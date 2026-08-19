/**
 * Unit tests for the summary updater's `conversation_summaries` write
 * (lambda/src/analytics-aurora/summary-updater.ts).
 *
 * These pin the two columns the writer used to fill with constants:
 *   - `name` was inserted as a literal NULL, so the column existed but nothing ever populated it.
 *   - `participant_count` was inserted as a literal 0, so every conversation read as unattended.
 * and the rule that makes `name` safe to write at all: a conversation is named ONCE. A scheduled
 * re-summarise must never rename a conversation the user already knows by its current name.
 *
 * The assertions are on the actual INSERT parameter array, because that is where the defect lived -
 * a test that only checked the parsed model output would have passed against the broken writer.
 */

const mockQuery = jest.fn();
const mockWriteSummaryEmbedding = jest.fn();
const mockSend = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  // Every DB Lambda entry applies pending migrations before it does anything
  // (db-lambdas-apply-migrations.test.ts). A no-op here; the real one is memoized and idempotent.
  ensureSchema: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/embedding-writer', () => ({
  writeSummaryEmbedding: (...a: unknown[]) => mockWriteSummaryEmbedding(...a),
}));
jest.mock('../../lambda/src/lib/emf-metrics', () => ({
  emitDriftCounter: jest.fn(),
  emitDriftTiming: jest.fn(),
  newCorrelationId: () => 'test-correlation-id',
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockSend(...a) })),
  InvokeModelCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

/** The model's structured summary response. */
function bedrockReply(body: Record<string, unknown>) {
  return {
    body: new TextEncoder().encode(JSON.stringify({
      content: [{ text: JSON.stringify(body) }],
    })),
  };
}

const MODEL_OUTPUT = {
  name: 'Monorepo vs multi-repo decision',
  summary: 'The user is weighing monorepo against multi-repo for five teams.',
  purpose: 'architecture-decision',
  topics: ['repository structure', 'CI cost'],
  key_points: ['Five teams', 'CI cost is the deciding factor'],
};

