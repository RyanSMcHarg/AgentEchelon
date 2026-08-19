/**
 * Onboarding intake E2E (opt-in welcome) — deployed validation.
 *
 * Drives the multi-step onboarding intake against a LIVE standard-tier
 * conversation. This is the one behaviour the unit tests cannot prove: that Lex
 * `sessionAttributes` actually persist across turns in the Chime->Lex
 * integration, which is what carries the intake cursor from one answer to the
 * next. If they did not persist, the intake would re-ask the first field forever
 * — so a full happy-path run here is the real validation of the design.
 *
 * It also proves the ONCE-PER-USER contract (SPEC-USER-PROFILE-AND-ONBOARDING):
 * after a user completes onboarding, a FRESH conversation for the same user is
 * NOT re-onboarded — it answers directly. Because onboarding completion is now
 * durable (per-user profile), this suite RESETS the standard user's profile in
 * beforeAll so the happy-path run is repeatable.
 *
 * GATED behind ONBOARDING_E2E=1 AND requires the standard-tier onboarding schema
 * to be enabled first (SSM /agent-echelon/assistant/standard/onboarding-intake +
 * a router cold-start). The validate.mjs full suite runs with onboarding OFF, so
 * this spec self-skips there and does not gate the other tests' first turns.
 *
 * The schema this asserts against (write it to SSM before running):
 *   { greeting: "...details before we begin.",
 *     fields: [ {key:company, prompt:"What company are you with?"},
 *               {key:role,    prompt:"And what is your role there?"} ],
 *     completion: "...you are all set. How can I help?" }
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import {
  signIn,
  createConversation,
  sendAndWaitForResponse,
  WebSocketMonitor,
  ConsoleMonitor,
} from './helpers/agent-helpers';
import { getOnboardingUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


const RUNNABLE = process.env.ONBOARDING_E2E === '1' && !!process.env.E2E_BASE_URL;
const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.VITE_USER_POOL_ID || '';

function aws(args: string[]): string {
  return execFileSync('aws', [...args, '--region', REGION, '--profile', AWS_PROFILE], {
    encoding: 'utf8',
    timeout: 20000,
  }).trim();
}

/**
 * Clear the standard user's onboarding so the happy-path run is repeatable. Resolves the user's sub
 * from Cognito, the profile table from SSM, and deletes the item. Best-effort: if any step fails (no
 * AWS creds, table absent), the test still runs — a fresh table already has no item, and a stale one
 * only makes the happy-path assertion fail loudly rather than silently pass.
 */
function resetStandardUserOnboarding(email: string): void {
  try {
    if (!USER_POOL_ID) throw new Error('VITE_USER_POOL_ID unset');
    const sub = aws([
      'cognito-idp', 'admin-get-user', '--user-pool-id', USER_POOL_ID, '--username', email,
      '--query', "UserAttributes[?Name=='sub'].Value | [0]", '--output', 'text',
    ]);
    const table = aws([
      'ssm', 'get-parameter', '--name', '/agent-echelon/shared/tables/user-profile-name',
      '--query', 'Parameter.Value', '--output', 'text',
    ]);
    if (sub && sub !== 'None' && table && table !== 'None') {
      aws([
        'dynamodb', 'delete-item', '--table-name', table,
        '--key', JSON.stringify({ userSub: { S: sub } }),
      ]);
      console.log(`[onboarding-e2e] reset onboarding for ${email} (sub ${sub}) in ${table}`);
    }
  } catch (err) {
    // Do NOT continue. The reset is a PRECONDITION, not a nicety: without it the run starts from
    // whatever state the last run left behind, and the intake FSM is mid-schema rather than at
    // field 0. Observed exactly that - with VITE_USER_POOL_ID unset the reset was skipped, the run
    // proceeded anyway, and the second intake turn came back as a bare persona marker with no body.
    // That reads as a product defect in the onboarding FSM. It was this line shrugging.
    throw new Error(
      `[onboarding-e2e] could not reset onboarding for ${email}, so this spec cannot start from a `
        + 'known state. Set VITE_USER_POOL_ID (validate.mjs reads it from packages/admin/.env) and '
        + `ensure AWS credentials can reach Cognito + the user-profile table. Cause: ${(err as Error).message}`,
    );
  }
}

