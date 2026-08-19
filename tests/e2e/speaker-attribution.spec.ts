/**
 * A merged turn carries WHO said it, and the convention never leaks into the channel (ADR-027 phase 2,
 * tracker row 68).
 *
 * WHAT PHASE 2 DID. A transcript entry now carries its speaker and kind, applied at the MERGE - the one
 * place the boundary between two colleagues, or a colleague and a peer assistant, was being lost. The
 * label has exactly one definition, `formatSpeakerLabel`, and renders as `[Name, kind]`.
 *
 * WHY AN E2E, GIVEN THE UNIT TESTS. The merge and the label are unit-covered. What no unit test can
 * reach is the MODEL's reaction to being taught a convention, and that reaction is the user-visible
 * risk: `transcriptConventionDirective` exists because "the most likely inference is to imitate it -
 * prefixing its own reply with a label, which then lands in the channel". A label in a REPLY is not a
 * cosmetic defect; it is the system teaching every reader a format that anyone can then forge.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS THESE TWO THINGS. Both are deterministic:
 *
 *   1. A 1:1 reply carries no attribution prefix. Phase 2 promises a 1:1 is byte-identical to before,
 *      so a label appearing here means labels are being applied where they disambiguate nothing.
 *   2. A MULTI-PARTY reply carries no attribution prefix either. This is the real guard: the transcript
 *      genuinely carries labels here, the model has been told what they mean, and the failure mode is
 *      imitation. Test 1 alone would pass on a build that leaks a label the moment a second person
 *      speaks, which is the only situation where the leak can happen at all.
 *
 * The pattern is a MIRROR of the backend's `ATTRIBUTION_PREFIX` (lib/transcript-attribution.ts) and is
 * pinned to it by `attribution-pattern-parity.test.ts`. A guard that matches a shape the backend no
 * longer produces passes forever, which is how this suite has been fooled before.
 *
 * Attribution CORRECTNESS - "the assistant knows Priya asked, not Sam" - is deliberately logged and not
 * asserted: it depends on model judgement, and a flaky assertion on the value of a feature is worse
 * than none, because it gets retried away.
 *
 * Gated by ATTRIBUTION_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 *   E2E_BASE_URL=<cf> ATTRIBUTION_E2E=1 npx playwright test e2e/speaker-attribution.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import {
  getTestCredentials,
  getSecondPremiumUser,
  missingUserReason,
  type TestCredentials,
} from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUN = process.env.ATTRIBUTION_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;

/**
 * MIRROR of `ATTRIBUTION_PREFIX` in `backend/lambda/src/lib/transcript-attribution.ts`. Kept in sync by
 * a parity test rather than by discipline - the same protection the guardrail-block copy needed after a
 * corrupted escape left a guard unable to fire.
 */
export const E2E_ATTRIBUTION_PREFIX = /^[ \t]*\[[^\]\n]{1,64},[ \t]*(?:person|assistant|system)\][ \t]*/gim;

function carriesAttributionPrefix(content: string): boolean {
  E2E_ATTRIBUTION_PREFIX.lastIndex = 0;
  return E2E_ATTRIBUTION_PREFIX.test(content);
}

