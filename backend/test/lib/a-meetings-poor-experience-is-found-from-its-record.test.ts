/**
 * A MEETING'S POOR EXPERIENCES ARE FOUND FROM ITS RECORD (SPEC-ASSISTANT-MEETINGS FR74): each person's stretches of
 * packet loss, jitter, round trip and poor connection past the deployment's thresholds, sustained, and each drop,
 * reconnect, signaling drop, device failure and failed join the record names, with when and how long; and the meeting's
 * detail answers them with the thresholds they were judged against (`meeting-experience.ts`, `admin-meetings.ts`).
 */
import {
  DEFAULT_EXPERIENCE_THRESHOLDS, experienceIssues, experienceThresholds,
} from '../../lambda/src/lib/meeting-experience';
import { meetingDetail, type MeetingEventRow } from '../../lambda/src/lib/meeting-figures';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const row = (over: Partial<MeetingEventRow> & Pick<MeetingEventRow, 'event_type' | 'event_at'>): MeetingEventRow => ({
  meeting_id: 'm-1', channel_arn: 'arn:c', classification: 'premium', source: 'client', attendee_id: 'a-1', person_key: 'p-1',
  is_content: false, network_transport: null, detail: {}, ...over,
} as MeetingEventRow);
const sample = (s: number, d: Record<string, unknown>, who: { person?: string; attendee?: string } = {}) => row({
  event_type: 'connectivitySample', event_at: at(s), person_key: who.person ?? 'p-1', attendee_id: who.attendee ?? 'a-1',
  detail: { connectionHealth: 'good', audioLossSendPct: 0, audioLossReceivePct: 0, audioJitterMs: 5, rttMs: 60, ...d },
});

/** A meeting of two people: p-1 has a bad minute; p-2 one bad reading and nothing else. */
function meeting(): MeetingEventRow[] {
  return [
    row({ event_type: 'MeetingStarted', event_at: at(0), source: 'server', attendee_id: null, person_key: null }),
    row({ event_type: 'AttendeeJoined', event_at: at(1), source: 'server' }),
    row({ event_type: 'AttendeeJoined', event_at: at(2), source: 'server', attendee_id: 'a-2', person_key: 'p-2' }),
    sample(15, {}),
    sample(30, { audioLossReceivePct: 6, audioJitterMs: 45 }),
    sample(45, { audioLossReceivePct: 9.5, audioJitterMs: 50 }),
    sample(60, { audioLossReceivePct: 4, audioJitterMs: 12 }),
    sample(75, { audioLossReceivePct: 1, rttMs: 420 }),
    sample(90, {}),
    sample(15, { rttMs: 900 }, { person: 'p-2', attendee: 'a-2' }),
    sample(30, {}, { person: 'p-2', attendee: 'a-2' }),
    row({ event_type: 'signalingDropped', event_at: at(100) }),
    row({ event_type: 'meetingReconnected', event_at: at(104) }),
    row({ event_type: 'audioInputFailed', event_at: at(110), detail: { errorMessage: 'NotReadableError' } }),
    row({ event_type: 'AttendeeDropped', event_at: at(120), source: 'server' }),
    row({ event_type: 'AttendeeJoined', event_at: at(150), source: 'server', attendee_id: 'a-3' }),
    row({ event_type: 'AttendeeDropped', event_at: at(170), source: 'server', attendee_id: 'a-2', person_key: 'p-2' }),
    row({ event_type: 'ringDismissed', event_at: at(5), attendee_id: 'ring#p-3', person_key: 'p-3' }),
    row({ event_type: 'MeetingEnded', event_at: at(200), source: 'server', attendee_id: null, person_key: null }),
  ];
}

