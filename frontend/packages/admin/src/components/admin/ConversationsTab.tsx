import i18n from '@ae/shared/i18n';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InvitationsPanel } from './InvitationsPanel';
import UnsupportedAnalyticsBanner from './UnsupportedAnalyticsBanner';
import {
  addAdminToConversation,
  addAdminMember,
  removeAdminMember,
  getAdminMembershipHistory,
  getAdminConversationIdentities,
  deleteAdminConversationMessage,
  findAdminConversation,
  archiveAdminConversation,
  deleteAdminConversation,
  listAdminConversationMembers,
  listAdminConversationMessages,
  listAdminConversations,
  redactAdminConversationMessage,
} from '../../services/adminConversationService';
import MessageInspectDrawer from './MessageInspectDrawer';
import CleanConversationView from './CleanConversationView';
import { recordModeration, listChannelEvents, flagResponse, unflagResponse } from '../../services/analyticsService';
import { getAdminAttachmentDownloadUrl, isUserUploadedAttachment } from '../../services/adminAttachmentService';
import { driftHealthMetrics, parseDriftCounts, formatRate, type DriftRate } from './driftHealth';
import { InfoTooltip, GuideLinks, guide } from './AdminHelp';
import { useCan } from '../../capabilities';
import { teamAssistant } from '../../services/teamScope';
import { ReasonDeclinedError } from '../../services/adminReason';
import { nearestTo, type MessageLink } from './messageLink';
import type { AnalyticsResult } from '@ae/shared';
import { classificationBadgeStyle, classificationName } from '@ae/shared/config/classifications.ts';

/**
 * The principal an ARN names, for surfaces that must identify a person without their name.
 *
 * The name is a separate grant: the Chime identity carries the person's EMAIL as its `Name`,
 * so the server omits it unless the caller holds the identity capability. The ARN is always present,
 * and its last segment is the person's AppInstanceUser id - which is what `person_id` joins on in every analytics
 * table, so an operator reading an id here can follow it everywhere else.
 */
function principalOf(arn: string): string {
  const last = arn.split('/').pop() || arn;
  return last || arn;
}
import type {
  AdminConversationEvent,
  AdminConversationMember,
  AdminConversationMessage,
  AdminConversationSummary,
  AdminMembershipEvent,
} from '@ae/shared';

/**
 * The reasons a flag can carry, and how each reads to a moderator.
 *
 * Same closed set the chat client offers an end user (`FeedbackReason`) and the same values
 * `human_flag.reason` stores, so a flag raised here and a `Needs work` clicked in a conversation
 * are countable as the same thing. The wording differs because the audiences differ: a person is
 * told "the answer wasn't good", a moderator is told which axis they are indicting.
 */
type FlagReason = NonNullable<AdminConversationMessage['flagReason']>;

/**
 * The three reasons a flag can carry, in the order the picker offers them.
 *
 * Keys, not labels: this is module scope. The RECORD still drives the picker, so the set of reasons stays
 * one list rather than becoming a list here and a parallel set of keys in the locale file.
 */
const FLAG_REASON_KEYS: Record<FlagReason, string> = {
  wrong_assistant: 'admin.conversations.flagReason.wrongAssistant',
  poor_answer: 'admin.conversations.flagReason.poorAnswer',
  asked_again: 'admin.conversations.flagReason.askedAgain',
};

interface ConversationsTabProps {
  summaryData: AnalyticsResult | null;
  driftData: AnalyticsResult | null;
  isLoading: boolean;
  /** When set (from Flagged/Ground-Truth links), open this channel's detail page. */
  deepLinkChannelArn?: string | null;
  /**
   * With `deepLinkChannelArn`: the message inside it to open at (`&msg=`, `&at=`). The viewer brings that
   * message into view and highlights it; see `messageLink.ts`.
   */
  deepLinkMessage?: MessageLink | null;
  /** Called once the deep link has been opened, so the parent can clear it. */
  onDeepLinkConsumed?: () => void;
  /**
   * Register a "close the open conversation detail" handler with the parent, so the
   * console's global Back button returns to the LIST first (one level) instead of
   * walking the tab history past it. Called with the closer when a detail is open,
   * and null when back on the list.
   */
  registerBack?: (close: (() => void) | null) => void;
  /**
   * Where this conversation was opened from, when that was another tab. Back returns to the page the
   * person was on, so one who followed a turn into its conversation goes back to that turn.
   */
  returnTo?: { onReturn: () => void } | null;
  /**
   * Notify the parent when the open conversation detail changes (channelArn, or null
   * when back on the list), so it can reflect it in the URL for deep-linking.
   */
  onConversationChange?: (channelArn: string | null, message?: MessageLink | null) => void;
  /**
   * The assistant the list is narrowed to (the Performance filter set's `as`, set by an assistant page's Conversations
   * link): only conversations one of its identities was a member of. Null lists every conversation in scope.
   */
  assistantFilter?: string | null;
  onClearAssistantFilter?: () => void;
}

