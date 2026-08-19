/**
 * Conversation context assembly - loadChannelHistory + the Bedrock message array
 *
 * These pin the two ways a turn silently lost its own conversation, both of which presented
 * identically to a user ("the assistant does not remember what I just told it") and neither of
 * which surfaced as an error:
 *
 *   1. Placeholder detection ran on PUNCTUATION. `content.includes('...')` matches every
 *      placeholder copy ("One moment...", "Analyzing...", "Looking into that..."), but it also
 *      matches ordinary assistant prose, so a real reply that happened to use an ellipsis was
 *      deleted from the history the next turn was built from. `content.includes('thinking')` did
 *      the same for any reply containing that word. The detection now matches the `<!--corr:`
 *      marker every placeholder is posted with and nothing else.
 *
 *   2. Consolidation ran BEFORE the current user turn was appended. Consolidation exists because
 *      Bedrock requires alternating roles, so appending afterwards re-created the adjacency it had
 *      just removed whenever the history ended on a user turn - which is the normal state when the
 *      trailing bot message is a placeholder still awaiting its answer.
 *
 * Defect 1 CAUSES the precondition for defect 2, so they are pinned together: dropping the
 * assistant reply is what leaves the history ending on a user turn.
 */

const mockMessagingSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListChannelMessagesCommand: jest.fn(),
  GetChannelMessageCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(),
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

import {
  isPlaceholderMessage,
  loadChannelHistory,
  runSharedPipeline,
  type ConversationMessage,
} from '../../lambda/src/lib/async-processor-core';
import { speakerIdFrom } from '../../lambda/src/lib/transcript-attribution';

const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const USER = 'arn:aws:chime:us-east-1:111:app-instance/i/user/sub-1';
const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-1';

