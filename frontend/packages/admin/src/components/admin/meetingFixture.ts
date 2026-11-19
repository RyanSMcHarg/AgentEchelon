/**
 * A MEETING AS THE DETAIL ROUTE ANSWERS IT, for the Meetings tab's tests: the event rows in the recorded shape
 * (`meeting-event-shape.ts`) from each source, the roster with its spans, and one attendee's connectivity.
 */
import type { MeetingAnswer, MeetingEvent, MeetingSummary } from '../../services/meetingAnalyticsService';

export const ALICE = 'aiu-alice-0001';
export const BOB = 'aiu-bob-0002';
const T0 = Date.parse('2026-11-11T14:00:00.000Z');
export const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();

const base = { meeting_id: 'm-1', channel_arn: 'arn:aws:chime:c1', classification: 'cls-a', is_content: false, network_transport: null, detail: null };
const server = (event_type: string, min: number, person: string | null = null, attendee: string | null = null, more: Partial<MeetingEvent> = {}): MeetingEvent =>
  ({ ...base, event_type, source: 'server', person_key: person, attendee_id: attendee, event_at: at(min), ...more });
const client = (event_type: string, min: number, person: string, detail: Record<string, unknown> = {}, attendee = `${person}-a1`): MeetingEvent =>
  ({ ...base, event_type, source: 'client', person_key: person, attendee_id: attendee, event_at: at(min), detail });

export const EVENTS: MeetingEvent[] = [
  { ...base, event_type: 'meetingCreated', source: 'platform', person_key: ALICE, attendee_id: null, event_at: at(0), detail: { startedVia: 'person' } },
  server('MeetingStarted', 0),
  server('AttendeeJoined', 1, ALICE, `${ALICE}-a1`, { network_transport: 'Voip' }),
  client('meetingStartSucceeded', 1, ALICE, { meetingStartDurationMs: 1200, browserName: 'Chrome' }),
  { ...client('ringAnswered', 2, BOB), attendee_id: `ring#${BOB}` },
  server('AttendeeJoined', 2, BOB, `${BOB}-a1`, { network_transport: 'Voip' }),
  server('AttendeeVideoStarted', 3, ALICE, `${ALICE}-a1`),
  client('audioMuted', 4, BOB, {}, `${BOB}-a1`),
  client('connectivitySample', 5, BOB, { rttMs: 80, audioJitterMs: 12, connectionHealth: 'good' }, `${BOB}-a1`),
  client('connectivitySample', 6, BOB, { rttMs: 420, audioJitterMs: 60, connectionHealth: 'poor' }, `${BOB}-a1`),
  client('connectionBecamePoor', 6, BOB, {}, `${BOB}-a1`),
  server('AttendeeContentJoined', 8, ALICE, `${ALICE}-a1#content`, { is_content: true }),
  client('audioInputFailed', 9, BOB, { errorMessage: 'NotAllowedError' }, `${BOB}-a1`),
  client('audioInputChanged', 9, BOB, { deviceClass: 'bluetooth' }, `${BOB}-a1`),
  server('AttendeeContentLeft', 12, ALICE, `${ALICE}-a1#content`, { is_content: true }),
  server('AttendeeDropped', 14, BOB, `${BOB}-a1`),
  server('AttendeeJoined', 15, BOB, `${BOB}-a2`, { network_transport: 'Voip' }),
  server('AttendeeVideoStopped', 18, ALICE, `${ALICE}-a1`),
  server('AttendeeLeft', 20, BOB, `${BOB}-a2`),
  server('AttendeeLeft', 20, ALICE, `${ALICE}-a1`),
  server('MeetingEnded', 20),
];

const NONE = { value: null, over: 0 };
export const MEETING: MeetingSummary = {
  meetingId: 'm-1', channelArn: 'arn:aws:chime:c1', classification: 'cls-a', status: 'ended', startedAt: at(0), endedAt: at(20),
  durationSeconds: 1200, startedVia: 'person', people: 2, phonePeople: 0, dropEvents: 1, peopleWhoDropped: 1, reconnects: 0, clientFailures: 1,
  joinLatencyMs: { p50: NONE, p95: NONE }, ring: { answered: 1, dismissed: 0, timedOut: 0 },
  roster: [
    {
      personKey: ALICE, state: 'left', firstJoinedAt: at(1), lastLeftAt: at(20), connectedSeconds: 1140, drops: 0, reconnects: 0,
      transports: [{ transport: 'Voip', at: at(1) }], phone: false, cameraSeconds: 900, sharedSeconds: 240, joinLatencyMs: 1200,
      device: { browser: 'Chrome', os: null, sdk: null }, quality: 'good', failures: [], poorConnectionSeconds: 0,
      spans: { connected: [{ from: at(1), to: at(20) }], camera: [{ from: at(3), to: at(18) }], sharing: [{ from: at(8), to: at(12) }] },
    },
    {
      personKey: BOB, state: 'left', firstJoinedAt: at(2), lastLeftAt: at(20), connectedSeconds: 1020, drops: 1, reconnects: 0,
      transports: [{ transport: 'Voip', at: at(2) }, { transport: 'Voip', at: at(15) }], phone: false, cameraSeconds: 0, sharedSeconds: 0, joinLatencyMs: null,
      device: { browser: null, os: null, sdk: null }, quality: 'error', failures: ['audioInputFailed'], poorConnectionSeconds: 60,
      spans: { connected: [{ from: at(2), to: at(14) }, { from: at(15), to: at(20) }], camera: [], sharing: [] },
    },
  ],
};

export const DETAIL: MeetingAnswer = {
  days: 7, from: '2026-11-05T00:00:00.000Z', to: '2026-11-12T00:00:00.000Z', store: 'athena', truncated: false, unreadClassifications: [],
  meeting: MEETING, events: EVENTS,
};
