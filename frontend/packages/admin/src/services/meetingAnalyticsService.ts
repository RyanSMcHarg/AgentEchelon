/**
 * THE CONSOLE'S MEETINGS (`view-meeting-analytics`, `GET /admin/meetings` and `/admin/meetings/{meetingId}`): every
 * meeting figure and each meeting's roster, derived on the server from the recorded events (backend
 * `admin-meetings.ts`). An admin catalog route, SigV4-signed with the console session.
 *
 * Meetings exist only where `AdminApi` serves the `meetings` capability, so the tab is shown only then.
 */
import { ApiError } from '@ae/shared';
import { adminRequest, consoleCredentials, sigv4GetJson } from './sigv4Fetch';
import { reasonFor } from './adminReason';
import { adminApiServes, adminUrl } from './adminApi';

/** A figure and the population it is over; `value` is null when that population cannot support it. */
export interface Figure {
  value: number | null;
  over: number;
}

export interface RosterRow {
  personKey: string;
  state: 'present' | 'left';
  firstJoinedAt: string;
  lastLeftAt: string | null;
  connectedSeconds: number;
  drops: number;
  reconnects: number;
  transports: Array<{ transport: string; at: string }>;
  phone: boolean;
  cameraSeconds: number;
  sharedSeconds: number;
  joinLatencyMs: number | null;
  /** Milliseconds from their join until their app first heard who else was in the meeting. */
  presenceReceivedMs?: number | null;
  /** The browser and the system each with its version, the device's name where the app read one, and the SDK. */
  device: { browser: string | null; os: string | null; name?: string | null; sdk: string | null };
  /** `error` after a failure their app reported, `warning` after a drop, a reconnect or a poor connection, else `good`. */
  quality: 'good' | 'warning' | 'error';
  failures: string[];
  /** Each failure their app reported: what failed, when, and the short error it gave, where it gave one. */
  failureEvents?: Array<{ eventType: string; at: string; errorMessage: string | null }>;
  /** Seconds their connection was poor, as their app reported it. */
  poorConnectionSeconds?: number;
  /** When they were connected, on camera and sharing: the intervals the seconds above are summed from. */
  spans?: { connected: Span[]; camera: Span[]; sharing: Span[] };
}

/** One stretch of time, as ISO instants. */
export interface Span { from: string; to: string }

/** What an incident is: a connection the service saw fail, or a join, media or connection failure the app reported. */
export type IncidentKind = 'drop' | 'joinFailure' | 'mediaFailure' | 'connectionFailure';
export const INCIDENT_KINDS: readonly IncidentKind[] = ['drop', 'joinFailure', 'mediaFailure', 'connectionFailure'];

export interface MeetingIncident {
  kind: IncidentKind;
  meetingId: string;
  personKey: string;
  eventType: string;
  at: string;
  errorMessage: string | null;
}

/** A recorded meeting event, as the detail route returns it in time order (backend `meeting-event-shape.ts`). */
export interface MeetingEvent {
  meeting_id: string;
  channel_arn: string;
  classification: string;
  event_type: string;
  source: 'server' | 'client' | 'platform';
  attendee_id: string | null;
  person_key: string | null;
  is_content: boolean;
  network_transport: string | null;
  event_at: string;
  detail: Record<string, unknown> | null;
}

/**
 * ONE CONNECTIVITY READING of one attendee (backend `meeting-figures.ts`): the means of the SDK's one-second metrics over
 * one sampling interval, at the interval's start. A metric the app had no reading for is null, never zero.
 */
export interface ConnectivitySample {
  at: string;
  health: 'good' | 'poor' | null;
  audioLossSendPct: number | null;
  audioLossReceivePct: number | null;
  audioJitterMs: number | null;
  rttMs: number | null;
  availableSendKbps: number | null;
  availableReceiveKbps: number | null;
  videoSendKbps: number | null;
  videoReceiveKbps: number | null;
}

/** One attendee record's connection over the meeting. */
export interface AttendeeConnectivity {
  personKey: string;
  attendeeId: string;
  samples: ConnectivitySample[];
  healthChanges: Array<{ at: string; health: 'good' | 'poor' }>;
  poorSeconds: number;
  videoStopSuggestions: number;
}

