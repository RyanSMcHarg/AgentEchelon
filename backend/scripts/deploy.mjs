/**
 * One-command deploy → live CloudFront app.
 *
 * `npm run deploy -- <cdk context flags>` does the whole thing an OSS deployer
 * (or their coding agent) needs, instead of leaving CloudFront empty after
 * `cdk deploy --all`:
 *
 *   0. npm run build              (compile Lambda TS→JS so esbuild doesn't bundle stale .js)
 *      analytics mode lock        (refuse a deploy whose analyticsMode differs from the mode this
 *                                  instance was first deployed with; switching is not supported)
 *      imported VPC routes        (with createVpcEndpoints=false, refuse when the VPC's endpoints do not
 *                                  route what the in-VPC handlers read; scripts/check-imported-vpc.mjs)
 *   1. resolve URLs + deploy      (read the live CloudFront origins FIRST, pass them as
 *                                  appUrl when chat is a declared capability, adminAppUrl
 *                                  when admin is, and widgetUrl when widget is, in the
 *                                  ONE backend pass so CORS is correct immediately — no
 *                                  transient localhost window that a mid-deploy failure could
 *                                  leave the live app stuck in)
 *   2. sync-context               (tiered context → S3)
 *   3. gen-frontend-env           (writes frontend/packages/{chat,admin}/.env from the live outputs)
 *   4. deploy-frontend            (builds the SPA + syncs to the CloudFront S3 origin + invalidates)
 *   (first deploy of a distribution only: one extra pass with its URL, since it didn't exist yet)
 *
 * NOTE: `cdk deploy --all` deploys every stack in the synthesized app. On an account
 * hosting OTHER CDK apps, always confirm the instance-name context is correct first.
 *
 * The CloudFront distribution ships with a managed-rules WAF ON BY DEFAULT
 * (AWS Common + Known-Bad-Inputs + IP-reputation + per-IP rate limit). Opt out
 * with `-c frontendWaf=false`; tune with `-c wafRateLimit=N` / `-c wafAllowedIps=...`.
 *
 * Examples:
 *   npm run deploy -- --context senderEmail=you@example.com
 *   npm run deploy -- --context analyticsMode=aurora --context senderEmail=you@example.com
 *   npm run deploy -- --context appUrl=https://app.example.com   # your own domain; skips step 4
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
// Hand-written CommonJS source (not build output), so it loads before step 0 the same as on a fresh
// clone. It holds the pure decisions below so they are tested without AWS.
const require = createRequire(import.meta.url);
const {
  resolveFrontendTargets,
  isFailedCreate,
  describeFailedCreate,
  checkFrontendStackOutputs,
  classifyDescribeStacksError,
  contextValue,
  contextFlagsFromConfig,
  consoleContext,
  widgetStackName,
  checkWidgetStackOutputs,
  backendDeployArgs,
  corsPassOrigins,
  DEPLOY_STEPS,
  ANALYTICS_MODE_RECORD_KEY,
  archiveStackName,
  deployedAnalyticsMode,
  checkAnalyticsModeLock,
  recordAnalyticsModeText,
} = require('./lib/deploy-guards.cjs');
import { assertNoRollback, recordDeployedCommits } from './lib/deployed-commit.mjs';
import { assertImportedVpcEgress } from './check-imported-vpc.mjs';
import { printDeclaredButRetired, orphanedConsoleAssistantsRefusal } from './lib/declared-assistants-report.mjs';
// deploy-context is COMPILED OUTPUT, and `backend/.gitignore` starts with `*.js`, so it does not
// exist on a fresh clone until step 0 builds it. A static import would resolve at MODULE LOAD,
// before main() can run that build, and fail with ERR_MODULE_NOT_FOUND on a fresh clone. It is
// imported dynamically, from inside main(), after the build has produced it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const REGION = process.env.AWS_REGION || 'us-east-1';
const CONFIG_PATH = path.join(BACKEND_DIR, 'deploy.config.json');

/**
 * The chat and admin frontend stacks, each derived from the instance prefix on its own
 * (`<prefix>ChatApp`, `<prefix>AdminApp`). FRONTEND_STACK_NAME overrides only the chat target
 * and ADMIN_FRONTEND_STACK_NAME only the admin one, and an override outside this instance is refused.
 * The prefix comes from AE_STACK_PREFIX / AE_INSTANCE_NAME, the variables the CDK app names its stacks
 * from (scripts/lib/stack-lookup.cjs resolves it for every script), never from FRONTEND_STACK_NAME.
 */
