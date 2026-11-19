/**
 * A LONG ANSWER'S PARTS ARE POSTED IN THE ORDER THEY READ.
 *
 * Measured on dev 2026-11-18: a two-part account brief showed its closing part ("---" and the source line) as the
 * conversation's first message and the brief after it. The continuation was posted while the answer was being sized,
 * before the first part was written into its message, so the tail reached every reader before the head.
 *
 * What it proves, driven through `finalizePlaceholderResponse` with the Amazon Chime SDK stubbed:
 *  - the first part is written into the placeholder before any continuation is posted, and each continuation names that
 *    message as its parent, in order;
 *  - the turn's record rides the message holding the first part, and no continuation carries it;
 *  - `handleLongResponse` posts nothing itself; its `postContinuations` does, once called;
 *  - DENY: a continuation the Amazon Chime SDK refuses is followed by the truncation note as the answer's last part, and
 *    a stopped turn posts no continuation at all.
 */
const mockMessagingSend = jest.fn();
const mockWriteMessageAnalytics = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  GetChannelMessageCommand: class { __type = 'Get'; constructor(public input: Record<string, unknown>) {} },
  UpdateChannelMessageCommand: class { __type = 'Update'; constructor(public input: Record<string, unknown>) {} },
  SendChannelMessageCommand: class { __type = 'Send'; constructor(public input: Record<string, unknown>) {} },
  ListChannelMessagesCommand: class { __type = 'List'; constructor(public input: Record<string, unknown>) {} },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
  ChannelMessageType: { STANDARD: 'STANDARD' },
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({ BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn() })), ConverseCommand: jest.fn(), ApplyGuardrailCommand: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn() }));
jest.mock('@aws-sdk/client-lambda', () => ({ LambdaClient: jest.fn(() => ({ send: jest.fn() })), InvokeCommand: jest.fn(), InvocationType: { Event: 'Event' } }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  GetCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), QueryCommand: jest.fn(), ScanCommand: jest.fn(), DeleteCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('../../lambda/src/lib/battle-state', () => ({
  markBotWaitingForUser: jest.fn(),
  getBotRow: jest.fn().mockResolvedValue(null),
  computeActiveResponseMs: () => 0,
  transitionBotState: jest.fn(),
  readBattleRows: jest.fn().mockResolvedValue([]),
  allBotsTerminal: jest.fn(() => false),
}));
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  writeMessageAnalytics: (...args: unknown[]) => mockWriteMessageAnalytics(...args),
  messageAnalyticsEnabled: () => false,
}));

import { finalizePlaceholderResponse, handleLongResponse } from '../../lambda/src/lib/async-processor-core';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/advisor';
const USER = 'arn:aws:chime:us-east-1:111:app-instance/user/u1';
const PLACEHOLDER = 'placeholder-msg';
const HEAD = '# Coastal Health Systems: account brief';
const TAIL = '*Source: customer-accounts.json - leadership restricted.*';
const BRIEF = [
  HEAD,
  ...Array.from({ length: 24 }, (_, i) => `- Point ${i + 1}: the renewal on 2026-12-01 is at risk because adoption fell in the last quarter, per the record.`),
  '---',
  TAIL,
].join('\n\n');

interface FakeCommand { __type: string; input: Record<string, unknown> }
const mutations = (): FakeCommand[] =>
  mockMessagingSend.mock.calls.map((c) => c[0] as FakeCommand).filter((c) => c?.__type === 'Update' || c?.__type === 'Send');
const text = (c: FakeCommand) => decodeURIComponent(c.input.Content as string);
const meta = (c: FakeCommand) => JSON.parse((c.input.Metadata as string) || '{}');

let sends = 0;
function stubChime(refuseSend?: number) {
  sends = 0;
  mockMessagingSend.mockImplementation((cmd: FakeCommand) => {
    if (cmd.__type === 'Get') return Promise.resolve({ ChannelMessage: {} });
    if (cmd.__type === 'Send') {
      sends++;
      if (sends === refuseSend) return Promise.reject(Object.assign(new Error('Channel Messages size limit exceeded'), { name: 'BadRequestException' }));
      return Promise.resolve({ MessageId: `part-${sends}` });
    }
    return Promise.resolve({});
  });
}

