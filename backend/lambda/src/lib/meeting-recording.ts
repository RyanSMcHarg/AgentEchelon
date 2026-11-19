/**
 * A MEETING'S AUDIO AND VIDEO RECORDING (SPEC-ASSISTANT-MEETINGS FR70, owner decision 2026-11-12): its keys, its settings,
 * its record on the meeting's conversation and the ended card's recording items. Pure: no client.
 *
 * ONE SWITCH. Recording mode (`recording`, `meeting-transcription.ts`) keeps the transcript and the
 * summary, and where the deployment records media (`meetingMediaRecording`) it also captures the meeting's audio and
 * video with an Amazon Chime SDK media capture pipeline. Each stretch of recording is a PART: a capture pipeline from
 * recording on to recording off (or the meeting's end), then a media concatenation pipeline that joins the capture's
 * 5-second chunks into one composited audio and video file (Amazon Chime SDK Developer Guide, "Creating media capture
 * pipelines" and "Creating media concatenation pipelines").
 *
 * THE RECORDING IS THE MEETING CONVERSATION'S ARTIFACT, in the conversation store's own family for it (tenet D15), beside
 * the transcript family and shaped like it:
 *   recordings/<classification>/<conversationId>/<meetingId>/<partId>/capture/...                    the capture's chunks
 *   recordings/<classification>/<conversationId>/<meetingId>/<partId>/media/composited-video/<id>.mp4  the recording
 * The family is written by the media pipelines service alone, under a bucket policy that names this family and nothing
 * else (`meeting-recordings.ts`), so no key in it can be read as a member's upload; the classification is in the key, so
 * a reader's grant comes from the conversation's classification; and its expiry is the conversation's own
 * (`MAX_CONVERSATION_TTL_DAYS`).
 */

/** The family every recording and its capture chunks are written under. */
export const RECORDINGS_FAMILY = 'recordings/';

const CLASSIFICATION = /^[a-z0-9-]{1,64}$/;
const CONVERSATION = /^[A-Za-z0-9_-]{1,128}$/;
const MEETING = /^[A-Za-z0-9-]{1,64}$/;
const PART = /^[A-Za-z0-9-]{1,64}$/;
const PIPELINE = /^[A-Za-z0-9-]{1,64}$/;

/** Where one recording part lives. */
export interface RecordingPlace { classification: string; conversationId: string; meetingId: string; partId: string }

/** One part's prefix: its capture and its recording are both beneath it. */
export const recordingPartPrefix = (p: RecordingPlace): string =>
  `${RECORDINGS_FAMILY}${p.classification}/${p.conversationId}/${p.meetingId}/${p.partId}/`;

/** Where the capture pipeline writes the part's chunks. */
export const capturePrefix = (p: RecordingPlace): string => `${recordingPartPrefix(p)}capture`;

/** Where the concatenation pipeline writes the part's joined files. */
export const mediaPrefix = (p: RecordingPlace): string => `${recordingPartPrefix(p)}media`;

/** The S3 ARN a pipeline's sink names: the conversation store's bucket and the prefix, in the app instance's partition. */
export const sinkArn = (bucket: string, prefix: string, partition = 'aws'): string => `arn:${partition}:s3:::${bucket}/${prefix}`;

/** Whether a string is safe as one segment of a recording key. */
export const isRecordingPlace = (p: Partial<RecordingPlace>): p is RecordingPlace =>
  typeof p.classification === 'string' && CLASSIFICATION.test(p.classification)
  && typeof p.conversationId === 'string' && CONVERSATION.test(p.conversationId)
  && typeof p.meetingId === 'string' && MEETING.test(p.meetingId)
  && typeof p.partId === 'string' && PART.test(p.partId);

/**
 * THE PARTS OF A RECORDING'S KEY: the composited audio and video file a concatenation wrote
 * (`.../<partId>/media/composited-video/<pipelineId>.mp4`), or null for any other key.
 */
export function parseRecordingKey(key: unknown): (RecordingPlace & { pipelineId: string }) | null {
  if (typeof key !== 'string' || key.length > 512) return null;
  const m = /^recordings\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/media\/composited-video\/([^/]+)\.mp4$/.exec(key);
  if (!m) return null;
  const place = { classification: m[1], conversationId: m[2], meetingId: m[3], partId: m[4] };
  return isRecordingPlace(place) && PIPELINE.test(m[5]) ? { ...place, pipelineId: m[5] } : null;
}

/** The link the chat app opens a recording from (`?recording=<key>`), read by the attachment download path. */
export const recordingLink = (key: string): string => `?recording=${encodeURIComponent(key)}`;

/** Whether this deployment captures its recorded meetings' audio and video (`meetingMediaRecording` in the deploy config). */
export const meetingMediaRecordingEnabled = (raw: string | undefined = process.env.MEETING_MEDIA_RECORDING): boolean => raw === 'true';

/**
 * THE CAPTURE'S ARTIFACTS, by the guide's compositing settings ("Compositing audio and video into a single view",
 * "Using the layout configurations for compositing"): the meeting's audio muxed into one composited video in the default
 * `GridView` layout at 1080p, switching to `ActiveSpeakerOnly` (the shared content full screen, the person speaking
 * overlaid in a corner) while someone shares their screen. Individual video and content streams are not captured: the
 * composited view already holds them, and each stream captured is billed on its own.
 */
export const CAPTURE_ARTIFACTS = {
  Audio: { MuxType: 'AudioWithCompositedVideo' },
  Video: { State: 'Disabled' },
  Content: { State: 'Disabled' },
  CompositedVideo: {
    Layout: 'GridView',
    Resolution: 'FHD',
    GridViewConfiguration: { ContentShareLayout: 'ActiveSpeakerOnly', ActiveSpeakerOnlyConfiguration: { ActiveSpeakerPosition: 'TopRight' } },
  },
} as const;

