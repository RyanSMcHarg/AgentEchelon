/**
 * Experiment results are trustworthy FOR EVERY EXPERIMENT TYPE (DESIGN-EXPERIMENTS-BATTLE §4.3).
 *
 * `experiments.spec.ts` already proves the drill-down reproduces the aggregate — for ONE type. That
 * is not enough, because each type binds traffic by a different rule, and the drill-down's whole
 * claim is that it resolves to EXACTLY the set that was scored:
 *
 *   intent            matches on the normalized route key, and OUTRANKS base/profile
 *                     (experiment-manager.ts:353)
 *   base_model        any live experiment on the classification, intent-agnostic  (:358)
 *   profile           same rule, but each variant is a whole profile version
 *   classification    a separate resolver; changes the CLASSIFIER, not the responder  (:385)
 *
 * A predicate that is right for one of those can be wrong for another, and the failure is silent: an
 * operator sees a populated table either way. So each type gets its own test.
 *
 * **Validated through the ADMIN CONSOLE, not the API.** The API-level check lives in
 * `experiments.spec.ts`; what an operator actually trusts is the number on screen and the view's own
 * statement that it reconciles. This drives the real UI: read the displayed sample, open the
 * drill-down, and require the console to say "Matches the result above".
 *
 * Gated by EXPERIMENTS_E2E=1. Types run SEQUENTIALLY: a classification experiment conflicts with any
 * other on the same classification (409), and a live `intent` experiment outranks a `base_model` one
 * on a matching turn, so overlapping runs would attribute each other's traffic.
 */
import { test, expect } from './helpers/fixtures';
import { request as pwRequest, type Page } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf, WebSocketMonitor } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signedAnalyticsPost, signedAdminGet, signedAdminContext, type SignedAdminContext } from './helpers/signed-analytics';
import { retireStrandedE2eExperiments } from './helpers/experiment-sweep';
import { defaultProfileRegistry } from '../../backend/lib/profile-registry';
import { ADMIN_API_URL, adminApiServes, adminUrl } from './helpers/api-urls';

type ProfileRef = { profileName: string; version?: number };

guardConsoleErrors();

const RUN = process.env.EXPERIMENTS_E2E === '1';
const suite = RUN ? test.describe.serial : test.describe.skip;

const EXPERIMENTS_API = adminApiServes('experiments') ? adminUrl('assistant-admin', '/admin/experiments') : '';
const CHAT_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || CHAT_BASE_URL;
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';
const PROFILES_API = ADMIN_API_URL ? adminUrl('assistant-admin', '/admin/profiles') : '';

/**
 * Prompts that classify to `general` take the `general` route, so an intent experiment on it binds them.
 *
 * EIGHT, not four. The console only renders the head-to-head comparison — and therefore the sample
 * row and its drill-down control — once BOTH variants have traffic; with a 50/50 split, four
 * independent turns leave a 1-in-8 chance that one variant is never assigned, and the test then fails
 * on a view that is behaving correctly. Eight puts that at ~0.4%.
 */
const GENERAL_QA_PROMPTS = [
  'One sentence: what is a feature flag?',
  'One sentence: what is a canary deploy?',
  'One sentence: what is a rollback?',
  'One sentence: what is idempotency?',
  'One sentence: what is a circuit breaker?',
  'One sentence: what is exponential backoff?',
  'One sentence: what is a blue-green deploy?',
  'One sentence: what is p95 latency?',
];

interface TypeCase {
  /** Test name suffix. */
  label: string;
  experimentType: 'base_model' | 'intent' | 'profile' | 'classification';
  /** Build the create payload. `profiles` is whatever the deployment has, for the profile case. */
  draft: (id: string, profiles: ProfileRef[]) => Record<string, unknown>;
  /** How many profiles this type needs before it can run at all. */
  needsProfiles?: number;
  /**
   * Every driven prompt binds to this type, so the rollup owes all of them. False where binding
   * depends on the turn (its intent, whether the classifier ran), and the rollup then owes the turns
   * that declared the experiment on their reply.
   */
  everyPromptBinds: boolean;
}