suite('a merged turn carries its speaker, and the convention stays out of the channel', () => {
  guardBackendErrors('speaker-attribution');

  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
  });

  test('a 1:1 reply carries no speaker label', async ({ page }) => {
    test.setTimeout(240_000);

    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    await createConversation(page, `Attribution 1-1 ${Date.now()}`, 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

    const resp = await sendAndWaitForResponse(
      page,
      'In two sentences, what is a feature flag?',
      120_000,
    );
    const text = resp.text || '';
    expect(text.length, 'the turn must return a response').toBeGreaterThan(0);

    // A 1:1 has one other participant, so a label says nothing the reader does not already know - and
    // phase 2's own claim is that this case is unchanged.
    expect(
      carriesAttributionPrefix(text),
      `a 1:1 reply must carry no "[Name, kind]" prefix; got: ${JSON.stringify(text.slice(0, 200))}`,
    ).toBe(false);
  });

  test('a multi-party reply carries no speaker label, though the transcript does', async ({ page, browser }) => {
    test.setTimeout(600_000);

    const second = await getSecondPremiumUser();
    test.skip(!second?.password, missingUserReason('secondPremiumUser'));

    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await createConversation(page, `Attribution multiparty ${Date.now()}`, 'Premium');
    const channelId = ((await (await createResp).json()).conversation.conversationArn as string)
      .split('/')
      .pop()!;
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

    // Bring in a SECOND PERSON. Two people is the minimum that makes a label mean anything, and it is
    // the exact condition under which the merge applies one.
    await shareChannelWith(page, second!.email);

    // Person A contributes a distinctive fact. ADDRESSED, because this is now a multi-user room and
    // silence-by-default is the rule - the join notice itself says 'mention @assistant or @all to
    // get a response'. The spec's first live run forgot that and timed out waiting for a reply the
    // router was correctly refusing to give.
    await sendAndWaitForResponse(page, '@Assistant-premium for the record: the migration window is codenamed HARBOUR.', 120_000);

    // Person B, in their own context, contributes a different one. A bare context signs in normally -
    // there is no storageState here to suppress the login form.
    const ctxB = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    });
    const pageB = await ctxB.newPage();
    try {
      await signIn(pageB, second!.email, second!.password);
      await openConversationById(pageB, channelId);
      await expect(pageB.locator('.message-textarea')).toBeEnabled({ timeout: 20_000 });
      await sendAndWaitForResponse(pageB, '@Assistant-premium and the rollback owner is codenamed PELICAN.', 120_000);
    } finally {
      await ctxB.close();
    }

    // Now a turn whose transcript genuinely carries two people. This is the turn that can leak.
    const resp = await sendAndWaitForResponse(
      page,
      '@Assistant-premium summarise what each of us just told you, in one sentence each.',
      180_000,
    );
    const text = resp.text || '';
    expect(text.length, 'the multi-party turn must return a response').toBeGreaterThan(0);
    console.log('[attribution-e2e] multi-party reply:', JSON.stringify(text.slice(0, 400)));

    // THE GUARD. The model has been shown labels and told what they mean; it must not imitate them.
    expect(
      carriesAttributionPrefix(text),
      `a reply must never carry a "[Name, kind]" prefix, even when the transcript does; got: `
        + JSON.stringify(text.slice(0, 200)),
    ).toBe(false);

    // Attribution CORRECTNESS is reported, not asserted - see the header. Logged so a human reading a
    // green run can still see whether the boundary held.
    const mentionsBoth = /HARBOUR/i.test(text) && /PELICAN/i.test(text);
    console.log(`[attribution-e2e] both contributions present in the summary: ${mentionsBoth}`);
  });
});

/** Share the open conversation with another member (same affordance battle.spec drives). */
async function shareChannelWith(page: Page, email: string): Promise<void> {
  await page.locator('button[aria-label="Share conversation"]').click();
  await expect(page.locator('#share-email')).toBeVisible({ timeout: 5_000 });
  await page.locator('#share-email').fill(email);
  await page.locator('.modal-content button[type="submit"]').click();
  await expect(page.locator('.alert-success')).toBeVisible({ timeout: 30_000 });
  await page.locator('.modal-close-btn').click().catch(() => {});
  await page.locator('.modal-content').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

/**
 * Open a conversation the caller is a member of, by channel id.
 *
 * RETRIES, and not defensively: the app fetches conversations once per load, so a just-shared channel
 * can be absent from this client's first fetch while membership propagates. Each `goto` forces a fresh
 * fetch. A single attempt fails as "the second member cannot see the channel", which reads as a
 * membership defect rather than a race.
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
  throw lastErr;
}