/** ListChannelMessages returns newest-first; loadChannelHistory reverses it. */
function queueMessages(messages: Array<{ sender: string; content: string }>): void {
  mockMessagingSend.mockResolvedValueOnce({
    ChannelMessages: [...messages]
      .reverse()
      .map(m => ({ Sender: { Arn: m.sender }, Content: m.content, Metadata: undefined })),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isPlaceholderMessage', () => {
  it.each([
    'One moment... <!--corr:abc123-->',
    'Analyzing... <!--corr:abc123-->',
    'Looking into that... <!--corr:abc123-->',
    'One moment... <!--corr:abc123--><!--battle:battleId=b1,round=1,total=2,rivalArn=arn-->',
  ])('matches the placeholder %j', (content) => {
    expect(isPlaceholderMessage(content)).toBe(true);
  });

  // THE REGRESSION. Each of these is a real assistant answer that the previous punctuation match
  // deleted from the model's context.
  it.each([
    'The cutover date you mentioned is March 14.',
    'Let me check... the cutover date you mentioned is March 14.',
    'Well... that depends on the migration window.',
    'I was thinking about your billing migration question.',
    'Options include: a phased cutover, a big-bang cutover, ...',
  ])('does NOT match the real reply %j', (content) => {
    expect(isPlaceholderMessage(content)).toBe(false);
  });
});

/**
 * The entry loadChannelHistory produces for a message, including the speaker identity it stopped
 * discarding in ADR-027 part 1. These fixtures carry no Sender.Name, so `name` is undefined - the
 * label falls back to the kind, which is asserted in transcript-attribution.test.ts.
 */
function entry(role: 'user' | 'assistant', content: string, sender: string): ConversationMessage {
  return {
    role,
    content,
    speaker: {
      id: speakerIdFrom(sender),
      name: undefined,
      kind: sender.includes('/bot/') ? 'assistant' : 'person',
    },
    isSelf: sender === BOT,
  };
}

describe('loadChannelHistory', () => {
  it('keeps an assistant reply that contains an ellipsis', async () => {
    queueMessages([
      { sender: USER, content: 'I am reviewing the billing migration and the cutover date is March 14.' },
      { sender: BOT, content: 'Understood... I have noted the March 14 cutover date.' },
    ]);

    const history = await loadChannelHistory(CHANNEL, BOT, 'What cutover date did I mention?');

    expect(history).toEqual<ConversationMessage[]>([
      entry('user', 'I am reviewing the billing migration and the cutover date is March 14.', USER),
      entry('assistant', 'Understood... I have noted the March 14 cutover date.', BOT),
    ]);
  });

  it('keeps an assistant reply that contains the word "thinking"', async () => {
    queueMessages([
      { sender: USER, content: 'What should I consider?' },
      { sender: BOT, content: 'I have been thinking about it: the main risk is the cutover window.' },
    ]);

    const history = await loadChannelHistory(CHANNEL, BOT, 'And the second risk?');

    expect(history.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(history[1].content).toContain('cutover window');
  });

  it('still drops the unanswered placeholder', async () => {
    queueMessages([
      { sender: USER, content: 'I am reviewing the billing migration and the cutover date is March 14.' },
      { sender: BOT, content: 'Understood, noted.' },
      { sender: BOT, content: 'One moment... <!--corr:9f9a434b960e3110-->' },
    ]);

    const history = await loadChannelHistory(CHANNEL, BOT, 'What cutover date did I mention?');

    expect(history).toEqual<ConversationMessage[]>([
      entry('user', 'I am reviewing the billing migration and the cutover date is March 14.', USER),
      entry('assistant', 'Understood, noted.', BOT),
    ]);
  });

  it('drops a URL-encoded placeholder (Content arrives encoded from Chime)', async () => {
    queueMessages([
      { sender: USER, content: 'Hello' },
      { sender: BOT, content: encodeURIComponent('One moment... <!--corr:abc123-->') },
    ]);

    const history = await loadChannelHistory(CHANNEL, BOT, 'Anything else?');

    expect(history).toEqual<ConversationMessage[]>([entry('user', 'Hello', USER)]);
  });

  it('excludes the current user message but keeps earlier user turns', async () => {
    queueMessages([
      { sender: USER, content: 'The cutover date is March 14.' },
      { sender: BOT, content: 'Noted.' },
      { sender: USER, content: 'What cutover date did I mention?' },
    ]);

    const history = await loadChannelHistory(CHANNEL, BOT, 'What cutover date did I mention?');

    expect(history).toEqual<ConversationMessage[]>([
      entry('user', 'The cutover date is March 14.', USER),
      entry('assistant', 'Noted.', BOT),
    ]);
  });
});

/**
 * Drive the REAL pipeline, not a local mirror of its composition - a mirror would keep passing if
 * the pipeline reverted to consolidating before appending the current turn.
 *
 * `placeholderMessageId` and `conversationHistory` are supplied so the poll and the channel read are
 * skipped: this is about the composition alone. A history containing a user turn also makes
 * `isFirstUserTurn` false, so no title rename is kicked off.
 */
async function composeBedrockMessages(
  history: ConversationMessage[],
  userMessage: string,
): Promise<ConversationMessage[]> {
  const pipeline = await runSharedPipeline({
    channelArn: CHANNEL,
    correlationId: 'corr-test',
    botArn: BOT,
    senderArn: USER,
    userMessage,
    placeholderMessageId: 'placeholder-msg-id',
    // The pipeline loads from the channel only when this is empty, so an empty-history case has to
    // go through loadChannelHistory; queue an empty channel for it.
    conversationHistory: history,
  } as Parameters<typeof runSharedPipeline>[0]);
  if (!pipeline) throw new Error('pipeline returned null');
  return pipeline.bedrockMessages;
}

describe('bedrock message array alternates', () => {
  it('does not emit two consecutive user turns when the history ends on a user turn', async () => {
    // Exactly the state left behind when the trailing bot message is a placeholder: the history
    // ends on the user's own turn.
    const messages = await composeBedrockMessages(
      [{ role: 'user', content: 'The cutover date is March 14.' }],
      'What cutover date did I mention?',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    // Consolidating rather than dropping: the earlier turn's content must survive the merge, or the
    // fix for the adjacency would itself lose the context.
    expect(messages[0].content).toContain('March 14');
    expect(messages[0].content).toContain('What cutover date did I mention?');
  });

  it('leaves an already-alternating history alone and appends the current turn', async () => {
    const messages = await composeBedrockMessages(
      [
        { role: 'user', content: 'The cutover date is March 14.' },
        { role: 'assistant', content: 'Noted.' },
      ],
      'What cutover date did I mention?',
    );

    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2].content).toBe('What cutover date did I mention?');
  });

  it('never produces adjacent same-role entries, for any history shape', async () => {
    const shapes: ConversationMessage[][] = [
      [{ role: 'user', content: 'a' }],
      [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }],
      [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'assistant', content: 'c' }],
    ];

    for (const shape of shapes) {
      const messages = await composeBedrockMessages(shape, 'current turn');
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].role).not.toBe(messages[i - 1].role);
      }
      expect(messages[messages.length - 1].role).toBe('user');
      expect(messages[messages.length - 1].content).toContain('current turn');
    }
  });
});
