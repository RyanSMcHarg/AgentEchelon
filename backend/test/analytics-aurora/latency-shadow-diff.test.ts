/**
 * THE SHADOW DIFF: THE DERIVED PATH AND THE LEDGER ARE COMPARED PER TURN, AND THE COMPARISON IS HONEST.
 *
 * The Latency tab reads TTFF and E2E from the ledger (`v_turn_latency`) rather than the derived path
 * (exchanges), and that repoint is a measured change only because the two are seen to agree on live
 * traffic. `turn_latency_shadow_diff` is where they are seen. No test here executes SQL (nothing in
 * this suite does), so these pin the SHAPE whose mutations would make the diff lie:
 *
 *  - pairing on anything other than the identity the backfill's go/no-go used, which would compare two
 *    different turns and report the result as agreement or noise;
 *  - a plain join to exchanges, which counts a turn twice;
 *  - a tolerance that is not the stated constant, or that treats a figure present on one side only as
 *    a pass - the shape of the backfill's single disagreement;
 *  - classes that overlap or leave a gap, so the counts stop adding up to the population;
 *  - a window that reads one bound, and a query whose derived relations are read by columns they do not
 *    expose (the 42703 outage shape).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { checkSqlAliasColumns, sqlLiteralsIn } from '../helpers/sql-alias-columns';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

import { handler, SHADOW_DIFF_TOLERANCE_MS } from '../../lambda/src/analytics-aurora/analytics-query';
import { capabilityForQueryType } from '../../lambda/src/lib/admin-capability-map';
import { __testing as athena } from '../../lambda/src/analytics-query';
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

async function shadowDiff(rows: unknown[] = [], extra: Record<string, unknown> = {}) {
  mockDbQuery.mockResolvedValueOnce({ rows });
  const res = await handler(postEvent({
    queryType: 'turn_latency_shadow_diff',
    dateRange: { start: '2026-09-08', end: '2026-09-14' },
    ...extra,
  }));
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM v_turn_latency v/.test(sql as string));
  expect(call).toBeDefined();
  return { sql: call![0] as string, params: call![1] as unknown[], res, body: JSON.parse(res.body) };
}

/** The text of one CTE, from its name to the next top-level CTE name. */
function cte(sql: string, name: string, next: string): string {
  return sql.slice(sql.indexOf(`${name} AS (`), sql.indexOf(`${next} AS (`));
}

const SUMMARY = {
  compared_count: '1148',
  agree_count: '1140',
  disagree_count: '2',
  derived_only_count: '5',
  ledger_only_count: '1',
  ttff_diff_sample_count: '1142',
  p50_abs_ttff_diff_ms: 0,
  p95_abs_ttff_diff_ms: 1,
  max_abs_ttff_diff_ms: 412,
  e2e_diff_sample_count: '1100',
  p50_abs_e2e_diff_ms: 0,
  p95_abs_e2e_diff_ms: 0,
  max_abs_e2e_diff_ms: 3315,
  exchange_anchored_count: '37',
};

const DETAIL = {
  response_id: '9b7fe04c',
  channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/x/channel/c1',
  turn_id: 'corr-1',
  exchange_id: 91,
  placeholder_at: '2026-09-14T10:11:12.000Z',
  assistant: 'premium',
  paired_by: 'in_batch',
  anchor_source: 'ledger',
  trigger_kind: 'user',
  derived_ttff_ms: 2100,
  ledger_ttff_ms: 2100,
  ttff_diff_ms: 0,
  derived_e2e_ms: null,
  ledger_e2e_ms: 3315,
  e2e_diff_ms: null,
  classification: 'disagree',
  disagreed_on: 'e2e',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registration', () => {
  it('is served natively in Aurora mode, not reported unsupported', async () => {
    const { res, body } = await shadowDiff();
    expect(res.statusCode).toBe(200);
    expect(body.unsupported).toBeUndefined();
  });

  it('is Aurora-only in Athena mode, so the console gets the honest "requires Aurora" answer', () => {
    expect(athena.AURORA_ONLY_TYPES.has('turn_latency_shadow_diff')).toBe(true);
    expect(athena.SUPPORTED_TYPES.has('turn_latency_shadow_diff')).toBe(false);
  });

  it('is authorized as the aggregate analytics capability: it carries ids and durations, never content', () => {
    expect(capabilityForQueryType('turn_latency_shadow_diff')).toBe('view-analytics');
  });
});

