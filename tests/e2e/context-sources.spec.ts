/**
 * Context source catalog E2E (SPEC-CONTEXT-SOURCES-AND-STORES).
 *
 * The catalog shipped with unit and synth coverage only, so nothing had ever exercised the deployed
 * path: a real turn, through the real UI, resolving a real source against the published catalog with
 * the real IAM grant behind it.
 *
 * WHY THIS ASSERTS ON A METRIC AND NOT ONLY ON THE REPLY. A context source's whole visible effect is
 * that the answer is better grounded, and three separate mechanisms feed the same prompt: the context
 * source catalog, RAG retrieval, and the company-context tool. A UI assertion cannot tell them apart,
 * so "the assistant answered correctly" would pass with the catalog completely inert - which is
 * exactly the state this feature was in before it was wired, and exactly the kind of green-but-blind
 * test this repo keeps finding. `AgentEchelon/ContextSources` is emitted by the resolver and by
 * nothing else, so a datapoint is proof the deployed path ran for THIS turn.
 *
 * The console and backend guards are not decoration either: a source that fails resolves to a missing
 * section and the turn still succeeds, so a broken catalog looks like a healthy conversation from the
 * outside. The backend guard is what sees the difference.
 */
import { test, expect } from '@playwright/test';
import {
  signIn,
  createConversation,
  sendAndWaitForResponse,
  WebSocketMonitor,
  ConsoleMonitor,
} from './helpers/agent-helpers';
import { getStandardUser, getAdminUser, missingUserReason } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { execSync } from 'node:child_process';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import {
  waitForOutcome,
  sumOutcome,
  metricCheckEnabled,
  METRIC_CHECK_DISABLED,
} from './helpers/context-source-metrics';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


/** The reference deployment's standard profile selects `company-docs`. */
const CLASSIFICATION = 'standard';
const SOURCE_KEY = 'company-docs';
const MANAGE_PROFILES_API = (process.env.VITE_MANAGE_PROFILES_API_URL || '').replace(/\/$/, '');

