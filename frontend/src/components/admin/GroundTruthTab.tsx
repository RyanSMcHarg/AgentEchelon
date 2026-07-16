import React, { useState } from 'react';
import DataTable from './DataTable';
import { DocLink } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';
import type { AnalyticsResult } from '../../types/analytics';

interface GroundTruthTabProps {
  data: AnalyticsResult | null;
  isLoading: boolean;
  onSubmitScore?: (exchangeId: string, score: number, classification: string, reasoning: string) => void;
  /** Open a conversation's detail (Conversations tab) from a scored exchange. */
  onOpenConversation?: (channelArn: string) => void;
}

function deltaColor(delta: number): string {
  const abs = Math.abs(delta);
  if (abs <= 5) return 'var(--status-good)';   // close agreement
  if (abs <= 15) return 'var(--status-warn)';  // moderate disagreement
  return 'var(--status-bad)';                  // significant disagreement
}

const GroundTruthTab: React.FC<GroundTruthTabProps> = ({ data, isLoading, onSubmitScore, onOpenConversation }) => {
  const [showScoring, setShowScoring] = useState(false);
  const [scoreForm, setScoreForm] = useState({
    exchangeId: '',
    score: 50,
    classification: 'acceptable',
    reasoning: '',
  });

  if (isLoading) {
    return <div className="admin-tab-loading">Loading ground truth data...</div>;
  }

  const rows = data?.data ?? [];

  // Calculate calibration metrics
  const scored = rows.filter((r) => r.human_score != null && r.automated_score != null);
  const avgDelta = scored.length > 0
    ? scored.reduce((sum, r) => sum + Math.abs(Number(r.score_delta)), 0) / scored.length
    : 0;
  const agreementRate = scored.length > 0
    ? scored.filter((r) => Math.abs(Number(r.score_delta)) <= 10).length / scored.length
    : 0;

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>Ground Truth Calibration</h3>
        {onSubmitScore && (
          <button
            className="admin-btn admin-btn-primary"
            onClick={() => setShowScoring(!showScoring)}
          >
            {showScoring ? 'Hide Scoring Form' : 'Score an Exchange'}
          </button>
        )}
      </div>

      <p className="admin-tab-description">
        Ground truth is a set of human-assigned scores used to calibrate the automated evaluator.
        Use "Score an Exchange" to submit a human score (0–100) with reasoning; the metrics below
        then show how closely the automated scores track human judgment — mean absolute error and
        the share of scores that agree within 10 points. Lower error and higher agreement mean the
        automated evaluator can be trusted more.{' '}
        <DocLink href={DOC_LINKS.evaluation}>How evaluation works</DocLink>
      </p>

      {scored.length > 0 && (
        <div className="admin-metrics-row">
          <div className="admin-metric-card">
            <div className="admin-metric-value">{scored.length}</div>
            <div className="admin-metric-label">Human Scores</div>
          </div>
          <div className="admin-metric-card">
            <div className="admin-metric-value" style={{ color: deltaColor(avgDelta) }}>
              {avgDelta.toFixed(1)}
            </div>
            <div className="admin-metric-label">Mean Absolute Error</div>
          </div>
          <div className="admin-metric-card">
            <div className="admin-metric-value" style={{ color: agreementRate >= 0.7 ? 'var(--status-good)' : 'var(--status-warn)' }}>
              {(agreementRate * 100).toFixed(0)}%
            </div>
            <div className="admin-metric-label">Agreement Rate (within 10pt)</div>
          </div>
        </div>
      )}

      {showScoring && onSubmitScore && (
        <div className="admin-scoring-form">
          <h4>Submit Human Score</h4>
          <div className="admin-form-grid">
            <label>
              Exchange ID:
              <input
                type="text"
                value={scoreForm.exchangeId}
                onChange={(e) => setScoreForm({ ...scoreForm, exchangeId: e.target.value })}
                placeholder="Exchange ID from evaluations tab"
              />
            </label>
            <label>
              Score (0-100):
              <input
                type="number"
                min={0}
                max={100}
                value={scoreForm.score}
                onChange={(e) => setScoreForm({ ...scoreForm, score: Number(e.target.value) })}
              />
            </label>
            <label>
              Classification:
              <select
                value={scoreForm.classification}
                onChange={(e) => setScoreForm({ ...scoreForm, classification: e.target.value })}
              >
                <option value="excellent">Excellent</option>
                <option value="good">Good</option>
                <option value="acceptable">Acceptable</option>
                <option value="poor">Poor</option>
                <option value="appropriate_refusal">Appropriate Refusal</option>
                <option value="error_response">Error Response</option>
              </select>
            </label>
            <label>
              Reasoning:
              <textarea
                value={scoreForm.reasoning}
                onChange={(e) => setScoreForm({ ...scoreForm, reasoning: e.target.value })}
                placeholder="Why did you assign this score?"
                rows={3}
              />
            </label>
          </div>
          <button
            className="admin-btn admin-btn-primary"
            onClick={() => {
              onSubmitScore(scoreForm.exchangeId, scoreForm.score, scoreForm.classification, scoreForm.reasoning);
              setScoreForm({ exchangeId: '', score: 50, classification: 'acceptable', reasoning: '' });
              setShowScoring(false);
            }}
            disabled={!scoreForm.exchangeId || !scoreForm.reasoning}
          >
            Submit Score
          </button>
        </div>
      )}

      <DataTable
        columns={[
          { key: 'scored_at', label: 'Date', render: (v) => new Date(String(v)).toLocaleDateString() },
          { key: 'exchange_id', label: 'Exchange', render: (v) => String(v).substring(0, 8) + '...' },
          { key: 'classification', label: 'Classification' },
          {
            key: 'human_score',
            label: 'Human Score',
            render: (v) => <span style={{ fontWeight: 700 }}>{Number(v).toFixed(0)}</span>,
          },
          {
            key: 'automated_score',
            label: 'Automated',
            // Null when the exchange has no automated evaluation yet (LEFT JOIN) — show a dash,
            // not NaN.
            render: (v) =>
              v == null || Number.isNaN(Number(v))
                ? <span style={{ opacity: 0.5 }}>—</span>
                : <span style={{ fontWeight: 600 }}>{Number(v).toFixed(0)}</span>,
          },
          {
            key: 'score_delta',
            label: 'Delta',
            // Delta is null when there is no automated score to compare against (human - null).
            // Show a dash rather than NaN.
            render: (v) => {
              if (v == null || Number.isNaN(Number(v))) {
                return <span style={{ opacity: 0.5 }}>—</span>;
              }
              const delta = Number(v);
              return (
                <span style={{ color: deltaColor(delta), fontWeight: 600 }}>
                  {delta > 0 ? '+' : ''}{delta.toFixed(0)}
                </span>
              );
            },
          },
          { key: 'scorer_id', label: 'Scorer' },
          {
            key: 'channel_arn',
            label: 'Conversation',
            sortable: false,
            // Deep-link to the conversation this exchange belongs to. channel_arn is
            // returned by the ground_truth query; absent on older rows → no link.
            render: (v) =>
              v && onOpenConversation ? (
                <button className="admin-inline-btn" onClick={() => onOpenConversation(String(v))}>
                  Open
                </button>
              ) : (
                <span style={{ opacity: 0.5 }}>—</span>
              ),
          },
        ]}
        data={rows}
        emptyMessage="No ground truth scores submitted yet. Use the scoring form above to start calibrating."
      />
    </div>
  );
};

export default GroundTruthTab;
