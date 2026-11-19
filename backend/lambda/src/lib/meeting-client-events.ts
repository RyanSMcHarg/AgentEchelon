/**
 * WHAT A PARTICIPANT'S APP REPORTS ABOUT A MEETING (SPEC-ASSISTANT-MEETINGS FR22, FR23): the facts only the app can see,
 * such as how long joining took, a microphone that failed, or a reconnect, filed beside the service's own lifecycle as
 * `source: client`.
 *
 * NOTHING HERE IS TAKEN ON THE APP'S WORD EXCEPT THE FACT ITSELF. The person, the meeting, the conversation and the
 * classification come from the server: the caller's own sign-in, the conversation's recorded meeting, and an attendee
 * the service confirms is theirs (`meeting-api.ts`). The app names an event from a fixed list and a handful of
 * attributes from a fixed list, each bounded, so a report cannot carry free text into the record beyond a short error.
 * A time the app gives is kept only when it is near the server's own clock.
 */
import { CONNECTIVITY_SAMPLE_EVENT, wellFormedPrefix, type MeetingEventRecord } from './meeting-event-shape.js';
import { emitEmfMetric } from './emf-metrics.js';

/**
 * The events the app files about its own attendee: the Amazon Chime SDK client's `eventDidReceive` names, then what the
 * app reads from the session itself (SPEC-ASSISTANT-MEETINGS FR44): its connection, its own mute, and its devices.
 */
export const CLIENT_MEETING_EVENTS = [
  'meetingStartRequested', 'meetingStartSucceeded', 'meetingStartFailed', 'meetingEnded', 'meetingFailed', 'meetingReconnected',
  'attendeePresenceReceived', 'audioInputFailed', 'videoInputFailed', 'signalingDropped', 'sendingAudioFailed',
  'sendingAudioRecovered', 'receivingAudioDropped',
  'connectivitySample', 'connectionBecamePoor', 'connectionBecameGood', 'videoStopSuggested',
  'audioMuted', 'audioUnmuted',
  'audioInputChanged', 'videoInputChanged', 'audioOutputChanged', 'devicesChanged', 'devicePermissionDenied',
] as const;

/**
 * HOW OFTEN AN APP READS ITS CONNECTION, and the grid a reading is filed on. The SDK measures every second; the app files
 * the mean of each interval's readings, one event per attendee per interval, and a change of health at once. The server
 * files a reading at the start of its interval, so one attendee has at most one reading per interval on the natural key
 * (meeting, attendee, type, time) whatever an app sends: the projection's unique index and every reader's fold keep one.
 */
export const CONNECTIVITY_SAMPLE_INTERVAL_MS = 15_000;

/** The connection's health as the SDK's connection monitor judges it. */
export const CONNECTION_HEALTH = ['good', 'poor'] as const;
/** Which kind of device an event is about, by the browser's own `MediaDeviceInfo.kind`. */
export const DEVICE_KINDS = ['audioinput', 'videoinput', 'audiooutput'] as const;
/**
 * WHAT KIND OF DEVICE WAS CHOSEN, never which one. A device's label and id can name a person ("Jane's AirPods") or a
 * machine, so the app sends only the class it reads from the label, and `none` when the input was released.
 */
export const DEVICE_CLASSES = ['built-in', 'bluetooth', 'usb', 'virtual', 'unknown', 'none'] as const;

/** What the app reports about a ring: answered with Join, dismissed, or left to run out. Not tied to an attendee. */
export const RING_OUTCOME_EVENTS = ['ringAnswered', 'ringDismissed', 'ringTimedOut'] as const;

/** The attendee key a ring outcome carries: the person's, under a prefix no service attendee id has. */
export const RING_KEY_PREFIX = 'ring#';

export type ClientMeetingEvent = typeof CLIENT_MEETING_EVENTS[number] | typeof RING_OUTCOME_EVENTS[number];

/** An event that fails a join, a device or the connection: what a failure figure counts. */
export const CLIENT_FAILURE_EVENTS: ReadonlySet<string> = new Set([
  'meetingStartFailed', 'meetingFailed', 'audioInputFailed', 'videoInputFailed', 'signalingDropped', 'sendingAudioFailed', 'receivingAudioDropped',
]);

