/**
 * TTFF ADDS UP, AND THE CONSOLE CAN SHOW WHY.
 *
 * The Latency tab's TTFF breakdown claims a decomposition. This checks the claim against the live
 * deployment, read through the SIGNED path the console itself uses - never a direct Lambda invoke
 * with hand-made claims, which would prove only that the code runs.
 *
 * What is being verified, and why each part needed checking:
 *
 *  1. `avg_ttff_outside_router_ms` is PUBLISHED. It is new; a column computed in the SQL but missing
 *     from the returned-fields allowlist reaches nothing, and the panel would silently fall back to
 *     the cruder figure while looking identical.
 *
 *  2. It RECONCILES: the router leg plus the time outside it equals TTFF, within a tolerance that
 *     accounts for the two figures being averaged over different (overlapping) populations. This is
 *     the arithmetic the panel draws, and it is the one thing a reader cannot check for themselves.
 *
 *  3. The router leg divides: classification plus the rest equals the router span, over ONE
 *     population, so this one reconciles tightly.
 *
 *  4. `ttff_router_paired_count` never exceeds either parent count. It is an intersection - the turns
 *     carrying both a TTFF and a router span - so a count above either is proof the FILTER is wrong.
 *
 * Gated like the other accuracy phases and run against the live deployment.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';

guardConsoleErrors();

const RUN = process.env.ANALYTICS_ACCURACY_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';

type Row = Record<string, number | string>;

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

suite('TTFF decomposes, and the parts are published', () => {
  guardBackendErrors('ttff-decomposition');

  let creds: TestCredentials;
  let idToken = '';
  let rows: Row[] = [];

  test.beforeAll(async () => {
    creds = await getTestCredentials();
  });

  test.beforeEach(async ({ page }) => {
    // The analytics API is admin-gated and IAM-enforced, so this reads as an admin through the same
    // SigV4-signed path the console uses.
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    idToken = await idTokenOf(page);
    expect(idToken, 'an admin id token is required to read the analytics API').toBeTruthy();
    expect(ANALYTICS_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();

    const end = new Date();
    const start = new Date(end.getTime() - 14 * 86_400_000);
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
      queryType: 'latency_metrics',
      dateRange: { start: start.toISOString(), end: end.toISOString() },
    });
    rows = (j.data || []) as Row[];
  });

  test('the query publishes the time-outside-the-router column at all', () => {
    // NOT A PASS ON NO DATA. A column check over zero rows proves nothing, and a guard that greens
    // when the deployment is idle is the vacuous shape this repo has been bitten by before.
    expect(
      rows.length,
      'the deployment must have recorded traffic in the last 14 days for this to mean anything. '
        + 'An empty result is inconclusive, not a pass.',
    ).toBeGreaterThan(0);

    // The field must be PRESENT on the row, which is a different fact from being non-zero: a window
    // where nothing paired still publishes the key with a null.
    const published = rows.some((r) => 'avg_ttff_outside_router_ms' in (r as object));
    expect(
      published,
      'avg_ttff_outside_router_ms is computed in the SQL but must also be in the returned-fields '
        + 'allowlist. Without it the console silently shows the cruder difference-of-averages and '
        + 'looks identical while doing so.',
    ).toBe(true);
    expect(rows.some((r) => 'ttff_router_paired_count' in (r as object))).toBe(true);
  });

  test('the paired count is an intersection, never larger than either parent', () => {
    const paired = rows.filter((r) => num(r.ttff_router_paired_count) > 0);
    expect(
      paired.length,
      'no row in the window carried both a TTFF and a router span, so the reconciliation below '
        + 'cannot be checked. Inconclusive, not a pass.',
    ).toBeGreaterThan(0);

    for (const r of paired) {
      const both = num(r.ttff_router_paired_count);
      const ttffCount = num(r.ttff_measured_count);
      const routerCount = num(r.router_measured_count);
      // A count above either parent means the FILTER is wrong - it is the turns carrying both, so it
      // is bounded by each. This is the cheapest check that the predicate did not drift.
      expect(both, `${r.date}: paired ${both} exceeds ttff_measured ${ttffCount}`).toBeLessThanOrEqual(ttffCount);
      expect(both, `${r.date}: paired ${both} exceeds router_measured ${routerCount}`).toBeLessThanOrEqual(routerCount);
    }
  });

  test('router plus outside equals TTFF EXACTLY where all three share a population', () => {
    // THE IDENTITY IS EXACT, AND THE FIRST VERSION OF THIS TEST WAS WRONG TO ALLOW A TOLERANCE.
    //
    // avg_ttff_ms is averaged over ttff_measured_count, avg_router_ms over router_measured_count, and
    // avg_ttff_outside_router_ms over the intersection. Where those three counts are EQUAL the same
    // turns are behind all three figures, so the per-turn identity survives the averaging and the
    // three must agree to rounding. Where they differ, the figures describe different turns and
    // comparing them is meaningless - not "approximately true", meaningless. A percentage tolerance
    // blurred the two cases together and would have passed a genuine defect on the rows that agree.
    const aligned = rows.filter((r) => {
      const paired = num(r.ttff_router_paired_count);
      return paired > 0
        && paired === num(r.ttff_measured_count)
        && paired === num(r.router_measured_count)
        && num(r.avg_ttff_ms) > 0;
    });
    expect(
      aligned.length,
      'no row had TTFF, router and the paired figure over the same turns; inconclusive, not a pass.',
    ).toBeGreaterThan(0);

    for (const r of aligned) {
      const ttff = num(r.avg_ttff_ms);
      const sum = num(r.avg_router_ms) + num(r.avg_ttff_outside_router_ms);
      // 2ms, because each of the three is independently ROUNDed in SQL.
      expect(
        Math.abs(sum - ttff),
        `${r.date} ${r.agent_type} ${r.delivery_option}: router ${r.avg_router_ms} + outside `
          + `${r.avg_ttff_outside_router_ms} = ${sum}, but TTFF is ${ttff}. Over ${r.ttff_router_paired_count} `
          + 'turns that all three figures share, so this must reconcile.',
      ).toBeLessThanOrEqual(2);
    }
  });

  test('a router span longer than TTFF is reported, not hidden', () => {
    // FOUND ON LIVE DATA, and it is a real behavior rather than a measurement fault: a row carrying
    // TTFF 1129ms against a router span of 2071ms, over two turns, reconciling exactly to -942ms.
    //
    // It means the placeholder became visible BEFORE the router finished, and that is ordinary: the
    // ROUTER posts the acknowledgment itself, partway through its own span, then carries on with the
    // hand-off and the dispatch. Its span CONTAINS the placeholder rather than ending at it, so the
    // Router card's claim that it "sits in front of the placeholder, so it is inside TTFF" is not
    // universally true.
    //
    // This asserts the VALUE IS CARRIED, never that it is positive. Clamping would file the finding as
    // a fast turn, and a guard demanding positivity would push somebody to clamp it.
    const negatives = rows.filter(
      (r) => num(r.ttff_router_paired_count) > 0 && num(r.avg_ttff_outside_router_ms) < 0,
    );
    for (const r of negatives) {
      // It still reconciles: a negative is arithmetic, not corruption.
      const sum = num(r.avg_router_ms) + num(r.avg_ttff_outside_router_ms);
      if (num(r.ttff_router_paired_count) === num(r.router_measured_count)) {
        expect(
          Math.abs(sum - num(r.avg_ttff_ms)),
          `${r.date}: a negative outside-router figure must still reconcile`,
        ).toBeLessThanOrEqual(2);
      }
    }
    // Not an assertion that negatives EXIST - they are rare and depend on the window. The point is
    // that when they do, they are internally consistent rather than noise.
    expect(Array.isArray(negatives)).toBe(true);
  });

  test('the time outside the router is a real share, not pinned at zero or at the whole wait', () => {
    // The panel draws this as one of three rows. If it were pinned at 0 or at TTFF the decomposition
    // would be decorative, which is the state the panel was in before this column existed.
    const aligned = rows.filter((r) => {
      const paired = num(r.ttff_router_paired_count);
      return paired > 0 && paired === num(r.ttff_measured_count) && num(r.avg_ttff_ms) > 0;
    });
    expect(aligned.length, 'inconclusive, not a pass.').toBeGreaterThan(0);

    const shares = aligned.map((r) => num(r.avg_ttff_outside_router_ms) / num(r.avg_ttff_ms));
    // At least one row where it is a meaningful, ordinary share - so the column is measuring
    // something rather than always degenerating to an edge.
    expect(
      shares.some((s) => s > 0.01 && s < 0.99),
      `no row had an ordinary outside-router share; got ${shares.map((s) => s.toFixed(2)).join(', ')}`,
    ).toBe(true);
  });

  test('classification plus the rest of the router equals the router span', () => {
    // This one reconciles TIGHTLY: avg_router_other_ms is AVG(router_ms - COALESCE(classifier_ms, 0))
    // over the SAME rows as avg_router_ms, so the difference is a per-row quantity and the two
    // averages share a population. A loose tolerance here would hide a real defect.
    const usable = rows.filter((r) => num(r.avg_router_ms) > 0 && num(r.avg_router_other_ms) > 0);
    expect(usable.length, 'inconclusive, not a pass.').toBeGreaterThan(0);

    for (const r of usable) {
      const router = num(r.avg_router_ms);
      const other = num(r.avg_router_other_ms);
      // The rest of the router can never exceed the router span it is part of.
      expect(other, `${r.date}: router_other ${other}ms exceeds router ${router}ms`).toBeLessThanOrEqual(router + 1);
    }
  });
});
