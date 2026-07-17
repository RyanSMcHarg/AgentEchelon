import React, { useCallback, useEffect, useMemo, useState } from 'react';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import { queryAnalytics } from '../../services/analyticsService';
import {
  METRIC_TARGETS,
  evaluateTarget,
  STATUS_VAR,
  statusGlyph,
  type TargetStatus,
} from './metricTargets';
import type { AnalyticsDateRange, AnalyticsResult } from '../../types/analytics';

/**
 * Effectiveness section (SPEC-ADMIN-CONSOLE-EFFECTIVENESS). The intent is the spine: one dashboard
 * ranks intents worst-first on quality, then drills L0 → intent → exchanges/tasks → turn timeline →
 * steps. Single-turn and multi-turn are two delivery classes of one pipeline, measured together.
 *
 * Data: L0 (`intent_effectiveness`, all intents) is loaded by the parent and passed as `data`. The
 * drills are user-initiated, so this component fetches them on demand with the shared `dateRange`:
 * L1 reuses the L0 row (no fetch); L2 = `intent_exchanges` (DIRECT) or `task_details?intent` (task);
 * L3 = `task_timeline?taskId` (its rows carry the L4 steps inline). Colors/targets reuse the existing
 * metricTargets registry — no new scheme. Intent-anchored only (no tier/profile slicing), so it does
 * not touch the classification/profile migration.
 */

interface EffectivenessTabProps {
  data: AnalyticsResult | null; // L0 intent_effectiveness
  dateRange: AnalyticsDateRange;
  isLoading: boolean;
}

type Row = Record<string, unknown>;

type Drill =
  | { level: 0 }
  | { level: 1; intent: string }
  | { level: 2; intent: string; delivery: 'direct' | 'task' }
  | { level: 3; intent: string; taskId: string };

// ---- small formatting + status helpers (reuse the metricTargets registry) --------------------------
const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));
const RANK: Record<TargetStatus, number> = { bad: 0, warn: 1, good: 2 };

function statusOf(value: number, targetKey: string): TargetStatus | null {
  const t = METRIC_TARGETS[targetKey];
  if (!t || !Number.isFinite(value)) return null;
  return evaluateTarget(value, t);
}

/** A metric value rendered in its good/warn/bad color, with the registry's formatter + glyph. */
function StatusValue({ value, targetKey, fallback = '—' }: { value: unknown; targetKey: string; fallback?: string }) {
  const n = num(value);
  const t = METRIC_TARGETS[targetKey];
  if (!Number.isFinite(n) || !t) return <span style={{ color: 'var(--status-neutral)' }}>{fallback}</span>;
  const status = evaluateTarget(n, t);
  const text = t.format ? t.format(n) : `${n}${t.unit ?? ''}`;
  return (
    <span style={{ color: STATUS_VAR[status], fontWeight: 600 }} title={`Target ${t.direction === 'lower' ? '≤' : '≥'} ${t.format ? t.format(t.target) : t.target}`}>
      <span aria-hidden>{statusGlyph(status)} </span>{text}
    </span>
  );
}

const fmtMs = (v: unknown): string => {
  const ms = num(v);
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
};
const fmtUsd = (v: unknown): string => {
  const n = num(v);
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : '—';
};
const shortId = (v: unknown): string => (v == null ? '—' : String(v).slice(0, 8) + '…');
/** Format a value through its metricTargets formatter (MetricCard colors via rawValue+target). */
const fmtBy = (v: unknown, key: string): string => {
  const t = METRIC_TARGETS[key];
  const n = num(v);
  if (!Number.isFinite(n)) return '—';
  return t?.format ? t.format(n) : String(n);
};

/**
 * The execution axis is delivery-dependent (§5): a task intent is judged by completion rate, a DIRECT
 * intent by Pass A relevance. Pick the one that fits this intent's dominant delivery class.
 */
function executionAxis(row: Row): { value: number; targetKey: string; label: string; delivery: 'direct' | 'task' } {
  const taskCount = num(row.task_count) || 0;
  const directCount = num(row.direct_count) || 0;
  if (taskCount > 0 && taskCount >= directCount) {
    return { value: num(row.task_completion_rate), targetKey: 'task_completion_rate', label: 'Completion', delivery: 'task' };
  }
  return { value: num(row.direct_relevance), targetKey: 'relevance_score', label: 'Relevance', delivery: 'direct' };
}

