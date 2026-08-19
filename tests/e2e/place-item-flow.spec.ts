/**
 * THE SCHEDULING MACHINE (`place_item`): propose, confirm, place - and the two replies that are not a
 * confirmation.
 *
 * WHAT IT IS. `place_item` puts something on a plan. `collecting -> confirming` is driven by the work-
 * item proposal's SUCCESS side-effect (`advancePlaceItemOnProposal`), not by a prose keyword and not
 * by the `<!--proposal:-->` marker itself; `confirming` declares BOTH `awaits` and
 * `resolvedByOneResponse`, so the person's next message is applied as the answer that completes the
 * step; `placed` is terminal with a `success` disposition.
 *
 * WHY IT NEEDED COVERAGE. It had none anywhere in the suite, and `resolvedByOneResponse` is the
 * riskiest flag the platform has: it is the only one that lets a person's message move a machine
 * without the model reading it. `applyUserResponseToTask` is explicit that its check is STRUCTURAL -
 * it asks whether the state awaits someone and has one exit, never what the message said - so every
 * reply arriving at `confirming` completes the step, including "actually, make it 45 minutes" and
 * "no, don't add it". That is the same class of defect as the report regression next door: a machine
 * reading a person's words as something they did not say. The three tests below occupy that state and
 * say what each reply must and must not do to the task.
 *
 * WHY THE TASK IS SEEDED AND THE PLAN IS STAMPED. A `place_item` task opens when the classifier emits
 * a `place_item` intent, which a deployment declares in its INTENT PACK; the platform default pack
 * this deployment runs declares the five enterprise intents and no work-item ones, and the work-item
 * tools are registered only for a conversation that carries a host plan (`domainContext`, written by
 * `federated-create-conversation`, which is gated on a `federatedUserPoolId` this deployment does not
 * set). So the test supplies those two host-side inputs and nothing else - the same technique
 * `bilingual-conversations.spec.ts` uses for `userLanguage`. Every runtime path under test is the
 * shipped one: the router's resume loop walks `Object.keys(taskStateMachines())` and so finds the
 * row, the processor registers the work-item tools off the stored plan, the proposal coupling
 * advances the machine, and the one-response confirm is `applyUserResponseToTask`.
 *
 * WHAT MAKES THESE NON-VACUOUS. Each test PROVES it reached `confirming` (polled from the persisted
 * row, with the proposal that caused it read off the channel wire) before asserting anything about
 * the reply that follows. Without that, "the task was not placed" passes on a task that never got
 * near the confirm step.
 *
 * Gated by TASKS_E2E=1 (the validate.mjs "task-branches" phase). Reads and writes DynamoDB via the
 * AWS CLI (AWS_PROFILE); table names come from env (AGENT_TASKS_TABLE / USER_TASKS_TABLE) or SSM
 * (`/<instance>/shared/tables/{agent,user}-tasks-name`, needs E2E_INSTANCE_NAME).
 *
 *   E2E_BASE_URL=<cf> TASKS_E2E=1 E2E_INSTANCE_NAME=<instance> AWS_PROFILE=<p> \
 *     npx playwright test e2e/place-item-flow.spec.ts --config=playwright.config.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse, looksLikeTaskPlaceholder } from './helpers/agent-helpers';
import { isPlaceholder } from './helpers/websocket-monitor';
import { ChannelWireRecorder } from './helpers/channel-wire';
import { getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import {
  PLACE_ITEM,
  clearPlanContext,
  deleteSeededTask,
  edgePath,
  graphEdges,
  hasEdge,
  isAuthorizedEdge,
  isDeclaredState,
  jwtSub,
  pollFor,
  proposalsIn,
  putPlanContext,
  readTask,
  resolveChannelContextTable,
  resolveTaskTable,
  seedPlaceItemTask,
  terminalEntries,
  type SeededTask,
  type TaskRow,
} from './helpers/task-backend';

guardConsoleErrors();

const RUN = process.env.TASKS_E2E === '1';
const SKIP_REASON =
  'Set TASKS_E2E=1 (the validate.mjs "task-branches" phase). This suite drives the place_item machine '
  + 'against a live deployment and reads the task row back from DynamoDB.';

/** The plan the conversation is about. Two items with ids, so a proposal can be positioned. */
const PLAN = {
  title: 'Q4 launch plan',
  items: [
    { id: 'item-kickoff', title: 'Kickoff meeting', status: 'open', start: '2026-09-01T15:00:00Z', end: '2026-09-01T15:30:00Z' },
    { id: 'item-copy', title: 'Marketing copy review', status: 'open', start: '2026-09-02T16:00:00Z', end: '2026-09-02T16:45:00Z' },
  ],
};

