/**
 * A MEETING FIGURE IS DERIVED FROM ITS EVENTS (`meeting-figures.ts`, SPEC-ASSISTANT-MEETINGS FR22 to FR26).
 *
 * Each case pins one way a meeting figure goes confidently wrong: an attendee record counted as a person, a shared
 * screen counted as one, last-minus-first taken as connected time, a redelivery counted twice, a transport read from an
 * id, and a figure over nothing shown as zero.
 */
import {
  ABANDONED_AFTER_MS, ABANDONED_GRACE_MS, abandonedAfterMs, INCIDENTS_LISTED, MIN_SAMPLES_FOR_PERCENTILE, incidentKindOf, meetingFigures, percentile, summarizeMeeting, unionMs, type MeetingEventRow,
} from '../../lambda/src/lib/meeting-figures';

const T0 = Date.parse('2026-11-11T14:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
function ev(type: string, min: number, over: Partial<MeetingEventRow> = {}): MeetingEventRow {
  seq += 1;
  return {
    meeting_id: 'm-1', channel_arn: 'arn:c1', classification: 'premium', event_type: type, source: 'server',
    attendee_id: null, person_key: null, is_content: false, network_transport: null, event_at: at(min), detail: null, ...over,
  };
}
const join = (person: string, attendee: string, min: number, transport = 'Voip') => ev('AttendeeJoined', min, { person_key: person, attendee_id: attendee, network_transport: transport });
const leave = (person: string, attendee: string, min: number, type = 'AttendeeLeft') => ev(type, min, { person_key: person, attendee_id: attendee });
const client = (person: string, type: string, min: number, detail: Record<string, unknown> = {}) =>
  ev(type, min, { source: 'client', person_key: person, attendee_id: `${person}-a`, detail });

const ENDED_AT = 60;
const END = T0 + 24 * 60 * 60_000;

describe('a roster is one row per person', () => {
  it('folds a reconnect, a move from phone to browser and a shared screen into one person, and counts the screen as nobody', () => {
    const s = summarizeMeeting([
      ev('MeetingStarted', 0),
      join('alice', 'a1', 2, 'Pstn'),
      join('alice', 'a2', 9, 'Voip'),
      leave('alice', 'a1', 10),
      ev('AttendeeContentJoined', 15, { person_key: 'alice', attendee_id: 'a2#content', is_content: true }),
      ev('AttendeeContentLeft', 28, { person_key: 'alice', attendee_id: 'a2#content', is_content: true }),
      leave('alice', 'a2', 31, 'AttendeeDropped'),
      join('alice', 'a3', 32),
      leave('alice', 'a3', 40),
      join('bob', 'b1', 5),
      leave('bob', 'b1', 40),
      ev('MeetingEnded', ENDED_AT),
    ], END);
    expect(s.people).toBe(2);
    const alice = s.roster.find((r) => r.personKey === 'alice')!;
    // 2 to 31 (the phone and browser overlap counted once), then 32 to 40: the gap is not connected time.
    expect(alice.connectedSeconds).toBe((29 + 8) * 60);
    expect(alice.sharedSeconds).toBe(13 * 60);
    expect(alice.transports.map((t) => t.transport)).toEqual(['Pstn', 'Voip', 'Voip']);
    expect(alice.phone).toBe(true);
    expect(alice.drops).toBe(1);
    expect(alice.quality).toBe('warning');
    expect(s.phonePeople).toBe(1);
    expect(s.dropEvents).toBe(1);
    expect(s.peopleWhoDropped).toBe(1);
    expect(s.durationSeconds).toBe(60 * 60);
    expect(s.status).toBe('ended');
  });

  it('counts a redelivered event once', () => {
    const rows = [ev('MeetingStarted', 0), join('bob', 'b1', 1), leave('bob', 'b1', 11), ev('MeetingEnded', 20)];
    const s = summarizeMeeting([...rows, ...rows.map((r) => ({ ...r }))], END);
    expect(s.people).toBe(1);
    expect(s.roster[0].connectedSeconds).toBe(600);
  });

  it('marks a phone attendee from the transport the service reported, never from an id', () => {
    const s = summarizeMeeting([ev('MeetingStarted', 0), join('+15551234567', 'p1', 1, 'Voip'), ev('MeetingEnded', 5)], END);
    expect(s.phonePeople).toBe(0);
  });
});

describe('a running meeting is not a finished one', () => {
  it('has no duration yet, shows who is present, and counts open time up to now', () => {
    const now = T0 + 30 * 60_000;
    const s = summarizeMeeting([ev('MeetingStarted', 0), join('bob', 'b1', 10)], now);
    expect(s.status).toBe('active');
    expect(s.durationSeconds).toBeNull();
    expect(s.roster[0]).toMatchObject({ state: 'present', connectedSeconds: 20 * 60 });
  });

  it('reports a meeting with no recorded end, long past its start, as abandoned, closing its intervals at the last thing seen', () => {
    const now = T0 + ABANDONED_AFTER_MS + 60_000;
    const s = summarizeMeeting([ev('MeetingStarted', 0), join('bob', 'b1', 10), ev('AttendeeVideoStarted', 15, { person_key: 'bob', attendee_id: 'b1' })], now);
    expect(s.status).toBe('abandoned');
    expect(s.roster[0]).toMatchObject({ state: 'left', connectedSeconds: 5 * 60 });
  });

  it('never folds a meeting still within the deployment\'s limit as abandoned, however long the limit is', () => {
    const was = process.env.MEETING_MAX_MINUTES;
    process.env.MEETING_MAX_MINUTES = '600';
    try {
      // Five hours in, with a ten-hour limit: running, and its person present.
      const s = summarizeMeeting([ev('MeetingStarted', 0), join('bob', 'b1', 10)], T0 + 5 * 60 * 60_000);
      expect(s.status).toBe('active');
      expect(s.present).toBe(1);
      expect(abandonedAfterMs(600)).toBe(600 * 60_000 + ABANDONED_GRACE_MS);
      expect(abandonedAfterMs(90)).toBe(ABANDONED_AFTER_MS);
    } finally {
      if (was === undefined) delete process.env.MEETING_MAX_MINUTES; else process.env.MEETING_MAX_MINUTES = was;
    }
  });
});

describe('what the apps reported', () => {
  it('reads join latency, the device, a reconnect and a failure from the person\'s own app', () => {
    const s = summarizeMeeting([
      ev('MeetingStarted', 0), join('bob', 'b1', 1),
      client('bob', 'meetingStartSucceeded', 1, { meetingStartDurationMs: 1800, browserName: 'Chrome', browserVersion: '131', osName: 'macOS', sdkVersion: '3.31.0' }),
      client('bob', 'meetingReconnected', 5),
      client('bob', 'audioInputFailed', 6, { errorMessage: 'NotAllowedError' }),
      ev('MeetingEnded', 10),
    ], END);
    expect(s.roster[0]).toMatchObject({
      joinLatencyMs: 1800, reconnects: 1, quality: 'error', failures: ['audioInputFailed'],
      device: { browser: 'Chrome 131', os: 'macOS', sdk: '3.31.0' },
    });
    expect(s.clientFailures).toBe(1);
  });

  it('keeps someone who only reported from their app, with no join on the service\'s record, off the roster', () => {
    const s = summarizeMeeting([ev('MeetingStarted', 0), client('eve', 'meetingStartFailed', 1), ev('MeetingEnded', 3)], END);
    expect(s.people).toBe(0);
    expect(s.clientFailures).toBe(1);
  });
});

describe('a figure states what it is over, and one over too little is not shown', () => {
  it('shows no percentile below the minimum sample, and no rate over nothing', () => {
    expect(percentile([100, 200], 50)).toEqual({ value: null, over: 2 });
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toEqual({ value: 10, over: 10 });
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toEqual({ value: 5, over: 10 });
    const { figures } = meetingFigures([], END);
    expect(figures.meetings).toBe(0);
    expect(figures.dropRate).toEqual({ value: null, over: 0 });
    expect(figures.durationSeconds).toEqual({ value: null, over: 0 });
    expect(figures.joinSuccessRate).toEqual({ value: null, over: 0 });
  });

  it('computes the rates across meetings over people, not attendee records, and the percentiles over joins', () => {
    const m = (id: string, offset: number, latency: number, dropped: boolean) => [
      ev('meetingCreated', offset, { meeting_id: id, source: 'platform', person_key: 'host', detail: { startedVia: 'person' } }),
      ev('MeetingStarted', offset, { meeting_id: id }),
      { ...join('host', `${id}-h`, offset), meeting_id: id },
      { ...join('guest', `${id}-g1`, offset + 1), meeting_id: id },
      ...(dropped ? [{ ...leave('guest', `${id}-g1`, offset + 2, 'AttendeeDropped'), meeting_id: id }, { ...join('guest', `${id}-g2`, offset + 3), meeting_id: id }] : []),
      { ...client('guest', 'meetingStartSucceeded', offset + 1, { meetingStartDurationMs: latency, browserName: 'Chrome' }), meeting_id: id },
      { ...client('guest', 'ringAnswered', offset, {}), meeting_id: id, attendee_id: 'ring#guest', event_at: new Date(T0 + offset * 60_000 + 4000).toISOString() },
      ev('MeetingEnded', offset + 30, { meeting_id: id }),
    ];
    const rows = [...m('m-a', 0, 1000, true), ...m('m-b', 60, 2000, false), ...m('m-c', 120, 3000, false), ...m('m-d', 180, 4000, false), ...m('m-e', 240, 5000, false)];
    const { figures } = meetingFigures(rows, END);
    expect(figures.meetings).toBe(5);
    expect(figures.peoplePerMeeting).toEqual({ value: 2, over: 5 });
    expect(figures.dropRate).toEqual({ value: 1 / 10, over: 10 });
    expect(figures.dropEvents).toBe(1);
    expect(figures.joinLatencyMs.p50).toEqual({ value: 3000, over: 5 });
    expect(figures.joinLatencyMs.p95).toEqual({ value: 5000, over: 5 });
    expect(figures.joinSuccessRate).toEqual({ value: 1, over: 5 });
    expect(figures.ring).toMatchObject({ sent: 5, answered: 5, answerRate: { value: 1, over: 5 } });
    expect(figures.ring.timeToAnswerMs.p50).toEqual({ value: 4000, over: 5 });
    expect(figures.browsers).toEqual({ Chrome: 5 });
    expect(figures.startedVia).toEqual({ person: 5, workflow: 0, unknown: 0 });
    expect(figures.byDay).toEqual([{ day: '2026-11-11', meetings: 5, people: 10, dropEvents: 1, clientFailures: 0 }]);
    expect(figures.quality).toEqual({ good: 9, warning: 1, error: 0 });
  });
});

describe('connected time is a union of intervals', () => {
  it('counts overlap once and gaps not at all', () => {
    expect(unionMs([{ from: 0, to: 10 }, { from: 5, to: 15 }, { from: 20, to: 25 }])).toBe(20);
    expect(unionMs([])).toBe(0);
    expect(MIN_SAMPLES_FOR_PERCENTILE).toBeGreaterThan(1);
  });
});

describe('a window holds the meetings that started in it', () => {
  it('leaves out a meeting whose start is before the window, rather than inventing its start, length and people', () => {
    const inWindow = [ev('MeetingStarted', 0), join('bob', 'b1', 1), leave('bob', 'b1', 11), ev('MeetingEnded', 20)];
    // m-old started before the window: only its departure and end are in it.
    const tail = [
      ev('AttendeeLeft', 2, { meeting_id: 'm-old', person_key: 'amy', attendee_id: 'x1' }),
      ev('MeetingEnded', 3, { meeting_id: 'm-old' }),
    ];
    const { figures, meetings } = meetingFigures([...inWindow, ...tail], END);
    expect(meetings.map((m) => m.meetingId)).toEqual(['m-1']);
    expect(figures.meetings).toBe(1);
    expect(figures.durationSeconds).toEqual({ value: 1200, over: 1 });
    expect(figures.peoplePerMeeting).toEqual({ value: 1, over: 1 });
  });

  it('counts a meeting the platform recorded creating, though the service\'s own start is not in the window', () => {
    const rows = [ev('meetingCreated', 0, { source: 'platform', detail: { startedVia: 'workflow' } }), join('bob', 'b1', 1), ev('MeetingEnded', 5)];
    expect(meetingFigures(rows, END).figures.meetings).toBe(1);
  });
});

describe('time to answer a ring is two server times', () => {
  it('never counts an answer recorded before the ring went out', () => {
    const rows = [
      ev('meetingCreated', 10, { source: 'platform', detail: { startedVia: 'person' } }),
      { ...client('guest', 'ringAnswered', 9), attendee_id: 'ring#guest' },
    ];
    expect(meetingFigures(rows, END).figures.ring.timeToAnswerMs.p50.over).toBe(0);
  });
});

describe('the console draws a meeting from the same intervals and incidents its figures count', () => {
  it('gives each person the connected, camera and sharing spans their seconds are summed from, merged across attendee records', () => {
    const s = summarizeMeeting([
      ev('MeetingStarted', 0),
      join('alice', 'a1', 2, 'Pstn'),
      join('alice', 'a2', 9),
      leave('alice', 'a1', 10),
      ev('AttendeeVideoStarted', 12, { person_key: 'alice', attendee_id: 'a2' }),
      ev('AttendeeContentJoined', 15, { person_key: 'alice', attendee_id: 'a2#content', is_content: true }),
      ev('AttendeeContentLeft', 28, { person_key: 'alice', attendee_id: 'a2#content', is_content: true }),
      leave('alice', 'a2', 31, 'AttendeeDropped'),
      join('alice', 'a3', 32),
      ev('MeetingEnded', 40),
    ], END);
    const alice = s.roster[0];
    expect(alice.spans).toEqual({
      connected: [{ from: at(2), to: at(31) }, { from: at(32), to: at(40) }],
      camera: [{ from: at(12), to: at(31) }],
      sharing: [{ from: at(15), to: at(28) }],
    });
    const summed = (xs: Array<{ from: string; to: string }>) => xs.reduce((n, x) => n + (Date.parse(x.to) - Date.parse(x.from)) / 1000, 0);
    expect(summed(alice.spans.connected)).toBe(alice.connectedSeconds);
    expect(summed(alice.spans.camera)).toBe(alice.cameraSeconds);
    expect(summed(alice.spans.sharing)).toBe(alice.sharedSeconds);
  });

  it('lists every drop and app failure as one incident of one kind, and the window counts each kind with its newest first', () => {
    const rows = [
      ev('MeetingStarted', 0),
      join('bob', 'b1', 1),
      client('bob', 'meetingStartFailed', 1),
      client('bob', 'audioInputFailed', 3, { errorMessage: 'NotAllowedError' }),
      client('bob', 'signalingDropped', 4),
      leave('bob', 'b1', 5, 'AttendeeDropped'),
      join('bob', 'b2', 6),
      client('bob', 'videoInputFailed', 7),
      client('bob', 'meetingReconnected', 8),
      ev('MeetingEnded', 10),
    ];
    const s = summarizeMeeting(rows, END);
    expect(s.incidents.map((i) => [i.kind, i.eventType])).toEqual([
      ['joinFailure', 'meetingStartFailed'], ['mediaFailure', 'audioInputFailed'], ['connectionFailure', 'signalingDropped'],
      ['drop', 'AttendeeDropped'], ['mediaFailure', 'videoInputFailed'],
    ]);
    expect(s.incidents[1]).toEqual({ kind: 'mediaFailure', meetingId: 'm-1', personKey: 'bob', eventType: 'audioInputFailed', at: at(3), errorMessage: 'NotAllowedError' });
    expect(s.incidents.filter((i) => i.kind !== 'drop')).toHaveLength(s.clientFailures);
    expect(s.incidents.filter((i) => i.kind === 'drop')).toHaveLength(s.dropEvents);

    const { figures } = meetingFigures(rows, END);
    expect(figures.incidents.mediaFailure.count).toBe(2);
    expect(figures.incidents.mediaFailure.recent.map((i) => i.eventType)).toEqual(['videoInputFailed', 'audioInputFailed']);
    expect(figures.incidents.drop).toEqual({ count: 1, recent: [expect.objectContaining({ meetingId: 'm-1', personKey: 'bob', at: at(5) })] });
    expect(figures.incidents.joinFailure.count).toBe(1);
    expect(figures.incidents.connectionFailure.count).toBe(1);
  });

  it('lists at most the newest INCIDENTS_LISTED of a kind and still counts them all', () => {
    const rows = [ev('MeetingStarted', 0), join('bob', 'b1', 0)];
    for (let i = 0; i < INCIDENTS_LISTED + 5; i += 1) rows.push(client('bob', 'audioInputFailed', 1 + i / 100));
    const { figures } = meetingFigures(rows, END);
    expect(figures.incidents.mediaFailure.count).toBe(INCIDENTS_LISTED + 5);
    expect(figures.incidents.mediaFailure.recent).toHaveLength(INCIDENTS_LISTED);
  });

  it('names an incident kind for every app failure, and none for an event that is not a failure', () => {
    for (const t of ['meetingStartFailed', 'meetingFailed', 'audioInputFailed', 'videoInputFailed', 'signalingDropped', 'sendingAudioFailed', 'receivingAudioDropped']) {
      expect(incidentKindOf(t)).not.toBeNull();
    }
    expect(incidentKindOf('meetingReconnected')).toBeNull();
    expect(incidentKindOf('AttendeeLeft')).toBeNull();
  });
});

describe('how a meeting ended, and who is in it now', () => {
  it('ended because everyone left when the last person left well before the service ended it', () => {
    const s = summarizeMeeting([ev('MeetingStarted', 0), join('bob', 'b1', 1), leave('bob', 'b1', 10), ev('MeetingEnded', 12)], END);
    expect(s.endedHow).toBe('everyoneLeft');
    expect(s.present).toBe(0);
  });

  it('ended with people in it when someone was still connected at its end', () => {
    const s = summarizeMeeting([ev('MeetingStarted', 0), join('bob', 'b1', 1), ev('MeetingEnded', 12), leave('bob', 'b1', 12)], END);
    expect(s.endedHow).toBe('withPeopleIn');
  });

  it('says nobody joined an ended meeting with an empty roster, and nothing about one still running', () => {
    expect(summarizeMeeting([ev('MeetingStarted', 0), ev('MeetingEnded', 5)], END).endedHow).toBe('nobodyJoined');
    const running = summarizeMeeting([ev('MeetingStarted', 0), join('bob', 'b1', 1), join('amy', 'c1', 2)], T0 + 10 * 60_000);
    expect(running.endedHow).toBeNull();
    expect(running.present).toBe(2);
  });
});
