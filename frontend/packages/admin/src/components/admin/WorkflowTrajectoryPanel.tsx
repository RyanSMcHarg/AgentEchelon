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
 * HOW EACH WORKFLOW'S TASKS GOT WHERE THEY ARE (SPEC-EVALUATION Appendix C2).
 *
 * Read from the path each task turn recorded against the machine it ran under (`workflow_trajectory`),
 * so every figure is a count of what the runtime did, not a judge's opinion. One row per assistant,
 * classification and task type, scoped by the same assistant and classification filters as the table
 * above it.
 */
const WorkflowTrajectoryPanel: React.FC<{
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
      .then(() => queryAnalytics('workflow_trajectory', dateRange, extra))
      .then((res) => { if (!cancelled) setRows((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.workflowTrajectory.error')); });
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification, t]);

  const muted = <span style={{ color: 'var(--text-muted)' }}>—</span>;

  const outcome = (row: Row) => {
    const parts = (['success', 'failure', 'handoff', 'open'] as const)
      .map((k) => ({ k, n: num(row[k]) ?? 0 }))
      .filter((x) => x.n > 0)
      .map((x) => t(`admin.workflowTrajectory.outcome.${x.k}`, { count: x.n }));
    return parts.length ? parts.join(' · ') : muted;
  };

  const columns = [
    { key: 'task_type', label: t('admin.workflowTrajectory.column.taskType'), render: (v: unknown) => <strong>{String(v ?? '—')}</strong> },
    { key: 'assistant', label: t('admin.workflowTrajectory.column.assistant') },
    { key: 'conversation_classification', label: t('admin.workflowTrajectory.column.classification') },
    { key: 'tasks', label: t('admin.workflowTrajectory.column.tasks'), sortable: true },
    { key: 'success', label: t('admin.workflowTrajectory.column.outcome'), render: (_v: unknown, row: Row) => outcome(row) },
    {
      key: 'path_ratio',
      label: t('admin.workflowTrajectory.column.path'),
      sortable: true,
      render: (v: unknown) => (num(v) === null ? muted : `${num(v)!.toFixed(2)}×`),
    },
    { key: 'tasks_regressed', label: t('admin.workflowTrajectory.column.wentBack'), sortable: true },
    { key: 'stalled', label: t('admin.workflowTrajectory.column.stalled'), sortable: true },
    { key: 'refused_moves', label: t('admin.workflowTrajectory.column.refused'), sortable: true },
    { key: 'platform_moves', label: t('admin.workflowTrajectory.column.platformMoves'), sortable: true },
  ];

  return (
    <div className="admin-section" role="region" aria-label={t('admin.workflowTrajectory.title')}>
      <h4>
        {t('admin.workflowTrajectory.title')}{' '}
        <InfoTooltip label={t('admin.workflowTrajectory.title')} content={t('admin.workflowTrajectory.tip')} />
      </h4>
      <p className="admin-tab-description">{t('admin.workflowTrajectory.description')}</p>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.workflowTrajectory.loading')}</p>}
      {!error && rows !== null && rows.length === 0 && <p className="admin-tab-empty">{t('admin.workflowTrajectory.empty')}</p>}
      {rows !== null && rows.length > 0 && <DataTable data={rows} columns={columns} />}
    </div>
  );
};

export default WorkflowTrajectoryPanel;
