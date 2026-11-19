/**
 * A MEETING'S LIVE TRANSCRIPTION, AS THE MEETINGS FUNCTION RUNS IT (SPEC-ASSISTANT-MEETINGS FR28):
 *  - ON AT THE START where the deployment transcribes its meetings (`meetingTranscription`), started with the
 *    meeting, in recording mode unless `meetingRecording`
 *    is `false`; on or off after that, and between its two modes (captions only, or recording: captions, the stored
 *    transcript and the summary), by a host only (the meeting's recorded hosts);
 *  - each change recorded on the meeting's conversation (`lastMeeting.transcription`), so a person who joins while it is on
 *    is told before their audio is heard, and the service's own `TranscriptionStarted` and `TranscriptionStopped` events
 *    tell the room (`router-agent-handler.ts`);
 *  - what each attendee's app heard of its own person's speech kept as segments (`meeting-transcript.ts`), and the
 *    transcript written from them once the meeting ended.
 * Nothing here decides who the caller is: the meetings function proved the caller a member and the attendee theirs first.
 */
import {
  StartMeetingTranscriptionCommand, StopMeetingTranscriptionCommand, type ChimeSDKMeetingsClient,
} from '@aws-sdk/client-chime-sdk-meetings';
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import { chimeIdentityClient } from './chime/clients.js';
import { readWithRetry } from './transient-retry.js';
import { recordMeetingFact, type ChannelContext } from './channel-context-client.js';
import { userArnFor } from './person-arn.js';
import { syncMediaCapture } from './meeting-media-capture.js';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { MeetingLifecycleDetail } from './meeting-lifecycle.js';
import { publishMeetingLifecycle, type LifecycleBus } from './meeting-lifecycle-publish.js';
import {
  MEETING_TRANSCRIPTION_CONFIGURATION, TRANSCRIPT_CLOCK_SKEW_MS, composeTranscript, readStoredSegment, segmentKey, segmentsPrefix, transcriptKey,
  type TranscriptSegment,
} from './meeting-transcript.js';

const LOG = '[meeting-transcription]';

let s3: Pick<S3Client, 'send'> = new S3Client({});
let identity: Pick<ReturnType<typeof chimeIdentityClient>, 'send'> | undefined;
/** Test seam: the clients the transcript is written and named with. */
export function __setTranscriptClients(c: { s3?: Pick<S3Client, 'send'>; identity?: Pick<ReturnType<typeof chimeIdentityClient>, 'send'> }): void {
  if (c.s3) s3 = c.s3;
  if (c.identity) identity = c.identity;
}

/** The conversation store's bucket the transcript family is in (`ATTACHMENTS_BUCKET`). */
const bucket = (): string => process.env.ATTACHMENTS_BUCKET || '';

type Meetings = Pick<ChimeSDKMeetingsClient, 'send'>;

/** Whether the meeting is transcribed now (live captions), by its conversation's record. */
export const transcribingNow = (row: Pick<ChannelContext, 'lastMeeting'> | null | undefined, meetingId: string): boolean =>
  row?.lastMeeting?.meetingId === meetingId && row.lastMeeting.transcription?.on === true;

/** Whether the meeting is in recording mode now (captions, the stored transcript and the summary), by its record. */
export const recordingNow = (row: Pick<ChannelContext, 'lastMeeting'> | null | undefined, meetingId: string): boolean =>
  transcribingNow(row, meetingId) && row?.lastMeeting?.transcription?.recording === true;

/** How long after recording stops, or the meeting ends while recorded, an app's last lines are still kept: its report's batch. */
export const LATE_LINES_GRACE_MS = 30_000;

/**
 * THE LAST LINES OF A RECORDING, reported just after it stopped: the instant recording stopped (the meeting ended while
 * recorded, `endedAt`; or a host turned recording off, `recordedUntil`), where that was at most
 * {@link LATE_LINES_GRACE_MS} ago. Lines spoken before it are kept; undefined where no recording of this meeting
 * stopped that recently.
 */
