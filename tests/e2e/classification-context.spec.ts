/**
 * Classification context + IAM boundary E2E - the demo's core value.
 *
 * Proves the SPEC-DEMO-COMPANY tiering: the SAME question about Stratum is answered
 * differently by tier, because each tier's assistant reads only its own S3 context
 * prefix (enforced by IAM on the classification's acting role, not by the prompt).
 * Stratum is a FICTIONAL company, so the model can only know its financials/people
 * from the seeded context - which makes the IAM boundary the thing that decides
 * whether a classification can answer. A negative assertion (no `$4.2M`) therefore proves a
 * classification not granted that data genuinely could not read it.
 *
 * REQUIRES the demo to be seeded first (`seed-demo.ts` uploads the Stratum context)
 * and the Stratum persona (`-c assistantSystemPrompt=...`). Run via `npm run validate`,
 * which seeds before this spec. Skipped when a tier's test user has no password.
 */
import { test, expect } from './helpers/fixtures';
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
import { getBasicUser, getStandardUser, getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors, allowConsoleError } from './helpers/turn-guards';
import {
  NO_AWS_REASON, awsReachable, actingRole, botFor, decide, sessionContext, processorRoleArn, contextBucket,
} from './helpers/assistant-acting-role';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();

// ─────────────────────────────────────────────────────────────────────────────
// The IAM boundary, asserted as IAM.
//
// Every test below this block infers the boundary from what the MODEL said - "standard did not
// utter $4.2M, therefore standard cannot read premium context". That is the consequence, not the
// cause, and it is a weak proxy in both directions: a model can decline to repeat a figure it CAN
// read (false pass), and a refusal for an unrelated reason reads identically to a working boundary.
//
// The read is made on the assistant's session: the classification's acting role, tagged by the vend
// with the assistant's `role`. Company context is granted per assistant role (`RoleContextRead<Slug>`,
// conditioned on `aws:PrincipalTag/role`), so the principal asserted here is the acting role WITH the
// tags a primary session carries. The processor's own role is bootstrap only and reads none.
//
// `simulate-principal-policy` evaluates the real deployed policy, boundary included, and answers
// allowed / implicitDeny / explicitDeny. It costs one API call, needs no model turn, and cannot be
// satisfied by a model that simply chose not to answer.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Classification context - the IAM boundary itself', () => {
  test('each classification can read its own context prefix and NOT the ones above it', async () => {
    test.setTimeout(180_000);
    test.skip(!awsReachable(), NO_AWS_REASON);

    const CLASSIFICATIONS = [
      { name: 'basic', canRead: ['basic'], cannotRead: ['standard', 'premium'] },
      { name: 'standard', canRead: ['basic', 'standard'], cannotRead: ['premium'] },
      { name: 'premium', canRead: ['basic', 'standard', 'premium'], cannotRead: [] },
    ];

    const violations: string[] = [];

    for (const c of CLASSIFICATIONS) {
      const acting = actingRole(c.name);
      expect(acting, `no deployed ${c.name} acting role`).toBeTruthy();
      const processor = processorRoleArn(c.name);
      const bucket = contextBucket(c.name);
      expect(processor && bucket, `could not read the ${c.name} processor role and context bucket`).toBeTruthy();
      // A real primary bot when one is assigned. The context grant does not compare the bot, so a
      // placeholder keeps the session's tag set the same shape without changing the answer.
      const primarySession = sessionContext(c.name, 'primary', botFor(c.name, 'primary')?.botId || 'primary-probe-bot');

      const read = (principal: string, prefix: string, context: string[]): string =>
        decide(principal, 's3:GetObject', `arn:aws:s3:::${bucket}/context/${prefix}/probe.json`, context);

      for (const prefix of c.canRead) {
        const d = read(acting!.arn, prefix, primarySession);
        if (d !== 'allowed') violations.push(`${c.name} primary session CANNOT read context/${prefix}/ (${d}) - it should`);
      }
      for (const prefix of c.cannotRead) {
        const d = read(acting!.arn, prefix, primarySession);
        if (d === 'allowed') {
          violations.push(
            `${c.name} primary session CAN read context/${prefix}/ - the classification boundary is OPEN. Every `
            + 'model-output assertion in this file would still pass, because a model that simply '
            + 'chose not to quote the figure looks identical to one that could not reach it.',
          );
        }
      }
      for (const prefix of ['basic', 'standard', 'premium']) {
        const d = read(processor!, prefix, []);
        if (d === 'allowed') violations.push(`${c.name} processor role CAN read context/${prefix}/ - it must read none`);
      }
      console.log(`[iam-boundary] ${c.name}: primary session reads ${c.canRead.join('+')}, denied ${c.cannotRead.join('+') || '(none)'}; processor reads none`);
    }

    expect(violations, 'the deployed IAM boundary does not match the classification model').toEqual([]);
  });
});