let TARGETS;
try {
  TARGETS = resolveFrontendTargets(process.env);
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
}

/**
 * The environment every child step runs with. The prefix and both targets are passed explicitly so
 * `gen-frontend-env.mjs` and `deploy-frontend.mjs` resolve the same stacks this script resolved,
 * instead of falling back to the default instance's names.
 */
const CHILD_ENV = {
  ...process.env,
  STACK_PREFIX: TARGETS.prefix,
  FRONTEND_STACK_NAME: TARGETS.chat,
  ADMIN_FRONTEND_STACK_NAME: TARGETS.admin,
};

/**
 * Per-instance deploy context, persisted so a redeploy is reproducible without re-passing
 * ad-hoc flags. `backend/deploy.config.json` (gitignored; see `deploy.config.example.json`) is a
 * flat map of cdk context keys -> values, forwarded as `--context k=v`. CLI flags come after
 * and win. This is what lets `npm run deploy` reproduce an instance that uses non-default
 * choices (aurora mode, an imported VPC, etc.) without anyone reverse-engineering the flags.
 */
/**
 * FAIL CLOSED. Both failure paths here used to warn (or say nothing) and continue with ZERO
 * context flags, which is the most destructive thing this script can do: many flags gate resources
 * that already exist, and an ABSENT flag reads as "off". A deploy with no context therefore
 * REMOVES the admin persona/IAM execute-api teeth on the shared roles (cascading to every admin
 * surface, not just the stack being deployed), unwires live drift + Aurora RAG, and resets each
 * API's CORS allowlist to localhost. A JSON typo silently doing all of that is not an acceptable
 * outcome, so a config that exists but cannot be parsed is fatal, and a missing config aborts
 * unless the caller opts out explicitly.
 */
const NO_CONFIG_FLAG = '--no-deploy-config';
/** Opt out of the completeness check (a deliberately partial context). */
const PARTIAL_CONFIG_FLAG = '--allow-partial-config';

function configFlags() {
  const p = CONFIG_PATH;
  const optedOut = process.argv.slice(2).includes(NO_CONFIG_FLAG);

  if (!existsSync(p)) {
    if (optedOut) {
      console.warn(`! ${NO_CONFIG_FLAG}: deploying with CLI context only (no deploy.config.json).`);
      return [];
    }
    console.error(
      '\n✗ backend/deploy.config.json not found.\n'
        + '  It holds this instance\'s deploy context. Deploying without it silently drops every\n'
        + '  flag, which DELETES existing grants (admin IAM/personas, live drift, CORS origins).\n\n'
        + '  First deploy:  cp deploy.config.example.json deploy.config.json  then set your values.\n'
        + `  Deliberately bare (a genuinely fresh account):  npm run deploy -- ${NO_CONFIG_FLAG} --context senderEmail=you@example.com\n`,
    );
    process.exit(1);
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(
      `\n✗ backend/deploy.config.json could not be parsed: ${e.message}\n`
        + '  Refusing to deploy. Continuing would forward NO context flags and silently strip the\n'
        + '  admin IAM/persona grants, live drift, and CORS origins this instance depends on.\n',
    );
    process.exit(1);
  }

  // Loading is not the same as being COMPLETE. A config missing a key parses fine, forwards fewer
  // flags, and reports success — which is how this instance deployed with `appUrl` absent and came
  // within one command of rewriting every CORS origin to localhost. Compare against the example,
  // which the test suite already proves documents every flag the app reads.
  const examplePath = path.join(BACKEND_DIR, 'deploy.config.example.json');
  if (!process.argv.slice(2).includes(PARTIAL_CONFIG_FLAG) && existsSync(examplePath)) {
    try {
      const example = JSON.parse(readFileSync(examplePath, 'utf8'));
      const gap = compareDeployContext(cfg, example);
      const message = describeDeployContextGap(gap, PARTIAL_CONFIG_FLAG);
      if (message) {
        // Fail CLOSED on a missing key (it deletes things); an unknown key alone only warns, since a
        // stale entry cannot drop a grant.
        console[gap.destructive.length ? 'error' : 'warn'](message);
        if (gap.destructive.length) process.exit(1);
      }
    } catch (e) {
      console.warn(`! could not compare deploy.config.json against the example: ${e.message}`);
    }
  }

  persistedConfig = cfg;
  const out = contextFlagsFromConfig(cfg); // `_`-keys are comments and records, never context
  console.log(`  (loaded ${out.length / 2} context flags from deploy.config.json)`);
  return out;
}