describe('the pairing is the one v_turn_latency anchors on', () => {
  it('joins a ledger response to its placeholder row, and that row to the exchange that answers it', async () => {
    const { sql } = await shadowDiff();
    const derived = cte(sql, 'derived', 'ledger');
    // messages.message_id = v.response_id, same channel, the CREATE row, and exchanges.agent_message_id
    // = that row. (compareLatencyDerivations reaches the same rows far more loosely - a plain join, no
    // ordering, no LIMIT 1, no queued_as predicate - so it is not the thing this pins against.)
    expect(derived).toMatch(/SELECT m\.message_id\s+AS response_id/);
    expect(derived).toMatch(/m\.event_type = 'CREATE_CHANNEL_MESSAGE'/);
    expect(derived).toMatch(/WHERE ex\.agent_message_id = m\.id/);
    expect(sql).toMatch(/FULL OUTER JOIN derived d\s+ON d\.response_id = l\.response_id AND d\.channel_arn = l\.channel_arn/);
  });

  it('takes ONE exchange per placeholder, the same one v_turn_latency takes', async () => {
    // exchanges is unique on the (user, agent) PAIR, so a plain join emits a placeholder once per row and
    // counts that turn twice in every class.
    const { sql } = await shadowDiff();
    const derived = cte(sql, 'derived', 'ledger');
    expect(derived).toMatch(/JOIN LATERAL \(/);
    expect(derived).toMatch(/ORDER BY ex\.created_at\s+LIMIT 1/);
    expect(derived).not.toMatch(/JOIN exchanges/);
    // AND THE SAME PREDICATE, which is the half that makes "the same one" true (migration 052). A
    // folded answer carries one exchange per queued message it rolled in, all on this same message,
    // and a queued row's response_latency_ms holds the queue wait. Without this the derived side can
    // take one of those while the ledger takes the turn's own exchange, and every folded turn classes
    // as a disagreement that means nothing - which drowns the disagreements this query exists to find.
    expect(derived).toMatch(/AND ex\.queued_as IS NULL/);
  });

  it('compares the figures the tab reads against the figures the ledger derives', async () => {
    const { sql } = await shadowDiff();
    expect(sql).toMatch(/e\.response_latency_ms\s+AS derived_ttff_ms/);
    expect(sql).toMatch(/e\.e2e_ms\s+AS derived_e2e_ms/);
    expect(sql).toMatch(/v\.ttff_ms\s+AS ledger_ttff_ms/);
    expect(sql).toMatch(/v\.e2e_ms\s+AS ledger_e2e_ms/);
    // The difference is ledger minus derived, so a positive number means the ledger measured longer.
    expect(sql).toMatch(/\(j\.ledger_ttff_ms - j\.derived_ttff_ms\) AS ttff_diff_ms/);
    expect(sql).toMatch(/\(j\.ledger_e2e_ms - j\.derived_e2e_ms\)\s+AS e2e_diff_ms/);
  });
});

describe('classification', () => {
  it('binds the stated tolerance constant, and it is the rounding bound rather than a noise band', async () => {
    const { sql, params } = await shadowDiff();
    expect(SHADOW_DIFF_TOLERANCE_MS).toBe(1);
    expect(params[1]).toBe(SHADOW_DIFF_TOLERANCE_MS);
    expect(sql).toMatch(/ABS\(j\.ledger_ttff_ms - j\.derived_ttff_ms\) > \$2::integer/);
    expect(sql).toMatch(/ABS\(j\.ledger_e2e_ms - j\.derived_e2e_ms\) > \$2::integer/);
  });

  it('counts a figure present on only one side as a mismatch, never as a pass', async () => {
    // The backfill's one disagreement: ledger e2e 3315, derived NULL. ABS(NULL) > n is NULL, so without
    // the presence test that turn would fall through to agree.
    const { sql } = await shadowDiff();
    expect(sql).toMatch(/\(j\.derived_ttff_ms IS NULL\) <> \(j\.ledger_ttff_ms IS NULL\)/);
    expect(sql).toMatch(/\(j\.derived_e2e_ms IS NULL\) <> \(j\.ledger_e2e_ms IS NULL\)/);
  });

  it('classifies each turn ONCE into exactly the four classes, with one side absent checked first', async () => {
    const { sql } = await shadowDiff();
    const body = sql.slice(sql.indexOf('CASE', sql.indexOf('classified AS (')), sql.indexOf('END AS classification'));
    const arms = [...body.matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]);
    const elseArm = /ELSE '([a-z_]+)'/.exec(body)![1];
    expect([...arms, elseArm]).toEqual(['derived_only', 'ledger_only', 'disagree', 'agree']);
    // Every summary count reads that one value, one class each.
    for (const c of ['agree', 'disagree', 'derived_only', 'ledger_only']) {
      expect(sql).toMatch(new RegExp(`COUNT\\(\\*\\) FILTER \\(WHERE c\\.classification = '${c}'\\)\\s+AS ${c}_count`));
    }
  });

  it('leaves out a turn neither path measured, rather than calling it agreement', async () => {
    const { sql } = await shadowDiff();
    expect(sql).toMatch(/WHERE COALESCE\(j\.derived_ttff_ms, j\.derived_e2e_ms, j\.ledger_ttff_ms, j\.ledger_e2e_ms\) IS NOT NULL/);
  });

  it('reports the distribution of the absolute difference over turns both sides measured', async () => {
    const { sql } = await shadowDiff();
    for (const m of ['ttff', 'e2e']) {
      expect(sql).toMatch(new RegExp(`percentile_cont\\(0\\.5\\)\\s+WITHIN GROUP \\(ORDER BY ABS\\(c\\.${m}_diff_ms\\)\\)\\)\\s+AS p50_abs_${m}_diff_ms`));
      expect(sql).toMatch(new RegExp(`percentile_cont\\(0\\.95\\) WITHIN GROUP \\(ORDER BY ABS\\(c\\.${m}_diff_ms\\)\\)\\)\\s+AS p95_abs_${m}_diff_ms`));
    }
  });

  it('lists only the turns that need a look, and caps how many', async () => {
    const { sql, params } = await shadowDiff([], { limit: 9999 });
    expect(cte(sql, 'detail', 'NO_SUCH_CTE')).toMatch(/WHERE c\.classification <> 'agree'/);
    expect(params[2]).toBe(500);
  });
});

