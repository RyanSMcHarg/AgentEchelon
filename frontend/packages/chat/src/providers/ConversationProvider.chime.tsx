import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode, useMemo } from 'react';
import type { Conversation, Message, UserTier, Attachment, ChannelMember, StickyMentionTarget } from '@ae/shared';
import { useAuth } from '@ae/shared';
import { useAwsClient } from './AwsClientProvider';
import { useMessaging } from './MessagingProvider';
import i18n from '@ae/shared/i18n';
import { chimeService, type ShareConversationResult } from '../services/chimeService';
import { notificationService } from '../services/notificationService';
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
  createConversation: (title: string, modelId: string, modelName: string, topic?: string) => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  /** Deselect the active conversation (return to the list) without removing it.
   *  Drives the mobile master-detail Back affordance. */
  clearActiveConversation: () => void;
  sendMessage: (
    content: string,
    attachment?: Attachment,
    options?: { targetArn?: string; mentionBotArn?: string },
  ) => Promise<void>;
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
  /** Derived from messages: bots currently WAITING_FOR_USER in this
   *  channel (battlewaiting marker live on their placeholder). Empty
   *  when none. Drives the composer's "Replying to:" affordance; order
   *  is message order so the LAST entry is the most-recent waiter
   *  (composer default selection, SPEC-BATTLE.md §"Per-bot reply UX"). */
  battleWaitingBots: Array<{ botArn: string; battleId: string }>;
}

const ConversationContext = createContext<ConversationContextType | undefined>(undefined);

