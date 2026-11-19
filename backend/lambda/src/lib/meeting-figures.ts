/**
 * EVERY MEETING FIGURE, DERIVED FROM THE RECORDED EVENTS (SPEC-ASSISTANT-MEETINGS FR22 to FR26).
 *
 * One pure fold over meeting events, whichever store they were read from (the archive through Athena, or the Aurora
 * projection), so the two can never disagree about a number. Nothing here keeps a count beside the events: the roster,
 * each meeting's summary and every figure across meetings are recomputed from the rows each time.
 *
 * WHAT IT REFUSES TO DO, each a way a meeting figure has gone confidently wrong elsewhere:
 *  - count an attendee record as a person. One person who reconnects, moves from phone to browser, or shares a screen
 *    has several attendee records and is one roster row, keyed by their AppInstanceUser id (FR21, FR26). A shared
 *    screen is attributed to its owner and never counted as a person.
 *  - take last-minus-first as connected time. Connected time is the union of each person's join-to-leave intervals, so
 *    a reconnect does not count the gap and two concurrent attendee records do not count twice.
 *  - read a transport from an id's spelling. A phone attendee is one the service says joined over the phone network.
 *  - show a figure over nothing as zero. Every figure carries the population it was computed over, and one with too
 *    small a population is null (FR23).
 *  - trust a redelivery. Delivery is at-least-once, so rows are folded on their natural key (meeting, attendee, type,
 *    time) before anything is counted.
 */
import { CLIENT_FAILURE_EVENTS, RING_KEY_PREFIX } from './meeting-client-events.js';
import { CONNECTIVITY_SAMPLE_EVENT } from './meeting-event-shape.js';
import { meetingMaxMinutes } from './meeting-watch.js';
import type { MeetingEventRecord } from './meeting-event-shape.js';

/** A meeting event as either store returns it: the one shape every writer files (`meeting-event-shape.ts`). */
export type MeetingEventRow = MeetingEventRecord;

/** The events that mark a meeting's start: the service's own, and the platform's record that it created the meeting. */
const START_EVENTS: ReadonlySet<string> = new Set(['MeetingStarted', 'meetingCreated']);

/**
 * Whether these events hold the meeting's start. A window holds a meeting when it holds the meeting's start: one that
 * started earlier has only its later events in the window, and a summary built from those would invent its start, its
 * length and its people.
 */
export function startsInEvents(events: MeetingEventRow[]): boolean {
  return events.some((r) => START_EVENTS.has(r.event_type));
}

/** A figure and the population it was computed over. `value` is null when that population cannot support it. */
export interface Figure {
  value: number | null;
  over: number;
}

/** Percentiles need this many samples; below it they are not shown. */
export const MIN_SAMPLES_FOR_PERCENTILE = 5;
/** The least time a meeting with no recorded end runs before it is reported as abandoned rather than running. */
export const ABANDONED_AFTER_MS = 4 * 60 * 60_000;

/** How long past the deployment's meeting limit a meeting's end may take to be recorded: the watch's end and the service's event. */
export const ABANDONED_GRACE_MS = 30 * 60_000;

/**
 * WHEN A MEETING WITH NO RECORDED END IS ABANDONED: past the longest a meeting of this deployment runs (`meetingMaxMinutes`,
 * which its watch ends it at) and the time its end takes to be recorded, and never sooner than {@link ABANDONED_AFTER_MS}. A
 * meeting still within its limit is running, however long the limit is.
 */
export function abandonedAfterMs(maxMinutes: number = meetingMaxMinutes()): number {
  return Math.max(ABANDONED_AFTER_MS, maxMinutes * 60_000 + ABANDONED_GRACE_MS);
}

const figure = (value: number | null, over: number): Figure => ({ value: over > 0 ? value : null, over });

/** The nearest-rank percentile of a sample, or null below the minimum sample. */
export function percentile(values: number[], p: number): Figure {
  if (values.length < MIN_SAMPLES_FOR_PERCENTILE) return { value: null, over: values.length };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return { value: sorted[rank], over: values.length };
}

const ratio = (num: number, den: number): Figure => figure(den > 0 ? num / den : null, den);
const mean = (xs: number[]): Figure => figure(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, xs.length);

type Interval = { from: number; to: number };

