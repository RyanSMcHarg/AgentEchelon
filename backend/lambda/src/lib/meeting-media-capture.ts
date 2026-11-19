/**
 * A MEETING'S AUDIO AND VIDEO CAPTURE, AS THE MEETINGS FUNCTIONS RUN IT (SPEC-ASSISTANT-MEETINGS FR70, `meeting-recording.ts`):
 *  - RECORDING ON, where the deployment records media (`meetingMediaRecording`): an Amazon Chime SDK media capture pipeline
 *    joins the meeting and writes 5-second chunks under the part's `capture` prefix (`CreateMediaCapturePipeline`);
 *  - RECORDING OFF, OR THE MEETING'S END: the capture pipeline is deleted (`DeleteMediaCapturePipeline`) and a media
 *    concatenation pipeline joins its chunks into one composited audio and video file under the part's `media` prefix
 *    (`CreateMediaConcatenationPipeline`), which the service starts once the capture has stopped;
 *  - the service's own events finish it (`meeting-recording-events.ts`): a capture that stopped on its own (the meeting
 *    ended, or it failed) is concatenated there, the recording written is marked ready and its chunks deleted, and a
 *    concatenation that failed is marked failed. Each finish is told to the meeting's router, which rewrites the ended card.
 *
 * Each step is one conditional write on the meeting conversation's record (`lastMeeting.recordings[partId]`), so a stop and
 * the service's event racing each other concatenate a part once. Nothing here decides who the caller is: recording is
 * turned on and off only through the host's transcription mode (`meeting-transcription.ts`) and the meeting's end.
 */
import { randomUUID } from 'crypto';
import {
  ChimeSDKMediaPipelinesClient, CreateMediaCapturePipelineCommand, CreateMediaConcatenationPipelineCommand, DeleteMediaCapturePipelineCommand,
} from '@aws-sdk/client-chime-sdk-media-pipelines';
import { ChimeSDKMeetingsClient, GetMeetingCommand } from '@aws-sdk/client-chime-sdk-meetings';
import {
  __setChannelContextStore, moveMeetingRecordingPart, readMeetingRecordings, recordMeetingRecordingPart,
} from './channel-context-client.js';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { fileMeetingEvents } from './meeting-event-archive.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { conversationIdOf } from './dashboard-keys.js';
import { isTransientReadError, readWithRetry } from './transient-retry.js';
import type { MeetingLifecycleDetail } from './meeting-lifecycle.js';
import { publishMeetingLifecycle, type LifecycleBus } from './meeting-lifecycle-publish.js';
import {
  CAPTURE_ARTIFACTS, CONCATENATION_ARTIFACTS, RECORDING_EVENTS, capturePrefix, mediaPrefix, meetingMediaRecordingEnabled, recordingPartsOf,
  sinkArn, type RecordingPart, type RecordingPartState, type RecordingPlace,
} from './meeting-recording.js';

const LOG = '[meeting-media-capture]';

type Send = { send(command: unknown): Promise<unknown> };
let pipelines: Send | undefined;
let meetings: Send | undefined;
let s3: Send | undefined;
let bus: Send | undefined;
/** Test seam: the clients the capture is run with. */
export function __setCaptureClients(c: { pipelines?: Send; meetings?: Send; ddb?: Send; s3?: Send; bus?: Send }): void {
  if (c.pipelines) pipelines = c.pipelines;
  if (c.meetings) meetings = c.meetings;
  // The record is written by the one module that writes the conversation's row (`channel-context-client.ts`).
  if (c.ddb) __setChannelContextStore(c.ddb as never);
  if (c.s3) s3 = c.s3;
  if (c.bus) bus = c.bus;
}
// EVERY CALL IS BOUNDED (`BOUNDED_REQUEST_HANDLER`): a meeting's end stops its capture before the meeting is deleted, so a
// stalled socket fails and is retried rather than holding the end.
const pipelinesClient = (): Send => (pipelines ??= new ChimeSDKMediaPipelinesClient({ requestHandler: BOUNDED_REQUEST_HANDLER }) as unknown as Send);
const meetingsClient = (): Send => (meetings ??= new ChimeSDKMeetingsClient({ requestHandler: BOUNDED_REQUEST_HANDLER }) as unknown as Send);
const s3Client = (): Send => (s3 ??= new S3Client({ requestHandler: BOUNDED_REQUEST_HANDLER }) as unknown as Send);

