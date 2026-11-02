/**
 * ONE INTENT, BY STEP AND BY MODEL (ADR-064 decision 4; SPEC-ADMIN-CONSOLE-EFFECTIVENESS FR39 to FR41).
 *
 * Below an intent's L1 cards: each step the intent's turns recorded (a model call by its model, a tool by its name, a
 * platform action and a correction by their label), with the turns it appeared in, its calls, time per call, p95 and the
 * cost summed from what each entry recorded; for an intent with a workflow, grouped under the task step each turn started
 * in. Then each model a step ran on, with its turns, calls, time per call and summed cost. `?step=` narrows both to one
 * task step, and a task step narrows to itself. Read from `intent_steps`, under the same filters as the row above, Aurora
 * only: Athena mode says so rather than showing nothing.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable, { type Column } from './DataTable';
import { queryAnalytics } from '../../services/analyticsService';
import { modelDisplayName, type AnalyticsDateRange } from '@ae/shared';
import type { PerformanceFilters } from './PerformanceFilters';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));
const fmtMs = (v: unknown): string => {
  const ms = num(v);
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
};
const fmtUsd = (v: unknown): string => {
  const n = num(v);
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : '—';
};
const modelName = (m: unknown): string => modelDisplayName(String(m)) || String(m);

/** The breakdown's query parameters: the intent, the step, and the same filters the L1 row was read under. */
export function stepBreakdownParams(intent: string, step: string | undefined, filters: PerformanceFilters): Record<string, string> {
  return {
    intent,
    ...(step ? { step } : {}),
    ...(filters.assistant ? { agentType: filters.assistant } : {}),
    ...(filters.classification ? { conversationClassification: filters.classification } : {}),
    ...(filters.role ? { assistantRole: filters.role } : {}),
    ...(filters.version ? { profileVersion: String(filters.version) } : {}),
  };
}

/**
 * The turn steps in reading order: grouped by the task step their turn started in, in the order the task steps arrive,
 * the steps of a turn bound to no task last. The first row of each task step carries that task step's summary (its
 * turns, their latency and cost). A task step whose turns recorded no steps is one row that says so (`noSteps`), so the
 * task step and its turns are still read.
 */