/** A set of intervals as the fewest that cover the same time, in order: overlapping or touching ones become one. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.to > i.from).sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const i of sorted) {
    const cur = out[out.length - 1];
    if (!cur || i.from > cur.to) out.push({ ...i }); else cur.to = Math.max(cur.to, i.to);
  }
  return out;
}

/** The total length of a set of intervals, overlaps counted once. */
export function unionMs(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce((n, i) => n + (i.to - i.from), 0);
}

/**
 * What an incident is, for the console's incident lists: a connection the service saw fail (`drop`), a join the app
 * reported failing, a microphone, camera or audio stream that failed, or the app losing its connection to the meeting.
 */
export type IncidentKind = 'drop' | 'joinFailure' | 'mediaFailure' | 'connectionFailure';
export const INCIDENT_KINDS: readonly IncidentKind[] = ['drop', 'joinFailure', 'mediaFailure', 'connectionFailure'];
const JOIN_FAILURE_EVENTS: ReadonlySet<string> = new Set(['meetingStartFailed']);
const CONNECTION_FAILURE_EVENTS: ReadonlySet<string> = new Set(['signalingDropped', 'meetingFailed']);

/** The kind of incident an event is, or null for an event that is not one. Every app failure is exactly one kind. */
export function incidentKindOf(eventType: string): IncidentKind | null {
  if (eventType === 'AttendeeDropped') return 'drop';
  if (!CLIENT_FAILURE_EVENTS.has(eventType)) return null;
  if (JOIN_FAILURE_EVENTS.has(eventType)) return 'joinFailure';
  if (CONNECTION_FAILURE_EVENTS.has(eventType)) return 'connectionFailure';
  return 'mediaFailure';
}

/** One incident: what failed, for whom, when, and in which meeting. */
export interface MeetingIncident {
  kind: IncidentKind;
  meetingId: string;
  personKey: string;
  eventType: string;
  at: string;
  /** The short error the app reported with a failure, where it gave one. */
  errorMessage: string | null;
}

/** One stretch of time, overlapping attendee records already merged. */
export interface Span { from: string; to: string }

/** The rows with redeliveries folded away, in time order. */
export function distinctEvents(rows: MeetingEventRow[]): MeetingEventRow[] {
  const seen = new Map<string, MeetingEventRow>();
  for (const r of rows) seen.set(`${r.meeting_id}|${r.attendee_id ?? ''}|${r.event_type}|${r.event_at}`, r);
  return [...seen.values()].sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
}

/** One person's row on a meeting's roster. */
export interface RosterRow {
  personKey: string;
  /** `present` while any of their attendee records is connected; `left` once none is. */
  state: 'present' | 'left';
  firstJoinedAt: string;
  lastLeftAt: string | null;
  connectedSeconds: number;
  /** Times a connection of theirs failed rather than ended (`AttendeeDropped`). */
  drops: number;
  /** Times their app reconnected on its own. */
  reconnects: number;
  /** Each transport they joined over, with when: the change is the interesting part. */
  transports: Array<{ transport: string; at: string }>;
  phone: boolean;
  cameraSeconds: number;
  sharedSeconds: number;
  joinLatencyMs: number | null;
  /** Milliseconds from their join until their app first heard who else was in the meeting (`attendeePresenceReceived`). */
  presenceReceivedMs: number | null;
  /** The browser and the system each with its version, the device's name where the app read one, and the SDK. */
  device: { browser: string | null; os: string | null; name: string | null; sdk: string | null };
  /** Seconds any of their connections was poor, overlaps counted once (`AttendeeConnectivity.poorSeconds`). */
  poorConnectionSeconds: number;
  /** `error` after a failure their app reported, `warning` after a drop, a reconnect or a poor connection, else `good`. */
  quality: 'good' | 'warning' | 'error';
  failures: string[];
  /** Each failure their app reported: what failed, when, and the short error it gave, where it gave one. */
  failureEvents: Array<{ eventType: string; at: string; errorMessage: string | null }>;
  /**
   * WHEN they were connected, on camera and sharing: the intervals the seconds above are summed from, so the console's
   * timeline and the roster's figures cannot disagree. An interval still open is closed where the figures close it: the
   * meeting's end, now while it runs, else the last event seen.
   */
  spans: { connected: Span[]; camera: Span[]; sharing: Span[] };
}

