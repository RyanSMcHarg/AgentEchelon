/**
 * A REPORT TASK, DRIVEN THROUGH ITS BRANCHES, not just past its opening turn.
 *
 * THE LIVE DEFECT THIS EXISTS FOR. A person asked for a report on Q2 ARR performance. The assistant proposed an
 * outline and ended its turn with a question: "Shall I go ahead, or would you like to adjust any
 * sections?". They answered it - "Can you make it 1-2 pages?" - and were told "It looks like you're
 * shifting topics. Want me to start a separate conversation?". A direct answer to the assistant's own
 * question was read as a change of subject, and the turn that should have narrowed the report was
 * spent offering to abandon it.
 *
 * WHY NOTHING CAUGHT IT. Every existing report e2e stops at, or just after, the opening turn:
 * `tasks.spec.ts` proves a task row lands, `task-state-machine.spec.ts` proves the persisted state is
 * a declared one, `task-resolution.spec.ts` proves the open reaches the ledger. None of them answers
 * the assistant mid-flow, so the state that had lost drift protection was never occupied by a test.
 * The suppression is now resolved from LIVE WORK IN THE CHANNEL rather than from who owns the task
 * (`liveTaskInChannel`, router-agent-handler), which is the property this spec pins.
 *
 * WHAT MAKES THE REGRESSION ASSERTION NON-VACUOUS. Three things, and each rules out a different way
 * of passing without testing anything:
 *   1. the flow must have REACHED the outline step before the scoping change is sent - asserted from
 *      the persisted `stateHistory` carrying `collecting_requirements -> drafting_outline`, not from
 *      the reply reading like an outline;
 *   2. the settled reply's Amazon Chime SDK message Metadata must declare `activeTask` - the
 *      backend's own account of the turn, and something a drift suggestion can never carry, because a
 *      fired suggestion SHORT-CIRCUITS the turn and the agent flow never runs;
 *   3. the persisted task row must MOVE with the turn (a new authorized edge, or `turnsInState`
 *      incremented by the no-transition counter). A short-circuited turn leaves the row untouched, so
 *      "the task advanced" is the exact falsifier of the defect rather than a restatement of it.
 * Only then does the test assert the absence of the two drift templates, which on its own would pass
 * on a turn that never reached the backend at all.
 *
 * THE OTHER BRANCHES. `generating -> revising` and the terminal `-> completed` are the two edges the
 * default machine declares and nothing drove: a report that is asked to change, and a report that
 * ends. Completion is asserted as a GRAPH EDGE plus the lifecycle ending, because the failure mode
 * being guarded is a task closed by something other than the machine - a walker that force-completed
 * a delivered-looking turn was removed for closing tasks from `drafting_outline` while the reply was
 * still asking a question.
 *
 * Serial by design: one conversation, one task, three stages. Each stage signs in and reopens the
 * conversation rather than sharing a page, so the console guard still watches a page the test drives.
 *
 * Gated by TASKS_E2E=1 (the validate.mjs "task-branches" phase). Reads DynamoDB via the AWS CLI
 * (AWS_PROFILE); table names come from env (AGENT_TASKS_TABLE / USER_TASKS_TABLE) or SSM
 * (`/<instance>/shared/tables/{agent,user}-tasks-name`, needs E2E_INSTANCE_NAME).
 *
 *   E2E_BASE_URL=<cf> TASKS_E2E=1 E2E_INSTANCE_NAME=<instance> AWS_PROFILE=<p> \
 *     npx playwright test e2e/report-flow-branches.spec.ts --config=playwright.config.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse, looksLikeTaskPlaceholder } from './helpers/agent-helpers';
import { isPlaceholder } from './helpers/websocket-monitor';
import { ChannelWireRecorder, type WireMessage } from './helpers/channel-wire';
import { getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import {
  REPORT_GENERATION,
  edgePath,
  graphEdges,
  hasEdge,
  isAuthorizedEdge,
  isDeclaredState,
  jwtSub,
  pollFor,
  readTask,
  resolveTaskTable,
  runTasksFor,
  terminalEntries,
  type TaskRow,
} from './helpers/task-backend';

guardConsoleErrors();

const RUN = process.env.TASKS_E2E === '1';
const SKIP_REASON =
  'Set TASKS_E2E=1 (the validate.mjs "task-branches" phase). This suite drives a real report task '
  + 'through its branches against a live deployment and reads the task row back from DynamoDB.';

/** Classified report_generation -> TASK_MULTI_STEP -> createTask (the prompt every report e2e uses). */
const REPORT_PROMPT =
  'Please compile a short report analyzing the pros and cons of a monorepo versus multi-repo for a 5-team org.';

