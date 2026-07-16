import { test, expect, Page, BrowserContext } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getBasicUser, getStandardUser } from './helpers/test-credentials';

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

  test.beforeAll(async ({ browser }) => {
    const userA = await getBasicUser();
    const userB = await getStandardUser();
    if (!userA.password || !userB.password) {
      test.skip();
      return;
    }

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
    channelId = (createBody.conversation.conversationArn as string).split('/').pop()!;
    console.log(`Shared channel id: ${channelId}`);
    await expect(pageA.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // A shares the conversation with B.
    await pageA.locator('button[aria-label="Share conversation"]').click();
    await expect(pageA.locator('#share-email')).toBeVisible({ timeout: 5000 });
    await pageA.locator('#share-email').fill(userB.email);
    await pageA.locator('.modal-content button[type="submit"]').click();
    await expect(pageA.locator('.alert-success')).toBeVisible({ timeout: 30000 });

    // Confirm A's UI flipped to multi-user.
    await expect(pageA.locator('.conversation-header-members-chip')).toBeVisible({ timeout: 15000 });

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
    console.log(`\n--- multi-user @all ---`);
    console.log(`Before: A=${beforeA}, B=${beforeB}`);

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
  });
});
