/**
 * validate.mjs - post-deploy launch validation.
 *
 * Runs the full validation sequence against a LIVE deployment so every classification flow is
 * exercised with REAL user->assistant messages (measured + recorded), then the admin
 * dashboard is verified against that real data. Nothing is faked.
 *
 * The core sequence, in order; admin is LAST so it verifies against the real data above. Further
 * phases run after it, and the complete registry, with what each one needs, is under Usage below:
 *   1. knowledge     - regenerate the project self-knowledge context (offline)
 *   1b. knowledge-rag - ingest the platform docs into pgvector for deep Q&A (Aurora only) [optional]
 *   2. seed          - demo users + classification context + identity provisioning
 *   3. user          - real per-classification conversations, mentions, drift, identity/exchange
 *                      (agent-intents is general-heavy by design — the DOMAIN-intent + multi-step-task
 *                       traffic that populates the admin console comes from the data-producing phases below)
 *   4. battle        - a real /battle run (needs a battle-enabled deploy)           [optional]
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
 *   node backend/scripts/validate.mjs --only=user --spec=mentions,drift-detection   # some of one phase's specs
 *   node backend/scripts/validate.mjs --strict            # optional-phase failure fails the run
 *
 *   Every --only id the registry accepts, in the order it declares them. An unknown id stops the run
 *   before it reads AWS, and names the valid set. The markers are what a reader needs before choosing:
 *     [req]    runs in a default sweep, and its failure fails the run
 *     [opt]    runs in a default sweep, and its failure is reported loudly but exits 0 without --strict
 *     [manual] reachable ONLY by name, and deliberately kept out of a sweep (queue-demo hands you the
 *              browser and waits; sleep-failure pauses the data plane)
 *   A phase named beside a variable SETS that variable, and the spec it runs skips without it - so
 *   reaching that spec any other way opts it out rather than running it.
 *
 *     knowledge [req]                       knowledge-rag [opt, Aurora only]
 *     seed [req]                            user [req]
 *     battle [opt, BATTLE_E2E]              image-gen [opt, RUN_LIVE_IMAGE_GEN]
 *     feedback [opt, FEEDBACK_E2E]          experiments [opt, EXPERIMENTS_E2E]
 *     experiment-trust [opt, EXPERIMENTS_E2E]
 *     experiment-promotion [opt, EXPERIMENTS_E2E]
 *     tasks [opt, TASKS_E2E]                task-answer [opt, TASK_ANSWER_E2E]
 *     task-reference [opt, TASK_REFERENCE_E2E]
 *     concurrent-tasks [opt, CONCURRENT_TASKS_E2E]
 *     profiles [opt, PROFILE_CONFIG_E2E]    knowledge-qa [opt, PLATFORM_KNOWLEDGE_E2E]
 *     welcome [opt, WELCOME_E2E]            evaluate [opt, Aurora only]
 *     welcome-workflows [opt, WELCOME_WORKFLOWS_E2E]
 *     workflow-tasks [opt, E2E_WORKFLOW_TASKS]
 *     admin [req]                           auth [opt]
 *     governance [opt]                      identity-classification [req, IDENTITY_CLASSIFICATION_E2E]
 *     context-sources [opt]                 tasks-deep [opt, TASKS_E2E]
 *     task-branches [opt, TASKS_E2E]        onboarding [opt, ONBOARDING_E2E]
 *     document-templates [opt, DOCUMENT_TEMPLATES_E2E]
 *     preferences [opt, PREFERENCES_E2E]    conversation-assembly [opt]
 *     subjects [opt]
 *     drift-scope [opt, DRIFT_SCOPE_E2E]    bilingual [opt]
 *     notifications [opt, ADMIN_ALERT_E2E]  cost [opt]
 *     demo-cast-mail [opt, DEMO_CAST_MAIL_E2E]
 *     incident-watch [opt, INCIDENT_WATCH_E2E]
 *     sleep-failure [manual, SLEEP_FAILURE_E2E]
 *     latency [opt, LATENCY_E2E]            analytics-accuracy [opt, ANALYTICS_ACCURACY_E2E]
 *     evaluation-verdicts [opt, EVALUATION_VERDICTS_E2E, Aurora only]
 *     task-resolution [opt, TASK_RESOLUTION_E2E]
 *     open-work [opt, OPEN_WORK_E2E]        queue-demo [manual, QUEUE_DEMO]
 *     turn-queue [opt, TURN_QUEUE_E2E]      group-split [opt, GROUP_SPLIT_E2E]
 *     private-stop [opt, PRIVATE_STOP_E2E]  attribution [opt, ATTRIBUTION_E2E]
 *     admin-surfaces [opt]                 deny-tests [opt]
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
// --release-e2e: after the phases, release the memberships THIS run's conversations created (see
// scripts/release-e2e-memberships.mjs). Opt-in because it removes memberships; without it test accounts
// and assistants accumulate one per conversation until they cross the SearchChannels limit.
const releaseE2e = args.includes('--release-e2e');
const RUN_STARTED_AT = Date.now();
// ── EVERY PHASE NAMED, NOT THE FIRST ONE (2026-09-10) ─────────────────────────────────────────
//
// This took `args.find`, so `--only=battle --only=experiments --only=latency` ran battle, ignored the
// other two, and exited 0. A command that does a third of what it was asked and reports success is
// the shape this repo treats as a defect everywhere else - `cdk deploy <wrong-name>` exiting 0 having
// deployed nothing is the same failure, and it is in the deploy notes for the same reason.
//
// Both spellings work, because both are the obvious one to try: repeat the flag, or comma-separate.
const only = args
  .filter((a) => a.startsWith('--only='))
  .flatMap((a) => a.slice('--only='.length).split(','))
  .map((s) => s.trim())
  .filter(Boolean);
// `--spec=<name>[,<name>]` narrows ONE phase to the specs whose file name contains a name given, so a
// few of a long phase's specs can run with everything else this script sets up (the user pool, the
// origins, the instance). It needs exactly one `--only`, and a name that matches no spec of that phase
// stops the run rather than running the whole phase: asking for less and getting all of it is the same
// silent-success shape as the `--only` bug above.
const specFilter = args
  .filter((a) => a.startsWith('--spec='))
  .flatMap((a) => a.slice('--spec='.length).split(','))
  .map((s) => s.trim())
  .filter(Boolean);
if (specFilter.length && only.length !== 1) {
  console.error('[validate] --spec narrows one phase: pass exactly one --only=<phase> with it');
  process.exit(1);
}
function narrowToSpecs(cmd) {
  if (!specFilter.length) return cmd;
  const tokens = cmd.split(' ');
  const isSpec = (t) => /^e2e\/.+\.spec\.ts$/.test(t);
  const kept = tokens.filter((t) => isSpec(t) && specFilter.some((name) => t.includes(name)));
  const unmatched = specFilter.filter((name) => !kept.some((t) => t.includes(name)));
  if (!kept.length || unmatched.length) {
    const offered = tokens.filter(isSpec).map((t) => t.replace(/^e2e\//, '')).join(', ');
    throw new Error(`--spec matched nothing for [${unmatched.join(', ') || specFilter.join(', ')}]; this phase runs: ${offered}`);
  }
  return tokens.filter((t) => !isSpec(t) || kept.includes(t)).join(' ');
}
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
//
// This instance's CloudFormation stack prefix comes from the one resolver every operator script uses
// (scripts/lib/stack-lookup.cjs): `AE_STACK_PREFIX` (or the script-only `STACK_PREFIX`), else the
// PascalCase of the instance name. Variables that name different instances stop the run here.
//
// EVERY stack this script names is built from it, for two reasons. It ANCHORS resource lookups to
// this deployment: in a shared account, "the function whose name contains EvaluationLambda" matches
// other projects' functions too, and the thing being resolved here is INVOKED, so an unanchored
// match is a validation run pointed at somebody else's data. And it keeps the script usable on a
// deployment that is not the default instance: a hardcoded `AgentEchelon...` resolves nothing there,
// and the frontend lookup below fails the run outright when the prefix names no stack.
let INSTANCE_NAME;
let STACK_PREFIX;
try {
  INSTANCE_NAME = resolveInstanceName(process.env);
  STACK_PREFIX = resolveStackPrefix(process.env);
} catch (err) {
  console.error(`[validate] ${err.message}`);
  process.exit(1);
}

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
  //
  // `--verify` makes the phase about the corpus rather than the uploads: a put returns before ingestion runs,
  // and an ingest that timed out left the corpus empty while the phase passed. With it the phase waits, bounded,
  // until every synced key holds chunks at its current ETag, and fails naming the keys that do not.
  { id: 'knowledge-rag', label: 'Ingest the platform docs for deep Q&A (Aurora only)', cwd: BACKEND,
    cmd: 'node scripts/sync-project-knowledge.mjs --rag --verify', optional: true },
  // THE TRAIL THE PLATFORM ASSUMES: the control-plane audit layer, and the event source that keeps
  // group-sourced conversations and the admin conversations in sync. Checked rather than assumed.
  { id: 'audit-trail', label: 'A CloudTrail trail is logging management events (audit + group sync)', cwd: BACKEND,
    cmd: 'node scripts/check-audit-trail.mjs' },
  { id: 'seed', label: 'Seed demo (users + classification context + identity)', cwd: BACKEND,
    cmd: 'npx ts-node scripts/seed-demo.ts' },
  // `deployed-build.spec.ts` runs FIRST in this phase and takes ~2s. It answers "is the deployed chat
  // app the one these specs were written against?", which is the question every browser assertion
  // below silently assumes. It existed but NO phase named it - the same gap the profiles phase
  // records - so the guard built to catch a stale deployment had never run in a sweep. A stale bundle
  // makes a correct spec fail for a reason that has nothing to do with the code under test, and that
  // is worth two seconds at the front rather than a hand-diff of the served JavaScript.
  { id: 'user', label: 'User e2e: deployed-build guard, classification-context boundary, per-classification conversations, mentions, drift, identity, fulfillment retry, turn state without the Lex session', cwd: TESTS,
    cmd: PW('e2e/deployed-build.spec.ts e2e/classification-context.spec.ts e2e/agent-intents.spec.ts e2e/credential-exchange.spec.ts e2e/mentions.spec.ts e2e/drift-detection.spec.ts '
      + 'e2e/a-replayed-turn-claims-once.spec.ts e2e/dispatch-routing.spec.ts e2e/turn-state-without-lex.spec.ts '
      + 'e2e/a-person-opened-conversation-goes-through-the-canonical-creator.spec.ts') },
  // BATTLE_IMAGE_E2E is set HERE because nothing else sets it: the image battle (generation-out) skipped
  // itself on every sweep, which under E2E_REQUIRE_ALL fails the phase and otherwise reads as covered.
  // It needs the image-generation keys, which DATA READINESS above reports.
  // E2E_INSTANCE_NAME resolves the agent-tasks table: B-E7 reads the task a waiting battle side opened.
  { id: 'battle', label: 'Battle e2e: a real /battle run, text and image', cwd: TESTS,
    cmd: PW('e2e/battle.spec.ts e2e/an-image-duel-runs-both-chains-to-an-image.battle.spec.ts'), env: { BATTLE_E2E: '1', BATTLE_IMAGE_E2E: '1', E2E_MODEL_ROUTES: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
  // RUNS ITS OWN BATTLE, so it stands alone. A battle is read on its experiment's page: the phase arms a battle
  // experiment of its own, fires one short /battle, reaches the battle through the experiment's page, opens its
  // conversation from its row, and checks that the retired Battles and Duels links land on Experiments. It ends and
  // deletes its experiment and restores Battle Mode afterwards. BATTLE_E2E and E2E_INSTANCE_NAME are what the battle
  // helpers read, as in the battle phase: the instance resolves the battle tables the duel's completion is read from.
  { id: 'experiment-battles', label: 'Experiment battles: a battle read on its experiment page, opening its conversation', cwd: TESTS,
    cmd: PW('e2e/experiment-battles.spec.ts'), env: { EXPERIMENT_BATTLES_E2E: '1', BATTLE_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
  { id: 'image-gen', label: 'Image gen-out: real external providers (FAL, OpenAI) return persistable PNGs', cwd: BACKEND,
    cmd: 'npx jest image-gen-live', env: { RUN_LIVE_IMAGE_GEN: '1' }, optional: true },
  // Data-producing e2e (cluster E): each drives a real flow so the empty admin
  // tabs get real data. Gated + optional so they only run in validation, never
  // in the default unit suite. See PLAN-E2E-DATA-COVERAGE.md.
  { id: 'feedback', label: 'Feedback e2e: a thumbs rating persists (→ #36 feedback data)', cwd: TESTS,
    cmd: PW('e2e/feedback.spec.ts'), env: { FEEDBACK_E2E: '1' }, optional: true },
  { id: 'experiments', label: 'Experiment e2e: create an A/B experiment + run a turn (→ #39 experiment_results)', cwd: TESTS,
    cmd: PW('e2e/experiments.spec.ts'), env: { EXPERIMENTS_E2E: '1' }, optional: true },
  // AN ORPHANED SPEC, AND THE ONLY ONE THAT ANSWERS "is the number the console shows the right one".
  //
  // `experiment-results-trust.spec.ts` drives all four experiment types against live traffic and then
  // asserts the console RECONCILES per variant. It gates on the same `EXPERIMENTS_E2E=1` as the phase
  // above and was invoked by NO phase, so it had never run in validation - while
  // `docs/reference/e2e-coverage-matrix.md` listed it as covered, which is how it stayed invisible: the
  // matrix over-reported exactly the spec nothing ran.
  //
  // It is also the only e2e that distinguishes two things unit tests cannot. `experiments.spec.ts`
  // points both arms of its profile experiment at the SAME profile, so it cannot tell a per-variant
  // profile resolution from a shared one; this one uses two different profiles. And its `classification`
  // case activates a real classification experiment and drives premium turns through it, which is the
  // only live exercise of the classifier gate - if the gate refused it, nothing would attribute.
  //
  // Its OWN phase rather than a second file on the phase above, for the reason the task-answer comment
  // below gives: the shape is expensive and specific, and a failure should name itself rather than
  // arrive as "experiments failed".
  { id: 'experiment-trust', label: 'Experiment-trust e2e: four experiment types attribute, and the console reconciles per variant', cwd: TESTS,
    cmd: PW('e2e/experiment-results-trust.spec.ts'), env: { EXPERIMENTS_E2E: '1' }, optional: true },
  // PROMOTION (SPEC-BATTLE FR12): an operator promotes a measured treatment from the console. It arms two
  // experiments on premium, drives a turn per arm, activates a clone of the live version to prove the
  // moved-base refusal, promotes, and rolls the live premium assistant back to the version it started from.
  // Its own phase for the reason experiment-trust has one: it changes which version serves premium while it
  // runs, so it runs alone on that classification, and a failure names itself.
  { id: 'experiment-promotion', label: 'Experiment-promotion e2e: a measured treatment is promoted from the console, and refused once the live version moved', cwd: TESTS,
    cmd: PW('e2e/a-tested-treatment-is-promoted-into-the-live-assistant.spec.ts'), env: { EXPERIMENTS_E2E: '1' }, optional: true },
  { id: 'tasks', label: 'Task e2e: a report request opens a tracked task, and a non-member cannot open one (→ #32/#35 task_id + Flows)', cwd: TESTS,
    cmd: PW('e2e/tasks.spec.ts e2e/a-non-member-cannot-open-work-in-a-conversation.spec.ts'),
    env: { TASKS_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
  // A task answer in a SHARED conversation (ADR-032). Its own phase because the shape is expensive and
  // specific: more than one person in the room AND an open item held by the answerer. Every
  // single-user test passes whatever this code does - in a 1:1 Chime routes every message to the
  // assistant regardless of addressing - which is exactly how a person answering a question they were
  // asked came to reach nobody at all, silently.
  { id: 'task-answer', label: 'Task-answer e2e: an unaddressed answer in a shared conversation still reaches its assistant', cwd: TESTS,
    // E2E_INSTANCE_NAME resolves the agent-tasks table: the private-request test reads the task a
    // targeted request opens, which is where its privacy and its attribution are recorded.
    cmd: PW('e2e/task-answer.spec.ts'), env: { TASK_ANSWER_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
  // A reply that names its item (ADR-035): a bare `#2` in a group reaches the owning assistant and moves
  // item 2 only, a colleague's `#1` starts nothing, and a reference to nothing is answered privately.
  // E2E_INSTANCE_NAME resolves the task tables the spec seeds its two open items into.
  { id: 'task-reference', label: 'Task-reference e2e: a reply starting with #n answers that item, on text alone', cwd: TESTS,
    cmd: PW('e2e/task-reference.spec.ts'), env: { TASK_REFERENCE_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
  // TWO TASKS AT ONCE. Every other task phase drives one, so every task invariant here has been
  // measured against a population of one - and the failures that need two (a turn advancing the task
  // it was not addressing, a completion door closing the wrong one) are exactly the ones nothing else
  // would catch. See ADR-047 for why a turn's machines being resolved per consumer produced that shape
  // of defect.
  { id: 'concurrent-tasks', label: 'Concurrent-tasks e2e: two open tasks stay separate; a turn moves only the one it addresses', cwd: TESTS,
    cmd: PW('e2e/concurrent-tasks.spec.ts'), env: { CONCURRENT_TASKS_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
  // Portable/versioned profiles: the Profiles admin tab loads the live list, AND the full config
  // lifecycle (copy → edit guardrail+machines+persona → activate → export → import → TAKES EFFECT).
  // Mutates the 'standard' profile and rolls it back in-spec, so it is safe between data phases.
  // The portable-artifact specs run HERE too. They existed but no phase named them, so the
  // export/import round trip, the activate/rollback pointer, and the fail-closed activation gates
  // never ran in a validate sweep - a phase reporting "passed" while the portable half of the
  // feature it is named for went untouched.
  { id: 'profiles', label: 'Profiles e2e: portable artifact lifecycle (export/import/activate/rollback + gates) + persona & guardrail take effect', cwd: TESTS,
    cmd: PW('e2e/admin-profiles.spec.ts e2e/profile-config.spec.ts e2e/portable-profile-lifecycle.spec.ts '
      + 'e2e/portable-profile-gates.spec.ts e2e/profile-ownership.spec.ts '
      + 'e2e/an-import-cannot-carry-a-model-the-target-classification-lacks.spec.ts '
      + 'e2e/an-assistants-infrastructure-links-name-live-resources.spec.ts '
      + 'e2e/an-assistants-page-shows-its-templates-intents-and-workflows.spec.ts '
      + 'e2e/a-declared-assistant-is-the-registrys-own-name.spec.ts '
      + 'e2e/admin-workflow-builder.spec.ts'),
    env: { PROFILE_CONFIG_E2E: '1' }, optional: true },
  // A draft answers the golden set before it is activated (ADR-065): a labeled answer nominated as a regression entry,
  // Activate refused until the draft is run, the run's record deciding the gate, and an edit needing a new run; and a
  // deployment's own entries, uploaded and generated, with coverage per intent (decisions 6 to 8). Every entry added is
  // retired afterwards and every version activated is rolled back. Its own phase because a run is minutes of model calls.
  { id: 'golden-set', label: 'Golden set e2e: a draft is run against the set before Activate, and refused without a run', cwd: TESTS,
    cmd: PW('e2e/a-draft-answers-the-golden-set-before-it-is-activated.spec.ts e2e/a-deployment-brings-its-own-golden-entries.spec.ts'), optional: true },
  // Proves the platform RAG corpus is not just ingested but RETRIEVED: it asserts the answer carries
  // detail that exists only in a doc BODY. A summary-only answer is fluent and on-topic, so nothing
  // else in this suite would notice the corpus being unreachable.
  { id: 'knowledge-qa', label: 'Platform Q&A e2e: the assistant answers about itself from the docs, not the summary index', cwd: TESTS,
    cmd: PW('e2e/platform-knowledge.spec.ts'), env: { PLATFORM_KNOWLEDGE_E2E: '1' }, optional: true },
  { id: 'welcome', label: 'Welcome e2e: a new conversation opens with the seeded classification-aware orientation', cwd: TESTS,
    cmd: PW('e2e/welcome.spec.ts'), env: { WELCOME_E2E: '1' }, optional: true },
  // ADR-060: a version's variable fills the welcome and a targeted template from one declaration (it activates a
  // version of the premium primary for its duration and rolls it back), and a classification's acting role is refused
  // every context source only another classification publishes.
  { id: 'variables', label: 'Variables e2e: one declaration fills a welcome and a targeted template; a turn role reads only its own sources', cwd: TESTS,
    cmd: PW('e2e/a-version-variable-fills-a-welcome-and-a-template.spec.ts e2e/a-turn-role-is-refused-another-classifications-context-source.spec.ts'),
    env: { E2E_VERSION_VARIABLES: '1' }, optional: true },
  // ADR-061 and ADR-062 at a deployment: a share runs the version's `person-joined` workflow and welcomes the joiner once,
  // in the language they chose, with the join recap after it; a room an event opens welcomes its lead once from its
  // `conversation-opened` run, by a send addressed to the `lead` participant role; and an invitation runs its
  // `invitation-sent` workflow for the inviter while a revoked invitation's deadline runs nothing; a workflow welcome
  // offers the intake as a step; an `invitation-unredeemed` agent step's proposal is applied once, by its addressee
  // alone; a `voice` welcome is said in the assistant's voice and a render that misses its bound posts the written
  // text; and an agent step addressed to a participant role reaches its holders only. Each activates a version of the
  // premium primary for its run and returns it, so the phase runs only when named.
  { id: 'welcome-workflows', label: 'Welcome-workflow e2e: a joiner, a room\'s lead and an inviter are each told once, by the workflow their event runs', cwd: TESTS,
    cmd: PW('e2e/a-person-who-joins-is-welcomed-once-in-their-language.spec.ts e2e/an-opened-room-welcomes-its-lead-once-by-role.spec.ts '
      + 'e2e/an-invitation-runs-its-workflow-until-it-is-revoked.spec.ts e2e/a-welcome-workflow-offers-the-intake-as-a-step.spec.ts '
      + 'e2e/a-proposal-is-applied-once-by-its-addressee.spec.ts e2e/a-welcome-is-said-in-the-assistants-voice.spec.ts '
      + 'e2e/an-agent-step-addressed-to-a-role-reaches-only-its-holders.spec.ts'),
    env: { WELCOME_WORKFLOWS_E2E: '1' }, optional: true },
  // A workflow's task step (ADR-063): a person's task told and settled on its card, a task ended by its deadline, and an
  // idle assistant taking up its own work. Each changes a deployed assistant's active version for its run, so the phase
  // runs only when named; the pickup spec also skips itself where the turn queue is off (E2E_TURN_QUEUE).
  { id: 'workflow-tasks', label: 'Workflow-task e2e: a step assigns a task, a card or a deadline settles it, and an idle assistant takes up its own', cwd: TESTS,
    cmd: PW('e2e/a-workflow-step-opens-a-task-for-a-person.spec.ts e2e/a-task-deadline-ends-the-task-and-continues-the-run.spec.ts '
      + 'e2e/an-idle-assistant-takes-up-its-own-work.spec.ts'),
    env: { E2E_WORKFLOW_TASKS: '1', E2E_WORKFLOW_TASK_DEADLINE: '1', E2E_WORKFLOW_TASK_PICKUP: '1' }, optional: true },
  // A turn takes its model from its intent and, where the step overrides it or delivers, from the step (ADR-064): routes
  // keyed by the intent, per-step models and their rows, text and image in one intent, a required tool, the console and
  // Effectiveness, experiments and battles. The specs that change the premium primary's active version return it.
  { id: 'model-routes', label: 'Model-route e2e: a turn takes its model from its intent, and from its step where the step overrides or delivers', cwd: TESTS,
    cmd: PW('e2e/a-route-is-keyed-by-its-intent.spec.ts e2e/a-step-picks-the-model-where-it-overrides-or-delivers.spec.ts '
      + 'e2e/an-image-is-asked-for-confirmed-drawn-and-revised.spec.ts e2e/a-step-requires-its-lookup-before-the-task-moves-on.spec.ts '
      + 'e2e/an-image-experiment-attributes-every-step-to-its-arm.spec.ts '
      + 'e2e/a-console-edits-an-intents-image-and-step-models.spec.ts'),
    // E2E_INSTANCE_NAME resolves the agent-tasks table: the step spec drives its report task by its state and reads the
    // intent that opened it, and the image experiment spec reads the arm its task recorded.
    env: { E2E_MODEL_ROUTES: '1', E2E_IMAGE_STEPS: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },
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
    // The trace spec is local and needs no deployment; it sits with sign-in because it proves how a
    // sign-in types its password.
    cmd: PW('e2e/signup.spec.ts e2e/signin.spec.ts e2e/trace-holds-no-password.spec.ts'), optional: true },

  { id: 'governance', label: 'Governance e2e: abuse controls, moderation, access auditing, archive membership', cwd: TESTS,
    // The controls that are supposed to STOP things. A silent failure here reads as "nothing
    // happened", which is exactly what a working control also looks like - hence real assertions.
    cmd: PW('e2e/abuse-controls.spec.ts e2e/moderation.spec.ts e2e/access-auditing.spec.ts '
      + 'e2e/archive-membership.spec.ts e2e/no-platform-role-speaks-as-an-assistant.spec.ts'), optional: true },

  // THE CLASSIFICATION TAG ON THE PRINCIPALS THEMSELVES, checked against the deployment rather than
  // against the source. It is its own phase, not folded into `governance`, because it answers a
  // different question: governance asks whether the controls STOP things, this asks whether the
  // mechanism the whole design is stated in terms of is actually PRESENT.
  //
  // It exists because nothing else could have caught its absence. Conversations were tagged from the
  // first commit and identities never were - for nine months, through repeated testing and repeated
  // doc review - because every unit test passed correctly (enforcement runs through the vended role,
  // so a missing tag had no behavioural consequence) and review is drawn to what exists: you cannot
  // review a parameter that was never written. It surfaced only when analytics needed the fact, could
  // not find it, and guessed.
  //
  // NOT optional. A claim the platform is described in terms of either holds on the deployment or it
  // does not, and "skipped" is the state that let it hide.
  // THE DENY-TEST RUNS BESIDE THE TAG TEST, because they prove the two halves of one claim: the tag
  // test says every principal carries its classification, and the deny-test says the classification
  // actually refuses a model it does not declare. Neither is worth much alone - a tag nothing evaluates
  // is decoration, and a refusal on an untagged principal proves nothing about the deployment.
  { id: 'identity-classification', label: 'Identity e2e: every assistant and person carries its classification tag, and a classification is denied a model it does not declare', cwd: TESTS,
    cmd: PW('e2e/identity-classification.spec.ts '
      + 'e2e/a-classification-is-denied-a-model-it-does-not-declare.spec.ts '
      // The assistant's channel boundary, bearer pin and archived read-only Deny, simulated on the deployed roles.
      + 'e2e/assistant-classification-boundary.spec.ts'),
    env: { IDENTITY_CLASSIFICATION_E2E: '1' } },

  // ── A SECOND ASSISTANT IN ONE CLASSIFICATION, REACHING WHAT ITS SIBLING CANNOT ────────────────
  //
  // OPTIONAL, because the role is the deployment's choice: a deployment whose `profiles` does not name
  // `ops-premium` has no `(premium, ops)` assistant and the phase has nothing to assert. Its specs say so by name rather than
  // failing, which is the difference between "not deployed" and "deployed and broken".
  //
  // IT IS THE GOVERNANCE CLAIM, not a feature tour. Two assistants of one classification, one allowed
  // this deployment's own CloudWatch metrics and one refused, proven by simulating the DEPLOYED acting role
  // roles rather than by reading a policy - which is what tenet P4 asks for and what a demo should
  // show, because "the ops assistant answered" is not evidence that the primary could not have.
  // THE ROLLOUT, SHOWN BEFORE THE PROOF. A second assistant inside one classification is the least
  // visible thing this platform does - nothing in the chat window says whether an answer came from a
  // different principal with a different reach - so the demo names the infrastructure the deploy
  // produced and the profile that governs the assistant, read back from AWS rather than echoed from
  // config. It prints the rollback in the same breath, because a rollout nobody can undo is a
  // commitment rather than a demo.
  { id: 'ops-rollout', label: 'Ops-role rollout: the infra and profile a role\'s deploy created', cwd: BACKEND,
    cmd: 'node scripts/show-ops-rollout.mjs', optional: true },

  { id: 'ops-role', label: 'Ops-role e2e: a second assistant reaches its own classification and nothing else', cwd: TESTS,
    cmd: PW('e2e/an-ops-role-reaches-only-its-own-classification.spec.ts e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts e2e/a-typed-conversation-creator-creates-at-one-classification.spec.ts e2e/an-assistant-passes-a-question-to-its-ops-roommate.spec.ts'),
    optional: true },

  // THE INCIDENT WATCH AND THE ROOM'S FIRST LOOK (ADR-061): an ops event naming an alarm opens an `ops` room that watches
  // it, the first look opens an `incident_first_look` task, a state change on the watched alarm runs the room's incident
  // watch, and one on an alarm no room watches posts nothing. It owns two alarms and both rooms, and activates a version
  // of the premium primary for its duration and rolls it back, so it runs only when named. E2E_INSTANCE_NAME resolves the
  // instance the ops event names.
  { id: 'incident-watch', label: 'Incident-watch e2e: an ops room watches its alarm, takes a first look, and answers its alarm changing state', cwd: TESTS,
    cmd: PW('e2e/an-alarm-a-room-watches-starts-its-workflow.spec.ts'),
    env: { INCIDENT_WATCH_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

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

  // A TEMPLATED REPORT IS DELIVERED IN ITS TEMPLATE'S SHAPE, IN THE FORMAT THE PERSON CHOSE
  // (SPEC-DOCUMENT-TEMPLATES FR3a, FR10). Every report follows a template (the platform report workflow
  // declares one), and premium's demo pack offers a choice of two; this drives premium's report with the
  // non-default one named, and compares the attached file to the template its delivery record names.
  { id: 'document-templates', label: 'Document templates e2e: a report is delivered in the template the person chose, with its sections in order', cwd: TESTS,
    optional: true,
    cmd: PW('e2e/document-templates.spec.ts'),
    env: { DOCUMENT_TEMPLATES_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME } },

  { id: 'onboarding', label: 'Onboarding e2e: the intake runs once per user, not once per conversation', cwd: TESTS,
    cmd: PW('e2e/onboarding-intake.spec.ts'), env: { ONBOARDING_E2E: '1' }, optional: true },

  { id: 'preferences', label: 'Preferences e2e: the premium offer never blocks a question; set and show are platform intents', cwd: TESTS,
    cmd: PW('e2e/reply-preferences.spec.ts'), env: { PREFERENCES_E2E: '1' }, optional: true },

  { id: 'conversation-assembly', label: 'Conversation e2e: named on its first turn by the UPDATE_CHANNEL event; a room an event opens arrives named from its context; the service admin leaves the room it assembled', cwd: TESTS,
    cmd: PW('e2e/a-conversation-is-named-and-assembled.spec.ts e2e/a-room-an-event-opens-is-named-from-its-context.spec.ts'), optional: true },

  { id: 'subjects', label: 'Subjects e2e: a turn-two pivot is flagged; off-topic is declined; platform answers at each depth', cwd: TESTS,
    cmd: PW('e2e/subjects-and-intents.spec.ts'), optional: true },

  // DRIFT SCOPING FOR A HEAVY MEMBER. A conversation whose first member is over the SearchChannels
  // membership limit must still resolve its related-conversation scope, by re-asking as another member.
  // Needs Aurora with `-c enableLiveDrift=true` and a premium test user over the limit (a long-lived
  // account usually is); without one it skips, saying so. E2E_INSTANCE_NAME resolves the app instance.
  { id: 'drift-scope', label: 'Drift scope e2e: a member over the search limit does not switch drift off for the room (precondition needs updating for the assistant-first bearer)', cwd: TESTS,
    cmd: PW('e2e/drift-scope-heavy-member.spec.ts'),
    env: { DRIFT_SCOPE_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // CAPABILITY REFUSAL (SPEC-CAPABILITY-REFUSAL). A basic conversation with two people: a public report
  // request is refused to the room while the asker alone reads where reports are produced, and a
  // targeted image request from a basic-only person is refused privately and points at an administrator.
  // E2E_INSTANCE_NAME resolves the task tables, which prove no task was opened.
  { id: 'capability-refusal', label: 'Capability refusal e2e: a request for something the assistant does not offer is refused, and says where to get it', cwd: TESTS,
    cmd: PW('e2e/capability-refusal.spec.ts'),
    env: { CAPABILITY_REFUSAL_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  { id: 'bilingual', label: 'Bilingual e2e: a conversation holds its language across turns', cwd: TESTS,
    cmd: PW('e2e/bilingual-conversations.spec.ts'), optional: true },

  // ADMIN_ALERT_E2E drives a real uncleared membership so an admin alert is posted and emailed: the
  // sender (the admin-agent bot) and the recipients (live membership, not the Metadata roster) are only
  // observable on an alert that was actually sent. Needs `admin` in capabilities (the admin notification channel);
  // E2E_INSTANCE_NAME is the SSM root the channel and bot ARNs are published under.
  { id: 'notifications', label: 'Notification e2e: the bridge delivers outside the app, and an admin alert is sent as the admin assistant, in its own words, to members', cwd: TESTS,
    // `preferences` reads the same test inbox: a mail a person can stop carries its one-click unsubscribe. The operator
    // notice spec saves the admin assistant a `cloudwatch-alarm` template and drives an alarm through the one notifier.
    cmd: PW('e2e/notification-bridge.spec.ts e2e/preferences.spec.ts e2e/an-operator-notice-is-worded-by-the-admin-agent.spec.ts'),
    env: { ADMIN_ALERT_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // THE DEMO'S PEOPLE RECEIVE WHAT THE DEMO SAYS THEY DO. The demo cast (`provision-test-users --cast ops-demo`,
  // secret agent-interface/demo-credentials) is on the test inbox's domain, so the mail a share sends one cast
  // member is read back from the inbox and its recipient, deep link and sender asserted. DEMO_CAST_MAIL_E2E opts
  // the spec in: it opens one premium conversation as the on-call lead and shares it with the engineering manager,
  // then puts the declared ops event on the bus (Act 3.2) and reads the welcome the lead is emailed from the new
  // ops room. That half needs the Ops assistant (ops-premium in profiles) and puts the lead in `ops` for the run only.
  { id: 'demo-cast-mail', label: 'Demo cast mail e2e: a share, and the ops event, each email the demo person they name, linking into that conversation, from its assistant', cwd: TESTS,
    cmd: PW('e2e/demo-cast-mail.spec.ts'),
    env: { DEMO_CAST_MAIL_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  { id: 'cost', label: 'Cost e2e: sleep mode parks idle spend and wakes on demand', cwd: TESTS,
    cmd: PW('e2e/cost-sleep-mode.spec.ts'), optional: true },

  // THE MANUAL SLEEP/WAKE FAILURE ALERT. NOT PART OF A RUN, like `queue-demo`, and for a different
  // reason: the only way to reach the failure path on a real deployment is to drive a real transition
  // that Aurora refuses, which pauses the data plane while it runs. That is not something an unattended
  // sweep of a shared deployment should do. Reachable by name only; see the spec header.
  { id: 'sleep-failure', label: 'Cost e2e (manual): a failed manual sleep/wake publishes to the sleep topic (run with --only=sleep-failure)',
    cwd: TESTS, manualOnly: true, optional: true,
    cmd: PW('e2e/cost-sleep-failure-alert.spec.ts'),
    env: { SLEEP_FAILURE_E2E: '1' } },

  { id: 'latency', label: 'Latency e2e: time-to-first-token stays inside the stated SLA', cwd: TESTS,
    // The Amazon Lex leg measured on every turn (`the-lex-leg-is-measured-per-turn`) rides with the SLA it is part of.
    cmd: PW('e2e/latency.spec.ts e2e/the-lex-leg-is-measured-per-turn.spec.ts'), env: { LATENCY_E2E: '1', LEX_LEG_E2E: '1' }, optional: true },

  // THE NUMBERS MEAN WHAT THE SPEC SAYS. Every other analytics phase asserts that
  // something rendered, or that a figure agrees with another figure the same code computed. Neither
  // can see a number that is stable, moves correctly with the window, reconciles against itself, and
  // describes a different population from the one its name claims. The P95 latency band is tuned
  // against the turn count, so that count has to be what its name says.
  //
  // READ-ONLY: it drives no traffic and costs no model turns, so it can run beside anything. It reads
  // what the deployment has already recorded, which also means it cannot be made to pass by
  // generating friendlier data.
  { id: 'analytics-accuracy', label: 'Analytics accuracy: windows, weighting, and populations that match their names', cwd: TESTS,
    // `ttff-decomposition` reads the same recorded turns under the same gate: the time to first feedback is
    // the sum of the spans LATENCY-TARGETS names.
    cmd: PW('e2e/analytics-accuracy.spec.ts e2e/ttff-decomposition.spec.ts'), env: { ANALYTICS_ACCURACY_E2E: '1' }, optional: true },

  // THE EVALUATION RUNNER, DRIVEN END TO END. Every claim on SPEC-EVALUATION rested on unit tests, and
  // that document says in its own words that none of them executes any evaluation SQL against a
  // database or asserts anything about a verdict a judge actually returned. The path this drives has
  // more seams than most: a scheduled Lambda inside the VPC, a migration that must have applied on the
  // live cluster, a Bedrock judge, an INSERT against a partial unique index, and four read queries in a
  // DIFFERENT Lambda that must name the same columns. Each half was green in isolation, which is how a
  // feature here has shipped inert before.
  //
  // SEPARATE FROM THE `evaluate` PHASE, which invokes the runner so the admin phase reads real scores
  // and asserts nothing about what came back. This drives a turn of its own, invokes the runner the
  // same way, and then reads the verdict back through the signed analytics API - so the phase that
  // produces the scores and the phase that PROVES the path are not the same phase.
  //
  // It asserts WIRING and SHAPE only, never a judged outcome: the spec's header says why, at length,
  // because the temptation to assert the verdict is the thing most likely to turn this into a flaky
  // gate with retries on it. Aurora-only, and dropped from the phase list below when no Aurora
  // analytics stack resolves.
  { id: 'evaluation-verdicts', label: 'Evaluation e2e: a real turn is judged and the verdict is readable through the signed analytics API', cwd: TESTS,
    cmd: PW('e2e/evaluation-verdicts.spec.ts'), env: { EVALUATION_VERDICTS_E2E: '1' }, optional: true },

  // Task resolution is measured SEPARATELY from turn latency, and so is its phase: the two read
  // different views with different denominators, and a failure in one says nothing about the other.
  { id: 'task-resolution', label: 'Task-resolution e2e: a real task reaches v_task_resolution', cwd: TESTS,
    cmd: PW('e2e/task-resolution.spec.ts'), env: { TASK_RESOLUTION_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // The cross-conversation queue. Separate from the `tasks` phase because that one asserts what a task
  // DOES in its own conversation; this asserts that a person's items from several conversations are
  // one list, which no single-conversation test can see.
  { id: 'open-work', label: 'Open-work e2e: "waiting on you" is one queue across conversations', cwd: TESTS,
    cmd: PW('e2e/open-work-items.spec.ts'), env: { OPEN_WORK_E2E: '1' }, optional: true },

  // ADR-033. One turn at a time, and what happens to the messages that arrive meanwhile. Every piece
  // has unit coverage and none of it can show the property the design is judged on: a person who keeps
  // typing is told so, their messages are picked up rather than lost, and `/stop` reaches the work in
  // something close to real time. It spans five Lambdas and a React hook, each green in isolation -
  // which is how this feature shipped inert once already.
  //
  // Needs `-c turnQueue=true` on the deployment. Without it nothing ever queues and the phase fails
  // loudly, which is the right direction: passing against a deployment with the feature switched off
  // would be worse than not running.
  // NOT PART OF A RUN. `manualOnly` keeps it out of the phase list unless it is asked for by name,
  // because it ends by handing you the browser and waiting - which would stall any unattended run.
  //
  // It is here rather than in a standalone script so it inherits this file's resolution: the live
  // chat origin, the pools and the turn-state table all come from CloudFormation, which is the same
  // reason the e2e recipe says to go through validate rather than calling playwright by hand.
  { id: 'queue-demo', label: 'Queue demo: WATCH a drain in a browser you drive (run with --only=queue-demo)',
    cwd: TESTS, manualOnly: true, optional: true,
    // `--project=queue-demo`, not `chat`: the spec is deliberately excluded from the chat project
    // so an unattended sweep cannot start a demo that waits for a person, and it has a project of
    // its own for exactly this invocation. Naming `chat` here matched zero tests and exited non-zero.
    cmd: PW('e2e/queue-demo.spec.ts') + ' --headed --workers=1 --project=queue-demo',
    env: { QUEUE_DEMO: '1', E2E_INSTANCE_NAME: INSTANCE_NAME, PWDEBUG: '1' } },
  { id: 'turn-queue', label: 'Turn-queue e2e: deferral, depth, /stop, and per-responder busy', cwd: TESTS,
    // E2E_INSTANCE_NAME is how this spec finds the turn-state table, reading the same shared SSM
    // contract the task specs read. Without it resolveTurnStateTable() returns null, the offer poll
    // returns null every time, and the split test reports "offer: null" for a deployment that wrote
    // the offer - a harness silence indistinguishable from the product failing.
    cmd: PW('e2e/turn-queue.spec.ts'),
    env: { TURN_QUEUE_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // THE SAME QUEUE, WITH MORE THAN TWO PEOPLE IN THE ROOM. Three behaviours are inert below three
  // members - the addressed reply, an offer covering two people, and anything about what the room can
  // see - so the 1:1 phase above cannot reach them however long it runs.
  { id: 'group-split', label: 'Group split offer: a queue covering two people is put to both', cwd: TESTS,
    cmd: PW('e2e/group-split-offer.spec.ts'),
    env: { GROUP_SPLIT_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // A STOP SENT PRIVATELY IN A ROOM, which is inert in every 1:1 phase above. The refusal needs both
  // conditions at once - a Target on the message, and a room bigger than two - so the queue specs
  // cannot reach it: there a private stop is allowed to proceed, and asserting the refusal would
  // assert the rule backwards. E2E_INSTANCE_NAME for the same reason as the two phases above: the
  // holder is what says the turn was still running when the refusal landed.
  { id: 'private-stop', label: 'Private stop: a private /stop in a room is refused and nothing is stopped', cwd: TESTS,
    cmd: PW('e2e/private-stop.spec.ts'),
    env: { PRIVATE_STOP_E2E: '1', E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // ADR-027 phase 2. The turn-level assertion a unit test cannot make: what the MODEL does when it is
  // taught a labelling convention, which is where the convention can escape into the channel.
  { id: 'attribution', label: 'Attribution e2e: a merged turn is labelled, a reply never is', cwd: TESTS,
    cmd: PW('e2e/speaker-attribution.spec.ts'), env: { ATTRIBUTION_E2E: '1' }, optional: true },

  { id: 'admin-surfaces', label: 'Admin e2e (surfaces): navigation, flows, attachment access, render integrity', cwd: TESTS,
    // The dashboard phase asserts DATA; these assert the console around it - the parts an operator
    // touches to reach that data.
    cmd: PW('e2e/admin-nav.spec.ts e2e/admin-flow.spec.ts e2e/admin-attachments.spec.ts '
      + 'e2e/admin-dashboard-render.spec.ts '
      // `admin-task-routes` rides here rather than in a phase of its own: it is an operator surface,
      // it needs the same admin origin and vended credential the others do, and a spec registered in
      // NO phase is a spec that never runs - which is what it was. It asserts the three D8 task
      // routes through the signed path, including that the assignee read and the owner read do not
      // serve each other's set, and that each vend is pinned to the one principal it named.
      + 'e2e/admin-task-routes.spec.ts'),
    // AND THE INSTANCE NAME, WITHOUT WHICH THAT SPEC SILENTLY OPTS OUT (2026-09-10).
    //
    // `resolveTaskTable` reads the shared SSM contract at `/<instance>/shared/tables/...`, and with no
    // instance to key on it returns null and the four task-route tests skip themselves. This phase
    // passed no env at all, so registering the spec here - done precisely because "a spec registered
    // in NO phase is a spec that never runs" - bought a spec that ran and then declined to test
    // anything. `E2E_REQUIRE_ALL=1` is what caught it; without that the phase reads 8 passed.
    //
    // It matters beyond the four tests: this spec is the live check that the D8 task routes keep the
    // assignee and owner reads apart and pin each vend to its principal, so neither could be settled
    // while it quietly opted out.
    env: { E2E_INSTANCE_NAME: INSTANCE_NAME },
    optional: true },

  // THE BOUNDARY AND CONSOLE SPECS NO PHASE NAMED, and so never ran: a conversation read carries no name,
  // a vended session writes no processor record and is narrowed to its definition, only the vend mints an
  // assistant session, two private messages stay apart, the console reflects the role, a response can be
  // flagged, and a runtime assistant answers as itself. Each skips on its own when its credentials are
  // absent; `backend/test/every-e2e-spec-runs-in-a-phase.test.ts` refuses a spec no phase names.
  { id: 'boundaries', label: 'Boundaries e2e: names withheld, vend-only sessions, narrowed sessions, private messages, console role', cwd: TESTS,
    cmd: PW('e2e/a-conversation-is-read-without-who-said-it.spec.ts e2e/a-vended-session-cannot-write-processor-records.spec.ts '
      + 'e2e/an-assistant-session-is-narrowed-to-its-definition.spec.ts e2e/only-the-vend-mints-an-assistant-session.spec.ts '
      + 'e2e/identical-private-messages.spec.ts e2e/admin-console-reflects-role.spec.ts e2e/flag-a-response.spec.ts '
      + 'e2e/a-runtime-assistant-answers-as-itself.spec.ts e2e/a-team-creates-opens-and-moves-its-own-assistant.spec.ts'),
    env: { E2E_INSTANCE_NAME: INSTANCE_NAME, TEAM_CREATE_E2E: '1' }, optional: true },

  // THE ADMIN CAPABILITY AND OWNER-TAG DENY-TESTS, run from a sweep rather than only by hand. Each proves a
  // refusal against the deployed API and IAM: every admin route refused to a role that does not hold it, a
  // team creating only where its clearance and the deployment allow and moving only to its own teams, and the
  // `owner-team` tag written by its one writer. They change live ownership for the run and put it back. The
  // phase runs in a sweep and is optional, so a failure is reported loudly and fails only a --strict run. Each
  // check gates itself on what the deployment supplies (a team user in two teams, an uncleared classification,
  // a role that is declared and not enabled): one it cannot run prints `skipped:` with the reason, and a setup
  // error exits 2 and names what is missing.
  { id: 'deny-tests', label: 'Deny-tests: admin capabilities and team create refused where not held; the owner tag has one writer', cwd: BACKEND,
    cmd: 'node scripts/run-deny-tests.mjs admin-capabilities owner-team-tag', optional: true },

  // AN ORGANIZATION'S IDENTITY PROVIDER, the steps IDENTITY-PROVIDER-GUIDE "Groups from your provider" tells a
  // deployer to follow, against the TestIssuer fixture provider; and the H1 foreign-issuer person and their
  // offboarding (AE_H1_ID_TOKEN).
  { id: 'identity-providers', label: 'Identity providers e2e: a provider\'s groups give the access the guide describes; a foreign person and their offboarding', cwd: TESTS,
    cmd: PW('e2e/a-providers-groups-give-the-access-the-guide-describes.spec.ts e2e/h1-person.spec.ts e2e/h1-offboard.spec.ts'),
    env: { E2E_INSTANCE_NAME: INSTANCE_NAME }, optional: true },

  // THE GUEST AND INVITATION PATHS, each gated as its spec says: a guest deployment (the widget on the sample
  // host page, the funnel's two paths), invitations, and a person's export.
  { id: 'guest-and-invitations', label: 'Guest, invitation and export e2e: the widget on its host page, the funnel, invitations, export', cwd: TESTS,
    cmd: PW('e2e/guest-widget.spec.ts e2e/funnel.spec.ts e2e/invitations.spec.ts e2e/export.spec.ts'),
    env: { GUEST_WIDGET_E2E: '1', FUNNEL_E2E: '1', INVITATIONS_E2E: '1', EXPORT_E2E: '1' }, optional: true },

  // LAST, AND ONCE PER RUN: delete the conversations this run created, so runs do not accumulate. Not per phase,
  // because later phases read what earlier ones made - `evaluate` scores their exchanges and `admin`
  // verifies the dashboard against them. Deleting a channel removes it from Amazon Chime SDK only; the
  // archive keeps every event and every analytics fact. Only rooms CREATED after the run's start marker
  // that have a test user as a member are selected, so the admin notification channel and demo rooms,
  // which are older, are never touched.
  { id: 'cleanup', label: 'Cleanup: delete the conversations this run created', fn: cleanupRun, optional: true },
];

// ── A TYPO STOPS THE RUN BEFORE IT COSTS ANYTHING (2026-09-10) ────────────────────────────────
//
// Checked HERE, immediately after the phase list, rather than beside the filtering further down:
// everything between the two resolves a deployment and reads AWS, so a misspelled phase used to pay
// for all of it before being told. Nothing above this line needs credentials.
if (only.length) {
  const unknown = only.filter((id) => !PHASES.some((p) => p.id === id));
  if (unknown.length) {
    console.error(
      `[validate] unknown phase(s): ${unknown.join(', ')}.`
      + ` Valid: ${PHASES.map((p) => p.id).join(', ')}`,
    );
    process.exit(2);
  }
}

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
  let cmd;
  try {
    cmd = narrowToSpecs(phase.cmd);
  } catch (err) {
    console.error(`\n[validate] FAILED at phase "${phase.id}": ${err.message}`);
    return false;
  }
  console.log(`    $ ${cmd}   (cwd: ${path.relative(process.cwd(), phase.cwd) || '.'})`);
  const phaseStartedAt = Date.now();
  const res = spawnSync(cmd, {
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
      // Each phase keeps its own Playwright artifacts (tests/test-results/<phase>/), so a later phase
      // cannot wipe an earlier phase's failure evidence. Read by playwright.config.ts.
      E2E_OUTPUT_DIR: `./test-results/${phase.id}`,
      // The watchdog's operator-alert listener reports an alert posted before this moment as standing, not
      // as this phase's (tests/e2e/helpers/watchdog/run-watch.ts).
      E2E_PHASE_STARTED_AT: String(phaseStartedAt),
      ...(phase.env || {}),
    },
  });
  const watchdogClean = reportWatchdog(phase);
  if (res.status !== 0) {
    if (phase.optional && skipBattle) return true; // shouldn't reach; guarded below
    console.error(`\n[validate] FAILED at phase "${phase.id}" (exit ${res.status}).`);
    return false;
  }
  if (!watchdogClean) {
    console.error(`\n[validate] FAILED at phase "${phase.id}": the watchdog recorded a failure no test answered for (above).`);
    return false;
  }
  return true;
}

/**
 * What the e2e watchdog saw during a phase: the alarms already standing when it began, every operator alert
 * that arrived while it ran, and any failure that arrived with no test running to fail. Returns false when
 * such a failure is recorded, so a phase cannot pass over an alarm that fired between tests.
 */
