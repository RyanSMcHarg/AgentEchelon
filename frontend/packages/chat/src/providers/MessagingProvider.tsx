import { TARGET_MISMATCH_LOG, receivedTargetMismatch } from '../utils/targetIntegrity';
import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import {
  DefaultMessagingSession,
  MessagingSessionConfiguration,
  ConsoleLogger,
  LogLevel,
  type MessagingSession,
} from 'amazon-chime-sdk-js';
import { useAwsClient } from './AwsClientProvider';
import { isAssistantArn, useAuth } from '@ae/shared';
import { onSessionEnd } from '@ae/shared/services/sessionEpoch.ts';
import { chimeService } from '../services/chimeService';
import { markResponseReceived, markPlaceholderShown } from '../services/messageLatencyTracker';
import { liftTurnStateFields } from '../services/turnStateFields';
import { proposalFromMetadata } from '../services/proposalService';
import { taskCardFromMetadata } from '../services/taskCardService';
import { dashboardFromMetadata } from '../services/dashboardService';
import { MAX_RING_SECONDS, arrivingRingEndsAt, isRingOff, nextRing, parseRing, steadyNow } from '../services/meetingRing';
import { claimMeetingRing, isRingSettled, onRingSettledElsewhere, ringOver, settleRingOnce, unlessInMeeting } from '../services/meetingPresence';
import { conversationIdOf, meetingWindowRequest } from '../utils/meetingWindow';
import { reportRingOutcome } from '../services/meetingEventReporter';
import type { RingOutcome } from '../services/meetingEventNames';
import { isMeetingEnabled, meetingCardFromMetadata, meetingService } from '../services/meetingService';
import { trackEvent } from '@ae/shared';
import {
  parseMessageContent,
  decodeMessageText,
  parseActiveTaskFromMetadata,
  parseMessageFeedbackFromMetadata,
  isEmptyLexEnvelope,
  unwrapLexEnvelope,
  declaresFinalAnswer,
} from '@ae/shared';
import type { Message } from '@ae/shared';

/**
 * Channel events, delivered for EVERY channel the user is a member of.
 *
 * There is deliberately no per-channel registration. The websocket session is app-level and always
 * on, so a per-channel callback map only ever added a window in which a channel had no registered
 * handler - and a message arriving in that window was dropped with no repair. That window opened on
 * every conversation CREATE: the bot is added (firing its welcome server-side) before the client can
 * register anything, and the welcome lands seconds later because the router retries the
 * eventually-consistent creator lookup. The result was an empty conversation carrying an unread dot
 * in the user's own sidebar, in roughly a third of new conversations.
 *
 * So the handler is registered once and receives `channelArn`; deciding what is "current" belongs to
 * the consumer, which is the only layer that knows. This mirrors the Amazon Chime SDK sample chat
 * app (`aws-samples/amazon-chime-sdk`, `ChatMessagesProvider`), which subscribes once on auth and
 * branches on an active-channel ref - render it, or mark the channel unread.
 */
export interface ChannelCallbacks {
  onMessageCreate?: (channelArn: string, msg: Message) => void;
  onMessageUpdate?: (channelArn: string, msg: Message) => void;
  onMessageDelete?: (channelArn: string, msgId: string) => void;
  /** Fires on CREATE_CHANNEL_MEMBERSHIP or DELETE_CHANNEL_MEMBERSHIP events.
   *  The subscriber is expected to re-fetch the member list — we don't try
   *  to reconcile individual events into local state because Chime's at-
   *  least-once delivery can drop or duplicate membership events. */
  onMembershipChange?: (channelArn: string) => void;
  /** Fires on UPDATE_CHANNEL events — primarily when the bot renames a
   *  channel after deriving a title from the first user message. The
   *  subscriber receives the new channel `Name`, and the channel's `Metadata`
   *  as the event carries it (the archive's `archived` display mirror rides it). */
  onChannelUpdate?: (channelArn: string, channelName: string, metadata?: string) => void;
}

/** Cross-channel bookkeeping that is not about rendering: unread state, and surfacing a channel the
 *  user was just added to (a drift-spawned conversation) that is not in the sidebar yet. */
export interface GlobalMessageListener {
  onMessageInAnyChannel?: (channelArn: string, senderArn: string) => void;
  /** Fires on CREATE_CHANNEL_MEMBERSHIP in ANY channel, including one the sidebar does not know
   *  about yet — without it a newly-joined channel never appears until a reload. */
  onAddedToChannel?: (channelArn: string) => void;
  /** Fires when a channel the viewer is in is deleted (DELETE_CHANNEL), or the viewer's own membership is
   *  removed (DELETE_CHANNEL_MEMBERSHIP naming them): the conversation is no longer theirs to show. */
  onRemovedFromChannel?: (channelArn: string) => void;
}

/** A meeting ringing for the viewer: which conversation, and when the ring stops (`meetingRing.ts`). */
export interface IncomingRing {
  channelArn: string;
  /** Epoch milliseconds. */
  endsAt: number;
}

/** The last ring or ring-off this window heard, in any window kind: which conversation, and when (epoch milliseconds). */
export interface RingHeard {
  channelArn: string;
  at: number;
}

/**
 * MEETING NEWS PUSHED OVER THE MESSAGING CONNECTION (`meetingNews`): the platform's started or ended card, from an
 * assistant, in the conversation it was posted in (the meeting's own, or the conversation it was started from), with the card's
 * own word on the meeting; or this person removed from a conversation.
 */
