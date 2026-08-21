/**
 * LOCATING THE PLACEHOLDER IS TWO QUESTIONS, AND ONE COLUMN WAS ANSWERING NEITHER.
 *
 * `poll_ms` used to be stamped as (now - processor entry) at the moment the placeholder resolved, so
 * it spanned the dedup claim and the task-status write as well as the lookup. Two consequences, both
 * read off live data before this change:
 *
 *   1. It could never reach 0, however well the channel flow's placeholder-id handoff worked. The
 *      owner expected ~0 once the id was handed over; the metric was structurally incapable of it.
 *   2. Task turns exceeded every other delivery option by ~100 ms on every day measured (2026-08-21:
 *      222/288/313 against 178). That delta was `updateTaskStatus` - which runs only when the event
 *      carries a task id - showing through a column labelled as a scan.
 *
 * The owner's requirement is the shape of the fix: see what LOCATING cost, and separately how often
 * a scan was needed, since a scan is what moves that cost. So:
 *
 *   avg_placeholder_resolve_ms  the mapping read plus the scan when there was one
 *   poll_fallback_count         how often the handoff did not supply a target
 *   avg_poll_ms                 what a scan costs WHEN it happens
 *
 * THE CONDITIONAL MEAN IS STRUCTURAL, NOT A FILTER. `poll_ms` is NULL on a turn that did not scan
 * (migration 030) and `AVG` skips nulls, so `AVG(poll_ms)` is already "cost when it happened" and
 * `COUNT(poll_ms)` is already the rate. Writing 0 instead would put the mean between a common 0 and
 * a rare few thousand, describing no turn on the system - the same defect as averaging a
 * reconstructed pairing into TTFF, running the other way.
 *
 * The `latencyQuery` harness matches `latency-unclosed-split.test.ts` in this directory.
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

async function latencyQuery(): Promise<{ sql: string; body: any }> {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
  const res = await handler(
    postEvent({ queryType: 'latency_metrics', dateRange: { start: '2026-08-01', end: '2026-08-21' } })
  );
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return { sql: call![0] as string, body: JSON.parse(res.body) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the latency query reports the locate cost and the fallback rate separately', () => {
  it('averages the resolve cost, which is the latency a turn actually pays to find its placeholder', async () => {
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/ROUND\(AVG\(m\.placeholder_resolve_ms\)\)\s*AS\s+avg_placeholder_resolve_ms/);
  });

  it('gates every step figure on the row having been measured the new way', async () => {
    // FOUND IN LIVE VERIFICATION. Ungated, the first post-deploy read reported poll_fallback_count
    // equal to the row count on every historical group - a 100% fallback rate - because the OLD
    // poll_ms was stamped on every turn and could never be null. The rate would have read as a total
    // outage of the handoff until the history aged out.
    //
    // placeholder_resolve_ms is the discriminator because only the new code writes it: its presence
    // DECLARES that this row's poll_ms means the scan alone.
    const { sql } = await latencyQuery();
    const GATE = /FILTER\s*\(\s*WHERE\s+m\.placeholder_resolve_ms\s+IS\s+NOT\s+NULL\s*\)/;
    expect(sql).toMatch(new RegExp(/COUNT\(m\.poll_ms\)\s*/.source + GATE.source));
    expect(sql).toMatch(new RegExp(/AVG\(m\.poll_ms\)\s*/.source + GATE.source));
    // And the tail, which had the same contamination the other way: a pre-split row's unmeasured
    // admission and lookup would otherwise be reported AS tail, inflating one bucket with two others.
    const tail = /AVG\(m\.total_ms[\s\S]*?AS\s+avg_processor_tail_ms/.exec(sql);
    expect(tail).not.toBeNull();
    expect(tail![0]).toMatch(GATE);
    // The denominator, so a count of fallbacks is readable as a proportion rather than against a row
    // count that includes turns this split never measured.
    expect(sql).toMatch(/COUNT\(m\.placeholder_resolve_ms\)\s*AS\s+placeholder_measured_count/);
  });

  it('COUNTS the scans, which is the number that sits on a floor of zero', async () => {
    // The rate is the readable signal precisely because it CAN be zero: a regression is then a step
    // off the floor rather than a drift inside noise. `poll_ms` never could be, which is why a
    // partial handoff failure would have hidden in it.
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/COUNT\(m\.poll_ms\)[\s\S]*?AS\s+poll_fallback_count/);
  });

  it('keeps the poll average conditional on the NULLS, and gates only on the row era', async () => {
    // Two different things, and the distinction is the point. The conditional-ness comes from
    // poll_ms being NULL when no scan ran, which AVG skips for free - NOT from a predicate about
    // scanning. The only FILTER here is the era gate, which answers "was this row measured the new
    // way", never "did this row scan".
    //
    // The mutation this catches is someone "fixing" the null-ness by writing 0 in the producer and
    // compensating with a `poll_ms > 0` filter here. That would work, and it would quietly turn a
    // conditional mean back into a diluted one the moment the filter was dropped.
    const { sql } = await latencyQuery();
    const pollAvg = /ROUND\(AVG\(m\.poll_ms\)[\s\S]*?\)\s*AS\s+avg_poll_ms/.exec(sql);
    expect(pollAvg).not.toBeNull();
    expect(pollAvg![0]).toMatch(/m\.placeholder_resolve_ms\s+IS\s+NOT\s+NULL/);
    expect(pollAvg![0]).not.toMatch(/poll_ms\s*[>!]/);
  });

  it('declares both new columns, appended so the existing contract is intact', async () => {
    const { body } = await latencyQuery();
    const cols: string[] = body.columns;
    expect(cols).toEqual(expect.arrayContaining(['avg_placeholder_resolve_ms', 'poll_fallback_count']));
    // `avg_poll_ms` keeps its name AND its original position: readers that already bind to it are
    // unaffected by the additions, and only its MEANING changed (migration 030 records that).
    expect(cols.indexOf('avg_poll_ms')).toBeLessThan(cols.indexOf('avg_placeholder_resolve_ms'));
    expect(cols.indexOf('avg_poll_ms')).toBe(6);
  });

  it('the three figures are distinct columns, so none can silently stand in for another', async () => {
    // Non-vacuity for the set: the whole point is that one column was answering three questions.
    const { sql } = await latencyQuery();
    const named = ['avg_placeholder_resolve_ms', 'poll_fallback_count', 'avg_poll_ms'];
    for (const n of named) {
      expect(sql.match(new RegExp(`AS\\s+${n}\\b`, 'g'))).toHaveLength(1);
    }
  });
});

