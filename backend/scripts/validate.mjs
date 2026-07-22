/**
 * validate.mjs - post-deploy launch validation.
 *
 * Runs the full validation sequence against a LIVE deployment so every tier flow is
 * exercised with REAL user->assistant messages (measured + recorded), then the admin
 * dashboard is verified against that real data. Nothing is faked.
 *
 *   1. sync-knowledge  - regenerate the project self-knowledge context (offline)
 *   2. seed-demo       - demo users + tier context + identity provisioning
 *   3. user e2e        - real per-tier conversations, mentions, drift, identity/exchange
 *   4. battle e2e      - a real /battle duel (needs a battle-enabled deploy)
 *   5. admin e2e       - verify the full dashboard, LAST, so it has the real data above
 *
 * Prereqs: a deployed stack + valid creds (`aws sso login --profile <p>`), and the
 * test credentials secret the e2e reads (test-credentials.ts / provision-test-users).
 *
 * Usage:
 *   AWS_PROFILE=<your-profile> node backend/scripts/validate.mjs
 *   AWS_PROFILE=<your-profile> node backend/scripts/validate.mjs --skip-battle
 *   node backend/scripts/validate.mjs --only=admin        # one phase
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const TESTS = path.resolve(__dirname, '..', '..', 'tests');

const args = process.argv.slice(2);
const skipBattle = args.includes('--skip-battle');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;

const PW = (specs, extraEnv = {}) =>
  `npx playwright test ${specs} --config=playwright.config.ts`;

// Phase → { label, cmd, cwd, env }. Ordered; admin is LAST by design.
const PHASES = [
  { id: 'knowledge', label: 'Sync project self-knowledge (curated context)', cwd: BACKEND,
    cmd: 'node scripts/sync-project-knowledge.mjs' },
  { id: 'seed', label: 'Seed demo (users + tier context + identity)', cwd: BACKEND,
    cmd: 'npx ts-node scripts/seed-demo.ts' },
  { id: 'user', label: 'User e2e: tier-context boundary, per-tier conversations, mentions, drift, identity', cwd: TESTS,
    cmd: PW('e2e/tier-context.spec.ts e2e/agent-intents.spec.ts e2e/credential-exchange.spec.ts e2e/mentions.spec.ts e2e/drift-detection.spec.ts') },
  { id: 'battle', label: 'Battle e2e: a real /battle duel', cwd: TESTS,
    cmd: PW('e2e/battle.spec.ts'), env: { BATTLE_E2E: '1' }, optional: true },
  { id: 'image-gen', label: 'Image gen-out: real external providers (FAL, OpenAI) return persistable PNGs', cwd: BACKEND,
    cmd: 'npx jest image-gen-live', env: { RUN_LIVE_IMAGE_GEN: '1' }, optional: true },
  // Data-producing e2e (cluster E): each drives a real flow so the empty admin
  // tabs get real data. Gated + optional so they only run in validation, never
  // in the default unit suite. See PLAN-E2E-DATA-COVERAGE.md.
  { id: 'feedback', label: 'Feedback e2e: a thumbs rating persists (→ #36 feedback data)', cwd: TESTS,
    cmd: PW('e2e/feedback.spec.ts'), env: { FEEDBACK_E2E: '1' }, optional: true },
  { id: 'experiments', label: 'Experiment e2e: create an A/B experiment + run a turn (→ #39 experiment_results)', cwd: TESTS,
    cmd: PW('e2e/experiments.spec.ts'), env: { EXPERIMENTS_E2E: '1' }, optional: true },
  { id: 'tasks', label: 'Task e2e: a report request opens a tracked task (→ #32/#35 task_id + Flows)', cwd: TESTS,
    cmd: PW('e2e/tasks.spec.ts'), env: { TASKS_E2E: '1' }, optional: true },
  { id: 'welcome', label: 'Welcome e2e: a new conversation opens with the seeded tier-aware orientation', cwd: TESTS,
    cmd: PW('e2e/welcome.spec.ts'), env: { WELCOME_E2E: '1' }, optional: true },
  // Score the exchanges/flows the e2e just produced BEFORE the admin phase reads the dashboard, so the
  // Effectiveness views verify against real relevance/completion instead of an unscored backlog.
  { id: 'evaluate', label: 'Evaluate: run the scorer on the e2e-produced exchanges/flows', fn: triggerEvaluation, optional: true },
  { id: 'admin', label: 'Admin e2e: verify the full dashboard against the real data', cwd: TESTS,
    cmd: PW('e2e/admin-dashboard.spec.ts') },
];

async function run(phase) {
  console.log(`\n=== [${phase.id}] ${phase.label} ===`);
  // A phase can be an in-process step (phase.fn) instead of a shell command.
  if (phase.fn) {
    try {
      await phase.fn();
      return true;
    } catch (err) {
      console.error(`\n[validate] FAILED at phase "${phase.id}": ${err?.message || err}`);
      return false;
    }
  }
  console.log(`    $ ${phase.cmd}   (cwd: ${path.relative(process.cwd(), phase.cwd) || '.'})`);
  const res = spawnSync(phase.cmd, {
    cwd: phase.cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...(phase.env || {}) },
  });
  if (res.status !== 0) {
    if (phase.optional && skipBattle) return true; // shouldn't reach; guarded below
    console.error(`\n[validate] FAILED at phase "${phase.id}" (exit ${res.status}).`);
    return false;
  }
  return true;
}

/**
 * Score the exchanges/flows the e2e just produced by invoking the evaluation runner synchronously,
 * so the admin phase verifies the dashboard against REAL scores instead of an empty backlog (the
 * scheduled run is only every 30 min). Best-effort: needs Aurora mode + EVAL_LAMBDA_NAME resolved.
 */
