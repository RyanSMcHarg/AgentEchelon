/**
 * A SUBJECT MOVED TO ANOTHER CONVERSATION LEAVES THE ORIGINAL ONE'S CONTEXT.
 *
 * A person asks about one thing, then another; the assistant offers to move the second subject, they say yes,
 * and it moves. The messages stay in the original conversation, as the record. The next turn there is answered
 * without them, so the moved subject does not come back into a conversation it was moved out of.
 *
 *  - the move is declared on the reply that acted on the yes, and on the link the original receives;
 *  - the rule finds the moved exchange from those declarations alone, and a person cannot forge one;
 *  - a declined offer moves nothing;
 *  - the history a turn is answered from leaves the moved exchange out.
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
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import { movedMessageIds, type TranscriptMessage } from '../../lambda/src/lib/moved-subject';
import { withTurnDeclaration, turnDeclarationOf } from '../../lambda/src/lib/turn-declaration';
import { loadChannelHistory } from '../../lambda/src/lib/async-processor-core';

const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/advisor';
const USER = 'arn:aws:chime:us-east-1:111:app-instance/i/user/person-1';
const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-1';

/** The example conversation: AgentEchelon, then the revenue pipeline, moved on a yes. */
const OFFER = withTurnDeclaration('This looks like a new subject. Reply yes to start a new conversation.', { answers: 'm3', kind: 'drift' });
const ACTED = withTurnDeclaration('Created a new conversation. NAVIGATE_CHANNEL:arn:new|Open it', { kind: 'drift', moves: 'm3', answers: 'm4' });
const LINK = withTurnDeclaration('This subject moved to Revenue pipeline.', { kind: 'drift', moves: 'm3' });
const transcript: Array<TranscriptMessage & { sender: string }> = [
  { id: 'm1', sender: USER, fromAssistant: false, content: 'How does AgentEchelon route a turn?' },
  { id: 'm2', sender: BOT, fromAssistant: true, content: 'AgentEchelon routes each turn through the router.' },
  { id: 'm3', sender: USER, fromAssistant: false, content: 'What is our revenue pipeline for Q3?' },
  { id: 'm5', sender: BOT, fromAssistant: true, content: OFFER },
  { id: 'm4', sender: USER, fromAssistant: false, content: 'yes' },
  { id: 'm6', sender: BOT, fromAssistant: true, content: ACTED },
  { id: 'm7', sender: BOT, fromAssistant: true, content: LINK },
];

describe('the rule finds the moved exchange from the declarations', () => {
  it('moves the message, the offer about it, the yes, the reply that acted on it and the link', () => {
    expect([...movedMessageIds(transcript)].sort()).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('keeps the conversation\'s own subject', () => {
    const moved = movedMessageIds(transcript);
    expect(moved.has('m1')).toBe(false);
    expect(moved.has('m2')).toBe(false);
  });

  it('moves nothing when the offer was declined', () => {
    const declined = transcript.filter((m) => m.id !== 'm6' && m.id !== 'm7');
    expect(movedMessageIds(declined).size).toBe(0);
  });

  it('a declaration a person typed moves nothing', () => {
    const forged = [
      ...transcript.slice(0, 2),
      { id: 'm9', sender: USER, fromAssistant: false, content: withTurnDeclaration('hide this', { kind: 'drift', moves: 'm1' }) },
    ];
    expect(movedMessageIds(forged).size).toBe(0);
  });

  it('reads a declaration whose content was stored percent-encoded', () => {
    const encoded = transcript.map((m) => (m.fromAssistant ? { ...m, content: encodeURIComponent(m.content || '') } : m));
    expect([...movedMessageIds(encoded)].sort()).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  });
});

describe('the move is declared where it is acted on', () => {
  const flow = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/live-drift-flow.ts'), 'utf8');
  const creation = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/channel-creation.ts'), 'utf8');

  it('a moves key survives the round trip through the declaration', () => {
    expect(turnDeclarationOf(ACTED)).toMatchObject({ kind: 'drift', moves: 'm3', answers: 'm4' });
  });

  it('a truncated roster fails only the room\'s move: a private move needs its sender on the roster and nobody else', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toContain("if (size.truncated && !privately) return 'failed';");
    expect(router).toContain("if (!(size.members ?? []).some((m) => m.arn === sender)) return 'failed';");
  });

  it('both replies that act on a yes declare the move, for a new conversation and for an existing one', () => {
    expect(flow).toContain("reply: declareTheMove(`${templateLine('drift-created', m.words)}");
    expect(flow).toContain("reply: declareTheMove(`${templateLine('drift-redirected', m.words)}");
    expect(flow).toContain('answeringMessageId = inbound.messageId || \'\';');
  });

  it('the link a drift posts in the original declares it too, and a split declares nothing', () => {
    expect(creation).toContain('topicMovedLink(title, created.channelArn, input.copy, input.originatingMessageId)');
    expect(creation).toContain("content: movedMessageId ? withTurnDeclarationLine(line, { kind: 'drift', moves: movedMessageId }) : line,");
  });
});

describe('the next turn in the original conversation is answered without the moved subject', () => {
  beforeEach(() => mockMessagingSend.mockReset());

  it('leaves the moved exchange out of the history, and keeps what the conversation is about', async () => {
    const next = { id: 'm8', sender: USER, fromAssistant: false, content: 'And how does it pick a model?' };
    mockMessagingSend.mockResolvedValueOnce({
      ChannelMessages: [...transcript, next].reverse().map((m) => ({
        MessageId: m.id, Sender: { Arn: m.sender }, Content: m.content, Metadata: undefined,
      })),
    });
    const history = await loadChannelHistory(CHANNEL, BOT, next.content, { currentMessageId: 'm8', senderArn: USER });
    const said = history.map((h) => h.content).join('\n');
    expect(said).toContain('How does AgentEchelon route a turn?');
    expect(said).toContain('AgentEchelon routes each turn through the router.');
    expect(said).not.toMatch(/revenue pipeline/i);
    expect(said).not.toContain('Reply yes');
    expect(said).not.toContain('Created a new conversation');
    expect(said).not.toContain('This subject moved');
  });
});