/**
 * THE CONCATENATION'S ARTIFACTS, by the guide's request ("Building an Amazon Chime SDK media concatenation pipeline"):
 * audio (which the service always concatenates) and the composited video, nothing else.
 */
export const CONCATENATION_ARTIFACTS = {
  Audio: { State: 'Enabled' },
  Video: { State: 'Disabled' },
  Content: { State: 'Disabled' },
  DataChannel: { State: 'Disabled' },
  TranscriptionMessages: { State: 'Disabled' },
  MeetingEvents: { State: 'Disabled' },
  CompositedVideo: { State: 'Enabled' },
} as const;

/** Where one recording part stands. */
export type RecordingPartState = 'capturing' | 'processing' | 'ready' | 'failed';

/** One part of a meeting's recording, as its conversation's record holds it (`lastMeeting.recordings[partId]`). */
export interface RecordingPart {
  /** The capture pipeline's id and ARN: the ARN is what a concatenation names as its source. */
  capture: string;
  captureArn: string;
  /** The meeting conversation's classification, the one its keys carry. */
  classification: string;
  startedAt: string;
  state: RecordingPartState;
  /** The concatenation pipeline's id, once one was created. */
  concatenation?: string;
  /** The composited audio and video file, once it was written. */
  key?: string;
  /** Why the part failed, by the step that failed. */
  failure?: 'capture' | 'concatenation';
  changedAt?: string;
}

/** A meeting's recording parts, by part id. */
export type MeetingRecordings = Record<string, RecordingPart>;

/** A part read strictly from the record; null for anything else. */
export function readRecordingPart(raw: unknown): RecordingPart | null {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (typeof r.capture !== 'string' || typeof r.captureArn !== 'string' || typeof r.startedAt !== 'string') return null;
  if (typeof r.classification !== 'string' || !CLASSIFICATION.test(r.classification)) return null;
  if (r.state !== 'capturing' && r.state !== 'processing' && r.state !== 'ready' && r.state !== 'failed') return null;
  return {
    capture: r.capture, captureArn: r.captureArn, classification: r.classification, startedAt: r.startedAt, state: r.state,
    ...(typeof r.concatenation === 'string' ? { concatenation: r.concatenation } : {}),
    ...(typeof r.key === 'string' && parseRecordingKey(r.key) ? { key: r.key } : {}),
    ...(r.failure === 'capture' || r.failure === 'concatenation' ? { failure: r.failure } : {}),
    ...(typeof r.changedAt === 'string' ? { changedAt: r.changedAt } : {}),
  };
}

/** The meeting's parts, in the order they were recorded. */
export function recordingPartsOf(recordings: unknown): Array<{ partId: string } & RecordingPart> {
  if (!recordings || typeof recordings !== 'object') return [];
  return Object.entries(recordings as Record<string, unknown>)
    .map(([partId, raw]) => { const p = readRecordingPart(raw); return p && PART.test(partId) ? { partId, ...p } : null; })
    .filter((p): p is { partId: string } & RecordingPart => p !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.partId.localeCompare(b.partId));
}

/** The part whose capture or concatenation pipeline is `pipelineId`. */
export function partOfPipeline(recordings: unknown, pipelineId: string): ({ partId: string; role: 'capture' | 'concatenation' } & RecordingPart) | null {
  for (const p of recordingPartsOf(recordings)) {
    if (p.capture === pipelineId) return { ...p, role: 'capture' };
    if (p.concatenation === pipelineId) return { ...p, role: 'concatenation' };
  }
  return null;
}

/** The status line templates the ended card says a recording's state in. */
export const RECORDING_STATUS_TEMPLATES = {
  processing: 'meeting-recording-processing',
  failed: 'meeting-recording-failed',
} as const;

/** The ended card's recording items (`meeting-ended`, `meeting-summary`). */
export interface RecordingCardValues {
  /** The one finished part's link, where the meeting has one. */
  recording_link?: string;
  /** Every finished part's link, numbered, where the meeting has more than one. */
  recording_parts?: string;
  /** Whether a part is still processing, or one failed, in the card speaker's wording. */
  recording_status?: string;
}

/**
 * THE ENDED CARD'S RECORDING ITEMS, from the meeting's record: the link to its recording (or to each part, numbered,
 * where recording was turned off and on again), and a status line while a part is still being joined or where one
 * failed, said in the template `say` renders. No item where the meeting was not recorded.
 */
export async function recordingCardValues(recordings: unknown, say: (template: string) => Promise<string>): Promise<RecordingCardValues> {
  const parts = recordingPartsOf(recordings);
  if (!parts.length) return {};
  const ready = parts.filter((p) => p.state === 'ready' && p.key);
  const out: RecordingCardValues = {};
  if (ready.length === 1) out.recording_link = recordingLink(ready[0].key as string);
  else if (ready.length > 1) out.recording_parts = ready.map((p, i) => `[${i + 1}](${recordingLink(p.key as string)})`).join(' · ');
  const status = parts.some((p) => p.state === 'capturing' || p.state === 'processing') ? 'processing'
    : parts.some((p) => p.state === 'failed') ? 'failed' : null;
  if (status) {
    const line = (await say(RECORDING_STATUS_TEMPLATES[status]).catch(() => '')).replace(/\s+/g, ' ').trim();
    if (line) out.recording_status = line;
  }
  return out;
}

/** The meeting events a recording files (`meeting_events`, source `platform`), so the console and analytics count them. */
export const RECORDING_EVENTS = {
  started: 'recordingStarted',
  stopped: 'recordingStopped',
  ready: 'recordingReady',
  failed: 'recordingFailed',
} as const;
