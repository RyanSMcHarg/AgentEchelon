/**
 * THE LATENCY TAB'S TTFF AND E2E COME FROM THE LEDGER.
 *
 * WHAT MOVED. `getLatencyMetrics` read `exchanges.response_latency_ms` and `exchanges.e2e_ms` - figures
 * computed at archival by whichever pairer happened to make the pair. It now reads `v_turn_latency`,
 * which derives the same two figures at READ from instants the ledger recorded, each carrying its clock
 * and whether it is provable against the Amazon Chime SDK message stream. An aggregate cannot be
 * audited; a row per instant can.
 *
 * WHY IT WAS SAFE TO MOVE, MEASURED ON LIVE TRAFFIC through `turn_latency_shadow_diff` (step 4,
 * 2026-09-15). One day: 239 turns compared, 239 agreed, 0 disagreed, 0 measured by only one side, p95
 * absolute difference 0 ms on TTFF and on E2E. Seven days: 1,016 compared, 883 agreed, 6 disagreed -
 * all battle round-2 rebuttals, where the ledger's null is the correct reading - and 127 measured only
 * by the derived path, none of them in the last day.
 *
 * WHAT THESE TESTS HOLD. The SHAPE is unchanged, so `LatencyTab.tsx`, `alerts.ts` and `metricTargets.ts`
 * need no edit; the swept-pairing exclusion came across with the figures; a turn nobody waited for
 * leaves the distribution rather than entering it as a zero; and what the repoint dropped is counted
 * rather than lost.
 *
 * Mock + `latencyQuery` pattern follows `latency-unclosed-split.test.ts` in this directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
const mockEnsureSchema = jest.fn().mockResolvedValue(undefined);

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: mockEnsureSchema,
  getClient: jest.fn(),
}));

import { handler, priceLatencyRow } from '../../lambda/src/analytics-aurora/analytics-query';
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

async function latencyQuery(rows: unknown[] = []): Promise<{ sql: string; body: any }> {
  mockDbQuery.mockResolvedValueOnce({ rows });
  const res = await handler(
    postEvent({ queryType: 'latency_metrics', dateRange: { start: '2026-09-08', end: '2026-09-15' } })
  );
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return { sql: call![0] as string, body: JSON.parse(res.body) };
}

/** Compare SQL by tokens, so a reformat that changes no row cannot fail these - or hide in them. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/**
 * Every column the admin console reads off a `latency_metrics` row by name.
 *
 * Taken from `LatencyTab.tsx`, `alerts.ts` and `metricTargets.ts` rather than from the query, so this
 * list fails when the query stops serving a reader instead of agreeing with it by construction.
 */
const READ_BY_THE_CONSOLE = [
  'date', 'assistant', 'delivery_option', 'assistant_turn_count',
  'avg_ttff_ms', 'avg_ttff_warm_ms', 'avg_e2e_ms', 'p95_e2e_ms',
  'avg_total_ms', 'p95_total_ms', 'avg_bedrock_ms', 'p95_bedrock_ms',
  'avg_model_ms', 'avg_tool_ms', 'avg_inbound_ms', 'avg_poll_ms',
  'avg_router_ms', 'avg_classifier_ms', 'avg_router_other_ms', 'avg_guard_ms',
  'avg_placeholder_resolve_ms', 'avg_processor_tail_ms',
  'router_measured_count', 'guard_measured_count', 'placeholder_measured_count',
  'classified_by_model_count',
];

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureSchema.mockResolvedValue(undefined);
});

