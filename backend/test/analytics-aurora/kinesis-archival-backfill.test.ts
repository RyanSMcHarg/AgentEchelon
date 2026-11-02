/**
 * kinesis-archival — placeholder->final backfill unit tests.
 *
 * Delivery is placeholder->update: the bot posts a "One moment..." placeholder
 * (CREATE_CHANNEL_MESSAGE), then edits in the real answer + model
 * (UPDATE_CHANNEL_MESSAGE, archived as a separate `<id>-UPD` row). Analytics
 * reads resolve the canonical CREATE row, so `backfillFromUpdateEvents` must
 * fold the final content/model onto that message row and the intent/routing onto
 * its exchange. These tests pin that contract:
 *   - the CREATE message row is patched with updated_content + model/telemetry;
 *   - the exchange is patched with intent/routing (intent lives only on the
 *     exchange — there is no messages.intent column);
 *   - the `-UPD` suffix is stripped to recover the CREATE message_id;
 *   - a record whose id does not end in `-UPD` is skipped (no query issued);
 *   - a failing patch is swallowed (archival of the batch must not abort).
 */

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  batchInsert: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { backfillFromUpdateEvents } from '../../lambda/src/analytics-aurora/kinesis-archival';

const mockedQuery = query as jest.MockedFunction<typeof query>;

/** Minimal UPDATE MessageRecord for the backfill (only the read fields matter). */
function updateRecord(overrides: Record<string, any> = {}): any {
  return {
    event_type: 'UPDATE_CHANNEL_MESSAGE',
    message_id: 'msg-123-UPD',
    channel_arn: 'arn:aws:chime:...:channel/abc',
    content: 'The Q2 ARR is $4.2M.',
    sender_arn: 'arn:aws:chime:...:bot/premium',
    sender_name: 'Assistant',
    target_arn: null,
    is_bot: true,
    conversation_classification: 'premium',
    assistant: 'premium',
    bedrock_model: 'anthropic.claude-opus',
    input_tokens: 120,
    output_tokens: 340,
    latency_ms: 900,
    total_ms: 1800,
    poll_ms: 50,
    model_ms: 700,
    tool_ms: 200,
    processor_entry_ms: 1752537600000,
    persistence: 'PERSISTENT',
    metadata: {},
    created_at: '2026-07-15T00:00:00.000Z',
    // The UPDATE event's own Chime timestamp (final answer posted 2s after the placeholder).
    last_updated_at: '2026-07-15T00:00:02.000Z',
    intent: 'BUSINESS_QUERY',
    intent_confidence: 'high',
    was_rerouted: false,
    delivery_option: 'inline',
    task_id: null,
    task_status: null,
    task_state: null,
    task_transition: null,
    experiment_id: null,
    variant_id: null,
    was_fallback: false,
    ...overrides,
  };
}

