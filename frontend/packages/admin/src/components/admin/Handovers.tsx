/**
 * HANDOVERS: one assistant passing a person's message to another, counted as itself.
 *
 * Sent is each handover message the archive holds; answered is a sent handover whose receiver started a
 * `handover` turn soon after; the gap is the handovers refused or never delivered, which is the number to
 * watch. Read from `analytics.handovers` (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4). A handover is a
 * message and its own Turn kind; this panel adds whether the receiving assistant answered it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange, AnalyticsResult } from '@ae/shared';

interface Props {
  dateRange: AnalyticsDateRange;
}

interface HandoverRow extends Record<string, unknown> {
  date: string;
  receiver: string;
  kind: string;
  sent_count: number | string;
  answered_count: number | string;
  unanswered_count: number | string;
  avg_handover_to_answer_ms: number | string | null;
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

const fmtMs = (v: unknown): string => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n) || n <= 0) return '-';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
};

export function Handovers({ dateRange }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<HandoverRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (range: AnalyticsDateRange) => {
    setLoading(true);
    setError(null);
    try {
      const res: AnalyticsResult = await queryAnalytics('handovers', range);
      setRows((res.data ?? []) as unknown as HandoverRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.handovers.failed'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(dateRange); }, [dateRange, load]);

  return (
    <section className="admin-section" aria-label={t('admin.handovers.title')}>
      <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
        <span className="admin-tab-banner-label-text">{t('admin.handovers.title')}</span>
        <InfoTooltip label={t('admin.handovers.aboutLabel')} content={t('admin.handovers.about')} />
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {!error && !loading && rows.length === 0 && (
        <p className="admin-help-text">{t('admin.handovers.empty')}</p>
      )}

      {rows.length > 0 && (
        <DataTable<HandoverRow>
          columns={[
            { key: 'date', label: t('admin.handovers.columns.date') },
            { key: 'receiver', label: t('admin.handovers.columns.receiver') },
            {
              key: 'kind',
              label: t('admin.handovers.columns.kind'),
              render: (v) => <span title={t(`admin.handovers.kinds.${String(v)}`)}>{String(v)}</span>,
            },
            { key: 'sent_count', label: t('admin.handovers.columns.sent') },
            { key: 'answered_count', label: t('admin.handovers.columns.answered') },
            {
              key: 'unanswered_count',
              label: t('admin.handovers.columns.unanswered'),
              render: (v) => {
                const n = num(v);
                return (
                  <span className={n > 0 ? 'status-bad' : undefined} title={t('admin.handovers.unansweredHelp')}>
                    {n}
                  </span>
                );
              },
            },
            {
              key: 'avg_handover_to_answer_ms',
              label: t('admin.handovers.columns.toAnswer'),
              render: (v) => <span title={t('admin.handovers.toAnswerHelp')}>{fmtMs(v)}</span>,
            },
          ]}
          data={rows}
        />
      )}
    </section>
  );
}

export default Handovers;
