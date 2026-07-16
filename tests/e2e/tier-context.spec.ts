/**
 * Tier context + IAM boundary E2E - the demo's core value.
 *
 * Proves the SPEC-DEMO-COMPANY tiering: the SAME question about Stratum is answered
 * differently by tier, because each tier's assistant reads only its own S3 context
 * prefix (enforced by IAM on the tier's async-processor role, not by the prompt).
 * Stratum is a FICTIONAL company, so the model can only know its financials/people
 * from the seeded context - which makes the IAM boundary the thing that decides
 * whether a tier can answer. A negative assertion (no `$4.2M`) therefore proves the
 * lower tier genuinely could not read the higher tier's data.
 *
 * REQUIRES the demo to be seeded first (`seed-demo.ts` uploads the Stratum context)
 * and the Stratum persona (`-c assistantSystemPrompt=...`). Run via `npm run validate`,
 * which seeds before this spec. Skipped when a tier's test user has no password.
 */
import { test, expect } from '@playwright/test';
import {
  signIn,
  createConversation,
  sendAndWaitForResponse,
  assertBotResponse,
  validateResponse,
  logResult,
  WebSocketMonitor,
  ConsoleMonitor,
} from './helpers/agent-helpers';
import { getBasicUser, getStandardUser, getPremiumUser } from './helpers/test-credentials';

// Grounded in the seeded context files:
//  - premium/financial-data.json: annualRecurringRevenue.current = "$4.2M"
//  - standard/employee-directory.json: "Priya Patel", "VP Engineering"
//  - basic/company-public.json: has neither
const ARR_Q = 'What was Stratum Technologies Q2 ARR? Give the exact figure if you have it.';
const LEAD_Q = 'Who leads the platform engineering team at Stratum? Name them if you know.';
const ARR_FIGURE = '4.2'; // "$4.2M"
const LEAD_NAME = 'priya'; // Priya Patel

// The conversation's classification (the assistant chosen at creation) is a real
// tier boundary: effective tier = min(userTier, channelTier). A premium USER in a
// basic (Claude Haiku) conversation gets BASIC access. So each tier's test must
// open a conversation with its OWN tier's assistant, not always Haiku, or it only
// ever exercises basic tier. (Premium = Claude Opus, Standard = Claude Sonnet,
// Basic = Claude Haiku.)
async function ask(
  page: import('@playwright/test').Page,
  ws: WebSocketMonitor,
  title: string,
  q: string,
  assistant = 'Claude Haiku',
) {
  await createConversation(page, title, assistant);
  await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
  return sendAndWaitForResponse(page, q, 60000, ws);
}

test.describe.serial('Tier context - Premium (full access)', () => {
  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getPremiumUser();
    if (!user.password) { test.skip(); return; }
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('premium CAN access financial data (ARR)', async ({ page }) => {
    const r = await ask(page, ws, 'Tier Premium ARR', ARR_Q, 'Claude Opus');
    assertBotResponse(r, 'premium-arr');
    const issues = validateResponse(r.text, { mustContainAny: [ARR_FIGURE] });
    logResult('premium-arr', r, [], issues);
    expect(issues, 'premium tier should surface the $4.2M ARR from premium/financial-data.json').toHaveLength(0);
    cons.assertNoErrors();
  });
});

test.describe.serial('Tier context - Standard (internal ops, no financials)', () => {
  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getStandardUser();
    if (!user.password) { test.skip(); return; }
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('standard CAN name leadership (employee directory)', async ({ page }) => {
    const r = await ask(page, ws, 'Tier Standard Lead', LEAD_Q, 'Claude Sonnet');
    assertBotResponse(r, 'standard-lead');
    const issues = validateResponse(r.text, { mustContainAny: [LEAD_NAME, 'Patel'] });
    logResult('standard-lead', r, [], issues);
    expect(issues, 'standard tier should name Priya Patel from standard/employee-directory.json').toHaveLength(0);
    cons.assertNoErrors();
  });

  test('standard CANNOT access financials (IAM boundary below the prompt)', async ({ page }) => {
    const r = await ask(page, ws, 'Tier Standard ARR', ARR_Q, 'Claude Sonnet');
    assertBotResponse(r, 'standard-arr');
    // No premium/* access -> cannot produce the fictional ARR figure.
    expect(r.text.toLowerCase(), 'standard tier must not surface premium financial data').not.toContain(ARR_FIGURE);
    cons.assertNoErrors();
  });
});

test.describe.serial('Tier context - Basic (public only)', () => {
  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getBasicUser();
    if (!user.password) { test.skip(); return; }
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('basic CANNOT access financials (IAM boundary)', async ({ page }) => {
    const r = await ask(page, ws, 'Tier Basic ARR', ARR_Q);
    assertBotResponse(r, 'basic-arr');
    expect(r.text.toLowerCase(), 'basic tier must not surface premium financial data').not.toContain(ARR_FIGURE);
    cons.assertNoErrors();
  });

  test('basic CANNOT name internal leadership (no employee directory)', async ({ page }) => {
    const r = await ask(page, ws, 'Tier Basic Lead', LEAD_Q);
    assertBotResponse(r, 'basic-lead');
    expect(r.text.toLowerCase(), 'basic tier must not surface the internal employee directory').not.toContain(LEAD_NAME);
    cons.assertNoErrors();
  });
});