/**
 * Reflect (or clear) the open conversation in the URL as `?conversation=<id>`, so the current
 * conversation is shareable / bookmarkable and a reload reopens it (App.tsx reads this param on load —
 * the inbound deep-link path). Previously the URL only fed IN (a share link opened a conversation) and
 * never updated OUT when one was opened. `replaceState` keeps conversation switches out of the history
 * stack; a null id clears the param when the detail pane is closed.
 */
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
  const { isInitialized } = useAwsClient();
  const { subscribe, unsubscribe, setGlobalListener } = useMessaging();

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
  const botTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const activeConversationRef = useRef<Conversation | null>(null);
  activeConversationRef.current = activeConversation;

  // Load conversations when AWS clients are initialized
  useEffect(() => {
    async function loadConversations() {
      if (!isInitialized || !user) {
        setIsInitializing(!user);
        return;
      }

      try {
        setIsInitializing(true);
        const userConversations = await chimeService.listConversations();

        const filteredConversations = userConversations.filter((conv) => {
          if (user.tier === 'premium') return true;
          if (user.tier === 'standard') return conv.modelTier !== 'premium';
          return conv.modelTier === 'basic';
        });

        setConversations(filteredConversations);
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

    // Derive effective "last activity" — prefer the realtime tick over
    // the potentially-stale listConversations snapshot.
    const tick = unreadTicks[conv.conversationArn];
    const lastMessageMs = Math.max(
      conv.lastMessageAt ? conv.lastMessageAt.getTime() : 0,
      tick || 0,
    );
    if (!lastMessageMs) return false;

    const viewed = viewedAt[conv.conversationArn] || 0;
    const markerMs = conv.lastReadAt ? conv.lastReadAt.getTime() : 0;
    const effectiveReadMs = Math.max(markerMs, viewed);

    return lastMessageMs > effectiveReadMs;
  }, [unreadTicks, viewedAt]);

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
          return;
        }

        // Otherwise: record the tick so isConversationUnread flips this
        // conversation to unread on the next render
        setUnreadTicks((prev) => ({ ...prev, [channelArn]: Date.now() }));

        // Browser notification — only when the tab is hidden or the
        // channel isn't currently visible. Find the conversation so we
        // can show its title and route the click back to it. We don't
        // put the model name in the title/body: the router picks models
        // per-intent within a tier, so "Sonnet replied" can be wrong.
        const conv = conversations.find((c) => c.conversationArn === channelArn);
        const title = conv?.title || i18n.t('notifications.newMessageTitle');
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
    });

    return () => setGlobalListener(null);
  }, [setGlobalListener, conversations]);

  // Ref so the global listener closure can route clicks to the latest
  // selectConversation without being recreated on every conversations
  // change — it captures conversations for the notification title, but
  // navigation goes through a stable ref.
  const selectConversationRef = useRef<((id: string) => Promise<void>) | null>(null);

  // Drift-confirm redirect: when a bot message arrives carrying a
  // NAVIGATE_CHANNEL marker, switch the active conversation. The new channel
  // may not be in our local `conversations` list yet (membership-change
  // event lags slightly); retry briefly to give that handler time to fire.
  const handleNavigateChannel = useCallback((targetArn: string) => {
    const attemptNavigate = (attempt: number) => {
      const target = conversations.find((c) => c.conversationArn === targetArn);
      if (target) {
        void selectConversationRef.current?.(target.id);
        return;
      }
      if (attempt < 4) {
        setTimeout(() => attemptNavigate(attempt + 1), 500);
      } else {
        console.warn('[ConversationProvider] NAVIGATE_CHANNEL target never appeared in local list:', targetArn);
      }
    };
    attemptNavigate(0);
  }, [conversations]);

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
        name: msg.sender.name || (msg.isBot ? 'Assistant' : 'Member'),
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
        name: msg.sender.name || (msg.isBot ? 'Assistant' : 'Member'),
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
        battle: msg.battle
          ? { ...(updated[idx].battle ?? {}), ...msg.battle }
          : updated[idx].battle,
        // battleWaiting is the OPPOSITE of battle: REPLACE, never
        // preserve. The waiting marker rides the placeholder UPDATE
        // (2B-vii); when the bot resumes, 2B-x-e reuses that SAME
        // message and the answer UPDATE carries no marker → msg.battle-
        // Waiting is undefined → it must clear here. That clearing IS
        // the "waiting ended" signal the composer affordance keys off.
        battleWaiting: msg.battleWaiting,
        // Generation-out: the image marker rides the placeholder UPDATE
        // (PLACEHOLDER_UPDATE), so msg.battleImage is the authoritative
        // source; fall back to any existing value defensively.
        battleImage: msg.battleImage ?? updated[idx].battleImage,
        activeTask: msg.activeTask,
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

  /** Apply a channel rename from a Chime UPDATE_CHANNEL event. Updates
   *  the sidebar entry AND the active-conversation header if this is
   *  the chat currently open. */
  const handleChannelUpdate = useCallback((channelArn: string, name: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.conversationArn === channelArn ? { ...c, title: name } : c))
    );
    if (activeConversationRef.current?.conversationArn === channelArn) {
      setActiveConversation((prev) => (prev ? { ...prev, title: name } : prev));
    }
  }, []);

  const selectConversation = useCallback(async (conversationId: string) => {
    const prev = activeConversationRef.current;
    if (prev) {
      unsubscribe(prev.conversationArn);
    }

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
      setActiveConversation(conversation);
      reflectConversationInUrl(conversation.id); // shareable/bookmarkable URL; reload reopens it
      setStickyTarget(null);

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

      const [conversationMessages, members] = await Promise.all([
        chimeService.listMessages(conversation.conversationArn),
        chimeService.listChannelMembers(conversation.conversationArn),
      ]);
      setMessages(conversationMessages);
      setChannelMembers(members);

      // Defensive belt-and-suspenders (mirrors createConversation): guard
      // each callback against the live activeConversation so a late event
      // arriving after a switch can't leak into the wrong chat.
      const arn = conversation.conversationArn;
      subscribe(arn, {
        onMessageCreate: (msg) => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMessageCreate(msg);
        },
        onMessageUpdate: (msg) => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMessageUpdate(msg);
        },
        onMessageDelete: (id) => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMessageDelete(id);
        },
        onMembershipChange: () => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMembershipChange();
        },
        onChannelUpdate: (name) => {
          // No active-conversation guard: a rename can land while the
          // user is on a different chat and we still want the sidebar
          // entry to update.
          handleChannelUpdate(arn, name);
        },
      });
    } catch (error) {
      console.error('Failed to load messages:', error);
      setMessages([]);
    } finally {
      setIsLoadingMessages(false);
    }
  }, [conversations, subscribe, unsubscribe, handleMessageCreate, handleMessageUpdate, handleMessageDelete, handleMembershipChange, handleChannelUpdate]);

  // Keep selectConversationRef pointing at the latest callback so the
  // notification click handler routes correctly even after re-renders.
  selectConversationRef.current = selectConversation;

  const createConversation = useCallback(async (
    title: string,
    modelId: string,
    modelName: string,
    topic?: string,
  ): Promise<void> => {
    if (!user) return;

    try {
      let modelTier: UserTier = 'basic';
      if (modelId.includes('opus')) modelTier = 'premium';
      else if (modelId.includes('sonnet') || modelId.includes('titan')) modelTier = 'standard';

      const newConversation = await chimeService.createConversation(title, modelId, modelName, modelTier, topic);

      // J: cross-chat leak. createConversation was missing the
      // unsubscribe(prev) that selectConversation does — so the previous
      // channel's subscription stayed alive and its in-flight battle
      // reply rendered into the just-opened new chat. Mirror the switch
      // pattern: drop the prior subscription before swapping active.
      const prevConv = activeConversationRef.current;
      if (prevConv) unsubscribe(prevConv.conversationArn);

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

      setConversations((prev) => [newConversation, ...prev]);
      setActiveConversation(newConversation);

      // Defensive belt-and-suspenders: guard each callback against the
      // live activeConversation so a future missed-unsubscribe (or a
      // late event arriving after a switch) can't leak into the wrong
      // chat. The subscribed-arn is captured in closure.
      const arn = newConversation.conversationArn;
      subscribe(arn, {
        onMessageCreate: (msg) => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMessageCreate(msg);
        },
        onMessageUpdate: (msg) => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMessageUpdate(msg);
        },
        onMessageDelete: (id) => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMessageDelete(id);
        },
        onMembershipChange: () => {
          if (activeConversationRef.current?.conversationArn !== arn) return;
          handleMembershipChange();
        },
        onChannelUpdate: (name) => {
          handleChannelUpdate(arn, name);
        },
      });

      // Greeting is rendered client-side as an empty-state — see
      // utils/greeting.ts and the empty branch in ConversationInterface.
      const conversationMessages = await chimeService.listMessages(newConversation.conversationArn);
      setMessages(conversationMessages);
      trackEvent('conversation_created', { modelId, modelName, modelTier });
    } catch (error) {
      console.error('Failed to create conversation:', error);
      throw error;
    } finally {
      // Drop the loading mask once the fresh (usually empty) message list has
      // been applied, so the client-side greeting empty-state renders.
      setIsLoadingMessages(false);
    }
  }, [user, subscribe, unsubscribe, handleMessageCreate, handleMessageUpdate, handleMessageDelete, handleMembershipChange]);

  const sendMessage = useCallback(async (
    content: string,
    attachment?: Attachment,
    options?: { targetArn?: string; mentionBotArn?: string },
  ): Promise<void> => {
    if (!activeConversationRef.current || !user) return;

    try {
      setIsSending(true);
      setSendError(null);

      const metadata = attachment ? { attachment } : undefined;
      const userMessage = await chimeService.sendMessage(
        activeConversationRef.current.conversationArn,
        content,
        metadata,
        options,
      );

      if (attachment) {
        userMessage.attachment = attachment;
      }

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
    } catch (error) {
      console.error('Failed to send message:', error);
      setSendError(error instanceof Error ? error.message : 'Failed to send message');
      throw error;
    } finally {
      setIsSending(false);
    }
  }, [user]);

  const deleteConversation = useCallback((conversationId: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));

    if (activeConversationRef.current?.id === conversationId) {
      if (activeConversationRef.current) {
        unsubscribe(activeConversationRef.current.conversationArn);
      }
      setActiveConversation(null);
      reflectConversationInUrl(null); // the open conversation was deleted — drop it from the URL
      setMessages([]);
    }
  }, [unsubscribe]);

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

  // Derived: bots currently waiting on the user. A bot's battlewaiting
  // marker lives on its placeholder until 2B-x-e reuses that message for
  // the resumed answer (UPDATE replace clears battleWaiting), so a
  // message still carrying it ⇒ that bot is genuinely waiting. Keyed by
  // botArn (one waiting placeholder per bot); Map insertion = message
  // order, so the last value is the most-recent waiter.
  const battleWaitingBots = useMemo(() => {
    const byBot = new Map<string, { botArn: string; battleId: string }>();
    for (const m of messages) {
      if (m.battleWaiting) byBot.set(m.battleWaiting.botArn, m.battleWaiting);
    }
    return Array.from(byBot.values());
  }, [messages]);

  // Deselect the active conversation (return to the list) without removing it —
  // the mobile Back affordance. Unlike deleteConversation it deletes nothing; it
  // just unsubscribes the live view and clears the detail pane, matching the
  // deselect half of the delete/select flows. Re-selecting re-subscribes.
  const clearActiveConversation = useCallback(() => {
    const current = activeConversationRef.current;
    if (current) unsubscribe(current.conversationArn);
    setActiveConversation(null);
    reflectConversationInUrl(null); // back to the list — clear the conversation from the URL
    setMessages([]);
  }, [unsubscribe]);

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
  }), [
    conversations, activeConversation, messages, isLoadingMessages,
    isInitializing, isSending, isBotTyping, sendError, channelMembers,
    isConversationUnread,
    createConversation, selectConversation, clearActiveConversation, sendMessage, shareConversation,
    deleteConversation, archiveConversation, leaveConversation, renameConversation, clearSendError,
    stickyTarget,
    battleWaitingBots,
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
