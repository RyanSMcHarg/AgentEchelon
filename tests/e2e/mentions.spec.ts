import { test, expect } from './helpers/fixtures';
import { Page, BrowserContext } from '@playwright/test';
import { signIn, createConversation, idTokenOf } from './helpers/agent-helpers';
import { getAdminUser, getBasicUser, getStandardUser, getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantResponseCount, botMessagesForDiagnosis, assertNotAnErrorReply } from './helpers/drift-backend';
import { signedAnalyticsPost } from './helpers/signed-analytics';
// WHAT THE ROOM CAN SEE, read from the service rather than from a browser. A privacy assertion made
// against B's DOM cannot tell "B is not allowed to see it" from "B's socket dropped".
import { messagesVisibleTo } from './helpers/third-party-view';
import { personArnOf } from './helpers/person';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

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
// Asserts (ADR-034 — addressing a message and making it private are two acts):
//   - `@<bot> <q>` from A is PUBLIC. Both A and B see the question and the reply.
//   - `@<person>` from A addresses a colleague and starts NO assistant turn.
//   - `.<bot> <q>` from A is PRIVATE. B cannot see it, checked server-side.
//   - `.env is missing` is ordinary text, not an address, and B sees it.
//   - `@all <q>` from A produces a broadcast bot reply both A and B see.
//
// ── WHAT CHANGED HERE, AND WHY THE OLD ASSERTION WAS THE OPPOSITE ──
//
// The first test used to read "@<bot> produces a targeted reply visible only to A" and asserted
// `B's message count did not grow`. That was the old contract, and it is exactly what ADR-034
// declared it was breaking: an `@` mention set an Amazon Chime SDK `Target`, so naming the assistant
// also hid the exchange from the rest of the room. People watched a colleague type a question to the
// assistant and saw no answer.
//
// `@` now sets no `Target` and the channel flow routes it, so the question and the answer are both
// readable by everyone. The dot is what makes a message private. This file is where that break is
// observable end to end, which is why the inversion belongs here rather than in a unit test.
//
// Single-user channels can't exercise any of it: in a 1:1 Chime's AUTO trigger routes every message
// regardless of addressing, so there is no room to be excluded from.

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

/**
 * Drop the sticky mention chip before a test that types its own address.
 *
 * The composer prepends the sticky target to a message that does not start with one, so a chip left
 * by a previous test in this serial block would silently turn "@Dana ..." into "@Assistant @Dana ..."
 * - and a test asserting that no assistant answered would then fail for a reason that has nothing to
 * do with what it is testing.
 */
/**
 * Leave both views on persisted history and STOPPED GROWING, before the next test in this serial
 * block takes its baseline.
 *
 * MEASURED, not guessed. Channel history keeps streaming in for seconds after the textarea enables,
 * so a baseline captured mid-stream is too low and the NEXT test's delta silently absorbs THIS test's
 * messages - which is exactly how the `@all` test came to report "the room gained 1 message" for a
 * broadcast that had in fact delivered both. It passes in isolation and fails after a neighbour, the
 * signature of a baseline problem rather than a product one. The `@<bot>` test already documents the
 * same hazard from the other side.
 */
async function settleViews(pages: Page[], channelId: string) {
  for (const page of pages) {
    await openConversationById(page, channelId);
    let previous = -1;
    for (let i = 0; i < 20; i++) {
      const count = await page.locator('.message').count();
      if (count === previous) break;
      previous = count;
      await page.waitForTimeout(1000);
    }
  }
}

