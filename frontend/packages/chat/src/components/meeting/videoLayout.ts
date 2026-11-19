/**
 * THE MEETING'S VIDEO LAYOUT, as rules (SPEC-ASSISTANT-MEETINGS FR61): who takes the stage, who presents, who yields a
 * share, how the grid pages, and which remote videos are subscribed. `VideoTiles.tsx` renders what these decide.
 *
 *  - THE STAGE (speaker layout) holds a shared screen, else the active speaker among the OTHERS in the meeting, kept
 *    there while they or the viewer fall silent, else the first of the others; the viewer has the stage only alone.
 *    The viewer is a self view over the stage, and the stage follows who speaks.
 *  - ONE SHARE AT A TIME, the newest winning: a sharer whose share is older than another's stops theirs, as the Amazon
 *    Chime SDK React component library's content share provider does at its default of one share
 *    (`ContentShareProvider`, `maxContentShares = 1`).
 *  - THE GRID PAGES past `GRID_PAGE_SIZE` people (`GRID_PAGE_SIZE_NARROW` on a phone-width window), and only the page in
 *    view is subscribed (`videoPreferencesFor`), following the Amazon Chime SDK's video layout guide
 *    (https://aws.github.io/amazon-chime-sdk-js/modules/videolayout.html): its gallery sample renders up to ten remote
 *    videos and leaves the rest unsubscribed "so they do not cost bandwidth", and its small grid holds up to four. An
 *    attendee subscribes to at most 25 video streams (Amazon Chime SDK WebRTC quotas,
 *    https://docs.aws.amazon.com/general/latest/gr/chime-sdk.html#chm-sdk-webrtc-quotas).
 */
import type { MeetingAttendee, MeetingTile } from '../../providers/MeetingProvider';

/** People on one grid page: a 3 by 3 grid, under the guide's gallery sample of ten. */
export const GRID_PAGE_SIZE = 9;
/** People on one grid page in a phone-width window: the guide's small grid of up to four. */
export const GRID_PAGE_SIZE_NARROW = 4;
/**
 * A PHONE-SIZED WINDOW: at or under the sibling project's 640px mobile breakpoint, or a phone held sideways (short and
 * landscape). There the grid holds `GRID_PAGE_SIZE_NARROW` and the meeting window's columns are panes
 * (`meetingPanes.ts`); the stylesheets carry the same query.
 */
export const NARROW_MEDIA = '(max-width: 640px), (max-height: 480px) and (orientation: landscape)';

/** A shared screen's attendee is its sharer's attendee with this suffix (amazon-chime-sdk-js content share guide). */
export const CONTENT_SUFFIX = '#content';

/** The attendee an attendee id belongs to: a shared screen's sharer, else itself. */
export function baseAttendeeOf(attendeeId: string): string {
  const at = attendeeId.indexOf(CONTENT_SUFFIX);
  return at < 0 ? attendeeId : attendeeId.slice(0, at);
}

/** One place on screen: an attendee (with their video tile, when they send one) or a shared screen. */
export interface Pane {
  key: string;
  attendee?: MeetingAttendee;
  tile?: MeetingTile;
}

/** The attendee a pane shows, a shared screen's being its own `#content` attendee. */
export function attendeeIdOf(pane: Pane): string | undefined {
  return pane.attendee?.attendeeId ?? pane.tile?.attendeeId;
}

/** The pane is the viewer's own. */
export function isSelf(pane: Pane, selfAttendeeId?: string): boolean {
  if (pane.tile?.isContent) return false;
  if (pane.tile?.isLocal) return true;
  const id = attendeeIdOf(pane);
  return !!id && !!selfAttendeeId && id === selfAttendeeId;
}

/** The panes, a shared screen first, then each attendee in the order they arrived, with their video tile where they send one. */
export function panesOf(attendees: readonly MeetingAttendee[], tiles: readonly MeetingTile[]): Pane[] {
  const content = tiles.filter((t) => t.isContent).map((tile) => ({ key: `content-${tile.tileId}`, tile }));
  const people = attendees.map((attendee) => ({
    key: attendee.attendeeId,
    attendee,
    tile: tiles.find((t) => !t.isContent && t.attendeeId === attendee.attendeeId),
  }));
  // A video tile whose attendee has not been announced yet still shows.
  const unseated = tiles
    .filter((t) => !t.isContent && !attendees.some((a) => a.attendeeId === t.attendeeId))
    .map((tile) => ({ key: `tile-${tile.tileId}`, tile }));
  return [...content, ...people, ...unseated];
}

