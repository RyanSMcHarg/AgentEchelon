/**
 * THE IN-MEETING CHAT PANEL (SPEC-ASSISTANT-MEETINGS FR71): the header's chat toggle, the panel's header, the T shortcut,
 * the unread chat mark and the sidebar beside the video.
 *
 * The panel holds the meeting's own conversation, the one the meeting window shows (`MeetingWindow`), drawn by the app's
 * own message list and composer: mentions are chips, typing @ opens the picker, the assistants answer there, and the
 * transcription notices and the ended card land there. It is never a separate store.
 *
 * - The header's Chat button opens and closes it, as does T while focus is not in a field.
 * - It sits beneath the meeting's roster in the right column. Two toggles at the column's top show the roster, the chat or
 *   both; the line between them is dragged to give either more room; the column is resized from a splitter at its edge.
 *   The width and the split are remembered in this browser.
 * - While it is closed, the button counts what arrived since it closed, other people's and assistants' messages alike;
 *   opening it clears the count.
 * - Closed, it stays mounted and hidden, so the composer's draft and the thread's place survive; the open state belongs
 *   to the window, so a layout change in the room leaves it as it is.
 * - Once the meeting ends and its conversation is archived, the composer is read-only and says so (`MessageInput`
 *   follows the conversation's `archived` mirror, which the archive's channel update carries live).
 *
 * Outside a `MeetingChatProvider` the panel is the plain right column, always open, and the toggle renders nothing.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ComponentType, type TouchEvent as ReactTouchEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../../providers/ConversationProvider.chime';
import { useAwsClient } from '../../providers/AwsClientProvider';
import { IconChat, IconPeople, IconVideoPane } from './meetingIcons';
import { meetingPanes, paneAfterSwipe, paneForKey, paneShown, SWIPE_EXEMPT, useNarrowWindow, type MeetingPane } from './meetingPanes';
import './MeetingChatPanel.css';

interface MeetingChatState {
  /** The chat is on screen: the panel is open, or on a phone-width screen, the chat is the pane shown. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Messages from others that arrived while the panel was closed. Zero while it is open. */
  unread: number;
  /** A phone-width screen (`meetingPanes.ts`): the window's columns are panes, one on screen at a time. */
  narrow: boolean;
  /** The pane chosen on a phone-width screen; `paneShown` says which is on screen. */
  pane: MeetingPane;
  setPane: (pane: MeetingPane) => void;
  /** The roster is shown in the right column at a wider width. */
  rosterOpen: boolean;
  setRosterOpen: (open: boolean) => void;
}

const MeetingChatContext = createContext<MeetingChatState | null>(null);

/** What the panel has shown: the conversation, the messages it held, and the newest of them. */
interface Seen {
  conversation: string | undefined;
  ids: ReadonlySet<string>;
  latest: number;
  /** The conversation's own messages have been taken in once its load finished, not only the list shown while it loaded. */
  settled: boolean;
}

const timeOf = (t: Date | string | number | undefined) => (t ? new Date(t).getTime() || 0 : 0);

