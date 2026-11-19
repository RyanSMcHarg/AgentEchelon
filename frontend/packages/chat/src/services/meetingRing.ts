/**
 * A MEETING'S RING, as the chat app reads it: an Amazon Chime SDK control message, non-persistent, whose
 * content is `ae:ring:<seconds>`, for 5 to 60 seconds. It reaches the members connected when it is sent, is never
 * stored, and rings from its own send time for that many seconds, then stops on its own; `ae:ring:off` stops it sooner,
 * when the meeting ends while it rings. A ring outside the bounds is no ring at all, and only an assistant's ring counts
 * (`MessagingProvider`): the platform sends every one as the room's assistant.
 *
 * The backend writes the same shape (`backend/lambda/src/lib/meeting-ring.ts`), and a backend test holds the two to one
 * another.
 */

export const RING_PREFIX = 'ae:ring:';
/** The shortest and longest ring, in whole seconds. */
export const MIN_RING_SECONDS = 5;
export const MAX_RING_SECONDS = 60;
/** The content that stops a ring: the conversation's meeting ended while it rang. */
export const RING_OFF = 'ae:ring:off';
/** A ring's length when the deployment names none. */
export const DEFAULT_RING_SECONDS = 10;

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

/** Is this content the signal that stops a ring? */
export function isRingOff(content: unknown): boolean {
  return content === RING_OFF;
}

/** The deployment's ring length (`VITE_MEETING_RING_SECONDS`, else ten seconds), for a late arrival whose status read names none. */
export function configuredRingSeconds(raw: unknown = import.meta.env.VITE_MEETING_RING_SECONDS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_RING_SECONDS && n <= MAX_RING_SECONDS ? n : DEFAULT_RING_SECONDS;
}

/**
 * When a ring stops: its send time plus its length. A ring that arrives late (a slow connection, a reconnect) rings only
 * for what is left of it, and one already over does not ring at all. A send time that cannot be read counts from now.
 */
export function ringEndsAt(seconds: number, sentAt: string | number | undefined, now = Date.now()): number {
  const sent = typeof sentAt === 'number' ? sentAt : sentAt ? Date.parse(sentAt) : NaN;
  const from = Number.isFinite(sent) && sent <= now ? sent : now;
  return from + seconds * 1000;
}

/**
 * WHEN A RING THAT JUST ARRIVED STOPS, by this app's clock. Its send time is on the server's clock, which this one may run
 * ahead of or behind, so the time it spent on the way is read against the shortest delivery this connection has seen
 * (`fastestDelivery`, arrival minus send time, which carries the clocks' difference): the difference is cancelled and
 * only the extra delay counts. A ring therefore rings for its whole length when it arrives as fast as messages do,
 * whatever this clock says, and for what is left of it when it arrives late. The delivery is measured on the steady
 * clock (`steady`, from `steadyNow`), the one `fastestDelivery` was measured on, and the end is said on the wall clock
 * (`now`), which the app's timers compare against.
 */
export function arrivingRingEndsAt(
  seconds: number, sentAt: string | undefined, fastestDelivery: number, now = Date.now(), steady = now,
): number {
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  if (!Number.isFinite(sent) || !Number.isFinite(fastestDelivery)) return now + seconds * 1000;
  const late = Math.max(0, (steady - sent) - fastestDelivery);
  return now + seconds * 1000 - late;
}

/** The wall clock as it read when this page loaded, the base the steady clock counts from. */
const STEADY_BASE = Date.now() - performance.now();

/**
 * A STEADY CLOCK in epoch milliseconds: the wall clock at load plus the page's monotonic time. A step of the device clock
 * (a manual change, a sync after sleep) leaves it where it was, so a delivery measured on it keeps measuring the network
 * and the clocks' difference, and a ring is never read as late because this device's clock moved.
 */
export function steadyNow(): number {
  return STEADY_BASE + performance.now();
}

/**
 * What a ring arriving for a conversation does to the one showing. A ring for the conversation already ringing is the
 * same meeting, so it neither restarts the tone nor extends the time; a ring for another conversation replaces it.
 */
export function nextRing<R extends { channelArn: string; endsAt: number }>(current: R | null, arriving: R, now = Date.now()): R {
  return current && current.channelArn === arriving.channelArn && current.endsAt > now ? current : arriving;
}
