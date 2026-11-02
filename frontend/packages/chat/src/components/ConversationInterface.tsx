import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTurnState } from '../hooks/useTurnState';
import { useTranslation, Trans } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';
import { withPrivateAddressDisplayed, withMentionNamesDisplayed } from '../utils/mentionParser';
import TaskStatusIndicator from './TaskStatusIndicator';
import QueueStatusIndicator from './QueueStatusIndicator';
import AttachmentDisplay from './AttachmentDisplay';
import { ProposalCard } from './ProposalCard';
import { TaskCard } from './TaskCard';
import ShareConversationModal from './ShareConversationModal';
import { shareDisabledReason } from './shareAvailability';
import ArchiveConversationModal from './ArchiveConversationModal';
import ChannelMembersPanel from './ChannelMembersPanel';
import { useAwsClient } from '../providers/AwsClientProvider';
import { chimeService } from '../services/chimeService';
import { getBattleConfig, type ChannelBattleConfig } from '../services/channelBattleService';
import { CollapsibleText } from './CollapsibleText';
import BattleScorecard, { type ScorecardVariant } from './BattleScorecard';
import { battleOf, lastMessageIndexByBattleId, messagesById, opensRound2 } from './battleScorecardAnchor';
import BattleTallyBar from './BattleTallyBar';
import { computeBattleTally, type BattleRoundInput, type BattleWinner, type BattleTally } from '../utils/battleTally';
import { submitMessageFeedback } from '@ae/shared';
import { personApiServes } from '@ae/shared';
import type { FeedbackReason } from '@ae/shared';
import { shortenModelId } from '../utils/modelLabel';
import { getModelGreeting } from '../utils/greeting';
import type { Message } from '@ae/shared';
import { orderContinuations } from '../utils/continuationOrder';
import { taskReferenceOf } from '../utils/taskReference';
import { botMessageLabel } from '../utils/senderLabel';
import { duelSidesInOrder } from './duelSideOrder';
import { useFollowBottom } from '@ae/shared/hooks/useFollowBottom.ts';
import { BattleSideReply } from './BattleSideReply';
import { mayAnswerSide, personIdOfArn, waitingSides } from '../utils/battleSideReply';
import { AudienceLabel, ClassificationBadge, headerAudienceClass } from './ConversationClassification';
import './ConversationInterface.css';
import { clearMessageFocus, hasPendingMessageFocus, noteMessageFocusMiss, peekMessageFocus, scrollToMessage } from '../utils/focusMessage';
import { conversationTitleFor, isUnnamedConversation } from '../utils/conversationTitle';

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
 *  side's name from its profile (the challenger's marked when the two match) carried on the
 *  battlestats marker; it falls back to the bot's Chime sender name only
 *  when the marker didn't carry one. Response time / est. cost ride the
 *  same compact per-message battle summary. */
export function toScorecardVariant(m: Message, fallbackLabel: string): ScorecardVariant {
  return {
    // Header = the VARIANT, then the bot's own name. The two sides of a duel must be tellable
    // apart from each other, which is a stronger requirement than naming the principal - and this
    // is the one view whose entire job is the comparison.
    //
    // IT USED TO BE THE OTHER WAY AROUND, against this function's own description above. Building
    // the label from `sender.name` alone made the columns read "Advisor" against "Alt-premium" -
    // the live assistant's name against the alt's - while the bubbles directly above them read the
    // two variant names. The alt's identity cannot be renamed toward the variant either: the
    // rename applier is scoped to a single ARN (`RenameOwnIdentityOnly`) and the alt is not it. So
    // the scorecard takes the battle label the bubbles already use, via the same resolver.
    //
    // The principal is not lost, it moves to the subtitle: different intents may invoke different
    // models for the same assistant, and the per-step expander shows what actually ran while the
    // config expander shows what it is CONFIGURED for - both of which are about the principal.
    //
    // The fallback is PASSED IN rather than written here: this is module scope, so it has no
    // translator, and an English literal would be the one piece of this header nobody could localize.
    label: botMessageLabel({
      battleVariantLabel: m.battle?.label,
      senderName: m.sender?.name,
      fallback: fallbackLabel,
    }),
    // ONLY WHEN IT SAYS SOMETHING THE HEADER DOES NOT. With no battle label the header already IS
    // the sender name, and filling the subtitle with it too renders the same string stacked twice.
    persona: m.battle?.label ? m.sender?.name : undefined,
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

/** Battle prompt-steering table (DESIGN-EXPERIMENTS-BATTLE §2.2). Keyed by the
 *  experiment's target intent (the shipped intents), each row is a coaching
 *  line plus 2-3 concrete starter chips the user can click to prefill the
 *  composer with `/battle <chip>` — so the battle exercises what the experiment
 *  measures instead of leaving users to guess. Deployment-overridable example
 *  copy, shipped as defaults. Aliases stay opaque: the briefing names the
 *  DECISION, never the models (INV-4, semi-blind eval). */
interface BattleSteering {
  coaching: string;
  chips: string[];
}

const BATTLE_STEERING: Record<string, BattleSteering> = {
  general: {
    coaching: 'Ask real questions your users ask.',
    chips: ['Explain X to a new hire', "What's the difference between A and B?"],
  },
  code_generation: {
    coaching: "Ask a real coding task you'd actually ship.",
    chips: ['Write a function that …', 'Add retry/timeout to this call'],
  },
  code_review: {
    coaching: 'Paste real code and ask for a review.',
    chips: ['Review this for bugs', 'Is this concurrency-safe?'],
  },
  data_extraction: {
    coaching: 'Give a document and ask for specific fields.',
    chips: ['Extract the totals as a table', 'Pull every date + owner'],
  },
  report_generation: {
    coaching: "Ask for a report you'd actually send.",
    chips: ['Draft a one-page status report on …', 'Summarize this for execs'],
  },
  image_generation: {
    coaching: 'Describe an image you actually need.',
    chips: ['A hero image for …', 'An icon set for …'],
  },
  strategic_analysis: {
    coaching: 'Pose a real judgment call.',
    chips: ['Pros/cons of migrating to …', 'What are the risks of …?'],
  },
  guided_troubleshooting: {
    coaching: 'Ask it to drive a multi-step task.',
    chips: ['Plan and track the steps to …', 'Walk me through …'],
  },
};

/** Fallback for base/classification/profile experiments — they span intents, so
 *  there is no single intent row (§2.2): a generic coaching line + broadly useful
 *  chips seeded from the most common intents. */
const BATTLE_STEERING_GENERIC: BattleSteering = {
  coaching: "We're comparing overall quality — ask the kinds of questions your users actually ask.",
  chips: ['Explain X to a new hire', 'Write a function that …', 'Draft a one-page status report on …'],
};

/** Inline styles (this component owns no CSS file for the briefing) built from
 *  the app's design tokens so the banner stays theme-aware and consistent with
 *  the existing mention-banner. */
const battleBriefingStyles: Record<string, React.CSSProperties> = {
  banner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-3)',
    margin: 'var(--space-4) 0 var(--space-2)',
    padding: 'var(--space-3) var(--space-4)',
    background: 'var(--accent-50)',
    border: '1px solid var(--accent-200)',
    borderLeft: '3px solid var(--accent-500)',
    borderRadius: 'var(--radius-md)',
  },
  body: { flex: 1, minWidth: 0 },
  eyebrow: {
    display: 'inline-block',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    textTransform: 'uppercase',
    letterSpacing: 'var(--tracking-wider)',
    color: 'var(--accent-700)',
    marginBottom: 'var(--space-1)',
  },
  decision: {
    margin: '0 0 var(--space-2)',
    fontSize: 'var(--text-md)',
    color: 'var(--text-primary)',
    lineHeight: 'var(--leading-relaxed)',
  },
  decisionLabel: { fontWeight: 600 },
  coaching: {
    margin: '0 0 var(--space-2)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-secondary)',
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' },
  chip: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    color: 'var(--accent-700)',
    background: 'var(--surface-0)',
    border: '1px solid var(--accent-300)',
    borderRadius: 'var(--radius-sm)',
    padding: '4px var(--space-3)',
    cursor: 'pointer',
  },
  dismiss: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    padding: 0,
    color: 'var(--text-tertiary)',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-full)',
    cursor: 'pointer',
  },
};

