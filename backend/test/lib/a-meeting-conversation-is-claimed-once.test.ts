/**
 * A MEETING'S CONVERSATION IS CLAIMED ONCE, AND ITS WRITES ARE ONES DYNAMODB ACCEPTS (SPEC-ASSISTANT-MEETINGS FR27).
 *
 * DynamoDB refuses an update whose expression attribute names or values include one its expressions never use
 * (`ValidationException`), which a mocked client cannot see. So each write the meeting conversation makes is captured
 * here and held to that rule, in every shape it takes: a first claim, a claim over an ended meeting's conversation, the
 * settle, the parent link and the ended card's room.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  GetCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  PutCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  DeleteCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  ScanCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

process.env.CHANNEL_CONTEXT_TABLE = 'Conversations-ChannelContext';

import {
  claimMeetingConversation, settleMeetingConversation, recordMeetingOf, recordEndedMeetingCard,
} from '../../lambda/src/lib/channel-context-client';

const ROOM = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/room-1';
const MEETING = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/meet-1';

interface Update { UpdateExpression: string; ConditionExpression?: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> }
const lastUpdate = (): Update => mockSend.mock.calls.at(-1)![0].input as Update;

/** Every name and value the write declares is used by its expressions, as DynamoDB requires. */
function expectAcceptable(u: Update) {
  const text = `${u.UpdateExpression} ${u.ConditionExpression ?? ''}`;
  for (const name of Object.keys(u.ExpressionAttributeNames)) expect({ name, used: new RegExp(`${name}\\b`).test(text) }).toEqual({ name, used: true });
  for (const value of Object.keys(u.ExpressionAttributeValues)) expect({ value, used: new RegExp(`${value}\\b`).test(text) }).toEqual({ value, used: true });
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('the writes a meeting conversation makes', () => {
  it('claims a first meeting conversation with a write DynamoDB accepts', async () => {
    expect(await claimMeetingConversation(ROOM, undefined, 'tok-1', { now: Date.parse('2026-11-11T10:00:00Z') })).toBe('claimed');
    expectAcceptable(lastUpdate());
    expect(lastUpdate().ConditionExpression).not.toContain('#arn');
  });

  it('claims over an ended meeting\'s conversation only while it is still the one recorded', async () => {
    expect(await claimMeetingConversation(ROOM, MEETING, 'tok-2')).toBe('claimed');
    expectAcceptable(lastUpdate());
    expect(lastUpdate().ConditionExpression).toContain('#mc.#arn = :prior');
    expect(lastUpdate().ExpressionAttributeValues[':prior']).toBe(MEETING);
  });

  it('loses the claim to another start, and fails on any other refusal', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('taken'), { name: 'ConditionalCheckFailedException' }));
    expect(await claimMeetingConversation(ROOM, undefined, 'tok-3')).toBe('lost');
    mockSend.mockRejectedValueOnce(Object.assign(new Error('bad'), { name: 'ValidationException' }));
    expect(await claimMeetingConversation(ROOM, undefined, 'tok-4')).toBe('failed');
  });

  it('settles, links the meeting conversation to its room, and records the ended card\'s room, each with a write DynamoDB accepts', async () => {
    expect(await settleMeetingConversation(ROOM, 'tok-1', MEETING)).toBe(true);
    expectAcceptable(lastUpdate());
    expect(await recordMeetingOf(MEETING, ROOM)).toBe(true);
    expectAcceptable(lastUpdate());
    expect(await recordEndedMeetingCard(MEETING, 'm-1', 'msg-1', 'arn:bot', ROOM)).toBe(true);
    expectAcceptable(lastUpdate());
    expect(lastUpdate().ExpressionAttributeValues[':in']).toBe(ROOM);
  });
});
