/**
 * A PRIVATE BRIEF NEVER REACHES A PUBLIC REPLY OR A RECAP.
 *
 * The assistant can read a message addressed privately to it, so a private request is in the
 * conversation it lists. A turn is given a targeted message only when its reply goes to one person
 * who already sees that message. Every other turn, including the room-visible reply to an untargeted
 * message, a stop evaluation, a reading and a join recap, is given none (`privateReaderOf`,
 * `lambda/src/lib/async-processor-core.ts`). What the model is not given it cannot repeat.
 */

const mockMessagingSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
  InvokeModelCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListChannelMessagesCommand: jest.fn(),
  GetChannelMessageCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(),
  DescribeChannelCommand: jest.fn(),
  UpdateChannelCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  GetCommand: jest.fn(),
  QueryCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

import { loadChannelHistory } from '../../lambda/src/lib/async-processor-core';
import { DEFAULT_JOIN_RECAP_REQUEST } from '../../lambda/src/lib/join-recap';

const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const ALICE = 'arn:aws:chime:us-east-1:111:app-instance/i/user/alice';
const BOB = 'arn:aws:chime:us-east-1:111:app-instance/i/user/bob';
const CAROL = 'arn:aws:chime:us-east-1:111:app-instance/i/user/carol';
const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-1';

const BRIEF = 'Write me a private briefing about sardine-cartography';
const BRIEF_ANSWER = 'Here is your sardine-cartography briefing';

type Msg = { MessageId: string; Sender: { Arn: string }; Content: string; Target?: Array<{ MemberArn: string }> };

/** Oldest first; the listing is returned newest first, as Amazon Chime SDK returns it. */
function channel(...messages: Msg[]): void {
  mockMessagingSend.mockResolvedValueOnce({ ChannelMessages: [...messages].reverse() });
}

const aliceBrief: Msg = { MessageId: 'p1', Sender: { Arn: ALICE }, Content: BRIEF, Target: [{ MemberArn: BOT }] };
const briefAnswer: Msg = { MessageId: 'p2', Sender: { Arn: BOT }, Content: BRIEF_ANSWER, Target: [{ MemberArn: ALICE }] };
const open: Msg = { MessageId: 'o1', Sender: { Arn: BOB }, Content: 'The deploy is on Friday' };

function leaksNothing(history: unknown): void {
  expect(JSON.stringify(history)).not.toContain('sardine');
}

beforeEach(() => mockMessagingSend.mockReset());

describe('a reply the room reads', () => {
  it('to an untargeted message is given no private message', async () => {
    const own: Msg = { MessageId: 'q1', Sender: { Arn: BOB }, Content: 'What did we decide?' };
    channel(aliceBrief, briefAnswer, open, own);
    const history = await loadChannelHistory(CHANNEL, BOT, own.Content, { currentMessageId: 'q1', senderArn: BOB });
    expect(history.map((m) => m.content)).toEqual([open.Content]);
    leaksNothing(history);
  });

  it('from a stop evaluation or a reading, which has no message of its own, is given no private message', async () => {
    channel(aliceBrief, briefAnswer, open);
    const history = await loadChannelHistory(CHANNEL, BOT, 'Was the stopped work needed?', { excludeIds: [] });
    expect(history.map((m) => m.content)).toEqual([open.Content]);
    leaksNothing(history);
  });

  it('posted publicly although its own message was targeted is given no private message', async () => {
    const own: Msg = { MessageId: 'q1', Sender: { Arn: ALICE }, Content: 'carry on', Target: [{ MemberArn: BOT }] };
    channel(aliceBrief, briefAnswer, open, own);
    const history = await loadChannelHistory(CHANNEL, BOT, own.Content, {
      currentMessageId: 'q1', senderArn: ALICE, answeredInPublic: true,
    });
    expect(history.map((m) => m.content)).toEqual([open.Content]);
    leaksNothing(history);
  });
});

describe('a join recap', () => {
  it('addressed to the new member is given nothing anybody said privately before they joined', async () => {
    channel(aliceBrief, briefAnswer, open);
    const history = await loadChannelHistory(CHANNEL, BOT, DEFAULT_JOIN_RECAP_REQUEST, { senderArn: CAROL });
    expect(history.map((m) => m.content)).toEqual([open.Content]);
    leaksNothing(history);
  });
});

describe('a reply addressed to one person', () => {
  it('is given only the private messages that person already sees', async () => {
    const bobPrivate: Msg = { MessageId: 'b1', Sender: { Arn: BOB }, Content: 'my laptop request', Target: [{ MemberArn: BOT }] };
    const own: Msg = { MessageId: 'q1', Sender: { Arn: BOB }, Content: 'any news?', Target: [{ MemberArn: BOT }] };
    channel(aliceBrief, briefAnswer, bobPrivate, open, own);
    const history = await loadChannelHistory(CHANNEL, BOT, own.Content, { currentMessageId: 'q1', senderArn: BOB });
    expect(history.map((m) => m.content)).toEqual([bobPrivate.Content, open.Content]);
    leaksNothing(history);
  });

  it('is given no private message when its own message was sent by somebody else', async () => {
    const own: Msg = { MessageId: 'q1', Sender: { Arn: ALICE }, Content: 'any news?', Target: [{ MemberArn: BOT }] };
    channel(aliceBrief, briefAnswer, open, own);
    const history = await loadChannelHistory(CHANNEL, BOT, own.Content, { currentMessageId: 'q1', senderArn: BOB });
    expect(history.map((m) => m.content)).toEqual([open.Content]);
    leaksNothing(history);
  });
});
