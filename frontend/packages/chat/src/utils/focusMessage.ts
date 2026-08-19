/**
 * A pending "scroll to this message" request from a `#message=<id>` deep link.
 *
 * A deep link is handled in `App` before the target conversation's history has loaded, so the request has to
 * outlive that moment and be acted on when the message actually renders. It is held here rather than in
 * provider state because nothing else needs to react to it: `ConversationInterface` already re-renders when
 * `messages` changes, so an effect there fires at exactly the right time. No timer, no polling, no deadline.
 *
 * Consumed once and cleared, so a later conversation switch does not re-scroll to an old target.
 */
let pendingMessageId: string | null = null;

export function requestMessageFocus(messageId: string): void {
  pendingMessageId = messageId || null;
}

/** Take the pending target, if any. Clearing on read is what makes it fire once. */
export function takePendingMessageFocus(): string | null {
  const id = pendingMessageId;
  pendingMessageId = null;
  return id;
}

/** Peek without consuming, so an effect can tell whether there is anything to wait for. */
export function hasPendingMessageFocus(): boolean {
  return pendingMessageId !== null;
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
