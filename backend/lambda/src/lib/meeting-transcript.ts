/**
 * A MEETING'S TRANSCRIPT (SPEC-ASSISTANT-MEETINGS FR28): the meeting is transcribed by Amazon Chime SDK live
 * transcription (`StartMeetingTranscription`), each attendee's app receives the transcript on the meeting's data channel
 * (`transcriptionController.subscribeToTranscriptEvent`) and sends what it heard to the meetings function
 * (`POST /meetings/transcript`), and the platform writes the whole transcript once the meeting has ended.
 *
 * EACH APP REPORTS ITS OWN PERSON'S SPEECH ONLY. A segment is kept only where the service attributes it to the reporting
 * attendee, and that attendee is proven the caller's (`GetAttendee`, its `ExternalUserId` is the caller's AppInstanceUser
 * id), so every line of a transcript is attributed to the person whose app heard themself say it, and no member can put
 * words in another's mouth.
 *
 * THE TRANSCRIPT IS THE MEETING CONVERSATION'S ARTIFACT, in the conversation store's own family for it (tenet D15):
 * `transcripts/<classification>/<conversationId>/<meetingId>.md`, its segments beneath it. The family is written by the
 * platform alone, so no key in it can be read as a member's upload; the classification is in the key, so a reader's grant
 * comes from the conversation's classification; and its expiry is the conversation's own (`MAX_CONVERSATION_TTL_DAYS`),
 * so a transcript lives as long as the meeting's conversation and no longer.
 *
 * IT IS THE MEETING'S SPEECH AND NOTHING ELSE. A report carries speech segments only (`SEGMENT_FIELDS`), and an item that
 * carries anything else, a chat message's id or a message's target among them, is not kept. No chat message of the
 * meeting's conversation, and never a targeted one, is written to a transcript or read into its summary.
 */
import { conversationIdOf } from './dashboard-keys.js';

/** The family every transcript and its segments are written under. */
export const TRANSCRIPTS_FAMILY = 'transcripts/';

const CLASSIFICATION = /^[a-z0-9-]{1,64}$/;
const CONVERSATION = /^[A-Za-z0-9_-]{1,128}$/;
const MEETING = /^[A-Za-z0-9-]{1,64}$/;
const RESULT = /^[A-Za-z0-9_-]{1,128}$/;

/** One classification's transcripts: the prefix a write, a read and a listing are each scoped to. */
export const transcriptPrefix = (classification: string): string => `${TRANSCRIPTS_FAMILY}${classification}/`;

/** A conversation's transcripts. */
export const conversationTranscriptsPrefix = (classification: string, conversationId: string): string =>
  `${transcriptPrefix(classification)}${conversationId}/`;

/** The transcript of one meeting, written once it has ended. */
export const transcriptKey = (classification: string, conversationId: string, meetingId: string): string =>
  `${conversationTranscriptsPrefix(classification, conversationId)}${meetingId}.md`;

/** Where the segments of one meeting are kept while it runs. */
export const segmentsPrefix = (classification: string, conversationId: string, meetingId: string): string =>
  `${conversationTranscriptsPrefix(classification, conversationId)}${meetingId}/segments/`;

/**
 * One segment's key: ordered by when it was spoken, then the SPEAKER, then the service's result id. The speaker is the
 * person the meetings function proved reported it, so a segment's key is its speaker's alone: one result the service
 * shares between two speakers is two segments, and no report can name the key of another person's line. A report sent
 * twice is one object.
 */
export const segmentKey = (classification: string, conversationId: string, meetingId: string, s: Pick<TranscriptSegment, 'startMs' | 'resultId' | 'personId'>): string =>
  `${segmentsPrefix(classification, conversationId, meetingId)}${String(Math.floor(s.startMs)).padStart(13, '0')}-${encodeURIComponent(s.personId)}-${s.resultId}.json`;

