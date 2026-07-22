import React from 'react';
import DataTable from './DataTable';
import { getFeedbackSummary, modelDisplayName, type FeedbackSummaryRow } from '@ae/shared';
import type { AnalyticsResult } from '@ae/shared';

interface ModelsTabProps {
  data: AnalyticsResult | null;
  effectivenessData: AnalyticsResult | null;
  isLoading: boolean;
}

const ModelsTab: React.FC<ModelsTabProps> = ({ data, effectivenessData, isLoading }) => {
  const [feedbackSummary, setFeedbackSummary] = React.useState<FeedbackSummaryRow[]>([]);

  React.useEffect(() => {
    let mounted = true;
    getFeedbackSummary(30)
      .then((rows) => {
        if (mounted) setFeedbackSummary(rows);
      })
      .catch(() => {
        if (mounted) setFeedbackSummary([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (isLoading) {
    return <div className="admin-tab-loading">Loading model data...</div>;
  }

  return (
    <div className="admin-tab">
      <div className="admin-section">
        <h3>Model Usage</h3>
        <DataTable
          columns={[
            { key: 'model_name', label: 'Model', render: (v) => modelDisplayName(v as string) || '—' },
            { key: 'message_count', label: 'Messages' },
            { key: 'avg_latency_ms', label: 'Avg Latency (ms)', render: (v) => `${Number(v).toFixed(0)}` },
            { key: 'total_tokens', label: 'Total Tokens', render: (v) => Number(v).toLocaleString() },
          ]}
          data={data?.data ?? []}
          emptyMessage="No model usage data available for this period"
        />
      </div>

      <div className="admin-section">
        <h3>Intent x Model Effectiveness</h3>
        <DataTable
          columns={[
            { key: 'model_name', label: 'Model', render: (v) => modelDisplayName(v as string) || '—' },
            { key: 'intent', label: 'Intent' },
            { key: 'exchange_count', label: 'Exchanges' },
            { key: 'avg_score', label: 'Avg Score', render: (v) => Number(v).toFixed(1) },
            { key: 'avg_total_ms', label: 'Avg Total (ms)', render: (v) => Number(v).toFixed(0) },
            { key: 'p95_total_ms', label: 'P95 (ms)', render: (v) => Number(v).toFixed(0) },
            { key: 'compliance_rate', label: 'Compliance %', render: (v) => `${Number(v).toFixed(1)}%` },
          ]}
          data={effectivenessData?.data ?? []}
          emptyMessage="Deploy with analyticsMode=aurora to compare model effectiveness by intent."
        />
      </div>

      <div className="admin-section">
        <h3>User Feedback</h3>
        <DataTable
          columns={[
            { key: 'model_name', label: 'Model', render: (v) => modelDisplayName(v as string) || '—' },
            { key: 'intent', label: 'Intent' },
            { key: 'thumbs_up', label: 'Helpful' },
            { key: 'thumbs_down', label: 'Needs work' },
            { key: 'feedback_count', label: 'Feedback Count' },
            { key: 'approval_rate', label: 'Approval %', render: (v) => `${Number(v).toFixed(1)}%` },
          ]}
          data={feedbackSummary}
          emptyMessage="No user feedback submitted yet."
        />
      </div>
    </div>
  );
};

export default ModelsTab;