let pause: ((ms: number) => Promise<void>) | undefined;
/** Test seam: the wait between a pipeline call's attempts. */
export function __setCapturePause(p: (ms: number) => Promise<void>): void { pause = p; }

/** A pipeline call, made again after a passing fault (`lib/transient-retry.ts`); any other fault throws at once. */
const withAttempts = <T>(call: () => Promise<T>): Promise<T> => readWithRetry(call, 500, pause ? { pause } : {});

const isGone = (err: unknown): boolean => ['NotFoundException', 'ResourceNotFoundException'].includes((err as Error)?.name);

/** The conversation store's bucket the recording family is in (`ATTACHMENTS_BUCKET`). */
const bucket = (): string => process.env.ATTACHMENTS_BUCKET || '';
const table = (): string => process.env.CHANNEL_CONTEXT_TABLE || '';
/** The partition of this deployment's ARNs, read from its app instance. */
const partition = (): string => (process.env.APP_INSTANCE_ARN || '').split(':')[1] || 'aws';

/** The meeting a capture is of: its conversation (`meetingArn`, the meeting conversation's channel), its id and classification. */
export interface CapturedMeeting { meetingArn: string; meetingId: string; classification: string }

const placeOf = (m: CapturedMeeting, partId: string): RecordingPlace =>
  ({ classification: m.classification, conversationId: conversationIdOf(m.meetingArn), meetingId: m.meetingId, partId });

// ── THE RECORD ────────────────────────────────────────────────────────────────────────────────────

/**
 * THE MEETING'S RECORDING PARTS ON ITS CONVERSATION'S RECORD, read and written by the one module that writes that row
 * (`channel-context-client.ts`), only while the meeting is the record's last.
 */
export const recordingsOf = readMeetingRecordings;
export const movePart = moveMeetingRecordingPart;
const recordPart = recordMeetingRecordingPart;

// ── WHAT IT TELLS ─────────────────────────────────────────────────────────────────────────────────

/** File a recording's step as a platform meeting event, so the console's meeting detail and analytics hold it. Never throws. */
export async function fileRecordingEvent(m: CapturedMeeting, eventType: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await fileMeetingEvents([{
      meeting_id: m.meetingId, channel_arn: m.meetingArn, classification: m.classification, event_type: eventType, source: 'platform',
      attendee_id: null, person_key: null, is_content: false, network_transport: null, event_at: new Date().toISOString(), detail,
    }], undefined, { projection: 'best-effort' });
  } catch (err) {
    console.warn(`${LOG} the recording event could not be filed`, { eventType, err: (err as Error).name });
  }
}

/** The lifecycle events a recording's finish raises for the meeting's router, which rewrites the ended card. */
export type RecordingFinish = 'recording-ready' | 'recording-failed';

/** Tell the meeting's router a part finished, so it rewrites the ended card (`handleMeetingLifecycle`). Never throws. */
export async function publishRecordingFinish(m: CapturedMeeting, event: RecordingFinish): Promise<boolean> {
  const instance = process.env.MEETING_LIFECYCLE_INSTANCE || '';
  if (!instance) return false;
  try {
    const detail: MeetingLifecycleDetail = {
      instance, classification: m.classification, channelArn: m.meetingArn, meetingId: m.meetingId, event, at: new Date().toISOString(),
    };
    return await publishMeetingLifecycle(detail, bus as LifecycleBus | undefined);
  } catch (err) {
    console.warn(`${LOG} the recording's finish could not be published`, { event, err: (err as Error).name });
    return false;
  }
}

// ── CAPTURE ───────────────────────────────────────────────────────────────────────────────────────

/**
 * START CAPTURING THE MEETING'S AUDIO AND VIDEO, as a new part, where the deployment records media and no part is
 * capturing now. The sink is the part's `capture` prefix of the recording family. Never throws.
 */
