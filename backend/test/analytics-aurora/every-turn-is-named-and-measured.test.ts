/**
 * EVERY TURN IS NAMED AND MEASURED, and no analytics value reads "unknown".
 *
 * Every assistant turn burns tokens and takes time, so every one has to say what kind of turn it was and
 * how long it took from its OWN start to its own final post. The Latency tab grouped by the exchange's
 * delivery option, and a turn no person's message anchors has none: measured live on dev, 290 turns in 47
 * rows, 214 of them unpaired (readings, rebuttals, welcomes, join recaps, folded readings) and 76 paired
 * with no delivery option (duel rounds, queue acknowledgments). All of them grouped as 'unknown' with no
 * end to end, so analytics-accuracy.spec.ts found a whole population blind.
 *
 * WHAT THIS PINS:
 *   - the row label is the delivery option, else the declared turn kind, else the named defect
 *     undeclared_turn - never NULL and never 'unknown' - and the drill filters on the same label;
 *   - each turn's span starts where that KIND of turn starts (declared trigger, the acknowledged message,
 *     the person's message, or the processor's entry), decided by kind rather than by which column happens
 *     to be present;
 *   - every group reports its tokens and its cost, priced per model;
 *   - battle results carry every round each side fought, attributed to the side that fought it, whether or
 *     not the round paired.
 *
 * The SQL is checked as text, the way every sibling in this directory checks it: there is no Postgres in
 * the unit suite. The JS halves (pricing, round attribution) are exercised for real.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
const mockEnsureSchema = jest.fn().mockResolvedValue(undefined);

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: mockEnsureSchema,
  getClient: jest.fn(),
}));

import { handler, priceLatencyRow, battleRoundsBySide } from '../../lambda/src/analytics-aurora/analytics-query';
import { estimateStepCostUsd } from '../../lambda/src/lib/model-rate-table';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { analyticsPathFor } from '../helpers/analytics-path';
import { edgeContext } from '../helpers/edge-context';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: analyticsPathFor(body),
    body: JSON.stringify(body),
    requestContext: {
      authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }),
    },
  } as unknown as APIGatewayProxyEvent;
}

const RANGE = { start: '2026-10-09', end: '2026-10-16' };
/** SQL with its comment lines removed, so a word in an explanation cannot satisfy or fail a check. */
const sqlOnly = (s: string): string => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

async function sqlFor(queryType: string, extra: Record<string, unknown> = {}, rows: unknown[] = []): Promise<{ sql: string; body: any }> {
  mockDbQuery.mockResolvedValueOnce({ rows });
  const res = await handler(postEvent({ queryType, dateRange: RANGE, ...extra }));
  expect(res.statusCode).toBe(200);
  const call = mockDbQuery.mock.calls[mockDbQuery.mock.calls.length - 1];
  return { sql: call[0] as string, body: JSON.parse(res.body) };
}

/** One lateral's body, from its opening to its alias, so a clause elsewhere cannot satisfy a check. */
function lateral(sql: string, alias: string): string {
  const end = sql.indexOf(`) ${alias} ON TRUE`);
  expect(end).toBeGreaterThan(-1);
  const start = sql.lastIndexOf('LEFT JOIN LATERAL (', end);
  expect(start).toBeGreaterThan(-1);
  return sqlOnly(sql.slice(start, end));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureSchema.mockResolvedValue(undefined);
});