/** The parts of a transcript's key, or null for any key that is not one. */
export function parseTranscriptKey(key: unknown): { classification: string; conversationId: string; meetingId: string } | null {
  if (typeof key !== 'string' || key.length > 400) return null;
  const m = /^transcripts\/([^/]+)\/([^/]+)\/([^/]+)\.md$/.exec(key);
  if (!m || !CLASSIFICATION.test(m[1]) || !CONVERSATION.test(m[2]) || !MEETING.test(m[3])) return null;
  return { classification: m[1], conversationId: m[2], meetingId: m[3] };
}

/** The link the chat app opens a transcript from (`?transcript=<key>`), read by the attachment download path. */
export const transcriptLink = (key: string): string => `?transcript=${encodeURIComponent(key)}`;

/**
 * THE LIVE TRANSCRIPTION SETTINGS: Amazon Transcribe, United States English, with partial results stabilized at high
 * stability so a line an app reports is the one every app saw.
 */
export const MEETING_TRANSCRIPTION_CONFIGURATION = {
  EngineTranscribeSettings: {
    LanguageCode: 'en-US',
    EnablePartialResultsStabilization: true,
    PartialResultsStability: 'high',
  },
} as const;

/** Whether this deployment transcribes its meetings from their start (`meetingTranscription` in the deploy config). */
export const meetingTranscriptionEnabled = (raw: string | undefined = process.env.MEETING_TRANSCRIPTION): boolean => raw === 'true';

/**
 * Whether a meeting transcribed from its start is in RECORDING mode (`meetingRecording`): captions, the stored transcript
 * and the summary. Recording is the default mode, so only an explicit `false` starts in captions-only mode.
 */
export const meetingRecordingByDefault = (raw: string | undefined = process.env.MEETING_RECORDING): boolean => raw !== 'false';

/** One line of a transcript: what one person said, when, by the service's result id. */
export interface TranscriptSegment {
  resultId: string;
  /** The speaker's AppInstanceUser id: the attendee's `ExternalUserId`. */
  personId: string;
  /** When it was spoken, in milliseconds, as the service times its results. */
  startMs: number;
  endMs: number;
  text: string;
}

/** The most segments one report carries, and the longest one line. */
export const MAX_SEGMENTS_PER_REPORT = 25;
export const MAX_SEGMENT_CHARS = 2000;

/** The fields a reported segment carries: one final result of the service's speech, and nothing else. */
export const SEGMENT_FIELDS: ReadonlySet<string> = new Set(['resultId', 'attendeeId', 'text', 'startMs', 'endMs']);

/** How far a line's time may sit outside its recording's window, for the service's clock and this function's. */
export const TRANSCRIPT_CLOCK_SKEW_MS = 2_000;

/**
 * THE SEGMENTS AN APP REPORTED, read strictly. Only final results the service attributed to the reporting attendee are
 * kept, each carrying the speech fields alone and spoken inside `window` (epoch milliseconds, both ends included): the
 * rest are counted as skipped. A report that is not a list, or is longer than one report carries, is refused.
 */
export function readReportedSegments(
  raw: unknown, reporter: { attendeeId: string; personId: string }, window?: { fromMs: number; untilMs: number },
): { segments: TranscriptSegment[]; skipped: number } | { refused: 'INVALID_SEGMENTS' } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEGMENTS_PER_REPORT) return { refused: 'INVALID_SEGMENTS' };
  const segments: TranscriptSegment[] = [];
  let skipped = 0;
  for (const item of raw) {
    const r = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : '';
    const startMs = Number(r.startMs);
    const endMs = Number(r.endMs);
    const ok = Object.keys(r).every((k) => SEGMENT_FIELDS.has(k))
      && (!window || (startMs >= window.fromMs && startMs <= window.untilMs))
      && r.attendeeId === reporter.attendeeId
      && typeof r.resultId === 'string' && RESULT.test(r.resultId)
      && text.length > 0 && text.length <= MAX_SEGMENT_CHARS
      && Number.isFinite(startMs) && startMs >= 0 && Number.isFinite(endMs) && endMs >= startMs;
    if (!ok) { skipped++; continue; }
    segments.push({ resultId: r.resultId as string, personId: reporter.personId, startMs, endMs, text });
  }
  return { segments, skipped };
}

