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
import { InfoTooltip, DocLink } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';
import { modelDisplayName, type AnalyticsDateRange, type AnalyticsResult } from '@ae/shared';

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
  /** Open a conversation's detail (messages + raw event log) from a drilled exchange/task/turn. Deep-
   *  links into the Conversations tab (AdminDashboard.openConversation). Lets an admin jump from an
   *  analytics row to the actual conversation to see what the exchange really looked like. */
  onOpenConversation?: (channelArn: string) => void;
  /** Register a "close one drill level first" handler so the console's global Back steps L3→L2→L1→L0
   *  through the drill before it walks the tab history (mirrors ConversationsTab). null at L0. */
  registerBack?: (close: (() => void) | null) => void;
  /** The drill position, LIFTED to the parent so it survives this tab unmounting on a tab switch — e.g.
   *  "View conversation" navigates to the Conversations tab and Back returns you to the SAME drill level
   *  instead of resetting to L0. Optional: falls back to internal state when the parent doesn't own it. */
  drill?: Drill;
  onDrillChange?: React.Dispatch<React.SetStateAction<Drill>>;
  /** When set, the whole view is scoped to ONE assistant's classification (basic/standard/premium) —
   *  arrived at via the Assistants tab's "view this assistant's effectiveness" link. Shows a filter banner
   *  and scopes the drill queries. Null ⇒ all classifications. */
  classification?: string | null;
  onClearClassification?: () => void;
}

type Row = Record<string, unknown>;

export type Drill =
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

/** A "view raw conversation log" link for a drilled row carrying a channel_arn. Clicking it deep-links
 *  into the Conversations tab detail (messages + raw event log) so an admin can see the actual exchange.
 *  stopPropagation keeps a row-level click (the drill) from also firing. */
