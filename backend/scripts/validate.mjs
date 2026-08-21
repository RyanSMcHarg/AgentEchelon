/**
 * validate.mjs - post-deploy launch validation.
 *
 * Runs the full validation sequence against a LIVE deployment so every classification flow is
 * exercised with REAL user->assistant messages (measured + recorded), then the admin
 * dashboard is verified against that real data. Nothing is faked.
 *
 * Phases (all run by default, in order; admin is LAST so it verifies against the real data above):
 *   1. knowledge     - regenerate the project self-knowledge context (offline)
 *   1b. knowledge-rag - ingest the platform docs into pgvector for deep Q&A (Aurora only) [optional]
 *   2. seed          - demo users + classification context + identity provisioning
 *   3. user          - real per-classification conversations, mentions, drift, identity/exchange
 *                      (agent-intents is general-heavy by design — the DOMAIN-intent + multi-step-task
 *                       traffic that populates the admin console comes from the data-producing phases below)
 *   4. battle        - a real /battle duel (needs a battle-enabled deploy)          [optional]
 *   5. image-gen     - real external image providers return persistable PNGs         [optional]
 *   6. feedback      - a thumbs rating persists (→ feedback data)                     [optional]
 *   7. experiments   - create an A/B experiment + run a turn (→ experiment_results)   [optional]
 *   8. tasks         - report/extraction/troubleshooting across ALL THREE classifications, driven to real
 *                      task rows + downloaded deliverables (→ Tasks/Flows admin data) [optional]
 *   9. profiles      - portable/versioned profiles: config lifecycle (copy/edit/activate/export/
 *                      import) + persona & guardrail selection TAKE EFFECT at runtime            [optional]
 *  10. welcome       - a new conversation opens with the seeded classification-aware orientation [optional]
 *  11. evaluate      - score the exchanges/flows the e2e just produced (Aurora only)  [optional]
 *  12. admin         - verify the full dashboard against all of the above
 *
 * The [optional] data-producing phases are what fill the admin console with variety (domain intents,
 * multi-step tasks, experiments, feedback). They SELF-SKIP when their deployed dependency is not
 * resolved (an app-API URL from CDK outputs, Aurora mode, a battle-enabled deploy). A self-skip exits
 * 0, so this script cannot tell "ran" from "skipped" per se — instead it prints a DATA READINESS
 * preflight (below) and an END-OF-RUN SUMMARY so a sparse admin console is VISIBLE, not silent.
 *
 * Prereqs: a deployed stack + valid creds (`aws sso login --profile <p>`), the test credentials secret
 * the e2e reads (test-credentials.ts / provision-test-users), and `frontend/.env` generated from CDK
 * outputs (gen-frontend-env) so the data-producing phases can reach the live app APIs.
 *
 * Usage:
 *   AWS_PROFILE=<your-profile> node backend/scripts/validate.mjs
 *   AWS_PROFILE=<your-profile> node backend/scripts/validate.mjs --skip-battle
 *   node backend/scripts/validate.mjs --only=tasks        # one phase
 *   node backend/scripts/validate.mjs --strict            # optional-phase failure fails the run
 *   (valid --only ids: knowledge knowledge-rag seed user battle image-gen feedback experiments tasks
 *    task-answer profiles knowledge-qa welcome evaluate admin auth governance context-sources
 *    tasks-deep task-branches onboarding bilingual notifications cost latency task-resolution open-work attribution
 *    admin-surfaces)
 *
 * Exit code: non-zero if a REQUIRED phase fails, or if any phase fails under --strict.
 * Without --strict an optional phase's failure is reported loudly but exits 0, so read the
 * final verdict line rather than the exit code alone.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const require = createRequire(import.meta.url);
const { resolveInstanceName, resolveStackPrefix, classifyStackLookup } = require('./lib/stack-lookup.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const TESTS = path.resolve(__dirname, '..', '..', 'tests');

const args = process.argv.slice(2);
const skipBattle = args.includes('--skip-battle');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;
// `--strict` makes an OPTIONAL phase's failure fail the whole run. Off by default so a
// deployment that genuinely lacks an optional dependency (no image-gen keys, no Aurora)
// still completes; on in CI, where a silent optional failure would otherwise read as green.
const STRICT = args.includes('--strict');
// Optional phases that RAN and FAILED. Collected so the final verdict can name them
// instead of printing "all required phases passed" over the top of a real failure.
const failedOptional = [];

// The deployment's instance name — the SSM root without its leading slash. Specs that resolve shared
// resources from the SSM contract (`/<instance>/shared/...`) need it, and a missing value reads as a
// broken feature rather than as unset configuration.
const INSTANCE_NAME = resolveInstanceName(process.env);

/**
 * This instance's CloudFormation stack prefix. Resolved by the same rules the rest of the tooling
 * uses (`AE_STACK_PREFIX` / `STACK_PREFIX` / `FRONTEND_STACK_NAME`, else PascalCase of the instance
 * name) - see scripts/lib/stack-lookup.cjs.
 *
 * EVERY stack this script names is built from it, for two reasons. It ANCHORS resource lookups to
 * this deployment: in a shared account, "the function whose name contains AnalyticsAuro" matches
 * other projects' functions too, and the thing being resolved here is INVOKED, so an unanchored
 * match is a validation run pointed at somebody else's data. And it keeps the script usable on a
 * deployment that is not the default instance: a hardcoded `AgentEchelon...` resolves nothing there,
 * which now fails the run outright at the frontend lookup below.
 */
const STACK_PREFIX = resolveStackPrefix(process.env);

const PW = (specs, extraEnv = {}) =>
  `npx playwright test ${specs} --config=playwright.config.ts`;