export interface MeetingSummary {
  meetingId: string;
  channelArn: string;
  classification: string;
  status: 'active' | 'ended' | 'abandoned';
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  startedVia: 'person' | 'workflow' | null;
  /** Who started it, as the platform recorded its creation: a person's id, or the workflow's identity. */
  createdBy?: string | null;
  /** Its hosts as decided at the start, by person id. */
  hosts?: string[];
  /** The AWS Region its media was hosted in. */
  mediaRegion?: string | null;
  /** Whether its live transcription ran at any point. */
  transcribed?: boolean;
  people: number;
  /** People in it now, on the service's record. */
  present?: number;
  phonePeople: number;
  dropEvents: number;
  peopleWhoDropped: number;
  reconnects: number;
  clientFailures: number;
  joinLatencyMs: { p50: Figure; p95: Figure };
  ring: { answered: number; dismissed: number; timedOut: number };
  roster?: RosterRow[];
  incidents?: MeetingIncident[];
  /**
   * Whether it runs now: its conversation still holds it AND Amazon Chime SDK still runs it, read when the answer was
   * made. Null when that could not be read.
   */
  live?: boolean | null;
  /** How an ended meeting ended, as its events show it. */
  endedHow?: 'everyoneLeft' | 'withPeopleIn' | 'nobodyJoined' | null;
}

/** One day (UTC) of the window: the meetings that started on it, and their people, drops and app failures. */
export interface DayFigures { day: string; meetings: number; people?: number; dropEvents?: number; clientFailures?: number }

export interface MeetingFigures {
  meetings: number;
  byStatus: Record<'active' | 'ended' | 'abandoned', number>;
  durationSeconds: Figure;
  peoplePerMeeting: Figure;
  dropRate: Figure;
  dropEvents: number;
  dropsPerPersonWhoDropped: Figure;
  phoneShare: Figure;
  joinLatencyMs: { p50: Figure; p95: Figure; mean: Figure };
  /** Meetings in which no app reported a failure, over meetings. */
  healthyMeetings?: Figure;
  joinSuccessRate: Figure;
  failuresByType: Record<string, number>;
  reconnects: number;
  ring: { sent: number; answered: number; dismissed: number; timedOut: number; answerRate: Figure; timeToAnswerMs: { p50: Figure; p95: Figure } };
  byDay: DayFigures[];
  browsers: Record<string, number>;
  operatingSystems: Record<string, number>;
  sdkVersions: Record<string, number>;
  startedVia: { person: number; workflow: number; unknown: number };
  /** People by roster quality, once per person per meeting. */
  quality?: Record<RosterRow['quality'], number>;
  /** Each kind of incident: how many, and the newest of them. */
  incidents?: Record<IncidentKind, { count: number; recent: MeetingIncident[] }>;
}

/** What every answer says about what it covers and what it is missing. */
interface Coverage {
  days: number;
  from: string;
  to: string;
  store: 'aurora' | 'athena';
  truncated: boolean;
  unreadClassifications: string[];
}

export type MeetingsAnswer = Coverage & { figures: MeetingFigures; meetings: MeetingSummary[] };
/**
 * One meeting: its summary with the roster, its events in time order, and, where the deployment records them, each
 * attendee's connectivity readings. With no `connectivity`, the console reads them from the `connectivitySample` events.
 */
/** The thresholds a meeting's poor stretches were judged against: the deployment's, else the declared defaults. */
export interface ExperienceThresholds { packetLossPct: number; jitterMs: number; roundTripMs: number; sustainedSeconds: number }

export type ExperienceIssueKind =
  | 'packetLossSend' | 'packetLossReceive' | 'jitter' | 'roundTrip' | 'poorConnection'
  | 'drop' | 'reconnect' | 'signalingDropped' | 'deviceFailure' | 'audioSendFailed' | 'audioReceiveDropped' | 'joinFailure';

/** One poor stretch or moment of one person's meeting (backend `meeting-experience.ts`). */
export interface ExperienceIssue {
  personKey: string;
  attendeeId: string | null;
  kind: ExperienceIssueKind;
  from: string;
  /** Equal to `from` for a moment; null for a drop the person never came back from. */
  to: string | null;
  seconds: number | null;
  /** The worst reading of a stretch, in its measure's unit. */
  peak: number | null;
  eventType: string | null;
}

