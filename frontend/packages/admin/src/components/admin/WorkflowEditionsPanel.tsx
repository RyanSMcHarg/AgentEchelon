import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable, { type Column } from './DataTable';
import { InfoTooltip } from './AdminHelp';
import WorkflowEditorLink from './WorkflowEditorLink';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fmtMs = (v: unknown): string => {
  const ms = num(v);
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
};
const shortHash = (v: unknown): string => (typeof v === 'string' && v ? v.slice(0, 8) : '');

/**
 * Edition rows with their steps and what started their runs beside them: one row per workflow, assistant and edition,
 * carrying the steps of that edition in the order the query returns them (most runs first), and one entry per trigger (WT118).
 */
export function editionsWithSteps(rows: Row[]): Row[] {
  const steps = new Map<string, Row[]>();
  const triggers = new Map<string, Row[]>();
  const keyOf = (r: Row) => `${String(r.workflow_name)}\u0000${String(r.assistant ?? '')}\u0000${String(r.workflow_origin_hash ?? '')}`;
  for (const r of rows) {
    if (r.dimension === 'step') steps.set(keyOf(r), [...(steps.get(keyOf(r)) ?? []), r]);
    if (r.dimension === 'trigger') triggers.set(keyOf(r), [...(triggers.get(keyOf(r)) ?? []), r]);
  }
  return rows.filter((r) => r.dimension === 'edition').map((r) => ({ ...r, steps: steps.get(keyOf(r)) ?? [], triggers: triggers.get(keyOf(r)) ?? [] }));
}

/** The order the triggers are shown in, whatever order the query returns them. */
const TRIGGER_ORDER = ['person', 'assistant', 'event'];

/**
 * HOW EACH EDITION OF A WORKFLOW RAN, AND HOW OFTEN WORK WENT BACK (ADR-067 decision 6; SPEC-WORKFLOWS-AND-TASKS WT109,
 * WT105).
 *
 * Runs per workflow edition (`workflow_editions`): the runs each edition started, the runs that ended, the share that
 * ended in success, and each run-level step's messages and time, so one edition of a workflow is read beside the next.
 * Rework (`task_rework`): reopens per task, by intent and the machine edition the task started on. Both are read from
 * what the archive already holds, under the same assistant and classification filters as the tables above, Aurora only.
 */
