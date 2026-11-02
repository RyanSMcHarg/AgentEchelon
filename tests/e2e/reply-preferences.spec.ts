/**
 * Reply preferences E2E - the onboarding offer and the two platform intents, against a live deployment.
 *
 * WHAT THIS PROVES THAT UNIT TESTS CANNOT. `backend/test/lib/reply-preferences.test.ts` pins the engine,
 * the store writes and the directives. Only a deployment shows:
 *
 *  1. The premium welcome carries the answer-style offer, from the profile version's intake.
 *  2. A question asked while the offer is open is ANSWERED, and the offer stays open: nothing is stored
 *     and onboarding is not recorded. Onboarding completes only once a preference is chosen.
 *  3. Choosing writes `preferences.answerStyle` and `onboardedAt` to the profile store, and a second
 *     conversation does not offer again.
 *  4. `show_preferences` and `set_preference` are classified and handled on a real turn: the listing
 *     names the saved choice, and a change is written to the store.
 *
 * Every claim about storage is read from the profile row, not inferred from the transcript.
 *
 * WHO. `secondPremiumUser`: the offer is on the premium profile, and the onboarding-only user holds
 * standard. global-setup pre-onboards every demo user, so `beforeAll` deletes this user's row first.
 * The router caches an onboarded sub for five minutes, so a run that follows another spec's premium
 * conversation by this user within that window starts with no offer and fails case 1, by design.
 *
 * NEEDS THE OFFER CONFIGURED. The demo seed carries no premium intake, so on a
 * deployment seeded from it the first case fails at the welcome. Activate an Advisor version whose
 * `onboarding` is `PREMIUM_ONBOARDING` (demo/onboarding.ts) before running this.
 *
 * Gated behind PREFERENCES_E2E=1 + a live E2E_BASE_URL.
 */
