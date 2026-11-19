/**
 * A MEETING'S STARTED CARD in its room (SPEC-ASSISTANT-MEETINGS FR35 to FR37): the platform's `meeting-started` message,
 * drawn from its `meetingCard` metadata as a card, not as the raw text.
 *
 * - The room address the card is sent to (`@humans`, `@all`) is how the notification bridge reaches the room; the card
 *   shows none of it.
 * - The first line is the card's title; what follows (an alarm's reason, for one) is a secondary, wrapped line.
 * - Join meeting is the card's one action while that meeting runs, and opens the meeting window from this room, found by
 *   the meeting's own conversation where the person already has it open. Once the meeting has ended the card says so
 *   and offers nothing.
 * - A meeting link in the text is the same action as the button, so the text keeps none.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@ae/shared';
import { openMeetingWindow } from '../../utils/meetingWindow';
import './MeetingRoom.css';
import './MeetingStartedCard.css';

/** Room addresses at the front of the card's text, which only route it. */
const LEADING_ROOM_ADDRESS = /^(?:\s*@(?:humans|all)\b[,:]?)+\s*/i;
/** A meeting link in the text (`[join it](?meeting=<id>)`) with the punctuation that introduced it. */
const MEETING_LINK = /\s*[:,·•|–—-]?\s*\[[^\]]*\]\(\?meeting=[^)\s]*\)/g;
/** `@humans` at the front of an assistant's message: the notification bridge's address to the room's people. */
const LEADING_HUMANS = /^\s*@humans\b[,:]?\s*/i;

/**
 * An assistant's message as a reader sees it: the `@humans` room address at its front is how the notification bridge
 * reaches the room's people, never words for them, so it is not shown. A person's own `@humans` is their words.
 */
export function shownAssistantText(content: string): string {
  return content.replace(LEADING_HUMANS, '');
}

/** The started card a message is drawn as, or undefined: the platform's `meetingCard` metadata alone decides it. */
export function startedCardOf(message: Pick<Message, 'meetingCard'>): { conversationId?: string } | undefined {
  return message.meetingCard?.event === 'meeting-started' ? message.meetingCard : undefined;
}

/** The card's title line and its secondary detail, from the message's text. */
export function meetingCardText(content: string): { title: string; detail: string } {
  const text = content.replace(LEADING_ROOM_ADDRESS, '').replace(MEETING_LINK, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return { title: lines[0] ?? '', detail: lines.slice(1).join('\n') };
}

export default function MeetingStartedCard({
  content, roomArn, meetingConversationId, running, renderText, inMeeting = false,
}: {
  content: string;
  /** The room the card was posted in, which the meeting is joined from. */
  roomArn: string;
  /** The meeting's own conversation, as the card names it. */
  meetingConversationId?: string;
  /** Whether this card's meeting runs now, as the room's meeting state says. */
  running: boolean;
  /** Draws a line of the card's text as the conversation draws a message (mentions, emphasis, links). */
  renderText: (markdown: string) => ReactNode;
  /** Drawn inside the meeting window, which is the meeting: no Join and no ended line. */
  inMeeting?: boolean;
}) {
  const { t } = useTranslation();
  const { title, detail } = meetingCardText(content);
  return (
    <div className={`ae-meeting-card${running ? ' ae-meeting-card--live' : ''}`} data-testid="meeting-started-card">
      <div className="ae-meeting-card-head">
        <span className="ae-meeting-card-dot" aria-hidden="true" />
        <div className="ae-meeting-card-title">{renderText(title)}</div>
        {inMeeting ? null : (
          // THE CARD'S STATE IS ONE SHORT PILL IN ITS HEADER, said in full to a screen reader.
          <span className={`ae-meeting-card-state${running ? ' ae-meeting-card-state--live' : ''}`} role="status"
            aria-label={running ? t('meeting.cardLiveLabel') : t('meeting.ended')}>
            {running ? t('meeting.cardLive') : t('meeting.cardEnded')}
          </span>
        )}
      </div>
      {detail && <div className="ae-meeting-card-detail">{renderText(detail)}</div>}
      {!inMeeting && running ? (
        <div className="ae-meeting-card-actions">
          <button type="button" className="ae-meeting-join-btn" onClick={() => openMeetingWindow(roomArn, meetingConversationId)}>
            {t('meeting.join')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
