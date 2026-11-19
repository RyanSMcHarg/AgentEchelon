/**
 * WHAT THE MEETINGS TAB DRAWS, as pure functions of the answer: the window's days, a meeting's lanes, the markers on
 * them, and each attendee's connectivity. Nothing here computes a figure; every number is the server's
 * (`meeting-figures.ts`), and these only place it on an axis.
 *
 * A PERSON IS THEIR ID. A lane, a marker and an incident carry the person's AppInstanceUser id as the record keeps it.
 */
import type {
  AttendeeConnectivity, ConnectivitySample, DayFigures, MeetingEvent, MeetingSummary, RosterRow,
} from '../../services/meetingAnalyticsService';

/** What an event is about, for the timeline's colors and its list's filter. */
export type EventCategory = 'lifecycle' | 'presence' | 'media' | 'device' | 'connection' | 'failure' | 'ring' | 'other';
export const EVENT_CATEGORIES: readonly EventCategory[] = ['lifecycle', 'presence', 'media', 'device', 'connection', 'failure', 'ring', 'other'];

/** The app's periodic connection reading: drawn in the connectivity panel, not as a marker. */
export const CONNECTIVITY_SAMPLE_EVENT = 'connectivitySample';

const LIFECYCLE = new Set(['MeetingStarted', 'MeetingEnded', 'meetingCreated']);
const PRESENCE = new Set([
  'AttendeeJoined', 'AttendeeLeft', 'AttendeeDeleted', 'meetingStartRequested', 'meetingStartSucceeded', 'meetingEnded',
  'meetingReconnected', 'attendeePresenceReceived',
]);
const FAILURE = new Set([
  'AttendeeDropped', 'meetingStartFailed', 'meetingFailed', 'audioInputFailed', 'videoInputFailed', 'signalingDropped',
  'sendingAudioFailed', 'receivingAudioDropped', 'devicePermissionDenied',
]);
const MEDIA = new Set([
  'AttendeeVideoStarted', 'AttendeeVideoStopped', 'AttendeeContentJoined', 'AttendeeContentLeft', 'AttendeeContentDropped',
  'audioMuted', 'audioUnmuted',
]);
const DEVICE = new Set(['audioInputChanged', 'videoInputChanged', 'audioOutputChanged', 'devicesChanged']);
const CONNECTION = new Set([CONNECTIVITY_SAMPLE_EVENT, 'connectionBecamePoor', 'connectionBecameGood', 'videoStopSuggested', 'sendingAudioRecovered']);
const RING = new Set(['ringAnswered', 'ringDismissed', 'ringTimedOut']);

/** The category of one event. A shared screen's own join and leave are media, never a person's presence or drop. */
export function categoryOf(e: Pick<MeetingEvent, 'event_type' | 'source' | 'is_content'>): EventCategory {
  const t = e.event_type;
  if (e.is_content || t.startsWith('AttendeeContent')) return 'media';
  if (LIFECYCLE.has(t) || e.source === 'platform') return 'lifecycle';
  if (FAILURE.has(t)) return 'failure';
  if (PRESENCE.has(t)) return 'presence';
  if (MEDIA.has(t)) return 'media';
  if (DEVICE.has(t)) return 'device';
  if (CONNECTION.has(t)) return 'connection';
  if (RING.has(t)) return 'ring';
  return 'other';
}

const DAY_MS = 86_400_000;

/**
 * Every UTC day from the window's first to its last, each with what the server counted on it, and a day with no
 * meeting as zero meetings: the window was read whole, so a day absent from `byDay` held none.
 */
