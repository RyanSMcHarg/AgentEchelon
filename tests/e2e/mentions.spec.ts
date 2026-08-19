import { test, expect, Page, BrowserContext } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getAdminUser, getBasicUser, getStandardUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantResponseCount, botMessagesForDiagnosis, assertNotAnErrorReply } from './helpers/drift-backend';
import { signedAnalyticsPost } from './helpers/signed-analytics';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardBackendErrors('mentions');
guardConsoleErrors();


// Multi-user coverage for the new CHIME.mentions routing + sticky-mention UX.
//
// Setup: User A (basic) creates a conversation, shares it with User B (standard
// — must satisfy the share-conversation tier check). Once B is added, the
// channel becomes multi-user, which is the regime where the new behavior
// matters.
//
// Asserts:
//   - `@assistant <q>` from A produces a bot reply targeted to A. Only A sees
//     A's user message AND the bot reply (Target restricts visibility); B's
//     DOM stays unchanged. The sticky chip auto-sets on A.
//   - `@all <q>` from A produces a broadcast bot reply both A and B see.
//
// Single-user channels can't exercise this — Lex broadcasts replies in 1:1, so
// `targetedToUser` is always false and the chip never sets.

/**
 * Open a conversation by its channel id (the last segment of the channel
 * ARN), deterministically — via the app's deep-link handler
 * (`/?conversation=<id>` → App.tsx matches `conversationArn.endsWith(id)`).
 * Replaces the old `button.conversation-item).first()` guesswork, which
 * silently selected whatever channel happened to sort to the top. Titles
 * auto-derive from the first user message (commit 8377f1c), so these test
 * channels render as the generic "New conversation" and CANNOT be pinned by
 * title — the id is the only stable handle.
 */
async function openConversationById(page: Page, channelId: string) {
  // The app fetches conversations once per load, so a just-shared channel may
  // be absent from this client's first fetch (membership propagation). Each
  // goto forces a fresh fetch; retry until the channel appears and the
  // deep-link handler selects it (the textarea only enables when a
  // conversation is actually open, so it gates on a successful selection).
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(`/?conversation=${channelId}`);
    await page.waitForLoadState('networkidle');
    try {
      await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 10000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(3000);
    }
  }
  throw new Error(
    `openConversationById: channel ${channelId} never became selectable after 5 attempts. ` +
      `Last error: ${lastErr}`,
  );
}