export function lateLinesCutoff(
  row: Pick<ChannelContext, 'lastMeeting' | 'activeMeeting'> | null | undefined, meetingId: string, now = Date.now(),
): number | undefined {
  const last = row?.lastMeeting;
  if (!last || last.meetingId !== meetingId) return undefined;
  const t = last.transcription;
  const ended = row?.activeMeeting?.meetingId !== meetingId;
  const at = ended && t?.on === true && t.recording === true ? Date.parse(last.endedAt ?? '')
    : t?.recording !== true ? Date.parse(t?.recordedUntil ?? '') : NaN;
  return Number.isFinite(at) && now - at <= LATE_LINES_GRACE_MS && now >= at ? at : undefined;
}

/**
 * THE WINDOW A REPORTED LINE MUST HAVE BEEN SPOKEN IN, in epoch milliseconds, from the meeting's own record: from when its
 * latest stretch of recording began (`recordedFrom`; the meeting's creation for a record that carries none) to now while it
 * records, or to the instant recording stopped (`lateLinesCutoff`). A line spoken under captions alone, before recording
 * began, or after it stopped, is outside it. Undefined where no recording of this meeting takes lines now.
 */
export function transcriptWindow(
  row: Pick<ChannelContext, 'lastMeeting' | 'activeMeeting'> | null | undefined, meetingId: string, now = Date.now(),
): { fromMs: number; untilMs: number } | undefined {
  const last = row?.lastMeeting;
  if (!last || last.meetingId !== meetingId) return undefined;
  const running = row?.activeMeeting?.meetingId === meetingId;
  // While it records, now and the service's clock's skew; once it stopped, the instant it stopped, exactly.
  const until = running && recordingNow(row, meetingId) ? now + TRANSCRIPT_CLOCK_SKEW_MS : lateLinesCutoff(row, meetingId, now);
  if (until === undefined) return undefined;
  const created = Date.parse(last.createdAt);
  const began = Date.parse(last.transcription?.recordedFrom ?? '');
  const from = Number.isFinite(began) ? began : created;
  if (!Number.isFinite(from)) return undefined;
  return { fromMs: from - TRANSCRIPT_CLOCK_SKEW_MS, untilMs: until };
}

/** Characters of speech one person's share of a transcript holds per second of the meeting: about twice a fast talker's. */
export const TRANSCRIPT_CHARS_PER_SECOND = 30;
/** What one line costs of a person's share at least, so a share cannot be spent as a flood of short lines. */
export const TRANSCRIPT_LINE_MIN_CHARS = 40;

/**
 * ONE PERSON'S SHARE OF A TRANSCRIPT, in characters: what speaking without pause, twice as fast as a fast talker, from the
 * meeting's creation to `untilMs` could say, and one line's worth more. No one person's reports outweigh that, so nobody
 * pushes everyone else out of the transcript or its summary.
 */
export function transcriptShareOf(createdAt: string, untilMs: number): number {
  const created = Date.parse(createdAt);
  const seconds = Number.isFinite(created) ? Math.max(0, (untilMs - created) / 1000) : 0;
  return Math.ceil(seconds * TRANSCRIPT_CHARS_PER_SECOND) + MAX_LINE_SHARE;
}
const MAX_LINE_SHARE = 2_000;

/** What a report's lines cost of the reporting person's share. */
export const transcriptCostOf = (segments: readonly TranscriptSegment[]): number =>
  segments.reduce((n, s) => n + Math.max(s.text.length, TRANSCRIPT_LINE_MIN_CHARS), 0);

/** What a host asks for: captions on or off, recording on or off. Either may be left as it is. */
export interface TranscriptionAsk { on?: boolean; recording?: boolean }

/**
 * THE MODE A HOST'S ASK LEAVES THE MEETING IN, from its mode now: recording always includes captions, so turning recording on turns captions on;
 * captions cannot be turned off while recording is on (`RECORDING_ON`); turning recording off leaves captions as they are.
 */