describe('a latency row is named, never unknown', () => {
  it('groups by the label, and the label has no unknown and no NULL in it', async () => {
    const { sql } = await sqlFor('latency_metrics');
    const code = sqlOnly(sql);
    // The old bucket, gone from both the SELECT and the GROUP BY.
    expect(code).not.toMatch(/COALESCE\(e\.delivery_option, 'unknown'\)/);
    expect(code).toMatch(/lbl\.delivery_option AS delivery_option/);
    expect(code.slice(code.lastIndexOf('GROUP BY'))).toMatch(/lbl\.delivery_option/);
    expect(code.slice(code.lastIndexOf('GROUP BY'))).not.toMatch(/\be\.delivery_option\b/);

    const label = flat(lateral(sql, 'lbl'));
    // The delivery option first, then the kind, then the message's own declaration, then the defect -
    // and the COALESCE is total, so the label cannot be NULL.
    expect(label).toMatch(/AS kind/);
    expect(label).toMatch(/COALESCE\(e\.delivery_option, CASE .* END, m\.delivery_option, upd\.delivery_option, 'undeclared_turn'\) AS delivery_option/);
    expect(label).not.toMatch(/'unknown'/);
  });

  it('names each kind from what a producer declared, in a fixed precedence', async () => {
    const { sql } = await sqlFor('latency_metrics');
    const kind = flat(lateral(sql, 'lbl'));
    const at = (needle: string): number => {
      const i = kind.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    // A declared receipt first: its answer moved to a message of its own, which is the turn. A resumed
    // duel side's placeholder carries the round marker and is closed out as a receipt, and named by its
    // round it read as the side's answer, so the one turn was counted twice.
    const receipt = at(`WHEN COALESCE(upd.turn_kind, m.turn_kind, upd.metadata->>'turnKind', m.metadata->>'turnKind') = 'receipt' THEN 'receipt'`);
    // A duel round is a duel round whatever else it declared (round 1 and round 2 alike).
    const round = at(`WHEN COALESCE(m.battle_round, vl.battle_round) IS NOT NULL THEN 'battle_round_' || COALESCE(m.battle_round, vl.battle_round)::text`);
    // The declared kind - reading, welcome, join_recap, drift, notification - from the latest update first,
    // because archival does not fold turn_kind onto the CREATE.
    const declared = kind.indexOf(`WHEN COALESCE(upd.turn_kind, m.turn_kind, upd.metadata->>'turnKind', m.metadata->>'turnKind') IS NOT NULL`, round);
    expect(declared).toBeGreaterThan(round);
    expect(receipt).toBeLessThan(round);
    // A deferral notice, read off the CREATE's own Metadata only.
    const ack = at(`WHEN m.metadata->>'respPhase' = 'notice' THEN 'queue_ack'`);
    expect(kind).not.toMatch(/upd\.metadata->>'respPhase'/);
    const handover = at(`'aeHandover') THEN 'handover'`);
    // The declared interaction kind, with the retired dispatcher name read as the rebuttal it was.
    const legacy = at(`= 'orchestrator' THEN 'rebuttal'`);
    const trigger = at(`<> 'user' THEN COALESCE(vl.trigger_kind, upd.metadata->>'trigger', m.metadata->>'trigger')`);
    expect([round, declared, ack, handover, legacy, trigger]).toEqual(
      [...[round, declared, ack, handover, legacy, trigger]].sort((a, b) => a - b),
    );
  });

  // LIVE, dev, 2026-10-23: a placeholder became the queue notice, its private answer moved to a message of
  // its own, and the notice was closed out as `turnKind: 'receipt'`, final. Before migration 084 the
  // archive kept one `-UPD` row per message, the FIRST update (the notice's queue_ack), so the receipt's
  // kind survived only as the CREATE row's agent_final_at and answers_message_id, and the turn was
  // labeled undeclared_turn. Every update is its own row now and the latest declares `receipt` itself;
  // this arm keeps the pre-084 rows named the same way.
  it('names a final queue notice whose answer another message carries as the receipt, before the answer arm', async () => {
    for (const queryType of ['latency_metrics', 'turn_kinds']) {
      const { sql } = await sqlFor(queryType);
      const code = flat(sqlOnly(sql));
      const moved = `m.answers_message_id IS NOT NULL AND EXISTS ( SELECT 1 FROM messages moved WHERE moved.channel_arn = m.channel_arn AND moved.answers_message_id = m.answers_message_id AND moved.message_id <> m.message_id AND COALESCE(moved.base_message_id, moved.message_id) <> m.message_id)`;
      const receipt = code.indexOf(`= 'queue_ack' AND m.agent_final_at IS NOT NULL AND (${moved}) THEN 'receipt'`);
      const answer = code.indexOf(`= 'queue_ack' AND m.agent_final_at IS NOT NULL THEN NULL`);
      expect({ queryType, receipt: receipt > -1 }).toEqual({ queryType, receipt: true });
      expect(answer).toBeGreaterThan(receipt);
    }
  });

  it('drills on the same label, so a kind-labeled row does not drill to nothing', async () => {
    const { sql } = await sqlFor('latency_exchanges', { deliveryOption: 'reading' });
    const code = flat(sqlOnly(sql));
    // The message's LATEST update row (migration 084), the same join the breakdown reads.
    expect(code).toContain("LEFT JOIN LATERAL ( SELECT upd_ev.* FROM messages upd_ev WHERE upd_ev.channel_arn = m.channel_arn AND upd_ev.event_type = 'UPDATE_CHANNEL_MESSAGE' AND upd_ev.base_message_id = m.message_id ORDER BY upd_ev.last_updated_at DESC NULLS LAST");
    expect(flat(lateral(sql, 'lbl'))).toMatch(/COALESCE\(e\.delivery_option, CASE .* END, m\.delivery_option, upd\.delivery_option, 'undeclared_turn'\) AS delivery_option/);
    expect(code).toContain('($4::varchar IS NULL OR lbl.delivery_option = $4)');
    expect(code).not.toMatch(/\$4 = 'unknown'/);
  });
});

describe('the drill reads the population the breakdown counts', () => {
  /** The population's joins and WHERE, comments removed and whitespace flattened. */
  async function population(queryType: string, extra: Record<string, unknown> = {}): Promise<{ joins: string; where: string; code: string }> {
    const { sql } = await sqlFor(queryType, extra);
    const code = flat(sqlOnly(sql));
    // The last one: latency_metrics states the same joins in its model_mix CTE before the grid.
    const from = code.lastIndexOf('FROM messages m LEFT JOIN LATERAL ( SELECT ex.* FROM exchanges ex');
    expect(from).toBeGreaterThan(-1);
    const joinsEnd = code.indexOf(') lbl ON TRUE', from) + ') lbl ON TRUE'.length;
    const whereAt = code.indexOf('WHERE m.is_bot = true', joinsEnd);
    expect(whereAt).toBeGreaterThan(-1);
    const whereEnd = code.indexOf('< upper($1::tstzrange)', whereAt) + '< upper($1::tstzrange)'.length;
    return { joins: code.slice(from, joinsEnd), where: code.slice(whereAt, whereEnd), code };
  }

  it('selects from messages, never from exchanges, with the same joins and the same WHERE', async () => {
    const breakdown = await population('latency_metrics');
    const drill = await population('latency_exchanges', { deliveryOption: 'undeclared_turn' });
    // Identical text, so the two cannot count different turns: the exchange is one row or none, minus
    // the queued pairings, and an unpaired turn is in both.
    expect(drill.joins).toBe(breakdown.joins);
    expect(drill.where).toBe(breakdown.where);
    expect(drill.joins).toContain('AND ex.queued_as IS NULL ORDER BY ex.created_at LIMIT 1 ) e ON true');
    expect(drill.where).toContain("m.event_type = 'CREATE_CHANNEL_MESSAGE'");
    expect(drill.where).toContain("(e.id IS NOT NULL OR m.total_ms IS NOT NULL OR m.content LIKE '%<!--corr:%')");
    // The old drill read FROM exchanges and cut the window on the exchange, which emptied every
    // unpaired row.
    expect(drill.code).not.toMatch(/FROM exchanges e\b/);
    expect(drill.code).not.toMatch(/WHERE e\.created_at/);
  });

  it('filters on each grouping expression of the breakdown, verbatim', async () => {
    const { code: breakdown } = await population('latency_metrics');
    const groupBy = breakdown.slice(
      breakdown.lastIndexOf('GROUP BY ') + 'GROUP BY '.length,
      breakdown.lastIndexOf(' ) SELECT grid.*'),
    );
    // Split on the commas between expressions, not the ones inside a COALESCE.
    const dims = groupBy.split(/, (?![^()]*\))/).map((d) => d.trim());
    expect(dims).toHaveLength(8);
    const { code: drill } = await population('latency_exchanges');
    // The GROUP BY order: day, assistant, label, entry, role, version, round, classification.
    const param = ['$2::date', '$3', '$4', '$8', '$5', '$6', '$11', '$7'];
    dims.forEach((d, i) => {
      expect(drill).toContain(`${d} = ${param[i]})`);
    });
  });

  it("keeps a paired row's exchange columns and reports the turn itself on every row", async () => {
    const { sql } = await sqlFor('latency_exchanges');
    const code = flat(sqlOnly(sql));
    expect(code).toMatch(/SELECT e\.id AS exchange_id, m\.id AS message_id,/);
    expect(code).toContain('lbl.kind AS turn_kind');
    expect(code).toContain('e.paired_by,');
    expect(code).toContain('COALESCE(e.created_at, m.created_at) AS created_at');
    expect(code).toContain('ORDER BY m.total_ms DESC NULLS LAST, m.created_at DESC');
  });
});

