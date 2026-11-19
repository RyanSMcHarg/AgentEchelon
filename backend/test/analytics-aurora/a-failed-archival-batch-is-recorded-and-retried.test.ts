/**
 * AN ARCHIVAL BATCH THAT FAILS IS RECORDED AS FAILED AND RETRIED, NEVER COMMITTED WITHOUT WHAT IT CARRIED.
 *
 * The archival function projects the message stream into Aurora. A batch it throws on is retried by the event
 * source and, after the last retry, kept in the archival dead-letter queue (the stack half is
 * `a-failed-archival-batch-is-kept-and-alarmed.test.ts`). This file pins the function's half:
 *   - a failed batch, at schema setup or at the write, is counted in the archival health series before it is
 *     handed back, so the failure is visible while it is retried;
 *   - a failed read of a turn's out-of-band telemetry fails the batch rather than committing the turn with NULL
 *     tokens and latency, and is counted; "no record" still archives the turn from its inline metadata;
 *   - a membership event's id is derived from the event, so a redelivery lands on the row it wrote and a join, a
 *     leave and a rejoin in one batch are three rows;
 *   - the redrive reads back exactly the range a dead-letter record names.
 */
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockBatchInsert = jest.fn();
const mockEnsureSchema = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (...a: unknown[]) => mockTransaction(...a),
  batchInsert: (...a: unknown[]) => mockBatchInsert(...a),
  ensureSchema: (...a: unknown[]) => mockEnsureSchema(...a),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({ detectDrift: jest.fn(), recordDriftFire: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({ updateConversationContext: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/turn-events-live', () => ({
  ...jest.requireActual('../../lambda/src/analytics-aurora/turn-events-live'),
  writeTurnEvents: jest.fn(),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({ touchActivity: jest.fn() }));
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  getChannelContext: jest.fn(async () => null),
  putChannelContext: jest.fn(),
}));
const mockReadAnalytics = jest.fn();
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  ...jest.requireActual('../../lambda/src/lib/message-analytics'),
  readMessageAnalytics: (...a: unknown[]) => mockReadAnalytics(...a),
}));
const mockEmitHealth = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/archival-health', () => ({
  ...jest.requireActual('../../lambda/src/analytics-aurora/archival-health'),
  emitArchivalHealth: (...a: unknown[]) => mockEmitHealth(...a),
}));

