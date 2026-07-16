/**
 * summary-updater — scheduled Lambda that generates fresh
 * conversation_summaries via Bedrock Haiku and triggers the embedding
 * writer inline.
 *
 * Tests pin:
 *
 *   1. Empty active-channel set → no-op return shape.
 *   2. Channel with messages but Bedrock fails → failed counter increments,
 *      doesn't throw, doesn't write summary/embedding.
 *   3. Channel with messages + valid Bedrock JSON → INSERT into
 *      conversation_summaries and call writeSummaryEmbedding inline.
 *   4. Version-race: if the INSERT returns 0 rows (another writer won),
 *      the embedding write is skipped.
 *   5. parseSummaryJson tolerates fenced/prefixed JSON output from the LLM.
 *
 * Embedding-writer is mocked at module boundary so this test pins the
 * orchestration only; the embedding-writer module has its own tests.
 */

import type { QueryResult, QueryResultRow } from 'pg';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args: unknown) => ({ __args: args })),
}));

const mockWriteEmbedding = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/embedding-writer', () => ({
  writeSummaryEmbedding: mockWriteEmbedding,
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

function mockHaikuResponse(jsonText: string): void {
  mockBedrockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ content: [{ text: jsonText }] })),
  });
}

const CHANNEL_ARN = 'arn:aws:chime:us-east-1:1:app-instance/test/channel/c1';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DB_HOST = 'localhost';
  process.env.DB_NAME = 'analytics';
  process.env.DB_USER = 'testuser';
  process.env.DB_REGION = 'us-east-1';
  mockWriteEmbedding.mockResolvedValue({ written: true });
});

describe('summary-updater handler', () => {
  it('no active channels → returns { processed: 0, failed: 0 }', async () => {
    // Scan returns empty channel set.
    mockedQuery.mockResolvedValueOnce(mockRows([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('skips channels with no messages — bedrock + write are not called', async () => {
    mockedQuery
      // findActiveChannels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // pull recent messages → empty
      .mockResolvedValueOnce(mockRows([]));

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('Bedrock failure: processed++ (best-effort), no summary write, no embedding', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi there', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      // pull existing summary
      .mockResolvedValueOnce(mockRows([]));

    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock 5xx (simulated)'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    warnSpy.mockRestore();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('happy path: writes a new summary row + invokes writeSummaryEmbedding inline', async () => {
    mockedQuery
      // findActiveChannels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: 2,
            last_summary_at: '2026-05-21T00:00:00Z',
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // pull recent messages
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'we need to ship the migration tonight', created_at: '2026-05-22T00:00:00Z' },
          { sender_name: null, is_bot: true, content: 'ok — what step is failing?', created_at: '2026-05-22T00:00:01Z' },
        ]),
      )
      // pull existing summary
      .mockResolvedValueOnce(
        mockRows([
          { version: 2, summary: 'Earlier discussion of the staging migration.', purpose: 'ops', topics: ['migration'] },
        ]),
      )
      // getMessageCount (called BEFORE the INSERT in the source)
      .mockResolvedValueOnce(mockRows([{ count: '12' }]))
      // INSERT new version
      .mockResolvedValueOnce(mockRows([{ version: 3 }]));

    mockHaikuResponse(JSON.stringify({
      summary: 'Coordinating tonight\'s production database migration.',
      purpose: 'migration coordination',
      topics: ['migration', 'staging', 'release'],
      key_points: ['target window 10pm UTC', 'rollback plan ready'],
    }));

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).toHaveBeenCalledTimes(1);
    expect(mockWriteEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL_ARN,
      summaryText: expect.stringContaining('database migration'),
      fromVersion: 3,
    }));

    // Find the INSERT call and verify the version increment + writer attribution.
    const insertCall = mockedQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO conversation_summaries'),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall!;
    expect(params).toEqual([
      CHANNEL_ARN,
      'migration coordination',
      'Coordinating tonight\'s production database migration.',
      ['migration', 'staging', 'release'],
      ['target window 10pm UTC', 'rollback plan ready'],
      expect.any(Number), // totalMessageCount (lookup happened before this call)
      3, // previousVersion(2) + 1
      'anthropic.claude-3-haiku-20240307-v1:0',
    ]);
  });

  it('version race: INSERT returns 0 rows → skip embedding write (another writer won)', async () => {
    mockedQuery
      // findActiveChannels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: 1,
            last_summary_at: '2026-05-21T00:00:00Z',
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // pull messages
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      // pull existing summary
      .mockResolvedValueOnce(mockRows([]))
      // getMessageCount (called BEFORE the INSERT in the source)
      .mockResolvedValueOnce(mockRows([{ count: '5' }]))
      // INSERT → 0 rows (race lost)
      .mockResolvedValueOnce(mockRows<{ version: number }>([]));

    mockHaikuResponse(JSON.stringify({
      summary: 'A summary.',
      purpose: 'p',
      topics: ['t'],
      key_points: [],
    }));

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('tolerates fenced/prefixed JSON in Haiku output (strips outer prose)', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hello', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ count: '1' }]))   // getMessageCount first
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));  // then INSERT

    // Realistic Haiku output: fenced block + leading prose.
    mockHaikuResponse(
      'Sure, here is the JSON:\n\n```json\n' +
      JSON.stringify({
        summary: 'A short hello.',
        purpose: 'greet',
        topics: ['greeting'],
        key_points: [],
      }) +
      '\n```',
    );

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      summaryText: 'A short hello.',
    }));
  });

  it('rejects malformed Bedrock JSON (no {} block) — channel processed, no writes', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      .mockResolvedValueOnce(mockRows([]));

    mockHaikuResponse('Sorry, I cannot summarize this conversation.');

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('per-channel failure does not poison the batch', async () => {
    mockedQuery
      // findActiveChannels — two channels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: 'arn:.../c-fail',
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
          {
            channel_arn: 'arn:.../c-ok',
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // c-fail: messages lookup throws
      .mockRejectedValueOnce(new Error('connection blip'))
      // c-ok: full happy path
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ count: '1' }]))   // getMessageCount first
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));  // then INSERT

    mockHaikuResponse(JSON.stringify({
      summary: 'ok',
      purpose: 'p',
      topics: ['t'],
      key_points: [],
    }));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    warnSpy.mockRestore();

    expect(result).toEqual({ processed: 1, failed: 1 });
    expect(mockWriteEmbedding).toHaveBeenCalledTimes(1);
  });
});