/**
 * Read the user's row from the profile store — the thing the once-per-user gate actually consults.
 *
 * Without this the spec is a conversation transcript: "the assistant did not re-ask" is the
 * CONSEQUENCE of a persisted profile, not evidence of one. A deployment whose store write silently
 * failed would still pass on prose whenever the model simply chose not to re-ask, and the next cold
 * Lambda (the onboarded cache is warm-life only) would re-interrogate a user the test called
 * remembered. Returns null when the row is absent.
 */
function readProfile(email: string): { userSub: string; onboardedAt?: string; facts?: Record<string, string> } | null {
  const sub = aws([
    'cognito-idp', 'admin-get-user', '--user-pool-id', USER_POOL_ID, '--username', email,
    '--query', "UserAttributes[?Name=='sub'].Value | [0]", '--output', 'text',
  ]);
  const table = aws([
    'ssm', 'get-parameter', '--name', '/agent-echelon/shared/tables/user-profile-name',
    '--query', 'Parameter.Value', '--output', 'text',
  ]);
  const raw = aws([
    'dynamodb', 'get-item', '--table-name', table,
    '--key', JSON.stringify({ userSub: { S: sub } }), '--output', 'json',
  ]);
  const item = raw ? JSON.parse(raw)?.Item : undefined;
  if (!item) return null;
  return {
    userSub: item.userSub?.S,
    onboardedAt: item.onboardedAt?.S,
    facts: Object.fromEntries(
      Object.entries((item.facts?.M ?? {}) as Record<string, { S?: string }>).map(([k, v]) => [k, v?.S ?? '']),
    ),
  };
}