// Classification badge for the conversations list, from metadata.modelTier: the declared display name in
// the classification's declared badge color (`classificationBadgeStyle`), the neutral pair for a value this
// deployment does not declare. Blank when a legacy row carries none.
function tierBadge(tier: string): React.ReactNode {
  if (!tier) return <span style={{ opacity: 0.5 }}>—</span>;
  return (
    <span style={{ ...classificationBadgeStyle(tier), backgroundColor: 'var(--cls-bg)', color: 'var(--cls-fg)', padding: '2px 8px', borderRadius: '4px', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
      {classificationName(tier)}
    </span>
  );
}

function stateBadge(state?: 'live' | 'archived' | 'deleted'): React.ReactNode {
  const s = state || 'live';
  const color =
    s === 'deleted' ? 'var(--status-bad)' : s === 'archived' ? 'var(--status-warn)' : 'var(--status-good)';
  return (
    <span style={{ backgroundColor: `${color}20`, color, padding: '2px 8px', borderRadius: '4px', fontSize: 'var(--text-sm)', fontWeight: 600, textTransform: 'capitalize' }}>
      {s}
    </span>
  );
}

/**
 * Drift is a TOPIC-CHANGE signal, not a quality failure. A user moving to a new subject is normal
 * conversation, and the product's response is to OFFER a new conversation - a feature working, not an
 * error. So the scale is informational (how far the topic moved), never good-to-bad: coloring a
 * strong signal with `--status-bad` told operators to treat successful detection as a problem, and
 * made "no drift" look like the healthy state when it simply means nobody changed subject.
 */
function driftBadge(score: number): React.ReactNode {
  const color = score >= 0.7 ? 'var(--status-info)' : score >= 0.4 ? 'var(--status-info)' : 'var(--text-muted)';
  const label = score >= 0.7 ? i18n.t('admin.conversations.topicChanged') : score >= 0.4 ? i18n.t('admin.conversations.partialShift') : 'Same topic';
  return (
    <span style={{ backgroundColor: `${color}20`, color, padding: '2px 8px', borderRadius: '4px', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
      {label} ({(score * 100).toFixed(0)}%)
    </span>
  );
}

/**
 * The drift headline: two questions about an offer that was made.
 *
 *   1. Was it ACCURATE, judged after the fact by evaluation?
 *   2. Did the user ACCEPT it?
 *
 * Kept separate on purpose: a user can decline a correct call, or accept a bad one, so a single
 * blended number would hide which half is failing. Deliberately NOT drift volume, which measures
 * users rather than the feature.
 *
 * Two rules this enforces:
 *  - a rate with a zero denominator renders "No data", never a fabricated 0%;
 *  - a metric nothing instruments renders "Not measured", never a number.
 * No good/bad coloring: no target has been agreed for these rates, and coloring one would assert
 * a threshold the product has not set (the same mistake as coloring high drift volume as bad).
 */
const DriftHealthPanel: React.FC<{ stats?: Record<string, string | number | null> }> = ({ stats }) => {
  const m = driftHealthMetrics(parseDriftCounts(stats));

  const tiles: { label: string; rate: DriftRate; unavailable?: string; hint: string }[] = [
    {
      label: 'Accuracy',
      rate: m.accuracy,
      // Denominator is offers JUDGED. Nothing judged yet is "Not measured", never a score.
      unavailable: m.accuracy.denominator === 0 ? i18n.t('admin.conversations.notMeasured') : undefined,
      hint: i18n.t('admin.conversations.offersThePostHocJudge'),
    },
    { label: 'Acceptance', rate: m.acceptance, hint: i18n.t('admin.conversations.offersTheUserAccepted') },
  ];

  return (
    <>
      <div className="admin-metrics-row">
        {tiles.map((t) => {
          const pct = t.unavailable ? null : formatRate(t.rate);
          return (
            <div className="admin-metric-card" key={t.label}>
              <div
                className="admin-metric-value"
                style={pct === null ? { color: 'var(--text-muted)', fontSize: 'var(--text-md)' } : undefined}
              >
                {pct ?? t.unavailable ?? 'No data'}
              </div>
              <div className="admin-metric-label">{t.label}</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>
                {t.unavailable ? i18n.t('admin.conversations.noOffersJudgedYetIn') : `${t.hint} (${t.rate.numerator}/${t.rate.denominator})`}
              </div>
            </div>
          );
        })}
      </div>
      {(m.pending > 0 || m.awaitingEvaluation > 0) && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '4px 0 12px' }}>
          {m.pending > 0 && (
            <>
              {m.pending} offer{m.pending === 1 ? '' : 's'} not yet settled. Acceptance counts every
              offer made, so it is a floor that rises as these resolve.{' '}
            </>
          )}
          {m.awaitingEvaluation > 0 && (
            <>
              {m.awaitingEvaluation} awaiting evaluation, so accuracy is measured over the judged
              subset rather than every offer.
            </>
          )}
        </p>
      )}
    </>
  );
};

const ConversationsTab: React.FC<ConversationsTabProps> = ({ driftData, isLoading, deepLinkChannelArn, deepLinkMessage = null, onDeepLinkConsumed, registerBack, onConversationChange, returnTo, assistantFilter = null, onClearAssistantFilter }) => {
  const { t } = useTranslation();
  // Each control renders only for a role holding its capability (SPEC-ADMIN-CONSOLE FR0f, FR36); IAM
  // refuses the rest whatever renders.
  const can = useCan();
  const [view, setView] = useState<'browser' | 'drift'>('browser');
  // Which form of an open conversation is shown: the record, or its de-identified copy (FR54).
  const [detailForm, setDetailForm] = useState<'record' | 'deidentified'>('record');
  // The record by default; narrowed to what is there now on request (FR55).
  const [currentStateOnly, setCurrentStateOnly] = useState(false);
  const [conversations, setConversations] = useState<AdminConversationSummary[]>([]);
  // Server-side pagination for the conversation list (it can grow unbounded): fetch one page + the
  // total from the backend rather than a truncated window.
  const CONV_PAGE_SIZE = 25;
  const [convPage, setConvPage] = useState(0);
  const [convTotal, setConvTotal] = useState(0);
  const [selectedConversation, setSelectedConversation] = useState<AdminConversationSummary | null>(null);
  const [messages, setMessages] = useState<AdminConversationMessage[]>([]);
  // The conversation whose read last settled, so a message link resolves against that read and not a previous one.
  const [messagesFor, setMessagesFor] = useState<string | null>(null);
  // THE MESSAGE A LINK OPENED AT, held with its conversation: it applies while that conversation is open.
  const [messageLink, setMessageLink] = useState<(MessageLink & { channelArn: string }) | null>(null);
  // What the link resolved to: the row to bring into view, and whether the linked message itself was missing.
  const [linkFocus, setLinkFocus] = useState<{ key: string | null; missing: boolean } | null>(null);
  // The link whose conversation has been read a second time, so the second read happens once.
  const [rereadFor, setRereadFor] = useState<MessageLink | null>(null);
  const [members, setMembers] = useState<AdminConversationMember[]>([]);
  const [membershipHistory, setMembershipHistory] = useState<AdminMembershipEvent[]>([]);
  // ARN -> display name, EMPTY unless the operator holds `see-user-identity`. The conversation reads
  // return no name at all, so this is the only source of one and its absence is the normal case: every
  // person-bearing surface below renders the principal id and treats a name as an enrichment.
  const [identities, setIdentities] = useState<Record<string, string>>({});
  /** The name for an ARN when the grant allowed one, otherwise the Cognito sub. */
  const nameOrId = (arn?: string | null) => (arn ? identities[arn] || principalOf(arn) : '');
  const [inspectMessage, setInspectMessage] = useState<AdminConversationMessage | null>(null);
  // The message whose reason picker is open. Single-valued: flagging is one decision at a time, and
  // two open pickers would let a mis-click land on the wrong response.
  const [flagPickerFor, setFlagPickerFor] = useState<string | null>(null);
  // fileKey currently being vended/opened, so its button can show a pending state.
  const [openingAttachment, setOpeningAttachment] = useState<string | null>(null);
  const [newMemberArn, setNewMemberArn] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  // Lookup by the id a person gave the operator (FR52): reaches a conversation the paged list may not show.
  const [findId, setFindId] = useState('');
  const [finding, setFinding] = useState(false);
  const handleFind = async () => {
    if (!findId.trim()) return;
    setFinding(true);
    setActionError(null);
    try {
      const found = await findAdminConversation(findId);
      if (found) {
        setSelectedConversation(found);
        setFindId('');
      } else {
        setActionError(t('admin.conversations.findNotFound'));
      }
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setFinding(false);
    }
  };
  const [isRefreshing, setIsRefreshing] = useState(false);
  // List-load state kept separate from `actionError` (which is for moderation
  // actions) so we can tell loading / load-error / genuinely-empty apart.
  const [listError, setListError] = useState<string | null>(null);
  const [hasLoadedList, setHasLoadedList] = useState(false);
  // Complete raw event log (dev-persona view) — lazy-loaded on demand per conversation.
  const [events, setEvents] = useState<AdminConversationEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const driftEvents = driftData?.data ?? [];

  // The backend blanks content for a redacted OR deleted message, so `content` is
  // empty in both cases. The distinct `redacted` / `deleted` flags carry which one;
  // the preview column renders a visible tombstone from them (see below) rather than
  // showing an empty cell, so a reviewer sees that content EXISTED and was removed.
  // ONE TIMELINE, THE FULL RECORD BY DEFAULT (SPEC-ADMIN-CONSOLE FR55). Membership changes sit between
  // the messages they separated, so an operator reading a reply sees who was in the room when it was
  // sent. A removed message stays in place as its tombstone; "Current state" narrows the timeline to
  // what participants see now: it drops removed messages and the membership changes of hidden members.
  // An event archived before visibility was recorded carries no `hidden` and stays, because the filter
  // must not guess that a member was visible or hidden.
  const selectedMessages = useMemo(() => {
    const messageRows = messages.map((message) => ({
      ...message,
      kind: 'message' as const,
      preview: message.content.length > 140 ? `${message.content.slice(0, 140)}...` : message.content,
    }));
    const membershipRows = membershipHistory.map((e, i) => ({
      id: `membership-${i}`,
      kind: 'membership' as const,
      timestamp: e.timestamp,
      senderArn: e.memberArn,
      action: e.action,
      invitedBy: e.invitedBy,
      isBot: e.isBot,
      hidden: e.hidden,
      roomSetup: e.roomSetup,
      subject: e.subject,
      subjectOutcome: e.subjectOutcome,
      preview: '',
    }));
    const at = (t: unknown) => Date.parse(String(t)) || 0;
    const rows = [...messageRows, ...membershipRows].sort((a, b) => at(a.timestamp) - at(b.timestamp));
    return currentStateOnly
      ? rows.filter((r) => (r.kind === 'membership' ? r.hidden !== true && r.roomSetup !== true : (!(r as AdminConversationMessage).redacted && !(r as AdminConversationMessage).deleted)))
      : rows;
  }, [messages, membershipHistory, currentStateOnly]);

  async function loadConversationList(page = convPage) {
    setIsRefreshing(true);
    try {
      setListError(null);
      const { conversations: rows, total } = await listAdminConversations(CONV_PAGE_SIZE, page * CONV_PAGE_SIZE, undefined, narrowedTo);
      setConversations(rows);
      setConvTotal(total);
    } catch (error) {
      setListError(error instanceof Error ? error.message : t('admin.conversations.failedToLoadConversations'));
    } finally {
      setIsRefreshing(false);
      setHasLoadedList(true);
    }
  }

  // Fetch a specific page (server-side) and remember it as the current page.
  function goToConvPage(page: number) {
    setConvPage(page);
    loadConversationList(page);
  }

  async function loadConversationDetail(channelArn: string, signal?: AbortSignal) {
    if (!can('view-messages')) {
      setMessages([]);
      setMembers([]);
      setMembershipHistory([]);
      setIdentities({});
      setActionError(t('admin.refusal.lacksCapability', { capability: 'view-messages' }));
      return;
    }
    setIsRefreshing(true);
    // A TEAM MEMBER READS WHAT WAS SAID WHILE THEIR ASSISTANT WAS THERE, and nothing else: the membership
    // record, live members and names are reads their session holds no route for, so they are not asked for.
    if (teamAssistant()) {
      try {
        setActionError(null);
        const nextMessages = await listAdminConversationMessages(channelArn, 100);
        if (signal?.aborted) return;
        setMessages(nextMessages);
        setMembers([]);
        setMembershipHistory([]);
        setIdentities({});
      } catch (error) {
        if (signal?.aborted || error instanceof ReasonDeclinedError) return;
        setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToLoadConversationDetail'));
      } finally {
        if (!signal?.aborted) {
          setIsRefreshing(false);
          setMessagesFor(channelArn);
        }
      }
      return;
    }
    try {
      setActionError(null);
      // Each read degrades independently: the messages are the point of this view, so a
      // failing live members call (Chime can 4xx on an abandoned/odd channel) or history
      // read must NOT reject the whole load and blank the messages. Members + history each
      // fall back to empty; only a messages failure surfaces as an error.
      const [nextMessages, nextMembers, nextHistory, nextIdentities] = await Promise.all([
        listAdminConversationMessages(channelArn, 100),
        // The live member list is an administration-identity read; a role without it reads the archived
        // membership timeline below instead.
        can('view-live-members')
          ? listAdminConversationMembers(channelArn).catch(() => [] as AdminConversationMember[])
          : Promise.resolve([] as AdminConversationMember[]),
        getAdminMembershipHistory(channelArn).catch(() => [] as AdminMembershipEvent[]),
        // Refused for a role without the identity capability, which is a designed answer rather than a
        // failure: it resolves to an empty map and every surface keeps rendering ids. The `.catch` is
        // the same rule the two reads above follow - names are an enrichment, so nothing about them may
        // blank the messages this view exists to show.
        getAdminConversationIdentities(channelArn).catch(() => ({} as Record<string, string>)),
      ]);
      if (signal?.aborted) return;
      setMessages(nextMessages);
      setMembers(nextMembers);
      setMembershipHistory(nextHistory);
      setIdentities(nextIdentities);
    } catch (error) {
      if (signal?.aborted) return;
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToLoadConversationDetail'));
    } finally {
      if (!signal?.aborted) {
        setIsRefreshing(false);
        setMessagesFor(channelArn);
      }
    }
  }

  async function loadEvents(channelArn: string) {
    if (teamAssistant()) return; // the event log is a cross-assistant archive read
    setEventsLoading(true);
    setEventsError(null);
    try {
      setEvents(await listChannelEvents(channelArn));
    } catch (e) {
      setEvents([]);
      // A role without archive-view permission gets a 403 here — surface it, don't crash.
      setEventsError(e instanceof Error ? e.message : t('admin.conversations.failedToLoadEvents'));
    } finally {
      setEventsLoading(false);
    }
  }

  // A team's list is its own assistant's already, so only an admin's is narrowed.
  const narrowedTo = !teamAssistant() && assistantFilter ? assistantFilter : null;
  useEffect(() => {
    setConvPage(0);
    loadConversationList(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrowedTo]);

  // Cross-tab deep link: open a specific channel's detail page when another tab
  // (Flagged / Ground Truth) requests it. Prefer the loaded summary (real name +
  // tier); fall back to a minimal summary keyed on the ARN so the detail still
  // opens for a channel not in the current 40-row list. Consume once.
  useEffect(() => {
    if (!deepLinkChannelArn) return;
    const match = conversations.find((c) => c.channelArn === deepLinkChannelArn);
    setSelectedConversation(
      match ?? {
        channelArn: deepLinkChannelArn,
        name: deepLinkChannelArn.split('/').pop() || 'Conversation',
        messageCount: 0,
        memberCount: 0,
        metadata: {},
      },
    );
    setView('browser');
    setMessageLink(deepLinkMessage ? { ...deepLinkMessage, channelArn: deepLinkChannelArn } : null);
    setLinkFocus(null);
    setRereadFor(null);
    // A message is highlighted in the record, so a link opens the record rather than the de-identified copy.
    if (deepLinkMessage) setDetailForm('record');
    onDeepLinkConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkChannelArn]);

  // A link applies to its own conversation: opening another one, or the list, lets it go.
  const openLink = messageLink && messageLink.channelArn === selectedConversation?.channelArn ? messageLink : null;

  // ── OPENING AT A MESSAGE ─────────────────────────────────────────────────────────────────────────
  //
  // Resolved when the conversation's read settles, never on a timer. The viewer's read is the archive's
  // whole record of the conversation, so a message the link names is normally in the first read; when it is
  // not, the conversation is read once more (the record may not yet hold a message just written), and then
  // the viewer opens at the message nearest the link's time and says the linked message is not available.
  useEffect(() => {
    if (!openLink || linkFocus || messagesFor !== openLink.channelArn) return;
    const hit = openLink.messageId ? messages.find((m) => m.id === openLink.messageId) : undefined;
    if (!hit && openLink.messageId && rereadFor !== openLink) {
      setRereadFor(openLink);
      setMessagesFor(null);
      loadConversationDetail(openLink.channelArn);
      return;
    }
    const target = hit ?? nearestTo(messages, openLink.at);
    // A removed message is part of the record; "Current state" would hide the very row the link names.
    if (target && (target.redacted || target.deleted)) setCurrentStateOnly(false);
    // A link by time alone opens at its nearest message without a note; only a named message can be missing.
    setLinkFocus({ key: target?.id ?? null, missing: Boolean(openLink.messageId) && !hit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLink, linkFocus, messagesFor, messages, rereadFor]);

  useEffect(() => {
    if (!selectedConversation?.channelArn) return;

    // Collapse the raw event log when switching conversations (lazy-load again on demand).
    setShowEvents(false);
    setEvents([]);
    const controller = new AbortController();
    loadConversationDetail(selectedConversation.channelArn, controller.signal);

    return () => controller.abort();
  }, [selectedConversation?.channelArn]);

  // Let the console's global Back close an open detail (→ list) before it walks the
  // tab history, and mirror the open detail into the URL (deep-linking). Both react to
  // the selected conversation; registered/cleared as it opens and closes.
  useEffect(() => {
    registerBack?.(selectedConversation ? () => setSelectedConversation(null) : null);
    onConversationChange?.(selectedConversation?.channelArn ?? null, openLink);
    return () => registerBack?.(null);
  }, [selectedConversation, registerBack, onConversationChange, openLink]);

  // ARCHIVE OR DELETE THE WHOLE CONVERSATION. Each asks for the reason (adminReason) and for confirmation,
  // because neither is undone from here: an archive freezes the room, and a delete removes it.
  async function handleConversationAction(kind: 'archive' | 'delete') {
    if (!selectedConversation) return;
    const confirmKey = kind === 'archive' ? 'admin.conversations.confirmArchive' : 'admin.conversations.confirmDeleteConversation';
    if (!window.confirm(t(confirmKey, { name: selectedConversation.name }))) return;
    try {
      setActionError(null);
      if (kind === 'archive') await archiveAdminConversation(selectedConversation.channelArn);
      else await deleteAdminConversation(selectedConversation.channelArn);
      await loadConversationList();
      setSelectedConversation(null);
    } catch (error) {
      if (error instanceof ReasonDeclinedError) return;
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedConversationAction'));
    }
  }

  async function handleMembershipJoin(type: 'DEFAULT' | 'HIDDEN') {
    if (!selectedConversation) return;
    try {
      setActionError(null);
      await addAdminToConversation(selectedConversation.channelArn, type, type === 'DEFAULT');
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToJoinConversation'));
    }
  }

  async function handleRedact(messageId: string) {
    if (!selectedConversation) return;
    try {
      setActionError(null);
      await redactAdminConversationMessage(selectedConversation.channelArn, messageId);
      // Attribution: record WHO did it (server-verified). Best-effort — never fail the moderation.
      await recordModeration(selectedConversation.channelArn, messageId, 'redact').catch(() => {});
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToRedactMessage'));
    }
  }

  async function handleDelete(messageId: string) {
    if (!selectedConversation) return;
    // Delete is irreversible (app-instance-admin) — confirm.
    if (!window.confirm(t('admin.conversations.deleteThisMessagePermanentlyThis'))) return;
    try {
      setActionError(null);
      await deleteAdminConversationMessage(selectedConversation.channelArn, messageId);
      await recordModeration(selectedConversation.channelArn, messageId, 'delete').catch(() => {});
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToDeleteMessage'));
    }
  }

  async function handleFlag(messageId: string, reason: FlagReason) {
    if (!selectedConversation) return;
    setFlagPickerFor(null);
    try {
      setActionError(null);
      await flagResponse(selectedConversation.channelArn, messageId, reason);
      // Reload rather than patching state locally: the flag is now stored, and the transcript read
      // projects it (admin-conversations-aurora), so re-reading keeps the button honest about what
      // is actually in the table rather than about what this component believes it wrote.
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToFlagResponse'));
    }
  }

  async function handleUnflag(messageId: string) {
    if (!selectedConversation) return;
    try {
      setActionError(null);
      await unflagResponse(selectedConversation.channelArn, messageId);
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToWithdrawTheFlag'));
    }
  }

  // Open a conversation attachment. Vends channel-scoped, short-lived, AUDITED S3 creds via the
  // exchange (plane:'admin') and opens the presigned GET in a new tab. User-uploaded files (PII)
  // are confirmed first, since opening one is a moderation-grade access that is distinctly logged.
  async function handleOpenAttachment(fileKey: string, name: string) {
    if (!selectedConversation) return;
    if (isUserUploadedAttachment(fileKey)) {
      if (!window.confirm(`"${name}" is a user-uploaded file and may contain personal data. Opening it is an audited action. Continue?`)) return;
    }
    try {
      setActionError(null);
      setOpeningAttachment(fileKey);
      const url = await getAdminAttachmentDownloadUrl(selectedConversation.channelArn, fileKey);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToOpenAttachment'));
    } finally {
      setOpeningAttachment(null);
    }
  }

  async function handleAddMember() {
    if (!selectedConversation || !newMemberArn.trim()) return;
    try {
      setActionError(null);
      await addAdminMember(selectedConversation.channelArn, newMemberArn.trim());
      setNewMemberArn('');
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToAddMember'));
    }
  }

  async function handleRemoveMember(memberArn: string) {
    if (!selectedConversation) return;
    if (!window.confirm('Remove this member from the conversation?')) return;
    try {
      setActionError(null);
      await removeAdminMember(selectedConversation.channelArn, memberArn);
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('admin.conversations.failedToRemoveMember'));
    }
  }

  if (isLoading && conversations.length === 0) {
    return <div className="admin-tab-loading">{t('admin.conversations.loadingConversationData')}</div>;
  }

  // #4: the conversation detail is its OWN page — selecting a conversation replaces
  // the list with a full-width messages/members view and a Back control, rather than
  // appending an inline panel below the list. Deep links (Flagged / Ground Truth) land
  // here directly.
  if (selectedConversation) {
    return (
      <div className="admin-tab">
        <div className="admin-tab-header">
          <button className="btn-secondary" onClick={returnTo ? returnTo.onReturn : () => setSelectedConversation(null)}>
            {t('admin.conversations.back')}
          </button>
          <button className="admin-filter-btn" onClick={() => loadConversationDetail(selectedConversation.channelArn)}>
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {actionError && (
          <div className="admin-error">
            <span>{actionError}</span>
            <button className="btn-secondary" onClick={() => setActionError(null)}>Dismiss</button>
          </div>
        )}
        {teamAssistant() && (
          <p className="admin-tab-description">
            {t('admin.conversations.teamReadBounded', { assistant: teamAssistant() })}
          </p>
        )}

        <div className="admin-section admin-conversation-panel">
          <div className="admin-conversation-header">
            <div>
              <h4>{selectedConversation.name}</h4>
              <p>{selectedConversation.channelArn}</p>
            </div>
            {can('manage-membership') && (
              <div className="admin-filter-group">
                <button className="btn-secondary" onClick={() => handleMembershipJoin('DEFAULT')}>
                  Join visibly
                </button>
                <button className="btn-secondary" onClick={() => handleMembershipJoin('HIDDEN')}>
                  Join invisibly
                </button>
              </div>
            )}
            {(can('archive-conversation') || can('delete-conversation')) && (
              <div className="admin-filter-group">
                {can('archive-conversation') && (
                  <button className="btn-secondary" onClick={() => handleConversationAction('archive')}>
                    {t('admin.conversations.archiveConversation')}
                  </button>
                )}
                {can('delete-conversation') && (
                  <button className="btn-danger" onClick={() => handleConversationAction('delete')}>
                    {t('admin.conversations.deleteConversation')}
                  </button>
                )}
              </div>
            )}
          </div>

          {can('view-clean-conversations') && (
            <div className="admin-filter-group" role="group" aria-label={t('admin.conversations.viewDeidentified')}>
              <button className="admin-filter-btn" aria-pressed={detailForm === 'record'} onClick={() => setDetailForm('record')}>
                {t('admin.conversations.viewRecord')}
              </button>
              <button className="admin-filter-btn" aria-pressed={detailForm === 'deidentified'} onClick={() => setDetailForm('deidentified')}>
                {t('admin.conversations.viewDeidentified')}
              </button>
            </div>
          )}
          {detailForm === 'deidentified' && can('view-clean-conversations') ? (
            <CleanConversationView channelArn={selectedConversation.channelArn} />
          ) : (
          <div className="admin-conversation-split">
            <div className="admin-section">
              <h4>{t('admin.conversations.recentMessages')}</h4>
              <label className="admin-filter-group">
                <input type="checkbox" checked={currentStateOnly} onChange={(e) => setCurrentStateOnly(e.target.checked)} />{' '}
                {t('admin.conversations.clean.currentState')}
              </label>
              {currentStateOnly && <p className="admin-field-hint">{t('admin.conversations.currentStateRecordHint')}</p>}
              {openLink && linkFocus?.missing && (
                <p className="admin-field-hint" role="status" data-testid="message-link-note">
                  {openLink.at
                    ? t('admin.conversations.messageLink.missing', { context: openLink.kind ?? undefined, time: new Date(openLink.at).toLocaleString() })
                    : t('admin.conversations.messageLink.missingNoTime', { context: openLink.kind ?? undefined })}
                </p>
              )}
              <DataTable
                rowKey={(row) => (row.kind === 'message' ? String(row.id) : null)}
                focusKey={openLink ? linkFocus?.key ?? null : null}
                columns={[
                  { key: 'timestamp', label: 'Time', render: (value) => new Date(String(value)).toLocaleString() },
                  // WHO SENT IT, BY ID UNLESS A NAME WAS GRANTED. The read returns no name to
                  // anyone - `Name` on the Chime identity is the person's EMAIL - so the id is the
                  // default and `identities` fills a name in only for an operator holding
                  // `see-user-identity`. The column is never blank either way.
                  {
                    key: 'senderArn',
                    label: 'Sender',
                    render: (_value, row) => {
                      const arn = String(row.senderArn || '');
                      const name = identities[arn];
                      return name ? <>{name}</> : <span className="font-mono">{principalOf(arn)}</span>;
                    },
                  },
                  { key: 'intent', label: 'Intent' },
                  { key: 'modelId', label: 'Model' },
                  {
                    key: 'preview',
                    label: 'Message',
                    render: (value, row) => {
                      // A SUBJECT CHANGE, where it happened: a drift flag and how it ended, or a subject a
                      // summary added or dropped. Folded into the same timeline as membership.
                      if (row.kind === 'membership' && String(row.action).startsWith('subject_')) {
                        return (
                          <span className="admin-timeline-action">
                            {t(`admin.conversations.subject.${String(row.action)}`, { subject: String(row.subject ?? '') })}
                            {row.subjectOutcome ? ` · ${t(`admin.conversations.subject.outcome.${String(row.subjectOutcome)}`, { defaultValue: String(row.subjectOutcome) })}` : ''}
                          </span>
                        );
                      }
                      if (row.kind === 'membership') {
                        return (
                          <span className="admin-timeline-action">
                            {t('admin.conversations.membershipChange', {
                              action: t(`admin.membership.action.${String(row.action)}`, { defaultValue: String(row.action) }),
                            })}
                            {row.invitedBy ? ` · ${t('admin.conversations.membershipBy', { by: String(row.invitedBy) })}` : ''}
                            {row.hidden ? ` · ${t('admin.conversations.membershipHidden')}` : ''}
                            {row.roomSetup ? ` · ${t('admin.conversations.membershipRoomSetup')}` : ''}
                          </span>
                        );
                      }
                      const m = row as unknown as AdminConversationMessage;
                      // A tombstone (not a blank cell) so the reviewer sees content existed and was
                      // removed. Wording tracks the authority model (SPEC-ADMIN-IDENTITY): a redact is
                      // a moderator-level action, a delete requires app-instance-admin. Delete takes
                      // precedence over redact (the stronger action).
                      if (m.deleted)
                        return (
                          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            {m.moderatedByName ? t('admin.conversations.deletedBy', { moderatedByName: m.moderatedByName }) : t('admin.conversations.deletedByAnAdmin')}
                          </span>
                        );
                      if (m.redacted)
                        return (
                          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            {m.moderatedByName ? t('admin.conversations.redactedBy', { moderatedByName: m.moderatedByName }) : t('admin.conversations.redactedByAModerator')}
                          </span>
                        );
                      // EVERY VERSION IN THE RECORD (FR55). The latest is the text above; the earlier
                      // ones sit under it, oldest first, because a reply may have answered any of them.
                      // "Current state" is the latest only.
                      if (!currentStateOnly && m.versions && m.versions.length > 1)
                        return (
                          <>
                            {String(value ?? '')}
                            <details className="admin-field-hint">
                              <summary>{t('admin.conversations.editedVersions', { count: m.versions.length })}</summary>
                              <ol>
                                {m.versions.slice(0, -1).map((v, i) => (
                                  <li key={i}>
                                    {new Date(v.at).toLocaleString()}: {v.content}
                                  </li>
                                ))}
                              </ol>
                            </details>
                          </>
                        );
                      return String(value ?? '');
                    },
                  },
                  {
                    key: 'moderate',
                    label: 'Moderate',
                    sortable: false,
                    render: (_value, row) => {
                      // A membership change has no message to inspect, moderate or flag.
                      if (row.kind === 'membership') return null;
                      const m = row as unknown as AdminConversationMessage;
                      return (
                        <div className="admin-inline-actions">
                          <button
                            className="btn-secondary"
                            title={t('admin.conversations.inspectAllFieldsMetadata')}
                            onClick={() => setInspectMessage(m)}
                          >
                            ⓘ Info
                          </button>
                          {/* A redacted message can't be re-redacted; a deleted one can't be
                              moderated at all. Redact hides once redacted OR deleted; Delete once deleted. */}
                          {!m.redacted && !m.deleted && can('redact') && (
                            <button className="btn-secondary" onClick={() => handleRedact(String(row.id))}>
                              Redact
                            </button>
                          )}
                          {!m.deleted && can('delete') && (
                            <button className="btn-danger" onClick={() => handleDelete(String(row.id))}>
                              Delete
                            </button>
                          )}
                          {/* ── FLAG: THE JUDGEMENT THIS VIEW COULD NOT RECORD ────────────────────
                              Oversight is the moderator surface and it was read-only about quality:
                              the Flagged list had exactly one author, the judge, and a human could
                              only approve or reject what the judge already raised. So a moderator
                              who read a conversation and saw a bad answer had nowhere to put it.
                              Only on assistant responses - flagging a person's own message is not
                              what this measures, and a deleted message has no response left.
                              And only on an ANSWER: a welcome or a join notice has no exchange, and
                              the Flagged list reaches a flag through its exchange. A flag already
                              raised still renders, so it can be withdrawn. */}
                          {m.isBot && !m.deleted && can('triage-responses') && (
                            m.flagReason ? (
                              <button
                                className="btn-secondary"
                                title={t('admin.conversations.flaggedClickToWithdraw', { flagReason: FLAG_REASON_KEYS[m.flagReason] ? t(FLAG_REASON_KEYS[m.flagReason]) : m.flagReason })}
                                onClick={() => handleUnflag(String(row.id))}
                              >
                                ⚑ Flagged
                              </button>
                            ) : m.answersTurn ? (
                              <button
                                className="btn-secondary"
                                title={t('admin.conversations.flagThisResponseForReview')}
                                onClick={() => setFlagPickerFor(String(row.id))}
                              >
                                ⚑ Flag
                              </button>
                            ) : null
                          )}
                        </div>
                      );
                    },
                  },
                  {
                    key: 'flagPicker',
                    label: '',
                    sortable: false,
                    render: (_value, row) => {
                      // The reason, asked inline rather than in a modal: the moderator is reading a
                      // transcript and the response being judged has to stay on screen next to the
                      // question. Same closed set the chat client offers an end user, so the two
                      // populations of flags are countable together.
                      if (flagPickerFor !== String(row.id)) return null;
                      return (
                        <div className="admin-inline-actions">
                          {(Object.keys(FLAG_REASON_KEYS) as FlagReason[]).map((reason) => (
                            <button key={reason} className="btn-secondary" onClick={() => handleFlag(String(row.id), reason)}>
                              {t(FLAG_REASON_KEYS[reason])}
                            </button>
                          ))}
                          <button className="btn-secondary" onClick={() => setFlagPickerFor(null)}>
                            Cancel
                          </button>
                        </div>
                      );
                    },
                  },
                ]}
                data={selectedMessages}
                emptyMessage={t('admin.conversations.noMessagesLoaded')}
              />
            </div>

            <div className="admin-section admin-conversation-members">
              <h4>{t('admin.conversations.members')}</h4>
              <DataTable
                columns={[
                  // THE ONE PERSON-BEARING SURFACE NO SERVER OMISSION CAN REACH.
                  //
                  // This table is read client-side from Amazon Chime SDK `ListChannelMemberships` under
                  // the admin bearer, not from `admin-conversations`, so the identity capability never
                  // sees the request and `name` arrives as the person's EMAIL whatever the caller holds.
                  // The client cannot gate what it was never told, so it renders the id by default -
                  // the decided behavior for every person-bearing surface, and the only half of it
                  // available here. The remove action already keys off `memberArn`, so nothing needs
                  // the name.
                  {
                    key: 'memberArn',
                    label: 'Member',
                    render: (value) => <code className="admin-mono-arn">{principalOf(String(value || ''))}</code>,
                  },
                  { key: 'type', label: 'Visibility' },
                  { key: 'isBot', label: 'Bot', render: (value) => value ? 'Yes' : 'No' },
                  {
                    key: 'remove',
                    label: '',
                    sortable: false,
                    render: (_value, row) => (can('manage-membership') ? (
                      <button
                        className="btn-danger"
                        title={t('admin.conversations.removeMember')}
                        onClick={() => handleRemoveMember(String((row as AdminConversationMember).memberArn))}
                      >
                        ×
                      </button>
                    ) : null),
                  },
                ]}
                data={members}
                emptyMessage={t('admin.conversations.noMembersFound')}
              />
              {can('manage-membership') && (
              <div className="admin-add-member-row">
                <input
                  className="input"
                  placeholder={t('admin.conversations.memberArnUserOrBot')}
                  value={newMemberArn}
                  onChange={(e) => setNewMemberArn(e.target.value)}
                />
                <button className="btn-secondary" onClick={handleAddMember} disabled={!newMemberArn.trim()}>
                  Add member
                </button>
              </div>
              )}

            </div>
            {/* Who was invited in, and where each invitation stands (M-10). */}
            {can('view-invitations') && (
              <InvitationsPanel channelArn={selectedConversation.channelArn} canRevoke={can('revoke-invitations')} />
            )}
          </div>
          )}

          {/* Complete raw event log — dev-persona view of EVERY archived event for this channel
              (message create/update/redact/delete, membership create/update/delete, channel). Lazy. */}
          <div className="admin-section">
            <div className="admin-tab-header" style={{ marginBottom: 'var(--space-2)' }}>
              <h4 style={{ margin: 0 }}>All events (raw log)</h4>
              <button
                className="admin-filter-btn"
                onClick={() => {
                  const next = !showEvents;
                  setShowEvents(next);
                  if (next && selectedConversation && events.length === 0) {
                    loadEvents(selectedConversation.channelArn);
                  }
                }}
              >
                {showEvents ? 'Hide' : eventsLoading ? 'Loading…' : t('admin.conversations.showAllEvents')}
              </button>
            </div>
            {showEvents && (
              <DataTable
                columns={[
                  { key: 'createdAt', label: 'Time', render: (v) => new Date(String(v)).toLocaleString() },
                  { key: 'eventType', label: 'Event' },
                  {
                    key: 'senderArn',
                    label: 'Actor',
                    // Same rule as the Sender column: the id unless a name was granted.
                    render: (_v, row) => nameOrId((row as AdminConversationEvent).senderArn),
                  },
                  { key: 'targetArn', label: 'Target', render: (v) => (v ? String(v).split('/').pop() : '') },
                  {
                    key: 'content',
                    label: 'Detail',
                    render: (v) => {
                      const s = v == null ? '' : String(v);
                      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
                    },
                  },
                ]}
                data={events}
                emptyMessage={eventsError || (eventsLoading ? t('admin.conversations.loadingEvents') : 'No events')}
              />
            )}
          </div>
        </div>

        {inspectMessage && (
          <MessageInspectDrawer
            message={inspectMessage}
            onClose={() => setInspectMessage(null)}
            onOpenAttachment={handleOpenAttachment}
            openingAttachment={openingAttachment}
            channelArn={selectedConversation.channelArn}
          />
        )}
      </div>
    );
  }

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        {/* What a moderator can do from here is a hint; the authority behind each action - who may
            redact, who may delete, and the membership an action is taken through - is SPEC-MODERATION. */}
        <h3>
          Conversations
          <InfoTooltip
            label={t('admin.conversations.whatYouCanDoFrom')}
            content={
              <>
                Browse conversations in any state - live, archived or deleted - and inspect their recent
                messages. You can add yourself as a visible or a hidden member, and redact or delete a
                message when moderation is needed. Drift Detection is the second view: it reports the
                offers to split a conversation that has moved to a new subject.
              </>
            }
          />
        </h3>
        {/* The two VIEW toggles are grouped together; Refresh is a distinct ACTION (not a third view),
            set apart so it doesn't read as another toggle. */}
        <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="admin-filter-group">
            <button
              className={`admin-filter-btn ${view === 'browser' ? 'active' : ''}`}
              onClick={() => setView('browser')}
            >
              Browser
            </button>
            <button
              className={`admin-filter-btn ${view === 'drift' ? 'active' : ''}`}
              onClick={() => setView('drift')}
            >
              Drift Detection
              {driftEvents.filter((d) => d.outcome === 'abandoned').length > 0 && (
                <span className="admin-badge">{driftEvents.filter((d) => d.outcome === 'abandoned').length}</span>
              )}
            </button>
          </div>
          <button className="btn-secondary" onClick={() => loadConversationList()} title={t('admin.conversations.reloadTheConversationList')}>
            {isRefreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {actionError && (
        <div className="admin-error">
          <span>{actionError}</span>
          <button className="btn-secondary" onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      {view === 'browser' ? (
        <>
          <p className="admin-tab-description">{t('admin.conversations.browserDescription')}</p>
          <GuideLinks guides={[guide(t('admin.guides.conversations.moderation'), 'moderation')]} />

          {can('find-conversation') && (
            <form
              className="admin-add-member-row"
              onSubmit={(e) => { e.preventDefault(); void handleFind(); }}
            >
              <input
                className="input"
                aria-label={t('admin.conversations.findById')}
                placeholder={t('admin.conversations.findByIdPlaceholder')}
                value={findId}
                onChange={(e) => setFindId(e.target.value)}
              />
              <button type="submit" className="btn-secondary" disabled={finding || !findId.trim()}>
                {t('admin.conversations.findButton')}
              </button>
            </form>
          )}

          {narrowedTo && (
            <div className="admin-info-banner" role="status" data-testid="conversations-assistant-filter">
              <span>{t('admin.conversations.narrowedToAssistant', { assistant: narrowedTo })}</span>
              {onClearAssistantFilter && (
                <button type="button" className="btn-secondary" onClick={onClearAssistantFilter}>{t('admin.conversations.showEveryConversation')}</button>
              )}
            </div>
          )}
          <div className="admin-section">
            {!hasLoadedList && isRefreshing ? (
              <div className="admin-tab-loading">{t('admin.conversations.loadingConversations')}</div>
            ) : listError && conversations.length === 0 ? (
              <div className="data-table-empty">
                Couldn't load conversations. {listError}{' '}
                <button className="btn-secondary" onClick={() => loadConversationList()}>Retry</button>
              </div>
            ) : (
              <>
                {listError && (
                  <p className="admin-tab-description" style={{ color: 'var(--status-bad)' }}>
                    Showing the last loaded results — refresh failed: {listError}
                  </p>
                )}
                <DataTable
                  columns={[
                    { key: 'name', label: 'Conversation' },
                    {
                      key: 'tier',
                      // The list query returns the conversation's tier on metadata.modelTier — that IS
                      // what this column shows, so label it "Tier" (not "Privacy", which mislabeled it).
                      label: 'Tier',
                      render: (_value, row) =>
                        tierBadge(String((row as AdminConversationSummary).metadata?.modelTier ?? '')),
                    },
                    {
                      key: 'state',
                      label: 'State',
                      render: (_value, row) => stateBadge((row as AdminConversationSummary).state),
                    },
                    { key: 'memberCount', label: 'Members' },
                    { key: 'lastMessageAt', label: 'Last Activity', render: (value) => value ? new Date(String(value)).toLocaleString() : '--' },
                    {
                      key: 'select',
                      label: 'Open',
                      sortable: false,
                      render: (_value, row) => (
                        <button
                          className="btn-secondary"
                          onClick={() => setSelectedConversation(row as AdminConversationSummary)}
                        >
                          View
                        </button>
                      ),
                    },
                  ]}
                  data={conversations}
                  emptyMessage={t('admin.conversations.noConversationsAvailable')}
                  serverPagination={{ page: convPage, pageSize: CONV_PAGE_SIZE, total: convTotal, onPageChange: goToConvPage, loading: isRefreshing }}
                />
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {/*
            Honest-empty banner: in Athena mode `drift_events` returns
            unsupported (pgvector cosine-similarity is Aurora-only per
            docs/specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md). Without the banner, the
            drift table is permanently empty with no explanation.
          */}
          <UnsupportedAnalyticsBanner result={driftData} />
          <p className="admin-tab-description">
            {t('admin.conversations.whetherTheOffersToSplit')}
            <InfoTooltip
              label={t('admin.conversations.howToReadTheDrift')}
              content={
                <>
                  Drift detection offers to split a conversation that has moved to a new subject. Two
                  things matter about an offer: was it accurate, and did the user accept. How often
                  users change topic is a fact about users rather than a health measure, so the
                  per-event rows below are detail rather than the headline.
                </>
              }
            />
          </p>
          <GuideLinks guides={[guide(t('admin.guides.conversations.drift'), 'driftConvergence')]} />
          <DriftHealthPanel stats={driftData?.stats} />
          <DataTable
            columns={[
              { key: 'detected_at', label: 'Detected', render: (v) => new Date(String(v)).toLocaleString() },
              { key: 'drift_score', label: 'Drift', render: (v) => driftBadge(Number(v)) },
              { key: 'intent', label: 'Intent' },
              {
                key: 'outcome',
                label: 'Outcome',
                render: (v) => {
                  const labels: Record<string, string> = {
                    accepted: t('admin.conversations.acceptedReroute'),
                    declined: 'Declined',
                    rejected_in_new_channel: t('admin.conversations.rejectedInNewChannel'),
                    abandoned: 'Abandoned',
                  };
                  return labels[String(v)] || String(v ?? '');
                },
              },
              { key: 'confidence', label: 'Confidence' },
              {
                key: 'new_channel_arn',
                label: 'Rerouted To',
                render: (v) => (v ? String(v).split('/').pop() : 'n/a'),
              },
            ]}
            data={driftEvents}
            emptyMessage={t('admin.conversations.noDriftEventsDetected')}
          />
        </>
      )}
    </div>
  );
};

export default ConversationsTab;