// Grounded in the seeded context files:
//  - premium/financial-data.json: annualRecurringRevenue.current = "$4.2M"
//  - standard/employee-directory.json: "Priya Patel", "VP Engineering"
//  - basic/company-public.json: has neither
const ARR_Q = 'What was Stratum Technologies Q2 ARR? Give the exact figure if you have it.';
const LEAD_Q = 'Who leads the platform engineering team at Stratum? Name them if you know.';
const ARR_FIGURE = '4.2'; // "$4.2M"

// LEAD_Q has TWO defensible answers in the directory, and the assistant gives either: Priya Patel is
// VP Engineering, and David Kim is the Principal Engineer whose `team` is literally "Platform Core".
// Asserting on "priya" alone measured the wrong thing in both directions. A live reply reads:
//
//   "David Kim leads the Platform Core engineering team ... Reports to: Priya Patel (VP Engineering)"
//
// which PASSED on the incidental reporting line while the headline answer named someone else - so the
// test would also have FAILED a perfectly grounded reply that omitted that line. Either way the
// number it produced was not a grounding rate. Accept either lead.
//
// Both names exist ONLY in standard/employee-directory.json, and Stratum is fictional, so a reply
// containing one cannot have come from model knowledge. That is what makes these names serve as a
// grounding signal here and as a classification-boundary signal in the basic tests below.
const LEAD_ANSWERS = ['priya', 'patel', 'david kim'];

// Every person in the directory. The basic tier must surface NONE of them - asserting only on
// "priya" let a leak through if the model answered with any other name from the same file.
const DIRECTORY_NAMES = [
  'priya', 'patel', 'david kim', 'marcus rivera', 'emma torres', 'raj mehta',
  'sarah chen', 'lin wei', 'james okafor',
];

// The failure this test exists for is a REFUSAL while the answer sits in the prompt - the model
// saying "I don't have specific information about the individuals leading..." with
// employee-directory.json ranked first at similarity 0.615. Naming a lead and not refusing are two
// different assertions, and the refusal is the one with a recorded live failure, so pin it directly
// rather than inferring it from the name check.
const REFUSAL_MARKERS = [
  "don't have specific information", 'do not have specific information',
  "don't have information about", 'no information about',
  'unable to determine', 'not able to determine',
];

// The over-grounding counterweight. `buildRetrievedContextHint` carries BOTH a directive to answer
// FROM the retrieved passages and an escape hatch for irrelevant ones; strengthening the first at
// the cost of the second trades a refusal problem for a fabrication problem. This question is
// answerable by neither prefix a standard user can read: employee-directory.json lists Executive,
// Engineering, Product, Sales and Customer Success and no Legal function, and company-public.json
// names no officers. Retrieval will still rank the directory first - it is the closest thing to a
// "who holds role X" document - so the model IS handed a plausible passage that does not contain
// the answer. Declining is the correct behavior.
const ABSENT_Q = "Who is Stratum Technologies' General Counsel? Give their name if you have it.";

