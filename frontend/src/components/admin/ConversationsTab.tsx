import React, { useEffect, useMemo, useState } from 'react';
import DataTable from './DataTable';
import UnsupportedAnalyticsBanner from './UnsupportedAnalyticsBanner';
import {
  addAdminToConversation,
  addAdminMember,
  removeAdminMember,
  getAdminMembershipHistory,
  deleteAdminConversationMessage,
  listAdminConversationMembers,
  listAdminConversationMessages,
  listAdminConversations,
  redactAdminConversationMessage,
} from '../../services/adminConversationService';
import MessageInspectDrawer from './MessageInspectDrawer';
import MembershipTimeline from './MembershipTimeline';
import type { AnalyticsResult } from '../../types/analytics';
import type {
  AdminConversationMember,
  AdminConversationMessage,
  AdminConversationSummary,
  AdminMembershipEvent,
} from '../../types';

interface ConversationsTabProps {
  summaryData: AnalyticsResult | null;
  driftData: AnalyticsResult | null;
  isLoading: boolean;
  /** When set (from Flagged/Ground-Truth links), open this channel's detail page. */
  deepLinkChannelArn?: string | null;
  /** Called once the deep link has been opened, so the parent can clear it. */
  onDeepLinkConsumed?: () => void;
  /**
   * Register a "close the open conversation detail" handler with the parent, so the
   * console's global Back button returns to the LIST first (one level) instead of
   * walking the tab history past it. Called with the closer when a detail is open,
   * and null when back on the list.
   */
  registerBack?: (close: (() => void) | null) => void;
}

// Tier badge for the conversations list (basic/standard/premium) — the channel's
// classification, from metadata.modelTier. Blank when a legacy row carries no tier.
function tierBadge(tier: string): React.ReactNode {
  if (!tier) return <span style={{ opacity: 0.5 }}>—</span>;
  const color =
    tier === 'premium' ? 'var(--status-info)' : tier === 'standard' ? 'var(--status-good)' : 'var(--status-warn)';
  return (
    <span style={{ backgroundColor: `${color}20`, color, padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 600 }}>
      {tier}
    </span>
  );
}

function driftBadge(score: number): React.ReactNode {
  const color = score >= 0.7 ? 'var(--status-bad)' : score >= 0.4 ? 'var(--status-warn)' : 'var(--status-good)';
  const label = score >= 0.7 ? 'High Drift' : score >= 0.4 ? 'Moderate' : 'On Topic';
  return (
    <span style={{ backgroundColor: `${color}20`, color, padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 600 }}>
      {label} ({(score * 100).toFixed(0)}%)
    </span>
  );
}

