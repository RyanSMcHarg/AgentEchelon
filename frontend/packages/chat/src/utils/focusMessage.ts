/**
 * A pending "scroll to this message" request from a `#message=<id>` deep link.
 *
 * A deep link is handled in `App` before the target conversation's history has loaded, so the request has to
 * outlive that moment and be acted on when the message actually renders. It is held here rather than in
 * provider state because nothing else needs to react to it: `ConversationInterface` already re-renders when
 * `messages` changes, so an effect there fires at exactly the right time.
 *
 * The request is BOUNDED and SCOPED, because a pending request suppresses the auto-scroll-to-newest
 * behaviour while it waits:
 *
 * - Scoped to the conversation the link named. A request only ever matches that conversation, so switching
 *   conversations can never inherit someone else's stale target.
 * - Bounded by an attempt ceiling and a deadline. A target can be genuinely unreachable: deleted, redacted,
 *   or beyond the loaded history page. Without a limit such a request stays pending forever and the reader
 *   never sees a new message scroll into view again. Once the budget runs out the request is dropped and
 *   auto-scroll resumes. Nothing is shown when a target cannot be found, matching the rest of the deep-link
 *   path, which is silent about a conversation it cannot resolve either.
 */
interface PendingFocus {
  messageId: string;
  conversationId: string;
  /** Renders left in which the target may still appear. Decremented by `noteMessageFocusMiss`. */
  attemptsLeft: number;
  /** Wall-clock give-up point, for the case where no further render ever comes. */
  expiresAt: number;
}

/**
 * Renders in which the target may still turn up. The target normally arrives on the first render after the
 * history load, so this only has to cover a history that lands in several passes.
 */
const MAX_ATTEMPTS = 8;

/** Generous enough to cover a slow history fetch, short enough that a dead link stops mattering quickly. */
const FOCUS_TTL_MS = 30_000;

let pending: PendingFocus | null = null;

/**
 * Reduce either spelling of a conversation to the channel id both share.
 *
 * A backend-composed deep link addresses the conversation by its full channel ARN
 * (`?conversation=arn:aws:chime:.../channel/<id>`), while the app reflects the SHORT id into the URL and
 * `Conversation.id` is that short id. Scoping on the raw string would never match an ARN-shaped link, so the
 * deep link would silently stop focusing anything. The last path segment is the channel id in both forms
 * (`chimeService` builds `id` as exactly that).
 */
function conversationKey(conversationId: string | null | undefined): string {
  return conversationId ? conversationId.split('/').pop() || '' : '';
}

/** Drop a request whose budget or deadline has run out. Returns the request while it is still live. */
function live(): PendingFocus | null {
  if (!pending) return null;
  if (pending.attemptsLeft <= 0 || Date.now() > pending.expiresAt) {
    pending = null;
    return null;
  }
  return pending;
}

/**
 * Record a deep link's target. `conversationId` is the conversation the link named, in either the ARN or the
 * short-id spelling.
 */
export function requestMessageFocus(messageId: string, conversationId: string): void {
  const key = conversationKey(conversationId);
  pending = messageId && key
    ? { messageId, conversationId: key, attemptsLeft: MAX_ATTEMPTS, expiresAt: Date.now() + FOCUS_TTL_MS }
    : null;
}

/** The target waiting on this conversation, if any. Does not consume: the caller clears once it lands. */
export function peekMessageFocus(conversationId: string | null | undefined): string | null {
  const p = live();
  const key = conversationKey(conversationId);
  if (!p || !key || p.conversationId !== key) return null;
  return p.messageId;
}

/** Peek without the id, so the auto-scroll effect can tell whether there is anything to wait for. */
export function hasPendingMessageFocus(conversationId: string | null | undefined): boolean {
  return peekMessageFocus(conversationId) !== null;
}

/** The target landed (or the caller is giving up on it). */
export function clearMessageFocus(): void {
  pending = null;
}

/**
 * The target was not in the DOM on this pass. Spends one attempt and leaves the request pending, which is
 * what lets a message that arrives a moment after mount still be scrolled to. Clears the request once the
 * attempts are spent, so auto-scroll recovers instead of being suppressed forever.
 */
export function noteMessageFocusMiss(): void {
  if (!pending) return;
  pending.attemptsLeft -= 1;
  if (pending.attemptsLeft <= 0) pending = null;
}

/** Long enough to notice, short enough not to linger once the reader has found it. */
const HIGHLIGHT_MS = 2600;

/**
 * Scroll a rendered message into view and mark it briefly.
 *
 * Returns false when the element is not in the DOM, so the caller can leave the request pending for the next
 * render rather than losing it.
 */
export function scrollToMessage(messageId: string): boolean {
  if (!messageId) return false;
  // A Chime MessageId is opaque and must not be assumed to be a valid CSS identifier.
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(messageId) : messageId;
  const el = document.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('message--focused');
  window.setTimeout(() => el.classList.remove('message--focused'), HIGHLIGHT_MS);
  return true;
}