/** A segment as stored, read strictly; null for anything else. */
export function readStoredSegment(raw: unknown): TranscriptSegment | null {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (typeof r.resultId !== 'string' || typeof r.personId !== 'string' || typeof r.text !== 'string') return null;
  const startMs = Number(r.startMs);
  const endMs = Number(r.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return { resultId: r.resultId, personId: r.personId, startMs, endMs, text: r.text };
}

/** `m:ss`, or `h:mm:ss` past an hour, from milliseconds. */
export function transcriptClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * A MEETING'S LINES IN THE ORDER SPOKEN: by when each was spoken, then the service's result id, then the speaker. A result
 * delivered twice to one speaker is one line; the same result heard from two speakers is a line for each.
 */
export function orderedSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const seen = new Set<string>();
  return [...segments].sort((a, b) => a.startMs - b.startMs || a.resultId.localeCompare(b.resultId) || a.personId.localeCompare(b.personId))
    .filter((s) => { const k = `${s.personId}\n${s.resultId}`; return seen.has(k) ? false : (seen.add(k), true); });
}

/**
 * THE TRANSCRIPT, as Markdown: one line per segment, in the order spoken, each its time from the first line, the speaker by the name the
 * room shows them under (`nameOf`), and what they said. A result the service delivered twice to one speaker is one line;
 * the same result heard from two speakers is a line for each. It carries no wording of the platform's own, so it reads
 * the same in every language the meeting was held in.
 */
export function composeTranscript(segments: readonly TranscriptSegment[], nameOf: (personId: string) => string): string {
  const ordered = orderedSegments(segments);
  const origin = ordered[0]?.startMs ?? 0;
  return ordered.map((s) => `[${transcriptClock(s.startMs - origin)}] **${nameOf(s.personId).replace(/[*_`[\]]/g, '')}**: ${s.text}`).join('\n\n') + (ordered.length ? '\n' : '');
}

/** The most of a transcript one turn reads as grounding: its end, where a meeting's decisions are. */
export const TRANSCRIPT_CONTEXT_CHARS = 24_000;

/** The S3 calls a transcript read makes, structurally, so a test passes its own. */
export interface TranscriptS3 {
  send(command: unknown): Promise<unknown>;
}

/**
 * THE LATEST TRANSCRIPT OF A CONVERSATION'S MEETINGS, as grounding for a turn that may read that conversation (a room's
 * `thread` child, DESIGN-WORKFLOWS-AND-TASKS section 6, rule 5, checked by the caller): the newest transcript under the
 * conversation's own key in its classification's family, its last `TRANSCRIPT_CONTEXT_CHARS`. Null where it has none or
 * it cannot be read. Never throws.
 */
export async function latestTranscriptOf(
  s3: TranscriptS3, bucket: string, classification: string, channelArn: string,
  commands: { list: (input: Record<string, unknown>) => unknown; get: (input: Record<string, unknown>) => unknown },
): Promise<string | null> {
  const conversationId = conversationIdOf(channelArn);
  if (!bucket || !CLASSIFICATION.test(classification) || !CONVERSATION.test(conversationId)) return null;
  try {
    const listed = await s3.send(commands.list({ Bucket: bucket, Prefix: conversationTranscriptsPrefix(classification, conversationId), Delimiter: '/' })) as
      { Contents?: Array<{ Key?: string; LastModified?: Date }> };
    const newest = (listed.Contents ?? []).filter((o) => o.Key && parseTranscriptKey(o.Key))
      .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))[0];
    if (!newest?.Key) return null;
    const out = await s3.send(commands.get({ Bucket: bucket, Key: newest.Key })) as { Body?: { transformToString(): Promise<string> } };
    const text = (await out.Body?.transformToString())?.trim() ?? '';
    return text ? text.slice(-TRANSCRIPT_CONTEXT_CHARS) : null;
  } catch (err) {
    console.warn('[meeting-transcript] a transcript could not be read as grounding', { err: (err as Error).name });
    return null;
  }
}
