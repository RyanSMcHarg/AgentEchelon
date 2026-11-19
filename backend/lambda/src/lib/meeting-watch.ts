/**
 * A MEETING ENDS IN BOUNDED TIME (SPEC-ASSISTANT-MEETINGS FR50). Nobody has to remember to end a meeting: a running meeting
 * is watched by one-shot schedules (`event-deadlines.ts`, ADR-061 decision 1: a deadline is a one-shot schedule, never a
 * poll), and a check that finds it unattended ends it for everyone through the meetings function's one end
 * (`endMeeting`).
 *
 * WHEN A CHECK RUNS (tenet D6): each is due at a moment something could have changed. Five minutes after the start, when a
 * meeting nobody else joined is due to end; five minutes after a person leaves (the router schedules it on `person-left`),
 * when one left alone may be due; and at the deployment's limit. An attended meeting is not checked in between: a leave is
 * an event, and the absence of a join or of a second person is seen at those moments.
 *
 * THE RULES, each ending the meeting with its reason, which the meeting's ended card says:
 *  - `nobody-joined`: at most one person has been in it, and at most one is in it, five minutes after it started;
 *  - `left-alone`: one person or nobody has been in it at two checks in a row, at least five minutes apart;
 *  - `time-limit`: it has run for the deployment's limit (`meetingMaxMinutes`, 90 minutes unless set).
 * A meeting with two or more people in it is left running until its limit, or the next leave.
 *
 * A JOIN THE EVENTS STORE HAS NOT FILED YET STILL COUNTS. The people are read from the meeting's events, which the archive
 * files in batches (`EVENTS_SETTLE_MS`), so the running meeting's record carries when a person last joined
 * (`activeMeeting.lastJoinAt`, written as the join arrives). A check that would end a meeting someone joined within that
 * time checks again once the join is filed, so a meeting is never ended with a person in it the store has not shown yet.
 *
 * PURE: the router reads the meeting's record and its people (the summary entry's `present` and `people`), decides here,
 * then ends it or schedules the next check.
 */

/** How long after a start or a leave a meeting is checked, and how long it may be unattended before it ends. */
export const MEETING_WATCH_MINUTES = 5;

/**
 * How long after it arrives an event is in the store the people are read from: past the archive stream's 60 second buffer,
 * the same wait a meeting's summary takes after its end (`MEETING_SUMMARY_DELAY_SECONDS`).
 */
export const EVENTS_SETTLE_MS = 120_000;

/** The longest a meeting runs where the deployment sets no limit. */
export const DEFAULT_MEETING_MAX_MINUTES = 90;

/** Why a watched meeting was ended. */
export type MeetingTimeoutReason = 'nobody-joined' | 'left-alone' | 'time-limit';

/** The message template the ended card says each reason in. */
export const MEETING_TIMEOUT_TEMPLATES: Readonly<Record<MeetingTimeoutReason, string>> = {
  'nobody-joined': 'meeting-ended-nobody-joined',
  'left-alone': 'meeting-ended-left-alone',
  'time-limit': 'meeting-ended-time-limit',
};

/** The deployment's meeting limit in minutes (`MEETING_MAX_MINUTES`, from `meetingMaxMinutes`), within 10 to 1440. */
export function meetingMaxMinutes(raw: string | undefined = process.env.MEETING_MAX_MINUTES): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 10 && n <= 1440 ? n : DEFAULT_MEETING_MAX_MINUTES;
}

export interface MeetingWatchInput {
  now: number;
  /** When the meeting was created, epoch ms. */
  startedAt: number;
  maxMinutes: number;
  /** People connected now, as the events store holds them. */
  present: number;
  /** People who have been in it at all, as the events store holds them. */
  people: number;
  /** When an earlier check last found at most one person in it, epoch ms; absent when it found two or more. */
  aloneSince?: number;
  /** When a person last joined, from the running meeting's record, epoch ms (`activeMeeting.lastJoinAt`). */
  lastJoinAt?: number;
}

export type MeetingWatchDecision =
  | { end: MeetingTimeoutReason }
  | { next: number; aloneSince?: number };

/** THE CHECK: end the meeting with its reason, or the moment of the next check and what this one saw. */
export function meetingWatchDecision(w: MeetingWatchInput): MeetingWatchDecision {
  const windowMs = MEETING_WATCH_MINUTES * 60_000;
  const capAt = w.startedAt + w.maxMinutes * 60_000;
  if (w.now >= capAt) return { end: 'time-limit' };
  // ATTENDED: nothing is due before the limit; a leave schedules its own check.
  if (w.present >= 2) return { next: capAt };
  // A JOIN NOT FILED YET: checked again once it is.
  if (w.lastJoinAt !== undefined && w.now - w.lastJoinAt < EVENTS_SETTLE_MS) return { next: Math.min(w.lastJoinAt + EVENTS_SETTLE_MS, capAt) };
  // AT MOST ONE PERSON IN IT: unattended since the start for a meeting nobody else joined, else since the check that first saw it.
  const since = w.aloneSince ?? (w.people <= 1 ? w.startedAt : undefined);
  if (since !== undefined && w.now - since >= windowMs) return { end: w.people <= 1 ? 'nobody-joined' : 'left-alone' };
  const alone = since ?? w.now;
  return { next: Math.min(alone + windowMs, capAt), aloneSince: alone };
}
