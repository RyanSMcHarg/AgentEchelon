/**
 * Meeting lifecycle consumer - the roster's source (SPEC-ASSISTANT-MEETINGS FR18/FR22).
 *
 * What these pin, in order of how badly each would hurt:
 *
 *   - A DROP IS TOLD FROM A DEPARTURE. Nothing the meeting API can see distinguishes somebody who
 *     left from somebody whose connection failed; the operator goal for this phase asks for exactly
 *     that split, and this consumer is the only place it exists.
 *   - A FAILED WRITE THROWS. Everywhere else on this platform a store failure degrades (tenet 5),
 *     because a less personal reply is better than none. A roster with a missing arrival is simply
 *     wrong and nothing downstream can detect the gap, so this one re-raises and lets EventBridge
 *     retry and then dead-letter it. The ingest is idempotent, which is what makes that safe.
 *   - A CONVERSATION WITH NO DECLARED CLASSIFICATION DOES NOT DISCARD THE EVENT. It files it where the
 *     fewest people can read it. A tag read that FAILED is not that: it throws and is retried, so nothing
 *     is filed or handed to a router under a guess.
 *   - ONLY THIS DEPLOYMENT'S MEETINGS ARE FILED. A meeting whose conversation this app instance does
 *     not hold is another application's, and is skipped.
 *   - THE SCREEN SHARE IS NOT A PARTICIPANT. It joins as its own attendee with the owner's external
 *     user id, so it has to be marked, or a roster counts a screen as a person.
 */
const mockIngest = jest.fn();
const mockHasDataPlane = jest.fn();
jest.mock('../lambda/src/lib/data-plane-client', () => ({
  hasDataPlane: () => mockHasDataPlane(),
  ingestMeetingEvents: (...a: unknown[]) => mockIngest(...a),
}));

/**
 * The conversation's tag read, as the service answers it: a classification (a string), a conversation with none
 * (`undefined`), or a failure (an `Error` with the service's name).
 */
const mockReadClassification = jest.fn();
const mockTagSend = jest.fn(async () => {
  const v = await mockReadClassification();
  if (v instanceof Error) throw v;
  return { Tags: v === undefined ? [] : [{ Key: 'classification', Value: v }] };
});
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => (mockTagSend as (...x: unknown[]) => unknown)(...a) })),
  ListTagsForResourceCommand: class { constructor(public input: unknown) {} },
}), { virtual: true });
const serviceError = (name: string): Error => Object.assign(new Error(name), { name });

const mockPutLines = jest.fn();
/** This deployment's conversation record: by default it names the meeting the event is about. */
const mockReadRow = jest.fn();
const mockJoin = jest.fn();
jest.mock('../lambda/src/lib/channel-context-client', () => ({
  readChannelContext: (...a: unknown[]) => mockReadRow(...a),
  recordMeetingJoin: (...a: unknown[]) => mockJoin(...a),
}));

jest.mock('../lambda/src/lib/event-archive', () => ({
  ensureDataPlaneArn: async () => undefined,
  putArchiveLines: (...a: unknown[]) => mockPutLines(...a),
}));

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP_INSTANCE;
process.env.MEETING_EVENTS_DELIVERY_STREAM = 'test-meeting-events';
process.env.AURORA_DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:DataPlane';

import { handler, __setBus } from '../lambda/src/meeting-events';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

/**
 * The value an unreadable tag is filed at, read from the registry rather than written down here.
 *
 * It is NOT a distinct 'unknown' value, and on this deployment's ladder it happens to be `premium` -
 * the classification the FEWEST holders reach. So a test that asserted 'not premium' would be
 * asserting the opposite of the contract while looking correct, which is why the readable value in
 * these two tests is 'standard'.
 */
const MOST_RESTRICTIVE = profiles.failClosedContentValue;

function evt(detail: Record<string, unknown>) {
  return { detail } as never;
}