const finalize = () => finalizePlaceholderResponse({
  event: { channelArn: CHANNEL, correlationId: 'corr-1', userMessage: 'Prepare an account brief.', classification: 'premium', botArn: BOT, senderArn: USER },
  response: BRIEF,
  model: 'anthropic.claude-sonnet',
  inputTokens: 10, outputTokens: 20, bedrockTime: 100,
  messageId: PLACEHOLDER, guardMs: 2, placeholderResolveMs: 5, conversationHistoryLength: 2,
  startTime: Date.now(),
} as never);

beforeEach(() => {
  mockMessagingSend.mockReset();
  mockWriteMessageAnalytics.mockReset().mockResolvedValue(undefined);
});

describe('a long answer, delivered', () => {
  it('writes the first part into its message before posting the parts that continue it, in order', async () => {
    stubChime();
    await finalize();
    const m = mutations();
    const head = m.findIndex((c) => c.__type === 'Update' && c.input.MessageId === PLACEHOLDER && text(c).includes(HEAD));
    const parts = m.map((c, i) => ({ c, i })).filter(({ c }) => c.__type === 'Send' && meta(c).continuation === true);
    expect(head).toBeGreaterThan(-1);
    expect(parts.length).toBeGreaterThan(0);
    for (const { c, i } of parts) {
      expect(i).toBeGreaterThan(head);
      expect(meta(c).parentMessageId).toBe(PLACEHOLDER);
    }
    expect(parts.map(({ c }) => meta(c).part)).toEqual(parts.map((_, k) => k + 2));
    // The tail is in the last part, after the head, never ahead of it.
    expect(text(parts[parts.length - 1].c)).toContain(TAIL);
    expect(text(m[head])).not.toContain(TAIL);
  });

  it('keeps the turn\'s record on the message holding the first part; the parts carry only their grouping', async () => {
    stubChime();
    await finalize();
    const head = mutations().find((c) => c.__type === 'Update' && c.input.MessageId === PLACEHOLDER && text(c).includes(HEAD))!;
    expect(meta(head).respPhase).toBe('final');
    for (const c of mutations().filter((x) => x.__type === 'Send')) {
      expect(Object.keys(meta(c)).sort()).toEqual(['continuation', 'parentMessageId', 'part', 'responseGroup', 'totalParts']);
    }
  });

  it('DENY: a refused part is followed by the truncation note, as the answer\'s last part, after the first part', async () => {
    stubChime(1);
    await finalize();
    const m = mutations();
    const head = m.findIndex((c) => c.__type === 'Update' && c.input.MessageId === PLACEHOLDER && text(c).includes(HEAD));
    const sent = m.map((c, i) => ({ c, i })).filter(({ c }) => c.__type === 'Send');
    expect(sent).toHaveLength(2);
    expect(sent[0].i).toBeGreaterThan(head);
    expect(meta(sent[1].c)).toMatchObject({ continuation: true, parentMessageId: PLACEHOLDER, part: 2 });
    expect(text(sent[1].c)).not.toContain(TAIL);
  });
});

describe('handleLongResponse', () => {
  it('posts nothing itself: the parts after the first go out when the caller says the first is written', async () => {
    stubChime();
    const r = await handleLongResponse(BRIEF, CHANNEL, BOT, PLACEHOLDER, []);
    expect(r.totalParts).toBeGreaterThan(1);
    expect(mutations()).toHaveLength(0);
    await r.postContinuations!();
    expect(mutations().length).toBe((r.totalParts ?? 1) - 1);
  });

  it('DENY: a stopped turn has no parts to post', async () => {
    stubChime();
    const r = await handleLongResponse(BRIEF, CHANNEL, BOT, PLACEHOLDER, [], true);
    expect(r.postContinuations).toBeUndefined();
    expect(mutations()).toHaveLength(0);
  });
});