async function triggerEvaluation() {
  const name = process.env.EVAL_LAMBDA_NAME;
  if (!name) {
    console.warn('[validate] EVAL_LAMBDA_NAME not resolved (Athena mode, or the output is missing) — skipping on-demand evaluation.');
    return;
  }
  const client = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const res = await client.send(new InvokeCommand({
    FunctionName: name,
    Payload: Buffer.from(JSON.stringify({ action: 'post-e2e' })),
  }));
  const body = res.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
  console.log(`[validate] evaluation runner result: ${body.slice(0, 300)}`);
}

// Resolve the credential-exchange endpoint from CDK outputs and export it, so
// the credential-exchange e2e in the "user" phase actually runs. Without a URL
// that spec self-skips, and the identity contract (401 on anon, scoped-cred
// vend, IDOR ignore) is silently never validated. Pull it once here.
if (!process.env.VITE_CREDENTIAL_EXCHANGE_API_URL && !process.env.EXCHANGE_API_URL) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const q = "Stacks[0].Outputs[?OutputKey=='CredentialExchangeApiUrl'].OutputValue";
  const res = spawnSync(
    `aws cloudformation describe-stacks --stack-name AgentEchelonCognitoAuth --region ${region} --query "${q}" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  const url = (res.stdout || '').trim();
  if (url && url !== 'None') {
    process.env.VITE_CREDENTIAL_EXCHANGE_API_URL = url;
    console.log(`[validate] credential-exchange URL resolved from CDK outputs: ${url}`);
  } else {
    console.warn('[validate] WARNING: could not resolve CredentialExchangeApiUrl — credential-exchange tests will SKIP. Deploy AgentEchelonCognitoAuth or set VITE_CREDENTIAL_EXCHANGE_API_URL.');
  }
}

// Resolve the deployed app ORIGINS so the browser e2e runs against the live CloudFront
// distributions instead of the localhost dev-server defaults. E2E_BASE_URL is the CHAT app
// (playwright baseURL); E2E_ADMIN_BASE_URL is the standalone ADMIN app. These are DIFFERENT origins
// since the admin-app split — the battle/experiments/admin phases arm experiments on the admin origin,
// and battle-setup falls back to the chat URL when E2E_ADMIN_BASE_URL is unset (that origin has no
// admin UI, so the arm step times out on .admin-section-rail). Resolve both here so a plain
// `validate.mjs` run is self-contained. Absent stack / unset → the phase uses the localhost default.
for (const [envVar, stack, key] of [
  ['E2E_BASE_URL', 'AgentEchelonFrontend', 'DistributionUrl'],
  ['E2E_ADMIN_BASE_URL', 'AgentEchelonAdminFrontend', 'AdminDistributionUrl'],
]) {
  if (process.env[envVar]) continue;
  const region = process.env.AWS_REGION || 'us-east-1';
  const q = `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`;
  const res = spawnSync(
    `aws cloudformation describe-stacks --stack-name ${stack} --region ${region} --query "${q}" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  const url = (res.stdout || '').trim();
  if (url && url !== 'None') {
    process.env[envVar] = url;
    console.log(`[validate] ${envVar} resolved from ${stack}: ${url}`);
  } else {
    console.warn(`[validate] WARNING: could not resolve ${envVar} from ${stack} — browser e2e falls back to localhost (the LIVE app is not tested). Deploy ${stack} or set ${envVar}.`);
  }
}