function ConvLink({ channelArn, onOpen }: { channelArn: unknown; onOpen?: (arn: string) => void }) {
  const arn = channelArn ? String(channelArn) : '';
  if (!arn || !onOpen) return <span style={{ color: 'var(--status-neutral)' }}>—</span>;
  return (
    <button
      className="admin-link-btn"
      title="Open the raw conversation log for this exchange"
      onClick={(e) => { e.stopPropagation(); onOpen(arn); }}
    >
      View conversation
    </button>
  );
}
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

  // Column header with an inline "what is this / how to use it" tooltip.
  const hdr = (label: string, tip: string) => (
    <span>{label} <InfoTooltip content={tip} label={`About ${label}`} /></span>
  );

  return (
    <DataTable
      data={ranked}
      emptyMessage="No intent activity for this period"
      onRowClick={(row) => onPick(String(row.intent))}
      columns={[
        {
          key: 'intent',
          label: hdr('Intent', 'A category of request (e.g. report_generation). Click it to drill into this intent’s exchanges or tasks, its turn timeline, and the tool-loop steps.'),
          render: (v) => (
            <button className="admin-link-btn" onClick={() => onPick(String(v))} style={{ fontWeight: 600 }}>
              {String(v)}
            </button>
          ),
        },
        { key: 'exchange_count', label: hdr('Volume', 'Number of exchanges (a user message + the assistant’s reply) classified to this intent in the selected window.'), sortable: true },
        {
          key: 'avg_confidence',
          label: hdr('Classification', 'Did routing send the right traffic here? Average classifier confidence (high/medium/low → 100/50/0), plus the share of exchanges re-routed away from this intent. A low score is a taxonomy or classifier problem — distinct from whether the work then succeeded.'),
          sortable: true,
          render: (v, row) => (
            <span>
              <StatusValue value={v} targetKey="intent_confidence" />
              <span style={{ color: 'var(--status-neutral)', fontSize: 12 }}> · rerouted away <StatusValue value={row.reroute_rate} targetKey="intent_reroute_rate" />
                <InfoTooltip label="About rerouted-away" content="Share of exchanges the classifier first assigned to THIS intent but then re-routed to a different one — i.e. this intent was over-triggered and corrected away. High = a taxonomy/classifier boundary problem here, distinct from whether the work then succeeded." />
              </span>
            </span>
          ),
        },
        {
          key: 'execution',
          label: hdr('Execution', 'Given correct routing, did the work succeed? For single-turn (DIRECT) intents this is the automated relevance score; for task intents it is the completion rate. The cell label (Relevance / Completion) tells you which applies.'),
          render: (_v, row) => {
            const ax = executionAxis(row);
            return <span>{ax.label} <StatusValue value={ax.value} targetKey={ax.targetKey} /></span>;
          },
        },
        { key: 'avg_total_ms', label: hdr('Latency (avg)', 'Mean end-to-end time to the completed reply. Agentic tool loops make several model calls, so multi-second totals are normal.'), sortable: true, render: (v) => <StatusValue value={v} targetKey="avg_total_ms" fallback="—" /> },
        { key: 'p95_total_ms', label: hdr('P95', '95th-percentile end-to-end latency (the tail). More sensitive than the average to cold starts and long tool loops.'), sortable: true, render: (v) => fmtMs(v) },
        { key: 'cost_per_reply_usd', label: hdr('Cost/reply', 'Estimated USD per reply: average tokens × the model’s published rate. An estimate, not your AWS bill — see the note above the table. Use it to compare intents, not as an exact charge.'), sortable: true, render: (v) => <StatusValue value={v} targetKey="cost_per_reply" /> },
        {
          key: 'tool_error_rate',
          label: hdr('Tools', 'Tool-error rate for this intent (share of tool calls that failed), with the total tool-call count in parentheses. “—” means the intent made no tool calls in the window.'),
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

// ---- L1 tool lens: per-tool usage folded in (the Steps aggregate, intent-scoped) ------------------
type ToolAgg = { name: string; calls: number; errors: number; errorRate: number };
/** Aggregate per-tool usage from execution_steps rows (steps[].tools[]), client-side. Pass an intent to
 *  scope to that intent (the L1 lens), or null to span every intent (the L0 system-wide view). */
function aggregateTools(stepRows: Row[], intent: string | null): ToolAgg[] {
  const map = new Map<string, { calls: number; errors: number }>();
  for (const r of stepRows) {
    if (intent !== null && String(r.intent) !== intent) continue;
    const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : [];
    for (const s of steps) {
      const tools = Array.isArray(s.tools) ? (s.tools as Array<{ name?: string; ok?: boolean }>) : [];
      for (const t of tools) {
        const name = String(t.name ?? 'unknown');
        const e = map.get(name) ?? { calls: 0, errors: 0 };
        e.calls += 1;
        if (t.ok === false) e.errors += 1;
        map.set(name, e);
      }
    }
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, calls: v.calls, errors: v.errors, errorRate: v.calls ? (v.errors / v.calls) * 100 : 0 }))
    .sort((a, b) => b.calls - a.calls);
}

const ToolLensPanel: React.FC<{ tools: ToolAgg[] | null; title?: string; tip?: string; emptyText?: string }> = ({
  tools,
  title = 'Tool lens',
  tip = "Which tools this intent's assistant actually invoked in the window, how often, and each tool's error rate (from the per-step tool outcomes). Tool use is the mechanism that produces the outcome, so a high per-tool error rate is a distinct, actionable failure mode. Aggregated across this intent's multi-step turns.",
  emptyText = 'No tool calls recorded for this intent in the window (the assistant answered without tools, or these turns predate per-tool telemetry).',
}) => (
  <div style={{ marginTop: 16 }}>
    <h4 style={{ margin: '0 0 6px' }}>
      {title}{' '}
      <InfoTooltip content={tip} label={`About ${title}`} />
    </h4>
    {tools === null ? (
      <p className="admin-tab-description">Loading tool usage…</p>
    ) : tools.length === 0 ? (
      <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.8 }}>{emptyText}</p>
    ) : (
      <DataTable
        data={tools as unknown as Row[]}
        emptyMessage="No tool calls"
        columns={[
          { key: 'name', label: 'Tool' },
          { key: 'calls', label: 'Calls', sortable: true },
          { key: 'errors', label: 'Errors', sortable: true },
          { key: 'errorRate', label: 'Error rate', sortable: true, render: (v) => <StatusValue value={v} targetKey="tool_error_rate" /> },
        ]}
      />
    )}
  </div>
);