/** When this person's newest message has had no assistant message after it: its time, else undefined. */
function awaitingReplySinceOf(messages: readonly Message[], currentUserArn: string | null | undefined): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.isBot) return undefined;
    if (currentUserArn && m.sender?.arn === currentUserArn) return new Date(m.timestamp).getTime();
  }
  return undefined;
}

const ConversationInterface: React.FC = () => {
  const { t } = useTranslation();
  const { activeConversation, messages: loadedMessages, isLoadingMessages, isBotTyping, channelMembers, renameConversation, archiveConversation, selectConversation, battleWaitingBots = [], replyingToSides = [], replyToSides } = useConversations();
  // A continuation part is shown with the message it continues, not wherever its creation time put it:
  // a queue notice posted while the answer was generating otherwise lands between the two halves.
  // Ordered once here so every index-based read below sees the same order.
  const messages = useMemo(() => orderContinuations(loadedMessages), [loadedMessages]);
  const { userArn: currentUserArn } = useAwsClient();
  // The message each waiting duel side waits on, so its answer control is drawn there and nowhere else.
  const liveWaitingMessageIds = useMemo(
    () => new Set(waitingSides(loadedMessages).map((side) => side.messageId)),
    [loadedMessages],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  /** The list's content, whose height the follow-the-bottom rule observes. */
  const contentRef = useRef<HTMLDivElement>(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  // Sharing exists only where the person API serves it (`VITE_PERSON_API_CAPABILITIES` names `notifications`).
  const shareServed = personApiServes('notifications');
  // Share shows disabled, with the reason, where membership comes from a group or list (see shareAvailability).
  const shareDisabledReasonText = shareDisabledReason(activeConversation?.membershipSource, t);
  // A hover tooltip reaches neither a touch nor a keyboard user, so the reason is also shown on tap and focus.
  const [showShareReason, setShowShareReason] = useState(false);
  useEffect(() => { setShowShareReason(false); }, [activeConversation?.id]);
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
  /**
   * A REFUSED RENAME HAS TO REACH THE PERSON WHO TRIED IT.
   *
   * The pencil is offered to every member, and Chime authorizes `UpdateChannel` only for a channel
   * moderator - so a non-moderator is denied server-side, by design. This used to close the editor,
   * swallow the error into `console.error`, and let the title snap back to its old value: the person saw
   * their edit silently undone with no reason given, which reads as the product being broken rather than
   * as a permission they do not have.
   *
   * The editor now stays OPEN on failure with the draft intact, so the text is not lost and the message
   * sits beside the input that produced it. The server's own message is preferred when there is one,
   * because "you are not a moderator of this conversation" is more use than any generic line this
   * component could invent.
   */
  const [renameError, setRenameError] = useState<string | null>(null);
  const saveTitle = useCallback(async () => {
    if (!activeConversation) return;
    const name = titleDraft.trim();
    if (!name || name === activeConversation.title) { setIsEditingTitle(false); setRenameError(null); return; }
    try {
      await renameConversation(activeConversation.id, name);
      setIsEditingTitle(false);
      setRenameError(null);
    } catch (err) {
      console.error('Failed to rename conversation:', err);
      setRenameError(err instanceof Error && err.message ? err.message : t('conversation.renameFailed'));
    }
  }, [activeConversation, titleDraft, renameConversation, t]);
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
  // The message whose "what went wrong" picker is open, and the one showing the acknowledgement
  // after a reason was given. Both are single-valued: only the most recent down vote is being asked
  // about, so opening one picker closes any other.
  const [reasonPromptFor, setReasonPromptFor] = useState<string | null>(null);
  const [reasonThanksFor, setReasonThanksFor] = useState<string | null>(null);
  // Live /battle tally: each scorecard reports its pick up here so the bar above
  // the stream can aggregate wins/speed/cost across every round in real time
  // (SPEC-BATTLE Battle Objectives, objective 2).
  const [battleWinners, setBattleWinners] = useState<Record<string, BattleWinner | null>>({});

  const handleBattleOutcome = useCallback((battleId: string, winner: BattleWinner | null) => {
    setBattleWinners((prev) => (prev[battleId] === winner ? prev : { ...prev, [battleId]: winner }));
  }, []);

  // Battle briefing (DESIGN-EXPERIMENTS-BATTLE §2.2/§2.3): read the channel's
  // battle config so a dismissible intro banner can be shown to EVERY battling
  // member — non-moderators included, read-only — carrying the decision line
  // (objective statement) and intent-keyed prompt chips. Only premium channels
  // can have battle (INV-5), so we skip the fetch elsewhere; errors are
  // swallowed (a member without config access just sees no banner).
  const [battleConfig, setBattleConfig] = useState<ChannelBattleConfig | null>(null);
  const [isBattleBriefingDismissed, setIsBattleBriefingDismissed] = useState(false);
  useEffect(() => {
    setIsBattleBriefingDismissed(false);
    const arn = activeConversation?.conversationArn;
    // Eligibility comes from the config response (the profile's `battleEligible`), so the request is
    // no longer pre-gated on a hardcoded premium check against mutable metadata. A non-eligible
    // conversation simply gets `battleEligible: false` back and renders nothing.
    // Battle exists only where the person API serves it (`VITE_PERSON_API_CAPABILITIES` names `battle`).
    if (!arn || !personApiServes('battle')) { setBattleConfig(null); return; }
    let cancelled = false;
    void getBattleConfig(arn)
      .then((cfg) => { if (!cancelled) setBattleConfig(cfg); })
      .catch(() => { if (!cancelled) setBattleConfig(null); });
    return () => { cancelled = true; };
  }, [activeConversation?.conversationArn]);

  // Clicking a starter chip prefills the composer with `/battle <chip>`. The
  // composer (MessageInput) is a sibling component with no shared draft state,
  // so we load its controlled <textarea> the React-safe way: call the native
  // value setter, then dispatch a bubbling 'input' event so React's onChange
  // fires and the composer re-renders with the prefilled text (no coupling,
  // no edit to MessageInput).
  const handleBattleChip = useCallback((chip: string) => {
    const text = `/battle ${chip}`;
    const textarea = document.querySelector<HTMLTextAreaElement>('.message-textarea');
    if (!textarea) return;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setValue?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
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
      // A is the control and B the treatment, which is how the server credits a pick (`duelSideOrder.ts`).
      const [first, second] = duelSidesInOrder(msgs);
      const a = toScorecardVariant(first, t('tier.assistant'));
      const b = toScorecardVariant(second, t('tier.assistant'));
      rounds.push({
        battleId,
        sideA: { label: a.label, responseMs: a.responseMs, costUsd: a.estCostUsd },
        sideB: { label: b.label, responseMs: b.responseMs, costUsd: b.estCostUsd },
        winner: null, // overlaid from battleWinners below
      });
    }
    return rounds;
  // `t` is a dependency because the fallback label is now translated: without it a language
  // change would leave the previous language's label on any side whose sender name was absent.
  }, [messages, t]);

  // One STANDALONE tally per battle: each /battle prompt is scored on its own (A vs B
  // for THAT prompt, both rounds including the rebuttal), and the next prompt starts a
  // fresh tally - no running total is carried across battles. Rendered inline at the end
  // of each battle, so the stream reads as a sequence of independent battle results.
  // Replaces the old single sticky bar that floated over the whole view and aggregated
  // every battle into one ambiguous running count.
  const battleTallyByBattleId = useMemo(() => {
    const map = new Map<string, BattleTally>();
    for (const r of battleRounds) {
      map.set(r.battleId, computeBattleTally([{ ...r, winner: battleWinners[r.battleId] ?? null }]));
    }
    return map;
  }, [battleRounds, battleWinners]);

  /**
   * The LAST message of each battle, by index, so its scorecard renders exactly once.
   *
   * THE BUG THIS REPLACES. The anchor was "the next message has a different battleId", which is the
   * last message of a CONTIGUOUS RUN rather than of the battle. A duel's messages are only contiguous
   * when nothing interleaves, and plenty does: the person can speak mid-duel, a second `/battle` is
   * refused with an explained no-op, and round 2 arrives after all of it. Every interleaving splits
   * one duel into two blocks, and because the scorecard's data is filtered from ALL messages by
   * battleId rather than from the block, each block rendered the SAME scorecard again.
   *
   * Measured live: three scorecards for one duel in the single-active-battle e2e - the one test that
   * deliberately interleaves a refusal into a running duel, which is why it is the one that caught
   * this. It had failed once before without being root-caused, and was recorded as
   * "do not file this as flaky" for exactly this reason.
   *
   * A MAP OF LAST INDEX, not a scan per message: the render loop is per message, so asking "is there
   * a later message with this battleId" inline would be quadratic on a long conversation.
   */
  const messageById = useMemo(() => messagesById(messages), [messages]);
  const lastIndexByBattleId = useMemo(() => lastMessageIndexByBattleId(messages, messageById), [messages, messageById]);

  const humanMemberCount = channelMembers.filter((m) => !m.isBot).length;

  // WHAT IS WAITING HERE (ADR-033), read from the conversation's record rather than derived from
  // the transcript: ordering is not a reliable encoding of set membership, and a client that
  // reloaded with partial history or joined late would style the wrong messages.
  //
  // The FIRST bot member is the responder, because busy is a property of a responder and this is the
  // one the composer addresses by default. A room with several assistants reports on that one; the
  // alternative is a request per bot on every poll to answer a question nobody asked.
  // EVERY assistant, not the first. Busy is a property of a responder, so a room with several has
  // several queues - reading one of them styles a message queued behind any other as not waiting.
  /**
   * EVERY assistant that could be holding a turn here, from BOTH things that know.
   *
   * The roster is the obvious source and it is not sufficient on its own. It is fetched when the
   * conversation is opened and refreshed on a membership event, and an assistant added around the
   * moment the conversation is created can land in the gap between those two: the fetch ran before
   * it joined, and no membership event for it followed. Measured against the deployment, that is not
   * theoretical - the record held a waiting message, the endpoint returned it correctly, and the app
   * asked ZERO times for the whole conversation, because this list was empty and the read returns
   * before its request when there is nobody to ask about.
   *
   * The TRANSCRIPT is the other thing that knows, and it cannot miss: an assistant that is answering
   * has, by definition, already posted into this conversation - the greeting, the placeholder, or
   * the deferral notice itself. Taking the union means a roster that is late, incomplete, or never
   * refreshed cannot silence the queue state, and neither can a transcript that starts mid-history.
   */
  const responderIds = useMemo(
    () => {
      const fromRoster = channelMembers
        .filter((m) => m.isBot)
        .map((m) => m.userArn.split('/').pop() || '');
      const fromTranscript = messages
        .filter((m) => m.sender?.arn?.includes('/bot/'))
        .map((m) => m.sender.arn.split('/').pop() || '');
      return Array.from(new Set([...fromRoster, ...fromTranscript])).filter(Boolean);
    },
    [channelMembers, messages],
  );
  // THE EVENT, from the messages this component already has. The deferral notice is an ordinary
  // message: posted when the queue starts, updated as more arrive, updated again when the drain
  // empties it. Its id and content together change exactly when the queue does, so watching them is
  // subscribing to the state change rather than polling for it.
  const noticeSignal = useMemo(
    () => {
      // THE NOTICE, when it can be recognized. The depth, not the text: a count is the state token
      // the notification is supposed to carry, and content length was a proxy that would miss a
      // change of the same size.
      const notices = messages
        .filter((m) => m.responsePhase === 'notice')
        .map((m) => `${m.id}:${m.queueDepth ?? '?'}`)
        .join('|');
      // AND THE TRANSCRIPT ITSELF, because recognizing the notice depends on a single metadata field
      // surviving the whole way from the sender to this component. Measured against the deployment:
      // the record held a waiting message, the endpoint returned it correctly to this page, and the
      // app read the endpoint exactly ONCE - at mount, before anything was queued - and never again,
      // because this signal never changed. The person was never shown their message waiting.
      //
      // The transcript changing is a strict superset of the notice arriving, and it is still an
      // EVENT rather than a timer: it is the same message subscription this component already has.
      // A re-read costs one small request per assistant and only happens when something was said.
      // AND AN UPDATE, NOT ONLY A NEW MESSAGE. A drain that clears the queue and then
      // UPDATES its proposal in place changes no id and no count, so the last read stood from before
      // the clear and two messages kept their "waiting" badge for good. The newest few messages'
      // phase and length move when one of them is rewritten.
      const recentUpdates = messages
        .slice(-3)
        .map((m) => `${m.id}:${m.responsePhase ?? ''}:${m.content?.length ?? 0}`)
        .join(',');
      return `${notices}#${messages.length}:${recentUpdates}`;
    },
    [messages],
  );
  // WHEN THIS PERSON IS STILL WAITING FOR AN ANSWER: their newest message, with no assistant message after
  // it. The turn-state hook reads once more at two deadlines after it, so a turn that never started, or an
  // answer that could not be delivered, is shown without a reload. Any assistant message after it clears this.
  const awaitingReplySince = awaitingReplySinceOf(messages, currentUserArn);
  const { queuedIds, dispatchFailed } = useTurnState({
    // THE ARN, not the id. `Conversation.id` is the channel's short id - the ARN's last segment -
    // and this endpoint checks that what it is given belongs to this deployment, so a short id is
    // rejected with 400. Every call the app made was refused that way, and it went unnoticed because
    // the hook had nothing to ask about and so made no calls at all until the responders were fixed.
    channelArn: activeConversation?.conversationArn ?? null,
    responderIds,
    changeSignal: noticeSignal,
    awaitingReplySince,
  });
  const isMultiUser = humanMemberCount >= 2;
  // Shown only where an assistant is present to answer; a room of people alone has nobody to mention.
  const showMentionBanner = isMultiUser && channelMembers.some((m) => m.isBot) && !isMentionBannerDismissed;

  // Briefing fields ride on the battle config (DESIGN-EXPERIMENTS-BATTLE A.5),
  // snapshotted at enable time. Read them via a local augmentation so this stays
  // type-safe whether or not ChannelBattleConfig has grown the optional fields
  // yet (same pattern as the Experiment battleEnabled read).
  const briefing = battleConfig as
    | (ChannelBattleConfig & { briefingStatement?: string; briefingIntent?: string })
    | null;
  const briefingStatement = briefing?.briefingStatement?.trim() || '';
  const briefingSteering =
    (briefing?.briefingIntent && BATTLE_STEERING[briefing.briefingIntent]) || BATTLE_STEERING_GENERIC;
  // Absent statement ⇒ no banner (additive: absent ⇒ today's behavior). Eligibility is checked as well
  // as `enabled`: a profile can have `battleEligible` revoked after a moderator turned Battle Mode on,
  // and the stored config would still say enabled.
  const showBattleBriefing =
    !!battleConfig?.enabled && battleConfig.battleEligible !== false
    && !!briefingStatement && !isBattleBriefingDismissed;
  const activeConversationId = activeConversation?.id;

  // THE LIST FOLLOWS ITS NEWEST CONTENT WHILE THE VIEWER IS AT THE BOTTOM (`useFollowBottom`): a new
  // message, an UPDATE that grows one (a placeholder replaced by its answer, a duel side's reply) and an
  // image that loads all keep the newest content in view, and a viewer who scrolled up to read history
  // is left there and offered the jump instead. Suspended while a deep link is still waiting to land, so
  // it never scrolls away from the message the reader followed a link to reach.
  const {
    showJump: showScrollBtn,
    jumpToBottom,
    onScroll: handleScroll,
    release: releaseFollow,
  } = useFollowBottom({
    containerRef,
    contentRef,
    changeKey: messages,
    resetKey: activeConversationId,
    isSuspended: () => hasPendingMessageFocus(activeConversationId),
  });

  // A `#message=<id>` deep link (a drift conversation's link back to the message that caused it) records its
  // target before the conversation's history exists. This runs on every `messages` change, so it fires
  // exactly when the target renders - no polling. The request is scoped to the conversation the link named
  // and carries a bounded budget, so a target that never renders stops being waited on (see focusMessage).
  //
  // Running FIRST is not what makes the deep link win - it is what made it LOSE. Effects run in
  // declaration order within a commit, so on the render where the target finally mounts this one
  // consumed the pending request and scrolled to the message, and then the auto-scroll effect below
  // saw no pending focus, found the list still following on a freshly loaded conversation, and
  // scrolled to the bottom - the last scroll applied, and the one that wins. Following a drift link
  // landed the reader at the newest message with a highlight they never saw.
  //
  // Marking the position as user-owned is what settles it: the viewport is now where the reader asked
  // to be, so the auto-scroll effect takes its "offer the jump-to-newest button" branch instead of
  // yanking them away - on this render and on later ones, which is also the right behavior while
  // someone is reading history.
  useEffect(() => {
    const id = peekMessageFocus(activeConversationId);
    if (!id) return;
    if (!scrollToMessage(id)) {
      // NOT WHILE THE LIST IS STILL LOADING. A miss is meant to mean "the history rendered and the
      // target was not in it", which is what the attempt budget exists to bound. While
      // `isLoadingMessages` is true the list is a skeleton, so the target cannot be there and a miss
      // says nothing - counting those spends the whole budget on the renders BEFORE the messages
      // arrive, and the request is then gone by the time the target appears.
      //
      // That was latent until the drift back-link started navigating in place: the link used to open
      // a new tab, so this path never ran for it. Measured live - the originating message rendered and
      // never took the highlight.
      if (!isLoadingMessages) noteMessageFocusMiss();
      return;
    }
    clearMessageFocus();
    releaseFollow();
    // `isLoadingMessages` is a dependency because the list is replaced by a skeleton while it is true: a
    // commit that swaps the skeleton back for the messages is a render where the target can appear, even
    // when the `messages` reference did not change again.
  }, [messages, activeConversationId, isLoadingMessages, releaseFollow]);

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
      // A vote that says a response was bad says nothing about WHAT was bad, and the three things a
      // person is signalling - wrong assistant, bad answer, had to ask again - are three different
      // problems with three different owners. So ask, but only AFTER the vote is already recorded:
      // the picker refines a vote that has counted since the moment it was clicked, and ignoring it
      // costs the person nothing and loses nothing that was captured before.
      setReasonPromptFor(!isClear && clicked === 'down' ? message.id : null);
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

  /**
   * Refine a `down` that is already recorded with the axis it indicts.
   *
   * Posted as a SECOND vote rather than an update: the feedback store appends every revision and
   * counts only the latest per (voter, message), so this supersedes the bare vote without changing
   * the sentiment it recorded and without erasing the fact that the person voted before they said
   * why. Failure is silent by design - the vote is already safe, and an error toast here would
   * punish somebody for volunteering more than they had to.
   */
  const handleFeedbackReason = useCallback(async (message: Message, reason: FeedbackReason) => {
    if (!activeConversation) return;
    setReasonPromptFor(null);
    setReasonThanksFor(message.id);
    try {
      await submitMessageFeedback({
        messageId: message.id,
        channelArn: activeConversation.conversationArn,
        modelId: message.modelId,
        intent: message.intent,
        feedback: 'down',
        reason,
        experimentId: message.experimentId,
        variantId: message.variantId,
        assignmentMode: message.assignmentMode,
      });
    } catch (error) {
      console.error('Failed to submit feedback reason:', error);
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
        <header className={`conversation-header${headerAudienceClass(activeConversation.modelTier)}`} role="banner">
          <div className="conversation-header-content">
            <div className="conversation-header-title-group">
              {isEditingTitle ? (
                <>
                  <input
                    className="conversation-header-title-input"
                    value={titleDraft}
                    autoFocus
                    maxLength={80}
                    aria-label={t('conversation.renameTitle')}
                    aria-invalid={renameError ? true : undefined}
                    onChange={(e) => { setTitleDraft(e.target.value); setRenameError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void saveTitle(); }
                      else if (e.key === 'Escape') { setIsEditingTitle(false); setRenameError(null); }
                    }}
                    /* No save on blur while a refusal is showing: blurring to read the message would
                       retry the same denied call and close the editor, losing the draft and the reason. */
                    onBlur={() => { if (!renameError) void saveTitle(); }}
                  />
                  {renameError && (
                    <div className="alert alert-error conversation-header-rename-error" role="alert">
                      {renameError}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h2 className="conversation-header-title" title={conversationTitleFor(activeConversation.title, t('conversation.newConversation'))}>
                    {conversationTitleFor(activeConversation.title, t('conversation.newConversation'))}
                  </h2>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon conversation-header-btn conversation-header-rename-btn"
                    onClick={() => { setTitleDraft(isUnnamedConversation(activeConversation.title) ? '' : activeConversation.title); setIsEditingTitle(true); }}
                    title={t('conversation.renameTitle')}
                    aria-label={t('conversation.renameTitle')}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                      <path d="M2.695 14.762l-1.262 3.155a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.501a2.121 2.121 0 00-3-3L3.58 13.419a4 4 0 00-.885 1.343z" />
                    </svg>
                  </button>
                </>
              )}
              {activeConversation.modelTier && (
                <>
                  <ClassificationBadge value={activeConversation.modelTier} title={activeConversation.modelName} />
                  <AudienceLabel value={activeConversation.modelTier} />
                </>
              )}
            </div>
            <div className="conversation-header-actions">
              {shareServed && (<>
              <button
                type="button"
                className={`btn btn-ghost btn-icon conversation-header-btn${shareDisabledReasonText ? ' is-disabled' : ''}`}
                // aria-disabled rather than disabled: a disabled button receives no hover, so its tooltip -
                // the reason Share is unavailable - would never show.
                onClick={() => {
                  // Show, never toggle: a tap focuses the button first, so a toggle here would hide what focus just showed.
                  if (shareDisabledReasonText) setShowShareReason(true);
                  else setIsShareModalOpen(true);
                }}
                onFocus={() => { if (shareDisabledReasonText) setShowShareReason(true); }}
                onBlur={() => setShowShareReason(false)}
                aria-disabled={shareDisabledReasonText ? true : undefined}
                aria-describedby={shareDisabledReasonText ? 'share-disabled-reason' : undefined}
                title={shareDisabledReasonText || t('conversation.shareTitle')}
                aria-label={t('conversation.shareTitle')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
                  <path d="M13 4.5a2.5 2.5 0 11.702 1.737L6.97 9.604a2.518 2.518 0 010 .792l6.733 3.367a2.5 2.5 0 11-.671 1.341l-6.733-3.367a2.5 2.5 0 110-3.474l6.733-3.367A2.52 2.52 0 0113 4.5z" />
                </svg>
              </button>
              {shareDisabledReasonText && (
                <span
                  id="share-disabled-reason"
                  role="status"
                  className={`share-disabled-reason${showShareReason ? ' is-visible' : ''}`}
                >
                  {shareDisabledReasonText}
                </span>
              )}
              </>)}
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
                {/* The count rides ON the toggle. It used to be a separate `members-chip` next to it,
                    which rendered the SAME people icon a second time - two identical glyphs in the
                    header, one of them not clickable. One control, one icon, one meaning. */}
                {isMultiUser && (
                  <span className="conversation-header-btn-count">{humanMemberCount}</span>
                )}
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
          {/* ── A TURN THAT NEVER RAN, SAID BY THE APP RATHER THAN BY THE ASSISTANT ───────────────
              The channel flow used to post this as the assistant. That put an infrastructure failure
              in the transcript under the assistant's name and showed it to the whole room; this is
              the person's own client telling them their message was delivered and nothing is coming.
              `role="alert"` rather than `status`: they are waiting for a reply that will never
              arrive, so it is worth interrupting for. The copy comes from i18n, keyed by the reason
              code, with a generic line for a code this build does not recognise - a newer server must
              degrade to an honest sentence rather than to silence. */}
          {dispatchFailed && (
            <div className="mention-banner" role="alert">
              <div className="mention-banner-icon" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.93-12.588a.75.75 0 10-1.49-.154l-.5 4.775a.75.75 0 001.49.154l.5-4.775zM10 15a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="mention-banner-body">
                {t([`conversation.turnFailed.${dispatchFailed}`, 'conversation.turnFailed.generic'])}
              </div>
            </div>
          )}
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
                  components={[<strong key="all" />]}
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
        <div className="messages-content" ref={contentRef}>
        {/* Battle briefing (DESIGN-EXPERIMENTS-BATTLE §2.2): a compact,
            dismissible intro rendered above the first battle turn. It names the
            DECISION (objective statement) — never the models, keeping aliases
            opaque (INV-4) — and offers intent-keyed starter chips that prefill
            the composer with `/battle …`. Shown to every battling member,
            non-moderators included, read-only. */}
        {showBattleBriefing && (
          <div className="battle-briefing" role="region" aria-label="Battle briefing" style={battleBriefingStyles.banner}>
            <div className="battle-briefing-body" style={battleBriefingStyles.body}>
              <span className="battle-briefing-eyebrow" style={battleBriefingStyles.eyebrow}>Battle Mode</span>
              <p className="battle-briefing-decision" style={battleBriefingStyles.decision}>
                <span style={battleBriefingStyles.decisionLabel}>We&rsquo;re deciding: </span>
                {briefingStatement}
              </p>
              {briefingSteering.coaching && (
                <p className="battle-briefing-coaching" style={battleBriefingStyles.coaching}>
                  {briefingSteering.coaching}
                </p>
              )}
              {briefingSteering.chips.length > 0 && (
                <div className="battle-briefing-chips" role="group" aria-label="Suggested battle prompts" style={battleBriefingStyles.chips}>
                  {briefingSteering.chips.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="battle-briefing-chip"
                      style={battleBriefingStyles.chip}
                      onClick={() => handleBattleChip(chip)}
                      title={`Prefill: /battle ${chip}`}
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="battle-briefing-dismiss"
              style={battleBriefingStyles.dismiss}
              onClick={() => setIsBattleBriefingDismissed(true)}
              aria-label="Dismiss battle briefing"
              title="Dismiss"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        )}
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
            {activeConversation?.modelTier && getModelGreeting(activeConversation.modelTier, t) ? (
              <div className="conversation-empty-greeting">
                {(getModelGreeting(activeConversation.modelTier, t) ?? '')
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
            // A long round-1 answer ends in continuation parts, which belong to it (`battleOf`).
            const showRound2Divider = opensRound2(message, prevMessage, messageById);

            // /battle: variant chip on bot messages. Prefer the side's
            // profile name from the battlestats marker
            // (message.battle.label); fall back to
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
            // THE LAST MESSAGE OF THE BATTLE, not of a contiguous run of it. Comparing against the
            // NEXT message alone made every interleaved message - the person speaking mid-duel, a
            // refused second `/battle`, anything arriving between rounds - start a new "block", and
            // each block rendered its own copy of the same scorecard.
            // A continuation part of the duel's last answer is the duel's last message (`battleOf`).
            const ownBattle = battleOf(message, messageById);
            const isLastOfBattle =
              !!ownBattle && lastIndexByBattleId.get(ownBattle.battleId) === index;
            const battleRound1Msgs =
              isLastOfBattle && ownBattle
                ? duelSidesInOrder(messages.filter(
                    (m) =>
                      m.battle?.battleId === ownBattle.battleId &&
                      m.battle?.round === 1,
                  ))
                : [];
            const scorecard =
              battleRound1Msgs.length >= 2 && ownBattle
                ? {
                    battleId: ownBattle.battleId,
                    variantA: toScorecardVariant(battleRound1Msgs[0], t('tier.assistant')),
                    variantB: toScorecardVariant(battleRound1Msgs[1], t('tier.assistant')),
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
              // Addressable so a `#message=<id>` deep link can scroll to and highlight this exact message
              // (see utils/focusMessage). A drift-created conversation links back to the message that
              // caused it, which is useless if it only lands the reader in the right thread.
              data-message-id={message.id}
              // WHICH STEP OF THE ANSWER THIS IS, as the backend declared it. Rendered as an attribute
              // rather than kept in state alone because it is the only structural way to tell a
              // settled reply from work in progress by looking at the page: a delivering turn updates
              // its message mid-flight ("Trimming the report to 1-2 pages..."), which is indistinguishable
              // from a short final answer by text. An e2e reading the DOM mistook one for the answer
              // and sent its next message into a turn that was still generating, producing the report
              // twice. Absent when the writer stamped no phase.
              data-response-phase={message.responsePhase}
              // WAITING TO BE READ (ADR-033). From the conversation's RECORD, never derived from where
              // this message sits in the transcript: a client that reloaded with partial history or
              // joined late would get that wrong, and the styling would claim something false.
              //
              // It clears for the whole batch at once when triage runs, because that is when a message
              // stops waiting - there is no per-message signal to wait for, and inventing one would
              // mean claiming an attribution the platform cannot verify.
              data-queued={queuedIds.has(message.id) ? 'true' : undefined}
              className={`message ${message.isBot ? 'assistant-message' : 'user-message'}${isContinuation || isGroupedWithPrev ? ' continuation' : ''}${message.battle ? ' battle-message' : ''}${queuedIds.has(message.id) ? ' message-queued' : ''}`}
            >
              <div className="message-content">
                {queuedIds.has(message.id) && (
                  <span className="message-waiting-label">{t('conversation.messageWaiting')}</span>
                )}
                {!message.isBot && taskReferenceOf(message.content) !== null && (
                  <span
                    className="message-answering-label"
                    aria-label={t('conversation.answeringRefA11y', { ref: taskReferenceOf(message.content) })}
                  >
                    {t('conversation.answeringRef', { ref: taskReferenceOf(message.content) })}
                  </span>
                )}
                {showHeader && (
                <div className="message-header">
                  <span className="message-role">
                    {/* WHO SAID THIS, in the order of most specific to least.
                        1. In a battle, the side's profile name (the challenger's marked), so the two sides are distinguishable.
                        2. The ASSISTANT'S OWN NAME, carried on the message's Chime sender. This step
                           was missing: the header rendered the constant `tier.assistant` for every
                           bot off the battle path, so an assistant renamed through its profile still
                           read as "Assistant" - and two assistants in one room read as the SAME word,
                           which is a correctness problem the moment a classification holds more than
                           one (DESIGN-SEPARATE-ASSISTANTS 3.0).
                        3. The translated label, when the message carries no sender name. It stays a
                           t() key rather than an English literal: the fallback is copy, only the name
                           itself is data. */}
                    {message.isBot
                      ? botMessageLabel({ battleVariantLabel, senderName: message.sender?.name, fallback: t('tier.assistant') })
                      : 'You'}
                  </span>
                  <span className="message-timestamp">
                    {formatTimestamp(message.timestamp)}
                  </span>
                  {/*
                    * THE MODEL THE TURN WAS ROUTED TO, and it does not claim to be the author of every
                    * word.
                    *
                    * A bare "Opus" reads as "this reply is Opus". It is the turn's PRIMARY model: a
                    * turn can fall back to another model mid-flight, run sub-steps on a different one,
                    * or produce text the platform wrote rather than the model - and the badge said
                    * "Opus" for all of them. The client cannot tell the difference either, because the
                    * per-step models go out of band to analytics and only `bedrockModel` reaches here.
                    *
                    * So the chip is labeled as routing rather than authorship, and says so on hover.
                    * Narrowing the claim is the honest fix available at this seam; showing which
                    * models a turn ACTUALLY used needs the per-step list to reach the client, and that
                    * is a metadata decision against the 4KB message budget rather than a copy change.
                    */}
                  {message.isBot && shortenModelId(message.modelId) && (
                    <span
                      className="message-model-badge"
                      title={t('message.routedToModel', { model: shortenModelId(message.modelId), id: message.modelId })}
                    >
                      {t('message.viaModel', { model: shortenModelId(message.modelId) })}
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
                    // An image reply is the other way a battle turn finishes: it lands as an
                    // attachment, so `attachment` alone covers what battleImage used to.
                    && !message.attachment;
                  if (isBattlePlaceholder) {
                    const name = botMessageLabel({ battleVariantLabel: message.battle?.label, senderName: message.sender?.name, fallback: t('tier.assistant') });
                    return (
                      <div className="message-text battle-placeholder" role="status" aria-live="polite">
                        <span className="battle-placeholder-name">{name}</span>
                        <span className="battle-placeholder-state"> is drafting</span>
                        <span className="battle-placeholder-dots" aria-hidden="true">…</span>
                      </div>
                    );
                  }
                  // THE ADDRESS IS SHOWN BY NAME, WITH THE ID TAKEN BACK OUT. The composer writes
                  // `.<Name|id>` so the backend resolves the addressee by id rather than by matching a
                  // display name; the id is for the server and not for the reader, and until this ran
                  // a recipient read the literal token, pipe and brackets included.
                  return (
                    <CollapsibleText
                      content={withMentionNamesDisplayed(withPrivateAddressDisplayed(message.content))}
                      isBot={message.isBot}
                    />
                  );
                })()}
                {/* A DUEL SIDE WAITING ON THE PERSON (DESIGN-BATTLE, "A side parked on the person"): its
                    answer control, on the step or question it parked on. Drawn from the message's own
                    `<!--battlewaiting-->` marker, which comes down when the side is answered or the duel
                    ends, so the control lives exactly as long as the wait. */}
                {message.isBot && message.battleWaiting && liveWaitingMessageIds.has(message.id) && (() => {
                  const waiting = message.battleWaiting;
                  const sideName = botMessageLabel({ battleVariantLabel, senderName: message.sender?.name, fallback: t('tier.assistant') });
                  const ownerName = waiting.ownerId
                    ? channelMembers.find((m) => !m.isBot && personIdOfArn(m.userArn) === waiting.ownerId)?.name
                    : undefined;
                  const duelSidesWaitingOnMe = battleWaitingBots
                    .filter((side) => side.battleId === waiting.battleId)
                    .map((side) => side.botArn);
                  return (
                    <BattleSideReply
                      sideArn={waiting.botArn}
                      sideName={sideName}
                      canAnswer={mayAnswerSide(waiting, currentUserArn)}
                      {...(ownerName ? { ownerName } : {})}
                      replying={replyingToSides.some((side) => side.botArn === waiting.botArn)}
                      offerBoth={duelSidesWaitingOnMe.length > 1 && duelSidesWaitingOnMe.includes(waiting.botArn)}
                      onReply={() => replyToSides?.([waiting.botArn])}
                      onReplyBoth={() => replyToSides?.(duelSidesWaitingOnMe)}
                    />
                  );
                })()}
                {/*
                  A durable way into the conversation this one continued into. The `NAVIGATE_CHANNEL:` marker
                  that switches conversations on arrival is stripped before display, so without this the
                  parent keeps the announcement and loses the link. Rendered from message METADATA, which
                  survives that stripping, so it still works on a re-read days later.
                */}
                {message.isBot && message.driftRedirect && (
                  <button
                    type="button"
                    className="drift-redirect-link"
                    onClick={() => {
                      const id = message.driftRedirect!.childChannelArn.split('/').pop();
                      if (id) void selectConversation(id);
                    }}
                  >
                    {t('drift.openConversation', {
                      label: message.driftRedirect.label,
                      defaultValue: 'Open {{label}}',
                    })}
                  </button>
                )}
                {/* A PROPOSAL ADDRESSED TO THIS PERSON (ADR-061 decision 8): its confirmation card, drawn from the targeted
                    message's Metadata, which only they receive. Nothing happens until they answer it. */}
                {message.isBot && message.proposal && (
                  <ProposalCard proposal={message.proposal} onOpenConversation={(id) => void selectConversation(id)} />
                )}
                {/* A TASK A WORKFLOW ASSIGNED THIS PERSON (ADR-063 decision 2): its card, drawn from the targeted message's
                    Metadata, which only they receive. They may answer on it or by writing here. */}
                {message.isBot && message.taskCard && activeConversation?.conversationArn && (
                  <TaskCard card={message.taskCard} channelArn={activeConversation.conversationArn} />
                )}
                {/* A generated image (battle generation-out, or any image_generation turn) arrives as
                    an ATTACHMENT and renders below, same as an uploaded one. */}
                {message.attachment && (
                  <AttachmentDisplay attachment={message.attachment} />
                )}
                {message.isBot && message.activeTask && (
                  <TaskStatusIndicator task={message.activeTask} />
                )}
                {/* The queue's stage, shown the same way and in the same place as a task's: to the
                    person watching, a queue being worked and a task being worked are the same thing. */}
                {message.isBot && message.queueStatus && (
                  <QueueStatusIndicator
                    status={message.queueStatus}
                    {...(message.queueStatusLabel ? { label: message.queueStatusLabel } : {})}
                  />
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
                      title={t('feedback.helpfulTitle')}
                      aria-label={feedbackState[message.id] === 'pending' ? t('feedback.submitting') : t('feedback.helpfulAria')}
                    >
                      {t('feedback.helpful')}
                    </button>
                    <button
                      className={`message-feedback-btn ${feedbackState[message.id] === 'down' ? 'active' : ''}`}
                      onClick={() => handleFeedback(message, 'down')}
                      disabled={feedbackState[message.id] === 'pending'}
                      title={t('feedback.needsWorkTitle')}
                      aria-label={feedbackState[message.id] === 'pending' ? t('feedback.submitting') : t('feedback.needsWorkAria')}
                    >
                      {t('feedback.needsWork')}
                    </button>
                  </div>
                )}
                {/* ── WHAT WENT WRONG, ASKED AFTER THE VOTE IS ALREADY IN ──────────────────────────
                    Optional by construction: the down vote counted when it was clicked, so every
                    exit from here (picking a reason, skipping, or ignoring it entirely) leaves a
                    recorded vote behind. It is not a form and it does not block the conversation. */}
                {showFeedback && reasonPromptFor === message.id && (
                  <div className="message-feedback-reason" role="group" aria-label={t('feedback.reasonPrompt')}>
                    <span className="message-feedback-reason-prompt">{t('feedback.reasonPrompt')}</span>
                    <button className="message-feedback-reason-btn" onClick={() => handleFeedbackReason(message, 'wrong_assistant')}>
                      {t('feedback.reasonWrongAssistant')}
                    </button>
                    <button className="message-feedback-reason-btn" onClick={() => handleFeedbackReason(message, 'poor_answer')}>
                      {t('feedback.reasonPoorAnswer')}
                    </button>
                    <button className="message-feedback-reason-btn" onClick={() => handleFeedbackReason(message, 'asked_again')}>
                      {t('feedback.reasonAskedAgain')}
                    </button>
                    <button
                      className="message-feedback-reason-skip"
                      onClick={() => setReasonPromptFor(null)}
                      aria-label={t('feedback.reasonDismissAria')}
                    >
                      {t('feedback.reasonDismiss')}
                    </button>
                  </div>
                )}
                {showFeedback && reasonThanksFor === message.id && reasonPromptFor !== message.id && (
                  <div className="message-feedback-reason-thanks">{t('feedback.reasonThanks')}</div>
                )}
              </div>
            </div>
            {scorecard && (
              <BattleScorecard
                battleId={scorecard.battleId}
                channelArn={activeConversation.conversationArn}
                variantA={scorecard.variantA}
                variantB={scorecard.variantB}
                // The pick this session already made, if any. The scorecard hangs off a specific
                // message, so an arriving round-2 reply can move it to a different one - React
                // unmounts and remounts it, and the child's own state goes with it. Its mount fetch
                // then races the pick POST and can resolve to "no pick", leaving a recorded pick
                // rendered as unpicked with no way back. This state outlives the remount.
                knownWinner={battleWinners[scorecard.battleId] ?? undefined}
                onOutcomeChange={handleBattleOutcome}
              />
            )}
            {/* One running-tally snapshot inline at the end of each battle (cumulative
                through this battle), so the record grows down the stream and the newest
                one marks the battle being scored now. */}
            {scorecard && battleTallyByBattleId.get(scorecard.battleId) && (
              <BattleTallyBar inline tally={battleTallyByBattleId.get(scorecard.battleId)!} />
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
        </div>
      </div>
      {showScrollBtn && (
        <button
          className="scroll-to-bottom-btn"
          onClick={jumpToBottom}
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
        // The panel owns the battle TOGGLE; this view owns the battle BRIEFING. Both read the same
        // server config, so the toggle has to publish its result here - otherwise this copy stays at
        // whatever it was when the conversation opened, and the briefing never appears for the person
        // who just enabled Battle Mode.
        onBattleConfigChange={setBattleConfig}
      />
    </div>
  );
};

export default ConversationInterface;