/** A field the person is typing in, where T is a letter rather than the shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function MeetingChatProvider({ children, initiallyOpen = true }: { children: ReactNode; initiallyOpen?: boolean }) {
  const { activeConversation, messages = [], isLoadingMessages } = useConversations();
  const { userArn: viewerArn } = useAwsClient();
  const narrow = useNarrowWindow();
  const [panelOpen, setPanelOpen] = useState(initiallyOpen);
  const [rosterOpen, setRosterOpen] = useState(true);
  const [pane, setPaneState] = useState<MeetingPane>('video');
  // ON A PHONE-WIDTH SCREEN, opening the chat shows its pane and closing it returns to the video, so whatever opens the
  // chat (the roster addressing a member, the T key) works the same at either width.
  const open = narrow ? pane === 'chat' : panelOpen;
  const setPane = useCallback((next: MeetingPane) => {
    setPaneState((was) => {
      // A light tap of the phone on each change of pane, as the sibling project's tab switch gives, where supported.
      if (was !== next) { try { navigator.vibrate?.(10); } catch { /* no vibration here */ } }
      return next;
    });
  }, []);
  const setOpen = useCallback((next: boolean) => {
    if (narrow) setPane(next ? 'chat' : 'video');
    else setPanelOpen(next);
  }, [narrow, setPane]);
  const toggleRef = useRef(() => undefined as void);
  toggleRef.current = () => setOpen(!open);
  const conversation = activeConversation?.conversationArn;
  // What the window opens with has been seen, whichever pane a phone-width screen shows first.
  const [seen, setSeen] = useState<Seen>(() => ({
    conversation,
    ids: new Set(messages.map((m) => m.id)),
    latest: messages.reduce((n, m) => Math.max(n, timeOf(m.timestamp)), 0),
    settled: !isLoadingMessages,
  }));

  // EVERYTHING ON SCREEN COUNTS AS SEEN while the panel is open, while a conversation loads, and when the window
  // switches to another conversation (the room it opened for, then the meeting's own), up to and including the list its
  // load finishes with, which arrives in the same render that ends the load: only what arrives after that, while the
  // panel is closed, is unread.
  const absorbing = open || isLoadingMessages || seen.conversation !== conversation || !seen.settled;
  if (absorbing && (seen.conversation !== conversation || seen.settled !== !isLoadingMessages || messages.some((m) => !seen.ids.has(m.id)))) {
    setSeen({
      conversation,
      ids: new Set(messages.map((m) => m.id)),
      latest: messages.reduce((n, m) => Math.max(n, timeOf(m.timestamp)), 0),
      settled: !isLoadingMessages,
    });
  }
  const unread = absorbing
    ? 0
    : messages.filter((m) => !seen.ids.has(m.id) && m.sender?.arn !== viewerArn && timeOf(m.timestamp) >= seen.latest).length;

  // T OPENS AND CLOSES THE CHAT, unless the person is typing or holds a modifier.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 't' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      // A MODAL DIALOG HOLDS THE KEYBOARD: nothing behind it changes while it asks.
      if (document.querySelector('[aria-modal="true"]')) return;
      toggleRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo(() => ({ open, setOpen, unread, narrow, pane, setPane, rosterOpen, setRosterOpen }), [open, setOpen, unread, narrow, pane, setPane, rosterOpen]);
  return <MeetingChatContext.Provider value={value}>{children}</MeetingChatContext.Provider>;
}

/** The chat panel's open state, for a part of the window that opens it (the roster, addressing a member). Null outside a provider. */
export function useMeetingChat(): Pick<MeetingChatState, 'open' | 'setOpen'> | null {
  return useContext(MeetingChatContext);
}

/** The header's Chat button: pressed while the panel is open, with the unread count while it is closed. */
export function MeetingChatToggle() {
  const { t } = useTranslation();
  const chat = useContext(MeetingChatContext);
  // On a phone-width screen the tab bar's Chat tab does this, with the same count.
  if (!chat || chat.narrow) return null;
  return (
    <button
      type="button"
      className={`ae-mc-btn ae-mc-btn--icon ae-meeting-chat-toggle${chat.open ? ' ae-mc-btn--on' : ''}`}
      aria-pressed={chat.open}
      aria-controls="ae-meeting-chat-panel"
      // The button's name carries the count: a name set here replaces what the button holds, the count's own label included.
      aria-label={chat.unread > 0 ? t('meeting.chat.titleUnread', { count: chat.unread }) : t('meeting.chat.title')}
      title={t(chat.open ? 'meeting.chat.hide' : 'meeting.chat.show')}
      onClick={() => chat.setOpen(!chat.open)}
      data-testid="meeting-chat-toggle"
    >
      <IconChat />
      {chat.unread > 0 && (
        <span className="ae-meeting-chat-unread" data-testid="meeting-chat-unread" aria-hidden="true">
          {chat.unread > 99 ? '99+' : chat.unread}
        </span>
      )}
    </button>
  );
}

/** THE RIGHT COLUMN'S WIDTH, remembered per viewer in this browser, within bounds. */
const SIDE_WIDTH_KEY = 'ae.meeting.sideWidth';
const SIDE_MIN = 280;
const SIDE_MAX = 640;
const SIDE_DEFAULT = 380;
const SIDE_STEP = 16;
const clampSide = (w: number) => Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)));
function storedSideWidth(): number {
  try {
    const v = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    return Number.isFinite(v) && v > 0 ? clampSide(v) : SIDE_DEFAULT;
  } catch {
    return SIDE_DEFAULT;
  }
}
function keepSideWidth(w: number): void {
  try { localStorage.setItem(SIDE_WIDTH_KEY, String(w)); } catch { /* the width lasts this window only */ }
}

