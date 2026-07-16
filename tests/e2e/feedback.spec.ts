/**
 * User-feedback e2e (#36 feedback half / cluster E).
 *
 * PRODUCES REAL DATA: drives the actual thumbs UI on a bot reply so a feedback
 * row lands in the UserFeedback store (which the Experiments thumbs-join and the
 * Evaluation feedback view read). Without this, feedback data is perpetually
 * empty and the console shows "no user feedback".
 *
 * Gated by FEEDBACK_E2E=1 (a validate.mjs phase), like battle.spec — it runs
 * against the live deployment and is NOT part of the default unit run.
 *
 *   E2E_BASE_URL=<cloudfront> FEEDBACK_E2E=1 AWS_PROFILE=<p> \
 *     npx playwright test e2e/feedback.spec.ts --config=playwright.config.ts
 */
import { test, expect } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';

const RUN = process.env.FEEDBACK_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;

suite('User feedback (thumbs) produces real feedback data', () => {
  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
  });

  test('a thumbs rating on a bot reply submits and persists (→ feedback store)', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    await createConversation(page, `Feedback e2e ${Date.now()}`);

    const resp = await sendAndWaitForResponse(page, 'In one sentence, what is a monorepo?');
    expect(resp.text && resp.text.length).toBeTruthy();

    // The feedback row renders on the last message of a response group. The
    // button flips to `.active` only on a SUCCESSFUL submit (handleFeedback
    // catches failures), so asserting that = the feedback persisted.
    const helpful = page.locator('button[aria-label="Mark as helpful"]').last();
    await expect(helpful).toBeVisible({ timeout: 20_000 });

    const [fbResponse] = await Promise.all([
      page
        .waitForResponse(
          (r) => r.request().method() === 'POST' && /\/feedback\b/.test(r.url()),
          { timeout: 25_000 },
        )
        .catch(() => null),
      helpful.click(),
    ]);

    // Network truth: the feedback POST returned 2xx.
    if (fbResponse) {
      expect(fbResponse.status(), `feedback POST status: ${fbResponse.status()}`).toBeLessThan(300);
    }
    // UI truth: the button reflects the submitted (active) state.
    await expect(helpful).toHaveClass(/active/, { timeout: 15_000 });
  });
});