/** The ask that should produce a proposal, phrased so the model has the detail and the position. */
const ADD_REQUEST =
  'Add a 30-minute design review to the plan on September 2nd at 10:00, right after the kickoff. '
  + 'Propose it so I can confirm before anything is saved.';

/** One nudge, if the first turn described the change instead of proposing it. */
const ADD_NUDGE =
  'Please propose that as an actual change to the plan (the add tool), so I get something to confirm.';

let agentTable = '';
let userTable = '';
let contextTable = '';

/** Per-test state, torn down in afterEach so a run leaves no seeded work in anyone's queue. */
let seeded: SeededTask | null = null;
let channelArn = '';

function task(): TaskRow | undefined {
  return seeded ? readTask(agentTable, seeded.taskId, channelArn) : undefined;
}

/** Bot frames after `fromIndex` whose content has settled (never a progress placeholder). */
function settledBotContent(wire: ChannelWireRecorder, fromIndex: number): string[] {
  return wire
    .botMessagesFor(channelArn)
    .slice(fromIndex)
    .map((m) => m.content)
    .filter((c) => c && !isPlaceholder(c) && !looksLikeTaskPlaceholder(c));
}

/** Every work-item proposal the assistant emitted on this channel, decoded from the wire. */
function proposalsOnWire(wire: ChannelWireRecorder, fromIndex = 0) {
  return wire
    .botMessagesFor(channelArn)
    .slice(fromIndex)
    .flatMap((m) => proposalsIn(m.content));
}

/**
 * A conversation about a plan, with a `place_item` task open on it and the wire recorded from before
 * the page loads.
 */