import { handler, transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { MessageAnalyticsReadError } from '../../lambda/src/lib/message-analytics';

const { batchOfDeadLetter, recordsOfBatch, kinesisEventOf } = require('../../scripts/lib/archival-redrive.cjs');

const APP = 'arn:aws:chime:us-east-1:1:app-instance/a';
const CHANNEL = `${APP}/channel/c-archival`;

function streamRecord(event: unknown, sequenceNumber = '49650000000000000000000000000000000000000000000000000001') {
  return { kinesis: { sequenceNumber, data: Buffer.from(JSON.stringify(event)).toString('base64') } };
}

const botMessage = (id: string) => ({
  EventType: 'CREATE_CHANNEL_MESSAGE',
  Payload: {
    MessageId: id,
    ChannelArn: CHANNEL,
    Content: 'An answer.',
    Sender: { Arn: `${APP}/bot/advisor`, Name: 'Advisor' },
    CreatedTimestamp: '2026-11-01T00:00:00Z',
  },
});

const membership = (type: string, ts: string | undefined, member = 'ada') => ({
  EventType: type,
  Payload: {
    ChannelArn: CHANNEL,
    Member: { Arn: `${APP}/user/${member}`, Name: member },
    ...(ts ? { CreatedTimestamp: ts, LastUpdatedTimestamp: ts } : {}),
    Type: 'DEFAULT',
  },
});

const ctx = { awsRequestId: 'r-1' } as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockBatchInsert.mockResolvedValue(1);
  mockEnsureSchema.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mockReadAnalytics.mockResolvedValue(null);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('a failed batch is recorded in archival health before it is retried', () => {
  it('counts every record of a batch whose write failed, and hands the failure back', async () => {
    mockTransaction.mockRejectedValue(new Error('connection reset'));
    await expect(handler({ Records: [streamRecord(botMessage('m-1')), streamRecord(botMessage('m-2'), '2')] } as never, ctx))
      .rejects.toThrow('connection reset');
    expect(mockEmitHealth).toHaveBeenCalledWith({ archived: 0, errors: 2 });
  });

  it('counts the batch when the schema could not be brought up to date before it', async () => {
    mockEnsureSchema.mockRejectedValue(new Error('migration 090 failed'));
    await expect(handler({ Records: [streamRecord(botMessage('m-1'))] } as never, ctx)).rejects.toThrow('migration 090 failed');
    expect(mockEmitHealth).toHaveBeenCalledWith({ archived: 0, errors: 1 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('records a committed batch as archived, as before', async () => {
    await handler({ Records: [streamRecord(botMessage('m-1'))] } as never, ctx);
    expect(mockEmitHealth).toHaveBeenCalledWith({ archived: 1, errors: 0 });
  });
});

describe('a turn whose telemetry could not be read is retried, not committed without it', () => {
  it('fails the batch, commits nothing, and counts the record', async () => {
    mockReadAnalytics.mockRejectedValue(new MessageAnalyticsReadError('m-1', new Error('ProvisionedThroughputExceededException')));
    await expect(handler({ Records: [streamRecord(botMessage('m-1'))] } as never, ctx)).rejects.toThrow(/m-1.*retried/);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockBatchInsert).not.toHaveBeenCalled();
    expect(mockEmitHealth).toHaveBeenCalledWith({ archived: 0, errors: 1 });
  });

  it('still archives a turn that has no out-of-band record at all', async () => {
    mockReadAnalytics.mockResolvedValue(null);
    await handler({ Records: [streamRecord(botMessage('m-1'))] } as never, ctx);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockEmitHealth).toHaveBeenCalledWith({ archived: 1, errors: 0 });
  });
});

describe('readMessageAnalytics tells a failed read from no record', () => {
  const mockSend = jest.fn();
  let read: typeof import('../../lambda/src/lib/message-analytics').readMessageAnalytics;
  let ReadError: typeof MessageAnalyticsReadError;

  beforeAll(() => {
    jest.isolateModules(() => {
      process.env.MESSAGE_ANALYTICS_TABLE = 'message-analytics-test';
      jest.doMock('@aws-sdk/lib-dynamodb', () => ({
        DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
        GetCommand: jest.fn((input: unknown) => input),
        PutCommand: jest.fn((input: unknown) => input),
      }));
      const mod = jest.requireActual('../../lambda/src/lib/message-analytics');
      read = mod.readMessageAnalytics;
      ReadError = mod.MessageAnalyticsReadError;
    });
  });
  afterAll(() => { delete process.env.MESSAGE_ANALYTICS_TABLE; });

  it('throws when DynamoDB fails, so the caller cannot mistake it for an absent record', async () => {
    mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));
    await expect(read('m-1')).rejects.toBeInstanceOf(ReadError);
  });

  it('returns null when no row is stored under the id', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(read('m-1')).resolves.toBeNull();
  });

  it('returns the row when there is one', async () => {
    mockSend.mockResolvedValueOnce({ Item: { messageId: 'm-1', inputTokens: 10 } });
    await expect(read('m-1')).resolves.toMatchObject({ inputTokens: 10 });
  });
});

