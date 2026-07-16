/**
 * Tracks message round-trip latency: from user clicking send to bot response arriving via WebSocket.
 *
 * Uses performance.now() for high-resolution timing. Stores pending measurements
 * keyed by channelArn, since we don't know the response messageId ahead of time.
 */

import { trackPerformance } from './eventTrackingService';

export interface LatencyMeasurement {
  roundTripMs: number;
  sentAt: number;
  receivedAt: number;
  channelArn: string;
}

// Map of channelArn -> timestamp when the most recent message was sent
const pendingSends = new Map<string, number>();

/**
 * Call when the user clicks send. Records the high-resolution timestamp.
 * @param channelArn - The channel ARN where the message is being sent
 */
export function markMessageSent(channelArn: string): void {
  try {
    pendingSends.set(channelArn, performance.now());
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
}
