import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** How close to the bottom, in pixels, still counts as reading the newest message. */
export const FOLLOW_THRESHOLD_PX = 100;

/**
 * The conversation follows its newest content while the viewer is at the bottom, and leaves them where
 * they are once they scroll up to read history.
 *
 * Every chat view renders its messages in one scrolling list (`ConversationInterface`), and so does the widget's
 * transcript (`Transcript`); this is that list's scrolling rule:
 *
 * - **At the bottom, it follows.** A new message, an UPDATE that grows a message (a placeholder
 *   replaced by its answer, a duel side's reply landing), and an image or attachment that loads all
 *   change the height of the list's content, and a `ResizeObserver` on that content pins the view to
 *   the bottom on each change. `changeKey` (the message list) pins it on the render a message arrives.
 * - **Scrolled up, it stays put.** The viewer has left the bottom when they scroll up away from it, so
 *   new content shows the jump affordance (`showJump`) instead of moving them. Scrolling back to the
 *   bottom, or the jump, resumes following.
 * - **A conversation opens at the bottom.** `resetKey` (the conversation) starts every conversation
 *   following, pinned on its first render.
 *
 * Event-driven throughout (tenet D6): the message stream, the scroll event and the resize observer
 * drive it, and nothing runs on a timer. The pin is an instant `scrollTop` write, so a programmatic
 * scroll never animates through positions that would read as the viewer scrolling up.
 */
export function useFollowBottom(args: {
  containerRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** Changes when the list's messages change. */
  changeKey: unknown;
  /** Changes when a different conversation opens. */
  resetKey: unknown;
  /** True while something else owns the scroll position (a deep link that has not landed yet). */
  isSuspended?: () => boolean;
}): {
  showJump: boolean;
  jumpToBottom: () => void;
  onScroll: () => void;
  /** The viewer is somewhere they chose (a deep-linked message): stop following until they return. */
  release: () => void;
} {
  const { containerRef, contentRef, changeKey, resetKey } = args;
  const suspendedRef = useRef(args.isSuspended);
  useLayoutEffect(() => {
    suspendedRef.current = args.isSuspended;
  });
  const followingRef = useRef(true);
  const lastTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const pin = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, [containerRef]);

  const suspended = () => !!suspendedRef.current?.();

  // A conversation opens at its newest message.
  useLayoutEffect(() => {
    followingRef.current = true;
    setShowJump(false);
    pin();
  }, [resetKey, pin]);

  // A message arrived or changed: follow it, or say there is something new below.
  useLayoutEffect(() => {
    if (suspended()) return;
    if (followingRef.current) pin();
    else setShowJump(true);
    // `suspended` reads a ref, so the message list is the only thing this runs on.
  }, [changeKey, pin]);

  // The content grew or shrank without a new message: an UPDATE replaced a placeholder, an image loaded.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current && !suspendedRef.current?.()) pin();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, pin, resetKey]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom <= FOLLOW_THRESHOLD_PX) {
      followingRef.current = true;
      setShowJump(false);
    } else if (el.scrollTop < lastTopRef.current) {
      // Only a move UP leaves the bottom. Content growing below the viewer moves nothing, and a
      // programmatic pin only moves down, so neither can be mistaken for the viewer leaving.
      followingRef.current = false;
    }
    lastTopRef.current = el.scrollTop;
  }, [containerRef]);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    followingRef.current = true;
    setShowJump(false);
    if (!el) return;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, [containerRef]);

  const release = useCallback(() => {
    followingRef.current = false;
  }, []);

  return { showJump, jumpToBottom, onScroll, release };
}
