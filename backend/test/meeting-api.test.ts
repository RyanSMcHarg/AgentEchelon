/**
 * The meeting API (SPEC-ASSISTANT-MEETINGS FR12 to FR15): the person routes and the run entry a workflow step invokes.
 *
 * The control-plane grant is account-wide, so these pin what the handler holds instead:
 *   - every route, end included, passes the caller's membership and clearance, and nothing is created for a refusal;
 *   - a conversation outside this app instance is refused before anything is read;
 *   - an attendee is keyed by the person's AppInstanceUser id;
 *   - a meeting that loses the start race, or cannot be recorded, is deleted;
 *   - a meeting Amazon Chime SDK has ended is released and never offered;
 *   - a run starts a meeting only under a classification read from the conversation's tag.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockMeetingsSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-meetings', () => ({
  ChimeSDKMeetingsClient: jest.fn(() => ({ send: mockMeetingsSend })),
  CreateMeetingCommand: jest.fn((input) => ({ __type: 'CreateMeeting', input })),
  CreateAttendeeCommand: jest.fn((input) => ({ __type: 'CreateAttendee', input })),
  DeleteMeetingCommand: jest.fn((input) => ({ __type: 'DeleteMeeting', input })),
  GetMeetingCommand: jest.fn((input) => ({ __type: 'GetMeeting', input })),
  GetAttendeeCommand: jest.fn((input) => ({ __type: 'GetAttendee', input })),
}));

const mockFile = jest.fn();
jest.mock('../lambda/src/lib/meeting-event-archive', () => ({ fileMeetingEvents: (...a: unknown[]) => mockFile(...a) }));
jest.mock('../lambda/src/lib/event-archive', () => ({ ensureDataPlaneArn: async () => undefined }));

const mockReach = jest.fn();
jest.mock('../lambda/src/lib/conversation-access', () => {
  const actual = jest.requireActual('../lambda/src/lib/conversation-access');
  return { ...actual, callerReachesConversation: (...a: unknown[]) => mockReach(...a) };
});
const mockPersonId = jest.fn();
jest.mock('../lambda/src/lib/auth', () => ({ callerPersonId: (...a: unknown[]) => mockPersonId(...a) }));
jest.mock('../lib/profile-registry', () => ({ ...jest.requireActual('../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));

const mockReadClassification = jest.fn();
jest.mock('../lambda/src/lib/channel-classification', () => ({
  ...jest.requireActual('../lambda/src/lib/channel-classification'),
  readChannelClassificationTag: (...a: unknown[]) => mockReadClassification(...a),
}));

const mockGetContext = jest.fn();
const mockClaim = jest.fn();
const mockRelease = jest.fn();
const mockClaimConversation = jest.fn();
const mockSettleConversation = jest.fn();
const mockConfirmConversation = jest.fn();
const mockReleaseConversation = jest.fn();
const mockRecordedAttendee = jest.fn((..._a: unknown[]) => true);
// A ROW IS A MEETING'S OWN CONVERSATION unless a test says otherwise: these cases hold the meeting where it is held (FR27).
jest.mock('../lambda/src/lib/channel-context-client', () => ({
  readChannelContext: async (...a: unknown[]) => ({ conversationType: 'meeting', ...((await mockGetContext(...a)) ?? {}) }),
  MEETING_OPENING_HOLD_MS: 60_000,
  confirmMeetingConversation: (...a: unknown[]) => mockConfirmConversation(...a),
  releaseMeetingConversation: (...a: unknown[]) => mockReleaseConversation(...a),
  claimMeetingConversation: (...a: unknown[]) => mockClaimConversation(...a),
  settleMeetingConversation: (...a: unknown[]) => mockSettleConversation(...a),
  claimActiveMeeting: (...a: unknown[]) => mockClaim(...a),
  releaseActiveMeeting: (...a: unknown[]) => mockRelease(...a),
  recordMeetingFact: async () => true,
  recordMeetingAttendee: async () => true,
  chargeTranscriptChars: async () => 'charged',
  meetingRecordedAttendee: (...a: unknown[]) => mockRecordedAttendee(...a),
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP_INSTANCE;
// The run entry under test is the premium classification's (`MEETING_RUN_CLASSIFICATION`, one per classification).
process.env.MEETING_RUN_CLASSIFICATION = 'premium';
process.env.MEDIA_REGION = 'us-east-1';

import { handler, runHandler, __setClients, __setLifecycleBus, __forgetRunningMeetings } from '../lambda/src/meeting-api';
import { __forgetAttendeeOwners } from '../lambda/src/lib/meeting-host-controls';

const CHANNEL = `${APP_INSTANCE}/channel/c1`;
const PERSON = 'person-1';
const MEETING = { MeetingId: 'm-1', MediaPlacement: {} };
const RECORD = { meetingId: 'm-1', meeting: MEETING, classification: 'premium', createdAt: '2026-11-10T00:00:00.000Z', createdBy: PERSON };

function event(path: string, body: Record<string, unknown> = { conversationId: 'c1' }): APIGatewayProxyEvent {
  return { httpMethod: 'POST', path, resource: path, headers: { origin: 'http://localhost:5173' }, body: JSON.stringify(body) } as unknown as APIGatewayProxyEvent;
}
const sent = (type: string) => mockMeetingsSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === type);

beforeEach(() => {
  __forgetAttendeeOwners();
  __forgetRunningMeetings();
  jest.clearAllMocks();
  mockReach.mockResolvedValue({ ok: true, channelArn: CHANNEL, classification: 'premium' });
  mockPersonId.mockResolvedValue(PERSON);
  mockGetContext.mockResolvedValue(null);
  mockClaim.mockResolvedValue('claimed');
  mockRelease.mockResolvedValue('released');
  mockConfirmConversation.mockResolvedValue(true);
  mockReleaseConversation.mockResolvedValue(true);
  mockReadClassification.mockResolvedValue('premium');
  mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
    if (cmd.__type === 'CreateMeeting') return { Meeting: MEETING };
    if (cmd.__type === 'CreateAttendee') return { Attendee: { AttendeeId: 'a-1', ExternalUserId: PERSON, JoinToken: 't' } };
    if (cmd.__type === 'GetMeeting') return { Meeting: MEETING };
    return {};
  });
});

describe('every person route passes the caller\'s membership and clearance', () => {
  it.each(['/meetings', '/meetings/join', '/meetings/status', '/meetings/end', '/meetings/events'])('%s refuses a caller the check refuses, and touches no meeting', async (path) => {
    mockReach.mockResolvedValue({ ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false });
    const res = await handler(event(path));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NOT_A_MEMBER');
    expect(mockMeetingsSend).not.toHaveBeenCalled();
    // A start, a join or a status read may read the named conversation's own row, to learn whether it is a meeting's its
    // caller may enter from the conversation it was started from; no other route reads anything for a refused caller.
    if (!['/meetings/join', '/meetings', '/meetings/status'].includes(path)) expect(mockGetContext).not.toHaveBeenCalled();
  });

  it('answers an unavailable check as retryable', async () => {
    mockReach.mockResolvedValue({ ok: false, status: 503, code: 'UNAVAILABLE', memberProven: true });
    expect((await handler(event('/meetings'))).statusCode).toBe(503);
  });

  it('refuses a conversation of another app instance before checking anyone', async () => {
    const res = await handler(event('/meetings', { channelArn: 'arn:aws:chime:us-east-1:999:app-instance/other/channel/c1' }));
    expect(res.statusCode).toBe(400);
    expect(mockReach).not.toHaveBeenCalled();
  });
});

describe('a start', () => {
  it('creates the meeting under the classification the check read, tagged with it, and keys the attendee by the person', async () => {
    const res = await handler(event('/meetings'));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).created).toBe(true);
    expect(sent('CreateMeeting')[0].input.Tags).toEqual([{ Key: 'classification', Value: 'premium' }]);
    expect(sent('CreateAttendee')[0].input.ExternalUserId).toBe(PERSON);
    expect(mockClaim.mock.calls[0][1].createdBy).toBe(PERSON);
  });

  it('records that it created the meeting, by whom and by which path, which is when the ring went out', async () => {
    mockFile.mockResolvedValue({ archived: 1, projected: null, duplicates: 0 });
    await handler(event('/meetings'));
    expect(mockFile).toHaveBeenCalledWith([expect.objectContaining({
      meeting_id: 'm-1', event_type: 'meetingCreated', source: 'platform', person_key: PERSON, classification: 'premium',
      detail: expect.objectContaining({ startedVia: 'person' }),
    })], undefined, { projection: 'best-effort' });
  });

  // FILED ONCE THE ARCHIVE HOLDS IT: a projection that fails is handed on and retried from the archive, so a deployment
  // that reads only the projection never loses a meeting's creation.
  it('files its creation with the projection best-effort, so a passing projection failure is retried from the archive', async () => {
    mockFile.mockResolvedValue({ archived: 1, projected: null, duplicates: 0 });
    await handler(event('/meetings'));
    const call = mockFile.mock.calls.find((c) => (c[0] as Array<{ event_type: string }>)[0]?.event_type === 'meetingCreated')!;
    expect(call[2]).toEqual({ projection: 'best-effort' });
  });

  it('records the Region its media is hosted in and its hosts by id, for the console', async () => {
    mockFile.mockResolvedValue({ archived: 1, projected: null, duplicates: 0 });
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'CreateMeeting') return { Meeting: { ...MEETING, MediaRegion: 'eu-west-2' } };
      if (cmd.__type === 'CreateAttendee') return { Attendee: { AttendeeId: 'a-1', ExternalUserId: PERSON, JoinToken: 't' } };
      return {};
    });
    await handler(event('/meetings'));
    const created = mockFile.mock.calls.flatMap((c) => c[0] as Array<{ event_type: string; detail: Record<string, unknown> }>).find((r) => r.event_type === 'meetingCreated')!;
    expect(created.detail.mediaRegion).toBe('eu-west-2');
    const hosts = mockClaim.mock.calls[0][1].hosts as Array<{ personId: string }> | undefined;
    if (hosts?.length) expect(created.detail.hosts).toEqual(hosts.map((h) => h.personId));
    else expect(created.detail.hosts).toBeUndefined();
  });

  it('starts the meeting even when its creation cannot be recorded', async () => {
    mockFile.mockRejectedValue(new Error('stream down'));
    expect((await handler(event('/meetings'))).statusCode).toBe(201);
  });

  it('records nothing when it joined a meeting already running', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    await handler(event('/meetings'));
    expect(mockFile).not.toHaveBeenCalled();
  });

  it('joins the running meeting rather than creating a second', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    const res = await handler(event('/meetings'));
    expect(res.statusCode).toBe(200);
    expect(sent('CreateMeeting')).toHaveLength(0);
  });

  it('deletes its meeting when it loses the race, and joins the winner', async () => {
    mockClaim.mockResolvedValue('lost');
    mockGetContext.mockResolvedValueOnce(null).mockResolvedValue({ activeMeeting: { ...RECORD, meetingId: 'm-2' } });
    const res = await handler(event('/meetings'));
    expect(res.statusCode).toBe(200);
    expect(sent('DeleteMeeting')[0].input.MeetingId).toBe('m-1');
    expect(sent('CreateAttendee')[0].input.MeetingId).toBe('m-2');
  });

  it('deletes a meeting it could not record, and says so', async () => {
    mockClaim.mockResolvedValue('failed');
    const res = await handler(event('/meetings'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('MEETING_NOT_RECORDED');
    expect(sent('DeleteMeeting')).toHaveLength(1);
  });
});

describe('a join', () => {
  describe('a person who takes the meeting stops ringing on their other tabs and devices', () => {
    const bus = { send: jest.fn() };
    const published = () => bus.send.mock.calls.map((c) => JSON.parse(c[0].input.Entries[0].Detail));
    beforeAll(() => { process.env.MEETING_LIFECYCLE_INSTANCE = 'inst'; __setLifecycleBus(bus as never); });
    afterAll(() => { delete process.env.MEETING_LIFECYCLE_INSTANCE; });
    beforeEach(() => { bus.send.mockReset(); bus.send.mockResolvedValue({ FailedEntryCount: 0 }); });

    it.each(['/meetings/join', '/meetings'])("%s publishes the caller's attendance, naming them, once their attendee is created", async (path) => {
      mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
      expect((await handler(event(path))).statusCode).toBeLessThan(300);
      expect(published()).toEqual([expect.objectContaining({ instance: 'inst', classification: 'premium', channelArn: CHANNEL, meetingId: 'm-1', event: 'person-attended', personId: PERSON })]);
    });

    it('joins all the same where the attendance cannot be published', async () => {
      mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
      bus.send.mockRejectedValue(Object.assign(new Error('x'), { name: 'ThrottlingException' }));
      expect((await handler(event('/meetings/join'))).statusCode).toBe(200);
    });

    it('publishes nothing for a join that created no attendee', async () => {
      mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
      mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
        if (cmd.__type === 'GetMeeting') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
        return {};
      });
      await handler(event('/meetings/join'));
      expect(bus.send).not.toHaveBeenCalled();
    });
  });

  it('releases a meeting Amazon Chime SDK has ended, and offers none', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetMeeting') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
      return {};
    });
    const res = await handler(event('/meetings/join'));
    expect(res.statusCode).toBe(404);
    expect(mockRelease).toHaveBeenCalledWith(CHANNEL, 'm-1', expect.any(String));
    expect(sent('CreateAttendee')).toHaveLength(0);
  });

  it('keeps a meeting whose state cannot be read, and joins it', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetMeeting') throw Object.assign(new Error('slow'), { name: 'ThrottlingException' });
      return { Attendee: { AttendeeId: 'a-1' } };
    });
    expect((await handler(event('/meetings/join'))).statusCode).toBe(200);
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe('an end', () => {
  it('keeps the record when the delete fails, so the meeting can be ended again', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    mockMeetingsSend.mockRejectedValue(Object.assign(new Error('x'), { name: 'ServiceFailureException' }));
    const res = await handler(event('/meetings/end'));
    expect(res.statusCode).toBe(502);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('answers a record it could not read as an outage, never as no meeting, so the meeting is not left running unseen', async () => {
    mockGetContext.mockRejectedValue(Object.assign(new Error('x'), { name: 'ChannelContextUnreadable' }));
    const res = await handler(event('/meetings/end'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('UNAVAILABLE');
  });

  it('releases the record once the meeting is gone', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    const res = await handler(event('/meetings/end'));
    expect(JSON.parse(res.body)).toEqual({ ended: true });
    expect(mockRelease).toHaveBeenCalledWith(CHANNEL, 'm-1', expect.any(String));
  });
});

describe('a workflow run\'s start', () => {
  it('starts the meeting under the conversation\'s tag, recorded as the assistant\'s', async () => {
    const out = await runHandler({ channelArn: CHANNEL, startedBy: 'ops-bot' });
    expect(out).toEqual({ ok: true, meetingId: 'm-1', created: true, meetingConversationArn: CHANNEL, ringSeconds: 10 });
    expect(mockReadClassification).toHaveBeenCalledWith(expect.anything(), CHANNEL, expect.any(String));
    expect(mockClaim.mock.calls[0][1]).toMatchObject({ classification: 'premium', createdBy: 'ops-bot' });
    // A run joins nobody, so it creates no attendee.
    expect(sent('CreateAttendee')).toHaveLength(0);
  });

  it('records the meeting it created as the start of a workflow', async () => {
    mockFile.mockResolvedValue({ archived: 1, projected: null, duplicates: 0 });
    await runHandler({ channelArn: CHANNEL, startedBy: 'ops-bot' });
    expect(mockFile).toHaveBeenCalledWith([expect.objectContaining({ event_type: 'meetingCreated', person_key: 'ops-bot', detail: expect.objectContaining({ startedVia: 'workflow' }) })], undefined, { projection: 'best-effort' });
  });

  it('starts nothing where the classification cannot be read', async () => {
    mockReadClassification.mockResolvedValue(undefined);
    expect(await runHandler({ channelArn: CHANNEL, startedBy: 'ops-bot' })).toEqual({ ok: false, code: 'CLASSIFICATION_UNREADABLE' });
    expect(sent('CreateMeeting')).toHaveLength(0);
  });

  it('starts nothing in another app instance\'s conversation', async () => {
    const out = await runHandler({ channelArn: 'arn:aws:chime:us-east-1:999:app-instance/other/channel/c1', startedBy: 'ops-bot' });
    expect(out).toEqual({ ok: false, code: 'INVALID_CONVERSATION' });
    expect(mockMeetingsSend).not.toHaveBeenCalled();
  });
});

describe('a run entry acts only in its own classification\'s conversations (tenets D3, D12)', () => {
  afterEach(() => { process.env.MEETING_RUN_CLASSIFICATION = 'premium'; });

  it('REFUSED: a start, an end or a transcript in a conversation of another classification, before anything is read or created', async () => {
    mockReadClassification.mockResolvedValue('standard');
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD, lastMeeting: { meetingId: 'm-1', transcription: { everRecorded: true } } });
    expect(await runHandler({ channelArn: CHANNEL, startedBy: 'ops-bot' })).toEqual({ ok: false, code: 'OTHER_CLASSIFICATION' });
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'OTHER_CLASSIFICATION' });
    expect(await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'OTHER_CLASSIFICATION' });
    expect(mockMeetingsSend).not.toHaveBeenCalled();
    expect(mockGetContext).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('REFUSED: an end or a transcript where the conversation\'s classification cannot be read', async () => {
    mockReadClassification.mockResolvedValue(undefined);
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'CLASSIFICATION_UNREADABLE' });
    expect(await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'CLASSIFICATION_UNREADABLE' });
    expect(mockMeetingsSend).not.toHaveBeenCalled();
  });

  it('REFUSED: every operation of a run entry deployed without its classification', async () => {
    delete process.env.MEETING_RUN_CLASSIFICATION;
    expect(await runHandler({ channelArn: CHANNEL, startedBy: 'ops-bot' })).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
    expect(await runHandler({ op: 'transcript', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
    expect(mockReadClassification).not.toHaveBeenCalled();
    expect(mockMeetingsSend).not.toHaveBeenCalled();
  });

  it('acts in a conversation of its own classification', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: true });
    expect(mockReadClassification).toHaveBeenCalledWith(expect.anything(), CHANNEL, expect.any(String));
  });

  it('every run entry passes one gate, so which conversations a run may act in is decided in one place', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lambda', 'src', 'meeting-api.ts'), 'utf8') as string;
    for (const entry of ['startFromRun', 'endFromRun', 'transcriptFromRun']) {
      const body = src.slice(src.indexOf(`async function ${entry}(`), src.indexOf('\n}\n', src.indexOf(`async function ${entry}(`)));
      expect(body).toMatch(/return inRunConversation\(/);
    }
    // The classification is read against the entry's own in that gate alone.
    expect(src.match(/await notThisRunsClassification\(/g)).toHaveLength(1);
  });

  it('REFUSED: a request naming no meeting or no starter, before anything is read', async () => {
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: '' })).toEqual({ ok: false, code: 'INVALID_CONVERSATION' });
    expect(await runHandler({ channelArn: CHANNEL, startedBy: '' })).toEqual({ ok: false, code: 'INVALID_CONVERSATION' });
    expect(mockReadClassification).not.toHaveBeenCalled();
  });
});

describe('what the app of a participant reports', () => {
  const report = (body: Record<string, unknown>) => handler(event('/meetings/events', { conversationId: 'c1', ...body }));
  const ATTENDEE_OF = (owner: string) => async (cmd: { __type: string }) => {
    if (cmd.__type === 'GetMeeting') return { Meeting: MEETING };
    if (cmd.__type === 'GetAttendee') return { Attendee: { AttendeeId: 'a-1', ExternalUserId: owner } };
    return {};
  };
  beforeEach(() => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    mockFile.mockResolvedValue({ archived: 1, projected: null, duplicates: 0 });
  });

  it('files a meeting event as the caller, in the meeting and boundary of the conversation, never as the body says', async () => {
    mockMeetingsSend.mockImplementation(ATTENDEE_OF(PERSON));
    const res = await report({
      attendeeId: 'a-1',
      events: [{ name: 'meetingStartSucceeded', at: Date.now(), attributes: { meetingStartDurationMs: 1840, browserName: 'Chrome', personKey: 'someone-else' } }],
      meetingId: 'another-meeting', classification: 'basic',
    });
    expect(res.statusCode).toBe(202);
    const [records] = mockFile.mock.calls[0];
    expect(records).toEqual([expect.objectContaining({
      meeting_id: 'm-1', channel_arn: CHANNEL, classification: 'premium', person_key: PERSON, attendee_id: 'a-1', source: 'client',
      event_type: 'meetingStartSucceeded', detail: { meetingStartDurationMs: 1840, browserName: 'Chrome' },
    })]);
  });

  it('asks the service whether the meeting runs once per window for its reports, and a join always asks', async () => {
    mockMeetingsSend.mockImplementation(ATTENDEE_OF(PERSON));
    const now = jest.spyOn(Date, 'now');
    try {
      const t0 = Date.parse('2026-11-17T10:00:00.000Z');
      now.mockReturnValue(t0);
      for (let i = 0; i < 3; i++) expect((await report({ attendeeId: 'a-1', events: [{ name: 'audioInputFailed', at: t0 }] })).statusCode).toBe(202);
      expect(sent('GetMeeting')).toHaveLength(1);
      // PAST THE WINDOW, the next report asks again.
      now.mockReturnValue(t0 + 30_000);
      expect((await report({ attendeeId: 'a-1', events: [{ name: 'audioInputFailed', at: t0 + 30_000 }] })).statusCode).toBe(202);
      expect(sent('GetMeeting')).toHaveLength(2);
      // A JOIN NEVER TAKES THE KEPT ANSWER: it is offered only a meeting the service holds now.
      await handler(event('/meetings/join'));
      expect(sent('GetMeeting')).toHaveLength(3);
    } finally {
      now.mockRestore();
    }
  });

  it('answers a report filed once the archive holds it, the projection best effort, because the app never retries one', async () => {
    mockMeetingsSend.mockImplementation(ATTENDEE_OF(PERSON));
    mockFile.mockResolvedValue({ archived: 1, projected: null, duplicates: 0, projectionFailed: true });
    const res = await report({ attendeeId: 'a-1', events: [{ name: 'audioInputFailed', at: Date.now() }] });
    expect(res.statusCode).toBe(202);
    expect(mockFile.mock.calls[0][2]).toEqual({ projection: 'best-effort' });
  });

  it('refuses an attendee that belongs to someone else, and files nothing', async () => {
    mockMeetingsSend.mockImplementation(ATTENDEE_OF('person-2'));
    const res = await report({ attendeeId: 'a-1', events: [{ name: 'audioInputFailed', at: Date.now() }] });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NOT_YOUR_ATTENDEE');
    expect(mockFile).not.toHaveBeenCalled();
  });

  it('files a ring outcome without an attendee, keyed by the person, and skips a meeting event that has none', async () => {
    const res = await report({ events: [{ name: 'ringAnswered', at: Date.now() }, { name: 'audioInputFailed', at: Date.now() }] });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ filed: 1, skipped: 1 });
    expect(mockFile.mock.calls[0][0]).toEqual([expect.objectContaining({ event_type: 'ringAnswered', attendee_id: `ring#${PERSON}`, person_key: PERSON })]);
  });

  it('files nothing about a meeting that is not running', async () => {
    mockGetContext.mockResolvedValue(null);
    const res = await report({ events: [{ name: 'ringDismissed', at: Date.now() }] });
    expect(res.statusCode).toBe(404);
    expect(mockFile).not.toHaveBeenCalled();
  });

  describe('the last batch of a meeting that just ended', () => {
    const realRecordedAttendee = jest.requireActual('../lambda/src/lib/channel-context-client').meetingRecordedAttendee;
    const endedRow = (endedAgoMs: number) => ({
      lastMeeting: { meetingId: 'm-1', createdAt: RECORD.createdAt, createdBy: PERSON, attendeeKeys: [`${PERSON} a-1`], endedAt: new Date(Date.now() - endedAgoMs).toISOString() },
    });
    const sample = () => ({ name: 'connectivitySample', at: Date.now() - 20_000, attributes: { rttMs: 80, readings: 15 } });
    let warn: jest.SpyInstance;
    beforeEach(() => {
      mockRecordedAttendee.mockImplementation(realRecordedAttendee);
      // The service has deleted the meeting: it answers for no meeting and no attendee.
      mockMeetingsSend.mockImplementation(async () => { throw Object.assign(new Error('gone'), { name: 'NotFoundException' }); });
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      mockRecordedAttendee.mockImplementation(() => true);
      warn.mockRestore();
    });
    const refusalsLogged = () => warn.mock.calls.filter((c) => String(c[0]).includes('a meeting event report was refused')).map((c) => c[1]);

    it('files a report from an attendee the ended meeting recorded for the caller, within the clock tolerance, against that meeting', async () => {
      mockGetContext.mockResolvedValue(endedRow(60_000));
      const res = await report({ attendeeId: 'a-1', events: [sample()], meetingId: 'another-meeting', classification: 'basic' });
      expect(res.statusCode).toBe(202);
      expect(mockFile.mock.calls[0][0]).toEqual([expect.objectContaining({
        meeting_id: 'm-1', classification: 'premium', person_key: PERSON, attendee_id: 'a-1', event_type: 'connectivitySample',
      })]);
      expect(refusalsLogged()).toEqual([]);
    });

    it('files it when the meeting was still recorded as running and the service had already ended it', async () => {
      mockGetContext
        .mockResolvedValueOnce({ activeMeeting: RECORD, lastMeeting: endedRow(0).lastMeeting })
        .mockResolvedValue(endedRow(1_000));
      const res = await report({ attendeeId: 'a-1', events: [sample()] });
      expect(res.statusCode).toBe(202);
      expect(mockFile).toHaveBeenCalledTimes(1);
    });

    it('files the last batch when this report is the one that finds the meeting gone: its release says when, in the same write', async () => {
      // The store as the release leaves it: the running meeting removed and its end recorded together, never one alone.
      let stored: Record<string, unknown> = { activeMeeting: RECORD, lastMeeting: { ...endedRow(0).lastMeeting, endedAt: undefined } };
      mockGetContext.mockImplementation(async () => stored);
      mockRelease.mockImplementation(async (_c: string, _m: string, endedAt?: string) => {
        const { activeMeeting: _gone, ...rest } = stored;
        stored = { ...rest, lastMeeting: { ...(rest.lastMeeting as object), ...(endedAt ? { endedAt } : {}) } };
        return 'released';
      });
      const res = await report({ attendeeId: 'a-1', events: [sample()] });
      expect(res.statusCode).toBe(202);
      expect(mockRelease).toHaveBeenCalledWith(CHANNEL, 'm-1', expect.stringMatching(/^\d{4}-/));
      expect(refusalsLogged()).toEqual([]);
    });

    it('REFUSED: an attendee the ended meeting never created for the caller, and the refusal is logged without the report', async () => {
      mockGetContext.mockResolvedValue(endedRow(60_000));
      const res = await report({ attendeeId: 'a-2', events: [sample()] });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('NOT_YOUR_ATTENDEE');
      expect(mockFile).not.toHaveBeenCalled();
      expect(refusalsLogged()).toEqual([{ reason: 'ENDED_NOT_YOUR_ATTENDEE', status: 403, meetingId: 'm-1' }]);
    });

    it('REFUSED: a meeting that ended longer ago than the clock tolerance', async () => {
      mockGetContext.mockResolvedValue(endedRow(5 * 60_000 + 1_000));
      const res = await report({ attendeeId: 'a-1', events: [sample()] });
      expect(res.statusCode).toBe(404);
      expect(mockFile).not.toHaveBeenCalled();
      expect(refusalsLogged()).toEqual([{ reason: 'ENDED_TOO_LONG_AGO', status: 404, meetingId: 'm-1' }]);
    });

    it('REFUSED: a report naming no attendee, and a conversation that never held a meeting, each logged with its reason', async () => {
      mockGetContext.mockResolvedValue(endedRow(1_000));
      expect((await report({ events: [{ name: 'ringDismissed', at: Date.now() }] })).statusCode).toBe(404);
      mockGetContext.mockResolvedValue(null);
      expect((await report({ attendeeId: 'a-1', events: [sample()] })).statusCode).toBe(404);
      expect(mockFile).not.toHaveBeenCalled();
      expect(refusalsLogged().map((l) => l.reason)).toEqual(['ENDED_NO_ATTENDEE', 'NO_MEETING']);
      expect(JSON.stringify(refusalsLogged())).not.toContain('connectivitySample');
    });
  });

  it('answers a report it could not file as retryable', async () => {
    mockFile.mockRejectedValue(new Error('stream down'));
    expect((await report({ events: [{ name: 'ringTimedOut', at: Date.now() }] })).statusCode).toBe(503);
  });
});

describe('a status read, for a person who arrives late', () => {
  it('says the meeting runs, since when, and whether this person started it, and creates nothing', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    const res = await handler(event('/meetings/status'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ running: true, startedAt: RECORD.createdAt, startedByYou: true, conversationId: 'c1', roomConversationId: 'c1', isHost: true, hostIds: [PERSON], mutedByHost: false, mayEnd: true, transcribing: false, recording: false, mediaRecording: false });
    expect(sent('CreateAttendee')).toHaveLength(0);
    expect(sent('CreateMeeting')).toHaveLength(0);
  });

  it('says whether a host holds the reader\'s audio, so a session that reconnects holds or frees its microphone', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, heldPersonIds: [PERSON] } });
    expect(JSON.parse((await handler(event('/meetings/status'))).body).mutedByHost).toBe(true);
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, heldPersonIds: ['someone-else'] } });
    expect(JSON.parse((await handler(event('/meetings/status'))).body).mutedByHost).toBe(false);
  });

  it('says the meeting\'s audio and video are recorded only while a part of this meeting is capturing', async () => {
    process.env.MEETING_MEDIA_RECORDING = 'true';
    try {
      const part = (state: string) => ({ capture: 'p-1', captureArn: 'arn:aws:chime:us-east-1:111122223333:media-pipeline/p-1', classification: 'premium', startedAt: '2026-11-10T00:01:00.000Z', state });
      const recorded = (state: string, meetingId = 'm-1') => ({
        activeMeeting: RECORD,
        lastMeeting: { meetingId, createdAt: RECORD.createdAt, createdBy: PERSON, transcription: { on: true, recording: true, changedAt: RECORD.createdAt, changedBy: PERSON }, recordings: { 'part-1': part(state) } },
      });
      mockGetContext.mockResolvedValue(recorded('capturing'));
      expect(JSON.parse((await handler(event('/meetings/status'))).body)).toMatchObject({ recording: true, mediaRecording: true });
      // A capture that failed, or was stopped, records nothing more: the meeting is recorded as its transcript only.
      mockGetContext.mockResolvedValue(recorded('failed'));
      expect(JSON.parse((await handler(event('/meetings/status'))).body)).toMatchObject({ recording: true, mediaRecording: false });
      mockGetContext.mockResolvedValue(recorded('processing'));
      expect(JSON.parse((await handler(event('/meetings/status'))).body)).toMatchObject({ recording: true, mediaRecording: false });
    } finally {
      delete process.env.MEETING_MEDIA_RECORDING;
    }
  });

  it('says another person started it', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, createdBy: 'someone-else' } });
    expect(JSON.parse((await handler(event('/meetings/status'))).body).startedByYou).toBe(false);
  });

  it('says nothing runs where none is recorded, or the service has ended it', async () => {
    expect(JSON.parse((await handler(event('/meetings/status'))).body)).toEqual({ running: false, roomConversationId: 'c1', mayStart: true });
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'GetMeeting') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
      return {};
    });
    expect(JSON.parse((await handler(event('/meetings/status'))).body)).toEqual({ running: false, roomConversationId: 'c1', mayStart: true });
    expect(mockRelease).toHaveBeenCalledWith(CHANNEL, 'm-1', expect.any(String));
  });
});

describe('every meeting is its own conversation (FR27, FR42)', () => {
  const ROOM = `${APP_INSTANCE}/channel/room-1`;
  const MEETING_CONV = `${APP_INSTANCE}/channel/meet-1`;
  const PERSON_ARN = `${APP_INSTANCE}/user/${PERSON}`;
  const mockInvoke = jest.fn();
  const asked = () => mockInvoke.mock.calls.map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString('utf8')));
  const answer = (body: unknown) => ({ Payload: Buffer.from(JSON.stringify(body)) });
  const rows: Record<string, Record<string, unknown> | null> = {};
  const inRoom = () => ({ channelArn: ROOM });

  beforeAll(() => { process.env.TYPED_CREATOR_NAME_PATTERN = 'AgentEchelonAssistants-{classification}-TypedCreator'; });
  afterAll(() => { delete process.env.TYPED_CREATOR_NAME_PATTERN; });
  beforeEach(() => {
    __setClients({ lambda: { send: mockInvoke } as never });
    mockInvoke.mockResolvedValue(answer({ ok: true, channelArn: MEETING_CONV }));
    for (const k of Object.keys(rows)) delete rows[k];
    rows[ROOM] = { conversationType: 'general' };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM };
    mockGetContext.mockImplementation(async (arn: string) => rows[arn] ?? null);
    mockClaimConversation.mockResolvedValue('claimed');
    mockSettleConversation.mockResolvedValue(true);
    // The caller is a member of the room and, until admitted, of nothing else.
    mockReach.mockImplementation(async (_e: unknown, conv: string) => {
      const arn = conv.startsWith('arn:') ? conv : `${APP_INSTANCE}/channel/${conv}`;
      return arn === ROOM ? { ok: true, channelArn: ROOM, classification: 'premium' } : { ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false };
    });
  });

  it("a start from a conversation opens the meeting's own conversation for the person, through that classification's creator, and holds the meeting there", async () => {
    const res = await handler(event('/meetings', inRoom()));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).conversationId).toBe('meet-1');
    expect(mockInvoke.mock.calls[0][0].input.FunctionName).toBe('AgentEchelonAssistants-premium-TypedCreator');
    expect(asked()).toEqual([{ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON_ARN }]);
    expect(mockClaimConversation).toHaveBeenCalledWith(ROOM, undefined, expect.any(String));
    expect(mockSettleConversation).toHaveBeenCalledWith(ROOM, mockClaimConversation.mock.calls[0][2], MEETING_CONV);
    // The room's claim is cleared only once the meeting is recorded in its conversation.
    expect(mockConfirmConversation).toHaveBeenCalledWith(ROOM, MEETING_CONV);
    expect(mockClaim.mock.invocationCallOrder[0]).toBeLessThan(mockConfirmConversation.mock.invocationCallOrder[0]);
    // The meeting is the meeting conversation's, never the room's.
    expect(mockClaim).toHaveBeenCalledWith(MEETING_CONV, expect.objectContaining({ createdBy: PERSON }));
    expect(sent('CreateMeeting')[0].input.ExternalMeetingId).toBe('meet-1');
  });

  it('a large room whose people were not all carried by the answer has the rest carried after it, asked without waiting', async () => {
    mockInvoke.mockResolvedValueOnce(answer({ ok: true, channelArn: MEETING_CONV, carryLeft: true }));
    const res = await handler(event('/meetings', inRoom()));
    expect(res.statusCode).toBe(201);
    expect(asked()).toEqual([
      { aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON_ARN },
      { aeMeeting: 'carry', meetingChannelArn: MEETING_CONV, parentChannelArn: ROOM },
    ]);
    expect(mockInvoke.mock.calls[1][0].input.InvocationType).toBe('Event');
    expect(mockInvoke.mock.calls[1][0].input.FunctionName).toBe('AgentEchelonAssistants-premium-TypedCreator');
  });

  it('asks for no carry where the open carried everyone', async () => {
    await handler(event('/meetings', inRoom()));
    expect(asked().filter((r: { aeMeeting: string }) => r.aeMeeting === 'carry')).toEqual([]);
  });

  it('a second start while the meeting runs opens no second conversation: the person enters the running one', async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
    const res = await handler(event('/meetings', inRoom()));
    expect(res.statusCode).toBe(200);
    expect(asked()).toEqual([{ aeMeeting: 'admit', meetingChannelArn: MEETING_CONV, personArn: PERSON_ARN, parentChannelArn: ROOM }]);
    expect(sent('CreateMeeting')).toHaveLength(0);
    expect(mockClaimConversation).not.toHaveBeenCalled();
  });

  it('a meeting that ended is followed by a new conversation, not reopened in the old one', async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, lastMeeting: { meetingId: 'm-0', createdAt: 'x', createdBy: PERSON } };
    await handler(event('/meetings', inRoom()));
    expect(mockClaimConversation).toHaveBeenCalledWith(ROOM, MEETING_CONV, expect.any(String), { reuse: false });
    expect(asked()[0].aeMeeting).toBe('open');
  });

  it('a start that loses the claim while the other is still opening is told the meeting is starting, and creates nothing', async () => {
    mockClaimConversation.mockResolvedValue('lost');
    const res = await handler(event('/meetings', inRoom()));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('MEETING_STARTING');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(sent('CreateMeeting')).toHaveLength(0);
  });

  it('a conversation the creator could not open starts no meeting', async () => {
    mockInvoke.mockResolvedValue(answer({ ok: false, code: 'FAILED' }));
    const res = await handler(event('/meetings', inRoom()));
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('CONVERSATION_NOT_OPENED');
    expect(sent('CreateMeeting')).toHaveLength(0);
  });

  it("a join from the conversation admits its member to the meeting's conversation alone, and names it", async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
    const res = await handler(event('/meetings/join', inRoom()));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).conversationId).toBe('meet-1');
    expect(asked()).toEqual([{ aeMeeting: 'admit', meetingChannelArn: MEETING_CONV, personArn: PERSON_ARN, parentChannelArn: ROOM }]);
  });

  it("a join that names the meeting's conversation, from its link, admits a member of the conversation it was started from", async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
    const res = await handler(event('/meetings/join', { channelArn: MEETING_CONV }));
    expect(res.statusCode).toBe(200);
    expect(asked()).toEqual([{ aeMeeting: 'admit', meetingChannelArn: MEETING_CONV, personArn: PERSON_ARN, parentChannelArn: ROOM }]);
  });

  it('a person in neither conversation is admitted to nothing', async () => {
    mockReach.mockResolvedValue({ ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false });
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
    const res = await handler(event('/meetings/join', { channelArn: MEETING_CONV }));
    expect(res.statusCode).toBe(403);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(sent('CreateAttendee')).toHaveLength(0);
  });

  describe('who may end the meeting, from the room and without joining', () => {
    const mockMessaging = jest.fn();
    const moderatorOf = (...arns: string[]) => mockMessaging.mockImplementation(async (cmd: { input: { ChannelArn: string; ChannelModeratorArn: string; ChimeBearer: string } }) => {
      // The read bears the caller, about the caller.
      expect(cmd.input.ChimeBearer).toBe(PERSON_ARN);
      expect(cmd.input.ChannelModeratorArn).toBe(PERSON_ARN);
      if (arns.includes(cmd.input.ChannelArn)) return { ChannelModerator: { Moderator: { Arn: PERSON_ARN } } };
      throw Object.assign(new Error('x'), { name: 'NotFoundException' });
    });
    const running = (record: Record<string, unknown>) => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: record };
    };
    beforeEach(() => {
      __setClients({ messaging: { send: mockMessaging } as never });
      moderatorOf();
    });

    it('a member of the room who neither started it nor moderates the room cannot end it', async () => {
      running({ ...RECORD, createdBy: 'person-2' });
      const res = await handler(event('/meetings/end', inRoom()));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('NOT_PERMITTED_TO_END');
      expect(sent('DeleteMeeting')).toHaveLength(0);
    });

    it('the person who started it ends it from the room without having joined', async () => {
      running(RECORD);
      const res = await handler(event('/meetings/end', inRoom()));
      expect(JSON.parse(res.body)).toEqual({ ended: true });
      expect(sent('DeleteMeeting')[0].input.MeetingId).toBe('m-1');
      expect(mockRelease).toHaveBeenCalledWith(MEETING_CONV, 'm-1', expect.any(String));
    });

    it("the room's moderator (its lead, its on-call) ends a meeting a workflow started as the assistant", async () => {
      running({ ...RECORD, createdBy: 'ops-bot', startedVia: 'workflow' });
      moderatorOf(ROOM);
      const res = await handler(event('/meetings/end', inRoom()));
      expect(JSON.parse(res.body)).toEqual({ ended: true });
      expect(sent('DeleteMeeting')).toHaveLength(1);
    });

    it('a moderator read that fails denies', async () => {
      running({ ...RECORD, createdBy: 'ops-bot', startedVia: 'workflow' });
      mockMessaging.mockRejectedValue(Object.assign(new Error('x'), { name: 'ThrottledClientException' }));
      expect((await handler(event('/meetings/end', inRoom()))).statusCode).toBe(403);
      expect(sent('DeleteMeeting')).toHaveLength(0);
    });

    it('a status read tells the reader whether they may end it, so the room offers End only to them', async () => {
      running({ ...RECORD, createdBy: 'ops-bot', startedVia: 'workflow' });
      expect(JSON.parse((await handler(event('/meetings/status', inRoom()))).body)).toMatchObject({ running: true, mayEnd: false });
      moderatorOf(ROOM);
      expect(JSON.parse((await handler(event('/meetings/status', inRoom()))).body)).toMatchObject({ running: true, mayEnd: true });
    });

    it('the host a workflow\'s meeting recorded ends it without being a moderator', async () => {
      running({ ...RECORD, createdBy: 'ops-bot', startedVia: 'workflow', hosts: [{ personId: PERSON, role: 'on-call:ops' }], hostVia: 'role' });
      const res = await handler(event('/meetings/end', inRoom()));
      expect(JSON.parse(res.body)).toEqual({ ended: true });
    });
  });

  describe('the hosts (FR50): the room\'s host roles, else whoever starts it', () => {
    const INCIDENT = (lead: string) => ({ conversationType: 'ops', participantRoles: { lead: { [lead]: { origin: 'event' } } } });
    // Nobody here moderates anything: the host alone decides.
    beforeEach(() => {
      __setClients({ messaging: { send: async () => { throw Object.assign(new Error('x'), { name: 'NotFoundException' }); } } as never });
    });

    describe("an incident's on-call and its secondary on-call both host; a responder does not", () => {
      const ON_CALL_ROOM = {
        conversationType: 'ops',
        participantRoles: {
          'on-call:ops': { 'oncall-1': { origin: 'group' } },
          'secondary:ops': { 'second-1': { origin: 'group' } },
          responder: { [PERSON]: { origin: 'group' } },
        },
      };
      const HOSTS = [{ personId: 'oncall-1', role: 'on-call:ops' }, { personId: 'second-1', role: 'secondary:ops' }];
      const as = (person: string) => mockPersonId.mockResolvedValue(person);

      it('each starts it, recorded with both as hosts', async () => {
        for (const person of ['oncall-1', 'second-1']) {
          mockClaim.mockClear();
          rows[ROOM] = { ...ON_CALL_ROOM };
          as(person);
          const res = await handler(event('/meetings', inRoom()));
          expect(res.statusCode).toBe(201);
          expect(JSON.parse(res.body)).toMatchObject({ isHost: true, mayEnd: true });
          expect(mockClaim).toHaveBeenCalledWith(MEETING_CONV, expect.objectContaining({ hosts: HOSTS, hostVia: 'role' }));
        }
      });

      it('each ends it for everyone, and a responder is refused', async () => {
        const runningIt = () => {
          rows[ROOM] = { ...ON_CALL_ROOM, meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
          rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: { ...RECORD, createdBy: 'ops-bot', startedVia: 'workflow', hosts: HOSTS, hostVia: 'role' } };
        };
        runningIt();
        as(PERSON);
        const refused = await handler(event('/meetings/end', inRoom()));
        expect(refused.statusCode).toBe(403);
        expect(JSON.parse(refused.body).code).toBe('NOT_PERMITTED_TO_END');
        expect(sent('DeleteMeeting')).toHaveLength(0);
        for (const person of ['oncall-1', 'second-1']) {
          runningIt();
          as(person);
          expect(JSON.parse((await handler(event('/meetings/end', inRoom()))).body)).toEqual({ ended: true });
        }
        expect(sent('DeleteMeeting')).toHaveLength(2);
      });

      it('each starts it again after it ended, and a responder may not', async () => {
        const ended = () => {
          rows[ROOM] = { ...ON_CALL_ROOM, meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
          rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, lastMeeting: { meetingId: 'm-0', createdAt: 'x', createdBy: 'oncall-1' } };
        };
        ended();
        as(PERSON);
        const refused = await handler(event('/meetings', inRoom()));
        expect(JSON.parse(refused.body).code).toBe('NOT_HOST');
        expect(sent('CreateMeeting')).toHaveLength(0);
        for (const person of ['oncall-1', 'second-1']) {
          ended();
          as(person);
          expect((await handler(event('/meetings', inRoom()))).statusCode).toBe(201);
        }
        expect(sent('CreateMeeting')).toHaveLength(2);
      });
    });

    it("a person's start in a room whose lead is someone else is refused, and opens nothing", async () => {
      rows[ROOM] = INCIDENT('lead-1');
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('NOT_HOST');
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(sent('CreateMeeting')).toHaveLength(0);
      expect(mockClaimConversation).not.toHaveBeenCalled();
    });

    it("the room's lead starts it, and is recorded its host by the role", async () => {
      rows[ROOM] = INCIDENT(PERSON);
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toMatchObject({ isHost: true, mayEnd: true });
      expect(mockClaim).toHaveBeenCalledWith(MEETING_CONV, expect.objectContaining({ hosts: [{ personId: PERSON, role: 'lead' }], hostVia: 'role' }));
    });

    it('a member who is not the host joins the meeting that runs through the start route', async () => {
      rows[ROOM] = { ...INCIDENT('lead-1'), meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: { ...RECORD, createdBy: 'lead-1', hosts: [{ personId: 'lead-1', role: 'lead' }], hostVia: 'role' } };
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ created: false, isHost: false });
      expect(sent('CreateMeeting')).toHaveLength(0);
    });

    it("a workflow's meeting takes the room's lead as its host", async () => {
      rows[ROOM] = INCIDENT('lead-1');
      const out = await runHandler({ channelArn: ROOM, startedBy: 'ops-bot' });
      expect(out).toMatchObject({ ok: true, created: true });
      expect(mockClaim).toHaveBeenCalledWith(MEETING_CONV, expect.objectContaining({ createdBy: 'ops-bot', startedVia: 'workflow', hosts: [{ personId: 'lead-1', role: 'lead' }], hostVia: 'role' }));
    });

    it("a workflow's meeting in a parent conversation with no host role held is hosted by the parent conversation's moderators the creator read", async () => {
      mockInvoke.mockResolvedValue(answer({ ok: true, channelArn: MEETING_CONV, roomModeratorIds: ['mod-1', 'mod-2'] }));
      const out = await runHandler({ channelArn: ROOM, startedBy: 'ops-bot' });
      expect(out).toMatchObject({ ok: true, created: true });
      expect(mockClaim).toHaveBeenCalledWith(MEETING_CONV, expect.objectContaining({
        createdBy: 'ops-bot', startedVia: 'workflow', hosts: [{ personId: 'mod-1' }, { personId: 'mod-2' }], hostVia: 'moderators',
      }));
    });

    it('in a room with no host role, whoever starts it hosts it', async () => {
      await handler(event('/meetings', inRoom()));
      expect(mockClaim).toHaveBeenCalledWith(MEETING_CONV, expect.objectContaining({ hosts: [{ personId: PERSON }], hostVia: 'starter' }));
    });

    it("a meeting's own conversation says its meeting ended, and whether the reader may start it again", async () => {
      rows[ROOM] = { ...INCIDENT('lead-1'), meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, lastMeeting: { meetingId: 'm-0', createdAt: 'x', createdBy: 'lead-1' } };
      mockReach.mockResolvedValue({ ok: true, channelArn: MEETING_CONV, classification: 'premium' });
      const body = JSON.parse((await handler(event('/meetings/status', { channelArn: MEETING_CONV }))).body);
      expect(body).toMatchObject({ running: false, ended: true, mayStart: false });
      rows[ROOM] = { ...INCIDENT(PERSON), meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      expect(JSON.parse((await handler(event('/meetings/status', { channelArn: MEETING_CONV }))).body)).toMatchObject({ ended: true, mayStart: true });
    });

    it("a stale record the service has ended offers no Join: the status read releases it", async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD, lastMeeting: { meetingId: 'm-1', createdAt: 'x', createdBy: PERSON } };
      mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
        if (cmd.__type === 'GetMeeting') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
        return {};
      });
      const body = JSON.parse((await handler(event('/meetings/status', inRoom()))).body);
      expect(body.running).toBe(false);
      expect(mockRelease).toHaveBeenCalledWith(MEETING_CONV, 'm-1', expect.any(String));
    });
  });

  it("a status read from the meeting's link, by a member of its room not yet in it, answers as the join would, and admits nobody", async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: { ...RECORD, createdBy: 'someone', hosts: [{ personId: 'someone' }] } };
    const res = await handler(event('/meetings/status', { channelArn: MEETING_CONV }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ running: true, conversationId: 'meet-1', roomConversationId: 'room-1' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(sent('CreateAttendee')).toHaveLength(0);
  });

  it('DENY: a status read from the link of a meeting the room has moved on from, or by a person in neither conversation, answers nothing of it', async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: `${APP_INSTANCE}/channel/meet-2`, at: 'x' } };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
    expect((await handler(event('/meetings/status', { channelArn: MEETING_CONV }))).statusCode).toBe(409);
    mockReach.mockResolvedValue({ ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false });
    const res = await handler(event('/meetings/status', { channelArn: MEETING_CONV }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).running).toBeUndefined();
  });

  it('a status read from the conversation says the meeting runs and where, and admits nobody', async () => {
    rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
    rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
    const body = JSON.parse((await handler(event('/meetings/status', inRoom()))).body);
    expect(body).toMatchObject({ running: true, conversationId: 'meet-1' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("a workflow's start opens the meeting's conversation for nobody and answers it", async () => {
    const out = await runHandler({ channelArn: ROOM, startedBy: 'ops-bot' });
    expect(out).toEqual({ ok: true, meetingId: 'm-1', created: true, meetingConversationArn: MEETING_CONV, ringSeconds: 10 });
    expect(asked()).toEqual([{ aeMeeting: 'open', parentChannelArn: ROOM }]);
  });

  describe('one meeting per room, held by one claim', () => {
    const fresh = () => new Date().toISOString();

    it('a start that reads the room while another start holds it goes to the conversation it names, and opens no second', async () => {
      // The other start opened the meeting's conversation and has not yet recorded its meeting there.
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, opening: 'their-token', at: fresh() } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM };
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).conversationId).toBe('meet-1');
      expect(mockClaimConversation).not.toHaveBeenCalled();
      expect(asked().filter((a) => a.aeMeeting === 'open')).toEqual([]);
      expect(mockClaim).toHaveBeenCalledWith(MEETING_CONV, expect.anything());
    });

    it("a start while another holds the room's claim with no conversation yet is told the meeting is starting", async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { opening: 'their-token', at: fresh() } };
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('MEETING_STARTING');
      expect(mockClaimConversation).not.toHaveBeenCalled();
      expect(sent('CreateMeeting')).toHaveLength(0);
    });

    it('a room whose record cannot be read is an outage, never a room with no meeting', async () => {
      mockGetContext.mockImplementation(async (arn: string) => {
        if (arn === ROOM) throw Object.assign(new Error('ProvisionedThroughputExceededException'), { name: 'ChannelContextUnreadable' });
        return rows[arn] ?? null;
      });
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe('UNAVAILABLE');
      expect(mockClaimConversation).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('a meeting conversation whose record cannot be read is not taken over', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      mockGetContext.mockImplementation(async (arn: string) => {
        if (arn === MEETING_CONV) throw Object.assign(new Error('x'), { name: 'ChannelContextUnreadable' });
        return rows[arn] ?? null;
      });
      expect((await handler(event('/meetings', inRoom()))).statusCode).toBe(503);
      expect(mockClaimConversation).not.toHaveBeenCalled();
    });

    it("a creator that opens nothing gives the room's claim back, so the next start is not held off", async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, lastMeeting: { meetingId: 'm-0', createdAt: 'x', createdBy: PERSON } };
      mockInvoke.mockResolvedValue(answer({ ok: false, code: 'FAILED' }));
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(502);
      const token = mockClaimConversation.mock.calls[0][2];
      expect(mockReleaseConversation).toHaveBeenCalledWith(ROOM, token, MEETING_CONV);
    });

    it('a meeting that could not be created gives the claim back, keeping the conversation it opened', async () => {
      mockMeetingsSend.mockImplementation(async () => ({}));
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).code).toBe('CREATE_FAILED');
      expect(mockReleaseConversation).toHaveBeenCalledWith(ROOM, mockClaimConversation.mock.calls[0][2], MEETING_CONV);
      expect(mockConfirmConversation).not.toHaveBeenCalled();
    });

    it('a meeting conversation that never held a meeting is held again rather than left empty beside a new one', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      const res = await handler(event('/meetings', inRoom()));
      expect(res.statusCode).toBe(201);
      expect(mockClaimConversation).toHaveBeenCalledWith(ROOM, MEETING_CONV, expect.any(String), { reuse: true });
      expect(asked().filter((a) => a.aeMeeting === 'open')).toEqual([]);
      expect(mockConfirmConversation).toHaveBeenCalledWith(ROOM, MEETING_CONV);
    });

    it("a start in an older meeting's conversation, reached from an old link, holds no meeting there", async () => {
      const NEWER = `${APP_INSTANCE}/channel/meet-2`;
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: NEWER, at: 'x' } };
      mockReach.mockResolvedValue({ ok: true, channelArn: MEETING_CONV, classification: 'premium' });
      const res = await handler(event('/meetings', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('MEETING_MOVED');
      expect(sent('CreateMeeting')).toHaveLength(0);
    });

    it("a start again in an ended meeting's own conversation opens the room's next meeting in a new conversation, and keeps the ended one's record", async () => {
      const NEXT = `${APP_INSTANCE}/channel/meet-2`;
      mockInvoke.mockResolvedValue(answer({ ok: true, channelArn: NEXT }));
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, lastMeeting: { meetingId: 'm-0', createdAt: 'x', createdBy: PERSON } };
      mockReach.mockResolvedValue({ ok: true, channelArn: MEETING_CONV, classification: 'premium' });
      const res = await handler(event('/meetings', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(201);
      expect(mockClaimConversation).toHaveBeenCalledWith(ROOM, MEETING_CONV, expect.any(String), { reuse: false });
      expect(asked()).toEqual([{ aeMeeting: 'open', parentChannelArn: ROOM, forUserArn: PERSON_ARN }]);
      // The new meeting is the new conversation's; the ended one's record (its lastMeeting) is never written over.
      expect(mockClaim).toHaveBeenCalledWith(NEXT, expect.objectContaining({ createdBy: PERSON }));
      expect(mockClaim).not.toHaveBeenCalledWith(MEETING_CONV, expect.anything());
      expect(mockConfirmConversation).toHaveBeenCalledWith(ROOM, NEXT);
      expect(JSON.parse(res.body)).toMatchObject({ conversationId: 'meet-2', roomConversationId: 'room-1' });
    });

    it("a start again from an archived meeting's conversation opens the room's next meeting, and holds nothing in the archived one", async () => {
      const NEXT = `${APP_INSTANCE}/channel/meet-2`;
      mockInvoke.mockResolvedValue(answer({ ok: true, channelArn: NEXT }));
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, lastMeeting: { meetingId: 'm-0', createdAt: 'x', createdBy: PERSON } };
      mockReach.mockImplementation(async (_e: unknown, conv: string) => (conv === MEETING_CONV
        ? { ok: true, channelArn: MEETING_CONV, classification: 'premium', tags: { classification: 'premium', archived: 'true' } }
        : { ok: true, channelArn: ROOM, classification: 'premium' }));
      const res = await handler(event('/meetings', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).conversationId).toBe('meet-2');
      expect(mockClaim).not.toHaveBeenCalledWith(MEETING_CONV, expect.anything());
      // A join there is still refused: nothing runs in an archived conversation.
      expect((await handler(event('/meetings/join', { channelArn: MEETING_CONV }))).statusCode).toBe(409);
    });

    it('DENY: a person added to the meeting alone starts nothing in the room: no conversation, no meeting, no host', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, lastMeeting: { meetingId: 'm-0', createdAt: 'x', createdBy: 'someone' } };
      // A member of the meeting's conversation, and of nothing else.
      mockReach.mockImplementation(async (_e: unknown, conv: string) => (conv === MEETING_CONV
        ? { ok: true, channelArn: MEETING_CONV, classification: 'premium' }
        : { ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false }));
      const res = await handler(event('/meetings', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('NOT_HOST');
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockClaimConversation).not.toHaveBeenCalled();
      expect(sent('CreateMeeting')).toHaveLength(0);
      // And the meeting's conversation does not offer them a start.
      expect(JSON.parse((await handler(event('/meetings/status', { channelArn: MEETING_CONV }))).body)).toMatchObject({ running: false, mayStart: false });
    });

    it('a person added to the meeting alone still joins the meeting that runs, through the start route', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: { ...RECORD, createdBy: 'someone', hosts: [{ personId: 'someone' }] } };
      mockReach.mockImplementation(async (_e: unknown, conv: string) => (conv === MEETING_CONV
        ? { ok: true, channelArn: MEETING_CONV, classification: 'premium' }
        : { ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false }));
      const res = await handler(event('/meetings', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ created: false, isHost: false });
    });
  });

  describe("who enters a meeting's conversation", () => {
    it('a join from an old link admits nobody when no meeting runs there', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      const res = await handler(event('/meetings/join', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(404);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('a join from the link of a meeting the room has moved on from admits nobody', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: `${APP_INSTANCE}/channel/meet-2`, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
      const res = await handler(event('/meetings/join', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('MEETING_MOVED');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("a start from the link of the room's current meeting admits a member of the room, as a join does", async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
      const res = await handler(event('/meetings', { channelArn: MEETING_CONV }));
      expect(res.statusCode).toBe(200);
      expect(asked()).toEqual([{ aeMeeting: 'admit', meetingChannelArn: MEETING_CONV, personArn: PERSON_ARN, parentChannelArn: ROOM }]);
    });

    it.each(['/meetings', '/meetings/join'])('%s in an archived conversation is refused, and nothing is opened or admitted', async (path) => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
      mockReach.mockImplementation(async (_e: unknown, conv: string) => (conv === ROOM
        ? { ok: true, channelArn: ROOM, classification: 'premium', tags: { classification: 'premium', archived: 'true' } }
        : { ok: false, status: 403, code: 'NOT_A_MEMBER', memberProven: false }));
      const res = await handler(event(path, inRoom()));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('CONVERSATION_ARCHIVED');
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(sent('CreateMeeting')).toHaveLength(0);
    });

    it('a start from the room that finds its meeting running reads that meeting once', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: RECORD };
      await handler(event('/meetings', inRoom()));
      expect(sent('GetMeeting')).toHaveLength(1);
    });
  });

  describe('what a late arrival is told', () => {
    it('a status read says which room the meeting belongs to and how much of its ring is left, on the server clock', async () => {
      rows[ROOM] = { conversationType: 'general', meetingConversation: { channelArn: MEETING_CONV, at: 'x' } };
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: { ...RECORD, createdAt: new Date(Date.now() - 4_000).toISOString(), ringSeconds: 30 } };
      const body = JSON.parse((await handler(event('/meetings/status', inRoom()))).body);
      expect(body.roomConversationId).toBe('room-1');
      expect(body.ringSecondsLeft).toBeGreaterThanOrEqual(25);
      expect(body.ringSecondsLeft).toBeLessThanOrEqual(26);
    });

    it("says no ring is left once it is over, and names the room from the meeting's own conversation too", async () => {
      rows[MEETING_CONV] = { conversationType: 'meeting', meetingOf: ROOM, activeMeeting: { ...RECORD, ringSeconds: 10 } };
      mockReach.mockResolvedValue({ ok: true, channelArn: MEETING_CONV, classification: 'premium' });
      const body = JSON.parse((await handler(event('/meetings/status', { channelArn: MEETING_CONV }))).body);
      expect(body.ringSecondsLeft).toBeUndefined();
      expect(body.roomConversationId).toBe('room-1');
      expect(body.conversationId).toBe('meet-1');
    });

    it("a workflow's start records the ring its step asked for", async () => {
      const out = await runHandler({ channelArn: ROOM, startedBy: 'ops-bot', ringSeconds: 45 });
      expect(mockClaim.mock.calls[0][1]).toMatchObject({ ringSeconds: 45 });
      // The run is answered the length the meeting records, so its ring is that length and no other.
      expect(out).toMatchObject({ ok: true, ringSeconds: 45 });
    });
  });
});

describe('the console ends a meeting through the run entry (`end-meetings`)', () => {
  it('ends the meeting the conversation holds now through the same end a host uses: the service deletes it and the record is released', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: true });
    expect(sent('DeleteMeeting')[0].input).toEqual({ MeetingId: 'm-1' });
    expect(mockRelease).toHaveBeenCalledWith(CHANNEL, 'm-1', expect.any(String));
  });

  it('ends nothing when the conversation holds another meeting, or none', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: { ...RECORD, meetingId: 'm-2' } });
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'NOT_RUNNING' });
    mockGetContext.mockResolvedValue(null);
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'NOT_RUNNING' });
    expect(sent('DeleteMeeting')).toHaveLength(0);
  });

  it('refuses a conversation of another app instance before reading anything', async () => {
    expect(await runHandler({ op: 'end', channelArn: 'arn:aws:chime:us-east-1:999:app-instance/other/channel/c1', meetingId: 'm-1' }))
      .toEqual({ ok: false, code: 'INVALID_CONVERSATION' });
    expect(mockGetContext).not.toHaveBeenCalled();
  });

  it('keeps the record when the service could not delete the meeting', async () => {
    mockGetContext.mockResolvedValue({ activeMeeting: RECORD });
    mockMeetingsSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'DeleteMeeting') throw Object.assign(new Error('x'), { name: 'ServiceFailureException' });
      return {};
    });
    expect(await runHandler({ op: 'end', channelArn: CHANNEL, meetingId: 'm-1' })).toEqual({ ok: false, code: 'END_FAILED' });
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe('the creator is asked once', () => {
  it('a call to the creator is never retried by the client, so a slow open never opens a second conversation', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../lambda/src/meeting-api.ts'), 'utf8') as string;
    const client = /let lambda: Pick<LambdaClient, 'send'> = new LambdaClient\(\{([\s\S]*?)\}\);/.exec(source)?.[1] ?? '';
    expect(client).toMatch(/maxAttempts: 1\b/);
  });
});