/**
 * ONE CONNECTIVITY READING of one attendee (`connectivitySample`): the means of the SDK's one-second metrics over one
 * sampling interval, at the interval's start. A metric the app had no reading for is null, never zero.
 */
export interface ConnectivitySample {
  at: string;
  /** The connection monitor's judgment when the interval closed. */
  health: 'good' | 'poor' | null;
  /** Audio packets this attendee sent that were lost, in percent. */
  audioLossSendPct: number | null;
  /** Audio packets sent to this attendee that were lost, in percent. */
  audioLossReceivePct: number | null;
  /** Jitter on the audio this attendee received, in milliseconds. */
  audioJitterMs: number | null;
  /** Round trip to the media service, in milliseconds. */
  rttMs: number | null;
  availableSendKbps: number | null;
  availableReceiveKbps: number | null;
  /** Video this attendee sent and received, in kilobits per second; null while there was none. */
  videoSendKbps: number | null;
  videoReceiveKbps: number | null;
}

/** One attendee record's connection over the meeting, for a meeting's detail. */
export interface AttendeeConnectivity {
  personKey: string;
  attendeeId: string;
  /** The readings, in time order. */
  samples: ConnectivitySample[];
  /** Each change of health the app reported the moment it happened, in time order. */
  healthChanges: Array<{ at: string; health: 'good' | 'poor' }>;
  /** Seconds the connection was poor: from each change to poor to the next change to good, or to the attendee's close. */
  poorSeconds: number;
  /** Times the SDK judged the connection too weak to send video. */
  videoStopSuggestions: number;
}

export type MeetingStatus = 'active' | 'ended' | 'abandoned';

export interface MeetingSummary {
  meetingId: string;
  channelArn: string;
  classification: string;
  status: MeetingStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Null until the meeting has ended: a running meeting has no duration yet. */
  durationSeconds: number | null;
  startedVia: 'person' | 'workflow' | null;
  /** Who started it, as the platform recorded its creation: an AppInstanceUser id, or the workflow's identity. */
  createdBy: string | null;
  /** Its hosts as decided at the start, by AppInstanceUser id. */
  hosts: string[];
  /** The AWS Region Amazon Chime SDK hosts its media in, as recorded at its creation. */
  mediaRegion: string | null;
  /** Whether its live transcription ran at any point (the service's `TranscriptionStarted`). */
  transcribed: boolean;
  people: number;
  /** People in it now: connected on the service's record while it runs. Zero once it has ended. */
  present: number;
  phonePeople: number;
  dropEvents: number;
  peopleWhoDropped: number;
  reconnects: number;
  clientFailures: number;
  joinLatencyMs: { p50: Figure; p95: Figure };
  ring: { answered: number; dismissed: number; timedOut: number };
  roster: RosterRow[];
  /** Every drop and app failure counted above, in time order: the rows the console's incident lists are built from. */
  incidents: MeetingIncident[];
  /** How an ended meeting ended, as its events show it; null while it has no recorded end. */
  endedHow: MeetingEndedHow | null;
}

/**
 * HOW A MEETING ENDED, as far as its events say. `everyoneLeft`: the last person left at least
 * {@link EMPTIED_BEFORE_END_MS} before the service ended it, so it closed because it was empty. `withPeopleIn`: someone was
 * still in it within that time of its end, so it was ended for everyone (by a person, the console or the service).
 * `nobodyJoined`: no one was ever on its roster.
 */
export type MeetingEndedHow = 'everyoneLeft' | 'withPeopleIn' | 'nobodyJoined';
/** How long before its end a meeting must have emptied to have ended because everyone left. */
export const EMPTIED_BEFORE_END_MS = 30_000;

/** What the app files about its connection: a reading, a change of health, and a suggestion to stop sending video. */
const CONNECTIVITY_EVENTS: ReadonlySet<string> = new Set([CONNECTIVITY_SAMPLE_EVENT, 'connectionBecamePoor', 'connectionBecameGood', 'videoStopSuggested']);

