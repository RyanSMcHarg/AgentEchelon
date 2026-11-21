/**
 * THE MEETING'S ROSTER, at the top of the meeting window's right column, above the meeting's chat (`MeetingWindow`).
 *
 * The people of the meeting's conversation, each with their state in the meeting (SPEC-ASSISTANT-MEETINGS FR54): those in
 * the meeting in a list at the top, and those who are not (left, never joined, or removed by a host) in a list at the bottom; and, while in it, speaking, muted (by themselves or by a host) or with no
 * audio connected, a network losing their audio, camera on, sharing. The person the active-speaker detector names now is
 * highlighted. Anyone in the meeting who is not listed as a member yet still has a row; the conversation's assistants are
 * listed apart, after the people.
 *
 * A HOST'S CONTROLS (FR59) show to a host alone: mute or let speak each person who is not a host, remove them, allow or
 * dismiss each person asking to speak, and, behind one icon at the top of the roster, mute or let everyone but the hosts
 * speak. The server checks the host again for each; the roster only offers.
 *
 * ADDRESSING A MEMBER FROM THE ROSTER: clicking a person or an assistant puts a mention of them in the meeting chat's
 * composer, drawn as the same chip the composer's own picker makes (`utils/composerRequests.ts`). Right-click, or the
 * row's More button for the keyboard, offers Message privately, which starts a message to that member alone.
 *
 * Compact and collapsible, so the chat beneath it keeps the rest of the column; the choice is remembered in this browser.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelMember } from '@ae/shared';
import { useMeeting, type MeetingAttendee, type MeetingTile } from '../../providers/MeetingProvider';
import { useMeetingSignals } from '../../providers/meetingSignals';
import { useConversations } from '../../providers/ConversationProvider.chime';
import { chimeService } from '../../services/chimeService';
import { ActivityIndicators, AudioIndicators } from './MeetingIndicators';
import { requestComposerAddress, type ComposerAddressMode } from '../../utils/composerRequests';
import { useMeetingChat } from './MeetingChatPanel';
import { IconMore, IconShield } from './meetingIcons';
import './MeetingRoster.css';

const COLLAPSED_KEY = 'ae.meeting.rosterCollapsed';

/** One person on the roster and their state in the meeting. */
export interface RosterPerson {
  personId: string;
  name?: string;
  isYou: boolean;
  /** A host of the meeting (`meeting-host.ts`). */
  isHost: boolean;
  inMeeting: boolean;
  /** Not in the meeting now, and seen in it earlier: they left, as opposed to never having joined. */
  left: boolean;
  /** A host removed them from this meeting. */
  removed: boolean;
  /** Speaking now, by their volume (debounced, `meetingSignals.tsx`). */
  speaking: boolean;
  /** The speaker the active-speaker detector names now. */
  activeSpeaker: boolean;
  /** Undefined while the service has not reported their audio. */
  muted?: boolean;
  /** A host stopped their audio. */
  mutedByHost: boolean;
  /** In the meeting with no audio reported by the service: no microphone or speaker connected. */
  noAudio: boolean;
  camera: boolean;
  sharing: boolean;
  /** The network loses much of their audio (signal strength, debounced), or the viewer's own session is reconnecting. */
  weakConnection: boolean;
}

/** The person id an AppInstanceUser or AppInstanceBot ARN ends in. */
const idOf = (arn: string): string => arn.split('/').pop() || arn;

/**
 * THE ROSTER'S PEOPLE AND ASSISTANTS. People: the conversation's human members and anyone in the meeting not yet among
 * them, those in the meeting first, then by name. The viewer's own mute and camera are their session's (`self`), which
 * the service does not echo back for its own attendee.
 */
