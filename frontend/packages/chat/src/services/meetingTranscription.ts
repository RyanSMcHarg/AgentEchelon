/**
 * A MEETING'S LIVE TRANSCRIPTION, AS THIS APP TAKES PART IN IT (SPEC-ASSISTANT-MEETINGS FR28):
 *  - the service's transcript arrives on the meeting's data channel (`transcriptionController.subscribeToTranscriptEvent`);
 *    its status says whether the meeting is transcribed now, which the room shows to everyone in it;
 *  - this app reports the final lines the service attributes to ITS OWN attendee, in small batches, so each person's
 *    words are sent by their own app and the server keeps only those (`meeting-api.ts` `transcript`);
 *  - a spoken notice (the Web Speech API) tells the person they are being transcribed
 *    when they join a transcribed meeting and when transcription starts or stops while they are in it.
 */
import { Transcript, TranscriptItemType, TranscriptionStatus, TranscriptionStatusType, type TranscriptEvent } from 'amazon-chime-sdk-js';

/** One final line this person said, as the service timed and identified it. */
export interface OwnSegment {
  resultId: string;
  attendeeId: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** One live caption line: who is speaking (their person id) and what they are saying, final or still forming. */
export interface CaptionLine {
  resultId: string;
  personId: string;
  text: string;
  partial: boolean;
}

/**
 * WHAT ONE TRANSCRIPT EVENT SAYS: the status it carries, every speaker's caption lines (partial lines included
 * so captions are live), and this person's own final lines in it.
 */
export function readTranscriptEvent(event: TranscriptEvent, selfAttendeeId: string): { transcribing?: boolean; own: OwnSegment[]; captions: CaptionLine[] } {
  if (event instanceof TranscriptionStatus) {
    if (event.type === TranscriptionStatusType.STARTED || event.type === TranscriptionStatusType.RESUMED) return { transcribing: true, own: [], captions: [] };
    if (event.type === TranscriptionStatusType.STOPPED || event.type === TranscriptionStatusType.FAILED) return { transcribing: false, own: [], captions: [] };
    return { own: [], captions: [] };
  }
  if (!(event instanceof Transcript)) return { own: [], captions: [] };
  const own: OwnSegment[] = [];
  const captions: CaptionLine[] = [];
  for (const result of event.results ?? []) {
    const alternative = result.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    const first = alternative?.items?.find((i) => i.type === TranscriptItemType.PRONUNCIATION);
    if (!text || !first) continue;
    captions.push({ resultId: result.resultId, personId: first.attendee?.externalUserId ?? '', text, partial: !!result.isPartial });
    if (result.isPartial || first.attendee?.attendeeId !== selfAttendeeId) continue;
    own.push({ resultId: result.resultId, attendeeId: selfAttendeeId, text, startMs: result.startTimeMs, endMs: result.endTimeMs });
  }
  return { own, captions };
}

/** How many caption lines the room shows at once: the newest. */
export const CAPTION_LINES = 3;

/** The caption lines after an event's: a line still forming is replaced as it grows, and the newest few are kept. */
export function nextCaptions(shown: readonly CaptionLine[], incoming: readonly CaptionLine[]): CaptionLine[] {
  let out = [...shown];
  for (const line of incoming) {
    const at = out.findIndex((l) => l.resultId === line.resultId);
    if (at >= 0) out[at] = line; else out.push(line);
  }
  if (out.length > CAPTION_LINES) out = out.slice(out.length - CAPTION_LINES);
  return out;
}

/**
 * THE MEETING'S TRANSCRIPTION MODE, SAID BY A HOST'S APP to everyone in the meeting on a data message,
 * read only from a sender the join answered as a host.
 */
export const TRANSCRIPTION_TOPIC = 'ae-meeting-transcription';

/** A mode message, read strictly: null for anything that is not one. */
export function transcriptionModeOf(text: string): { on: boolean; recording: boolean } | null {
  try {
    const m = JSON.parse(text) as { on?: unknown; recording?: unknown };
    return typeof m.on === 'boolean' && typeof m.recording === 'boolean' ? { on: m.on, recording: m.recording } : null;
  } catch {
    return null;
  }
}

/** The most lines one report carries (the server's `MAX_SEGMENTS_PER_REPORT`). */
export const SEGMENTS_PER_REPORT = 25;
/** How long a line waits for others to go with it. */
export const REPORT_AFTER_MS = 8000;

export interface TranscriptReporter {
  add: (segments: readonly OwnSegment[]) => void;
  /** Send whatever is waiting, now: on leaving, so the person's last words are kept. */
  flush: () => void;
}

/**
 * THE DELAYS BEFORE A BATCH IS SENT AGAIN after a send that never got an answer, or got a server error or throttling. They
 * add up to under the server's late-lines window (30 seconds), so a line sent again is still taken.
 */
export const REPORT_RETRY_DELAYS_MS = [1000, 3000, 7000, 12000];

/**
 * A send the server refused outright: any 4xx but throttling, and a 429 that names its reason (`TRANSCRIPT_SHARE_SPENT`),
 * which no later send changes.
 */
function refused(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500) return false;
  return status !== 429 || typeof code === 'string';
}

