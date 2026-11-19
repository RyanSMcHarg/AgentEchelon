/**
 * A MEETING'S TRANSCRIPT AND ITS SUMMARY ARE THE MEETING'S SPEECH ONLY, AND ITS CHAT HISTORY NEVER CARRIES A TARGETED
 * MESSAGE INTO WHAT THE PLATFORM PRODUCES (SPEC-ASSISTANT-MEETINGS FR28).
 *
 *  - the transcript route keeps speech segments alone: an item carrying anything else (a chat message's id, a message's
 *    target, its content) is not kept (`readReportedSegments`, `SEGMENT_FIELDS`);
 *  - the transcript writer and the summary prompt take segments, never messages: their inputs are the meeting's
 *    conversation and its segments, and a stored segment is read back as speech fields alone (`readStoredSegment`);
 *  - where the meeting conversation's chat history is read for an assistant turn in it or a join recap, a targeted
 *    message between two other members is absent (`loadChannelHistory`, `privateReaderOf`).
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
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), ListObjectsV2Command: jest.fn() }), { virtual: true });
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

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadChannelHistory } from '../../lambda/src/lib/async-processor-core';
import { DEFAULT_JOIN_RECAP_REQUEST } from '../../lambda/src/lib/join-recap';
import { composeTranscript, readReportedSegments, readStoredSegment, SEGMENT_FIELDS, type TranscriptSegment } from '../../lambda/src/lib/meeting-transcript';
import type { writeTranscript } from '../../lambda/src/lib/meeting-transcription';
import type { meetingSummaryPrompt } from '../../lambda/src/lib/meeting-summary-turn';

const APP = 'arn:aws:chime:us-east-1:111:app-instance/i';
const BOT = `${APP}/bot/default`;
const ALICE = `${APP}/user/alice`;
const BOB = `${APP}/user/bob`;
const CAROL = `${APP}/user/carol`;
const DAVE = `${APP}/user/dave`;
/** A meeting's own conversation (its type is `meeting`). */
const MEETING_CHAT = `${APP}/channel/meeting-conv-1`;

type Msg = { MessageId: string; Sender: { Arn: string }; Content: string; Target?: Array<{ MemberArn: string }> };
function chat(...messages: Msg[]): void {
  mockMessagingSend.mockResolvedValueOnce({ ChannelMessages: [...messages].reverse() });
}
const SECRET = 'the private number is otter-falcon-42';
const aliceToBob: Msg = { MessageId: 't1', Sender: { Arn: ALICE }, Content: SECRET, Target: [{ MemberArn: BOB }] };
const roomLine: Msg = { MessageId: 'r1', Sender: { Arn: CAROL }, Content: 'Slides are in the channel' };

beforeEach(() => mockMessagingSend.mockReset());

describe("the meeting conversation's chat history never carries a targeted message into what the platform produces", () => {
  it("an assistant turn in the meeting's chat, answering a third member, is not given a targeted message between two others", async () => {
    const own: Msg = { MessageId: 'q1', Sender: { Arn: CAROL }, Content: 'what did we decide?' };
    chat(roomLine, aliceToBob, own);
    const history = await loadChannelHistory(MEETING_CHAT, BOT, own.Content, { currentMessageId: 'q1', senderArn: CAROL });
    expect(JSON.stringify(history)).not.toContain('otter-falcon');
    expect(history.map((m) => m.content)).toEqual([roomLine.Content]);
  });

  it('a join recap built for a newcomer to the meeting is not given it either', async () => {
    chat(roomLine, aliceToBob);
    const history = await loadChannelHistory(MEETING_CHAT, BOT, DEFAULT_JOIN_RECAP_REQUEST, { senderArn: DAVE });
    expect(JSON.stringify(history)).not.toContain('otter-falcon');
  });

  it("the archive's conversation summary selects untargeted messages only", () => {
    const updater = readFileSync(join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'summary-updater.ts'), 'utf8');
    expect(updater).toMatch(/AND target_arn IS NULL/);
  });
});

describe("a meeting's transcript and its summary are its speech only", () => {
  const reporter = { attendeeId: 'a-1', personId: 'alice' };
  const speech = { resultId: 'r1', attendeeId: 'a-1', text: 'we ship friday', startMs: 1_000, endMs: 2_000 };

  it('DENY: the transcript route keeps a speech segment, and no item that carries a message id, a target or message content', () => {
    for (const extra of [{ MessageId: 'm-1' }, { messageId: 'm-1' }, { Target: [{ MemberArn: BOB }] }, { target: BOB }, { Content: SECRET }, { Metadata: '{}' }]) {
      const read = readReportedSegments([{ ...speech, ...extra }], reporter);
      expect(read).toEqual({ segments: [], skipped: 1 });
    }
    expect(readReportedSegments([speech], reporter)).toEqual({ segments: [expect.objectContaining({ text: 'we ship friday' })], skipped: 0 });
    expect([...SEGMENT_FIELDS].sort()).toEqual(['attendeeId', 'endMs', 'resultId', 'startMs', 'text']);
  });

  it('a stored segment is read back as its speech fields alone, so the transcript and the summary hold nothing else', () => {
    const stored = readStoredSegment({ resultId: 'r1', personId: 'alice', startMs: 1, endMs: 2, text: 'hello', Target: [{ MemberArn: BOB }], messageId: 'm-1' });
    expect(Object.keys(stored!).sort()).toEqual(['endMs', 'personId', 'resultId', 'startMs', 'text']);
    expect(composeTranscript([stored!], (id) => id)).toBe('[0:00] **alice**: hello\n');
  });

  it('the transcript writer and the summary prompt take segments and the meeting, never a message', () => {
    // Type-level: what each is given. A message parameter would fail to compile here.
    type WriterInput = Parameters<typeof writeTranscript>;
    type PromptSegments = Parameters<typeof meetingSummaryPrompt>[1];
    const writer: WriterInput = ['arn', { classification: 'c', conversationId: 'id', meetingId: 'm' }];
    const segments: PromptSegments = [] as TranscriptSegment[];
    expect(writer).toHaveLength(2);
    expect(segments).toEqual([]);
    // And the modules that build them read no channel message.
    for (const file of ['meeting-transcription.ts', 'meeting-transcript.ts', 'meeting-summary-turn.ts']) {
      const source = readFileSync(join(__dirname, '..', '..', 'lambda', 'src', 'lib', file), 'utf8');
      expect(source).not.toMatch(/ListChannelMessages|GetChannelMessage|loadChannelHistory/);
    }
  });
});