// Phase → { label, cmd, cwd, env }. Ordered; admin is LAST by design.
const PHASES = [
  { id: 'knowledge', label: 'Sync project self-knowledge (curated context)', cwd: BACKEND,
    cmd: 'node scripts/sync-project-knowledge.mjs' },
  // The OTHER half of the platform self-knowledge. `knowledge` above writes the curated index (a title
  // plus a ~400-character summary per doc, read through the load_platform_info tool); this ingests the
  // full text into pgvector, which is what answers "how does AgentEchelon work?" from the documentation
  // instead of from summaries.
  //
  // It belongs in the single setup command precisely because skipping it is SILENT - the assistant
  // still answers, just thinly, so there is no error for anyone to notice. Aurora-only, and removed
  // from the phase list below when no Aurora stack resolves.
  { id: 'knowledge-rag', label: 'Ingest the platform docs for deep Q&A (Aurora only)', cwd: BACKEND,
    cmd: 'node scripts/sync-project-knowledge.mjs --rag', optional: true },
  { id: 'seed', label: 'Seed demo (users + classification context + identity)', cwd: BACKEND,
    cmd: 'npx ts-node scripts/seed-demo.ts' },
  // `deployed-build.spec.ts` runs FIRST in this phase and takes ~2s. It answers "is the deployed chat
  // app the one these specs were written against?", which is the question every browser assertion
  // below silently assumes. It existed but NO phase named it - the same gap the profiles phase
  // records - so the guard built to catch a stale deployment had never run in a sweep. A stale bundle
  // makes a correct spec fail for a reason that has nothing to do with the code under test, and that
  // is worth two seconds at the front rather than a hand-diff of the served JavaScript.
  { id: 'user', label: 'User e2e: deployed-build guard, classification-context boundary, per-classification conversations, mentions, drift, identity, fulfillment retry', cwd: TESTS,
    cmd: PW('e2e/deployed-build.spec.ts e2e/classification-context.spec.ts e2e/agent-intents.spec.ts e2e/credential-exchange.spec.ts e2e/mentions.spec.ts e2e/drift-detection.spec.ts '
      + 'e2e/fulfillment-retry.spec.ts e2e/dispatch-routing.spec.ts') },
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
    cmd: PW('e2e/tasks.spec.ts'), env: { TASKS_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
  // A task answer in a SHARED conversation (ADR-032). Its own phase because the shape is expensive and
  // specific: more than one person in the room AND an open item held by the answerer. Every
  // single-user test passes whatever this code does - in a 1:1 Chime routes every message to the
  // assistant regardless of addressing - which is exactly how a person answering a question they were
  // asked came to reach nobody at all, silently.
  { id: 'task-answer', label: 'Task-answer e2e: an unaddressed answer in a shared conversation still reaches its assistant', cwd: TESTS,
    cmd: PW('e2e/task-answer.spec.ts'), env: { TASK_ANSWER_E2E: '1' }, optional: true },
  // Portable/versioned profiles: the Profiles admin tab loads the live list, AND the full config
  // lifecycle (copy → edit guardrail+machines+persona → activate → export → import → TAKES EFFECT).
  // Mutates the 'standard' profile and rolls it back in-spec, so it is safe between data phases.
  // The portable-artifact specs run HERE too. They existed but no phase named them, so the
  // export/import round trip, the activate/rollback pointer, and the fail-closed activation gates
  // never ran in a validate sweep - a phase reporting "passed" while the portable half of the
  // feature it is named for went untouched.
  { id: 'profiles', label: 'Profiles e2e: portable artifact lifecycle (export/import/activate/rollback + gates) + persona & guardrail take effect', cwd: TESTS,
    cmd: PW('e2e/admin-profiles.spec.ts e2e/profile-config.spec.ts e2e/portable-profile-lifecycle.spec.ts '
      + 'e2e/portable-profile-gates.spec.ts e2e/profile-ownership.spec.ts'),
    env: { PROFILE_CONFIG_E2E: '1' }, optional: true },
  // Proves the platform RAG corpus is not just ingested but RETRIEVED: it asserts the answer carries
  // detail that exists only in a doc BODY. A summary-only answer is fluent and on-topic, so nothing
  // else in this suite would notice the corpus being unreachable.
  { id: 'knowledge-qa', label: 'Platform Q&A e2e: the assistant answers about itself from the docs, not the summary index', cwd: TESTS,
    cmd: PW('e2e/platform-knowledge.spec.ts'), env: { PLATFORM_KNOWLEDGE_E2E: '1' }, optional: true },
  { id: 'welcome', label: 'Welcome e2e: a new conversation opens with the seeded classification-aware orientation', cwd: TESTS,
    cmd: PW('e2e/welcome.spec.ts'), env: { WELCOME_E2E: '1' }, optional: true },
  // Score the exchanges/flows the e2e just produced BEFORE the admin phase reads the dashboard, so the
  // Effectiveness views verify against real relevance/completion instead of an unscored backlog.
  { id: 'evaluate', label: 'Evaluate: run the scorer on the e2e-produced exchanges/flows', fn: triggerEvaluation, optional: true },
  { id: 'admin', label: 'Admin e2e: verify the full dashboard against the real data', cwd: TESTS,
    cmd: PW('e2e/admin-dashboard.spec.ts') },

  // ---------------------------------------------------------------------------------------------
  // The phases below run specs that, until they were added here, NO phase named. They were not
  // skipped and not gated - they simply never ran, so a green validate reported on about two thirds
  // of the suite it appeared to cover. Grouped by what they exercise rather than dumped into one
  // phase, so a failure names an area instead of a spec list.
  //
  // Ordered AFTER admin because several drive real conversations and would otherwise add data the
  // dashboard phase does not expect. `auth` is the exception below - see its note.
  // ---------------------------------------------------------------------------------------------

  { id: 'auth', label: 'Auth e2e: sign-up and sign-in against the live Cognito pool', cwd: TESTS,
    // Runs its own registration flow, so it neither needs nor disturbs the seeded users.
    cmd: PW('e2e/signup.spec.ts e2e/signin.spec.ts'), optional: true },

  { id: 'governance', label: 'Governance e2e: abuse controls, moderation, access auditing, archive membership', cwd: TESTS,
    // The controls that are supposed to STOP things. A silent failure here reads as "nothing
    // happened", which is exactly what a working control also looks like - hence real assertions.
    cmd: PW('e2e/abuse-controls.spec.ts e2e/moderation.spec.ts e2e/access-auditing.spec.ts '
      + 'e2e/archive-membership.spec.ts'), optional: true },

  { id: 'context-sources', label: 'Context-source e2e: sources resolve, and the staleness alarm fires', cwd: TESTS,
    cmd: PW('e2e/context-sources.spec.ts e2e/context-source-alarm.spec.ts'), optional: true },

  { id: 'tasks-deep', label: 'Task e2e (deep): the state machine advances, and tasks cross channels', cwd: TESTS,
    // Same TASKS_E2E gate the `tasks` phase uses; these are the two specs that phase never named.
    //
    // E2E_INSTANCE_NAME is how these specs find the task tables: they read the shared SSM contract
    // at `/<instance>/shared/tables/{agent,user}-tasks-name`. Without it both fail instantly on
    // "AgentTasks table must resolve" - a harness gap that looks exactly like a broken task machine.
    // The instance is the SSM root without its leading slash, which is what every stack publishes under.
    cmd: PW('e2e/task-state-machine.spec.ts e2e/cross-channel-tasks.spec.ts'),
    env: { TASKS_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // The BRANCHES, which are where the machines have actually failed people. `tasks-deep` proves a
  // task's persisted state is valid; this drives a report past its outline into a revision and a
  // close, and drives the scheduling machine through a confirmation, a correction and a decline.
  // Its own phase because these are long multi-turn journeys (several model turns each) and because
  // a branch failure is a different diagnosis from "the row is malformed".
  { id: 'task-branches', label: 'Task e2e (branches): a report is revised and closed, a placement is confirmed', cwd: TESTS,
    cmd: PW('e2e/report-flow-branches.spec.ts e2e/place-item-flow.spec.ts'),
    env: { TASKS_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  { id: 'onboarding', label: 'Onboarding e2e: the intake runs once per user, not once per conversation', cwd: TESTS,
    cmd: PW('e2e/onboarding-intake.spec.ts'), env: { ONBOARDING_E2E: '1' }, optional: true },

  { id: 'bilingual', label: 'Bilingual e2e: a conversation holds its language across turns', cwd: TESTS,
    cmd: PW('e2e/bilingual-conversations.spec.ts'), optional: true },

  { id: 'notifications', label: 'Notification e2e: the bridge delivers outside the app', cwd: TESTS,
    cmd: PW('e2e/notification-bridge.spec.ts'), optional: true },

  { id: 'cost', label: 'Cost e2e: sleep mode parks idle spend and wakes on demand', cwd: TESTS,
    cmd: PW('e2e/cost-sleep-mode.spec.ts'), optional: true },

  { id: 'latency', label: 'Latency e2e: time-to-first-token stays inside the stated SLA', cwd: TESTS,
    cmd: PW('e2e/latency.spec.ts'), env: { LATENCY_E2E: '1' }, optional: true },

  // Task resolution is measured SEPARATELY from turn latency, and so is its phase: the two read
  // different views with different denominators, and a failure in one says nothing about the other.
  { id: 'task-resolution', label: 'Task-resolution e2e: a real task reaches v_task_resolution', cwd: TESTS,
    cmd: PW('e2e/task-resolution.spec.ts'), env: { TASK_RESOLUTION_E2E: '1' }, optional: true },

  // The cross-conversation queue. Separate from the `tasks` phase because that one asserts what a task
  // DOES in its own conversation; this asserts that a person's items from several conversations are
  // one list, which no single-conversation test can see.
  { id: 'open-work', label: 'Open-work e2e: "waiting on you" is one queue across conversations', cwd: TESTS,
    cmd: PW('e2e/open-work-items.spec.ts'), env: { OPEN_WORK_E2E: '1' }, optional: true },

  // ADR-027 phase 2. The turn-level assertion a unit test cannot make: what the MODEL does when it is
  // taught a labelling convention, which is where the convention can escape into the channel.
  { id: 'attribution', label: 'Attribution e2e: a merged turn is labelled, a reply never is', cwd: TESTS,
    cmd: PW('e2e/speaker-attribution.spec.ts'), env: { ATTRIBUTION_E2E: '1' }, optional: true },

  { id: 'admin-surfaces', label: 'Admin e2e (surfaces): navigation, flows, attachment access, render integrity', cwd: TESTS,
    // The dashboard phase asserts DATA; these assert the console around it - the parts an operator
    // touches to reach that data.
    cmd: PW('e2e/admin-nav.spec.ts e2e/admin-flow.spec.ts e2e/admin-attachments.spec.ts '
      + 'e2e/admin-dashboard-render.spec.ts'), optional: true },
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
    // A GATED SKIP IS NOT A PASS. Default the skip-visibility reporter to its strict mode so a test
    // that opted out fails the phase instead of quietly shrinking what "passed" covers. This is not
    // hypothetical: a spec whose credential helper was called without `await` self-skipped, and the
    // phase still reported `passed` over 33 of 34 tests. Validate exists to answer "is the
    // deployment good", and a run that silently drops coverage cannot answer it.
    //
    // E2E_ALLOW_SKIPS=1 opts out, for a deployment that genuinely lacks an OPTIONAL dependency
    // (no image-gen keys, no admin app, no second premium user) rather than one that is misconfigured.
    env: {
      E2E_REQUIRE_ALL: process.env.E2E_ALLOW_SKIPS === '1' ? '' : '1',
      ...process.env,
      ...(phase.env || {}),
    },
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

// Say which deployment this run is about to resolve everything from, before anything is looked up.
console.log(`[validate] instance "${INSTANCE_NAME}" — CloudFormation stack prefix "${STACK_PREFIX}" (override: AE_STACK_PREFIX).`);

// Resolve the credential-exchange endpoint from CDK outputs and export it, so
// the credential-exchange e2e in the "user" phase actually runs. Without a URL
// that spec self-skips, and the identity contract (401 on anon, scoped-cred
// vend, IDOR ignore) is silently never validated. Pull it once here.
if (!process.env.VITE_CREDENTIAL_EXCHANGE_API_URL && !process.env.EXCHANGE_API_URL) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const stack = `${STACK_PREFIX}CognitoAuth`;
  const q = "Stacks[0].Outputs[?OutputKey=='CredentialExchangeApiUrl'].OutputValue";
  const res = spawnSync(
    `aws cloudformation describe-stacks --stack-name ${stack} --region ${region} --query "${q}" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  const url = (res.stdout || '').trim();
  if (url && url !== 'None') {
    process.env.VITE_CREDENTIAL_EXCHANGE_API_URL = url;
    console.log(`[validate] credential-exchange URL resolved from CDK outputs: ${url}`);
  } else {
    const { presence, why } = classifyStackLookup(res);
    console.warn(`[validate] WARNING: could not resolve CredentialExchangeApiUrl from ${stack} — credential-exchange tests will SKIP.`);
    console.warn(presence === 'unknown'
      ? `[validate] The lookup itself failed, so the stack's state is UNKNOWN: ${why}`
      : `[validate] Deploy ${stack} or set VITE_CREDENTIAL_EXCHANGE_API_URL.`);
  }
}

// Resolve the deployed app ORIGINS so the browser e2e runs against the live CloudFront
// distributions instead of the localhost dev-server defaults. E2E_BASE_URL is the CHAT app
// (playwright baseURL); E2E_ADMIN_BASE_URL is the standalone ADMIN app. These are DIFFERENT origins
// since the admin-app split — the battle/experiments/admin phases arm experiments on the admin origin,
// and battle-setup falls back to the chat URL when E2E_ADMIN_BASE_URL is unset (that origin has no
// admin UI, so the arm step times out on .admin-section-rail). Resolve both here so a plain
// `validate.mjs` run is self-contained. Absent stack / unset → the phase uses the localhost default.
//
// The stack names are built from STACK_PREFIX, not hardcoded: this lookup is FATAL for the chat
// origin, so a hardcoded `AgentEchelon...` would kill the run outright on any deployment whose
// instance name is not the default - a script refusing to run against the very deployment it was
// pointed at. STACK_PREFIX is overridable (AE_STACK_PREFIX / STACK_PREFIX), which the failure says.
for (const [envVar, stack, key] of [
  ['E2E_BASE_URL', `${STACK_PREFIX}Frontend`, 'DistributionUrl'],
  ['E2E_ADMIN_BASE_URL', `${STACK_PREFIX}AdminFrontend`, 'AdminDistributionUrl'],
]) {
  if (process.env[envVar]) continue;
  const region = process.env.AWS_REGION || 'us-east-1';
  const q = `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`;
  const res = spawnSync(
    `aws cloudformation describe-stacks --stack-name ${stack} --region ${region} --query "${q}" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  const url = (res.stdout || '').trim();
  // Name the reason rather than listing the possibilities: an unaskable lookup (expired SSO, no
  // credentials, a denied call) is a different fix from a stack that is genuinely not deployed.
  const { presence, why } = classifyStackLookup(res);
  const cause = presence === 'unknown'
    ? `the lookup FAILED, so the stack's state is UNKNOWN: ${why}`
    : presence === 'absent'
      ? `${stack} is not deployed in ${region}`
      : `${stack} exists but publishes no ${key} output`;
  if (url && url !== 'None') {
    process.env[envVar] = url;
    console.log(`[validate] ${envVar} resolved from ${stack}: ${url}`);
  } else if (envVar === 'E2E_BASE_URL' && process.env.E2E_ALLOW_LOCALHOST !== '1') {
    // FATAL, not a warning. Falling back to localhost does not fail the run - it silently retargets
    // every browser phase at a dev server that is not there, or worse, at one that is. The most
    // common cause is an EXPIRED SSO token, so the failure arrives exactly when someone is trying to
    // confirm a deploy, and it reports as a sweep that "ran" without having touched the deployment.
    // A validate run that cannot name the live origin has nothing to say about it.
    console.error(
      `\n[validate] FATAL: could not resolve ${envVar} from ${stack} — ${cause}.\n`
      + '  Browser e2e would silently fall back to localhost and report on a deployment it never reached.\n'
      + (presence === 'unknown'
        ? '  Repair the AWS session first (aws sso login --profile <your-profile>); nothing here says the stack is missing.\n'
        : `  Deploy ${stack}, or set ${envVar} directly.\n`)
      + `  Stacks named differently? This deployment's prefix resolved to "${STACK_PREFIX}"; override with\n`
      + '  AE_STACK_PREFIX=<prefix> (or STACK_PREFIX / AE_INSTANCE_NAME, as the rest of the tooling takes it).\n'
      + '  Deliberately testing a local dev server:  E2E_ALLOW_LOCALHOST=1 node scripts/validate.mjs\n',
    );
    process.exit(1);
  } else {
    console.warn(`[validate] WARNING: could not resolve ${envVar} from ${stack} — ${cause}. Browser e2e falls back to localhost (the LIVE app is not tested). Deploy ${stack} or set ${envVar}.`);
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

// The data-producing e2e specs (feedback/experiments/tasks) read the app API URLs from VITE_* env.
// Since the admin/chat app split (SPEC-SEPARATE-ADMIN-APP), gen-frontend-env writes PER-PACKAGE .env
// files (packages/admin/.env + packages/chat/.env), NOT a root frontend/.env. Read the package files
// (admin first: the admin-only URLs — experiments/analytics/manage-profiles — live only there; the
// shared pool ids are in both), falling back to a legacy root frontend/.env for back-compat. Load any
// key not already set so the phases can reach the live APIs. VITE_USER_POOL_ID + VITE_IDENTITY_POOL_ID
// are loaded here too: the admin/tasks/experiments phases SigV4-sign their analytics reads
// (helpers/signed-analytics.ts), exchanging the id token for Identity-Pool creds — without these two,
// those signed reads fail and the admin verification is empty.
const FRONTEND = path.join(BACKEND, '..', 'frontend');
// PER-PACKAGE ONLY. The legacy root `frontend/.env` used to sit at the end of this list as
// "back-compat", and on 2026-08-06 it silently supplied a dead user pool, a dead identity pool and an
// NXDOMAIN experiments API to three whole phases - because the per-package files were missing (a
// `git worktree remove` wiped `frontend/packages/**`, and the `git checkout -- frontend/` recovery
// does not restore gitignored files). A fallback to a pre-split artifact cannot be distinguished from
// a healthy resolve at the point of use, so it is gone. If the per-package files are absent, that is
// now a loud failure below, not a silent substitution.
const ENV_CANDIDATES = [
  path.join(FRONTEND, 'packages', 'admin', '.env'),
  path.join(FRONTEND, 'packages', 'chat', '.env'),
];
const missingEnvFiles = ENV_CANDIDATES.filter((f) => !fs.existsSync(f));
if (missingEnvFiles.length === ENV_CANDIDATES.length) {
  console.error('\n[validate] FATAL: no per-package frontend env found. Looked for:');
  for (const f of ENV_CANDIDATES) console.error(`    ${f}`);
  console.error('[validate] Every VITE_* dependent phase would run against unset or stale values.');
  console.error('[validate] Fix: cd backend && AWS_PROFILE=<profile> node scripts/gen-frontend-env.mjs\n');
  process.exit(1);
} else if (missingEnvFiles.length > 0) {
  console.warn(`\n[validate] WARNING: missing ${missingEnvFiles.map((f) => path.relative(FRONTEND, f)).join(', ')}`);
  console.warn('[validate] Admin-only URLs live in packages/admin/.env; regenerate with gen-frontend-env.\n');
}
if (fs.existsSync(path.join(FRONTEND, '.env'))) {
  console.warn('[validate] NOTE: a legacy root frontend/.env exists and is NO LONGER READ (pre-split');
  console.warn('[validate] artifact). Delete it - it is a trap that once fed dead ids into a full run.\n');
}
for (const key of [
  'VITE_USER_FEEDBACK_API_URL', 'VITE_EXPERIMENTS_API_URL', 'VITE_ANALYTICS_API_URL',
  'VITE_MANAGE_PROFILES_API_URL', 'VITE_USER_POOL_ID', 'VITE_IDENTITY_POOL_ID',
  // The admin-conversations API. gen-frontend-env writes it into packages/admin/.env like the
  // others, but it was missing from THIS list, so validate never exported it and every spec needing
  // it self-skipped on every run - permanently, with a reason that read like a local setup problem
  // rather than a harness gap. That silently withheld the behavioural half of access auditing (does
  // a membership change reach the record?) and of archiving (does the admin record survive?).
  'VITE_ADMIN_CONVERSATIONS_API_URL',
  // The cross-conversation work-item queue (GET /tasks/mine). Same gap shape as the key above: written
  // into packages/chat/.env by gen-frontend-env, absent from this list, so the open-work phase failed
  // its env precondition on its first run rather than reaching the deployment.
  'VITE_USER_TASKS_API_URL',
]) {
  if (process.env[key]) continue;
  for (const file of ENV_CANDIDATES) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
      if (m) { process.env[key] = m[1].trim(); break; }
    } catch { /* candidate absent — try the next */ }
  }
}

// Resolve the evaluation runner Lambda name (Aurora mode only) so the "evaluate" phase can score the
// e2e-produced exchanges on demand. Absent in Athena mode / older deploys → that phase self-skips.
// Set by the stack lookup below. Null means the lookup did not run because EVAL_LAMBDA_NAME was
// already supplied - which itself implies an Aurora deployment.
let auroraStackPresence = null;
if (!process.env.EVAL_LAMBDA_NAME) {
  const region = process.env.AWS_REGION || 'us-east-1';
  // This instance's analytics stack. Named once so the output read and the name-anchored fallback
  // below cannot drift apart - and so neither can match another project in this shared account.
  const ANALYTICS_STACK = `${STACK_PREFIX}AnalyticsAurora`;
  const q = "Stacks[0].Outputs[?OutputKey=='EvaluationLambdaName'].OutputValue";
  const res = spawnSync(
    `aws cloudformation describe-stacks --stack-name ${ANALYTICS_STACK} --region ${region} --query "${q}" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  // Whether the Aurora ANALYTICS STACK EXISTS is a different question from whether one of its outputs
  // resolved, and the vector store follows the former. describe-stacks exits non-zero when the stack is
  // absent, so this is the same call already being made, read for what it actually proves.
  //
  // A NON-ZERO EXIT IS NOT PROOF OF ABSENCE. The same exit code covers an expired SSO session, absent
  // credentials, a denied call, a throttle and no network - and reading it as "no Aurora stack" told
  // an operator their analytics stack was not deployed when the script had simply failed to ask. The
  // three outcomes are kept apart (present / absent / unknown) and reported differently below.
  const lookup = classifyStackLookup(res);
  auroraStackPresence = lookup.presence;
  if (lookup.presence === 'unknown') {
    console.warn(`[validate] WARNING: could not determine whether ${ANALYTICS_STACK} exists — the lookup itself failed: ${lookup.why}`);
    console.warn('[validate] This says NOTHING about the deployment. Treating Aurora as PRESENT so nothing is silently dropped;');
    console.warn('[validate] repair the AWS session (aws sso login --profile <your-profile>) and re-run for a clean read.');
  }
  let name = (res.stdout || '').trim();
  if (name === 'None') name = '';
  // Fallback: the EvaluationLambdaName output ships in a newer analytics-stack version; until that
  // stack is redeployed, resolve the runner by its function-name prefix instead.
  if (!name) {
    // ANCHORED TO THIS INSTANCE'S STACK PREFIX, not a bare `contains('AnalyticsAuro')`.
    //
    // This account is shared with other projects, and CDK derives a function name from its stack -
    // so the unanchored form matched `YoujiAnalyticsAurora-EvaluationLambda...` just as readily as
    // ours. Measured in this account: with AgentEchelon's own stack mid-teardown, the unanchored
    // query returned ONLY the other project's Lambda. The `evaluate` phase INVOKES what this
    // resolves, so the failure would have been a validation run scoring another project's data -
    // and the fallback fires precisely when the CDK output is missing, which is when nobody is
    // looking closely.
    //
    // Same lesson as the teardown near-miss: resolve by NAME, never by "the one that looks right".
    const lf = spawnSync(
      `aws lambda list-functions --region ${region} --query "Functions[?starts_with(FunctionName,'${ANALYTICS_STACK.slice(0, 25)}') && contains(FunctionName,'EvaluationLambda')].FunctionName | [0]" --output text`,
      { shell: true, encoding: 'utf8' },
    );
    const byPrefix = (lf.stdout || '').trim();
    if (byPrefix && byPrefix !== 'None') name = byPrefix;
  }
  if (name) {
    process.env.EVAL_LAMBDA_NAME = name;
    console.log(`[validate] evaluation Lambda resolved: ${name}`);
  } else {
    console.warn(auroraStackPresence === 'unknown'
      ? '[validate] NOTE: could not resolve the evaluation Lambda — the post-e2e evaluate step will skip. The stack lookup above failed, so this is NOT evidence of Athena mode.'
      : '[validate] NOTE: could not resolve the evaluation Lambda — the post-e2e evaluate step will skip (Athena mode / analytics stack not deployed).');
  }
}

// `knowledge-rag` ingests the platform docs into pgvector. It is Aurora-only, so drop it entirely when
// no Aurora stack resolved - a phase that cannot succeed should not be in the list at all, rather than
// run and fail for a reason that is not a fault.
//
// Deliberately its OWN phase rather than a `--rag` on the `knowledge` one: that phase is REQUIRED, and
// folding a network write into it would let a transient S3 hiccup abort the run BEFORE `seed`, leaving
// a deployment with no users and no context. As a separate optional phase, a failure warns loudly, is
// named in the summary, and the setup still completes.
// GATED ON THE MODE, NOT ON A LOOKUP THAT CAN FAIL. This tested `EVAL_LAMBDA_NAME` as a proxy for
// "is there an Aurora stack", so any reason the eval Lambda could not be resolved - a missing stack
// OUTPUT, an IAM gap on list-functions, a throttle, a deploy in flight - printed "no Aurora stack" and
// silently dropped the very ingestion this phase exists to guarantee. The inverse was just as wrong: a
// pre-set EVAL_LAMBDA_NAME in Athena mode kept a phase that cannot succeed.
//
// `analyticsMode` is the thing that actually decides whether a vector store exists, and it is known
// without calling anything.
// The vector store exists iff the Aurora ANALYTICS STACK does, which `describe-stacks` above already
// answered. `auroraStackPresence === null` means the lookup was skipped because EVAL_LAMBDA_NAME was
// supplied, which itself implies Aurora; `'unknown'` means the lookup could not be made, and an
// unanswered question is not an answer of "no" - dropping the phase on it is exactly the silent
// substitution this gate exists to prevent, so only a POSITIVE 'absent' removes it.
const auroraDeployment = auroraStackPresence !== 'absent';
if (!auroraDeployment) {
  const i = PHASES.findIndex((p) => p.id === 'knowledge-rag');
  if (i !== -1) {
    PHASES.splice(i, 1);
    console.log('[validate] NOTE: no Aurora analytics stack — skipping the platform-docs RAG ingestion (Athena mode has no vector store; the curated self-knowledge index still ships).');
  }
} else if (!process.env.EVAL_LAMBDA_NAME) {
  // The stack IS there and the Lambda still did not resolve: a missing output, an IAM gap, a throttle,
  // a deploy in flight. That is a fault rather than a configuration, so the phase STAYS and fails
  // visibly. The old gate read this case as "no Aurora stack" and silently dropped the ingestion it
  // exists to guarantee - a skip that looks identical to a pass in the summary.
  console.warn(auroraStackPresence === 'unknown'
    ? '[validate] WARNING: neither the Aurora analytics stack nor EVAL_LAMBDA_NAME could be read. Keeping the RAG ingestion phase so the failure is visible rather than skipped.'
    : '[validate] WARNING: the Aurora analytics stack resolved but EVAL_LAMBDA_NAME did not. Keeping the RAG ingestion phase so the failure is visible rather than skipped.');
}

let phases = PHASES;
if (only) phases = PHASES.filter((p) => p.id === only);
if (skipBattle) phases = phases.filter((p) => p.id !== 'battle');

if (phases.length === 0) {
  console.error(`[validate] no matching phase for --only=${only}. Valid: ${PHASES.map((p) => p.id).join(', ')}`);
  process.exit(2);
}

// DATA READINESS preflight. The data-producing phases self-skip (exit 0) when their deployed
// dependency is unresolved, which silently yields a sparse admin console. Surface it up front:
// map each rich-data dependency to whether it resolved above and which phase(s) it gates.
const readiness = [
  ['live chat origin (E2E_BASE_URL)', !!process.env.E2E_BASE_URL, 'all browser e2e (else localhost — the live app is NOT tested)'],
  ['live admin origin (E2E_ADMIN_BASE_URL)', !!process.env.E2E_ADMIN_BASE_URL, 'battle, experiments, admin'],
  ['credential-exchange URL', !!(process.env.VITE_CREDENTIAL_EXCHANGE_API_URL || process.env.EXCHANGE_API_URL), 'user (identity/exchange)'],
  ['analytics API (VITE_ANALYTICS_API_URL)', !!process.env.VITE_ANALYTICS_API_URL, 'tasks (Tasks/Flows admin data)'],
  ['SigV4 pools (VITE_USER_POOL_ID + VITE_IDENTITY_POOL_ID)', !!(process.env.VITE_USER_POOL_ID && process.env.VITE_IDENTITY_POOL_ID), 'admin/tasks/experiments signed reads (signed-analytics.ts)'],
  ['experiments API (VITE_EXPERIMENTS_API_URL)', !!process.env.VITE_EXPERIMENTS_API_URL, 'experiments'],
  ['feedback API (VITE_USER_FEEDBACK_API_URL)', !!process.env.VITE_USER_FEEDBACK_API_URL, 'feedback'],
  ['evaluation Lambda (Aurora only)', !!process.env.EVAL_LAMBDA_NAME, 'evaluate (quality scoring)'],
  ['image-gen keys secret', !!process.env.IMAGE_GEN_KEYS_SECRET_ARN, 'image-gen'],
  ['admin-conversations API (VITE_ADMIN_CONVERSATIONS_API_URL)', !!process.env.VITE_ADMIN_CONVERSATIONS_API_URL,
    'governance (access auditing + archive record survival)'],
];
// PROVE each value, do not merely find it non-empty.
//
// This table printed `OK` for a dead Cognito user pool, a dead identity pool and an NXDOMAIN
// experiments API on 2026-08-06, because "OK" only ever meant "the string is not empty". Three phases
// then ran against infrastructure that does not exist and their failures read as product regressions
// (a 13.8m user run and a battle run, both misattributed). A readiness check that reports a false OK
// is worse than no readiness check: it actively redirects the reader away from the real fault.
//
// So: resolve every URL's host in DNS, and describe both Cognito pools. Failures are reported as DEAD
// with the reason, and DEAD is fatal - continuing would just reproduce the misattribution.
async function probeHost(url) {
  try {
    const host = new URL(url).hostname;
    await dns.lookup(host);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err?.code === 'ENOTFOUND' ? `NXDOMAIN ${err.hostname || url}` : String(err?.message || err) };
  }
}
/**
 * "I could not ask" is NOT "the resource is absent", and reporting them the same way sends the reader
 * to redeploy infrastructure that is fine.
 *
 * A LIVE identity pool was reported DEAD and failed the whole run FATAL on
 * `CredentialsProviderError` — an SDK credential-resolution failure, i.e. an expired SSO session. The
 * JS SDK reads the SSO cache but cannot refresh it; the CLI can, which is why `aws sts
 * get-caller-identity` silently repairs it and the symptom appears to move around. This file's own
 * founding bug was the mirror image: reporting OK for genuinely dead ids because OK only ever meant
 * "the string is non-empty". Both come from reporting the SHAPE of a result without asking what it
 * means.
 */
const AUTH_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'AccessDenied',
  'AccessDeniedException',
  'SSOTokenProviderFailure',
]);

/** Classify a probe failure: an auth problem is the OPERATOR's session, never a dead dependency. */
function classifyProbeError(err, id) {
  const name = err?.name || 'error';
  if (AUTH_ERROR_NAMES.has(name) || /token|credential|sso/i.test(String(err?.message || ''))) {
    return {
      ok: false,
      auth: true,
      why: `${name} — cannot authenticate, so this dependency was NOT tested. `
        + 'Run `aws sso login --profile <your-profile>` (the JS SDK cannot refresh the SSO cache; the '
        + 'CLI can). This is your session, not the deployment.',
    };
  }
  return { ok: false, why: `${name} for ${id}` };
}

async function probeUserPool(id) {
  try {
    const { CognitoIdentityProviderClient, DescribeUserPoolCommand } = await import('@aws-sdk/client-cognito-identity-provider');
    const c = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });
    await c.send(new DescribeUserPoolCommand({ UserPoolId: id }));
    return { ok: true };
  } catch (err) { return classifyProbeError(err, id); }
}
async function probeIdentityPool(id) {
  try {
    const { CognitoIdentityClient, DescribeIdentityPoolCommand } = await import('@aws-sdk/client-cognito-identity');
    const c = new CognitoIdentityClient({ region: process.env.AWS_REGION || 'us-east-1' });
    await c.send(new DescribeIdentityPoolCommand({ IdentityPoolId: id }));
    return { ok: true };
  } catch (err) { return classifyProbeError(err, id); }
}

const PROBES = [
  ['live chat origin (E2E_BASE_URL)', () => probeHost(process.env.E2E_BASE_URL)],
  ['live admin origin (E2E_ADMIN_BASE_URL)', () => probeHost(process.env.E2E_ADMIN_BASE_URL)],
  ['credential-exchange URL', () => probeHost(process.env.VITE_CREDENTIAL_EXCHANGE_API_URL || process.env.EXCHANGE_API_URL)],
  ['analytics API (VITE_ANALYTICS_API_URL)', () => probeHost(process.env.VITE_ANALYTICS_API_URL)],
  ['experiments API (VITE_EXPERIMENTS_API_URL)', () => probeHost(process.env.VITE_EXPERIMENTS_API_URL)],
  ['feedback API (VITE_USER_FEEDBACK_API_URL)', () => probeHost(process.env.VITE_USER_FEEDBACK_API_URL)],
  ['admin-conversations API (VITE_ADMIN_CONVERSATIONS_API_URL)', () => probeHost(process.env.VITE_ADMIN_CONVERSATIONS_API_URL)],
];

console.log('\n[validate] DATA READINESS (unresolved ⇒ the gated phase self-skips ⇒ that admin data will be missing):');
const dead = [];
// AUTH failures are tracked separately from DEAD ones: a dead dependency means the deployment is
// wrong, an auth failure means we never got to look. Conflating them sends the reader to redeploy
// something that is fine (see classifyProbeError).
const unauthed = [];
for (const [dep, ok, gates] of readiness) {
  if (!ok) { console.log(`    MISS  ${dep}  →  gates: ${gates}`); continue; }
  const probe = PROBES.find(([name]) => name === dep);
  let verdict = 'OK  ';
  if (probe) {
    const r = await probe[1]();
    if (!r.ok) {
      verdict = r.auth ? 'AUTH' : 'DEAD';
      (r.auth ? unauthed : dead).push(`${dep}: ${r.why}`);
    }
  } else if (dep.startsWith('SigV4 pools')) {
    const [u, i] = await Promise.all([
      probeUserPool(process.env.VITE_USER_POOL_ID),
      probeIdentityPool(process.env.VITE_IDENTITY_POOL_ID),
    ]);
    if (!u.ok || !i.ok) {
      const why = [!u.ok && u.why, !i.ok && i.why].filter(Boolean).join('; ');
      // An auth failure on EITHER probe means neither was actually tested, so the pair reports AUTH.
      if (u.auth || i.auth) { verdict = 'AUTH'; unauthed.push(`${dep}: ${why}`); }
      else { verdict = 'DEAD'; dead.push(`${dep}: ${why}`); }
    }
  }
  console.log(`    ${verdict}  ${dep}  →  gates: ${gates}`);
}
const misses = readiness.filter(([, ok]) => !ok).length;
if (misses > 0) {
  console.log(`    ${misses} dependency(ies) unresolved. To get a FULL admin console, deploy the missing stack(s)`);
  console.log('    and regenerate the per-package env (gen-frontend-env), then re-run. See docs/guides/user/DEMO-AND-VALIDATION.md.');
}
// Reported BEFORE the dead-dependency block: when the session is not authenticated, every other
// probe's verdict is suspect too, so this is the first thing the reader should act on.
if (unauthed.length > 0) {
  console.error('\n[validate] FATAL: NOT AUTHENTICATED — these dependencies were never tested:');
  for (const u of unauthed) console.error(`    ${u}`);
  console.error('[validate] This is your AWS session, NOT the deployment. Nothing here says the');
  console.error('[validate] infrastructure is wrong. Fix: aws sso login --profile <your-profile>');
  console.error('[validate] (then re-run; `aws sts get-caller-identity` also repairs the SSO cache).\n');
  process.exit(1);
}
if (dead.length > 0) {
  console.error('\n[validate] FATAL: a dependency RESOLVED TO A VALUE THAT DOES NOT EXIST:');
  for (const d of dead) console.error(`    ${d}`);
  console.error('[validate] These are set but dead — a stale env. Running would attribute harness rot');
  console.error('[validate] to product tests. Fix: cd backend && node scripts/gen-frontend-env.mjs\n');
  process.exit(1);
}

console.log(`\n[validate] running phases: ${phases.map((p) => p.id).join(' -> ')}`);
const results = [];
for (const phase of phases) {
  const ok = await run(phase);
  if (!ok) {
    if (phase.optional) {
      // "optional" means the run CONTINUES, not that the failure is acceptable. A phase only
      // reaches here after actually RUNNING and failing — a phase whose dependency is absent
      // self-skips and exits 0 (see DATA READINESS above), so this is a real failure until
      // proven otherwise. Name the phase rather than guessing a cause: the old wording blamed
      // "a battle-enabled deploy" for every optional phase, which is wrong for e.g. tasks and
      // sends the reader after the wrong problem.
      console.warn(`[validate] phase "${phase.id}" FAILED. It is marked optional, so the run continues — but an`);
      console.warn('[validate] optional phase that RAN and failed is a real failure unless its dependency is genuinely absent.');
      failedOptional.push(phase.id);
      results.push([phase.id, 'FAILED (optional — continued)']);
      continue;
    }
    results.push([phase.id, 'FAILED']);
    printSummary(results);
    process.exit(1);
  }
  results.push([phase.id, 'passed']);
}
printSummary(results);

// Never claim a clean run when something failed. This line is what a human (or a CI log
// scan) reads to decide whether the deploy is good, and it previously said "all required
// phases passed" even when an optional phase had failed — so a genuine regression in
// tasks/experiments/battle read as green.
if (failedOptional.length > 0) {
  console.log(`\n[validate] required phases passed, but ${failedOptional.length} OPTIONAL phase(s) FAILED: ${failedOptional.join(', ')}`);
  console.log('[validate] investigate each one. Re-run a single phase with --only=<phase>.');
  if (STRICT) {
    console.error('[validate] --strict: exiting non-zero because an optional phase failed.');
    process.exit(1);
  }
  console.log('[validate] (exit 0 — pass --strict to fail the run on optional-phase failures, e.g. in CI.)');
} else {
  console.log('\n[validate] all phases passed.');
}

/**
 * End-of-run summary. Prints each phase's result. NOTE: a data-producing phase that SELF-SKIPPED
 * (missing URL / non-Aurora) still reports "passed" here because it exits 0 — cross-reference the
 * DATA READINESS block above to know whether it actually produced admin data.
 */
function printSummary(rows) {
  console.log('\n[validate] ============ PHASE SUMMARY ============');
  for (const [id, status] of rows) console.log(`    ${status.startsWith('FAILED') ? '✗' : '✓'}  ${id.padEnd(12)} ${status}`);
  console.log('    (a data-producing phase can report "passed" yet have self-skipped — see DATA READINESS above.)');
  console.log('[validate] ========================================');
}
