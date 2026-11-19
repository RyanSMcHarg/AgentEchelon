import { describe, it, expect, vi } from 'vitest';
import { createConnectivitySampler, deviceClassOf, isPermissionDenied, readingOf } from './meetingConnectivity';
import { createMeetingEventReporter } from './meetingEventReporter';
import type { ReportedEvent } from './meetingEventNames';

const report = (m: Record<string, number>, video: Record<string, Record<string, Record<string, number>>> = {}) => ({
  getObservableMetrics: () => m,
  getObservableVideoMetrics: () => video,
});

describe('a connectivity reading', () => {
  it('reads loss, jitter, round trip and bandwidth in the units the server keeps, and sums the video received', () => {
    expect(readingOf(report({
      audioPacketLossPercent: 1.5, audioPacketsReceivedFractionLoss: 3, audioDownstreamJitterMs: 12, currentRoundTripTimeMs: 90,
      availableOutgoingBitrate: 2_000_000, availableIncomingBitrate: 5_000_000, videoUpstreamBitrate: 600_000,
    }, { self: { 1: { videoDownstreamBitrate: 999_000 } }, other: { 2: { videoDownstreamBitrate: 300_000 }, 3: { videoDownstreamBitrate: 200_000 } } }), 'self')).toEqual({
      audioLossSendPct: 1.5, audioLossReceivePct: 3, audioJitterMs: 12, rttMs: 90,
      availableSendKbps: 2000, availableReceiveKbps: 5000, videoSendKbps: 600, videoReceiveKbps: 500,
    });
  });

  it('leaves out a metric the report does not hold, rather than reading it as zero', () => {
    expect(readingOf(report({ audioPacketLossPercent: NaN }))).toEqual({});
  });
});

describe('the sampler', () => {
  it('files the means of an interval\'s readings once per interval, with no timer of its own', () => {
    const record = vi.fn();
    let t = 0;
    const s = createConnectivitySampler(record, { now: () => t, intervalMs: 15_000 });
    for (; t < 15_000; t += 1000) s.metrics(report({ currentRoundTripTimeMs: t < 7_500 ? 100 : 200 }));
    expect(record).not.toHaveBeenCalled();
    s.metrics(report({ currentRoundTripTimeMs: 200 }));
    expect(record).toHaveBeenCalledTimes(1);
    const [name, attrs] = record.mock.calls[0];
    expect(name).toBe('connectivitySample');
    expect(attrs).toEqual({ connectionHealth: 'good', readings: 16, rttMs: (8 * 100 + 8 * 200) / 16 });
  });

  it('reports a change of health at once, once per change, and the next reading carries it', () => {
    const record = vi.fn();
    let t = 0;
    const s = createConnectivitySampler(record, { now: () => t, intervalMs: 1000 });
    s.becameGood();
    s.becamePoor();
    s.becamePoor();
    expect(record.mock.calls.map((c) => c[0])).toEqual(['connectionBecamePoor']);
    s.metrics(report({}));
    t = 1000;
    s.metrics(report({}));
    expect(record).toHaveBeenLastCalledWith('connectivitySample', expect.objectContaining({ connectionHealth: 'poor' }));
    s.becameGood();
    expect(record).toHaveBeenLastCalledWith('connectionBecameGood');
  });

  it('sends a turn to poor through the reporter at once, with the readings waiting before it', async () => {
    const send = vi.fn(async (_e: ReportedEvent[]) => undefined);
    const reporter = createMeetingEventReporter(send, () => 1);
    let t = 0;
    const s = createConnectivitySampler(reporter.record, { now: () => t, intervalMs: 1000 });
    s.metrics(report({ audioPacketLossPercent: 4 }));
    t = 1000;
    s.metrics(report({ audioPacketLossPercent: 4 }));
    expect(send).not.toHaveBeenCalled();
    s.becamePoor();
    await Promise.resolve();
    expect(send.mock.calls[0][0].map((e) => e.name)).toEqual(['connectivitySample', 'connectionBecamePoor']);
    expect(send.mock.calls[0][0][0].attributes).toEqual({ connectionHealth: 'good', readings: 2, audioLossSendPct: 4 });
  });
});

describe('a device is named by its class only', () => {
  it.each([
    ["Jane's AirPods", 'bluetooth'],
    ['Headset (WH-1000XM4 Hands-Free)', 'bluetooth'],
    ['USB Audio Device', 'usb'],
    ['Logitech BRIO (046d:085e)', 'usb'],
    ['MacBook Pro Microphone (Built-in)', 'built-in'],
    ['FaceTime HD Camera', 'built-in'],
    // Chromium labels the machine's own camera with its ids too.
    ['FaceTime HD Camera (Built-in) (05ac:8514)', 'built-in'],
    ['Integrated Webcam (0c45:6713)', 'built-in'],
    ['OBS Virtual Camera', 'virtual'],
    ['BlackHole 2ch', 'virtual'],
    ['Studio Display', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('%s is %s', (label, cls) => {
    expect(deviceClassOf(label)).toBe(cls);
  });

  it('knows a refused permission from another failure', () => {
    expect(isPermissionDenied({ name: 'NotAllowedError' })).toBe(true);
    expect(isPermissionDenied({ name: 'PermissionDeniedError' })).toBe(true);
    expect(isPermissionDenied({ name: 'NotFoundError' })).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
  });
});