export function windowDays(byDay: DayFigures[], fromIso: string, toIso: string): Required<DayFigures>[] {
  const known = new Map(byDay.map((d) => [d.day, d]));
  const from = Date.parse(fromIso.slice(0, 10));
  const to = Date.parse(toIso.slice(0, 10));
  const out: Required<DayFigures>[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return out;
  for (let t = from; t <= to; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const d = known.get(day);
    out.push({ day, meetings: d?.meetings ?? 0, people: d?.people ?? 0, dropEvents: d?.dropEvents ?? 0, clientFailures: d?.clientFailures ?? 0 });
  }
  return out;
}

/** The meeting's own lane: its start, its end and the platform's record of it. */
export const MEETING_LANE = '__meeting';

export interface Lane {
  key: string;
  /** The person's id; null on the meeting's own lane. */
  personKey: string | null;
  connected: Array<{ from: number; to: number }>;
  camera: Array<{ from: number; to: number }>;
  sharing: Array<{ from: number; to: number }>;
  quality: RosterRow['quality'] | null;
}

export interface Marker {
  /** The event's index in the answer's events, which is also its key in the list beneath. */
  index: number;
  at: number;
  lane: string;
  category: EventCategory;
  event: MeetingEvent;
}

export interface Timeline {
  start: number;
  end: number;
  lanes: Lane[];
  markers: Marker[];
}

const spansOf = (xs: Array<{ from: string; to: string }> | undefined) =>
  (xs ?? []).map((s) => ({ from: Date.parse(s.from), to: Date.parse(s.to) })).filter((s) => s.to > s.from);

/** The lane an event is drawn on: the meeting's for the meeting's own events, else the person it names. */
export function laneOf(e: MeetingEvent): string {
  if (e.source === 'platform' || LIFECYCLE.has(e.event_type) || !e.person_key) return MEETING_LANE;
  return e.person_key;
}

/**
 * A meeting as lanes on one time axis: the meeting's lane, then one per person on the roster in the order they joined,
 * then anyone the events name who is not on it (an app that reported without the service recording a join). Spans are
 * the roster's own intervals; markers are every event but the periodic connectivity reading.
 */
export function buildTimeline(meeting: MeetingSummary, events: MeetingEvent[], now: number = Date.now()): Timeline {
  const roster = meeting.roster ?? [];
  const lanes: Lane[] = [{ key: MEETING_LANE, personKey: null, connected: [], camera: [], sharing: [], quality: null }];
  for (const r of roster) {
    lanes.push({ key: r.personKey, personKey: r.personKey, connected: spansOf(r.spans?.connected), camera: spansOf(r.spans?.camera), sharing: spansOf(r.spans?.sharing), quality: r.quality });
  }
  const markers: Marker[] = [];
  events.forEach((event, index) => {
    if (event.event_type === CONNECTIVITY_SAMPLE_EVENT) return;
    const at = Date.parse(event.event_at);
    if (!Number.isFinite(at)) return;
    const lane = laneOf(event);
    if (!lanes.some((l) => l.key === lane)) lanes.push({ key: lane, personKey: lane, connected: [], camera: [], sharing: [], quality: null });
    markers.push({ index, at, lane, category: categoryOf(event), event });
  });

  const times = [
    ...markers.map((m) => m.at),
    ...lanes.flatMap((l) => [...l.connected, ...l.camera, ...l.sharing].flatMap((s) => [s.from, s.to])),
  ];
  const started = meeting.startedAt ? Date.parse(meeting.startedAt) : NaN;
  const ended = meeting.endedAt ? Date.parse(meeting.endedAt) : NaN;
  const start = Math.min(...(Number.isFinite(started) ? [started] : []), ...times);
  let end = Math.max(...(Number.isFinite(ended) ? [ended] : []), ...times, ...(meeting.status === 'active' ? [now] : []));
  if (!Number.isFinite(start)) return { start: now, end: now + 60_000, lanes, markers };
  if (end <= start) end = start + 60_000;
  return { start, end, lanes, markers };
}

const TICK_STEPS_MS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].map((s) => s * 1000);

/** Clean tick instants across a span: the smallest round step that gives at most `max` ticks. */
export function timeTicks(start: number, end: number, max = 8): number[] {
  const span = Math.max(1, end - start);
  const step = TICK_STEPS_MS.find((s) => span / s <= max) ?? Math.ceil(span / max / 3_600_000) * 3_600_000;
  const out: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) out.push(t);
  return out;
}

/** Clean upper bound and ticks for a count axis: 0 to a round number at or above the largest value. */
export function countTicks(maxValue: number): number[] {
  if (maxValue <= 0) return [0, 1];
  const raw = maxValue / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw && Number.isInteger(s)) ?? Math.max(1, Math.ceil(raw));
  const ticks: number[] = [];
  for (let v = 0; v < maxValue + step; v += step) { ticks.push(v); if (v >= maxValue) break; }
  return ticks;
}

/** An attendee's connection as the console draws it; the server's figures where it gave them, else none. */
export type ConnectivityLane = Pick<AttendeeConnectivity, 'personKey' | 'attendeeId' | 'samples' | 'healthChanges'>
  & Partial<Pick<AttendeeConnectivity, 'poorSeconds' | 'videoStopSuggestions'>>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Each attendee's connectivity: the answer's own where it carries it, else read from the `connectivitySample` and
 * health-change events, one lane per attendee record, in time order. Nothing is summed here: a figure the server did not
 * give (poor seconds, video-stop suggestions) is left out rather than recomputed.
 */
export function connectivityLanes(answer: AttendeeConnectivity[] | undefined, events: MeetingEvent[]): ConnectivityLane[] {
  if (answer && answer.length) return answer;
  const byAttendee = new Map<string, ConnectivityLane>();
  for (const e of events) {
    if (!e.person_key || !e.attendee_id) continue;
    const kind = e.event_type;
    if (kind !== CONNECTIVITY_SAMPLE_EVENT && kind !== 'connectionBecamePoor' && kind !== 'connectionBecameGood') continue;
    const lane = byAttendee.get(e.attendee_id) ?? { personKey: e.person_key, attendeeId: e.attendee_id, samples: [], healthChanges: [] };
    byAttendee.set(e.attendee_id, lane);
    if (kind === CONNECTIVITY_SAMPLE_EVENT) {
      const d = e.detail ?? {};
      const health = d.connectionHealth === 'good' || d.connectionHealth === 'poor' ? d.connectionHealth : null;
      const sample: ConnectivitySample = {
        at: e.event_at, health,
        audioLossSendPct: num(d.audioLossSendPct), audioLossReceivePct: num(d.audioLossReceivePct), audioJitterMs: num(d.audioJitterMs),
        rttMs: num(d.rttMs), availableSendKbps: num(d.availableSendKbps), availableReceiveKbps: num(d.availableReceiveKbps),
        videoSendKbps: num(d.videoSendKbps), videoReceiveKbps: num(d.videoReceiveKbps),
      };
      lane.samples.push(sample);
    } else {
      lane.healthChanges.push({ at: e.event_at, health: kind === 'connectionBecamePoor' ? 'poor' : 'good' });
    }
  }
  return [...byAttendee.values()];
}
