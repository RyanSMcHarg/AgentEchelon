import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * SAFETY AND REFUSALS (SPEC-EVALUATION Appendix C5).
 *
 * Three readings from `safety_readings`, each a count over the population it was taken from: requests
 * refused because the classification does not offer the capability, each guardrail finding, and each
 * compliance rule a verdict named. A refusal is the classification boundary working, so it is shown as a
 * count and is never colored as a failure.
 */
const SafetyReadingsPanel: React.FC<{
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
      .then(() => queryAnalytics('safety_readings', dateRange, extra))
      .then((res) => { if (!cancelled) setRows((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.safetyReadings.error')); });
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification, t]);

  const ofPopulation = (row: Row) => t('admin.safetyReadings.ofPopulation', {
    count: num(row.count) ?? 0,
    population: num(row.population) ?? 0,
  });

  const common = [
    { key: 'assistant', label: t('admin.safetyReadings.column.assistant') },
    { key: 'conversation_classification', label: t('admin.safetyReadings.column.classification') },
  ];

  const refusals = (rows ?? []).filter((r) => r.dimension === 'refusal');
  const guardrail = (rows ?? []).filter((r) => r.dimension === 'guardrail');
  const rules = (rows ?? []).filter((r) => r.dimension === 'rule');

  return (
    <div className="admin-section" role="region" aria-label={t('admin.safetyReadings.title')}>
      <h4>
        {t('admin.safetyReadings.title')}{' '}
        <InfoTooltip label={t('admin.safetyReadings.title')} content={t('admin.safetyReadings.tip')} />
      </h4>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.safetyReadings.loading')}</p>}
      {!error && rows !== null && rows.length === 0 && <p className="admin-tab-empty">{t('admin.safetyReadings.empty')}</p>}
      {refusals.length > 0 && (
        <>
          <h5>{t('admin.safetyReadings.refusals')}</h5>
          <DataTable
            data={refusals}
            columns={[
              { key: 'key', label: t('admin.safetyReadings.column.intent'), render: (v: unknown) => <strong>{String(v)}</strong> },
              ...common,
              { key: 'count', label: t('admin.safetyReadings.column.refused'), sortable: true, render: (_v: unknown, row: Row) => ofPopulation(row) },
              {
                key: 'judged_appropriate',
                label: t('admin.safetyReadings.column.judgeAgreed'),
                render: (_v: unknown, row: Row) => (num(row.judged) ? t('admin.safetyReadings.judgeAgreed', {
                  count: num(row.judged_appropriate) ?? 0, judged: num(row.judged) ?? 0,
                }) : '—'),
              },
            ]}
          />
        </>
      )}
      {guardrail.length > 0 && (
        <>
          <h5>{t('admin.safetyReadings.guardrail')}</h5>
          <DataTable
            data={guardrail}
            columns={[
              { key: 'key', label: t('admin.safetyReadings.column.finding'), render: (v: unknown) => <code>{String(v)}</code> },
              ...common,
              { key: 'count', label: t('admin.safetyReadings.column.turns'), sortable: true, render: (_v: unknown, row: Row) => ofPopulation(row) },
            ]}
          />
        </>
      )}
      {rules.length > 0 && (
        <>
          <h5>{t('admin.safetyReadings.rules')}</h5>
          <DataTable
            data={rules}
            columns={[
              { key: 'key', label: t('admin.safetyReadings.column.rule'), render: (v: unknown) => <code>{String(v)}</code> },
              ...common,
              { key: 'count', label: t('admin.safetyReadings.column.assessed'), sortable: true, render: (_v: unknown, row: Row) => ofPopulation(row) },
            ]}
          />
        </>
      )}
    </div>
  );
};

export default SafetyReadingsPanel;
