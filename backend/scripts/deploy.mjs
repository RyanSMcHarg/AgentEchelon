/**
 * One-command deploy → live CloudFront app.
 *
 * `npm run deploy -- <cdk context flags>` does the whole thing an OSS deployer
 * (or their coding agent) needs, instead of leaving CloudFront empty after
 * `cdk deploy --all`:
 *
 *   0. npm run build              (compile Lambda TS→JS so esbuild doesn't bundle stale .js)
 *   1. resolve appUrl + deploy    (read the live CloudFront origin FIRST, pass it as
 *                                  appUrl in the ONE backend pass so CORS is correct
 *                                  immediately — no transient localhost window that a
 *                                  mid-deploy failure could leave the live app stuck in)
 *   2. sync-context               (tiered context → S3)
 *   3. gen-frontend-env           (writes frontend/.env from the live outputs)
 *   4. deploy-frontend            (builds the SPA + syncs to the CloudFront S3 origin + invalidates)
 *   (first-ever deploy only: one extra appUrl pass, since the distribution didn't exist yet)
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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
// Compiled from lib/config/deploy-context.ts (npm run build runs first, step 0).
import { compareDeployContext, describeDeployContextGap } from '../lib/config/deploy-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const REGION = process.env.AWS_REGION || 'us-east-1';
const FRONTEND_STACK = process.env.FRONTEND_STACK_NAME || 'AgentEchelon' + 'Frontend';

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
  const p = path.join(BACKEND_DIR, 'deploy.config.json');
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

  const out = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (k.startsWith('_') || v === undefined || v === null || v === '') continue; // `_`-keys are comments
    out.push('--context', `${k}=${v}`);
  }
  console.log(`  (loaded ${out.length / 2} context flags from deploy.config.json)`);
  return out;
}

// `--no-deploy-config` is ours, not cdk's: strip it before forwarding or cdk rejects it.
const cliArgs = process.argv.slice(2).filter((a) => a !== NO_CONFIG_FLAG && a !== PARTIAL_CONFIG_FLAG);
const forwarded = [...configFlags(), ...cliArgs]; // persisted config, then CLI (CLI wins)
const userSetAppUrl = forwarded.some((a, i) => a === '--context' && /^appUrl=/.test(forwarded[i + 1] || ''));
// Whether this instance provisions the standalone admin console. Read from the SAME
// forwarded context the CDK app gates the stack on, so the publish step and the stack
// can never disagree. Accepts the string form (`--context enableAdminApp=true`) since
// that is how context arrives on the command line.
const adminAppEnabled = forwarded.some(
  (a, i) => a === '--context' && /^enableAdminApp=(true|1)$/i.test(forwarded[i + 1] || ''),
);

function run(cmd, args, label) {
  console.log(`\n▶ ${label}\n  ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: BACKEND_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${res.status}). Aborting.`);
    process.exit(res.status || 1);
  }
}

async function cloudFrontUrl() {
  const cfn = new CloudFormationClient({ region: REGION });
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: FRONTEND_STACK }));
  const outs = resp.Stacks?.[0]?.Outputs || [];
  return outs.find((o) => o.OutputKey === 'DistributionUrl')?.OutputValue;
}

/**
 * SAFETY GUARD (shared / multi-app accounts). `cdk deploy --all` deploys every
 * stack in the SYNTHESIZED app. If the instance-name context is wrong, that
 * synthesis can be a DIFFERENT app's stacks (a look-alike on a shared account),
 * and --all would deploy THOSE. Before deploying, synthesize the stack LIST and
 * refuse if any stack falls outside this deployment's expected prefix.
 *
 * The prefix is the instance name the script already assumes (from
 * FRONTEND_STACK_NAME, default "AgentEchelon") — independent of the cdk context,
 * so a wrong `-c instanceName=...` can't slip its own stacks past this check
 * (they simply won't match the prefix). Override with AE_DEPLOY_STACK_PREFIX only
 * if you deliberately deploy mixed-prefix stacks.
 */
function assertOnlyOurStacks() {
  const expectedPrefix = process.env.AE_DEPLOY_STACK_PREFIX || FRONTEND_STACK.replace(/Frontend$/, '');
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
}