// `--no-deploy-config` is ours, not cdk's: strip it before forwarding or cdk rejects it.
/** Ours, not cdk's: the rollback check's two overrides (scripts/lib/deploy-guards.cjs `rollbackVerdict`). */
const ALLOW_ROLLBACK_FLAG = '--allow-rollback';
const ALLOW_DIRTY_FLAG = '--allow-dirty';
const OUR_FLAGS = [NO_CONFIG_FLAG, PARTIAL_CONFIG_FLAG, ALLOW_ROLLBACK_FLAG, ALLOW_DIRTY_FLAG];
const cliArgs = process.argv.slice(2).filter((a) => !OUR_FLAGS.includes(a));
// Resolved in main(), AFTER the build, for the same reason the import moved. Module-level `const`
// would re-introduce the load-time dependency the dynamic import exists to remove.
let forwarded = [...cliArgs];
let userSetAppUrl = false;
let userSetAdminAppUrl = false;
let userSetWidgetUrl = false;
let chatAppEnabled = false;
let adminAppEnabled = false;
let widgetEnabled = false;
let widgetHostEnabled = false;
/** The parsed deploy.config.json, or null when deploying without one (`--no-deploy-config`). */
let persistedConfig = null;

/**
 * Resolve the forwarded context. Called from main() AFTER the build, because `configFlags()` reaches
 * `deploy-context.js`, which the build is what produces.
 */
async function resolveForwardedContext() {
  ({ compareDeployContext, describeDeployContextGap } = await import('../lib/config/deploy-context.js'));
  forwarded = [...configFlags(), ...cliArgs]; // persisted config, then CLI (CLI wins)
  ({ userSetAppUrl, userSetAdminAppUrl, userSetWidgetUrl, chatAppEnabled, adminAppEnabled, widgetEnabled, widgetHostEnabled } = consoleContext(forwarded));
}

/**
 * Bound by {@link resolveForwardedContext}. Declared here, assigned there, because the module they
 * come from is build output that does not exist until step 0 has run.
 *
 * `chatAppEnabled` and `adminAppEnabled` are read from the SAME declared capability list the CDK app
 * creates the two stacks from, so a publish step and its stack can never disagree; `userSetAppUrl` and `userSetAdminAppUrl` record
 * that the caller supplied their own origin, which skips that CloudFront lookup.
 */
let compareDeployContext;
let describeDeployContextGap;

function run(cmd, args, label) {
  console.log(`\n▶ ${label}\n  ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: CHILD_ENV,
  });
  if (res.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${res.status}). Aborting.`);
    process.exit(res.status || 1);
  }
}

const cfn = new CloudFormationClient({ region: REGION });

/**
 * One stack's presence: 'present' with the stack, 'absent', 'failed-create' with the stack (a create
 * that never succeeded, so no outputs), or 'unknown' with the reason. Only a "does not exist"
 * ValidationError is absence; any other failure leaves presence unknown.
 */
async function describeStack(name) {
  try {
    const resp = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    const stack = resp.Stacks?.[0];
    if (!stack) return { presence: 'absent' };
    return { presence: isFailedCreate(stack.StackStatus) ? 'failed-create' : 'present', stack };
  } catch (err) {
    return { presence: classifyDescribeStacksError(err), why: err?.message || String(err) };
  }
}

/**
 * The live CloudFront origin a frontend stack publishes, for the CORS context.
 *
 * Returns the URL, or null when the stack does not exist yet (its first deploy, which the extra pass
 * at the end covers). A stack whose create failed is the same case: it has no outputs, and the backend
 * pass deletes and creates it again. Aborts when the lookup cannot be made: deploying on without the
 * URL resets that console's CORS allowlist to localhost on a live instance, the failure this
 * pre-resolution exists to prevent. Also aborts when an explicit override names a stack that does not
 * exist, because the CDK app never creates a stack by that name, so no later pass would find it either.
 */
