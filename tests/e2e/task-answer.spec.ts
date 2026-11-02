/**
 * ANSWERING A WORK ITEM IN A SHARED CONVERSATION (ADR-032, ADR-030).
 *
 * THE BEHAVIOR THIS PROTECTS, stated as the person experiences it: an assistant asks them something,
 * they answer in the conversation the way anyone would, and they get an answer back. In a shared room
 * that used to fail silently. Silence-by-default is the right rule - an assistant must not answer
 * chatter it was not part of - and it is exactly what strands a person answering a question they were
 * asked. Their reply reached nobody, the work stayed blocked, and nothing anywhere reported an error.
 *
 * WHY THIS IS ONE TEST AND NOT TWO, though two mechanisms are involved. The composer addresses the
 * answer at send (the client knows the item - it rendered it), and post-processing dispatches the ones
 * that arrive unaddressed anyway, counting each as a client defect. Which of the two carried a given
 * turn is an implementation detail; the guarantee is that the person is answered. So the assertion is
 * on the guarantee. The `Repairs` metric is what says which path did it, and it is the operator's
 * signal rather than the test's.
 *
 * THE SHAPE MATTERS AND IS THE EXPENSIVE PART OF THIS SETUP. It needs a conversation with more than
 * one person in it AND an open item held by the answerer. In a 1:1 Amazon Chime SDK routes every
 * message to the assistant regardless of addressing, so nothing here can fail - which is precisely why
 * the defect survived so long: every single-user test passed.
 *
 * Gated by TASK_ANSWER_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 */
import { test, expect } from './helpers/fixtures';
import { Page, BrowserContext } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { getAdminUser, getSecondPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantResponseCount } from './helpers/drift-backend';
import { personArnFromIdToken, personIdOf } from './helpers/person';
import { channelTasks, readTask, resolveTaskTable } from './helpers/task-backend';
import { addMember, assistantArnIn, assistantNameIn } from './helpers/third-party-view';
import { sendTargetedAs } from './helpers/turn-state-record';
import { exchange, signedCall } from './helpers/admin-api';
import { PERSON_API_URL, ADMIN_API_URL, personUrl, adminUrl } from './helpers/api-urls';

guardBackendErrors('task-answer');
guardConsoleErrors();

const RUN = process.env.TASK_ANSWER_E2E === '1';
const TASKS_API = PERSON_API_URL ? personUrl('/tasks/mine') : '';

/**
 * Every task id in this conversation, open or not, from the source-of-truth table.
 *
 * Snapshotted before a request so the task that request opens is identified by being NEW rather than
 * by being newest: this room already holds an open item from `beforeAll`, and "the most recent row"
 * would pick that one whenever the second write lands a moment late.
 */
function taskIdsIn(agentTable: string, channelArn: string): Set<string> {
  return new Set(channelTasks(agentTable, channelArn).map((t) => String(t.taskId)));
}
const suite = RUN ? test.describe : test.describe.skip;