const TYPES: TypeCase[] = [
  {
    label: 'base_model (every premium turn binds)',
    everyPromptBinds: true,
    experimentType: 'base_model',
    draft: (id) => ({
      experimentId: id,
      name: `Trust ${id}`,
      experimentType: 'base_model',
      status: 'active',
      tiers: ['premium'],
      variants: [
        { variantId: 'control', weight: 50 },
        { variantId: 'treatment', weight: 50, modelKey: 'sonnet' },
      ],
    }),
  },
  {
    label: 'intent (only its own intent binds)',
    everyPromptBinds: false,
    experimentType: 'intent',
    draft: (id) => ({
      experimentId: id,
      name: `Trust ${id}`,
      experimentType: 'intent',
      status: 'active',
      tiers: ['premium'],
      // The experiment stores the ROUTE KEY; the exchange stores the classifier intent ('general').
      // They differ on purpose, which is why the drill-down keys on experiment_id and not on intent.
      intent: 'general',
      variants: [
        { variantId: 'control', weight: 50 },
        { variantId: 'treatment', weight: 50, modelKey: 'sonnet' },
      ],
    }),
  },
  {
    // The type that was attributed to NOTHING until the router threaded the classifier ids onto the
    // turn. Two things stay true about it even now, and both are honest:
    //  - BOTH variants answer with the same response model, so `avg_score` compares a model against
    //    itself. Its real evidence is the §5 gate, not this table.
    //  - Only turns the LLM classifier actually ran on are attributed; a greeting takes the fast path
    //    and the variant did nothing, so it is correctly absent from the set.
    label: 'classification (only turns the classifier actually ran on)',
    everyPromptBinds: false,
    experimentType: 'classification',
    draft: (id) => ({
      experimentId: id,
      name: `Trust ${id}`,
      experimentType: 'classification',
      status: 'active',
      tiers: ['premium'],
      intent: '',
      // A classification experiment measures the classifier, so its objective metric is `accuracy`.
      objective: { metric: 'accuracy', target: 5, statement: 'Trust check: classifier attribution reaches the rollup.' },
      variants: [
        { variantId: 'control', weight: 50 },
        { variantId: 'treatment', weight: 50, modelKey: 'sonnet' },
      ],
    }),
  },
  {
    label: 'profile (each variant is a whole profile version)',
    everyPromptBinds: true,
    experimentType: 'profile',
    needsProfiles: 2,
    draft: (id, profiles) => ({
      experimentId: id,
      name: `Trust ${id}`,
      experimentType: 'profile',
      status: 'active',
      tiers: ['premium'],
      variants: [
        { variantId: 'control', weight: 50, profileRef: profiles[0] },
        { variantId: 'treatment', weight: 50, profileRef: profiles[1] },
      ],
    }),
  },
];

