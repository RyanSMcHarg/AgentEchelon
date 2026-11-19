/**
 * A WELCOME'S PROMPT STEP FOLLOWS ITS OPENING (SPEC-WELCOME-AND-CONTEXT FR24, ADR-061 decisions 8 and 9), against the
 * deployed stacks.
 *
 * The unit suite proves each half with the code's own functions (`a-prompt-welcome-follows-the-opening`: which welcome
 * applies, what a version may name, the turn, the dispatch, and where the router and processor run it). What only a
 * deployment proves is the path end to end:
 *  - a version of the premium primary whose `assistant-joined` welcome is an opening send followed by a `prompt` step
 *    (the shipped `welcome-greeting` template, with one read tool) validates and activates;
 *  - a conversation opened through the route the chat client calls is greeted by the opening first, with no model call
 *    before it, so it lands within seconds of the room's creation;
 *  - the router dispatches the prompt step's one model turn to the processor, which posts one more message to the room,
 *    declared a `welcome` turn (`turnKind: welcome`, `welcomeOutcome: posted`, `respPhase: final`) and said by the same
 *    assistant, after the opening;
 *  - the run records the prompt step as dispatched and ends in success, and the primary posts nothing else.
 *
 * WHAT IS OBSERVED, AND WHAT IS NOT. The model's words are not deterministic, so the spec asserts what is: which step
 * posted the opening (`eventStep` on its Metadata), the run's records for the prompt step and its end, the declaration
 * the prompt turn's message carries, the order of the two posts, and that nothing else from the primary is in the room.
 * The prompt turn's message carries no `eventStep`: the processor posts it on its own path (`runWelcomePromptTurn`), so it
 * is told apart by its declaration, and tied to the step by the run's `prompt` record. A refused meter, a guardrail or a
 * deadline would post nothing and record a fallback, so a posted message is the observable proof the turn delivered.
 *
 * THE RUN OWNS WHAT IT CHANGES. The premium primary activates a version whose welcome is the one above. Afterwards the
 * version that was active is activated again and the conversation is deleted.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/a-welcome-prompt-step-follows-the-opening.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL } from './helpers/api-urls';
import { idTokenFor } from './helpers/person';
import { pollFor, readTask } from './helpers/task-backend';
import { awsv, awsvText } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';
import { SERVED_VERSION_TTL_MS } from './helpers/version-under-test';
import { PROFILE, activate, activeVersionOf, draftWith, openConversation, rollBack, sleep } from './helpers/workflow-task';
import { isContinuation, partsOf, roomMessagesSeenBy, roomMessagesUntil, runKeyOf, stepOf, type RoomMessage } from './helpers/event-run-messages';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);

const MARK = `PROMPT-${Date.now().toString(36)}`;
const WORKFLOW = 'e2e-prompt-welcome';
const OPENING_STEP = 'opening';
const PROMPT_STEP = 'greeting';
/** The shipped prompt template a prompt welcome runs from (`shipped-message-templates.ts`). */
const PROMPT_TEMPLATE = 'welcome-greeting';
/** A read tool: the company document tool the welcome's turn already carries (`enableCompanyContextTool`). */
const READ_TOOLS = ['load_company_context'];
/** The opening makes no model call, so it lands with the room; the chat client's own welcome check waits this long. */
const OPENING_WITHIN_MS = 20_000;

