/**
 * TWO PEOPLE ASK THE SAME PRIVATE QUESTION AT THE SAME TIME, AND EACH ANSWER REACHES ONLY ITS ASKER.
 *
 * ── WHAT DECIDES WHERE AN ANSWER GOES, WHICH IS NOT THE CONTENT ─────────────────────────────────
 *
 * Delivery is id-based end to end and has been since [ADR-025] and [ADR-037]. A turn posts an
 * acknowledgment carrying `<!--corr:{id}-->`; the channel flow claims `corr#<id> -> MessageId`
 * (`claimPlaceholderMapping`); the processor finds that message by the mapping and updates it; and the
 * answer inherits the acknowledgment's `Target`. A private request now posts a TARGETED
 * acknowledgment (`postAsAssistant`), so the person's own message id, their placeholder and their
 * answer are one chain, and no step of it compares text.
 *
 * ── SO WHY THIS TEST ────────────────────────────────────────────────────────────────────────────
 *
 * Because one step of the turn still reads the channel back by content: `findInboundMessage`, which
 * recovers the inbound `MessageId` when nothing handed it over. It does not decide delivery - it sets
 * the `answers=` label and feeds drift - but ADR-037 rates it plainly: "No, and it can be WRONG rather
 * than merely weaker. A newest-first exact-content match over a bounded window. Repeated identical
 * text binds to the newest."
 *
 * That is the one place where two people saying exactly the same thing could be confused for each
 * other. In the tree it cannot: the matcher skips any candidate whose `Sender.Arn` is not the person
 * whose turn this is, BEFORE comparing content (`inbound-message.ts`), so the residual ambiguity
 * ADR-037 names is within ONE sender rather than across two. Nothing exercised that end to end, and
 * the cost of being wrong is not a mislabelled row - it is one person's private answer delivered to
 * another.
 *
 * This test is the adversarial case the argument rests on: two real identities, byte-identical text,
 * at the same time, asserted from what each member can actually read and from what each browser
 * actually renders.
 *
 * ── WHAT MAKES IT NON-VACUOUS ───────────────────────────────────────────────────────────────────
 *
 * The text is IDENTICAL by construction, codename included. A test that gave each person their own
 * secret would pass against a matcher with NO sender filter at all, because the content would have
 * disambiguated them - which is precisely the thing not being tested.
 *
 * Visibility is read from Amazon Chime SDK as each member (`messageRowsVisibleTo`), because a targeted
 * message is readable only by its sender and its target - so what the service returns for B's bearer
 * IS what B may see. The rendered check that follows is a second question: the service withholding it
 * and the client not showing it are different failures, and a person only experiences the second.
 */
import { test, expect } from './helpers/fixtures';
import { Page, BrowserContext } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getAdminUser, getSecondPremiumUser, missingUserReason } from './helpers/test-credentials';
import { messageRowsVisibleTo } from './helpers/third-party-view';
import { personArnOf } from './helpers/person';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console. This spec
// drives a browser and two real turns, so both apply.
guardBackendErrors('identical-private-messages');
guardConsoleErrors();

/** The assistant answers both; the wait covers two turns running side by side. */
const BOTH_ANSWERED_MS = 120_000;

/**
 * Open a conversation by channel id through the app's deep-link handler, retrying while membership
 * propagates. Mirrors the multi-user pattern in `mentions.spec.ts` and `battle.spec.ts`: titles
 * auto-derive, so the id is the only stable handle, and copying the other browser's URL does not work
 * because the share must reach B's own list before the handler can select it.
 */
async function openConversationById(page: Page, channelId: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(`/?conversation=${channelId}`);
    await page.waitForLoadState('networkidle');
    try {
      await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 10_000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(3_000);
    }
  }
  throw new Error(`openConversationById: channel ${channelId} never became selectable. Last error: ${lastErr}`);
}

/** Address the assistant privately through the picker, then type `text` and send. */
async function askPrivately(page: Page, text: string): Promise<void> {
  await page.locator('.message-textarea').fill('.');
  const privateList = page.locator('.mention-dropdown--private');
  await expect(privateList, 'a dot opens the privacy picker').toBeVisible({ timeout: 5_000 });
  const botOption = privateList.locator('.mention-option', {
    has: page.locator('.mention-option-badge', { hasText: 'BOT' }),
  }).first();
  await expect(botOption).toBeVisible({ timeout: 5_000 });
  await botOption.click();
  // The chip is the person's confirmation that privacy applied BEFORE they commit to sending. Without
  // it the message would go to the room, and every assertion below would be satisfied for the wrong
  // reason - both people seeing everything rather than each seeing only their own.
  await expect(
    page.locator('.message-input-sticky-target-chip--private'),
    'the privacy decoration must appear before the message is sent',
  ).toBeVisible({ timeout: 5_000 });
  await page.locator('.message-textarea').press('End');
  await page.locator('.message-textarea').pressSequentially(text);
  await page.keyboard.press('Enter');
}

