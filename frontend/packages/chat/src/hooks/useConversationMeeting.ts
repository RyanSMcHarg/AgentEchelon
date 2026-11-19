/**
 * WHETHER THE OPEN CONVERSATION'S MEETING RUNS, for a person who arrives late or comes back (SPEC-ASSISTANT-MEETINGS FR35
 * to FR37), and what the reader may do about it: join while it runs, end it for everyone (its host and the moderators),
 * start it (its host). Event-driven, with one read where events cannot reach:
 *  - one status read when the conversation opens, on every reconnect (`sessionVersion`), when a ring or a meeting card for
 *    it arrives, and when this person leaves the meeting in another window, because the service's answer is what says a
 *    meeting still runs, and a card or a ring sent while this app was away is never pushed again;
 *  - then the conversation's own messages: a platform card newer than the read decides, started or ended;
 *  - and a ring for the meeting, which only a start sends, in the meeting's own conversation.
 * A STARTED CARD SHOWS JOIN UNTIL IT IS KNOWN OTHERWISE: before the read answers, or where it fails, the conversation's
 * newest platform card decides, so the newest started card offers Join and an ended card that follows it takes it away.
 * A status read that finds the meeting started inside its ring's window rings for what is left, unless this person
 * started it. Nothing polls.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Message } from '@ae/shared';
import { useMessaging } from '../providers/MessagingProvider';
import { isMeetingEnabled, meetingService, type MeetingApiError, type MeetingStatusInfo } from '../services/meetingService';
import { conversationIdOf } from '../utils/meetingWindow';
import { unlessInMeeting, watchMeetingPresenceAs } from '../services/meetingPresence';

export interface ConversationMeeting {
  /** The meeting runs. */
  running: boolean;
  /** This person is in it, in another window of this browser. */
  joinedHere: boolean;
  /**
   * The meeting's own conversation, where it is held, once a read or the platform's card names it: the name its meeting
   * window goes by, so Join brings forward the window the person already has, however they entered it.
   */
  meetingConversationId?: string;
  /** While it runs: the reader may end it for everyone, without joining (the server enforces the same rule). */
  mayEnd: boolean;
  /** While it runs: the reader hosts it. */
  isHost: boolean;
  /** While none runs: the reader may start it. */
  mayStart: boolean;
  /** While none runs, in a meeting's own conversation: its meeting has ended. */
  ended: boolean;
  /** While it runs: a host removed the reader from it, so it offers them no Join (SPEC-ASSISTANT-MEETINGS FR59). */
  removed: boolean;
  /** The service has answered for this conversation. */
  known: boolean;
  /**
   * The service refused or could not answer the read: its code, said rather than shown as no meeting at all. A meeting's
   * link may name a conversation the person enters only by joining, so Join is still theirs to try; the join says why not.
   */
  errorCode?: string;
}

/** The latest message carrying a meeting card, which says whether the meeting ran when it was posted. */
export function latestMeetingCard(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].meetingCard) return messages[i];
  return undefined;
}

/**
 * WHAT DECIDES: a ring for the meeting; else a card posted after the read; else the read. Before the read answers (or
 * where it failed), the newest card: a started card runs until something says otherwise, and a meeting whose ended card
 * followed it does not.
 */
export function meetingRuns(args: {
  ringing: boolean;
  read: { running: boolean; at: number } | null;
  card: Message | undefined;
  /** A message's server time on this device's clock, which the read's time is on. */
  localTimeOf?: (serverTime: number) => number;
}): boolean {
  if (args.ringing) return true;
  if (!args.read) return args.card?.meetingCard?.event === 'meeting-started';
  const sent = args.card?.timestamp instanceof Date ? args.card.timestamp.getTime() : NaN;
  const at = Number.isFinite(sent) && args.localTimeOf ? args.localTimeOf(sent) : sent;
  if (args.card?.meetingCard && Number.isFinite(at) && at > args.read.at) return args.card.meetingCard.event === 'meeting-started';
  return args.read.running;
}

/**
 * WHEN A LATE ARRIVAL'S RING STOPS, by this app's clock, or null for no ring: what is left of the ring as the server
 * counts it, at the ring's own length (a workflow step may ring longer or shorter than the deployment). The server names
 * the seconds left only while the ring still sounds, so a status without them rings nobody, whatever this clock says of
 * the meeting's start. The reader's own start never rings them.
 */
export function lateRingEndsAt(s: MeetingStatusInfo, now = Date.now()): number | null {
  if (!s.running || s.startedByYou) return null;
  return typeof s.ringSecondsLeft === 'number' && s.ringSecondsLeft > 0 ? now + s.ringSecondsLeft * 1000 : null;
}

/**
 * `ringLate`: whether a late arrival hears what is left of the ring (the conversation, yes; the meeting window, which is
 * the meeting itself, no). `refresh`: read again when it changes (the meeting window's own session leaving or failing).
 */