export function nextTranscriptionMode(
  now: { on: boolean; recording: boolean }, ask: TranscriptionAsk,
): { on: boolean; recording: boolean } | { refused: 'RECORDING_ON' | 'INVALID_BODY' } {
  if (ask.on === undefined && ask.recording === undefined) return { refused: 'INVALID_BODY' };
  const recording = ask.recording ?? now.recording;
  if (ask.on === false && recording) return { refused: 'RECORDING_ON' };
  return { on: recording ? true : (ask.on ?? now.on), recording };
}

let bus: Pick<EventBridgeClient, 'send'> | undefined;
/** Test seam: the bus a mode change is published on. */
export function __setTranscriptionBus(b: Pick<EventBridgeClient, 'send'>): void { bus = b; }

/**
 * A CHANGE OF MODE THE SERVICE RAISES NO EVENT FOR (recording turned on or off while captions stay on) is published as the
 * meeting's own lifecycle event, so its router tells the meeting's chat as it does for the service's events. The router
 * checks the meeting's record before it says anything. Never throws: the people in the meeting are told aloud regardless.
 */
async function publishModeChange(meetingArn: string, meetingId: string, classification: string, recording: boolean): Promise<void> {
  const instance = process.env.MEETING_LIFECYCLE_INSTANCE || '';
  if (!instance) return;
  try {
    const detail: MeetingLifecycleDetail = {
      instance, classification, channelArn: meetingArn, meetingId, event: recording ? 'recording-started' : 'recording-stopped', at: new Date().toISOString(),
    };
    await publishMeetingLifecycle(detail, bus);
  } catch (err) {
    console.warn(`${LOG} the change of mode could not be published`, { meetingId, err: (err as Error).name });
  }
}

/**
 * SET THE MEETING'S TRANSCRIPTION MODE: record it on the meeting's conversation, then with the service. Captions turned on
 * or off start or stop the service's transcription; recording turned on or off while captions stay on changes what is kept
 * and is published as the meeting's lifecycle event. `by` is the host's AppInstanceUser id, or `platform` for the start.
 *
 * ONE CHANGE AT A TIME. The record is written only over the state the change was decided from (its `changedAt`), so two
 * hosts' changes decided from one read never both land: the second is refused and its host tries again from the record
 * as it stands, and `everOn`, `everRecorded` and `recordedFrom` are never lost to a change decided before them. A
 * service that refuses puts the record back as it was.
 */