// ---- L1 intent header (reuses the L0 row) ----------------------------------------------------------
const L1Intent: React.FC<{ row: Row; toolLens: ToolAgg[] | null; onDrill: (delivery: 'direct' | 'task') => void }> = ({ row, toolLens, onDrill }) => {
  const ax = executionAxis(row);
  const hasTasks = (num(row.task_count) || 0) > 0;
  const hasDirect = (num(row.direct_count) || 0) > 0;
  return (
    <div>
      {row.assistant != null && (
        <p className="admin-tab-description" style={{ fontSize: '0.9em', marginBottom: 8 }}>
          Served by assistant <strong>{String(row.assistant)}</strong>
          {row.profile_version != null && <> · profile <strong>v{String(row.profile_version)}</strong></>}
          {row.profile_config_id != null && <> <span className="admin-muted">(config {String(row.profile_config_id).slice(0, 12)})</span></>}
          {' '}— the portable profile version that produced this intent's traffic in the window.
        </p>
      )}
      <div className="admin-metrics-row">
        <MetricCard title="Classification confidence" value={fmtBy(row.avg_confidence, 'intent_confidence')} rawValue={num(row.avg_confidence)} target={METRIC_TARGETS.intent_confidence} />
        <MetricCard title="Rerouted away" value={fmtBy(row.reroute_rate, 'intent_reroute_rate')} rawValue={num(row.reroute_rate)} target={METRIC_TARGETS.intent_reroute_rate} tooltip="Share of exchanges the classifier first assigned to this intent but then re-routed to a different one (this intent was over-triggered and corrected away). High = a classifier/taxonomy boundary problem for this intent." />
        <MetricCard title={ax.label} value={fmtBy(ax.value, ax.targetKey)} rawValue={ax.value} target={METRIC_TARGETS[ax.targetKey]} />
        <MetricCard title="Avg latency" value={fmtMs(row.avg_total_ms)} subtitle={`p95 ${fmtMs(row.p95_total_ms)}`} rawValue={num(row.avg_total_ms)} target={METRIC_TARGETS.avg_total_ms} />
        <MetricCard title="Cost / reply" value={fmtUsd(row.cost_per_reply_usd)} subtitle={row.dominant_model ? modelDisplayName(String(row.dominant_model)) : undefined} rawValue={num(row.cost_per_reply_usd)} target={METRIC_TARGETS.cost_per_reply} />
        <MetricCard title="Tool error rate" value={fmtBy(row.tool_error_rate, 'tool_error_rate')} subtitle={`${num(row.tool_calls) || 0} calls`} rawValue={num(row.tool_error_rate)} target={METRIC_TARGETS.tool_error_rate} />
      </div>
      <div className="admin-filter-group" style={{ marginTop: 12 }}>
        {hasDirect && <button className="admin-filter-btn" onClick={() => onDrill('direct')}>Exchanges ({num(row.direct_count) || 0})</button>}
        {hasTasks && <button className="admin-filter-btn" onClick={() => onDrill('task')}>Tasks ({num(row.task_count) || 0})</button>}
      </div>
      <p className="admin-tab-description" style={{ fontSize: '0.9em', marginTop: 12 }}>
        <strong>How tools relate to tasks here.</strong> Each turn runs a <em>tool loop</em>: the assistant
        reasons, optionally calls one or more tools, observes their results, then answers. A multi-step
        <strong> task</strong> (e.g. <code>data_extraction</code>) is several such turns, each advancing the
        task's machine state. The panel below <em>aggregates</em> which tools this intent's assistant invoked
        across all its turns (and each tool's error rate). To see <strong>which tool ran in which task turn</strong>,
        open <strong>Tasks</strong> above → a task's turn-by-turn <strong>timeline</strong> → expand a turn to its
        <strong> tool-loop steps</strong> (each step shows its model and the tools it called, ✓ / ✗ with the error class).
      </p>
      <ToolLensPanel tools={toolLens} />
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
                  { key: 'modelId', label: 'Model', render: (v) => (v ? modelDisplayName(String(v)) : '—') },
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

// ---- L3 flow score (the Flows detail, folded into the drill) ---------------------------------------
const FLOW_DIMS: Array<{ key: string; label: string; weight: number }> = [
  { key: 'outcome_score', label: 'Outcome', weight: 0.30 },
  { key: 'information_score', label: 'Information', weight: 0.25 },
  { key: 'efficiency_score', label: 'Efficiency', weight: 0.15 },
  { key: 'context_retention_score', label: 'Context', weight: 0.15 },
  { key: 'ux_score', label: 'UX', weight: 0.15 },
];
/** 0-100 quality bands shared across the console (good >= 75, warn >= 50). */
function scoreColor(n: number): string {
  if (!Number.isFinite(n)) return 'var(--status-neutral)';
  return n >= 75 ? 'var(--status-good)' : n >= 50 ? 'var(--status-warn)' : 'var(--status-bad)';
}
const FlowScorePanel: React.FC<{ flow: Row }> = ({ flow }) => {
  const composite = FLOW_DIMS.reduce((s, d) => s + (num(flow[d.key]) || 0) * d.weight, 0);
  return (
    <div className="admin-metrics-row" style={{ marginBottom: 12 }}>
      <div className="metric-card">
        <div className="metric-card-title">
          Flow score
          <InfoTooltip
            content="The holistic multi-turn quality of this task from the flow evaluator - five weighted dimensions (Outcome 30%, Information 25%, Efficiency 15%, Context 15%, UX 15%). This is the Flows detail, folded into the drill. Good >= 75, acceptable >= 50."
            label="About Flow score"
          />
        </div>
        <div className="metric-card-value" style={{ color: scoreColor(composite) }}>{Number.isFinite(composite) ? composite.toFixed(0) : '—'}</div>
        {Boolean(flow.outcome || flow.status) && <div className="metric-card-subtitle">{String(flow.outcome || flow.status)}</div>}
      </div>
      {FLOW_DIMS.map((d) => {
        const n = num(flow[d.key]);
        return (
          <div className="metric-card" key={d.key}>
            <div className="metric-card-title">{d.label} <span style={{ color: 'var(--status-neutral)', fontSize: 11 }}>{Math.round(d.weight * 100)}%</span></div>
            <div className="metric-card-value" style={{ color: scoreColor(n) }}>{Number.isFinite(n) ? n.toFixed(0) : '—'}</div>
          </div>
        );
      })}
    </div>
  );
};

// ---- the tab: L0 dashboard + drill state -----------------------------------------------------------
const EffectivenessTab: React.FC<EffectivenessTabProps> = ({ data, dateRange, isLoading, onOpenConversation, registerBack, drill: drillProp, onDrillChange, classification, onClearClassification }) => {
  const l0Rows = useMemo(() => (data?.data ?? []) as Row[], [data]);
  // Use the parent-owned drill when provided (survives tab-switch unmounts — C2); else internal state.
  const [internalDrill, setInternalDrill] = useState<Drill>({ level: 0 });
  const drill = drillProp ?? internalDrill;
  const setDrill = onDrillChange ?? setInternalDrill;
  const [drillData, setDrillData] = useState<AnalyticsResult | null>(null);
  // L3 only: the task's holistic flow score (evaluation_flows) — the 5 weighted dimensions folded into
  // the drill so the Flows detail lives here instead of a separate tab.
  const [flowSummary, setFlowSummary] = useState<Row | null>(null);
  // L1 only: per-tool usage aggregated from execution_steps for the intent (the tool lens). null = loading.
  const [toolLens, setToolLens] = useState<ToolAgg[] | null>([]);
  // L0 only: the same aggregate across ALL intents (the system-wide tool view). null = loading.
  const [l0Tools, setL0Tools] = useState<ToolAgg[] | null>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  // Server-side pagination for the L2 list (exchanges / tasks): the backend returns one page + the
  // total match count, so the list scales past any single-fetch window instead of silently truncating.
  const DRILL_PAGE_SIZE = 25;
  const [drillPage, setDrillPage] = useState(0);
  const [drillTotal, setDrillTotal] = useState(0);
  // A fresh drill TARGET restarts at page 0 (drill identity changes on any level/intent/task change);
  // the fetch effect below depends on drillPage, so paging within a target refetches just that page.
  useEffect(() => { setDrillPage(0); }, [drill]);

  const intentRow = useCallback(
    (intent: string): Row | undefined => l0Rows.find((r) => String(r.intent) === intent),
    [l0Rows],
  );

  // Fetch the drill's data when it needs a query (L2/L3). L0/L1 are served from the loaded L0 rows.
  // L2/L3 also pull the existing evaluation queries so the per-exchange judge verdict (reasoning,
  // classification, compliance) and the per-flow 5-dimension score fold INTO the drill (frontend-only,
  // no new backend queries): the Evaluations and Flows detail lives here rather than in separate tabs.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      // L0: the intent table comes from the `data` prop; asynchronously load the system-wide tool
      // view (aggregate execution_steps across every intent).
      if (drill.level === 0) {
        setDrillData(null); setFlowSummary(null); setToolLens([]); setL0Tools(null);
        try {
          const steps = await queryAnalytics('execution_steps', dateRange, { limit: '200' });
          if (!cancelled) setL0Tools(aggregateTools((steps?.data ?? []) as Row[], null));
        } catch {
          if (!cancelled) setL0Tools([]);
        }
        return;
      }
      // L1: the metric cards come from the L0 row; asynchronously load the per-intent tool lens
      // (aggregate execution_steps client-side). null = loading.
      if (drill.level === 1) {
        setDrillData(null); setFlowSummary(null); setToolLens(null);
        try {
          const steps = await queryAnalytics('execution_steps', dateRange, { limit: '200' });
          if (!cancelled) setToolLens(aggregateTools((steps?.data ?? []) as Row[], drill.intent));
        } catch {
          if (!cancelled) setToolLens([]);
        }
        return;
      }
      setToolLens([]);
      if (drill.level !== 2 && drill.level !== 3) { setDrillData(null); setFlowSummary(null); return; }
      setDrillLoading(true);
      setFlowSummary(null);
      try {
        // Scope the drill to the same assistant (agent_type) as the L0 view when the filter is set.
        const clsExtra = classification ? { agentType: classification } : {};
        // Server-paginated L2 window: one page of rows + the total, so nothing is hidden past a cap.
        const pageWin = { limit: String(DRILL_PAGE_SIZE), offset: String(drillPage * DRILL_PAGE_SIZE) };
        if (drill.level === 2 && drill.delivery === 'direct') {
          const [ex, ev] = await Promise.all([
            queryAnalytics('intent_exchanges', dateRange, { intent: drill.intent, ...pageWin, ...clsExtra }),
            // The judge-verdict merge is best-effort over recent evaluations; a deep page may show '—'.
            queryAnalytics('evaluation_exchanges', dateRange, { limit: '200' }),
          ]);
          const evalById = new Map(((ev?.data ?? []) as Row[]).map((r) => [String(r.id ?? r.exchange_id), r]));
          const merged = ((ex?.data ?? []) as Row[]).map((r) => ({ ...r, _eval: evalById.get(String(r.exchange_id)) ?? null }));
          if (!cancelled) { setDrillData({ data: merged as unknown as AnalyticsResult['data'], columns: [] }); setDrillTotal(Number(ex?.total ?? merged.length)); }
        } else if (drill.level === 2) {
          const res = await queryAnalytics('task_details', dateRange, { intent: drill.intent, ...pageWin, ...clsExtra });
          if (!cancelled) { setDrillData(res ?? null); setDrillTotal(Number(res?.total ?? (res?.data?.length ?? 0))); }
        } else if (drill.level === 3) {
          const [tl, flows] = await Promise.all([
            queryAnalytics('task_timeline', dateRange, { taskId: drill.taskId }),
            queryAnalytics('evaluation_flows', dateRange, { limit: '200' }),
          ]);
          const flow = ((flows?.data ?? []) as Row[]).find((f) => String(f.task_id) === drill.taskId) ?? null;
          if (!cancelled) { setDrillData(tl ?? null); setFlowSummary(flow); }
        }
      } catch {
        if (!cancelled) { setDrillData(null); setFlowSummary(null); }
      } finally {
        if (!cancelled) setDrillLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [drill, dateRange, classification, drillPage]);

  // Back integration (issue: global Back skipped the drill). Register a closer that pops ONE drill level
  // so the console's in-app Back and browser Back step L3→L2→L1→L0 through the drill before walking the
  // tab history. At L0 there is nothing to close, so register null and let Back move between tabs.
  useEffect(() => {
    if (!registerBack) return;
    if (drill.level === 0) { registerBack(null); return; }
    registerBack(() => {
      setDrill((d) => {
        if (d.level === 3) return { level: 2, intent: d.intent, delivery: 'task' };
        if (d.level === 2) return { level: 1, intent: d.intent };
        return { level: 0 };
      });
    });
    return () => registerBack(null);
  }, [drill, registerBack]);

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

      {classification && (
        <div className="admin-filter-banner" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', border: '1px solid var(--surface-200)', borderRadius: 'var(--radius-md)', background: 'var(--surface-50, var(--surface-0))' }}>
          <span>Scoped to the <strong>{classification}</strong> assistant. Every row, drill, and tool count below is only this classification's traffic.</span>
          {onClearClassification && (
            <button className="admin-inline-btn" style={{ marginLeft: 'auto' }} onClick={onClearClassification}>Clear filter ✕</button>
          )}
        </div>
      )}

      {drill.level === 0 && (
        <>
          <p className="admin-tab-description">
            Each row is one <strong>intent</strong> (a category of request), ranked <strong>worst-first</strong> so
            the capabilities needing attention sit at the top. Quality is split into two axes so you can tell
            different problems apart: <strong>Classification</strong> asks whether routing sent the right traffic
            here (average classifier confidence and how often requests were re-routed away);{' '}
            <strong>Execution</strong> asks whether, given correct routing, the work then succeeded (single-turn:
            the automated relevance score; task: completion rate). A red Classification with a green Execution is a
            taxonomy or router problem; the reverse is a runtime problem; a red Tools cell is a tool-dependency
            problem. <strong>Latency</strong>, <strong>Cost/reply</strong>, and <strong>Tool error rate</strong> are
            independently sortable decision columns. <strong>Click an intent</strong> to drill into its exchanges or
            tasks, then a task's turn-by-turn timeline, then that turn's tool-loop steps.{' '}
            <DocLink href={DOC_LINKS.evaluation}>How quality is measured</DocLink>
          </p>
          <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.85 }}>
            Note: <strong>Cost/reply is an estimate</strong> — average tokens × each model's published rate, not your
            AWS bill. It is not yet reconciled against billing, so it will not match your invoice exactly; treat it
            as a relative signal for comparing intents, not an exact charge.
          </p>
          <L0Dashboard rows={l0Rows} onPick={(intent) => setDrill({ level: 1, intent })} />
          <ToolLensPanel
            tools={l0Tools}
            title="Tool usage (all intents)"
            tip="Every tool the assistants invoked across all intents in the window, with per-tool call counts and error rate — the system-wide view of the same per-step tool outcomes shown per intent in the L1 tool lens. Use it to spot a tool that is failing platform-wide, independent of any one intent."
            emptyText="No tool calls recorded across any intent in the window (or these turns predate per-tool telemetry)."
          />
        </>
      )}

      {drill.level === 1 && (() => {
        const row = intentRow(drill.intent);
        if (!row) return <div className="admin-info-banner">No data for “{drill.intent}”.</div>;
        return <L1Intent row={row} toolLens={toolLens} onDrill={(delivery) => setDrill({ level: 2, intent: drill.intent, delivery })} />;
      })()}

      {drill.level === 2 && (
        drillLoading ? <div className="admin-tab-loading">Loading…</div> :
        drill.delivery === 'task' ? (
          <>
          <p className="admin-tab-description" style={{ fontSize: '0.9em' }}>
            Two different things track a task, side by side: <strong>Status</strong> is the <em>lifecycle</em> — is the
            work done? (<code>in_progress → completed / failed / cancelled</code>, set by the processor).{' '}
            <strong>Machine state</strong> is the task's position in its <em>declared flow</em>
            (<code>collecting_requirements → extracting → validating → formatting → completed</code>), advanced by the
            assistant via its <code>advance_task_state</code> tool. A task now reads Status=<em>completed</em> only once
            its machine reaches a terminal state, so the two no longer contradict each other.
          </p>
          <DataTable
            data={(drillData?.data ?? []) as Row[]}
            emptyMessage="No tasks for this intent"
            serverPagination={{ page: drillPage, pageSize: DRILL_PAGE_SIZE, total: drillTotal, onPageChange: setDrillPage, loading: drillLoading }}
            onRowClick={(row) => setDrill({ level: 3, intent: drill.intent, taskId: String(row.task_id) })}
            columns={[
              { key: 'task_id', label: 'Task', render: (v) => <button className="admin-link-btn" onClick={() => setDrill({ level: 3, intent: drill.intent, taskId: String(v) })}>{shortId(v)}</button> },
              { key: 'status', label: 'Status (lifecycle)' },
              { key: 'task_state', label: 'Machine state (flow)', render: (v) => (v ? String(v) : '—') },
              { key: 'exchange_count', label: 'Turns', sortable: true },
              { key: 'transition_count', label: 'Transitions', sortable: true },
              { key: 'last_at', label: 'Last', render: (v) => (v ? new Date(String(v)).toLocaleString() : '—') },
              { key: 'channel_arn', label: 'Conversation', sortable: false, render: (v) => <ConvLink channelArn={v} onOpen={onOpenConversation} /> },
            ]}
          />
          </>
        ) : (
          <DataTable
            data={(drillData?.data ?? []) as Row[]}
            emptyMessage="No exchanges for this intent"
            serverPagination={{ page: drillPage, pageSize: DRILL_PAGE_SIZE, total: drillTotal, onPageChange: setDrillPage, loading: drillLoading }}
            columns={[
              { key: 'created_at', label: 'When', render: (v) => (v ? new Date(String(v)).toLocaleString() : '—') },
              { key: 'relevance_score', label: 'Relevance', sortable: true, render: (v) => <StatusValue value={v} targetKey="relevance_score" /> },
              // Per-exchange judge verdict (the Evaluations detail), folded in from evaluation_exchanges.
              { key: 'classification', label: 'Class', render: (_v, row) => { const ev = (row as { _eval?: Row })._eval; return ev?.classification ? String(ev.classification) : '—'; } },
              { key: 'is_compliant', label: 'OK', render: (_v, row) => { const ev = (row as { _eval?: Row })._eval; if (!ev || ev.is_compliant == null) return '—'; return <span style={{ color: ev.is_compliant ? 'var(--status-good)' : 'var(--status-bad)' }}>{ev.is_compliant ? '✓' : '✗'}</span>; } },
              { key: 'reasoning', label: 'Why (judge)', render: (_v, row) => { const ev = (row as { _eval?: Row })._eval; const t = ev?.reasoning ? String(ev.reasoning) : ''; return t ? <span title={t}>{t.length > 90 ? t.slice(0, 90) + '…' : t}</span> : '—'; } },
              { key: 'total_ms', label: 'Latency', sortable: true, render: (v) => fmtMs(v) },
              { key: 'input_tokens', label: 'In', sortable: true },
              { key: 'output_tokens', label: 'Out', sortable: true },
              { key: 'bedrock_model', label: 'Model', render: (v) => (v ? modelDisplayName(String(v)) : '—') },
              { key: 'channel_arn', label: 'Conversation', sortable: false, render: (v) => <ConvLink channelArn={v} onOpen={onOpenConversation} /> },
            ]}
          />
        )
      )}

      {drill.level === 3 && (
        drillLoading ? <div className="admin-tab-loading">Loading…</div> :
        <>
          {/* The whole task lives in one conversation; a single link opens its raw log (all turns below). */}
          {onOpenConversation && (() => {
            const arn = String(((drillData?.data ?? [])[0] as Row | undefined)?.channel_arn ?? '');
            return arn ? (
              <p className="admin-tab-description" style={{ marginBottom: 'var(--space-2)' }}>
                <ConvLink channelArn={arn} onOpen={onOpenConversation} />{' '}
                <span style={{ color: 'var(--text-secondary)' }}>— see the actual messages for this task</span>
              </p>
            ) : null;
          })()}
          {flowSummary
            ? <FlowScorePanel flow={flowSummary} />
            : <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.8 }}>No holistic flow score for this task yet (the flow evaluator scores a multi-turn task once it has accumulated turns).</p>}
          <L3Timeline rows={(drillData?.data ?? []) as Row[]} />
        </>
      )}
    </div>
  );
};

export default EffectivenessTab;
