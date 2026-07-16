import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';
import TaskStatusIndicator from './TaskStatusIndicator';
import AttachmentDisplay from './AttachmentDisplay';
import ShareConversationModal from './ShareConversationModal';
import ArchiveConversationModal from './ArchiveConversationModal';
import ChannelMembersPanel from './ChannelMembersPanel';
import { useAwsClient } from '../providers/AwsClientProvider';
import { chimeService } from '../services/chimeService';
import { CollapsibleText } from './CollapsibleText';
import BattleScorecard, { type ScorecardVariant } from './BattleScorecard';
import BattleTallyBar from './BattleTallyBar';
import { computeBattleTally, type BattleRoundInput, type BattleWinner } from '../utils/battleTally';
import { submitMessageFeedback } from '../services/feedbackService';
import { shortenModelId } from '../utils/modelLabel';
import { getModelGreeting } from '../utils/greeting';
import type { Message } from '../types';
import './ConversationInterface.css';

/** Multi-day date divider: a divider
 *  separates messages when the calendar day changes vs the previous
 *  message. By design we NEVER render a divider before the very first
 *  message of the conversation — a single-day chat shows no markers; the
 *  marker only appears once a second day begins. Labels: "Today",
 *  "Yesterday", or "MMM DD, YYYY". */
function dayKey(d: Date): string {
  return d.toDateString();
}