export interface MeetingNews extends RingHeard {
  /** Its place among the news this window heard, counting from one: a reader applies every piece after the last it applied. */
  seq?: number;
  /** The card: which meeting, started or ended, its own conversation and the conversation it was started from. */
  card?: { event: 'meeting-started' | 'meeting-ended'; meetingId: string; conversationId?: string; roomConversationId?: string; ringUntil?: number };
  /** The card's send time, on the server's clock. */
  sentAt?: number;
  /** This person was removed from the conversation. */
  removed?: true;
}

interface MessagingContextType {
  isConnected: boolean;
  /**
   * Incremented each time a messaging session STARTS - the first connect and every reconnect.
   *
   * THE SESSION CONTRACT: anything that holds
   * data the session would have pushed lists this as a dependency and re-reads when it changes,
   * because a message posted while no session was running is never pushed again.
   */
  sessionVersion: number;
  /** Register the single channel-event handler. Pass null to clear it. */
  setChannelListener: (callbacks: ChannelCallbacks | null) => void;
  setGlobalListener: (listener: GlobalMessageListener | null) => void;
  /** The meeting ringing for the viewer now, or null. */
  incomingRing: IncomingRing | null;
  /**
   * The last ring or ring-off heard for any conversation, in the app and in a meeting window alike (which shows no ring):
   * a meeting started or ended there, so whatever shows that conversation's meeting reads it again.
   */
  ringHeard: RingHeard | null;
  /**
   * When a ring or a ring-off was last heard for a conversation, by its id (0 for never). Every ring is kept, so two heard
   * for different conversations in one render are both read, where `ringHeard` holds only the last.
   */
  ringHeardAt?: (conversationId: string) => number;
  /**
   * THE LAST MEETING NEWS PUSHED FOR ANY CONVERSATION, in any window kind: the platform's started or ended card arriving
   * in any conversation the person is in, carrying the card, or this person removed from a conversation. Whatever lists
   * the person's meetings applies it directly, so a meeting started anywhere shows at once, with no read and no timer.
   */
  meetingNews: MeetingNews | null;
  /**
   * EVERY PIECE OF MEETING NEWS AFTER `seq`, oldest first: news that lands in one render is all here, where
   * `meetingNews` holds only the last of it. A reader keeps the `seq` of the last piece it applied.
   */
  meetingNewsAfter?: (seq: number) => MeetingNews[];
  /** Stop the ring: the viewer answered or declined it, or its time is up. */
  dismissRing: (outcome?: 'ringAnswered' | 'ringDismissed') => void;
  /**
   * A RING THE VIEWER MISSED, for what is left of it: a status read on load or on reconnect found the meeting started inside
   * its ring's window. A ring this app already showed for the conversation, answered or not, does not ring again.
   */
  ringLate: (channelArn: string, endsAt: number) => void;
  /**
   * A server time (a message's creation time) on this device's clock, by the shortest delivery this connection has seen,
   * so a message's time and a time this app read compare whatever the two clocks say.
   */
  localTimeOf: (serverTime: number) => number;
}

const MessagingContext = createContext<MessagingContextType | undefined>(undefined);

// How long the page can be hidden before forcing a reconnect
const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1000;

// Detect the bot's async placeholder ("One moment... <!--corr:uuid-->").
// The corr marker only appears on the initial placeholder CREATE — the async
// processor's UpdateChannelMessage replaces content with the finalized
// response and strips the marker. Used to skip latency/analytics tracking on
// the placeholder so the metric measures time-to-actual-response, not
// time-to-acknowledgment.
// AND A TURN THAT DECLARED IT IS FINISHED IS NOT ONE, however it is marked (2026-09-11). A greeting
// answered by the handler now carries a correlation marker so its pairing can be declared rather
// than guessed at downstream, and it posts once with no update to follow. Read as a placeholder, the
// clock is never stopped and the turn reports no answer at all - which is the same one-directional
// bias `isQueueNotice` below records, on the turns that are fastest rather than slowest.
function isAsyncPlaceholder(rawContent: string | undefined): boolean {
  if (!rawContent) return false;
  if (declaresFinalAnswer(rawContent)) return false;
  return rawContent.includes('<!--corr:') || rawContent.includes('%3C!--corr%3A');
}

/**
 * The queue notice - "still working on your earlier message" - which is NOT an answer.
 *
 * It is bot-authored, it is a CREATE, and it carries no `corr` marker, because it is not a
 * placeholder for a turn: it is a statement about a queue. So it satisfied every condition the
 * response tracking used, and stopped the clock. `markResponseReceived` then deleted the pending
 * send, so the REAL answer a minute later reported nothing at all, and `markPlaceholderShown`
 * returned early so the client's time-to-first-feedback for that turn was lost too.
 *
 * The effect was not noise, it was bias in one direction: latency looked fastest on exactly the
 * queued turns where the person waited longest.
 *
 * Read from Metadata rather than from the words, which are the assistant's own and translated.
 */
function isQueueNotice(rawMetadata: string | undefined): boolean {
  if (!rawMetadata) return false;
  try {
    const decoded = (() => {
      try { return decodeURIComponent(rawMetadata); } catch { return rawMetadata; }
    })();
    return (JSON.parse(decoded) as { respPhase?: unknown })?.respPhase === 'notice';
  } catch {
    // Unparseable metadata is not a notice. Guessing the other way would silently stop counting
    // real answers, which is the more expensive mistake.
    return false;
  }
}