function reportWatchdog(phase) {
  const file = path.join(TESTS, 'test-results', phase.id, 'watchdog-record.json');
  if (!fs.existsSync(file)) return true;
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[validate] the watchdog record for "${phase.id}" could not be read: ${err.message}`);
    return true;
  }
  const lines = [];
  if (rec.preexistingAlarms?.length) lines.push(`  standing before the phase (not this run's): ${rec.preexistingAlarms.join(', ')}`);
  for (const a of rec.alerts ?? []) {
    if (a.preexisting) continue;
    const tag = a.fails ? 'FAILED THE RUN' : a.expected ? 'declared by a spec' : a.kind;
    lines.push(`  ${a.atIso} ${a.kind} ${a.name} [${tag}]: ${String(a.reason || '').slice(0, 200)}`);
  }
  for (const n of rec.watched?.notes ?? []) lines.push(`  note: ${n}`);
  for (const u of rec.unattributed ?? []) lines.push(`  NO TEST RAN TO FAIL: ${u}`);
  if (lines.length) console.log(`\n[validate] watchdog, phase "${phase.id}":\n${lines.join('\n')}`);
  return !(rec.unattributed ?? []).length;
}

/**
 * Score the exchanges/flows the e2e just produced by invoking the evaluation runner synchronously,
 * so the admin phase verifies the dashboard against REAL scores instead of an empty backlog (the
 * scheduled run is only every 30 min). Best-effort: needs Aurora mode + EVAL_LAMBDA_NAME resolved.
 */
/** Where a run records when it began, so its cleanup knows which conversations are its own. */
const RUN_START_MARKER = path.join(TESTS, 'test-results', '.e2e-run-start');

/** Record the run's start once; a run made of several `--only` invocations keeps its first marker. */
function markRunStart() {
  if (fs.existsSync(RUN_START_MARKER)) return;
  fs.mkdirSync(path.dirname(RUN_START_MARKER), { recursive: true });
  // A minute's cushion, for clock skew between this machine and the service's CreatedTimestamp.
  fs.writeFileSync(RUN_START_MARKER, new Date(Date.now() - 60_000).toISOString());
}

async function cleanupRun() {
  if (!fs.existsSync(RUN_START_MARKER)) {
    console.warn('[validate] no run-start marker, so this run made nothing to clean up.');
    return;
  }
  const since = fs.readFileSync(RUN_START_MARKER, 'utf8').trim();
  const res = spawnSync('node', [path.join(BACKEND, 'scripts', 'delete-conversations.mjs'), `--created-since=${since}`, '--only-test-people', '--apply'], {
    cwd: BACKEND, stdio: 'inherit', env: process.env, shell: process.platform === 'win32',
  });
  // ONLY ROOMS WHOSE PEOPLE ARE ALL TEST USERS (`--only-test-people`), so a marker left by a killed run that
  // reaches further back still never takes a room a real person is in.
  // KEPT ON FAILURE, so a rerun of `--only=cleanup` finishes what this one could not.
  if (res.status !== 0) throw new Error(`cleanup exited ${res.status}; the run-start marker is kept so a rerun finishes it`);
  fs.rmSync(RUN_START_MARKER, { force: true });
}

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
/**
 * RESOLVE AN ENV VAR FROM A CDK OUTPUT, because a spec that cannot find what it needs SKIPS.
 *
 * Four specs gated on variables nothing set: the conversation API URL, the user pool id, the
 * channel-context table and the manage-profiles URL. Each was supplied by hand during development and
 * by nobody in the harness, so each one self-skipped the moment it ran here - and a skip reported as a
 * pass is the failure mode `E2E_REQUIRE_ALL` exists to catch. Resolving them centrally is what makes
 * wiring a spec into a phase mean it RUNS.
 *
 * Returns quietly when the variable is already set, so an operator can still override any of them.
 */
function resolveFromStackOutput(envVar, stackSuffix, outputKey, label) {
  if (process.env[envVar]) return;
  const region = process.env.AWS_REGION || 'us-east-1';
  const stack = `${STACK_PREFIX}${stackSuffix}`;
  const q = `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue`;
  const res = spawnSync(
    `aws cloudformation describe-stacks --stack-name ${stack} --region ${region} --query "${q}" --output text`,
    { shell: true, encoding: 'utf8' },
  );
  const value = (res.stdout || '').trim();
  if (value && value !== 'None') {
    process.env[envVar] = value;
    console.log(`[validate] ${label} resolved from CDK outputs: ${value}`);
  } else {
    console.warn(`[validate] WARNING: could not resolve ${outputKey} from ${stack} - tests needing ${label} will SKIP.`);
  }
}

// THE TWO HTTP APIS: every route a person calls is on PersonApi, every admin route on AdminApi, and each
// publishes the capabilities whose routes it serves, which the specs skip a feature on.
resolveFromStackOutput('VITE_PERSON_API_URL', 'PersonApi', 'PersonApiUrl', 'person API URL');
resolveFromStackOutput('VITE_PERSON_API_CAPABILITIES', 'PersonApi', 'PersonApiCapabilities', 'person API capabilities');
resolveFromStackOutput('VITE_ADMIN_API_URL', 'AdminApi', 'AdminApiUrl', 'admin API URL');
resolveFromStackOutput('VITE_ADMIN_API_CAPABILITIES', 'AdminApi', 'AdminApiCapabilities', 'admin API capabilities');
// The console's events (ADR-065): told when a golden run, an upload or a generation ends.
resolveFromStackOutput('VITE_CONSOLE_EVENTS_HTTP', 'AdminServices', 'ConsoleEventsHttpDns', 'console events (HTTP)');
resolveFromStackOutput('VITE_CONSOLE_EVENTS_REALTIME', 'AdminServices', 'ConsoleEventsRealtimeDns', 'console events (WebSocket)');
resolveFromStackOutput('VITE_USER_POOL_ID', 'Identity', 'UserPoolId', 'user pool id');
resolveFromStackOutput('CHANNEL_CONTEXT_TABLE', 'Conversations', 'ChannelContextTableName', 'channel-context table');
// The SSM namespace every spec composes parameter names from. The specs default it to
// `/agent-echelon`, which is right for the default instance and wrong for any other, so it is set
// from the instance the run is actually targeting rather than left to a default.
if (!process.env.SSM_ROOT) process.env.SSM_ROOT = `/${INSTANCE_NAME}`;


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
  ['E2E_BASE_URL', `${STACK_PREFIX}ChatApp`, 'DistributionUrl'],
  ['E2E_ADMIN_BASE_URL', `${STACK_PREFIX}AdminApp`, 'AdminDistributionUrl'],
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
      + '  AE_STACK_PREFIX=<prefix> or AE_INSTANCE_NAME=<instance> (scripts/lib/stack-lookup.cjs).\n'
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
// Since the admin/chat app split (DESIGN-SEPARATE-ADMIN-APP), gen-frontend-env writes PER-PACKAGE .env
// files (packages/admin/.env + packages/chat/.env), NOT a root frontend/.env. Read the package files
// (admin first: the admin-only URLs — experiments/analytics/manage-profiles — live only there; the
// shared pool ids are in both), falling back to a legacy root frontend/.env for back-compat. Load any
// key not already set so the phases can reach the live APIs. VITE_USER_POOL_ID is loaded here too: the
// admin/tasks/experiments phases SigV4-sign their analytics reads (helpers/signed-analytics.ts) with a
// console session the credential exchange vends for the signed-in operator - without the pool and the
// exchange URL, those signed reads fail and the admin verification is empty.
const FRONTEND = path.join(BACKEND, '..', 'frontend');
// PER-PACKAGE ONLY. The legacy root `frontend/.env` used to sit at the end of this list as
// "back-compat", and on 2026-08-06 it silently supplied a dead user pool, a dead credential pool and an
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
  // THE TWO API BASES AND WHAT EACH SERVES. Every route a spec calls is composed from one of these
  // (`tests/e2e/helpers/api-urls.ts`), so a key missing from this list self-skips every phase that
  // needs it with a reason that reads like a local setup problem rather than a harness gap.
  'VITE_PERSON_API_URL', 'VITE_PERSON_API_CAPABILITIES',
  'VITE_ADMIN_API_URL', 'VITE_ADMIN_API_CAPABILITIES',
  'VITE_CONSOLE_EVENTS_HTTP', 'VITE_CONSOLE_EVENTS_REALTIME',
  'VITE_USER_POOL_ID',
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
  const ANALYTICS_STACK = `${STACK_PREFIX}Archive`;
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
    // ANCHORED TO THIS INSTANCE'S STACK PREFIX, not a bare name match.
    //
    // This account is shared with other projects, and CDK derives a function name from its stack -
    // so the unanchored form matched another project's evaluation function just as readily as
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
  // `evaluation-verdicts` is dropped on the same POSITIVE 'absent', for the same reason and with the
  // same consequence if it were kept. Athena mode deploys a different, much smaller runner and has no
  // `evaluation_results` table, so there is no verdict for the spec to read: it would state its missing
  // precondition, and `E2E_REQUIRE_ALL=1` (this script's default) turns any stated skip into a phase
  // failure. That would report a correct Athena deployment as broken - the mirror image of the silent
  // pass this suite is built to prevent, and just as wrong.
  const j = PHASES.findIndex((p) => p.id === 'evaluation-verdicts');
  if (j !== -1) {
    PHASES.splice(j, 1);
    console.log('[validate] NOTE: no Aurora analytics stack — skipping the evaluation-verdict e2e (Athena mode has no evaluation_results table to read a verdict from).');
  }
} else if (!process.env.EVAL_LAMBDA_NAME) {
  // The stack IS there and the Lambda still did not resolve: a missing output, an IAM gap, a throttle,
  // a deploy in flight. That is a fault rather than a configuration, so the phase STAYS and fails
  // visibly. The old gate read this case as "no Aurora stack" and silently dropped the ingestion it
  // exists to guarantee - a skip that looks identical to a pass in the summary.
  console.warn(auroraStackPresence === 'unknown'
    ? '[validate] WARNING: neither the Aurora analytics stack nor EVAL_LAMBDA_NAME could be read. Keeping the RAG ingestion and evaluation-verdict phases so the failure is visible rather than skipped.'
    : '[validate] WARNING: the Aurora analytics stack resolved but EVAL_LAMBDA_NAME did not. Keeping the RAG ingestion and evaluation-verdict phases so the failure is visible rather than skipped.');
}