/** Worst-first (D2): rank by the WORSE of the two quality axes, so the axis that surfaces an intent is
 *  the reason it reads red. Ties break on volume (more traffic first). */
function qualityRank(row: Row): number {
  const cls = statusOf(num(row.avg_confidence), 'intent_confidence');
  const exec = statusOf(executionAxis(row).value, executionAxis(row).targetKey);
  const ranks = [cls, exec].filter((s): s is TargetStatus => s != null).map((s) => RANK[s]);
  return ranks.length ? Math.min(...ranks) : 3; // unknown quality sorts after ranked rows
}

// ---- L0 dashboard ----------------------------------------------------------------------------------
const L0Dashboard: React.FC<{ rows: Row[]; onPick: (intent: string) => void }> = ({ rows, onPick }) => {
  const ranked = useMemo(
    () => [...rows].sort((a, b) => qualityRank(a) - qualityRank(b) || num(b.exchange_count) - num(a.exchange_count)),
    [rows],
  );

  return (
    <DataTable
      data={ranked}
      emptyMessage="No intent activity for this period"
      columns={[
        {
          key: 'intent',
          label: 'Intent',
          render: (v) => (
            <button className="admin-link-btn" onClick={() => onPick(String(v))} style={{ fontWeight: 600 }}>
              {String(v)}
            </button>
          ),
        },
        { key: 'exchange_count', label: 'Volume', sortable: true },
        {
          key: 'avg_confidence',
          label: 'Classification',
          sortable: true,
          render: (v, row) => (
            <span>
              <StatusValue value={v} targetKey="intent_confidence" />
              <span style={{ color: 'var(--status-neutral)', fontSize: 12 }}> · reroute <StatusValue value={row.reroute_rate} targetKey="intent_reroute_rate" /></span>
            </span>
          ),
        },
        {
          key: 'execution',
          label: 'Execution',
          render: (_v, row) => {
            const ax = executionAxis(row);
            return <span>{ax.label} <StatusValue value={ax.value} targetKey={ax.targetKey} /></span>;
          },
        },
        { key: 'avg_total_ms', label: 'Latency (avg)', sortable: true, render: (v) => <StatusValue value={v} targetKey="avg_total_ms" fallback="—" /> },
        { key: 'p95_total_ms', label: 'P95', sortable: true, render: (v) => fmtMs(v) },
        { key: 'cost_per_reply_usd', label: 'Cost/reply', sortable: true, render: (v) => <StatusValue value={v} targetKey="cost_per_reply" /> },
        {
          key: 'tool_error_rate',
          label: 'Tools',
          sortable: true,
          render: (v, row) => {
            const calls = num(row.tool_calls) || 0;
            if (!calls) return <span style={{ color: 'var(--status-neutral)' }}>—</span>;
            return <span><StatusValue value={v} targetKey="tool_error_rate" /> <span style={{ color: 'var(--status-neutral)', fontSize: 12 }}>({calls})</span></span>;
          },
        },
      ]}
    />
  );
};

// ---- L1 intent header (reuses the L0 row) ----------------------------------------------------------
const L1Intent: React.FC<{ row: Row; onDrill: (delivery: 'direct' | 'task') => void }> = ({ row, onDrill }) => {
  const ax = executionAxis(row);
  const hasTasks = (num(row.task_count) || 0) > 0;
  const hasDirect = (num(row.direct_count) || 0) > 0;
  return (
    <div>
      <div className="admin-metrics-row">
        <MetricCard title="Classification confidence" value={fmtBy(row.avg_confidence, 'intent_confidence')} rawValue={num(row.avg_confidence)} target={METRIC_TARGETS.intent_confidence} />
        <MetricCard title="Reroute rate" value={fmtBy(row.reroute_rate, 'intent_reroute_rate')} rawValue={num(row.reroute_rate)} target={METRIC_TARGETS.intent_reroute_rate} />
        <MetricCard title={ax.label} value={fmtBy(ax.value, ax.targetKey)} rawValue={ax.value} target={METRIC_TARGETS[ax.targetKey]} />
        <MetricCard title="Avg latency" value={fmtMs(row.avg_total_ms)} subtitle={`p95 ${fmtMs(row.p95_total_ms)}`} rawValue={num(row.avg_total_ms)} target={METRIC_TARGETS.avg_total_ms} />
        <MetricCard title="Cost / reply" value={fmtUsd(row.cost_per_reply_usd)} subtitle={row.dominant_model ? String(row.dominant_model) : undefined} rawValue={num(row.cost_per_reply_usd)} target={METRIC_TARGETS.cost_per_reply} />
        <MetricCard title="Tool error rate" value={fmtBy(row.tool_error_rate, 'tool_error_rate')} subtitle={`${num(row.tool_calls) || 0} calls`} rawValue={num(row.tool_error_rate)} target={METRIC_TARGETS.tool_error_rate} />
      </div>
      <div className="admin-filter-group" style={{ marginTop: 12 }}>
        {hasDirect && <button className="admin-filter-btn" onClick={() => onDrill('direct')}>Exchanges ({num(row.direct_count) || 0})</button>}
        {hasTasks && <button className="admin-filter-btn" onClick={() => onDrill('task')}>Tasks ({num(row.task_count) || 0})</button>}
      </div>
    </div>
  );
};