/**
 * THE SPLITTER between the video and the right column: dragged with a pointer, or moved with the arrow keys (Home and End
 * for the narrowest and widest), within bounds; the width is remembered in this browser. Not shown where the column sits
 * beneath the meeting (a narrow window).
 */
function SideSplitter({ width, onWidth, onSettle }: {
  width: number;
  /** The width as it moves. */
  onWidth: (w: number) => void;
  /** The width it was left at (the drag let go, a key pressed), which is the one remembered. */
  onSettle: (w: number) => void;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; w: number; last: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width, last: width };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the drag follows the element */ }
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The column is at the right: moving left widens it.
    drag.current.last = clampSide(drag.current.w + (drag.current.x - e.clientX));
    onWidth(drag.current.last);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onSettle(drag.current.last);
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released with the pointer */ }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowLeft' ? width + SIDE_STEP
      : e.key === 'ArrowRight' ? width - SIDE_STEP
        : e.key === 'Home' ? SIDE_MIN
          : e.key === 'End' ? SIDE_MAX : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(clampSide(next));
    onSettle(clampSide(next));
  };
  return (
    <div
      className="ae-meeting-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('meeting.chat.resize')}
      title={t('meeting.chat.resize')}
      aria-controls="ae-meeting-side"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      data-testid="meeting-side-splitter"
    />
  );
}

/** THE ROSTER'S SHARE OF THE COLUMN while the chat shows beneath it, remembered per viewer in this browser, within bounds. */
const SPLIT_KEY = 'ae.meeting.rosterShare';
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;
const SPLIT_DEFAULT = 0.4;
const SPLIT_STEP = 0.05;
const clampSplit = (v: number) => Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) * 100) / 100;
function storedSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(v) && v > 0 ? clampSplit(v) : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}
function keepSplit(v: number): void {
  try { localStorage.setItem(SPLIT_KEY, String(v)); } catch { /* the split lasts this window only */ }
}

/**
 * THE LINE BETWEEN THE ROSTER AND THE CHAT: dragged up or down with a pointer, or moved with the arrow keys (Home and End for
 * the least and most room for the roster), within bounds; the split is remembered in this browser.
 */
function RosterChatSplitter({ share, column, onShare, onSettle }: {
  share: number;
  column: () => HTMLElement | null;
  onShare: (v: number) => void;
  onSettle: (v: number) => void;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ top: number; height: number; last: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = column()?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    drag.current = { top: rect.top, height: rect.height, last: share };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the drag follows the element */ }
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.last = clampSplit((e.clientY - drag.current.top) / drag.current.height);
    onShare(drag.current.last);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onSettle(drag.current.last);
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released with the pointer */ }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowDown' ? share + SPLIT_STEP
      : e.key === 'ArrowUp' ? share - SPLIT_STEP
        : e.key === 'Home' ? SPLIT_MIN
          : e.key === 'End' ? SPLIT_MAX : null;
    if (next === null) return;
    e.preventDefault();
    onShare(clampSplit(next));
    onSettle(clampSplit(next));
  };
  return (
    <div
      className="ae-meeting-rowsplitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('meeting.side.split')}
      title={t('meeting.side.split')}
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      data-testid="meeting-roster-chat-splitter"
    />
  );
}

/**
 * THE RIGHT COLUMN: two toggles at its top show the meeting's roster, its chat, or both (one always stays on), the roster
 * above the chat with a line between them that gives either more room. With neither, the column closes and the stage takes
 * the whole width; the header's Chat button opens the chat again. The column is resized from the splitter at its edge.
 */
