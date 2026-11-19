/**
 * WHAT GAVE AN ATTENDEE A POOR EXPERIENCE IN ONE MEETING (SPEC-ASSISTANT-MEETINGS FR74), folded from the meeting's
 * recorded events and its connectivity readings (FR44), so the console's first view of a meeting can say who suffered,
 * from what, when and for how long. Like every meeting figure it is derived on the server from the record (FR22); the
 * console draws it and computes none of it.
 *
 * Two kinds of issue:
 *  - A SUSTAINED STRETCH of a connection measure past its threshold: audio packet loss either way, received jitter and
 *    round trip, read from consecutive 15 second readings, and the connection monitor's own poor stretches. A stretch
 *    counts once it lasts at least `sustainedSeconds`, so one bad reading is not an issue.
 *  - A MOMENT the record names: a dropped connection (until that person's next join, if they came back), a reconnect,
 *    signaling dropped, a device that failed or a microphone permission refused, audio that stopped sending (until it
 *    recovered) or receiving, and a join that failed.
 *
 * THE THRESHOLDS ARE THE DEPLOYMENT'S: declared defaults here, tuned by `meetingExperienceThresholds` in
 * `deploy.config.json` (the `MEETING_EXPERIENCE_THRESHOLDS` environment of the console's meetings function), and answered
 * with the issues, so the console draws the same lines it detected against.
 *
 * A person is their AppInstanceUser id, as the record keeps it.
 */
import { RING_KEY_PREFIX } from './meeting-client-events.js';
import { CONNECTIVITY_SAMPLE_EVENT } from './meeting-event-shape.js';
import type { AttendeeConnectivity, ConnectivitySample, MeetingEventRow } from './meeting-figures.js';

/** The thresholds a stretch of readings is judged against. */
export interface ExperienceThresholds {
  /** Audio packets lost, either way, in percent: a reading above it is poor. */
  packetLossPct: number;
  /** Jitter on the audio received, in milliseconds. */
  jitterMs: number;
  /** Round trip to the media service, in milliseconds. */
  roundTripMs: number;
  /** How long readings must stay past a threshold before the stretch is an issue, in seconds. */
  sustainedSeconds: number;
}

/**
 * THE DECLARED DEFAULTS. Audio loss above 3% is where speech is audibly broken up even with the codec's concealment;
 * jitter above 30 ms and a round trip above 300 ms are where conversation starts to talk over itself (ITU-T G.114 puts
 * one-way delay past 150 ms as noticeable). 30 seconds is two consecutive readings, so a single 15 second blip is not an
 * issue and a half-minute of it is.
 */
export const DEFAULT_EXPERIENCE_THRESHOLDS: Readonly<ExperienceThresholds> = Object.freeze({
  packetLossPct: 3, jitterMs: 30, roundTripMs: 300, sustainedSeconds: 30,
});

/** The bounds a deployment's value must fall in; one outside them keeps the default. */
const BOUNDS: Record<keyof ExperienceThresholds, { min: number; max: number }> = {
  packetLossPct: { min: 0.1, max: 100 },
  jitterMs: { min: 1, max: 10_000 },
  roundTripMs: { min: 1, max: 60_000 },
  sustainedSeconds: { min: 15, max: 3_600 },
};

/**
 * The deployment's thresholds: the declared defaults, each replaced by the deployment's value where it set one inside
 * its bounds. `raw` is a JSON object of any of the four keys; anything unreadable keeps the defaults.
 */
export function experienceThresholds(raw: string | undefined = process.env.MEETING_EXPERIENCE_THRESHOLDS): ExperienceThresholds {
  const out: ExperienceThresholds = { ...DEFAULT_EXPERIENCE_THRESHOLDS };
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const key of Object.keys(BOUNDS) as Array<keyof ExperienceThresholds>) {
    const v = (parsed as Record<string, unknown>)[key];
    const n = typeof v === 'string' && v.trim() ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n >= BOUNDS[key].min && n <= BOUNDS[key].max) out[key] = n;
  }
  return out;
}

