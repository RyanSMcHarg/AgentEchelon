#!/usr/bin/env node
/**
 * NO PRINCIPAL CAN ASK THE PROVISIONER IN ANOTHER'S NAME, ON THE DEPLOYED POLICIES (ADR-048, amended 2026-10-24).
 *
 * The provisioner (`lambda/src/assistant-provisioner-function.ts`) cannot see who invoked it, so each request proves
 * its caller with a claim written where only that caller may write (`lambda/src/lib/provisioner-claim.ts`):
 * `{root}/provisioner-claims/seed/{classification}/` for that classification's seed, and
 * `{root}/provisioner-claims/console/` for `manage-assistants`. `one-principal-builds-every-assistant.test.ts` pins
 * it at synthesis. This asks IAM's policy simulator, for every role of the deployment, whether it may write a claim
 * under each classification's path and under the console's, and then asks the provisioner itself to remove a
 * classification's declared assistants with a request whose claim was never written.
 *
 * What must hold:
 *   - each classification's seed role, and no other role, may write under that classification's claim path;
 *   - `manage-assistants`' role, and no other role, may write under the console's;
 *   - a seed role may write under no other classification's path;
 *   - the provisioner refuses a `seed-declared` Delete whose claim is not there, before it reads or removes
 *     anything (it answers with a function error naming the claim). The request names a classification and a
 *     declaration of no assistants, so even a provisioner that failed to refuse would remove nothing.
 *
 * Scope: the roles in the deployment's stacks (nested stacks included). Principals outside the deployment (account
 * administrators, single sign-on roles, the CDK bootstrap roles) are not this test's subject; the invoke in the last
 * check is made as the operator running this.
 *
 * Usage: AWS_PROFILE=... AE_INSTANCE_NAME=<instance> node scripts/deny-test-provisioner-claims.mjs
 * Exit: 0 every refusal held, 1 a gap, 2 it could not run its checks (`lib/deny-test-verdict.cjs`).
 */
import { execFile } from 'child_process';
import { createRequire } from 'node:module';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { listStackNames, instanceStacksAmong, physicalIdsIn, withNestedStacks } = require('./lib/stack-resources.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const INSTANCE = resolveInstanceName(process.env);
const SSM_ROOT = `/${INSTANCE}`;
const PROVISIONER = `${INSTANCE}-assistant-provisioner`;

const POOL = Number(process.env.DENY_TEST_CONCURRENCY || 4);
let running = 0;
const waiting = [];
const aws = async (args) => {
  if (running >= POOL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await new Promise((resolve, reject) => execFile('aws', [...args, '--region', REGION, '--output', 'json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1', AWS_RETRY_MODE: 'adaptive', AWS_MAX_ATTEMPTS: '12' },
    }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out)))));
  } finally {
    running--;
    waiting.shift()?.();
  }
};

let roles;
let account;
try {
  const cfn = new CloudFormationClient({ region: REGION });
  const stacks = instanceStacksAmong(await listStackNames(cfn), resolveStackPrefix(process.env));
  const names = new Set(await physicalIdsIn(cfn, await withNestedStacks(cfn, stacks), { type: 'AWS::IAM::Role' }));
  roles = (await aws(['iam', 'list-roles'])).Roles.filter((r) => names.has(r.RoleName));
  account = (await aws(['sts', 'get-caller-identity'])).Account;
} catch (err) {
  console.error(`could not read the deployment's roles: ${err?.message || err}`);
  process.exit(2);
}
if (roles.length < 10) {
  console.error(`only ${roles.length} roles found in the deployment's stacks: the check would pass vacuously`);
  process.exit(2);
}

// THE CLASSIFICATIONS, read from the seeds' own environments: each seed function names the classification it serves.
const seedRoles = roles.filter((r) => /(DeclaredAssistantsRole|AdminAgentSeedRole)/.test(r.RoleName));
const classifications = [];
for (const r of seedRoles) {
  const fns = (await aws(['lambda', 'list-functions'])).Functions.filter((f) => f.Role === r.Arn);
  for (const f of fns) if (f.Environment?.Variables?.CLASSIFICATION) classifications.push({ classification: f.Environment.Variables.CLASSIFICATION, role: r.RoleName });
}
if (!classifications.length) {
  console.error('no seed function names a classification, so no claim path can be checked');
  process.exit(2);
}

const claimArn = (path) => `arn:aws:ssm:${REGION}:${account}:parameter${SSM_ROOT}/provisioner-claims/${path}/deny-test-probe`;
const decide = async (roleArn, resource) => (await aws([
  'iam', 'simulate-principal-policy', '--policy-source-arn', roleArn, '--action-names', 'ssm:PutParameter', '--resource-arns', resource,
])).EvaluationResults[0].EvalDecision;

const failures = [];
const paths = [...classifications.map((c) => ({ path: `seed/${c.classification}`, owner: c.role })), { path: 'console', owner: /ManageAssistantsRole/ }];
for (const { path, owner } of paths) {
  const writers = [];
  await Promise.all(roles.map(async (r) => { if ((await decide(r.Arn, claimArn(path))) === 'allowed') writers.push(r.RoleName); }));
  const expected = (n) => (owner instanceof RegExp ? owner.test(n) : n === owner);
  const others = writers.filter((n) => !expected(n));
  if (others.length) failures.push(`roles other than its owner that may write a claim under ${path}: ${others.join(', ')}`);
  if (!writers.some(expected)) {
    // The console's owner exists only where admin is declared.
    if (!(path === 'console' && !roles.some((r) => /ManageAssistantsRole/.test(r.RoleName)))) failures.push(`its owner may not write a claim under ${path}, so its requests would all be refused`);
  }
  console.log(`claims under ${path}: ${writers.join(', ') || 'nobody'}`);
}

// THE SECOND LAYER: a request whose claim was never written is refused before anything is read or removed.
try {
  const c = classifications[0].classification;
  const request = {
    op: 'seed-declared', callerClassification: c, requestType: 'Delete', logicalResourceId: 'DenyTestProbe', physicalResourceId: 'deny-test-probe',
    fulfillmentArn: 'arn:aws:lambda:deny-test', declaration: { classification: c, roles: [], assistants: [] },
    claim: '00000000-0000-4000-8000-000000000000',
  };
  const out = await new LambdaClient({ region: REGION }).send(new InvokeCommand({ FunctionName: PROVISIONER, Payload: Buffer.from(JSON.stringify(request)) }));
  const body = out.Payload ? Buffer.from(out.Payload).toString() : '';
  if (!out.FunctionError || !/does not prove its caller/.test(body)) {
    failures.push(`the provisioner answered a request with no claim written: ${body || '(empty)'}`);
  } else {
    console.log(`the provisioner refused a request with no claim: ${JSON.parse(body).errorMessage}`);
  }
} catch (err) {
  console.error(`could not invoke ${PROVISIONER}: ${err?.message || err}`);
  process.exit(2);
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nevery claim path is its owner's alone (${paths.length} paths, ${roles.length} roles), and an unproven request is refused`);
