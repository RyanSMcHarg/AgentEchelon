/**
 * A LEDGER ANCHOR THE BACKFILL BOUND FROM AN EXCHANGE IS NOT AN INDEPENDENT MEASUREMENT.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
 *
 * `turn-events-backfill.ts` binds `turn_id` onto `user_message` rows straight from `exchanges`, with
 * NO `paired_by` filter, and records `turn_id_source = 'paired'`. That makes the ledger anchor
 * non-NULL, which flips `v_turn_latency.anchor_source` from `exchange` to `ledger`, and the TTFF
 * measured predicate in `getLatencyMetrics` treated `ledger` as measured UNCONDITIONALLY on the
 * stated assumption that a ledger anchor is one "no sweep took part in".
 *
 * That assumption is false for the backfilled population. The INSTANT is observed either way; what
 * the ledger may not have observed is WHICH user message is this turn's anchor, and when that binding
 * came from an exchange it carries the exchange's provenance, a swept one included. So running the
 * backfill over a window readmitted every swept pairing to the headline average - silently, and in
 * the direction that flatters the number, because the swept rows are the slow ones.
 *
 * ── THE FIX, AND WHY IT IS NOT MERELY CONSERVATIVE ─────────────────────────────────────────────
 *
 * The ledger clause now asks `turn_id_source IS DISTINCT FROM 'paired'` as well. Where the binding
 * WAS paired, the decision falls through to the exchange clauses - which is the correct reading
 * rather than a cautious one, because that exchange is literally where the binding came from. A
 * declared or in-batch pairing passes there on its own merits; a swept one is excluded there by the
 * name it records for itself. Nothing genuine is lost and nothing reconstructed is admitted.
 *
 * ── HOW THESE TESTS WORK ───────────────────────────────────────────────────────────────────────
 *
 * The predicate is SQL, so each clause is paired with the condition it encodes and evaluated AS THE
 * QUERY ACTUALLY WRITES IT: a clause absent from the issued SQL does not vote. The last test feeds
 * the model the pre-change predicate and shows the backfilled swept turn counted as measured, so
 * none of the assertions above passes vacuously.
 *
 * Mock + `latencyQuery` pattern follows `ttff-counts-only-measured-pairings.test.ts` beside it.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
const mockEnsureSchema = jest.fn().mockResolvedValue(undefined);

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: mockEnsureSchema,
  getClient: jest.fn(),
}));

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { edgeContext } from '../helpers/edge-context';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: {
      authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }),
    },
  } as unknown as APIGatewayProxyEvent;
}

const flat = (s: string) => s.replace(/\s+/g, ' ');

async function latencySql(): Promise<string> {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
  await handler(
    postEvent({ queryType: 'latency_metrics', dateRange: { start: '2026-09-01', end: '2026-09-16' } })
  );
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return flat(call![0] as string);
}

/** What the query can know about one turn when it decides whether the turn is measured. */
interface Turn {
  /** v_turn_latency.anchor_source */
  anchorSource: 'ledger' | 'exchange' | null;
  /** v_turn_latency.turn_id_source, from the ledger's user_message row */
  turnIdSource: 'declared' | 'paired' | null;
  /**
   * exchanges.paired_by on the exchange the view anchored through.
   *
   * `mention` joined the set on 2026-09-23 and is a DECLARATION, not a guess: the correlation id is
   * the user's own message id, so it pairs on an exact match with no time bound. It therefore sits
   * with `declared` on the measured side of the predicate below, and only `swept` is excluded.
   */
  pairedBy: 'declared' | 'mention' | 'in_batch' | 'swept' | null;
  /** exchanges.delivery_option, the pre-042 proxy */
  deliveryOption: string | null;
}

/**
 * The two arms of the predicate, each with the condition it encodes. The ledger arm carries the new
 * conjunct; removing it from the SQL removes it from the model, which is what makes the final test a
 * real demonstration rather than a restatement.
 */
const LEDGER_ARM = "COALESCE(vl.anchor_source = 'ledger' AND vl.turn_id_source IS DISTINCT FROM 'paired', FALSE)";
const LEDGER_ARM_BEFORE = "COALESCE(vl.anchor_source = 'ledger', FALSE)";
const EXCHANGE_ARM = "(e.paired_by IS DISTINCT FROM 'swept'"
  + ' AND (e.paired_by IS NOT NULL OR e.delivery_option IS NOT NULL))';

