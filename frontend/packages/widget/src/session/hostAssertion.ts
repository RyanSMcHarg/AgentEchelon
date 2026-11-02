/**
 * THE WIDGET'S HALF OF THE HOST ASSERTION (A9).
 *
 * A host that already knows who the person is (a Salesforce org, through its Lightning component) signs
 * a short-lived assertion and posts it into the widget's frame. The server checks the assertion itself:
 * the pinned key, `aud`, `exp`, the `jti` spent once, the mapped permission set and a provisioned
 * subject (`backend/lambda/src/lib/host-assertion-exchange.ts`). What only the frame can check is who
 * posted it, so a posted message is accepted only when BOTH hold:
 *
 *  - `event.origin` is exactly one of the origins the registry's `host-assertion` entries declare
 *    (`allowedOrigins`), compared as a whole string, never as a prefix or a pattern;
 *  - `event.source` is this frame's own parent window, so another frame on a declared host's page, a
 *    popup, or this frame's own children cannot hand the widget an assertion.
 *
 * An accepted assertion is held in memory only, taken once, and sent once to the exchange. Nothing is
 * written to storage. When the session needs renewing, the widget asks the parent for a new one, and
 * only at the origin the accepted one came from.
 */

/** The message a host posts into the frame. */
export const ASSERTION_MESSAGE = 'ae:host-assertion';
/** The message the frame posts to its parent to ask for a fresh assertion. */
export const ASSERTION_REQUEST = 'ae:host-assertion-request';

export interface PostedAssertion {
  /** The host's signed JWT. */
  assertion: string;
  /** The conversation the host opened the widget on, when it names one. */
  conversationArn?: string;
}

export type AssertionCheck =
  | { ok: true; value: PostedAssertion; origin: string }
  | { ok: false; reason: 'origin' | 'source' | 'shape' };

/** Whether a posted message is an assertion this frame accepts, and why not when it is not. */
export function checkPostedAssertion(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  hosts: ReadonlySet<string>,
  parent: unknown,
): AssertionCheck {
  if (!event.origin || !hosts.has(event.origin)) return { ok: false, reason: 'origin' };
  // A frame with no parent (opened on its own) has nobody to accept an assertion from.
  if (!parent || event.source !== parent) return { ok: false, reason: 'source' };
  const d = event.data as { type?: unknown; assertion?: unknown; conversationArn?: unknown } | null;
  if (!d || d.type !== ASSERTION_MESSAGE || typeof d.assertion !== 'string' || !d.assertion || d.assertion.length > 8192) {
    return { ok: false, reason: 'shape' };
  }
  const conversationArn = typeof d.conversationArn === 'string' && d.conversationArn ? d.conversationArn : undefined;
  return { ok: true, value: { assertion: d.assertion, ...(conversationArn ? { conversationArn } : {}) }, origin: event.origin };
}

/** The window surface the inbox uses: the frame's own window. */
export interface FrameWindow {
  parent: unknown;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * Receives host assertions for one frame. `take()` resolves with the next accepted assertion and forgets
 * it; `request()` asks the parent for another, at the origin the last accepted one came from.
 */
export class HostAssertionInbox {
  private pending: PostedAssertion | null = null;
  private origin: string | null = null;
  private waiting: Array<(a: PostedAssertion) => void> = [];
  private readonly listener: (event: MessageEvent) => void;
  private readonly win: FrameWindow;

  /** Every refused post, by reason, for the frame's own diagnostics. */
  readonly refused: Record<'origin' | 'source' | 'shape', number> = { origin: 0, source: 0, shape: 0 };

  constructor(hosts: ReadonlySet<string>, win: FrameWindow = window as unknown as FrameWindow) {
    this.win = win;
    this.listener = (event) => {
      const check = checkPostedAssertion(event, hosts, win.parent === win ? null : win.parent);
      if (!check.ok) {
        // A post that is not an assertion at all (another script's message) is not worth counting.
        if (check.reason !== 'shape' || (event.data as { type?: unknown } | null)?.type === ASSERTION_MESSAGE) this.refused[check.reason] += 1;
        return;
      }
      this.origin = check.origin;
      const next = this.waiting.shift();
      if (next) next(check.value);
      else this.pending = check.value;
    };
    win.addEventListener('message', this.listener);
  }

  /** The next accepted assertion, taken once. */
  take(): Promise<PostedAssertion> {
    if (this.pending) {
      const a = this.pending;
      this.pending = null;
      return Promise.resolve(a);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Ask the parent for a fresh assertion. Only once one was accepted, and only at its origin. */
  request(): boolean {
    const parent = this.win.parent as { postMessage?: (m: unknown, origin: string) => void } | null;
    if (!this.origin || !parent || parent === (this.win as unknown) || typeof parent.postMessage !== 'function') return false;
    parent.postMessage({ type: ASSERTION_REQUEST }, this.origin);
    return true;
  }

  close(): void {
    this.win.removeEventListener('message', this.listener);
    this.waiting = [];
    this.pending = null;
  }
}
