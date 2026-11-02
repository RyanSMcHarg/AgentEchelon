#!/usr/bin/env node
/**
 * Does the imported analytics VPC give the in-VPC handlers a route to everything they read?
 *
 * `npm run check:vpc` (read-only). Applies when deploy.config.json (or `--context k=v` flags) selects Aurora mode with
 * `analyticsVpcId` set and `createVpcEndpoints=false`: the stack then creates no endpoints and relies on the VPC's
 * own, which synth cannot see. Reads the VPC's endpoints, route tables, subnets and the interface endpoints'
 * security groups (EC2 Describe* calls through the AWS CLI), plus the S3 buckets and DynamoDB tables the deployed
 * in-VPC functions of this instance name, and evaluates each against what the handlers call
 * (`lib/imported-vpc-checks.cjs`). Exits 1 when a check fails, 0 otherwise; prints nothing to fix when the
 * deployment creates its own endpoints.
 *
 * `deploy.mjs` and `deploy-stack.mjs` run the same check before any stack deploys (`assertImportedVpcEgress`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { contextFlagsFromConfig, contextValue } = require('./lib/deploy-guards.cjs');
const { resolveInstanceName } = require('./lib/stack-lookup.cjs');
const {
  importedVpcSelection, inVpcRequirements, checkImportedVpc, describeImportedVpcFailures, GATEWAY_SERVICES,
} = require('./lib/imported-vpc-checks.cjs');

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One read-only AWS CLI call, as parsed JSON. UTF-8 output, so a description with a non-ASCII character parses on Windows. */
function aws(args, region) {
  const out = execFileSync('aws', [...args, '--region', region, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out || '{}');
}

/**
 * The in-VPC functions this instance already runs: those in the VPC whose registry location names this instance's
 * registry bucket. Their subnets join the check, and the buckets and tables their environment names join the
 * requirements. None on a first deploy, which leaves the requirements the stacks declare.
 */
async function deployedInVpcFunctions({ vpcId, region, registryBucket }) {
  const { LambdaClient, paginateListFunctions } = await import('@aws-sdk/client-lambda');
  const client = new LambdaClient({ region });
  const found = [];
  for await (const page of paginateListFunctions({ client }, {})) {
    for (const f of page.Functions || []) {
      if (f.VpcConfig?.VpcId !== vpcId) continue;
      const env = f.Environment?.Variables || {};
      if (!String(env.AE_PROFILE_REGISTRY_S3 || '').startsWith(`s3://${registryBucket}/`)) continue;
      found.push({ name: f.FunctionName, subnets: f.VpcConfig.SubnetIds || [], env });
    }
  }
  return found;
}

/** Bucket and table names a function's environment carries (`*_BUCKET`, `s3://` values, `*_TABLE`). */
function namedResources(env) {
  const buckets = [];
  const tables = [];
  for (const [k, v] of Object.entries(env || {})) {
    const s3 = /^s3:\/\/([^/]+)/.exec(String(v));
    if (s3) buckets.push(s3[1]);
    else if (/_BUCKET(_NAME)?$/.test(k) && v) buckets.push(String(v));
    if (/_TABLE(_NAME)?$/.test(k) && v) tables.push(String(v));
  }
  return { buckets, tables };
}

/** Gather the facts and run the check. `value(key)` reads one context value. Returns null when it does not apply. */
export async function importedVpcFindings(value, { region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1' } = {}) {
  const selection = importedVpcSelection(value);
  if (!selection) return null;
  const { vpcId, subnetType } = selection;
  const resPrefix = resolveInstanceName(process.env);
  const account = aws(['sts', 'get-caller-identity'], region).Account;
  const registryBucket = `${resPrefix}-registry-${account}-${region}`;

  const filter = ['--filters', `Name=vpc-id,Values=${vpcId}`];
  const subnets = aws(['ec2', 'describe-subnets', ...filter], region).Subnets || [];
  const routeTables = aws(['ec2', 'describe-route-tables', ...filter], region).RouteTables || [];
  const endpoints = aws(['ec2', 'describe-vpc-endpoints', ...filter], region).VpcEndpoints || [];
  const groupIds = [...new Set(endpoints.filter((e) => e.VpcEndpointType === 'Interface').flatMap((e) => (e.Groups || []).map((g) => g.GroupId)))];
  const securityGroups = groupIds.length
    ? aws(['ec2', 'describe-security-groups', '--group-ids', ...groupIds], region).SecurityGroups || []
    : [];

  const functions = await deployedInVpcFunctions({ vpcId, region, registryBucket });
  const named = functions.map((f) => namedResources(f.env));
  const attachmentsBucket = functions.map((f) => f.env.ATTACHMENTS_BUCKET).find(Boolean);
  const requirements = inVpcRequirements({
    resPrefix,
    account,
    region,
    attachmentsBucket,
    extraBuckets: named.flatMap((n) => n.buckets),
    tables: named.flatMap((n) => n.tables),
  });
  // DynamoDB before any table is known (a first deploy): its route is still checked, its policy cannot be.
  if (!requirements.some((r) => r.service === 'dynamodb') && GATEWAY_SERVICES.has('dynamodb')) {
    requirements.push({ service: 'dynamodb', routeOnly: true, who: 'the turn data planes, archival and the analytics query (DynamoDB tables; no table is deployed yet, so the policy is not checked)' });
  }
  const findings = checkImportedVpc({
    vpcId, subnetType, subnets, routeTables, endpoints, securityGroups, account, requirements,
    deployedSubnetIds: functions.flatMap((f) => f.subnets),
  });
  return { vpcId, findings, functions: functions.map((f) => f.name) };
}

/** Print the findings the way the doctor prints its checks. */
export function printFindings(result, log = console.log) {
  for (const f of result.findings) {
    log(`[${f.level === 'fail' ? 'FAIL' : f.level}] ${f.check}`);
    if (f.detail) log(`      ${f.detail}`);
  }
}

/**
 * The deploy preflight: refuse (throw) when the imported VPC fails a check. `forwarded` is the context the deploy
 * passes to cdk. A deployment that creates its own endpoints returns without calling AWS.
 */
export async function assertImportedVpcEgress(forwarded, opts = {}) {
  const result = await importedVpcFindings((k) => contextValue(forwarded, k), opts);
  if (!result) return null;
  console.log(`\n▶ Imported VPC ${result.vpcId}: checking the in-VPC handlers' routes (createVpcEndpoints=false)`);
  printFindings(result);
  const refusal = describeImportedVpcFailures(result.findings, result.vpcId);
  if (refusal) throw new Error(refusal);
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const configPath = path.join(BACKEND_DIR, 'deploy.config.json');
  const cfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const forwarded = [...contextFlagsFromConfig(cfg), ...argv];
  const result = await importedVpcFindings((k) => contextValue(forwarded, k));
  if (!result) {
    console.log('Not an imported VPC without endpoints (Aurora mode, analyticsVpcId set, createVpcEndpoints=false): nothing to check.');
    return;
  }
  console.log(`Imported VPC ${result.vpcId}: the in-VPC handlers' routes`);
  console.log(`  deployed in-VPC functions of this instance: ${result.functions.length}`);
  printFindings(result);
  const refusal = describeImportedVpcFailures(result.findings, result.vpcId);
  if (refusal) {
    console.error(`\n✗ ${refusal}`);
    process.exit(1);
  }
  const warned = result.findings.filter((f) => f.level === 'warn').length;
  console.log(`\n✓ Every in-VPC call has a route${warned ? ` (${warned} not confirmed, see the warnings above)` : ''}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`check-imported-vpc failed: ${err?.stderr?.toString?.() || err?.message || err}`);
    process.exit(1);
  });
}
