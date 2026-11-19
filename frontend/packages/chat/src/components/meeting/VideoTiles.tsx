/**
 * VideoTiles: everyone in the meeting, in one of two layouts (SPEC-ASSISTANT-MEETINGS FR61). The rules live in
 * `videoLayout.ts`; this renders them.
 *
 *  - `speaker`: the stage holds a shared screen, else whoever else is speaking, kept there through a
 *    silence; while a screen is shared, the speaker shows over its corner. The viewer is a self view over the stage that
 *    a drag moves to the nearest corner and a double tap or double click enlarges, and that the viewer may hide. Everyone
 *    else is in a filmstrip beneath.
 *  - `grid` (the owner's decision): every person an equal tile, a shared screen above them, paged past
 *    `GRID_PAGE_SIZE` people; only the page in view is received (`useVideoSubscriptions.ts`).
 *
 * EVERY ATTENDEE HAS A TILE, camera or not: a tile shows their video when it plays, and their initials when their camera
 * is off or the network policy paused their video, so a meeting of people with
 * cameras off still shows who is there and who is speaking.
 *
 * A SHARED SCREEN SAYS WHO PRESENTS it, the sharer's own included: a sharer sees their own screen as everyone does. One
 * share shows at a time, the newest; the older sharer's app stops theirs (`shareYields`). A share the browser's own
 * "Stop sharing" bar ends turns the control off (the provider's content share observer).
 *
 * A <video> is handed to the provider by a stable ref callback per tile, which binds it to the live Amazon Chime SDK
 * tile; an inline callback would rebind on every render. Each tile is on screen once, as the SDK binds a tile to one
 * element. A PERSON'S AUDIO SIGNS ride on their tile as on the roster (`MeetingIndicators.tsx`): muted, muted by a host,
 * and a network losing their audio; the active speaker's tile is ringed, in both layouts.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMeeting } from '../../providers/MeetingProvider';
import { useMeetingSignals } from '../../providers/meetingSignals';
import { AudioIndicators } from './MeetingIndicators';
import {
  GRID_PAGE_SIZE, GRID_PAGE_SIZE_NARROW,
  attendeeIdOf, initialsOf, isSelf, pageOf, panesOf, presenterOf, shareYields, stageOf, type Pane,
} from './videoLayout';
import { useVideoSubscriptions } from './useVideoSubscriptions';
import { useNarrowWindow } from './meetingPanes';
import './MeetingRoom.css';
import './VideoTiles.css';

export type MeetingLayout = 'grid' | 'speaker';

/** Whether the viewer hides their own view, remembered in this browser ("Show self-view"). */
const SELF_VIEW_KEY = 'ae.meeting.selfView';
function storedSelfViewHidden(): boolean {
  try { return localStorage.getItem(SELF_VIEW_KEY) === 'hidden'; } catch { return false; }
}

type Corner = 'tl' | 'tr' | 'bl' | 'br';

/** People on a grid page for this window's width, following the width as it changes. */
function useGridPageSize(): number {
  return useNarrowWindow() ? GRID_PAGE_SIZE_NARROW : GRID_PAGE_SIZE;
}

/** A pane's audio signs, or none for a shared screen. */
interface PaneAudio { muted?: boolean; mutedByHost?: boolean; poorNetwork?: boolean; isYou?: boolean; heldForNotice?: boolean }