export async function setTranscription(
  meetings: Meetings, meeting: { meetingArn: string; meetingId: string; classification: string },
  ask: TranscriptionAsk, by: string, row: Pick<ChannelContext, 'lastMeeting'> | null | undefined,
): Promise<{ on: boolean; recording: boolean } | { refused: 'RECORDING_ON' | 'INVALID_BODY' } | 'failed'> {
  const { meetingArn, meetingId } = meeting;
  const current = row?.lastMeeting?.meetingId === meetingId ? row.lastMeeting.transcription : undefined;
  const now = { on: current?.on === true, recording: current?.on === true && current.recording === true };
  const next = nextTranscriptionMode(now, ask);
  if ('refused' in next) return next;
  const everOn = next.on || current?.everOn === true;
  const everRecorded = next.recording || current?.everRecorded === true;
  const changedAt = new Date().toISOString();
  // WHEN THE LATEST STRETCH OF RECORDING BEGAN AND ENDED, so a line is kept only where it was spoken while recorded
  // (`transcriptWindow`), and the lines spoken before a stop and reported just after are still kept (`lateLinesCutoff`).
  const recordedFrom = !now.recording && next.recording ? changedAt : current?.recordedFrom;
  const recordedUntil = now.recording && !next.recording ? changedAt : current?.recordedUntil;
  const decidedFrom = current?.changedAt ?? null;
  const recorded = await recordMeetingFact(meetingArn, meetingId, { transcription: {
    on: next.on, recording: next.recording, changedAt, changedBy: by,
    ...(everOn ? { everOn: true } : {}), ...(everRecorded ? { everRecorded: true } : {}),
    ...(recordedFrom ? { recordedFrom } : {}), ...(recordedUntil ? { recordedUntil } : {}),
  } }, { ifChangedAt: decidedFrom });
  if (!recorded) {
    console.warn(`${LOG} the change of mode could not be recorded over the state it was decided from; nothing changed`, { meetingId });
    return 'failed';
  }
  /** The record as it was, written back over this change alone. */
  const putRecordBack = (): Promise<boolean> => recordMeetingFact(meetingArn, meetingId, { transcription: {
    on: now.on, recording: now.recording, changedAt: new Date().toISOString(), changedBy: by,
    ...(everOn ? { everOn: true } : {}), ...(everRecorded ? { everRecorded: true } : {}),
    ...(current?.recordedFrom ? { recordedFrom: current.recordedFrom } : {}), ...(current?.recordedUntil ? { recordedUntil: current.recordedUntil } : {}),
  } }, { ifChangedAt: changedAt });
  try {
    if (next.on && !now.on) {
      await meetings.send(new StartMeetingTranscriptionCommand({ MeetingId: meetingId, TranscriptionConfiguration: MEETING_TRANSCRIPTION_CONFIGURATION }));
    } else if (!next.on && now.on) {
      await meetings.send(new StopMeetingTranscriptionCommand({ MeetingId: meetingId }));
    }
  } catch (err) {
    console.warn(`${LOG} the service did not ${next.on ? 'start' : 'stop'} transcription; the record is put back`, { meetingId, err: (err as Error).name });
    await putRecordBack();
    return 'failed';
  }
  // THE RECORD AND THE SERVICE AGREE, or the change is undone: the record is what tells a joiner they are transcribed,
  // what keeps their lines, and what the end writes the transcript from.
  const putServiceBack = async (): Promise<void> => {
    try {
      if (next.on && !now.on) await meetings.send(new StopMeetingTranscriptionCommand({ MeetingId: meetingId }));
      else if (!next.on && now.on) await meetings.send(new StartMeetingTranscriptionCommand({ MeetingId: meetingId, TranscriptionConfiguration: MEETING_TRANSCRIPTION_CONFIGURATION }));
    } catch (err) {
      console.warn(`${LOG} the service could not be put back`, { meetingId, err: (err as Error).name });
    }
  };
  // RECORDING MODE IS ONE SWITCH: where the deployment records media, its audio and video are captured while it is on.
  // A CAPTURE THAT COULD NOT BE STOPPED KEEPS THE MEETING RECORDED: its audio and video are still being kept, so the record
  // says recording again, the service is put back, nobody is told it stopped, and the host may try again.
  if ((await syncMediaCapture(meeting, now, next)) === 'still-capturing') {
    console.warn(`${LOG} the capture could not be stopped; the meeting stays recorded`, { meetingId });
    await putRecordBack();
    await putServiceBack();
    return 'failed';
  }
  if (next.on === now.on && next.recording !== now.recording) await publishModeChange(meetingArn, meetingId, meeting.classification, next.recording);
  console.log(`${LOG} transcription ${next.on ? (next.recording ? 'recording' : 'captions') : 'off'}`, { meetingId, by: by === 'platform' ? 'platform' : 'host' });
  return next;
}

/**
 * KEEP WHAT AN ATTENDEE'S APP HEARD, each segment its own object under the meeting's segments, keyed by when it was spoken,
 * its speaker and the service's result id (`segmentKey`). WRITTEN ONCE: the write is conditional on no object at the key,
 * so a line once kept is never replaced, and a report sent again finds its segments already kept. Answers how many of
 * them are kept now.
 */