describe('a meeting\'s poor experiences, found from its record', () => {
  const detail = meetingDetail(meeting(), T0 + 300_000);
  const issues = experienceIssues(meeting(), detail.connectivity, T0 + 200_000);
  const of = (person: string, kind: string) => issues.filter((i) => i.personKey === person && i.kind === kind);

  it('finds a sustained stretch past a threshold, with when, how long and its worst reading', () => {
    // Loss received over 3% at 30, 45 and 60: three readings, 45 seconds, worst 9.5%.
    expect(of('p-1', 'packetLossReceive')).toEqual([{
      personKey: 'p-1', attendeeId: 'a-1', kind: 'packetLossReceive', from: at(30), to: at(75), seconds: 45, peak: 9.5, eventType: null,
    }]);
    // Jitter over 30 ms at 30 and 45: two readings, 30 seconds, the sustained bound exactly.
    expect(of('p-1', 'jitter')).toEqual([expect.objectContaining({ from: at(30), to: at(60), seconds: 30, peak: 50 })]);
  });

  it('leaves out one bad reading that was not sustained', () => {
    expect(of('p-1', 'roundTrip')).toEqual([]);
    expect(of('p-2', 'roundTrip')).toEqual([]);
    expect(of('p-1', 'packetLossSend')).toEqual([]);
  });

  it('names each moment the record holds: signaling dropped, a reconnect, a device failure and a drop until they came back', () => {
    expect(of('p-1', 'signalingDropped')).toEqual([expect.objectContaining({ from: at(100), to: at(100), seconds: 0, eventType: 'signalingDropped' })]);
    expect(of('p-1', 'reconnect')).toEqual([expect.objectContaining({ from: at(104), eventType: 'meetingReconnected' })]);
    expect(of('p-1', 'deviceFailure')).toEqual([expect.objectContaining({ from: at(110), eventType: 'audioInputFailed' })]);
    expect(of('p-1', 'drop')).toEqual([expect.objectContaining({ from: at(120), to: at(150), seconds: 30 })]);
    // A drop the person never came back from has no end.
    expect(of('p-2', 'drop')).toEqual([expect.objectContaining({ from: at(170), to: null, seconds: null })]);
  });

  it('never takes a ring outcome for an attendee\'s issue, and lists every issue in time order', () => {
    expect(issues.some((i) => i.personKey === 'p-3')).toBe(false);
    const times = issues.map((i) => Date.parse(i.from));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('judges against the deployment\'s thresholds: a tighter round trip and a shorter sustained bound find more', () => {
    const tight = experienceThresholds(JSON.stringify({ roundTripMs: 400, sustainedSeconds: 15 }));
    expect(tight).toEqual({ ...DEFAULT_EXPERIENCE_THRESHOLDS, roundTripMs: 400, sustainedSeconds: 15 });
    const found = experienceIssues(meeting(), detail.connectivity, T0 + 200_000, tight);
    expect(found.filter((i) => i.kind === 'roundTrip').map((i) => [i.personKey, i.peak])).toEqual([['p-2', 900], ['p-1', 420]]);
  });

  it('keeps a default for a value that is unreadable or outside its bounds', () => {
    expect(experienceThresholds(undefined)).toEqual(DEFAULT_EXPERIENCE_THRESHOLDS);
    expect(experienceThresholds('not json')).toEqual(DEFAULT_EXPERIENCE_THRESHOLDS);
    expect(experienceThresholds(JSON.stringify({ packetLossPct: -1, jitterMs: 'x', sustainedSeconds: 1, roundTripMs: '250' })))
      .toEqual({ ...DEFAULT_EXPERIENCE_THRESHOLDS, roundTripMs: 250 });
    expect(DEFAULT_EXPERIENCE_THRESHOLDS).toEqual({ packetLossPct: 3, jitterMs: 30, roundTripMs: 300, sustainedSeconds: 30 });
  });

  it('finds the connection monitor\'s own poor stretch, closed at the meeting\'s end where it never turned good', () => {
    const rows = [
      ...meeting(),
      row({ event_type: 'connectionBecamePoor', event_at: at(130), attendee_id: 'a-3' }),
    ];
    const d = meetingDetail(rows, T0 + 300_000);
    const found = experienceIssues(rows, d.connectivity, T0 + 200_000);
    expect(found.filter((i) => i.kind === 'poorConnection')).toEqual([expect.objectContaining({ personKey: 'p-1', attendeeId: 'a-3', from: at(130), to: at(200), seconds: 70 })]);
  });

  it("closes an open poor stretch when its person left, as the roster does, never at the meeting's end", () => {
    const rows = [
      ...meeting(),
      row({ event_type: 'connectionBecamePoor', event_at: at(130), attendee_id: 'a-3' }),
      row({ event_type: 'AttendeeLeft', event_at: at(180), source: 'server', attendee_id: 'a-3' }),
    ];
    const d = meetingDetail(rows, T0 + 300_000);
    const found = experienceIssues(rows, d.connectivity, T0 + 200_000);
    expect(found.filter((i) => i.kind === 'poorConnection')).toEqual([expect.objectContaining({ from: at(130), to: at(180), seconds: 50 })]);
  });

  it('reads a session that failed after it started as a lost connection, not a failed join', () => {
    const rows = [...meeting(), row({ event_type: 'meetingFailed', event_at: at(140), attendee_id: 'a-3' })];
    const found = experienceIssues(rows, meetingDetail(rows, T0 + 300_000).connectivity, T0 + 200_000);
    expect(found.filter((i) => i.eventType === 'meetingFailed').map((i) => i.kind)).toEqual(['signalingDropped']);
  });
});
