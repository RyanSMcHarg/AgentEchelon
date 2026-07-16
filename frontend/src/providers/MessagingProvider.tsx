import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import {
  DefaultMessagingSession,
  MessagingSessionConfiguration,
  ConsoleLogger,
  LogLevel,
  type MessagingSession,
} from 'amazon-chime-sdk-js';
import { useAwsClient } from './AwsClientProvider';
import { useAuth } from './AuthProvider';
import { chimeService } from '../services/chimeService';
import { markResponseReceived } from '../services/messageLatencyTracker';
import { trackEvent } from '../services/eventTrackingService';
import {
  parseMessageContent,
  parseActiveTaskFromMetadata,
  parseMessageFeedbackFromMetadata,
} from '../utils/messageParser';
import type { Message } from '../types';

export interface ChannelCallbacks {
  onMessageCreate?: (msg: Message) => void;
  onMessageUpdate?: (msg: Message) => void;
  onMessageDelete?: (msgId: string) => void;
  /** Fires on CREATE_CHANNEL_MEMBERSHIP or DELETE_CHANNEL_MEMBERSHIP events.
   *  The subscriber is expected to re-fetch the member list — we don't try
   *  to reconcile individual events into local state because Chime's at-
   *  least-once delivery can drop or duplicate membership events. */
  onMembershipChange?: () => void;
  /** Fires on UPDATE_CHANNEL events — primarily when the bot renames a
   *  channel after deriving a title from the first user message. The
   *  subscriber receives the new channel `Name`. */
  onChannelUpdate?: (channelName: string) => void;
}

/** Global listener fires for EVERY channel the user is a member of,
 *  not just the one currently subscribed via `subscribe()`. Used by
 *  ConversationProvider to flip unread state on inactive channels
 *  without needing per-channel subscriptions. */
export interface GlobalMessageListener {
  onMessageInAnyChannel?: (channelArn: string, senderArn: string) => void;
}

interface MessagingContextType {
  isConnected: boolean;
  subscribe: (channelArn: string, callbacks: ChannelCallbacks) => void;
  unsubscribe: (channelArn: string) => void;
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
  const subscriptionsRef = useRef<Map<string, ChannelCallbacks>>(new Map());
  const globalListenerRef = useRef<GlobalMessageListener | null>(null);
  const isConnectingRef = useRef(false);
  const hiddenAtRef = useRef<number | null>(null);
  const lastMessageTimeRef = useRef<number>(Date.now());
  // Tracks whether the current session is the result of a forceReconnect call
  // so we can emit websocket_reconnected instead of websocket_connected when
  // the next messagingSessionDidStart fires.
  const isReconnectRef = useRef(false);

  // Parse a Chime message payload into our Message type
  const parseMessagePayload = useCallback((payload: Record<string, unknown>): Message | null => {
    if (!payload) return null;

    let content = payload.Content as string | undefined;
    if (!content) return null;

    // Lex bot replies arrive wrapped: `{"Messages":[{"Content":"...","ContentType":"PlainText"}]}`.
    // Empty `Messages` arrays are noise (e.g. Lex returned no response); drop them.
    // Otherwise unwrap so the user sees the actual text.
    const contentType = payload.ContentType as string | undefined;
    if (contentType === 'application/amz-chime-lex-msgs') {
      try {
        const parsed = JSON.parse(content);
        const messages = parsed?.Messages;
        if (Array.isArray(messages)) {
          if (messages.length === 0) return null;
          const first = messages[0]?.Content;
          if (typeof first === 'string') content = first;
        }
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
          setIsConnected(true);
          trackEvent(isReconnectRef.current ? 'websocket_reconnected' : 'websocket_connected');
          isReconnectRef.current = false;
        },
        messagingSessionDidStop: () => {
          sessionRef.current = null;
          setIsConnected(false);
          trackEvent('websocket_disconnected');
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

          const callbacks = subscriptionsRef.current.get(channelArn);
          if (!callbacks) return;

          // Bot replies arrive in one of two shapes:
          //   1. Direct (Lex returned full content): CREATE with the answer.
          //   2. Async (placeholder + update): CREATE with "One moment... <!--corr:-->",
          //      then UPDATE with the real answer.
          // Latency + analytics tracking must fire when the *actual answer*
          // arrives, not when the placeholder lands — otherwise we measure
          // time-to-acknowledgment, which is uniformly fast and useless.
          const trackBotResponse = (isBot: boolean) => {
            if (!isBot) return;
            try {
              markResponseReceived(channelArn);
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
                callbacks.onMessageCreate?.(msg);
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
                callbacks.onMessageUpdate?.(msg);
              }
              break;
            }
            case 'DELETE_CHANNEL_MESSAGE': {
              const msgId = payload.MessageId as string;
              if (msgId) callbacks.onMessageDelete?.(msgId);
              break;
            }
            case 'CREATE_CHANNEL_MEMBERSHIP':
            case 'UPDATE_CHANNEL_MEMBERSHIP':
            case 'DELETE_CHANNEL_MEMBERSHIP': {
              callbacks.onMembershipChange?.();
              break;
            }
            case 'UPDATE_CHANNEL': {
              // Fires when anyone (typically the bot, on first-message
              // title derive) updates the channel's Name or Metadata.
              // The payload places the new name at `payload.Name`.
              const newName = (payload.Name as string | undefined) || '';
              if (newName) callbacks.onChannelUpdate?.(newName);
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
    // Stop existing session
    if (sessionRef.current) {
      try {
        sessionRef.current.stop();
      } catch (e) {
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

  // Initial connection
  useEffect(() => {
    connect();

    return () => {
      if (sessionRef.current) {
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

  const subscribe = useCallback((channelArn: string, callbacks: ChannelCallbacks) => {
    subscriptionsRef.current.set(channelArn, callbacks);
  }, []);

  const unsubscribe = useCallback((channelArn: string) => {
    subscriptionsRef.current.delete(channelArn);
  }, []);

  const setGlobalListener = useCallback((listener: GlobalMessageListener | null) => {
    globalListenerRef.current = listener;
  }, []);

  return (
    <MessagingContext.Provider value={{ isConnected, subscribe, unsubscribe, setGlobalListener }}>
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