/**
 * BATCHES THIS PERSON'S LINES and sends each batch: a full batch at once, else a few seconds after its first line. A batch
 * the server refused is dropped; one that met no answer, a server error or throttling is sent again after each of
 * `REPORT_RETRY_DELAYS_MS` in turn, since the server keeps each line once whatever number of times it arrives.
 */
export function createTranscriptReporter(send: (segments: OwnSegment[]) => Promise<unknown>): TranscriptReporter {
  let waiting: OwnSegment[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sendWithRetry = (batch: OwnSegment[], attempt = 0): void => {
    send(batch).catch((error: unknown) => {
      if (refused(error) || attempt >= REPORT_RETRY_DELAYS_MS.length) return;
      setTimeout(() => sendWithRetry(batch, attempt + 1), REPORT_RETRY_DELAYS_MS[attempt]);
    });
  };
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    while (waiting.length) {
      const batch = waiting.slice(0, SEGMENTS_PER_REPORT);
      waiting = waiting.slice(SEGMENTS_PER_REPORT);
      sendWithRetry(batch);
    }
  };
  return {
    add: (segments) => {
      if (!segments.length) return;
      waiting.push(...segments);
      if (waiting.length >= SEGMENTS_PER_REPORT) flush();
      else if (!timer) timer = setTimeout(flush, REPORT_AFTER_MS);
    },
    flush,
  };
}

/**
 * WHEN THE MEETING WAS RECORDED, as this app learned it: each span from recording on to recording off. A line is kept by
 * whether the meeting was recorded when it was SPOKEN (its start), never by when the service finished it, so speech made
 * under captions alone is not kept and the sentence being finished as recording stops is.
 */
export interface RecordingTimeline {
  /** The recording mode from `at` (ms since the epoch) on. */
  set: (recording: boolean, at?: number) => void;
  /** Whether the meeting was recorded at `ms`. */
  recordedAt: (ms: number) => boolean;
  /** Recorded now. */
  now: () => boolean;
  /** Forget every span: a new meeting entry. */
  reset: () => void;
}

/**
 * HOW FAR BEFORE A RECORDING'S START A LINE STILL COUNTS AS RECORDED: the server's own allowance (`recordedFrom` less two
 * seconds), so the clock difference between this device and the service never drops a line the server would keep.
 */
export const RECORDED_FROM_GRACE_MS = 2000;

