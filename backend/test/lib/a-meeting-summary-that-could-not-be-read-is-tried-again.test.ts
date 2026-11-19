/**
 * A MEETING'S SUMMARY THAT COULD NOT BE READ OR WRITTEN IS TRIED AGAIN, never answered as no transcript or no summary.
 *
 * What it proves:
 *  - at the summary's firing, a run or summary entry that answers a transient code throws, so the schedule's asynchronous
 *    invoke is retried, and nothing is archived on it;
 *  - a rewrite of the ended card that fails throws before the summary turn is dispatched or the conversation archived;
 *  - a summary's hand-back whose conversation's tags cannot be read throws rather than refusing it as another
 *    classification's, and one whose summary could not be stored throws while the meeting is still the last;
 *  - the meeting's ended card is posted, recorded and its summary scheduled, or the lifecycle event throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LambdaClient } from '@aws-sdk/client-lambda';

const mockTags = jest.fn();
jest.mock('../../lambda/src/lib/channel-classification', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-classification'),
  readChannelTags: (...a: unknown[]) => mockTags(...a),
}));
const mockContext = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  getChannelContext: (...a: unknown[]) => mockContext(...a),
  readChannelContext: (...a: unknown[]) => mockContext(...a),
}));
const mockTranscribe = jest.fn();
const mockSummary = jest.fn();
const mockRuns = jest.fn();
jest.mock('../../lambda/src/lib/meeting-run', () => ({
  ...jest.requireActual('../../lambda/src/lib/meeting-run'),
  transcribeEndedMeeting: (...a: unknown[]) => mockTranscribe(...a),
  summarizeConversationMeeting: (...a: unknown[]) => mockSummary(...a),
  meetingRunsNow: (...a: unknown[]) => mockRuns(...a),
}));

process.env.CLASSIFICATION = 'premium';
process.env.MEETING_RUN_FUNCTION = 'AgentEchelonMeetings-MeetingRun';
process.env.MEETING_SUMMARY_FUNCTION = 'AgentEchelonMeetings-MeetingSummary';
process.env.CONVERSATION_MANAGEMENT_FUNCTION = 'AgentEchelon-ConversationManagement';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_LAMBDA_FUNCTION_NAME = 'router';

import { handleMeetingSummaryFired, handleMeetingSummaryWritten, isTransientEntryCode } from '../../lambda/src/router-agent-handler';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/conv-meeting-1`;
const M = 'a1b2c3d4-0000-1111-2222-333344445555';
const LAST = {
  meetingId: M, createdAt: '2026-11-14T10:00:00Z', endedAt: '2026-11-14T10:30:00Z', createdBy: 'p1',
  transcription: { everOn: true }, endedCardMessageId: 'msg-1', endedCardBy: `${APP}/bot/advisor`,
};

const invoke = jest.spyOn(LambdaClient.prototype, 'send') as unknown as jest.Mock;

beforeEach(() => {
  mockTags.mockReset().mockResolvedValue({ classification: 'premium' });
  mockContext.mockReset().mockResolvedValue({ lastMeeting: LAST });
  mockTranscribe.mockReset();
  mockSummary.mockReset().mockResolvedValue({ ok: true, ended: true, people: 2, connectedMinutes: 40, drops: 0, durationMinutes: 30 });
  mockRuns.mockReset().mockResolvedValue(false);
  invoke.mockReset().mockResolvedValue({});
});

describe('the summary\'s firing', () => {
  it('a transient code is no answer, for each entry', () => {
    for (const code of ['ENTRY_FAILED', 'UNAVAILABLE', 'INTERNAL', 'CLASSIFICATION_UNREADABLE']) expect(isTransientEntryCode(code)).toBe(true);
    for (const code of ['NOT_THIS_MEETING', 'STILL_RUNNING', 'OTHER_CLASSIFICATION', 'INCOMPLETE', undefined]) expect(isTransientEntryCode(code)).toBe(false);
  });

  it('a transcript the run entry could not write throws, and nothing is archived', async () => {
    mockTranscribe.mockResolvedValue({ ok: false, code: 'UNAVAILABLE' });
    await expect(handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).rejects.toThrow(/UNAVAILABLE/);
    mockTranscribe.mockResolvedValue({ ok: false, code: 'ENTRY_FAILED' });
    await expect(handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).rejects.toThrow(/ENTRY_FAILED/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('figures the summary entry could not read throw, and nothing is archived', async () => {
    mockTranscribe.mockResolvedValue({ ok: true, key: `transcripts/premium/conv-meeting-1/${M}/t.md` });
    mockSummary.mockResolvedValue({ ok: false, code: 'INTERNAL' });
    await expect(handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).rejects.toThrow(/INTERNAL/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a rewrite of the card that fails throws before the summary turn or the archive', async () => {
    mockTranscribe.mockResolvedValue({ ok: true, key: `transcripts/premium/conv-meeting-1/${M}/t.md` });
    mockContext.mockResolvedValueOnce({ lastMeeting: LAST }).mockRejectedValueOnce(Object.assign(new Error('rate'), { name: 'ChannelContextUnreadable' }));
    await expect(handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).rejects.toThrow('rate');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a meeting conversation that is gone is an answer: the summary ends, and nothing is retried or run', async () => {
    for (const name of ['ForbiddenException', 'NotFoundException']) {
      mockTags.mockReset().mockRejectedValue(Object.assign(new Error('gone'), { name }));
      mockTranscribe.mockReset();
      expect(await handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M }))
        .toEqual({ ran: false, reason: 'the meeting conversation is gone' });
      expect(mockTranscribe).not.toHaveBeenCalled();
    }
  });

  it('a tag read that is throttled is no answer: it throws, so the schedule retries', async () => {
    mockTags.mockReset().mockRejectedValue(Object.assign(new Error('rate'), { name: 'ThrottlingException' }));
    await expect(handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).rejects.toThrow('rate');
  });

  it('a meeting the entry says is not this one is an answer: archived, never retried', async () => {
    mockTranscribe.mockResolvedValue({ ok: false, code: 'NOT_THIS_MEETING' });
    mockSummary.mockResolvedValue({ ok: false, code: 'NOT_THIS_MEETING' });
    expect(await handleMeetingSummaryFired({ kind: 'meeting', channelArn: CHANNEL, meetingId: M })).toMatchObject({ ran: false });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('the summary\'s hand-back', () => {
  const written = { meetingArn: CHANNEL, meetingId: M, botArn: `${APP}/bot/advisor`, content: { summary: 'We shipped.' }, turn: { model: 'm', totalMs: 5 } };

  it('a conversation whose tags cannot be read throws, never refused as another classification\'s', async () => {
    mockTags.mockRejectedValue(Object.assign(new Error('rate'), { name: 'ThrottlingException' }));
    await expect(handleMeetingSummaryWritten(written)).rejects.toThrow('rate');
  });

  it('a summary that could not be stored throws while the meeting is still the last and holds none', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function handleMeetingSummaryWritten('), src.indexOf('async function summaryCardValues('));
    expect(fn).toContain("if (now?.meetingId === w.meetingId && !now.summary) throw new Error('the meeting summary could not be stored');");
    expect(fn).not.toMatch(/servedWelcomeVersion\([^)]*\)\.catch/);
  });
});

describe('the ended card', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function handleMeetingLifecycle('), src.indexOf('async function endedCardRecorded('));

  it('is posted, recorded and its summary scheduled, or the event throws and is delivered again', () => {
    expect(fn).toContain("if (!sent?.MessageId) throw new Error('the ended card was not posted');");
    expect(fn).toContain("if (await scheduleMeetingSummary(h.channelArn, h.meetingId) === 'failed') throw");
    expect(fn).not.toMatch(/catch \(err\) \{\s*console\.warn\('\[Router\]\[meeting\] the meeting card could not be posted'/);
    const recorded = src.slice(src.indexOf('async function endedCardRecorded('), src.indexOf('async function scheduleMeetingWatch('));
    expect(recorded).toContain("throw new Error('the ended card could not be recorded');");
  });

  it('is said in the shipped wording where the team\'s renders nothing, so a card is always there to hang the summary on', () => {
    const say = src.slice(src.indexOf('async function sayMeetingCard<T>('), src.indexOf('async function ringTheRoom('));
    expect(say).toContain('if (!rendered.ok || !rendered.sections.chat) rendered = await render(true);');
  });
});
