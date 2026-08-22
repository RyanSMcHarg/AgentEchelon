/**
 * THE BROWSER'S OWN VIEW OF THE WAIT (G5, docs/guides/developer/LATENCY-TARGETS.md).
 *
 * Two numbers come out of one send, and the whole value of the pair is that they bracket DIFFERENT
 * spans: `client_ttff_ms` ends when the placeholder renders, `message_round_trip_ms` ends when the
 * real answer does. Compared against the server's own TTFF, the first exposes the WebSocket hop and
 * the render - the part of the perceived wait no server-side bracket can see.
 *
 * The failure this guards is over-reporting. A duel posts a placeholder PER SIDE and a resumed chain
 * posts a receipt beside the answer, so a naive "on placeholder, emit" fires two or three times for
 * one send and the later ones measure a rival starting rather than a person waiting - inflating the
 * sample count with values that answer no question.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackPerformance = vi.fn();
vi.mock('@ae/shared', () => ({ trackPerformance: (...a: unknown[]) => trackPerformance(...a) }));

import {
  markMessageSent,
  markPlaceholderShown,
  markResponseReceived,
  clearPending,
} from './messageLatencyTracker';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const OTHER = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c2';

const emitted = (metric: string) =>
  trackPerformance.mock.calls.filter((c) => c[0] === metric);

beforeEach(() => {
  trackPerformance.mockReset();
  clearPending(CHANNEL);
  clearPending(OTHER);
});

describe('client TTFF', () => {
  it('is emitted when the placeholder renders', () => {
    markMessageSent(CHANNEL);
    markPlaceholderShown(CHANNEL);

    expect(emitted('client_ttff_ms')).toHaveLength(1);
    expect(emitted('client_ttff_ms')[0][1]).toBeGreaterThanOrEqual(0);
  });

  it('is emitted ONCE however many placeholders a turn posts', () => {
    // A duel: two sides, two placeholders, one person waiting. The second and third would measure
    // the rival's start, not the wait.
    markMessageSent(CHANNEL);
    markPlaceholderShown(CHANNEL);
    markPlaceholderShown(CHANNEL);
    markPlaceholderShown(CHANNEL);

    expect(emitted('client_ttff_ms')).toHaveLength(1);
  });

  it('does NOT consume the send, so the round trip is still measured to the real answer', () => {
    // The two metrics answer different questions and both come from one send. A placeholder
    // interrupts the silence; it does not end the wait.
    markMessageSent(CHANNEL);
    markPlaceholderShown(CHANNEL);
    const measurement = markResponseReceived(CHANNEL);

    expect(measurement).not.toBeNull();
    expect(emitted('client_ttff_ms')).toHaveLength(1);
    expect(emitted('message_round_trip_ms')).toHaveLength(1);
  });

  it('is not emitted for a placeholder in a channel this user did not send in', () => {
    // The WebSocket handler sees every channel. Without the pending-send gate, an assistant replying
    // in a background conversation would report a "wait" nobody was having.
    markPlaceholderShown(OTHER);
    expect(emitted('client_ttff_ms')).toHaveLength(0);
  });

  it('re-arms on the next send', () => {
    markMessageSent(CHANNEL);
    markPlaceholderShown(CHANNEL);
    markMessageSent(CHANNEL);
    markPlaceholderShown(CHANNEL);

    expect(emitted('client_ttff_ms')).toHaveLength(2);
  });

  it('measures the placeholder from the send, not from the previous answer', () => {
    // The value, not just the count. The latch releases on SEND, so the span measured is always
    // "this person's current wait" - releasing it anywhere else (on the answer, on a timer) would
    // let a placeholder be measured against a send it did not follow.
    const sentAt = performance.now();
    markMessageSent(CHANNEL);
    markPlaceholderShown(CHANNEL);

    const [, value] = emitted('client_ttff_ms')[0];
    expect(Number(value)).toBeLessThanOrEqual(Math.round(performance.now() - sentAt) + 1);
  });

  it('does not report a second turn against the first turn\'s send', () => {
    // The bug this shape prevents: a latch that is never released would silently stop reporting, and
    // one released at the wrong moment would report the wrong span. Both look like a working metric.
    markMessageSent(CHANNEL);
    markPlaceholderShown(CHANNEL);
    markResponseReceived(CHANNEL);
    // No new send: nothing here is a wait anyone is having.
    markPlaceholderShown(CHANNEL);

    expect(emitted('client_ttff_ms')).toHaveLength(1);
  });

  it('is not emitted after the conversation is switched away from', () => {
    markMessageSent(CHANNEL);
    clearPending(CHANNEL);
    markPlaceholderShown(CHANNEL);

    expect(emitted('client_ttff_ms')).toHaveLength(0);
  });
});