/** A reading as the console reads it, from the attributes the server kept (`meeting-client-events.ts`). */
function sampleOf(at: string, d: Record<string, unknown>): ConnectivitySample {
  const n = (k: string): number | null => (typeof d[k] === 'number' ? d[k] as number : null);
  return {
    at,
    health: d.connectionHealth === 'good' || d.connectionHealth === 'poor' ? d.connectionHealth : null,
    audioLossSendPct: n('audioLossSendPct'),
    audioLossReceivePct: n('audioLossReceivePct'),
    audioJitterMs: n('audioJitterMs'),
    rttMs: n('rttMs'),
    availableSendKbps: n('availableSendKbps'),
    availableReceiveKbps: n('availableReceiveKbps'),
    videoSendKbps: n('videoSendKbps'),
    videoReceiveKbps: n('videoReceiveKbps'),
  };
}

const ms = (iso: string): number => Date.parse(iso);
const iso = (t: number): string => new Date(t).toISOString();

/** One meeting's summary and roster, from its events. `now` closes a running meeting's open intervals. */
export function summarizeMeeting(events: MeetingEventRow[], now: number): MeetingSummary {
  return meetingDetail(events, now).meeting;
}

/**
 * ONE MEETING'S DETAIL: its summary and roster, and each attendee record's connection over the meeting, folded together
 * so a roster row's poor-connection seconds and the series it is summed from cannot disagree.
 */