describe('the processor leg decomposes into steps that add up', () => {
  it('names admission separately from the lookup it used to be charged to', async () => {
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/ROUND\(AVG\(m\.guard_ms\)\)\s*AS\s+avg_guard_ms/);
  });

  it('DERIVES the tail from the total, so it cannot drift from what it is a residual of', async () => {
    // Stamped independently, the tail would be a fifth number that agrees with the other four only
    // by luck. Defined as total minus the named steps, a reader can check the arithmetic.
    const { sql } = await latencyQuery();
    expect(sql).toMatch(
      /AVG\(m\.total_ms\s*-\s*COALESCE\(m\.guard_ms,\s*0\)\s*-\s*COALESCE\(m\.placeholder_resolve_ms,\s*0\)[\s\S]*?-\s*COALESCE\(m\.latency_ms,\s*0\)\)[\s\S]*?AS\s+avg_processor_tail_ms/,
    );
  });

  it('does NOT clamp the tail at zero, because a negative residual is the finding', async () => {
    // A negative tail means compute was attributed to the wrong turn - the bug class v_turn_latency's
    // unattributed_ms exists to expose. GREATEST(...,0) here would hide exactly that, and would look
    // like tidiness while doing it.
    const { sql } = await latencyQuery();
    const tail = /AVG\(m\.total_ms[\s\S]*?AS avg_processor_tail_ms/.exec(sql);
    expect(tail).not.toBeNull();
    expect(tail![0]).not.toMatch(/GREATEST|ABS\(/);
  });

  it('COALESCEs the parts but not the total, so a turn with no telemetry stays null', async () => {
    // The asymmetry is deliberate. A missing PART is zero-cost for that step; a missing TOTAL means
    // the turn recorded no compute at all, and a tail computed from it would be a number invented
    // out of nulls. AVG then skips the row, which is the correct silence.
    const { sql } = await latencyQuery();
    const tail = /AVG\((m\.total_ms[\s\S]*?)\)\)\s*AS avg_processor_tail_ms/.exec(sql);
    expect(tail).not.toBeNull();
    expect(tail![1]).not.toMatch(/COALESCE\(m\.total_ms/);
  });

  it('declares the step columns in the contract', async () => {
    const { body } = await latencyQuery();
    expect(body.columns).toEqual(
      expect.arrayContaining(['avg_guard_ms', 'avg_placeholder_resolve_ms', 'avg_processor_tail_ms']),
    );
  });
});

describe('the classifier is a measured step, not a number from the logs', () => {
  it('averages the classifier cost and counts how often a model was asked', async () => {
    // The classifier runs BEFORE the placeholder, so it is inside TTFF - the metric the 1s SLO is
    // about - and it was the one step of the path with no column. It read 444ms avg / 1,410ms p95 on
    // premium traffic, against a TTFF missing its target by 1.6s. A step that large cannot be
    // decided from CloudWatch while the dashboard argues about the total.
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/ROUND\(AVG\(m\.classifier_ms\)\)\s*AS\s+avg_classifier_ms/);
    expect(sql).toMatch(/COUNT\(m\.classifier_ms\)\s*AS\s+classified_by_model_count/);
  });

  it('keeps its OWN average conditional, so a fast path reads as rarer and not as cheaper', async () => {
    // The mutation this catches is zero-filling the classifier inside the average OF the classifier,
    // which would fold every pre-LLM fast path and every orchestrator rebuttal in as a free
    // classification - making the model look FASTER the more often it is not called.
    //
    // Scoped to that one expression on purpose. A blanket "classifier_ms is never coalesced" rule
    // fired on `avg_router_other_ms` below, where the coalesce is CORRECT and means something else
    // entirely, and a guard that cannot tell those two apart gets loosened rather than obeyed.
    const { sql } = await latencyQuery();
    const ownAverage = /ROUND\(AVG\(([^)]*classifier_ms[^)]*)\)\)\s*AS\s+avg_classifier_ms/.exec(sql);
    expect(ownAverage).not.toBeNull();
    expect(ownAverage![1]).not.toMatch(/COALESCE/);
  });

  it('DOES zero-fill the classifier when subtracting it from the router, which is the opposite case', async () => {
    // The distinction the guard above must not erase. A turn that took a fast path really did spend
    // none of its router time classifying, so its whole router span is "other" and 0 is the true
    // value. Null-propagating here would blank router_other for exactly the cheap turns.
    //
    // Asymmetric on purpose: the classifier is coalesced, `router_ms` is NOT - a null there means the
    // turn was never measured, and subtracting from it would invent a number rather than record one.
    const { sql } = await latencyQuery();
    expect(sql).toMatch(
      /ROUND\(AVG\(m\.router_ms\s*-\s*COALESCE\(m\.classifier_ms,\s*0\)\)\)\s*AS\s+avg_router_other_ms/,
    );
  });

  it('names the router leg on its own clock, distinct from the cross-clock inbound bound', async () => {
    // `inbound_ms` spans the flow, Lex AND the router as one cross-clock figure, so it tracks TTFF
    // rather than dividing it. Both must exist and stay separate: this is what lets a reader tell
    // "the router is slow" from "something before the router is slow".
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/ROUND\(AVG\(m\.router_ms\)\)\s*AS\s+avg_router_ms/);
    expect(sql).toMatch(/ROUND\(AVG\(e\.inbound_ms\)\)\s*AS\s+avg_inbound_ms/);
  });

  it('declares both in the contract', async () => {
    const { body } = await latencyQuery();
    expect(body.columns).toEqual(
      expect.arrayContaining(['avg_classifier_ms', 'classified_by_model_count']),
    );
  });
});