export function groupedTurnSteps(rows: Row[]): Row[] {
  const summaries = new Map<string, Row>();
  for (const r of rows) if (r.dimension === 'task_step' && r.task_step != null) summaries.set(String(r.task_step), r);
  const groups = new Map<string | null, Row[]>();
  for (const r of rows) {
    if (r.dimension !== 'step') continue;
    const key = r.task_step == null ? null : String(r.task_step);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const order: Array<string | null> = [...new Set([...summaries.keys(), ...[...groups.keys()].filter((k): k is string => k !== null)])];
  if (groups.has(null)) order.push(null);
  return order.flatMap((k) => {
    const summary = k !== null ? summaries.get(k) : undefined;
    const steps = groups.get(k) ?? [];
    if (k !== null && !steps.length) {
      return [{ dimension: 'step', task_step: k, noSteps: true, taskStepStart: true, taskStepSummary: summary }];
    }
    return steps.map((r, i) => ({ ...r, taskStepStart: k !== null && i === 0, taskStepSummary: summary }));
  });
}

const IntentStepBreakdown: React.FC<{
  intent: string;
  step?: string;
  dateRange: AnalyticsDateRange;
  filters: PerformanceFilters;
  /** Narrow to one step, or clear the narrowing with null. */
  onStep: (step: string | null) => void;
}> = ({ intent, step, dateRange, filters, onStep }) => {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ rows: Row[]; loading: boolean; unsupported: boolean }>({ rows: [], loading: true, unsupported: false });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve(queryAnalytics('intent_steps', dateRange, stepBreakdownParams(intent, step, filters)))
      .then((res) => { if (!cancelled) setState({ rows: (res?.data ?? []) as Row[], loading: false, unsupported: !!res?.unsupported }); })
      .catch(() => { if (!cancelled) setState({ rows: [], loading: false, unsupported: false }); });
    return () => { cancelled = true; };
  }, [intent, step, dateRange, filters]);

  const turnSteps = groupedTurnSteps(state.rows);
  const models = state.rows.filter((r) => r.dimension === 'model');
  const unpriced = turnSteps.reduce((n, r) => n + (num(r.unpriced_steps) || 0), 0);
  // An intent with a workflow is one whose turns started in a task step; the task-step column is shown only then.
  const workflow = state.rows.some((r) => (r.dimension === 'task_step' || r.dimension === 'step') && r.task_step != null);

  /** What the step is, in the reader's language where the platform names it, and as the tool's own name where not. */
  const stepName = (row: Row): React.ReactNode => {
    if (row.noSteps) {
      return <span className="admin-muted" data-testid={`intent-task-step-no-steps-${String(row.task_step)}`}>{t('admin.effectiveness.steps.noRecordedSteps')}</span>;
    }
    const kind = String(row.step_kind ?? 'model');
    const key = String(row.step_key ?? '');
    const labelKey = kind === 'platform' ? `admin.effectiveness.steps.action.${key}`
      : kind === 'correction' ? `admin.effectiveness.steps.correction.${key}` : null;
    const name = kind === 'model' ? modelName(key)
      : labelKey && i18n.exists(labelKey) ? t(labelKey) : <code>{key}</code>;
    const ranOn = kind !== 'model' && Array.isArray(row.models) && row.models.length
      ? <span className="admin-muted"> {t('admin.effectiveness.steps.ranOn', { models: row.models.map(modelName).join(', ') })}</span>
      : null;
    return (
      <span data-testid={`intent-turn-step-${String(row.group_key)}`}>
        <span className="admin-muted">{t(`admin.effectiveness.steps.kind.${kind}`)}</span> {name}{ranOn}
      </span>
    );
  };

  const columns: Column<Row>[] = [
    ...(workflow ? [{
      key: 'task_step', label: t('admin.effectiveness.steps.taskStep'), sortable: false,
      render: (v: unknown, row: Row) => (!row.taskStepStart ? null : (
        <>
          {step ? <code>{String(v)}</code>
            : <button type="button" className="btn-link" data-testid={`intent-step-open-${String(v)}`} title={t('admin.effectiveness.steps.open')} onClick={() => onStep(String(v))}><code>{String(v)}</code></button>}
          {row.taskStepSummary != null && (
            <span className="admin-muted" data-testid={`intent-task-step-summary-${String(v)}`}>
              {' '}{t('admin.effectiveness.steps.taskStepSummary', {
                count: Number((row.taskStepSummary as Row).turns),
                latency: fmtMs((row.taskStepSummary as Row).avg_ms),
                cost: fmtUsd((row.taskStepSummary as Row).cost_usd),
              })}
            </span>
          )}
        </>
      )),
    } as Column<Row>] : []),
    { key: 'step_key', label: t('admin.effectiveness.steps.step'), sortable: !workflow, render: (_v, row) => stepName(row) },
    { key: 'turns', label: t('admin.effectiveness.steps.turns'), sortable: !workflow },
    { key: 'calls', label: t('admin.effectiveness.steps.calls'), sortable: !workflow },
    { key: 'avg_ms', label: t('admin.effectiveness.steps.perCall'), sortable: !workflow, render: (v) => fmtMs(v) },
    { key: 'p95_ms', label: t('admin.effectiveness.steps.p95'), sortable: !workflow, render: (v) => fmtMs(v) },
    { key: 'cost_usd', label: t('admin.effectiveness.steps.cost'), sortable: !workflow, render: (v) => fmtUsd(v) },
  ];

  return (
    <div className="admin-section" data-testid="intent-step-breakdown">
      <h4>{t('admin.effectiveness.steps.title')}</h4>
      <p className="admin-tab-description">{t(workflow ? 'admin.effectiveness.steps.helpWorkflow' : 'admin.effectiveness.steps.help')}</p>
      {step && (
        <p className="admin-field-hint" role="status" data-testid="intent-step-filter">
          {t('admin.effectiveness.steps.filtered', { step })}{' '}
          <button type="button" className="btn-link" data-testid="intent-step-filter-clear" onClick={() => onStep(null)}>{t('admin.effectiveness.steps.clear')}</button>
        </p>
      )}
      {state.unsupported ? <p className="admin-info-banner">{t('admin.effectiveness.steps.unsupported')}</p>
        : state.loading ? <p className="admin-help-text">{t('admin.effectiveness.steps.loading')}</p>
          : state.rows.length === 0 ? <p className="admin-tab-empty">{t('admin.effectiveness.steps.none')}</p>
            : (
              <>
                <div data-testid="intent-steps-table">
                  <DataTable data={turnSteps} pageSize={0} emptyMessage={t('admin.effectiveness.steps.noneRecorded')} columns={columns} />
                </div>
                {unpriced > 0 && <p className="admin-field-hint" data-testid="intent-steps-unpriced">{t('admin.effectiveness.steps.unpriced', { count: unpriced })}</p>}
                <h4>{t('admin.effectiveness.models.title')}</h4>
                <p className="admin-tab-description">{t('admin.effectiveness.models.help')}</p>
                <div data-testid="intent-models-table">
                  <DataTable data={models} pageSize={0} columns={[
                    { key: 'group_key', label: t('admin.effectiveness.models.model'), render: (v) => modelName(v) },
                    { key: 'model_kind', label: t('admin.effectiveness.models.kind'), render: (v) => t(v === 'image' ? 'admin.effectiveness.models.kindImage' : 'admin.effectiveness.models.kindText') },
                    { key: 'turns', label: t('admin.effectiveness.models.turns') },
                    { key: 'calls', label: t('admin.effectiveness.models.calls') },
                    { key: 'avg_ms', label: t('admin.effectiveness.models.perCall'), render: (v) => fmtMs(v) },
                    { key: 'cost_usd', label: t('admin.effectiveness.models.cost'), render: (v) => fmtUsd(v) },
                    { key: 'steps', label: t('admin.effectiveness.models.steps'), render: (v) => (Array.isArray(v) && v.length ? v.join(', ') : '—') },
                  ]} />
                </div>
              </>
            )}
    </div>
  );
};

export default IntentStepBreakdown;