/**
 * The pane on the speaker layout's stage: a shared screen; else the active speaker among the others; else the one who
 * held it last (`previous`), while they are still here; else the first of the others; else the viewer, alone.
 */
export function stageOf(panes: readonly Pane[], activeSpeaker?: string, selfAttendeeId?: string, previous?: string): Pane | undefined {
  const content = panes.find((p) => p.tile?.isContent);
  if (content) return content;
  const others = panes.filter((p) => !isSelf(p, selfAttendeeId));
  return others.find((p) => !!activeSpeaker && attendeeIdOf(p) === activeSpeaker)
    ?? others.find((p) => !!previous && p.key === previous)
    ?? others[0]
    ?? panes[0];
}

/** Two initials from a display name ("Ada Lovelace" is "AL", "Ada" is "A"), for a tile with no video. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** The person presenting a shared screen, by the share's tile: the viewer, another attendee, or one not yet announced. */
export function presenterOf(tile: MeetingTile, attendees: readonly MeetingAttendee[], selfAttendeeId?: string): { self: boolean; attendee?: MeetingAttendee } {
  const base = baseAttendeeOf(tile.attendeeId);
  return { self: !!selfAttendeeId && base === selfAttendeeId, attendee: attendees.find((a) => a.attendeeId === base) };
}

/**
 * The viewer's share yields: they are sharing and another attendee's share started after theirs (a higher tile id, the
 * order the SDK numbers tiles in), so the newest share is the one the meeting sees.
 */
export function shareYields(tiles: readonly MeetingTile[], selfAttendeeId: string | undefined, sharing: boolean): boolean {
  if (!sharing || !selfAttendeeId) return false;
  const shares = tiles.filter((t) => t.isContent);
  const own = shares.find((t) => baseAttendeeOf(t.attendeeId) === selfAttendeeId);
  if (!own) return false;
  return shares.some((t) => baseAttendeeOf(t.attendeeId) !== selfAttendeeId && t.tileId > own.tileId);
}

/** How many pages `count` people take at `size` a page; at least one. */
export function pageCountOf(count: number, size: number): number {
  return Math.max(1, Math.ceil(count / size));
}

/** The people on page `page` (from zero), the page held within the pages there are. */
export function pageOf<T>(items: readonly T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = pageCountOf(items.length, size);
  const at = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(at * size, at * size + size), page: at, pages };
}

/** A resolution a subscription asks for, the SDK's `TargetDisplaySize` by name. */
export type VideoSize = 'low' | 'medium' | 'high';

/** One remote video to subscribe to: its attendee (a share's `#content` attendee included), priority (1 first) and size. */
export interface VideoChoice { attendeeId: string; priority: number; size: VideoSize }

/**
 * THE REMOTE VIDEOS TO SUBSCRIBE TO, from those published (`sources`): every shared screen first at high resolution;
 * then the featured (the stage, and a speaker shown over a share) at high; then the rest in view, at a resolution their
 * number allows, the sizes the SDK's own default gives by count (high to four, medium to eight, low beyond). A source not
 * in view is left out, which the policy unsubscribes (priority-based downlink policy guide,
 * https://aws.github.io/amazon-chime-sdk-js/modules/prioritybased_downlink_policy.html). The order and priorities follow
 * the video layout guide's featured layout: content 1, featured 2, the others 3.
 */
export function videoPreferencesFor({ sources, visible, featured = [] }: {
  sources: readonly string[];
  visible: readonly string[];
  featured?: readonly string[];
}): VideoChoice[] {
  const inView = visible.filter((id) => !featured.includes(id));
  const size: VideoSize = inView.length > 8 ? 'low' : inView.length > 4 ? 'medium' : 'high';
  const out: VideoChoice[] = [];
  for (const id of [...sources].sort()) {
    if (id.includes(CONTENT_SUFFIX)) out.push({ attendeeId: id, priority: 1, size: 'high' });
    else if (featured.includes(id)) out.push({ attendeeId: id, priority: 2, size: 'high' });
    else if (inView.includes(id)) out.push({ attendeeId: id, priority: 3, size });
  }
  return out.sort((a, b) => a.priority - b.priority || a.attendeeId.localeCompare(b.attendeeId));
}
