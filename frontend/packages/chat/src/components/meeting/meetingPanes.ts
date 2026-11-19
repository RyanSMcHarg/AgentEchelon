/**
 * THE MEETING WINDOW ON A PHONE-WIDTH SCREEN (SPEC-ASSISTANT-MEETINGS): the window's columns (the video, the roster, the
 * chat) are panes, one on screen at a time, reached by swiping across the window or from the tab bar at its foot, as the
 * sibling project's meeting interface does at the same 640px breakpoint (its bottom tab bar, and its 50px horizontal swipe
 * that a touch starting on a control never triggers).
 *
 * These are the rules; `MeetingChatPanel.tsx` holds the state and renders the tab bar, `MeetingRoom.tsx` the panes.
 */
import { useEffect, useState } from 'react';
import { NARROW_MEDIA } from './videoLayout';

/** One column of the meeting window, as a pane on a phone-width screen. */
export type MeetingPane = 'video' | 'people' | 'chat';

/** The least horizontal travel, in CSS pixels, that counts as a swipe (the sibling project's `minSwipeDistance`). */
export const SWIPE_MIN_DISTANCE = 50;

/**
 * Where a touch never starts a swipe: a control (the sibling project's rule, so a tap on the microphone never changes the
 * pane), a field, and anything that moves under the finger itself (the filmstrip scrolls sideways, the self view drags).
 */
export const SWIPE_EXEMPT = 'button, a, input, select, textarea, [role="button"], [role="tab"], [role="separator"], [contenteditable="true"], .ae-video-strip, .ae-video-self';

/** The panes there are, in reading order: the video, then the roster and the chat where the window holds them. */
export function meetingPanes({ people, chat }: { people: boolean; chat: boolean }): MeetingPane[] {
  return ['video', ...(people ? ['people' as const] : []), ...(chat ? ['chat' as const] : [])];
}

/** The pane on screen: the one chosen while it is there, else the video. */
export function paneShown(pane: MeetingPane, panes: readonly MeetingPane[]): MeetingPane {
  return panes.includes(pane) ? pane : 'video';
}

/**
 * The pane a swipe lands on. `dx` and `dy` are the finger's travel (end minus start): a mostly horizontal travel of at
 * least `SWIPE_MIN_DISTANCE` moves one pane, leftward to the next and rightward to the previous, and stops at either end.
 * Anything else (a tap, a vertical scroll of the chat or the roster) leaves the pane as it is.
 */
export function paneAfterSwipe(pane: MeetingPane, panes: readonly MeetingPane[], dx: number, dy: number): MeetingPane {
  const at = panes.indexOf(paneShown(pane, panes));
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) <= Math.abs(dy)) return panes[at];
  const next = dx < 0 ? at + 1 : at - 1;
  return panes[Math.min(panes.length - 1, Math.max(0, next))];
}

/** The pane a key moves the tab bar's focus to (the WAI-ARIA tabs pattern), or null for any other key. */
export function paneForKey(pane: MeetingPane, panes: readonly MeetingPane[], key: string): MeetingPane | null {
  const at = panes.indexOf(paneShown(pane, panes));
  if (key === 'ArrowRight') return panes[(at + 1) % panes.length];
  if (key === 'ArrowLeft') return panes[(at - 1 + panes.length) % panes.length];
  if (key === 'Home') return panes[0];
  if (key === 'End') return panes[panes.length - 1];
  return null;
}

/** Whether the window is phone-width now (`NARROW_MEDIA`), following it as it changes: a rotation, a resized window. */
export function useNarrowWindow(): boolean {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_MEDIA) : null;
  const [narrow, setNarrow] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return undefined;
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  // The query is the same media for the life of the window.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return narrow;
}