export function createRecordingTimeline(clock: () => number = Date.now): RecordingTimeline {
  let spans: Array<{ from: number; to?: number }> = [];
  const open = () => spans.length > 0 && spans[spans.length - 1].to === undefined;
  return {
    set: (recording, at = clock()) => {
      if (recording && !open()) spans.push({ from: at });
      else if (!recording && open()) spans[spans.length - 1].to = at;
    },
    recordedAt: (ms) => spans.some((s) => ms >= s.from - RECORDED_FROM_GRACE_MS && (s.to === undefined || ms < s.to)),
    now: open,
    reset: () => { spans = []; },
  };
}

/** The person's microphone in the live session, as a spoken notice holds it. */
export interface NoticeMic {
  /** The person's own state: muted by them or held by a host, apart from any notice. */
  personMuted: () => boolean;
  mute: () => void;
  unmute: () => void;
}

/** The microphone held for the notices being said now. */
export interface NoticeMicHold {
  /** Hold the microphone for one notice; the function returned releases that hold, once, however often it is called. */
  hold: () => () => void;
  /** Whether a notice holds the microphone now. */
  held: () => boolean;
}

/**
 * A SPOKEN NOTICE NEVER ENTERS THE MEETING'S AUDIO. The browser plays speech synthesis outside the session's echo
 * cancellation, so an open microphone would carry it to everyone and into this person's transcript. While any notice is
 * said the session's microphone is muted; when the last one ends it returns to the person's own state at that moment:
 * muted if they were muted (or muted themselves, or a host held them, meanwhile), open if they were not.
 *
 * The microphone is read when the hold ends, so a session rebuilt while a notice plays is the one given back; the session
 * mutes a microphone it brings up while `held()`. `onChange` hears the hold begin and end, after the microphone has been
 * returned, so the person is shown that it is held and what they pressed meanwhile is reported.
 */
export function createNoticeMicHold(micOf: () => NoticeMic | null, onChange?: (held: boolean) => void): NoticeMicHold {
  let holds = 0;
  return {
    held: () => holds > 0,
    hold: () => {
      holds += 1;
      const mic = micOf();
      if (holds === 1) {
        if (mic && !mic.personMuted()) mic.mute();
        onChange?.(true);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds > 0) return;
        const now = micOf();
        if (now && !now.personMuted()) now.unmute();
        onChange?.(false);
      };
    },
  };
}

/** How long a notice takes to say, by its length: speech at the rate `announce` sets runs near 13 characters a second. */
const SPEECH_MS_PER_CHARACTER = 75;
/** The margin past a notice's expected length before its hold ends regardless. */
const NOTICE_HOLD_MARGIN_MS = 2500;

/**
 * The longest a notice holds the microphone: the time it takes to say, and a short margin. A browser that never reports
 * the end of the speech gives the microphone back then.
 */
export function noticeHoldLimitMs(text: string): number {
  return NOTICE_HOLD_MARGIN_MS + text.length * SPEECH_MS_PER_CHARACTER;
}

/**
 * SAY A NOTICE ALOUD, in the reader's language as the caller wrote
 * it. A browser without speech synthesis says nothing aloud; the room's written notice stands either way.
 *
 * `holdMic` holds the meeting's microphone for as long as the notice is said: released when the speech ends, fails or is
 * cancelled, when speaking throws, and at the latest after `noticeHoldLimitMs`, so every hold ends. A notice still being
 * said at that limit is cut short before the microphone opens, so none of it is picked up.
 */
export function announce(text: string, lang?: string, holdMic?: () => () => void): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return;
  let release: (() => void) | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    if (limit) { clearTimeout(limit); limit = undefined; }
    const r = release;
    release = undefined;
    r?.();
  };
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.volume = 0.8;
    if (lang) utterance.lang = lang;
    utterance.onend = done;
    utterance.onerror = done;
    release = holdMic?.();
    if (release) {
      limit = setTimeout(() => {
        try { window.speechSynthesis.cancel?.(); } catch { /* nothing is being said */ }
        done();
      }, noticeHoldLimitMs(text));
    }
    window.speechSynthesis.speak(utterance);
  } catch {
    // The written notice stands, and the microphone is the person's again.
    done();
  }
}
