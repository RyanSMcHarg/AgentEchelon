/**
 * A MEETING RECORDING'S FINISH, FROM THE SERVICES' OWN EVENTS (SPEC-ASSISTANT-MEETINGS FR70, tenet D6: nothing polls).
 *
 * Two rules on the default bus hand this function its events:
 *  - Amazon Chime SDK's `Chime Media Pipeline State Change` ("Using Amazon Chime SDK media pipeline events"): a capture
 *    that stopped (`chime:MediaPipelineDeleted`) or failed (`chime:MediaPipelinePermanentFailure`) is concatenated, where
 *    no stop already did; a concatenation that failed marks its part failed; a concatenation that finished
 *    (`chime:MediaPipelineDeleted`) marks its part ready where its file is there;
 *  - Amazon S3's `Object Created` for a recording's composited file (`.../media/composited-video/<id>.mp4`): its part is
 *    ready.
 * A part made ready has its capture chunks deleted, and is filed as a meeting event; a ready or failed part is told to the
 * meeting's router, which rewrites the ended card (`recording-ready`, `recording-failed`).
 *
 * ONLY THIS DEPLOYMENT'S RECORDINGS. Both rules match every pipeline and every object of their kind in the account. An
 * event acts only where the meeting conversation's own record holds the pipeline, or the part the key names, for that
 * meeting while it is the conversation's last; every other event is skipped. A read that fails throws, so the event is
 * retried and a persistent failure lands on the dead-letter queue.
 */
import type { EventBridgeEvent } from 'aws-lambda';
import { ChimeSDKMediaPipelinesClient, GetMediaPipelineCommand } from '@aws-sdk/client-chime-sdk-media-pipelines';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  concatenatePart, deleteCaptureChunks, failPart, fileRecordingEvent, movePart, publishRecordingFinish, recordingsOf, resumable, type CapturedMeeting,
} from './lib/meeting-media-capture.js';
import { RECORDING_EVENTS, RECORDINGS_FAMILY, isRecordingPlace, mediaPrefix, parseRecordingKey, type RecordingPart, type RecordingPlace } from './lib/meeting-recording.js';
import { isMeetingId } from './lib/meeting-lifecycle.js';

const LOG = '[meeting-recording-events]';

type Send = { send(command: unknown): Promise<unknown> };
let pipelines: Send | undefined;
let s3: Send | undefined;
/** Test seam: the clients a pipeline is read and a recording found with. */
export function __setRecordingEventClients(c: { pipelines?: Send; s3?: Send }): void {
  if (c.pipelines) pipelines = c.pipelines;
  if (c.s3) s3 = c.s3;
}

const appInstanceArn = (): string => process.env.APP_INSTANCE_ARN || '';
const bucket = (): string => process.env.ATTACHMENTS_BUCKET || '';
const CHANNEL_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The detail Amazon Chime SDK sends for a media pipeline. Every field optional: it is the service's payload. */
interface PipelineEventDetail { eventType?: string; mediaPipelineId?: string; meetingId?: string; externalMeetingId?: string }
/** The detail Amazon S3 sends for an object created. */
interface ObjectCreatedDetail { bucket?: { name?: string }; object?: { key?: string } }

/** The parts of a recording-family prefix a pipeline's sink names: `.../recordings/<c>/<conv>/<meeting>/<part>/<capture|media>`. */
function placeOfSink(arn: unknown): RecordingPlace | null {
  if (typeof arn !== 'string') return null;
  const at = arn.indexOf(`/${RECORDINGS_FAMILY}`);
  if (at < 0) return null;
  const [classification, conversationId, meetingId, partId] = arn.slice(at + 1 + RECORDINGS_FAMILY.length).split('/');
  const place = { classification, conversationId, meetingId, partId };
  return isRecordingPlace(place) ? place : null;
}

/** The meeting a part belongs to, as the capture functions take it. */
const meetingOf = (conversationId: string, meetingId: string, classification: string): CapturedMeeting =>
  ({ meetingArn: `${appInstanceArn()}/channel/${conversationId}`, meetingId, classification });

/**
 * A PART'S RECORDING WAS WRITTEN: the part moves from processing to ready with its key (once, whichever event comes
 * first), its chunks are deleted, it is filed, and the router is told.
 */
async function partReady(m: CapturedMeeting, place: RecordingPlace, key: string): Promise<boolean> {
  if (!(await movePart(m.meetingArn, m.meetingId, place.partId, ['processing'], 'ready', { key }))) return false;
  const deleted = await deleteCaptureChunks(place).catch((err) => {
    console.warn(`${LOG} the capture chunks could not be deleted; the family's expiry removes them`, { err: (err as Error).name });
    return 0;
  });
  await fileRecordingEvent(m, RECORDING_EVENTS.ready, { partId: place.partId, chunksDeleted: deleted });
  await publishRecordingFinish(m, 'recording-ready');
  console.log(`${LOG} recording ready`, { meetingId: m.meetingId, partId: place.partId, chunksDeleted: deleted });
  return true;
}

