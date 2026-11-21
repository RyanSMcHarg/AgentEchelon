/**
 * A MEETING'S TRANSCRIPT, ITS ENDED CARD AND ITS ARCHIVE (SPEC-ASSISTANT-MEETINGS FR27, FR28).
 *
 *  - transcription starts with the meeting where the deployment transcribes its meetings, and not otherwise;
 *  - only a host turns it on or off, and each change is recorded on the meeting's conversation;
 *  - a person's app files only that person's own lines, each attributed to their AppInstanceUser id, under the meeting
 *    conversation's transcript key family with its classification in the key;
 *  - the transcript is written from them once the meeting has ended, and only for a meeting that was transcribed;
 *  - the ended card reads well and carries the meeting conversation's link and the transcript's link, or no transcript
 *    link where there is none;
 *  - the ended meeting's conversation is archived through the one archive sequence;
 *  - a member reads the transcript through the download path, and a non-member or another classification is refused;
 *  - a room's assistant reads the transcript of a `thread` child it may read as grounding.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockMeetingsSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-meetings', () => ({
  ChimeSDKMeetingsClient: jest.fn(() => ({ send: mockMeetingsSend })),
  CreateMeetingCommand: jest.fn((input) => ({ __type: 'CreateMeeting', input })),
  CreateAttendeeCommand: jest.fn((input) => ({ __type: 'CreateAttendee', input })),
  DeleteMeetingCommand: jest.fn((input) => ({ __type: 'DeleteMeeting', input })),
  GetMeetingCommand: jest.fn((input) => ({ __type: 'GetMeeting', input })),
  GetAttendeeCommand: jest.fn((input) => ({ __type: 'GetAttendee', input })),
  StartMeetingTranscriptionCommand: jest.fn((input) => ({ __type: 'StartMeetingTranscription', input })),
  StopMeetingTranscriptionCommand: jest.fn((input) => ({ __type: 'StopMeetingTranscription', input })),
}));
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ __type: 'PutObject', input })),
  ListObjectsV2Command: jest.fn((input) => ({ __type: 'ListObjectsV2', input })),
  GetObjectCommand: jest.fn((input) => ({ __type: 'GetObject', input })),
}));
const mockIdentitySend = jest.fn();
const mockBusSend = jest.fn();
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(() => ({ send: mockBusSend })),
  PutEventsCommand: jest.fn((input) => ({ __type: 'PutEvents', input })),
}));
jest.mock('../../lambda/src/lib/chime/clients', () => ({
  ...jest.requireActual('../../lambda/src/lib/chime/clients'),
  chimeIdentityClient: () => ({ send: mockIdentitySend }),
}));

jest.mock('../../lambda/src/lib/meeting-event-archive', () => ({ fileMeetingEvents: async () => ({ archived: 1, projected: null, duplicates: 0 }) }));
jest.mock('../../lambda/src/lib/event-archive', () => ({ ensureDataPlaneArn: async () => undefined }));
const mockReach = jest.fn();
jest.mock('../../lambda/src/lib/conversation-access', () => ({
  ...jest.requireActual('../../lambda/src/lib/conversation-access'),
  callerReachesConversation: (...a: unknown[]) => mockReach(...a),
}));
const mockPersonId = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ callerPersonId: (...a: unknown[]) => mockPersonId(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../../lambda/src/lib/channel-classification', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-classification'),
  readChannelClassificationTag: async () => 'premium',
}));

const mockSyncCapture = jest.fn();
const mockStopCapture = jest.fn(async () => ({ stopped: 0, stillCapturing: 0 }));
jest.mock('../../lambda/src/lib/meeting-media-capture', () => ({
  ...jest.requireActual('../../lambda/src/lib/meeting-media-capture'),
  syncMediaCapture: (...a: unknown[]) => mockSyncCapture(...a),
  stopMediaCapture: (...a: unknown[]) => (mockStopCapture as jest.Mock)(...a),
}));

const mockGetContext = jest.fn();
const mockFact = jest.fn();
const mockCharge = jest.fn();
const mockRelease = jest.fn(async (..._a: unknown[]) => 'released');
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  // The meeting's record carries its creation and the attendees it created, as the claim and the join write them.
  readChannelContext: async (...a: unknown[]) => {
    const row = { conversationType: 'meeting', ...((await mockGetContext(...a)) ?? {}) } as { lastMeeting?: Record<string, unknown> };
    if (row.lastMeeting) row.lastMeeting = { createdAt: '2026-11-12T10:00:00.000Z', attendeeKeys: ['host-1 a-1', 'guest-1 a-guest'], ...row.lastMeeting };
    return row;
  },
  meetingRecordedAttendee: jest.requireActual('../../lambda/src/lib/channel-context-client').meetingRecordedAttendee,
  recordMeetingAttendee: async () => true,
  chargeTranscriptChars: (...a: unknown[]) => mockCharge(...a),
  MEETING_OPENING_HOLD_MS: 60_000,
  confirmMeetingConversation: async () => true,
  releaseMeetingConversation: async () => true,
  claimMeetingConversation: async () => 'claimed',
  settleMeetingConversation: async () => undefined,
  claimActiveMeeting: async () => 'claimed',
  releaseActiveMeeting: (...a: unknown[]) => mockRelease(...a),
  recordMeetingFact: (...a: unknown[]) => mockFact(...a),
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP_INSTANCE;
// The run entry under test is the premium classification's.
process.env.MEETING_RUN_CLASSIFICATION = 'premium';
process.env.ATTACHMENTS_BUCKET = 'conversation-store';
process.env.MEETING_LIFECYCLE_INSTANCE = 'test';

import { handler, runHandler } from '../../lambda/src/meeting-api';
import { __forgetAttendeeOwners } from '../../lambda/src/lib/meeting-host-controls';
import { MAX_TRANSCRIPT_SEGMENTS, SEGMENT_READ_CONCURRENCY } from '../../lambda/src/lib/meeting-transcription';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { composeTranscript, latestTranscriptOf, parseTranscriptKey, readReportedSegments, transcriptKey, transcriptLink } from '../../lambda/src/lib/meeting-transcript';
import { buildRelatedConversationsHint } from '../../lambda/src/analytics-aurora/document-retrieval';

const CHANNEL = `${APP_INSTANCE}/channel/c1`;
const HOST = 'host-1';
const GUEST = 'guest-1';
const MEETING = { MeetingId: 'm-1', MediaPlacement: {} };
const RUNNING = { meetingId: 'm-1', meeting: MEETING, classification: 'premium', createdAt: '2026-11-12T10:00:00.000Z', createdBy: HOST, hosts: [{ personId: HOST }] };
const sent = (type: string) => mockMeetingsSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === type);
const puts = () => mockS3Send.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'PutObject');

function event(path: string, body: Record<string, unknown> = {}): APIGatewayProxyEvent {
  return { httpMethod: 'POST', path, resource: path, headers: { origin: 'http://localhost:5173' }, body: JSON.stringify({ conversationId: 'c1', ...body }) } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  __forgetAttendeeOwners();
  delete process.env.MEETING_TRANSCRIPTION;
  delete process.env.MEETING_RECORDING;
  mockBusSend.mockResolvedValue({ FailedEntryCount: 0 });
  mockReach.mockResolvedValue({ ok: true, channelArn: CHANNEL, classification: 'premium' });
  mockPersonId.mockResolvedValue(HOST);
  mockGetContext.mockResolvedValue(null);
  mockFact.mockResolvedValue(true);
  // Each person's share, kept as the record's conditional add keeps it.
  const shares = new Map<string, number>();
  mockCharge.mockImplementation(async (_arn: string, _m: string, person: string, chars: number, budget: number) => {
    const held = shares.get(person) ?? 0;
    if (held + chars > budget) return 'over';
    shares.set(person, held + chars);
    return 'charged';
  });
  mockSyncCapture.mockResolvedValue('in-step');
  mockStopCapture.mockImplementation(async () => ({ stopped: 0, stillCapturing: 0 }));
  mockS3Send.mockResolvedValue({});
  mockMeetingsSend.mockImplementation(async (cmd: { __type: string; input: { AttendeeId?: string } }) => {
    if (cmd.__type === 'CreateMeeting') return { Meeting: MEETING };
    if (cmd.__type === 'CreateAttendee') return { Attendee: { AttendeeId: 'a-1', ExternalUserId: HOST, JoinToken: 't' } };
    if (cmd.__type === 'GetMeeting') return { Meeting: MEETING };
    if (cmd.__type === 'GetAttendee') return { Attendee: { AttendeeId: cmd.input.AttendeeId, ExternalUserId: cmd.input.AttendeeId === 'a-guest' ? GUEST : HOST } };
    return {};
  });
});

describe('transcription starts with the meeting only where the deployment transcribes its meetings', () => {
  it('starts it, with the live transcription settings, in recording mode (the default), when meetingTranscription is on', async () => {
    process.env.MEETING_TRANSCRIPTION = 'true';
    expect((await handler(event('/meetings'))).statusCode).toBe(201);
    expect(sent('StartMeetingTranscription')).toHaveLength(1);
    expect(sent('StartMeetingTranscription')[0].input).toEqual({
      MeetingId: 'm-1',
      TranscriptionConfiguration: { EngineTranscribeSettings: { LanguageCode: 'en-US', EnablePartialResultsStabilization: true, PartialResultsStability: 'high' } },
    });
    expect(mockFact).toHaveBeenCalledWith(CHANNEL, 'm-1', { transcription: expect.objectContaining({ on: true, recording: true, changedBy: 'platform', everOn: true, everRecorded: true }) }, expect.anything());
  });

  it('starts it with captions alone where meetingRecording is false', async () => {
    process.env.MEETING_TRANSCRIPTION = 'true';
    process.env.MEETING_RECORDING = 'false';
    expect((await handler(event('/meetings'))).statusCode).toBe(201);
    expect(sent('StartMeetingTranscription')).toHaveLength(1);
    const fact = mockFact.mock.calls.find((c) => c[2].transcription)![2].transcription;
    expect(fact).toEqual(expect.objectContaining({ on: true, recording: false }));
    expect(fact.everRecorded).toBeUndefined();
  });

  it('does not start it when meetingTranscription is off', async () => {
    expect((await handler(event('/meetings'))).statusCode).toBe(201);
    expect(sent('StartMeetingTranscription')).toHaveLength(0);
    expect(mockFact).not.toHaveBeenCalledWith(CHANNEL, 'm-1', expect.objectContaining({ transcription: expect.anything() }));
  });
});

describe('only a host turns transcription on or off', () => {
  it('lets a host stop it, and records the stop by who stopped it', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: false, everOn: true } } });
    const res = await handler(event('/meetings/transcription', { on: false }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).transcribing).toBe(false);
    expect(sent('StopMeetingTranscription')[0].input).toEqual({ MeetingId: 'm-1' });
    expect(mockFact).toHaveBeenCalledWith(CHANNEL, 'm-1', { transcription: expect.objectContaining({ on: false, changedBy: HOST, everOn: true }) }, expect.anything());
  });

  it('refuses to stop captions while the meeting is recorded, and the service is never asked', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true } } });
    const res = await handler(event('/meetings/transcription', { on: false }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('RECORDING_ON');
    expect(sent('StopMeetingTranscription')).toHaveLength(0);
    expect(mockFact).not.toHaveBeenCalled();
  });

  it('turns recording on with captions, and off again leaving captions on, telling the meeting\'s router of a change the service does not raise', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: false, everOn: true } } });
    let res = await handler(event('/meetings/transcription', { recording: true }));
    expect(JSON.parse(res.body)).toEqual({ transcribing: true, recording: true });
    expect(sent('StartMeetingTranscription')).toHaveLength(0);
    expect(JSON.parse(mockBusSend.mock.calls[0][0].input.Entries[0].Detail)).toEqual(expect.objectContaining({ event: 'recording-started', meetingId: 'm-1', classification: 'premium', instance: 'test' }));
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true, everRecorded: true } } });
    res = await handler(event('/meetings/transcription', { recording: false }));
    expect(JSON.parse(res.body)).toEqual({ transcribing: true, recording: false });
    expect(mockFact).toHaveBeenLastCalledWith(CHANNEL, 'm-1', { transcription: expect.objectContaining({ on: true, recording: false, everRecorded: true }) }, expect.anything());
    expect(JSON.parse(mockBusSend.mock.calls[1][0].input.Entries[0].Detail).event).toBe('recording-stopped');
  });

  it('refuses anyone else, and the service is never asked', async () => {
    mockPersonId.mockResolvedValue(GUEST);
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1' } });
    const res = await handler(event('/meetings/transcription', { on: true }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('TRANSCRIPTION_HOST_ONLY');
    expect(sent('StartMeetingTranscription')).toHaveLength(0);
    expect((await handler(event('/meetings/transcription', { recording: true }))).statusCode).toBe(403);
  });

  it('tells a person who joins, starts or reads it whether it is recorded now, so every app says so', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true } } });
    for (const path of ['/meetings/join', '/meetings', '/meetings/status']) {
      expect(JSON.parse((await handler(event(path))).body)).toMatchObject({ transcribing: true, recording: true });
    }
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true } } });
    for (const path of ['/meetings/join', '/meetings', '/meetings/status']) {
      expect(JSON.parse((await handler(event(path))).body)).toMatchObject({ transcribing: true, recording: false });
    }
  });

  it('a change the record could not keep changes nothing with the service, and the host is told to try again', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: false, changedAt: 'c0', changedBy: HOST } } });
    mockFact.mockResolvedValue(false);
    const res = await handler(event('/meetings/transcription', { on: true }));
    expect(res.statusCode).toBe(502);
    expect(sent('StartMeetingTranscription')).toHaveLength(0);
    expect(sent('StopMeetingTranscription')).toHaveLength(0);
  });

  // ONE CHANGE AT A TIME: a change is written only over the state it was decided from, so two hosts' changes decided from
  // one read never both land, and the second never clears what the first recorded.
  it('DENY: a change decided from a state another host has changed since is refused, and the service is never asked', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: false, changedAt: 'c1', changedBy: HOST, everOn: true } } });
    await handler(event('/meetings/transcription', { recording: true }));
    // Written only over the state read (its changedAt), and carrying when the recording began.
    expect(mockFact).toHaveBeenLastCalledWith(CHANNEL, 'm-1', { transcription: expect.objectContaining({ recording: true, everRecorded: true, recordedFrom: expect.any(String) }) }, { ifChangedAt: 'c1' });
    // The record moved on (another host's change landed first): this one is refused, and nothing else is done.
    mockFact.mockClear();
    mockSyncCapture.mockClear();
    mockFact.mockResolvedValueOnce(false);
    const res = await handler(event('/meetings/transcription', { on: false }));
    expect(res.statusCode).toBe(502);
    expect(mockFact).toHaveBeenCalledTimes(1);
    expect(sent('StopMeetingTranscription')).toHaveLength(0);
    expect(mockSyncCapture).not.toHaveBeenCalled();
  });

  it('a service that refuses the change puts the record back as it was', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: false, changedAt: 'c0', changedBy: HOST } } });
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetMeeting') return { Meeting: MEETING };
      if (cmd.__type === 'StartMeetingTranscription') throw Object.assign(new Error('no'), { name: 'BadRequestException' });
      return {};
    });
    expect((await handler(event('/meetings/transcription', { on: true }))).statusCode).toBe(502);
    expect(mockFact).toHaveBeenLastCalledWith(CHANNEL, 'm-1', { transcription: expect.objectContaining({ on: false }) }, { ifChangedAt: expect.any(String) });
  });

  it('a capture that could not be stopped keeps the meeting recorded: the record says so again, nobody is told it stopped, and the host may try again', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true, everOn: true, everRecorded: true } } });
    mockSyncCapture.mockResolvedValue('still-capturing');
    const res = await handler(event('/meetings/transcription', { recording: false }));
    expect(res.statusCode).toBe(502);
    expect(mockFact).toHaveBeenLastCalledWith(CHANNEL, 'm-1', { transcription: expect.objectContaining({ on: true, recording: true }) }, expect.anything());
    expect(mockBusSend).not.toHaveBeenCalled();
  });

  it('records when recording was turned off, so the lines heard before it are still kept', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true, everRecorded: true } } });
    await handler(event('/meetings/transcription', { recording: false }));
    expect(mockFact).toHaveBeenLastCalledWith(CHANNEL, 'm-1', { transcription: expect.objectContaining({ recording: false, recordedUntil: expect.any(String) }) }, expect.anything());
  });

  it('tells a person who joins whether it is transcribed now', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true } } });
    expect(JSON.parse((await handler(event('/meetings/join'))).body).transcribing).toBe(true);
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1' } });
    expect(JSON.parse((await handler(event('/meetings/join'))).body).transcribing).toBe(false);
  });
});

describe('a person\'s app files only that person\'s own lines', () => {
  const transcribed = { activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true, everOn: true, everRecorded: true } } };

  it('keeps the caller\'s lines, attributed to their person id, under the conversation\'s transcript family with its classification', async () => {
    mockGetContext.mockResolvedValue(transcribed);
    const res = await handler(event('/meetings/transcript', {
      attendeeId: 'a-1',
      segments: [
        { resultId: 'r1', attendeeId: 'a-1', text: 'we ship friday', startMs: 1794477660000, endMs: 1794477661000 },
        { resultId: 'r2', attendeeId: 'a-guest', text: 'words put in another mouth', startMs: 1794477662000, endMs: 1794477663000 },
      ],
    }));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ kept: 1, skipped: 1 });
    expect(puts()).toHaveLength(1);
    // Keyed by its speaker, and written only where no line is kept at that key yet.
    expect(puts()[0].input.Key).toBe(`transcripts/premium/c1/m-1/segments/1794477660000-${HOST}-r1.json`);
    expect(puts()[0].input.IfNoneMatch).toBe('*');
    expect(JSON.parse(puts()[0].input.Body)).toEqual(expect.objectContaining({ personId: HOST, text: 'we ship friday' }));
  });

  it("DENY: no report replaces another person's line: a result id another speaker reported is a key of theirs, never the caller's", async () => {
    mockGetContext.mockResolvedValue(transcribed);
    const line = { resultId: 'r1', text: 'my words', startMs: 1794477660000, endMs: 1794477661000 };
    await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [{ ...line, attendeeId: 'a-1' }] }));
    mockPersonId.mockResolvedValue(GUEST);
    await handler(event('/meetings/transcript', { attendeeId: 'a-guest', segments: [{ ...line, attendeeId: 'a-guest', text: 'words in her mouth' }] }));
    const [mine, theirs] = puts().map((p) => p.input.Key);
    expect(mine).toContain(`-${HOST}-r1.json`);
    expect(theirs).toContain(`-${GUEST}-r1.json`);
    expect(theirs).not.toBe(mine);
  });

  it('a line already kept is kept, never replaced, and a report sent again is answered as kept', async () => {
    mockGetContext.mockResolvedValue(transcribed);
    mockS3Send.mockRejectedValue(Object.assign(new Error('exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }));
    const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [{ resultId: 'r1', attendeeId: 'a-1', text: 'x', startMs: 1794477660000, endMs: 1794477661000 }] }));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).kept).toBe(1);
  });

  it("a service that cannot say whose attendee it is answers retryably, never as someone else's", async () => {
    mockGetContext.mockResolvedValue(transcribed);
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetMeeting') return { Meeting: MEETING };
      if (cmd.__type === 'GetAttendee') throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      return {};
    });
    const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [{ resultId: 'r1', attendeeId: 'a-1', text: 'x', startMs: 1794477660000, endMs: 1794477661000 }] }));
    expect(res.statusCode).toBe(503);
    expect(puts()).toHaveLength(0);
  });

  describe('the last lines, reported just after recording stopped', () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const line = (id: string, startMs: number) => ({ resultId: id, attendeeId: 'a-1', text: `line ${id}`, startMs, endMs: startMs + 500 });

    it('keeps the lines a recorded meeting heard before it ended, reported moments after, and none spoken after', async () => {
      const endedAt = at(5_000);
      mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', endedAt, transcription: { on: true, recording: true, everOn: true, everRecorded: true } } });
      const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', Date.parse(endedAt) - 2_000), line('r2', Date.parse(endedAt) + 1_000)] }));
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ kept: 1, skipped: 1 });
      expect(puts().map((p) => p.input.Key)).toEqual([expect.stringContaining('-r1.json')]);
    });

    it('keeps the lines heard before a host turned recording off, reported moments after', async () => {
      const recordedUntil = at(3_000);
      mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: false, everRecorded: true, recordedUntil } } });
      const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', Date.parse(recordedUntil) - 1_000), line('r2', Date.parse(recordedUntil) + 500)] }));
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ kept: 1, skipped: 1 });
    });

    it('keeps nothing once the moment has passed, or for a meeting that ended unrecorded', async () => {
      mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', endedAt: at(60_000), transcription: { on: true, recording: true, everRecorded: true } } });
      expect((await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', 1)] }))).statusCode).toBe(404);
      mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', endedAt: at(1_000), transcription: { on: true, recording: false, everOn: true } } });
      expect((await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', 1)] }))).statusCode).toBe(404);
      expect(puts()).toHaveLength(0);
    });

    it("DENY: after the end, a person who is not a member of the meeting's conversation keeps nothing", async () => {
      // The caller reaches the room, and is not a member of the meeting's own conversation.
      const MEET = `${APP_INSTANCE}/channel/meet-1`;
      mockGetContext.mockImplementation(async (arn: string) => (arn === MEET
        ? { conversationType: 'meeting', meetingOf: CHANNEL, lastMeeting: { meetingId: 'm-1', endedAt: at(2_000), transcription: { on: true, recording: true, everRecorded: true } } }
        : { conversationType: 'general', meetingConversation: { channelArn: MEET, at: 'x' } }));
      mockReach.mockImplementation(async (_e: unknown, conv: string) => (conv === MEET
        ? { ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false }
        : { ok: true, channelArn: CHANNEL, classification: 'premium' }));
      const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', 1)] }));
      expect(res.statusCode).toBe(403);
      expect(puts()).toHaveLength(0);
      // A member of it keeps their line.
      mockReach.mockResolvedValue({ ok: true, channelArn: CHANNEL, classification: 'premium' });
      expect((await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', 1)] }))).statusCode).toBe(202);
    });
  });

  describe('a line is kept only where it was spoken while the meeting was recorded, and no one person crowds out the rest', () => {
    const T = Date.parse(RUNNING.createdAt);
    const line = (id: string, startMs: number, text = `line ${id}`) => ({ resultId: id, attendeeId: 'a-1', text, startMs, endMs: startMs + 500 });

    it('DENY: a line timed outside the meeting (far in the future, or at the epoch) is not kept, and never orders the transcript', async () => {
      mockGetContext.mockResolvedValue(transcribed);
      const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', 9_999_999_999_999), line('r2', 0), line('r3', T + 60_000)] }));
      expect(JSON.parse(res.body)).toEqual({ kept: 1, skipped: 2 });
      expect(puts().map((p) => p.input.Key)).toEqual([expect.stringContaining('-r3.json')]);
    });

    it('DENY: a line spoken under captions alone, before recording began, is not kept even when it is reported once recording is on', async () => {
      const recordedFrom = new Date(T + 600_000).toISOString();
      mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true, everRecorded: true, recordedFrom } } });
      const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('before', T + 300_000), line('after', T + 601_000)] }));
      expect(JSON.parse(res.body)).toEqual({ kept: 1, skipped: 1 });
      expect(puts().map((p) => p.input.Key)).toEqual([expect.stringContaining('-after.json')]);
    });

    it("DENY: one person's reports stop at their share of the transcript, and another person's lines are still kept", async () => {
      // A MEETING STARTED AN HOUR AGO, whenever this runs: the share grows with the meeting's length, so a fixed start date
      // would let the share outgrow what this test sends once enough days pass.
      const started = Date.now() - 3_600_000;
      const at = new Date(started).toISOString();
      mockGetContext.mockResolvedValue({ activeMeeting: { ...RUNNING, createdAt: at }, lastMeeting: { ...transcribed.lastMeeting, createdAt: at } });
      const long = 'x'.repeat(2000);
      let refused: number | undefined;
      for (let i = 0; i < 400 && refused === undefined; i++) {
        const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: Array.from({ length: 25 }, (_v, j) => line(`f${i}-${j}`, started + 1000 * i + j, long)) }));
        if (res.statusCode !== 202) refused = res.statusCode;
      }
      expect(refused).toBe(429);
      const charged = mockCharge.mock.calls[0];
      // The share is the meeting's length so far at thirty characters a second, and one line more.
      expect(charged[4]).toBeGreaterThan(30 * ((Date.now() - started) / 1000));
      expect(charged[4]).toBeLessThan(30 * ((Date.now() - started) / 1000) + 2_000 + 30 * 20);
      mockPersonId.mockResolvedValue(GUEST);
      const theirs = await handler(event('/meetings/transcript', { attendeeId: 'a-guest', segments: [{ ...line('g1', started + 5_000), attendeeId: 'a-guest' }] }));
      expect(JSON.parse(theirs.body)).toEqual({ kept: 1, skipped: 0 });
    });

    it("DENY: after the end, a member's line is kept only from an attendee the meeting created for them", async () => {
      const endedAt = new Date(Date.now() - 2_000).toISOString();
      mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', endedAt, attendeeKeys: ['host-1 a-1'], transcription: { on: true, recording: true, everRecorded: true } } });
      const forged = await handler(event('/meetings/transcript', { attendeeId: 'a-made-up', segments: [{ ...line('r1', Date.parse(endedAt) - 1_000), attendeeId: 'a-made-up' }] }));
      expect(forged.statusCode).toBe(403);
      expect(JSON.parse(forged.body).code).toBe('NOT_YOUR_ATTENDEE');
      expect(puts()).toHaveLength(0);
      const own = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [line('r1', Date.parse(endedAt) - 1_000)] }));
      expect(JSON.parse(own.body)).toEqual({ kept: 1, skipped: 0 });
    });
  });

  it('refuses an attendee that is not the caller\'s', async () => {
    mockGetContext.mockResolvedValue(transcribed);
    const res = await handler(event('/meetings/transcript', { attendeeId: 'a-guest', segments: [{ resultId: 'r1', attendeeId: 'a-guest', text: 'x', startMs: 1794477660000, endMs: 1794477661000 }] }));
    expect(res.statusCode).toBe(403);
    expect(puts()).toHaveLength(0);
  });

  it('keeps nothing while the meeting shows captions alone (captions-only mode)', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: false, everOn: true } } });
    const res = await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [{ resultId: 'r1', attendeeId: 'a-1', text: 'x', startMs: 1794477660000, endMs: 1794477661000 }] }));
    expect(res.statusCode).toBe(409);
    expect(puts()).toHaveLength(0);
  });

  it('one result heard from two speakers is a line for each; one delivered twice to a speaker is one line', () => {
    const seg = (personId: string) => ({ resultId: 'r1', personId, startMs: 0, endMs: 1, text: `said by ${personId}` });
    expect(composeTranscript([seg(HOST), seg(GUEST), seg(HOST)], (id) => id)).toBe(`[0:00] **${GUEST}**: said by ${GUEST}\n\n[0:00] **${HOST}**: said by ${HOST}\n`);
  });

  it('reads a report strictly', () => {
    expect(readReportedSegments('nope', { attendeeId: 'a', personId: 'p' })).toEqual({ refused: 'INVALID_SEGMENTS' });
    expect(readReportedSegments(Array(26).fill({}), { attendeeId: 'a', personId: 'p' })).toEqual({ refused: 'INVALID_SEGMENTS' });
  });
});

describe('the transcript is written once the meeting has ended, where it was transcribed', () => {
  it('writes it from the segments, each line named as the room shows its speaker', async () => {
    mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', transcription: { on: false, everOn: true, everRecorded: true } } });
    mockS3Send.mockImplementation(async (cmd: { __type: string; input: { Key?: string } }) => {
      if (cmd.__type === 'ListObjectsV2') return { Contents: [{ Key: 'transcripts/premium/c1/m-1/segments/1-r1.json' }, { Key: 'transcripts/premium/c1/m-1/segments/2-r2.json' }] };
      if (cmd.__type === 'GetObject') {
        const r1 = cmd.input.Key?.endsWith('r1.json');
        return { Body: { transformToString: async () => JSON.stringify({ resultId: r1 ? 'r1' : 'r2', personId: r1 ? HOST : GUEST, startMs: r1 ? 1000 : 5000, endMs: 6000, text: r1 ? 'we ship friday' : 'agreed' }) } };
      }
      return {};
    });
    mockIdentitySend.mockImplementation(async (cmd: { input: { AppInstanceUserArn: string } }) => ({ AppInstanceUser: { Name: cmd.input.AppInstanceUserArn.endsWith(HOST) ? 'Hana Host' : 'Gus Guest' } }));
    const out = await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' });
    expect(out).toEqual({ ok: true, key: 'transcripts/premium/c1/m-1.md' });
    // The tag is read against this deployment's classifications, loaded first.
    expect(loadProfileRegistry).toHaveBeenCalled();
    const written = puts().find((p) => p.input.Key === 'transcripts/premium/c1/m-1.md');
    expect(written.input.Body).toBe('[0:00] **Hana Host**: we ship friday\n\n[0:04] **Gus Guest**: agreed\n');
  });

  it('writes nothing for a meeting never recorded (captions alone included), or one still running', async () => {
    mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1' } });
    expect(await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: true });
    mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', transcription: { on: false, everOn: true } } });
    expect(await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: true });
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, everOn: true } } });
    expect(await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'STILL_RUNNING' });
    expect(puts()).toHaveLength(0);
  });

  it('records why a host ended it, for the ended card, and when it ended in the same write that releases it', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1' } });
    expect((await handler(event('/meetings/end'))).statusCode).toBe(200);
    expect(mockFact).toHaveBeenCalledWith(CHANNEL, 'm-1', { endReason: 'host' });
    expect(mockRelease).toHaveBeenCalledWith(CHANNEL, 'm-1', expect.stringMatching(/^\d{4}-/));
    expect(mockFact).not.toHaveBeenCalledWith(CHANNEL, 'm-1', { endedAt: expect.any(String) });
  });
});

describe('a meeting that did not end is left as it ran', () => {
  it('DENY: a delete the service refuses stops no capture and puts back the reason its ended card would say', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true, everRecorded: true } } });
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetMeeting') return { Meeting: MEETING };
      if (cmd.__type === 'DeleteMeeting') throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      return {};
    });
    const res = await handler(event('/meetings/end'));
    expect(res.statusCode).toBe(502);
    expect(mockStopCapture).not.toHaveBeenCalled();
    expect(mockFact).toHaveBeenNthCalledWith(1, CHANNEL, 'm-1', { endReason: 'host' });
    expect(mockFact).toHaveBeenLastCalledWith(CHANNEL, 'm-1', { endReason: null });
  });

  it('stops the capture once the service has deleted the meeting', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1' } });
    const order: string[] = [];
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => { order.push(cmd.__type); return cmd.__type === 'GetMeeting' ? { Meeting: MEETING } : {}; });
    mockStopCapture.mockImplementation(async () => { order.push('stopCapture'); return { stopped: 1, stillCapturing: 0 }; });
    expect((await handler(event('/meetings/end'))).statusCode).toBe(200);
    expect(order.filter((x) => x === 'DeleteMeeting' || x === 'stopCapture')).toEqual(['DeleteMeeting', 'stopCapture']);
  });
});

describe("a room check that cannot be answered is an outage, never 'not in the room'", () => {
  it('answers 503 to a status read from a meeting\'s own conversation whose room cannot be checked', async () => {
    const MEET = `${APP_INSTANCE}/channel/meet-1`;
    mockGetContext.mockImplementation(async (arn: string) => (arn === MEET
      ? { conversationType: 'meeting', meetingOf: CHANNEL, lastMeeting: { meetingId: 'm-0', endedAt: '2026-11-12T11:00:00.000Z' } }
      : { conversationType: 'general', meetingConversation: { channelArn: MEET, at: '2026-11-12T10:00:00.000Z' } }));
    mockReach.mockImplementation(async (_e: unknown, conv: string) => (conv === CHANNEL
      ? { ok: false, status: 503, code: 'UNAVAILABLE', memberProven: false }
      : { ok: true, channelArn: MEET, classification: 'premium' }));
    const res = await handler(event('/meetings/status', { conversationId: 'meet-1' }));
    expect(res.statusCode).toBe(503);
  });
});

describe('a recorded meeting asks the service whose an attendee is once, not once per report', () => {
  it('reads the attendee once across reports, and still refuses another person\'s', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RUNNING, lastMeeting: { meetingId: 'm-1', transcription: { on: true, recording: true, everRecorded: true } } });
    const seg = (id: string) => ({ resultId: id, attendeeId: 'a-1', text: id, startMs: Date.parse(RUNNING.createdAt) + 1_000, endMs: Date.parse(RUNNING.createdAt) + 2_000 });
    await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [seg('r1')] }));
    await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [seg('r2')] }));
    expect(sent('GetAttendee')).toHaveLength(1);
    mockPersonId.mockResolvedValue(GUEST);
    expect((await handler(event('/meetings/transcript', { attendeeId: 'a-1', segments: [seg('r3')] }))).statusCode).toBe(403);
  });
});

describe('the transcript is written in bounded time', () => {
  const stored = (key: string) => {
    const m = /segments\/(\d+)-(.+)-(r\d+)\.json$/.exec(key)!;
    return JSON.stringify({ resultId: m[3], personId: m[2], startMs: Number(m[1]), endMs: Number(m[1]) + 1, text: `said ${m[3]}` });
  };
  it('a segment that cannot be read is left out, and the rest are written', async () => {
    mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', transcription: { on: false, everRecorded: true } } });
    const keys = [1, 2, 3].map((i) => `transcripts/premium/c1/m-1/segments/${String(i * 1000).padStart(13, '0')}-${HOST}-r${i}.json`);
    mockS3Send.mockImplementation(async (cmd: { __type: string; input: { Key?: string } }) => {
      if (cmd.__type === 'ListObjectsV2') return { Contents: keys.map((Key) => ({ Key })) };
      if (cmd.__type === 'GetObject') {
        if (cmd.input.Key === keys[1]) throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
        return { Body: { transformToString: async () => stored(cmd.input.Key!) } };
      }
      return {};
    });
    mockIdentitySend.mockResolvedValue({ AppInstanceUser: { Name: 'Hana Host' } });
    expect(await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: true, key: 'transcripts/premium/c1/m-1.md' });
    const body = puts().find((p) => p.input.Key === 'transcripts/premium/c1/m-1.md')!.input.Body as string;
    expect(body).toContain('said r1');
    expect(body).not.toContain('said r2');
    expect(body).toContain('said r3');
  });

  it('reads at most its cap of segments, the latest, and never all at once', async () => {
    mockGetContext.mockResolvedValue({ lastMeeting: { meetingId: 'm-1', transcription: { on: false, everRecorded: true } } });
    const total = MAX_TRANSCRIPT_SEGMENTS + 50;
    const keys = Array.from({ length: total }, (_v, i) => `transcripts/premium/c1/m-1/segments/${String(1000 + i).padStart(13, '0')}-${HOST}-r${i}.json`);
    let inFlight = 0;
    let most = 0;
    mockS3Send.mockImplementation(async (cmd: { __type: string; input: { Key?: string } }) => {
      if (cmd.__type === 'ListObjectsV2') return { Contents: keys.map((Key) => ({ Key })) };
      if (cmd.__type === 'GetObject') {
        inFlight++; most = Math.max(most, inFlight);
        await Promise.resolve();
        inFlight--;
        return { Body: { transformToString: async () => stored(cmd.input.Key!) } };
      }
      return {};
    });
    mockIdentitySend.mockResolvedValue({ AppInstanceUser: { Name: 'Hana Host' } });
    await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' });
    const gets = mockS3Send.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'GetObject');
    expect(gets).toHaveLength(MAX_TRANSCRIPT_SEGMENTS);
    expect(gets.map((g) => g.input.Key)).not.toContain(keys[0]);
    expect(most).toBeLessThanOrEqual(SEGMENT_READ_CONCURRENCY);
  });
});

describe('the ended card', () => {
  const render = (values: Record<string, string>) => {
    const r = renderMessageTemplate(shippedMessageTemplate('meeting-ended'), values, { sections: ['chat'], refusedValue: 'empty' });
    return r.ok ? r.sections.chat : '';
  };

  it('reads as a titled list: length, how it ended, its people, and links to its conversation and its transcript', () => {
    const chat = render({
      duration_minutes: '12', ended_how: 'A host ended it for everyone.', people_names: 'Gus Guest, Hana Host',
      conversation_link: '?conversation=c1', transcript_link: transcriptLink(transcriptKey('premium', 'c1', 'm-1')),
    });
    expect(chat).toBe([
      '**Meeting ended** · 12 min', '',
      '- A host ended it for everyone.',
      '- People: Gus Guest, Hana Host',
      '- [Meeting conversation](?conversation=c1)',
      '- [Transcript](?transcript=transcripts%2Fpremium%2Fc1%2Fm-1.md)',
    ].join('\n'));
  });

  it('carries no transcript link where there is no transcript', () => {
    const chat = render({ duration_minutes: '3', ended_how: 'Everyone left.', people_names: '', conversation_link: '?conversation=c1', transcript_link: '' });
    expect(chat).not.toContain('Transcript');
    expect(chat).not.toContain('People:');
    expect(chat).toContain('[Meeting conversation](?conversation=c1)');
  });

  it('says how each ending happened, in the shipped templates', () => {
    for (const name of ['meeting-ended-by-host', 'meeting-ended-everyone-left', 'meeting-ended-nobody-joined', 'meeting-ended-left-alone', 'meeting-ended-time-limit']) {
      const r = renderMessageTemplate(shippedMessageTemplate(name), { max_minutes: '90' }, { sections: ['chat'], refusedValue: 'empty' });
      expect(r.ok && r.sections.chat).toBeTruthy();
    }
  });
});

describe('the router writes the transcript, rewrites the card with its link, then archives the meeting\'s conversation', () => {
  const src = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const fired = src.slice(src.indexOf('export async function handleMeetingSummaryFired'), src.indexOf('export async function handleRuleEvent'));

  it('in that order, and archives whatever the card did', () => {
    const order = ['transcribeEndedMeeting(runFn', 'summarizeConversationMeeting(fn', 'rewriteEndedCard(firing.channelArn, firing.meetingId, { transcriptKey, figures })', 'return archive({ ran: true })'];
    const at = order.map((s) => fired.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(fired).toMatch(/return archive\(refuse\('no ended card'\)\)/);
  });

  it('archives through the conversation management function, the one archive sequence', () => {
    expect(src).toMatch(/FunctionName: fn, InvocationType: InvocationType\.Event,\s*Payload: Buffer\.from\(JSON\.stringify\(\{ aeMeetingArchive: \{ channelArn: meetingArn, meetingId \} \}\)\)/);
    const mgmt = readFileSync(join(__dirname, '../../lambda/src/conversation-management.ts'), 'utf8');
    const archiveEnded = mgmt.slice(mgmt.indexOf('export async function archiveEndedMeetingConversation'), mgmt.indexOf('export const handler'));
    // It checks the conversation's own row: a meeting's conversation, its last meeting the one named, none running.
    expect(archiveEnded).toMatch(/meetingSettingsOf\(row\?\.conversationType\)/);
    expect(archiveEnded).toMatch(/row\?\.lastMeeting\?\.meetingId !== meetingId/);
    expect(archiveEnded).toMatch(/if \(row\.activeMeeting\)/);
    expect(archiveEnded).toMatch(/await archiveConversation\(\{/);
    // The deployment's classifications are read before the archive, so the deadlines it cancels are named at their classification.
    const handler = mgmt.slice(mgmt.indexOf('export const handler'));
    expect(handler.indexOf('await loadProfileRegistry();')).toBeGreaterThan(-1);
    expect(handler.indexOf('await loadProfileRegistry();')).toBeLessThan(handler.indexOf('aeMeetingArchive'));
  });

  it('tells the people in the meeting when its transcription starts or stops, in its own chat', () => {
    expect(src).toContain("h.event === 'transcription-started' || h.event === 'transcription-stopped' || h.event === 'recording-started' || h.event === 'recording-stopped'");
    expect(src).toContain('sayTranscriptionNotice(h.channelArn, h.meetingId, transcriptionNoticeOf(h.event, last.transcription?.recording === true), h.at)');
    // The summary only follows a recorded meeting: the transcript is written only for one (`everRecorded`).
    const api = readFileSync(join(__dirname, '../../lambda/src/meeting-api.ts'), 'utf8');
    expect(api).toContain('if (row.lastMeeting.transcription?.everRecorded !== true) return { ok: true };');
  });
});

describe('a member reads the transcript; nobody else does', () => {
  it('is keyed in its own family, never one a member\'s upload could be read as', () => {
    const key = transcriptKey('premium', 'c1', 'm-1');
    expect(key.startsWith('attachments/')).toBe(false);
    expect(parseTranscriptKey(key)).toEqual({ classification: 'premium', conversationId: 'c1', meetingId: 'm-1' });
    expect(parseTranscriptKey('transcripts/premium/../c1/m-1.md')).toBeNull();
  });

  const presigner = readFileSync(join(__dirname, '../../lambda/presigned-url/index.js'), 'utf8');
  it('is signed only for the conversation the key names, for a member cleared for it, and only at the conversation\'s classification', () => {
    expect(presigner).toMatch(/const meetingArtifact = transcript \|\| recording;/);
    expect(presigner).toMatch(/\|\| \(meetingArtifact && meetingArtifact\.conversationId === conversationId\)/);
    expect(presigner).toMatch(/refusedConversation\(event, conversationId, origin, meetingArtifact \? meetingArtifact\.classification : undefined\)/);
    expect(presigner).toMatch(/access\.ok && keyClassification !== undefined && access\.classification !== keyClassification/);
  });
});

describe('a room\'s assistant reads its meeting\'s transcript as grounding', () => {
  it('reads the newest transcript of the child conversation, in its own classification\'s family', async () => {
    const send = jest.fn(async (cmd: { kind: string; input: Record<string, unknown> }) => cmd.kind === 'list'
      ? { Contents: [{ Key: 'transcripts/premium/c1/old.md', LastModified: new Date(1) }, { Key: 'transcripts/premium/c1/m-1.md', LastModified: new Date(2) }] }
      : { Body: { transformToString: async () => '[0:00] **Hana Host**: we ship friday' } });
    const text = await latestTranscriptOf({ send }, 'store', 'premium', CHANNEL, {
      list: (input) => ({ kind: 'list', input }), get: (input) => ({ kind: 'get', input }),
    });
    expect(text).toBe('[0:00] **Hana Host**: we ship friday');
    expect(send.mock.calls[0][0].input).toEqual(expect.objectContaining({ Prefix: 'transcripts/premium/c1/' }));
    expect(send.mock.calls[1][0].input).toEqual({ Bucket: 'store', Key: 'transcripts/premium/c1/m-1.md' });
  });

  it('puts it in the prompt as data, under the child\'s summary', () => {
    const hint = buildRelatedConversationsHint([{ relation: 'child', summary: 'A call about the release.', transcript: '[0:00] **Hana Host**: we ship friday' }]);
    expect(hint).toContain('<meeting-transcript>\n[0:00] **Hana Host**: we ship friday\n</meeting-transcript>');
  });

  it('a meeting\'s conversation is its room\'s thread, so the room reads it under the membership rule', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('../../lib/config/conversation-types').relationOf('meeting')).toBe('thread');
    expect(composeTranscript([], () => '')).toBe('');
  });
});