const ConversationsTab: React.FC<ConversationsTabProps> = ({ driftData, isLoading, deepLinkChannelArn, onDeepLinkConsumed, registerBack }) => {
  const [view, setView] = useState<'browser' | 'drift'>('browser');
  const [conversations, setConversations] = useState<AdminConversationSummary[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<AdminConversationSummary | null>(null);
  const [messages, setMessages] = useState<AdminConversationMessage[]>([]);
  const [members, setMembers] = useState<AdminConversationMember[]>([]);
  const [membershipHistory, setMembershipHistory] = useState<AdminMembershipEvent[]>([]);
  const [inspectMessage, setInspectMessage] = useState<AdminConversationMessage | null>(null);
  const [newMemberArn, setNewMemberArn] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // List-load state kept separate from `actionError` (which is for moderation
  // actions) so we can tell loading / load-error / genuinely-empty apart.
  const [listError, setListError] = useState<string | null>(null);
  const [hasLoadedList, setHasLoadedList] = useState(false);

  const driftEvents = driftData?.data ?? [];

  // The backend blanks content for a redacted OR deleted message, so `content` is
  // empty in both cases. The distinct `redacted` / `deleted` flags carry which one;
  // the preview column renders a visible tombstone from them (see below) rather than
  // showing an empty cell, so a reviewer sees that content EXISTED and was removed.
  const selectedMessages = useMemo(
    () => messages.map((message) => ({
      ...message,
      preview: message.content.length > 140 ? `${message.content.slice(0, 140)}...` : message.content,
    })),
    [messages]
  );

  async function loadConversationList() {
    setIsRefreshing(true);
    try {
      setListError(null);
      const results = await listAdminConversations(40);
      setConversations(results);
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Failed to load conversations');
    } finally {
      setIsRefreshing(false);
      setHasLoadedList(true);
    }
  }

  async function loadConversationDetail(channelArn: string, signal?: AbortSignal) {
    setIsRefreshing(true);
    try {
      setActionError(null);
      const [nextMessages, nextMembers, nextHistory] = await Promise.all([
        listAdminConversationMessages(channelArn, 100),
        listAdminConversationMembers(channelArn),
        getAdminMembershipHistory(channelArn).catch(() => [] as AdminMembershipEvent[]),
      ]);
      if (signal?.aborted) return;
      setMessages(nextMessages);
      setMembers(nextMembers);
      setMembershipHistory(nextHistory);
    } catch (error) {
      if (signal?.aborted) return;
      setActionError(error instanceof Error ? error.message : 'Failed to load conversation detail');
    } finally {
      if (!signal?.aborted) setIsRefreshing(false);
    }
  }

  useEffect(() => {
    loadConversationList();
  }, []);

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
    onDeepLinkConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkChannelArn]);

  useEffect(() => {
    if (!selectedConversation?.channelArn) return;

    const controller = new AbortController();
    loadConversationDetail(selectedConversation.channelArn, controller.signal);

    return () => controller.abort();
  }, [selectedConversation?.channelArn]);

  // Let the console's global Back close an open detail (→ list) before it walks the
  // tab history. Registered while a conversation is selected; cleared otherwise.
  useEffect(() => {
    registerBack?.(selectedConversation ? () => setSelectedConversation(null) : null);
    return () => registerBack?.(null);
  }, [selectedConversation, registerBack]);

  async function handleMembershipJoin(type: 'DEFAULT' | 'HIDDEN') {
    if (!selectedConversation) return;
    try {
      setActionError(null);
      await addAdminToConversation(selectedConversation.channelArn, type, type === 'DEFAULT');
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to join conversation');
    }
  }

  async function handleRedact(messageId: string) {
    if (!selectedConversation) return;
    try {
      setActionError(null);
      await redactAdminConversationMessage(selectedConversation.channelArn, messageId);
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to redact message');
    }
  }

  async function handleDelete(messageId: string) {
    if (!selectedConversation) return;
    // Delete is irreversible (app-instance-admin) — confirm.
    if (!window.confirm('Delete this message permanently? This cannot be undone.')) return;
    try {
      setActionError(null);
      await deleteAdminConversationMessage(selectedConversation.channelArn, messageId);
      await loadConversationDetail(selectedConversation.channelArn);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to delete message');
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
      setActionError(error instanceof Error ? error.message : 'Failed to add member');
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
      setActionError(error instanceof Error ? error.message : 'Failed to remove member');
    }
  }

  if (isLoading && conversations.length === 0) {
    return <div className="admin-tab-loading">Loading conversation data...</div>;
  }

  // #4: the conversation detail is its OWN page — selecting a conversation replaces
  // the list with a full-width messages/members view and a Back control, rather than
  // appending an inline panel below the list. Deep links (Flagged / Ground Truth) land
  // here directly.
  if (selectedConversation) {
    return (
      <div className="admin-tab">
        <div className="admin-tab-header">
          <button className="admin-inline-btn" onClick={() => setSelectedConversation(null)}>
            ← Back to conversations
          </button>
          <button className="admin-filter-btn" onClick={() => loadConversationDetail(selectedConversation.channelArn)}>
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {actionError && (
          <div className="admin-error">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)}>Dismiss</button>
          </div>
        )}

        <div className="admin-section admin-conversation-panel">
          <div className="admin-conversation-header">
            <div>
              <h4>{selectedConversation.name}</h4>
              <p>{selectedConversation.channelArn}</p>
            </div>
            <div className="admin-filter-group">
              <button className="admin-inline-btn" onClick={() => handleMembershipJoin('DEFAULT')}>
                Join visibly
              </button>
              <button className="admin-inline-btn" onClick={() => handleMembershipJoin('HIDDEN')}>
                Join invisibly
              </button>
            </div>
          </div>

          <div className="admin-conversation-split">
            <div className="admin-section">
              <h4>Recent Messages</h4>
              <DataTable
                columns={[
                  { key: 'timestamp', label: 'Time', render: (value) => new Date(String(value)).toLocaleString() },
                  { key: 'senderName', label: 'Sender' },
                  { key: 'intent', label: 'Intent' },
                  { key: 'modelId', label: 'Model' },
                  {
                    key: 'preview',
                    label: 'Message',
                    render: (value, row) => {
                      const m = row as unknown as AdminConversationMessage;
                      // Deleted takes precedence over redacted (a delete is the stronger action).
                      // A tombstone, not a blank cell: the reviewer must see content existed + was removed.
                      if (m.deleted)
                        return (
                          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            🗑 [deleted by moderator]
                          </span>
                        );
                      if (m.redacted)
                        return (
                          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            ⊘ [redacted by moderator]
                          </span>
                        );
                      return String(value ?? '');
                    },
                  },
                  {
                    key: 'moderate',
                    label: 'Moderate',
                    sortable: false,
                    render: (_value, row) => (
                      <div className="admin-inline-actions">
                        <button
                          className="admin-inline-btn"
                          title="Inspect — all fields + metadata"
                          onClick={() => setInspectMessage(row as unknown as AdminConversationMessage)}
                        >
                          ⓘ Info
                        </button>
                        <button className="admin-inline-btn" onClick={() => handleRedact(String(row.id))}>
                          Redact
                        </button>
                        <button className="admin-inline-btn danger" onClick={() => handleDelete(String(row.id))}>
                          Delete
                        </button>
                      </div>
                    ),
                  },
                ]}
                data={selectedMessages}
                emptyMessage="No messages loaded"
              />
            </div>

            <div className="admin-section admin-conversation-members">
              <h4>Members</h4>
              <DataTable
                columns={[
                  { key: 'name', label: 'Name' },
                  { key: 'type', label: 'Visibility' },
                  { key: 'isBot', label: 'Bot', render: (value) => value ? 'Yes' : 'No' },
                  {
                    key: 'remove',
                    label: '',
                    sortable: false,
                    render: (_value, row) => (
                      <button
                        className="admin-inline-btn danger"
                        title="Remove member"
                        onClick={() => handleRemoveMember(String((row as AdminConversationMember).memberArn))}
                      >
                        ×
                      </button>
                    ),
                  },
                ]}
                data={members}
                emptyMessage="No members found"
              />
              <div className="admin-add-member-row">
                <input
                  className="input"
                  placeholder="Member ARN (user or bot of this app instance)"
                  value={newMemberArn}
                  onChange={(e) => setNewMemberArn(e.target.value)}
                />
                <button className="admin-inline-btn" onClick={handleAddMember} disabled={!newMemberArn.trim()}>
                  Add member
                </button>
              </div>

              <h4 style={{ marginTop: 'var(--space-4)' }}>Membership history</h4>
              <MembershipTimeline events={membershipHistory} />
            </div>
          </div>
        </div>

        {inspectMessage && (
          <MessageInspectDrawer message={inspectMessage} onClose={() => setInspectMessage(null)} />
        )}
      </div>
    );
  }

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>Conversations</h3>
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
          <button className="admin-filter-btn" onClick={() => loadConversationList()}>
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {actionError && (
        <div className="admin-error">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      {view === 'browser' ? (
        <>
          <p className="admin-tab-description">
            Browse live conversations, inspect recent messages, add yourself as a visible or hidden member,
            and redact or delete messages when moderation is needed.
          </p>

          <div className="admin-section">
            {!hasLoadedList && isRefreshing ? (
              <div className="admin-tab-loading">Loading conversations…</div>
            ) : listError && conversations.length === 0 ? (
              <div className="data-table-empty">
                Couldn't load conversations. {listError}{' '}
                <button className="admin-inline-btn" onClick={() => loadConversationList()}>Retry</button>
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
                    { key: 'memberCount', label: 'Members' },
                    { key: 'lastMessageAt', label: 'Last Activity', render: (value) => value ? new Date(String(value)).toLocaleString() : '--' },
                    {
                      key: 'select',
                      label: 'Open',
                      sortable: false,
                      render: (_value, row) => (
                        <button
                          className="admin-inline-btn"
                          onClick={() => setSelectedConversation(row as AdminConversationSummary)}
                        >
                          View
                        </button>
                      ),
                    },
                  ]}
                  data={conversations}
                  emptyMessage="No conversations available"
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
            docs/SPEC-DRIFT-CONVERGENCE.md). Without the banner, the
            drift table is permanently empty with no explanation.
          */}
          <UnsupportedAnalyticsBanner result={driftData} />
          <p className="admin-tab-description">
            Drift detection identifies conversations that have shifted away from their stated purpose.
            High drift may indicate the user needs to be redirected to a new conversation.
          </p>
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
                    accepted: 'Accepted reroute',
                    declined: 'Declined',
                    rejected_in_new_channel: 'Rejected in new channel',
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
            emptyMessage="No drift events detected"
          />
        </>
      )}
    </div>
  );
};

export default ConversationsTab;