describe('a membership event has one id, derived from the event', () => {
  it('gives the same event the same id on every delivery', async () => {
    const ev = membership('CREATE_CHANNEL_MEMBERSHIP', '2026-11-01T00:00:00Z');
    const first = await transformToMessageRecord(ev as never, { sequenceNumber: '1' });
    const again = await transformToMessageRecord(ev as never, { sequenceNumber: '1' });
    expect(first!.message_id).toBe(again!.message_id);
  });

  it('keeps a join, a leave and a rejoin of one member in one batch as three ids', async () => {
    const ids = await Promise.all([
      transformToMessageRecord(membership('CREATE_CHANNEL_MEMBERSHIP', '2026-11-01T00:00:00Z') as never, { sequenceNumber: '1' }),
      transformToMessageRecord(membership('DELETE_CHANNEL_MEMBERSHIP', '2026-11-01T00:00:00Z') as never, { sequenceNumber: '2' }),
      transformToMessageRecord(membership('CREATE_CHANNEL_MEMBERSHIP', '2026-11-01T00:05:00Z') as never, { sequenceNumber: '3' }),
    ]);
    expect(new Set(ids.map((r) => r!.message_id)).size).toBe(3);
  });

  it('tells apart two events that carry no timestamp by their stream position, and repeats a redelivered one', async () => {
    const ev = membership('CREATE_CHANNEL_MEMBERSHIP', undefined);
    const a = await transformToMessageRecord(ev as never, { sequenceNumber: '100' });
    const b = await transformToMessageRecord(ev as never, { sequenceNumber: '200' });
    const aAgain = await transformToMessageRecord(ev as never, { sequenceNumber: '100' });
    expect(a!.message_id).not.toBe(b!.message_id);
    expect(aAgain!.message_id).toBe(a!.message_id);
  });

  it('writes all three events of a join, a leave and a rejoin delivered in one batch', async () => {
    await handler({
      Records: [
        streamRecord(membership('CREATE_CHANNEL_MEMBERSHIP', '2026-11-01T00:00:00Z', 'ada'), '1'),
        streamRecord(membership('DELETE_CHANNEL_MEMBERSHIP', '2026-11-01T00:00:00Z', 'ada'), '2'),
        streamRecord(membership('CREATE_CHANNEL_MEMBERSHIP', '2026-11-01T00:05:00Z', 'ada'), '3'),
      ],
    } as never, ctx);
    const written = JSON.stringify([...mockBatchInsert.mock.calls, ...mockQuery.mock.calls]);
    const ids = written.match(/(CREATE|DELETE)_CHANNEL_MEMBE-[0-9a-f]{16}-[0-9a-f]{12}/g) ?? [];
    expect(new Set(ids).size).toBe(3);
  });
});

describe('the redrive reads back the range a dead-letter record names', () => {
  const body = JSON.stringify({
    requestContext: { condition: 'RetryAttemptsExhausted' },
    timestamp: '2026-11-01T00:10:00Z',
    KinesisBatchInfo: {
      shardId: 'shardId-000000000001',
      startSequenceNumber: '49650000000000000000000000000000000000000000000000000010',
      endSequenceNumber: '49650000000000000000000000000000000000000000000000000012',
      batchSize: 3,
      streamArn: 'arn:aws:kinesis:us-east-1:1:stream/chime-messaging-test',
    },
  });

  it('parses the batch position, and refuses a body that is not one', () => {
    expect(batchOfDeadLetter(body)).toMatchObject({ shardId: 'shardId-000000000001', batchSize: 3, condition: 'RetryAttemptsExhausted' });
    expect(batchOfDeadLetter('{"Records":[]}')).toBeNull();
    expect(batchOfDeadLetter('not json')).toBeNull();
  });

  it('selects the records in the range, comparing sequence numbers past a double precision', () => {
    const batch = batchOfDeadLetter(body);
    const at = (n: number) => ({ SequenceNumber: `496500000000000000000000000000000000000000000000000000${String(n).padStart(2, '0')}`, PartitionKey: 'p', Data: 'e30=' });
    const read = recordsOfBatch(batch, [at(10), at(11), at(12), at(13)]);
    expect(read.records.map((r: { SequenceNumber: string }) => r.SequenceNumber.slice(-2))).toEqual(['10', '11', '12']);
    expect(read.expired).toBe(false);
    expect(read.reachedEnd).toBe(true);
  });

  it('reports a range the stream has already trimmed as expired', () => {
    const batch = batchOfDeadLetter(body);
    expect(recordsOfBatch(batch, [{ SequenceNumber: '49650000000000000000000000000000000000000000000000000011' }]).expired).toBe(true);
    expect(recordsOfBatch(batch, []).expired).toBe(true);
  });

  it('builds the event the archival function reads', async () => {
    const batch = batchOfDeadLetter(body);
    const data = Buffer.from(JSON.stringify(botMessage('m-9'))).toString('base64');
    const event = kinesisEventOf(batch, [{ SequenceNumber: '10', PartitionKey: 'p', Data: data, ApproximateArrivalTimestamp: '2026-11-01T00:00:00Z' }], 'us-east-1');
    expect(event.Records[0]).toMatchObject({ eventSource: 'aws:kinesis', eventSourceARN: batch.streamArn, kinesis: { sequenceNumber: '10', data } });
    await handler(event as never, ctx);
    expect(mockEmitHealth).toHaveBeenCalledWith({ archived: 1, errors: 0 });
  });
});
