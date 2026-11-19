/**
 * THE ARCHIVE'S CLASSIFICATION PARTITION IS WHAT THE PLATFORM DECLARED, AND EVERY RECORD STAYS IN THE TABLE.
 *
 * The conversation archive's Firehose sets `user_type` from a record's Metadata, and a person's message Metadata is
 * member-writable. So the partition reads an assistant's record only (the platform writes assistant Metadata), the
 * parse is guarded so no Metadata routes a record to the error prefix outside the `conversations` table, and the
 * Athena reader decides a conversation's classification from assistant rows only.
 *
 * WHAT THIS PINS:
 *   1. the extraction query parses Metadata inside `try ... catch`, falls back to `unknown`, and reads Metadata
 *      only behind the assistant-sender gate;
 *   2. the reader's single-channel classification reads trusted rows only and resolves exactly one value;
 *   3. the reader's scoped list admits a channel by its trusted classification, not by any row's partition.
 *
 * The expression's behavior on records was checked with jq against: an assistant's flat and nested
 * classification, a person's forged classification, non-JSON Metadata from either sender, an array, a numeric
 * classification, an empty or path-shaped classification, and channel events with no sender. Each person, malformed
 * or channel record yields `unknown`; each well-formed assistant record yields its classification.
 */
import { ARCHIVE_PARTITION_QUERY } from '../lib/constructs/archive-partitions';

const mockQueries: string[] = [];
let mockResultRows: string[][] = [];
jest.mock('@aws-sdk/client-athena', () => {
  class StartQueryExecutionCommand { constructor(public input: { QueryString: string }) { mockQueries.push(input.QueryString); } }
  class GetQueryExecutionCommand { constructor(public input: unknown) {} }
  class GetQueryResultsCommand { constructor(public input: unknown) {} }
  return {
    AthenaClient: jest.fn(() => ({
      send: jest.fn(async (cmd: unknown) => {
        if (cmd instanceof StartQueryExecutionCommand) return { QueryExecutionId: 'q-1' };
        if (cmd instanceof GetQueryExecutionCommand) return { QueryExecution: { Status: { State: 'SUCCEEDED' } } };
        return { ResultSet: { Rows: mockResultRows.map((r) => ({ Data: r.map((v) => ({ VarCharValue: v })) })) } };
      }),
    })),
    StartQueryExecutionCommand,
    GetQueryExecutionCommand,
    GetQueryResultsCommand,
    QueryExecutionState: { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' },
  };
}, { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  // No data-plane parameter: Athena mode.
  SSMClient: jest.fn(() => ({ send: jest.fn().mockRejectedValue(Object.assign(new Error('absent'), { name: 'ParameterNotFound' })) })),
  GetParameterCommand: jest.fn(),
}), { virtual: true });
jest.mock('../lambda/src/lib/data-plane-client.js', () => ({
  hasDataPlane: () => false,
  adminListConversations: jest.fn(),
  adminListMessages: jest.fn(),
  adminMembershipHistory: jest.fn(),
  adminCleanConversation: jest.fn(),
}));

import { archiveReader, TRUSTED_CLASSIFICATION_ROW } from '../lambda/src/lib/archive-reader';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/app/channel/c-1';

beforeEach(() => {
  mockQueries.length = 0;
  mockResultRows = [];
});

describe('the Firehose partition expression', () => {
  const q = ARCHIVE_PARTITION_QUERY;

  it('parses Metadata inside try ... catch, so no Metadata a sender writes routes a record out of the table', () => {
    const tryAt = q.indexOf('try (');
    const catchAt = q.indexOf('catch empty');
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(catchAt).toBeGreaterThan(tryAt);
    const parseAt = q.indexOf('fromjson');
    expect(parseAt).toBeGreaterThan(tryAt);
    expect(parseAt).toBeLessThan(catchAt);
    // Nothing is read from Metadata outside the guarded block.
    expect(q.split('.Payload.Metadata').length - 1).toBe(1);
    expect(q.indexOf('.Payload.Metadata')).toBeGreaterThan(tryAt);
    expect(q.trim().endsWith('// "unknown")}')).toBe(true);
  });

  it('reads Metadata only behind the assistant-sender gate, so a person cannot choose the partition', () => {
    const gate = 'select(.Payload.Sender.Arn | strings | contains("/bot/"))';
    expect(q).toContain(gate);
    expect(q.indexOf(gate)).toBeLessThan(q.indexOf('.Payload.Metadata'));
  });

  it('keeps only a classification-key-shaped string, so every partition written is one the registrar parses', () => {
    expect(q).toContain('| strings');
    expect(q).toMatch(/select\(length > 0 and length < 64 and \(explode \| all\(/);
  });
});

describe('the Athena reader decides a conversation\'s classification from trusted rows only', () => {
  it('reads the single-channel classification from assistant rows in a declared partition', async () => {
    mockResultRows = [['classification'], ['premium']];
    const reader = await archiveReader();
    expect(reader.kind).toBe('athena');
    await expect(reader.channelClassification(CHANNEL)).resolves.toBe('premium');
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0]).toContain(TRUSTED_CLASSIFICATION_ROW);
    expect(TRUSTED_CLASSIFICATION_ROW).toContain("user_type <> 'unknown'");
    expect(TRUSTED_CLASSIFICATION_ROW).toContain("'$.Payload.Sender.Arn'), '/bot/'");
  });

  it('resolves nothing when the trusted rows name more than one classification, and nothing when they name none', async () => {
    const reader = await archiveReader();
    mockResultRows = [['classification'], ['premium'], ['basic']];
    await expect(reader.channelClassification(CHANNEL)).resolves.toBeUndefined();
    mockResultRows = [['classification']];
    await expect(reader.channelClassification(CHANNEL)).resolves.toBeUndefined();
  });

  it('admits a channel to a scoped list by its trusted classification, not by any row\'s partition', async () => {
    mockResultRows = [['channel_arn', 'classification', 'name', 'message_count', 'last_message_at', 'total_count']];
    const reader = await archiveReader();
    await reader.listConversations({ limit: 10, offset: 0, allowed: ['basic'], only: null, memberArns: null });
    const sql = mockQueries[0];
    const where = sql.slice(sql.indexOf('WHERE'), sql.indexOf('GROUP BY'));
    expect(where).not.toMatch(/user_type\s+IN/);
    expect(sql).toContain(`HAVING arbitrary(user_type) FILTER (WHERE ${TRUSTED_CLASSIFICATION_ROW}) IN ('basic')`);
    expect(sql).toContain(`COALESCE(arbitrary(user_type) FILTER (WHERE ${TRUSTED_CLASSIFICATION_ROW}), 'unknown') AS classification`);
  });

  it('admits no channel to a list scoped to no classification', async () => {
    mockResultRows = [['channel_arn']];
    const reader = await archiveReader();
    await reader.listConversations({ limit: 10, offset: 0, allowed: [], only: null, memberArns: null });
    expect(mockQueries[0]).toContain('HAVING false');
  });
});