export function meetingRosterOf(args: {
  members: readonly ChannelMember[];
  attendees: readonly MeetingAttendee[];
  tiles: readonly MeetingTile[];
  /**
   * Every remote video published in the meeting, by attendee id, whether or not this viewer receives it now: a person on
   * another page of the grid still has their camera on.
   */
  videoSources?: readonly string[];
  activeSpeaker?: string;
  selfId?: string;
  /** The meeting's hosts, by person id. */
  hostIds?: readonly string[];
  /** Who left the meeting and has not come back, by person id. */
  leftIds?: readonly string[];
  /** Who a host removed, by person id. */
  removedIds?: ReadonlySet<string> | readonly string[];
  /** Who a host stopped from speaking, by person id. */
  hostMutedIds?: ReadonlySet<string>;
  /** Attendees speaking now, and attendees on a poor network, by attendee id. */
  speakingIds?: ReadonlySet<string>;
  poorSignalIds?: ReadonlySet<string>;
  self: { muted: boolean; cameraOn: boolean; sharing: boolean; reconnecting: boolean };
}): { people: RosterPerson[]; assistants: ChannelMember[] } {
  const byPerson = new Map<string, MeetingAttendee>();
  for (const a of args.attendees) if (a.personId) byPerson.set(a.personId, a);
  const humans = args.members.filter((m) => !m.isBot);
  const ids = [...humans.map((m) => idOf(m.userArn)), ...[...byPerson.keys()].filter((id) => !humans.some((m) => idOf(m.userArn) === id))];
  const nameOf = new Map(humans.map((m) => [idOf(m.userArn), m.name]));
  const removedIds = new Set(args.removedIds ?? []);

  const people = [...new Set(ids)].map((personId): RosterPerson => {
    const attendee = byPerson.get(personId);
    const isYou = !!args.selfId && personId === args.selfId;
    const inMeeting = !!attendee;
    const camera = inMeeting && (isYou ? args.self.cameraOn
      : !!args.videoSources?.includes(attendee.attendeeId) || args.tiles.some((t) => !t.isContent && t.attendeeId === attendee.attendeeId));
    const sharing = inMeeting && (isYou ? args.self.sharing : args.tiles.some((t) => t.isContent && t.attendeeId.split('#')[0] === attendee.attendeeId));
    const muted = !inMeeting ? undefined : isYou ? args.self.muted : attendee.muted;
    const poor = inMeeting && (args.poorSignalIds ? args.poorSignalIds.has(attendee.attendeeId) : attendee.weakSignal === true);
    return {
      personId,
      ...(nameOf.get(personId) ? { name: nameOf.get(personId) } : {}),
      isYou,
      isHost: !!args.hostIds?.includes(personId),
      inMeeting,
      removed: !inMeeting && removedIds.has(personId),
      left: !inMeeting && !removedIds.has(personId) && !!args.leftIds?.includes(personId),
      speaking: inMeeting && !!args.speakingIds?.has(attendee.attendeeId),
      activeSpeaker: inMeeting && args.activeSpeaker === attendee.attendeeId,
      ...(muted !== undefined ? { muted } : {}),
      mutedByHost: inMeeting && !!args.hostMutedIds?.has(personId),
      noAudio: inMeeting && muted === undefined,
      camera,
      sharing,
      weakConnection: poor || (inMeeting && isYou && args.self.reconnecting),
    };
  });
  people.sort((a, b) => Number(b.inMeeting) - Number(a.inMeeting) || (a.name || '').localeCompare(b.name || ''));
  const assistants = args.members.filter((m) => m.isBot).slice().sort((a, b) => a.name.localeCompare(b.name));
  return { people, assistants };
}

function storedCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}

/** Why a person not in the meeting is not in it, where there is a why: removed by a host, or left. */
const awayKey = (p: RosterPerson): string => (p.removed ? 'meeting.roster.removed' : 'meeting.roster.left');

/** A member the roster can address in the chat. */
type Addressable = Pick<ChannelMember, 'userArn' | 'name' | 'isBot'>;

/**
 * A ROW'S MENU (right-click, or its More button): Mention, and Message privately. Escape or a click outside closes it,
 * and Escape returns focus to the row's More button. The arrow keys move between its items.
 */