export async function startMediaCapture(m: CapturedMeeting): Promise<'started' | 'off' | 'capturing' | 'failed'> {
  if (!meetingMediaRecordingEnabled() || !bucket() || !table()) return 'off';
  try {
    if ((await recordingsOf(m.meetingArn, m.meetingId)).some((p) => p.state === 'capturing')) return 'capturing';
    const partId = randomUUID();
    const place = placeOf(m, partId);
    const meeting = await meetingsClient().send(new GetMeetingCommand({ MeetingId: m.meetingId })) as { Meeting?: { MeetingArn?: string } };
    const sourceArn = meeting.Meeting?.MeetingArn;
    if (!sourceArn) throw Object.assign(new Error('the meeting has no ARN'), { name: 'NoMeetingArn' });
    const created = await pipelinesClient().send(new CreateMediaCapturePipelineCommand({
      SourceType: 'ChimeSdkMeeting', SourceArn: sourceArn,
      SinkType: 'S3Bucket', SinkArn: sinkArn(bucket(), capturePrefix(place), partition()),
      ClientRequestToken: partId,
      ChimeSdkMeetingConfiguration: { ArtifactsConfiguration: CAPTURE_ARTIFACTS },
    } as never)) as { MediaCapturePipeline?: { MediaPipelineId?: string; MediaPipelineArn?: string } };
    const capture = created.MediaCapturePipeline;
    if (!capture?.MediaPipelineId || !capture.MediaPipelineArn) throw Object.assign(new Error('no capture pipeline'), { name: 'NoCapturePipeline' });
    const recorded = await recordPart(m.meetingArn, m.meetingId, partId, {
      capture: capture.MediaPipelineId, captureArn: capture.MediaPipelineArn, classification: m.classification,
      startedAt: new Date().toISOString(), state: 'capturing',
    });
    if (!recorded) {
      // A capture the record does not hold is one nobody would finish: it is stopped while this call still knows it.
      await pipelinesClient().send(new DeleteMediaCapturePipelineCommand({ MediaPipelineId: capture.MediaPipelineId })).catch(() => undefined);
      return 'failed';
    }
    await fileRecordingEvent(m, RECORDING_EVENTS.started, { partId });
    console.log(`${LOG} capture started`, { meetingId: m.meetingId, partId });
    return 'started';
  } catch (err) {
    console.error(`${LOG} the capture could not be started`, { meetingId: m.meetingId, err: (err as Error).name });
    await fileRecordingEvent(m, RECORDING_EVENTS.failed, { step: 'capture', error: (err as Error).name });
    return 'failed';
  }
}

/**
 * JOIN A PART'S CHUNKS INTO ONE FILE: the part moves from capturing to processing (once, whoever calls), then a
 * concatenation pipeline is created on its capture, writing under the part's `media` prefix. The service starts it once
 * the capture has stopped. A concatenation the service refuses marks the part failed and tells the router.
 *
 * A PART PROCESSING WITH NO CONCATENATION IS JOINED AGAIN by whoever finds it so (`resumable`): the stop that moved it
 * and failed for a passing reason, or stopped short, and the capture's own end event both create it, and the request
 * token makes every create of one part the same pipeline. So no part waits in processing with nothing left to finish it.
 */
export const resumable = (part: Pick<RecordingPart, 'state' | 'concatenation'>): boolean => part.state === 'processing' && !part.concatenation;

export async function concatenatePart(m: CapturedMeeting, part: { partId: string } & RecordingPart): Promise<'started' | 'not capturing' | 'failed'> {
  if (!resumable(part) && !(await movePart(m.meetingArn, m.meetingId, part.partId, ['capturing'], 'processing'))) return 'not capturing';
  try {
    const created = await withAttempts(() => pipelinesClient().send(new CreateMediaConcatenationPipelineCommand({
      Sources: [{
        Type: 'MediaCapturePipeline',
        MediaCapturePipelineSourceConfiguration: { MediaPipelineArn: part.captureArn, ChimeSdkMeetingConfiguration: { ArtifactsConfiguration: CONCATENATION_ARTIFACTS } },
      }],
      Sinks: [{ Type: 'S3Bucket', S3BucketSinkConfiguration: { Destination: sinkArn(bucket(), mediaPrefix(placeOf(m, part.partId)), partition()) } }],
      ClientRequestToken: `${part.partId}-concatenation`.slice(0, 64),
    } as never))) as { MediaConcatenationPipeline?: { MediaPipelineId?: string } };
    const id = created.MediaConcatenationPipeline?.MediaPipelineId;
    if (!id) throw Object.assign(new Error('no concatenation pipeline'), { name: 'NoConcatenationPipeline' });
    await movePart(m.meetingArn, m.meetingId, part.partId, ['processing'], 'processing', { concatenation: id });
    await fileRecordingEvent(m, RECORDING_EVENTS.stopped, { partId: part.partId });
    console.log(`${LOG} concatenation started`, { meetingId: m.meetingId, partId: part.partId });
    return 'started';
  } catch (err) {
    console.error(`${LOG} the concatenation could not be started`, { meetingId: m.meetingId, err: (err as Error).name });
    // A FAULT THAT MAY PASS LEAVES THE PART PROCESSING WITH NO CONCATENATION, which the caller's retried invoke and the
    // capture's own end event join again (`resumable`). Only a refusal fails the part for good.
    if (isTransientReadError(err)) throw err;
    await failPart(m, part.partId, 'concatenation', (err as Error).name);
    return 'failed';
  }
}

