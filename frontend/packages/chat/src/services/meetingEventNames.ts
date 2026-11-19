/**
 * THE EVENTS THE MEETING API FILES FROM THIS APP, by the names it files them under. The backend holds the same lists
 * (`backend/lambda/src/lib/meeting-client-events.ts`), and a backend test holds the two to one another.
 */
export const CLIENT_MEETING_EVENTS = [
  'meetingStartRequested', 'meetingStartSucceeded', 'meetingStartFailed', 'meetingEnded', 'meetingFailed', 'meetingReconnected',
  'attendeePresenceReceived', 'audioInputFailed', 'videoInputFailed', 'signalingDropped', 'sendingAudioFailed',
  'sendingAudioRecovered', 'receivingAudioDropped',
  'connectivitySample', 'connectionBecamePoor', 'connectionBecameGood', 'videoStopSuggested',
  'audioMuted', 'audioUnmuted',
  'audioInputChanged', 'videoInputChanged', 'audioOutputChanged', 'devicesChanged', 'devicePermissionDenied',
] as const;

/** How often the app files a connectivity reading: the server files one per attendee per interval. */
export const CONNECTIVITY_SAMPLE_INTERVAL_MS = 15_000;

/** What happened to a ring this app showed: answered with Join, dismissed, or left to run out. */
export const RING_OUTCOME_EVENTS = ['ringAnswered', 'ringDismissed', 'ringTimedOut'] as const;
export type RingOutcome = typeof RING_OUTCOME_EVENTS[number];

/** The most events one report carries. */
export const MAX_EVENTS_PER_REPORT = 20;

/** One event as reported: its name, the app's time, and the attributes the server keeps. */
export interface ReportedEvent {
  name: string;
  at: number;
  attributes?: Record<string, string | number>;
}