export function useConversationMeeting(
  channelArn: string | undefined, messages: readonly Message[], opts: { ringLate?: boolean; refresh?: unknown } = {},
): ConversationMeeting {
  const lateRing = opts.ringLate !== false;
  const refresh = opts.refresh;
  const { sessionVersion, incomingRing, ringHeard, ringHeardAt, ringLate, localTimeOf } = useMessaging();
  const [read, setRead] = useState<{ arn: string; at: number; status: MeetingStatusInfo } | null>(null);
  const [failed, setFailed] = useState<{ arn: string; code: string } | null>(null);
  const [joinedHere, setJoinedHere] = useState(false);
  const card = useMemo(() => latestMeetingCard(messages), [messages]);
  // Read again when this person leaves the meeting in another window, so Join returns only while it still runs.
  const [leftAt, setLeftAt] = useState(0);

  // A RING OR A RING-OFF HEARD FOR THIS MEETING, in any window: for this conversation, the meeting's own or its room,
  // where a start rings and an end stops it. It is the one word a meeting window, which shows no ring, has of a start.
  const lastRead = read && read.arn === channelArn ? read.status : undefined;
  const heardIds = channelArn ? [conversationIdOf(channelArn), lastRead?.conversationId, lastRead?.roomConversationId] : [];
  const heardFor = !ringHeard || !channelArn ? 0
    : ringHeardAt ? Math.max(0, ...heardIds.map((id) => (id ? ringHeardAt(id) : 0)))
      : heardIds.includes(conversationIdOf(ringHeard.channelArn)) ? ringHeard.at : 0;

  // THE READ, on open, on reconnect, and on each event that may change the answer: a ring, a card, a leave.
  useEffect(() => {
    if (!channelArn || !isMeetingEnabled()) return undefined;
    let current = true;
    const at = Date.now();
    meetingService.status(channelArn).then((s) => {
      if (!current) return;
      setRead({ arn: channelArn, at, status: s });
      setFailed(null);
      const endsAt = lateRingEndsAt(s);
      // THE LATE RING IS THE MEETING'S OWN RING, keyed by the meeting's own conversation as its live ring, its ring-off and its
      // settling are, so a ring-off stops it and one tab sounds it; and never while this person is in the meeting, in any
      // window of this browser, under either name it goes by.
      if (endsAt !== null && lateRing) {
        const meetingId = s.conversationId ?? conversationIdOf(channelArn);
        const ringArn = s.conversationId ? channelArn.replace(/[^/]+$/, s.conversationId) : channelArn;
        unlessInMeeting(meetingId, () => unlessInMeeting(s.roomConversationId ?? meetingId, () => ringLate(ringArn, endsAt)));
      }
    }).catch((e: unknown) => {
      if (!current) return;
      setFailed({ arn: channelArn, code: (e as MeetingApiError)?.code || 'STATUS_FAILED' });
    });
    return () => { current = false; };
  }, [channelArn, sessionVersion, ringLate, lateRing, incomingRing?.channelArn, heardFor, card?.id, leftAt, refresh]);

  const readNow = read && read.arn === channelArn ? read : null;
  const errorCode = failed && failed.arn === channelArn ? failed.code : undefined;
  const currentRead = readNow ? { running: readNow.status.running, at: readNow.at, conversationId: readNow.status.conversationId, roomConversationId: readNow.status.roomConversationId } : null;
  // THE MEETING'S OWN CONVERSATION: the newest word on it, a card posted after the read, else the read.
  const cardAt = card?.timestamp instanceof Date ? localTimeOf(card.timestamp.getTime()) : NaN;
  const meetingConversationId = (card?.meetingCard?.conversationId && currentRead && cardAt > currentRead.at
    ? card.meetingCard.conversationId : undefined)
    ?? currentRead?.conversationId
    // Before the read answers, the newest card names it, so only that meeting's card offers Join.
    ?? (!currentRead ? card?.meetingCard?.conversationId : undefined);
  // A RING FOR THIS CONVERSATION'S MEETING, which sounds in the meeting's own conversation (one ring key, the meeting).
  const ringingHere = !!channelArn && !!incomingRing
    && [conversationIdOf(channelArn), meetingConversationId].includes(conversationIdOf(incomingRing.channelArn));
  const roomConversationId = currentRead?.roomConversationId;

  // THIS PERSON'S OWN MEETING WINDOW, under every name the meeting goes by: this conversation, the meeting's own and its
  // room, so a window entered any of those ways reads as this person being in it.
  useEffect(() => {
    setJoinedHere(false);
    if (!channelArn || !isMeetingEnabled()) return undefined;
    let was = false;
    return watchMeetingPresenceAs([conversationIdOf(channelArn), meetingConversationId ?? '', roomConversationId ?? ''], (here) => {
      setJoinedHere(here);
      if (was && !here) setLeftAt(Date.now());
      was = here;
    });
  }, [channelArn, meetingConversationId, roomConversationId]);

  const running = meetingRuns({
    ringing: ringingHere,
    read: currentRead,
    card,
    localTimeOf,
  });
  // What the reader may do comes from the read alone: a ring or a card says a meeting runs, never who may end it.
  const s = readNow?.status;
  return {
    running, joinedHere, ...(meetingConversationId ? { meetingConversationId } : {}),
    mayEnd: running && !!s?.running && !!s.mayEnd,
    isHost: running && !!s?.running && !!s.isHost,
    mayStart: !running && !!s && !s.running && s.mayStart !== false,
    ended: !running && !!s && !s.running && !!s.ended,
    removed: running && !!s?.running && !!s.removed,
    known: !!s,
    ...(errorCode ? { errorCode } : {}),
  };
}