import { test, expect } from './helpers/fixtures';
import { deleteProfile, readProfileItem } from './helpers/profile-store';
import {
  signIn,
  createConversation,
  sendAndWaitForResponse,
  WebSocketMonitor,
  ConsoleMonitor,
} from './helpers/agent-helpers';
import { getSecondPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { SSM_ROOT } from './helpers/stack-prefix';
import { assistantServing } from './helpers/assistant-identity';
import { awsvText as aws } from './helpers/aws';

guardConsoleErrors();

const RUNNABLE = process.env.PREFERENCES_E2E === '1' && !!process.env.E2E_BASE_URL;

/** The offer's own words (demo/onboarding.ts PREMIUM_ONBOARDING). */
const OFFER = 'just the figure';

/**
 * WHETHER THE PREMIUM ASSISTANT'S ACTIVE VERSION CARRIES THE OFFER THIS SPEC ASSERTS, read from the
 * version itself (the live assistant from its assignment record, then its `active` definition). An offer is
 * profile data, so a deployment whose version carries none is SKIPPED BY NAME rather than failed: the
 * spec turns itself back on when a version carries the offer again.
 */
function activeVersionCarriesOffer(phrase: string): boolean {
  try {
    // The declared primary, from its assignment record (ADR-048, amended 2026-10-23).
    const record = { assistant: assistantServing('premium') };
    const def = aws(['ssm', 'get-parameter', '--name', `${SSM_ROOT}/assistant/${record.assistant}/definition:active`,
      '--query', 'Parameter.Value', '--output', 'text']);
    return def.toLowerCase().includes(phrase.toLowerCase());
  } catch {
    return true; // unreadable: run the spec, so a broken read fails loudly rather than skipping quietly
  }
}

/** A precondition, not a nicety: without it the run starts onboarded and the offer never appears. */
async function resetProfile(email: string): Promise<void> {
  try {
    await deleteProfile(email);
    console.log(`[preferences-e2e] reset profile for ${email}`);
  } catch (err) {
    throw new Error(
      `[preferences-e2e] could not reset ${email}, so this spec cannot start from a known state. Ensure the `
        + `test secret carries this user and AWS credentials reach the profile table. Cause: ${(err as Error).message}`,
    );
  }
}

interface StoredProfile { onboardedAt?: string; preferences: Record<string, string> }

async function readProfile(email: string): Promise<StoredProfile | null> {
  const item = await readProfileItem(email);
  if (!item) return null;
  return {
    onboardedAt: item.onboardedAt?.S,
    preferences: Object.fromEntries(
      Object.entries((item.preferences?.M ?? {}) as Record<string, { S?: string }>).map(([k, v]) => [k, v?.S ?? '']),
    ),
  };
}

/** The store is written alongside the reply, not before it, so a read is polled until it holds. */
async function profileWhen(
  email: string,
  holds: (p: StoredProfile | null) => boolean,
  wait: (ms: number) => Promise<void>,
): Promise<StoredProfile | null> {
  let p = await readProfile(email);
  for (let i = 0; i < 10 && !holds(p); i++) {
    await wait(2000);
    p = await readProfile(email);
  }
  return p;
}

test.describe.serial('Reply preferences (premium offer, set and show intents)', () => {
  guardBackendErrors('reply-preferences');

  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;
  let email = '';

  test.beforeAll(async () => {
    if (!RUNNABLE) return;
    const user = await getSecondPremiumUser();
    if (!user?.email) return;
    await resetProfile(user.email);
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!RUNNABLE, 'Needs PREFERENCES_E2E=1 + a live E2E_BASE_URL (premium carries the offer on its profile version).');
    // WITHDRAWN FROM THE DEMO (pending a rework of its wording): Advisor's version carries no answer-style
    // offer until its wording is reworked, and the seed no longer applies PREMIUM_ONBOARDING.
    test.skip(!activeVersionCarriesOffer(OFFER), 'the premium active version carries no answer-style offer (withdrawn pending a rework of its wording)');
    const user = await getSecondPremiumUser();
    test.skip(!user?.password, missingUserReason('secondPremiumUser'));
    email = user!.email;
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user!.email, user!.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('the offer never blocks a question, and onboarding completes only once a style is chosen', async ({ page }) => {
    const wait = (ms: number) => page.waitForTimeout(ms);

    await createConversation(page, 'Preferences offer', 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
    const welcome = ((await page.locator('.assistant-message .message-text').first().textContent()) || '').toLowerCase();
    expect(welcome, 'the premium welcome must carry the answer-style offer').toContain(OFFER);

    // A question while the offer is open goes to the assistant, and records nothing.
    const answered = await sendAndWaitForResponse(page, 'In one sentence, what does ARR stand for?', 90000, ws);
    expect(answered.text.toLowerCase(), 'the question is answered, not taken as a choice').toContain('recurring');
    const stillOpen = await readProfile(email);
    expect(stillOpen?.onboardedAt, 'a question must not complete onboarding').toBeFalsy();
    expect(stillOpen?.preferences?.answerStyle, 'a question must not store a preference').toBeFalsy();

    // Choosing completes onboarding and stores the registry value, not the typed words.
    const confirmed = await sendAndWaitForResponse(page, 'Just the figure, please', 90000, ws);
    expect(confirmed.text.trim().length, 'the assistant confirms the choice').toBeGreaterThan(0);
    const chosen = await profileWhen(email, (p) => p?.preferences?.answerStyle === 'brief' && !!p?.onboardedAt, wait);
    expect(chosen?.preferences.answerStyle, 'the choice is stored as the registry value').toBe('brief');
    expect(chosen?.onboardedAt, 'choosing completes onboarding').toBeTruthy();
    console.log(`[preferences-e2e] stored answerStyle=brief onboardedAt=${chosen?.onboardedAt}`);

    cons.assertNoErrors();
  });

  test('a later conversation is not offered again, lists the saved style, and changes it on request', async ({ page }) => {
    const wait = (ms: number) => page.waitForTimeout(ms);
    const before = await readProfile(email);
    expect(before?.preferences.answerStyle, 'the previous test must have stored a choice').toBe('brief');

    await createConversation(page, 'Preferences later', 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
    const welcome = ((await page.locator('.assistant-message .message-text').first().textContent()) || '').toLowerCase();
    expect(welcome, 'a person who chose is not offered again').not.toContain(OFFER);

    // show_preferences: the listing names the saved choice by its label.
    const shown = await sendAndWaitForResponse(page, 'What are my preferences?', 90000, ws);
    expect(shown.text.toLowerCase(), 'the listing names the saved style').toContain(OFFER);

    // set_preference: a lasting change is written to the store.
    await sendAndWaitForResponse(page, 'From now on, give me the figure with what it means.', 90000, ws);
    const changed = await profileWhen(email, (p) => p?.preferences?.answerStyle === 'explained', wait);
    expect(changed?.preferences.answerStyle, 'the change is written to the store').toBe('explained');
    expect(changed?.onboardedAt, 'a change does not re-stamp onboarding').toBe(before?.onboardedAt);

    cons.assertNoErrors();
  });
});
