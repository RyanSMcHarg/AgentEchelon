import React from 'react';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import { DocLink } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';
import { METRIC_TARGETS, formatTarget } from './metricTargets';
import type { AnalyticsResult } from '@ae/shared';

interface EvaluationsTabProps {
  data: AnalyticsResult | null;
  isLoading: boolean;
}

function scoreColor(score: number): string {
  if (score >= 75) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

const EvaluationsTab: React.FC<EvaluationsTabProps> = ({ data, isLoading }) => {
  if (isLoading) {
    return <div className="admin-tab-loading">Loading evaluation data...</div>;
  }

  const rows = data?.data ?? [];
  // Count-weighted average relevance across rows, for the target summary.
  const totalCount = rows.reduce((s, r) => s + Number(r.count || 0), 0);
  const avgRelevance = totalCount > 0
    ? rows.reduce((s, r) => s + Number(r.avg_relevance_score || 0) * Number(r.count || 0), 0) / totalCount
    : 0;

  return (
    <div className="admin-tab">
      <h3>Evaluation Scores</h3>
      <p className="admin-tab-description">
        Automated relevance scoring of individual exchanges (a user message plus the assistant's
        reply). Each turn is scored context-aware — with its preceding turns, and task context for
        task turns — so a correct contextual reply is not penalised as if it were isolated. Rows
        group by day, assistant, and intent; the count is the number of exchanges in that group.
        Target: {METRIC_TARGETS.relevance_score.label} {formatTarget(METRIC_TARGETS.relevance_score)} (good).{' '}
        <DocLink href={DOC_LINKS.evaluation}>How evaluation works</DocLink>
      </p>
      {totalCount > 0 && (
        <div className="admin-metrics-row">
          <MetricCard
            title="Avg relevance"
            value={avgRelevance.toFixed(1)}
            subtitle={`${totalCount.toLocaleString()} evaluations`}
            target={METRIC_TARGETS.relevance_score}
            rawValue={avgRelevance}
          />
        </div>
      )}
      <DataTable
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'agent_type', label: 'Assistant Type' },
          { key: 'intent_type', label: 'Intent' },
          {
            key: 'avg_relevance_score',
            label: 'Avg Score',
            render: (v) => {
              const score = Number(v);
              // v is null for a day-group whose exchanges aren't evaluated yet
              // (evaluation runs on a schedule). Show a dash, not NaN/0.0.
              if (!Number.isFinite(score)) {
                return <span style={{ opacity: 0.5 }}>&mdash;</span>;
              }
              return (
                <span style={{ color: scoreColor(score), fontWeight: 600 }}>
                  {score.toFixed(1)}
                </span>
              );
            },
          },
          { key: 'count', label: 'Count' },
        ]}
        data={data?.data ?? []}
        emptyMessage="No evaluation data available for this period"
      />
    </div>
  );
};

export default EvaluationsTab;
