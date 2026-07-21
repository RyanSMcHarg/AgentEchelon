import React, { useState, useEffect } from 'react';
import DataTable from './DataTable';
import type { AnalyticsResult } from '@ae/shared';

interface FlaggedResponsesTabProps {
  data: AnalyticsResult | null;
  isLoading: boolean;
  onReview?: (exchangeId: string, action: 'approved' | 'rejected', notes: string) => void;
  /** Open the source conversation's detail (Conversations tab) from a flagged row. */
  onOpenConversation?: (channelArn: string) => void;
  /** Register a "close the review detail first" handler so global/browser Back steps out of the detail
   *  before walking tab history (same pattern as ConversationsTab). */
  registerBack?: (close: (() => void) | null) => void;
}

function severityBadge(classification: string): React.ReactNode {
  const colors: Record<string, string> = {
    poor: '#ef4444',
    error_response: '#dc2626',
    appropriate_refusal: '#6366f1',
    acceptable: '#f59e0b',
  };
  const color = colors[classification] || '#6b7280';
  return (
    <span
      style={{
        backgroundColor: `${color}20`,
        color,
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
      }}
    >
      {classification}
    </span>
  );
}

function statusBadge(status: string): React.ReactNode {
  const colors: Record<string, string> = {
    pending: '#f59e0b',
    reviewed: '#3b82f6',
    approved: '#10b981',
    rejected: '#ef4444',
  };
  const color = colors[status] || '#6b7280';
  return (
    <span
      style={{
        backgroundColor: `${color}20`,
        color,
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

const FlaggedResponsesTab: React.FC<FlaggedResponsesTabProps> = ({ data, isLoading, onReview, onOpenConversation, registerBack }) => {
  // Keyed by exchange_id (stable across filter changes), not a row index — the row
  // index broke when the filter re-sliced the list, which left the review panel
  // permanently unreachable (nothing could open it).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'reviewed'>('pending');

  // Let global/browser Back close the open review detail first (before walking tab history).
  useEffect(() => {
    registerBack?.(expandedId ? () => setExpandedId(null) : null);
    return () => registerBack?.(null);
  }, [expandedId, registerBack]);

  if (isLoading) {
    return <div className="admin-tab-loading">Loading flagged responses...</div>;
  }

  const filteredData = (data?.data ?? []).filter((row) => {
    if (filter === 'all') return true;
    return row.review_status === filter;
  });
  const expanded = filteredData.find((r) => String(r.exchange_id) === expandedId) ?? null;

  // Detail view: a review opens as its own PAGE within the tab (not an inline panel below the list), so
  // it's fully visible on mobile and Back steps out of it. Render it INSTEAD of the table.
  if (expanded) {
    return (
      <div className="admin-tab">
        <div className="admin-tab-header">
          <nav className="admin-breadcrumb" aria-label="Review path">
            <button className="admin-link-btn" onClick={() => setExpandedId(null)}>← Flagged responses</button>
            <span> / </span>
            <span>Review {String(expanded.intent || 'exchange')}</span>
          </nav>
        </div>
        <div className="admin-review-panel">
          <div className="admin-conversation-header">
            <h4>Review Exchange</h4>
            {expanded.channel_arn && onOpenConversation && (
              <button className="admin-inline-btn" onClick={() => onOpenConversation(String(expanded.channel_arn))}>
                Open conversation ↗
              </button>
            )}
          </div>
          <div className="admin-review-messages">
            <div className="admin-review-message user">
              <strong>User:</strong>
              <p>{String(expanded.user_message)}</p>
            </div>
            <div className="admin-review-message agent">
              <strong>Assistant:</strong>
              <p>{String(expanded.agent_response)}</p>
            </div>
          </div>
          <div className="admin-review-reasoning">
            <strong>Evaluation Reasoning:</strong>
            <p>{String(expanded.reasoning)}</p>
          </div>
          {expanded.compliance_categories && (
            <div className="admin-review-compliance">
              <strong>Compliance Categories:</strong>
              <p>{String(expanded.compliance_categories)}</p>
            </div>
          )}
          {onReview && expanded.review_status === 'pending' && (
            <div className="admin-review-actions">
              <textarea
                placeholder="Review notes (optional)"
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
              />
              <div className="admin-review-buttons">
                <button
                  className="admin-btn admin-btn-approve"
                  onClick={() => { onReview(String(expanded.exchange_id), 'approved', reviewNotes); setExpandedId(null); setReviewNotes(''); }}
                >
                  Approve
                </button>
                <button
                  className="admin-btn admin-btn-reject"
                  onClick={() => { onReview(String(expanded.exchange_id), 'rejected', reviewNotes); setExpandedId(null); setReviewNotes(''); }}
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>Flagged Responses</h3>
        <div className="admin-filter-group">
          {(['pending', 'reviewed', 'all'] as const).map((f) => (
            <button
              key={f}
              className={`admin-filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              {f === 'pending' && data?.data && (
                <span className="admin-badge">
                  {data.data.filter((r) => r.review_status === 'pending').length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <DataTable
        columns={[
          { key: 'flagged_at', label: 'Date', render: (v) => new Date(String(v)).toLocaleDateString() },
          { key: 'agent_type', label: 'Assistant' },
          { key: 'intent', label: 'Intent' },
          {
            key: 'relevance_score',
            label: 'Score',
            render: (v) => (
              <span style={{ color: Number(v) < 30 ? '#ef4444' : '#f59e0b', fontWeight: 600 }}>
                {Number(v).toFixed(0)}
              </span>
            ),
          },
          { key: 'classification', label: 'Classification', render: (v) => severityBadge(String(v)) },
          {
            key: 'flags',
            label: 'Flags',
            render: (v) => {
              const flags = Array.isArray(v) ? v : String(v).split(',');
              return flags.map((f: string, i: number) => (
                <span key={i} className="admin-flag-chip">{f}</span>
              ));
            },
          },
          { key: 'review_status', label: 'Status', render: (v) => statusBadge(String(v)) },
          {
            key: 'review',
            label: '',
            sortable: false,
            render: (_v, row) => {
              const id = String(row.exchange_id);
              return (
                <button
                  className="admin-inline-btn"
                  onClick={() => setExpandedId(expandedId === id ? null : id)}
                >
                  {expandedId === id ? 'Hide' : 'Review'}
                </button>
              );
            },
          },
        ]}
        data={filteredData}
        emptyMessage={filter === 'pending' ? 'No pending reviews' : 'No flagged responses for this period'}
      />
    </div>
  );
};

export default FlaggedResponsesTab;