/** Mark a part failed, file it, and tell the router so the ended card says so. */
export async function failPart(m: CapturedMeeting, partId: string, failure: 'capture' | 'concatenation', error?: string): Promise<boolean> {
  if (!(await movePart(m.meetingArn, m.meetingId, partId, ['capturing', 'processing'], 'failed', { failure }))) return false;
  await fileRecordingEvent(m, RECORDING_EVENTS.failed, { partId, step: failure, ...(error ? { error } : {}) });
  await publishRecordingFinish(m, 'recording-failed');
  return true;
}

/**
 * STOP CAPTURING: every part capturing now has its capture pipeline deleted, then is concatenated. A capture the service
 * already stopped (the meeting ended) is concatenated all the same. A CAPTURE THAT COULD NOT BE DELETED IS STILL RECORDING,
 * so its part stays capturing and is counted `stillCapturing`: it is joined when the service stops it (the meeting's end,
 * `meeting-recording-events.ts`), and the caller never says recording stopped while it runs. Never throws.
 */
export async function stopMediaCapture(m: CapturedMeeting): Promise<{ stopped: number; stillCapturing: number }> {
  const out = { stopped: 0, stillCapturing: 0 };
  if (!table()) return out;
  try {
    for (const part of (await recordingsOf(m.meetingArn, m.meetingId)).filter((p) => p.state === 'capturing')) {
      try {
        await withAttempts(() => pipelinesClient().send(new DeleteMediaCapturePipelineCommand({ MediaPipelineId: part.capture })));
      } catch (err) {
        if (!isGone(err)) {
          console.error(`${LOG} the capture could not be deleted; it is still recording`, { meetingId: m.meetingId, err: (err as Error).name });
          out.stillCapturing++;
          continue;
        }
      }
      try {
        if (await concatenatePart(m, part) === 'started') out.stopped++;
      } catch (err) {
        console.error(`${LOG} the capture stopped; its concatenation is made when the service reports the stop`, { err: (err as Error).name });
      }
    }
  } catch (err) {
    console.error(`${LOG} the capture could not be stopped`, { meetingId: m.meetingId, err: (err as Error).name });
    out.stillCapturing++;
  }
  return out;
}

/**
 * KEEP THE CAPTURE IN STEP WITH THE MEETING'S RECORDING MODE: recording turned on starts a part; turned off stops it and
 * joins it into one file. The one switch, called where the mode changes (`setTranscription`). Answers `still-capturing`
 * where recording was turned off and a capture could not be stopped, so the caller does not say it stopped. Never throws.
 */
export async function syncMediaCapture(m: CapturedMeeting, before: { recording: boolean }, after: { recording: boolean }): Promise<'in-step' | 'still-capturing'> {
  if (!meetingMediaRecordingEnabled()) return 'in-step';
  if (after.recording && !before.recording) await startMediaCapture(m);
  else if (!after.recording && before.recording && (await stopMediaCapture(m)).stillCapturing) return 'still-capturing';
  return 'in-step';
}

// ── CLEANUP ───────────────────────────────────────────────────────────────────────────────────────

/**
 * DELETE A PART'S CAPTURE CHUNKS once its recording is written: everything under the part's `capture` prefix, a thousand
 * keys a call. The recording family's expiry (`DeleteOldRecordings`) removes any a delete missed. Answers how many.
 */
export async function deleteCaptureChunks(place: RecordingPlace): Promise<number> {
  const b = bucket();
  const prefix = `${capturePrefix(place)}/`;
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = await s3Client().send(new ListObjectsV2Command({ Bucket: b, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) })) as
      { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string };
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
    if (keys.length) {
      await s3Client().send(new DeleteObjectsCommand({ Bucket: b, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}
