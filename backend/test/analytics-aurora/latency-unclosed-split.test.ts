/**
 * EVERY UNCLOSED TURN FALLS INTO A NAMED CATEGORY.
 *
 * The first live reading of `unclosed_count` was **closed 418, unclosed 172** - 29% of paired turns
 * never recorded a final answer, and `AVG` had been skipping every one of them in silence. The count
 * made the gap visible and then could say nothing about it: the same 172 carried "e2e test litter",
 * "correctly-unclosed errored turns" and "answers that were genuinely lost", which differ enormously
 * in seriousness and cannot be acted on together.
 *
 * **The split must be a partition, not six opinions.** Six independently written predicates would
 * re-create the original ambiguity in a new form - overlapping ones double-count, a missing one drops
 * a turn - and neither failure raises anything. It just quietly stops adding up. So the query
 * classifies each response ONCE, with a single `CASE` in a grouped CTE, and the buckets are FILTERs
 * over that one value.
 *
 * That is what these tests hold in place, and the mutation each is written to catch is named on it.
 * The load-bearing one is `partitions unclosed_count exhaustively`: it extracts the outcomes the CASE
 * can produce and the outcomes the buckets consume, and fails when they diverge - which is what
 * happens the day someone adds a seventh ledger outcome and no bucket counts it.
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

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: {
      authorizer: { claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } },
    },
  } as unknown as APIGatewayProxyEvent;
}

async function latencyQuery(rows: unknown[] = []): Promise<{ sql: string; body: any }> {
  mockDbQuery.mockResolvedValueOnce({ rows });
  const res = await handler(
    postEvent({ queryType: 'latency_metrics', dateRange: { start: '2026-08-01', end: '2026-08-17' } })
  );
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return { sql: call![0] as string, body: JSON.parse(res.body) };
}

/** The bucket columns, in the order the query appends them. */
const BUCKETS = [
  'unclosed_no_placeholder',
  'unclosed_unreadable_marker',
  'unclosed_unobserved',
  'unclosed_disagreed',
  'unclosed_errored',
  'unclosed_superseded',
  'unclosed_awaiting',
  'unclosed_silent',
] as const;

/**
 * The placeholder predicate, escaped for matching against the SQL text.
 *
 * It is spelled out here rather than loosened to a substring match ON PURPOSE. The query must use the
 * FULL marker pattern - `turn-events-backfill.ts`'s own - and an earlier cut that tested only for the
 * opening token disagreed with the backfill on 26 live rows, classifying as "unobserved placeholder"
 * messages the backfill had declined to record. A test that matched loosely would have let that
 * through, so this asserts the exact predicate.
 */
const MARKER =
  "substring\\(m\\.content from '<!--corr:\\(\\[A-Za-z0-9\\._-\\]\\{1,64\\}\\)-->'\\)";

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureSchema.mockResolvedValue(undefined);
});