/** The requirements the first step asks for: subject, audience, length or format. */
const REQUIREMENTS_ANSWER =
  'The audience is engineering leadership. Focus on delivery velocity, code ownership and CI cost, '
  + 'and give me an outline first.';

/**
 * THE MESSAGE THE DEFECT WAS ABOUT. A scoping change, phrased as the answer to the assistant's own
 * question about the outline. It names no new subject, so nothing in it is a topic change; it is
 * short, so a cosine comparison against the conversation summary is exactly what misreads it.
 */
const SCOPING_CHANGE = 'Can you make it 1-2 pages?';

/** Stable substrings of the two drift suggestion templates (analytics-aurora/drift-detection.ts). */
const DRIFT_CONFIRM_MARKER = 'start a separate conversation for this';
const DRIFT_REDIRECT_MARKER = 'want me to take you there';

/** The conversation and task this suite drives, established by the first stage. */
let channelArn = '';
let channelId = '';
let taskId = '';
let agentTable = '';
let userTable = '';

/** The freshest source-of-truth row for the task under test. */
function task(): TaskRow | undefined {
  return readTask(agentTable, taskId, channelArn);
}

/** Bot frames that arrived after `fromIndex` and carry settled content (never a progress placeholder). */
function settledBotMessages(wire: ChannelWireRecorder, fromIndex: number): WireMessage[] {
  return wire
    .botMessagesFor(channelArn)
    .slice(fromIndex)
    .filter((m) => m.content && !isPlaceholder(m.content) && !looksLikeTaskPlaceholder(m.content));
}

/** Wait for the backend's settled answer ON THE WIRE, which is the authority for what it sent. */
async function waitForSettledReply(
  wire: ChannelWireRecorder,
  fromIndex: number,
  timeoutMs = 180_000,
): Promise<WireMessage | undefined> {
  const found = await pollFor(
    () => settledBotMessages(wire, fromIndex),
    (msgs) => msgs.length > 0,
    { timeoutMs, intervalMs: 1_000 },
  );
  return found[found.length - 1];
}

/** Sign in and open the conversation this suite drives, with the wire recorded from before load. */
async function openConversation(page: Page): Promise<ChannelWireRecorder> {
  const user = await getPremiumUser();
  test.skip(!user.password, missingUserReason('premiumUser'));
  const wire = new ChannelWireRecorder();
  wire.attach(page);
  await signIn(page, user.email, user.password);
  await page.goto(`/?conversation=${channelId}`);
  await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 30_000 });
  return wire;
}