test.describe.serial('Onboarding intake (opt-in welcome, standard tier)', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('onboarding-intake');

  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeAll(async () => {
    if (!RUNNABLE) return;
    const user = await getOnboardingUser();
    if (!user?.email) return; // the per-test skip below states the reason
    resetStandardUserOnboarding(user.email);
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!RUNNABLE, 'Needs ONBOARDING_E2E=1 + a live E2E_BASE_URL + the standard onboarding schema enabled in SSM.');
    const user = await getOnboardingUser();
    test.skip(!user?.password, missingUserReason('onboardingUser'));
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user!.email, user!.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('greets with the intake, collects fields across turns, confirms, and hands off', async ({ page }) => {
    // 1. Create a standard-tier conversation. With onboarding enabled AND the user not yet onboarded,
    //    the on-join welcome IS the intake greeting + the first field's question.
    await createConversation(page, 'Onboarding Intake', 'Claude Sonnet');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const welcome = ((await page.locator('.assistant-message .message-text').first().textContent()) || '').toLowerCase();
    // Match the intake's QUESTION, not the bare word "company". A seeded persona that describes "an
    // enterprise SaaS company" satisfies `toContain('company')`, so this passed against an ordinary
    // orientation welcome - which is how a run where the intake never started still reached step 2
    // and reported "the intake did not advance", sending the diagnosis after the wrong thing.
    expect(
      welcome,
      `the on-join welcome should BE the intake, asking the first field. Got: ${welcome.slice(0, 200)}`,
    ).toMatch(/what company are you with|company.*\?/);

    // 2. Answer the first field -> the FSM must advance to the second field.
    //    (This is the sessionAttributes-persistence proof: a second, DIFFERENT
    //    question means the cursor moved, not that field 0 was re-asked.)
    const afterCompany = await sendAndWaitForResponse(page, 'Acme Corp', 60000, ws);
    expect(afterCompany.text.toLowerCase(), 'after the company answer the intake should ask the role field').toContain('role');

    // 3. Answer the second (last) field -> the FSM must present the confirmation summary.
    const afterRole = await sendAndWaitForResponse(page, 'Staff Engineer', 60000, ws);
    const summary = afterRole.text.toLowerCase();
    expect(summary, 'the last field should produce a confirmation summary').toContain('correct');
    expect(summary, 'the summary should echo the collected company').toContain('acme');

    // 4. Confirm -> intake completes, hands off to the working assistant, AND persists the once-per-user
    //    onboarded flag + facts to the profile store.
    const done = await sendAndWaitForResponse(page, 'yes', 60000, ws);
    expect(done.text.toLowerCase(), 'confirming should complete the intake and hand off').toMatch(/all set|how can i help/);

    // 5. THE STORE, not the transcript. "All set" is the assistant's account of what happened; the
    //    once-per-user gate reads `onboardedAt` from the profile row, and the promise that the user is
    //    remembered rather than re-interrogated is only kept if the facts landed there too. A store
    //    write that silently failed leaves this conversation looking perfect.
    const user = await getOnboardingUser();
    let profile = readProfile(user!.email);
    for (let i = 0; i < 10 && !profile?.onboardedAt; i++) {
      await page.waitForTimeout(2000); // the write completes alongside the reply, not before it
      profile = readProfile(user!.email);
    }

    expect(profile, 'a profile row must exist for the onboarded user').not.toBeNull();
    expect(
      profile!.onboardedAt,
      'onboardedAt must be set — its PRESENCE is what makes onboarding fire once per user',
    ).toBeTruthy();
    expect(
      JSON.stringify(profile!.facts ?? {}).toLowerCase(),
      `the collected answers must be persisted, not just echoed back in the summary. facts=${JSON.stringify(profile!.facts)}`,
    ).toContain('acme');

    console.log(`[onboarding-e2e] persisted onboardedAt=${profile!.onboardedAt} facts=${JSON.stringify(profile!.facts)}`);
    cons.assertNoErrors();
  });

  test('does NOT re-onboard the same user: a fresh conversation answers directly', async ({ page }) => {
    // The previous test onboarded this user and persisted it. A brand-new standard conversation must
    // therefore SKIP the intake: the welcome is the normal orientation (not the "what company?" field),
    // and a real question gets a real answer instead of being consumed as a field answer. This is the
    // once-per-user contract (SPEC-USER-PROFILE-AND-ONBOARDING).
    // The gate's input, read BEFORE the second conversation. Asserting only that the assistant did
    // not re-ask would pass on a deployment where the row was never written and the model simply
    // chose not to re-interrogate — so pin the row, then require the second conversation to leave it
    // exactly as it was.
    const user = await getOnboardingUser();
    const before = readProfile(user!.email);
    expect(
      before?.onboardedAt,
      'the previous test must have left a persisted onboardedAt — without it this test proves nothing',
    ).toBeTruthy();

    await createConversation(page, 'Post-onboarding conversation', 'Claude Sonnet');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const welcome = ((await page.locator('.assistant-message .message-text').first().textContent()) || '').toLowerCase();
    expect(welcome, 'a returning (onboarded) user must NOT be re-asked the first intake field')
      .not.toContain('what company are you with');

    const resp = await sendAndWaitForResponse(page, 'In one sentence, what is a feature flag?', 90000, ws);
    const answer = resp.text.toLowerCase();
    expect(answer, 'the question should be answered directly, not treated as an onboarding field answer')
      .toContain('feature flag');
    expect(answer, 'the assistant must not ask the onboarding role field').not.toContain('what is your role there');

    // Onboarding is once per USER, not once per conversation: a second conversation must not re-run
    // the intake and re-stamp the row. An `onboardedAt` that moved means the gate did not hold and
    // the user WAS re-onboarded, however politely the transcript reads.
    const after = readProfile(user!.email);
    expect(
      after?.onboardedAt,
      `a second conversation re-stamped onboardedAt (${before?.onboardedAt} -> ${after?.onboardedAt}); ` +
        'onboarding fired again, so it is once-per-conversation, not once-per-user',
    ).toBe(before?.onboardedAt);

    cons.assertNoErrors();
  });
});