async function main() {
  // 0. Compile Lambda TS → JS FIRST. CDK's NodejsFunction esbuild resolves the
  //    `.js` import specifiers to on-disk `.js` files, so without a fresh build
  //    it bundles STALE `.js` and edited `.ts` silently doesn't ship (a clean
  //    exit-0 deploy that changes nothing). Build up front so assets = source.
  run('npm', ['run', 'build'], '0/4 Compile Lambda TS → JS (avoid stale-.js bundling)');

  // Refuse to `--all`-deploy anything outside this instance (shared-account safety).
  assertOnlyOurStacks();

  // Resolve the live CloudFront origin BEFORE deploying, so `appUrl` is set
  // correctly in the FIRST (and normally only) backend pass. The previous flow
  // deployed the backend with appUrl DEFAULTING to http://localhost:5173 and
  // fixed CORS in a SEPARATE second pass — so any failure between the two passes
  // (a mid-deploy stack rollback, a Ctrl-C) left the LIVE app CORS-broken
  // (ALLOWED_ORIGIN=localhost → "Failed to fetch" for every user). On a redeploy
  // the distribution already exists, so we set appUrl up front and there is NO
  // broken window. `userSetAppUrl` ⇒ the caller already put appUrl in `forwarded`.
  const preUrl = userSetAppUrl ? null : await cloudFrontUrl().catch(() => null);
  const corsFlag = preUrl ? ['--context', `appUrl=${preUrl}`] : [];

  const cdkBase = ['cdk', 'deploy', '--all', '--require-approval', 'never', ...forwarded];

  run('npx', [...cdkBase, ...corsFlag], '1/4 Deploy backend stacks (appUrl pre-resolved — CORS never transiently broken)');
  run('node', ['scripts/sync-context.mjs'], '2/4 Sync tiered context into S3');
  run('node', ['scripts/gen-frontend-env.mjs'], '3/4 Generate frontend/.env from outputs');
  run('node', ['scripts/deploy-frontend.mjs'], '4/4 Publish chat SPA to CloudFront');

  // The admin console is a SEPARATE package with its own bucket + distribution, and
  // deploy-frontend.mjs only publishes it when passed --admin. Without this step a
  // deploy updates the admin BACKEND (AdminPlane, Experiments, AnalyticsAurora, ...)
  // while leaving the admin BUNDLE frozen at whatever the last manual --admin run
  // shipped — a stale console talking to a moved backend, which surfaces as
  // unexplained 4xx in the console rather than as an obvious deploy failure.
  // Gated on the same flag that provisions the stack, so a chat-only deployment
  // (enableAdminApp unset) does not try to publish a distribution that isn't there.
  if (adminAppEnabled) {
    run('node', ['scripts/deploy-frontend.mjs', '--admin'], '4b/4 Publish admin console to CloudFront');
  } else {
    console.log('\n• enableAdminApp is not set — skipping the admin console publish.');
  }

  const url = preUrl || (await cloudFrontUrl().catch(() => null));
  if (!url) {
    console.warn('\n! Could not read the CloudFront URL; skipping the CORS step. Set --context appUrl=<your url> and redeploy.');
    return;
  }
  if (userSetAppUrl) {
    console.log(`\n✓ You supplied your own appUrl — skipping the CloudFront CORS step.\n  App (CloudFront origin): ${url}`);
  } else if (preUrl) {
    // appUrl was already applied in pass 1 — nothing to close, no broken window.
    console.log(`\n✅ Done. App is live at: ${url}`);
    console.log('   WAF (AWS managed rules) is ON by default; opt out with -c frontendWaf=false.');
  } else {
    // FIRST-EVER deploy only: the distribution didn't exist before pass 1, so
    // appUrl couldn't be pre-resolved. Apply it now. A failure HERE only affects
    // a brand-new app that isn't serving anyone yet — it never breaks a live one.
    run('npx', [...cdkBase, '--context', `appUrl=${url}`], '5 Allow the CloudFront origin (CORS) — first deploy only');
    console.log(`\n✅ Done. App is live at: ${url}`);
    console.log('   WAF (AWS managed rules) is ON by default; opt out with -c frontendWaf=false.');
  }
}

main().catch((err) => {
  console.error('deploy failed:', err.message || err);
  process.exit(1);
});