export function meetingDetail(events: MeetingEventRow[], now: number): { meeting: MeetingSummary; connectivity: AttendeeConnectivity[] } {
  const rows = distinctEvents(events);
  const first = rows[0];
  const started = rows.find((r) => r.event_type === 'MeetingStarted') ?? rows.find((r) => r.event_type === 'meetingCreated');
  const ended = rows.find((r) => r.event_type === 'MeetingEnded');
  const startedAt = started ? ms(started.event_at) : first ? ms(first.event_at) : now;
  const lastSeen = rows.length ? ms(rows[rows.length - 1].event_at) : now;
  const status: MeetingStatus = ended ? 'ended' : now - startedAt > abandonedAfterMs() ? 'abandoned' : 'active';
  // Where an interval was still open: the meeting's end, else now for a running meeting, else the last thing seen.
  const closeAt = ended ? ms(ended.event_at) : status === 'active' ? now : lastSeen;
  const created = rows.find((r) => r.event_type === 'meetingCreated');

  type Person = { presence: Interval[]; open: Map<string, number>; camera: Interval[]; camOpen: Map<string, number>; share: Interval[]; shareOpen: Map<string, number>; row: RosterRow };
  const people = new Map<string, Person>();
  const personOf = (key: string, at: string): Person => {
    let p = people.get(key);
    if (!p) {
      p = {
        presence: [], open: new Map(), camera: [], camOpen: new Map(), share: [], shareOpen: new Map(),
        row: {
          personKey: key, state: 'left', firstJoinedAt: at, lastLeftAt: null, connectedSeconds: 0, drops: 0, reconnects: 0, transports: [],
          phone: false, cameraSeconds: 0, sharedSeconds: 0, joinLatencyMs: null, presenceReceivedMs: null, device: { browser: null, os: null, name: null, sdk: null }, poorConnectionSeconds: 0, quality: 'good', failures: [], failureEvents: [],
          spans: { connected: [], camera: [], sharing: [] },
        },
      };
      people.set(key, p);
    }
    return p;
  };
  const close = (open: Map<string, number>, into: Interval[], id: string, at: number) => {
    const from = open.get(id);
    if (from !== undefined) { into.push({ from, to: at }); open.delete(id); }
  };

  let dropEvents = 0;
  let clientFailures = 0;
  const incidents: MeetingIncident[] = [];
  const meetingId = first?.meeting_id ?? '';
  const incident = (r: MeetingEventRow, personKey: string) => {
    const kind = incidentKindOf(r.event_type);
    const err = r.detail?.errorMessage;
    if (kind) incidents.push({ kind, meetingId, personKey, eventType: r.event_type, at: r.event_at, errorMessage: typeof err === 'string' ? err : null });
  };
  const ring = { answered: 0, dismissed: 0, timedOut: 0 };
  const latencies: number[] = [];
  // EACH ATTENDEE RECORD'S CONNECTION, from its app's readings and health changes. A poor stretch runs to the next change
  // to good, else to that attendee leaving on the service's record, else to where the meeting's intervals close.
  type Connection = { row: AttendeeConnectivity; poorFrom: number | null; poor: Interval[] };
  const connections = new Map<string, Connection>();
  const connectionOf = (attendeeId: string, personKey: string): Connection => {
    let c = connections.get(attendeeId);
    if (!c) {
      c = { row: { personKey, attendeeId, samples: [], healthChanges: [], poorSeconds: 0, videoStopSuggestions: 0 }, poorFrom: null, poor: [] };
      connections.set(attendeeId, c);
    }
    return c;
  };
  const endPoor = (c: Connection, at: number) => {
    if (c.poorFrom !== null) { c.poor.push({ from: c.poorFrom, to: Math.max(c.poorFrom, at) }); c.poorFrom = null; }
  };
  for (const r of rows) {
    const t = ms(r.event_at);
    const key = r.person_key;
    if (r.source === 'server' && key && r.attendee_id) {
      const id = r.attendee_id;
      if (r.is_content || r.event_type.startsWith('AttendeeContent')) {
        // A SHARED SCREEN: the owner presenting, never a person in the room.
        const p = personOf(key, r.event_at);
        if (r.event_type === 'AttendeeContentJoined' || r.event_type === 'AttendeeJoined') p.shareOpen.set(id, t);
        if (['AttendeeContentLeft', 'AttendeeContentDropped', 'AttendeeLeft', 'AttendeeDropped', 'AttendeeDeleted'].includes(r.event_type)) close(p.shareOpen, p.share, id, t);
        continue;
      }
      if (r.event_type === 'AttendeeJoined') {
        const p = personOf(key, r.event_at);
        p.open.set(id, t);
        if (r.network_transport) {
          p.row.transports.push({ transport: r.network_transport, at: r.event_at });
          if (r.network_transport.toLowerCase() === 'pstn') p.row.phone = true;
        }
      } else if (r.event_type === 'AttendeeLeft' || r.event_type === 'AttendeeDropped' || r.event_type === 'AttendeeDeleted') {
        const c = connections.get(id);
        if (c) endPoor(c, t);
        const p = people.get(key);
        if (p) {
          close(p.open, p.presence, id, t);
          close(p.camOpen, p.camera, id, t);
          p.row.lastLeftAt = r.event_at;
          if (r.event_type === 'AttendeeDropped') { p.row.drops += 1; dropEvents += 1; incident(r, key); }
        }
      } else if (r.event_type === 'AttendeeVideoStarted') {
        personOf(key, r.event_at).camOpen.set(id, t);
      } else if (r.event_type === 'AttendeeVideoStopped') {
        const p = people.get(key);
        if (p) close(p.camOpen, p.camera, id, t);
      }
    } else if (r.source === 'client' && key) {
      if (r.attendee_id?.startsWith(RING_KEY_PREFIX)) {
        if (r.event_type === 'ringAnswered') ring.answered += 1;
        if (r.event_type === 'ringDismissed') ring.dismissed += 1;
        if (r.event_type === 'ringTimedOut') ring.timedOut += 1;
        continue;
      }
      const p = personOf(key, r.event_at);
      const d = r.detail ?? {};
      if (r.attendee_id && CONNECTIVITY_EVENTS.has(r.event_type)) {
        const c = connectionOf(r.attendee_id, key);
        if (r.event_type === CONNECTIVITY_SAMPLE_EVENT) c.row.samples.push(sampleOf(r.event_at, d));
        else if (r.event_type === 'videoStopSuggested') c.row.videoStopSuggestions += 1;
        else {
          const health = r.event_type === 'connectionBecamePoor' ? 'poor' : 'good';
          c.row.healthChanges.push({ at: r.event_at, health });
          if (health === 'poor') { if (c.poorFrom === null) c.poorFrom = t; } else endPoor(c, t);
        }
        continue;
      }
      if (typeof d.browserName === 'string') p.row.device.browser = d.browserName + (typeof d.browserVersion === 'string' ? ` ${d.browserVersion}` : '');
      if (typeof d.osName === 'string') p.row.device.os = d.osName + (typeof d.osVersion === 'string' ? ` ${d.osVersion}` : '');
      if (typeof d.deviceName === 'string') p.row.device.name = d.deviceName;
      if (typeof d.sdkVersion === 'string') p.row.device.sdk = d.sdkVersion;
      if (r.event_type === 'attendeePresenceReceived' && typeof d.attendeePresenceDurationMs === 'number' && p.row.presenceReceivedMs === null) {
        p.row.presenceReceivedMs = d.attendeePresenceDurationMs;
      }
      if (r.event_type === 'meetingStartSucceeded' && typeof d.meetingStartDurationMs === 'number') {
        latencies.push(d.meetingStartDurationMs);
        if (p.row.joinLatencyMs === null) p.row.joinLatencyMs = d.meetingStartDurationMs;
      }
      if (r.event_type === 'meetingReconnected') p.row.reconnects += 1;
      if (CLIENT_FAILURE_EVENTS.has(r.event_type)) {
        clientFailures += 1;
        p.row.failures.push(r.event_type);
        p.row.failureEvents.push({ eventType: r.event_type, at: r.event_at, errorMessage: typeof d.errorMessage === 'string' ? d.errorMessage : null });
        incident(r, key);
      }
    }
  }

  const connectivity: AttendeeConnectivity[] = [];
  const poorOf = new Map<string, Interval[]>();
  for (const c of connections.values()) {
    endPoor(c, closeAt);
    c.row.poorSeconds = Math.round(unionMs(c.poor) / 1000);
    poorOf.set(c.row.personKey, [...(poorOf.get(c.row.personKey) ?? []), ...c.poor]);
    connectivity.push(c.row);
  }
  connectivity.sort((a, b) => (a.samples[0]?.at ?? a.healthChanges[0]?.at ?? '').localeCompare(b.samples[0]?.at ?? b.healthChanges[0]?.at ?? ''));

  const roster: RosterRow[] = [];
  for (const p of people.values()) {
    const stillOpen = p.open.size > 0;
    for (const [id] of [...p.open]) close(p.open, p.presence, id, closeAt);
    for (const [id] of [...p.camOpen]) close(p.camOpen, p.camera, id, closeAt);
    for (const [id] of [...p.shareOpen]) close(p.shareOpen, p.share, id, closeAt);
    // Someone who only ever reported from their app, with no join on the service's record, is not on the roster.
    if (p.presence.length === 0 && p.share.length === 0) continue;
    p.row.state = stillOpen && status === 'active' ? 'present' : 'left';
    p.row.firstJoinedAt = p.presence.length ? iso(Math.min(...p.presence.map((i) => i.from))) : p.row.firstJoinedAt;
    const spans = (xs: Interval[]): Span[] => mergeIntervals(xs).map((i) => ({ from: iso(i.from), to: iso(i.to) }));
    p.row.spans = { connected: spans(p.presence), camera: spans(p.camera), sharing: spans(p.share) };
    p.row.connectedSeconds = Math.round(unionMs(p.presence) / 1000);
    p.row.cameraSeconds = Math.round(unionMs(p.camera) / 1000);
    p.row.sharedSeconds = Math.round(unionMs(p.share) / 1000);
    p.row.poorConnectionSeconds = Math.round(unionMs(poorOf.get(p.row.personKey) ?? []) / 1000);
    const poorly = (poorOf.get(p.row.personKey) ?? []).length > 0;
    p.row.quality = p.row.failures.length ? 'error' : p.row.drops || p.row.reconnects || poorly ? 'warning' : 'good';
    roster.push(p.row);
  }
  roster.sort((a, b) => a.firstJoinedAt.localeCompare(b.firstJoinedAt));
  const lastPresent = Math.max(-Infinity, ...roster.flatMap((r) => r.spans.connected.map((s) => ms(s.to))));
  const endedHow: MeetingEndedHow | null = !ended ? null
    : roster.length === 0 ? 'nobodyJoined'
      : lastPresent <= ms(ended.event_at) - EMPTIED_BEFORE_END_MS ? 'everyoneLeft' : 'withPeopleIn';

  const meeting: MeetingSummary = {
    meetingId,
    channelArn: first?.channel_arn ?? '',
    classification: first?.classification ?? '',
    status,
    startedAt: rows.length ? iso(startedAt) : null,
    endedAt: ended ? ended.event_at : null,
    durationSeconds: ended ? Math.round((ms(ended.event_at) - startedAt) / 1000) : null,
    startedVia: created?.detail?.startedVia === 'workflow' ? 'workflow' : created?.detail?.startedVia === 'person' ? 'person' : null,
    createdBy: created?.person_key ?? null,
    hosts: Array.isArray(created?.detail?.hosts) ? (created.detail.hosts as unknown[]).filter((h): h is string => typeof h === 'string') : [],
    mediaRegion: typeof created?.detail?.mediaRegion === 'string' ? created.detail.mediaRegion : null,
    transcribed: rows.some((r) => r.event_type === 'TranscriptionStarted'),
    people: roster.length,
    present: roster.filter((r) => r.state === 'present').length,
    phonePeople: roster.filter((r) => r.phone).length,
    dropEvents,
    peopleWhoDropped: roster.filter((r) => r.drops > 0).length,
    reconnects: roster.reduce((n, r) => n + r.reconnects, 0),
    clientFailures,
    joinLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    ring,
    roster,
    incidents,
    endedHow,
  };
  return { meeting, connectivity };
}

