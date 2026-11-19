/**
 * THE MEETING WINDOW (`utils/meetingWindow.ts`): one meeting, full window, with its conversation's chat in the right
 * column.
 *
 * EVERY MEETING IS ITS OWN CONVERSATION (FR27). The window may be opened for the conversation a meeting was started from
 * (its meeting control, a ring) or for the meeting's own conversation (a card's link, an email's button); the meeting
 * routes accept either. Once a start or a join answers, the window shows the meeting's own conversation, which the
 * person is now a member of, so the chat beside the meeting is the meeting's chat and never the room it came from.
 *
 * It opens a conversation as the app opens any conversation (`selectConversation`, which reads it as the person), so a
 * conversation the person is not a member of opens nothing. Leaving the meeting closes the window.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../../providers/ConversationProvider.chime';
import { APP_INSTANCE_ARN } from '@ae/shared';
import { useMeeting } from '../../providers/MeetingProvider';
import { useConversationMeeting } from '../../hooks/useConversationMeeting';
import ConversationInterface from '../ConversationInterface';
import MessageInput from '../MessageInput';
import MeetingRoom from './MeetingRoom';
import MeetingRoster from './MeetingRoster';
import { MeetingChatProvider } from './MeetingChatPanel';
import { aliasMeetingWindow, closeMeetingWindow, nameMeetingWindow, unaliasMeetingWindow } from '../../utils/meetingWindow';
import './MeetingRoom.css';

export default function MeetingWindow({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const { activeConversation, selectConversation, channelMembers, conversations } = useConversations();
  const meeting = useMeeting();
  // THE MEETING'S OWN CONVERSATION, kept once a start or a join names it: after the meeting ends for this person, the window
  // still shows that meeting, its chat and that it ended, never the room it was entered from. A later start names the next
  // meeting's conversation, and the window follows it.
  const [meetingConversation, setMeetingConversation] = useState<string | undefined>();
  useEffect(() => {
    if (meeting.conversationId) setMeetingConversation(meeting.conversationId);
  }, [meeting.conversationId]);
  const kept = meeting.conversationId || meetingConversation;
  // The conversation the window shows: the one it was opened for, until the meeting names its own.
  const shown = kept || conversationId;
  // The conversation the meeting is started and joined from until it names its own: the one the window was opened for,
  // kept once it opened. Switching the chat to the meeting's own conversation never re-enters the meeting.
  const enteredFrom = useRef<string | null>(null);
  const inMeeting = meeting.status === 'joined';
  // Once the meeting names its own conversation, the room acts on it: an end ends that meeting, the next start from it opens
  // the room's next meeting (whose conversation the window then follows), and out of it, it says when it has ended.
  const connected = inMeeting || meeting.status === 'reconnecting';
  // Whether opening the conversation has finished, so one that did not open is said rather than waited on.
  const [settled, setSettled] = useState(false);

  const open = activeConversation && (activeConversation.id === shown || activeConversation.conversationArn.endsWith(`/${shown}`));
  // WHETHER THE OPEN CONVERSATION IS A MEETING'S OWN, AS THE SERVER SAYS: before a start or a join names the meeting's
  // conversation (a window opened from a card's link or an email), its status read answers it. A channel's Metadata, which
  // its moderator can rewrite, never decides it.
  const before = useConversationMeeting(open && !kept ? activeConversation.conversationArn : undefined, [], { ringLate: false });
  // Read by the effect below without being its dependency.
  const openRef = useRef(open);
  openRef.current = open;
  const selectRef = useRef(selectConversation);
  selectRef.current = selectConversation;

  // THE CONVERSATION IS OPENED ONCE PER CONVERSATION SHOWN, and read again once joined only while it is not open yet: a
  // person admitted by the join is a member only from then. A conversation already open stays as it is through a
  // reconnect, a rename or another page of the conversation list, so its chat and its member names never blank mid-meeting.
  useEffect(() => {
    if (openRef.current) return;
    setSettled(false);
    void selectRef.current(shown).catch(() => undefined).finally(() => setSettled(true));
  }, [shown, inMeeting]);

  // THE WINDOW GOES BY ITS MEETING'S NAME once the meeting names its own conversation, so every way into the same meeting
  // finds this window (`utils/meetingWindow.ts`).
  useEffect(() => {
    if (meeting.conversationId) nameMeetingWindow(meeting.conversationId);
  }, [meeting.conversationId]);
  // WHILE IN THE MEETING, every conversation it goes by (the one entered from, its room) opens this window, so a ring for
  // the room or another link to it brings this window forward rather than opening a second one.
  useEffect(() => {
    if (!connected || !meeting.conversationId) return undefined;
    aliasMeetingWindow([conversationId, meeting.conversationId, meeting.roomConversationId ?? '']);
    return unaliasMeetingWindow;
  }, [connected, conversationId, meeting.conversationId, meeting.roomConversationId]);

  const names = useMemo(
    () => new Map(channelMembers.map((m) => [m.userArn.split('/').pop() || m.userArn, m.name])),
    [channelMembers],
  );
  if (open && !enteredFrom.current) enteredFrom.current = activeConversation.conversationArn;

  // THE MEETING IS NAMED FOR ITS ROOM: "Meeting in <room>". Before joining, the open conversation is the room; the meeting's
  // own conversation is named for its room by the server's answer (`roomConversationId`), and is named for it at creation,
  // so where the room is not known here its own name says the same.
  const isId = (c: { id: string; conversationArn: string }, id: string | undefined) => !!id && (c.id === id || c.conversationArn.endsWith(`/${id}`));
  const inMeetingConversation = !!activeConversation && (isId(activeConversation, meeting.conversationId) || isId(activeConversation, kept)
    || isId(activeConversation, before.meetingConversationId) || before.ended);
  const room = inMeetingConversation
    ? conversations.find((c) => isId(c, meeting.roomConversationId))
    : activeConversation;
  const meetingTitle = room?.title ? t('meeting.inRoom', { room: room.title }) : activeConversation?.title;
  // THE CHAT IS ONLY EVER THE MEETING'S OWN CONVERSATION (FR27): the open conversation is a meeting's (it names its room),
  // or the one a start or a join named. Before the meeting names it, the room it was entered from shows no chat beside it.
  const meetingChatOpen = !!open && inMeetingConversation;

  // THE RIGHT COLUMN (FR71): the meeting's roster, then its chat as a panel of its own. Each is one element for the window's
  // life, so the meeting's own changes (who is speaking, who arrived) re-render the room and the roster, which reads the
  // meeting itself, and not the chat; the chat re-renders on its own conversation's changes.
  const roster = useMemo(() => <MeetingRoster />, []);
  const chat = useMemo(() => (
    <div className="ae-meeting-chat-column ae-meeting-chat-thread">
      <ConversationInterface inMeetingWindow />
      <MessageInput inMeetingWindow />
    </div>
  ), []);

  return (
    // THE CHAT PANEL (FR71) belongs to the window, so it stays open or closed through the room's layout changes.
    <MeetingChatProvider>
      <div className="ae-meeting-window" data-testid="meeting-window">
        {open || (enteredFrom.current && !settled) ? (
          <MeetingRoom
            channelArn={kept && APP_INSTANCE_ARN ? `${APP_INSTANCE_ARN}/channel/${kept}` : enteredFrom.current ?? activeConversation!.conversationArn}
            title={meetingTitle}
            nameOf={(personId) => names.get(personId)}
            onLeave={closeMeetingWindow}
            chat={meetingChatOpen ? chat : undefined}
            roster={meetingChatOpen ? roster : undefined}
          />
        ) : settled && APP_INSTANCE_ARN ? (
          // A MEETING'S CONVERSATION THE PERSON IS NOT IN YET, opened from its link: they may still join it, from the
          // conversation it was started from, where its settings allow (the meeting routes decide). Its chat shows once
          // they are in; anyone else is told why they cannot join when they try.
          <MeetingRoom
            channelArn={`${APP_INSTANCE_ARN}/channel/${conversationId}`}
            onLeave={closeMeetingWindow}
          />
        ) : settled ? (
          <div className="ae-meeting-prejoin" role="alert">
            <p className="ae-meeting-error">{t('meeting.errors.NOT_A_MEMBER')}</p>
            <button type="button" className="ae-meeting-join-btn ae-meeting-join-btn--secondary" onClick={closeMeetingWindow}>{t('meeting.close')}</button>
          </div>
        ) : (
          <div className="app-loading"><div className="app-loading-spinner" /></div>
        )}
      </div>
    </MeetingChatProvider>
  );
}