suite('a task answer in a shared conversation reaches the assistant that asked', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let channelId: string;
  let channelArn: string;

  test.beforeAll(async ({ browser }) => {
    const userA = await getAdminUser();
    // The second member must be PREMIUM: the conversation below is created Premium, and the share
    // gate refuses a member not cleared for Premium with a user-facing message naming both access levels
    // (the exact copy is pinned by classification-context.spec.ts's invite-refusal test). The spec
    // originally shared with the STANDARD user, so its setup was refused by the classification
    // boundary on every live run - the refusal rendered where the success alert was awaited. The
    // test's intent (an unaddressed answer reaches the assistant that asked) needs a second PERSON,
    // not a higher clearance.
    const userB = await getSecondPremiumUser();
    if (!userA?.password) test.skip(true, missingUserReason('testAdmin'));
    if (!userB?.password) test.skip(true, missingUserReason('secondPremiumUser'));

    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();

    await signIn(pageA, userA.email, userA.password);
    await signIn(pageB, userB!.email, userB!.password);

    const createResp = pageA.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(pageA, `Task answer e2e ${Date.now()}`, 'Premium');
    const body = await (await createResp).json();
    channelArn = body.conversation.conversationArn as string;
    channelId = channelArn.split("/").pop()!;
    await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Open a task FIRST, while the conversation is still 1:1. A task-shaped request is answered by an
    // assistant that then asks for what it still needs, which is the state this whole test is about:
    // something is waiting on this person.
    const opening = await sendAndWaitForResponse(
      pageA,
      'Put together a report on our Q2 performance.',
      180_000,
    );
    expect(opening.text && opening.text.length, 'the task-opening turn must be answered').toBeTruthy();

    // NOW make it a group. Sharing after the task exists is deliberate: it reproduces the real
    // sequence (work starts, someone else is brought in) and it means the item is already open when
    // the room becomes one where silence is the default.
    await pageA.locator('button[aria-label="Share conversation"]').click();
    await expect(pageA.locator('#share-email')).toBeVisible({ timeout: 5000 });
    await pageA.locator("#share-email").fill(userB!.email);
    await pageA.locator('form:has(#share-email) button[type="submit"]').click();
    await expect(pageA.locator('.alert-success')).toBeVisible({ timeout: 30000 });
    await pageA.locator('.modal-close-btn').click();
    await expect(pageA.locator('.modal-content')).toBeHidden({ timeout: 5000 });

    // The count badge renders only when the client considers the channel multi-user, so it is the
    // signal that A's composer is now in the regime this test exercises.
    await expect(pageA.locator('.conversation-header-btn-count')).toBeVisible({ timeout: 15000 });
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('an unaddressed answer is answered, and the person is told what it is answering', async () => {
    test.setTimeout(420_000);

    // The queue is polled, so give the client a load to pick the open item up. Without an item in
    // THIS channel the composer has nothing to address and the test would pass for the wrong reason.
    await pageA.goto(`/?conversation=${channelId}`);
    await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 30000 });

    // THE PERSON CHOOSES THE ITEM (ADR-035). The composer never picks one on its own: the item's Answer
    // action selects it, and the composer says what the next message answers. The item travels as an id
    // beside the message, not as `#n` typed into it, so the text box stays the person's own.
    await pageA.locator('.open-work-items-summary').click();
    await pageA.locator('.open-work-items-item', { hasText: /in this conversation/i })
      .first().getByRole('button', { name: /Answer/i }).click();
    const answering = pageA.locator('.message-input-sticky-target', { hasText: /Answering\s*#\d+/i });
    await expect(answering, 'the composer says which item the next message answers').toBeVisible({ timeout: 60000 });
    await expect(pageA.locator('.message-textarea'), 'the Answer action leaves the text box to the person').toHaveValue('');

    // COUNT AS THE ANSWERER, NOT AS THE ADMIN. The composer targets the answer, and the reply
    // inherits the placeholder's Target (async-processor-core: "a targeted reply's tail [stays]
    // private") - so it is visible ONLY to the answerer and the bot. The admin bearer's message list
    // omits it BY DESIGN, which is how this assertion originally failed against a correct product:
    // the DOM showed the reply while the admin-bearer count stayed flat.
    const answererArn = await personArnFromIdToken(
      await idTokenOf(pageA),
    );
    const before = await assistantResponseCount(channelArn, answererArn);
    const beforeBroadcast = await assistantResponseCount(channelArn);

    // THE MESSAGE THE WHOLE DESIGN IS ABOUT: a plain answer, addressed to nobody, in a room with more
    // than one person in it. No @mention, no slash command, no reference typed: the item the Answer
    // action selected travels with it.
    const answer = await sendAndWaitForResponse(
      pageA,
      'The audience is engineering leadership and one page is enough.',
      240_000,
    );

    // THE GUARANTEE. Before this work the turn produced nothing at all - no error, no reply, and a
    // workflow that stayed blocked. Either mechanism satisfies it; the person cannot tell which.
    expect(answer.text && answer.text.length, 'an unaddressed task answer must still be answered').toBeTruthy();
    const after = await assistantResponseCount(channelArn, answererArn);
    expect(after, 'exactly one assistant response for one answer, as the answerer sees it').toBe(before + 1);

    // THE PRIVACY HALF, asserted deliberately rather than tripped over: the reply to a targeted
    // answer must NOT broadcast. A count that moves here means a targeted exchange leaked to members
    // it does not address - the defect, where the flat count is the design.
    // ── ADDRESSING IS NOT PRIVATISING ───────────────────────────────────────
    //
    // This asserted that the count must NOT move - that the reply to a task answer stays private to
    // the answerer. That was true when reaching the assistant and privatising the exchange were one
    // act, and it was changed deliberately because the two are not the same thing. MessageInput.tsx:
    // "answering work the room can SEE made the exchange invisible to the people waiting on it, and
    // the outcome changed under them with no way to know why."
    //
    // So a SHARED item is answered by MENTIONING the assistant - public text, no Chime Target - and
    // the reply is public because the room is waiting on that work. Only a PRIVATE item keeps the
    // target, because it is nobody else's. The task here is shared, so the room must see the reply.
    const afterBroadcast = await assistantResponseCount(channelArn);
    expect(
      afterBroadcast,
      'the reply to a SHARED item reaches the room. The people waiting on this work are entitled to '
        + 'its outcome, and hiding it is the defect the mention-instead-of-target change removed.',
    ).toBe(beforeBroadcast + 1);
  });

  test('a message the person addresses themselves is left alone', async () => {
    test.setTimeout(300_000);

    // The other half of the rule: what someone types always wins. An explicit mention is them naming
    // who they are talking to, and the composer must not override it - nor may post-processing treat
    // an addressed message as one that reached nobody, which would answer it twice.
    await pageA.goto(`/?conversation=${channelId}`);
    await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 30000 });

    // Counted as the SENDER, for the same reason as the first test: a mention is a targeted message,
    // so its reply is targeted too and the admin bearer never sees it.
    const senderArn = await personArnFromIdToken(
      await idTokenOf(pageA),
    );
    const before = await assistantResponseCount(channelArn, senderArn);
    // THE ASSISTANT'S NAME FROM THE LIVE ROSTER: it comes from its profile version and changes at runtime.
    const assistantName = assistantNameIn(channelArn, senderArn);
    expect(assistantName, 'the conversation has an assistant member to address').toBeTruthy();
    const reply = await sendAndWaitForResponse(pageA, `@${assistantName} anything else you need?`, 240_000);
    expect(reply.text && reply.text.length, 'a mentioned assistant answers').toBeTruthy();

    const after = await assistantResponseCount(channelArn, senderArn);
    // ONE. Two would mean the message was both delivered by its mention AND dispatched again as
    // unreached - the failure mode that costs a double model call and advances the chain twice, while
    // looking entirely correct in the transcript.
    expect(after, 'an addressed message is answered once, not twice').toBe(before + 1);
  });

  /**
   * THE OTHER HALF OF ADDRESSING-IS-NOT-PRIVATISING: A PRIVATE ITEM KEEPS ITS PRIVACY.
   *
   * The first test proves a SHARED item's reply reaches the room. This proves the opposite case holds
   * at the layer the room could still read it from: the task record. A targeted request is work the
   * room may learn EXISTS - which assistant it occupies, and that it is open - and may never learn
   * WHAT it is, or whose it is.
   *
   * WHAT IS ALREADY ASSERTED ELSEWHERE, and not repeated: that a targeted request's own words never
   * reach a third party's message list (`turn-queue.spec.ts`, `mentions.spec.ts`), and that a private
   * subject in a split offer carries its requester (`group-split-offer.spec.ts`). Neither reads the
   * task a targeted request opens, which is where three separate fixes landed:
   *
   *   1. the task is recorded as private at all (a targeted request narrows its task);
   *   2. it is attributed to the person who SENT it, which is B here and not A, who owns the room's
   *      other item and created the conversation;
   *   3. the redacted row does not carry the requester's id. The read unlocks a private row's details
   *      for a viewer id equal to the requester, so a redacted row that published that id handed any
   *      reader the key to unstrip it.
   *
   * THE ROOM'S VIEW is the viewerless conversation read, taken through the operator route with a
   * vended credential: `adminListTasks` passes no viewer, which is exactly the form every member who
   * is not the requester or the owning assistant receives from `getOpenTasksForConversation`. THE
   * OWNER'S VIEW is `GET /tasks/mine` with the requester's own token - the only read a person holds,
   * and one that cannot be asked about anyone else.
   */
  test('a targeted request is private work: the room reads that it exists, only its requester reads what it is', async () => {
    test.setTimeout(420_000);

    const agentTable = resolveTaskTable('agent-tasks');
    expect(
      agentTable,
      'the agent-tasks table must resolve (E2E_INSTANCE_NAME, or AGENT_TASKS_TABLE) - the record is where '
        + 'privacy and attribution are decided, and without it a leak and a clean run look identical',
    ).toBeTruthy();
    expect(ADMIN_API_URL, 'VITE_ADMIN_API_URL must be set - the room view is read through a vended credential').toBeTruthy();
    expect(TASKS_API, 'VITE_PERSON_API_URL must be set - the owner view is GET /tasks/mine').toBeTruthy();

    const tokenA = await idTokenOf(pageA);
    const tokenB = await idTokenOf(pageB);
    expect(tokenA && tokenB, 'both members must hold an id token').toBeTruthy();
    const arnA = await personArnFromIdToken(tokenA);
    const arnB = await personArnFromIdToken(tokenB);
    const personB = personIdOf(arnB);
    expect(arnB, 'the requester must be a different person from the conversation\'s creator').not.toBe(arnA);

    // A ROOM OF ITS OWN. The shared conversation above is about a Q2 report, so a request for a report on
    // an unrelated codename there is a change of subject: measured live 2026-09-15, drift detection answered
    // it with an offer to move to a new conversation (score 0.88) and no task opened, which failed this test
    // on its precondition. A new room has no earlier subject to drift from. Two people and the assistant,
    // so it is a group, where a targeted message is private.
    const roomResp = pageA.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(pageA, `Private work e2e ${Date.now()}`, 'Premium');
    const room = ((await (await roomResp).json())?.conversation?.conversationArn || '') as string;
    expect(room, 'the private-work room could not be created').toBeTruthy();
    const roomId = room.split('/').pop()!;
    expect(addMember(room, arnB, arnA), 'the requester must be added to the room').toBe(true);

    // The address, from the MEMBERSHIP. In a group an unaddressed message reaches no assistant, so
    // waiting on a reply to learn where to send would be circular (see `assistantArnIn`).
    const botArn = assistantArnIn(room, arnB);
    expect(botArn, 'the conversation has no assistant member to address').toBeTruthy();

    const before = taskIdsIn(agentTable!, room);
    // A codename, so the absence checks below cannot pass or fail on words the platform uses anyway.
    const secret = `LANTERNFISH${Date.now().toString(36).toUpperCase()}`;
    // Report-shaped, because a report opens a task and then waits on its requester for scope - which
    // keeps it OPEN, and only open work appears in the conversation read.
    sendTargetedAs(
      room,
      arnB,
      botArn,
      `Please put together a report on ${secret} for me: where it came from and where it is used today.`,
    );

    // THE SETTLED STATE, not the first sample: the row is written during the turn.
    let taskId = '';
    for (let i = 0; i < 60 && !taskId; i += 1) {
      taskId = [...taskIdsIn(agentTable!, room)].find((id) => !before.has(id)) || '';
      if (!taskId) await pageB.waitForTimeout(3_000);
    }
    expect(taskId, 'PRECONDITION: the targeted request opened no task, so there is no private work to read').toBeTruthy();
    const row = readTask(agentTable!, taskId, room);
    console.log(`\n--- targeted task ${taskId}\n    visibility=${row?.visibility} userArn=${row?.userArn} ownerPersonId=${row?.ownerPersonId}`);

    // 1. PRIVATE. Only the literal `conversation` makes a task shared (`task-visibility.ts`).
    expect(
      row?.visibility,
      'a TARGETED request opened a task recorded as shared. The room would be told it exists, what kind '
        + 'of work it is and whose it is - the disclosure the targeting was the person\'s way of refusing.',
    ).not.toBe('conversation');

    // 2. ATTRIBUTED TO ITS SENDER.
    expect(
      row?.userArn,
      'the task is attributed to somebody other than the person who sent the request',
    ).toBe(arnB);
    if (row?.ownerPersonId) {
      expect(row.ownerPersonId, 'the task is owned by somebody other than the person who asked for it').toBe(personB);
    }

    // 3. THE ROOM'S VIEW: existence yes, content and identity no.
    const vend = await exchange(tokenA, { identity: 'admin', channelArn: room, capabilities: ['tasks-read'] });
    expect(vend.status, `tasks-read vend: ${JSON.stringify(vend.body).slice(0, 300)}`).toBe(200);
    const roomRead = await signedCall(adminUrl('admin-conversations', `/admin/tasks/channel/${encodeURIComponent(roomId)}`), vend.body.credentials);
    expect(roomRead.status, `conversation task read: ${JSON.stringify(roomRead.body).slice(0, 300)}`).toBe(200);
    // Every service answered, or a missing row below could be a service that did not reply.
    expect(roomRead.body?.servicesAnswered, 'a task service did not answer the conversation read')
      .toBe(roomRead.body?.servicesAsked);
    const roomRows = (roomRead.body?.data ?? []) as Array<Record<string, unknown>>;
    const seen = roomRows.find((t) => t.taskId === taskId);
    console.log(`--- the room's row: ${JSON.stringify(seen)}`);

    expect(
      seen,
      'the room cannot see that the private work EXISTS. Hiding it outright makes the assistant it occupies '
        + 'look idle and lets a /stop report nothing in progress over work that is running.',
    ).toBeTruthy();
    expect(seen!.private, 'the row the room reads is not marked as redacted').toBe(true);
    expect(
      { taskType: seen!.taskType, taskState: seen!.taskState, dueBy: seen!.dueBy },
      'the room read carries what the private work IS',
    ).toEqual({ taskType: undefined, taskState: undefined, dueBy: undefined });
    const flat = JSON.stringify(seen);
    expect(
      flat.includes(personB),
      'the redacted row carries the requester\'s id. That id, passed back as the viewer, is exactly what '
        + 'unlocks the fields this read just stripped - the redaction would hand out its own key.',
    ).toBe(false);
    expect(flat.includes(secret), 'the redacted row carries the request\'s own words').toBe(false);

    // 4. THE OWNER'S VIEW: their own item, readable as theirs. Polled, because the mirror row is written
    //    as the turn settles.
    const mine = async (page: Page): Promise<Array<Record<string, unknown>>> => {
      const token = await idTokenOf(page);
      const body = await page.evaluate(
        async ([url, t]) => {
          const r = await fetch(url as string, { headers: { Authorization: `Bearer ${t}` } });
          return { status: r.status, json: r.ok ? await r.json() : null };
        },
        [TASKS_API, token],
      );
      expect(body.status, `GET /tasks/mine should answer 200 (got ${body.status})`).toBe(200);
      return (body.json?.items ?? []) as Array<Record<string, unknown>>;
    };
    let ownItem: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !ownItem; i += 1) {
      ownItem = (await mine(pageB)).find((it) => it.taskId === taskId);
      if (!ownItem) await pageB.waitForTimeout(6_000);
    }
    console.log(`--- the requester's own item: ${JSON.stringify(ownItem)}`);
    expect(ownItem, 'the requester cannot read their own private request in their open work').toBeTruthy();
    expect(ownItem!.visibility, 'the requester\'s own item does not say it is private').toBe('private');
    expect(String(ownItem!.title || ''), 'the requester\'s own item carries no title to act on').not.toBe('');
    expect(String(ownItem!.taskType || ''), 'the requester\'s own item does not say what kind of work it is').not.toBe('');

    // And the other member's queue does not carry it: ownership is not shared by being in the room.
    expect(
      (await mine(pageA)).some((it) => it.taskId === taskId),
      'another member\'s open work lists a private request that is not theirs',
    ).toBe(false);
  });
});