/** The record the consumer produced. */
const filed = () => mockIngest.mock.calls[0][0][0] as Record<string, unknown>;

const BASE = {
  eventType: 'chime:AttendeeJoined',
  timestamp: Date.parse('2026-10-01T14:02:00.000Z'),
  meetingId: 'm-1',
  attendeeId: 'att-1',
  externalUserId: 'alice',
  mediaRegion: 'us-east-1',
  networkType: 'Wifi',
};

/**
 * A FRESH CONVERSATION PER TEST, which the consumer's cache makes necessary.
 *
 * It caches a conversation's classification for the life of the container - sound, because the tag is
 * immutable - so one channel id shared across tests would let the first test's cached read answer
 * every later one. Two of these tests assert cache behavior directly and would have passed for the
 * wrong reason. Each test gets its own conversation, so a cache assertion has to earn its result.
 */
let channelSeq = 0;
const channel = () => `c${channelSeq}`;
const joined = (over: Record<string, unknown> = {}) => ({
  ...BASE, externalMeetingId: channel(), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APP_INSTANCE_ARN = APP_INSTANCE;
  mockHasDataPlane.mockReturnValue(true);
  mockIngest.mockResolvedValue({ inserted: 1, duplicates: 0 });
  mockPutLines.mockResolvedValue({ delivered: 1, dropped: 0 });
  mockReadClassification.mockResolvedValue('premium');
  mockReadRow.mockResolvedValue({ activeMeeting: { meetingId: 'm-1' }, lastMeeting: { meetingId: 'm-1' } });
  mockJoin.mockResolvedValue('recorded');
  channelSeq += 1;
});