describe('kinesis-archival backfillFromUpdateEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it('patches the CREATE message row with final content + model, keyed by the de-suffixed id', async () => {
    await backfillFromUpdateEvents([updateRecord()]);

    const messageCall = mockedQuery.mock.calls.find(([sql]) =>
      /UPDATE messages/.test(sql as string)
    );
    expect(messageCall).toBeDefined();
    const [sql, params] = messageCall as [string, any[]];
    // The update's text, unless a later update of the same message is already stored (migration 084).
    expect(sql).toMatch(/THEN updated_content\s+ELSE COALESCE\(\$1, updated_content\) END/);
    expect(sql).toMatch(/bedrock_model\s*=\s*COALESCE\(\$2, bedrock_model\)/);
    expect(sql).toContain("event_type = 'CREATE_CHANNEL_MESSAGE'");
    // $1 final content, $2 model, $12 de-suffixed CREATE id, $13 channel.
    expect(params[0]).toBe('The Q2 ARR is $4.2M.');
    expect(params[1]).toBe('anthropic.claude-opus');
    expect(params[11]).toBe('msg-123'); // '-UPD' stripped
    // $25: the conversation's classification folds onto the canonical row like the rest.
    expect(sql).toMatch(/conversation_classification\s*=\s*COALESCE\(\$25, conversation_classification\)/);
    expect(params[24]).toBe('premium');
    expect(params[12]).toBe('arn:aws:chime:...:channel/abc');
  });

  it('patches the exchange with intent/routing (intent is exchange-only)', async () => {
    await backfillFromUpdateEvents([updateRecord()]);

    const exchangeCall = mockedQuery.mock.calls.find(([sql]) =>
      /UPDATE exchanges/.test(sql as string)
    );
    expect(exchangeCall).toBeDefined();
    const [sql, params] = exchangeCall as [string, any[]];
    expect(sql).toMatch(/intent\s*=\s*COALESCE\(\$1, ex\.intent\)/);
    expect(sql).toContain('ex.agent_message_id = am.id');
    expect(sql).toContain('am.message_id = $12');
    expect(params[0]).toBe('BUSINESS_QUERY');
    expect(sql).toMatch(/conversation_classification\s*=\s*COALESCE\(\$17, ex\.conversation_classification\)/);
    expect(params[16]).toBe('premium');
    expect(params[11]).toBe('msg-123');
    expect(params[12]).toBe('arn:aws:chime:...:channel/abc');
  });

  it('derives agent_final_at from the update timestamp (gated on the DECLARED phase) and e2e_ms on the exchange', async () => {
    await backfillFromUpdateEvents([updateRecord({ resp_phase: 'final' })]);

    // agent_final_at is the Chime update time ($14), set when the producer DECLARED this update the
    // final answer ($17), and frozen by COALESCE so a later moderation/battle update cannot move it.
    const messageCall = mockedQuery.mock.calls.find(([sql]) => /UPDATE messages/.test(sql as string));
    const [msgSql, msgParams] = messageCall as [string, any[]];
    expect(msgSql).toMatch(/\$17::text = 'final' THEN \$14::timestamptz/);
    expect(msgParams[16]).toBe('final');
    expect(msgParams[13]).toBe('2026-07-15T00:00:02.000Z');
    // Bedrock latency split folded onto the message: model_ms ($15), tool_ms ($16).
    expect(msgSql).toMatch(/model_ms\s*=\s*COALESCE\(\$15, model_ms\)/);
    expect(msgSql).toMatch(/tool_ms\s*=\s*COALESCE\(\$16, tool_ms\)/);
    expect(msgParams[14]).toBe(700);
    expect(msgParams[15]).toBe(200);

    // e2e_ms = agent_final_at - user_message_at (both Chime, skew-free); inbound_ms = processor entry
    // ($16) - user_message_at (cross-clock), clamped >= 0. Both guarded and idempotent: a first round
    // keeps its first stored value, and only a later duel round is recomputed (migration 071).
    const exchangeCall = mockedQuery.mock.calls.find(([sql]) => /UPDATE exchanges/.test(sql as string));
    const [exSql, exParams] = exchangeCall as [string, any[]];
    expect(exSql).toMatch(/e2e_ms\s*=\s*COALESCE\(CASE WHEN COALESCE\(ex\.battle_round, am\.battle_round, 1\) > 1 THEN NULL\s+ELSE ex\.e2e_ms END,/);
    expect(exSql).toContain('am.agent_final_at - ex.user_message_at');
    expect(exSql).toMatch(/inbound_ms\s*=\s*CASE WHEN COALESCE\(ex\.battle_round, am\.battle_round, 1\) > 1 THEN NULL\s+ELSE COALESCE\(ex\.inbound_ms,/);
    expect(exSql).toContain('GREATEST(0,');
    // $16 is explicitly cast: used only in `IS NOT NULL` + arithmetic, an uncast param makes Postgres
    // fail at execution with "could not determine data type of parameter $16" (caught in live validation,
    // not by this mock-level assertion). The cast is the fix.
    expect(exSql).toContain('$16::bigint');
    expect(exParams[15]).toBe(1752537600000); // $16 processor_entry_ms
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // FINALITY IS DECLARED, NOT INFERRED.
  //
  // The old gate read "this update carries worker telemetry, so it must be the completion", and
  // `COALESCE` then froze whichever update satisfied that first. The two coincided only for as long as
  // no interim update happened to carry telemetry - and the battle clarification update does, so it
  // froze `e2e_ms` at a moment the duel had not finished. Nothing errored; the number simply read too
  // fast. These three cases are the ones that distinguish the rules.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('does NOT close the turn on an INTERIM update that carries telemetry', async () => {
    // The exact input the old gate got wrong. `total_ms` is present and the phase says this is a step
    // on the way, so nothing may be frozen here.
    await backfillFromUpdateEvents([updateRecord({ resp_phase: 'interim', total_ms: 1200 })]);
    const [, msgParams] = mockedQuery.mock.calls.find(([sql]) =>
      /UPDATE messages/.test(sql as string)) as [string, any[]];
    expect(msgParams[16]).toBe('interim');
    // The SQL is what decides: with a declared phase that is not 'final', neither branch of the CASE
    // can fire, so the timestamp param is inert on this row.
    const [msgSql] = mockedQuery.mock.calls.find(([sql]) =>
      /UPDATE messages/.test(sql as string)) as [string, any[]];
    expect(msgSql).toMatch(/\$17::text IS NULL AND \$7 IS NOT NULL/);
  });

  it('falls back to the legacy inference ONLY when no phase was declared', async () => {
    // Messages archived before the declaration shipped carry no phase, and their `e2e_ms` must keep
    // working exactly as it did - the fallback exists for them and for nothing else.
    await backfillFromUpdateEvents([updateRecord({ resp_phase: null, total_ms: 1200 })]);
    const [msgSql, msgParams] = mockedQuery.mock.calls.find(([sql]) =>
      /UPDATE messages/.test(sql as string)) as [string, any[]];
    expect(msgParams[16]).toBeNull();
    expect(msgSql).toMatch(/\$17::text IS NULL AND \$7 IS NOT NULL THEN \$14::timestamptz/);
  });

  it('freezes the FIRST final, so a later edit cannot move the completion', async () => {
    // A moderation content-edit re-reads the same out-of-band record and arrives looking like a
    // completion. COALESCE, not the gate, is what protects the timestamp there - and it must survive
    // the gate being rewritten.
    await backfillFromUpdateEvents([updateRecord({ resp_phase: 'final' })]);
    const [msgSql] = mockedQuery.mock.calls.find(([sql]) =>
      /UPDATE messages/.test(sql as string)) as [string, any[]];
    expect(msgSql).toMatch(/agent_final_at\s*=\s*COALESCE\(agent_final_at,/);
  });

  it('folds task machine state (task_state + JSONB task_transition) onto the exchange', async () => {
    await backfillFromUpdateEvents([
      updateRecord({ task_state: 'generating', task_transition: { from: 'drafting_outline', to: 'generating' } }),
    ]);

    const exchangeCall = mockedQuery.mock.calls.find(([sql]) =>
      /UPDATE exchanges/.test(sql as string),
    );
    const [sql, params] = exchangeCall as [string, any[]];
    expect(sql).toMatch(/task_state\s*=\s*COALESCE\(\$14, ex\.task_state\)/);
    expect(sql).toMatch(/task_transition\s*=\s*COALESCE\(\$15, ex\.task_transition\)/);
    expect(params[13]).toBe('generating');
    // $15 is the JSONB param — the {from,to} object stringified.
    expect(params[14]).toBe(JSON.stringify({ from: 'drafting_outline', to: 'generating' }));
  });

  it('leaves task_transition NULL when the turn advanced nothing', async () => {
    await backfillFromUpdateEvents([updateRecord({ task_state: 'generating', task_transition: null })]);
    const exchangeCall = mockedQuery.mock.calls.find(([sql]) => /UPDATE exchanges/.test(sql as string));
    const [, params] = exchangeCall as [string, any[]];
    expect(params[13]).toBe('generating');
    expect(params[14]).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // A LATE DECLARATION IS RECORDED, NOT RE-DERIVED.
  //
  // Kinesis archival batches on a five second window, so a turn whose time to first feedback exceeds
  // five seconds cannot have its user message and its placeholder in one batch. The cross-batch sweep
  // mints the exchange from the placeholder alone, every carrier of the declaration is still NULL at
  // that moment, and its CASE writes `swept`. The Latency tab excludes a swept pairing from TTFF by
  // name - correctly, because a genuine sweep searched up to the reply bound for a plausible answer -
  // so the rows wrongly carrying that label were exactly the slow ones the SLO exists to catch.
  //
  // This fold is where the turn's own statement finally arrives. The promotion is a correction to a
  // provenance claim the sweep made before the evidence existed; it is not a second pairing rule.
  //
  // WHAT IS PROVABLE HERE. The unit suite has no Postgres, so what these pin is the statement: which
  // value each parameter carries, and that the SET clause contains no path that writes `paired_by`
  // any value other than 'declared'-from-'swept' or the row's own current one. The conditions
  // themselves are single SQL predicates over one indexed row, asserted character for character.
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /** The one SET clause under test, isolated so a match cannot be satisfied by prose elsewhere. */
  const pairedByClause = (sql: string) =>
    sql.slice(sql.indexOf('paired_by = CASE'), sql.indexOf('END,', sql.indexOf('paired_by = CASE')) + 4)
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const exchangeUpdate = () =>
    mockedQuery.mock.calls.find(([sql]) => /UPDATE exchanges/.test(sql as string)) as [string, any[]];

  it('promotes a swept pairing to declared when the update names that exchange own user message', async () => {
    await backfillFromUpdateEvents([updateRecord({ answers_message_id: 'm-the-question' })]);

    const [sql, params] = exchangeUpdate();
    // $18 is the declaration, folded onto the record by transformToMessageRecord from whichever
    // carrier the turn had.
    expect(params[17]).toBe('m-the-question');
    expect(pairedByClause(sql)).toBe(
      "paired_by = CASE WHEN ex.paired_by = 'swept' AND $18::text IS NOT NULL AND $18::text = ( "
      + 'SELECT um.message_id FROM messages um WHERE um.id = ex.user_message_id ) '
      + "THEN 'declared' ELSE ex.paired_by END,",
    );
  });

  it('promotes ONLY on the exact id, so a mismatch is not a pairing', async () => {
    // A declaration naming a DIFFERENT message is not this pairing being confirmed - it is evidence
    // the pairing is wrong. The comparison is an equality against the exchange own user message read
    // through the primary key, so there is no bound, no window and nothing to widen.
    const [sql] = (await backfillFromUpdateEvents([updateRecord({ answers_message_id: 'm-somebody-else' })]),
      exchangeUpdate());
    expect(pairedByClause(sql)).toContain('$18::text = ( SELECT um.message_id FROM messages um');
    expect(pairedByClause(sql)).not.toMatch(/LIKE|INTERVAL|created_at/);
  });

  it('never downgrades, and never touches a declared or in_batch row', async () => {
    // ELSE keeps the row own value, and it is the ONLY other branch. A row already `declared` or
    // `in_batch` reaches the ELSE and is rewritten to what it already held.
    const [sql] = (await backfillFromUpdateEvents([updateRecord({ answers_message_id: 'm-the-question' })]),
      exchangeUpdate());
    const clause = pairedByClause(sql);
    expect(clause).toContain("WHEN ex.paired_by = 'swept'");
    expect(clause).toContain('ELSE ex.paired_by');
    // Proving it can fail: the unguarded form this would have been.
    expect(clause).not.toContain("paired_by = 'declared',");
    // 'declared' is written from exactly one place in the clause, behind the swept guard.
    expect(clause.match(/'declared'/g)).toHaveLength(1);
    expect(clause).not.toContain("'swept' END");
    expect(clause).not.toContain("'in_batch'");
  });

  it('leaves a genuine sweep alone: no declaration means the promotion cannot fire', async () => {
    // THE ONE THAT MATTERS MOST. A reconstructed pairing must stay out of a measured population, and
    // this must not become the door it walks back in through. With no declaration $18 is NULL, the
    // guard is not TRUE, the ELSE holds, and the row keeps the label the Latency tab excludes.
    await backfillFromUpdateEvents([updateRecord({ answers_message_id: null })]);

    const [sql, params] = exchangeUpdate();
    expect(params[17]).toBeNull();
    expect(pairedByClause(sql)).toContain('$18::text IS NOT NULL');
  });

  it('adds no parameter ahead of the ones already numbered in the statement comments', async () => {
    // The position in the params array IS the parameter number, and this statement refers to its
    // params by number in its own comments. Appending is what keeps a fold from quietly starting to
    // write the column after the one it means.
    await backfillFromUpdateEvents([updateRecord({ answers_message_id: 'm-the-question' })]);
    const [, params] = exchangeUpdate();
    // 18 numbered before migration 092, then $19-$21 appended (ADR-064); $3 now carries the task type.
    expect(params).toHaveLength(21);
    expect(params[16]).toBe('premium'); // $17 conversation_classification, unmoved
  });

  it('skips a record whose id does not carry the -UPD suffix', async () => {
    await backfillFromUpdateEvents([
      updateRecord({ message_id: 'msg-999' }),
    ]);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('swallows a failing patch so archival of the batch is not aborted', async () => {
    mockedQuery.mockRejectedValueOnce(new Error('deadlock'));
    await expect(
      backfillFromUpdateEvents([updateRecord()])
    ).resolves.toBeUndefined();
  });
});

describe('the cross-batch exchange sweep mints one row per (turn, responding bot)', () => {
  // The next-user bound alone paired EVERY bot CREATE before the next user turn - welcomes, drift
  // notices and continuation chunks each minted an exchange whose latency was the gap to a user
  // message they never answered. Raw exchange counts inflated and TTFF averages polluted, silently:
  // the unclosed_no_placeholder bucket absorbed them in the latency view, so nothing errored.
  // Source-level on the SQL because the function is not exported and the property is the query's.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts'), 'utf8');

  it('takes the EARLIEST bot CREATE per sender and round, so a duel pairs both sides every round', () => {
    // THE ROUND JOINED THE KEY 2026-09-23. It was (turn, sender), which pairs both sides of a normal
    // duel and caps a multi-round one at two: a side's rebuttal answers the same user message as its
    // round-1 reply and comes from the same bot, so it collided and was dropped. Of 14 two-round
    // duels measured, only 3 recorded all four turns.
    //
    // The property this case was written for is UNCHANGED and still asserted below: earliest per
    // group, so a welcome or a continuation chunk cannot claim a turn. The group simply got a third
    // term. COALESCE to 0 keeps every non-battle turn in one group, because NULLs are distinct from
    // each other in a DISTINCT ON and a null round would make each ordinary turn its own group.
    expect(src).toContain('SELECT DISTINCT ON (um.id, am.sender_arn, COALESCE(am_upd.battle_round, am.battle_round, 0))');
    expect(src).toContain('ORDER BY um.id, am.sender_arn, COALESCE(am_upd.battle_round, am.battle_round, 0), am.created_at');
    // Still EARLIEST within the group - the half that stops a later message claiming the turn.
    expect(src).toMatch(/ORDER BY um\.id, am\.sender_arn, COALESCE\([^)]*\), am\.created_at/);
  });

  it('keeps the next-user bound that attaches a reply to the prompt that caused it', () => {
    expect(src).toMatch(/NOT EXISTS \(\s*\n\s*SELECT 1 FROM messages nxt/);
  });
});

describe('the sweep pairs only real replies, once per (turn, sender), within a bounded window', () => {
  // The pair-level anti-join ran before DISTINCT ON, so a sender's LATER unprompted message became
  // the "earliest surviving" candidate for an already-answered turn and minted a second exchange -
  // and with no delay limit, a briefing hours later paired at ~8-hour "latency". Three bounds,
  // pinned together because each alone leaves a mint path open.
  const sweepSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts'), 'utf8');

  it('the anti-join is durable per (turn, sender), not per exact pair', () => {
    expect(sweepSrc).toMatch(/e\.user_message_id = um\.id\s*\n\s*AND EXISTS \(/);
    expect(sweepSrc).toMatch(/am_prev\.sender_arn = am\.sender_arn/);
  });

  it('only corr-marked (response-anchored) bot messages may pair', () => {
    expect(sweepSrc).toContain("AND am.content LIKE '%<!--corr:%'");
  });

  it('a reply pairs only within the bound, and both pairers read the same bound', () => {
    // One definition, interpolated into the query. It was a literal here and absent from the
    // TypeScript, so the in-batch pairer could not have applied it even once it started trying -
    // and a later edit would have changed the rule for half the rows with nothing failing.
    expect(sweepSrc).toContain('const REPLY_BOUND_MINUTES = 60;');
    expect(sweepSrc).toContain("AND am.created_at <= um.created_at + INTERVAL '${REPLY_BOUND_MINUTES} minutes'");
    expect(sweepSrc).toContain('if (gapMs > REPLY_BOUND_MS) continue;');
  });
});