// Resolve the image-gen-keys secret ARN so the image-gen phase can hit the real
// external providers exactly as the deployed processor does. Without it the live
// suite has no keys to load; surface that rather than let it fail opaquely.
if (!process.env.IMAGE_GEN_KEYS_SECRET_ARN) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const res = spawnSync(
    `aws secretsmanager list-secrets --region ${region} --query "SecretList[?contains(Name,'image-gen-keys')].ARN" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  // --output text can emit tabs/extra tokens; pick the actual ARN token.
  const arn = (res.stdout || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .find((s) => s.startsWith('arn:aws:secretsmanager:')) || '';
  if (arn) {
    process.env.IMAGE_GEN_KEYS_SECRET_ARN = arn;
    console.log(`[validate] image-gen-keys secret resolved from Secrets Manager: ${arn}`);
  } else {
    console.warn('[validate] WARNING: could not resolve the image-gen-keys secret — the image-gen phase will fail (optional; provision agent-echelon/image-gen-keys or set IMAGE_GEN_KEYS_SECRET_ARN).');
  }
}

// The data-producing e2e specs (feedback/experiments/tasks) read the app API URLs
// from VITE_* env. They live in frontend/.env (generated from CDK outputs); load
// any that aren't already set so the phases can reach the live APIs.
const FRONTEND_ENV = path.join(BACKEND, '..', 'frontend', '.env');
for (const key of ['VITE_USER_FEEDBACK_API_URL', 'VITE_EXPERIMENTS_API_URL', 'VITE_ANALYTICS_API_URL']) {
  if (process.env[key]) continue;
  try {
    const envText = fs.readFileSync(FRONTEND_ENV, 'utf8');
    const m = envText.match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (m) process.env[key] = m[1].trim();
  } catch { /* frontend/.env absent — the gated phase will report the missing URL */ }
}

// Resolve the evaluation runner Lambda name (Aurora mode only) so the "evaluate" phase can score the
// e2e-produced exchanges on demand. Absent in Athena mode / older deploys → that phase self-skips.
if (!process.env.EVAL_LAMBDA_NAME) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const q = "Stacks[0].Outputs[?OutputKey=='EvaluationLambdaName'].OutputValue";
  const res = spawnSync(
    `aws cloudformation describe-stacks --stack-name AgentEchelonAnalyticsAurora --region ${region} --query "${q}" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  let name = (res.stdout || '').trim();
  if (name === 'None') name = '';
  // Fallback: the EvaluationLambdaName output ships in a newer analytics-stack version; until that
  // stack is redeployed, resolve the runner by its function-name prefix instead.
  if (!name) {
    const lf = spawnSync(
      `aws lambda list-functions --region ${region} --query "Functions[?contains(FunctionName,'AnalyticsAuro') && contains(FunctionName,'EvaluationLambda')].FunctionName | [0]" --output text`,
      { shell: true, encoding: 'utf8' },
    );
    const byPrefix = (lf.stdout || '').trim();
    if (byPrefix && byPrefix !== 'None') name = byPrefix;
  }
  if (name) {
    process.env.EVAL_LAMBDA_NAME = name;
    console.log(`[validate] evaluation Lambda resolved: ${name}`);
  } else {
    console.warn('[validate] NOTE: could not resolve the evaluation Lambda — the post-e2e evaluate step will skip (Athena mode / analytics stack not deployed).');
  }
}

let phases = PHASES;
if (only) phases = PHASES.filter((p) => p.id === only);
if (skipBattle) phases = phases.filter((p) => p.id !== 'battle');

if (phases.length === 0) {
  console.error(`[validate] no matching phase for --only=${only}. Valid: ${PHASES.map((p) => p.id).join(', ')}`);
  process.exit(2);
}

console.log(`[validate] running phases: ${phases.map((p) => p.id).join(' -> ')}`);
for (const phase of phases) {
  const ok = await run(phase);
  if (!ok) {
    if (phase.optional) {
      console.warn(`[validate] phase "${phase.id}" is optional (needs a battle-enabled deploy); continuing. Use --skip-battle to silence.`);
      continue;
    }
    process.exit(1);
  }
}
console.log('\n[validate] all phases passed.');