const WorkflowEditionsPanel: React.FC<{
  dateRange: AnalyticsDateRange | undefined;
  assistant?: string | null;
  classification?: string | null;
}> = ({ dateRange, assistant, classification }) => {
  const { t } = useTranslation();
  const [editions, setEditions] = useState<{ rows: Row[] | null; unsupported: boolean; error: boolean }>({ rows: null, unsupported: false, error: false });
  const [rework, setRework] = useState<{ rows: Row[] | null; unsupported: boolean; error: boolean }>({ rows: null, unsupported: false, error: false });

  useEffect(() => {
    let cancelled = false;
    setEditions({ rows: null, unsupported: false, error: false });
    setRework({ rows: null, unsupported: false, error: false });
    const extra: Record<string, string> = {};
    if (assistant) extra.agentType = assistant;
    if (classification) extra.conversationClassification = classification;
    Promise.resolve()
      .then(() => queryAnalytics('workflow_editions', dateRange, extra))
      .then((res) => { if (!cancelled) setEditions({ rows: (res?.data ?? []) as Row[], unsupported: !!res?.unsupported, error: false }); })
      .catch(() => { if (!cancelled) setEditions({ rows: [], unsupported: false, error: true }); });
    Promise.resolve()
      .then(() => queryAnalytics('task_rework', dateRange, extra))
      .then((res) => { if (!cancelled) setRework({ rows: (res?.data ?? []) as Row[], unsupported: !!res?.unsupported, error: false }); })
      .catch(() => { if (!cancelled) setRework({ rows: [], unsupported: false, error: true }); });
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification]);

  const muted = <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const edition = (v: unknown) => (shortHash(v) ? <code title={String(v)}>{shortHash(v)}</code> : <span className="admin-muted">{t('admin.workflowEditions.noEdition')}</span>);

  const editionColumns: Column<Row>[] = [
    {
      // EACH WORKFLOW OPENS IN ITS ASSISTANT'S EDITOR: the row's assistant, or the one the view is narrowed to.
      key: 'workflow_name', label: t('admin.workflowEditions.column.workflow'),
      render: (v, row) => (
        <strong>
          <WorkflowEditorLink assistant={String(row.assistant ?? '') || assistant} workflow={v == null ? null : String(v)}
            testId={`workflow-edition-link-${String(v)}-${shortHash(row.workflow_origin_hash)}`}>{String(v ?? '—')}</WorkflowEditorLink>
        </strong>
      ),
    },
    { key: 'assistant', label: t('admin.workflowEditions.column.assistant'), render: (v) => (v ? String(v) : muted) },
    { key: 'workflow_origin_hash', label: t('admin.workflowEditions.column.edition'), render: (v) => edition(v) },
    { key: 'runs', label: t('admin.workflowEditions.column.runs'), sortable: true },
    { key: 'ended', label: t('admin.workflowEditions.column.ended'), sortable: true },
    {
      key: 'success_share', label: t('admin.workflowEditions.column.success'), sortable: true,
      render: (v) => (num(v) === null ? muted : `${Math.round(num(v)! * 100)}%`),
    },
    { key: 'avg_ms', label: t('admin.workflowEditions.column.avg'), render: (v) => fmtMs(v) },
    {
      // WHAT STARTED THE RUNS (WT118): each intent is one population whoever asked, and this is its breakdown, with the
      // same measures, so a request from another assistant is read beside a person's.
      key: 'triggers', label: t('admin.workflowEditions.column.startedBy'), sortable: false,
      render: (v, row) => (Array.isArray(v) && v.length ? (
        <ul className="admin-plain-list" data-testid={`workflow-edition-triggers-${String(row.workflow_name)}-${shortHash(row.workflow_origin_hash)}`}>
          {[...(v as Row[])].sort((a, b) => TRIGGER_ORDER.indexOf(String(a.workflow_trigger)) - TRIGGER_ORDER.indexOf(String(b.workflow_trigger))).map((s) => (
            <li key={String(s.workflow_trigger)}>
              <strong>{t(`admin.workflowEditions.trigger.${String(s.workflow_trigger)}`)}</strong>{' '}
              <span className="admin-muted">{t('admin.workflowEditions.triggerSummary', {
                count: num(s.runs) ?? 0,
                success: num(s.success_share) === null ? '—' : `${Math.round(num(s.success_share)! * 100)}%`,
                avg: fmtMs(s.avg_ms),
              })}</span>
            </li>
          ))}
        </ul>
      ) : muted),
    },
    {
      key: 'steps', label: t('admin.workflowEditions.column.steps'), sortable: false,
      render: (v, row) => (Array.isArray(v) && v.length ? (
        <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }} data-testid={`workflow-edition-steps-${String(row.workflow_name)}-${shortHash(row.workflow_origin_hash)}`}>
          {(v as Row[]).map((s) => (
            <li key={String(s.workflow_step)}>
              <code>{String(s.workflow_step)}</code>{' '}
              <span className="admin-muted">{t('admin.workflowEditions.stepSummary', { count: num(s.messages) ?? 0, runs: num(s.runs) ?? 0, avg: fmtMs(s.avg_ms), p95: fmtMs(s.p95_ms) })}</span>
            </li>
          ))}
        </ul>
      ) : muted),
    },
  ];

  const reworkColumns: Column<Row>[] = [
    {
      // A TASK'S MACHINE OPENS IN ITS ASSISTANT'S EDITOR, on that machine's steps.
      key: 'task_type', label: t('admin.workflowEditions.rework.intent'),
      render: (v, row) => (
        <strong>
          <WorkflowEditorLink assistant={String(row.assistant ?? '') || assistant} task={v == null ? null : String(v)}
            testId={`task-rework-link-${String(v)}`}>{String(v ?? '—')}</WorkflowEditorLink>
        </strong>
      ),
    },
    { key: 'assistant', label: t('admin.workflowEditions.rework.assistant'), render: (v) => (v ? String(v) : muted) },
    { key: 'task_origin_machine_hash', label: t('admin.workflowEditions.rework.machine'), render: (v) => edition(v) },
    { key: 'tasks', label: t('admin.workflowEditions.rework.tasks'), sortable: true },
    { key: 'tasks_reopened', label: t('admin.workflowEditions.rework.reopened'), sortable: true },
    { key: 'reopens', label: t('admin.workflowEditions.rework.reopens'), sortable: true },
    { key: 'reopens_per_task', label: t('admin.workflowEditions.rework.perTask'), sortable: true, render: (v) => (num(v) === null ? muted : num(v)!.toFixed(2)) },
  ];

  const body = (s: { rows: Row[] | null; unsupported: boolean; error: boolean }, data: Row[], columns: Column<Row>[], testId: string) => (
    s.unsupported ? <p className="admin-info-banner">{t('admin.workflowEditions.unsupported')}</p>
      : s.error ? <p className="admin-error" role="alert">{t('admin.workflowEditions.error')}</p>
        : s.rows === null ? <p className="admin-help-text">{t('admin.workflowEditions.loading')}</p>
          : data.length === 0 ? <p className="admin-tab-empty">{t('admin.workflowEditions.empty')}</p>
            : <div data-testid={testId}><DataTable data={data} columns={columns} /></div>
  );

  return (
    <div className="admin-section" role="region" aria-label={t('admin.workflowEditions.title')} data-testid="workflow-editions">
      <h3>
        {t('admin.workflowEditions.title')}{' '}
        <InfoTooltip label={t('admin.workflowEditions.title')} content={t('admin.workflowEditions.tip')} />
      </h3>
      <p className="admin-tab-description">{t('admin.workflowEditions.description')}</p>
      {body(editions, editionsWithSteps(editions.rows ?? []), editionColumns, 'workflow-editions-table')}
      <h3>
        {t('admin.workflowEditions.rework.title')}{' '}
        <InfoTooltip label={t('admin.workflowEditions.rework.title')} content={t('admin.workflowEditions.rework.tip')} />
      </h3>
      <p className="admin-tab-description">{t('admin.workflowEditions.rework.description')}</p>
      {body(rework, rework.rows ?? [], reworkColumns, 'task-rework-table')}
    </div>
  );
};

export default WorkflowEditionsPanel;
