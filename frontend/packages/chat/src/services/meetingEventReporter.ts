/**
 * WHAT THIS APP SAW OF A MEETING, reported to the meeting API (`POST /meetings/events`), where it is filed beside the
 * service's own record as `source: client` (backend `meeting-client-events.ts`). Only this app can see how long joining
 * took, a microphone that failed, or a reconnect, so without it those figures do not exist.
 *
 * SENT ON EVENTS, NEVER ON A TIMER OF ITS OWN: at once for a join outcome or a failure, when a batch holds a minute of
 * connectivity readings or fills, and as the person leaves. The server files the last batch of a meeting that ended a
 * moment ago from an attendee it created, so a report sent as the meeting ends for everyone is kept. A report that cannot
 * be sent is dropped: it is telemetry, and a meeting must never wait on it.
 *
 * The server names the person, the meeting and the boundary; this sends only the event, its time and the attributes the
 * server keeps, under the names it keeps them by.
 */
import {
  CLIENT_MEETING_EVENTS, MAX_EVENTS_PER_REPORT, type ReportedEvent, type RingOutcome,
} from './meetingEventNames';

export { CLIENT_MEETING_EVENTS };

/**
 * Events sent at once rather than batched: the join outcome is the headline figure, and a failure, a connection turning
 * poor or a refused device is what an operator watches. A connectivity reading waits for its batch.
 */
const SEND_AT_ONCE: ReadonlySet<string> = new Set([
  'meetingStartSucceeded', 'meetingStartFailed', 'meetingFailed', 'audioInputFailed', 'videoInputFailed', 'signalingDropped',
  'connectionBecamePoor', 'devicePermissionDenied',
]);

/**
 * A BATCH IS SENT ONCE IT HOLDS FOUR CONNECTIVITY READINGS: one minute of the sampler's 15 second readings. The readings
 * already arrive on the sampler's own clock, so counting them bounds what a crash or a closed tab loses to the last
 * minute without a second timer. The bound trades loss against requests: one report a minute per attendee (60 for an
 * hour); a full batch of twenty would leave five minutes of readings to any exit that sends nothing, and a shorter bound
 * adds requests and archive objects for little more of the record.
 */
export const READINGS_PER_REPORT = 4;

/** The attributes this app reads itself (`meetingConnectivity.ts`), sent under their own names. */
const OWN_STRING_ATTRIBUTES = ['connectionHealth', 'deviceKind', 'deviceClass'] as const;
const OWN_NUMBER_ATTRIBUTES = [
  'audioLossSendPct', 'audioLossReceivePct', 'audioJitterMs', 'rttMs', 'availableSendKbps', 'availableReceiveKbps',
  'videoSendKbps', 'videoReceiveKbps', 'readings', 'deviceCount',
] as const;

/** The SDK's attribute names, mapped onto the ones the server keeps. Anything else is not sent. */
export function reportedAttributes(raw: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const str = (k: string, from: unknown) => { if (typeof from === 'string' && from) out[k] = from.slice(0, 200); };
  const num = (k: string, from: unknown) => { if (typeof from === 'number' && Number.isFinite(from)) out[k] = from; };
  str('browserName', raw.browserName);
  str('browserVersion', raw.browserMajorVersion ?? raw.browserVersion);
  str('osName', raw.osName);
  str('osVersion', raw.osVersion);
  str('deviceName', raw.deviceName);
  str('sdkName', raw.sdkName);
  str('sdkVersion', raw.sdkVersion);
  str('meetingStatus', raw.meetingStatus);
  str('errorMessage', raw.meetingErrorMessage ?? raw.audioInputErrorMessage ?? raw.videoInputErrorMessage);
  num('meetingStartDurationMs', raw.meetingStartDurationMs);
  num('attendeePresenceDurationMs', raw.attendeePresenceDurationMs);
  num('signalingOpenDurationMs', raw.signalingOpenDurationMs);
  num('retryCount', raw.retryCount);
  for (const k of OWN_STRING_ATTRIBUTES) str(k, raw[k]);
  for (const k of OWN_NUMBER_ATTRIBUTES) num(k, raw[k]);
  return out;
}

export interface MeetingEventReporter {
  /** One SDK event, from `eventController`'s `eventDidReceive`. An event the server does not file is ignored. */
  record(name: string, attributes?: Record<string, unknown>): void;
  /** Send what is waiting, resolved once it is sent or dropped. Called as the person leaves and before a host ends it. */
  flush(): Promise<void>;
}

/**
 * What happened to a ring this app showed, reported once with no attendee: the person may not have joined. The send is
 * given, so a test can watch it; its failure is swallowed, because a ring's outcome never holds up a join.
 */
export function reportRingOutcome(
  channelArn: string, outcome: RingOutcome, send: (channelArn: string, events: ReportedEvent[]) => Promise<void>, now: () => number = Date.now,
): void {
  void send(channelArn, [{ name: outcome, at: now() }]).catch(() => undefined);
}

/** A reporter for one attendee in one conversation's meeting. `send` posts one batch; its failure is swallowed. */
export function createMeetingEventReporter(send: (events: ReportedEvent[]) => Promise<void>, now: () => number = Date.now): MeetingEventReporter {
  let waiting: ReportedEvent[] = [];
  let readings = 0;
  const flush = async () => {
    if (waiting.length === 0) return;
    const batch = waiting.slice(0, MAX_EVENTS_PER_REPORT);
    waiting = waiting.slice(MAX_EVENTS_PER_REPORT);
    readings = waiting.filter((e) => e.name === 'connectivitySample').length;
    await send(batch).catch(() => undefined);
    if (waiting.length) await flush();
  };
  return {
    record(name, attributes = {}) {
      if (!(CLIENT_MEETING_EVENTS as readonly string[]).includes(name)) return;
      waiting.push({ name, at: now(), attributes: reportedAttributes(attributes) });
      if (name === 'connectivitySample') readings += 1;
      if (SEND_AT_ONCE.has(name) || readings >= READINGS_PER_REPORT || waiting.length >= MAX_EVENTS_PER_REPORT) void flush();
    },
    flush,
  };
}