/** Find the INSERT INTO conversation_summaries call and return its parameter array. */
function summaryInsertCall(): unknown[] {
  const call = mockQuery.mock.calls.find(
    (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO conversation_summaries'),
  );
  if (!call) throw new Error('no conversation_summaries INSERT was issued');
  return call as unknown[];
}
function summaryInsertParams(): unknown[] {
  return summaryInsertCall()[1] as unknown[];
}
function summaryInsertSql(): string {
  return summaryInsertCall()[0] as string;
}

/**
 * Drive one channel through the updater. `existingRow` is the current
 * conversation_summaries row (undefined = never summarised).
 */
async function runUpdater(existingRow?: Record<string, unknown>) {
  jest.resetModules();
  mockQuery.mockReset();
  mockWriteSummaryEmbedding.mockReset().mockResolvedValue({ skipped: false });
  mockSend.mockReset().mockResolvedValue(bedrockReply(MODEL_OUTPUT));

  mockQuery.mockImplementation(routeSql(existingRow));

  const mod = await import('../../lambda/src/analytics-aurora/summary-updater');
  await mod.handler({});
}

/**
 * Route each query by a fragment unique to it. Matched against the REAL SQL in
 * summary-updater.ts - the channel scan is a LEFT JOIN LATERAL, not a SELECT DISTINCT,
 * and matching loosely on "FROM messages" swallows three different queries.
 */
function routeSql(existingRow?: Record<string, unknown>) {
  return async (sql: string) => {
    if (sql.includes('LEFT JOIN LATERAL')) {
      return { rows: [{ channel_arn: 'arn:channel:1', current_version: existingRow?.version ?? null }] };
    }
    if (sql.includes('COUNT(DISTINCT')) return { rows: [{ count: '3' }] };  // 2 humans + the assistant
    if (sql.includes('COUNT(*)::text')) return { rows: [{ count: '12' }] };
    if (sql.includes('SELECT version, name')) return { rows: existingRow ? [existingRow] : [] };
    if (sql.includes('SELECT sender_name')) {
      return { rows: [{ sender_name: 'Demo', is_bot: false, content: 'hello', created_at: '2026-07-28T00:00:00Z' }] };
    }
    if (sql.includes('INSERT INTO conversation_summaries')) return { rows: [{ version: 1 }] };
    return { rows: [] };
  };
}

describe('summary-updater conversation_summaries write', () => {
  it('does NOT write a conversation name into the summary row', async () => {
    // The Amazon Chime SDK channel is authoritative for the name and `channel_registry.channel_name`
    // already mirrors it live from Kinesis. A summary row is versioned and never rewritten, so a
    // name copied here would freeze at one summarisation and could disagree with the name the user
    // actually sees. Worse, letting the summariser generate one creates a SECOND, divergent name.
    // The column is DROPPED (migration 015), so it must not appear in the INSERT at all.
    await runUpdater(undefined);
    expect(summaryInsertSql()).not.toMatch(/[(,]\s*name\s*[,)]/);
    expect(summaryInsertParams()).not.toContain('Monorepo vs multi-repo decision');
  });

  it('does NOT ask the model for a name', async () => {
    await runUpdater(undefined);
    const prompt = JSON.parse(Buffer.from(mockSend.mock.calls[0][0].input.body).toString())
      .messages[0].content as string;
    expect(prompt).not.toMatch(/"name"/);
  });

  it('does NOT query a participant count', async () => {
    // Membership lives in `channel_membership`, maintained live from the Kinesis membership events.
    // Freezing a count into an immutable row is wrong from the next join or leave onward.
    await runUpdater(undefined);
    const counted = mockQuery.mock.calls.some((c) => /channel_membership|COUNT\(DISTINCT/i.test(String(c[0])));
    expect(counted).toBe(false);
  });

  it('does NOT store a message count or participant count either', async () => {
    // Both stored CHANNEL STATE rather than a fact about this summary version, and no consumer read
    // them: every "messages" figure in the console counts live or reads `conversations.message_count`
    // (a different table). The incremental watermark is `updated_at`, not a count. Columns dropped in
    // migration 015, so neither may appear in the INSERT, and no count query may be issued.
    await runUpdater(undefined);
    expect(summaryInsertSql()).not.toMatch(/message_count/);
    expect(summaryInsertSql()).not.toMatch(/participant_count/);
    expect(summaryInsertParams()).not.toContain(12);
    const counted = mockQuery.mock.calls.some((c) => /COUNT\(\*\)::text AS count|channel_membership/i.test(String(c[0])));
    expect(counted).toBe(false);
  });
});

/**
 * The first-turn seed. Drift compares each message against the conversation summary, so a
 * conversation with no summary cannot drift at all - live-verified as `drift_skipped_no_summary`
 * firing on every turn of a fresh deployment. The seed writes that anchor from the opening exchange.
 */
describe('seedSummaryFromExchange', () => {
  const EXCHANGE = {
    channelArn: 'arn:channel:new',
    userMessage: 'How does AgentEchelon work?',
    assistantReply: 'AgentEchelon routes each turn through a per-classification assistant profile.',
  };

  async function loadSeed(existingSummaryRows: unknown[]) {
    jest.resetModules();
    mockQuery.mockReset();
    mockWriteSummaryEmbedding.mockReset().mockResolvedValue({ written: true });
    mockSend.mockReset().mockResolvedValue(bedrockReply(MODEL_OUTPUT));
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT version FROM conversation_summaries')) return { rows: existingSummaryRows };
      if (sql.includes('INSERT INTO conversation_summaries')) return { rows: [{ version: 1 }] };
      return { rows: [] };
    });
    return import('../../lambda/src/analytics-aurora/summary-updater');
  }

  it('seeds v1 from the exchange when the conversation has no summary', async () => {
    const mod = await loadSeed([]);
    const result = await mod.seedSummaryFromExchange(EXCHANGE);
    expect(result.seeded).toBe(true);
    expect(summaryInsertParams()[0]).toBe('arn:channel:new');
    expect(summaryInsertParams()[2]).toBe(MODEL_OUTPUT.summary);
  });

  it('is idempotent - a conversation that already has a summary is left alone', async () => {
    const mod = await loadSeed([{ version: 3 }]);
    const result = await mod.seedSummaryFromExchange(EXCHANGE);
    expect(result).toEqual({ seeded: false, reason: 'already-summarised' });
    // The whole point: safe to call on any turn without the caller tracking first-ness.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('INSERT'))).toBe(false);
  });

  it('never reads a message store - the exchange is supplied by the caller', async () => {
    // Reading Aurora `messages` would reintroduce the Kinesis/archival lag the seed exists to avoid.
    const mod = await loadSeed([]);
    await mod.seedSummaryFromExchange(EXCHANGE);
    const readMessages = mockQuery.mock.calls.some((c) => /FROM\s+messages/i.test(String(c[0])));
    expect(readMessages).toBe(false);
  });

  it('does not write a summary when summarisation fails', async () => {
    const mod = await loadSeed([]);
    mockSend.mockRejectedValueOnce(new Error('bedrock unavailable'));
    const result = await mod.seedSummaryFromExchange(EXCHANGE);
    expect(result.seeded).toBe(false);
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('INSERT'))).toBe(false);
  });

  it('still reports seeded when only the embedding write fails', async () => {
    // The row is what unblocks drift; the embedding writer catches up on the next scheduled run.
    const mod = await loadSeed([]);
    mockWriteSummaryEmbedding.mockRejectedValueOnce(new Error('titan timeout'));
    await expect(mod.seedSummaryFromExchange(EXCHANGE)).resolves.toEqual({ seeded: true });
  });
});