describe('the window', () => {
  it('reads both bounds on both sides, on the placeholder instant each side holds', async () => {
    const { sql, params } = await shadowDiff();
    expect(params[0]).toBe('[2026-09-08T00:00:00.000Z,2026-09-15T00:00:00.000Z)');
    expect(sql).toMatch(/m\.created_at >= lower\(\$1::tstzrange\) AND m\.created_at < upper\(\$1::tstzrange\)/);
    expect(sql).toMatch(/v\.t2_placeholder_at >= lower\(\$1::tstzrange\) AND v\.t2_placeholder_at < upper\(\$1::tstzrange\)/);
  });
});

describe('the SQL is well formed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');
  const lit = sqlLiteralsIn(src).find((l) => l.text.includes('FULL OUTER JOIN derived d'));

  it('is one literal, with balanced parentheses and no backtick to end it mid-query', () => {
    expect(lit).toBeDefined();
    let depth = 0;
    for (const ch of lit!.text.replace(/--[^\n]*/g, '').replace(/'[^']*'/g, "''")) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('uses every placeholder it binds, and binds every placeholder it uses', async () => {
    const { sql, params } = await shadowDiff();
    const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect([...used].sort()).toEqual(params.map((_, i) => i + 1));
  });

  it('reads no column a CTE or LATERAL does not expose, and the checker actually checked it', () => {
    const { violations, checkedReads } = checkSqlAliasColumns(lit!.text);
    expect(violations).toEqual([]);
    // Dozens of reads cross the CTEs here (j., c., s., d., f., l., e.); a collapse to a handful means
    // the checker stopped seeing them, not that they became correct.
    expect(checkedReads).toBeGreaterThan(60);
  });

  it('exposes every detail column and every summary field it returns', () => {
    const outer = lit!.text.slice(lit!.text.lastIndexOf('SELECT s.compared_count'));
    const { body } = { body: outer };
    for (const col of Object.keys(DETAIL)) expect(body).toMatch(new RegExp(`\\bd\\.${col}\\b`));
    for (const col of Object.keys(SUMMARY)) expect(body).toMatch(new RegExp(`\\bs\\.${col}\\b`));
  });
});

describe('the response', () => {
  it('returns the summary as numbers beside the rows, with the tolerance it was computed at', async () => {
    const { body } = await shadowDiff([{ ...SUMMARY, ...DETAIL }]);
    expect(body.summary).toEqual({
      tolerance_ms: 1,
      compared_count: 1148,
      agree_count: 1140,
      disagree_count: 2,
      derived_only_count: 5,
      ledger_only_count: 1,
      ttff_diff_sample_count: 1142,
      p50_abs_ttff_diff_ms: 0,
      p95_abs_ttff_diff_ms: 1,
      max_abs_ttff_diff_ms: 412,
      e2e_diff_sample_count: 1100,
      p50_abs_e2e_diff_ms: 0,
      p95_abs_e2e_diff_ms: 0,
      max_abs_e2e_diff_ms: 3315,
      exchange_anchored_count: 37,
    });
    expect(body.data).toEqual([DETAIL]);
    expect(body.columns).toEqual(Object.keys(DETAIL));
  });

  it('when every turn agreed, returns the summary and no rows rather than a null row', async () => {
    const nullDetail = Object.fromEntries(Object.keys(DETAIL).map((k) => [k, null]));
    const { body } = await shadowDiff([{ ...SUMMARY, disagree_count: '0', derived_only_count: '0', ledger_only_count: '0', ...nullDetail }]);
    expect(body.data).toEqual([]);
    expect(body.summary.compared_count).toBe(1148);
  });

  it('keeps an empty distribution null, so "no turn had both figures" is not read as "no difference"', async () => {
    const { body } = await shadowDiff([]);
    expect(body.summary.compared_count).toBe(0);
    expect(body.summary.p95_abs_ttff_diff_ms).toBeNull();
    expect(body.summary.max_abs_e2e_diff_ms).toBeNull();
  });
});