function PaneView({ pane, bind, label, initials, showVideo, speaking, size, audio, children }: {
  pane: Pane;
  bind: (tileId: number, el: HTMLVideoElement | null) => void;
  label: string;
  initials: string;
  /** The tile's video plays: false while the camera is off or the policy paused it, and the initials show instead. */
  showVideo: boolean;
  speaking: boolean;
  size: 'stage' | 'tile' | 'strip' | 'overlay' | 'self';
  audio?: PaneAudio;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const tileId = pane.tile?.tileId;
  const ref = useCallback((el: HTMLVideoElement | null) => { if (tileId !== undefined) bind(tileId, el); }, [bind, tileId]);
  return (
    <div
      className={`ae-video-tile ae-video-tile--${size}${pane.tile?.isContent ? ' ae-video-tile--content' : ''}${speaking ? ' ae-video-tile--speaking' : ''}`}
      data-testid="meeting-tile"
      data-pane={pane.key}
    >
      {/* The element stays while a video pauses, so it plays again in place when the policy resumes it. */}
      {pane.tile && (
        <video className={`ae-video-el${showVideo ? '' : ' ae-video-el--hidden'}`} autoPlay playsInline muted={pane.tile.isLocal} ref={ref} />
      )}
      {!showVideo && (
        <div
          className="ae-video-avatar" role="img" data-testid="meeting-tile-placeholder"
          aria-label={pane.tile?.paused ? t('meeting.videoPaused') : t('meeting.cameraOff')}
          title={pane.tile?.paused ? t('meeting.videoPaused') : undefined}
        >
          <span className="ae-video-initials">{initials}</span>
        </div>
      )}
      <span className="ae-video-badge">{label}{audio && <> <AudioIndicators {...audio} /></>}</span>
      {children}
    </div>
  );
}

/**
 * THE VIEWER'S OWN VIEW over the stage:
 * a drag of more than 50 pixels snaps it to the nearest corner, and two taps or clicks within 300 ms enlarge it or bring
 * it back.
 */
function SelfView({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [corner, setCorner] = useState<Corner>('tr');
  const [expanded, setExpanded] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  // THE DRAG BELONGS TO THE VIEW from the press: the pointer is captured, so the release reaches it wherever the mouse ends
  // up, and the press starts no native drag of the video or selection of the page.
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, y: e.clientY };
    e.preventDefault();
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* a pointer that cannot be captured still taps */ }
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const from = start.current;
    start.current = null;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (Math.hypot(dx, dy) > 50) {
      const box = e.currentTarget.getBoundingClientRect();
      const parent = e.currentTarget.parentElement?.getBoundingClientRect();
      if (!parent) return;
      const left = box.left + box.width / 2 + dx - parent.left < parent.width / 2;
      const top = box.top + box.height / 2 + dy - parent.top < parent.height / 2;
      setCorner(top ? (left ? 'tl' : 'tr') : (left ? 'bl' : 'br'));
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < 300) setExpanded((x) => !x);
    lastTap.current = now;
  };
  return (
    <div
      className={`ae-video-self ae-video-self--${corner}${expanded ? ' ae-video-self--expanded' : ''}`}
      data-testid="meeting-self-view" data-corner={corner}
      title={t('meeting.selfView.hint')}
      onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { start.current = null; }}
    >
      {children}
    </div>
  );
}