describe('unclosed turns are split by what the ledger observed', () => {
  it('classifies each response ONCE, in a grouped CTE', async () => {
    const { sql } = await latencyQuery();
    // Grouped per response before it is joined. The mutation this catches is joining `turn_events`
    // directly: that emits one row per EVENT, so a turn that logged four events would multiply every
    // average in this query by four - the fan-out hazard `v_turn_latency` documents, from the other side.
    expect(sql).toMatch(/WITH resp_ledger AS \(/);
    expect(sql).toMatch(/GROUP BY response_id, channel_arn/);
    expect(sql).toMatch(
      /LEFT JOIN resp_ledger l ON l\.response_id = m\.message_id AND l\.channel_arn = m\.channel_arn/
    );
    // The outer query must reach the ledger only through the grouped CTE.
    const outer = sql.slice(sql.indexOf('FROM messages m'));
    expect(outer).not.toMatch(/JOIN turn_events/);
  });

  it('partitions unclosed_count exhaustively', async () => {
    const { sql } = await latencyQuery();

    // What the CASE can produce.
    const cte = sql.slice(sql.indexOf('WITH resp_ledger'), sql.indexOf('END AS outcome'));
    const produced = new Set((cte.match(/THEN '([a-z_]+)'/g) || []).map((m) => m.slice(6, -1)));
    // The ELSE is what makes it total - without it an unrecognised event pattern yields NULL and is
    // silently miscounted as "the ledger holds nothing", i.e. a defect disguised as an absence.
    expect(cte).toMatch(/ELSE '([a-z_]+)'\s*$/m);
    const elseVal = /ELSE '([a-z_]+)'/.exec(cte)![1];
    produced.add(elseVal);

    // What the BUCKET CASE consumes. The buckets themselves consume b.unclosed_bucket values, and
    // the bucket lateral is the only place l.outcome is read - one classification per row, so the
    // split cannot stop being a partition however the outcome list grows.
    const bucketCase = sql.slice(sql.indexOf('END AS outcome'), sql.indexOf('END AS unclosed_bucket'));
    const consumed = new Set((bucketCase.match(/l\.outcome = '([a-z_]+)'/g) || []).map((m) => m.slice(13, -1)));

    // Every outcome the classifier can emit is mapped by exactly one CASE arm, and no arm names an
    // outcome the classifier cannot emit. THIS is the assertion that keeps the split a partition.
    expect([...consumed].sort()).toEqual([...produced].sort());

    // Plus the three arms that are not ledger outcomes at all: the message never carried a marker,
    // it carried one the reader cannot see, and the ledger had nothing to say about a real
    // placeholder. The first two split on the LITERAL '<!--corr:' because the bounded substring is
    // NULL for BOTH - one predicate served two opposite findings ("nobody was promised an answer" vs
    // "a person was promised one the platform structurally cannot deliver") until the split.
    expect(bucketCase).toMatch(/l\.outcome IS NULL\s+THEN 'unobserved'/);
    expect(bucketCase).toMatch(/mk\.marker_id IS NULL\s*\n\s*AND m\.content NOT LIKE '%<!--corr:%'\s+THEN 'no_placeholder'/);
    expect(bucketCase).toMatch(/mk\.marker_id IS NULL\s+THEN 'unreadable_marker'/);
    // And the no-marker arm PRECEDES the bare-null arm, or every marker-less message would land in
    // the unreadable bucket.
    expect(bucketCase.indexOf("'no_placeholder'")).toBeLessThan(bucketCase.indexOf("'unreadable_marker'"));
    // Each bucket column counts exactly its own CASE value.
    for (const bucket of BUCKETS) {
      const value = bucket.replace('unclosed_', '');
      expect(sql).toMatch(new RegExp(`b\\.unclosed_bucket = '${value}'\\)\\s+AS ${bucket}`));
    }

    // Buckets = outcomes + 3, so none was written twice under two names. The producer-attribution
    // columns (unreadable_marker_battle/mention) are SUB-counts of the unreadable bucket, not
    // partition members - adding them here would make the partition appear to double-count.
    expect(BUCKETS.length).toBe(produced.size + 3);
  });

  it('answers for history WITHOUT the ledger, because most of the population predates it', async () => {
    // MEASURED 2026-08-16: 169 of the 172 unclosed turns sat in the unknown/unknown bucket, and the
    // ledger's live writer was hours old - so a split that could only speak through the ledger would
    // have returned "cannot say" for effectively all of them and looked like an answer.
    //
    // The marker test is a property of the MESSAGE, so it answers for every row ever archived. Only a
    // placeholder is edited into a final answer (`backfillFromUpdateEvents` is the sole writer of
    // `agent_final_at`), so a bot message that never carried the marker CANNOT close - it is a welcome,
    // a drift notice, a continuation chunk or a DIRECT reply that `createExchangesFromDatabase` paired
    // to a user message because it pairs any bot CREATE that follows one.
    const { sql } = await latencyQuery();
    const bucketCase = sql.slice(sql.indexOf('END AS outcome'), sql.indexOf('END AS unclosed_bucket'));
    // The message-property arms must NOT consult the ledger - that is the whole point of them.
    const markerArms = bucketCase.slice(0, bucketCase.indexOf("'unreadable_marker'"));
    expect(markerArms).not.toMatch(/l\.outcome/);

    // The SAME predicate the backfill uses to define a placeholder, in full - see MARKER above for
    // what a looser version cost. Two disagreeing definitions of "response" is the defect the ledger
    // exists to remove; this is a poor place to add a third. Stated ONCE (the mk lateral), which is
    // what replaced ten hand-copied instances of it.
    expect(sql).toMatch(new RegExp(MARKER.replace(/m\\\.content/, 'm\\.content')));

    // And every ledger-based arm must sit BELOW the marker arms, so a marker-less message can never
    // reach a ledger bucket - the CASE ordering is what keeps the buckets from overlapping.
    for (const value of ['unobserved', 'disagreed', 'errored', 'superseded', 'awaiting', 'silent']) {
      const at = bucketCase.indexOf(`'${value}'`);
      expect(at).toBeGreaterThan(bucketCase.indexOf("'unreadable_marker'"));
    }
  });

  it('scopes every bucket to the SAME population as unclosed_count', async () => {
    // A bucket that widened its own predicate would still "add up" against a total nobody recomputes.
    // Every one must carry the identical unclosed test: paired to a user message, and never closed.
    const { sql } = await latencyQuery();
    // The population gate is stated ONCE, as the CASE's first arm: any closed or unpaired row
    // classifies to NULL and so is counted by NO bucket. Ten per-bucket copies of the same predicate
    // are exactly what this replaced - they could drift apart one at a time.
    const bucketCase = sql.slice(sql.indexOf('END AS outcome'), sql.indexOf('END AS unclosed_bucket'));
    expect(bucketCase).toMatch(/WHEN e\.id IS NULL OR e\.e2e_ms IS NOT NULL\s+THEN NULL/);
    // And it is the FIRST arm, so nothing upstream of it can classify a closed row.
    expect(/WHEN[\s\S]*?THEN/.exec(bucketCase.slice(bucketCase.indexOf('SELECT CASE')))![0]).toContain('e.id IS NULL');
    for (const bucket of BUCKETS) {
      expect(sql.indexOf(`AS ${bucket}`)).toBeGreaterThan(-1);
    }
    // And the parent it partitions is unchanged.
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE e\.id IS NOT NULL AND e\.e2e_ms IS NULL\) AS unclosed_count/);
  });

  it('reads finality from the DECLARED kind, never from row shape', async () => {
    // The ledger exists because lifecycle role used to be inferred from transport shape. Only
    // `final_response` may close, and `error_response` deliberately may not: an errored turn's wait
    // ended without an answer, and folding its duration into time-to-answer reads a broken turn as a
    // fast one. The mutation this catches is treating 'error' as terminal-and-closed.
    const { sql } = await latencyQuery();
    const cte = sql.slice(sql.indexOf('WITH resp_ledger'), sql.indexOf('END AS outcome'));
    expect(cte).toMatch(/bool_or\(kind = 'final_response'\)\s+THEN 'ledger_final'/);
    expect(cte).toMatch(/bool_or\(kind = 'error_response'\)\s+THEN 'errored'/);
    // final outranks error: a turn that errored and then answered is answered.
    expect(cte.indexOf("'final_response'")).toBeLessThan(cte.indexOf("'error_response'"));
  });

  it('separates a DISAGREEMENT from a lost answer', async () => {
    // A ledger-declared final against a null e2e_ms means the two derivations disagree - the shadow
    // diff of rollout step 4, arriving early. Counting it as a lost answer would send an investigation
    // after the wrong system, so it outranks every other outcome.
    const { sql } = await latencyQuery();
    const cte = sql.slice(sql.indexOf('WITH resp_ledger'), sql.indexOf('END AS outcome'));
    const first = /WHEN bool_or\(kind = '([a-z_]+)'\)/.exec(cte);
    expect(first![1]).toBe('final_response');
  });

  it('serves the split beside the count, appended to the column contract', async () => {
    // LatencyTab, alerts.ts and metricTargets.ts read `columns` BY NAME. An append is safe; a reorder
    // is not, and this boundary is where that would otherwise go unnoticed.
    const { body } = await latencyQuery();
    const cols = body.columns as string[];
    expect(cols.slice(0, 4)).toEqual(['date', 'agent_type', 'delivery_option', 'exchange_count']);
    expect(cols).toEqual(expect.arrayContaining([...BUCKETS]));
    // Appended AFTER the count they explain, so a reader meets the total before the breakdown.
    expect(cols.indexOf('unclosed_unobserved')).toBeGreaterThan(cols.indexOf('unclosed_count'));
  });

  it('returns the bucket values to the caller', async () => {
    // The shell rendering is not the test. A row carrying a real breakdown must arrive intact, and it
    // must still add up - here, 12 unclosed turns of which 7 are merely un-observed and 2 are lost.
    const row = {
      date: '2026-08-16',
      agent_type: 'premium',
      delivery_option: 'ASYNC',
      exchange_count: 40,
      closed_count: 28,
      unclosed_count: 12,
      unclosed_no_placeholder: 6,
      unclosed_unreadable_marker: 1,
      unclosed_unobserved: 0,
      unclosed_disagreed: 1,
      unclosed_errored: 1,
      unclosed_superseded: 0,
      unclosed_awaiting: 1,
      unclosed_silent: 2,
    };
    const { body } = await latencyQuery([row]);
    expect(body.data).toHaveLength(1);
    const got = body.data[0];
    for (const bucket of BUCKETS) expect(got[bucket]).toBe((row as any)[bucket]);
    const summed = BUCKETS.reduce((n, b) => n + (got[b] as number), 0);
    expect(summed).toBe(got.unclosed_count);
  });
});