suite('experiment results reconcile in the console, per experiment type', () => {
  guardBackendErrors('experiment-results-trust');

  let creds: TestCredentials;

  test.beforeAll(async ({ browser }) => {
    creds = await getTestCredentials();
    expect(EXPERIMENTS_API, 'VITE_ADMIN_API_CAPABILITIES must name experiments').toBeTruthy();

    // SWEEP FIRST, do not rely on teardown alone: a run killed before its teardown leaves its
    // experiment live, and the classification then refuses this run's create (one live experiment
    // each, §3.2.1). Every `e2e-` id, not only this spec's: the stranded one that cost a run was not.
    const page = await browser.newPage();
    try {
      await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
      const idToken = await idTokenOf(page);
      const api = signedAdminContext(idToken!);
      await retireStrandedE2eExperiments(api, EXPERIMENTS_API, { label: 'trust' });
      await api.dispose();
    } finally {
      await page.close().catch(() => undefined);
    }
  });

  /**
   * Drive N premium turns, and count the ones that declared THIS experiment on their own reply.
   *
   * The reply's Metadata carries the `experimentId` the turn was assigned under, so the count is the
   * turn's own statement rather than the rollup's: the number the rollup is then waited for, not a number
   * read back from it.
   */
  async function driveTraffic(page: Page, tag: string, experimentId: string, monitor: WebSocketMonitor): Promise<number> {
    let bound = 0;
    for (let i = 0; i < GENERAL_QA_PROMPTS.length; i++) {
      await createConversation(page, `${tag} ${i} ${Date.now()}`, 'Premium');
      const resp = await sendAndWaitForResponse(page, GENERAL_QA_PROMPTS[i], 120_000, monitor);
      expect(resp.text && resp.text.length, `turn ${i} produced a reply`).toBeTruthy();
      if (monitor.lastBotMetadata?.experimentId === experimentId) bound += 1;
    }
    return bound;
  }

  /**
   * Open the console, find this experiment's comparison, and make the VIEW prove itself.
   *
   * The assertion is deliberately the console's own reconciliation verdict rather than a number this
   * test computes: that banner is what an operator reads before shipping, and it is the thing that
   * must not be able to say "reconciles" while the sets differ.
   */
  /**
   * Wait until the rollup actually has rows for this experiment.
   *
   * The console fetches analytics once when it mounts, so opening it before archival and pairing have
   * landed shows an empty table that never fills — the test would then be waiting on a page that is
   * never going to change. Poll the API first, then load the console once against settled data.
   */
  async function waitForRows(idToken: string, experimentId: string, page: Page, expected: number) {
    const end = new Date();
    const dateRange = { start: new Date(end.getTime() - 86_400_000).toISOString(), end: end.toISOString() };
    // Wait for BOTH variants, not merely for rows: the console renders the head-to-head comparison
    // only when control and treatment have both recorded traffic, so settling on one variant would
    // hand the UI assertion a view that legitimately has no sample row to show.
    // 300s, not 150. The LAST type in a serial run settles behind ~24 turns' worth of archival and
    // pairing already in the pipeline, and the same test that settles in well under a minute on its
    // own can miss a 150s window at the end of the run. A short window here fails as
    // "the split never assigned the second variant", which points at the product rather than at lag.
    //
    // AND FOR EVERY TURN, SETTLED. Two visible variants is not a settled rollup: the drill-down the
    // console opens is read later than the aggregate above it, so a turn that lands between the two reads
    // makes them differ and the reconciliation banner reports a mismatch that is only lag. So the wait
    // also requires the summed `exchange_count` to reach the number of turns this experiment owns, and to read the
    // same on the next poll.
    let seen = new Set<string>();
    let total = 0;
    let previous = -1;
    let stable = false;
    for (let i = 0; i < 60; i++) {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken, { queryType: 'experiment_results', dateRange });
      const rows = (j.data || []).filter((x: any) => (x.experiment_id ?? x.experimentId) === experimentId);
      seen = new Set(rows.map((r: any) => String(r.variant_id ?? r.variantId ?? '')).filter(Boolean));
      total = rows.reduce((n: number, r: any) => n + Number(r.exchange_count ?? r.exchangeCount ?? 0), 0);
      stable = total === previous;
      if (seen.size >= 2 && total >= expected && stable) return rows;
      previous = total;
      await page.waitForTimeout(5000);
    }
    throw new Error(
      `${experimentId}: after 300s ${seen.size} variant(s) recorded traffic (saw [${[...seen].join(', ')}]) and `
      + `${total} of the ${expected} turns this experiment owns were counted${stable ? '' : ', still changing'}. `
      + 'Either the turns did not bind to this experiment, the split never assigned the second variant, or '
      + 'archival and pairing had not caught up.',
    );
  }

  async function validateInConsole(adminPage: Page, experimentId: string) {
    // signIn navigates to the CONTEXT's baseURL, so the admin context must be created with the admin
    // origin — otherwise this signs into the chat app and then waits forever for an admin rail.
    await signIn(adminPage, creds.testAdmin.email, creds.testAdmin.password);
    await adminPage.locator('.admin-section-rail button:has-text("Experiments")').click();

    const compare = adminPage.locator('.exp-compare').filter({ hasText: experimentId });
    await expect(compare, `the console shows a comparison for ${experimentId}`).toBeVisible({ timeout: 60_000 });

    // The sample row is the aggregate the drill-down has to reproduce.
    //
    // NAMED BY ITS LABEL, because `.exp-metric-row--sample` is no longer unique. A second row carrying
    // the same class was added later - "Scored by the evaluator", which is deliberately a different
    // number from traffic - so this resolved to two elements and Playwright's strict mode failed the
    // spec. It went unnoticed because no validate phase invoked this file: the console moved on and the
    // spec did not, which is what an unrun test does.
    const sampleRow = compare.locator('.exp-metric-row--sample')
      .filter({ hasText: /Sample \(exchanges\)/i });
    await expect(sampleRow, 'the head-to-head shows the exchange sample for both variants').toBeVisible();
    // Both variants' counts, not just the label - the label is how the row was found, so asserting it
    // again would prove only that the filter worked.
    const sampleText = (await sampleRow.innerText()).replace(/\s+/g, ' ');
    expect(
      (sampleText.match(/\d[\d,]*/g) || []).length,
      `the sample row carries a count for each variant (got "${sampleText}")`,
    ).toBeGreaterThanOrEqual(2);

    // Open the exchanges behind the control variant.
    const drillBtn = sampleRow.locator('button.exp-drill-btn').first();
    await expect(drillBtn, 'a "show exchanges" control is offered for a variant with traffic').toBeVisible();
    await drillBtn.click();

    // THE ASSERTION: the console itself states the drill-down reproduces the number above it.
    const recon = compare.locator('.exp-drill-recon');
    await expect(recon).toBeVisible({ timeout: 30_000 });
    await expect(
      recon,
      `${experimentId}: the console must state the drill-down reconciles with the aggregate`,
    ).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
    await expect(recon).toContainText(/Matches the result above/i);

    // And the panel must say WHICH population it is showing — an unlabelled set is not evidence.
    await expect(compare.locator('.exp-drill-population')).toContainText(/Randomly assigned turns only/i);
  }

  async function completeExperiment(api: SignedAdminContext, id: string) {
    await api
      .post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), { data: { status: 'completed' } })
      .catch(() => undefined);
  }

  for (const spec of TYPES) {
    test(`${spec.experimentType}: ${spec.label}`, async ({ browser, page }) => {
      test.setTimeout(15 * 60_000);

      await page.goto(CHAT_BASE_URL);
      // THE MONITOR READS EACH REPLY'S OWN METADATA, which names the experiment the turn was assigned under.
      const wsMonitor = new WebSocketMonitor();
      await signIn(page, creds.testAdmin.email, creds.testAdmin.password, wsMonitor);
      const idToken = await idTokenOf(page);
      expect(idToken, 'admin idToken in localStorage').toBeTruthy();
      const api = signedAdminContext(idToken!);

      // A profile experiment needs real profiles. Resolve them rather than assuming, and fail with a
      // message naming what is missing — a silent skip would read as coverage this type does not have.
      let profiles: ProfileRef[] = [];
      if (spec.needsProfiles) {
        // SIGNED, not Bearer. The profiles GET is IAM-authorized, like every admin route, so a
        // JWT gets 403 — and a naive `if (ok)` then reports "this deployment has 0 profiles", which
        // is a different and much more misleading claim than "I could not read them". Distinguish the
        // two: a read failure fails on the read.
        const listed = await signedAdminGet(PROFILES_API, idToken!);
        expect(
          listed.status,
          `could not read profiles (HTTP ${listed.status}) — this is a harness/auth failure, not a statement about how many profiles exist`,
        ).toBe(200);
        const arr = listed.body?.profiles ?? listed.body?.data ?? listed.body;
        // ONLY VERSIONS OF THE EXPERIMENT'S OWN CLASSIFICATION. The first two profiles in the listing
        // were taken whatever they served, so a premium experiment ran a standard assistant's version,
        // whose guardrail premium may not apply (measured live 2026-10-13); the experiments API now
        // refuses that. Two premium assistants where there are two, otherwise two VERSIONS of one,
        // which is all a profile experiment compares. Never an alt: it serves only through its battle.
        const classification = (spec.draft('probe', []).tiers as string[])[0];
        const rows = (Array.isArray(arr) ? arr : [])
          .map((p: any) => ({
            name: String(p.profileName ?? p.name ?? ''),
            active: typeof p.activeVersion === 'number' ? p.activeVersion as number : null,
            versions: (Array.isArray(p.versions) ? p.versions : []).map((v: any) => Number(v?.version ?? v)).filter((v: number) => v > 0),
          }))
          .filter((r) => r.name && !r.name.startsWith('alt-') && r.active !== null
            && defaultProfileRegistry.classificationOfAssistant(r.name) === classification);
        const multi = rows.find((r) => r.versions.some((v: number) => v !== r.active));
        profiles = rows.length >= 2
          ? [{ profileName: rows[0].name }, { profileName: rows[1].name }]
          : multi
            ? [{ profileName: multi.name, version: multi.active! }, { profileName: multi.name, version: multi.versions.find((v: number) => v !== multi.active)! }]
            : [];
        expect(
          profiles.length,
          `a profile experiment compares two profile VERSIONS of ${classification} assistants; this deployment has ${rows.length} active ${classification} profile(s) and none with a second version. Seed profiles before running this phase.`,
        ).toBeGreaterThanOrEqual(spec.needsProfiles);
      }

      const id = `e2e-trust-${spec.experimentType}-${Date.now()}`;
      const created = await api.post(EXPERIMENTS_API, { data: spec.draft(id, profiles) });
      expect(created.ok(), `create ${spec.experimentType}: ${created.status()} ${await created.text()}`).toBeTruthy();

      const adminContext = await browser.newContext({ baseURL: ADMIN_BASE_URL });
      const adminPage = await adminContext.newPage();
      try {
        const bound = await driveTraffic(page, `Trust ${spec.experimentType}`, id, wsMonitor);
        // WHAT THE ROLLUP OWES. Where every prompt binds, it owes every driven turn, so the driven count
        // is the target and a turn that failed to bind shows as a shortfall. Where only some prompts bind
        // (an intent, a classifier that ran), it owes the turns that DECLARED this experiment on their
        // own reply, and waiting for all eight would wait for turns that were never this experiment's.
        const expected = spec.everyPromptBinds ? GENERAL_QA_PROMPTS.length : bound;
        console.log(`[trust] ${id}: ${bound} of ${GENERAL_QA_PROMPTS.length} driven turns declared this experiment; the rollup owes ${expected}`);
        expect(expected, `${id}: no driven turn declared this experiment on its reply, so there is nothing to reconcile`)
          .toBeGreaterThan(0);
        // Settle first: the console reads analytics once on mount.
        await waitForRows(idToken!, id, page, expected);
        await validateInConsole(adminPage, id);
      } finally {
        // ORDER MATTERS, and this cost a run. Closing the browser context first put a throwing call
        // (`Target page… has been closed`, after a test timeout) ahead of the completion, so the
        // experiment stayed ACTIVE — and because resolution takes the FIRST live experiment, it then
        // captured the next run's traffic and that run reported "no rows" for its own id. Retire the
        // experiment first, and let no single cleanup failure skip another.
        await completeExperiment(api, id);
        await adminContext.close().catch(() => undefined);
        await api.dispose().catch(() => undefined);
      }
    });
  }

});