async function distributionUrl({ stackName, outputKey, label, overrideVar, derived }) {
  const r = await describeStack(stackName);
  if (r.presence === 'failed-create') {
    if (stackName !== derived) {
      // The CDK app creates only `derived`, so no pass of this deploy re-creates an override's stack.
      console.error(
        `\n✗ ${overrideVar}=${stackName}: Stack "${stackName}" is in ${r.stack.StackStatus}, a create that never `
          + `succeeded, and the CDK app names this stack ${derived}, so no pass re-creates it. Unset ${overrideVar}.`,
      );
      process.exit(1);
    }
    console.warn(`\n! ${describeFailedCreate(stackName, r.stack.StackStatus)}`);
    console.warn(`  Its ${label} origin is applied in the extra CORS pass once the stack exists.`);
    return null;
  }
  if (r.presence === 'present') {
    const outputs = r.stack.Outputs || [];
    // A stack that exists but is the other console's (or no frontend at all) stops here, BEFORE the
    // backend pass, rather than reading as "no URL yet" and deploying CORS back to localhost.
    const mismatch = checkFrontendStackOutputs({
      stackName,
      isAdmin: label === 'admin',
      outputKeys: outputs.map((o) => o.OutputKey),
      targets: TARGETS,
    });
    if (mismatch) {
      console.error(`\n✗ ${mismatch}`);
      process.exit(1);
    }
    return outputs.find((o) => o.OutputKey === outputKey)?.OutputValue || null;
  }
  if (r.presence === 'absent') {
    if (stackName !== derived) {
      console.error(
        `\n✗ ${overrideVar}=${stackName} names a ${label} frontend stack that does not exist in ${REGION}.\n`
          + `  Chat target:  ${TARGETS.chat}\n  Admin target: ${TARGETS.admin}\n`
          + `  The CDK app names this stack ${derived}. Unset ${overrideVar}, or fix it.`,
      );
      process.exit(1);
    }
    return null;
  }
  console.error(
    `\n✗ Could not read ${stackName} to resolve the ${label} origin: ${r.why}\n`
      + '  Deploying without it would reset that console\'s CORS allowlist to localhost. Fix the AWS\n'
      + `  session and rerun, or pass the origin yourself with --context ${label === 'admin' ? 'adminAppUrl' : 'appUrl'}=<url>.`,
  );
  process.exit(1);
}

const chatUrlLookup = () => distributionUrl({
  stackName: TARGETS.chat,
  outputKey: 'DistributionUrl',
  label: 'chat',
  overrideVar: 'FRONTEND_STACK_NAME',
  derived: `${TARGETS.prefix}ChatApp`,
});
/**
 * The widget frame's own origin (`<prefix>Widget`'s `WidgetDistributionUrl`), for `PersonApi`'s CORS
 * (`widgetUrl`). The same rules as a console's: null before the stack's first deploy (the extra pass
 * covers it), and an abort when the lookup cannot be made, since deploying on without it drops the
 * frame's origin from a live instance's CORS. A CDK reference cannot carry it: `PersonApi` is core and
 * `Widget` an interface stack, and the core depends on no interface stack (STACKS.md, the component rule).
 */
async function widgetUrlLookup() {
  const stackName = widgetStackName(TARGETS.prefix);
  const r = await describeStack(stackName);
  if (r.presence === 'absent' || r.presence === 'failed-create') return null;
  if (r.presence === 'present') {
    const outputs = r.stack.Outputs || [];
    const mismatch = checkWidgetStackOutputs({ stackName, outputKeys: outputs.map((o) => o.OutputKey) });
    if (mismatch) {
      console.error(`\n✗ ${mismatch}`);
      process.exit(1);
    }
    return outputs.find((o) => o.OutputKey === 'WidgetDistributionUrl')?.OutputValue || null;
  }
  console.error(
    `\n✗ Could not read ${stackName} to resolve the widget origin: ${r.why}\n`
      + '  Deploying without it would drop the widget frame from PersonApi\'s CORS. Fix the AWS session and\n'
      + '  rerun, or pass the origin yourself with --context widgetUrl=<url>.',
  );
  process.exit(1);
}