/** The figures across a set of meetings, each with the population it is over. */
export interface MeetingFigures {
  meetings: number;
  byStatus: Record<MeetingStatus, number>;
  durationSeconds: Figure;
  peoplePerMeeting: Figure;
  /** People who dropped at least once, over people. One person dropping four times is one. */
  dropRate: Figure;
  dropEvents: number;
  dropsPerPersonWhoDropped: Figure;
  phoneShare: Figure;
  joinLatencyMs: { p50: Figure; p95: Figure; mean: Figure };
  /** Meetings in which no app reported a failure, over meetings: the window's meeting health. */
  healthyMeetings: Figure;
  /** Joins that succeeded, over joins that succeeded or failed, as the apps reported them. */
  joinSuccessRate: Figure;
  failuresByType: Record<string, number>;
  reconnects: number;
  ring: { sent: number; answered: number; dismissed: number; timedOut: number; answerRate: Figure; timeToAnswerMs: { p50: Figure; p95: Figure } };
  /** Each day (UTC) a meeting started on, with those meetings' people, drops and app failures. */
  byDay: DayFigures[];
  browsers: Record<string, number>;
  operatingSystems: Record<string, number>;
  sdkVersions: Record<string, number>;
  startedVia: { person: number; workflow: number; unknown: number };
  /** People by their roster quality, counted once per person per meeting. */
  quality: Record<RosterRow['quality'], number>;
  /** Each kind of incident: how many there were, and the most recent {@link INCIDENTS_LISTED}, newest first. */
  incidents: Record<IncidentKind, { count: number; recent: MeetingIncident[] }>;
}