/** The composited file a finished concatenation wrote under the part's `media` prefix, or null where there is none. */
async function writtenRecording(place: RecordingPlace): Promise<string | null> {
  s3 ??= new S3Client({}) as unknown as Send;
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${mediaPrefix(place)}/composited-video/` })) as { Contents?: Array<{ Key?: string }> };
  return (listed.Contents ?? []).map((o) => o.Key).find((k) => parseRecordingKey(k)?.partId === place.partId) ?? null;
}

/** A pipeline's event: its conversation, then its part by the conversation's own record. */
async function onPipelineEvent(detail: PipelineEventDetail): Promise<string> {
  const id = typeof detail.mediaPipelineId === 'string' ? detail.mediaPipelineId : '';
  const type = detail.eventType ?? '';
  if (!id || !/^chime:MediaPipeline(Deleted|PermanentFailure)$/.test(type)) return 'not a finish';
  // THE CONVERSATION, from the meeting's external id (the meeting conversation's id, `meeting-api.ts`), else from the sink
  // the pipeline writes to, which names the conversation, the meeting and the part.
  let conversationId = CHANNEL_ID.test(detail.externalMeetingId ?? '') ? detail.externalMeetingId as string : '';
  let meetingId = isMeetingId(detail.meetingId) ? detail.meetingId : '';
  if (!conversationId || !meetingId) {
    pipelines ??= new ChimeSDKMediaPipelinesClient({}) as unknown as Send;
    const got = await pipelines.send(new GetMediaPipelineCommand({ MediaPipelineId: id })).catch((err) => {
      const name = (err as Error).name;
      if (name === 'NotFoundException' || name === 'ResourceNotFoundException') return null;
      throw err;
    }) as { MediaPipeline?: { MediaCapturePipeline?: { SinkArn?: string }; MediaConcatenationPipeline?: { Sinks?: Array<{ S3BucketSinkConfiguration?: { Destination?: string } }> } } } | null;
    const place = placeOfSink(got?.MediaPipeline?.MediaCapturePipeline?.SinkArn ?? got?.MediaPipeline?.MediaConcatenationPipeline?.Sinks?.[0]?.S3BucketSinkConfiguration?.Destination);
    if (!place) return 'not a pipeline of the recording family';
    conversationId = place.conversationId;
    meetingId = place.meetingId;
  }
  const parts = await recordingsOf(`${appInstanceArn()}/channel/${conversationId}`, meetingId);
  const part = parts.find((p) => p.capture === id || p.concatenation === id);
  if (!part) return 'not a recording of this deployment';
  const m = meetingOf(conversationId, meetingId, part.classification);
  const place: RecordingPlace = { classification: part.classification, conversationId, meetingId, partId: part.partId };

  if (part.capture === id) {
    // A CAPTURE THAT STOPPED ON ITS OWN (the meeting ended) OR FAILED is joined from what it captured, once; a part a stop
    // moved to processing and did not join yet is joined here (`resumable`), as the same pipeline.
    if (part.state !== 'capturing' && !resumable(part)) return 'already concatenating';
    return `capture ${await concatenatePart(m, part as { partId: string } & RecordingPart)}`;
  }
  if (type === 'chime:MediaPipelinePermanentFailure') return (await failPart(m, part.partId, 'concatenation')) ? 'failed' : 'already finished';
  // A CONCATENATION THAT FINISHED: ready where its file is there, failed where it is not.
  if (part.state !== 'processing') return 'already finished';
  const key = await writtenRecording(place);
  if (key) return (await partReady(m, place, key)) ? 'ready' : 'already finished';
  return (await failPart(m, part.partId, 'concatenation', 'NoRecordingWritten')) ? 'failed' : 'already finished';
}

/** A recording's composited file was written: its part is ready. */
async function onObjectCreated(detail: ObjectCreatedDetail): Promise<string> {
  if (!bucket() || detail.bucket?.name !== bucket()) return 'not the conversation store';
  const key = parseRecordingKey(detail.object?.key);
  if (!key) return 'not a recording';
  const parts = await recordingsOf(`${appInstanceArn()}/channel/${key.conversationId}`, key.meetingId);
  const part = parts.find((p) => p.partId === key.partId && p.classification === key.classification);
  if (!part) return 'not a recording of this deployment';
  const { pipelineId: _pipeline, ...place } = key;
  return (await partReady(meetingOf(key.conversationId, key.meetingId, part.classification), place, detail.object?.key as string)) ? 'ready' : 'already finished';
}

/** The rules' target. */
export async function handler(event: EventBridgeEvent<string, PipelineEventDetail & ObjectCreatedDetail>): Promise<{ outcome: string }> {
  if (!appInstanceArn()) return { outcome: 'not configured' };
  const outcome = event.source === 'aws.s3' ? await onObjectCreated(event.detail ?? {}) : await onPipelineEvent(event.detail ?? {});
  console.log(`${LOG} ${event.source} event`, { outcome });
  return { outcome };
}