// ---- L3 turn timeline + inline L4 steps ------------------------------------------------------------
const L3Timeline: React.FC<{ rows: Row[] }> = ({ rows }) => {
  const [open, setOpen] = useState<number | null>(null);
  if (rows.length === 0) return <div className="admin-info-banner">No turns recorded for this task.</div>;
  return (
    <div className="admin-timeline">
      {rows.map((r, i) => {
        const tx = r.task_transition as { from?: string; to?: string } | null;
        const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : [];
        const isOpen = open === i;
        return (
          <div key={String(r.exchange_id ?? i)} className="admin-timeline-row" style={{ borderLeft: '2px solid var(--status-info)', paddingLeft: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{tx?.from && tx?.to ? `${tx.from} → ${tx.to}` : (r.task_state ? `state: ${String(r.task_state)}` : 'no transition')}</strong>
              <span style={{ color: 'var(--status-neutral)', fontSize: 12 }}>{r.created_at ? new Date(String(r.created_at)).toLocaleString() : ''}</span>
              {Number.isFinite(num(r.relevance_score)) && <StatusValue value={r.relevance_score} targetKey="relevance_score" />}
              <span style={{ fontSize: 12 }}>latency {fmtMs(r.total_ms ?? r.response_latency_ms)}</span>
              {Number.isFinite(num(r.input_tokens)) && <span style={{ fontSize: 12, color: 'var(--status-neutral)' }}>{num(r.input_tokens)}→{num(r.output_tokens)} tok</span>}
              {steps.length > 0 && (
                <button className="admin-link-btn" onClick={() => setOpen(isOpen ? null : i)}>
                  {isOpen ? '▾' : '▸'} {steps.length} step{steps.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
            {isOpen && steps.length > 0 && (
              <DataTable
                data={steps}
                emptyMessage="No steps"
                columns={[
                  { key: 'stepLabel', label: 'Step' },
                  { key: 'modelId', label: 'Model', render: (v) => (v ? String(v) : '—') },
                  { key: 'tokensIn', label: 'In' },
                  { key: 'tokensOut', label: 'Out' },
                  { key: 'estCostUsd', label: 'Cost', render: (v) => (v == null ? '—' : `$${Number(v).toFixed(6)}`) },
                  {
                    key: 'tools',
                    label: 'Tools',
                    render: (v) => {
                      const tools = Array.isArray(v) ? (v as Array<{ name: string; ok: boolean; errorClass?: string }>) : [];
                      if (tools.length === 0) return '—';
                      return (
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {tools.map((tl, k) => (
                            <span key={k} style={{ color: tl.ok ? 'var(--status-good)' : 'var(--status-bad)', fontSize: 12, fontWeight: 600 }}>
                              {tl.ok ? '✓' : '✗'} {tl.name}{tl.errorClass ? ` (${tl.errorClass})` : ''}
                            </span>
                          ))}
                        </span>
                      );
                    },
                  },
                ]}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---- the tab: L0 dashboard + drill state -----------------------------------------------------------
const EffectivenessTab: React.FC<EffectivenessTabProps> = ({ data, dateRange, isLoading }) => {
  const l0Rows = useMemo(() => (data?.data ?? []) as Row[], [data]);
  const [drill, setDrill] = useState<Drill>({ level: 0 });
  const [drillData, setDrillData] = useState<AnalyticsResult | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const intentRow = useCallback(
    (intent: string): Row | undefined => l0Rows.find((r) => String(r.intent) === intent),
    [l0Rows],
  );

  // Fetch the drill's data when it needs a query (L2/L3). L0/L1 are served from the loaded L0 rows.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (drill.level !== 2 && drill.level !== 3) { setDrillData(null); return; }
      setDrillLoading(true);
      try {
        let res: AnalyticsResult;
        if (drill.level === 2 && drill.delivery === 'direct') {
          res = await queryAnalytics('intent_exchanges', dateRange, { intent: drill.intent });
        } else if (drill.level === 2) {
          res = await queryAnalytics('task_details', dateRange, { intent: drill.intent });
        } else {
          res = await queryAnalytics('task_timeline', dateRange, { taskId: drill.taskId });
        }
        if (!cancelled) setDrillData(res);
      } catch {
        if (!cancelled) setDrillData(null);
      } finally {
        if (!cancelled) setDrillLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [drill, dateRange]);

  if (isLoading) return <div className="admin-tab-loading">Loading effectiveness…</div>;

  // Breadcrumb — every level links back to L0 (§9). `level !== 0` narrows to the members carrying
  // `intent`; `=== 2` / `=== 3` narrow to those carrying `delivery` / `taskId`.
  const crumbs: React.ReactNode[] = [
    <button key="l0" className="admin-link-btn" onClick={() => setDrill({ level: 0 })}>Intents</button>,
  ];
  if (drill.level !== 0) {
    const intent = drill.intent;
    crumbs.push(<span key="s1"> / </span>, <button key="l1" className="admin-link-btn" onClick={() => setDrill({ level: 1, intent })}>{intent}</button>);
  }
  if (drill.level === 2) {
    crumbs.push(<span key="s2"> / </span>, <span key="l2">{drill.delivery === 'task' ? 'Tasks' : 'Exchanges'}</span>);
  }
  if (drill.level === 3) {
    crumbs.push(<span key="s3"> / </span>, <span key="l3">Task {shortId(drill.taskId)}</span>);
  }

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>Effectiveness</h3>
        {drill.level > 0 && <nav className="admin-breadcrumb" aria-label="Drill path">{crumbs}</nav>}
      </div>

      {drill.level === 0 && (
        <L0Dashboard rows={l0Rows} onPick={(intent) => setDrill({ level: 1, intent })} />
      )}

      {drill.level === 1 && (() => {
        const row = intentRow(drill.intent);
        if (!row) return <div className="admin-info-banner">No data for “{drill.intent}”.</div>;
        return <L1Intent row={row} onDrill={(delivery) => setDrill({ level: 2, intent: drill.intent, delivery })} />;
      })()}

      {drill.level === 2 && (
        drillLoading ? <div className="admin-tab-loading">Loading…</div> :
        drill.delivery === 'task' ? (
          <DataTable
            data={(drillData?.data ?? []) as Row[]}
            emptyMessage="No tasks for this intent"
            columns={[
              { key: 'task_id', label: 'Task', render: (v) => <button className="admin-link-btn" onClick={() => setDrill({ level: 3, intent: drill.intent, taskId: String(v) })}>{shortId(v)}</button> },
              { key: 'status', label: 'Status' },
              { key: 'task_state', label: 'Machine state', render: (v) => (v ? String(v) : '—') },
              { key: 'exchange_count', label: 'Turns', sortable: true },
              { key: 'transition_count', label: 'Transitions', sortable: true },
              { key: 'last_at', label: 'Last', render: (v) => (v ? new Date(String(v)).toLocaleString() : '—') },
            ]}
          />
        ) : (
          <DataTable
            data={(drillData?.data ?? []) as Row[]}
            emptyMessage="No exchanges for this intent"
            columns={[
              { key: 'created_at', label: 'When', render: (v) => (v ? new Date(String(v)).toLocaleString() : '—') },
              { key: 'relevance_score', label: 'Relevance', sortable: true, render: (v) => <StatusValue value={v} targetKey="relevance_score" /> },
              { key: 'total_ms', label: 'Latency', sortable: true, render: (v) => fmtMs(v) },
              { key: 'input_tokens', label: 'In', sortable: true },
              { key: 'output_tokens', label: 'Out', sortable: true },
              { key: 'bedrock_model', label: 'Model', render: (v) => (v ? String(v) : '—') },
              { key: 'was_rerouted', label: 'Rerouted', render: (v) => (v ? 'yes' : '') },
            ]}
          />
        )
      )}

      {drill.level === 3 && (
        drillLoading ? <div className="admin-tab-loading">Loading…</div> :
        <L3Timeline rows={(drillData?.data ?? []) as Row[]} />
      )}
    </div>
  );
};

export default EffectivenessTab;
