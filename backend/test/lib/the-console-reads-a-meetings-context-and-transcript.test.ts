/**
 * THE CONSOLE'S MEETING DETAIL (`admin-meetings.ts`, `meeting-figures.ts`, SPEC-ASSISTANT-MEETINGS FR46): the conversation
 * a meeting was held in and the room it was started from, who started and hosts it, its media Region, each person's
 * device, timings and failure text, and its transcript.
 *
 * A TRANSCRIPT IS CONVERSATION CONTENT. It is its own route, granted under `view-events` and never under
 * `view-meeting-analytics`, read only with a stated reason that the access log records before the read, and only for a
 * meeting of a classification the caller reaches. The detail itself says whether the meeting was transcribed and never
 * carries what was said.
 */
const mockRequireAdmin = jest.fn();
const mockIamCall = jest.fn(() => false);
const mockScope = jest.fn((): string | null | undefined => null);
jest.mock('../../lambda/src/lib/auth', () => ({
  requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a),
  isAdminIamEnforcedCall: () => mockIamCall(),
}));
jest.mock('../../lambda/src/lib/caller-scope', () => ({
  ...jest.requireActual('../../lambda/src/lib/caller-scope'),
  scopeForRequest: () => mockScope(),
}));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, __setForTests, readTranscriptFromStore } from '../../lambda/src/admin-meetings';
import { ADMIN_CAPABILITIES } from '../../lib/config/admin-capabilities';
import { meetingDetail, meetingFigures, type MeetingEventRow } from '../../lambda/src/lib/meeting-figures';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const CHANNEL = `${APP}/channel/meet-1`;
const ROOM = `${APP}/channel/room-1`;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const row = (type: string, min: number, over: Partial<MeetingEventRow> = {}): MeetingEventRow => ({
  meeting_id: 'm-1', channel_arn: CHANNEL, classification: 'premium', event_type: type, source: 'server', attendee_id: null,
  person_key: null, is_content: false, network_transport: null, event_at: new Date(NOW - 60 * 60_000 + min * 60_000).toISOString(), detail: null, ...over,
});
const client = (type: string, min: number, person: string, detail: Record<string, unknown>) =>
  row(type, min, { source: 'client', person_key: person, attendee_id: `${person}-a1`, detail });
const ROWS: MeetingEventRow[] = [
  row('meetingCreated', 0, { source: 'platform', person_key: 'p1', detail: { startedVia: 'person', mediaRegion: 'eu-west-2', hosts: ['p1'] } }),
  row('MeetingStarted', 0),
  row('TranscriptionStarted', 0),
  row('AttendeeJoined', 1, { person_key: 'p1', attendee_id: 'p1-a1', network_transport: 'Voip' }),
  client('meetingStartSucceeded', 1, 'p1', { meetingStartDurationMs: 1400, browserName: 'Chrome', browserVersion: '131', osName: 'macOS', osVersion: '15.1', deviceName: 'MacBook Pro', sdkVersion: '3.31.0' }),
  client('attendeePresenceReceived', 1, 'p1', { attendeePresenceDurationMs: 820 }),
  client('audioInputFailed', 5, 'p1', { errorMessage: 'NotAllowedError' }),
  row('AttendeeLeft', 20, { person_key: 'p1', attendee_id: 'p1-a1' }),
  row('MeetingEnded', 30),
];

const read = jest.fn();
const log = jest.fn();
const conversation = jest.fn();
const transcript = jest.fn();
const get = (path: string, query: Record<string, string> = {}) => handler({
  httpMethod: 'GET', path, resource: path.replace(/\/m-1(\/|$)/, '/{meetingId}$1'), headers: {}, queryStringParameters: query,
  pathParameters: { meetingId: 'm-1' }, body: null,
} as unknown as APIGatewayProxyEvent);
const readTranscript = (reason = 'A customer asked what was agreed') => get('/admin/meetings/m-1/transcript', { accessReason: reason });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APP_INSTANCE_ARN = APP;
  mockRequireAdmin.mockResolvedValue({ claims: { personId: 'admin-1' } });
  mockIamCall.mockReturnValue(false);
  mockScope.mockReturnValue(null);
  read.mockResolvedValue({ rows: ROWS, truncated: false, unread: [], store: 'athena' });
  log.mockResolvedValue(undefined);
  conversation.mockImplementation(async (arn: string) => (arn === CHANNEL ? { conversationType: 'meeting', meetingOf: 'room-1' } : { conversationType: 'account-room' }));
  transcript.mockResolvedValue('[0:00] **p1**: hello');
  __setForTests({ read, now: () => NOW, log, conversation, transcript, record: async () => null, runs: async () => false });
});

describe('a transcript read of a meeting the read did not see whole', () => {
  it('answers incomplete, records no read, and reads no transcript, rather than saying there is no such meeting', async () => {
    read.mockResolvedValue({ rows: [], truncated: true, unread: [], store: 'athena' });
    const res = await readTranscript();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('INCOMPLETE');
    expect(log).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });
});