export type MeetingAnswer = Coverage & {
  meeting: MeetingSummary; events?: MeetingEvent[]; connectivity?: AttendeeConnectivity[];
  /** Each person's poor stretches and moments, with the thresholds they were judged against (FR74). */
  experience?: { thresholds: ExperienceThresholds; issues: ExperienceIssue[] };
  /** The meeting conversation's type and the room it was started from, read from its record; null where unread. */
  conversation?: MeetingConversation | null;
};

/** The conversation a meeting was held in: its type, and the room it was started from with that room's type. */
export interface MeetingConversation {
  type: string | null;
  room: { channelArn: string; type: string | null } | null;
  /** Whether its summary was written; what it says is read with the transcript. */
  summarized?: boolean;
  /** Whether its transcript was kept (recording mode at some point); false for captions alone; null where the record does not say. */
  transcriptKept?: boolean | null;
}

/**
 * A MEETING'S SUMMARY, as the router wrote it: what was said, its key points, next steps and topics, and each action item.
 * An item with a `taskId` is a task on the room the meeting was started from, assigned to `assignee` or held by the host
 * `heldBy`, each by person id.
 */
export interface MeetingSummaryContent {
  summary: string;
  keyPoints: string[];
  nextSteps: string[];
  topics: string[];
  actionItems: Array<{ text: string; due?: string; taskId?: string; assignee?: string; heldBy?: string }>;
  writtenAt?: string;
}

/** What was said in a meeting: its transcript and its summary, either of which may be missing. */
export interface MeetingContent { transcript: string | null; summary: MeetingSummaryContent | null }

/** Whether this deployment serves meetings, so the console offers the tab. */
export function meetingAnalyticsAvailable(): boolean {
  return adminApiServes('meetings');
}

/** Every figure across the last `days` days, and each meeting's summary. */
export async function fetchMeetings(days: number): Promise<MeetingsAnswer> {
  return sigv4GetJson<MeetingsAnswer>(adminUrl('admin-conversations', '/admin/meetings'), { days }, await consoleCredentials());
}

/** One meeting, with its roster and its events. */
export async function fetchMeeting(meetingId: string, days: number): Promise<MeetingAnswer> {
  return sigv4GetJson<MeetingAnswer>(adminUrl('admin-conversations', `/admin/meetings/${encodeURIComponent(meetingId)}`), { days }, await consoleCredentials());
}

/**
 * A MEETING'S TRANSCRIPT AND SUMMARY (`view-events`, `GET /admin/meetings/{meetingId}/transcript`): conversation content,
 * read with the operator's stated reason, which the access log records before the read. The reason is the one the
 * meeting's conversation was opened for, when it was. Null when neither was written for the meeting.
 */
export async function fetchMeetingContent(meetingId: string, channelArn: string, days: number): Promise<MeetingContent | null> {
  const accessReason = await reasonFor({ capability: 'view-events', channelArn, kind: 'read' });
  try {
    const answer = await sigv4GetJson<{ transcript?: string | null; summary?: MeetingSummaryContent | null }>(
      adminUrl('admin-conversations', `/admin/meetings/${encodeURIComponent(meetingId)}/transcript`), { days, accessReason }, await consoleCredentials(),
    );
    return { transcript: answer.transcript ?? null, summary: answer.summary ?? null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * END A RUNNING MEETING FOR EVERYONE (`end-meetings`, `POST /admin/meetings/{meetingId}/end`), with the operator's stated
 * reason, which the access log records before the meeting is ended. The meeting is named with the conversation that holds
 * it; the server ends it only while that conversation holds it and the service runs it.
 */
export async function endMeetingForEveryone(meetingId: string, channelArn: string): Promise<{ ended: boolean }> {
  const reason = await reasonFor({ capability: 'end-meetings', channelArn, kind: 'change' });
  return adminRequest<{ ended: boolean }>('POST', adminUrl('admin-conversations', `/admin/meetings/${encodeURIComponent(meetingId)}/end`), { body: { channelArn, reason } });
}