test.describe.serial('Mentions — Multi-User', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let conversationTitle: string;
  // The shared channel's id (last ARN segment), captured from the
  // create-conversation API response so both clients select THIS channel
  // by id rather than by list position.
  let channelId: string;
  let channelArn: string;

  test.beforeAll(async ({ browser }) => {
    const userA = await getBasicUser();
    const userB = await getStandardUser();
    // Two users, so name whichever is missing rather than reporting a generic gate.
    test.skip(
      !userA.password || !userB.password,
      !userA.password ? missingUserReason('basicUser') : missingUserReason('standardUser'),
    );

    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();

    await signIn(pageA, userA.email, userA.password);
    await signIn(pageB, userB.email, userB.password);

    conversationTitle = `E2E Multi ${Date.now()}`;
    // Capture the channel id from the create-conversation API response so we
    // can re-select THIS exact channel by id later (titles auto-derive, so
    // there's no stable title to match on).
    const createRespPromise = pageA.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(pageA, conversationTitle, 'Claude Haiku');
    const createBody = await (await createRespPromise).json();
    channelArn = createBody.conversation.conversationArn as string;
    channelId = channelArn.split('/').pop()!;
    console.log(`Shared channel id: ${channelId}`);
    await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // A shares the conversation with B.
    await pageA.locator('button[aria-label="Share conversation"]').click();
    await expect(pageA.locator('#share-email')).toBeVisible({ timeout: 5000 });
    await pageA.locator('#share-email').fill(userB.email);
    await pageA.locator('.modal-content button[type="submit"]').click();
    await expect(pageA.locator('.alert-success')).toBeVisible({ timeout: 30000 });

    // Confirm A's UI flipped to multi-user.
    //
    // The count badge ON the roster toggle is the multi-user signal: it renders only when
    // `isMultiUser`. This used to assert `.conversation-header-members-chip`, a separate element that
    // `6a55eb6` DELETED when it collapsed two identical people-icons into one control — so the
    // assertion had become unsatisfiable and the test failed on a working share. Same class as the
    // drift spec that kept reading `priorMessage` from Metadata after it moved: the product changed
    // and the test did not move with it.
    await expect(pageA.locator('.conversation-header-btn-count')).toBeVisible({ timeout: 15000 });

    // Close the share modal — it doesn't auto-close on success.
    await pageA.locator('.modal-close-btn').click();
    await expect(pageA.locator('.modal-content')).toBeHidden({ timeout: 5000 });

    // Open the just-shared channel on B by id (deep-link), not by list
    // position. B must already be a member (the share above added them), so
    // the channel is in B's list and the deep-link handler can match it.
    await openConversationById(pageB, channelId);
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('@<bot> produces a targeted reply visible only to A; sticky chip set on A', async () => {
    // Stabilise B's view BEFORE capturing the baseline. The beforeAll
    // step opens B's conversation and waits for the textarea to enable,
    // but channel-history messages can still be streaming in for a few
    // seconds after that (Chime list-messages + WebSocket prefetch).
    // Without this wait, beforeB captures a premature 0 and the
    // afterB-vs-beforeB delta absorbs whatever history loaded during
    // the test body — a false signal of "B saw new messages."
    await pageB.waitForLoadState('networkidle');
    await pageB.waitForTimeout(3000);

    const beforeA = await pageA.locator('.message').count();
    const beforeB = await pageB.locator('.message').count();
    console.log(`\n--- multi-user @<bot> ---`);
    console.log(`Before: A=${beforeA} messages, B=${beforeB} messages`);

    // Find the channel's bot by its actual displayed Name (could be Aria,
    // Atlas, Echo — whatever the AppInstanceBot was created with). The
    // mention dropdown labels bot members with a BOT badge, so we type
    // `@` to trigger it, pick the first BOT-badged option, and let the
    // app insert `@<botName>` for us. Keeps the test independent of any
    // single bot's display name and aligns with how a user would
    // actually mention it.
    await pageA.locator('.message-textarea').fill('@');
    const botOption = pageA.locator('.mention-option', {
      has: pageA.locator('.mention-option-badge', { hasText: 'BOT' }),
    }).first();
    await expect(botOption).toBeVisible({ timeout: 5000 });
    const botMentionLabel = (await botOption.locator('.mention-option-name').textContent())?.trim();
    console.log(`Bot mention resolved to: ${botMentionLabel}`);
    await botOption.click();
    // Append the actual question after the inserted @<bot> mention.
    await pageA.locator('.message-textarea').press('End');
    await pageA.locator('.message-textarea').pressSequentially(' what is 2+2?');
    await pageA.keyboard.press('Enter');

    // A should see both their message and the bot reply (count grows by ≥2).
    await expect(async () => {
      const countA = await pageA.locator('.message').count();
      expect(countA).toBeGreaterThanOrEqual(beforeA + 2);
    }).toPass({ timeout: 60000 });

    const afterA = await pageA.locator('.message').count();
    console.log(`After @assistant: A=${afterA} (expected ≥${beforeA + 2})`);

    // Sticky chip auto-sets on A from the bot's targeted reply.
    await expect(pageA.locator('.message-input-sticky-target'))
      .toBeVisible({ timeout: 10000 });

    // Privacy: a targeted message TO the bot results in a targeted reply
    // FROM the bot back to the sender (TargetedMessages: ALL on the bot's
    // Lex config). Neither A's outgoing @<bot> question (Target=[bot])
    // nor the bot's reply (Target=[sender]) should be visible to B.
    // Give B a generous window to (incorrectly) receive anything, then
    // assert the message count did not grow.
    await pageB.waitForTimeout(8000);
    const afterB = await pageB.locator('.message').count();
    console.log(`After wait: B=${afterB} (expected ${beforeB})`);
    expect(afterB).toBe(beforeB);
  });

  test('@all produces a broadcast reply both A and B see', async () => {
    const beforeA = await pageA.locator('.message').count();
    const beforeB = await pageB.locator('.message').count();
    // Backend truth, read through the Chime API rather than either browser. The DOM counts below are
    // about VISIBILITY (both members see the broadcast); this is about how many assistant messages
    // the channel actually gained, which is the property the flow bypass owns.
    const botsBefore = await assistantResponseCount(channelArn);
    const renderedBeforeA = await pageA.locator('.message.assistant-message:not(.continuation)').count();
    const renderedBeforeB = await pageB.locator('.message.assistant-message:not(.continuation)').count();
    console.log(`\n--- multi-user @all ---`);
    console.log(`Before: A=${beforeA}, B=${beforeB}, bot messages=${botsBefore}`);

    // Clear any sticky from the previous test so the input doesn't auto-prepend.
    const stickyClear = pageA.locator('.message-input-sticky-target-clear');
    if (await stickyClear.isVisible({ timeout: 1000 }).catch(() => false)) {
      await stickyClear.click();
    }

    await pageA.locator('.message-textarea').fill('@all share one fun fact about the moon');
    await pageA.keyboard.press('Enter');

    // Wait for the bot's response to land in Chime + propagate to both clients.
    // Re-open both pages on THIS channel (by id) so the assertion is against
    // persisted history, not live WebSocket state (which can drop over
    // multi-test sessions). Selecting by id — not list position — guarantees
    // both clients are looking at the channel the @all was sent to.
    await pageA.waitForTimeout(20000);
    await openConversationById(pageA, channelId);
    await openConversationById(pageB, channelId);

    await expect(async () => {
      const countA = await pageA.locator('.message').count();
      const countB = await pageB.locator('.message').count();
      expect(countA).toBeGreaterThanOrEqual(beforeA + 2);
      expect(countB).toBeGreaterThanOrEqual(beforeB + 2);
    }).toPass({ timeout: 30000 });

    const afterA = await pageA.locator('.message').count();
    const afterB = await pageB.locator('.message').count();
    console.log(`After @all (post-reload): A=${afterA}, B=${afterB}`);

    // EXACTLY ONE assistant RESPONSE for one @all.
    //
    // The DOM assertions above are lower bounds (`>= before + 2`) because they prove VISIBILITY, and a
    // lower bound cannot fail on a duplicate - two replies satisfy it as comfortably as one. That left
    // the property the channel-flow bypass actually owns untested: it posts ONE placeholder, dispatches
    // ONE processor invocation keyed on the stable inbound MessageId (so a redelivery collapses on the
    // processor's claim), and the answer arrives as an UpdateChannelMessage REUSING that placeholder's
    // id.
    //
    // RESPONSE, NOT MESSAGE. A long reply is split at the Chime content cap and its tail sent as
    // consecutive continuation messages, so a message count would report a duplicate for a reply that
    // was merely long. `assistantResponseCount` excludes continuations, matching how the client groups
    // them.
    //
    // The wait matters. A duplicate arrives AFTER the winner, so counting the moment the first answer
    // renders would miss precisely the defect this guards.
    await pageA.waitForTimeout(15000);
    const botsAfter = await assistantResponseCount(channelArn);
    const gained = botsAfter - botsBefore;
    console.log(`@all assistant responses: ${botsBefore} -> ${botsAfter} (gained ${gained})`);
    expect(gained, 'one @all produced exactly one assistant response, not a duplicate').toBe(1);

    // And in the DOM, for both members - the reply is a broadcast, so each client should render one
    // more response than before, not two.
    //
    // A DELTA, not an absolute comparison against the channel count. Those two are NOT the same
    // quantity here: the preceding test in this serial block sent `@<bot>`, whose reply is
    // Target-addressed to A, and a targeted message is visible to A while not being returned by the
    // admin bearer's channel read. Comparing A's absolute DOM count to the admin count therefore
    // failed 4 vs 3 on a correct run - a real difference between two different questions, not a
    // duplicate. Measuring what each side GAINED over this turn compares like with like.
    for (const [label, pg, before] of [['A', pageA, renderedBeforeA], ['B', pageB, renderedBeforeB]] as const) {
      const rendered = await pg.locator('.message.assistant-message:not(.continuation)').count();
      console.log(`@all rendered assistant responses on ${label}: ${before} -> ${rendered}`);
      expect(rendered - before, `${label} rendered exactly one new assistant response`).toBe(1);
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// THE ACCEPTANCE TEST FOR THE `@all` HANDOFF (tracker row 46, MESSAGE-FLOW §3.1).
//
// Every test above passes whether or not the handoff landed, because they all ask "did `@all`
// answer?" - and it answered before the handoff too. That is exactly the failure mode §3.1 exists to
// prevent: a bypass that re-implements the turn still ANSWERS, so nothing errors and no test fails
// while classification, profile config and experiment attribution quietly diverge.
//
// This asks what the turn was CLASSIFIED as. Before the handoff the flow dispatched the processor
// with a hardcoded `intent: 'general'` and never called a classifier at all, so an `@all` phrased
// squarely as `data_extraction` archived as `general`. After it, the router classifies an `@all`
// exactly as it classifies an ordinary turn.
//
// WHY A 1:1, AND WHY STANDARD - both deliberate, and both were learned the hard way:
//   - STANDARD, because `agent-intents.spec.ts` establishes that this phrasing reaches
//     `data_extraction` on a standard profile. The first version of this test ran on the multi-user
//     block's BASIC channel and the classifier returned `general` for the same prompt. That may be a
//     real basic-profile finding, but it is a DIFFERENT question, and asserting it here would make
//     this test report "the handoff did not land" for a reason that has nothing to do with the
//     handoff.
//   - A 1:1, because that is the channel size where BOTH entries see the turn: `StandardMessages:
//     AUTO` routes every message to Lex regardless of mentions, so the router's `@all` guard has to
//     silence the LEX entry while letting the FLOW entry through. Get that pairing wrong and the turn
//     is either answered twice or not at all - so the response count below is not incidental, it is
//     the other half of the invariant.
test.describe('the @all handoff: a bypass turn is classified like any other', () => {
  guardBackendErrors('mentions-all-classification');

  test('an @all turn is CLASSIFIED, not hardcoded to general', async ({ page, browser }) => {
    test.setTimeout(420_000);
    const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || process.env.ANALYTICS_API_URL || '';
    const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || '';
    test.skip(!ANALYTICS_API, 'Needs VITE_ANALYTICS_API_URL (gen-frontend-env writes it).');
    test.skip(!ADMIN_BASE_URL, 'Needs E2E_ADMIN_BASE_URL - the archive read is admin-plane.');

    const user = await getStandardUser();
    const admin = await getAdminUser();
    test.skip(!user.password, missingUserReason('standardUser'));
    test.skip(!admin.password, missingUserReason('testAdmin'));

    // The analytics API is ADMIN-PLANE: read as the chat user it returns an authorization error with
    // no `data` key, which must never be coerced into "count 0" (agent-intents.spec.ts records where
    // exactly that turned an auth failure into a false classifier failure).
    const adminCtx = await browser.newContext({ baseURL: ADMIN_BASE_URL });
    const adminPage = await adminCtx.newPage();
    let idToken = '';
    try {
      await signIn(adminPage, admin.email, admin.password);
      idToken = (await adminPage.evaluate(() => localStorage.getItem('idToken'))) || '';
      expect(idToken, 'admin idToken for the analytics read').toBeTruthy();
    } finally {
      await adminCtx.close();
    }

    const intentCount = async (key: string): Promise<number> => {
      const end = new Date();
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
        queryType: 'intent_distribution',
        dateRange: { start: new Date(end.getTime() - 86_400_000).toISOString(), end: end.toISOString() },
      });
      if (!Array.isArray(j?.data)) {
        throw new Error(
          `intent_distribution did not return a result set. This is an API/authorization failure, NOT `
          + `an empty archive - do not read it as "the @all was never classified". Response: `
          + `${JSON.stringify(j).slice(0, 400)}`,
        );
      }
      const row = j.data.find((r: any) => String(r.intent) === key);
      return row ? Number(row.count) : 0;
    };

    const before = await intentCount('data_extraction');
    console.log(`[@all intent] data_extraction before: ${before}`);

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    // Capture the channel ARN from the create response, the same way the block above does - it is the
    // only stable handle, and the response-count assertion at the end needs it.
    const createRespPromise = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `E2E All Intent ${Date.now()}`, 'Claude Sonnet');
    const channelArn = (await (await createRespPromise).json()).conversation.conversationArn as string;
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const botsBefore = channelArn ? await assistantResponseCount(channelArn) : 0;

    // Phrased to sit squarely inside the pack's data_extraction description (STRUCTURED / BULK), not
    // the single-fact GENERAL case ADR-018 carves out - so `general` is a real failure here rather
    // than a defensible classification.
    await page.locator('.message-textarea')
      .fill('@all extract the full employee roster as a table with name, role and team');
    await page.keyboard.press('Enter');

    // Kinesis -> archival -> Aurora buffering routinely exceeds a minute (see tasks.spec.ts).
    let after = before;
    for (let i = 0; i < 30 && after <= before; i += 1) {
      await page.waitForTimeout(8000);
      after = await intentCount('data_extraction');
    }
    console.log(`[@all intent] data_extraction after: ${after}`);

    expect(
      after,
      'the archive recorded no data_extraction exchange for an @all phrased squarely as one. The '
      + 'reply itself was probably fine, which is the whole point: if the flow is still running the '
      + 'turn it dispatches with a hardcoded intent, so the classifier never ran, the profile\'s '
      + 'classifierMode was ignored, and any classifier experiment is silently missing this population.',
    ).toBeGreaterThan(before);

    // NO RESPONSE-COUNT ASSERTION HERE, deliberately. `data_extraction` carries
    // `delivery: 'TASK_MULTI_STEP'` in the intent pack, so a correctly-classified turn posts a task
    // placeholder AND step updates - `assistantResponseCount` counts every non-continuation bot
    // message, so the healthy number is several, not one. The first version of this test asserted
    // `=== 1` here and went red at 3 on a turn that had done exactly the right thing. Counting
    // responders needs an intent whose delivery is a single reply; that is the next test.
    console.log(`[@all intent] assistant messages: ${botsBefore} -> ${await assistantResponseCount(channelArn)}`);
  });

  // The OTHER half of "one responder", and the case that only exists in a 1:1.
  //
  // `StandardMessages: AUTO` routes every message to Lex regardless of mentions, so in a 1:1 BOTH
  // entries see an `@all`: the channel flow (which hands off to the router) and Lex (which invokes the
  // router directly). Exactly one of them may run the turn - the router's `@all` guard silences the
  // LEX entry and lets the FLOW entry through. Get that pairing wrong and the turn is answered twice
  // or not at all, and the handoff moved the guard, so it is worth pinning after the move.
  //
  // A GENERAL prompt on purpose: its delivery is PLACEHOLDER_UPDATE, one reply updated in place, so
  // the response count means "how many responders" rather than "how many task steps".
  test('a 1:1 @all is answered exactly once, by one entry', async ({ page }) => {
    test.setTimeout(300_000);
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const createRespPromise = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `E2E All Once ${Date.now()}`, 'Claude Sonnet');
    const channelArn = (await (await createRespPromise).json()).conversation.conversationArn as string;
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // SETTLE THE WELCOME FIRST. A fresh conversation gets an assistant welcome, and it lands
    // asynchronously - capturing the baseline before it arrives counts the welcome as part of this
    // turn's answer and reports a duplicate that never happened.
    await expect(async () => {
      expect(await assistantResponseCount(channelArn)).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 90_000 });
    await page.waitForTimeout(5000);
    const botsBefore = await assistantResponseCount(channelArn);
    console.log(`[1:1 @all] baseline assistant messages (welcome settled): ${botsBefore}`);

    await page.locator('.message-textarea').fill('@all share one fun fact about the moon');
    await page.keyboard.press('Enter');

    // Wait for the answer, then keep waiting: a DUPLICATE arrives AFTER the winner, so asserting the
    // moment the first reply lands is precisely when a second responder is still invisible.
    await expect(async () => {
      expect(await assistantResponseCount(channelArn)).toBeGreaterThan(botsBefore);
    }).toPass({ timeout: 120_000 });
    await page.waitForTimeout(20000);

    const messages = await botMessagesForDiagnosis(channelArn);
    for (const m of messages) {
      console.log(`[1:1 @all] bot message: len=${m.length} ${JSON.stringify(m.slice(0, 120))}`);
    }

    // COUNT MESSAGES THAT SAY SOMETHING, not bot messages.
    //
    // Amazon Chime SDK materialises a message even from a Lex fulfillment that returned an EMPTY
    // `Messages` array (verified 2026-08-06, ADR-022). So a raw bot-message count used to read 2 on a
    // perfectly healthy 1:1 `@all` - one silent envelope, one real answer - and asserting on it
    // reported a duplicate that did not exist.
    //
    // THE FILTER IS KEPT EVEN THOUGH THE FLOW NOW DROPS THOSE ENVELOPES (`lib/lex-envelope.ts`), for
    // two reasons: a channel whose history predates that change still holds them, and the filter must
    // not be what fails if an envelope ever reaches the channel again. It is tolerance, never evidence -
    // nothing below requires an envelope to be present.
    const isSilentEnvelope = (c: string): boolean => {
      try {
        const j = JSON.parse(c);
        return Array.isArray(j?.Messages) && j.Messages.length === 0;
      } catch {
        return false;
      }
    };
    const answers = messages.filter((c) => !isSilentEnvelope(c));

    // COUNTING CANNOT SEE A FAILED TURN. `handleProcessingError` UPDATES the placeholder with an
    // apology, so an errored turn produces exactly one non-empty bot message and satisfies every
    // assertion below. Check what the assistant actually SAID before trusting the count.
    for (const a of answers) assertNotAnErrorReply(a, "1:1 @all reply");
    console.log(`[1:1 @all] bot messages ${messages.length}, of which real answers ${answers.length}`);

    expect(
      answers.length - botsBefore,
      'exactly one ANSWER for one @all in a 1:1. Two means BOTH entries ran the turn (the router\'s '
      + '@all guard is not silencing the Lex entry); zero means neither did (the guard is silencing '
      + 'the flow entry too, or the flow is not associated to the channel).',
    ).toBe(1);

    // AND NO PLACEHOLDER WAS LEFT BEHIND, which is the other half of "one responder" and is the thing
    // a count of answers cannot see.
    //
    // THIS REPLACED AN ASSERTION ON THE EMPTY LEX ENVELOPE, and the reason is worth keeping. That one
    // required the envelope to EXIST as positive evidence the router had stood down - true while `@all`
    // took the flow bypass at every channel size. In a 1:1 the flow now stands aside and the Lex entry
    // ANSWERS, so there is no envelope to find and the old assertion failed on a working fix.
    //
    // The replacement asserts the OUTCOME rather than which component stood down: after the turn
    // settles, no bot message may still carry a `<!--corr:-->` marker. A marker surviving means a
    // placeholder nobody answered onto - exactly the defect measured on 2026-08-12 (two placeholders
    // 558ms apart, one stuck at "One moment..." forever). That property holds whichever entry answers,
    // so it does not need rewriting the next time the responder rule changes.
    const stranded = messages.filter((c) => {
      let t = c;
      try { t = decodeURIComponent(c); } catch { /* raw form is still tested */ }
      return t.includes('<!--corr:');
    });
    expect(
      stranded,
      'a bot message still carries a corr marker after the turn settled, i.e. a placeholder was posted '
      + 'and never answered onto. Two entries both posted one, or the answer landed on a different message.',
    ).toEqual([]);
  });

  // THE 1:1 @all KEEPS ITS ATTACHMENT. In a 1:1 the flow stands aside for @all and the Lex entry
  // answers - but the attachment rides the message Metadata, which Lex never passes, and the flow's
  // stand-aside used to return before reading it. So "@all summarize this" with a file answered on
  // the caption alone, with no error anywhere: the reply was fluent, every count above was
  // satisfied, and the document was simply never read. The router now recovers the attachment by
  // reading the stored message back on the fall-through, and this asserts the recovered file
  // actually reaches the model: the answer must contain a fact that exists ONLY inside the document.
  test('a 1:1 @all with an attachment answers from the document, not the caption', async ({ page }) => {
    test.setTimeout(300_000);
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const createRespPromise = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `E2E All Attach ${Date.now()}`, 'Claude Sonnet');
    const channelArn = (await (await createRespPromise).json()).conversation.conversationArn as string;
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Settle the welcome, as the test above does, so the baseline is stable.
    await expect(async () => {
      expect(await assistantResponseCount(channelArn)).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 90_000 });
    const botsBefore = await assistantResponseCount(channelArn);

    // The fact lives ONLY in the file. A nonce, so a caption-only answer cannot luck into it and a
    // grounded answer cannot avoid it.
    const codename = `ZORBLEFAX-${Date.now().toString(36).toUpperCase()}`;
    await page.locator('.file-input-hidden').setInputFiles({
      name: 'project-brief.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        `Project brief.\n\nThe internal codename for this initiative is ${codename}.\n`
        + 'Scope: a short pilot, one team, one quarter. Nothing else in this brief matters.\n',
      ),
    });

    await page.locator('.message-textarea')
      .fill('@all what is the internal codename stated in the attached document? Reply with the codename.');
    await page.keyboard.press('Enter');

    await expect(async () => {
      expect(await assistantResponseCount(channelArn)).toBeGreaterThan(botsBefore);
    }).toPass({ timeout: 180_000 });
    // POLL for the codename rather than sampling once after the first reply. The question may
    // classify as data_extraction (it is one, if a small one), whose delivery is a multi-step task
    // chain - the grounded answer then lands a message or two AFTER the first reply, and a single
    // read taken then reported 'not answered from the document' about a chain that was still
    // answering. The codename survives percent-encoding verbatim (A-Z, digits, hyphen), so the raw
    // stored content is searchable either way.
    await expect
      .poll(async () => (await botMessagesForDiagnosis(channelArn)).some((m) => m.includes(codename)), {
        timeout: 180_000,
        message:
          'no assistant message contains the codename that exists only inside the attached document. '
          + 'The reply was probably fluent - that is the failure mode: the attachment rides Metadata, '
          + 'Lex never passes it, and a fall-through that does not recover it answers on the caption '
          + 'alone with nothing erroring.',
      })
      .toBe(true);
    for (const m of (await botMessagesForDiagnosis(channelArn)).slice(-3)) {
      console.log(`[1:1 @all attach] bot message: ${JSON.stringify(m.slice(0, 160))}`);
    }
  });
});
