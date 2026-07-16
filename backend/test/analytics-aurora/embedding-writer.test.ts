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
    });

    expect(result).toEqual({ written: true });
    expect(mockedQuery).toHaveBeenCalledTimes(1);

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
    ]);
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
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0] as { __args: { body: string } };
    const body = JSON.parse(command.__args.body);
    expect(body.inputText.length).toBe(8000);
    expect(body.dimensions).toBe(1024);
    expect(body.normalize).toBe(true);
  });
});