/** The welcome under test: an opening send to the room, then one prompt turn, which ends the run. */
const promptWelcome = () => ({
  [WORKFLOW]: {
    on: 'assistant-joined',
    initial: OPENING_STEP,
    states: {
      [OPENING_STEP]: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: PROMPT_STEP, onFailure: PROMPT_STEP },
      [PROMPT_STEP]: { prompt: { template: PROMPT_TEMPLATE, tools: READ_TOOLS }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
});

/** One SSM parameter's value, or '' when it is not there. */
function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

function botOf(record: string): string {
  try { return String(JSON.parse(record).botArn || ''); } catch { return ''; }
}

test.describe.serial('a welcome\'s prompt step follows its opening with one model-written message (welcome-workflows)', () => {
  guardBackendErrors('a-welcome-prompt-step-follows-the-opening');

  let admin: VendedCredentials | undefined;
  let previousVersion: number | undefined;
  let activated = false;
  let primaryBot = '';
  let agentTable = '';
  let serviceAdmin = '';
  let channelArn = '';

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set WELCOME_WORKFLOWS_E2E=1 to run it (validate.mjs --only=welcome-workflows)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));

    primaryBot = botOf(ssmValue(`${SSM_ROOT}/assistant-assignments/premium/primary/assistants/${PROFILE}`));
    expect(primaryBot, `the assignment record of ${PROFILE} names no bot`).toContain('/bot/');
    agentTable = ssmValue(`${SSM_ROOT}/shared/tables/agent-tasks-name`);
    expect(agentTable, `${SSM_ROOT}/shared/tables/agent-tasks-name names no table`).toBeTruthy();
    serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(serviceAdmin, `${SSM_ROOT}/app-instance-admin-arn names no AppInstanceAdmin`).toBeTruthy();

    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
    previousVersion = await activeVersionOf(admin);
    expect(previousVersion, `${PROFILE} has no active version to return to`).toBeDefined();
  });

  test.afterAll(async () => {
    if (admin && activated) await rollBack(admin, previousVersion);
    if (channelArn && serviceAdmin) {
      try {
        awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', channelArn, '--chime-bearer', serviceAdmin]);
      } catch (err) {
        console.warn(`cleanup: could not delete the conversation ${channelArn}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  });

  test('a version whose welcome is an opening and then a prompt step with a read tool validates and activates', async () => {
    test.setTimeout(180_000);
    const valid = await draftWith(admin, promptWelcome());
    expect(valid.errors ?? [], JSON.stringify(valid).slice(0, 600)).toEqual([]);
    await activate(admin);
    activated = true;
  });

  test('the opening arrives first and fast, the prompt turn posts one welcome after it, and the primary posts nothing else', async () => {
    test.setTimeout(300_000);
    test.skip(!activated, 'the version was not activated');
    // The served version is cached by the router and the processor for 30 seconds.
    await sleep(SERVED_VERSION_TTL_MS);

    // OPENED AS THE CHAT CLIENT OPENS ONE: `POST /create-conversation` as the premium test user.
    const conv = await openConversation(`Prompt welcome ${MARK}`);
    channelArn = conv.channelArn;
    const personArn = conv.personArn;

    const fromPrimary = (ms: RoomMessage[]) => ms.filter((m) => m.senderArn === primaryBot);
    const openingOf = (ms: RoomMessage[]) => fromPrimary(ms).filter((m) => stepOf(m) === OPENING_STEP && !isContinuation(m));
    /** The prompt turn's message: declared a welcome by the processor, posted by no run step. */
    const promptOf = (ms: RoomMessage[]) => fromPrimary(ms).filter((m) => !stepOf(m) && !isContinuation(m)
      && m.meta?.turnKind === 'welcome' && m.meta?.welcomeOutcome === 'posted');

    // SETTLED: the opening and the prompt turn's message are both in the room, as the person who opened it sees it.
    const seen = await roomMessagesUntil(channelArn, personArn, (ms) => openingOf(ms).length > 0 && promptOf(ms).length > 0, { timeoutMs: 180_000 });
    const brief = JSON.stringify(fromPrimary(seen).map((m) => ({
      step: stepOf(m), kind: m.meta?.turnKind ?? '', outcome: m.meta?.welcomeOutcome ?? '', phase: m.meta?.respPhase ?? '', text: m.text.slice(0, 80),
    })));
    expect(openingOf(seen).length, `the opening was never posted; seen ${brief}`).toBeGreaterThan(0);
    expect(promptOf(seen).length, `the prompt step's turn posted no welcome; seen ${brief}`).toBeGreaterThan(0);

    // THE RUN: the prompt step is recorded as dispatched, and the run ends in success, since nothing follows the step.
    const opening = openingOf(seen)[0];
    const runKey = runKeyOf(opening);
    expect(runKey, 'the opening carries its run').toBeTruthy();
    expect(opening.meta?.eventStep?.event, 'the opening ran on assistant-joined').toBe('assistant-joined');
    expect(opening.meta?.eventStep?.workflow, 'the opening is the step of the version\'s welcome').toBe(WORKFLOW);
    const ended = await pollFor(() => readTask(agentTable, `event-run#${runKey}#step#end`, channelArn), (r) => Boolean(r), { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(ended?.outcome, `the run ${runKey} never ended`).toBe('success');
    expect(readTask(agentTable, `event-run#${runKey}#step#${PROMPT_STEP}`, channelArn)?.outcome, 'the prompt step dispatched its turn').toBe('dispatched');

    const settled = roomMessagesSeenBy(channelArn, personArn);

    // THE OPENING: posted once, to the room, with no model call before it, so it lands within seconds of the room.
    const openings = openingOf(settled);
    expect(openings.length, `one opening; seen ${brief}`).toBe(1);
    expect(openings[0].target, 'the opening is posted to the room').toEqual([]);
    expect(openings[0].meta?.welcomeOutcome, 'the opening is a platform send, not the prompt turn').toBeUndefined();
    const room = awsv(['chime-sdk-messaging', 'describe-channel', '--channel-arn', channelArn, '--chime-bearer', serviceAdmin]);
    const roomCreatedAt = Date.parse(String(room?.Channel?.CreatedTimestamp || ''));
    expect(Number.isFinite(roomCreatedAt), 'the conversation names when it was created').toBe(true);
    const openingAfterMs = Date.parse(openings[0].createdAt) - roomCreatedAt;
    console.log(`--- the opening landed ${openingAfterMs}ms after the conversation was created ---`);
    expect(openingAfterMs, 'the opening lands with the room, with no model call before it').toBeLessThanOrEqual(OPENING_WITHIN_MS);

    // THE PROMPT TURN: one welcome, said by the same assistant to the room, declared final, after the opening.
    const prompts = promptOf(settled);
    expect(prompts.length, `the prompt step's turn posted once; seen ${brief}`).toBe(1);
    const p = prompts[0];
    expect(p.target, 'the prompt turn\'s welcome is posted to the room').toEqual([]);
    expect(p.meta?.respPhase, 'the welcome is posted final, never as a placeholder').toBe('final');
    expect(p.meta?.agentType, 'the welcome is the primary\'s own turn').toBe(PROFILE);
    expect(Date.parse(p.createdAt), 'the prompt turn\'s welcome follows the opening').toBeGreaterThan(Date.parse(openings[0].createdAt));
    const said = partsOf(p, settled).map((m) => m.text).join('\n').trim();
    expect(said.length, 'the prompt turn says something').toBeGreaterThan(0);
    expect(said, 'the prompt turn does not repeat the opening').not.toBe(openings[0].text);

    // NOTHING ELSE: every message the primary posted is the opening, the prompt turn's welcome, or a part of either. The
    // room's line that a member joined is the membership's, not the welcome's, and is counted apart.
    const ours = new Set([...partsOf(openings[0], settled), ...partsOf(p, settled)].map((m) => m.messageId));
    const membership = (m: RoomMessage) => m.meta?.systemAnnouncement === 'member_joined';
    expect(fromPrimary(settled).filter((m) => !ours.has(m.messageId) && !membership(m)).map((m) => ({
      step: stepOf(m), kind: m.meta?.turnKind ?? '', announcement: m.meta?.systemAnnouncement ?? '', text: m.text.slice(0, 120),
    })), 'the primary posted nothing beside its opening and the prompt turn\'s welcome').toEqual([]);
  });
});