describe('the repoint keeps the contract the console already consumes', () => {
  it('serves every column the console reads, so no tab file changes', async () => {
    const { body } = await latencyQuery();
    const cols: string[] = body.columns;
    for (const name of READ_BY_THE_CONSOLE) expect(cols).toContain(name);
    // And the first four, which are the grouping keys every consumer slices on, are in place.
    expect(cols.slice(0, 4)).toEqual(['date', 'assistant', 'delivery_option', 'assistant_turn_count']);
  });

  it('declares no column the query does not select', async () => {
    // The failure this catches is silent on both sides: a name in the contract that no `AS` produces
    // arrives at the console as `undefined`, which renders as an empty cell rather than as an error.
    const { sql, body } = await latencyQuery();
    // PRICED IN JS, NOT SELECTED (decision D4: the rate table stays in model-rate-table.ts). These two
    // are produced by priceLatencyRow from the selected turn_models list, so they are checked against
    // that function's output instead of against an AS that would never exist.
    const DERIVED_IN_JS = ['cost_usd', 'cost_priced_turns'];
    const missing = (body.columns as string[])
      .filter((c) => !DERIVED_IN_JS.includes(c))
      .filter((c) => !new RegExp(`AS\\s+${c}\\b`).test(sql));
    expect(missing).toEqual([]);
    expect(sql).toMatch(/AS turn_models/);
    const priced = priceLatencyRow({ turn_models: [] });
    for (const c of DERIVED_IN_JS) expect(priced).toHaveProperty(c);
  });

  it('returns a row unchanged, ledger figures included', async () => {
    // Rendering the shell is not the test. A row carrying real figures must arrive intact.
    const row = {
      date: '2026-09-15',
      assistant: 'premium',
      delivery_option: 'ASYNC',
      assistant_turn_count: 239,
      avg_ttff_ms: 1820,
      p95_ttff_ms: 3400,
      ttff_measured_count: 233,
      ttff_reconstructed_count: 0,
      ttff_ledger_unmeasured_count: 6,
      avg_e2e_ms: 9100,
      p95_e2e_ms: 15200,
    };
    const { body } = await latencyQuery([row]);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject(row);
  });

  it('appends new columns rather than reordering anything', async () => {
    const { body } = await latencyQuery();
    const cols: string[] = body.columns;
    // THE PROPERTY, NOT THE TAIL. This pinned `ttff_ledger_unmeasured_count` as the LAST column, which
    // made it fail on the next legitimate append (`turn_entry`, migration 054) - a test asserting
    // "appends rather than reorders" that refused an append. What matters is that the contract the
    // console already reads is intact and IN ORDER, and that anything new sits after it.
    const CONTRACT_HEAD = ['date', 'assistant', 'delivery_option', 'assistant_turn_count'];
    expect(cols.slice(0, CONTRACT_HEAD.length)).toEqual(CONTRACT_HEAD);
    // Relative order of the pre-existing columns is what a reordering would break.
    expect(cols.indexOf('avg_ttff_ms')).toBeLessThan(cols.indexOf('ttff_measured_count'));
    expect(cols.indexOf('ttff_measured_count')).toBeLessThan(cols.indexOf('ttff_ledger_unmeasured_count'));
    // And the newest addition is genuinely at the end rather than spliced into the middle, which is
    // the mistake this test caught: the queue-release count follows everything that was there before it,
    // and the count of receipts their moved answer carries follows that.
    expect(cols[cols.length - 1]).toBe('turn_carried_by_answer_count');
    expect(cols[cols.length - 2]).toBe('turn_span_queue_release_count');
    expect(cols.indexOf('cost_priced_turns')).toBe(cols.length - 3);
  });
});

describe('the figures that moved, and the ones that did not', () => {
  it('reads TTFF and E2E from v_turn_latency', async () => {
    const { sql } = await latencyQuery();
    expect(flat(sql)).toContain('AVG(vl.ttff_ms) FILTER (WHERE mp.measured)) AS avg_ttff_ms');
    // Battle round 2 is filtered out of both: its end to end is its own round's (migration 071) and is
    // read from latency_by_interaction instead.
    expect(flat(sql)).toContain('ROUND(AVG(vl.e2e_ms) FILTER (WHERE COALESCE(vl.battle_round, 1) <= 1)) AS avg_e2e_ms');
    expect(flat(sql)).toContain(
      'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vl.e2e_ms) FILTER (WHERE COALESCE(vl.battle_round, 1) <= 1)) AS p95_e2e_ms',
    );
  });

  it('leaves every server-clock stamp on messages, because none of them was ever derived', async () => {
    // The scope of the repoint, stated as a test. Worker compute, the model loop, the router leg and
    // the placeholder lookup are stamped by the processor into `messages`; the ledger holds no second
    // opinion about them, so moving them would not be a repoint but an invention.
    const { sql } = await latencyQuery();
    for (const stamped of ['total_ms', 'latency_ms', 'model_ms', 'tool_ms', 'router_ms', 'guard_ms']) {
      expect(sql).toMatch(new RegExp(`AVG\\(m\\.${stamped}`));
    }
    expect(sql).not.toMatch(/AVG\(vl\.total_ms/);
  });

  it('keeps the unclosed split on the exchange, or its own disagreement bucket compares the ledger with itself', async () => {
    // A deliberate scope boundary, recorded here because it is the kind of thing a later reader
    // "tidies". closed_count and the unclosed_* buckets answer whether the EXCHANGE closed and why
    // not; one of those buckets is `disagreed`, which exists precisely to catch the ledger declaring
    // a final answer the exchange has not recorded. Repointing it would make it compare the ledger
    // with the ledger, and the bucket would read zero for ever.
    const { sql } = await latencyQuery();
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE e\.e2e_ms IS NOT NULL\) AS closed_count/);
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE e\.id IS NOT NULL AND e\.e2e_ms IS NULL\) AS unclosed_count/);
  });
});