describe('the conversation a meeting belongs to', () => {
  it('is DERIVED from the external meeting id, with no lookup', async () => {
    await handler(evt(joined()));
    expect(filed().channel_arn).toBe(`${APP_INSTANCE}/channel/${channel()}`);
    // A lookup through the active-meeting record would find nothing exactly when the most
    // interesting events land: these arrive after the meeting has ended and been cleared.
    expect(filed().meeting_id).toBe('m-1');
  });

  it('files the event when Lambda hands it its context as the second argument, as every invoke does', async () => {
    await handler(...([evt(joined()), { functionName: 'MeetingEvents', awsRequestId: 'r-1' }] as unknown as [Parameters<typeof handler>[0]]));
    expect(filed().meeting_id).toBe('m-1');
  });

  it('refuses to file anything when the app instance is unconfigured', async () => {
    delete process.env.APP_INSTANCE_ARN;
    await handler(evt(joined()));
    // A row whose conversation key is unusable is worse than no row: the roster is read through it.
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('skips an event that names no meeting rather than filing a row keyed on nothing', async () => {
    await handler(evt({ eventType: 'chime:AttendeeJoined', externalMeetingId: channel() }));
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('what the roster needs that nothing else can supply', () => {
  it('tells a DROP from a departure, which the meeting API cannot', async () => {
    await handler(evt(joined({ eventType: 'chime:AttendeeDropped' })));
    expect(filed().event_type).toBe('AttendeeDropped');
    mockIngest.mockClear();
    await handler(evt(joined({ eventType: 'chime:AttendeeLeft' })));
    expect(filed().event_type).toBe('AttendeeLeft');
  });

  it('strips the constant service prefix and keeps the event name otherwise unmapped', async () => {
    await handler(evt(joined({
      eventType: 'chime:MeetingEnded', attendeeId: undefined, externalUserId: undefined,
    })));
    expect(filed().event_type).toBe('MeetingEnded');
    // A meeting-level event belongs to no attendee, and that is a null rather than an invention.
    expect(filed().attendee_id).toBeNull();
    expect(filed().person_key).toBeNull();
  });

  it('keeps every meeting state change the service emits, not only the five the roster reads today', async () => {
    const all = [
      'MeetingStarted', 'MeetingEnded', 'AttendeeAdded', 'AttendeeJoined', 'AttendeeLeft', 'AttendeeDropped', 'AttendeeDeleted',
      'AttendeeAuthorized', 'AttendeeVideoStarted', 'AttendeeVideoStopped', 'AttendeeContentJoined', 'AttendeeContentLeft',
      'AttendeeContentDropped', 'AttendeeContentVideoStarted', 'AttendeeContentVideoStopped',
    ];
    for (const t of all) await handler(evt(joined({ eventType: `chime:${t}` })));
    expect(mockPutLines.mock.calls.map((c) => c[1][0].event_type)).toEqual(all);
  });

  it('passes an unprefixed event type through unchanged, rather than slicing six characters off it', async () => {
    await handler(evt(joined({ eventType: 'AttendeeJoined' })));
    expect(filed().event_type).toBe('AttendeeJoined');
  });

  it('records the transport, because the CHANGE is the interesting part', async () => {
    await handler(evt(joined({ networkType: 'Cellular' })));
    expect(filed().network_transport).toBe('Cellular');
  });

  it('uses the service timestamp, so a redelivery cannot reorder the timeline', async () => {
    await handler(evt(joined()));
    expect(filed().event_at).toBe('2026-10-01T14:02:00.000Z');
  });

  it('without a service timestamp, uses the envelope time a redelivered copy carries unchanged', async () => {
    const detail = joined({ timestamp: undefined });
    await handler({ detail, time: '2026-10-01T14:09:00Z' } as never);
    await handler({ detail, time: '2026-10-01T14:09:00Z' } as never);
    expect(mockIngest.mock.calls[0][0][0].event_at).toBe('2026-10-01T14:09:00.000Z');
    expect(mockIngest.mock.calls[1][0][0].event_at).toBe('2026-10-01T14:09:00.000Z');
  });

  it('files nothing for an event with no time at all, rather than one no redelivery would match', async () => {
    await handler(evt(joined({ timestamp: undefined })));
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('keeps the facts it does not map, rather than dropping them in translation', async () => {
    await handler(evt(joined({ transitionReason: 'NORMAL' })));
    expect(filed().detail).toEqual({
      mediaRegion: 'us-east-1',
      transitionReason: 'NORMAL',
      externalMeetingId: channel(),
    });
  });
});

describe('a screen share is not a person', () => {
  it('marks the content attendee by its id suffix, attributed to its owner', async () => {
    await handler(evt(joined({ attendeeId: 'att-1#content' })));
    expect(filed().is_content).toBe(true);
    // The owner's key, so the share folds onto their roster row instead of counting as a participant.
    expect(filed().person_key).toBe('alice');
  });

  it('marks it by the event name too, so a change to the suffix does not silently reclassify it', async () => {
    await handler(evt(joined({ eventType: 'chime:AttendeeContentJoined', attendeeId: 'att-9' })));
    expect(filed().is_content).toBe(true);
  });

  it('leaves an ordinary attendee unmarked', async () => {
    await handler(evt(joined()));
    expect(filed().is_content).toBe(false);
    expect(filed().person_key).toBe('alice');
  });
});

describe('a conversation with no declared classification', () => {
  it('files the event at the most restrictive value instead of discarding it', async () => {
    mockReadClassification.mockResolvedValue(undefined);
    await handler(evt(joined()));
    // The row EXISTS - discarding it would lose an arrival permanently - and sits where the fewest
    // principals can read it.
    expect(mockIngest).toHaveBeenCalled();
    expect(filed().classification).toBe(MOST_RESTRICTIVE);
  });

  it('hands its start to no router, because no router is its classification', async () => {
    const sendBus = jest.fn().mockResolvedValue({ FailedEntryCount: 0 });
    __setBus({ send: sendBus } as never);
    process.env.MEETING_LIFECYCLE_INSTANCE = 'test-instance';
    try {
      mockReadClassification.mockResolvedValue(undefined);
      await handler(evt(joined({ eventType: 'chime:MeetingStarted' })));
      expect(mockIngest).toHaveBeenCalled();
      expect(sendBus).not.toHaveBeenCalled();
    } finally {
      delete process.env.MEETING_LIFECYCLE_INSTANCE;
    }
  });
});

describe('a tag read that fails', () => {
  it('THROWS, filing and handing on nothing, so EventBridge retries the event under its real classification', async () => {
    const sendBus = jest.fn().mockResolvedValue({ FailedEntryCount: 0 });
    __setBus({ send: sendBus } as never);
    process.env.MEETING_LIFECYCLE_INSTANCE = 'test-instance';
    try {
      mockReadClassification.mockResolvedValue(serviceError('ThrottledClientException'));
      await expect(handler(evt(joined({ eventType: 'chime:MeetingStarted' })))).rejects.toThrow('ThrottledClientException');
      expect(mockPutLines).not.toHaveBeenCalled();
      expect(mockIngest).not.toHaveBeenCalled();
      expect(sendBus).not.toHaveBeenCalled();
    } finally {
      delete process.env.MEETING_LIFECYCLE_INSTANCE;
    }
  });

  it('is not remembered, so the retry reads the tag again and files at the real classification', async () => {
    // 'standard' rather than 'premium', because premium IS the most-restrictive value on this
    // ladder and the two would be indistinguishable.
    mockReadClassification.mockResolvedValueOnce(serviceError('ServiceUnavailableException')).mockResolvedValue('standard');
    await expect(handler(evt(joined()))).rejects.toThrow();
    await handler(evt(joined()));
    expect(filed().classification).toBe('standard');
  });

  it('a SUCCESSFUL read is remembered, because the tag is immutable and a busy meeting is many events', async () => {
    await handler(evt(joined()));
    await handler(evt(joined({ eventType: 'chime:AttendeeLeft' })));
    await handler(evt(joined({ eventType: 'chime:AttendeeVideoStarted' })));
    // One read for the conversation, not one per event.
    expect(mockReadClassification).toHaveBeenCalledTimes(1);
  });
});

describe("only this deployment's meetings are filed", () => {
  it("skips another deployment's meeting in a conversation with the same channel id, such as a team room", async () => {
    mockReadRow.mockResolvedValue({ lastMeeting: { meetingId: 'm-ours' } });
    await expect(handler(evt(joined({ meetingId: 'm-theirs', externalMeetingId: 'team-incident-standard' })))).resolves.toBeUndefined();
    expect(mockReadRow).toHaveBeenCalledWith(`${APP_INSTANCE}/channel/team-incident-standard`, { consistent: true });
    expect(mockPutLines).not.toHaveBeenCalled();
    expect(mockTagSend).not.toHaveBeenCalled();
  });

  it('files a meeting this deployment recorded on the conversation, running or last', async () => {
    mockReadRow.mockResolvedValue({ lastMeeting: { meetingId: 'm-last' } });
    await handler(evt(joined({ meetingId: 'm-last', eventType: 'chime:AttendeeLeft' })));
    expect(filed().meeting_id).toBe('m-last');
  });

  it("THROWS when the conversation record cannot be read, never reading it as another deployment's", async () => {
    mockReadRow.mockRejectedValue(Object.assign(new Error('ProvisionedThroughputExceededException'), { name: 'ChannelContextUnreadable' }));
    await expect(handler(evt(joined({ meetingId: 'm-unread' })))).rejects.toThrow();
    expect(mockPutLines).not.toHaveBeenCalled();
  });

  it('retries a fresh start the record does not name yet, since the meeting API records it just after creating it', async () => {
    mockReadRow.mockResolvedValue(null);
    await expect(handler(evt(joined({ meetingId: 'm-fresh', eventType: 'chime:MeetingStarted', timestamp: Date.now() })))).rejects.toThrow(/not recorded/);
    expect(mockPutLines).not.toHaveBeenCalled();
    // Past the grace, the retry decides for good: still unnamed is not this deployment's.
    await expect(handler(evt(joined({ meetingId: 'm-fresh', eventType: 'chime:MeetingStarted' })))).resolves.toBeUndefined();
    expect(mockPutLines).not.toHaveBeenCalled();
  });

  it("skips a meeting whose conversation this app instance does not hold (another deployment's or application's)", async () => {
    mockReadClassification.mockResolvedValue(serviceError('NotFoundException'));
    await expect(handler(evt(joined({ externalMeetingId: 'phone-bridge-poc-1700000000' })))).resolves.toBeUndefined();
    expect(mockPutLines).not.toHaveBeenCalled();
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('skips a meeting whose external id is not a channel id at all, without reading anything', async () => {
    await handler(evt(joined({ externalMeetingId: '' })));
    await handler(evt(joined({ externalMeetingId: 'not a channel/id' })));
    expect(mockTagSend).not.toHaveBeenCalled();
    expect(mockPutLines).not.toHaveBeenCalled();
  });
});

describe('a write that does not land', () => {
  it('THROWS, so EventBridge retries it and then dead-letters it', async () => {
    mockIngest.mockRejectedValue(new Error('data plane unavailable'));
    // Deliberately the opposite of this platform's usual degradation: a missing arrival is a wrong
    // roster that nothing downstream can detect, so it must not be swallowed.
    await expect(handler(evt(joined()))).rejects.toThrow('data plane unavailable');
  });

  it('THROWS when the archive did not take the event, before any projection', async () => {
    mockPutLines.mockResolvedValue({ delivered: 0, dropped: 1 });
    await expect(handler(evt(joined()))).rejects.toThrow(/not archived/);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('a start or an end is handed to the router of its conversation', () => {
  const sendBus = jest.fn();
  beforeEach(() => {
    process.env.MEETING_LIFECYCLE_INSTANCE = 'test-instance';
    sendBus.mockReset().mockResolvedValue({ FailedEntryCount: 0 });
    __setBus({ send: sendBus } as never);
  });
  afterEach(() => { delete process.env.MEETING_LIFECYCLE_INSTANCE; });

  it('after the event is archived, as this instance and classification, and never for an attendee event', async () => {
    const order: string[] = [];
    mockPutLines.mockImplementation(async () => { order.push('archive'); return { delivered: 1, dropped: 0 }; });
    sendBus.mockImplementation(async () => { order.push('bus'); return { FailedEntryCount: 0 }; });
    await handler(evt(joined({ eventType: 'chime:MeetingEnded' })));
    expect(order).toEqual(['archive', 'bus']);
    const entry = sendBus.mock.calls[0][0].input.Entries[0];
    expect(entry.Source).toBe('agentechelon.meetings');
    expect(JSON.parse(entry.Detail)).toMatchObject({ instance: 'test-instance', classification: 'premium', meetingId: 'm-1', event: 'meeting-ended' });
    sendBus.mockClear();
    await handler(evt(joined()));
    expect(sendBus).not.toHaveBeenCalled();
  });

  it("hands a person's leave or drop to the router, never a shared screen's", async () => {
    await handler(evt(joined({ eventType: 'chime:AttendeeLeft' })));
    await handler(evt(joined({ eventType: 'chime:AttendeeDropped' })));
    expect(sendBus.mock.calls.map((c) => JSON.parse(c[0].input.Entries[0].Detail).event)).toEqual(['person-left', 'person-left']);
    sendBus.mockClear();
    await handler(evt(joined({ eventType: 'chime:AttendeeLeft', attendeeId: 'att-1#content' })));
    expect(sendBus).not.toHaveBeenCalled();
  });

  it('throws when the handoff was not published, so the retry hands it over again', async () => {
    sendBus.mockResolvedValue({ FailedEntryCount: 1 });
    await expect(handler(evt(joined({ eventType: 'chime:MeetingStarted' })))).rejects.toThrow(/not published/);
  });
});

describe('the archive is the system of record', () => {
  it('files the event in the archive first, then the projection', async () => {
    const order: string[] = [];
    mockPutLines.mockImplementation(async () => { order.push('archive'); return { delivered: 1, dropped: 0 }; });
    mockIngest.mockImplementation(async () => { order.push('projection'); return { inserted: 1, duplicates: 0 }; });
    await handler(evt(joined()));
    expect(order).toEqual(['archive', 'projection']);
    const [stream, lines] = mockPutLines.mock.calls[0];
    expect(stream).toBe('test-meeting-events');
    // The archive line is the record, its detail kept as JSON text, from the service.
    expect(lines[0]).toEqual(expect.objectContaining({ meeting_id: 'm-1', event_type: 'AttendeeJoined', source: 'server' }));
    expect(typeof lines[0].detail).toBe('string');
  });

  it('keeps every event where the deployment has no Aurora projection (Athena mode)', async () => {
    mockHasDataPlane.mockReturnValue(false);
    await expect(handler(evt(joined()))).resolves.toBeUndefined();
    expect(mockPutLines).toHaveBeenCalledTimes(1);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('a join is on the running meeting at once, ahead of the events store', () => {
  it("records a person's join at the service's time, and never a shared screen's", async () => {
    await handler(evt(joined()));
    expect(mockJoin).toHaveBeenCalledWith(`${APP_INSTANCE}/channel/${channel()}`, 'm-1', '2026-10-01T14:02:00.000Z');
    mockJoin.mockClear();
    await handler(evt(joined({ attendeeId: 'att-1#content' })));
    await handler(evt(joined({ eventType: 'chime:AttendeeLeft' })));
    expect(mockJoin).not.toHaveBeenCalled();
  });

  it('THROWS when the join could not be recorded, so the retry records it', async () => {
    mockJoin.mockResolvedValue('failed');
    await expect(handler(evt(joined()))).rejects.toThrow(/join could not be recorded/);
    mockJoin.mockResolvedValue('not-running');
    await expect(handler(evt(joined()))).resolves.toBeUndefined();
  });
});

describe("a service's own attendee is not a person", () => {
  it('files nothing for an attendee the service reserves (a media pipeline), and records no join', async () => {
    await handler(evt(joined({ externalUserId: 'aws:MediaPipeline-abc' })));
    expect(mockPutLines).not.toHaveBeenCalled();
    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockJoin).not.toHaveBeenCalled();
  });
});

describe('events a writer could not project are projected here, and retried until they land', () => {
  const handed = (records: unknown) => ({ aeProjectMeetingEvents: records }) as never;
  const row = (over: Record<string, unknown> = {}) => ({
    meeting_id: 'm-1', channel_arn: `${APP_INSTANCE}/channel/c1`, classification: 'premium', event_type: 'recordingStarted', source: 'platform',
    attendee_id: null, person_key: null, is_content: false, network_transport: null, event_at: '2026-10-01T14:02:00.000Z', detail: null, ...over,
  });

  it('projects this app instance\'s rows, without filing them in the archive again', async () => {
    await handler(handed([row(), row({ channel_arn: 'arn:aws:chime:us-east-1:111122223333:app-instance/other/channel/c1' }), row({ event_at: 'yesterday' })]));
    expect(mockIngest).toHaveBeenCalledWith([row()]);
    expect(mockPutLines).not.toHaveBeenCalled();
  });

  it('THROWS when the projection fails, so the asynchronous invoke retries it', async () => {
    mockIngest.mockRejectedValue(Object.assign(new Error('down'), { name: 'ServiceException' }));
    await expect(handler(handed([row()]))).rejects.toThrow('down');
  });
});