/** The attributes kept, each with its type. Anything else the app sends is dropped. */
const STRING_ATTRIBUTES = ['browserName', 'browserVersion', 'osName', 'osVersion', 'deviceName', 'sdkVersion', 'sdkName', 'meetingStatus', 'errorMessage'] as const;
/** Attributes kept only when they are one of a fixed set of values. */
const ENUM_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  connectionHealth: CONNECTION_HEALTH, deviceKind: DEVICE_KINDS, deviceClass: DEVICE_CLASSES,
};
const DAY_MS = 86_399_999;
/**
 * Numeric attributes, each kept only inside its bounds and to its precision. One outside them is dropped, never clamped,
 * so no figure is folded from a value the app could not have measured.
 */
const NUMBER_ATTRIBUTES: Readonly<Record<string, { max: number; decimals: number }>> = {
  meetingStartDurationMs: { max: DAY_MS, decimals: 0 },
  attendeePresenceDurationMs: { max: DAY_MS, decimals: 0 },
  signalingOpenDurationMs: { max: DAY_MS, decimals: 0 },
  retryCount: { max: DAY_MS, decimals: 0 },
  ringSecondsLeft: { max: DAY_MS, decimals: 0 },
  // A connectivity reading (`connectivitySample`): packet loss in percent, times in milliseconds, rates in kilobits per
  // second, and how many of the SDK's one-second readings the interval's means were taken over.
  audioLossSendPct: { max: 100, decimals: 1 },
  audioLossReceivePct: { max: 100, decimals: 1 },
  audioJitterMs: { max: 60_000, decimals: 0 },
  rttMs: { max: 60_000, decimals: 0 },
  availableSendKbps: { max: 10_000_000, decimals: 0 },
  availableReceiveKbps: { max: 10_000_000, decimals: 0 },
  videoSendKbps: { max: 10_000_000, decimals: 0 },
  videoReceiveKbps: { max: 10_000_000, decimals: 0 },
  readings: { max: 600, decimals: 0 },
  // How many devices of one kind the browser lists after a change (`devicesChanged`).
  deviceCount: { max: 256, decimals: 0 },
};

export const MAX_EVENTS_PER_REPORT = 20;
const MAX_STRING = 200;
/** How far an app's clock may be from the server's before its time is replaced by the server's. */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;

const isClientEvent = (name: unknown): name is ClientMeetingEvent =>
  typeof name === 'string' && ((CLIENT_MEETING_EVENTS as readonly string[]).includes(name) || (RING_OUTCOME_EVENTS as readonly string[]).includes(name));

export const isRingOutcome = (name: string): boolean => (RING_OUTCOME_EVENTS as readonly string[]).includes(name);

/** The attributes kept from one reported event. */
export function keptAttributes(raw: unknown): Record<string, string | number> {
  const a = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const out: Record<string, string | number> = {};
  // Cut on characters and kept well formed, so a report the projection takes is never refused for a split character.
  for (const k of STRING_ATTRIBUTES) if (typeof a[k] === 'string' && a[k]) out[k] = wellFormedPrefix(a[k] as string, MAX_STRING);
  for (const [k, allowed] of Object.entries(ENUM_ATTRIBUTES)) {
    if (typeof a[k] === 'string' && allowed.includes(a[k] as string)) out[k] = a[k] as string;
  }
  for (const [k, { max, decimals }] of Object.entries(NUMBER_ATTRIBUTES)) {
    const n = a[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max) out[k] = Math.round(n * 10 ** decimals) / 10 ** decimals;
  }
  return out;
}

/**
 * The time an event is filed at: the app's, when it is near the server's clock, else the server's. `position` is the
 * event's place in its report, added to the server's time in milliseconds, so two events of one type that one report
 * files at the server's time stay two events on the natural key, in the order the app sent them.
 */
export function eventTime(at: unknown, now: number, position = 0): { eventAt: string; clockAdjusted: boolean } {
  const t = typeof at === 'number' ? at : NaN;
  const ok = Number.isFinite(t) && Math.abs(t - now) <= CLOCK_TOLERANCE_MS;
  return { eventAt: new Date(ok ? t : now + position).toISOString(), clockAdjusted: !ok };
}

/** The start of the sampling interval an instant falls in, as the time a connectivity reading is filed at. */
export function sampleIntervalOf(t: number): string {
  return new Date(Math.floor(t / CONNECTIVITY_SAMPLE_INTERVAL_MS) * CONNECTIVITY_SAMPLE_INTERVAL_MS).toISOString();
}