describe('a turn nobody waited for leaves the distribution rather than entering it as a zero', () => {
  it('never coalesces the ledger TTFF, so a rebuttal cannot be counted as instant feedback', async () => {
    // `v_turn_latency.ttff_ms` is NULL by declaration for any turn whose trigger is not a person
    // waiting - a battle round-2 rebuttal answers a rival's answer, not a user message. AVG and
    // PERCENTILE_CONT skip a NULL, so the exclusion is automatic; a COALESCE(...,0) anywhere on this
    // column is what would undo it, and would report instant feedback on a turn that gave none.
    //
    // MEASURED: over the 7 days to 2026-09-15 the shadow diff found six disagreements and all six had
    // this shape - derived TTFF present, ledger TTFF null.
    const { sql } = await latencyQuery();
    expect(sql).not.toMatch(/COALESCE\(\s*vl\.ttff_ms/);
    expect(sql).not.toMatch(/COALESCE\(\s*vl\.e2e_ms/);
  });

  it('counts a TTFF the ledger does not have, so the population change is visible rather than silent', async () => {
    // Partition, do not hide - the rule the whole file follows. Without this count the tab's TTFF
    // population would differ from the derived path's by a number nobody could see, which is the
    // failure `ttff_reconstructed_count` was added to prevent, arriving from the other side.
    const { sql, body } = await latencyQuery();
    expect(flat(sql)).toContain(
      'COUNT(*) FILTER (WHERE e.response_latency_ms IS NOT NULL AND vl.ttff_ms IS NULL)'
      + ' AS ttff_ledger_unmeasured_count',
    );
    expect(body.columns).toContain('ttff_ledger_unmeasured_count');
  });
});

describe('051: a deferral notice is not a turn', () => {
  const SCHEMA_DIR = path.join(__dirname, '../../lambda/src/analytics-aurora/schema');
  const FILE = '051-a-notice-is-not-a-turn.sql';
  const sql = fs.readFileSync(path.join(SCHEMA_DIR, FILE), 'utf8');

  it('drops a response whose ledger rows are ALL notices', () => {
    // THE DEFECT. A `notice_posted` row carries the notice message's own `response_id` and a NULL
    // `turn_id` (turn-events-live.ts writes it that way deliberately: the notice answers no turn), so
    // `v_turn_latency` grained a response for it with no placeholder, no final, no TTFF, no E2E and
    // `status = 'unresolved'`. Every queue episode injected one. The Turn Latency Audit lists these
    // rows unwindowed, so an operator read a deferral as an answer that went missing.
    expect(sql).toMatch(/HAVING bool_or\(kind <> 'notice_posted'\)/);
  });

  it('keeps a notice posted against a real turn, which is the whole point of bool_or', () => {
    // NOT a WHERE. Filtering the rows out would take the notice off a turn that has a placeholder as
    // well, losing an instant the ledger recorded. The HAVING drops the GROUP - the response - only
    // when nothing in it is anything other than a notice.
    const resp = sql.slice(sql.indexOf('resp AS ('), sql.indexOf('HAVING bool_or'));
    expect(resp.length).toBeGreaterThan(0);
    expect(resp).not.toMatch(/kind <> 'notice_posted'/);
    expect(resp).toMatch(/WHERE response_id IS NOT NULL/);
  });

  it('leaves the deferral measured where it belongs', () => {
    // v_queue_acknowledgement (039) is a queued message's first feedback, keyed on the acknowledged
    // message because several queued sends share one notice. This migration must not redefine or drop
    // it, or a duplicate reading is removed by deleting the real one.
    const executable = sql.replace(/--[^\n]*/g, '');
    expect(executable).not.toMatch(/(CREATE|DROP|ALTER)[^;]*v_queue_acknowledgement/i);
    // And the file says where the measurement went, so the next reader does not go looking.
    expect(sql).toContain('v_queue_acknowledgement');
  });

  it('is idempotent and transaction-safe, like every runtime-applied migration', () => {
    expect(sql).toContain('CREATE OR REPLACE VIEW v_turn_latency');
    expect(sql.replace(/--[^\n]*/g, '').toUpperCase()).not.toContain('CONCURRENTLY');
    expect(sql.match(/CREATE VIEW /g) || []).toEqual([]);
  });
});