function AddressMenu({ name, onPick, onClose, returnTo, at }: {
  name: string; onPick: (mode: ComposerAddressMode) => void; onClose: () => void; returnTo: HTMLElement | null;
  /** Where it opens, in the viewport: under the More button, or at the pointer. Fixed, so a scrolled roster never clips it. */
  at: { top: number; left: number };
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // FOCUS GOES TO THE FIRST ITEM ONCE, AS THE MENU OPENS: the roster re-renders as people speak, and focus stays on the
  // item the arrow keys moved it to. The newest `onClose` is read when a click lands outside.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // THE BUTTON THAT OPENED IT IS NOT OUTSIDE IT: a press there is the button's own, which closes the menu, so the press
  // never closes it here only for the click to open it again.
  const opener = useRef(returnTo);
  opener.current = returnTo;
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || opener.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); onClose(); returnTo?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
  };
  return (
    <div ref={ref} className="ae-meeting-roster-menu" style={{ top: at.top, left: at.left }} role="menu" aria-label={t('meeting.roster.menuFor', { name })} onKeyDown={onKeyDown} data-testid="meeting-roster-menu">
      <button type="button" role="menuitem" className="ae-meeting-roster-menu-item" onClick={() => { onPick('mention'); onClose(); }}>
        {t('meeting.roster.mention')}
      </button>
      <button type="button" role="menuitem" className="ae-meeting-roster-menu-item" onClick={() => { onPick('private'); onClose(); }}>
        {t('meeting.roster.messagePrivately')}
      </button>
    </div>
  );
}

