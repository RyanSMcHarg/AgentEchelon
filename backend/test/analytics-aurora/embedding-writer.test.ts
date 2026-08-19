/**
 * embedding-writer — pins the contract that the summary-updater Lambda
 * depends on for fresh drift signals:
 *
 *   1. Empty/whitespace summaries are refused (`empty_summary`) — never
 *      embed a no-op text.
 *   2. Bedrock failure returns `embedding_failed`, never throws into the
 *      caller. The summary-updater treats this as best-effort.
 *   3. Concurrent writers are race-safe via `embedded_from_version <
 *      EXCLUDED.embedded_from_version` — a stale write reports
 *      `stale_version` and does NOT clobber a fresher embedding.
 *   4. The persisted vector is the exact Titan embedding (1024 floats,
 *      pgvector string literal format).
 */

import type { QueryResult, QueryResultRow } from 'pg';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

// ADR-028: the subject now runs its bounded-table statements as a database role, via
// `withReaderRole`/`withWriterRole` (which wrap `transaction()`). Route those back to the mocked
// `query` so the SQL assertions below are unchanged, and record which role was assumed so the tests
// can assert the boundary was entered at all — a query that reaches the right table as the WRONG role
// is precisely the failure this design exists to prevent, and it is invisible in the SQL text.
const mockAssumedRoles: string[] = [];
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withReaderRole: jest.fn(async (classification: string, fn: (c: unknown) => unknown) => {
    mockAssumedRoles.push(`ae_reader_${classification}`);
    return fn({ query: require('../../lambda/src/analytics-aurora/db-client').query });
  }),
  withWriterRole: jest.fn(async (fn: (c: unknown) => unknown) => {
    mockAssumedRoles.push('ae_writer');
    return fn({ query: require('../../lambda/src/analytics-aurora/db-client').query });
  }),
}));

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args: unknown) => ({ __args: args })),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

function mockBedrockEmbedding(values: number[]): void {
  mockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ embedding: values })),
  });
}

const CHANNEL_ARN = 'arn:aws:chime:us-east-1:111111111111:app-instance/test/channel/c1';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DB_HOST = 'localhost';
  process.env.DB_NAME = 'analytics';
  process.env.DB_USER = 'testuser';
  process.env.DB_REGION = 'us-east-1';
});

describe('writeSummaryEmbedding', () => {
  it('refuses empty summary without calling Bedrock or DB', async () => {
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: '',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'empty_summary' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('refuses whitespace-only summary', async () => {
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: '   \n\t   ',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'empty_summary' });
  });

  it('returns embedding_failed when Bedrock errors out — never throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('Bedrock 5xx (simulated)'));
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'A meaningful summary of the conversation.',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'embedding_failed' });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('returns embedding_failed when Titan returns a wrong-shape embedding', async () => {
    // 512-dim instead of the required 1024.
    mockBedrockEmbedding(new Array(512).fill(0.5));
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'A meaningful summary.',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'embedding_failed' });
  });

  it('writes the embedding via UPSERT and returns written:true on a fresh row', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.25));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 5 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'Discussing the API redesign.',
      fromVersion: 5,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });

    // The result now also reports WHICH classification was stamped and where it came from — a row
    // written without that is a row no reader role can see, so it is part of the contract, not
    // decoration.
    expect(result).toEqual({ written: true, classification: 'standard', classificationSource: 'caller' });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    // ...and it went through the write role. Under FORCE RLS the same statement issued unroled
    // reports success and writes nothing, which no assertion on the SQL text can distinguish.
    expect(mockAssumedRoles).toEqual(['ae_writer']);

    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO summary_embeddings/);
    expect(sql).toMatch(/ON CONFLICT \(channel_arn\) DO UPDATE/);
    // The version-guard predicate is the load-bearing race-safety bit.
    expect(sql).toMatch(/WHERE summary_embeddings\.embedded_from_version < EXCLUDED\.embedded_from_version/);
    expect(params).toEqual([
      CHANNEL_ARN,
      `[${new Array(1024).fill(0.25).join(',')}]`,
      5,
      'amazon.titan-embed-text-v2:0',
      // The isolation column (ADR-028). Written on every row, including on the ON CONFLICT UPDATE
      // path — a re-embed that kept the old classification would silently pin a summary to whatever
      // the first write happened to guess.
      'standard',
    ]);
    expect(sql).toMatch(/classification = EXCLUDED\.classification/);
  });

  it('returns stale_version when the WHERE clause excluded the UPDATE (a fresher writer raced ahead)', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    // 0 rows returned ⇒ the ON CONFLICT WHERE clause didn't match.
    mockedQuery.mockResolvedValueOnce(mockRows<{ embedded_from_version: number }>([]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'A meaningful summary.',
      fromVersion: 3,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });

    expect(result).toEqual({ written: false, reason: 'stale_version' });
  });

  it('truncates summary text to 8000 chars before sending to Bedrock', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const huge = 'x'.repeat(20000);
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: huge,
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0] as { __args: { body: string } };
    const body = JSON.parse(command.__args.body);
    expect(body.inputText.length).toBe(8000);
    expect(body.dimensions).toBe(1024);
    expect(body.normalize).toBe(true);
  });
});

/**
 * ADR-028: which classification gets stamped, and what happens when nobody knows.
 *
 * This is the whole isolation value for a conversation summary. Stamp it too low and the summary is
 * readable by classifications that should never see it; leave it NULL and it is readable by nobody,
 * which is safe but silently removes drift's anchor. So the ladder - caller, then projection, then
 * most-restrictive - is pinned here rather than left to whatever the call site happens to pass.
 */
describe('writeSummaryEmbedding — classification resolution', () => {
  const upsertCall = () => mockedQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO summary_embeddings'))!;

  it('believes the caller when it supplied one, and never queries the projection', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1, classification: 'basic',
    });

    expect(result.classificationSource).toBe('caller');
    // The seed path resolved this from the live channel tag on the turn being served. Consulting the
    // projection anyway would prefer a stale copy to an authoritative read.
    expect(mockedQuery.mock.calls.some(([sql]) => String(sql).includes('channel_classification'))).toBe(false);
    expect(upsertCall()[1]).toContain('basic');
  });

  it('falls back to the projection when the caller could not know', async () => {
    // The scheduled scan runs inside the VPC, which has no route to the Chime SDK at all.
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ classification: 'standard' }]));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({ channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1 });

    expect(result.classificationSource).toBe('projection');
    expect(upsertCall()[1]).toContain('standard');
  });

  it('stamps the MOST RESTRICTIVE classification when nobody knows', async () => {
    // Fail-closed for CONTENT is the top of the ladder: readable only by the classification that
    // could already see everything. (For a READER role, fail-closed is the opposite end — the floor.
    // Getting those two the same way round is the bug this direction guards.)
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows<{ classification: string }>([]));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({ channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1 });

    expect(result.classificationSource).toBe('fail-closed');
    expect(result.classification).toBe('premium');
    expect(upsertCall()[1]).toContain('premium');
  });

  it('treats a classification this deployment does not declare as unknown, not as a label', async () => {
    // A renamed ladder leaves rows behind. An unrecognized value is not a classification just because
    // it is written down — believing it would stamp a row nothing can ever read, and (worse) would
    // make an attacker-chosen or typo'd label look like a successful write.
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ classification: 'top-secret-typo' }]));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({ channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1 });

    expect(result.classificationSource).toBe('fail-closed');
    expect(result.classification).toBe('premium');
  });
});