/** What the server knows about the report before it reads a single event. */
export interface ReportContext {
  meetingId: string;
  channelArn: string;
  classification: string;
  personId: string;
  /** The attendee the service confirmed is the caller's, or null for a report of ring outcomes only. */
  attendeeId: string | null;
  now: number;
}

/**
 * The records a report becomes, or why it is refused. An event outside the lists is skipped and counted, so an app on a
 * newer release can report what this one does not file yet without losing the rest. A meeting event needs the caller's
 * confirmed attendee; a ring outcome needs only the caller.
 */
export function recordsFromReport(events: unknown, ctx: ReportContext): { records: MeetingEventRecord[]; skipped: number } | { refused: string } {
  if (!Array.isArray(events) || events.length === 0) return { refused: 'NO_EVENTS' };
  if (events.length > MAX_EVENTS_PER_REPORT) return { refused: 'TOO_MANY_EVENTS' };
  const records: MeetingEventRecord[] = [];
  const sampledIntervals = new Set<string>();
  const filedKeys = new Set<string>();
  let skipped = 0;
  for (const [position, e] of events.entries()) {
    const ev = e && typeof e === 'object' ? e as Record<string, unknown> : {};
    if (!isClientEvent(ev.name)) { skipped++; continue; }
    const ring = isRingOutcome(ev.name);
    if (!ring && !ctx.attendeeId) { skipped++; continue; }
    // A RING OUTCOME IS TIMED BY THE SERVER. The app sends it the moment it happens, and its time is read against the
    // meeting's creation, which is also the server's: the app's own clock would carry its offset into time-to-answer.
    const timed = ring
      ? { eventAt: new Date(ctx.now + position).toISOString(), clockAdjusted: false }
      : eventTime(ev.at, ctx.now, position);
    const { clockAdjusted } = timed;
    let { eventAt } = timed;
    if (ev.name === CONNECTIVITY_SAMPLE_EVENT) {
      // ONE READING PER ATTENDEE PER INTERVAL: filed at its interval's start, and a second reading for an interval
      // this report already holds is skipped (the store's natural key keeps one across reports).
      eventAt = sampleIntervalOf(Date.parse(eventAt));
      if (sampledIntervals.has(eventAt)) { skipped++; continue; }
      sampledIntervals.add(eventAt);
    } else {
      // ONE NATURAL KEY PER EVENT: two events of one type the app stamped in the same millisecond (a headset's input and
      // output changing in one tick) are filed a millisecond apart, in the order sent, so both stores keep both.
      while (filedKeys.has(`${ev.name}|${eventAt}`)) eventAt = new Date(Date.parse(eventAt) + 1).toISOString();
      filedKeys.add(`${ev.name}|${eventAt}`);
    }
    records.push({
      meeting_id: ctx.meetingId,
      channel_arn: ctx.channelArn,
      classification: ctx.classification,
      event_type: ev.name,
      source: 'client',
      // A ring outcome belongs to no attendee; it is keyed by the person, so two people answering in the same instant are
      // two events on the natural key rather than one. The roster reads the service's records only.
      attendee_id: ring ? `${RING_KEY_PREFIX}${ctx.personId}` : ctx.attendeeId,
      person_key: ctx.personId,
      is_content: false,
      network_transport: null,
      event_at: eventAt,
      detail: { ...keptAttributes(ev.attributes), ...(clockAdjusted ? { clockAdjusted: true } : {}) },
    });
  }
  return { records, skipped };
}

/**
 * THE ONE MEETING METRIC: `ClientFailure`, with no dimension, which the alarm watches (`meetings-stack.ts`). Every figure
 * a person reads about meetings, failures by type included, comes from the recorded events through the console's one
 * query (`meeting-figures.ts`, tenet D7); this series exists only because an alarm needs a metric to fire on.
 */
export const MEETING_METRICS = { clientFailure: 'ClientFailure' } as const;

/**
 * Count a filed report's failures on the alarm's series, through the shared emitter (`emitEmfMetric`), once the events
 * are in the record they summarize. A report with no failure emits nothing.
 */
export function recordClientFailures(records: MeetingEventRecord[], namespace: string): void {
  const failures = records.filter((r) => CLIENT_FAILURE_EVENTS.has(r.event_type)).length;
  if (failures === 0) return;
  emitEmfMetric({
    namespace,
    metrics: [{ name: MEETING_METRICS.clientFailure, unit: 'Count' }],
    dimensionSets: [[]],
    properties: { [MEETING_METRICS.clientFailure]: failures },
  });
}
