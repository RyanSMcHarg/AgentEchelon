/**
 * A MEETING'S RING: what tells the members of a conversation who have the app open that its meeting has started.
 *
 * An Amazon Chime SDK CONTROL message, non-persistent: delivered over the session of each member connected when it is
 * sent, never stored, never in the conversation's history, and never handed to the channel flow, so it rings the people
 * there now and nobody later. Its content (at most 30 bytes, the service's limit for a control message) is this module's
 * one shape, `ae:ring:<seconds>`, for 5 to 60 seconds. A member's app rings from the message's own send time for that
 * many seconds and then stops on its own; `ae:ring:off` stops it sooner, when the meeting ends while it rings. An app
 * reads a ring outside the bounds as no ring at all, whoever sent it, so no member can make a room ring for longer.
 *
 * The chat app reads the same shape (`frontend/packages/chat/src/services/meetingRing.ts`), and a test holds the two
 * to one another.
 */

export const RING_PREFIX = 'ae:ring:';
/** The shortest and longest ring, in whole seconds. */
export const MIN_RING_SECONDS = 5;
export const MAX_RING_SECONDS = 60;
/** The content that stops a ring: the conversation's meeting ended while it rang. */
export const RING_OFF = 'ae:ring:off';
/** A ring's length when neither the step nor the deployment names one. */
export const DEFAULT_RING_SECONDS = 10;
/** The service's limit on a control message's content. */
export const CONTROL_CONTENT_MAX_BYTES = 30;

/** The ring's content, for a length in whole seconds. */
export function ringContent(seconds: number): string {
  return `${RING_PREFIX}${Math.round(seconds)}`;
}

/** The ring's length in seconds, or null for any content that is not a ring within bounds. */
export function parseRing(content: unknown): number | null {
  if (typeof content !== 'string' || !content.startsWith(RING_PREFIX)) return null;
  const seconds = Number(content.slice(RING_PREFIX.length));
  return Number.isInteger(seconds) && seconds >= MIN_RING_SECONDS && seconds <= MAX_RING_SECONDS ? seconds : null;
}

/**
 * How long a step rings: its own `ringSeconds`, else the deployment's `MEETING_RING_SECONDS`, else the default. A
 * deployment value outside the step's bounds is ignored for the default.
 */
export function ringSecondsFor(stepSeconds: number | undefined, bounds: { min: number; max: number }, env = process.env.MEETING_RING_SECONDS): number {
  if (stepSeconds !== undefined) return stepSeconds;
  const configured = Number(env);
  return Number.isInteger(configured) && configured >= bounds.min && configured <= bounds.max ? configured : DEFAULT_RING_SECONDS;
}

/**
 * THE RING LENGTH A START RECORDS ON ITS MEETING: the step's `ringSeconds` where it is a whole number within bounds, else
 * the deployment's, else the default. The meetings function computes it once, records it, and answers it to the run that
 * asked, so every later reading of the ring is of the recorded length.
 */
export function ringSecondsOf(stepSeconds: unknown, env = process.env.MEETING_RING_SECONDS): number {
  const asked = typeof stepSeconds === 'number' && Number.isInteger(stepSeconds) && stepSeconds >= MIN_RING_SECONDS && stepSeconds <= MAX_RING_SECONDS
    ? stepSeconds : undefined;
  return ringSecondsFor(asked, { min: MIN_RING_SECONDS, max: MAX_RING_SECONDS }, env);
}

/**
 * WHOLE SECONDS LEFT OF THE RING THAT ANNOUNCED A MEETING, on this server's clock: the ring sounds from the meeting's
 * creation for its recorded length (the deployment's, for a record that carries none). 0 once it is over.
 */
export function ringSecondsLeft(meeting: { createdAt: string; ringSeconds?: number }, now = Date.now()): number {
  const started = Date.parse(meeting.createdAt);
  if (!Number.isFinite(started)) return 0;
  const seconds = meeting.ringSeconds ?? ringSecondsOf(undefined);
  return Math.max(0, Math.ceil((started + seconds * 1000 - now) / 1000));
}

/**
 * WHAT IS LEFT OF A RUNNING MEETING'S RING, as its ring content (`ringSecondsLeft`, at most the longest ring). Null where
 * less than the shortest ring is left, so a late event rings nobody.
 */
export function ringLeft(meeting: { createdAt: string; ringSeconds?: number }, now = Date.now()): string | null {
  const left = Math.min(MAX_RING_SECONDS, ringSecondsLeft(meeting, now));
  return left >= MIN_RING_SECONDS ? ringContent(left) : null;
}

/**
 * WHEN A RUNNING MEETING'S RING STOPS, on this server's clock, for its started card (`ringUntil`): a person of the room the
 * ring did not reach (carried into the meeting's conversation after it was sent) hears it from their app, from the card, for
 * what is left of it. Undefined where the ring is over or the start cannot be read.
 */
export function ringUntilOf(meeting: { createdAt: string; ringSeconds?: number }, now = Date.now()): string | undefined {
  const left = ringSecondsLeft(meeting, now);
  return left > 0 ? new Date(Date.parse(meeting.createdAt) + (meeting.ringSeconds ?? ringSecondsOf(undefined)) * 1000).toISOString() : undefined;
}

/**
 * The ring a workflow's start sends, or null for none: the length the meetings function recorded and answered, only from
 * the start that created the meeting (a meeting already running rang when it started, so a workflow that runs again does
 * not ring the room again). A length outside the bounds is no ring.
 */
export function ringOnStart(created: boolean | undefined, recordedSeconds: number | undefined): string | null {
  if (!created || recordedSeconds === undefined) return null;
  const content = ringContent(recordedSeconds);
  return parseRing(content) === null ? null : content;
}
