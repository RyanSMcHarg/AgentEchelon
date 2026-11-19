/**
 * A PERSON'S MESSAGE METADATA DECLARES NOTHING ABOUT THE TURN.
 *
 * A member writes their own message's Metadata on their own credential. The projection files the
 * conversation's classification from the turn's declaration, and the scoped admin and team readers list a
 * conversation by that column, so a declaration read off a person's message would let any member decide
 * which readers see the conversation. Only an assistant's message declares.
 */
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  batchInsert: jest.fn(async () => 0),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));

import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c-premium';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/premium-assistant';
const PERSON = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';

const DECLARATION = {
  classification: 'standard',
  userClearance: 'standard',
  experimentId: 'exp-1',
  variantId: 'b',
  inputTokens: 9999,
};

const event = (sender: string, metadata: Record<string, unknown>) => ({
  EventType: 'CREATE_CHANNEL_MESSAGE',
  Payload: {
    MessageId: 'm-1',
    ChannelArn: CHANNEL,
    Content: 'hello',
    Sender: { Arn: sender, Name: 'Sender' },
    CreatedTimestamp: '2026-11-02T10:00:00.000Z',
    Persistence: 'PERSISTENT',
    Metadata: JSON.stringify(metadata),
  },
});

describe("archival reads a turn's declarations from an assistant's message only", () => {
  it.each([
    ['flat', DECLARATION],
    ['nested under analytics', { analytics: DECLARATION }],
  ])("ignores a person's %s declaration", async (_shape, metadata) => {
    const rec = await transformToMessageRecord(event(PERSON, metadata) as never);
    expect({
      conversation_classification: rec?.conversation_classification,
      user_clearance: rec?.user_clearance,
      experiment_id: rec?.experiment_id,
      variant_id: rec?.variant_id,
      input_tokens: rec?.input_tokens,
    }).toEqual({
      conversation_classification: null,
      user_clearance: null,
      experiment_id: null,
      variant_id: null,
      input_tokens: null,
    });
  });

  it("files an assistant's declaration", async () => {
    const rec = await transformToMessageRecord(event(BOT, DECLARATION) as never);
    expect(rec?.conversation_classification).toBe('standard');
    expect(rec?.experiment_id).toBe('exp-1');
  });
});