describe('a meeting\'s detail', () => {
  it('names its conversation\'s type and the room it was started from, with the room\'s type', async () => {
    const body = JSON.parse((await get('/admin/meetings/m-1')).body);
    expect(body.conversation).toEqual({ type: 'meeting', room: { channelArn: ROOM, type: 'account-room' }, summarized: false, transcriptKept: null });
  });

  it('stands without the conversation when its record cannot be read', async () => {
    conversation.mockRejectedValue(new Error('unreadable'));
    const res = await get('/admin/meetings/m-1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).conversation).toBeNull();
  });

  it('says who started it, its hosts, its media Region and that it was transcribed, and carries no transcript', async () => {
    const body = JSON.parse((await get('/admin/meetings/m-1')).body);
    expect(body.meeting).toMatchObject({ createdBy: 'p1', hosts: ['p1'], mediaRegion: 'eu-west-2', transcribed: true });
    expect(JSON.stringify(body)).not.toContain('hello');
    expect(transcript).not.toHaveBeenCalled();
  });

  it('gives each person their device, how long presence took and the text of each failure their app reported', () => {
    const [p1] = meetingDetail(ROWS, NOW).meeting.roster;
    expect(p1.device).toEqual({ browser: 'Chrome 131', os: 'macOS 15.1', name: 'MacBook Pro', sdk: '3.31.0' });
    expect(p1.presenceReceivedMs).toBe(820);
    expect(p1.failureEvents).toEqual([{ eventType: 'audioInputFailed', at: ROWS[6].event_at, errorMessage: 'NotAllowedError' }]);
  });

  it('counts the window\'s healthy meetings: those in which no app reported a failure', () => {
    const clean = ROWS.filter((r) => r.event_type !== 'audioInputFailed').map((r) => ({ ...r, meeting_id: 'm-2' }));
    expect(meetingFigures([...ROWS, ...clean], NOW).figures.healthyMeetings).toEqual({ value: 0.5, over: 2 });
  });
});

describe('a meeting\'s transcript', () => {
  it('is granted under the content capability, never under the meeting figures', () => {
    const path = { api: 'admin-conversations', method: 'GET', path: 'admin/meetings/{meetingId}/transcript' };
    expect(ADMIN_CAPABILITIES['view-events'].resources).toContainEqual(path);
    expect(ADMIN_CAPABILITIES['view-meeting-analytics'].resources).not.toContainEqual(path);
  });

  it('is read only with a stated reason, recorded before the read', async () => {
    const order: string[] = [];
    log.mockImplementation(async () => { order.push('log'); });
    transcript.mockImplementation(async () => { order.push('read'); return '[0:00] **p1**: hello'; });
    const res = await readTranscript();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ meetingId: 'm-1', transcript: '[0:00] **p1**: hello', summary: null });
    expect(order).toEqual(['log', 'read']);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      _auditEvent: 'meeting_transcript_read', personId: 'admin-1', channelArn: CHANNEL, meetingId: 'm-1', classification: 'premium',
      capabilities: ['view-events'], reason: 'A customer asked what was agreed', scope: 'full',
    }));
    expect(transcript).toHaveBeenCalledWith('transcripts/premium/meet-1/m-1.md');
  });

  it('is refused without a reason, and nothing is recorded or read', async () => {
    const res = await readTranscript('   ');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('REASON_REQUIRED');
    expect(log).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });

  it('is refused when the read cannot be recorded', async () => {
    log.mockRejectedValue(new Error('down'));
    const res = await readTranscript();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('ACCESS_LOG_UNAVAILABLE');
    expect(transcript).not.toHaveBeenCalled();
  });

  it('is refused for a meeting outside the classifications the caller reaches', async () => {
    mockIamCall.mockReturnValue(true);
    mockScope.mockReturnValue('basic');
    const res = await readTranscript();
    expect(res.statusCode).toBe(403);
    expect(log).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });

  it("carries the meeting's summary and its action items beside the transcript, and the detail says only that it was written", async () => {
    const SUMMARY = {
      summary: 'Renewal agreed.', keyPoints: ['Price held'], nextSteps: ['Send the order form'], topics: ['renewal'],
      actionItems: [{ text: 'Send the order form', due: '2026-11-20', taskId: 't-1', assignee: 'p1' }, { text: 'Book the review', heldBy: 'p1', secret: 'x' }],
      writtenBy: 'bot-1', writtenAt: '2026-11-11T12:00:00.000Z', model: 'm',
    };
    conversation.mockImplementation(async (arn: string) => (arn === CHANNEL
      ? { conversationType: 'meeting', meetingOf: 'room-1', lastMeeting: { meetingId: 'm-1', summary: SUMMARY } }
      : { conversationType: 'account-room' }));
    const detail = JSON.parse((await get('/admin/meetings/m-1')).body);
    expect(detail.conversation.summarized).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('Renewal agreed');
    const body = JSON.parse((await readTranscript()).body);
    expect(body.summary).toEqual({
      summary: 'Renewal agreed.', keyPoints: ['Price held'], nextSteps: ['Send the order form'], topics: ['renewal'],
      actionItems: [{ text: 'Send the order form', due: '2026-11-20', taskId: 't-1', assignee: 'p1' }, { text: 'Book the review', heldBy: 'p1' }],
      writtenAt: '2026-11-11T12:00:00.000Z',
    });
  });

  it('reads no summary of another meeting the conversation held', async () => {
    conversation.mockResolvedValue({ conversationType: 'meeting', lastMeeting: { meetingId: 'm-other', summary: { summary: 'Other', actionItems: [] } } });
    transcript.mockResolvedValue(null);
    expect((await readTranscript()).statusCode).toBe(404);
  });

  it('says whether the transcript was kept: recording mode at some point, not captions alone', async () => {
    conversation.mockImplementation(async (arn: string) => (arn === CHANNEL
      ? { conversationType: 'meeting', lastMeeting: { meetingId: 'm-1', transcription: { on: false, changedAt: 'x', changedBy: 'p1', everOn: true } } }
      : null));
    expect(JSON.parse((await get('/admin/meetings/m-1')).body).conversation.transcriptKept).toBe(false);
    conversation.mockImplementation(async () => ({ conversationType: 'meeting', lastMeeting: { meetingId: 'm-1', transcription: { on: false, changedAt: 'x', changedBy: 'p1', everOn: true, everRecorded: true } } }));
    expect(JSON.parse((await get('/admin/meetings/m-1')).body).conversation.transcriptKept).toBe(true);
  });

  it('answers a captions-only meeting as having no transcript, and records no read', async () => {
    conversation.mockResolvedValue({ conversationType: 'meeting', lastMeeting: { meetingId: 'm-1', transcription: { on: false, changedAt: 'x', changedBy: 'p1', everOn: true } } });
    const res = await readTranscript();
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('NO_TRANSCRIPT');
    expect(log).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });

  it('writes the CloudWatch audit line beside the access log record', async () => {
    const out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await readTranscript();
      const lines = out.mock.calls.map((c) => String(c[0])).filter((x) => x.includes('_auditEvent'));
      expect(lines.map((x) => JSON.parse(x))).toEqual([expect.objectContaining({ _auditEvent: 'meeting_transcript_read', meetingId: 'm-1', reason: 'A customer asked what was agreed' })]);
    } finally {
      out.mockRestore();
    }
  });

  it('answers a meeting with no transcript written as having none', async () => {
    transcript.mockResolvedValue(null);
    const res = await readTranscript();
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('NO_TRANSCRIPT');
  });

  it('answers a meeting outside the window as not found, and reads nothing', async () => {
    read.mockResolvedValue({ rows: [], truncated: false, unread: [], store: 'athena' });
    expect((await readTranscript()).statusCode).toBe(404);
    expect(log).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });
});