async function openPlanConversation(page: Page, label: string): Promise<ChannelWireRecorder> {
  const user = await getPremiumUser();
  test.skip(!user.password, missingUserReason('premiumUser'));

  const wire = new ChannelWireRecorder();
  wire.attach(page);
  await signIn(page, user.email, user.password);

  const createResp = page.waitForResponse(
    (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await createConversation(page, `${label} ${Date.now()}`, 'Premium');
  channelArn = (await (await createResp).json()).conversation.conversationArn as string;
  expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
  await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

  const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
  expect(idToken, 'idToken should be present after sign-in').toBeTruthy();
  const sub = jwtSub(idToken!);

  // The two host-side inputs, written where production reads them.
  putPlanContext(contextTable, channelArn, PLAN);
  seeded = seedPlaceItemTask({
    agentTable,
    userTable,
    channelArn,
    sub,
    contextId: 'plan-q4-launch',
    requestExcerpt: 'Add a design review to the Q4 launch plan',
  });
  console.log(`\n--- ${label} ---\nchannel: ${channelArn}\ntask: ${seeded.taskId}`);
  return wire;
}

/**
 * Drive `collecting -> confirming` and prove it happened for the declared reason.
 *
 * Returns the wire index at which the confirm step began, so a caller can baseline what comes next.
 */
async function driveToConfirming(page: Page, wire: ChannelWireRecorder): Promise<number> {
  for (const message of [ADD_REQUEST, ADD_NUDGE]) {
    if (task()?.taskState === 'confirming') break;
    const reply = await sendAndWaitForResponse(page, message, 240_000);
    expect(reply.text && reply.text.length, 'the proposal turn must be answered').toBeTruthy();
    await pollFor(
      () => task(),
      (t) => t?.taskState === 'confirming',
      { timeoutMs: 90_000, intervalMs: 5_000 },
    );
  }

  const confirming = task();
  expect(
    confirming?.taskState,
    'PRECONDITION: the machine must be at `confirming` before a reply to it can be judged. '
      + `State=${confirming?.taskState} edges=[${edgePath(confirming)}]. A task still at `
      + '`collecting` means the assistant never proposed anything.',
  ).toBe('confirming');

  // THE ADVANCE IS COUPLED TO THE PROPOSAL, so the proposal has to be there. Read off the wire
  // because the chat client renders no confirm card: the widget that does belongs to a host app, and
  // asserting on the prose around the marker would be asserting on the model's wording.
  const proposals = proposalsOnWire(wire);
  expect(
    proposals.length,
    'the task advanced to `confirming` with no work-item proposal on the wire, so something other '
      + 'than the proposal tool moved it',
  ).toBeGreaterThan(0);
  console.log(`--- proposal: ${JSON.stringify(proposals[proposals.length - 1])} ---`);

  expect(hasEdge(confirming, 'collecting', 'confirming'), `edges: [${edgePath(confirming)}]`).toBe(true);
  const edge = graphEdges(confirming).find((e) => e.from === 'collecting' && e.to === 'confirming')!;
  expect(['tool', 'system'], 'the proposal advance must be machine-authored').toContain(edge.by);

  // Ownership is deliberately NOT asserted here. `collecting` does not await anyone and `confirming`
  // does, but the task was already held by the person who opened it, so the machine crosses no
  // ownership boundary and `maybeHandOver` correctly does nothing. An assertion that the person holds
  // it would restate the seed rather than test the runtime.

  return wire.botMessagesFor(channelArn).length;
}

/**
 * The task, read after the turn has settled.
 *
 * ORDER MATTERS FOR A NEGATIVE ASSERTION. `applyUserResponseToTask` runs in the ROUTER, before the
 * reply is composed, so by the time a settled reply is on the wire any advance it caused is already
 * written: reading here cannot pass by looking too early. The trailing re-reads cover the write
 * ordering between the source-of-truth row and its mirror, and the LAST read is the one returned.
 */
async function settleAndRead(wire: ChannelWireRecorder, fromIndex: number): Promise<TaskRow | undefined> {
  const replies = await pollFor(
    () => settledBotContent(wire, fromIndex),
    (c) => c.length > 0,
    { timeoutMs: 180_000, intervalMs: 1_000 },
  );
  expect(
    replies.length,
    'no settled reply reached the wire, so nothing can be said about what the turn did to the task',
  ).toBeGreaterThan(0);
  let row = task();
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    row = task();
  }
  return row;
}

test.describe('place_item: a proposal is confirmed by the person, and only a confirmation places it', () => {
  test.skip(!RUN, SKIP_REASON);
  guardBackendErrors('place-item-flow');

  test.beforeAll(() => {
    agentTable = resolveTaskTable('agent-tasks') ?? '';
    userTable = resolveTaskTable('user-tasks') ?? '';
    contextTable = resolveChannelContextTable() ?? '';
    expect(agentTable, 'AgentTasks table must resolve - set AGENT_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
    expect(userTable, 'UserTasks table must resolve - set USER_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
    expect(
      contextTable,
      'the server-only Channel Context store must resolve: the plan grounding this suite stamps is '
        + 'what registers the work-item tools, and without it no proposal can be made',
    ).toBeTruthy();
  });

  test.afterEach(() => {
    if (seeded && agentTable && userTable) deleteSeededTask(agentTable, userTable, seeded);
    if (channelArn && contextTable) clearPlanContext(contextTable, channelArn);
    seeded = null;
    channelArn = '';
  });

  test('a proposal the person confirms reaches the terminal `placed` state', async ({ page }) => {
    test.setTimeout(900_000);

    const wire = await openPlanConversation(page, 'place-item happy path');
    const afterProposal = await driveToConfirming(page, wire);

    // THE CONFIRMATION. One answer completes this step by declaration, and this is the answer the
    // declaration is for.
    const reply = await sendAndWaitForResponse(page, 'Yes, that is right - go ahead and add it.', 240_000);
    expect(reply.text && reply.text.length, 'the confirmation must be answered').toBeTruthy();
    await settleAndRead(wire, afterProposal);

    const placed = await pollFor(
      () => task(),
      (t) => t?.taskState === 'placed',
      { timeoutMs: 120_000, intervalMs: 5_000 },
    );
    expect(
      placed?.taskState,
      `a confirmed proposal must reach the terminal state. Edges: [${edgePath(placed)}], `
        + `status ${placed?.status}`,
    ).toBe('placed');

    const closing = graphEdges(placed).find((e) => e.from === 'confirming' && e.to === 'placed');
    expect(closing, `the placement must be recorded as an edge. Edges: [${edgePath(placed)}]`).toBeTruthy();
    expect(
      isAuthorizedEdge(PLACE_ITEM, closing!.from, closing!.to),
      'the placement edge must be authorized by the machine',
    ).toBe(true);
    expect(['tool', 'system'], 'the placement must be machine-authored, never inferred from prose')
      .toContain(closing!.by);

    // A terminal state ends the task, and the ending is recorded with its disposition.
    expect(String(placed?.status), 'a terminal state ends the task').toBe('completed');
    const ending = terminalEntries(placed);
    expect(ending.length, 'the task must record its ending').toBeGreaterThan(0);
    expect(String(ending[ending.length - 1].terminal), 'the placed state is a success terminal').toBe('success');
  });

  test('a reply that CHANGES the proposal is not treated as a confirmation', async ({ page }) => {
    test.setTimeout(900_000);

    const wire = await openPlanConversation(page, 'place-item correction');
    const afterProposal = await driveToConfirming(page, wire);
    const proposalsBefore = proposalsOnWire(wire).length;

    // NOT A CONFIRMATION. The person is correcting the proposal: different duration, different
    // position. Nothing about it approves what was proposed.
    const reply = await sendAndWaitForResponse(
      page,
      'Actually, make it 45 minutes and put it BEFORE the kickoff instead, not after.',
      240_000,
    );
    expect(reply.text && reply.text.length, 'the correction must be answered').toBeTruthy();
    const after = await settleAndRead(wire, afterProposal);

    // THE ASSERTION THIS TEST EXISTS FOR. The proposal the person corrected must not be recorded as
    // the one they accepted. `placed` is terminal and marks the task complete, so reaching it here
    // says the item went onto the plan at the time and length they had just asked to change - and
    // the correction they typed has nowhere left to go, because the task that would carry it is
    // closed.
    expect(
      after?.taskState,
      'a correction was applied as if it were a confirmation: the task reached the terminal `placed` '
        + `state on a reply that changed the proposal. Edges: [${edgePath(after)}], status `
        + `${after?.status}. \`confirming\` declares resolvedByOneResponse, and the structural check `
        + 'behind that flag cannot tell "yes" from "no, make it 45 minutes".',
    ).not.toBe('placed');
    expect(
      ['completed', 'cancelled'],
      `a corrected proposal must leave the task open, not closed (status=${after?.status})`,
    ).not.toContain(String(after?.status));

    // AND THE CORRECTION IS CARRIED ON. The person asked for something; the assistant proposing the
    // corrected version is what "handled correctly" looks like from their side, as against silently
    // recording the original.
    const proposalsAfter = proposalsOnWire(wire).length;
    expect(
      proposalsAfter,
      'the correction produced no fresh proposal, so the change the person asked for was never put '
        + `back to them (proposals seen: ${proposalsBefore} before, ${proposalsAfter} after)`,
    ).toBeGreaterThan(proposalsBefore);

    // Whatever the machine did do stays inside the graph.
    expect(isDeclaredState(PLACE_ITEM, after?.taskState), `state '${after?.taskState}' is declared`).toBe(true);
    for (const e of graphEdges(after)) {
      expect(isAuthorizedEdge(PLACE_ITEM, e.from, e.to), `edge ${e.from}->${e.to} is authorized`).toBe(true);
    }
  });

  test('a reply that declines the proposal does not silently complete the task', async ({ page }) => {
    test.setTimeout(900_000);

    const wire = await openPlanConversation(page, 'place-item decline');
    const afterProposal = await driveToConfirming(page, wire);

    const reply = await sendAndWaitForResponse(
      page,
      'Actually, do not add it. Cancel that - we do not need a design review after all.',
      240_000,
    );
    expect(reply.text && reply.text.length, 'the decline must be answered').toBeTruthy();
    const after = await settleAndRead(wire, afterProposal);

    // A DECLINE IS NOT A PLACEMENT. `placed` is the machine's `success` terminal and the host apply
    // never ran, so a declined proposal recorded there is a task claiming it did something nobody
    // approved - and reporting it as a success while it is at it.
    expect(
      after?.taskState,
      'a decline was applied as if it were a confirmation: the task reached the terminal `placed` '
        + `state after the person said not to add the item. Edges: [${edgePath(after)}], status `
        + `${after?.status}`,
    ).not.toBe('placed');
    expect(
      String(after?.status),
      `a declined proposal must not close the task as completed (state=${after?.taskState})`,
    ).not.toBe('completed');
    expect(
      terminalEntries(after).filter((e) => e.terminal === 'success').length,
      'a declined proposal recorded a SUCCESS ending, which is the task reporting work that never happened',
    ).toBe(0);

    // The reply must not tell the person it was added either - the user-visible half of the same claim.
    expect(
      reply.text.toLowerCase(),
      `the assistant said the item was added after the person declined: "${reply.text.slice(0, 200)}"`,
    ).not.toMatch(/\b(added it to|i(?:'ve| have) added|has been added|is now on the plan)\b/);
  });
});