function dayLabel(d: Date): string {
  const now = new Date();
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const k = dayKey(d);
  if (k === today) return 'Today';
  if (k === yesterday) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

/** Collapse very long BOT messages behind a Show more/less toggle so a
 *  multi-thousand-char wall doesn't dominate the chat. Bot-only (the
 *  user wrote their own messages and shouldn't see them truncated). With
 *  D, report deliverables come through as a short lede + attachment, so
 *  this is mainly a safety net for any other long bot reply. */

/** Map a round-1 battle reply to a scorecard variant. The label is the
 *  resolved variant displayName ("Atlas" / "Echo") carried on the
 *  battlestats marker; it falls back to the bot's Chime sender name only
 *  when the marker didn't carry one. Response time / est. cost ride the
 *  same compact per-message battle summary. */
function toScorecardVariant(m: Message): ScorecardVariant {
  return {
    // Header = the bot's Chime/AppInstanceUser name (stable identifier
    // of the assistant principal). Different intents may invoke different
    // models for the same assistant; the per-step expander shows what
    // actually ran, the config expander shows what the assistant is
    // CONFIGURED for. The variant displayName (admin-set persona) lives
    // as a subtitle, not as the primary identifier.
    label: m.sender?.name || 'Assistant',
    persona: m.battle?.label,
    intent: m.intent,
    modelId: m.modelId,
    responseMs: m.battle?.responseMs,
    estCostUsd: m.battle?.estCostUsd,
    steps: m.battle?.steps,
    tokensIn: m.battle?.tokensIn,
    tokensOut: m.battle?.tokensOut,
    imageCount: m.battle?.imageCount,
  };
}

const ConversationInterface: React.FC = () => {
  const { t } = useTranslation();
  const { activeConversation, messages, isLoadingMessages, isBotTyping, channelMembers, renameConversation, archiveConversation } = useConversations();
  const { userArn: currentUserArn } = useAwsClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Snapshot the Chime read-marker boundary once when a conversation is opened, BEFORE
  // it gets marked read, so the "new messages" divider marks where the user left off.
  // Re-runs only on conversation identity change, not on every object update.
  const [unreadBoundaryMs, setUnreadBoundaryMs] = useState(0);
  useEffect(() => {
    const lr = activeConversation?.lastReadAt;
    setUnreadBoundaryMs(lr ? lr.getTime() : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id]);
  const saveTitle = useCallback(async () => {
    if (!activeConversation) return;
    const name = titleDraft.trim();
    setIsEditingTitle(false);
    if (!name || name === activeConversation.title) return;
    try {
      await renameConversation(activeConversation.id, name);
    } catch (err) {
      console.error('Failed to rename conversation:', err);
    }
  }, [activeConversation, titleDraft, renameConversation]);
  const [isMembersPanelOpen, setIsMembersPanelOpen] = useState(false);
  // Moderator status for the active conversation — read from Chime's live
  // moderator list (source of truth), gating the header Archive action. Same
  // check the members panel uses (SPEC-CONVERSATION-ARCHIVE).
  const [isModerator, setIsModerator] = useState(false);
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
  useEffect(() => {
    const arn = activeConversation?.conversationArn;
    if (!arn || !currentUserArn) { setIsModerator(false); return; }
    let cancelled = false;
    void chimeService.listModerators(arn).then((mods) => {
      if (!cancelled) setIsModerator(mods.has(currentUserArn));
    }).catch(() => { if (!cancelled) setIsModerator(false); });
    return () => { cancelled = true; };
  }, [activeConversation?.conversationArn, currentUserArn]);

  // Archive runs from the in-app confirmation modal (ArchiveConversationModal),
  // which owns the busy/error UI; this just performs the persisting archive and
  // lets the modal surface any failure inline.
  const handleArchiveConfirm = useCallback(async () => {
    if (!activeConversation) return;
    await archiveConversation(activeConversation.id);
  }, [activeConversation, archiveConversation]);
  const [isMentionBannerDismissed, setIsMentionBannerDismissed] = useState(false);
  const [feedbackState, setFeedbackState] = useState<Record<string, 'up' | 'down' | 'pending'>>({});
  // Live /battle tally: each scorecard reports its pick up here so the bar above
  // the stream can aggregate wins/speed/cost across every round in real time
  // (SPEC-BATTLE Battle Objectives, objective 2).
  const [battleWinners, setBattleWinners] = useState<Record<string, BattleWinner | null>>({});

  const handleBattleOutcome = useCallback((battleId: string, winner: BattleWinner | null) => {
    setBattleWinners((prev) => (prev[battleId] === winner ? prev : { ...prev, [battleId]: winner }));
  }, []);

  // Round-1 pairs grouped by battleId — the input to the running tally. Built
  // once per message change (independent of pick state) so picks don't re-walk
  // the whole message list.
  const battleRounds = useMemo<BattleRoundInput[]>(() => {
    const byId = new Map<string, Message[]>();
    for (const m of messages) {
      if (m.battle?.round === 1 && m.battle.battleId) {
        const arr = byId.get(m.battle.battleId) || [];
        arr.push(m);
        byId.set(m.battle.battleId, arr);
      }
    }
    const rounds: BattleRoundInput[] = [];
    for (const [battleId, msgs] of byId) {
      if (msgs.length < 2) continue;
      const a = toScorecardVariant(msgs[0]);
      const b = toScorecardVariant(msgs[1]);
      rounds.push({
        battleId,
        sideA: { label: a.label, responseMs: a.responseMs, costUsd: a.estCostUsd },
        sideB: { label: b.label, responseMs: b.responseMs, costUsd: b.estCostUsd },
        winner: null, // overlaid from battleWinners below
      });
    }
    return rounds;
  }, [messages]);

  const battleTally = useMemo(
    () => computeBattleTally(battleRounds.map((r) => ({ ...r, winner: battleWinners[r.battleId] ?? null }))),
    [battleRounds, battleWinners],
  );

  const humanMemberCount = channelMembers.filter((m) => !m.isBot).length;
  const isMultiUser = humanMemberCount >= 2;
  const showMentionBanner = isMultiUser && !isMentionBannerDismissed;
  const userScrolledRef = useRef(false);

  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' });
    userScrolledRef.current = false;
    setShowScrollBtn(false);
  }, []);

  useEffect(() => {
    if (!userScrolledRef.current) {
      scrollToBottom();
    } else {
      setShowScrollBtn(true);
    }
  }, [messages, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 100) {
      userScrolledRef.current = true;
    } else {
      userScrolledRef.current = false;
      setShowScrollBtn(false);
    }
  }, []);

  const formatTimestamp = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const handleFeedback = useCallback(async (message: Message, clicked: 'up' | 'down') => {
    if (!activeConversation) return;

    // Read the prior vote + set pending via a functional update (avoids stale
    // closure — feedbackState isn't a dep). Clicking the currently-active vote
    // CLEARS it (toggle off); a different vote CHANGES it. One rating per message.
    let wasPending = false;
    let prior: 'up' | 'down' | 'pending' | undefined;
    setFeedbackState((prev) => {
      if (prev[message.id] === 'pending') {
        wasPending = true;
        return prev;
      }
      prior = prev[message.id];
      return { ...prev, [message.id]: 'pending' };
    });
    if (wasPending) return;

    const isClear = prior === clicked;
    // Every vote — change or clear — is recorded server-side (audit trail of
    // indecision); only the LATEST per message is counted.
    const toSend: 'up' | 'down' | 'clear' = isClear ? 'clear' : clicked;

    try {
      await submitMessageFeedback({
        messageId: message.id,
        channelArn: activeConversation.conversationArn,
        modelId: message.modelId,
        intent: message.intent,
        feedback: toSend,
        // Experiment feedback join: attribute
        // the thumbs to the variant that served this message, when it carries one.
        experimentId: message.experimentId,
        variantId: message.variantId,
        assignmentMode: message.assignmentMode,
      });
      setFeedbackState((prev) => {
        const next = { ...prev };
        if (isClear) delete next[message.id];
        else next[message.id] = clicked;
        return next;
      });
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      setFeedbackState((prev) => {
        const next = { ...prev };
        // Restore the prior vote on failure (don't silently drop it).
        if (prior && prior !== 'pending') next[message.id] = prior;
        else delete next[message.id];
        return next;
      });
    }
  }, [activeConversation]);

  if (!activeConversation) {
    return (
      <div className="conversation-interface">
        <div className="no-conversation-selected">
          <div className="welcome-message">
            <div className="welcome-mark" aria-hidden="true">
              <span className="welcome-mark-glyph">⟁</span>
              <span className="welcome-mark-version">AgentEchelon · v0.2</span>
            </div>
            <h1 className="welcome-title">{t('app.welcomeTitle')}</h1>
            <p className="welcome-sub">{t('app.welcomeBody')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`conversation-interface${isMembersPanelOpen ? ' with-members-panel' : ''}`}>
      <div className="conversation-interface-main">
        <header className="conversation-header" role="banner">
          <div className="conversation-header-content">
            <div className="conversation-header-title-group">
              {isEditingTitle ? (
                <input
                  className="conversation-header-title-input"
                  value={titleDraft}
                  autoFocus
                  maxLength={80}
                  aria-label={t('conversation.renameTitle')}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void saveTitle(); }
                    else if (e.key === 'Escape') setIsEditingTitle(false);
                  }}
                  onBlur={() => void saveTitle()}
                />
              ) : (
                <>
                  <h2 className="conversation-header-title" title={activeConversation.title}>
                    {activeConversation.title}
                  </h2>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon conversation-header-btn conversation-header-rename-btn"
                    onClick={() => { setTitleDraft(activeConversation.title); setIsEditingTitle(true); }}
                    title={t('conversation.renameTitle')}
                    aria-label={t('conversation.renameTitle')}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                      <path d="M2.695 14.762l-1.262 3.155a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.501a2.121 2.121 0 00-3-3L3.58 13.419a4 4 0 00-.885 1.343z" />
                    </svg>
                  </button>
                </>
              )}
              <span
                className={`conversation-header-tier conversation-header-tier--${activeConversation.modelTier}`}
                title={activeConversation.modelName}
              >
                <span className="conversation-header-tier-dot" aria-hidden="true" />
                {t(`tier.${activeConversation.modelTier}`)}
              </span>
              {isMultiUser && (
                <span className="conversation-header-members-chip" aria-label={t('membersPanel.memberCount', { count: humanMemberCount })}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="12" height="12" aria-hidden="true">
                    <path d="M10 9a3 3 0 100-6 3 3 0 000 6zM6 8a2 2 0 11-4 0 2 2 0 014 0zM1.49 15.326a.78.78 0 01-.358-.442 3 3 0 014.308-3.516 6.484 6.484 0 00-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 01-2.07-.655zM16.44 15.98a4.97 4.97 0 002.07-.654.78.78 0 00.357-.442 3 3 0 00-4.308-3.517 6.484 6.484 0 011.907 3.96 2.32 2.32 0 01-.026.654zM18 8a2 2 0 11-4 0 2 2 0 014 0zM5.304 16.19a.844.844 0 01-.277-.71 5 5 0 019.947 0 .843.843 0 01-.277.71A6.975 6.975 0 0110 18a6.974 6.974 0 01-4.696-1.81z" />
                  </svg>
                  {humanMemberCount}
                </span>
              )}
            </div>
            <div className="conversation-header-actions">
              <button
                type="button"
                className="btn btn-ghost btn-icon conversation-header-btn"
                onClick={() => setIsShareModalOpen(true)}
                title={t('conversation.shareTitle')}
                aria-label={t('conversation.shareTitle')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
                  <path d="M13 4.5a2.5 2.5 0 11.702 1.737L6.97 9.604a2.518 2.518 0 010 .792l6.733 3.367a2.5 2.5 0 11-.671 1.341l-6.733-3.367a2.5 2.5 0 110-3.474l6.733-3.367A2.52 2.52 0 0113 4.5z" />
                </svg>
              </button>
              <button
                type="button"
                className={`btn btn-ghost btn-icon conversation-header-btn${isMembersPanelOpen ? ' is-active' : ''}`}
                onClick={() => setIsMembersPanelOpen((v) => !v)}
                title={isMembersPanelOpen ? t('membersPanel.toggleClose') : t('membersPanel.toggleOpen')}
                aria-pressed={isMembersPanelOpen}
                aria-label={isMembersPanelOpen ? t('membersPanel.toggleClose') : t('membersPanel.toggleOpen')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
                  <path d="M10 9a3 3 0 100-6 3 3 0 000 6zM6 8a2 2 0 11-4 0 2 2 0 014 0zM1.49 15.326a.78.78 0 01-.358-.442 3 3 0 014.308-3.516 6.484 6.484 0 00-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 01-2.07-.655zM16.44 15.98a4.97 4.97 0 002.07-.654.78.78 0 00.357-.442 3 3 0 00-4.308-3.517 6.484 6.484 0 011.907 3.96 2.32 2.32 0 01-.026.654zM18 8a2 2 0 11-4 0 2 2 0 014 0zM5.304 16.19a.844.844 0 01-.277-.71 5 5 0 019.947 0 .843.843 0 01-.277.71A6.975 6.975 0 0110 18a6.974 6.974 0 01-4.696-1.81z" />
                </svg>
              </button>
              {isModerator && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon conversation-header-btn"
                  onClick={() => setIsArchiveModalOpen(true)}
                  title={t('conversation.archiveTitle')}
                  aria-label={t('conversation.archiveTitle')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
                    <path d="M2 4a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
                    <path fillRule="evenodd" d="M3 8h14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm5 2a1 1 0 000 2h4a1 1 0 100-2H8z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {showMentionBanner && (
            <div className="mention-banner" role="status">
              <div className="mention-banner-icon" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.93-12.588a.75.75 0 10-1.49-.154l-.5 4.775a.75.75 0 001.49.154l.5-4.775zM10 15a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="mention-banner-body">
                {/* <Trans> (rather than dangerouslySetInnerHTML) keeps the
                    variable parts of the i18n string as auto-escaped text
                    nodes. The <strong> tags are rendered by React, not
                    parsed out of a string. */}
                <Trans
                  i18nKey="mentionBanner.body"
                  components={[<strong key="assistant" />, <strong key="all" />]}
                />
              </div>
              <button
                type="button"
                className="mention-banner-dismiss"
                onClick={() => setIsMentionBannerDismissed(true)}
                aria-label={t('mentionBanner.dismiss')}
                title={t('mentionBanner.dismiss')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          )}
        </header>
      <div className="messages-container" ref={containerRef} onScroll={handleScroll}>
        {battleRounds.length > 0 && <BattleTallyBar tally={battleTally} />}
        {isLoadingMessages ? (
          <div className="messages-loading">
            <div className="message-skeleton">
              <div className="skeleton-header"><div className="skeleton-line skeleton-short" /></div>
              <div className="skeleton-line skeleton-long" />
              <div className="skeleton-line skeleton-medium" />
            </div>
            <div className="message-skeleton">
              <div className="skeleton-header"><div className="skeleton-line skeleton-short" /></div>
              <div className="skeleton-line skeleton-long" />
            </div>
          </div>
        ) : messages.length === 0 ? (
          // Empty-state greeting: rendered client-side as an assistant-
          // styled intro (NOT a real Chime message), so the bot doesn't
          // try to "respond" to its own welcome, and the copy disappears
          // the moment the user (or bot) sends a real message. Falls
          // back to a generic empty string only if we somehow
          // don't have a tier yet.
          <div className="conversation-empty-state">
            {activeConversation?.modelTier ? (
              <div className="conversation-empty-greeting">
                {getModelGreeting(activeConversation.modelTier)
                  .split('\n')
                  .map((line, i) => (
                    <p key={i} className={line.startsWith('•') ? 'greeting-bullet' : ''}>
                      {line || ' '}
                    </p>
                  ))}
              </div>
            ) : (
              <p>{t('conversation.emptyMessages')}</p>
            )}
          </div>
        ) : (
          messages.map((message: Message, index: number) => {
            // Hide header on continuation messages (multi-part responses)
            const isContinuation = message.continuation === true;
            // Also hide header when consecutive bot messages share the same responseGroup
            const prevMessage = index > 0 ? messages[index - 1] : null;
            const isGroupedWithPrev = !isContinuation && message.isBot && prevMessage?.isBot &&
              message.responseGroup && message.responseGroup === prevMessage.responseGroup;
            const showHeader = !isContinuation && !isGroupedWithPrev;
            // Only show feedback on the last message of a response group (or standalone messages)
            const nextMessage = index < messages.length - 1 ? messages[index + 1] : null;
            const isLastInGroup = !nextMessage || !nextMessage.isBot ||
              !message.responseGroup || nextMessage.responseGroup !== message.responseGroup;
            const showFeedback = message.isBot && isLastInGroup && !isContinuation;

            // "New messages" divider: the first message past the read-marker
            // boundary captured when the conversation was opened. Only rendered at a
            // clear read → unread transition mid-list (there is a prior, read message),
            // so a brand-new or fully-unread conversation shows no divider.
            const showUnreadDivider =
              unreadBoundaryMs > 0 &&
              !!prevMessage &&
              message.timestamp.getTime() > unreadBoundaryMs &&
              prevMessage.timestamp.getTime() <= unreadBoundaryMs;

            // /battle: render a "Round 2: rebuttals" divider when consecutive
            // messages from the same battleId transition round 1 → round 2.
            const showRound2Divider =
              message.battle?.round === 2
              && prevMessage?.battle?.battleId === message.battle.battleId
              && prevMessage.battle.round === 1;

            // /battle: variant chip on bot messages. Prefer the resolved
            // variant displayName from the battlestats marker
            // (message.battle.label, e.g. "Atlas"/"Echo"); fall back to
            // the bot's Chime sender name only when the marker didn't
            // carry one (e.g. a placeholder before the answer lands).
            const battleVariantLabel =
              message.battle && message.isBot
                ? message.battle.label || message.sender.name
                : null;

            // H: scorecard anchors to the END of the battle (after all
            // rounds), not mid-conversation. The trigger is the LAST
            // message of the battleId in render order — same battleId on
            // current, different (or no) battleId on next. The data
            // shown is still the round-1 pair (the primary comparison);
            // we just delay where it renders so a multi-turn battle
            // doesn't show the scorecard wedged between rounds.
            const isLastOfBattle =
              !!message.battle &&
              (!nextMessage?.battle ||
                nextMessage.battle.battleId !== message.battle.battleId);
            const battleRound1Msgs =
              isLastOfBattle && message.battle
                ? messages.filter(
                    (m) =>
                      m.battle?.battleId === message.battle!.battleId &&
                      m.battle?.round === 1,
                  )
                : [];
            const scorecard =
              battleRound1Msgs.length >= 2
                ? {
                    battleId: message.battle!.battleId,
                    variantA: toScorecardVariant(battleRound1Msgs[0]),
                    variantB: toScorecardVariant(battleRound1Msgs[1]),
                  }
                : null;

            return (
            <React.Fragment key={message.id}>
            {prevMessage && dayKey(message.timestamp) !== dayKey(prevMessage.timestamp) && (
              <div className="message-day-divider" role="separator" aria-label={`Messages on ${dayLabel(message.timestamp)}`}>
                <span className="message-day-divider-line" />
                <span className="message-day-divider-label">{dayLabel(message.timestamp)}</span>
                <span className="message-day-divider-line" />
              </div>
            )}
            {showUnreadDivider && (
              <div className="message-unread-divider" role="separator" aria-label={t('conversation.newMessages')}>
                <span className="message-unread-divider-line" />
                <span className="message-unread-divider-label">{t('conversation.newMessages')}</span>
                <span className="message-unread-divider-line" />
              </div>
            )}
            {showRound2Divider && (
              <div className="battle-round-divider" role="separator" aria-label="Round 2 rebuttals">
                <span className="battle-round-divider-line" />
                <span className="battle-round-divider-label">Round 2 — rebuttals</span>
                <span className="battle-round-divider-line" />
              </div>
            )}
            <div
              className={`message ${message.isBot ? 'assistant-message' : 'user-message'}${isContinuation || isGroupedWithPrev ? ' continuation' : ''}${message.battle ? ' battle-message' : ''}`}
            >
              <div className="message-content">
                {showHeader && (
                <div className="message-header">
                  <span className="message-role">
                    {/* In a battle, name the specific variant (Atlas/Echo) so the two
                        assistants are distinguishable, instead of a generic "assistant"
                        for every bot. Falls back to the tier label off the battle path. */}
                    {message.isBot ? (battleVariantLabel || t('tier.assistant')) : 'You'}
                  </span>
                  <span className="message-timestamp">
                    {formatTimestamp(message.timestamp)}
                  </span>
                  {message.isBot && shortenModelId(message.modelId) && (
                    <span
                      className="message-model-badge"
                      title={message.modelId}
                    >
                      {shortenModelId(message.modelId)}
                    </span>
                  )}
                  {battleVariantLabel && message.battle?.round && (
                    <span
                      className={`battle-variant-chip battle-variant-chip--round-${message.battle?.round}`}
                      title={`Battle round ${message.battle.round} — ${battleVariantLabel}`}
                    >
                      {`Round ${message.battle.round}`}
                    </span>
                  )}
                </div>
                )}
                {(() => {
                  // A: a battle placeholder (battle marker present, no
                  // battlestats summary yet, no attachment/image) renders
                  // as a live working-state ("Atlas is drafting...") rather
                  // than the static fan-out text. Once the answer lands the
                  // UPDATE merges battlestats (responseMs) in and this
                  // condition flips false, falling through to the answer.
                  const isBattlePlaceholder =
                    message.isBot
                    && !!message.battle
                    && message.battle.responseMs === undefined
                    && !message.battleImage
                    && !message.attachment;
                  if (isBattlePlaceholder) {
                    const name = message.battle?.label || message.sender?.name || 'Assistant';
                    return (
                      <div className="message-text battle-placeholder" role="status" aria-live="polite">
                        <span className="battle-placeholder-name">{name}</span>
                        <span className="battle-placeholder-state"> is drafting</span>
                        <span className="battle-placeholder-dots" aria-hidden="true">…</span>
                      </div>
                    );
                  }
                  return <CollapsibleText content={message.content} isBot={message.isBot} />;
                })()}
                {message.isBot && message.battleImage && (
                  <div className="battle-generated-images">
                    {message.battleImage.urls.map((url, i) => (
                      <img
                        key={i}
                        src={url}
                        className="battle-generated-image"
                        loading="lazy"
                        alt={t('battle.generatedImageAlt', {
                          defaultValue: `Generated image ${i + 1} of ${message.battleImage!.count} (${message.battleImage!.modelId})`,
                        })}
                      />
                    ))}
                  </div>
                )}
                {message.attachment && (
                  <AttachmentDisplay attachment={message.attachment} />
                )}
                {message.isBot && message.activeTask && (
                  <TaskStatusIndicator task={message.activeTask} />
                )}
                {message.isBot && message.navigateChannel && (
                  <div className="message-redirect-banner" role="status">
                    <span className="message-redirect-icon" aria-hidden="true">↪</span>
                    <span className="message-redirect-text">
                      {t('conversation.driftSuggestion', { defaultValue: 'Suggested redirect' })}
                    </span>
                    <span className="message-redirect-target">
                      {message.navigateChannel.channelName} →
                    </span>
                  </div>
                )}
                {showFeedback && (
                  <div className="message-feedback-row">
                    <button
                      className={`message-feedback-btn ${feedbackState[message.id] === 'up' ? 'active' : ''}`}
                      onClick={() => handleFeedback(message, 'up')}
                      disabled={feedbackState[message.id] === 'pending'}
                      title="Helpful response"
                      aria-label={feedbackState[message.id] === 'pending' ? 'Submitting feedback' : 'Mark as helpful'}
                    >
                      Helpful
                    </button>
                    <button
                      className={`message-feedback-btn ${feedbackState[message.id] === 'down' ? 'active' : ''}`}
                      onClick={() => handleFeedback(message, 'down')}
                      disabled={feedbackState[message.id] === 'pending'}
                      title="Unhelpful response"
                      aria-label={feedbackState[message.id] === 'pending' ? 'Submitting feedback' : 'Mark as needs work'}
                    >
                      Needs work
                    </button>
                  </div>
                )}
              </div>
            </div>
            {scorecard && (
              <BattleScorecard
                battleId={scorecard.battleId}
                channelArn={activeConversation.conversationArn}
                variantA={scorecard.variantA}
                variantB={scorecard.variantB}
                onOutcomeChange={handleBattleOutcome}
              />
            )}
            </React.Fragment>
            );
          })
        )}
        {isBotTyping && (
          <div
            className="message assistant-message thinking-indicator"
            role="status"
            aria-live="polite"
            aria-label={`${t('tier.assistant')} is typing`}
          >
            <div className="message-content">
              <div className="message-header">
                <span className="message-role">{t('tier.assistant')}</span>
              </div>
              <div className="thinking-dots">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      {showScrollBtn && (
        <button
          className="scroll-to-bottom-btn"
          onClick={() => scrollToBottom()}
          title={t('conversation.scrollToBottom')}
          aria-label={t('conversation.scrollToBottom')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
            <path fillRule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clipRule="evenodd" />
          </svg>
        </button>
      )}
      <ShareConversationModal
        isOpen={isShareModalOpen}
        onClose={() => setIsShareModalOpen(false)}
      />
      <ArchiveConversationModal
        isOpen={isArchiveModalOpen}
        onClose={() => setIsArchiveModalOpen(false)}
        onConfirm={handleArchiveConfirm}
      />
      </div>
      <ChannelMembersPanel
        isOpen={isMembersPanelOpen}
        onClose={() => setIsMembersPanelOpen(false)}
      />
    </div>
  );
};

export default ConversationInterface;
