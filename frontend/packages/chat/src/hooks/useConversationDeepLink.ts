import { useEffect, useRef } from 'react';
import { requestMessageFocus } from '../utils/focusMessage';

type Select = (conversationId: string) => Promise<void>;

/**
 * The conversation and message a link names: `?conversation=<id>` with an optional `#message=<id>`. A message id that
 * does not decode names no message, and the conversation still opens.
 */
function linkTarget(search: string, hash: string): { conversationId: string; messageId: string } | null {
  const conversationId = new URLSearchParams(search).get('conversation');
  if (!conversationId) return null;
  const rawMessageId = (hash.match(/message=([^&]+)/) || [])[1] || '';
  let messageId = '';
  try { messageId = decodeURIComponent(rawMessageId); } catch { /* no message to focus */ }
  return { conversationId, messageId };
}

/**
 * Open what a link names: `#message=<id>` names a SPECIFIC message (a drift-created conversation links back to the
 * message that caused it). Recorded before selecting, because the target's history has not loaded yet; the conversation
 * view scrolls to it once it renders, and the request gives up after a bounded wait.
 */
function openTarget(target: { conversationId: string; messageId: string }, select: Select): Promise<void> {
  if (target.messageId) requestMessageFocus(target.messageId, target.conversationId);
  return select(target.conversationId);
}

/** The app's conversation opener while the app is signed in and ready, for a link in a message to open in place. */
let inAppSelect: Select | null = null;

/**
 * A CONVERSATION LINK IN A MESSAGE (`?conversation=<id>`, `#message=<id>`) OPENS IN PLACE: the conversation is selected
 * as the sidebar selects one, with no page load, so the app, its messaging session and an open meeting stay as they are.
 * Answers false where the app cannot open it here (not ready yet, or an href that names no conversation), and the link is
 * then followed as an ordinary same-tab address, which the deep link below opens on load.
 */
export function openConversationLinkInPlace(href: string): boolean {
  if (!inAppSelect) return false;
  const hashAt = href.indexOf('#');
  const target = linkTarget(hashAt === -1 ? href : href.slice(0, hashAt), hashAt === -1 ? '' : href.slice(hashAt));
  if (!target) return false;
  void openTarget(target, inAppSelect).catch(() => undefined);
  return true;
}

/**
 * OPENS THE CONVERSATION A LINK NAMES (`?conversation=<id>`, from a share or a proactive-briefing email), once.
 *
 * `selectConversation` resolves the id against the loaded list and falls back to describing the channel
 * directly, so the link works even when the channel is not in the recipient's sidebar yet (past the first
 * page, or freshly shared). It waits until the Amazon Chime SDK client is ready, because that fallback needs
 * it, and cleaning the URL before then would lose the link.
 *
 * READ ONCE, when the person is first ready. The provider writes the open conversation back into the same
 * param, and `selectConversation` is rebuilt whenever the conversation list changes, so reading it on every
 * run would reopen whatever the URL last named each time the list changed: creating a conversation would
 * send the person back to the one they had open before.
 *
 * From then on it is also the opener a message's conversation link uses (`openConversationLinkInPlace`).
 */
export function useConversationDeepLink(ready: boolean, selectConversation: Select): void {
  const taken = useRef(false);
  useEffect(() => {
    if (!ready) return undefined;
    inAppSelect = selectConversation;
    return () => { if (inAppSelect === selectConversation) inAppSelect = null; };
  }, [ready, selectConversation]);
  useEffect(() => {
    if (!ready || taken.current) return;
    taken.current = true;
    const target = linkTarget(window.location.search, window.location.hash);
    if (!target) return;
    void openTarget(target, selectConversation).finally(() => {
      window.history.replaceState({}, '', window.location.pathname);
    });
  }, [ready, selectConversation]);
}
