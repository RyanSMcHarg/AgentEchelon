import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode, useMemo } from 'react';
import type { Conversation, Message, UserTier, Attachment, ChannelMember, StickyMentionTarget } from '@ae/shared';
import { fetchOpenWork, type OpenWorkItem } from '../services/openWorkItemService';
import { useAuth } from '@ae/shared';
import { useAwsClient } from './AwsClientProvider';
import { useMessaging } from './MessagingProvider';
import { sidesWaitingOn, type WaitingSide } from '../utils/battleSideReply';
import { isUnnamedConversation } from '../utils/conversationTitle';
import { conversationIsUnread } from '../utils/conversationUnread';
import i18n from '@ae/shared/i18n';
import { chimeService, type ShareConversationResult } from '../services/chimeService';
import { notificationService } from '../services/notificationService';
import { battleAfterUpdate } from '../services/battleAfterUpdate';
import { announceConversationRead, onConversationReadElsewhere } from '../services/conversationReadSignal';
import { meetingWindowRequest } from '../utils/meetingWindow';
import {
  cacheSession, keepOnlyPersonsComposerCache, newClientMessageId, outboxEntries, putOutboxEntry, removeOutboxEntry, type OutboxEntry,
} from '../services/composerCache';
import { drainOutbox, isOnline, isSendingNow, isUnknownOutcome, sendingNow } from '../services/outbox';
import { trackEvent } from '@ae/shared';
import {
  archiveConversation as archiveConversationApi,
  leaveConversation as leaveConversationApi,
} from '../services/conversationManagementService';

// Tier-specific greeting is now a frontend-only empty-state rendered by
// ConversationInterface (see frontend/src/utils/greeting.ts). Posting it
// as a real Chime message authored by the user caused an unwanted bot
// reply on every new conversation, and re-appeared at the top of every
// channel rather than just empty ones.

/** What a send asks for beside its text. */
export interface SendMessageOptions {
  targetArn?: string;
  mentionBotArn?: string;
  mentionArns?: string[];
  taskId?: string;
}

interface ConversationContextType {
  conversations: Conversation[];
  activeConversation: Conversation | null;
  messages: Message[];
  isLoadingMessages: boolean;
  isInitializing: boolean;
  isSending: boolean;
  isBotTyping: boolean;
  sendError: string | null;
  channelMembers: ChannelMember[];
  /** Derived: true if the channel has a message newer than the last read
   *  marker OR the local in-session viewedAt timestamp. Returns false for
   *  the active conversation (that one is always considered read while
   *  viewing). */
  isConversationUnread: (conv: Conversation) => boolean;
  createConversation: (title: string | undefined, modelId: string, modelName: string, classification: UserTier, topic?: string) => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  /** Deselect the active conversation (return to the list) without removing it.
   *  Drives the mobile master-detail Back affordance. */
  clearActiveConversation: () => void;
  /**
   * Send a message into the active conversation. It is kept in this device's outbox until the service confirms it, so
   * one sent offline, or whose send was never answered, resolves `{ queued: true }` and is sent once when the person is
   * back online. A send the service refused rejects, and nothing is kept.
   */
  sendMessage: (
    content: string,
    attachment?: Attachment,
    options?: SendMessageOptions,
    /**
     * THE CONVERSATION THE MESSAGE WAS WRITTEN IN, captured when the person pressed Send: the message goes there whatever
     * conversation is open by the time it leaves. Absent, the open conversation.
     */
    writtenIn?: { id: string; conversationArn: string },
  ) => Promise<{ queued: boolean } | void>;
  /** The active conversation's messages waiting in this device's outbox, oldest first. */
  queuedMessages: OutboxEntry[];
  /** Send a queued message the service refused again. */
  retryQueuedMessage: (id: string) => void;
  /** Drop a queued message unsent. */
  discardQueuedMessage: (id: string) => void;
  shareConversation: (recipientEmail: string) => Promise<ShareConversationResult>;
  deleteConversation: (conversationId: string) => void;
  /** Archive a conversation for ALL members (moderator only): the backend marks
   *  it read-only + hidden and it drops from every member's list. Persists. */
  archiveConversation: (conversationId: string) => Promise<void>;
  /** Leave a conversation (any member): removes only the caller's membership. Persists. */
  leaveConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, newTitle: string) => Promise<void>;
  clearSendError: () => void;
  /** Sticky mention target: prepended on the next outbound message unless the user types their own @-mention. Set automatically when the bot replies with a targeted message; cleared on channel change or user dismiss. */
  stickyTarget: StickyMentionTarget | null;
  setStickyTarget: (target: StickyMentionTarget | null) => void;
  /** Derived from messages: duel sides in this channel WAITING ON THIS PERSON (their battlewaiting
   *  marker is live and names this viewer as the duel's owner, or names no owner). Empty when none.
   *  Message order, so index 0 is the oldest waiter. A side waiting on somebody else is not here: it
   *  is not this person's to answer, and nothing of theirs is held for it. */
  battleWaitingBots: BattleWaitingSide[];
  /** The duel sides the composer is replying to, chosen through a side's "Reply to this side" control
   *  (DESIGN-BATTLE, "A side parked on the person"). Only sides still waiting on this person stay in
   *  it, so a side that is answered or ends drops out on the message that says so. Empty when the
   *  composer is not replying to a side. */
  replyingToSides: BattleWaitingSide[];
  /** Put the composer into reply-to-side mode for these sides (one, or every waiting side). */
  replyToSides: (botArns: string[]) => void;
  /** Leave reply-to-side mode; the next send is an ordinary message. */
  clearReplyingToSides: () => void;
  /** Work items this user OWNS, across every conversation, oldest first (GET /tasks/mine).
   *  This is the cross-conversation half of "waiting on you": battleWaitingBots derives from the
   *  loaded channel's messages, so the item a user is most likely to have forgotten - the one in a
   *  conversation they are not looking at - is exactly the one it cannot show. */
  openWorkItems: OpenWorkItem[];
  /** The open items have been read at least once since sign-in, so an item missing from them is not open. */
  openWorkLoaded: boolean;
  /**
   * When the items installed now were asked for (ms). A task missing from them is closed only if its card arrived before
   * that: a card newer than the read is not in it yet, and stays answerable until a read asked after it says otherwise.
   */
  openWorkAskedAt?: number;
  /** The items installed now are every open item, so one missing from them is settled; a list at its cap is not. */
  openWorkComplete?: boolean;
  /** Re-read the queue. Called after a send, because answering is what closes an item. */
  refreshOpenWorkItems: () => void;
  /**
   * THE ITEM THE PERSON CHOSE TO ANSWER (ADR-035), or null. Set only by the person, through an item's
   * Answer action: nothing is attached to a message unless they chose it or typed its reference.
   */
  answeringTaskId: string | null;
  /** Choose this item to answer; the composer inserts its `#<n>` once its conversation is open. */
  answerItem: (item: OpenWorkItem) => void;
  /** Stop answering the chosen item. */
  clearAnswering: () => void;
}

/** A duel side waiting on the person, as its `<!--battlewaiting-->` marker states it. */
export type BattleWaitingSide = WaitingSide;

const ConversationContext = createContext<ConversationContextType | undefined>(undefined);

/**
 * Reflect (or clear) the open conversation in the URL as `?conversation=<id>`, so the current
 * conversation is shareable / bookmarkable and a reload reopens it (App.tsx reads this param on load —
 * the inbound deep-link path). Previously the URL only fed IN (a share link opened a conversation) and
 * never updated OUT when one was opened. `replaceState` keeps conversation switches out of the history
 * stack; a null id clears the param when the detail pane is closed.
 */
/** The person a messaging ARN names: its last segment, the AppInstanceUser id. */
/** The pauses before what waits in the outbox is sent again while the browser is online, the last repeated. */
export const OUTBOX_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

function personIdOf(arn: string | null | undefined): string | undefined {
  return arn ? arn.split('/').pop() || undefined : undefined;
}