/** What an issue was. */
export type ExperienceIssueKind =
  | 'packetLossSend' | 'packetLossReceive' | 'jitter' | 'roundTrip' | 'poorConnection'
  | 'drop' | 'reconnect' | 'signalingDropped' | 'deviceFailure' | 'audioSendFailed' | 'audioReceiveDropped' | 'joinFailure';

/** The kinds, in the order the console lists a person's issues of one moment. */
export const EXPERIENCE_ISSUE_KINDS: readonly ExperienceIssueKind[] = [
  'drop', 'joinFailure', 'signalingDropped', 'reconnect', 'deviceFailure', 'audioSendFailed', 'audioReceiveDropped',
  'poorConnection', 'packetLossSend', 'packetLossReceive', 'jitter', 'roundTrip',
];

/** One poor stretch or moment of one person's meeting. */
export interface ExperienceIssue {
  personKey: string;
  /** The attendee record it happened on; null where the record names none. */
  attendeeId: string | null;
  kind: ExperienceIssueKind;
  from: string;
  /** Where it ended; equal to `from` for a moment, null for a drop the person never came back from. */
  to: string | null;
  /** How long it lasted, in seconds; null for a drop the person never came back from. */
  seconds: number | null;
  /** The worst reading of a stretch of a measure, in its unit (percent or milliseconds); null otherwise. */
  peak: number | null;
  /** The recorded event behind a moment, by its name. */
  eventType: string | null;
}

/** A reading covers its interval: from its time to the next interval. */
const READING_MS = 15_000;
/** Two readings further apart than this are not one stretch: the app sent nothing between. */
const GAP_MS = 2 * READING_MS;

const ms = (iso: string): number => Date.parse(iso);
const iso = (t: number): string => new Date(t).toISOString();

type Measure = { kind: ExperienceIssueKind; read: (s: ConnectivitySample) => number | null; over: (t: ExperienceThresholds) => number };
const MEASURES: Measure[] = [
  { kind: 'packetLossSend', read: (s) => s.audioLossSendPct, over: (t) => t.packetLossPct },
  { kind: 'packetLossReceive', read: (s) => s.audioLossReceivePct, over: (t) => t.packetLossPct },
  { kind: 'jitter', read: (s) => s.audioJitterMs, over: (t) => t.jitterMs },
  { kind: 'roundTrip', read: (s) => s.rttMs, over: (t) => t.roundTripMs },
];

/** Each stretch of consecutive readings past one measure's threshold, kept where it lasted long enough. */
function measureStretches(c: AttendeeConnectivity, m: Measure, t: ExperienceThresholds): ExperienceIssue[] {
  const out: ExperienceIssue[] = [];
  const limit = m.over(t);
  let run: { from: number; last: number; peak: number } | null = null;
  const closeRun = () => {
    if (!run) return;
    const to = run.last + READING_MS;
    const seconds = Math.round((to - run.from) / 1000);
    if (seconds >= t.sustainedSeconds) {
      out.push({ personKey: c.personKey, attendeeId: c.attendeeId, kind: m.kind, from: iso(run.from), to: iso(to), seconds, peak: run.peak, eventType: null });
    }
    run = null;
  };
  for (const s of c.samples) {
    const at = ms(s.at);
    const v = m.read(s);
    if (!Number.isFinite(at)) continue;
    if (run && at - run.last > GAP_MS) closeRun();
    if (v !== null && v > limit) {
      if (run) { run.last = at; run.peak = Math.max(run.peak, v); } else run = { from: at, last: at, peak: v };
    } else closeRun();
  }
  closeRun();
  return out;
}

/** The connection monitor's own poor stretches, from each change to poor to the next change to good. */
function poorStretches(c: AttendeeConnectivity, closeAfter: (from: number) => number, t: ExperienceThresholds): ExperienceIssue[] {
  const out: ExperienceIssue[] = [];
  let from: number | null = null;
  const push = (to: number) => {
    if (from === null) return;
    const seconds = Math.round((Math.max(from, to) - from) / 1000);
    if (seconds >= t.sustainedSeconds) {
      out.push({ personKey: c.personKey, attendeeId: c.attendeeId, kind: 'poorConnection', from: iso(from), to: iso(Math.max(from, to)), seconds, peak: null, eventType: null });
    }
    from = null;
  };
  for (const h of c.healthChanges) {
    const at = ms(h.at);
    if (h.health === 'poor') { if (from === null) from = at; } else push(at);
  }
  if (from !== null) push(closeAfter(from));
  return out;
}

