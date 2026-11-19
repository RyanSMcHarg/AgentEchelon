/**
 * A CONVERSATION'S MEETING STARTED OR ENDED: the event the meetings capability raises for the conversation's router
 * (`meeting-started`, `meeting-ended`), so the router posts the platform's card and runs the workflows declared on it.
 *
 * The meeting-events consumer publishes it on the account's default bus once the service's own `MeetingStarted` or
 * `MeetingEnded` is filed in the archive. Each classification's stack holds one rule matching this instance's events
 * for its own classification, and hands its router the conversation, the meeting and the event, nothing else. The
 * router checks all of it against the conversation's own record before anything runs (`handleMeetingLifecycle`), so the
 * event says where to look and decides nothing.
 */
export const MEETING_LIFECYCLE_SOURCE = 'agentechelon.meetings';
export const MEETING_LIFECYCLE_DETAIL_TYPE = 'Meeting lifecycle';

/**
 * A meeting started or ended; or its live transcription started or stopped (SPEC-ASSISTANT-MEETINGS FR28), the service's
 * `TranscriptionStarted` and `TranscriptionStopped`, so the people in the meeting are told in its chat. Workflows run on
 * the first two only. Recording turned on or off while captions stay on (`recording-started`, `recording-stopped`) is
 * published by the meetings function itself (`meeting-transcription.ts`), as the service raises no event for it. A part
 * of the meeting's audio and video recording that is ready or failed (`recording-ready`, `recording-failed`) is published
 * by the recording's event function (`meeting-recording-events.ts`), so the router rewrites the ended card. A person who
 * left or dropped (`person-left`, the service's `AttendeeLeft` or `AttendeeDropped` of a person's own attendee) has the
 * meeting checked five minutes on (`meeting-watch.ts`), the moment one left alone may be due to end. A person whose attendee
 * the meetings function created (`person-attended`, published by `meeting-api.ts` on a join or a start, naming the person)
 * is sent a ring-off addressed to them alone, so their other tabs and devices stop ringing for a meeting they took.
 */
export type MeetingLifecycleEvent = 'meeting-started' | 'meeting-ended' | 'transcription-started' | 'transcription-stopped' | 'recording-started' | 'recording-stopped'
  | 'recording-ready' | 'recording-failed' | 'person-left' | 'person-attended';

export interface MeetingLifecycleDetail {
  /** This deployment's instance, so two deployments in one account never hand each other their meetings. */
  instance: string;
  classification: string;
  channelArn: string;
  meetingId: string;
  event: MeetingLifecycleEvent;
  /** When the service says it happened. */
  at: string;
  /** `person-attended` only: the person (their AppInstanceUser id) whose attendee was created. */
  personId?: string;
}

/** A person id a handoff may name: an AppInstanceUser id, by the service's own pattern, never a path. */
export const PERSON_ID = /^[A-Za-z0-9:_.@-]{1,64}$/;

/**
 * The lifecycle event a service meeting event raises, or null for every other. A leave raises `person-left` only for a
 * person's own attendee (`person`), never a shared screen's or a service's.
 */
export function lifecycleEventOf(eventType: string, person = false): MeetingLifecycleEvent | null {
  if (person && (eventType === 'AttendeeLeft' || eventType === 'AttendeeDropped')) return 'person-left';
  if (eventType === 'MeetingStarted') return 'meeting-started';
  if (eventType === 'MeetingEnded') return 'meeting-ended';
  if (eventType === 'TranscriptionStarted') return 'transcription-started';
  if (eventType === 'TranscriptionStopped') return 'transcription-stopped';
  return null;
}

/**
 * AN AMAZON CHIME SDK MEETING ID, as every reader of one holds it: the lifecycle handoff, a run's natural key, the summary
 * firing and entry, the console's figures and the archive's query. The chat app reads a meeting card's id by the same
 * pattern (`frontend/packages/chat/src/services/meetingService.ts`), and a test holds the two to one another.
 */
export const MEETING_ID = /^[A-Za-z0-9-]{1,64}$/;
/** Whether a value is a meeting id. */
export const isMeetingId = (v: unknown): v is string => typeof v === 'string' && MEETING_ID.test(v);

/** What the router is handed, read strictly: a malformed one is refused before anything is read. */
export function readLifecycleHandoff(raw: unknown): { channelArn: string; meetingId: string; event: MeetingLifecycleEvent; at: string; personId?: string } | null {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (typeof r.channelArn !== 'string' || !/^arn:aws[a-z-]*:chime:[a-z0-9-]+:\d{12}:app-instance\/[^/]+\/channel\/[A-Za-z0-9-]+$/.test(r.channelArn)) return null;
  if (!isMeetingId(r.meetingId)) return null;
  const events: readonly unknown[] = ['meeting-started', 'meeting-ended', 'transcription-started', 'transcription-stopped', 'recording-started', 'recording-stopped', 'recording-ready', 'recording-failed', 'person-left', 'person-attended'];
  if (!events.includes(r.event)) return null;
  const at = typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : new Date().toISOString();
  // A PERSON WHO ATTENDED is named, and only by an id: a handoff naming none, or anything else, is refused.
  if (r.event === 'person-attended') {
    if (typeof r.personId !== 'string' || !PERSON_ID.test(r.personId)) return null;
    return { channelArn: r.channelArn, meetingId: r.meetingId, event: 'person-attended', at, personId: r.personId };
  }
  return { channelArn: r.channelArn, meetingId: r.meetingId, event: r.event as MeetingLifecycleEvent, at };
}

/**
 * WHEN A MEETING ENDED, as the router words its length: the time the handoff reports, held between the meeting's own
 * recorded start and now, so a handoff never makes a meeting run before it started or past the moment it is read.
 */
export function endedAt(reported: string, startIso: string, nowMs: number = Date.now()): string {
  const start = Date.parse(startIso);
  const at = Date.parse(reported);
  const held = Math.min(Number.isFinite(at) ? at : nowMs, nowMs);
  return new Date(Number.isFinite(start) ? Math.max(held, start) : held).toISOString();
}

/** How long a meeting ran, in whole minutes and at least one; the card's template words it. Null when either time is unreadable. */
export function durationMinutes(startIso: string, endIso: string): number | null {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 60_000)) : null;
}