/** The roster of the conversation the meeting window shows, which is the meeting's own once a start or a join names it. */
export default function MeetingRoster() {
  const { t } = useTranslation();
  const meeting = useMeeting();
  const signals = useMeetingSignals();
  const chat = useMeetingChat();
  const { channelMembers: members } = useConversations();
  const selfArn = chimeService.getUserArn();
  const selfId = selfArn ? idOf(selfArn) : undefined;
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [hostMenuOpen, setHostMenuOpen] = useState(false);
  /** The row whose menu is open, by member ARN, and the element focus returns to when it closes. */
  const [menuFor, setMenuFor] = useState<{ arn: string; returnTo: HTMLElement | null; at: { top: number; left: number } } | null>(null);
  /** Where a menu opens under an element, kept inside the window. */
  const under = (el: HTMLElement | null): { top: number; left: number } => {
    const r = el?.getBoundingClientRect();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    return r ? { top: r.bottom + 4, left: Math.max(8, Math.min(r.right - 200, vw - 208)) } : { top: 0, left: 0 };
  };
  const toggle = () => {
    setCollapsed((was) => {
      try { localStorage.setItem(COLLAPSED_KEY, was ? '0' : '1'); } catch { /* the choice lasts this window only */ }
      return !was;
    });
  };

  const { people, assistants } = meetingRosterOf({
    members,
    attendees: meeting.attendees ?? [],
    tiles: meeting.tiles ?? [],
    videoSources: meeting.videoSources ?? [],
    activeSpeaker: meeting.activeSpeaker,
    selfId,
    hostIds: meeting.hostIds ?? [],
    leftIds: meeting.leftPersonIds ?? [],
    removedIds: signals.removed,
    hostMutedIds: signals.hostMuted,
    speakingIds: signals.speaking,
    poorSignalIds: signals.poorSignal,
    self: { muted: !!meeting.muted, cameraOn: !!meeting.cameraOn, sharing: !!meeting.sharing, reconnecting: meeting.status === 'reconnecting' },
  });
  const joined = people.filter((p) => p.inMeeting);
  const away = people.filter((p) => !p.inMeeting);
  const inMeeting = joined.length;
  const connected = meeting.status === 'joined' || meeting.status === 'reconnecting';
  // A host's controls, offered only to a host in the meeting; the server checks the host again.
  const hostControls = connected && !!meeting.isHost;
  // Who can be addressed: the conversation's members other than the viewer, by person id.
  const memberOf = new Map(members.filter((m) => m.userArn !== selfArn).map((m) => [idOf(m.userArn), m]));

  const address = (member: Addressable, mode: ComposerAddressMode) => {
    // The chat opens, so the person sees the draft the roster wrote.
    chat?.setOpen(true);
    requestComposerAddress({ member, mode });
  };
  const closeMenu = () => setMenuFor(null);
  const onContextMenu = (member: Addressable | undefined) => (e: ReactMouseEvent<HTMLElement>) => {
    if (!member) return;
    e.preventDefault();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    setMenuFor({ arn: member.userArn, returnTo: e.currentTarget.querySelector<HTMLElement>('.ae-meeting-roster-more'), at: { top: e.clientY, left: Math.max(8, Math.min(e.clientX, vw - 208)) } });
  };

  /** A row's name: a button that mentions the member, where they can be addressed; else their name as text. */
  const who = (member: Addressable | undefined, label: string, extra?: ReactNode) => (member ? (
    <button
      type="button"
      className="ae-meeting-roster-name ae-meeting-roster-who"
      onClick={() => address(member, 'mention')}
      title={t('meeting.roster.mentionHint', { name: label })}
    >
      {label}{extra}
    </button>
  ) : <span className="ae-meeting-roster-name">{label}{extra}</span>);
  /** A row's More button and its menu, where the member can be addressed. */
  const more = (member: Addressable | undefined, label: string) => member && (
    <span className="ae-meeting-roster-more-wrap">
      <button
        type="button"
        className="ae-meeting-roster-more"
        aria-label={t('meeting.roster.menuFor', { name: label })}
        title={t('meeting.roster.menuFor', { name: label })}
        aria-haspopup="menu"
        aria-expanded={menuFor?.arn === member.userArn}
        onClick={(e) => (menuFor?.arn === member.userArn ? closeMenu() : setMenuFor({ arn: member.userArn, returnTo: e.currentTarget, at: under(e.currentTarget) }))}
      >
        <IconMore />
      </button>
      {menuFor?.arn === member.userArn && (
        <AddressMenu name={label} returnTo={menuFor.returnTo} at={menuFor.at} onClose={closeMenu} onPick={(mode) => address(member, mode)} />
      )}
    </span>
  );

  /** One person's row, in whichever list they belong to. */
  const personRow = (p: RosterPerson) => {
              const member = p.isYou ? undefined : memberOf.get(p.personId);
              const label = p.name || t('meeting.participant');
              return (
                <li
                  key={p.personId}
                  className={`ae-meeting-roster-row${p.inMeeting ? '' : ' ae-meeting-roster-row--away'}${p.activeSpeaker ? ' ae-meeting-roster-row--speaking' : ''}`}
                  data-testid="meeting-roster-person"
                  onContextMenu={onContextMenu(member)}
                >
                  <span className="ae-meeting-roster-avatar" aria-hidden="true">{(p.name || '?').trim().charAt(0).toUpperCase()}</span>
                  {who(member, label, (
                    <>
                      {p.isYou && <span className="ae-meeting-roster-you"> {t('meeting.roster.youSuffix')}</span>}
                      {p.isHost && <span className="ae-meeting-host"> {t('meeting.host')}</span>}
                    </>
                  ))}
                  <span className="ae-meeting-roster-state">
                    {/* A PERSON NOT IN THE MEETING SAYS WHY WHERE THERE IS A WHY (left, removed): the list's heading says the rest. */}
                    {(p.left || p.removed) && <span className="ae-meeting-roster-tag">{t(awayKey(p))}</span>}
                    {p.inMeeting && (
                      <>
                        <ActivityIndicators micOn={p.muted === false && !p.mutedByHost} speaking={p.speaking && p.muted === false} camera={p.camera} sharing={p.sharing} />
                        <AudioIndicators muted={p.muted === true} mutedByHost={p.mutedByHost} poorNetwork={p.weakConnection} isYou={p.isYou} heldForNotice={p.isYou && !!meeting.mutedForNotice} />
                        {p.noAudio && <span className="ae-meeting-roster-tag">{t('meeting.roster.noAudio')}</span>}
                      </>
                    )}
                    {hostControls && p.inMeeting && !p.isYou && !p.isHost && (
                      <>
                        <button type="button" className="ae-meeting-roster-ctl" onClick={() => { void signals.setSpeaking(p.personId, p.mutedByHost); }}>
                          {t(p.mutedByHost ? 'meeting.roster.allow' : 'meeting.roster.mute')}
                        </button>
                        {confirmingRemove === p.personId ? (
                          <button type="button" className="ae-meeting-roster-ctl ae-meeting-roster-ctl--danger" onClick={() => { setConfirmingRemove(null); void signals.remove(p.personId); }}>
                            {t('meeting.roster.confirmRemove')}
                          </button>
                        ) : (
                          <button type="button" className="ae-meeting-roster-ctl" onClick={() => setConfirmingRemove(p.personId)}>{t('meeting.roster.remove')}</button>
                        )}
                      </>
                    )}
                    {more(member, label)}
                  </span>
                </li>
              );
            };

  return (
    <section className="ae-meeting-roster" aria-label={t('meeting.roster.title')} data-testid="meeting-roster">
      <div className="ae-meeting-roster-top">
        <button type="button" className="ae-meeting-roster-head" aria-expanded={!collapsed} onClick={toggle}>
          <span className="ae-meeting-roster-title">{t('meeting.roster.title')}</span>
          <span className="ae-meeting-roster-count">{t('meeting.roster.count', { inMeeting, total: people.length })}</span>
          <span className="ae-meeting-roster-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
        {/* EVERYONE'S CONTROLS, to a host alone, behind one icon at the top of the roster. */}
        {hostControls && (
          <span className="ae-meeting-roster-hostwrap">
            <button
              type="button"
              className={`ae-meeting-roster-hostbtn${hostMenuOpen ? ' ae-meeting-roster-hostbtn--on' : ''}`}
              aria-label={t('meeting.roster.hostControls')}
              title={t('meeting.roster.hostControls')}
              aria-expanded={hostMenuOpen}
              aria-controls="ae-meeting-roster-hostbar"
              onClick={() => setHostMenuOpen((o) => !o)}
              data-testid="meeting-roster-host-controls"
            >
              <IconShield />
            </button>
          </span>
        )}
      </div>
      {hostControls && hostMenuOpen && (
        <div id="ae-meeting-roster-hostbar" className="ae-meeting-roster-hostbar" role="group" aria-label={t('meeting.roster.hostControls')}>
          <button type="button" className="ae-meeting-roster-ctl" onClick={() => { setHostMenuOpen(false); void signals.setSpeaking('all', false); }}>{t('meeting.roster.muteAll')}</button>
          <button type="button" className="ae-meeting-roster-ctl" onClick={() => { setHostMenuOpen(false); void signals.setSpeaking('all', true); }}>{t('meeting.roster.allowAll')}</button>
        </div>
      )}
      {!collapsed && (
        <div className="ae-meeting-roster-body">
          {/* WHO ASKS TO SPEAK, to a host alone (FR59): Allow lets them speak, Dismiss keeps them muted. */}
          {hostControls && [...signals.asking].filter((id) => id !== selfId).map((id) => (
            <div key={id} className="ae-meeting-roster-ask" role="status" data-testid="meeting-roster-ask">
              <span>{t('meeting.roster.asksToSpeak', { name: people.find((p) => p.personId === id)?.name || t('meeting.participant') })}</span>
              <button type="button" className="ae-meeting-roster-ctl" onClick={() => { void signals.setSpeaking(id, true); }}>{t('meeting.roster.allowRequest')}</button>
              <button type="button" className="ae-meeting-roster-ctl" onClick={() => { void signals.dismiss(id); }}>{t('meeting.roster.dismissRequest')}</button>
            </div>
          ))}
          {signals.controlError && (
            <p className="ae-meeting-roster-error" role="alert">
              {t([`meeting.roster.errors.${signals.controlError}`, 'meeting.roster.errors.CONTROL_FAILED'])}
            </p>
          )}
          <ul className="ae-meeting-roster-list" data-testid="meeting-roster-joined">{joined.map(personRow)}</ul>
          {assistants.length > 0 && (
            <>
              <div className="ae-meeting-roster-subhead">{t('meeting.roster.assistants')}</div>
              <ul className="ae-meeting-roster-list">
                {assistants.map((a) => (
                  <li key={a.userArn} className="ae-meeting-roster-row ae-meeting-roster-row--assistant" data-testid="meeting-roster-assistant" onContextMenu={onContextMenu(a)}>
                    <span className="ae-meeting-roster-avatar" aria-hidden="true">{a.name.trim().charAt(0).toUpperCase()}</span>
                    {who(a, a.name)}
                    <span className="ae-meeting-roster-state">{more(a, a.name)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {away.length > 0 && (
            <>
              <div className="ae-meeting-roster-subhead">{t('meeting.roster.notInMeetingHeading')}</div>
              <ul className="ae-meeting-roster-list" data-testid="meeting-roster-away">{away.map(personRow)}</ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