// Assert the FAILURE, not a phrasing of the success.
//
// The first version of this guard whitelisted absence phrases ("not listed", "no record", ...). It
// failed on a live reply that declined perfectly - "the employee directory doesn't list a General
// Counsel or a Legal department at all" - because "doesn't list" was not on the list. That is the same
// defect this file's grounding assertion had: pinning one surface form of a correct answer, so the
// test breaks when the model rephrases and says nothing about whether the behavior is right.
//
// The regression this exists for has ONE observable: the model names a person as the officer the
// corpus does not contain. So assert that directly, and pair it with a deliberately broad negation
// check that any genuine decline satisfies and a bare fabrication ("Stratum's General Counsel is Jane
// Doe.") does not.
//
// Falsified against real and synthetic replies: both live declines pass; "General Counsel is Jane
// Doe", "Jane Doe serves as the General Counsel", and "The General Counsel is Robert Vance, though I
// do not have his email" all fail; and a decline that redirects to a REAL corpus person ("no GC
// listed; contact Sarah Chen") passes.
//
// Still not caught: a fabrication that never puts a name next to the role ("Our top lawyer handles
// that; her name is Jane Doe"). Detecting that needs the grounding measure in
// RECOMMENDATION-CONTEXT-GROUNDING step 4, not a sharper regex.
// The role is matched case-insensitively; the NAME deliberately is not. An `i` flag on the whole
// pattern would let `[A-Z][a-z]+ [A-Z][a-z]+` match any two lowercase words, so every sentence
// containing "is" near the role would read as a fabricated name. Spelling the role's cases out keeps
// the capitalised-name requirement meaningful, which is the only thing distinguishing "the General
// Counsel is not listed" from "the General Counsel is Jane Doe".
const ROLE = '(?:[Gg]eneral [Cc]ounsel|[Cc]hief [Ll]egal [Oo]fficer|\\bGC\\b)';
const NAME = '\\b[A-Z][a-z]+ [A-Z][a-z]+';
const FABRICATED_OFFICER = [
  // "...General Counsel is Jane Doe" / "the GC is Jane Doe"
  new RegExp(`${ROLE}[^.\\n]{0,40}\\bis\\b[^.\\n]{0,15}${NAME}`),
  // "Jane Doe is / serves as / acts as the General Counsel"
  new RegExp(`${NAME}\\b[^.\\n]{0,25}\\b(?:is|serves as|acts as)\\b[^.\\n]{0,25}${ROLE}`),
];
// Any real decline contains one of these; a flat fabrication does not.
// `n't` has no word boundary before it ("doesn't", "isn't"), so it is matched on its own.
const NEGATION = /\b(no|not|none|never|lacks?|absent|unable|without)\b|n't\b/i;

// The conversation's classification (the assistant chosen at creation) is a real
// tier boundary: effective tier = the channel's classification. A premium USER in a
// basic (Claude Haiku) conversation gets BASIC access. So each tier's test must
// open a conversation with its OWN tier's assistant, not always Haiku, or it only
// ever exercises basic tier. (Premium = Claude Opus, Standard = Claude Sonnet,
// Basic = Claude Haiku.)
async function ask(
  page: import('@playwright/test').Page,
  ws: WebSocketMonitor,
  title: string,
  q: string,
  assistant = 'Basic',
) {
  await createConversation(page, title, assistant);
  await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
  return sendAndWaitForResponse(page, q, 60000, ws);
}

test.describe.serial('Classification context - Premium (full access)', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('classification-context');

  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getPremiumUser();
    test.skip(!user.password, missingUserReason('premiumUser'));
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('premium CAN access financial data (ARR)', async ({ page }) => {
    const r = await ask(page, ws, 'Tier Premium ARR', ARR_Q, 'Premium');
    assertBotResponse(r, 'premium-arr');
    const issues = validateResponse(r.text, { mustContainAny: [ARR_FIGURE] });
    logResult('premium-arr', r, [], issues);
    expect(issues, 'premium tier should surface the $4.2M ARR from premium/financial-data.json').toHaveLength(0);
    cons.assertNoErrors();
  });

  // THE INVITE-TIME HALF OF THE BOUNDARY (SPEC-CONVERSATION-SECURITY §4b). The context tests above
  // prove a member not cleared for the classification cannot READ; this proves they are refused at the DOOR - the share
  // Lambda answers 403 TIER_FORBIDDEN rather than admitting a member Layer 1 would render inert.
  //
  // This assertion existed only BY ACCIDENT until 2026-08-18: task-answer.spec.ts shared a premium
  // conversation with the standard user in its SETUP, so every live run exercised the refusal - as an
  // unexplained setup failure. When that spec's setup was fixed, the accidental coverage went with
  // it; this is the deliberate replacement, asserting the refusal as the intended outcome.
  test('a user not cleared for the classification is refused at invite time, not admitted inert', async ({ page }) => {
    const standard = await getStandardUser();
    test.skip(!standard.password, missingUserReason('standardUser'));

    // The refusal IS the test, so its console noise is declared: the share API's 403 and the client's
    // own log of it are this test's expected outcome, not a defect the guard should fail the run for.
    allowConsoleError(/share.*403|status of 403/i);
    allowConsoleError(/Failed to share conversation/i);

    await createConversation(page, `Share gate e2e ${Date.now()}`, 'Premium');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    await page.locator('button[aria-label="Share conversation"]').click();
    await expect(page.locator('#share-email')).toBeVisible({ timeout: 5000 });
    await page.locator('#share-email').fill(standard.email);
    await page.locator('form:has(#share-email) button[type="submit"]').click();

    // The refusal must be EXPLAINED to the person, naming both levels - a silent no-op teaches the
    // sharer the button is broken, and a success would be the security failure this test exists for.
    const refusal = page.locator('.modal-content .alert-error, .modal-content .alert-warning');
    await expect(refusal, 'the share modal explains the refusal').toContainText(
      /does not include the premium tier this conversation requires/i,
      { timeout: 30000 },
    );
    await expect(page.locator('.modal-content .alert-success')).toHaveCount(0);

    // And the member was NOT added: no multi-user member-count badge appears on the conversation.
    await page.locator('.modal-close-btn').click().catch(() => {});
    await expect(page.locator('.conversation-header-btn-count')).toHaveCount(0);
  });
});