describe('each turn is timed from its own start', () => {
  it('chooses the start by what the turn is, in order', async () => {
    const { sql } = await sqlFor('latency_metrics');
    const src = flat(lateral(sql, 'tsrc'));
    expect(src).toBe(flat(`LEFT JOIN LATERAL (
       SELECT CASE
                WHEN COALESCE(m.battle_round, vl.battle_round, 1) > 1     THEN 'declared_trigger'
                WHEN lbl.kind = 'queue_ack'                               THEN 'acknowledged_message'
                WHEN lbl.kind = 'join_recap' AND mj.joined_at IS NOT NULL THEN 'membership_event'
                WHEN lbl.kind = 'reading' AND m.trigger_at IS NOT NULL    THEN 'queue_release'
                WHEN lbl.kind = 'receipt'                                 THEN 'carried_by_answer'
                WHEN lbl.kind IS NULL OR lbl.kind IN ('battle_round_1', 'handover', 'repair', 'recovery') THEN 'person_message'
                WHEN m.trigger_at IS NOT NULL                             THEN 'declared_trigger'
                WHEN vl.e2e_ms IS NOT NULL                                THEN 'person_message'
                WHEN m.total_ms IS NOT NULL                               THEN 'processor_entry'
              END AS turn_ms_source
     `));
  });

  it('measures each source from its own instants, and never from the person for a later round', async () => {
    const { sql } = await sqlFor('latency_metrics');
    const span = flat(lateral(sql, 'ts'));
    // Round two: the ledger's own round-two figure, declared trigger to final answer (migration 071).
    expect(span).toMatch(/WHEN COALESCE\(m\.battle_round, vl\.battle_round, 1\) > 1 THEN vl\.e2e_ms/);
    // A join recap: the membership event that triggered it, to its final answer.
    expect(span).toMatch(/'membership_event' AND COALESCE\(vl\.t3_final_at, m\.agent_final_at\) >= mj\.joined_at/);
    expect(flat(sql)).toMatch(/mj\.event_type = 'CREATE_CHANNEL_MEMBERSHIP' AND mj\.target_arn = m\.targeted_to/);
    // A queue acknowledgment: the message it names, to the moment the acknowledgment reached the person -
    // its own post, or the update that wrote it into a running answer's placeholder.
    expect(span).toMatch(/'acknowledged_message' AND COALESCE\(qm\.created_at, e\.user_message_at\) IS NOT NULL/);
    expect(span).toMatch(/COALESCE\(l\.notice_at, m\.created_at\) - COALESCE\(qm\.created_at, e\.user_message_at\)/);
    // A reading: the drain's release of the queued work, to the delivered message - the final answer,
    // else the update that delivered its interim proposal.
    expect(span).toMatch(/'queue_release' AND COALESCE\(vl\.t3_final_at, m\.agent_final_at, l\.delivered_at\) >= m\.trigger_at/);
    expect(span).toMatch(/COALESCE\(vl\.t3_final_at, m\.agent_final_at, l\.delivered_at\) - m\.trigger_at/);
    // A receipt has no span arm: its moved answer carries the person's wait, so its turn_ms is NULL.
    expect(span).not.toContain('receipt');
    expect(span).not.toContain('carried_by_answer');
    // A join recap or a repair: its declared trigger to the final answer.
    expect(span).toMatch(/COALESCE\(vl\.t3_final_at, m\.agent_final_at\) - m\.trigger_at/);
    // A processor turn with no other start on record: processor entry to the final post being issued.
    expect(span).toMatch(/WHEN tsrc\.turn_ms_source = 'processor_entry' THEN m\.total_ms/);
    // The acknowledged message is found by the id the notice names, on the CREATE or on the update that
    // wrote the notice into a placeholder, and cannot fan out.
    const code = flat(sqlOnly(sql));
    expect(code).toContain("LEFT JOIN messages qm ON qm.channel_arn = m.channel_arn AND qm.event_type = 'CREATE_CHANNEL_MESSAGE' AND qm.message_id = COALESCE(m.metadata->>'acknowledges', upd.metadata->>'acknowledges')");
    // Nothing joins the receipt's person message: nothing times the receipt from it.
    expect(code).not.toContain('LEFT JOIN messages pm');
    // The two ledger instants the new ends read, one per response.
    expect(code).toContain("MIN(occurred_at) FILTER (WHERE kind = 'notice_posted') AS notice_at");
    expect(code).toContain("MIN(occurred_at) FILTER (WHERE kind IN ('progress_update','final_response')) AS delivered_at");
  });

  it('keeps e2e a person\'s wait, and reports the span beside it with its provenance', async () => {
    const { sql, body } = await sqlFor('latency_metrics');
    const code = flat(sqlOnly(sql));
    // The headline is unchanged: round two stays out of a person's wait.
    expect(code).toMatch(/ROUND\(AVG\(vl\.e2e_ms\) FILTER \(WHERE COALESCE\(vl\.battle_round, 1\) <= 1\)\) AS avg_e2e_ms/);
    expect(code).toMatch(/ROUND\(AVG\(ts\.turn_ms\)\) AS avg_turn_ms/);
    expect(code).toMatch(/COUNT\(ts\.turn_ms\) AS turn_measured_count/);
    for (const s of ['person_message', 'declared_trigger', 'acknowledged_message', 'processor_entry', 'membership_event', 'queue_release']) {
      expect(code).toContain(`FILTER (WHERE ts.turn_ms_source = '${s}')`);
    }
    expect(body.columns).toEqual(expect.arrayContaining([
      'avg_turn_ms', 'p95_turn_ms', 'turn_measured_count',
      'turn_span_person_count', 'turn_span_trigger_count', 'turn_span_ack_count', 'turn_span_processor_count',
      'turn_span_membership_count', 'tokens_in', 'tokens_out', 'cost_usd', 'cost_priced_turns',
      'turn_span_queue_release_count',
    ]));
    expect(code).toContain("FILTER (WHERE ts.turn_ms_source = 'queue_release') AS turn_span_queue_release_count");
    // ONE WAIT, ONE SPAN. A receipt and its moved answer both start from the same person's message; only
    // the answer is timed, and the receipt is counted apart from the six sources that partition
    // turn_measured_count.
    expect(code).toContain("COUNT(*) FILTER (WHERE tsrc.turn_ms_source = 'carried_by_answer') AS turn_carried_by_answer_count");
    expect(code).not.toContain("FILTER (WHERE ts.turn_ms_source = 'carried_by_answer')");
    expect(body.columns[body.columns.length - 1]).toBe('turn_carried_by_answer_count');
    // Appended: the first four columns are the contract every reader keys on.
    expect(body.columns.slice(0, 4)).toEqual(['date', 'assistant', 'delivery_option', 'assistant_turn_count']);
  });
});

