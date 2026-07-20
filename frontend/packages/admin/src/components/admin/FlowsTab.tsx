import React, { useState } from 'react';
import DataTable from './DataTable';
import type { AnalyticsResult } from '@ae/shared';

interface FlowsTabProps {
  data: AnalyticsResult | null;
  isLoading: boolean;
  onSelectFlow?: (taskId: string) => void;
}

function compositeColor(score: number): string {
  if (score >= 75) return 'var(--status-good)';
  if (score >= 50) return 'var(--status-warn)';
  return 'var(--status-bad)';
}

// intent_flows stores the five sub-scores but no composite column, so compute
// it from them. Weights match the ones the flow-detail ScoreBars display
// (Outcome 30 / Information 25 / Efficiency 15 / Context 15 / UX 15 = 100).
// Without this the Composite column read a missing `composite_score` and rendered NaN.
function compositeScore(row: Record<string, unknown>): number {
  return Math.round(
    Number(row.outcome_score || 0) * 0.3 +
      Number(row.information_score || 0) * 0.25 +
      Number(row.efficiency_score || 0) * 0.15 +
      Number(row.context_retention_score || 0) * 0.15 +
      Number(row.ux_score || 0) * 0.15
  );
}

function statusBadge(status: string): React.ReactNode {
  const colors: Record<string, string> = {
    completed: 'var(--status-good)',
    in_progress: 'var(--status-info)',
    abandoned: 'var(--status-warn)',
    failed: 'var(--status-bad)',
  };
  const color = colors[status] || 'var(--status-neutral)';
  return (
    <span style={{ backgroundColor: `${color}20`, color, padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 600 }}>
      {status}
    </span>
  );
}

function ScoreBar({ label, score, weight }: { label: string; score: number; weight: string }) {
  return (
    <div className="admin-score-bar">
      <div className="admin-score-bar-label">
        <span>{label}</span>
        <span className="admin-score-bar-weight">{weight}</span>
      </div>
      <div className="admin-score-bar-track">
        <div
          className="admin-score-bar-fill"
          style={{ width: `${score}%`, backgroundColor: compositeColor(score) }}
        />
      </div>
      <span className="admin-score-bar-value" style={{ color: compositeColor(score) }}>
        {score.toFixed(0)}
      </span>
    </div>
  );
}

const FlowsTab: React.FC<FlowsTabProps> = ({ data, isLoading, onSelectFlow }) => {
  const [selectedFlow, setSelectedFlow] = useState<Record<string, unknown> | null>(null);

  if (isLoading) {
    return <div className="admin-tab-loading">Loading intent flows...</div>;
  }

  return (
    <div className="admin-tab">
      <h3>Intent Flows (Multi-Turn Evaluation)</h3>
      <p className="admin-tab-description">
        Flows group exchanges by task ID and evaluate them holistically across 5 weighted dimensions.
        This catches failures that per-exchange scoring misses.
      </p>

      <DataTable
        columns={[
          { key: 'task_id', label: 'Task ID', render: (v) => String(v).substring(0, 8) + '...' },
          { key: 'agent_type', label: 'Assistant' },
          { key: 'intent', label: 'Intent' },
          { key: 'exchange_count', label: 'Exchanges' },
          { key: 'status', label: 'Status', render: (v) => statusBadge(String(v)) },
          {
            key: 'composite_score',
            label: 'Composite',
            render: (_v, row) => {
              const score = compositeScore(row);
              return (
                <span style={{ color: compositeColor(score), fontWeight: 700, fontSize: '14px' }}>
                  {score.toFixed(0)}
                </span>
              );
            },
          },
          {
            key: 'duration_seconds',
            label: 'Duration',
            render: (v) => {
              const s = Number(v);
              if (!s) return '-';
              if (s < 60) return `${s.toFixed(0)}s`;
              return `${(s / 60).toFixed(1)}m`;
            },
          },
          {
            key: 'actions',
            label: '',
            sortable: false,
            render: (_v, row) => (
              <button
                className="admin-btn admin-btn-small"
                onClick={() => {
                  setSelectedFlow(row);
                  onSelectFlow?.(String(row.task_id));
                }}
              >
                Detail
              </button>
            ),
          },
        ]}
        data={data?.data ?? []}
        emptyMessage="No multi-turn flows recorded for this period"
      />

      {selectedFlow && (
        <div className="admin-flow-detail">
          <div className="admin-flow-detail-header">
            <h4>Flow Detail: {String(selectedFlow.task_id).substring(0, 12)}...</h4>
            <button className="admin-btn admin-btn-small" onClick={() => setSelectedFlow(null)}>
              Close
            </button>
          </div>

          <div className="admin-flow-scores">
            <ScoreBar label="Outcome" score={Number(selectedFlow.outcome_score)} weight="30%" />
            <ScoreBar label="Information Collection" score={Number(selectedFlow.information_score)} weight="25%" />
            <ScoreBar label="Efficiency" score={Number(selectedFlow.efficiency_score)} weight="15%" />
            <ScoreBar label="Context Retention" score={Number(selectedFlow.context_retention_score)} weight="15%" />
            <ScoreBar label="User Experience" score={Number(selectedFlow.ux_score)} weight="15%" />
          </div>

          {!!selectedFlow.outcome && selectedFlow.status !== 'completed' && (
            <div className="admin-flow-abandonment">
              <strong>Outcome:</strong> {String(selectedFlow.outcome)}
            </div>
          )}

          <div className="admin-flow-meta">
            <span>Assistant: {String(selectedFlow.agent_type)}</span>
            <span>Intent: {String(selectedFlow.intent)}</span>
            <span>Exchanges: {String(selectedFlow.exchange_count)}</span>
            <span>Started: {new Date(String(selectedFlow.first_exchange_at)).toLocaleString()}</span>
            {!!selectedFlow.last_exchange_at && (
              <span>Completed: {new Date(String(selectedFlow.last_exchange_at)).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default FlowsTab;