function measured(sql: string, t: Turn): boolean {
  const ledgerArm = sql.includes(LEDGER_ARM)
    ? t.anchorSource === 'ledger' && t.turnIdSource !== 'paired'
    : sql.includes(LEDGER_ARM_BEFORE)
      ? t.anchorSource === 'ledger'
      : false;
  const exchangeArm = sql.includes(EXCHANGE_ARM)
    ? t.pairedBy !== 'swept' && (t.pairedBy !== null || t.deliveryOption !== null)
    : false;
  return ledgerArm || exchangeArm;
}

/** The population the backfill creates: a ledger anchor whose binding came from a swept exchange. */
const backfilledSwept: Turn = {
  anchorSource: 'ledger', turnIdSource: 'paired', pairedBy: 'swept', deliveryOption: 'inline',
};

/** A genuine ledger anchor: the turn declared its own binding, so no exchange took part in it. */
const declaredLedger: Turn = {
  anchorSource: 'ledger', turnIdSource: 'declared', pairedBy: null, deliveryOption: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('a backfilled pairing does not readmit itself to the headline', () => {
  it('does NOT count a ledger anchor bound from a swept exchange as measured', async () => {
    const sql = await latencySql();
    expect(measured(sql, backfilledSwept)).toBe(false);
  });

  it('DOES count a genuine ledger anchor, which the turn bound itself', async () => {
    // The narrowing has to stay narrow. A turn whose binding was declared never borrowed a
    // reconstructed start, so excluding it would throw away a real measurement.
    const sql = await latencySql();
    expect(measured(sql, declaredLedger)).toBe(true);
  });

  it('DOES count a backfilled anchor whose exchange was really paired', async () => {
    // Falling through to the exchange is the point: the binding came from there, so the exchange's
    // own label is the honest verdict on it, in both directions.
    const sql = await latencySql();
    expect(measured(sql, { ...backfilledSwept, pairedBy: 'declared' })).toBe(true);
    expect(measured(sql, { ...backfilledSwept, pairedBy: 'in_batch' })).toBe(true);
  });

  it('still excludes a genuine sweep that never reached the ledger at all', async () => {
    // The constraint that must not move: the point is to stop MANUFACTURING sweeps, never to start
    // trusting them.
    const sql = await latencySql();
    expect(measured(sql, {
      anchorSource: 'exchange', turnIdSource: null, pairedBy: 'swept', deliveryOption: 'inline',
    })).toBe(false);
    // And the pre-042 proxy still holds for rows written before paired_by existed.
    expect(measured(sql, {
      anchorSource: 'exchange', turnIdSource: null, pairedBy: null, deliveryOption: null,
    })).toBe(false);
  });

  it('PROVES IT CAN FAIL: the old predicate counts the backfilled swept turn', async () => {
    const sql = await latencySql();
    const before = sql.replace(LEDGER_ARM, LEDGER_ARM_BEFORE);
    expect(measured(before, backfilledSwept)).toBe(true);
    // The very turn the fix holds out, admitted by the assumption the fix corrects.
    expect(measured(sql, backfilledSwept)).toBe(false);
  });
});

describe('the predicate reads columns that already exist', () => {
  it('asks turn_id_source of the view, which needs no view change', async () => {
    // v_turn_latency has selected turn_id_source since migration 019 and every redefinition since
    // carries it, so this change is a predicate and not a schema move.
    const sql = await latencySql();
    expect(sql).toContain('vl.turn_id_source');
    expect(sql).toContain(`SELECT (${LEDGER_ARM}`);
  });

  it('states the predicate exactly once, so the partition cannot drift', async () => {
    const sql = await latencySql();
    expect(sql.match(/AS measured\b/g)).toHaveLength(1);
  });

  it('keeps the result a strict boolean, so measured and NOT measured partition the rows', async () => {
    // A NULL would fall out of both counts and the split would stop adding up in silence.
    const sql = await latencySql();
    expect(sql).toContain('COALESCE(vl.anchor_source =');
  });
});