/**
 * The turn id the placeholder declares, or undefined (G5).
 *
 * THE ONE IDENTIFIER THE BROWSER AND THE SERVER BOTH HOLD. The client never sees a Chime MessageId
 * for its own send and the server never sees the click, so an aggregate comparison was the most the
 * two sides could support. The correlation marker is on the placeholder the client just rendered and
 * on the message row the server wrote, which makes it the join key for ONE turn.
 *
 * Both encodings are tried for the same reason `isAsyncPlaceholder` tries both: content arrives
 * percent-encoded on some paths, and reading only the decoded form would silently stop correlating
 * on exactly those.
 */
function correlationIdOf(rawContent: string | undefined): string | undefined {
  if (!rawContent) return undefined;
  const decoded = (() => {
    try { return decodeURIComponent(rawContent); } catch { return rawContent; }
  })();
  // Same bounded character class the backend readers use: an id that does not match is not an id,
  // and forwarding whatever followed the token would put unbounded message text into telemetry.
  return /<!--corr:([A-Za-z0-9._-]{1,64})-->/.exec(decoded)?.[1];
}

/** How much meeting news a window keeps for its readers: far more than ever lands in one render. */
const NEWS_KEPT = 50;

export function MessagingProvider({ children }: { children: ReactNode }) {
  const { isInitialized, userArn } = useAwsClient();
  const { refreshCredentials } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const sessionRef = useRef<MessagingSession | null>(null);
  const channelListenerRef = useRef<ChannelCallbacks | null>(null);
  const globalListenerRef = useRef<GlobalMessageListener | null>(null);
  const [incomingRing, setIncomingRing] = useState<IncomingRing | null>(null);
  const [ringHeard, setRingHeard] = useState<RingHeard | null>(null);
  const [meetingNews, setMeetingNews] = useState<MeetingNews | null>(null);
  /** The news this window heard, newest last, the most recent `NEWS_KEPT` of it, numbered as it arrived. */
  const newsLogRef = useRef<MeetingNews[]>([]);
  const newsSeqRef = useRef(0);
  /** When a ring or ring-off was last heard, by conversation id. */
  const ringsHeardRef = useRef<Map<string, number>>(new Map());
  const pushNews = useCallback((news: Omit<MeetingNews, 'seq'>) => {
    newsSeqRef.current += 1;
    const numbered: MeetingNews = { ...news, seq: newsSeqRef.current };
    newsLogRef.current = [...newsLogRef.current, numbered].slice(-NEWS_KEPT);
    setMeetingNews(numbered);
  }, []);
  const meetingNewsAfter = useCallback((seq: number) => newsLogRef.current.filter((n) => (n.seq ?? 0) > seq), []);
  const ringHeardAt = useCallback((conversationId: string) => ringsHeardRef.current.get(conversationId) ?? 0, []);
  /** When the last ring this app showed for each conversation stops, so a late ring never repeats one already shown. */
  const ringsShownRef = useRef<Map<string, number>>(new Map());
  /**
   * RINGS ARE FOR THE APP, NOT A MEETING WINDOW: a meeting window shows no ring, so it neither takes one nor reports one.
   * Read once, as the app reads whether it is a meeting window.
   */
  const [takesRings] = useState(() => meetingWindowRequest() === null);
  /**
   * The shortest delivery this connection has seen, arrival minus send time: it carries the difference between this
   * clock and the server's, so a ring's lateness is read without trusting either clock against the other.
   */
  const fastestDeliveryRef = useRef(Infinity);
  const isConnectingRef = useRef(false);
  const hiddenAtRef = useRef<number | null>(null);
  const lastMessageTimeRef = useRef<number>(Date.now());
  // Tracks whether the current session is the result of a forceReconnect call
  // so we can emit websocket_reconnected instead of websocket_connected when
  // the next messagingSessionDidStart fires.
  const isReconnectRef = useRef(false);
  // Set immediately before any DELIBERATE session.stop() (forceReconnect, unmount, sign-out) so the
  // stop observer can tell "we ended this" from "the socket dropped" and only auto-reconnect the
  // second. Without it, forceReconnect's own stop would race a second reconnect against itself.
  const intentionalStopRef = useRef(false);
  // Consecutive unattended drops, for backoff. Reset on a successful start.
  const dropCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The observer is built inside `connect`, so it cannot close over `forceReconnect` (defined after,
  // and itself depending on `connect`). A ref holding the latest one breaks the cycle.
  const forceReconnectRef = useRef<(() => Promise<void>) | null>(null);

  // Parse a Chime message payload into our Message type
  const parseMessagePayload = useCallback((payload: Record<string, unknown>, isUpdate = false): Message | null => {
    if (!payload) return null;

    let content = payload.Content as string | undefined;
    if (!content) return null;

    // Lex bot replies arrive wrapped: `{"Messages":[{"Content":"...","ContentType":"PlainText"}]}`.
    // Empty `Messages` arrays are noise (e.g. Lex returned no response); drop them.
    // Otherwise unwrap so the user sees the actual text.
    const contentType = payload.ContentType as string | undefined;
    // Empty envelope: the router suppressing a retried fulfillment (ADR-022). Same rule as the REST
    // history load, shared so a message cannot be dropped on one path and rendered on the other.
    if (isEmptyLexEnvelope(content, contentType)) return null;
    /**
     * ONE UNWRAP RULE, SHARED - not a second copy of it here.
     *
     * This path carried its own inline unwrap while the REST history load called
     * `unwrapLexEnvelope`. The sibling rule above it was deliberately shared for exactly this reason,
     * and its docstring says why: "They previously each carried their own copy, which is two places for
     * the rule to drift and only one of them visible in any given bug report - a message dropped live but
     * present on reload, or the reverse." That argument applies to the unwrap identically, and the two
     * copies had already begun to differ (the inline one never checked that `Messages` was an array).
     *
     * Note what this does NOT fix: both paths gate on the Lex ContentType, so an envelope that arrives
     * without it still renders verbatim. That is the remaining half of the raw-JSON report, and it belongs
     * to whatever posts the message, not here.
     */
    content = unwrapLexEnvelope(content, contentType);

    let metadata: Record<string, unknown> = {};
    try {
      if (payload.Metadata) {
        // An object or nothing: Metadata is member-writable, and `null` or a bare string parses without being one.
        const parsed: unknown = JSON.parse(payload.Metadata as string);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore metadata parse errors
    }

    const senderArn = (payload.Sender as Record<string, string>)?.Arn || '';
    // THE NAME IS CARRIED, NOT INVENTED. This defaulted to 'Unknown' and then, for a bot, to
    // 'Assistant' below - two English words produced by the data layer, where nothing can translate
    // them and nothing can tell a substitute apart from an assistant genuinely called that. An absent
    // name is now absent, and the VIEW supplies a translated label.
    const senderName = (payload.Sender as Record<string, string>)?.Name || '';
    const isBot = !!metadata.botResponse || senderArn.includes('/bot/');

    // Apply the same parsing rules as history loading (chimeService.listMessages)
    const decoded = decodeMessageText(content);
    const { content: cleanContent, activeTask: contentTask, navigateChannel, battle, battleWaiting } = parseMessageContent(decoded);
    const metadataTask = parseActiveTaskFromMetadata(metadata);
    const currentUserArn = chimeService.getUserArn();
    const targets = payload.Target as Array<{ MemberArn?: string }> | undefined;
    // TARGETED TO THIS PERSON IS THE `Target` AMAZON CHIME SDK SET: the service sets and enforces it, and the history path
    // (`chimeService.listMessages`) reads the same field. AN ASSISTANT'S PRIVATE REPLY that first arrives as its rewrite,
    // which may carry no `Target`, is read by the recipient the platform stamped on it (`targetedSender`): the sender is
    // service-stamped as an assistant, so its Metadata is the platform's. A person's Metadata never says who a message is for.
    const senderIsAssistant = isAssistantArn(senderArn);
    const targetedToUser = !!currentUserArn && ((Array.isArray(targets) && targets.some((t) => t?.MemberArn === currentUserArn))
      || (senderIsAssistant && !Array.isArray(targets) && metadata.targetedSender === currentUserArn));
    const targetArns = Array.isArray(targets) ? targets.map((t) => t?.MemberArn).filter((a): a is string => !!a) : [];
    // THE TARGET AND THE MESSAGE'S OWN WORDS MUST AGREE (`targetIntegrity.ts`). A rewrite's event is compared only where it
    // carries a `Target` to compare with; a created message always is.
    const targetMismatch = !isUpdate || 'Target' in payload
      ? receivedTargetMismatch({ text: decoded, metadata, targetArns, senderIsAssistant })
      : undefined;
    if (targetMismatch) {
      console.error(`${TARGET_MISMATCH_LOG} a received message disagrees with its Target`, { messageId: payload.MessageId, channelArn: payload.ChannelArn, mismatch: targetMismatch });
    }

    return {
      id: (payload.MessageId as string) || `msg-${Date.now()}`,
      content: cleanContent,
      sender: { arn: senderArn, name: senderName },
      timestamp: payload.CreatedTimestamp ? new Date(payload.CreatedTimestamp as string) : new Date(),
      isBot,
      status: 'sent',
      activeTask: contentTask || metadataTask || undefined,
      attachment: metadata.attachment as Message['attachment'],
      modelId: typeof metadata.bedrockModel === 'string' ? metadata.bedrockModel : undefined,
      intent: typeof metadata.intent === 'string' ? metadata.intent : undefined,
      // Experiment feedback join — see the chimeService message-history path.
      experimentId: typeof metadata.experimentId === 'string' ? metadata.experimentId : undefined,
      variantId: typeof metadata.variantId === 'string' ? metadata.variantId : undefined,
      assignmentMode: typeof metadata.assignmentMode === 'string' ? metadata.assignmentMode : undefined,
      feedback: parseMessageFeedbackFromMetadata(metadata),
      targetedToUser: targetedToUser || undefined,
      ...(targetArns.length ? { targetArns } : {}),
      ...(targetMismatch ? { targetMismatch } : {}),
      // A proposal addressed to this person (ADR-061 decision 8), lifted as the history load lifts it.
      proposal: proposalFromMetadata(metadata),
      // A task a workflow assigned this person (ADR-063), lifted as the history load lifts it.
      taskCard: taskCardFromMetadata(metadata),
      // A meeting's started or ended card, by the function the history load uses too, only from an assistant.
      meetingCard: meetingCardFromMetadata(metadata, senderArn),
      dashboard: dashboardFromMetadata(metadata, senderArn),
      // The answer's phase and the queue's depth and stage, lifted by the SAME function the history
      // load uses (`liftTurnStateFields`), so a reload shows exactly what the live event showed.
      ...liftTurnStateFields(metadata),
      // Multi-part response grouping
      responseGroup: typeof metadata.responseGroup === 'string' ? metadata.responseGroup : undefined,
      continuation: metadata.continuation === true,
      parentMessageId: typeof metadata.parentMessageId === 'string' ? metadata.parentMessageId : undefined,
      part: typeof metadata.part === 'number' ? metadata.part : undefined,
      totalParts: typeof metadata.totalParts === 'number' ? metadata.totalParts : undefined,
      // Drift-confirm redirect signal
      navigateChannel: navigateChannel || undefined,
      // /battle marker (round / rival info from the channel-flow processor + orchestrator)
      battle: battle || undefined,
      // /battle clarification — bot is blocked on the user. Parsed on
      // every payload (CREATE + UPDATE) so the marker, which lands via
      // the placeholder UPDATE, is never missed (CREATE-only audit lesson).
      battleWaiting: battleWaiting || undefined,
    };
  }, []);

  // Connect to the messaging session
  const connect = useCallback(async () => {
    if (isConnectingRef.current) return;
    if (!isInitialized || !userArn) return;

    const messagingClient = chimeService.getMessagingClient();
    if (!messagingClient) return;

    isConnectingRef.current = true;

    try {
      const configuration = new MessagingSessionConfiguration(
        userArn,
        null,
        undefined,
        messagingClient
      );

      const logger = new ConsoleLogger('ChimeMessaging', LogLevel.WARN);
      const session = new DefaultMessagingSession(configuration, logger);

      session.addObserver({
        messagingSessionDidStart: () => {
          sessionRef.current = session;
          lastMessageTimeRef.current = Date.now();
          dropCountRef.current = 0;
          setIsConnected(true);
          setSessionVersion((v) => v + 1);
          trackEvent(isReconnectRef.current ? 'websocket_reconnected' : 'websocket_connected');
          isReconnectRef.current = false;
        },
        messagingSessionDidStop: () => {
          sessionRef.current = null;
          setIsConnected(false);
          trackEvent('websocket_disconnected');

          // A deliberate stop is not a fault; the caller drives what happens next.
          if (intentionalStopRef.current) {
            intentionalStopRef.current = false;
            return;
          }

          // AN UNATTENDED DROP MUST RECONNECT ITSELF.
          //
          // Reconnecting used to be driven ONLY by `visibilitychange`, so a socket that dropped while
          // the page was VISIBLE - the ordinary case for someone sitting in a conversation - was never
          // re-established. The header rendered "Reconnecting..." indefinitely while nothing was
          // reconnecting, and messages the backend had already delivered simply never arrived. The
          // only recovery was switching tabs away and back, which no user knows to do.
          //
          // A HIDDEN tab is left alone deliberately: browsers suspend background sockets as a matter
          // of course, so retrying there burns credentials against a connection the browser intends to
          // keep down, and the visibility handler already re-establishes it on return.
          if (document.visibilityState === 'hidden') return;

          const attempt = ++dropCountRef.current;
          // 1s, 2s, 4s, 8s, capped at 15s. Backoff rather than a fixed retry so a server-side outage
          // is not amplified by every open client retrying in lockstep.
          const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
          console.warn(
            `[MessagingProvider] messaging session dropped (attempt ${attempt}); reconnecting in ${delay}ms`,
          );
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            // Full forceReconnect, not a bare connect(): a drop is frequently an expired credential,
            // and reconnecting with the same stale one fails identically and forever.
            void forceReconnectRef.current?.();
          }, delay);
        },
        messagingSessionDidReceiveMessage: (message: any) => {
          // Track last message time for staleness detection
          lastMessageTimeRef.current = Date.now();

          const headers = message.headers as Record<string, string> | undefined;
          const eventType = headers?.['x-amz-chime-event-type'];
          if (!eventType) return;

          // ChannelArn lives inside the JSON payload — the SDK's `Message`
          // object only exposes `type`, `headers`, and `payload`. The Chime
          // WS headers do not carry the channel ARN, so we must parse the
          // payload first to route the event to the right channel callback.
          const payload = message.payload ? JSON.parse(message.payload as string) : null;
          if (!payload) return;

          const channelArn =
            (payload.ChannelArn as string | undefined) ||
            headers?.['x-amz-chime-message-channel-arn'] ||
            headers?.['x-amz-chime-channel-arn'];
          if (!channelArn) return;

          // A MEETING'S RING (`meetingRing.ts`): a control message, which is never a message of the conversation. It rings
          // the viewer for what is left of its length, and goes no further: no unread mark, no view. ONE RING KEY, THE MEETING:
          // it sounds in the meeting's own conversation, so a second ring for it changes nothing, and a ring-off for it (the
          // end's, to everyone, or one addressed to this person because they took the meeting elsewhere) stops it here and
          // keeps a ring that arrives after it from sounding. ONE TAB RINGS: the first tab of this browser to hear a meeting's
          // ring claims it (`claimMeetingRing`), and the others show nothing.
          // A RING COUNTS ONLY FROM AN ASSISTANT: the platform sends it as the parent conversation's assistant, so a member's control
          // message rings nobody and stops nothing.
          const sentAt = typeof payload.CreatedTimestamp === 'string' ? Date.parse(payload.CreatedTimestamp) : NaN;
          if (Number.isFinite(sentAt)) fastestDeliveryRef.current = Math.min(fastestDeliveryRef.current, steadyNow() - sentAt);
          if (eventType === 'CREATE_CHANNEL_MESSAGE' && payload.Type === 'CONTROL') {
            const senderArn = (payload.Sender as Record<string, string> | undefined)?.Arn || '';
            const ringOff = isRingOff(payload.Content);
            const seconds = parseRing(payload.Content);
            if (!isAssistantArn(senderArn) || (!ringOff && seconds === null)) return;
            // Every window hears that the meeting started or ended, the meeting window included, so what it shows before
            // joining is read again (`useConversationMeeting`).
            const heardAt = Date.now();
            ringsHeardRef.current.set(conversationIdOf(channelArn), heardAt);
            setRingHeard({ channelArn, at: heardAt });
            if (!takesRings) return;
            if (ringOff) {
              setIncomingRing((r) => (r && r.channelArn === channelArn ? null : r));
              // ITS RING IS OVER for this person: a ring of this meeting that arrives after the ring-off sounds nowhere.
              ringsShownRef.current.set(channelArn, Date.now() + MAX_RING_SECONDS * 1000);
              ringOver(channelArn, Date.now(), MAX_RING_SECONDS);
              return;
            }
            if (seconds !== null && !isRingSettled(channelArn) && (ringsShownRef.current.get(channelArn) ?? 0) <= Date.now()) {
              const endsAt = arrivingRingEndsAt(seconds, payload.CreatedTimestamp as string | undefined, fastestDeliveryRef.current, Date.now(), steadyNow());
              // A person already in this meeting, in a window of this browser (their own start included), hears no ring.
              if (endsAt > Date.now()) unlessInMeeting(conversationIdOf(channelArn), () => {
                if (!claimMeetingRing(conversationIdOf(channelArn))) return;
                ringsShownRef.current.set(channelArn, endsAt);
                setIncomingRing((r) => nextRing(r, { channelArn, endsAt }));
              });
            }
            return;
          }

          // Global listener fires first — regardless of whether a per-channel
          // subscription exists. Used for unread-state tracking across all
          // channels the user is in.
          if (eventType === 'CREATE_CHANNEL_MESSAGE') {
            const senderArn = (payload.Sender as Record<string, string>)?.Arn || '';
            try {
              globalListenerRef.current?.onMessageInAnyChannel?.(channelArn, senderArn);
            } catch (err) {
              console.warn('Global message listener threw:', err);
            }
          }

          // MEETING NEWS IN ANY CONVERSATION: the platform's started or ended card from an assistant, wherever it lands (the
          // meeting's own conversation, which everyone in the parent conversation is a member of, and the parent), carrying the card itself;
          // and this person removed from a conversation. A card's rewrite (its summary) is not news.
          if (eventType === 'CREATE_CHANNEL_MESSAGE') {
            const sender = (payload.Sender as Record<string, string> | undefined)?.Arn || '';
            let meta: Record<string, unknown> = {};
            try { meta = typeof payload.Metadata === 'string' ? JSON.parse(payload.Metadata) as Record<string, unknown> : {}; } catch { meta = {}; }
            try {
              const card = meetingCardFromMetadata(meta, sender);
              if (card) pushNews({ channelArn, at: Date.now(), card, ...(Number.isFinite(sentAt) ? { sentAt } : {}) });
            } catch { /* never in the way of the message itself */ }
          } else if (eventType === 'DELETE_CHANNEL_MEMBERSHIP'
            && !!userArn && (payload.Member as { Arn?: string } | undefined)?.Arn === userArn) {
            pushNews({ channelArn, at: Date.now(), removed: true });
          }

          // Global membership hook — fires BEFORE the per-channel bail below, so a membership in a
          // channel we are not yet subscribed to (a channel we were just added to, e.g. a drift-spawned
          // conversation) still reaches the app and can be surfaced in the sidebar.
          if (eventType === 'CREATE_CHANNEL_MEMBERSHIP') {
            try {
              globalListenerRef.current?.onAddedToChannel?.(channelArn);
            } catch (err) {
              console.warn('Global membership listener threw:', err);
            }
          }

          // A CONVERSATION THAT IS GONE, OR NO LONGER THE VIEWER'S, LEAVES THE CLIENT AT ONCE. Deleted anywhere
          // (another client, the console, a reset), or the viewer removed from it: either way it must not stay
          // open or listed until a reload. Another member leaving is an ordinary membership change, below.
          const removedMember = (payload.Member as { Arn?: string } | undefined)?.Arn;
          if (eventType === 'DELETE_CHANNEL'
            || (eventType === 'DELETE_CHANNEL_MEMBERSHIP' && !!userArn && removedMember === userArn)) {
            try {
              globalListenerRef.current?.onRemovedFromChannel?.(channelArn);
            } catch (err) {
              console.warn('Global removal listener threw:', err);
            }
          }

          const callbacks = channelListenerRef.current;
          if (!callbacks) return;

          // Bot replies arrive in one of two shapes:
          //   1. Direct (Lex returned full content): CREATE with the answer.
          //   2. Async (placeholder + update): CREATE with "One moment... <!--corr:-->",
          //      then UPDATE with the real answer.
          // Latency + analytics tracking must fire when the *actual answer*
          // arrives, not when the placeholder lands — otherwise we measure
          // time-to-acknowledgment, which is uniformly fast and useless.
          // Scoped to a channel we are AWAITING a reply in. The handler now sees every channel, so
          // without this a bot reply in a background conversation would be counted as a response to
          // a send we never made. markResponseReceived returns null when there is no pending send
          // for the channel, which is exactly that condition — so it is the gate, not just a no-op.
          const trackBotResponse = (isBot: boolean) => {
            if (!isBot) return;
            try {
              if (!markResponseReceived(channelArn)) return;
              trackEvent('message_received', { isBot: true, channelArn });
            } catch {
              // Tracking must never break message processing
            }
          };

          switch (eventType) {
            case 'CREATE_CHANNEL_MESSAGE': {
              const msg = parseMessagePayload(payload);
              if (msg) {
                // A NOTICE IS NOT A TURN, ON EITHER BRANCH.
                //
                // Excluding it from `trackBotResponse` alone dropped it into the placeholder arm
                // below, where it called `markPlaceholderShown` with NO correlation id (a notice
                // carries no `<!--corr:-->`) and latched `ttffReported` for the channel. The real
                // placeholder, the one that does carry it, then returned early - so the per-turn
                // client/server join contained no queued turns at all, silently. The guard that
                // was meant to remove a bias removed the measurement instead.
                const queueNotice = isQueueNotice(payload.Metadata as string | undefined);
                if (msg.isBot
                  && !isAsyncPlaceholder(payload.Content as string | undefined)
                  && !queueNotice) {
                  trackBotResponse(true);
                } else if (msg.isBot && !queueNotice) {
                  // The placeholder, which is where the person's wait VISIBLY ends even though the
                  // answer has not arrived (G5). Measured here and not folded into the round trip:
                  // this is time-to-acknowledgment, the primary perceived-latency SLO under
                  // placeholder-then-update delivery, and the server's own TTFF has no way to see the
                  // WebSocket hop and the render that this includes.
                  // The correlation id rides the timing, so this browser-measured wait can be
                  // joined to the server numbers for the SAME turn instead of only compared as an
                  // average against an average.
                  markPlaceholderShown(channelArn, correlationIdOf(payload.Content as string | undefined));
                }
                callbacks.onMessageCreate?.(channelArn, msg);
              }
              break;
            }
            case 'UPDATE_CHANNEL_MESSAGE': {
              const msg = parseMessagePayload(payload, true);
              if (msg) {
                // The async-processor's update is when the real bot reply
                // arrives. markResponseReceived is idempotent (the pending
                // send is deleted on first call), so this is also safe in
                // the direct-CREATE path where the metric was already taken.
                //
                // AND THE NOTICE IS EXCLUDED HERE TOO. The guard went on the CREATE branch only,
                // and `advanceQueueNotice` / `settleQueueNotice` rewrite that same message through
                // UpdateChannelMessage - so queueing a second message recorded a ~1s round trip AND
                // deleted the pending send, leaving the real answer two minutes later to record
                // nothing. Exactly the bias the CREATE-side guard was written to remove, arriving
                // through the UPDATE door. Every notice write carries respPhase: notice, so the
                // same test works on both.
                if (!isQueueNotice(payload.Metadata as string | undefined)) {
                  trackBotResponse(msg.isBot);
                }
                callbacks.onMessageUpdate?.(channelArn, msg);
              }
              break;
            }
            case 'DELETE_CHANNEL_MESSAGE': {
              const msgId = payload.MessageId as string;
              if (msgId) callbacks.onMessageDelete?.(channelArn, msgId);
              break;
            }
            case 'CREATE_CHANNEL_MEMBERSHIP':
            case 'UPDATE_CHANNEL_MEMBERSHIP':
            case 'DELETE_CHANNEL_MEMBERSHIP': {
              callbacks.onMembershipChange?.(channelArn);
              break;
            }
            case 'UPDATE_CHANNEL': {
              // Fires when anyone (typically the bot, on first-message
              // title derive) updates the channel's Name or Metadata.
              // The payload places the new name at `payload.Name`.
              const newName = (payload.Name as string | undefined) || '';
              if (newName) callbacks.onChannelUpdate?.(channelArn, newName, payload.Metadata as string | undefined);
              break;
            }
          }
        },
      });

      await session.start();
    } catch (err) {
      console.error('Failed to start messaging session:', err);
    } finally {
      isConnectingRef.current = false;
    }
  }, [isInitialized, userArn, parseMessagePayload, takesRings]);

  // Force reconnect — stops existing session, refreshes credentials
  // (CRITICAL on visibility-stale paths: tokens cached by AwsClientProvider
  // may be expired after long idle, even though AuthProvider's 50-min
  // refresh interval is throttled by the browser when the tab is hidden),
  // then creates a new session with the fresh client.
  //
  // Force-reconnect pattern. Fixes the
  // stuck "connecting..." failure mode where a user returns after >1hr
  // and the WebSocket handshake fails with an expired credential.
  const forceReconnect = useCallback(async () => {
    // Mark the next messagingSessionDidStart as a reconnect so the
    // observer emits websocket_reconnected rather than _connected.
    isReconnectRef.current = true;
    // A queued auto-reconnect would now be redundant, and would race this one.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // Stop existing session
    if (sessionRef.current) {
      try {
        // Ours, not a fault: the stop observer must not schedule its own reconnect on top of this.
        intentionalStopRef.current = true;
        sessionRef.current.stop();
      } catch (e) {
        intentionalStopRef.current = false;
        console.warn('Error stopping old session:', e);
      }
      sessionRef.current = null;
      setIsConnected(false);
    }

    // Refresh credentials BEFORE reconnecting. AwsClientProvider's
    // useEffect on [user, idToken] will re-run when AuthProvider's
    // setIdToken propagates, calling chimeService.initialize with
    // the fresh idToken — the singleton's messagingClient gets new
    // credentials before connect() reads it below.
    if (refreshCredentials) {
      try {
        await refreshCredentials();
      } catch (err) {
        console.warn('[MessagingProvider] Credential refresh failed; attempting reconnect with existing creds:', err);
      }
    }

    // Brief delay before reconnecting so React's re-render of
    // AwsClientProvider (which calls chimeService.initialize with the
    // fresh idToken) has time to land before we call connect().
    await new Promise(resolve => setTimeout(resolve, 150));
    connect();
  }, [connect, refreshCredentials]);

  // Keep the ref pointing at the current forceReconnect so the stop observer can reach it.
  useEffect(() => {
    forceReconnectRef.current = forceReconnect;
  }, [forceReconnect]);

  // Initial connection
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (sessionRef.current) {
        // Teardown, not a fault: never let unmount schedule a reconnect against a dead provider.
        intentionalStopRef.current = true;
        sessionRef.current.stop();
        sessionRef.current = null;
      }
      setIsConnected(false);
    };
  }, [connect]);

  // Handle visibility changes — reconnect when page becomes visible after idle
  // This handles mobile browsers suspending WebSocket connections in background tabs
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        const hiddenDuration = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
        const timeSinceLastMessage = Date.now() - lastMessageTimeRef.current;

        hiddenAtRef.current = null;

        // Force reconnect if:
        // 1. Session is missing (WebSocket died in background), OR
        // 2. Page was hidden longer than threshold, OR
        // 3. No messages received for longer than threshold (silent dead connection)
        const shouldReconnect =
          !sessionRef.current ||
          hiddenDuration > STALE_SESSION_THRESHOLD_MS ||
          timeSinceLastMessage > STALE_SESSION_THRESHOLD_MS;

        if (shouldReconnect) {
          forceReconnect();
        }
      } else {
        hiddenAtRef.current = Date.now();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [forceReconnect]);

  const setChannelListener = useCallback((callbacks: ChannelCallbacks | null) => {
    channelListenerRef.current = callbacks;
  }, []);

  const setGlobalListener = useCallback((listener: GlobalMessageListener | null) => {
    globalListenerRef.current = listener;
  }, []);

  // WHAT HAPPENED TO A RING THIS APP SHOWED is reported once, for the meeting's analytics: answered with Join, dismissed,
  // or left to run out. A ring stopped because the meeting ended is nobody's answer and is not reported.
  const reportRing = useCallback((ring: IncomingRing | null, outcome: RingOutcome) => {
    if (ring && isMeetingEnabled()) reportRingOutcome(ring.channelArn, outcome, (arn, events) => meetingService.reportEvents(arn, null, events));
  }, []);
  // The ring showing now, read by the handlers below so a report is made outside a state update, which React may repeat.
  const incomingRingRef = useRef<IncomingRing | null>(null);
  incomingRingRef.current = incomingRing;
  // ONE OUTCOME PER RING across this person's tabs (`settleRingOnce`): the tab that settles it first reports it, and the
  // others stop showing it.
  const dismissRing = useCallback((outcome?: 'ringAnswered' | 'ringDismissed') => {
    const ring = incomingRingRef.current;
    if (ring) settleRingOnce(ring.channelArn, ring.endsAt, () => { if (outcome) reportRing(ring, outcome); });
    setIncomingRing(null);
  }, [reportRing]);
  useEffect(() => onRingSettledElsewhere(({ channelArn, until }) => {
    ringsShownRef.current.set(channelArn, Math.max(until, ringsShownRef.current.get(channelArn) ?? 0));
    setIncomingRing((r) => (r && r.channelArn === channelArn ? null : r));
  }), []);
  const ringLate = useCallback((channelArn: string, endsAt: number) => {
    const now = Date.now();
    if (!takesRings || endsAt <= now || (ringsShownRef.current.get(channelArn) ?? 0) > now || isRingSettled(channelArn, now)) return;
    if (!claimMeetingRing(conversationIdOf(channelArn), now)) return;
    ringsShownRef.current.set(channelArn, endsAt);
    setIncomingRing((r) => nextRing(r, { channelArn, endsAt }));
  }, [takesRings]);
  const localTimeOf = useCallback((serverTime: number) => {
    const offset = fastestDeliveryRef.current;
    // The offset is on the steady clock; the answer is said on the wall clock, where the times it is compared with are.
    return Number.isFinite(offset) ? serverTime + offset + (Date.now() - steadyNow()) : serverTime;
  }, []);
  // A SESSION THAT ENDS TAKES ITS RINGS AND ITS MEETING NEWS WITH IT: the next person to sign in on this tab hears no ring
  // meant for, and sees none of the meetings of, the person who was.
  useEffect(() => onSessionEnd(() => {
    incomingRingRef.current = null;
    setIncomingRing(null);
    setRingHeard(null);
    setMeetingNews(null);
    newsLogRef.current = [];
    ringsHeardRef.current = new Map();
    ringsShownRef.current = new Map();
  }), []);

  // THE RING STOPS ON ITS OWN when its time is up.
  useEffect(() => {
    if (!incomingRing) return undefined;
    const timer = setTimeout(() => {
      if (incomingRingRef.current !== incomingRing) return;
      settleRingOnce(incomingRing.channelArn, incomingRing.endsAt, () => reportRing(incomingRing, 'ringTimedOut'));
      setIncomingRing(null);
    }, Math.max(0, incomingRing.endsAt - Date.now()));
    return () => clearTimeout(timer);
  }, [incomingRing, reportRing]);

  return (
    <MessagingContext.Provider value={{ isConnected, sessionVersion, setChannelListener, setGlobalListener, incomingRing, ringHeard, ringHeardAt, meetingNews, meetingNewsAfter, dismissRing, ringLate, localTimeOf }}>
      {children}
    </MessagingContext.Provider>
  );
}

export function useMessaging(): MessagingContextType {
  const context = useContext(MessagingContext);
  if (context === undefined) {
    throw new Error('useMessaging must be used within a MessagingProvider');
  }
  return context;
}
