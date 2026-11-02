#!/usr/bin/env node
/**
 * Deploy ONE stack, the guarded way: `npm run deploy:stack -- <StackName> [flags]`.
 *
 * A single-stack `npx cdk deploy <Stack> --exclusively` typed by hand skips everything `deploy.mjs`
 * does before it touches AWS: it forwards no `deploy.config.json` context unless someone pastes it,
 * names a stack `cdk` may not have (and `cdk deploy` exits 0 when nothing matches), and deploys
 * whatever the checkout holds even when that is older than what is live. All three happened on dev
 * on 2026-10-14. This runs the same checks `deploy.mjs` runs, for one stack:
 *
 *   1. build, so the bundles are the source (esbuild packages compiled .js);
 *   2. the context from deploy.config.json, refused when a key it needs is missing, and refused when
 *      `appUrl` (or `adminAppUrl` with the admin app on, or `widgetUrl` with the widget) is absent, since a pass without them resets
 *      every API's CORS allowlist;
 *   3. the stack must be one `cdk list` names under that context;
 *   4. the rollback check: the stack's recorded live commit must be an ancestor of this checkout's, and, for an
 *      imported VPC without endpoints, its routes to everything the in-VPC handlers read (check-imported-vpc.mjs);
 *   5. `cdk diff --exclusively`, printed before anything deploys;
 *   6. `cdk deploy --exclusively`, then the new commit is recorded against the stack.
 *
 * Flags (ours, stripped before cdk sees them):
 *   --diff-only        stop after the diff
 *   --allow-rollback   deploy even though the live commit is not an ancestor (recorded)
 *   --allow-dirty      deploy uncommitted changes (recorded as dirty)
 * Anything else (for example `--context k=v`) is forwarded to cdk after the config, so it wins.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertNoRollback, recordDeployedCommits } from './lib/deployed-commit.mjs';
import { assertImportedVpcEgress } from './check-imported-vpc.mjs';
import { printDeclaredButRetired, orphanedConsoleAssistantsRefusal } from './lib/declared-assistants-report.mjs';

const require = createRequire(import.meta.url);
const {
  contextFlagsFromConfig, contextValue, declaredCapabilities,
  ANALYTICS_MODE_RECORD_KEY, archiveStackName, checkAnalyticsModeLock, classifyDescribeStacksError, deployedAnalyticsMode,
  isFailedCreate, resolveInstancePrefix,
} = require('./lib/deploy-guards.cjs');

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = process.env.AWS_REGION || 'us-east-1';
const OUR_FLAGS = ['--diff-only', '--allow-rollback', '--allow-dirty'];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const stackName = argv.find((a) => !a.startsWith('-') && !argv[argv.indexOf(a) - 1]?.match(/^(--context|-c)$/));
const passThrough = argv.filter((a) => a !== stackName && !OUR_FLAGS.includes(a));

function fail(msg, code = 2) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

function run(cmd, args, label) {
  console.log(`\n▶ ${label}\n  ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: BACKEND_DIR, shell: process.platform === 'win32', stdio: 'inherit' });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status}).`, res.status || 1);
}

async function main() {
  if (!stackName) fail('Usage: npm run deploy:stack -- <StackName> [--diff-only] [--allow-rollback] [--allow-dirty]');

  run('npm', ['run', 'build'], 'Compile Lambda TS -> JS (avoid stale-.js bundling)');

  // The same config, and the same completeness check, deploy.mjs applies. The check's helper is
  // build output, so it loads after the build.
  const configPath = path.join(BACKEND_DIR, 'deploy.config.json');
  if (!existsSync(configPath)) fail('backend/deploy.config.json not found. A single-stack deploy without it drops every flag.');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const examplePath = path.join(BACKEND_DIR, 'deploy.config.example.json');
  if (existsSync(examplePath)) {
    const { compareDeployContext, describeDeployContextGap } = await import('../lib/config/deploy-context.js');
    const gap = compareDeployContext(cfg, JSON.parse(readFileSync(examplePath, 'utf8')));
    const message = describeDeployContextGap(gap, '--allow-partial-config');
    if (message) console[gap.destructive.length ? 'error' : 'warn'](message);
    if (gap.destructive.length) fail('deploy.config.json is missing keys whose absence deletes grants. See above.');
  }
  const forwarded = [...contextFlagsFromConfig(cfg), ...passThrough];
  if (!contextValue(forwarded, 'appUrl')) {
    fail('appUrl is not in the context. A single-stack pass without it resets that stack\'s CORS allowlist to localhost. Set it in deploy.config.json.');
  }
  if (declaredCapabilities(forwarded).includes('admin') && !contextValue(forwarded, 'adminAppUrl')) {
    fail('adminAppUrl is not in the context while admin is a declared capability. A pass without it points admin CORS at the chat origin.');
  }
  if (declaredCapabilities(forwarded).includes('widget') && !contextValue(forwarded, 'widgetUrl')) {
    fail('widgetUrl is not in the context while widget is a declared capability. A pass without it drops the widget frame from PersonApi CORS. Set it to the Widget stack\'s WidgetDistributionUrl output in deploy.config.json.');
  }

  // `cdk deploy` exits 0 when no stack matches, so the name is checked against this context's list.
  const list = spawnSync('npx', ['cdk', 'list', ...forwarded], { cwd: BACKEND_DIR, encoding: 'utf8', shell: process.platform === 'win32' });
  if (list.status !== 0) fail(`cdk list failed (exit ${list.status}): ${list.stderr || ''}`);
  const stacks = String(list.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!stacks.includes(stackName)) {
    fail(`"${stackName}" is not a stack under this context. Stacks: ${stacks.join(', ')}`);
  }

  // THE ANALYTICS MODE LOCK, the same one `npm run deploy` applies (deploy-guards.cjs): a single stack built
  // in the other mode against a deployed archive would change the mode with nothing having refused it.
  await assertAnalyticsMode(cfg, forwarded);

  // THE IMPORTED VPC'S ROUTES, the same check `npm run deploy` applies (scripts/check-imported-vpc.mjs): with
  // createVpcEndpoints=false the in-VPC handlers depend on endpoints synth cannot see.
  try {
    await assertImportedVpcEgress(forwarded, { region: REGION });
  } catch (err) {
    fail(err.message, 1);
  }

  const state = await assertNoRollback({
    stacks: [stackName],
    cwd: BACKEND_DIR,
    region: REGION,
    allowRollback: has('--allow-rollback'),
    allowDirty: has('--allow-dirty'),
  });

  // A diff is informational: `cdk diff` exits 1 when there ARE differences, which is not a failure.
  console.log(`\n▶ What this deploy changes\n  npx cdk diff ${stackName} --exclusively`);
  spawnSync('npx', ['cdk', 'diff', stackName, '--exclusively', ...forwarded], { cwd: BACKEND_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  if (has('--diff-only')) {
    console.log('\n• --diff-only: nothing deployed.');
    return;
  }

  // A CLASSIFICATION IS NOT REMOVED WHILE THE CONSOLE'S ASSISTANTS ARE ACTIVE IN IT, the same check `npm run deploy`
  // applies: a classification's seed never fails its stack's delete, so the refusal is here.
  {
    const { resolveDeploymentProfiles } = await import('../lib/config/profiles.js');
    const { resolveInstanceName } = require('./lib/stack-lookup.cjs');
    const refusal = await orphanedConsoleAssistantsRefusal({
      profilesConfig: resolveDeploymentProfiles(contextValue(forwarded, 'profiles')),
      ssmRoot: `/${resolveInstanceName(process.env)}`,
      region: REGION,
    });
    if (refusal) fail(refusal, 1);
  }

  // Streamed, not captured: a deploy runs for minutes. "No stacks match" cannot happen here, because
  // the name was checked against `cdk list` under the same context above.
  run('npx', ['cdk', 'deploy', stackName, '--exclusively', '--require-approval', 'never', ...forwarded], `Deploy ${stackName}`);

  await recordDeployedCommits({ stacks: [stackName], state, region: REGION, by: 'deploy-stack.mjs' });

  // A CLASSIFICATION'S STACK SEEDS ITS DECLARED ASSISTANTS ONCE (ADR-048, amended 2026-10-23): one retired in the
  // console is not recreated, and this says so.
  const classification = /Assistants-(.+)$/.exec(stackName)?.[1];
  if (classification) {
    const { resolveDeploymentProfiles } = await import('../lib/config/profiles.js');
    const { resolveInstanceName } = require('./lib/stack-lookup.cjs');
    await printDeclaredButRetired({
      profilesConfig: resolveDeploymentProfiles(contextValue(forwarded, 'profiles')),
      ssmRoot: `/${resolveInstanceName(process.env)}`,
      region: REGION,
      classifications: [classification],
    });
  }
}

/** Refuse a pass whose analytics mode differs from the recorded or the deployed one. */
async function assertAnalyticsMode(cfg, forwarded) {
  const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
  const prefix = resolveInstancePrefix(process.env);
  let presence;
  let mode;
  try {
    const resp = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: archiveStackName(prefix) }));
    const stack = resp.Stacks?.[0];
    presence = !stack ? 'absent' : isFailedCreate(stack.StackStatus) ? 'failed-create' : 'present';
    mode = stack?.Outputs?.find((o) => o.OutputKey === 'AnalyticsMode')?.OutputValue;
  } catch (err) {
    presence = classifyDescribeStacksError(err);
  }
  const verdict = checkAnalyticsModeLock({
    requested: contextValue(forwarded, 'analyticsMode'),
    recorded: cfg?.[ANALYTICS_MODE_RECORD_KEY],
    deployed: deployedAnalyticsMode({ presence, mode }),
    prefix,
  });
  if (verdict.warning) console.warn(`
${verdict.warning}`);
  if (!verdict.ok) fail(verdict.message, 1);
}

main().catch((err) => fail(`deploy:stack failed: ${err?.message || err}`, 1));
