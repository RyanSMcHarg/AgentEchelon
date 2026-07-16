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
 * GATED behind ONBOARDING_E2E=1 AND requires the standard-tier onboarding schema
 * to be enabled first (SSM /agent-echelon/tier/standard/onboarding-intake +
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
import {
  signIn,
  createConversation,
  sendAndWaitForResponse,
  WebSocketMonitor,
  ConsoleMonitor,
} from './helpers/agent-helpers';
import { getStandardUser } from './helpers/test-credentials';

const RUNNABLE = process.env.ONBOARDING_E2E === '1' && !!process.env.E2E_BASE_URL;

test.describe.serial('Onboarding intake (opt-in welcome, standard tier)', () => {
  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    test.skip(!RUNNABLE, 'Needs ONBOARDING_E2E=1 + a live E2E_BASE_URL + the standard onboarding schema enabled in SSM.');
    const user = await getStandardUser();
    if (!user.password) { test.skip(); return; }
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('greets with the intake, collects fields across turns, confirms, and hands off', async ({ page }) => {
    // 1. Create a standard-tier conversation. With onboarding enabled the
    //    on-join welcome IS the intake greeting + the first field's question.
    await createConversation(page, 'Onboarding Intake', 'Claude Sonnet');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const welcome = ((await page.locator('.assistant-message .message-text').first().textContent()) || '').toLowerCase();
    expect(welcome, 'the on-join welcome should be the intake, asking the first field (company)').toContain('company');

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

    // 4. Confirm -> intake completes and hands off to the working assistant.
    const done = await sendAndWaitForResponse(page, 'yes', 60000, ws);
    expect(done.text.toLowerCase(), 'confirming should complete the intake and hand off').toMatch(/all set|how can i help/);

    cons.assertNoErrors();
  });
});