let phases = PHASES;
if (only.length) {
  // The names were checked immediately after the phase list, before anything reached AWS.
  //
  // IN THE PIPELINE'S ORDER, never the order they were typed: the phases depend on each other's data
  // (seed before user, evaluate after the turns it scores), and honouring the caller's order would
  // let a run pass or fail on the sequence somebody happened to write on the command line.
  phases = PHASES.filter((p) => only.includes(p.id));
} else {
  // A manual-only phase waits for a person, so it is reachable BY NAME and never by a plain run.
  phases = phases.filter((p) => !p.manualOnly);
}
// BOTH BATTLE PHASES, because the second one only has anything to review if the first ran. The
// experiment page's Battles section reads what a battle wrote, so skipping the battles and keeping the review means paying a
// browser phase to confirm an empty window - which it does by passing on its honest-empty copy, so
// it costs time and reports nothing.
if (skipBattle) phases = phases.filter((p) => p.id !== 'battle' && p.id !== 'experiment-battles');

if (phases.length === 0) {
  console.error(`[validate] no matching phase for --only=${only.join(',')}. Valid: ${PHASES.map((p) => p.id).join(', ')}`);
  process.exit(2);
}
if (only.length > 1) {
  console.log(`[validate] running ${phases.length} named phase(s), in pipeline order: ${phases.map((p) => p.id).join(' -> ')}`);
}