export default function VideoTiles({ layout = 'grid', nameOf = () => undefined }: {
  layout?: MeetingLayout;
  nameOf?: (personId: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const { attendees, tiles, activeSpeaker, status, bindVideoElement, muted, mutedForNotice, selfAttendeeId, cameraOn, sharing, toggleShare } = useMeeting();
  const signals = useMeetingSignals();
  const panes = panesOf(attendees, tiles);
  const [selfHidden, setSelfHidden] = useState(storedSelfViewHidden);
  const [page, setPage] = useState(0);
  const pageSize = useGridPageSize();
  const lastStage = useRef<string | undefined>(undefined);

  const hideSelf = (hidden: boolean) => {
    setSelfHidden(hidden);
    try { localStorage.setItem(SELF_VIEW_KEY, hidden ? 'hidden' : 'shown'); } catch { /* the choice lasts this window only */ }
  };

  // ONE SHARE AT A TIME: a newer share than the viewer's own stops theirs.
  const yields = shareYields(tiles, selfAttendeeId, sharing);
  useEffect(() => { if (yields) toggleShare(); }, [yields, toggleShare]);

  const self = (p: Pane) => isSelf(p, selfAttendeeId);
  const audioOf = (p: Pane): PaneAudio | undefined => {
    if (p.tile?.isContent) return undefined;
    const id = attendeeIdOf(p);
    const isYou = self(p);
    return {
      isYou,
      muted: isYou ? muted : p.attendee?.muted === true,
      heldForNotice: isYou && !!mutedForNotice,
      mutedByHost: !!p.attendee?.personId && signals.hostMuted.has(p.attendee.personId),
      poorNetwork: !!id && signals.poorSignal.has(id),
    };
  };
  const nameFor = (p: Pane) => (p.attendee && nameOf(p.attendee.personId)) || undefined;
  const labelOf = (p: Pane) => {
    if (p.tile?.isContent) {
      const who = presenterOf(p.tile, attendees, selfAttendeeId);
      if (who.self) return t('meeting.youArePresenting');
      const name = who.attendee && nameOf(who.attendee.personId);
      return name ? t('meeting.presenting', { name }) : t('meeting.sharedScreen');
    }
    return self(p) ? t('meeting.you') : nameFor(p) || t('meeting.participant');
  };
  const initialsFor = (p: Pane) => initialsOf(nameFor(p) || labelOf(p));
  const showsVideo = (p: Pane) => !!p.tile && !p.tile.paused && (!self(p) || cameraOn !== false);
  const speaking = (p: Pane) => !!activeSpeaker && attendeeIdOf(p) === activeSpeaker;
  const view = (p: Pane, size: Parameters<typeof PaneView>[0]['size'], children?: ReactNode) => (
    <PaneView
      key={p.key} pane={p} bind={bindVideoElement} label={labelOf(p)} initials={initialsFor(p)} showVideo={showsVideo(p)}
      speaking={speaking(p)} size={size} audio={audioOf(p)}
    >
      {children}
    </PaneView>
  );
  const hideButton = (
    <button type="button" className="ae-video-self-hide" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={() => hideSelf(true)} aria-label={t('meeting.selfView.hideLabel')}>
      {t('meeting.selfView.hide')}
    </button>
  );
  const showButton = (
    <button type="button" className="ae-mc-btn ae-video-self-show" onClick={() => hideSelf(false)}>{t('meeting.selfView.show')}</button>
  );

  // WHAT IS ON SCREEN, so the session receives only that (below). Worked out before any early return, as hooks follow.
  const selfPane = panes.find(self);
  const content = panes.filter((p) => p.tile?.isContent);
  const people = panes.filter((p) => !p.tile?.isContent && !(selfHidden && self(p)));
  const grid = pageOf(people, page, pageSize);
  const staged = stageOf(panes, activeSpeaker, selfAttendeeId, lastStage.current);
  // A viewer alone who hides their own view sees an empty stage, with the control that shows it again.
  const stage = staged && selfHidden && self(staged) ? undefined : staged;
  const stageIsContent = !!stage?.tile?.isContent;
  const others = panes.filter((p) => !p.tile?.isContent && !self(p));
  // While a screen has the stage, the speaker shows over its corner.
  const overlay = stageIsContent
    ? others.find((p) => !!activeSpeaker && attendeeIdOf(p) === activeSpeaker) ?? others.find((p) => p.key === lastStage.current) ?? others[0]
    : undefined;
  const pip = selfPane && stage && selfPane.key !== stage.key && !selfHidden ? selfPane : undefined;
  const strip = panes.filter((p) => p !== stage && p !== overlay && p !== pip && !(selfHidden && self(p)));
  const remote = (list: readonly (Pane | undefined)[]) => list
    .filter((p): p is Pane => !!p && !p.tile?.isContent && !self(p))
    .map((p) => attendeeIdOf(p)!)
    .filter(Boolean);
  const visible = layout === 'speaker' ? remote([stage, overlay, ...strip]) : remote(grid.items);
  const featured = layout === 'speaker' ? remote([stage, overlay]) : [];
  useVideoSubscriptions(visible, featured);
  // The stage is kept by whoever last held it among the others, so a silence or the viewer speaking does not move it.
  useEffect(() => {
    if (stage && !stageIsContent && !self(stage)) lastStage.current = stage.key;
  });

  if (panes.length === 0) {
    return <div className="ae-video-empty">{status === 'joined' ? t('meeting.waitingForVideo') : t('meeting.notJoined')}</div>;
  }

  if (layout === 'speaker') {
    return (
      <div className="ae-video-speaker" data-layout="speaker">
        <div className="ae-video-stage">
          {stage && view(stage, 'stage')}
          {overlay && <div className="ae-video-overlay" data-testid="meeting-share-overlay">{view(overlay, 'overlay')}</div>}
          {pip && <SelfView>{view(pip, 'self', hideButton)}</SelfView>}
          {selfHidden && selfPane && showButton}
        </div>
        {strip.length > 0 && <div className="ae-video-strip">{strip.map((p) => view(p, 'strip'))}</div>}
      </div>
    );
  }

  // As square a grid as the page allows, so each tile is as large as the stage can hold.
  // A narrow stage (a phone held upright) stacks up to three people in one column and four in two, so each tile keeps the
  // stage's width rather than shrinking beside another (`MeetingRoom.css` reads `--ae-grid-cols-narrow` there); a phone held
  // sideways puts the page in one row (`--ae-grid-count`).
  const columns = Math.max(1, Math.ceil(Math.sqrt(grid.items.length)));
  const narrowColumns = grid.items.length <= 3 ? 1 : 2;
  const count = Math.max(1, grid.items.length);
  return (
    <div className="ae-video-grid-wrap" data-layout="grid">
      {content.length > 0 && <div className="ae-video-grid-content">{content.map((p) => view(p, 'tile'))}</div>}
      <div
        className="ae-video-grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, '--ae-grid-cols-narrow': narrowColumns, '--ae-grid-count': count, '--ae-grid-rows': Math.ceil(count / columns), '--ae-grid-rows-narrow': Math.ceil(count / narrowColumns) } as CSSProperties}
      >
        {grid.items.map((p) => view(p, 'tile', self(p) ? hideButton : undefined))}
      </div>
      {(grid.pages > 1 || (selfHidden && selfPane)) && (
        <div className="ae-video-pager" role="group" aria-label={t('meeting.grid.pages')}>
          {grid.pages > 1 && (
            <>
              <button type="button" className="ae-mc-btn" onClick={() => setPage(grid.page - 1)} disabled={grid.page === 0}>{t('meeting.grid.previous')}</button>
              <span className="ae-video-pager-text" aria-live="polite">{t('meeting.grid.page', { page: grid.page + 1, count: grid.pages })}</span>
              <button type="button" className="ae-mc-btn" onClick={() => setPage(grid.page + 1)} disabled={grid.page >= grid.pages - 1}>{t('meeting.grid.next')}</button>
            </>
          )}
          {selfHidden && selfPane && showButton}
        </div>
      )}
    </div>
  );
}
