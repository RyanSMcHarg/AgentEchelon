/**
 * SHARING A SCREEN FROM THE MEETING WINDOW (SPEC-ASSISTANT-MEETINGS, the meeting window's share control).
 *
 * The browser's picker chooses what is shared: a tab, a window or the whole screen, and, where the browser offers it,
 * the sound playing there ("share tab audio", "share system audio"). This module guarantees:
 *  - THE MEETING WINDOW KEEPS THE FOCUS. Where the browser supports `CaptureController`, the shared tab or window is not
 *    brought forward, so the person stays in the meeting they shared from.
 *  - THE MEETING WINDOW ITSELF IS NOT OFFERED, so a share never mirrors the meeting back into itself or its own audio.
 *  - A PICKER THE PERSON CANCELLED changes nothing: no share starts, nothing is torn down, and no failure is said.
 *  - A SHARE THE PLATFORM REFUSED is said (`failed`, "Screen sharing did not start"): the page's permissions policy
 *    forbids capture, the operating system or the browser denied it, or the refusal came before any picker could be
 *    answered. The browser names both a person's cancel and a refusal `NotAllowedError`, so the error's name alone
 *    never decides it.
 *  - A share the session cannot start releases what the picker captured.
 */

/** What is shared, as the browser reports the surface the person picked. */
export type ShareSurface = 'browser' | 'window' | 'monitor' | 'unknown';

/** A share that started: what it shows and whether it carries that surface's sound. */
export interface ShareStarted {
  surface: ShareSurface;
  audio: boolean;
}

export type ShareOutcome =
  | { kind: 'started'; share: ShareStarted }
  | { kind: 'cancelled' }
  | { kind: 'failed' };

/** The part of the session a share needs. */
export interface ShareSession {
  startContentShare: (stream: MediaStream) => Promise<unknown>;
}

/** The part of `navigator.mediaDevices` a share needs. */
export interface DisplayMedia {
  getDisplayMedia: (options?: DisplayMediaStreamOptions) => Promise<MediaStream>;
}

interface FocusController {
  setFocusBehavior?: (behavior: 'focus-capturing-application' | 'focus-captured-surface' | 'no-focus-change') => void;
}

/** A browser's `CaptureController`, where it has one. */
function newCaptureController(): FocusController | undefined {
  const Ctor = (globalThis as { CaptureController?: new () => FocusController }).CaptureController;
  try { return Ctor ? new Ctor() : undefined; } catch { return undefined; }
}

/**
 * The shortest time in which a person can answer the browser's picker. A `NotAllowedError` sooner than this was given
 * before any picker could be answered: the platform refused it.
 */
export const PICKER_ANSWER_MIN_MS = 250;

/** The browser's own words for a refusal that is not the person's: the system, a policy, or an insecure context. */
const PLATFORM_REFUSAL = /system|polic|secure/i;

/**
 * The person chose not to share: they dismissed the picker (`NotAllowedError` after time to answer it, in the browser's
 * words for a person's denial), or the picker was aborted. Anything else is a refusal or a failure.
 */
function isCancel(e: unknown, elapsedMs: number): boolean {
  const err = e as { name?: string; message?: string } | undefined;
  if (err?.name === 'AbortError') return true;
  if (err?.name !== 'NotAllowedError') return false;
  return elapsedMs >= PICKER_ANSWER_MIN_MS && !PLATFORM_REFUSAL.test(err.message ?? '');
}

/** Whether the page's permissions policy forbids capturing a display: false where the browser cannot say. */
function policyForbidsCapture(): boolean {
  const doc = (typeof document !== 'undefined' ? document : undefined) as
    | { permissionsPolicy?: { allowsFeature?: (f: string) => boolean }; featurePolicy?: { allowsFeature?: (f: string) => boolean } }
    | undefined;
  const policy = doc?.permissionsPolicy ?? doc?.featurePolicy;
  try { return policy?.allowsFeature?.('display-capture') === false; } catch { return false; }
}

function surfaceOf(stream: MediaStream): ShareSurface {
  const settings = stream.getVideoTracks()[0]?.getSettings?.() as { displaySurface?: string } | undefined;
  const s = settings?.displaySurface;
  return s === 'browser' || s === 'window' || s === 'monitor' ? s : 'unknown';
}

/** Ask the browser what to share and share it into the meeting. */
export async function startScreenShare(
  session: ShareSession,
  media: DisplayMedia | undefined = navigator.mediaDevices,
  current: () => boolean = () => true,
  now: () => number = () => performance.now(),
): Promise<ShareOutcome> {
  if (!media?.getDisplayMedia || policyForbidsCapture()) return { kind: 'failed' };
  const controller = newCaptureController();
  let stream: MediaStream;
  const asked = now();
  try {
    stream = await media.getDisplayMedia({
      video: true,
      audio: true,
      // Options the platform's own types do not all name yet; each browser ignores what it does not know.
      ...({ systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', ...(controller ? { controller } : {}) } as object),
    });
  } catch (e) {
    return isCancel(e, now() - asked) ? { kind: 'cancelled' } : { kind: 'failed' };
  }
  // THE SESSION THE PICKER WAS OPENED FOR IS THE ONE SHARED INTO: a pick answered after that session has gone (the person
  // left, or a rejoin rebuilt it) is let go at once, so no screen stays captured for a session nobody holds.
  if (!current()) {
    stream.getTracks().forEach((track) => { try { track.stop(); } catch { /* already ended */ } });
    return { kind: 'cancelled' };
  }
  // Called as the picker answers, which is when the browser accepts it.
  try { controller?.setFocusBehavior?.('focus-capturing-application'); } catch { /* the browser decides the focus */ }
  try {
    await session.startContentShare(stream);
  } catch {
    stream.getTracks().forEach((track) => { try { track.stop(); } catch { /* already ended */ } });
    return { kind: 'failed' };
  }
  return { kind: 'started', share: { surface: surfaceOf(stream), audio: stream.getAudioTracks().length > 0 } };
}