// DATA READINESS preflight. The data-producing phases self-skip (exit 0) when their deployed
// dependency is unresolved, which silently yields a sparse admin console. Surface it up front:
// map each rich-data dependency to whether it resolved above and which phase(s) it gates.
//
// THE TEST INBOX is the one dependency read from the test secret rather than the stack outputs:
// provision-test-users writes it there, from an existing inbox the deployer named or the opt-in
// TestInbox stack. Without it the notification phase can show only that an email was attempted.
async function readTestInbox(secretId) {
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const r = await new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' })
      .send(new GetSecretValueCommand({ SecretId: secretId }));
    const inbox = JSON.parse(r.SecretString || '{}').testInbox;
    return inbox?.bucket ? inbox : null;
  } catch {
    return null;
  }
}
const testInbox = await readTestInbox(process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials');
const demoInbox = await readTestInbox(process.env.DEMO_SECRET_NAME || 'agent-interface/demo-credentials');
const readiness = [
  ['live chat origin (E2E_BASE_URL)', !!process.env.E2E_BASE_URL, 'all browser e2e (else localhost — the live app is NOT tested)'],
  ['live admin origin (E2E_ADMIN_BASE_URL)', !!process.env.E2E_ADMIN_BASE_URL, 'battle, experiments, admin'],
  ['person API (VITE_PERSON_API_URL)', !!process.env.VITE_PERSON_API_URL, 'user (identity/exchange), feedback, tasks, every person route'],
  ['admin API (VITE_ADMIN_API_URL)', !!process.env.VITE_ADMIN_API_URL, 'tasks (Tasks/Flows admin data), governance (access auditing + archive record survival)'],
  ['SigV4 signing (VITE_USER_POOL_ID + the person API)', !!(process.env.VITE_USER_POOL_ID && process.env.VITE_PERSON_API_URL), 'admin/tasks/experiments signed reads (signed-analytics.ts)'],
  ['experiment routes (experiments in VITE_ADMIN_API_CAPABILITIES)', String(process.env.VITE_ADMIN_API_CAPABILITIES || '').split(',').includes('experiments'), 'experiments'],
  ['evaluation Lambda (Aurora only)', !!process.env.EVAL_LAMBDA_NAME, 'evaluate (quality scoring), evaluation-verdicts (the e2e that reads a verdict back)'],
  ['image-gen keys secret', !!process.env.IMAGE_GEN_KEYS_SECRET_ARN, 'image-gen'],
  ['test inbox (testInbox in the test secret)', !!testInbox,
    'notifications (email delivery: who received it, what it says, where it links)'],
  ['demo cast inbox (testInbox in the demo secret)', !!demoInbox,
    'demo-cast-mail (what the demo\'s people receive; provision-test-users --cast ops-demo)'],
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
async function probeBucket(bucket) {
  try {
    const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
    await new S3Client({ region: process.env.AWS_REGION || 'us-east-1' }).send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true };
  } catch (err) { return classifyProbeError(err, bucket); }
}

const PROBES = [
  ['live chat origin (E2E_BASE_URL)', () => probeHost(process.env.E2E_BASE_URL)],
  ['live admin origin (E2E_ADMIN_BASE_URL)', () => probeHost(process.env.E2E_ADMIN_BASE_URL)],
  ['person API (VITE_PERSON_API_URL)', () => probeHost(process.env.VITE_PERSON_API_URL)],
  ['admin API (VITE_ADMIN_API_URL)', () => probeHost(process.env.VITE_ADMIN_API_URL)],
  ['test inbox (testInbox in the test secret)', () => probeBucket(testInbox.bucket)],
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
  } else if (dep.startsWith('SigV4 signing')) {
    const [u, x] = await Promise.all([
      probeUserPool(process.env.VITE_USER_POOL_ID),
      probeHost(process.env.VITE_PERSON_API_URL),
    ]);
    if (!u.ok || !x.ok) {
      const why = [!u.ok && u.why, !x.ok && x.why].filter(Boolean).join('; ');
      // An auth failure on EITHER probe means neither was actually tested, so the pair reports AUTH.
      if (u.auth || x.auth) { verdict = 'AUTH'; unauthed.push(`${dep}: ${why}`); }
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
// The run's start, written before its first phase creates anything (cleanup alone records nothing).
if (!phases.every((p) => p.id === 'cleanup')) markRunStart();
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

if (releaseE2e) {
  // After EVERY phase, admin included: the admin phase reads what earlier phases created, and an
  // app-instance admin reads a conversation without membership, so releasing first would not break it -
  // but running last keeps the order obvious. A failure here is reported, never fatal to the verdict.
  console.log('\n[validate] releasing the memberships this run created (--release-e2e)');
  const rel = spawnSync(`node scripts/release-e2e-memberships.mjs --since=${RUN_STARTED_AT} --apply`, {
    cwd: BACKEND, stdio: 'inherit', shell: true,
    env: { ...process.env, USER_POOL_ID: process.env.USER_POOL_ID || process.env.VITE_USER_POOL_ID || '' },
  });
  if (rel.status !== 0) console.warn("[validate] membership release FAILED; this run's conversations keep their memberships.");
}

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
