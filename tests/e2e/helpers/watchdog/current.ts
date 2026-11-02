/**
 * THE TEST THE WATCHDOG IS WATCHING NOW, for helpers that report progress or name a conversation.
 *
 * Held apart from the fixture so a helper (`pollFor`, the wire waits) can report to the watchdog without
 * importing Playwright's test object, and so it is a no-op when a helper runs outside a watched test.
 */
import type { Pattern, SignalSource } from './logic';

/** What a helper or a spec may tell the watchdog about the current test. */
export interface WatchHandle {
  /** Something happened: resets the stall window. */
  signal(source: SignalSource, detail: string): void;
  /** A conversation (channel id or ARN) or correlation id this test drives: backend lines carrying it count as progress. */
  track(idOrArn: string): void;
  /** Silence is expected until `dueAt` (epoch ms) plus the margin: the test waits on a timer. */
  declareWait(reason: string, dueAt: number): void;
  /** A backend error line this test causes on purpose. */
  allowBackendError(pattern: Pattern): void;
}

let current: WatchHandle | null = null;

export function setCurrentWatch(w: WatchHandle | null): void {
  current = w;
}

export function currentWatch(): WatchHandle | null {
  return current;
}

/** Report progress from a helper: a read whose answer changed, a message that arrived. */
export function noteProgress(source: SignalSource, detail: string): void {
  current?.signal(source, detail);
}

/** Name a conversation the current test drives, so its backend log lines count as progress. */
export function trackConversation(idOrArn: string): void {
  if (idOrArn) current?.track(idOrArn);
}

/**
 * The backend errors the current spec file declared, for its per-file CloudWatch sweep
 * (`guardBackendErrors`), which runs after the tests that declared them have ended.
 */
export const declaredBackendErrors: Pattern[] = [];
