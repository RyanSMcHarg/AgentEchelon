/**
 * THE SEAMS A DECLINED DRIFT TOPIC CROSSES, EACH PINNED WHERE IT CAN FAIL SILENTLY.
 *
 * The drift flow and the detector are tested on their own terms (`live-drift-flow.test.ts`,
 * `analytics-aurora/drift-detection.test.ts`). What those cannot see is the wiring between them, and
 * every piece of it fails without an error:
 *
 *   - the data-plane DISPATCH. An op the handler does not route throws "unknown op", which the client
 *     swallows, so every decline would adopt nothing and nobody would be told.
 *   - the client's DEGRADE. A failed adoption must not fail the person's turn.
 *   - the inbound message's SEND TIME, which is what tells an answer to an offer from a message sent
 *     before the offer existed. A lookup that dropped it would disable that guard, and every earlier
 *     message would decline an offer nobody had seen.
 *   - the MIGRATION. The table has to exist, carry the classification the boundary partitions on, and be
 *     registered as a bounded table, or the reads and writes that run as its reader and writer roles fail.
 */
import * as fs from 'fs';
import * as path from 'path';

// ── the data-plane dispatch ─────────────────────────────────────────────────────────────────────────
const mockAdopt = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  ensureSchema: jest.fn(async () => undefined),
  query: jest.fn(),
  transaction: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
  recordDriftOutcome: jest.fn(),
  getLatestSummary: jest.fn(),
  adoptOfferedTopic: (...a: unknown[]) => mockAdopt(...a),
}));

// ── the client ──────────────────────────────────────────────────────────────────────────────────────
const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockLambdaSend(...a) })),
  InvokeCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}), { virtual: true });

// ── the inbound message ─────────────────────────────────────────────────────────────────────────────
const mockChimeSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockChimeSend(...a) })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}), { virtual: true });

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

beforeEach(() => {
  mockAdopt.mockReset();
  mockLambdaSend.mockReset();
  mockChimeSend.mockReset();
});

describe('the data plane routes adoptOfferedTopic to the detector', () => {
  it('dispatches the op and returns the detector\'s answer', async () => {
    mockAdopt.mockResolvedValue({ adopted: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handler } = require('../../lambda/src/analytics-aurora/data-plane-handler');

    const result = await handler({ op: 'adoptOfferedTopic', input: { channelArn: CHANNEL, correlationId: 'corr-1' } });

    expect(mockAdopt).toHaveBeenCalledWith({ channelArn: CHANNEL, correlationId: 'corr-1' });
    expect(result).toEqual({ adopted: true });
  });
});

describe('the client degrades an adoption failure instead of failing the turn', () => {
  const OLD_ARN = process.env.AURORA_DATA_PLANE_ARN;
  afterEach(() => {
    if (OLD_ARN === undefined) delete process.env.AURORA_DATA_PLANE_ARN;
    else process.env.AURORA_DATA_PLANE_ARN = OLD_ARN;
  });

  it('invokes the named op with the offer it adopts', async () => {
    process.env.AURORA_DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:111:function:data-plane';
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ adopted: true })) });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adoptOfferedTopic } = require('../../lambda/src/lib/data-plane-client');

    expect(await adoptOfferedTopic({ channelArn: CHANNEL, correlationId: 'corr-2' })).toEqual({ adopted: true });
    const payload = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString());
    expect(payload).toEqual({ op: 'adoptOfferedTopic', input: { channelArn: CHANNEL, correlationId: 'corr-2' } });
  });

  it('returns adopted:false on a function error', async () => {
    process.env.AURORA_DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:111:function:data-plane';
    mockLambdaSend.mockResolvedValue({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"unknown op"}') });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adoptOfferedTopic } = require('../../lambda/src/lib/data-plane-client');

    expect(await adoptOfferedTopic({ channelArn: CHANNEL, correlationId: 'corr-3' })).toEqual({ adopted: false });
  });

  it('returns adopted:false when the data plane is not wired', async () => {
    delete process.env.AURORA_DATA_PLANE_ARN;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adoptOfferedTopic } = require('../../lambda/src/lib/data-plane-client');

    expect(await adoptOfferedTopic({ channelArn: CHANNEL, correlationId: 'corr-4' })).toEqual({ adopted: false });
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('the inbound message carries when it was sent', () => {
  it('returns the send time of the matched message', async () => {
    const sender = 'arn:aws:chime:us-east-1:111:app-instance/i/user/alice';
    mockChimeSend.mockResolvedValue({
      ChannelMessages: [
        { MessageId: 'm-2', Sender: { Arn: sender }, Content: 'something else', CreatedTimestamp: new Date('2026-09-12T10:00:09Z') },
        { MessageId: 'm-1', Sender: { Arn: sender }, Content: 'what is 17 times 3', CreatedTimestamp: new Date('2026-09-12T10:00:04Z') },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { findInboundMessage } = require('../../lambda/src/lib/inbound-message');

    const found = await findInboundMessage({
      channelArn: CHANNEL, senderArn: sender, botArn: 'arn:bot', userMessage: 'what is 17 times 3',
    });

    expect(found.messageId).toBe('m-1');
    expect(found.createdAt).toBe('2026-09-12T10:00:04.000Z');
  });
});

describe('migration 044 creates a bounded topic table and completes the durable offer', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../lambda/src/analytics-aurora/schema/044-a-declined-topic-belongs-to-the-conversation.sql'),
    'utf8',
  );

  it('creates the topic table idempotently, keyed per conversation and topic', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS conversation_topic_embeddings');
    expect(sql).toMatch(/PRIMARY KEY \(channel_arn, topic_key\)/);
    expect(sql).toMatch(/status VARCHAR\(16\) NOT NULL CHECK \(status IN \('offered', 'adopted'\)\)/);
    expect(sql).toMatch(/embedding vector\(1024\) NOT NULL/);
  });

  it('carries the classification column and is a bounded table, so the role boundary applies', () => {
    expect(sql).toMatch(/classification TEXT/);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BOUNDED_TABLES } = require('../../lambda/src/analytics-aurora/classification-boundary-sql');
    expect(BOUNDED_TABLES).toContain('conversation_topic_embeddings');
  });

  it('adds the drift event id to the pending offer, additively', () => {
    expect(sql).toContain('ALTER TABLE conversation_creation_tasks ADD COLUMN IF NOT EXISTS drift_event_id');
  });

  it('stores no message text: the by-reference rule holds', () => {
    // The table carries an embedding and a key, never the words that produced them.
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS conversation_topic_embeddings'), sql.indexOf(');'));
    expect(table).not.toMatch(/content|message_text|body/i);
  });
});