describe('the transcript store', () => {
  const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
  const KEY = 'transcripts/premium/meet-1/m-1.md';

  it('answers a key that is not there as none, when the read is denied for want of a whole-bucket listing', async () => {
    const send = jest.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') throw denied;
      return { Contents: [] };
    });
    await expect(readTranscriptFromStore(KEY, { send } as never, 'b')).resolves.toBeNull();
    expect(send.mock.calls[1][0]).toMatchObject({ input: { Bucket: 'b', Prefix: KEY, MaxKeys: 1 } });
  });

  it('keeps a denial of a key that is there', async () => {
    const send = jest.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') throw denied;
      return { Contents: [{ Key: KEY }] };
    });
    await expect(readTranscriptFromStore(KEY, { send } as never, 'b')).rejects.toThrow('Access Denied');
  });
});

describe('a transcript read by a reader that is not a person', () => {
  const PRINCIPAL = 'arn:aws:sts::111122223333:assumed-role/App-AdminRole-def/ops-automation';
  const signed = (identity: Record<string, unknown>) => handler({
    httpMethod: 'GET', path: '/admin/meetings/m-1/transcript', resource: '/admin/meetings/{meetingId}/transcript',
    headers: { 'x-amzn-principal-arn': 'arn:aws:sts::111122223333:assumed-role/Forged/x' },
    queryStringParameters: { accessReason: 'A customer asked what was agreed' }, pathParameters: { meetingId: 'm-1' }, body: null,
    requestContext: { identity },
  } as unknown as APIGatewayProxyEvent);

  beforeEach(() => mockRequireAdmin.mockResolvedValue({ claims: { personId: null } }));

  it('is recorded under the principal that signed it, then served', async () => {
    const res = await signed({ userArn: PRINCIPAL });
    expect(res.statusCode).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ _auditEvent: 'meeting_transcript_read', actorPrincipalArn: PRINCIPAL }));
  });

  it('is refused READER_UNIDENTIFIED where the signature names no principal ARN, whatever a header says', async () => {
    const res = await signed({ accountId: '111122223333' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('READER_UNIDENTIFIED');
    expect(log).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });
});