export function MeetingChatPanel({ children, roster }: { children: ReactNode; roster?: ReactNode }) {
  const { t } = useTranslation();
  const chat = useContext(MeetingChatContext);
  const [width, setWidth] = useState(storedSideWidth);
  const [share, setShare] = useState(storedSplit);
  const columnRef = useRef<HTMLElement | null>(null);

  if (!chat) return <aside className="ae-meeting-chat">{roster}{children}</aside>;
  // ON A PHONE-WIDTH SCREEN the column holds whichever of the roster and the chat is the pane shown, and no splitter.
  const shown = chat.narrow ? paneShown(chat.pane, meetingPanes({ people: !!roster, chat: !!children })) : null;
  const rosterShown = shown ? shown === 'people' : !!roster && chat.rosterOpen;
  const chatShown = shown ? shown === 'chat' : chat.open;
  const columnShown = shown ? shown !== 'video' : rosterShown || chatShown;
  const both = !shown && rosterShown && chatShown;
  const tabpanel = (pane: MeetingPane) => (shown ? { role: 'tabpanel', 'aria-labelledby': paneTabId(pane) } : {});
  return (
    <>
      {columnShown && !shown && <SideSplitter width={width} onWidth={setWidth} onSettle={keepSideWidth} />}
      <aside
        id="ae-meeting-side"
        ref={columnRef}
        className={`ae-meeting-side${shown ? ' ae-meeting-side--pane' : ''}`}
        hidden={!columnShown}
        style={{ '--ae-meeting-side-width': `${width}px` } as CSSProperties}
        data-testid="meeting-side"
      >
        {!shown && roster && (
          <div className="ae-meeting-side-views" role="group" aria-label={t('meeting.side.views')} data-testid="meeting-side-views">
            <button
              type="button"
              className={`ae-meeting-side-view${rosterShown ? ' ae-meeting-side-view--on' : ''}`}
              aria-pressed={rosterShown}
              // ONE VIEW ALWAYS STAYS ON from here, so the column never closes under the person's hand.
              disabled={rosterShown && !chatShown}
              onClick={() => chat.setRosterOpen(!rosterShown)}
              data-testid="meeting-side-view-people"
            >
              <IconPeople /><span>{t('meeting.panes.people')}</span>
            </button>
            <button
              type="button"
              className={`ae-meeting-side-view${chatShown ? ' ae-meeting-side-view--on' : ''}`}
              aria-pressed={chatShown}
              aria-controls="ae-meeting-chat-panel"
              disabled={chatShown && !rosterShown}
              onClick={() => chat.setOpen(!chatShown)}
              data-testid="meeting-side-view-chat"
            >
              <IconChat /><span>{t('meeting.panes.chat')}</span>
              {/* WHAT ARRIVED WHILE THE CHAT WAS HIDDEN, counted on its toggle, which is the one way to show it at this width. */}
              {!chatShown && chat.unread > 0 && (
                <span className="ae-meeting-chat-unread" data-testid="meeting-side-view-unread">
                  <span aria-hidden="true">{chat.unread > 99 ? '99+' : chat.unread}</span>
                  <span className="ae-meeting-visually-hidden">{t('meeting.chat.unread', { count: chat.unread })}</span>
                </span>
              )}
            </button>
          </div>
        )}
        {roster && (
          <div
            id={PANE_IDS.people}
            className="ae-meeting-side-roster"
            hidden={!rosterShown}
            style={both ? { flex: `0 0 ${share * 100}%`, maxHeight: 'none' } : undefined}
            {...tabpanel('people')}
          >
            {roster}
          </div>
        )}
        {both && <RosterChatSplitter share={share} column={() => columnRef.current} onShare={setShare} onSettle={keepSplit} />}
        <section
          id="ae-meeting-chat-panel"
          className="ae-meeting-chat ae-meeting-chat--panel"
          aria-label={t('meeting.chat.title')}
          hidden={!chatShown}
          data-testid="meeting-chat-panel"
          {...tabpanel('chat')}
        >
          <div className="ae-meeting-chat-panel-body">{children}</div>
        </section>
      </aside>
    </>
  );
}

/** Each pane's element and its tab, so a tab names the pane it shows and the pane is labelled by its tab. */
export const PANE_IDS: Record<MeetingPane, string> = {
  video: 'ae-meeting-pane-video',
  people: 'ae-meeting-pane-people',
  chat: 'ae-meeting-chat-panel',
};
export const paneTabId = (pane: MeetingPane) => `ae-meeting-tab-${pane}`;