describe('every group reports what it spent', () => {
  const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';

  it('sums tokens over every turn in the group, paired or not', async () => {
    const { sql } = await sqlFor('latency_metrics');
    const code = flat(sqlOnly(sql));
    expect(code).toMatch(/COALESCE\(SUM\(m\.input_tokens\), 0\) AS tokens_in/);
    expect(code).toMatch(/COALESCE\(SUM\(m\.output_tokens\), 0\) AS tokens_out/);
    expect(code).toMatch(/AS turn_models/);
  });

  it('ships tokens per (leg, model) per group, never one entry per turn', async () => {
    const { sql } = await sqlFor('latency_metrics');
    const code = flat(sqlOnly(sql));
    const grid = code.slice(code.indexOf('grid AS ('), code.indexOf(') SELECT grid.*'));
    // The grid itself aggregates no per-turn list.
    expect(grid).not.toMatch(/jsonb_agg/);
    const leg = code.slice(code.indexOf('model_leg AS ('), code.indexOf('model_mix AS ('));
    expect(leg).toMatch(/COUNT\(\*\) AS replies, COALESCE\(SUM\(leg\.tokens_in\), 0\) AS tokens_in/);
    expect(leg).toMatch(/GROUP BY .*, leg\.leg, leg\.model \), $/);
    expect(leg).toContain("('answer', m.bedrock_model, m.input_tokens, m.output_tokens)");
    expect(leg).toContain("('classifier', m.classifier_model, m.classifier_tokens_in, m.classifier_tokens_out)");
    expect(code).toContain('SELECT grid.*, mm.turn_models FROM grid LEFT JOIN model_mix mm');
    expect(code).toContain('mm.profile_version IS NOT DISTINCT FROM grid.profile_version');
  });

  it('prices each model at its own rate and removes the working list from the row', () => {
    const row = priceLatencyRow({
      delivery_option: 'reading',
      turn_models: [
        { leg: 'answer', model: HAIKU, replies: 2, tokensIn: 3000, tokensOut: 600 },
        { leg: 'classifier', model: HAIKU, replies: 1, tokensIn: 300, tokensOut: 5 },
      ],
    });
    expect(row).not.toHaveProperty('turn_models');
    expect(row.delivery_option).toBe('reading');
    expect(typeof row.cost_usd).toBe('number');
    expect(row.cost_usd as number).toBeGreaterThan(0);
    // Two answers priced; the classifier leg adds spend and no turn.
    expect(row.cost_priced_turns).toBe(2);
  });

  it('reports null, never 0, when nothing in the group is priceable', () => {
    expect(priceLatencyRow({ turn_models: null })).toMatchObject({ cost_usd: null, cost_priced_turns: 0 });
    expect(priceLatencyRow({ turn_models: [{ leg: 'answer', model: 'no-such-model', replies: 1, tokensIn: 10, tokensOut: 10 }] }))
      .toMatchObject({ cost_usd: null, cost_priced_turns: 0 });
  });

  it('prices the per-model sums exactly as it priced the turns one by one', () => {
    // A second model with its own rate, read from the catalog the rate table maps ids through.
    const SONNET = Object.values(getModelCatalog('us-east-1', '000000000000')).find((d) => d.key === 'sonnet')!.bedrockModelId;
    // Five turns on two models, two of them classified on Haiku, one with no token count.
    const turns = [
      { model: HAIKU, tin: 1200, tout: 340, cm: HAIKU, ctin: 310, ctout: 4 },
      { model: HAIKU, tin: 800, tout: 95, cm: null, ctin: null, ctout: null },
      { model: SONNET, tin: 4100, tout: 1250, cm: HAIKU, ctin: 290, ctout: 6 },
      { model: SONNET, tin: 2600, tout: 700, cm: null, ctin: null, ctout: null },
      { model: SONNET, tin: null, tout: null, cm: null, ctin: null, ctout: null },
    ];
    expect(estimateStepCostUsd({ modelId: SONNET, tokensIn: 1, tokensOut: 1 })).not.toBeNull();
    // Per turn, per leg: what the per-turn list used to be priced as.
    let expected = 0;
    for (const t of turns) {
      expected += estimateStepCostUsd({ modelId: t.model, tokensIn: t.tin ?? 0, tokensOut: t.tout ?? 0 }) ?? 0;
      if (t.cm) expected += estimateStepCostUsd({ modelId: t.cm, tokensIn: t.ctin ?? 0, tokensOut: t.ctout ?? 0 }) ?? 0;
    }
    // What model_mix ships for the same five turns: one entry per (leg, model).
    const sum = (xs: Array<number | null>): number => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
    const on = (m: string) => turns.filter((t) => t.model === m);
    const classified = turns.filter((t) => t.cm === HAIKU);
    const row = priceLatencyRow({
      turn_models: [
        { leg: 'answer', model: HAIKU, replies: 2, tokensIn: sum(on(HAIKU).map((t) => t.tin)), tokensOut: sum(on(HAIKU).map((t) => t.tout)) },
        { leg: 'answer', model: SONNET, replies: 3, tokensIn: sum(on(SONNET).map((t) => t.tin)), tokensOut: sum(on(SONNET).map((t) => t.tout)) },
        { leg: 'classifier', model: HAIKU, replies: 2, tokensIn: sum(classified.map((t) => t.ctin)), tokensOut: sum(classified.map((t) => t.ctout)) },
      ],
    });
    expect(row.cost_usd as number).toBeGreaterThan(0);
    expect(row.cost_usd).toBeCloseTo(Math.round(expected * 1e6) / 1e6, 6);
    // Every answer is a priced turn; the classifier leg adds spend and no turn.
    expect(row.cost_priced_turns).toBe(5);
  });
});