/** The moments a recorded event names, each the issue it is. */
const MOMENTS: Record<string, ExperienceIssueKind> = {
  AttendeeDropped: 'drop',
  meetingReconnected: 'reconnect',
  signalingDropped: 'signalingDropped',
  audioInputFailed: 'deviceFailure',
  videoInputFailed: 'deviceFailure',
  devicePermissionDenied: 'deviceFailure',
  sendingAudioFailed: 'audioSendFailed',
  receivingAudioDropped: 'audioReceiveDropped',
  meetingStartFailed: 'joinFailure',
  // A session that had started and then failed, as the overview counts it (`incidentKindOf`): a lost connection, not a join.
  meetingFailed: 'signalingDropped',
};

/**
 * EVERY POOR STRETCH AND MOMENT OF EVERY PERSON in one meeting, from its events (redeliveries already folded) and its
 * connectivity (`meetingDetail`). `closeAt` is where an open poor stretch closes: the meeting's end, or now while it runs.
 * In time order, then by person.
 */
export function experienceIssues(
  rows: MeetingEventRow[], connectivity: AttendeeConnectivity[], closeAt: number, t: ExperienceThresholds = experienceThresholds(),
): ExperienceIssue[] {
  const issues: ExperienceIssue[] = [];
  const sorted = [...rows].sort((a, b) => ms(a.event_at) - ms(b.event_at));
  // AN OPEN STRETCH CLOSES WHEN ITS PERSON LEFT OR DROPPED, as the roster closes it, else at the meeting's end (or now).
  const leftAfter = (personKey: string, from: number): number => {
    const out = sorted.find((n) => n.source === 'server' && n.person_key === personKey && !n.is_content
      && (n.event_type === 'AttendeeLeft' || n.event_type === 'AttendeeDropped') && ms(n.event_at) >= from);
    return out ? Math.min(ms(out.event_at), closeAt) : closeAt;
  };
  for (const c of connectivity) {
    for (const m of MEASURES) issues.push(...measureStretches(c, m, t));
    issues.push(...poorStretches(c, (from) => leftAfter(c.personKey, from), t));
  }
  sorted.forEach((r, i) => {
    const kind = MOMENTS[r.event_type];
    const key = r.person_key;
    if (!kind || !key || r.is_content || r.attendee_id?.startsWith(RING_KEY_PREFIX) || r.event_type === CONNECTIVITY_SAMPLE_EVENT) return;
    // A server event of the service's, a client event of the person's own app: each is one issue at its moment.
    if (kind === 'drop' && r.source !== 'server') return;
    if (kind !== 'drop' && r.source !== 'client') return;
    const at = ms(r.event_at);
    let to: number | null = at;
    if (kind === 'drop') {
      // Out of the meeting until they joined again, if they did.
      const back = sorted.slice(i + 1).find((n) => n.source === 'server' && n.person_key === key && n.event_type === 'AttendeeJoined' && !n.is_content);
      to = back ? ms(back.event_at) : null;
    } else if (kind === 'audioSendFailed') {
      const back = sorted.slice(i + 1).find((n) => n.person_key === key && n.attendee_id === r.attendee_id && n.event_type === 'sendingAudioRecovered');
      to = back ? ms(back.event_at) : leftAfter(key, at);
    }
    issues.push({
      personKey: key, attendeeId: r.attendee_id ?? null, kind, from: r.event_at, to: to === null ? null : iso(to),
      seconds: to === null ? null : Math.round((to - at) / 1000), peak: null, eventType: r.event_type,
    });
  });
  return issues.sort((a, b) => ms(a.from) - ms(b.from) || a.personKey.localeCompare(b.personKey)
    || EXPERIENCE_ISSUE_KINDS.indexOf(a.kind) - EXPERIENCE_ISSUE_KINDS.indexOf(b.kind));
}
