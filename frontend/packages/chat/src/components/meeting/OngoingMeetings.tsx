/**
 * MEETINGS NOW, at the top of the app's navigation: every meeting running in the person's conversations that they can
 * join, as `POST /meetings/mine` answers (`useOngoingMeetings`), with its name, a live mark, how long it has run, and one action.
 *
 * ALREADY IN IT IN ANOTHER WINDOW OR TAB of this browser (`meetingPresence.ts`): the row says so ("In this meeting") and
 * its action is Return, which brings that window forward and never opens a second one, as the sibling project's widget
 * offers "Return to meeting" while its pop-out meeting window is open. A window the browser will not raise is named
 * instead, so the person is never offered a second join of a meeting they are connected to. Otherwise Join opens its
 * meeting window, where they join. A meeting leaves the list when its ended card arrives (`useOngoingMeetings`).
 * Nothing shows while none runs.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../../providers/ConversationProvider.chime';
import { channelArnOf, useOngoingMeetings } from '../../hooks/useOngoingMeetings';
import type { MyMeeting } from '../../services/meetingService';
import { bringMeetingWindowForward, openMeetingWindow } from '../../utils/meetingWindow';
import { askMeetingWindowForward, watchMeetingPresenceAs } from '../../services/meetingPresence';
import './OngoingMeetings.css';

/** How long a meeting has run, in the reader's words: under a minute, minutes, or hours and minutes. */
export function runningFor(startedAt: string | undefined, now: number, t: (key: string, o?: Record<string, unknown>) => string): string | null {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return null;
  const minutes = Math.max(0, Math.floor((now - start) / 60000));
  if (minutes < 1) return t('meeting.ongoing.justStarted');
  if (minutes < 60) return t('meeting.ongoing.minutes', { minutes });
  return t('meeting.ongoing.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function OngoingRow({ meeting, title, now }: { meeting: MyMeeting; title: string; now: number }) {
  const { t } = useTranslation();
  // IN IT ALREADY, in another window of this browser, under any name the meeting goes by.
  const [inIt, setInIt] = useState(false);
  // The window could not be raised from here: the person is told it is open in another tab of theirs.
  const [elsewhere, setElsewhere] = useState(false);
  useEffect(() => watchMeetingPresenceAs([meeting.conversationId, meeting.roomConversationId], (here) => {
    setInIt(here);
    if (!here) setElsewhere(false);
  }), [meeting.conversationId, meeting.roomConversationId]);
  const elapsed = runningFor(meeting.startedAt, now, t);
  const room = channelArnOf(meeting.conversationId);
  const act = () => {
    if (!inIt) { openMeetingWindow(room, meeting.conversationId); return; }
    // RETURN: the window that holds the meeting comes forward; it is never opened a second time.
    askMeetingWindowForward([meeting.conversationId, meeting.roomConversationId]);
    if (!bringMeetingWindowForward(room, meeting.conversationId)) setElsewhere(true);
  };
  return (
    <li className="ae-ongoing-row" data-testid="ongoing-meeting" data-meeting={meeting.conversationId}>
      <span className="ae-ongoing-live" aria-hidden="true" />
      <span className="ae-ongoing-text">
        <span className="ae-ongoing-title" title={title}>{title}</span>
        <span className="ae-ongoing-meta">
          <span className="ae-ongoing-badge">{t('meeting.ongoing.live')}</span>
          {elapsed && <span>{elapsed}</span>}
          {inIt && <span className="ae-ongoing-in" data-testid="ongoing-in-meeting">{t('meeting.ongoing.inMeeting')}</span>}
        </span>
        {elsewhere && <span className="ae-ongoing-elsewhere" role="status">{t('meeting.ongoing.inAnotherTab')}</span>}
      </span>
      <button
        type="button"
        className="ae-ongoing-action"
        aria-label={t(inIt ? 'meeting.ongoing.returnLabel' : 'meeting.ongoing.joinLabel', { title })}
        title={t(inIt ? 'meeting.ongoing.returnLabel' : 'meeting.ongoing.joinLabel', { title })}
        // From the meeting's own conversation, which the person is a member of.
        onClick={act}
      >
        {t(inIt ? 'meeting.ongoing.return' : 'meeting.ongoing.join')}
      </button>
    </li>
  );
}

export default function OngoingMeetings() {
  const { meetings } = useOngoingMeetings();
  return <OngoingMeetingsList meetings={meetings} />;
}

/** The meetings running now, as a holder of the list read it (`useOngoingMeetings`), so one read serves the whole sidebar. */
export function OngoingMeetingsList({ meetings }: { meetings: readonly MyMeeting[] }) {
  const { t } = useTranslation();
  const { conversations } = useConversations();
  // The elapsed time on screen moves with the minute while a meeting is listed; nothing is read for it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!meetings.length) return undefined;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(tick);
  }, [meetings.length]);
  if (!meetings.length) return null;

  // THE MEETING'S NAME: its own conversation's name as it is, as the read or the person's conversations name it, else the
  // generic label (a meeting a pushed card listed carries no name of its own).
  const titleOf = (m: MyMeeting) => m.name
    || conversations.find((c) => c.conversationArn === channelArnOf(m.conversationId))?.title
    || t('meeting.title');

  return (
    <section className="ae-ongoing" aria-label={t('meeting.ongoing.heading')} data-testid="ongoing-meetings">
      <h2 className="ae-ongoing-heading">{t('meeting.ongoing.heading')}</h2>
      <ul className="ae-ongoing-list">
        {meetings.map((m) => (
          <OngoingRow key={m.conversationId} meeting={m} title={titleOf(m)} now={now} />
        ))}
      </ul>
    </section>
  );
}
