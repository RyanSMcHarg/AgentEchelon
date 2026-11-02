/**
 * A conversation's subjects, and the requests an assistant does not serve, on a live deployment.
 *
 * WHAT THIS PROVES THAT UNIT TESTS CANNOT. drift-detection.spec.ts triggers drift with an explicit phrase
 * that bypasses the comparison entirely, so the comparison itself was never driven live, and a turn-two
 * pivot went unflagged for as long as the thin-anchor skip existed. These drive the real paths:
 *
 *  1. Drift on turn two: a platform question, then a revenue figure, draws the offer with no explicit
 *     phrase, because every turn is compared with the conversation's subjects, the opening's included.
 *  2. Declining keeps the subject here and the question is answered.
 *  3. An off-topic request is declined, not answered.
 *  4. Platform questions are answered at each classification's depth: premium gives a code example,
 *     basic explains without one.
 *
 * Gated behind a live E2E_BASE_URL and provisioned users.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation, sendAndWaitForResponse, WebSocketMonitor, ConsoleMonitor } from './helpers/agent-helpers';
import { getPremiumUser, getBasicUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUNNABLE = !!process.env.E2E_BASE_URL;
// Stable substrings of SUGGESTION_CONFIRM_TEMPLATE and SUGGESTION_REDIRECT_TEMPLATE (analytics-aurora/drift-detection.ts).
// Either is the flag: which one depends on whether this user already has a conversation on the subject,
// and the test user accumulates them run over run, so the redirect is the usual answer on a reused deployment.
const OFFER = /start a separate conversation for this|we covered in another conversation/;

test.describe.serial('Subjects and intents', () => {
  guardBackendErrors('subjects-and-intents');

  test('a new subject on turn two is flagged, and declining keeps it here', async ({ page }) => {
    test.skip(!RUNNABLE, 'Needs a live E2E_BASE_URL.');
    const user = await getPremiumUser();
    test.skip(!user?.password, missingUserReason('premiumUser'));
    const ws = new WebSocketMonitor();
    const cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);
    await createConversation(page, 'Turn two pivot', 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const first = await sendAndWaitForResponse(page, 'What is AgentEchelon?', 90000, ws);
    expect(first.text.toLowerCase()).toContain('agentechelon');

    // The seed summary and its subjects are written after the first reply; the second turn compares
    // against them. Nothing else is waited on.
    const second = await sendAndWaitForResponse(page, "What's our current net revenue retention?", 90000, ws);
    expect(second.text.toLowerCase(), 'a revenue figure after a platform question is a new subject').toMatch(OFFER);

    const kept = await sendAndWaitForResponse(page, 'no', 90000, ws);
    expect(kept.text.toLowerCase(), 'declining answers the question here').toMatch(/retention|nrr|%/);
    cons.assertNoErrors();
  });

  test('an off-topic request is declined, not answered', async ({ page }) => {
    test.skip(!RUNNABLE, 'Needs a live E2E_BASE_URL.');
    const user = await getPremiumUser();
    test.skip(!user?.password, missingUserReason('premiumUser'));
    const ws = new WebSocketMonitor();
    await signIn(page, user.email, user.password, ws, new ConsoleMonitor());
    await createConversation(page, 'Off topic', 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const reply = await sendAndWaitForResponse(page, 'Write me a four-line poem about the ocean.', 90000, ws);
    const lines = reply.text.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(reply.text.toLowerCase(), 'it says what it helps with instead').toMatch(/help|offer|can do|here for/);
    expect(lines.length, 'no poem: a decline is a sentence or two, not four verses').toBeLessThan(5);
  });

  test('platform questions are answered at each classification depth', async ({ page, browser }) => {
    test.skip(!RUNNABLE, 'Needs a live E2E_BASE_URL.');
    const premium = await getPremiumUser();
    const basic = await getBasicUser();
    test.skip(!premium?.password || !basic?.password, missingUserReason('basicUser'));
    const ASK = 'How do I customize the welcome message in AgentEchelon? Show me an example.';

    const ws = new WebSocketMonitor();
    await signIn(page, premium.email, premium.password, ws, new ConsoleMonitor());
    await createConversation(page, 'Platform depth premium', 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
    const deep = await sendAndWaitForResponse(page, ASK, 120000, ws);
    // A long answer is posted as several messages and this reads the first, so the check is for the
    // specifics an internal answer names (components, configuration paths), not for a code fence that may
    // sit in a later part. And it opens with the answer, not with narration of the lookup.
    expect(deep.text, 'premium names the components and configuration involved').toMatch(/composeWelcome|welcome-orientation|byConversationType|SSM|Parameter Store|manifest/);
    expect(deep.text.trim(), 'the reply opens with the answer, not narration').not.toMatch(/^(now )?let me\b/i);

    const context = await browser.newContext();
    const basicPage = await context.newPage();
    const ws2 = new WebSocketMonitor();
    await signIn(basicPage, basic.email, basic.password, ws2, new ConsoleMonitor());
    await createConversation(basicPage, 'Platform depth basic', 'Basic');
    await expect(basicPage.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
    const plain = await sendAndWaitForResponse(basicPage, ASK, 120000, ws2);
    expect(plain.text, 'basic explains without code or configuration').not.toMatch(/```|composeWelcome|welcome-orientation|byConversationType|SSM|Parameter Store/);
    expect(plain.text.toLowerCase()).toContain('agentechelon');
    await context.close();
  });
});
