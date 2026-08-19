/**
 * ANSWERING A WORK ITEM IN A SHARED CONVERSATION (ADR-032, ADR-030).
 *
 * THE BEHAVIOUR THIS PROTECTS, stated as the person experiences it: an assistant asks them something,
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
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getAdminUser, getSecondPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantResponseCount, userArnFromIdToken } from './helpers/drift-backend';

guardBackendErrors('task-answer');
guardConsoleErrors();

const RUN = process.env.TASK_ANSWER_E2E === '1';
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
    // gate refuses a lower-clearance member with a user-facing message naming both access levels
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
    await pageA.locator('.modal-content button[type="submit"]').click();
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

    // THE AFFORDANCE. A person about to have their message addressed for them must be able to see
    // that, and to opt out - otherwise every remark they make becomes an answer to work they were not
    // talking about. Its absence is a real failure of the design, not a cosmetic one.
    const answering = pageA.locator('.message-input-sticky-target', { hasText: /Answering/i });
    await expect(answering, 'the composer says what the next message answers').toBeVisible({ timeout: 60000 });

    // COUNT AS THE ANSWERER, NOT AS THE ADMIN. The composer targets the answer, and the reply
    // inherits the placeholder's Target (async-processor-core: "a targeted reply's tail [stays]
    // private") - so it is visible ONLY to the answerer and the bot. The admin bearer's message list
    // omits it BY DESIGN, which is how this assertion originally failed against a correct product:
    // the DOM showed the reply while the admin-bearer count stayed flat.
    const answererArn = userArnFromIdToken(
      (await pageA.evaluate(() => localStorage.getItem('idToken')))!,
    );
    const before = await assistantResponseCount(channelArn, answererArn);
    const beforeBroadcast = await assistantResponseCount(channelArn);

    // THE MESSAGE THE WHOLE DESIGN IS ABOUT: a plain answer, addressed to nobody, in a room with more
    // than one person in it. No @mention, no slash command.
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
    const afterBroadcast = await assistantResponseCount(channelArn);
    expect(afterBroadcast, 'the targeted reply is not visible to non-target members').toBe(beforeBroadcast);
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
    const senderArn = userArnFromIdToken(
      (await pageA.evaluate(() => localStorage.getItem('idToken')))!,
    );
    const before = await assistantResponseCount(channelArn, senderArn);
    const reply = await sendAndWaitForResponse(pageA, '@Assistant-premium anything else you need?', 240_000);
    expect(reply.text && reply.text.length, 'a mentioned assistant answers').toBeTruthy();

    const after = await assistantResponseCount(channelArn, senderArn);
    // ONE. Two would mean the message was both delivered by its mention AND dispatched again as
    // unreached - the failure mode that costs a double model call and advances the chain twice, while
    // looking entirely correct in the transcript.
    expect(after, 'an addressed message is answered once, not twice').toBe(before + 1);
  });
});
