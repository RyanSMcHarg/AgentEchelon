/**
 * THE MEETINGS RUNNING NOW WHOSE OWN CONVERSATION THE PERSON IS IN (SPEC-ASSISTANT-MEETINGS FR35 to FR37), everyone in the
 * conversation a meeting started from and a person added to the meeting alone among them, for the top of the app's navigation,
 * and the ring that tells them on opening the app. The sibling project's model:
 *  - READ from the service (`POST /meetings/mine`), which confirms each meeting still runs, when the app loads and on
 *    every new messaging session (`sessionVersion`, a reconnect included), because news pushed while no session ran is
 *    never pushed again. Never on an interval, and never per event.
 *  - PUSHED between reads: the platform's own started and ended cards arrive over the messaging connection in the
 *    meeting's own conversation (and the room), from an assistant (`meetingNews`), and are applied to the list directly.
 *    A started card lists the meeting; an ended card, or this person removed from its conversation, takes it off.
 *
 * ON OPENING THE APP each meeting found running that the person is not in, in this or another window, rings them once
 * for this load, through the app's own ring (`ringLate`), for what is left of its ring or the deployment's ring length.
 * A MEETING THAT STARTS WHILE THE APP IS OPEN rings them the same way from its started card (`ringUntil`, the server's
 * time its ring stops), so a person of the room its ring did not reach, carried into the meeting's conversation after the
 * ring was sent, hears what is left of it, with no read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_INSTANCE_ARN } from '@ae/shared';
import { useMessaging, type MeetingNews } from '../providers/MessagingProvider';
import { isMeetingEnabled, meetingService, type MyMeeting, type MyMeetingRoom } from '../services/meetingService';
import { unlessInMeeting } from '../services/meetingPresence';
import { configuredRingSeconds, MAX_RING_SECONDS, MIN_RING_SECONDS } from '../services/meetingRing';
import { conversationIdOf } from '../utils/meetingWindow';

/** A conversation id as the channel ARN the app's ring and meeting window name it by. */
export function channelArnOf(conversationId: string): string {
  return APP_INSTANCE_ARN ? `${APP_INSTANCE_ARN}/channel/${conversationId}` : conversationId;
}

/** How long a ring on opening the app lasts: what is left of the meeting's ring, else the deployment's, within bounds. */
export function openingRingSeconds(m: Pick<MyMeeting, 'ringSecondsLeft'>): number {
  const left = typeof m.ringSecondsLeft === 'number' && m.ringSecondsLeft > 0 ? m.ringSecondsLeft : configuredRingSeconds();
  return Math.min(MAX_RING_SECONDS, Math.max(MIN_RING_SECONDS, left));
}

/**
 * THE LIST WITH ONE PIECE OF PUSHED NEWS APPLIED: a started card lists its meeting (newest first, once), an ended card
 * takes it off, and this person's removal from a conversation takes off the meeting held there. News naming no meeting
 * conversation changes nothing.
 */
export function applyMeetingNews(list: readonly MyMeeting[], news: MeetingNews): MyMeeting[] {
  const here = conversationIdOf(news.channelArn);
  if (news.removed) return list.filter((m) => m.conversationId !== here);
  const card = news.card;
  if (!card) return [...list];
  // The meeting's own conversation: the card names it; a card posted there names itself.
  const meetingId = card.conversationId ?? here;
  if (card.event === 'meeting-ended') return list.filter((m) => m.conversationId !== meetingId);
  if (list.some((m) => m.conversationId === meetingId)) return [...list];
  // The parent conversation it was started from: the card names it in the meeting's own conversation; a card in the parent conversation is posted there.
  const room = card.roomConversationId ?? (here !== meetingId ? here : meetingId);
  const startedAt = new Date(Number.isFinite(news.sentAt) ? news.sentAt! : news.at).toISOString();
  return [{ conversationId: meetingId, roomConversationId: room, startedAt, isHost: false }, ...list];
}

export function useOngoingMeetings(): { meetings: MyMeeting[]; rooms: MyMeetingRoom[] } {
  const { sessionVersion, meetingNews, meetingNewsAfter, ringLate, localTimeOf } = useMessaging();
  const [meetings, setMeetings] = useState<MyMeeting[]>([]);
  /** Each of the person's meeting conversations, running or ended, with its room, as the same read answered it. */
  const [rooms, setRooms] = useState<MyMeetingRoom[]>([]);
  const ringLateRef = useRef(ringLate);
  ringLateRef.current = ringLate;
  /** The meetings this load has already sounded a ring for, by meeting conversation: one ring each per load. */
  const ringSoundedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const ringIfAway = useCallback((m: MyMeeting, endsAt = Date.now() + openingRingSeconds(m) * 1000) => {
    if (ringSoundedRef.current.has(m.conversationId)) return;
    ringSoundedRef.current.add(m.conversationId);
    // Not while this person is in it, or entering it, in any window of this browser, under either name it goes by. The
    // ring is the meeting's, keyed by its own conversation as its ring and ring-off are.
    unlessInMeeting(m.conversationId, () => unlessInMeeting(m.roomConversationId, () => {
      ringLateRef.current(channelArnOf(m.conversationId), endsAt);
    }));
  }, []);
  const localTimeRef = useRef(localTimeOf);
  localTimeRef.current = localTimeOf;

  // THE READ: on load and on every new messaging session, and on nothing else.
  useEffect(() => {
    if (!isMeetingEnabled()) return undefined;
    let current = true;
    meetingService.mine().then((answer) => {
      if (!current || !mountedRef.current) return;
      const list = Array.isArray(answer?.meetings) ? answer.meetings : [];
      setMeetings(list);
      setRooms(Array.isArray(answer?.rooms) ? answer.rooms : []);
      list.forEach((m) => ringIfAway(m));
    }).catch(() => {
      // An unanswered read keeps what was listed; the cards pushed from here on still apply, and the next session reads.
    });
    return () => { current = false; };
  }, [sessionVersion, ringIfAway]);

  // THE PUSHED NEWS, applied as it arrives: every piece since the last one applied, so news that lands in one render is
  // applied whole. News heard before this list was read on mounting is the read's to answer, and is not applied.
  const appliedNewsRef = useRef<number | null>(null);
  if (appliedNewsRef.current === null) appliedNewsRef.current = meetingNews?.seq ?? 0;
  useEffect(() => {
    if (!meetingNews || !isMeetingEnabled()) return;
    const after = appliedNewsRef.current ?? 0;
    const pending = meetingNewsAfter ? meetingNewsAfter(after) : (meetingNews.seq === undefined || meetingNews.seq > after ? [meetingNews] : []);
    if (pending.length === 0) return;
    appliedNewsRef.current = pending[pending.length - 1].seq ?? after;
    setMeetings((list) => pending.reduce(applyMeetingNews, list));
    // A STARTED CARD RINGS a person not in the meeting for what is left of its ring, on this browser's clock.
    for (const news of pending) {
      const until = news.card?.event === 'meeting-started' ? news.card.ringUntil : undefined;
      if (until === undefined) continue;
      const endsAt = Math.min(Date.now() + MAX_RING_SECONDS * 1000, localTimeRef.current ? localTimeRef.current(until) : until);
      const [started] = applyMeetingNews([], news);
      if (started && endsAt > Date.now()) ringIfAway(started, endsAt);
    }
  }, [meetingNews, meetingNewsAfter, ringIfAway]);

  return { meetings, rooms };
}