const adminUrlLookup = () => distributionUrl({
  stackName: TARGETS.admin,
  outputKey: 'AdminDistributionUrl',
  label: 'admin',
  overrideVar: 'ADMIN_FRONTEND_STACK_NAME',
  derived: `${TARGETS.prefix}AdminApp`,
});

/**
 * ANALYTICS MODE LOCK. `analyticsMode` is chosen on the first deploy and is not switched afterwards:
 * the Athena and Aurora analytics stacks create resources with the same fixed names and both write the
 * app instance's one streaming configuration, so flipping the mode collides with the stack being
 * replaced (and `cdk deploy` never deletes that stack, so the collision is certain).
 *
 * Two checks, one function. Before any AWS call, against the mode deploy.config.json recorded on the
 * first deploy; then against the deployed `<prefix>Archive` stack's `AnalyticsMode` output, read with
 * the same DescribeStacks call the URL lookups use, so it needs no new permission.
 */
function requestedAnalyticsMode() {
  return contextValue(forwarded, 'analyticsMode');
}

function refuseUnless(verdict) {
  if (verdict.warning) console.warn(`\n${verdict.warning}`);
  if (verdict.ok) return;
  console.error(`\n${verdict.message}\n`);
  process.exit(1);
}

function assertAnalyticsModeRecord() {
  refuseUnless(checkAnalyticsModeLock({
    requested: requestedAnalyticsMode(),
    recorded: persistedConfig?.[ANALYTICS_MODE_RECORD_KEY],
    prefix: TARGETS.prefix,
  }));
}

async function assertAnalyticsModeMatchesDeployment() {
  const name = archiveStackName(TARGETS.prefix);
  const archive = await describeStack(name);
  const mode = archive.stack?.Outputs?.find((o) => o.OutputKey === 'AnalyticsMode')?.OutputValue;
  const deployed = deployedAnalyticsMode({ presence: archive.presence, mode });
  // Record-mode warnings were already printed by assertAnalyticsModeRecord.
  const { warning: _alreadyPrinted, ...verdict } = checkAnalyticsModeLock({
    requested: requestedAnalyticsMode(),
    recorded: persistedConfig?.[ANALYTICS_MODE_RECORD_KEY],
    deployed,
    prefix: TARGETS.prefix,
  });
  refuseUnless(verdict);
  if (archive.presence === 'failed-create') console.warn(`  ! ${describeFailedCreate(name, archive.stack.StackStatus)}`);
  console.log(deployed === 'none'
    ? `  ✓ First deploy of the archive: analyticsMode=${requestedAnalyticsMode() || 'athena'} is chosen now.`
    : `  ✓ analyticsMode matches the deployed ${deployed} archive.`);
}

/**
 * Record the mode in deploy.config.json once, after the backend pass succeeds, so a later run that
 * asks for the other mode is refused before AWS is asked. Also records the mode of an instance
 * deployed before the record existed. A file this script cannot rewrite only warns: the stack check
 * still holds.
 */
function recordAnalyticsMode() {
  if (!persistedConfig || !existsSync(CONFIG_PATH)) return;
  const mode = requestedAnalyticsMode() || 'athena';
  try {
    const next = recordAnalyticsModeText(readFileSync(CONFIG_PATH, 'utf8'), mode);
    if (next === null) return;
    writeFileSync(CONFIG_PATH, next);
    console.log(`  (recorded ${ANALYTICS_MODE_RECORD_KEY}="${mode}" in deploy.config.json)`);
  } catch (e) {
    console.warn(`! could not record the analytics mode in deploy.config.json: ${e.message}`);
  }
}

/**
 * SAFETY GUARD (shared / multi-app accounts). `cdk deploy --all` deploys every
 * stack in the SYNTHESIZED app. If the instance-name context is wrong, that
 * synthesis can be a DIFFERENT app's stacks (a look-alike on a shared account),
 * and --all would deploy THOSE. Before deploying, synthesize the stack LIST and
 * refuse if any stack falls outside this deployment's expected prefix.
 *
 * The prefix is resolved from the environment the CDK app names its stacks from
 * (AE_STACK_PREFIX, else the PascalCase of AE_INSTANCE_NAME, default "AgentEchelon"),
 * independent of the cdk context, so a wrong `-c instanceName=...` can't slip its
 * own stacks past this check (they simply won't match the prefix). Override with
 * AE_DEPLOY_STACK_PREFIX only if you deliberately deploy mixed-prefix stacks.
 */
