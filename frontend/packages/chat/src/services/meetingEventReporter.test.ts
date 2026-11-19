import { describe, it, expect, vi } from 'vitest';
import type { ReportedEvent } from './meetingEventNames';
import { READINGS_PER_REPORT, createMeetingEventReporter, reportRingOutcome, reportedAttributes } from './meetingEventReporter';
import { CONNECTIVITY_SAMPLE_INTERVAL_MS } from './meetingEventNames';

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe('what this app reports of a meeting', () => {
  it('sends a join outcome and a failure at once, and batches the rest until the person leaves', async () => {
    const send = vi.fn(async (_events: ReportedEvent[]) => undefined);
    const r = createMeetingEventReporter(send, () => 1000);
    r.record('meetingStartRequested');
    expect(send).not.toHaveBeenCalled();
    r.record('meetingStartSucceeded', { meetingStartDurationMs: 1840, browserName: 'Chrome' });
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([
      { name: 'meetingStartRequested', at: 1000, attributes: {} },
      { name: 'meetingStartSucceeded', at: 1000, attributes: { meetingStartDurationMs: 1840, browserName: 'Chrome' } },
    ]);
    r.record('meetingReconnected');
    await r.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends a full batch without waiting, and never more than twenty in one report', async () => {
    const send = vi.fn(async (_events: ReportedEvent[]) => undefined);
    const r = createMeetingEventReporter(send);
    for (let i = 0; i < 20; i++) r.record('attendeePresenceReceived');
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toHaveLength(20);
  });

  it('sends a batch once it holds a minute of connectivity readings, so an exit that sends nothing loses at most that minute', async () => {
    const send = vi.fn(async (_events: ReportedEvent[]) => undefined);
    const r = createMeetingEventReporter(send);
    r.record('audioMuted');
    for (let i = 1; i < READINGS_PER_REPORT; i++) r.record('connectivitySample', { rttMs: 80 });
    await flushPromises();
    expect(send).not.toHaveBeenCalled();
    r.record('connectivitySample', { rttMs: 90 });
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((e) => e.name)).toEqual(['audioMuted', ...Array(READINGS_PER_REPORT).fill('connectivitySample')]);
    // The count starts again with the next batch.
    for (let i = 1; i < READINGS_PER_REPORT; i++) r.record('connectivitySample', { rttMs: 80 });
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(READINGS_PER_REPORT * CONNECTIVITY_SAMPLE_INTERVAL_MS).toBe(60_000);
  });

  it('resolves a flush only once the batch it holds is sent, so a caller can send it before the meeting ends', async () => {
    let delivered: () => void = () => undefined;
    const send = vi.fn((_events: ReportedEvent[]) => new Promise<void>((resolve) => { delivered = resolve; }));
    const r = createMeetingEventReporter(send);
    r.record('audioUnmuted');
    let settled = false;
    const flushed = r.flush().then(() => { settled = true; });
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    delivered();
    await flushed;
    expect(settled).toBe(true);
  });

  it('ignores an event the server does not file, and never lets a failed send reach the meeting', async () => {
    const send = vi.fn(async (_events: ReportedEvent[]): Promise<void> => { throw new Error('offline'); });
    const r = createMeetingEventReporter(send);
    r.record('videoInputSelected');
    r.record('audioInputFailed', { audioInputErrorMessage: 'NotAllowedError' });
    await expect(r.flush()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0][0]?.attributes).toEqual({ errorMessage: 'NotAllowedError' });
  });

  it('maps the SDK attribute names onto the ones the server keeps, and sends nothing else', () => {
    expect(reportedAttributes({
      browserName: 'Firefox', browserMajorVersion: '131', osName: 'Windows', sdkVersion: '3.31.0', meetingHistory: [1, 2], attendeeId: 'a-9',
      meetingStartDurationMs: 2200, signalingOpenDurationMs: 300,
    })).toEqual({ browserName: 'Firefox', browserVersion: '131', osName: 'Windows', sdkVersion: '3.31.0', meetingStartDurationMs: 2200, signalingOpenDurationMs: 300 });
  });

  it('reports a ring outcome once, with no attendee, and swallows a failed send', async () => {
    const send = vi.fn(async (_arn: string, _events: ReportedEvent[]): Promise<void> => { throw new Error('offline'); });
    reportRingOutcome('arn:c1', 'ringDismissed', send, () => 5);
    await flushPromises();
    expect(send).toHaveBeenCalledWith('arn:c1', [{ name: 'ringDismissed', at: 5 }]);
  });
});
