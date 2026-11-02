import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v) || 0);

const FINDINGS = ['not_called', 'wrong_arguments', 'errored', 'empty', 'contradicted'] as const;

/**
 * WHAT EACH TOOL'S CALLS CAME TO, AND WHO FIXES IT (SPEC-EVALUATION Appendix C3).
 *
 * From `tool_outcomes`: per tool, how many verdicts it has, how many were used correctly, and each kind of
 * finding with who owns it. An errored or empty result is for the tool's owner; a wrong argument, a
 * contradiction or a tool left unused is for the assistant's team.
 */
const ToolOutcomesPanel: React.FC<{
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
      .then(() => queryAnalytics('tool_outcomes', dateRange, extra))
      .then((res) => { if (!cancelled) setRows((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.toolOutcomes.error')); });
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification, t]);

  const findings = (row: Row, owner: 'assistant' | 'tool') => {
    const kinds = FINDINGS.filter((k) => (owner === 'tool') === (k === 'errored' || k === 'empty'));
    const parts = kinds.filter((k) => num(row[k]) > 0).map((k) => t(`admin.toolOutcomes.outcome.${k}`, { count: num(row[k]) }));
    return parts.length ? parts.join(' · ') : '—';
  };

  return (
    <div className="admin-section" role="region" aria-label={t('admin.toolOutcomes.title')}>
      <h4>
        {t('admin.toolOutcomes.title')}{' '}
        <InfoTooltip label={t('admin.toolOutcomes.title')} content={t('admin.toolOutcomes.tip')} />
      </h4>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.toolOutcomes.loading')}</p>}
      {!error && rows !== null && rows.length === 0 && <p className="admin-tab-empty">{t('admin.toolOutcomes.empty')}</p>}
      {rows !== null && rows.length > 0 && (
        <DataTable
          data={rows}
          columns={[
            { key: 'tool_name', label: t('admin.toolOutcomes.column.tool'), render: (v: unknown) => <code>{String(v)}</code> },
            { key: 'assistant', label: t('admin.toolOutcomes.column.assistant') },
            { key: 'conversation_classification', label: t('admin.toolOutcomes.column.classification') },
            { key: 'verdicts', label: t('admin.toolOutcomes.column.verdicts'), sortable: true },
            {
              key: 'used_correctly',
              label: t('admin.toolOutcomes.column.usedCorrectly'),
              sortable: true,
              render: (_v: unknown, row: Row) => t('admin.toolOutcomes.ofVerdicts', { count: num(row.used_correctly), verdicts: num(row.verdicts) }),
            },
            { key: 'wrong_arguments', label: t('admin.toolOutcomes.column.assistantFindings'), render: (_v: unknown, row: Row) => findings(row, 'assistant') },
            {
              key: 'errored',
              label: t('admin.toolOutcomes.column.toolFindings'),
              render: (_v: unknown, row: Row) => {
                const text = findings(row, 'tool');
                return text === '—' ? text : t('admin.toolOutcomes.forOwner', { findings: text, owner: String(row.owner ?? 'platform') });
              },
            },
            { key: 'decided_by_judge', label: t('admin.toolOutcomes.column.judged'), render: (_v: unknown, row: Row) => t('admin.toolOutcomes.ofVerdicts', { count: num(row.decided_by_judge), verdicts: num(row.verdicts) }) },
          ]}
        />
      )}
    </div>
  );
};

export default ToolOutcomesPanel;
