import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import {
  DefaultMessagingSession,
  MessagingSessionConfiguration,
  ConsoleLogger,
  LogLevel,
  type MessagingSession,
} from 'amazon-chime-sdk-js';
import { useAwsClient } from './AwsClientProvider';
import { useAuth } from '@ae/shared';
import { chimeService } from '../services/chimeService';
import { markResponseReceived } from '../services/messageLatencyTracker';
import { trackEvent } from '@ae/shared';
import {
  parseMessageContent,
  parseActiveTaskFromMetadata,
  parseMessageFeedbackFromMetadata,
  isEmptyLexEnvelope,
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
   *  subscriber receives the new channel `Name`. */
  onChannelUpdate?: (channelArn: string, channelName: string) => void;
}

/** Cross-channel bookkeeping that is not about rendering: unread state, and surfacing a channel the
 *  user was just added to (a drift-spawned conversation) that is not in the sidebar yet. */
export interface GlobalMessageListener {
  onMessageInAnyChannel?: (channelArn: string, senderArn: string) => void;
  /** Fires on CREATE_CHANNEL_MEMBERSHIP in ANY channel, including one the sidebar does not know
   *  about yet — without it a newly-joined channel never appears until a reload. */
  onAddedToChannel?: (channelArn: string) => void;
}

interface MessagingContextType {
  isConnected: boolean;
  /** Register the single channel-event handler. Pass null to clear it. */
  setChannelListener: (callbacks: ChannelCallbacks | null) => void;
  setGlobalListener: (listener: GlobalMessageListener | null) => void;
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
function isAsyncPlaceholder(rawContent: string | undefined): boolean {
  if (!rawContent) return false;
  return rawContent.includes('<!--corr:') || rawContent.includes('%3C!--corr%3A');
}

export function MessagingProvider({ children }: { children: ReactNode }) {
  const { isInitialized, userArn } = useAwsClient();
  const { refreshCredentials } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const sessionRef = useRef<MessagingSession | null>(null);
  const channelListenerRef = useRef<ChannelCallbacks | null>(null);
  const globalListenerRef = useRef<GlobalMessageListener | null>(null);
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
  const parseMessagePayload = useCallback((payload: Record<string, unknown>): Message | null => {
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
    if (contentType === 'application/amz-chime-lex-msgs') {
      try {
        const parsed = JSON.parse(content);
        const first = parsed?.Messages?.[0]?.Content;
        if (typeof first === 'string') content = first;
      } catch {
        // If we can't parse it, render the raw content as a fallback
      }
    }

    let metadata: Record<string, unknown> = {};
    try {
      if (payload.Metadata) {
        metadata = JSON.parse(payload.Metadata as string);
      }
    } catch {
      // Ignore metadata parse errors
    }

    const senderArn = (payload.Sender as Record<string, string>)?.Arn || '';
    const senderName = (payload.Sender as Record<string, string>)?.Name || 'Unknown';
    const isBot = !!metadata.botResponse || senderArn.includes('/bot/');

    // Apply the same parsing rules as history loading (chimeService.listMessages)
    const decoded = decodeURIComponent(content);
    const { content: cleanContent, activeTask: contentTask, navigateChannel, battle, battleWaiting } = parseMessageContent(decoded);
    const metadataTask = parseActiveTaskFromMetadata(metadata);
    const currentUserArn = chimeService.getUserArn();
    const targets = payload.Target as Array<{ MemberArn?: string }> | undefined;
    // Belt-and-suspenders: Chime's WebSocket CREATE event doesn't reliably
    // echo the Target field to the recipient, so the channel-flow processor
    // also stamps `targetedSender` into the metadata for the sticky-target
    // auto-set. Either signal is sufficient.
    const targetedToUser =
      (!!currentUserArn && Array.isArray(targets)
        && targets.some((t) => t?.MemberArn === currentUserArn))
      || (typeof metadata.targetedSender === 'string'
        && metadata.targetedSender === currentUserArn);

    return {
      id: (payload.MessageId as string) || `msg-${Date.now()}`,
      content: cleanContent,
      sender: { arn: senderArn, name: isBot ? senderName || 'Assistant' : senderName },
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
      // The step of the answer this message is, as the backend declared it. Carried so a reader does
      // not have to guess from the text whether the turn has settled - see `Message.responsePhase`.
      responsePhase: typeof metadata.respPhase === 'string' ? metadata.respPhase : undefined,
      // Multi-part response grouping
      responseGroup: typeof metadata.responseGroup === 'string' ? metadata.responseGroup : undefined,
      continuation: metadata.continuation === true,
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
                if (msg.isBot && !isAsyncPlaceholder(payload.Content as string | undefined)) {
                  trackBotResponse(true);
                }
                callbacks.onMessageCreate?.(channelArn, msg);
              }
              break;
            }
            case 'UPDATE_CHANNEL_MESSAGE': {
              const msg = parseMessagePayload(payload);
              if (msg) {
                // The async-processor's update is when the real bot reply
                // arrives. markResponseReceived is idempotent (the pending
                // send is deleted on first call), so this is also safe in
                // the direct-CREATE path where the metric was already taken.
                trackBotResponse(msg.isBot);
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
              if (newName) callbacks.onChannelUpdate?.(channelArn, newName);
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
  }, [isInitialized, userArn, parseMessagePayload]);

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

  return (
    <MessagingContext.Provider value={{ isConnected, setChannelListener, setGlobalListener }}>
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