function assertOnlyOurStacks() {
  const expectedPrefix = process.env.AE_DEPLOY_STACK_PREFIX || TARGETS.prefix;
  console.log(`\n▶ Safety gate: verifying every --all stack is under "${expectedPrefix}"`);
  const res = spawnSync('npx', ['cdk', 'list', ...forwarded], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`\n✗ \`cdk list\` failed (exit ${res.status}); cannot verify deploy scope. Aborting.`);
    if (res.stderr) console.error(res.stderr);
    process.exit(res.status || 1);
  }
  const stacks = String(res.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const foreign = stacks.filter((s) => !s.startsWith(expectedPrefix));
  if (!stacks.length) {
    console.error('\n✗ Safety gate: `cdk list` returned no stacks. Aborting.');
    process.exit(2);
  }
  if (foreign.length) {
    console.error(`\n✗ SAFETY GATE TRIPPED — refusing to deploy. \`cdk deploy --all\` would touch stack(s) NOT under "${expectedPrefix}":`);
    for (const s of foreign) console.error(`    - ${s}`);
    console.error(`\n  This usually means the instance-name context points at a DIFFERENT app`);
    console.error(`  (dangerous on a shared account). Fix the context, or set`);
    console.error(`  AE_DEPLOY_STACK_PREFIX=<prefix> if this mix is intentional.`);
    process.exit(2);
  }
  console.log(`  ✓ ${stacks.length} stack(s), all under "${expectedPrefix}".`);
  ourStacks = stacks;
}

/** The stacks `cdk deploy --all` will touch, as the safety gate listed them; the rollback check reads them. */
let ourStacks = [];
/** The checkout the rollback check approved, recorded against every stack once the backend pass succeeds. */
let deployState = null;

/**
 * Each step `main()` runs, by the id DEPLOY_STEPS (scripts/lib/deploy-guards.cjs) orders them by. The
 * order is that list, so a test reads it as data; these are only the bodies.
 */
const origins = { pre: { chat: null, admin: null, widget: null }, late: { chat: null, admin: null, widget: null } };