/** The version the `active` label points at for the standard profile — the suite's restore target. */
function activeStandardVersion(): number | null {
  try {
    const raw = execSync(
      'aws ssm get-parameter-history --region ' + (process.env.AWS_REGION || 'us-east-1')
      + ' --name "/agent-echelon/assistant/' + CLASSIFICATION + '/definition"'
      + ' --query "Parameters[?Labels!=null].{v:Version,labels:Labels}" --output json',
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    const rows = JSON.parse(raw) as Array<{ v: number; labels: string[] }>;
    const active = rows.filter((r) => (r.labels ?? []).includes('active')).map((r) => r.v);
    return active.length ? Math.max(...active) : null;
  } catch {
    return null;
  }
}

test.describe.serial('context sources reach a live turn', () => {
  guardBackendErrors('context-sources');

  let wsMonitor: WebSocketMonitor;
  let consoleMonitor: ConsoleMonitor;
  let turnStartedAt = 0;
  /** The profile version active before this suite selected its source — the restore target. */
  let originalActiveVersion: number | null = null;

  /**
   * SELECT the source this suite asserts on, instead of assuming somebody already did.
   *
   * The deployment PUBLISHES `company-docs` in the standard catalog, but nothing SELECTS it: not the
   * seeder, not this spec. A profile only carries `contextSources` when an operator sets it, so on a
   * fresh deployment this suite failed with "the catalog did not run", and on this one it passed
   * until ordinary profile version churn - the profile e2e clones, activates and rolls back the same
   * `standard` profile - dropped the selection. Measured directly: the active version carried
   * `contextSources: undefined`, and CloudWatch held no datapoint for the dimension set in hours.
   *
   * That failure names the product ("the catalog did not run: the profile may not select the key")
   * for what is really an unmet precondition, which is the most expensive kind of red: it sends the
   * reader into the resolver looking for a defect that is not there. Establishing the precondition
   * makes the test self-sufficient and portable to any deployment, which is the point of an OSS suite.
   */
  test.beforeAll(async ({ browser }) => {
    const admin = await getAdminUser();
    if (!admin.password || !MANAGE_PROFILES_API) return; // the per-test skip states the reason
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, admin.email, admin.password);
      const idToken = (await page.evaluate(() => localStorage.getItem('idToken')))!;
      const post = (action: string, body: unknown) =>
        signedAnalyticsPost(`${MANAGE_PROFILES_API}${action}`, idToken, body);

      originalActiveVersion = activeStandardVersion();
      await post('/version', { profileName: CLASSIFICATION });
      await post('/draft', { profileName: CLASSIFICATION, patch: { contextSources: [SOURCE_KEY] } });
      const activated = await post('/activate', { profileName: CLASSIFICATION });
      expect(
        activated?.version,
        `could not select '${SOURCE_KEY}' on the ${CLASSIFICATION} profile: ${JSON.stringify(activated)}`,
      ).toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  // Put the pointer back, so this suite does not leave the shared profile carrying its selection.
  test.afterAll(async ({ browser }) => {
    if (!originalActiveVersion || !MANAGE_PROFILES_API) return;
    const admin = await getAdminUser();
    if (!admin.password) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, admin.email, admin.password);
      const idToken = (await page.evaluate(() => localStorage.getItem('idToken')))!;
      await signedAnalyticsPost(`${MANAGE_PROFILES_API}/rollback`, idToken, {
        profileName: CLASSIFICATION,
        version: originalActiveVersion,
      }).catch(() => { /* teardown must not fail a green suite; the next run re-selects anyway */ });
    } finally {
      await ctx.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));
    wsMonitor = new WebSocketMonitor();
    consoleMonitor = new ConsoleMonitor();
    await signIn(page, user.email, user.password, wsMonitor, consoleMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('a real turn RESOLVES the selected source, and says so in CloudWatch', async ({ page }) => {
    test.setTimeout(300_000); // the turn, plus EMF ingestion latency on the metric poll

    turnStartedAt = Date.now() - 60_000; // lead-in: the handler clock is not ours
    await createConversation(page, 'E2E Context Sources', 'Claude Sonnet');

    // A question that has to be answered from company knowledge rather than general knowledge.
    // Stratum is fictional, so an ungrounded model has nothing to say.
    //
    // Deliberately a DOMAIN question, not a question about the assistant's own capabilities. Asking
    // "what context do you have access to?" reads as system-probing and the output guardrail blocks
    // it - which was the first version of this test, and it passed anyway because a blocked reply is
    // still a non-empty reply.
    const reply = await sendAndWaitForResponse(
      page,
      'Who leads the engineering team at Stratum Technologies, and what is on the product roadmap?',
      120_000,
      wsMonitor,
    );

    const text = reply?.text ?? '';
    console.log(`\n--- reply ---\n${text.slice(0, 400)}`);

    expect(text.length, 'the turn must produce a reply at all').toBeGreaterThan(0);

    // A guardrail block is not an answer. Without this the spec goes green while every turn is
    // refused - the reply is non-empty, the metric still fires, and nothing says the assistant is
    // not actually working.
    expect(
      text,
      'the turn was BLOCKED by a guardrail rather than answered. The metric assertions below would '
      + 'still pass, so this is asserted explicitly.',
    ).not.toMatch(/I cannot process that request/i);

    // The console must be clean for the turn the assertion below is about.
    consoleMonitor.assertNoErrors();

    if (!metricCheckEnabled()) {
      // Never silently: a run without credentials would otherwise report a pass having checked the
      // one thing that distinguishes this feature from the two that look identical to it.
      throw new Error(
        'context source metric check needs AWS credentials (AWS_PROFILE or AWS_ACCESS_KEY_ID). '
        + 'Without them this spec cannot tell a resolved source from an inert catalog.',
      );
    }

    const resolved = await waitForOutcome({
      classification: CLASSIFICATION,
      outcome: 'resolved',
      sourceKey: SOURCE_KEY,
      metricName: 'ContextSourceResolved',
      sinceEpochMs: turnStartedAt,
    });

    expect(
      resolved,
      `no ContextSourceResolved datapoint for '${SOURCE_KEY}' at ${CLASSIFICATION}. The turn `
      + 'succeeded, so this means the catalog did not run: the profile may not select the key, the '
      + 'published catalog may be unreadable, or the source failed. Check the processor log group '
      + 'for "[context-sources] applied" and for a (catalog) failure.',
    ).toBeGreaterThan(0);
  });

  test('nothing was DENIED while resolving it', async () => {
    test.setTimeout(120_000);
    test.skip(!metricCheckEnabled(), METRIC_CHECK_DISABLED);

    // `denied` is the one outcome that means a boundary refused a read. It should be zero in steady
    // state, and after a deploy that changed the processor's S3 grants it is worth asserting rather
    // than assuming - a wrong grant would still let the turn succeed, just without that section.
    const denied = await sumOutcome({
      classification: CLASSIFICATION,
      outcome: 'denied',
      metricName: 'ContextSourceFailed',
      sinceEpochMs: turnStartedAt || Date.now() - 15 * 60_000,
    });

    expect(
      denied,
      'a context source read was DENIED. The IAM grant and the published locator/prefix disagree, '
      + 'or a grant was removed. Compare the live processor role policy with the published catalog.',
    ).toBe(0);
  });

  test('the catalog parameter itself was readable', async () => {
    test.setTimeout(120_000);
    test.skip(!metricCheckEnabled(), METRIC_CHECK_DISABLED);

    // The `(catalog)` pseudo-key means the catalog PARAMETER could not be read, which takes out every
    // source at once. It is counted separately precisely because it used to be invisible - a missing
    // ssm:GetParameter grant read as "the profile names a key that does not exist".
    const catalogFailures = await sumOutcome({
      classification: CLASSIFICATION,
      outcome: 'denied',
      sourceKey: '(catalog)',
      metricName: 'ContextSourceFailed',
      sinceEpochMs: turnStartedAt || Date.now() - 15 * 60_000,
    });

    expect(
      catalogFailures,
      'the context source CATALOG parameter could not be read - every source is gone at once. The '
      + 'processor is missing ssm:GetParameter on .../assistant/standard/context-sources.',
    ).toBe(0);
  });
});
