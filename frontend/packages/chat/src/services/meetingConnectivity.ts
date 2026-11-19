/**
 * WHAT THIS APP READS OF ITS OWN CONNECTION AND DEVICES during a meeting (SPEC-ASSISTANT-MEETINGS FR44), turned into the
 * events the meeting reporter files (`meetingEventReporter.ts`).
 *
 * SAMPLED, NOT STREAMED. The Amazon Chime SDK hands the app a metric report every second (`metricsDidReceive`); the
 * sampler keeps the interval's readings and files their means once per interval, so an hour holds 240 readings per
 * attendee rather than 3,600. Its clock is the SDK's own report: no timer runs here, and a session that stops reporting
 * files nothing. A change of health (`connectionDidBecomePoor`, `connectionDidBecomeGood`) is filed the moment it
 * happens, and a turn to poor is sent at once.
 *
 * A DEVICE IS NAMED ONLY BY ITS CLASS. A label such as "Jane's AirPods" names a person, and a device id identifies a
 * machine, so neither leaves this module: `deviceClassOf` reads the label here and returns one of a fixed set.
 */
import { CONNECTIVITY_SAMPLE_INTERVAL_MS } from './meetingEventNames';

export type RecordEvent = (name: string, attributes?: Record<string, unknown>) => void;

/** The SDK's metric report, as far as the sampler reads it (`ClientMetricReport`). */
export interface MetricReport {
  getObservableMetrics(): Record<string, number>;
  getObservableVideoMetrics?(): Record<string, Record<string, Record<string, number>>>;
}

/** One second's reading, in the units the server keeps: percent, milliseconds, kilobits per second. */
export interface Reading {
  audioLossSendPct?: number;
  audioLossReceivePct?: number;
  audioJitterMs?: number;
  rttMs?: number;
  availableSendKbps?: number;
  availableReceiveKbps?: number;
  videoSendKbps?: number;
  videoReceiveKbps?: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * The reading in one SDK report. Loss is the SDK's percent over the last second (`audioPacketLossPercent` up,
 * `audioPacketsReceivedFractionLoss` down), times are its milliseconds, and its bit rates are converted to kilobits. Video
 * received is the sum of every remote stream's bit rate, and a metric the report does not hold is left out.
 */
export function readingOf(report: MetricReport, selfAttendeeId?: string): Reading {
  const m = report.getObservableMetrics() ?? {};
  const out: Reading = {};
  const set = (k: keyof Reading, v: unknown, scale = 1) => { if (finite(v)) out[k] = v * scale; };
  set('audioLossSendPct', m.audioPacketLossPercent);
  set('audioLossReceivePct', m.audioPacketsReceivedFractionLoss);
  set('audioJitterMs', m.audioDownstreamJitterMs);
  set('rttMs', m.currentRoundTripTimeMs ?? m.audioUpstreamRoundTripTimeMs);
  set('availableSendKbps', m.availableOutgoingBitrate, 1 / 1000);
  set('availableReceiveKbps', m.availableIncomingBitrate, 1 / 1000);
  set('videoSendKbps', m.videoUpstreamBitrate, 1 / 1000);
  try {
    const video = report.getObservableVideoMetrics?.() ?? {};
    let received = 0;
    let any = false;
    for (const [attendeeId, streams] of Object.entries(video)) {
      if (attendeeId === selfAttendeeId) continue;
      for (const s of Object.values(streams ?? {})) {
        if (finite(s?.videoDownstreamBitrate)) { received += s.videoDownstreamBitrate; any = true; }
      }
    }
    if (any) out.videoReceiveKbps = received / 1000;
  } catch { /* a report without the video index carries no video received */ }
  return out;
}

export interface ConnectivitySampler {
  /** One SDK metric report. Files the interval's reading once the interval has run. */
  metrics(report: MetricReport): void;
  becamePoor(): void;
  becameGood(): void;
  suggestedStopVideo(): void;
}

/**
 * A sampler for one session. `now` is read only when a report arrives. A new session starts a new sampler, whose health
 * starts good, as the SDK's connection monitor does.
 */
export function createConnectivitySampler(
  record: RecordEvent, opts: { now?: () => number; intervalMs?: number; selfAttendeeId?: string } = {},
): ConnectivitySampler {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? CONNECTIVITY_SAMPLE_INTERVAL_MS;
  let health: 'good' | 'poor' = 'good';
  let windowStart: number | null = null;
  let readings: Reading[] = [];

  const file = () => {
    const attributes: Record<string, unknown> = { connectionHealth: health, readings: readings.length };
    const keys = new Set(readings.flatMap((r) => Object.keys(r) as Array<keyof Reading>));
    for (const k of keys) {
      const xs = readings.map((r) => r[k]).filter(finite);
      if (xs.length) attributes[k] = xs.reduce((a, b) => a + b, 0) / xs.length;
    }
    record('connectivitySample', attributes);
  };

  return {
    metrics(report) {
      const t = now();
      if (windowStart === null) windowStart = t;
      readings.push(readingOf(report, opts.selfAttendeeId));
      if (t - windowStart >= intervalMs) {
        file();
        windowStart = t;
        readings = [];
      }
    },
    becamePoor() {
      if (health === 'poor') return;
      health = 'poor';
      record('connectionBecamePoor');
    },
    becameGood() {
      if (health === 'good') return;
      health = 'good';
      record('connectionBecameGood');
    },
    suggestedStopVideo() {
      record('videoStopSuggested');
    },
  };
}

export type DeviceClass = 'built-in' | 'bluetooth' | 'usb' | 'virtual' | 'unknown' | 'none';

/**
 * The class of a device, read from its label and nothing else leaves: `virtual` for software devices (a virtual camera,
 * a loopback or noise-suppression driver), `bluetooth` for wireless headsets, `built-in` for the machine's own, `usb` for
 * a USB device or one the browser labels with its vendor and product ids and nothing that says it is built in, else
 * `unknown`, which is also the class of an unlabeled device (the browser withholds labels until a permission is granted).
 */
export function deviceClassOf(label: string | undefined | null): DeviceClass {
  const l = (label ?? '').toLowerCase();
  if (!l) return 'unknown';
  if (/virtual|obs |obs-|blackhole|loopback|soundflower|krisp|vb-audio|voicemeeter|snap camera|nvidia broadcast|camo/.test(l)) return 'virtual';
  if (/bluetooth|airpods|buds|hands-?free|\bbt\b|wh-1000|bose/.test(l)) return 'bluetooth';
  if (/usb/.test(l)) return 'usb';
  // Chromium adds the vendor and product ids to every camera it lists, the machine's own included, so the ids say USB only
  // where nothing in the label says the device is built in.
  if (/built-?in|internal|integrated|facetime|macbook|realtek|default|communications|microphone array|speakers/.test(l)) return 'built-in';
  if (/\([0-9a-f]{4}:[0-9a-f]{4}\)/.test(l)) return 'usb';
  return 'unknown';
}

/** Whether a failed `getUserMedia` or device start was the person, or the browser, refusing the permission. */
export function isPermissionDenied(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}