test.describe.serial('Classification context - Standard (internal ops, no financials)', () => {
  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));
    ws = new WebSocketMonitor();
    cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  // The IAM boundary assertion runs FIRST. In a serial group a failure skips everything after it,
  // and the grounding tests below are the known-intermittent ones - ordered the other way, a flaky
  // refusal silently takes the security check with it and the run still reads as "1 failure".
  test('standard CANNOT access financials (IAM boundary below the prompt)', async ({ page }) => {
    const r = await ask(page, ws, 'Classification Standard ARR', ARR_Q, 'Standard');
    assertBotResponse(r, 'standard-arr');
    // No premium/* access -> cannot produce the fictional ARR figure.
    expect(r.text.toLowerCase(), 'standard tier must not surface premium financial data').not.toContain(ARR_FIGURE);
    cons.assertNoErrors();
  });

  test('standard CAN name leadership (employee directory)', async ({ page }) => {
    const r = await ask(page, ws, 'Classification Standard Lead', LEAD_Q, 'Standard');
    assertBotResponse(r, 'standard-lead');
    const issues = validateResponse(r.text, {
      mustContainAny: LEAD_ANSWERS,
      mustNotContain: REFUSAL_MARKERS,
    });
    logResult('standard-lead', r, [], issues);
    expect(
      issues,
      'standard tier should ANSWER from standard/employee-directory.json - name a lead and not '
        + `refuse while holding the answer. Reply was: ${r.text.slice(0, 400)}`,
    ).toHaveLength(0);
    cons.assertNoErrors();
  });

  test('standard DECLINES when the corpus does not hold the answer (over-grounding guard)', async ({ page }) => {
    const r = await ask(page, ws, 'Classification Standard Absent', ABSENT_Q, 'Standard');
    assertBotResponse(r, 'standard-absent');
    logResult('standard-absent', r, []);

    const fabricated = FABRICATED_OFFICER.filter((re) => re.test(r.text)).map(String);
    expect(
      fabricated,
      'standard tier invented an officer its corpus does not name - retrieved context must not '
        + `override "never fabricate". Reply was: ${r.text.slice(0, 300)}`,
    ).toEqual([]);

    expect(
      NEGATION.test(r.text),
      'the reply neither declines nor hedges, which reads as asserting a General Counsel exists. '
        + `Reply was: ${r.text.slice(0, 300)}`,
    ).toBe(true);
    cons.assertNoErrors();
  });
});

test.describe.serial('Classification context - Basic (public only)', () => {
  let ws: WebSocketMonitor;
  let cons: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getBasicUser();
    test.skip(!user.password, missingUserReason('basicUser'));
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
    const r = await ask(page, ws, 'Classification Basic Lead', LEAD_Q);
    assertBotResponse(r, 'basic-lead');
    // Every name in the file, not just Priya Patel. A leak that answered "David Kim" - the reply the
    // standard tier actually gives to this question - satisfied a single-name assertion while the
    // whole directory had crossed the boundary.
    const leaked = DIRECTORY_NAMES.filter((n) => r.text.toLowerCase().includes(n));
    expect(
      leaked,
      `basic tier must not surface the internal employee directory. Reply was: ${r.text.slice(0, 400)}`,
    ).toEqual([]);
    cons.assertNoErrors();
  });
});