describe('battle results carry every round, attributed to its side', () => {
  it('reads the rounds from the messages each round posted, not from the exchange population', async () => {
    const { sql } = await sqlFor('battle_results');
    const code = flat(sqlOnly(sql));
    const start = code.indexOf('round_facts AS (');
    expect(start).toBeGreaterThan(-1);
    const facts = code.slice(start, code.indexOf('SELECT b.battle_id', start));
    expect(facts).toMatch(/FROM messages bm JOIN matched ON matched\.battle_id = bm\.battle_id/);
    expect(facts).toMatch(/COALESCE\(bm\.variant_id, bx\.variant_id\) AS variant_id/);
    expect(facts).toMatch(/bm\.battle_round IS NOT NULL/);
    expect(facts).toMatch(/COUNT\(bvl\.e2e_ms\) AS measured_count/);
    expect(facts).toMatch(/GROUP BY bm\.battle_id, COALESCE\(bm\.variant_id, bx\.variant_id\), bm\.battle_round, bm\.bedrock_model/);
  });

  it('credits each round to the side that fought it, and counts a round that named no side', () => {
    const { bySide, unattributed } = battleRoundsBySide([
      { variant_id: 'control', round: 1, model: 'anthropic.claude-3-haiku-20240307-v1:0', turn_count: 1, measured_count: 1, turn_ms_sum: 4000, tokens_in: 100, tokens_out: 50 },
      { variant_id: 'control', round: 2, model: 'anthropic.claude-3-haiku-20240307-v1:0', turn_count: 1, measured_count: 1, turn_ms_sum: 3000, tokens_in: 200, tokens_out: 80 },
      { variant_id: 'treatment', round: 2, model: 'no-such-model', turn_count: 1, measured_count: 0, turn_ms_sum: null, tokens_in: 10, tokens_out: 5 },
      { variant_id: 'treatment', round: 1, model: 'no-such-model', turn_count: 2, measured_count: 2, turn_ms_sum: 9000, tokens_in: 10, tokens_out: 5 },
      { variant_id: null, round: 2, model: null, turn_count: 3, measured_count: 0, turn_ms_sum: null, tokens_in: 0, tokens_out: 0 },
    ]);
    expect(unattributed).toBe(3);
    const control = bySide.get('control')!;
    expect(control.map((r) => r.round)).toEqual([1, 2]);
    expect(control[1]).toMatchObject({ round: 2, turn_count: 1, measured_count: 1, avg_turn_ms: 3000, tokens_in: 200, tokens_out: 80 });
    expect(control[1].cost_usd as number).toBeGreaterThan(0);
    const treatment = bySide.get('treatment')!;
    // Sorted by round whatever order the facts arrived in.
    expect(treatment.map((r) => r.round)).toEqual([1, 2]);
    expect(treatment[0]).toMatchObject({ turn_count: 2, avg_turn_ms: 4500 });
    // A round with no recorded span is unmeasured, not instant; an unpriceable model is null, not free.
    expect(treatment[1]).toMatchObject({ measured_count: 0, avg_turn_ms: null, cost_usd: null });
  });

  it('lists a side that only ever fought unpaired rounds, with its rounds', async () => {
    const { body } = await sqlFor('battle_results', {}, [{
      battle_id: 'b-1', fought_at: '2026-10-15T10:00:00.000Z', channel_arn: 'arn:c', conversation_classification: 'premium',
      experiment_id: 'exp-1', rounds: '2', sides: '1', turn_count: '1',
      contenders: [{ variant_id: 'control', assistant: 'advisor', assistant_role: 'primary', profile_version: 7, profile_config_id: 'cfg', model_name: 'm', turn_count: '1', avg_score: null }],
      round_facts: [
        { variant_id: 'control', round: 1, model: 'm', turn_count: 1, measured_count: 1, turn_ms_sum: 5000, tokens_in: 1, tokens_out: 1 },
        { variant_id: 'treatment', round: 2, model: 'm', turn_count: 1, measured_count: 1, turn_ms_sum: 7000, tokens_in: 1, tokens_out: 1 },
      ],
    }]);
    const d = body.data[0];
    expect(d.sides).toBe(2);
    expect(d.unattributed_round_turns).toBe(0);
    expect(d.contenders.map((c: any) => c.variant_id)).toEqual(['control', 'treatment']);
    expect(d.contenders[0].rounds.map((r: any) => r.round)).toEqual([1]);
    expect(d.contenders[1]).toMatchObject({ turn_count: 0, avg_score: null });
    expect(d.contenders[1].rounds[0]).toMatchObject({ round: 2, avg_turn_ms: 7000 });
  });
});