const STEPS = {
  // 0. Compile Lambda TS → JS FIRST. CDK's NodejsFunction esbuild resolves the `.js` import
  //    specifiers to on-disk `.js` files, so without a fresh build it bundles STALE `.js` and edited
  //    `.ts` does not ship (a clean exit-0 deploy that changes nothing). Build up front so assets =
  //    source.
  build: () => run('npm', ['run', 'build'], '0/4 Compile Lambda TS → JS (avoid stale-.js bundling)'),

  // The deploy-context helper is build output, so it loads only after the build. Every later step
  // reads `forwarded`.
  resolveContext: () => resolveForwardedContext(),

  // Refuse a deploy that asks for a different analytics mode than this instance was first deployed
  // with. This half reads only deploy.config.json, so it refuses before anything touches AWS.
  assertAnalyticsModeRecord: () => assertAnalyticsModeRecord(),

  // Refuse to `--all`-deploy anything outside this instance (shared-account safety).
  assertOnlyOurStacks: () => assertOnlyOurStacks(),

  // The other half asks the account which analytics stack exists.
  assertAnalyticsModeMatchesDeployment: async () => {
    console.log('\n▶ Analytics mode lock: checking which analytics stack this instance runs');
    await assertAnalyticsModeMatchesDeployment();
  },

  // An imported VPC that brings its own endpoints (`createVpcEndpoints=false`) must route every call an in-VPC
  // handler makes: synth cannot see its endpoint policies or route tables, and a gap hangs every in-VPC handler
  // (scripts/check-imported-vpc.mjs). Read-only; a deployment that creates its endpoints skips it.
  assertImportedVpcEgress: async () => {
    try {
      await assertImportedVpcEgress(forwarded, { region: REGION });
    } catch (err) {
      console.error(`
✗ ${err.message}`);
      process.exit(1);
    }
  },

  // Resolve the live CloudFront origins BEFORE deploying, so `appUrl` (when `chat` is declared) and
  // `adminAppUrl` (when `admin` is) are right in the FIRST, and normally only, backend pass. A pass without it
  // sets ALLOWED_ORIGIN to http://localhost:5173, and a failure before a later pass fixed it would
  // leave the live app CORS-broken. Without `adminAppUrl`, every admin API's CORS allowlist falls
  // back to the chat origin (app-origins.ts), which takes the live admin console offline.
  // `userSetAppUrl` means the caller already put appUrl in `forwarded`.
  resolveOrigins: async () => {
    origins.pre.chat = chatAppEnabled && !userSetAppUrl ? await chatUrlLookup() : null;
    origins.pre.admin = adminAppEnabled && !userSetAdminAppUrl ? await adminUrlLookup() : null;
    origins.pre.widget = widgetEnabled && !userSetWidgetUrl ? await widgetUrlLookup() : null;
  },

  // Refuse a deploy that would remove commits a live stack runs: every stack's recorded commit must be
  // an ancestor of this checkout's (scripts/lib/deploy-guards.cjs `rollbackVerdict`).
  assertNoRollback: async () => {
    deployState = await assertNoRollback({
      stacks: ourStacks,
      cwd: BACKEND_DIR,
      region: REGION,
      allowRollback: process.argv.includes(ALLOW_ROLLBACK_FLAG),
      allowDirty: process.argv.includes(ALLOW_DIRTY_FLAG),
    });
  },

  // A CLASSIFICATION IS NOT REMOVED WHILE THE CONSOLE'S ASSISTANTS ARE ACTIVE IN IT (ADR-048, amended 2026-10-24).
  // Its seed never fails its stack's delete, so the refusal is here, before anything deploys.
  assertNoOrphanedConsoleAssistants: async () => {
    const { resolveDeploymentProfiles } = await import('../lib/config/profiles.js');
    const { resolveInstanceName } = require('./lib/stack-lookup.cjs');
    const refusal = await orphanedConsoleAssistantsRefusal({
      profilesConfig: resolveDeploymentProfiles(contextValue(forwarded, 'profiles')),
      ssmRoot: `/${resolveInstanceName(process.env)}`,
      region: REGION,
    });
    if (refusal) {
      console.error(`
✗ ${refusal}`);
      process.exit(1);
    }
  },

  deployBackend: () => run(
    'npx',
    backendDeployArgs(forwarded, { appUrl: origins.pre.chat, adminAppUrl: origins.pre.admin, widgetUrl: origins.pre.widget }),
    '1/4 Deploy backend stacks (app origins pre-resolved — CORS never transiently broken)',
  ),

  recordAnalyticsMode: () => recordAnalyticsMode(),
  recordDeployedCommits: async () => {
    await recordDeployedCommits({ stacks: ourStacks, state: deployState, region: REGION, by: 'deploy.mjs' });
    // Each classification's stack seeds its declared assistants once (ADR-048, amended 2026-10-23): one retired in
    // the console is not recreated, and the deploy says so.
    const { resolveDeploymentProfiles } = await import('../lib/config/profiles.js');
    const { resolveInstanceName } = require('./lib/stack-lookup.cjs');
    await printDeclaredButRetired({
      profilesConfig: resolveDeploymentProfiles(contextValue(forwarded, 'profiles')),
      ssmRoot: `/${resolveInstanceName(process.env)}`,
      region: REGION,
    });
  },
  syncContext: () => run('node', ['scripts/sync-context.mjs'], '2/4 Sync tiered context into S3'),
  genFrontendEnv: () => run('node', ['scripts/gen-frontend-env.mjs'], '3/4 Generate frontend/packages/{chat,admin}/.env from outputs'),
  // Gated on the declared capability that creates the chat app stack, so a deployment without `chat`
  // does not try to publish to a distribution that is not there.
  publishChat: () => {
    if (chatAppEnabled) {
      run('node', ['scripts/deploy-frontend.mjs'], '4/4 Publish chat SPA to CloudFront');
    } else {
      console.log('\n• chat is not a declared capability — skipping the chat app publish.');
    }
  },

  // The admin console is a SEPARATE package with its own bucket + distribution, and
  // deploy-frontend.mjs publishes it only with --admin. Without this step a deploy updates the admin
  // BACKEND while the admin BUNDLE stays at whatever the last manual --admin run shipped: a stale
  // console talking to a moved backend, which surfaces as unexplained 4xx rather than as a deploy
  // failure. Gated on the declared capability that provisions the stack, so a deployment without
  // `admin` does not try to publish a distribution that is not there.
  publishAdmin: () => {
    if (adminAppEnabled) {
      run('node', ['scripts/deploy-frontend.mjs', '--admin'], '4b/4 Publish admin console to CloudFront');
    } else {
      console.log('\n• admin is not a declared capability — skipping the admin console publish.');
    }
  },

  // The widget hosting (the `widget` capability) publishes its bundle the same way, to `<prefix>Widget`.
  // Gated on the declared capability, so it runs exactly when that stack exists.
  publishWidget: () => {
    if (widgetEnabled) {
      run('node', ['scripts/deploy-frontend.mjs', '--widget'], '4c/4 Publish the widget to CloudFront');
    } else {
      console.log('\n• widget is not a declared capability - skipping the widget publish.');
    }
  },

  // The sample host page (`examples/widget-host/`) on `<prefix>WidgetHost`, which exists exactly when the
  // guest issuer lists "widget-host" in its allowedOrigins. The publish writes the widget's origin, read
  // from the Widget stack's output, into the page's configuration.
  publishWidgetHost: () => {
    if (widgetHostEnabled) {
      run('node', ['scripts/deploy-frontend.mjs', '--widget-host'], '4d/4 Publish the sample widget host page to CloudFront');
    }
  },

  // FIRST deploy of a distribution only: it did not exist before pass 1, so its URL could not be
  // pre-resolved. Apply it now, with every origin known, in one extra pass that carries them all, the
  // widget frame's included, so a guest deployment's first `npm run deploy` ends with its CORS closed. A
  // failure HERE only affects a console that is not serving anyone yet. The chat and admin origins
  // follow the same rule, so enabling the admin console on an existing instance closes its CORS loop
  // the same way a first deploy closes the chat one.
  corsPass: async () => {
    origins.late.chat = chatAppEnabled && !userSetAppUrl && !origins.pre.chat ? await chatUrlLookup() : null;
    origins.late.admin = adminAppEnabled && !userSetAdminAppUrl && !origins.pre.admin ? await adminUrlLookup() : null;
    origins.late.widget = widgetEnabled && !userSetWidgetUrl && !origins.pre.widget ? await widgetUrlLookup() : null;
    const pass = corsPassOrigins(origins);
    if (pass) {
      run('npx', backendDeployArgs(forwarded, pass), '5 Allow the new CloudFront origin (CORS) — first deploy of a distribution only');
    }
  },

  summary: () => {
    const url = origins.pre.chat || origins.late.chat;
    if (userSetAppUrl) {
      console.log(`\n✓ You supplied your own appUrl (${contextValue(forwarded, 'appUrl')}) — skipped the CloudFront lookup.`);
    } else if (url) {
      console.log(`\n✅ Done. App is live at: ${url}`);
    } else if (!chatAppEnabled) {
      console.log('\n✅ Done. chat is not a declared capability, so there is no chat app to report.');
    } else {
      console.warn('\n! Could not read the chat CloudFront URL. Set --context appUrl=<your url> and redeploy.');
    }
    if (adminAppEnabled) {
      const adminUrl = userSetAdminAppUrl ? contextValue(forwarded, 'adminAppUrl') : origins.pre.admin || origins.late.admin;
      if (adminUrl) console.log(`   Admin console: ${adminUrl}`);
      else console.warn('! Could not read the admin CloudFront URL. Set --context adminAppUrl=<your url> and redeploy.');
    }
    if (widgetEnabled) {
      const widgetUrl = userSetWidgetUrl ? contextValue(forwarded, 'widgetUrl') : origins.pre.widget || origins.late.widget;
      if (widgetUrl) console.log(`   Widget: ${widgetUrl}/embed.js`);
      else console.warn('! Could not read the widget CloudFront URL. Set --context widgetUrl=<your url> and redeploy.');
    }
    console.log('   WAF (AWS managed rules) is ON by default; opt out with -c frontendWaf=false.');
  },
};

async function main() {
  for (const id of DEPLOY_STEPS) {
    const step = STEPS[id];
    if (!step) throw new Error(`deploy step "${id}" has no body in deploy.mjs`);
    await step();
  }
}

main().catch((err) => {
  console.error('deploy failed:', err.message || err);
  process.exit(1);
});