/** What the room needs of the panes: null at a wider width or outside a provider, where every column is on screen. */
export interface MeetingPanesState {
  panes: MeetingPane[];
  shown: MeetingPane;
  /** The touch handlers that turn a horizontal swipe across the window into the next or the previous pane. */
  swipe: {
    onTouchStart: (e: ReactTouchEvent) => void;
    onTouchMove: (e: ReactTouchEvent) => void;
    onTouchEnd: () => void;
  };
}

/**
 * THE PANES ON A PHONE-WIDTH SCREEN, for the room: which are there (the roster and the chat only where the window holds
 * them), which is shown, and the swipe across the window that moves between them (the sibling project's touch handlers:
 * the travel from the first touch to the last, never from a touch that starts on a control).
 */
export function useMeetingPanes({ people, chat }: { people: boolean; chat: boolean }): MeetingPanesState | null {
  const state = useContext(MeetingChatContext);
  const from = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  if (!state?.narrow || (!people && !chat)) return null;
  const panes = meetingPanes({ people, chat });
  const shown = paneShown(state.pane, panes);
  return {
    panes,
    shown,
    swipe: {
      onTouchStart: (e) => {
        const touch = e.touches[0];
        const target = e.target as Element | null;
        from.current = !touch || e.touches.length > 1 || target?.closest?.(SWIPE_EXEMPT)
          ? null
          : { x: touch.clientX, y: touch.clientY, dx: 0, dy: 0 };
      },
      onTouchMove: (e) => {
        const touch = e.touches[0];
        if (!from.current || !touch) return;
        from.current.dx = touch.clientX - from.current.x;
        from.current.dy = touch.clientY - from.current.y;
      },
      onTouchEnd: () => {
        const travel = from.current;
        from.current = null;
        if (!travel) return;
        const next = paneAfterSwipe(shown, panes, travel.dx, travel.dy);
        if (next !== shown) state.setPane(next);
      },
    },
  };
}

const PANE_ICON: Record<MeetingPane, ComponentType> = { video: IconVideoPane, people: IconPeople, chat: IconChat };

/**
 * THE TAB BAR AT THE FOOT OF A PHONE-WIDTH WINDOW (the sibling project's bottom tabs): a tab for each pane, its icon and
 * its name, the chat's carrying the count of what arrived while another pane was shown. It is the swipe's indicator and
 * its alternative: a tab, or the arrow keys along the bar, shows the same pane a swipe does.
 */
export function MeetingPaneTabs({ panes }: { panes: MeetingPanesState | null }) {
  const { t } = useTranslation();
  const chat = useContext(MeetingChatContext);
  const refs = useRef<Partial<Record<MeetingPane, HTMLButtonElement | null>>>({});
  if (!panes || !chat) return null;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = paneForKey(panes.shown, panes.panes, e.key);
    if (!next) return;
    e.preventDefault();
    chat.setPane(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      className="ae-meeting-pane-tabs"
      role="tablist"
      aria-label={t('meeting.panes.label')}
      aria-describedby="ae-meeting-pane-hint"
      onKeyDown={onKeyDown}
      data-testid="meeting-pane-tabs"
    >
      <span id="ae-meeting-pane-hint" className="ae-meeting-visually-hidden">{t('meeting.panes.hint')}</span>
      {panes.panes.map((pane) => {
        const Icon = PANE_ICON[pane];
        const selected = pane === panes.shown;
        const unread = pane === 'chat' && chat.unread > 0 ? chat.unread : 0;
        return (
          <button
            key={pane}
            ref={(el) => { refs.current[pane] = el; }}
            type="button"
            role="tab"
            id={paneTabId(pane)}
            aria-selected={selected}
            aria-controls={PANE_IDS[pane]}
            tabIndex={selected ? 0 : -1}
            className={`ae-meeting-pane-tab${selected ? ' ae-meeting-pane-tab--active' : ''}`}
            onClick={() => chat.setPane(pane)}
            data-testid={`meeting-pane-tab-${pane}`}
          >
            <span className="ae-meeting-pane-tab-icon" aria-hidden="true"><Icon /></span>
            <span className="ae-meeting-pane-tab-label">{t(`meeting.panes.${pane}`)}</span>
            {unread > 0 && (
              <span className="ae-meeting-chat-unread ae-meeting-pane-tab-badge" data-testid="meeting-pane-unread">
                <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                <span className="ae-meeting-visually-hidden">{t('meeting.chat.unread', { count: unread })}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
