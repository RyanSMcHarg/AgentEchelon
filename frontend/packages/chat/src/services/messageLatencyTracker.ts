/**
 * Tracks message latency as the BROWSER experiences it, from the user clicking send.
 *
 * Two numbers come out of one send and they bracket different spans:
 *   `client_ttff_ms`         send -> the placeholder renders (the wait visibly ending)
 *   `message_round_trip_ms`  send -> the real answer renders (the wait actually ending)
 *
 * Both are the counterpart of a server-side metric that cannot see the WebSocket hop or the React
 * render, and cannot see the click at all. The DIFFERENCE between a client number and its server
 * twin is the delivery-and-render cost, which is the only way to answer "is the server slow or is
 * the client slow?" (G5, docs/guides/developer/LATENCY-TARGETS.md).
 *
 * Uses performance.now() for high-resolution timing. Stores pending measurements
 * keyed by channelArn, since we don't know the response messageId ahead of time.
 */

import { trackPerformance } from '@ae/shared';

export interface LatencyMeasurement {
  roundTripMs: number;
  sentAt: number;
  receivedAt: number;
  channelArn: string;
}

// Map of channelArn -> timestamp when the most recent message was sent
const pendingSends = new Map<string, number>();
// Channels whose CURRENT pending send has already reported a placeholder. A turn posts exactly one
// placeholder, but a duel posts one PER SIDE and a resumed chain posts a receipt beside the answer -
// so without this latch the first send reports two or three client TTFFs, and the later ones measure
// a rival starting rather than a person waiting.
const ttffReported = new Set<string>();

/**
 * Call when the user clicks send. Records the high-resolution timestamp.
 * @param channelArn - The channel ARN where the message is being sent
 */
export function markMessageSent(channelArn: string): void {
  try {
    pendingSends.set(channelArn, performance.now());
    // Re-arms the placeholder latch. This is the ONE release that matters: a new send is what makes
    // a new TTFF meaningful, and every other path either has no pending send to measure against or
    // is followed by one of these before the next placeholder can arrive.
    ttffReported.delete(channelArn);
  } catch {
    // Never break the app for tracking
  }
}

/**
 * Call when the assistant's PLACEHOLDER renders - the first visible sign the system is working.
 *
 * THE BROWSER'S OWN TTFF. The server measures time-to-placeholder between two Chime message
 * timestamps; this measures it from the person's click to the bubble appearing on their screen. The
 * gap between the two brackets is delivery and render.
 *
 * This is the metric the round-trip timer deliberately skipped, on the reasoning that
 * time-to-acknowledgment is "uniformly fast and useless". That was written before placeholder-then-
 * update delivery made time-to-acknowledgment the PRIMARY perceived-latency SLO: with no token
 * streaming, the placeholder IS the entire user-visible response for several seconds.
 *
 * DOES NOT CONSUME THE PENDING SEND, so the round trip is still measured to the real answer. A
 * placeholder interrupts the silence; it does not end the wait.
 */
export function markPlaceholderShown(channelArn: string): void {
  try {
    if (ttffReported.has(channelArn)) return;
    const sentAt = pendingSends.get(channelArn);
    // No pending send means this channel is not one the person is waiting in - the WebSocket handler
    // sees every channel, so without this an assistant replying in a background conversation would
    // report a wait nobody was having.
    if (sentAt === undefined) return;
    ttffReported.add(channelArn);
    trackPerformance('client_ttff_ms', Math.round(performance.now() - sentAt));
  } catch {
    // Never break the app for tracking
  }
}

/**
 * Call when a bot response arrives via WebSocket.
 * Returns the latency measurement, or null if no pending send was recorded.
 * @param channelArn - The channel ARN where the response was received
 */
export function markResponseReceived(channelArn: string): LatencyMeasurement | null {
  try {
    const sentAt = pendingSends.get(channelArn);
    if (sentAt === undefined) return null;

    pendingSends.delete(channelArn);
    const receivedAt = performance.now();
    const roundTripMs = Math.round(receivedAt - sentAt);

    const measurement: LatencyMeasurement = {
      roundTripMs,
      sentAt,
      receivedAt,
      channelArn,
    };

    // Report to the event tracking service
    trackPerformance('message_round_trip_ms', roundTripMs);

    return measurement;
  } catch {
    return null;
  }
}

/**
 * Clear any pending measurement for a channel (e.g., on conversation switch).
 */
export function clearPending(channelArn: string): void {
  pendingSends.delete(channelArn);
  ttffReported.delete(channelArn);
}
