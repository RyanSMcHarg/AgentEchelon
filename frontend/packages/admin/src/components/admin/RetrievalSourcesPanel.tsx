import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v) || 0);

/**
 * RETRIEVAL BY SOURCE (SPEC-EVALUATION Appendix C7).
 *
 * From `retrieval_sources`: for each context source, how often retrieval brought back a passage from it
 * and how often the answer rested on one. A source retrieved often and used rarely is for whoever
 * curates it, not for the assistant's team.
 */
const RetrievalSourcesPanel: React.FC<{
  dateRange: AnalyticsDateRange | undefined;
  assistant?: string | null;
  classification?: string | null;
}> = ({ dateRange, assistant, classification }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    const extra: Record<string, string> = {};
    if (assistant) extra.agentType = assistant;
    if (classification) extra.conversationClassification = classification;
    Promise.resolve()
      .then(() => queryAnalytics('retrieval_sources', dateRange, extra))
      .then((res) => { if (!cancelled) setRows((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.retrievalSources.error')); });
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification, t]);

  return (
    <div className="admin-section" role="region" aria-label={t('admin.retrievalSources.title')}>
      <h4>
        {t('admin.retrievalSources.title')}{' '}
        <InfoTooltip label={t('admin.retrievalSources.title')} content={t('admin.retrievalSources.tip')} />
      </h4>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.retrievalSources.loading')}</p>}
      {!error && rows !== null && rows.length === 0 && <p className="admin-tab-empty">{t('admin.retrievalSources.empty')}</p>}
      {rows !== null && rows.length > 0 && (
        <DataTable
          data={rows}
          columns={[
            {
              key: 'title',
              label: t('admin.retrievalSources.column.source'),
              render: (v: unknown, row: Row) => <span title={String(row.source_id ?? '')}>{String(v ?? row.source_id ?? '—')}</span>,
            },
            { key: 'assistant', label: t('admin.retrievalSources.column.assistant') },
            { key: 'conversation_classification', label: t('admin.retrievalSources.column.classification') },
            { key: 'retrieved', label: t('admin.retrievalSources.column.retrieved'), sortable: true },
            {
              key: 'used',
              label: t('admin.retrievalSources.column.used'),
              sortable: true,
              render: (_v: unknown, row: Row) => t('admin.retrievalSources.usedOf', {
                count: num(row.used),
                retrieved: num(row.retrieved),
                rate: num(row.retrieved) ? Math.round((num(row.used) * 100) / num(row.retrieved)) : 0,
              }),
            },
          ]}
        />
      )}
    </div>
  );
};

export default RetrievalSourcesPanel;
