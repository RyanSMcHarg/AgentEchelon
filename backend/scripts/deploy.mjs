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
function configFlags() {
  const p = path.join(BACKEND_DIR, 'deploy.config.json');
  if (!existsSync(p)) return [];
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const out = [];
    for (const [k, v] of Object.entries(cfg)) {
      if (k.startsWith('_') || v === undefined || v === null || v === '') continue; // `_`-keys are comments
      out.push('--context', `${k}=${v}`);
    }
    if (out.length) console.log(`  (loaded ${out.length / 2} context flags from deploy.config.json)`);
    return out;
  } catch (e) {
    console.warn(`! Could not read deploy.config.json: ${e.message}`);
    return [];
  }
}

const forwarded = [...configFlags(), ...process.argv.slice(2)]; // persisted config, then CLI (CLI wins)
const userSetAppUrl = forwarded.some((a, i) => a === '--context' && /^appUrl=/.test(forwarded[i + 1] || ''));

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
  run('node', ['scripts/deploy-frontend.mjs'], '4/4 Publish SPA to CloudFront');

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