export async function keepSegments(
  where: { classification: string; conversationId: string; meetingId: string }, segments: readonly TranscriptSegment[],
): Promise<number> {
  const b = bucket();
  if (!b) throw new Error('the transcript store is not configured');
  await Promise.all(segments.map(async (s) => {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: b, Key: segmentKey(where.classification, where.conversationId, where.meetingId, s),
        Body: JSON.stringify(s), ContentType: 'application/json', IfNoneMatch: '*',
      }));
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      // Kept already, by this report's earlier delivery; or written at this instant by the same report sent twice.
      if (e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412 || e?.name === 'ConditionalRequestConflict' || e?.$metadata?.httpStatusCode === 409) return;
      throw err;
    }
  }));
  return segments.length;
}

/** The most segments one transcript is written from: the latest, by when each was spoken. */
export const MAX_TRANSCRIPT_SEGMENTS = 6_000;
/** How many segments are read at once. */
export const SEGMENT_READ_CONCURRENCY = 24;

/**
 * THE SEGMENTS KEPT FOR THE MEETING, read page by page, IN BOUNDED TIME: at most {@link MAX_TRANSCRIPT_SEGMENTS}, the latest
 * by their key's time, read {@link SEGMENT_READ_CONCURRENCY} at a time, so a meeting with many lines is written inside the
 * run entry's timeout. A segment that cannot be read after its retries is left out and counted, and the rest stand.
 */
async function segmentsOf(where: { classification: string; conversationId: string; meetingId: string }): Promise<TranscriptSegment[]> {
  const b = bucket();
  const prefix = segmentsPrefix(where.classification, where.conversationId, where.meetingId);
  let keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  if (keys.length > MAX_TRANSCRIPT_SEGMENTS) {
    console.warn(`${LOG} the transcript is written from its latest segments`, { kept: MAX_TRANSCRIPT_SEGMENTS, listed: keys.length });
    keys = keys.sort().slice(-MAX_TRANSCRIPT_SEGMENTS);
  }
  const out: Array<TranscriptSegment | null> = new Array(keys.length).fill(null);
  let unread = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < keys.length) {
      const i = next++;
      try {
        const got = await readWithRetry(() => s3.send(new GetObjectCommand({ Bucket: b, Key: keys[i] })), 100);
        const text = await got.Body?.transformToString();
        try { out[i] = readStoredSegment(JSON.parse(text ?? '')); } catch { out[i] = null; }
      } catch (err) {
        unread++;
        console.warn(`${LOG} a segment could not be read; it is left out`, { err: (err as Error).name });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEGMENT_READ_CONCURRENCY, keys.length) }, worker));
  if (unread) console.warn(`${LOG} segments left out of the transcript`, { unread, of: keys.length });
  return out.filter((s): s is TranscriptSegment => s !== null);
}

/** The name the room shows a person under: their AppInstanceUser's name. Their id where it cannot be read. */
async function namesOf(appInstanceArn: string, personIds: readonly string[]): Promise<Map<string, string>> {
  identity ??= chimeIdentityClient({});
  const names = await Promise.all(personIds.map(async (id) => {
    const r = await identity!.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: userArnFor(appInstanceArn, id) })).catch(() => null);
    return [id, r?.AppInstanceUser?.Name?.trim() || id] as const;
  }));
  return new Map(names);
}

/**
 * WRITE THE MEETING'S TRANSCRIPT from its segments, once it has ended: `transcripts/<classification>/<conversation>/<meeting>.md`.
 * Answers the key, or null where nothing was said that a transcript could hold.
 */
export async function writeTranscript(
  appInstanceArn: string, where: { classification: string; conversationId: string; meetingId: string },
): Promise<string | null> {
  const segments = await segmentsOf(where);
  if (!segments.length) return null;
  const names = await namesOf(appInstanceArn, [...new Set(segments.map((s) => s.personId))]);
  const key = transcriptKey(where.classification, where.conversationId, where.meetingId);
  await s3.send(new PutObjectCommand({
    Bucket: bucket(), Key: key, Body: composeTranscript(segments, (id) => names.get(id) ?? id), ContentType: 'text/markdown; charset=utf-8',
  }));
  return key;
}