async function clearSticky(page: Page) {
  const clear = page.locator('.message-input-sticky-target-clear');
  if (await clear.isVisible({ timeout: 1000 }).catch(() => false)) {
    await clear.click();
  }
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
  /**
   * What this channel's assistant is actually CALLED, read from the picker rather than assumed.
   *
   * The bot's display name is whatever its `AppInstanceBot` was created with - Atlas, Echo,
   * Assistant-basic - and a test that hardcodes one passes on the deployment it was written against
   * and fails everywhere else for a reason that looks like a routing bug.
   */
  let botMentionName: string;
  /** What B is called in this room, read from the picker for the same reason the bot's name is. */
  let personMentionName: string;

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
    await createConversation(pageA, conversationTitle, 'Basic');
    const createBody = await (await createRespPromise).json();
    channelArn = createBody.conversation.conversationArn as string;
    channelId = channelArn.split('/').pop()!;
    console.log(`Shared channel id: ${channelId}`);
    await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // A shares the conversation with B.
    await pageA.locator('button[aria-label="Share conversation"]').click();
    await expect(pageA.locator('#share-email')).toBeVisible({ timeout: 5000 });
    await pageA.locator('#share-email').fill(userB.email);
    await pageA.locator('form:has(#share-email) button[type="submit"]').click();
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

    // Resolve the assistant's real name ONCE, the way a person would: open the picker and read the
    // BOT-badged entry. Every test below addresses it by that name.
    await pageA.locator('.message-textarea').fill('@');
    const botOption = pageA.locator('.mention-option', {
      has: pageA.locator('.mention-option-badge', { hasText: 'BOT' }),
    }).first();
    await expect(botOption).toBeVisible({ timeout: 10000 });
    botMentionName = ((await botOption.locator('.mention-option-name').textContent()) || '')
      .trim()
      .replace(/^@/, '');
    expect(botMentionName, 'this channel must have an addressable assistant').toBeTruthy();

    // The colleague, from the same list: the entry with no BOT badge.
    const personOpt = pageA.locator('.mention-option', {
      hasNot: pageA.locator('.mention-option-badge'),
    }).first();
    await expect(personOpt).toBeVisible({ timeout: 10000 });
    personMentionName = ((await personOpt.locator('.mention-option-name').textContent()) || '')
      .trim()
      .replace(/^@/, '');
    expect(personMentionName, 'this channel must have a second person in it').toBeTruthy();

    await pageA.locator('.message-textarea').fill('');
    console.log(`Channel members resolve to: @${botMentionName} (bot), @${personMentionName} (person)`);
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('@<bot> is PUBLIC: both A and B see the question and the reply; sticky chip set on A', async () => {
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

    // Sticky chip auto-sets on A from the mention A just sent. It is set by the composer on SEND
    // (`mentions.mentionedArns[0]`), not derived from a targeted reply - which matters now that the
    // reply is not targeted at all.
    await expect(pageA.locator('.message-input-sticky-target'))
      .toBeVisible({ timeout: 10000 });

    // ── THE INVERTED ASSERTION, AND THE POINT OF ADR-034 ──
    //
    // B MUST see both halves. This used to assert `afterB === beforeB` - that naming the assistant
    // hid the whole exchange from the room - because an `@` mention set a `Target`. Addressing a
    // message and making it private are now two different acts: `@` addresses in public, `.` is
    // private. Asking one person a question in front of the group is how groups work, and the room
    // seeing neither the question nor the answer was the defect, not the feature.
    //
    // Re-opened from persisted history rather than trusting live WebSocket state, the same way the
    // `@all` test below does - a socket that dropped mid-test would otherwise read as "B saw
    // nothing", which is the old bug's signature and would make this pass for the wrong reason.
    await openConversationById(pageB, channelId);
    await expect(async () => {
      const countB = await pageB.locator('.message').count();
      expect(countB).toBeGreaterThanOrEqual(beforeB + 2);
    }).toPass({ timeout: 60000 });

    const afterB = await pageB.locator('.message').count();
    console.log(`After @<bot>: B=${afterB} (expected >=${beforeB + 2} - the room sees a public mention)`);

    // Hand the next test a settled view, or its baseline absorbs this test's messages.
    await settleViews([pageA, pageB], channelId);
  });

  test('@<person> addresses a colleague and starts NO assistant turn', async () => {
    // THE OTHER HALF OF "ADDRESSING IS NOT SUMMONING". An assistant that answered here would
    // interrupt every conversation in a busy room, which is the reason silence is the default in a
    // group at all. The flow resolves the mention, notifies the person, and dispatches nothing.
    await clearSticky(pageA);

    // Backend truth. The DOM cannot tell "no assistant answered" from "the answer has not arrived
    // yet", and a lower bound on a message count cannot fail on an extra reply - so the property is
    // read from the channel itself.
    const botsBefore = await assistantResponseCount(channelArn);
    const beforeB = await pageB.locator('.message').count();

    // Pick the PERSON from the same list the bot was picked from, so the name is whatever B is
    // actually called in this room rather than a guess this test hardcodes.
    await pageA.locator('.message-textarea').fill('@');
    const personOption = pageA.locator('.mention-option', {
      hasNot: pageA.locator('.mention-option-badge'),
    }).first();
    await expect(personOption).toBeVisible({ timeout: 5000 });
    const personLabel = (await personOption.locator('.mention-option-name').textContent())?.trim();
    console.log(`\n--- multi-user @<person> --- resolved to: ${personLabel}`);
    await personOption.click();
    await pageA.locator('.message-textarea').press('End');
    await pageA.locator('.message-textarea').pressSequentially(' could you take a look at this?');
    await pageA.keyboard.press('Enter');

    // Long enough that an assistant turn would have landed. A turn answers in seconds; this waits
    // well past that, so a zero here is silence rather than impatience.
    await pageA.waitForTimeout(25000);

    const botsAfter = await assistantResponseCount(channelArn);
    console.log(`Assistant responses: before=${botsBefore} after=${botsAfter} (expected unchanged)`);
    expect(
      botsAfter,
      'an @ mention of a PERSON must not start an assistant turn',
    ).toBe(botsBefore);

    // And the message still reaches the room, with the token intact - the token is how the addressed
    // person sees it was meant for them.
    await openConversationById(pageB, channelId);
    await expect(async () => {
      const countB = await pageB.locator('.message').count();
      expect(countB).toBeGreaterThanOrEqual(beforeB + 1);
    }).toPass({ timeout: 30000 });

    await settleViews([pageA, pageB], channelId);
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

  test('.<bot> is PRIVATE: the room cannot see it', async () => {
    // THE HALF THAT CANNOT BE TAKEN BACK IF IT FAILS, so it is checked against the service rather
    // than against a browser. A DOM assertion on B's page proves less than it looks: a socket that
    // dropped, a page that did not refresh, a render that lagged all look exactly like "B cannot see
    // it". Amazon Chime SDK returns a targeted message only to its sender and its target, so listing
    // the channel AS B is the room's view by construction, whatever any client believes.
    //
    // B IS THE THIRD PARTY HERE. The private message goes from A to the ASSISTANT, so B is neither
    // sender nor target and is exactly the person who must not see it - no extra member needed.
    await clearSticky(pageA);

    const userB = await getStandardUser();
    const arnB = await personArnOf(userB);
    expect(arnB, 'B must resolve to an app-instance user, or the room view below is not B').toContain('/user/');

    // A codename, so the search below cannot match incidental words the assistant happens to use.
    const secret = `PRIVATEMENTION${Date.now().toString(36).toUpperCase()}`;

    // Pick the assistant from the PRIVACY picker, which is the gesture a person actually performs:
    // a dot opens a member list of its own, and picking from it is what guarantees the token matches
    // a real member in full. Typing the name by hand would test a different thing.
    await pageA.locator('.message-textarea').fill('.');
    const privateList = pageA.locator('.mention-dropdown--private');
    await expect(privateList, 'a dot opens the privacy picker').toBeVisible({ timeout: 5000 });
    const botOption = privateList.locator('.mention-option', {
      has: pageA.locator('.mention-option-badge', { hasText: 'BOT' }),
    }).first();
    await expect(botOption).toBeVisible({ timeout: 5000 });
    const label = (await botOption.locator('.mention-option-name').textContent())?.trim();
    console.log(`\n--- multi-user .<bot> --- privacy picker resolved to: ${label}`);
    await botOption.click();

    // The chip is the person's confirmation that privacy was applied BEFORE they commit to sending.
    await expect(
      pageA.locator('.message-input-sticky-target-chip--private'),
      'the privacy decoration must appear once the token resolves',
    ).toBeVisible({ timeout: 5000 });

    await pageA.locator('.message-textarea').press('End');
    await pageA.locator('.message-textarea').pressSequentially(`please remember the codename ${secret}`);
    await pageA.keyboard.press('Enter');

    // Let it land and be answered before asking what the room can see.
    await pageA.waitForTimeout(25000);

    // ── AND THE ABSENCE BELOW IS ALSO THE PROOF THAT LEX ANSWERED, NOT THE FLOW ──
    //
    // The two entries are told apart by the VISIBILITY of the reply, not by the correlation id: the
    // Lex DIRECT path mints `mention-<messageId>` exactly as the flow's dispatch does, so the marker
    // cannot discriminate between them. What differs is who can read the answer. The flow answers a
    // mention through `handOffTurnToRouter(broadcast: true)` - an UNTARGETED reply the whole room
    // sees - while Amazon Chime SDK answering a targeted message replies targeted, to the sender
    // alone.
    //
    // So an answer the room cannot see is an answer the flow did not produce. `.member` is routed by
    // `TargetedMessages: ALL` and the flow deliberately stands off it (`flowOwnsTheTurn` is false for
    // a dot), which is exactly what this measures from the outside.
    const roomSees = messagesVisibleTo(channelArn, arnB);
    // NOT VACUOUS. A read that returns nothing - wrong bearer, denied call, empty channel - would
    // satisfy the absence below without proving anything. The room must be able to see SOMETHING
    // before its not seeing the secret means something.
    expect(
      roomSees.length,
      'B must see the conversation at all, or this proves nothing about what B cannot see',
    ).toBeGreaterThan(0);

    const leaked = roomSees.filter((c) => c.includes(secret));
    console.log(`[.private] the room sees ${roomSees.length} message(s), ${leaked.length} carrying the secret`);
    expect(
      leaked,
      'a `.member` message reached somebody who was neither its sender nor its target',
    ).toEqual([]);
  });

  test('an assistant named ALONGSIDE a person still answers', async () => {
    // THE TURN NOBODY ANSWERED. The mention resolver returns the earliest token, which answers "who
    // is this addressed to" and not "must an assistant answer". Naming a colleague first therefore
    // made the flow take the human branch and dispatch nothing, while the handler stood down because
    // a member WAS named - so Lex was invoked and silenced, and the message simply sat there.
    // Reversing the two names worked, which is the kind of difference nobody reproduces on purpose.
    //
    // Only an e2e sees this: both halves are individually behaving as designed, and the failure is
    // the ABSENCE of a reply.
    await clearSticky(pageA);
    const botsBefore = await assistantResponseCount(channelArn);

    // Pick the person from the list, then type the assistant's name after them, so the person's
    // token genuinely comes first in the text.
    await pageA.locator('.message-textarea').fill('@');
    const personOption = pageA.locator('.mention-option', {
      hasNot: pageA.locator('.mention-option-badge'),
    }).first();
    await expect(personOption).toBeVisible({ timeout: 5000 });
    await personOption.click();
    await pageA.locator('.message-textarea').press('End');
    await pageA.locator('.message-textarea').pressSequentially(` and @${botMentionName} what is 2+2?`);
    await pageA.keyboard.press('Enter');

    await expect(async () => {
      expect(await assistantResponseCount(channelArn)).toBeGreaterThan(botsBefore);
    }).toPass({ timeout: 90_000 });

    const botsAfter = await assistantResponseCount(channelArn);
    console.log(`\n--- @person + @assistant --- responses ${botsBefore} -> ${botsAfter}`);
    // EXACTLY ONE. The complement still has to hold: the flow answers and the handler stands down.
    expect(
      botsAfter - botsBefore,
      'naming a colleague alongside the assistant must not take the turn away, nor answer it twice',
    ).toBe(1);

    await settleViews([pageA, pageB], channelId);
  });

  test('a private address resolves by id, not by display name', async () => {
    // THE ID IS THE REFERENCE, THE NAME IS ONLY WHAT THE READER SEES. A display name is not unique
    // and can hold any character, so the picker writes `.<Name|id>` and the composer and the flow
    // resolve the member by the id first (`privatePrefixFor`, `parseMentions`). This asserts the id is
    // what was written, and that the message it addresses stays private - not what characters a test
    // user's name happens to contain.
    await clearSticky(pageA);

    const secret = `PRIVATEID${Date.now().toString(36).toUpperCase()}`;
    const userB = await getStandardUser();
    const arnB = await personArnOf(userB);
    expect(arnB, 'B must resolve to an app-instance user').toContain('/user/');

    // Pick the ASSISTANT privately, and assert B - who is neither sender nor target - cannot see it.
    // Addressing B directly would make B the target, and a privacy assertion read from the target's
    // own view proves nothing.
    await pageA.locator('.message-textarea').fill('.');
    const privateList = pageA.locator('.mention-dropdown--private');
    await expect(privateList, 'a dot opens the privacy picker').toBeVisible({ timeout: 5000 });
    const botOption = privateList.locator('.mention-option', {
      has: pageA.locator('.mention-option-badge', { hasText: 'BOT' }),
    }).first();
    await expect(botOption).toBeVisible({ timeout: 5000 });
    await botOption.click();
    await expect(
      pageA.locator('.message-input-sticky-target-chip--private'),
      'the privacy decoration must appear once the token resolves',
    ).toBeVisible({ timeout: 5000 });
    // THE PICK WROTE THE MEMBER'S ID beside its name, so who reads the message is decided by the id.
    const written = await pageA.locator('.message-textarea').inputValue();
    expect(written, `the private pick wrote no id, only a name: "${written}"`).toMatch(/^\.<[^>|]+\|[^>|]+> /);

    await pageA.locator('.message-textarea').press('End');
    await pageA.locator('.message-textarea').pressSequentially(`please remember the codename ${secret}`);
    await pageA.keyboard.press('Enter');
    await pageA.waitForTimeout(25000);

    const roomSees = messagesVisibleTo(channelArn, arnB);
    expect(
      roomSees.length,
      'B must see the conversation at all, or this proves nothing about what B cannot see',
    ).toBeGreaterThan(0);
    expect(
      roomSees.filter((c) => c.includes(secret)),
      'a private message reached somebody who was neither its sender nor its target',
    ).toEqual([]);

    await settleViews([pageA, pageB], channelId);
  });

  test('a person can send another person a file, and they receive it', async () => {
    // USER TO USER, WITH NO ASSISTANT IN IT. Every other attachment test in this suite is about
    // whether a MODEL got the file. This one is about whether a colleague did - which is the more
    // basic promise of a shared conversation, and the one nothing here asserted.
    //
    // It also pins the half of `@<person>` that is easy to lose: addressing a colleague starts no
    // assistant turn, and that must not come at the cost of the message or its attachment.
    await clearSticky(pageA);
    const botsBefore = await assistantResponseCount(channelArn);
    const marker = `HANDOFF-${Date.now().toString(36).toUpperCase()}`;

    await pageA.locator('.file-input-hidden').setInputFiles({
      name: 'handoff-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`Handover note.\n\nReference ${marker}.\n`),
    });
    await pageA.locator('.message-textarea').fill(`@${personMentionName} here is the note, reference ${marker}`);
    await pageA.keyboard.press('Enter');

    // B RECEIVES IT. Read from persisted history rather than live socket state, for the reason the
    // `@all` test gives: a dropped socket and "never delivered" look identical in a DOM.
    await openConversationById(pageB, channelId);
    await expect(
      pageB.locator('.message', { hasText: marker }).first(),
      'the addressed colleague must actually receive the message',
    ).toBeVisible({ timeout: 60_000 });

    // AND THE FILE CAME WITH IT, not just the caption. `AttachmentDisplay` renders `.attachment-display`
    // INSIDE the message, as a sibling of the text, so this is a descendant lookup rather than a walk
    // up to a guessed parent - and the class is the one the component actually emits.
    await expect(
      pageB.locator('.message', { hasText: marker }).first().locator('.attachment-display').first(),
      'the file must arrive with the message, not only the words about it',
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      pageB.locator('.message', { hasText: marker }).first().locator('.attachment-name').first(),
      'the recipient sees what the file is called',
    ).toContainText('handoff-note.txt', { timeout: 15_000 });

    // AND NO ASSISTANT ANSWERED. Addressing a colleague is not summoning the assistant, and an
    // attachment does not change that.
    expect(
      await assistantResponseCount(channelArn),
      'a file sent to a person must not start an assistant turn',
    ).toBe(botsBefore);

    await settleViews([pageA, pageB], channelId);
  });

  test('a dot that names nobody is ordinary text, and the room sees it', async () => {
    // THE RULE THAT MAKES THE FEATURE LIVABLE. The prefix grammar matches far more than names, and
    // this used to REFUSE to send anything it could not resolve - so in a room where people discuss
    // code, `.env is missing` and `.gitignore needs a line` could not be sent at all.
    //
    // A dot applies a Target only when it is followed by an actual member's name in full. Anything
    // else is a sentence that happens to begin with a dot, and it goes to the room as written.
    await clearSticky(pageA);
    const beforeB = await pageB.locator('.message').count();

    await pageA.locator('.message-textarea').fill('.env is missing a value');

    // No decoration, because nothing resolved - and the ABSENCE of the chip is what tells the person
    // this message is not private. That is the signal the refusal used to provide.
    await expect(
      pageA.locator('.message-input-sticky-target-chip--private'),
      'nothing resolved, so nothing may claim to be private',
    ).toBeHidden({ timeout: 3000 });

    await pageA.keyboard.press('Enter');

    // It SENDS. The composer used to block here with "That name is not in this conversation".
    await expect(async () => {
      expect(await pageA.locator('.message-textarea').inputValue()).toBe('');
    }).toPass({ timeout: 15000 });

    // And it reaches the room, unedited - the dot is part of what the person wrote.
    await openConversationById(pageB, channelId);
    await expect(async () => {
      const countB = await pageB.locator('.message').count();
      expect(countB).toBeGreaterThanOrEqual(beforeB + 1);
    }).toPass({ timeout: 30000 });
    await expect(
      pageB.locator('.message', { hasText: '.env is missing a value' }).first(),
      'the room sees the sentence exactly as it was typed',
    ).toBeVisible({ timeout: 15000 });
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// THE ACCEPTANCE TEST FOR THE `@all` HANDOFF (MESSAGE-FLOW §6.1).
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
    const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';
    const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || '';
    test.skip(!ANALYTICS_API, 'Needs VITE_ADMIN_API_URL (gen-frontend-env writes it).');
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
      idToken = await idTokenOf(adminPage);
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
    await createConversation(page, `E2E All Intent ${Date.now()}`, 'Standard');
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
  test('an ORDINARY 1:1 message is answered exactly once', async ({ page }) => {
    // THE PLAIN CASE, which nothing asserted. Every 1:1 test in this file addresses the assistant
    // somehow - `@all`, an attachment caption - so the most common turn in the product, a person
    // simply typing a question in their own conversation, had no end-to-end coverage at all.
    //
    // At this size Amazon Chime SDK's AUTO trigger routes EVERY message to Lex regardless of
    // addressing, and the flow stands aside for all of them. That makes ONE the whole assertion: two
    // responses means both entries ran, none means the guard silenced the only one that could.
    test.setTimeout(180_000);
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const createRespPromise = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `E2E Plain 1:1 ${Date.now()}`, 'Basic');
    const oneToOneArn = (await (await createRespPromise).json()).conversation.conversationArn as string;
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Let the welcome settle, or it counts as this turn's reply.
    await expect(async () => {
      expect(await assistantResponseCount(oneToOneArn)).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 90_000 });
    const before = await assistantResponseCount(oneToOneArn);

    await page.locator('.message-textarea').fill('what is 2+2? Answer with the number only.');
    await page.keyboard.press('Enter');

    await expect(async () => {
      expect(await assistantResponseCount(oneToOneArn)).toBeGreaterThan(before);
    }).toPass({ timeout: 90_000 });

    // Settle, so a second response that is merely SLOW is still counted rather than missed.
    await page.waitForTimeout(15_000);
    const after = await assistantResponseCount(oneToOneArn);
    console.log(`\n--- plain 1:1 --- responses ${before} -> ${after}`);
    expect(after - before, 'a 1:1 turn is answered by exactly one entry').toBe(1);
  });

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
    await createConversation(page, `E2E All Once ${Date.now()}`, 'Standard');
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
    // Amazon Chime SDK materializes a message even from a Lex fulfillment that returned an EMPTY
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
    await createConversation(page, `E2E All Attach ${Date.now()}`, 'Standard');
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

  // THE SAME ASSERTION FOR THE OTHER TOKEN. `@all` takes the flow's bypass; an `@<member>` naming the
  // assistant does not, so it reaches the turn by a different route and needs its own recovery. It
  // was measured as broken before that recovery existed: an attachment rides message Metadata, Amazon
  // Chime SDK sends a Lex turn three request attributes and Metadata is not one of them, so the Lex
  // path has no route for a file at all. Two producers can supply it - the flow's direct invoke and
  // the handler reading the stored message back - and for an `@<member>` token neither ran.
  //
  // IT LIVES HERE, AND NOT IN THE MULTI-USER SUITE ABOVE, because that suite signs in as a basic user
  // and opens a Haiku conversation - and `concierge`, the basic assistant, declares
  // `attachmentsReadable: false` (`backend/lib/config/profiles.ts:319`). Its IAM role holds no
  // `s3:GetObject` on `attachments/*`, so the answer it gives is the one the product intends. Asserted
  // there, this test demanded a capability the deployment deliberately withholds and failed on correct
  // behavior, which is worse than not asserting it: it reported a designed boundary as a defect.
  test('an @<member> mention carries its attachment to the turn', async ({ browser }) => {
    test.setTimeout(300_000);
    // TWO HUMANS, AND THAT IS NOT INCIDENTAL. The mention picker builds its list from the members
    // other than you (`getMentionOptions`, MessageInput.tsx), and the dropdown renders only when that
    // list is non-empty. In a 1:1 there is nobody else to offer, so no picker opens and an
    // `@<member>` mention is not expressible through the UI at all - measured live: the textarea held
    // "@" and no `.mention-option` rendered for a full minute. The original home of this test was a
    // shared room for that reason, and moving it to a 1:1 made it unable to perform the action it
    // asserts.
    const userA = await getStandardUser();
    const userB = await getPremiumUser();
    test.skip(
      !userA.password || !userB.password,
      !userA.password ? missingUserReason('standardUser') : missingUserReason('premiumUser'),
    );

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    try {
      await signIn(pageA, userA.email, userA.password);
      await signIn(pageB, userB.email, userB.password);

      const createRespPromise = pageA.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30000 },
      );
      // SONNET, so the serving assistant is `analyst` - the classification whose profile declares
      // `attachmentsReadable: true` (`config/profiles.ts`). The basic assistant `concierge` declares
      // false and holds no `s3:GetObject` on `attachments/*`, so asserting this against it demanded a
      // capability the deployment deliberately withholds and failed on correct behavior.
      await createConversation(pageA, `E2E Mention Attach ${Date.now()}`, 'Standard');
      const channelArn = (await (await createRespPromise).json()).conversation.conversationArn as string;
      const channelId = channelArn.split('/').pop()!;
      await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

      // A shares with B, which is what puts a second human in the room and makes the picker offer
      // anything at all.
      await pageA.locator('button[aria-label="Share conversation"]').click();
      await expect(pageA.locator('#share-email')).toBeVisible({ timeout: 5000 });
      await pageA.locator('#share-email').fill(userB.email);
      await pageA.locator('form:has(#share-email) button[type="submit"]').click();
      await expect(pageA.locator('.alert-success')).toBeVisible({ timeout: 30000 });
      await expect(pageA.locator('.conversation-header-btn-count')).toBeVisible({ timeout: 15000 });
      await pageA.locator('.modal-close-btn').click();
      await expect(pageA.locator('.modal-content')).toBeHidden({ timeout: 5000 });
      await openConversationById(pageB, channelId);

      await expect(async () => {
        expect(await assistantResponseCount(channelArn)).toBeGreaterThanOrEqual(1);
      }).toPass({ timeout: 90_000 });
      const botsBefore = await assistantResponseCount(channelArn);

      // Resolve the assistant's real name the way a person would, by reading the BOT-badged entry out
      // of the picker. Hardcoding it would pin a display name this deployment is free to change.
      await pageA.locator('.message-textarea').fill('@');
      const botOption = pageA.locator('.mention-option', {
        has: pageA.locator('.mention-option-badge', { hasText: 'BOT' }),
      }).first();
      await expect(botOption).toBeVisible({ timeout: 10000 });
      const botMention = ((await botOption.locator('.mention-option-name').textContent()) || '')
        .trim()
        .replace(/^@/, '');
      expect(botMention, 'this channel must have an addressable assistant').toBeTruthy();

      // A nonce that exists ONLY in the file, so a caption-only answer cannot luck into it.
      const codename = `MENTIONFAX-${Date.now().toString(36).toUpperCase()}`;
      await pageA.locator('.file-input-hidden').setInputFiles({
        name: 'mention-brief.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          `Project brief.\n\nThe internal codename for this initiative is ${codename}.\n`
          + 'Scope: a short pilot, one team, one quarter. Nothing else in this brief matters.\n',
        ),
      });

      await pageA.locator('.message-textarea').fill(
        `@${botMention} what is the internal codename stated in the attached document? Reply with the codename.`,
      );
      await pageA.keyboard.press('Enter');

      await expect(async () => {
        expect(await assistantResponseCount(channelArn)).toBeGreaterThan(botsBefore);
      }).toPass({ timeout: 180_000 });

      // POLL rather than sample once: the question can classify as data_extraction, whose delivery is
      // a multi-step chain, so the grounded answer lands a message or two after the first reply. The
      // codename survives percent-encoding verbatim (A-Z, digits, hyphen), so the stored content is
      // searchable either way.
      await expect
        .poll(async () => (await botMessagesForDiagnosis(channelArn)).some((m) => m.includes(codename)), {
          timeout: 180_000,
          message:
            'no assistant message contains the codename that exists only inside the attached document. '
            + 'The reply was probably fluent - that is the failure mode: the attachment rides Metadata, '
            + 'Lex never passes it, and a mention that recovers neither answers on the caption alone.',
        })
        .toBe(true);
      for (const m of (await botMessagesForDiagnosis(channelArn)).slice(-3)) {
        console.log(`[@member attach] bot message: ${JSON.stringify(m.slice(0, 160))}`);
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