function reflectConversationInUrl(conversationId: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (conversationId) url.searchParams.set('conversation', conversationId);
    else url.searchParams.delete('conversation');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* non-browser / malformed URL — URL reflection is a nicety, never fatal */
  }
}

export function ConversationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { isInitialized, userArn: viewerArn } = useAwsClient();
  const { setChannelListener, setGlobalListener, sessionVersion, localTimeOf } = useMessaging();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [stickyTarget, setStickyTarget] = useState<StickyMentionTarget | null>(null);
  /** This person's outbox, read again whenever it changes here. */
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const refreshQueued = useCallback(() => {
    const personId = personIdOf(viewerArn);
    // A message whose send is running now is not waiting, so it is not listed.
    setOutbox(personId ? outboxEntries(personId).filter((e) => !isSendingNow(e.id)) : []);
  }, [viewerArn]);
  useEffect(() => { refreshQueued(); }, [refreshQueued]);
  // A SIGN-IN KEEPS ONLY ITS OWN PERSON'S UNSENT WORK on this device: what another person's session left behind is removed.
  useEffect(() => {
    const personId = personIdOf(viewerArn);
    if (personId) void keepOnlyPersonsComposerCache(personId);
  }, [viewerArn]);

  // A sticky target belongs to the conversation it was set in. It is set from a mention the user
  // JUST SENT, so carrying it into a different conversation asserts a targeted exchange that never
  // happened there - and the composer then prepends `@Name ` to everything the user types, often
  // naming a member of the OTHER channel entirely. Keyed on the ARN so a rename or archive, which
  // replaces the conversation object without changing which conversation is open, does not clear it.
  useEffect(() => {
    setStickyTarget(null);
  }, [activeConversation?.conversationArn]);

  const channelMembersRef = useRef<ChannelMember[]>([]);
  channelMembersRef.current = channelMembers;
  // In-session viewedAt map. channelArn -> millis timestamp. Combined with
  // Chime's eventually-consistent ReadMarkerTimestamp to decide unread
  // state without flickering on immediate reopens.
  const [viewedAt, setViewedAt] = useState<Record<string, number>>({});
  // Ephemeral "new message arrived since last view" timestamps — this is
  // how we flip channels to unread in real time from the WebSocket global
  // listener without waiting for the next listConversations refetch.
  const [unreadTicks, setUnreadTicks] = useState<Record<string, number>>({});
  /** Whether this window is a meeting window, read once as the app reads it. */
  const [inMeetingWindow] = useState(() => meetingWindowRequest() !== null);
  const unreadTicksRef = useRef(unreadTicks);
  unreadTicksRef.current = unreadTicks;
  const botTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const activeConversationRef = useRef<Conversation | null>(null);
  activeConversationRef.current = activeConversation;

  // Live view of the rendered messages, so the create-time reconcile can tell "already delivered"
  // from "still missing" without re-running on every state change.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  /**
   * Swap the active conversation, updating the ref SYNCHRONOUSLY as well as the state.
   *
   * The channel-event handler reads this ref to decide what to render. React commits state on the
   * next render, so setting state alone leaves a window - short, but real - in which the ref still
   * names the PREVIOUS conversation and an arriving message is discarded as "not active". That is
   * the same class of defect as the create-then-subscribe window this refactor removed, so it is
   * closed the same way rather than left as a smaller version of it.
   *
   * The render-time assignment above remains the source of truth for subsequent renders; this only
   * makes the handoff atomic.
   */
  const setActiveConversationNow = useCallback((conv: Conversation | null) => {
    activeConversationRef.current = conv;
    setActiveConversation(conv);
  }, []);

  /**
   * Recover the assistant's on-add welcome if neither the socket nor the initial load caught it.
   * See the call site in createConversation for why that window exists and cannot be closed by
   * listener design alone.
   *
   * Bounded and self-cancelling: it stops at the first assistant message, when the user navigates
   * away, or after the budget. Merges by id so an optimistic user message is never dropped, and
   * only ever ADDS - it cannot remove a message the socket delivered.
   */
  /**
   * Merge messages read from history into the rendered list: ADD the ones not already shown, never
   * remove or reorder what the socket delivered except by timestamp. Returns how many were added.
   * Shared by the create-time welcome reconcile and the catch-up on (re)connect.
   */
  const mergeFetchedMessages = useCallback((fetched: Message[], why: string): void => {
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const missing = fetched.filter((m) => !seen.has(m.id));
      if (missing.length === 0) return prev;
      console.warn(`[ConversationProvider] recovered ${missing.length} message(s) missed ${why}`);
      return [...prev, ...missing].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    });
  }, []);

  const reconcileNewConversationWelcome = useCallback(async (channelArn: string) => {
    const DELAYS_MS = [400, 800, 1500, 2500, 4000];

    for (const delay of DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay));
      // Navigated away, or the socket delivered it while we waited.
      if (activeConversationRef.current?.conversationArn !== channelArn) return;
      if (messagesRef.current.some((m) => m.isBot)) return;

      try {
        const fetched = await chimeService.listMessages(channelArn);
        if (activeConversationRef.current?.conversationArn !== channelArn) return;
        if (!fetched.some((m) => m.isBot)) continue;

        mergeFetchedMessages(fetched, 'during conversation create');
        return;
      } catch (err) {
        console.warn('[ConversationProvider] welcome reconcile attempt failed:', err);
      }
    }
  }, [mergeFetchedMessages]);

  // Load conversations when AWS clients are initialized
  useEffect(() => {
    async function loadConversations() {
      if (!isInitialized || !user) {
        setIsInitializing(!user);
        return;
      }

      try {
        setIsInitializing(true);
        /**
         * THE LIST IS THE MEMBERSHIPS THE PLATFORM GRANTED. The client does not subtract from it.
         *
         * This used to filter the result through a hardcoded basic/standard/premium rank, which was wrong
         * three ways. `listConversations` already asks
         * `ListChannelMembershipsForAppInstanceUser` with the person's own bearer, so the server has
         * already answered "which conversations is this person in" and enforced it; filtering afterwards
         * could only remove conversations they are legitimately a member of, including ones they created.
         * It ranked on `modelTier`, which comes from channel Metadata that members can write
         * (`chime:UpdateChannel`) - the same reason `useAttachmentCapability` refuses to read it. And it
         * failed OPEN: `modelTier` defaults to 'basic' when metadata is missing or unparseable, which is
         * exactly the bucket a basic-tier reader was allowed to see.
         *
         * It also made the same conversation appear or not depending on how someone arrived, because a
         * deep link resolves a channel directly and folds it in with no filter applied.
         *
         * The backend removed the classification ladder; this was the last place imposing it.
         */
        /**
         * RENDERED PAGE BY PAGE, so startup does not wait on the whole account.
         *
         * `listConversations` follows every page, which is what stopped the sidebar truncating silently.
         * Awaiting all of it before the first render made startup linear in membership count - six
         * sequential round trips on an account with 289 of them, before anything appeared. The callback
         * hands over the accumulated list after each page, so the first page is on screen while the rest
         * arrive, and the final value is still the complete list.
         */
        setConversations(await chimeService.listConversations(setConversations));
      } catch (error) {
        console.error('Failed to load conversations:', error);
      } finally {
        setIsInitializing(false);
      }
    }

    loadConversations();
  }, [isInitialized, user]);

  // Clear bot typing state
  const clearBotTyping = useCallback(() => {
    setIsBotTyping(false);
    if (botTypingTimeoutRef.current) {
      clearTimeout(botTypingTimeoutRef.current);
      botTypingTimeoutRef.current = undefined;
    }
  }, []);

  // ============================================================
  // Unread tracking
  // ============================================================

  /**
   * Unread if the channel has a message newer than BOTH the server-side
   * read marker AND the in-session viewedAt timestamp. The active
   * conversation is always read — we mark it read on every new message.
   *
   * Why the dual source: Chime's ReadMarkerTimestamp is eventually
   * consistent (seconds to minutes). The in-memory viewedAt map gives us
   * immediate feedback when the user just opened a channel.
   */
  const isConversationUnread = useCallback((conv: Conversation): boolean => {
    if (!conv) return false;
    if (activeConversationRef.current?.id === conv.id) return false;
    // The list's times are the server's and the view and arrival times this device's; each is compared on its own clock.
    return conversationIsUnread({
      lastMessageAt: conv.lastMessageAt,
      lastReadAt: conv.lastReadAt,
      arrivedAt: unreadTicks[conv.conversationArn],
      viewedAt: viewedAt[conv.conversationArn],
      localTimeOf,
    });
  }, [unreadTicks, viewedAt, localTimeOf]);

  /**
   * THE OPEN CONVERSATION IS READ ONCE THE PERSON IS BACK IN FRONT OF IT. A message that arrives in it while this window
   * is in the background or behind another (a meeting window, another person's window beside it) is recorded as an
   * arrival; when the window is focused and visible again the conversation on screen is marked read, here and on the
   * server, so it carries no unread mark once the person moves on or reloads.
   */
  useEffect(() => {
    const onBack = () => {
      if (typeof document === 'undefined' || document.hidden || !document.hasFocus()) return;
      const active = activeConversationRef.current;
      if (!active) return;
      const arn = active.conversationArn;
      // Only a conversation something arrived in while the person was away has anything to mark.
      if (!(arn in unreadTicksRef.current)) return;
      setViewedAt((prev) => ({ ...prev, [arn]: Date.now() }));
      setUnreadTicks((prev) => {
        if (!(arn in prev)) return prev;
        const next = { ...prev };
        delete next[arn];
        return next;
      });
      void chimeService.markConversationRead(arn);
      announceConversationRead(arn);
    };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, []);

  // A CONVERSATION ANOTHER WINDOW READ (`conversationReadSignal.ts`) is read here too: a meeting's chat read in the meeting
  // window leaves no mark on the meeting, or on its room, in the app beside it.
  useEffect(() => onConversationReadElsewhere((arn) => {
    setViewedAt((prev) => ({ ...prev, [arn]: Date.now() }));
    setUnreadTicks((prev) => {
      if (!(arn in prev)) return prev;
      const next = { ...prev };
      delete next[arn];
      return next;
    });
  }), []);

  // Request browser notification permission on first mount — silent
  // no-op if the user has already accepted or denied.
  useEffect(() => {
    void notificationService.requestPermission();
  }, []);

  // Close any active notifications on unmount / logout
  useEffect(() => {
    return () => notificationService.closeAll();
  }, []);

  // Global WebSocket listener — flips unread state on inactive channels
  // in real time and fires browser notifications when the document is
  // not focused. The active conversation immediately marks read instead.
  useEffect(() => {
    setGlobalListener({
      onMessageInAnyChannel: (channelArn, senderArn) => {
        const myUserArn = chimeService.getUserArn();
        // Ignore our own messages — they never create unread state
        if (myUserArn && senderArn === myUserArn) return;

        const active = activeConversationRef.current;
        const isActiveChannel = active && active.conversationArn === channelArn;
        const isDocumentFocused =
          typeof document !== 'undefined' && !document.hidden && document.hasFocus();

        if (isActiveChannel && isDocumentFocused) {
          // Active channel AND tab focused: mark read eagerly
          setViewedAt((prev) => ({ ...prev, [channelArn]: Date.now() }));
          chimeService.markConversationRead(channelArn);
          announceConversationRead(channelArn);
          return;
        }

        // Otherwise: record the tick so isConversationUnread flips this
        // conversation to unread on the next render
        setUnreadTicks((prev) => ({ ...prev, [channelArn]: Date.now() }));

        // ── A BROWSER NOTIFICATION IS FOR SOMEBODY WHO IS NOT LOOKING ─────────
        //
        // This fired whenever the message was not in the ACTIVE channel, focus notwithstanding, so a
        // person reading conversation A got an OS notification for conversation B while watching the
        // sidebar flip it to unread in front of them. Two signals for one event, one of which
        // interrupts the desktop.
        //
        // The unread state above is the in-app signal and it is already correct for this case. The
        // notification is for the case the app cannot cover: the tab is hidden, or the window is
        // behind something else. So it is gated on the document, not on which channel is open.
        if (isDocumentFocused) return;
        // A MEETING WINDOW NOTIFIES NOTHING: it is one meeting, and the app beside it notifies for every conversation, so a
        // click opens the conversation there and never takes the meeting window's chat away from its meeting.
        if (inMeetingWindow) return;
        // Find the conversation so we can show its title and route the click back to it. We don't
        // put the model name in the title/body: the router picks models per-intent within a tier, so
        // "Sonnet replied" can be wrong.
        const conv = conversations.find((c) => c.conversationArn === channelArn);
        const title = conv?.title && !isUnnamedConversation(conv.title) ? conv.title : i18n.t('notifications.newMessageTitle');
        const isBot = senderArn.includes('/bot/');
        const body = isBot
          ? i18n.t('notifications.botReplied')
          : i18n.t('notifications.memberMessage');
        notificationService.notifyNewMessage({
          channelArn,
          title,
          body,
          onClick: () => {
            if (conv) void selectConversationRef.current?.(conv.id);
          },
        });
      },
      onAddedToChannel: (channelArn) => {
        // A CREATE_CHANNEL_MEMBERSHIP arrived for a channel we don't track yet -> we were just added
        // (e.g. a drift-spawned conversation, or being added to a shared room). Surface it in the
        // sidebar so it appears - and can show its unread dot - even if we never navigate to it. The
        // functional update dedupes against a concurrent add; skip the fetch if we already have it.
        if (conversations.some((c) => c.conversationArn === channelArn)) return;
        void chimeService.getConversation(channelArn)
          .then((fetched) => {
            if (!fetched) return;
            setConversations((prev) => (prev.some((c) => c.id === fetched.id) ? prev : [fetched, ...prev]));
          })
          .catch((err) => console.warn('[ConversationProvider] could not surface newly-joined channel:', err));
      },
      onRemovedFromChannel: (channelArn) => {
        // Deleted, or the viewer removed from it: it leaves the list, and if it is the one open, it closes,
        // the same way a conversation the viewer deletes themselves does.
        setConversations((prev) => prev.filter((c) => c.conversationArn !== channelArn));
        if (activeConversationRef.current?.conversationArn === channelArn) {
          setActiveConversationNow(null);
          reflectConversationInUrl(null);
          setMessages([]);
        }
      },
    });

    return () => setGlobalListener(null);
  }, [setGlobalListener, conversations]);

  // Ref so the global listener closure can route clicks to the latest
  // selectConversation without being recreated on every conversations
  // change — it captures conversations for the notification title, but
  // navigation goes through a stable ref.
  const selectConversationRef = useRef<((id: string) => Promise<void>) | null>(null);

  // Drift-confirm redirect: when a bot message arrives carrying a NAVIGATE_CHANNEL marker, switch to the
  // new channel. It may not be in our local `conversations` list yet (the membership-change event lags),
  // so DON'T poll the list: the previous retry loop closed over a STALE `conversations` snapshot (captured
  // when the marker arrived) and never saw the channel land, so navigation silently failed ("target never
  // appeared in local list"). Instead resolve it DIRECTLY — `selectConversation` fetches a not-yet-listed
  // channel via DescribeChannel (the deep-link path) and folds it in. The conversation id is the ARN's
  // last segment (chimeService builds it as `ChannelArn.split('/').pop()`), and the channel already exists
  // server-side by the time this marker arrives (the bot creates it and adds the user before replying).
  const handleNavigateChannel = useCallback((targetArn: string) => {
    const id = targetArn.split('/').pop();
    if (!id) {
      console.warn('[ConversationProvider] NAVIGATE_CHANNEL: could not derive a conversation id from', targetArn);
      return;
    }
    void selectConversationRef.current?.(id);
  }, []);

  // WebSocket callbacks for the active conversation
  const handleMessageCreate = useCallback((msg: Message) => {
    const userArn = chimeService.getUserArn();
    if (userArn && msg.sender.arn === userArn) return;

    if (msg.isBot) clearBotTyping();

    // Sticky reply: a message TARGETED to me (an @assistant reply I asked for,
    // or a direct @mention from another member) pins the sender so my next reply
    // continues the targeted thread without retyping the mention. `targetedToUser`
    // is authoritative now that a broadcast / 1:1 reply is never spuriously
    // Target-ed (the tail-chunk over-targeting is fixed backend-side). Uses the
    // message's own sender (ARN + name); no channel-member lookup needed.
    if (msg.targetedToUser) {
      setStickyTarget({
        userArn: msg.sender.arn,
        name: msg.sender.name || (msg.isBot ? i18n.t('tier.assistant') : 'Member'),
        isBot: msg.isBot,
        isAll: false,
      });
    }

    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });

    // Drift-confirm: bot message carries a NAVIGATE_CHANNEL marker.
    if (msg.isBot && msg.navigateChannel) {
      handleNavigateChannel(msg.navigateChannel.channelArn);
    }
  }, [clearBotTyping, handleNavigateChannel]);

  const handleMessageUpdate = useCallback((msg: Message) => {
    if (msg.isBot) clearBotTyping();

    // Sticky-target hook for the async-processor path: if we missed the CREATE
    // (joined mid-conversation, WebSocket reconnected), the targeted UPDATE is
    // our only signal, so set sticky here too. Same rule as handleMessageCreate.
    if (msg.targetedToUser) {
      setStickyTarget({
        userArn: msg.sender.arn,
        name: msg.sender.name || (msg.isBot ? i18n.t('tier.assistant') : 'Member'),
        isBot: msg.isBot,
        isAll: false,
      });
    }

    // Drift-confirm: bot message carries a NAVIGATE_CHANNEL marker.
    // Per the CREATE-only audit lesson, run the navigate hook on UPDATE too
    // — async-processor responses arrive via UPDATE and may carry the marker.
    if (msg.isBot && msg.navigateChannel) {
      handleNavigateChannel(msg.navigateChannel.channelArn);
    }

    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id);
      if (idx === -1) {
        // Message not in state yet (placeholder arrived via Lex, not WebSocket).
        // Add it as a new message — this is the actual bot response.
        return [...prev, msg];
      }
      const updated = [...prev];
      // Selective field merge. `...updated[idx]` preserves fields the
      // UPDATE doesn't carry — critically `battle`, `navigateChannel`,
      // and `sender`. The `/battle` marker is written on the round-1/2
      // *placeholder* (CREATE); the async processor's updateMessage
      // overwrites Content with the model reply and no marker, so the
      // UPDATE-parsed `msg.battle` is null. Preserving battle here is
      // load-bearing — it is why variant chips, the round-2 divider,
      // and the scorecard keep rendering after the reply lands. DO NOT
      // add `battle` to the override list as a blind `msg.battle`.
      //
      // Emission wiring note: when the async processor
      // delivers the compact per-variant summary, MERGE its
      // summary fields into the existing battle (keep battleId/round/
      // rivalArn from the placeholder, add responseMs/estCostUsd/steps),
      // e.g. `battle: msg.battle ? { ...updated[idx].battle, ...msg.battle }
      // : updated[idx].battle`. A wholesale replace would drop the
      // placeholder identity; omitting it (current) means the summary
      // never reaches the scorecard.
      updated[idx] = {
        ...updated[idx],
        content: msg.content,
        // #1 emission wiring: the UPDATE carries the compact battle
        // summary via the <!--battlestats:--> marker. MERGE it onto the
        // placeholder-derived battle (keep battleId/round/rivalArn from
        // the placeholder; add responseMs/estCostUsd/steps) — never a
        // wholesale replace, which would drop the placeholder identity.
        // A placeholder that became a receipt carries no duel identity
        // at all (`battleAfterUpdate`).
        battle: battleAfterUpdate(updated[idx].battle, msg),
        turnKind: msg.turnKind ?? updated[idx].turnKind,
        // A DASHBOARD MESSAGE IS UPDATED IN PLACE ON EVERY REFRESH: its new time and state replace the old, so an open
        // dashboard reads again and its card says what the message says.
        dashboard: msg.dashboard ?? updated[idx].dashboard,
        // battleWaiting is the OPPOSITE of battle: REPLACE, never
        // preserve. The waiting marker rides the placeholder UPDATE
        // (2B-vii); when the bot resumes, 2B-x-e reuses that SAME
        // message and the answer UPDATE carries no marker → msg.battle-
        // Waiting is undefined → it must clear here. That clearing IS
        // the "waiting ended" signal the composer affordance keys off.
        battleWaiting: msg.battleWaiting,
        activeTask: msg.activeTask,
        // WHICH STEP OF THE ANSWER THIS UPDATE IS. Taken from the UPDATE, not preserved from the
        // CREATE, because that is the whole point: the placeholder says `placeholder`, an in-flight
        // correction says `interim`, and the settled answer says `final`. Omitted from this list, the
        // field never changed after the CREATE - which is the failure this merge's own comment warns
        // about, and it cost three e2e runs to find, because the attribute simply never appeared and a
        // guard reading it skipped silently.
        responsePhase: msg.responsePhase ?? updated[idx].responsePhase,
        // HOW MANY ARE WAITING, from the UPDATE for exactly the reason above. The deferral notice is
        // posted with a depth, updated as more messages queue, and updated to ZERO when the drain
        // empties it - and that last update is the event the client watches to clear the waiting
        // styling. Omitted from this list, the depth stayed at whatever the CREATE said, the signal
        // derived from it never changed, and the styling never cleared: the same failure this
        // merge's comment warns about, one field along. `??` keeps a real 0, which is the value
        // that matters most here.
        queueDepth: msg.queueDepth ?? updated[idx].queueDepth,
        // KEPT ACROSS UPDATES, because a stage arrives on one message among many and the merge would
        // otherwise drop it - but NOT past the point where the queue is empty. A settled notice that
        // carried no stage left the last one showing forever, pulsing under a notice that said the
        // opposite. An empty queue has no stage by definition, whatever the server did or did not say.
        queueStatus: msg.queueDepth === 0
          ? undefined
          : msg.queueStatus ?? updated[idx].queueStatus,
        queueStatusLabel: msg.queueStatusLabel ?? updated[idx].queueStatusLabel,
        attachment: msg.attachment ?? updated[idx].attachment,
        modelId: msg.modelId ?? updated[idx].modelId,
        intent: msg.intent ?? updated[idx].intent,
        // Experiment feedback join: the answer
        // UPDATE carries the analytics metadata, but preserve any value already
        // on the placeholder so a metadata-less UPDATE can't drop the join.
        experimentId: msg.experimentId ?? updated[idx].experimentId,
        variantId: msg.variantId ?? updated[idx].variantId,
        assignmentMode: msg.assignmentMode ?? updated[idx].assignmentMode,
        feedback: msg.feedback ?? updated[idx].feedback ?? null,
        responseGroup: msg.responseGroup ?? updated[idx].responseGroup,
        continuation: msg.continuation ?? updated[idx].continuation,
        part: msg.part ?? updated[idx].part,
        totalParts: msg.totalParts ?? updated[idx].totalParts,
      };
      return updated;
    });
  }, [clearBotTyping, handleNavigateChannel]);

  const handleMessageDelete = useCallback((msgId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
  }, []);

  // Refresh the member list when someone joins or leaves the active channel.
  // Chime's at-least-once delivery makes incremental reconciliation brittle,
  // so we just refetch.
  const handleMembershipChange = useCallback(async () => {
    const current = activeConversationRef.current;
    if (!current) return;
    try {
      const members = await chimeService.listChannelMembers(current.conversationArn);
      setChannelMembers(members);
    } catch (err) {
      console.error('Failed to refresh channel members:', err);
    }
  }, []);

  /** Apply a channel update from a Chime UPDATE_CHANNEL event: its name, and the archive's `archived`
   *  display mirror in its Metadata (the same mirror `chimeService` reads on a list), so a conversation
   *  archived while it is open, such as a meeting's own once the meeting ends, turns read-only in front
   *  of the person. Updates the sidebar entry AND the active conversation if this is the one open. */
  const handleChannelUpdate = useCallback((channelArn: string, name: string, metadata?: string) => {
    let archived = false;
    try { archived = !!metadata && (JSON.parse(metadata) as { archived?: unknown }).archived === true; } catch { /* no mirror */ }
    const apply = (c: Conversation): Conversation => ({ ...c, title: name, ...(archived ? { archived: true } : {}) });
    setConversations((prev) =>
      prev.map((c) => (c.conversationArn === channelArn ? apply(c) : c))
    );
    if (activeConversationRef.current?.conversationArn === channelArn) {
      setActiveConversation((prev) => (prev ? apply(prev) : prev));
    }
  }, []);

  /**
   * RE-READ WHAT THE SESSION WOULD HAVE PUSHED, EACH TIME A SESSION STARTS.
   *
   * Anything that holds data the session would have pushed lists `sessionVersion` as a dependency and re-reads on
   * every (re)connect, because a message posted while no session was running is never pushed again. On a slow page
   * the session endpoint can answer about 5 s after the conversation opens, and an assistant's targeted reply that
   * lands in that gap is delivered and readable in history, and shown only by the re-read.
   *
   * THIS APP HAS ONE app-level handler and one list, so the open conversation is
   * MERGED: a message not shown is added, and one shown with different content goes through the same
   * path a live UPDATE takes (most answers arrive as an update to a placeholder, so a missed UPDATE
   * would otherwise leave "One moment..." on screen). Replacing the list would drop an optimistic
   * message the history read has not caught up with yet.
   *
   * The sidebar re-fetches on a RECONNECT only (sessionVersion > 1): the first session starts right
   * after the initial load, which already read it. It is read whole rather than page by page, so a
   * refresh never shows the list shrunk to its first page.
   */
  useEffect(() => {
    if (!sessionVersion) return;
    const channelArn = activeConversationRef.current?.conversationArn;
    if (channelArn) {
      void chimeService.listMessages(channelArn)
        .then((fetched) => {
          if (activeConversationRef.current?.conversationArn !== channelArn) return;
          const shown = new Map(messagesRef.current.map((m) => [m.id, m]));
          for (const m of fetched) {
            const current = shown.get(m.id);
            if (current && current.content !== m.content) handleMessageUpdate(m);
          }
          mergeFetchedMessages(fetched, 'while no messaging session was running');
        })
        .catch((err) => {
          console.warn('[ConversationProvider] catch-up after the session started failed:', err);
        });
    }
    if (sessionVersion > 1) {
      void chimeService.listConversations()
        .then((all) => setConversations(all))
        .catch((err) => {
          console.warn('[ConversationProvider] conversation list refresh after reconnect failed:', err);
        });
    }
  }, [sessionVersion, mergeFetchedMessages, handleMessageUpdate]);

  /**
   * The single channel-event handler, registered once for the whole app.
   *
   * Every event carries its `channelArn` and we branch on the live active-conversation ref: render
   * it, or ignore it (the global listener owns unread bookkeeping for the other channels). That
   * branch is the same guard the old per-conversation callbacks each carried to stop a previous
   * channel's in-flight reply rendering into a newly opened chat - expressed once, in the only place
   * that knows which conversation is current, instead of re-derived at every subscribe site.
   *
   * Registering once is what removes the create-then-subscribe window: the handler exists before any
   * conversation does, so a welcome posted moments after CreateChannel always has somewhere to land.
   * Channel RENAMES are deliberately NOT gated on the active conversation - a title derived for a
   * background conversation should still update its sidebar entry.
   */
  useEffect(() => {
    const isActive = (channelArn: string) =>
      activeConversationRef.current?.conversationArn === channelArn;

    setChannelListener({
      onMessageCreate: (channelArn, msg) => { if (isActive(channelArn)) handleMessageCreate(msg); },
      onMessageUpdate: (channelArn, msg) => { if (isActive(channelArn)) handleMessageUpdate(msg); },
      onMessageDelete: (channelArn, msgId) => { if (isActive(channelArn)) handleMessageDelete(msgId); },
      onMembershipChange: (channelArn) => { if (isActive(channelArn)) handleMembershipChange(); },
      onChannelUpdate: (channelArn, name, metadata) => handleChannelUpdate(channelArn, name, metadata),
    });

    return () => setChannelListener(null);
  }, [
    setChannelListener,
    handleMessageCreate,
    handleMessageUpdate,
    handleMessageDelete,
    handleMembershipChange,
    handleChannelUpdate,
  ]);

  const selectConversation = useCallback(async (conversationId: string) => {
    let conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) {
      // Not in the loaded (paginated) list — e.g. deep-linked from a share or
      // proactive-briefing email to a channel that isn't in the sidebar yet.
      // Resolve it directly by describing the channel (DescribeChannel
      // deep-link path) and fold it into the
      // list so the sidebar shows it too.
      const fetched = await chimeService.getConversation(conversationId);
      if (!fetched) return;
      conversation = fetched;
      setConversations((prev) =>
        prev.some((c) => c.id === fetched.id) ? prev : [fetched, ...prev],
      );
    }

    try {
      setIsLoadingMessages(true);
      setIsBotTyping(false);
      if (botTypingTimeoutRef.current) {
        clearTimeout(botTypingTimeoutRef.current);
        botTypingTimeoutRef.current = undefined;
      }
      setActiveConversationNow(conversation);
      // Drop the OUTGOING conversation's roster before the new one is fetched.
      //
      // Members were only ever replaced once the fetch resolved, so between the switch and that
      // response the panel kept rendering the PREVIOUS conversation's members - a roster that belongs
      // to a different conversation, shown as though it were this one. On a slow fetch, or if the
      // fetch failed (the catch below cleared messages but not members), it stayed wrong.
      //
      // Empty is the honest intermediate state: this conversation's membership is not known yet.
      setChannelMembers([]);
      reflectConversationInUrl(conversation.id); // shareable/bookmarkable URL; reload reopens it
      // The sticky target is cleared by the ARN-keyed effect, not here: this clear ran on EVERY
      // select, so re-opening the conversation already open (clicking it again in the sidebar)
      // dropped a mention the user was still addressing.

      // Mark as read: local viewedAt stamp (immediate) + Chime read
      // marker (authoritative, eventual). Also clear any pending
      // unread tick so the UI doesn't flash unread on reopen.
      const now = Date.now();
      setViewedAt((prev) => ({ ...prev, [conversation.conversationArn]: now }));
      setUnreadTicks((prev) => {
        if (!(conversation.conversationArn in prev)) return prev;
        const next = { ...prev };
        delete next[conversation.conversationArn];
        return next;
      });
      void chimeService.markConversationRead(conversation.conversationArn);
      announceConversationRead(conversation.conversationArn);

      const [conversationMessages, members] = await Promise.all([
        chimeService.listMessages(conversation.conversationArn),
        chimeService.listChannelMembers(conversation.conversationArn),
      ]);
      setMessages(conversationMessages);
      setChannelMembers(members);

      // No per-channel subscription: the app-level handler is already live and branches on the
      // active-conversation ref, which this flow has just set.
    } catch (error) {
      console.error('Failed to load messages:', error);
      setMessages([]);
      // Members too: a failed load must not leave the previous conversation's roster standing in for
      // this one. Clearing messages but not members is what let a stale roster survive an error.
      setChannelMembers([]);
    } finally {
      setIsLoadingMessages(false);
    }
  }, [conversations]);

  // Keep selectConversationRef pointing at the latest callback so the
  // notification click handler routes correctly even after re-renders.
  selectConversationRef.current = selectConversation;

  const createConversation = useCallback(async (
    title: string | undefined,
    modelId: string,
    modelName: string,
    classification: UserTier,
    topic?: string,
  ): Promise<void> => {
    if (!user) return;

    try {
      // THE CLASSIFICATION THE PERSON CHOSE, sent as chosen. It is never inferred from the model, and
      // the server refuses a creation that names none (ADR-046).
      const newConversation = await chimeService.createConversation(title, modelId, modelName, classification, topic);

      // J (cross-chat leak) is now structural rather than a step that can be forgotten: the single
      // handler renders only the ACTIVE conversation, so a previous channel's in-flight battle
      // reply can no longer land in the just-opened chat. That was originally fixed by mirroring
      // selectConversation's unsubscribe(prev) here - the bug being that it was easy to omit.
      //
      // Mask the swap window exactly like selectConversation: clear the
      // outgoing conversation's messages and raise the loading flag BEFORE
      // swapping active. Without this, the previous conversation's messages
      // (and its welcome) keep rendering until listMessages() below resolves —
      // a visible flash, and worse, a window where a caller acting on the
      // "loaded" view (e.g. an e2e that waits for a welcome, then types) binds
      // its input to the stale conversation and the first message is routed to
      // the wrong channel. The loading spinner replaces the stale list, so the
      // new conversation's own welcome is the first assistant message anyone
      // sees or acts on.
      setMessages([]);
      setIsLoadingMessages(true);
      setIsBotTyping(false);
      if (botTypingTimeoutRef.current) {
        clearTimeout(botTypingTimeoutRef.current);
        botTypingTimeoutRef.current = undefined;
      }

      // ONE ROW PER CONVERSATION. The membership event for the new conversation can arrive before this create returns,
      // and its handler already added the row, so the created copy replaces it rather than standing beside it as a second
      // active row for the same conversation.
      setConversations((prev) => [newConversation, ...prev.filter((c) => c.id !== newConversation.id)]);
      setActiveConversationNow(newConversation);
      reflectConversationInUrl(newConversation.id); // the new conversation is the open one: a reload reopens it

      // Greeting is rendered client-side as an empty-state — see
      // utils/greeting.ts and the empty branch in ConversationInterface.
      const conversationMessages = await chimeService.listMessages(newConversation.conversationArn);
      setMessages(conversationMessages);

      // CREATE-TIME RECONCILE. One window survives the app-level handler, and it is inherent to
      // creation rather than to any listener design:
      //
      // The assistant's welcome fires when the BOT IS ADDED, which happens INSIDE
      // chimeService.createConversation() above. So it can be posted before that call returns -
      // before this client has the channel ARN at all. At that instant no active-conversation ref
      // can match it, so the handler correctly ignores it. The listMessages() above should then
      // catch it, but Chime's ListChannelMessages is eventually consistent and runs milliseconds
      // later, so it can miss it too. The result is the symptom this chased for days: an empty
      // conversation carrying an unread dot in the user's own sidebar, because the global
      // (ARN-agnostic) listener saw the message while the rendering path did not.
      //
      // So poll briefly for the assistant's first message, and stop the moment it appears. On the
      // healthy path the socket has already delivered it and the first check exits immediately.
      void reconcileNewConversationWelcome(newConversation.conversationArn);
      trackEvent('conversation_created', { modelId, modelName, modelTier: classification });
    } catch (error) {
      console.error('Failed to create conversation:', error);
      throw error;
    } finally {
      // Drop the loading mask once the fresh (usually empty) message list has
      // been applied, so the client-side greeting empty-state renders.
      setIsLoadingMessages(false);
    }
  }, [user]);

  const sendMessage = useCallback(async (
    content: string,
    attachment?: Attachment,
    options?: SendMessageOptions,
    writtenIn?: { id: string; conversationArn: string },
  ): Promise<{ queued: boolean } | void> => {
    const { taskId, ...sendOptions } = options ?? {};
    const conversation = writtenIn ?? activeConversationRef.current;
    if (!conversation || !user) return;
    /** The conversation the message goes to is still the one open, so it is shown there as it is sent. */
    const shownHere = () => activeConversationRef.current?.conversationArn === conversation.conversationArn;
    const personId = personIdOf(viewerArn);
    const session = cacheSession();
    // INTO THE OUTBOX BEFORE THE SEND, out of it on the service's confirmation (`composerCache.ts`).
    const entry: OutboxEntry = {
      id: newClientMessageId(),
      conversationId: conversation.id,
      channelArn: conversation.conversationArn,
      content,
      ...(attachment || taskId ? { metadata: { ...(attachment ? { attachment } : {}), ...(taskId ? { task: { id: taskId } } : {}) } } : {}),
      ...(Object.keys(sendOptions).length ? { options: sendOptions } : {}),
      createdAt: Date.now(),
    };
    /** A message this device could not keep is never said to be waiting: the person is told, and the field keeps it. */
    const notKept = () => {
      const error = new Error(i18n.t('conversation.notKeptToSend'));
      setSendError(error.message);
      return error;
    };
    if (personId) {
      // AN EARLIER MESSAGE OF THIS CONVERSATION STILL WAITING GOES FIRST: this one joins the outbox behind it, and the
      // outbox sends them in order.
      const earlierWaiting = outboxEntries(personId).some((e) => e.channelArn === conversation.conversationArn && !e.failed);
      const kept = putOutboxEntry(personId, entry, session);
      if (!isOnline() || earlierWaiting) {
        if (!kept) throw notKept();
        refreshQueued();
        if (isOnline()) drainSoonRef.current();
        return { queued: true };
      }
      putOutboxEntry(personId, { ...entry, attempted: true }, session);
    }

    try {
      setIsSending(true);
      setSendError(null);

      // THE TASK REFERENCE, when this message answers a work item (ADR-032). It rides the same
      // metadata blob as an attachment because it is the same kind of fact: something about the
      // message that the message text does not say.
      //
      // It is NOT how the assistant is reached - `options.targetArn` is, and it is what makes the
      // message arrive. The reference exists so a message that arrived at NOBODY can be detected
      // afterwards, off the message stream, and dispatched late instead of stranding. A repair that
      // fires is counted, so the client failing to address a task answer stays visible.
      //
      // THE TASK ID AND NOTHING ELSE. The task already records which assistant owns it, so naming
      // one here would be a second source for one fact, free to disagree with the row it describes.
      const metadata = entry.metadata;
      const userMessage = await sendingNow(entry.id, () => chimeService.sendMessage(
        conversation.conversationArn,
        content,
        metadata,
        { ...sendOptions, ...(taskId ? { taskId } : {}), ...(personId ? { clientMessageId: entry.id } : {}) },
      ));
      if (personId) removeOutboxEntry(personId, entry.id);

      if (attachment) {
        userMessage.attachment = attachment;
      }

      // Shown where it was sent, and only there: a person who moved to another conversation meanwhile sees it on return.
      if (!shownHere()) return { queued: false };
      // Optimistic add — bot response arrives via WebSocket
      setMessages((prev) => [...prev, userMessage]);

      // Title auto-derive happens server-side (see backend
      // async-processor: on the first user message into a channel still
      // named "New conversation", the bot calls UpdateChannel with a
      // Haiku-derived semantic title). The frontend picks the new name
      // up via the Chime channel-update WebSocket event and updates
      // every connected client - no local derivation here.

      // Show typing indicator until bot responds (or 90s timeout for deep reasoning models)
      setIsBotTyping(true);
      if (botTypingTimeoutRef.current) clearTimeout(botTypingTimeoutRef.current);
      botTypingTimeoutRef.current = setTimeout(() => {
        setIsBotTyping(false);
      }, 90000);
      return { queued: false };
    } catch (error) {
      // NEVER HEARD BACK: the message stays in the outbox and is sent, once, when the person is back online, or after a
      // short wait where the browser is online now (a server error or throttling).
      if (personId && isUnknownOutcome(error)) {
        if (!outboxEntries(personId).some((e) => e.id === entry.id)) throw notKept();
        console.warn('Message kept to send again: its send was not answered', error);
        refreshQueued();
        if (isOnline()) drainSoonRef.current();
        return { queued: true };
      }
      if (personId) removeOutboxEntry(personId, entry.id);
      console.error('Failed to send message:', error);
      setSendError(error instanceof Error ? error.message : 'Failed to send message');
      throw error;
    } finally {
      setIsSending(false);
    }
  }, [user, viewerArn, refreshQueued]);

  /**
   * SEND THE OUTBOX WHEN THE PERSON CAN BE HEARD AGAIN: each time a messaging session starts (`sessionVersion`) and each
   * time the browser comes back online, in order and each message once (`outbox.ts`). A message sent into the open
   * conversation joins its list as a send from here does.
   */
  const drainNow = useCallback(() => {
    const personId = personIdOf(viewerArn);
    if (!personId || outboxEntries(personId).length === 0) return;
    void drainOutbox(personId, {
      send: (e) => chimeService.sendMessage(e.channelArn, e.content, e.metadata, { ...e.options, clientMessageId: e.id }),
      sentAlready: (e) => chimeService.sentByClientId(e.channelArn, e.id),
      onSent: (e, sent) => {
        const message = sent as Message | undefined;
        if (!message?.id || activeConversationRef.current?.conversationArn !== e.channelArn) return;
        const attachment = (e.metadata as { attachment?: Attachment } | undefined)?.attachment;
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, attachment ? { ...message, attachment } : message]));
      },
      onChange: refreshQueued,
    }).then(() => {
      // WHAT IS STILL WAITING WHILE THE BROWSER IS ONLINE is sent again after a pause that grows with each try, so a server
      // error or throttling never leaves a message waiting for a reconnect that may not come.
      const left = outboxEntries(personId).some((e) => !e.failed);
      if (left && isOnline()) drainSoonRef.current();
      else drainRetryRef.current = 0;
    });
  }, [viewerArn, refreshQueued]);
  const drainNowRef = useRef(drainNow);
  drainNowRef.current = drainNow;
  /** The pause before the next send of what waits, and how many tries it has had. */
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainRetryRef = useRef(0);
  const drainSoonRef = useRef<() => void>(() => undefined);
  drainSoonRef.current = () => {
    if (drainTimerRef.current) return;
    const delay = OUTBOX_RETRY_DELAYS_MS[Math.min(drainRetryRef.current, OUTBOX_RETRY_DELAYS_MS.length - 1)];
    drainRetryRef.current += 1;
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      drainNowRef.current();
    }, delay);
  };
  useEffect(() => () => { if (drainTimerRef.current) clearTimeout(drainTimerRef.current); }, []);

  useEffect(() => {
    if (sessionVersion) drainNow();
  }, [sessionVersion, drainNow]);

  useEffect(() => {
    const online = () => drainNow();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [drainNow]);

  const retryQueuedMessage = useCallback((id: string) => {
    const personId = personIdOf(viewerArn);
    const entry = personId ? outboxEntries(personId).find((e) => e.id === id) : undefined;
    if (!personId || !entry) return;
    const { failed: _failed, ...rest } = entry;
    putOutboxEntry(personId, rest, cacheSession());
    refreshQueued();
    drainNow();
  }, [viewerArn, refreshQueued, drainNow]);

  const discardQueuedMessage = useCallback((id: string) => {
    const personId = personIdOf(viewerArn);
    if (!personId) return;
    removeOutboxEntry(personId, id);
    refreshQueued();
  }, [viewerArn, refreshQueued]);

  /**
   * The open conversation's share of the outbox, and every message the service refused in a conversation the person no
   * longer has, which no other conversation would ever show, so it can be read and discarded.
   */
  const queuedMessages = useMemo(() => {
    const listed = new Set(conversations.map((c) => c.conversationArn));
    return outbox.filter((e) => e.channelArn === activeConversation?.conversationArn
      || (!!e.failed && conversations.length > 0 && !listed.has(e.channelArn)));
  }, [outbox, activeConversation?.conversationArn, conversations]);

  const deleteConversation = useCallback((conversationId: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));

    if (activeConversationRef.current?.id === conversationId) {
      // Clearing active is the whole deselect: with one app-level handler branching on the active
      // ref, nothing further arrives for this channel once it is no longer current. Uses the atomic
      // setter so the REF clears now rather than at the next commit - the handler reads the ref, so
      // a late CREATE_CHANNEL_MESSAGE arriving in that window would still match this channel and
      // repopulate the list immediately after setMessages([]).
      setActiveConversationNow(null);
      reflectConversationInUrl(null); // the open conversation was deleted — drop it from the URL
      setMessages([]);
    }
  }, []);

  // Resolve a conversation's channel ARN from the current list (or the active one).
  const resolveArn = useCallback((conversationId: string): string | undefined => {
    const fromList = conversations.find((c) => c.id === conversationId)?.conversationArn;
    if (fromList) return fromList;
    return activeConversationRef.current?.id === conversationId
      ? activeConversationRef.current.conversationArn
      : undefined;
  }, [conversations]);

  const archiveConversation = useCallback(async (conversationId: string) => {
    const arn = resolveArn(conversationId);
    if (!arn) throw new Error('Conversation not found');
    // Persist first (moderator-gated, server-side). Membership is NOT removed —
    // the backend only makes the channel read-only (archived tag) + drops
    // moderators, so members keep read-only access until it expires. Mark it
    // archived locally so it leaves the active list (hidden behind "Show archived")
    // and its composer goes read-only, rather than dropping it. The metadata mirror
    // keeps it flagged on reload.
    await archiveConversationApi(arn);
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, archived: true } : c)));
    setActiveConversation((prev) => (prev && prev.id === conversationId ? { ...prev, archived: true } : prev));
  }, [resolveArn]);

  const leaveConversation = useCallback(async (conversationId: string) => {
    const arn = resolveArn(conversationId);
    if (!arn) throw new Error('Conversation not found');
    await leaveConversationApi(arn);
    deleteConversation(conversationId);
  }, [resolveArn, deleteConversation]);

  const renameConversation = useCallback(async (conversationId: string, newTitle: string) => {
    const name = newTitle.trim();
    if (!name) return;
    // The rename UI targets the active conversation; resolve its channel ARN.
    const active = activeConversationRef.current;
    const arn = active && active.id === conversationId ? active.conversationArn : undefined;
    if (!arn) throw new Error('Conversation not found');
    // Persist via Chime UpdateChannel (owner is a ChannelModerator). The Chime
    // channel-update event also syncs the title; update optimistically as well.
    await chimeService.updateChannelName(arn, name);
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, title: name } : c))
    );
    if (activeConversationRef.current?.id === conversationId) {
      setActiveConversation((prev) => (prev ? { ...prev, title: name } : null));
    }
  }, []);

  const shareConversation = useCallback(async (recipientEmail: string): Promise<ShareConversationResult> => {
    if (!activeConversationRef.current || !user) {
      throw new Error('No active conversation');
    }

    try {
      const result = await chimeService.shareConversation(
        activeConversationRef.current.conversationArn,
        activeConversationRef.current.title,
        recipientEmail,
        user.name || user.email
      );

      // Refresh channel members after sharing
      const members = await chimeService.listChannelMembers(activeConversationRef.current.conversationArn);
      setChannelMembers(members);

      return result;
    } catch (error) {
      console.error('Failed to share conversation:', error);
      throw error;
    }
  }, [user]);

  const clearSendError = useCallback(() => setSendError(null), []);

  // The user's own open items, across every conversation. Polled rather than pushed: an item can be
  // opened by an assistant in a channel this client is not subscribed to, so there is no event here to
  // listen for. The interval is deliberately slow - this is an ambient reminder, not a live feed - and
  // a send refreshes it immediately, because answering is what closes an item.
  const [openWorkItems, setOpenWorkItems] = useState<OpenWorkItem[]>([]);
  const [openWorkLoaded, setOpenWorkLoaded] = useState(false);
  const [openWorkAskedAt, setOpenWorkAskedAt] = useState(0);
  const [openWorkComplete, setOpenWorkComplete] = useState(false);
  // ── ONLY THE NEWEST ANSWER IS INSTALLED (code review, 2026-09-09) ─────────────────────────────
  //
  // This became event-driven - the effect below re-reads on every `messages` identity change - and
  // `handleMessageUpdate` returns a fresh array on every UPDATE: placeholder, interim, final, each
  // notice rewrite, each battle round. So one answer can put three of these in flight at once, and
  // they can resolve in any order. An OLDER list that still contained the item the person just
  // closed would then overwrite the fresher one and the item reappeared in the left nav until the
  // five-minute sweep corrected it.
  //
  // The fingerprint below does not help with this: the stale array has a DIFFERENT fingerprint from
  // the fresh one, so it is installed rather than skipped.
  //
  // A sequence number rather than an abort: the request is a plain read with no side effect, so the
  // cheapest correct thing is to let a superseded one finish and discard it.
  const openWorkSeqRef = useRef(0);
  const refreshOpenWorkItems = useCallback(() => {
    const seq = ++openWorkSeqRef.current;
    const askedAt = Date.now();
    void fetchOpenWork().then((read) => {
      // SUPERSEDED. Something newer has been asked since this went out, so this answer is already
      // known to be stale - installing it would be a step backwards.
      if (seq !== openWorkSeqRef.current) return;
      // A READ THAT FAILED SAYS NOTHING about what is open: what was read last stands, and no card is closed by it.
      if (!read) return;
      const { items } = read;
      setOpenWorkLoaded(true);
      setOpenWorkAskedAt(askedAt);
      setOpenWorkComplete(read.complete);
      // KEEP REFERENTIAL IDENTITY when nothing changed. openWorkItems is a dependency of the
      // provider-value useMemo, so a freshly parsed (always-new) array here invalidated the context
      // value and re-rendered every useConversations consumer once a minute even when the queue was
      // identical. The fingerprint covers identity, state and freshness - anything the UI renders
      // moves at least one of these.
      setOpenWorkItems((prev) => {
        const fingerprint = (list: OpenWorkItem[]) =>
          list.map((i) => `${i.taskId}|${i.taskRef ?? ''}|${i.status}|${i.taskState ?? ''}|${i.updatedAt ?? ''}`).join('\n');
        return fingerprint(prev) === fingerprint(items) ? prev : items;
      });
    });
  }, []);
  useEffect(() => {
    if (!user) {
      setOpenWorkItems([]);
      setOpenWorkLoaded(false);
      return;
    }
    refreshOpenWorkItems();
    // A RECONCILIATION SWEEP, not the mechanism. Tenet D6 allows one BEHIND an event path, and there
    // is now an event path: `messages` below re-reads whenever this conversation says anything, and
    // an assistant that opens, advances or closes a task says so in the conversation it opened it
    // in. What the event cannot cover is a task opened in a channel this client is not subscribed
    // to, which is why the sweep stays - and why it is slow rather than the every-minute poll it
    // was, which was doing the whole job on its own.
    const timer = setInterval(refreshOpenWorkItems, 5 * 60_000);
    return () => clearInterval(timer);
  }, [user, refreshOpenWorkItems]);

  // THE EVENT HALF. The open-work list is what the left nav renders, and it went stale for up to a
  // minute after the assistant said the thing that changed it - the person watched a task they had
  // just answered sit open. This is the same message subscription the transcript already has, so it
  // costs one read when something was actually said rather than one a minute forever.
  useEffect(() => {
    if (!user || !messages.length) return;
    refreshOpenWorkItems();
  }, [user, messages, refreshOpenWorkItems]);

  // THE ITEM THE PERSON CHOSE TO ANSWER (ADR-035). Held here rather than in the composer because the
  // choice is made in the open-items list, which is a different component. Choosing only records the
  // item; the list opens its conversation when it is elsewhere, and the composer acts on it once the
  // item's conversation is the one in front of the person.
  const [answeringTaskId, setAnsweringTaskId] = useState<string | null>(null);
  const answerItem = useCallback((item: OpenWorkItem) => setAnsweringTaskId(item.taskId), []);
  const clearAnswering = useCallback(() => setAnsweringTaskId(null), []);

  // WHICH SIDES WAIT ON THIS PERSON, from the messages the sides parked on. A side's marker comes down
  // when it is answered or the duel ends, and the update that takes it down is the event this re-derives
  // on, so nothing here is polled. Only the duel's owner is waited on (`mayAnswerSide`); a marker that
  // names no owner is offered to everyone and the router decides whose answer counts.
  const battleWaitingBots = useMemo(() => sidesWaitingOn(messages, viewerArn), [messages, viewerArn]);

  // THE SIDES THE PERSON CHOSE TO REPLY TO, held here because the choice is made on a message and acted
  // on in the composer, which are different components (the same shape as `answeringTaskId`). Kept as
  // ids and resolved against the live waiting set, so a side that stops waiting leaves the reply mode
  // on its own and the composer never targets a side that is no longer listening.
  const [replyingToSideArns, setReplyingToSideArns] = useState<string[]>([]);
  const replyToSides = useCallback((botArns: string[]) => setReplyingToSideArns(botArns), []);
  const clearReplyingToSides = useCallback(() => setReplyingToSideArns([]), []);
  const replyingToSides = useMemo(
    () => battleWaitingBots.filter((side) => replyingToSideArns.includes(side.botArn)),
    [battleWaitingBots, replyingToSideArns],
  );
  // A reply mode belongs to the conversation it was chosen in.
  useEffect(() => {
    setReplyingToSideArns([]);
  }, [activeConversation?.conversationArn]);

  // Deselect the active conversation (return to the list) without removing it —
  // the mobile Back affordance. Unlike deleteConversation it deletes nothing; it
  // just clears the detail pane, matching the deselect half of the delete/select
  // flows. Clearing active is sufficient: the app-level handler renders only the
  // active conversation, so nothing further lands here until it is reselected.
  const clearActiveConversation = useCallback(() => {
    // Atomic, for the same reason as the delete path: the app-level handler branches on the ref, so
    // leaving it pointing at the closed conversation keeps a late message eligible to render.
    setActiveConversationNow(null);
    reflectConversationInUrl(null); // back to the list — clear the conversation from the URL
    setMessages([]);
  }, []);

  const value: ConversationContextType = useMemo(() => ({
    conversations,
    activeConversation,
    messages,
    isLoadingMessages,
    isInitializing,
    isSending,
    isBotTyping,
    sendError,
    channelMembers,
    isConversationUnread,
    createConversation,
    selectConversation,
    clearActiveConversation,
    sendMessage,
    shareConversation,
    deleteConversation,
    archiveConversation,
    leaveConversation,
    renameConversation,
    clearSendError,
    stickyTarget,
    setStickyTarget,
    battleWaitingBots,
    replyingToSides,
    replyToSides,
    clearReplyingToSides,
    openWorkItems,
    openWorkLoaded,
    openWorkAskedAt,
    openWorkComplete,
    refreshOpenWorkItems,
    answeringTaskId,
    answerItem,
    clearAnswering,
    queuedMessages,
    retryQueuedMessage,
    discardQueuedMessage,
  }), [
    conversations, activeConversation, messages, isLoadingMessages,
    isInitializing, isSending, isBotTyping, sendError, channelMembers,
    isConversationUnread,
    createConversation, selectConversation, clearActiveConversation, sendMessage, shareConversation,
    deleteConversation, archiveConversation, leaveConversation, renameConversation, clearSendError,
    stickyTarget,
    battleWaitingBots,
    replyingToSides,
    replyToSides,
    clearReplyingToSides,
    openWorkItems,
    openWorkLoaded,
    openWorkAskedAt,
    openWorkComplete,
    refreshOpenWorkItems,
    answeringTaskId,
    answerItem,
    clearAnswering,
    queuedMessages,
    retryQueuedMessage,
    discardQueuedMessage,
  ]);

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversations(): ConversationContextType {
  const context = useContext(ConversationContext);
  if (context === undefined) {
    throw new Error('useConversations must be used within a ConversationProvider');
  }
  return context;
}