test.describe('a report task follows its machine through every branch it declares', () => {
  test.skip(!RUN, SKIP_REASON);
  test.describe.configure({ mode: 'serial' });
  guardBackendErrors('report-flow-branches');

  test.beforeAll(() => {
    agentTable = resolveTaskTable('agent-tasks') ?? '';
    userTable = resolveTaskTable('user-tasks') ?? '';
    expect(agentTable, 'AgentTasks table must resolve - set AGENT_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
    expect(userTable, 'UserTasks table must resolve - set USER_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
  });

  test('a scoping change answering the outline question continues the task and offers no new conversation', async ({ page }) => {
    test.setTimeout(900_000); // three task turns (up to 180s each) + the row polls between them

    const user = await getPremiumUser();
    test.skip(!user.password, missingUserReason('premiumUser'));

    const wire = new ChannelWireRecorder();
    wire.attach(page);
    await signIn(page, user.email, user.password);

    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    const runStart = Date.now() - 60_000; // skew cushion: the row is written just before the reply lands
    await createConversation(page, `Report branches ${Date.now()}`, 'Premium');
    channelArn = (await (await createResp).json()).conversation.conversationArn as string;
    channelId = channelArn.split('/').pop() || '';
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    console.log(`\n--- report-branches channel ---\n${channelArn}`);
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

    // Stage 1: open the task.
    const opening = await sendAndWaitForResponse(page, REPORT_PROMPT, 180_000);
    expect(opening.text && opening.text.length, 'the report turn must return a response').toBeTruthy();

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'idToken should be present after sign-in').toBeTruthy();
    const sub = jwtSub(idToken!);

    const mine = await pollFor(
      () => runTasksFor(userTable, sub, { taskType: 'report_generation', channelArn, since: runStart }),
      (rows) => rows.length > 0,
      { timeoutMs: 90_000, intervalMs: 3_000 },
    );
    expect(mine.length, `a report_generation task should exist for this conversation (sub=${sub})`).toBeGreaterThan(0);
    taskId = mine[0].taskId;
    console.log(`--- report-branches taskId ---\n${taskId}`);

    // Stage 2: answer the requirements until the machine LEAVES the first step. The precondition for
    // the whole test is that the task is at the outline, and the machine is what says so - a reply
    // that reads like an outline proves nothing about which state the runtime is in.
    //
    // `collecting_requirements` has exactly one exit, so any progress at all is the edge into
    // `drafting_outline`; the assertion names the edge rather than the destination so a machine that
    // grows a second exit later cannot satisfy it by accident.
    const NUDGES = [
      REQUIREMENTS_ANSWER,
      'One page, markdown, for engineering leadership. Please draft the outline now.',
      'Go ahead and lay out the section headings you plan to use.',
    ];
    let reached = task();
    for (const nudge of NUDGES) {
      if (hasEdge(reached, 'collecting_requirements', 'drafting_outline')) break;
      const answer = await sendAndWaitForResponse(page, nudge, 180_000);
      expect(answer.text && answer.text.length, 'a requirements turn must be answered').toBeTruthy();
      reached = await pollFor(
        () => task(),
        (t) => hasEdge(t, 'collecting_requirements', 'drafting_outline'),
        { timeoutMs: 60_000, intervalMs: 5_000 },
      );
    }
    expect(
      hasEdge(reached, 'collecting_requirements', 'drafting_outline'),
      'PRECONDITION: the task must have reached the outline step before the scoping change is sent, '
        + `else this test asserts nothing about it. State=${reached?.taskState} edges=[${edgePath(reached)}]`,
    ).toBe(true);

    // Stage 3: THE REGRESSION. A scoping change, which is an answer to the assistant's own question.
    const before = task();
    const beforeState = String(before?.taskState ?? '');
    const beforeTurns = Number(before?.turnsInState ?? 0);
    const beforeEdges = graphEdges(before).length;
    const wireBaseline = wire.botMessagesFor(channelArn).length;

    // The DOM wait is allowed to fail without ending the test: the message is sent either way, so the
    // wire still records what the backend answered, and the backend property is what this is about. A
    // client reconnect must not be reported as drift firing (drift-detection.spec.ts learned this the
    // expensive way).
    let domText = '';
    let domError: Error | null = null;
    try {
      domText = (await sendAndWaitForResponse(page, SCOPING_CHANGE, 240_000)).text;
    } catch (err) {
      domError = err as Error;
    }

    const settled = await waitForSettledReply(wire, wireBaseline, 120_000);
    expect(
      settled,
      'no settled reply reached the channel wire after the scoping change. The backend did not answer '
        + 'at all, which is a different failure from a drift offer.',
    ).toBeTruthy();
    console.log(`\n--- reply to the scoping change (WIRE) ---\n${settled!.content.slice(0, 400)}`);

    // 1. THE OFFER MUST NOT BE MADE. Both templates, because either one abandons the answer the person
    //    actually asked for, and the navigate marker, which is what acting on one looks like.
    const wireLower = settled!.content.toLowerCase();
    expect(wireLower, 'a drift suggestion was offered in answer to the outline question').not.toContain(DRIFT_CONFIRM_MARKER);
    expect(wireLower, 'a redirect suggestion was offered in answer to the outline question').not.toContain(DRIFT_REDIRECT_MARKER);
    expect(settled!.content, 'a NAVIGATE_CHANNEL marker reached the wire mid-task').not.toContain('NAVIGATE_CHANNEL');

    // 2. THE TURN WAS ANSWERED AS PART OF THE TASK. `activeTask` is stamped by the processor
    //    (analytics-metadata, carried through to the frontend Metadata), so it exists only on a turn
    //    the agent flow produced. A fired drift suggestion is posted directly and short-circuits the
    //    turn, so this is the per-turn evidence that no such short-circuit happened.
    //    The processor stamps it in two places for two consumers - the message Metadata and an
    //    `<!--ACTIVE_TASK:-->` marker in the content the client reads - and either one is the same
    //    evidence, so the assertion takes whichever arrived rather than pinning one carrier.
    const framesAfter = wire.botMessagesFor(channelArn).slice(wireBaseline);
    const declared = framesAfter
      .map((m) => {
        const fromMetadata = (m.metadata as Record<string, any> | undefined)?.activeTask;
        if (fromMetadata) return fromMetadata as { type?: string };
        const marker = m.content.match(/<!--ACTIVE_TASK:(\{.*?\})-->/);
        if (!marker) return null;
        try {
          return JSON.parse(marker[1]) as { type?: string };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ type?: string }>;
    expect(
      declared.length,
      'no reply after the scoping change declared an active task, so the turn was not answered as '
        + 'part of the report task. A fired drift suggestion is posted directly and the agent flow '
        + 'never runs, which is exactly this shape. Metadata seen: '
        + JSON.stringify(framesAfter.map((m) => m.metadata ?? null)),
    ).toBeGreaterThan(0);
    expect(
      String(declared[declared.length - 1].type),
      'the turn continued the report task, not some other work',
    ).toBe('report_generation');

    // 3. THE MACHINE MOVED WITH THE TURN. Either an authorized edge was appended, or the
    //    no-transition counter recorded the turn against this state. A short-circuited turn does
    //    neither, so this is the assertion that fails on the defect rather than describing it.
    const after = await pollFor(
      () => task(),
      (t) => graphEdges(t).length > beforeEdges || Number(t?.turnsInState ?? 0) > beforeTurns,
      { timeoutMs: 120_000, intervalMs: 5_000 },
    );
    expect(after, 'the task row must still exist after the scoping change').toBeTruthy();
    expect(
      graphEdges(after).length > beforeEdges || Number(after?.turnsInState ?? 0) > beforeTurns,
      'the task did not record the scoping-change turn at all: edges '
        + `${beforeEdges}->${graphEdges(after).length}, turnsInState ${beforeTurns}->${after?.turnsInState}. `
        + 'A turn the agent flow never ran leaves the row exactly like this.',
    ).toBe(true);

    // 4. AND IT MOVED ALONG DECLARED EDGES, rather than being abandoned or reset. Every new edge is
    //    authorized, the current state is declared, and the task is still live work.
    for (const e of graphEdges(after).slice(beforeEdges)) {
      expect(
        isAuthorizedEdge(REPORT_GENERATION, e.from, e.to),
        `the scoping change produced an unauthorized edge ${e.from}->${e.to}`,
      ).toBe(true);
      expect(['tool', 'system'], `edge ${e.from}->${e.to} must be machine-authored`).toContain(e.by);
    }
    expect(
      isDeclaredState(REPORT_GENERATION, after?.taskState),
      `taskState '${after?.taskState}' must be a declared report_generation state`,
    ).toBe(true);
    expect(
      ['cancelled', 'failed', 'abandoned'],
      `the task must not be abandoned by a scoping change (status=${after?.status}, `
        + `state ${beforeState}->${after?.taskState})`,
    ).not.toContain(String(after?.status));

    // 5. The client rendered what the wire delivered. A failure here is a CLIENT fault, and the
    //    message says so rather than reporting a drift regression.
    if (domError) {
      throw new Error(
        'the backend continued the task correctly (asserted on the wire above) but the client never '
          + `rendered the reply. This is a CLIENT-side delivery fault.\nunderlying: ${domError.message}`,
      );
    }
    const domLower = domText.toLowerCase();
    expect(domLower, 'a drift suggestion rendered in answer to the outline question').not.toContain(DRIFT_CONFIRM_MARKER);
    expect(domLower, 'a redirect suggestion rendered in answer to the outline question').not.toContain(DRIFT_REDIRECT_MARKER);
    expect(domText, 'a NAVIGATE_CHANNEL marker rendered mid-task').not.toContain('NAVIGATE_CHANNEL');
  });

  test('a change asked for after delivery moves generating -> revising and re-delivers', async ({ page }) => {
    test.setTimeout(900_000); // delivery drive (several 180s turns) + the revision turn

    expect(taskId, 'the opening stage must have established the task').toBeTruthy();
    const wire = await openConversation(page);

    // Drive to a DELIVERED report. Premium carries the rich processor, so delivery is a downloadable
    // document; the approvals mirror tasks.spec.ts, with one difference that matters here: they say
    // the report will be reviewed, so the model has no licence to close the task at delivery. A task
    // already at `completed` is terminal, and the revision edge is then unreachable by design.
    const attachment = page.locator('.assistant-message .attachment-display').last();
    const approvals = [
      'The outline works. Generate the full report and deliver it as a document - I will review it before we close this out.',
      'Yes, generate and attach the report as a file. Keep the task open for review.',
      'Please attach the report now.',
    ];
    let delivered = await attachment.isVisible({ timeout: 3_000 }).catch(() => false);
    for (const approval of approvals) {
      if (delivered) break;
      await sendAndWaitForResponse(page, approval, 240_000);
      delivered = await attachment.isVisible({ timeout: 5_000 }).catch(() => false);
    }
    expect(delivered, 'the report task must DELIVER a document before a revision can be asked for').toBe(true);

    const atDelivery = task();
    console.log(`--- state at delivery: ${atDelivery?.taskState} edges=[${edgePath(atDelivery)}] ---`);

    // THE REVISION BRANCH. `revising` is entered only when the user explicitly asks for changes, so
    // the ask is explicit. The attachment count is baselined rather than assumed: the delivery drive
    // above stops at the FIRST document, but a run that took two approvals to get there has whatever
    // count it has, and the claim being made is that the revision adds one more.
    const wireBaseline = wire.botMessagesFor(channelArn).length;
    const attachmentsBefore = await page.locator('.assistant-message .attachment-display').count();
    const revisionReply = await sendAndWaitForResponse(
      page,
      'Two changes please: cut the CI cost section down to a paragraph, and add a short recommendation '
        + 'at the end. Revise the report and send me the updated version.',
      240_000,
    );
    expect(revisionReply.text && revisionReply.text.length, 'the revision request must be answered').toBeTruthy();

    const revised = await pollFor(
      () => task(),
      (t) => hasEdge(t, 'generating', 'revising'),
      { timeoutMs: 180_000, intervalMs: 5_000 },
    );
    expect(
      hasEdge(revised, 'generating', 'revising'),
      'a change requested after delivery did not move the machine into `revising`. Edges recorded: '
        + `[${edgePath(revised)}], current state ${revised?.taskState}. A path that ends at `
        + '`generating->completed` means the task was closed at delivery, so the revision the person '
        + 'asked for could not re-open it.',
    ).toBe(true);
    const revisingEdge = graphEdges(revised).find((e) => e.from === 'generating' && e.to === 'revising')!;
    expect(['tool', 'system'], 'the revision edge must be machine-authored').toContain(revisingEdge.by);

    // AND THE PERSON GETS THE REVISED REPORT BACK. `revising` declares `delivers`, so a revision that
    // moves the machine and hands nothing over is the half-done case worth failing on.
    const redelivered = await pollFor(
      () => settledBotMessages(wire, wireBaseline).length,
      (n) => n > 0,
      { timeoutMs: 120_000, intervalMs: 2_000 },
    );
    expect(redelivered, 'the revision turn must post a settled reply').toBeGreaterThan(0);
    await expect(
      page.locator('.assistant-message .attachment-display'),
      'the revised report must be handed back too: `revising` declares `delivers`, so a revision that '
        + 'moves the machine and attaches nothing has told the person their changes were applied and '
        + 'given them no way to read them',
    ).toHaveCount(attachmentsBefore + 1, { timeout: 180_000 });
  });

  test('the task reaches its terminal state, and the machine is what closed it', async ({ page }) => {
    test.setTimeout(600_000);

    expect(taskId, 'the earlier stages must have established the task').toBeTruthy();
    await openConversation(page);

    // Accept the revised report. Completion has ONE path: the model declares it with
    // `advance_task_state` and the machine reaches terminal. The walker that used to force a
    // delivered-looking turn to completion was removed for closing tasks that were still asking
    // questions, so a task that will not close here is a real finding, not a flaky nudge count.
    const closers = [
      'That version is exactly right. Nothing further - please close this out as complete.',
      'Confirmed, the report is final. Mark the task complete.',
      'Yes, we are done here.',
    ];
    let closed = task();
    for (const closer of closers) {
      if (closed?.taskState === 'completed') break;
      const reply = await sendAndWaitForResponse(page, closer, 240_000);
      expect(reply.text && reply.text.length, 'the closing turn must be answered').toBeTruthy();
      closed = await pollFor(
        () => task(),
        (t) => t?.taskState === 'completed',
        { timeoutMs: 90_000, intervalMs: 5_000 },
      );
    }

    expect(
      closed?.taskState,
      `the task never reached its terminal state. Edges recorded: [${edgePath(closed)}], status ${closed?.status}`,
    ).toBe('completed');

    // THE MACHINE CLOSED IT, and that is asserted as a graph edge rather than as a status. A status
    // set with no edge behind it is the signature of a completion path outside the machine - which is
    // exactly what the removed walker did, from `drafting_outline`, while the reply was still asking.
    const edges = graphEdges(closed);
    const closing = edges[edges.length - 1];
    expect(closing, `the closing transition must be recorded as an edge. Edges: [${edgePath(closed)}]`).toBeTruthy();
    expect(closing.to, 'the last recorded edge must be the one into the terminal state').toBe('completed');
    expect(
      isAuthorizedEdge(REPORT_GENERATION, closing.from, closing.to),
      `the closing edge ${closing.from}->${closing.to} must be authorized by the machine`,
    ).toBe(true);
    expect(['tool', 'system'], 'the closing edge must be tool- or system-authored, never inferred from prose')
      .toContain(closing.by);

    // AND THE TASK RECORDS ITS ENDING. `updateTaskStatus` appends the lifecycle entry that says when
    // it ended and how it went; without it a finished task is a measurement gap in task resolution.
    expect(String(closed?.status), 'a terminal machine state must end the task').toBe('completed');
    const ending = terminalEntries(closed);
    expect(ending.length, `the task must record its ending. History: [${edgePath(closed)}]`).toBeGreaterThan(0);
    expect(String(ending[ending.length - 1].terminal), 'a completed report ends in success').toBe('success');
    console.log(`--- report task closed: [${edgePath(closed)}] status=${closed?.status} ---`);
  });
});
