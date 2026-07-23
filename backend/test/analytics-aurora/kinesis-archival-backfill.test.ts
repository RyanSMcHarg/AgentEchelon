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
    user_type: 'premium',
    agent_type: 'premium',
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
    original_intent: null,
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
    expect(sql).toMatch(/updated_content\s*=\s*COALESCE\(\$1, updated_content\)/);
    expect(sql).toMatch(/bedrock_model\s*=\s*COALESCE\(\$2, bedrock_model\)/);
    expect(sql).toContain("event_type = 'CREATE_CHANNEL_MESSAGE'");
    // $1 final content, $2 model, $12 de-suffixed CREATE id, $13 channel.
    expect(params[0]).toBe('The Q2 ARR is $4.2M.');
    expect(params[1]).toBe('anthropic.claude-opus');
    expect(params[11]).toBe('msg-123'); // '-UPD' stripped
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
    expect(params[11]).toBe('msg-123');
    expect(params[12]).toBe('arn:aws:chime:...:channel/abc');
  });

  it('derives agent_final_at from the update timestamp (gated on total_ms) and e2e_ms on the exchange', async () => {
    await backfillFromUpdateEvents([updateRecord()]);

    // agent_final_at is the Chime update time ($14), set only when this update carries completion
    // telemetry ($7 total_ms) and frozen by COALESCE so a later moderation/battle update cannot move it.
    const messageCall = mockedQuery.mock.calls.find(([sql]) => /UPDATE messages/.test(sql as string));
    const [msgSql, msgParams] = messageCall as [string, any[]];
    expect(msgSql).toMatch(
      /agent_final_at\s*=\s*COALESCE\(agent_final_at, CASE WHEN \$7 IS NOT NULL THEN \$14::timestamptz END\)/,
    );
    expect(msgParams[13]).toBe('2026-07-15T00:00:02.000Z');
    // Bedrock latency split folded onto the message: model_ms ($15), tool_ms ($16).
    expect(msgSql).toMatch(/model_ms\s*=\s*COALESCE\(\$15, model_ms\)/);
    expect(msgSql).toMatch(/tool_ms\s*=\s*COALESCE\(\$16, tool_ms\)/);
    expect(msgParams[14]).toBe(700);
    expect(msgParams[15]).toBe(200);

    // e2e_ms = agent_final_at - user_message_at (both Chime, skew-free); inbound_ms = processor entry
    // ($16) - user_message_at (cross-clock), clamped >= 0. Both guarded and idempotent.
    const exchangeCall = mockedQuery.mock.calls.find(([sql]) => /UPDATE exchanges/.test(sql as string));
    const [exSql, exParams] = exchangeCall as [string, any[]];
    expect(exSql).toMatch(/e2e_ms\s*=\s*COALESCE\(ex\.e2e_ms,/);
    expect(exSql).toContain('am.agent_final_at - ex.user_message_at');
    expect(exSql).toMatch(/inbound_ms\s*=\s*COALESCE\(ex\.inbound_ms,/);
    expect(exSql).toContain('GREATEST(0,');
    // $16 is explicitly cast: used only in `IS NOT NULL` + arithmetic, an uncast param makes Postgres
    // fail at execution with "could not determine data type of parameter $16" (caught in live validation,
    // not by this mock-level assertion). The cast is the fix.
    expect(exSql).toContain('$16::bigint');
    expect(exParams[15]).toBe(1752537600000); // $16 processor_entry_ms
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
