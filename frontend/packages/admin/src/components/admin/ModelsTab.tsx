import React from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { modelDisplayName, type FeedbackSummaryRow } from '@ae/shared';
import type { AnalyticsResult } from '@ae/shared';
import { fetchFeedbackSummary } from '../../services/feedbackSummaryService';

interface ModelsTabProps {
  data: AnalyticsResult | null;
  effectivenessData: AnalyticsResult | null;
  isLoading: boolean;
}

const ModelsTab: React.FC<ModelsTabProps> = ({ data, effectivenessData, isLoading }) => {
  const { t } = useTranslation();
  const [feedbackSummary, setFeedbackSummary] = React.useState<FeedbackSummaryRow[]>([]);
  // A FAILED READ IS SAID, NOT SHOWN AS AN EMPTY TABLE. An empty table reads as "nobody has voted",
  // which is the one conclusion a refused or failed read must never support. A gateway refusal that
  // reaches the browser with its status arrives here worded as the capability the role lacks (sigv4Fetch
  // `refusalMessage`). On a split-origin deployment the gateway refusal carries no CORS headers, so it
  // arrives as a network error that cannot name the missing capability (DESIGN-SEPARATE-ADMIN-APP.md,
  // "`GET /feedback` refusals under the split"); it is still said, not shown empty.
  const [feedbackError, setFeedbackError] = React.useState<{ message: string | null } | null>(null);
  // Why this console is not shown the summary at all (a team console: it counts every assistant).
  const [feedbackNote, setFeedbackNote] = React.useState<string | null>(null);
  // An unsettled read is not an empty one either: until the read settles the table is not drawn, so
  // "No user feedback submitted yet" is shown only for a read that returned no rows.
  const [feedbackLoaded, setFeedbackLoaded] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    fetchFeedbackSummary(30)
      .then((result) => {
        if (!mounted) return;
        setFeedbackSummary(result.data);
        setFeedbackNote(result.unsupported ? result.reason ?? null : null);
        setFeedbackError(null);
        setFeedbackLoaded(true);
      })
      .catch((e: unknown) => {
        if (!mounted) return;
        setFeedbackSummary([]);
        setFeedbackError({ message: e instanceof Error && e.message ? e.message : null });
        setFeedbackLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (isLoading) {
    return <div className="admin-tab-loading">{t('admin.models.loadingModelData')}</div>;
  }

  return (
    <div className="admin-tab">
      <div className="admin-section">
        <h3>{t('admin.models.modelUsage')}</h3>
        <DataTable
          columns={[
            { key: 'model_name', label: 'Model', render: (v) => modelDisplayName(v as string) || '—' },
            { key: 'message_count', label: 'Messages' },
            { key: 'avg_latency_ms', label: t('admin.models.avgLatencyMs'), render: (v) => `${Number(v).toFixed(0)}` },
            { key: 'total_tokens', label: 'Total Tokens', render: (v) => Number(v).toLocaleString() },
          ]}
          data={data?.data ?? []}
          emptyMessage={t('admin.models.noModelUsageDataAvailable')}
        />
      </div>

      <div className="admin-section">
        <h3>{t('admin.models.intentXModelEffectiveness')}</h3>
        <DataTable
          columns={[
            { key: 'model_name', label: 'Model', render: (v) => modelDisplayName(v as string) || '—' },
            { key: 'intent', label: 'Intent' },
            { key: 'exchange_count', label: 'Exchanges' },
            { key: 'avg_score', label: 'Avg Score', render: (v) => Number(v).toFixed(1) },
            { key: 'avg_total_ms', label: t('admin.models.avgTotalMs'), render: (v) => Number(v).toFixed(0) },
            { key: 'p95_total_ms', label: 'P95 (ms)', render: (v) => Number(v).toFixed(0) },
            {
              key: 'compliance_rate',
              label: 'Compliance %',
              // NOT ASSESSED IS NOT 0%. The query divides by the assessed count, so this is NULL for
              // an intent/model group nothing has judged yet - and `Number(null).toFixed(1)` rendered
              // that as a confident "0.0%", the worst reading available: a model looks entirely
              // non-compliant precisely when there is no evidence about it at all. A dash, like every
              // other unmeasured cell in this console.
              render: (v) => (v == null || !Number.isFinite(Number(v))
                ? <span style={{ opacity: 0.5 }}>&mdash;</span>
                : `${Number(v).toFixed(1)}%`),
            },
          ]}
          data={effectivenessData?.data ?? []}
          emptyMessage={t('admin.models.deployWithAnalyticsmodeAuroraTo')}
        />
      </div>

      <div className="admin-section">
        <h3>{t('admin.models.userFeedback')}</h3>
        {feedbackError && (
          <p className="admin-error" role="alert">
            {feedbackError.message ?? t('admin.models.couldNotReadFeedback')}{' '}
            {t('admin.models.feedbackNotShownOnFailure')}
          </p>
        )}
        {!feedbackLoaded && <p className="admin-muted">{t('admin.models.loadingFeedback')}</p>}
        {feedbackLoaded && !feedbackError && feedbackNote && <p className="admin-muted">{feedbackNote}</p>}
        {feedbackLoaded && !feedbackError && !feedbackNote && (
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
            emptyMessage={t('admin.models.noUserFeedbackSubmittedYet')}
          />
        )}
      </div>
    </div>
  );
};

export default ModelsTab;