test.describe('identical private questions, sent at the same time', () => {
  test('each answer reaches only the person who asked', async ({ browser }) => {
    test.setTimeout(6 * 60_000);

    const userA = await getAdminUser();
    const userB = await getSecondPremiumUser();
    // NOT a silent skip on a missing password: name which credential is absent, as the suite does
    // elsewhere. A skip that says nothing reports an untested claim as a passing one.
    test.skip(!userA.password || !userB?.password, missingUserReason('secondPremiumUser'));
    // Two DISTINCT people is the whole premise: with one identity both sends share a sender and the
    // filter under test is never reached.
    expect(
      userB!.email,
      'secondPremiumUser must differ from testAdmin, or both sends come from one sender',
    ).not.toBe(userA.email);

    const ctxA: BrowserContext = await browser.newContext();
    const ctxB: BrowserContext = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await signIn(pageA, userA.email, userA.password);
      await signIn(pageB, userB!.email, userB!.password);

      // The channel ARN comes from the create response, as the other multi-user spec does: titles
      // auto-derive, so there is no stable title to select by afterwards.
      const title = `E2E identical private ${Date.now().toString(36)}`;
      const createResp = pageA.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await createConversation(pageA, title, 'premium');
      const channelArn = (await (await createResp).json()).conversation.conversationArn as string;
      expect(channelArn, 'the conversation must resolve to a channel ARN').toBeTruthy();
      // NAMED IN THE LOG, so a turn that never answered can be traced in the turn state and the processors.
      console.log(`[identical-private] channel ${channelArn}`);
      await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

      // A shares with B.
      await pageA.locator('button[aria-label="Share conversation"]').click();
      await expect(pageA.locator('#share-email')).toBeVisible({ timeout: 5_000 });
      await pageA.locator('#share-email').fill(userB!.email);
      await pageA.locator('form:has(#share-email) button[type="submit"]').click();
      await expect(pageA.locator('.alert-success')).toBeVisible({ timeout: 30_000 });

      // The share modal does not close itself, and it covers the composer A types into below.
      await pageA.locator('.modal-close-btn').click();
      await expect(pageA.locator('.modal-content')).toBeHidden({ timeout: 5_000 });

      await openConversationById(pageB, channelArn.split('/').pop()!);

      const arnA = await personArnOf(userA);
      const arnB = await personArnOf(userB!);
      expect(arnA && arnB, 'both people must resolve to app-instance users').toBeTruthy();

      // ── ONE QUESTION, TWO CORRECT ANSWERS, AND THEY ARE NOT INTERCHANGEABLE ──────────────────
      //
      // The words are identical for both senders, which is what makes the two messages
      // indistinguishable to anything that compares content. What differs is the ANSWER: each person
      // is asking about themselves, so a reply that reaches the wrong person is wrong ON ITS FACE
      // rather than merely mis-addressed.
      //
      // This is the assertion an id-level check cannot make. Two answers can be delivered to the right
      // mailboxes and still carry the wrong person's context - a turn that resolved the other sender's
      // message would answer about THEM while arriving here. Asking for something unique about the
      // asker is what makes that visible.
      //
      // The codename rides along so the QUESTIONS are findable in a transcript that also contains the
      // answers.
      const shared = `IDENTICALASK${Date.now().toString(36).toUpperCase()}`;
      const question = `${shared}: what is my name and my email address? Answer with both, exactly as you have them.`;

      // What each answer must be about, and must not be about. The local part alone, because the
      // assistant may render an address, a display name or both.
      const localA = userA.email.split('@')[0].toLowerCase();
      const localB = userB!.email.split('@')[0].toLowerCase();
      expect(localA, 'the two identities must be distinguishable by their address').not.toBe(localB);

      // As close to simultaneous as two browsers get. Overlap is what matters, not exact coincidence:
      // both messages must be in the channel, unanswered, while either turn does its content match.
      // What each browser already showed, so the wait below is for a NEW assistant message rather
      // than for the welcome that is on screen before anyone asks anything.
      // Settled BEFORE the snapshot below is taken, not merely present. A share posts a membership
      // notice and a welcome, and those were still arriving when the snapshot was taken at sign-in -
      // so the "one more assistant message" wait was satisfied by the welcome and the assertions ran
      // one second after the questions, against a channel where nobody had answered yet.
      await pageA.waitForTimeout(3_000);
      await pageB.waitForTimeout(3_000);

      const askedAt = Date.now();
      await Promise.all([askPrivately(pageA, question), askPrivately(pageB, question)]);

      await expect(pageA.locator('.user-message')).toHaveCount(1, { timeout: 30_000 });
      await expect(pageB.locator('.user-message')).toHaveCount(1, { timeout: 30_000 });
      // AN ASSISTANT MESSAGE AFTER THIS PERSON'S OWN QUESTION, not one more than a count. A count
      // snapshotted once both questions show raced a fast reply: a drift suggestion answered B in two
      // seconds, was already on B's screen when the count was taken, and the "+1" never came. A count
      // taken before the sends counted the welcome and the membership notice instead.
      // A POSTED message, which carries its id: the thinking indicator shown while a turn runs is also an
      // `.assistant-message`, and matching it let this wait pass before either answer was posted.
      const answeredAfterOwnQuestion = (page: typeof pageA) => page.locator('.user-message').last()
        .locator('xpath=following::*[@data-message-id and contains(concat(" ", normalize-space(@class), " "), " assistant-message ")]');

      // ── WAIT ON THE WEBSOCKET, WHICH IS HOW A PERSON LEARNS THEY WERE ANSWERED ─────────────────
      //
      // The app subscribes to the Amazon Chime SDK message stream and renders from it, so a new
      // `.assistant-message` in the DOM IS the delivery event arriving. Waiting on that rather than
      // re-reading the channel on a timer follows the event path the product actually uses (tenet D6),
      // and it tests one more thing than a service read can: that the client this person is looking at
      // received it.
      //
      // It also removes a defect this wait had: a poll for "can see a bot message" was satisfied by
      // the welcome already on screen, so the assertions below ran against a half-finished channel and
      // reported a missing answer as a delivery failure.
      await Promise.all([
        expect(answeredAfterOwnQuestion(pageA).first(),
          'A must be told they were answered, over the stream their client is subscribed to')
          .toBeVisible({ timeout: BOTH_ANSWERED_MS }),
        expect(answeredAfterOwnQuestion(pageB).first(), 'B must be told they were answered')
          .toBeVisible({ timeout: BOTH_ANSWERED_MS }),
      ]);

      // THE BACKSTOP, not the mechanism (tenet D6's second qualification). The stream said a message
      // arrived; the service is what says who may READ it, and that is the claim under test. One read
      // per person, after the event, rather than a loop.
      const seenByA = messageRowsVisibleTo(channelArn, arnA);
      const seenByB = messageRowsVisibleTo(channelArn, arnB);
      const idsA = new Set(seenByA.map((m) => m.messageId));
      const idsB = new Set(seenByB.map((m) => m.messageId));
      const diag = (rows: typeof seenByA) => rows
        .map((m) => `${m.messageId.slice(0, 8)} upd=${m.lastUpdatedAt || m.createdAt} ${String(m.senderArn.split('/').pop()).slice(0, 8)} ${m.content.slice(0, 40)}`)
        .join('\n      ');
      console.log(`\n--- identical private asks (asked at ${new Date(askedAt).toISOString()}) ---\n  A sees:\n      ${diag(seenByA)}\n  B sees:\n      ${diag(seenByB)}`);


      const answersSeenBy = (arn: string) => messageRowsVisibleTo(channelArn, arn)
        .filter((m) => m.senderArn.includes('/bot/'))
        .filter((m) => Date.parse(m.lastUpdatedAt || m.createdAt) >= askedAt);
      expect(answersSeenBy(arnA).length, 'A must have an answer the service will hand them').toBeGreaterThan(0);
      expect(answersSeenBy(arnB).length, 'B must have an answer the service will hand them').toBeGreaterThan(0);

      // Each person's own send is theirs and invisible to the other. If this fails, privacy never
      // applied and everything below would pass trivially.
      const sendA = seenByA.find((m) => m.content.includes(shared) && !m.senderArn.includes('/bot/'));
      const sendB = seenByB.find((m) => m.content.includes(shared) && !m.senderArn.includes('/bot/'));
      expect(sendA, 'A must see their own private question').toBeTruthy();
      expect(sendB, 'B must see their own private question').toBeTruthy();
      expect(idsB.has(sendA!.messageId), 'B must NOT see the question A sent privately').toBe(false);
      expect(idsA.has(sendB!.messageId), 'A must NOT see the question B sent privately').toBe(false);

      // TWO ANSWERS EXIST, not one shared between them. A single answer visible to both would mean the
      // second turn resolved the first person's message and inherited its `Target`.
      // Only messages that postdate the questions: the welcome is shared by construction and says
      // nothing about whether a private answer was delivered privately.
      const answeredA = seenByA.filter((m) => m.senderArn.includes('/bot/')
        && Date.parse(m.lastUpdatedAt || m.createdAt) >= askedAt);
      const answeredB = seenByB.filter((m) => m.senderArn.includes('/bot/')
        && Date.parse(m.lastUpdatedAt || m.createdAt) >= askedAt);
      const onlyA = answeredA.filter((m) => !idsB.has(m.messageId));
      const onlyB = answeredB.filter((m) => !idsA.has(m.messageId));

      // A bot message answering a private question that BOTH can see is the disclosure this test
      // exists for, so it is named before the per-person claims below rather than surfacing as a
      // confusing count.
      const sharedAnswers = answeredA.filter((m) => idsB.has(m.messageId));
      expect(
        sharedAnswers.map((m) => `${m.messageId.slice(0, 8)} ${m.content.slice(0, 80)}`),
        'no answer posted after two private questions may be visible to both people',
      ).toEqual([]);
      expect(onlyA.length, 'A must have a private answer of their own').toBeGreaterThan(0);
      expect(onlyB.length, 'B must have a private answer of their own').toBeGreaterThan(0);

      // AND NEITHER ANSWER IS THE OTHER'S. This is the disclosure the test exists for: a wrong content
      // match hands one person's answer the other person's `Target`.
      for (const m of onlyA) {
        expect(idsB.has(m.messageId), `B must not see A's private answer (${m.messageId.slice(0, 8)})`).toBe(false);
      }
      for (const m of onlyB) {
        expect(idsA.has(m.messageId), `A must not see B's private answer (${m.messageId.slice(0, 8)})`).toBe(false);
      }

      // ── AND EACH ANSWER IS ABOUT THE PERSON IT REACHED ──────────────────────────────────────────
      //
      // The safety-critical half is the NEGATIVE: A's answer must not be about B. That holds whatever
      // the assistant knew, including when it declined to answer, so it is asserted unconditionally.
      const answerTextA = onlyA.map((m) => m.content.toLowerCase()).join(' ');
      const answerTextB = onlyB.map((m) => m.content.toLowerCase()).join(' ');
      expect(
        answerTextA.includes(localB),
        "A's private answer must not contain B's identity: a turn that resolved B's message would answer about B",
      ).toBe(false);
      expect(
        answerTextB.includes(localA),
        "B's private answer must not contain A's identity",
      ).toBe(false);

      // The POSITIVE half only when the assistant actually answered the question. If it knew neither
      // identity both replies are equally uninformative, the negative above is vacuously true, and
      // saying so is better than reporting a pass the run did not earn.
      const namedA = answerTextA.includes(localA);
      const namedB = answerTextB.includes(localB);
      if (namedA && namedB) {
        console.log('--- each answer names its own asker: the cross-delivery check is decisive');
      } else {
        console.log(
          `--- the assistant did not identify ${!namedA ? 'A' : ''}${!namedA && !namedB ? ' or ' : ''}${!namedB ? 'B' : ''};`
          + ' the no-cross-contamination assertions above still hold, but this run does not prove'
          + ' personalization reached the right person',
        );
      }

      // ── AND WHAT EACH BROWSER ACTUALLY RENDERS ────────────────────────────────────────────────
      //
      // The service withholding a message and the client not showing it are different failures, and a
      // person only ever experiences the second.
      const renderedTexts = async (pg: Page): Promise<string[]> =>
        (await pg.locator('.message-content').allTextContents()).map((t) => t.trim().toLowerCase());
      const shownA = await renderedTexts(pageA);
      const shownB = await renderedTexts(pageB);

      // Each page shows exactly ONE copy of the shared question: their own.
      expect(
        shownA.filter((t) => t.includes(shared.toLowerCase())).length,
        "A must render their own question once, not B's as well",
      ).toBe(1);
      expect(
        shownB.filter((t) => t.includes(shared.toLowerCase())).length,
        "B must render their own question once, not A's as well",
      ).toBe(1);

      // And neither browser renders the other person's ANSWER.
      //
      // Scoped to the answers rather than the whole transcript: the room legitimately learns who
      // joined it, and the share posts a membership notice naming the new member. Asserting that A's
      // transcript never mentions B was a claim about MEMBERSHIP, not about privacy, and it failed on
      // a working product for that reason.
      // BY MESSAGE ID, not by text: two identical questions get identical answers (a drift suggestion
      // answered both word for word), so B's own answer contains A's text and a text match reported a
      // leak that was B reading their own message.
      const renderedIds = async (page: typeof pageA) => page.locator('[data-message-id]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id') || ''));
      const idsShownA = new Set(await renderedIds(pageA));
      const idsShownB = new Set(await renderedIds(pageB));
      for (const m of onlyA) expect(idsShownB.has(m.messageId), "B must not render A's private answer").toBe(false);
      for (const m of onlyB) expect(idsShownA.has(m.messageId), "A must not render B's private answer").toBe(false);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
