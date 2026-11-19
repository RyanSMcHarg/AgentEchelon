/**
 * How a meeting session that stopped is recovered: which stops are rejoined, how far apart the rejoins are, and when a
 * rejoin waits for the person or the network to come back.
 *
 * `MeetingProvider.tsx` runs the connection; this file holds the rules.
 *
 * A REJOIN REUSES THE CACHED CREDENTIALS, so recovering creates no attendee (see `MeetingProvider.tsx`). Everything here
 * is about WHEN that local rejoin runs, never about calling the join API again.
 */
import { MeetingSessionStatusCode, type MeetingSessionStatus } from 'amazon-chime-sdk-js';

/** Rejoin attempts in one round before giving up. Bounded, so a meeting that is gone does not retry forever. */
export const MAX_REJOIN_ATTEMPTS = 3;

/** The pause between tearing a dead session down and connecting its replacement, 500 ms. */
export const REJOIN_SETTLE_MS = 500;

/** The added pause per failed attempt (`attempt * 2000` ms). */
export const REJOIN_BACKOFF_MS = 2000;

/**
 * THE WAIT BEFORE REJOIN ATTEMPT `attempt` (1-based): the settle pause, plus the backoff for each attempt that failed
 * before it. The settle pause lets the dead session's leave reach the service before the same attendee joins again, so
 * the meeting's events read leave-then-join for that attendee and the person stays present in them.
 */
export function rejoinDelayMs(attempt: number): number {
  return REJOIN_SETTLE_MS + Math.max(0, attempt - 1) * REJOIN_BACKOFF_MS;
}

/**
 * THE STOPS THAT ARE THE PERSON'S OUTCOME, not their connection's: they left, the meeting ended, the service turned the
 * attendee away (full, removed, joined elsewhere, credentials refused). Rejoining any of them with the same credentials
 * cannot succeed or would undo what the service decided, so each is left and said.
 */
const FINAL_STOPS: ReadonlySet<MeetingSessionStatusCode> = new Set([
  MeetingSessionStatusCode.Left,
  MeetingSessionStatusCode.MeetingEnded,
  MeetingSessionStatusCode.AudioCallAtCapacity,
  MeetingSessionStatusCode.VideoCallAtSourceCapacity,
  MeetingSessionStatusCode.AudioJoinedFromAnotherDevice,
  MeetingSessionStatusCode.AudioAttendeeRemoved,
  MeetingSessionStatusCode.AudioAuthenticationRejected,
]);

/** What a stopped session asks for: a rejoin, leaving the meeting, or nothing. */
export type StopOutcome = 'rejoin' | 'leave' | 'stay';

/**
 * WHAT A STOP MEANS. A final stop is left. Every other failure is rejoined, including the SDK's terminal transport
 * stops (`AudioDisconnected`, `SignalingRequestFailed`, `SignalingBadRequest`, `RealtimeApiFailed`,
 * `TURNCredentialsForbidden`): the SDK will not reconnect those itself, and a backgrounded or briefly offline tab is
 * where they happen, so the bounded rejoin brings the person back. A meeting that has really ended answers the rejoin
 * with `MeetingEnded`, which is final.
 */
export function stopOutcome(status: MeetingSessionStatus): StopOutcome {
  if (FINAL_STOPS.has(status.statusCode())) return 'leave';
  if (status.isTerminal() || status.isFailure()) return 'rejoin';
  return 'stay';
}

/** The tab is in the background now. */
export function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** The browser says it has no network now. Only an explicit `false` counts: an unknown state is treated as online. */
export function networkOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * RESUME WHAT THE BROWSER PAUSED while the tab was away: a media element it paused (a mobile browser pauses audio when
 * another app takes the audio focus) plays again. An element with nothing bound, or one already playing, is left alone.
 */
export function resumePlayback(el: HTMLMediaElement | null | undefined): void {
  if (!el || !el.paused || !el.srcObject) return;
  try {
    void el.play()?.catch(() => undefined);
  } catch { /* the browser refused; the next gesture plays it */ }
}