export interface DayFigures { day: string; meetings: number; people: number; dropEvents: number; clientFailures: number }

/** The most incidents of one kind an answer lists; the count says how many there were. */
export const INCIDENTS_LISTED = 50;

const tally = (into: Record<string, number>, key: string | null) => { if (key) into[key] = (into[key] ?? 0) + 1; };

/**
 * Every figure across the meetings that STARTED in these events. A meeting whose start is not among them began before
 * the window, so it is not one of the window's meetings and none of its rows count (`startsInEvents`).
 */
export function meetingFigures(events: MeetingEventRow[], now: number): { figures: MeetingFigures; meetings: MeetingSummary[] } {
  const all = new Map<string, MeetingEventRow[]>();
  for (const e of events) { const list = all.get(e.meeting_id) ?? []; list.push(e); all.set(e.meeting_id, list); }
  const byMeeting = new Map([...all].filter(([, rows]) => startsInEvents(rows)));
  const meetings = [...byMeeting.values()].map((rows) => summarizeMeeting(rows, now))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  const durations = meetings.filter((m) => m.durationSeconds !== null).map((m) => m.durationSeconds as number);
  const people = meetings.reduce((n, m) => n + m.people, 0);
  const dropped = meetings.reduce((n, m) => n + m.peopleWhoDropped, 0);
  const dropEvents = meetings.reduce((n, m) => n + m.dropEvents, 0);
  const phone = meetings.reduce((n, m) => n + m.phonePeople, 0);

  const latencies: number[] = [];
  let succeeded = 0;
  let startFailed = 0;
  const failuresByType: Record<string, number> = {};
  const answerTimes: number[] = [];
  for (const rows of byMeeting.values()) {
    const d = distinctEvents(rows);
    const created = d.find((r) => r.event_type === 'meetingCreated');
    for (const r of d) {
      if (r.source !== 'client') continue;
      if (r.event_type === 'meetingStartSucceeded') {
        succeeded += 1;
        const v = r.detail?.meetingStartDurationMs;
        if (typeof v === 'number') latencies.push(v);
      }
      if (r.event_type === 'meetingStartFailed') startFailed += 1;
      if (CLIENT_FAILURE_EVENTS.has(r.event_type)) tally(failuresByType, r.event_type);
      // Two times on the server's clock: the ring went out when the meeting was created, and a ring outcome is filed at
      // the moment the server received it (`recordsFromReport`), so no device's clock enters the figure.
      if (r.event_type === 'ringAnswered' && created) {
        const answeredIn = ms(r.event_at) - ms(created.event_at);
        if (answeredIn >= 0) answerTimes.push(answeredIn);
      }
    }
  }

  const browsers: Record<string, number> = {};
  const operatingSystems: Record<string, number> = {};
  const sdkVersions: Record<string, number> = {};
  const byDay = new Map<string, DayFigures>();
  const quality: Record<RosterRow['quality'], number> = { good: 0, warning: 0, error: 0 };
  const allIncidents: MeetingIncident[] = [];
  const startedVia = { person: 0, workflow: 0, unknown: 0 };
  const byStatus: Record<MeetingStatus, number> = { active: 0, ended: 0, abandoned: 0 };
  const ring = { sent: 0, answered: 0, dismissed: 0, timedOut: 0 };
  for (const m of meetings) {
    byStatus[m.status] += 1;
    startedVia[m.startedVia ?? 'unknown'] += 1;
    if (m.startedVia) ring.sent += 1;
    ring.answered += m.ring.answered;
    ring.dismissed += m.ring.dismissed;
    ring.timedOut += m.ring.timedOut;
    if (m.startedAt) {
      const day = m.startedAt.slice(0, 10);
      const d = byDay.get(day) ?? { day, meetings: 0, people: 0, dropEvents: 0, clientFailures: 0 };
      d.meetings += 1; d.people += m.people; d.dropEvents += m.dropEvents; d.clientFailures += m.clientFailures;
      byDay.set(day, d);
    }
    // Counted once per person per meeting, so a person who reconnects is not several browsers.
    for (const r of m.roster) {
      tally(browsers, r.device.browser); tally(operatingSystems, r.device.os); tally(sdkVersions, r.device.sdk);
      quality[r.quality] += 1;
    }
    allIncidents.push(...m.incidents);
  }
  const outcomes = ring.answered + ring.dismissed + ring.timedOut;
  allIncidents.sort((a, b) => b.at.localeCompare(a.at));
  const incidents = Object.fromEntries(INCIDENT_KINDS.map((k) => {
    const of = allIncidents.filter((i) => i.kind === k);
    return [k, { count: of.length, recent: of.slice(0, INCIDENTS_LISTED) }];
  })) as MeetingFigures['incidents'];

  return {
    meetings,
    figures: {
      meetings: meetings.length,
      byStatus,
      durationSeconds: mean(durations),
      peoplePerMeeting: mean(meetings.map((m) => m.people)),
      dropRate: ratio(dropped, people),
      dropEvents,
      dropsPerPersonWhoDropped: ratio(dropEvents, dropped),
      phoneShare: ratio(phone, people),
      joinLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), mean: mean(latencies) },
      healthyMeetings: ratio(meetings.filter((m) => m.clientFailures === 0).length, meetings.length),
      joinSuccessRate: ratio(succeeded, succeeded + startFailed),
      failuresByType,
      reconnects: meetings.reduce((n, m) => n + m.reconnects, 0),
      ring: {
        ...ring,
        answerRate: ratio(ring.answered, outcomes),
        timeToAnswerMs: { p50: percentile(answerTimes, 50), p95: percentile(answerTimes, 95) },
      },
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      browsers,
      operatingSystems,
      sdkVersions,
      startedVia,
      quality,
      incidents,
    },
  };
}
