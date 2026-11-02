import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v) || 0);

/**
 * HOW EACH DOCUMENT TEMPLATE'S DELIVERIES WENT (SPEC-DOCUMENT-TEMPLATES FR8).
 *
 * From `template_outcomes`: per template, how many deliveries passed its check first time, passed after
 * a correction, were posted inline because they could not be made to pass, or were filled by the
 * platform. A row that spans an edit to the template says how many versions it covers.
 */
const TemplateOutcomesPanel: React.FC<{
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
      .then(() => queryAnalytics('template_outcomes', dateRange, extra))
      .then((res) => { if (!cancelled) setRows((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.templateOutcomes.error')); });
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification, t]);

  const of = (key: string) => (_v: unknown, row: Row) =>
    t('admin.templateOutcomes.ofDeliveries', { count: num(row[key]), deliveries: num(row.deliveries) });

  return (
    <div className="admin-section" role="region" aria-label={t('admin.templateOutcomes.title')}>
      <h4>
        {t('admin.templateOutcomes.title')}{' '}
        <InfoTooltip label={t('admin.templateOutcomes.title')} content={t('admin.templateOutcomes.tip')} />
      </h4>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.templateOutcomes.loading')}</p>}
      {!error && rows !== null && rows.length === 0 && <p className="admin-tab-empty">{t('admin.templateOutcomes.empty')}</p>}
      {rows !== null && rows.length > 0 && (
        <DataTable
          data={rows}
          columns={[
            {
              key: 'template',
              label: t('admin.templateOutcomes.column.template'),
              render: (v: unknown, row: Row) => (
                <span>
                  <strong>{String(v ?? '—')}</strong>
                  {num(row.template_versions) > 1 && (
                    <span style={{ color: 'var(--status-warn)', fontSize: 'var(--text-sm)' }}>
                      {' '}{t('admin.templateOutcomes.versions', { count: num(row.template_versions) })}
                    </span>
                  )}
                </span>
              ),
            },
            { key: 'assistant', label: t('admin.templateOutcomes.column.assistant') },
            { key: 'conversation_classification', label: t('admin.templateOutcomes.column.classification') },
            { key: 'deliveries', label: t('admin.templateOutcomes.column.deliveries'), sortable: true },
            { key: 'passed', label: t('admin.templateOutcomes.column.passed'), render: of('passed') },
            { key: 'passed_after_correction', label: t('admin.templateOutcomes.column.corrected'), render: of('passed_after_correction') },
            { key: 'posted_inline', label: t('admin.templateOutcomes.column.inline'), render: of('posted_inline') },
            { key: 'filled_by_platform', label: t('admin.templateOutcomes.column.filled'), render: of('filled_by_platform') },
          ]}
        />
      )}
    </div>
  );
};

export default TemplateOutcomesPanel;
