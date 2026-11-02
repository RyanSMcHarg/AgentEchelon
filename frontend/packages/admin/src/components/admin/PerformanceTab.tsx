import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import PerformanceFilterBar, { type PerformanceFilters } from './PerformanceFilters';
import { evaluateTarget, targetFor, STATUS_VAR, type TargetStatus } from './metricTargets';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange, AnalyticsResult } from '@ae/shared';

/**
 * ── PERFORMANCE, ONE VIEW ─────────────────────────────────────────────────────
 *
 * The section opens on an overview: headline cards and the message flow, how turns arrived, which
 * intent they were and what happened. Nothing else shows until somebody clicks, and every click opens
 * the detail behind what was clicked:
 *
 *   TTFF card              the first update by path (the Latency detail, opened at its TTFF breakdown)
 *   E2E, worker, turns     the full flow and latency (the Latency detail)
 *   a quality card         every intent and the evaluation readings (the Effectiveness detail)
 *   an intent node         that intent: its flow figures, its turns, then its Effectiveness drill
 *   an outcome or a path   that slice: its flow figures and its turns
 *   a turn                 the turn's record: each step in order, the metric it closes, its verdicts
 *
 * Effectiveness and Latency used to be two tabs showing the same turns two ways. They are the drills
 * of this view now, rendered by the parent so they keep their own state, and they share its filters.
 */

type Row = Record<string, unknown>;

export type PerfView =
  | { view: 'overview' }
  | { view: 'ttff' }
  | { view: 'latency' }
  | { view: 'quality' }
  | { view: 'intent' | 'outcome' | 'path'; key: string };

interface PerformanceTabProps {
  flowData: AnalyticsResult | null;
  /** The Welcome lane: welcomes timed from the assistant joining (`welcome_flow`). */
  welcomeData?: AnalyticsResult | null;
  effectivenessData: AnalyticsResult | null;
  dateRange: AnalyticsDateRange;
  isLoading: boolean;
  filters: PerformanceFilters;
  onFiltersChange: (next: PerformanceFilters) => void;
  filterRows: Row[];
  view: PerfView;
  onViewChange: (next: PerfView) => void;
  /** The Latency detail, rendered by the parent; `openTtff` opens it at the first-update breakdown. */
  renderLatency: (openTtff: boolean) => React.ReactNode;
  /** The Effectiveness detail at the overview of every intent, or at one intent's drill. */
  renderEffectiveness: (intent: string | null) => React.ReactNode;
  onOpenConversation?: (channelArn: string) => void;
}

const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));
const fmt = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
export const formatMs = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
};

/** A count-weighted mean over rows, from an average column and the count it was taken over. */
export function weighted(rows: Row[], avgKey: string, nKey: string): { value: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const a = num(r[avgKey]);
    const c = num(r[nKey]);
    if (Number.isFinite(a) && Number.isFinite(c) && c > 0) { sum += a * c; n += c; }
  }
  return { value: n > 0 ? sum / n : NaN, n };
}

const sum = (rows: Row[], key: string): number => rows.reduce((s, r) => s + (num(r[key]) || 0), 0);

const OUTCOMES = ['answered', 'task', 'refused', 'handed', 'stopped'] as const;
const PATHS = ['flow', 'lex', 'unknown'] as const;
/** The label of one statistic: its name, and the definition beside it. */
const STAT_LABEL = 'perf-stat-label';

const PATH_COLOR: Record<string, string> = { flow: '#1F5F8B', lex: '#7B5EA7', unknown: '#8A94A3' };
const FILL: Record<TargetStatus | 'neutral', string> = { good: '#2F7D4E', warn: '#C98A12', bad: '#B42318', neutral: '#8A94A3' };
const MAX_INTENTS = 6;
const OTHER = '__other__';

function status(value: number, key: string, tier?: string | null): TargetStatus | null {
  const t = targetFor(key, tier ?? null);
  return t && Number.isFinite(value) ? evaluateTarget(value, t) : null;
}

/** The flow rows with the long tail of intents folded into one `Other` row per (path, outcome). */
export function foldIntents(rows: Row[]): { rows: Row[]; intents: string[]; folded: string[] } {
  const byIntent = new Map<string, number>();
  for (const r of rows) byIntent.set(String(r.intent), (byIntent.get(String(r.intent)) ?? 0) + (num(r.turns) || 0));
  const ranked = [...byIntent.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const keep = ranked.length > MAX_INTENTS ? ranked.slice(0, MAX_INTENTS - 1) : ranked;
  const folded = ranked.filter((k) => !keep.includes(k));
  const out = rows.map((r) => (keep.includes(String(r.intent)) ? r : { ...r, intent: OTHER }));
  return { rows: out, intents: folded.length ? [...keep, OTHER] : keep, folded };
}

/**
 * THE WELCOME LANE, beside the two paths a message arrives by. A welcome answers no message, so it has no
 * TTFF; it is timed from the assistant joining to the welcome appearing, which is what a person sees.
 */
const WelcomeLane: React.FC<{ data: AnalyticsResult | null }> = ({ data }) => {
  const { t } = useTranslation();
  const rows = (data?.data ?? []) as Record<string, unknown>[];
  const unmeasured = rows.reduce((s, r) => s + (Number(r.welcomes) || 0) - (Number(r.measured) || 0), 0);
  return (
    <section className="perf-welcome" aria-label={t('admin.performance.welcome.title')}>
      <h4>{t('admin.performance.welcome.title')}</h4>
      <p className="admin-tab-description">{t('admin.performance.welcome.lead')}</p>
      {rows.length === 0 ? (
        <p className="admin-tab-empty">{t('admin.performance.welcome.empty')}</p>
      ) : (
        <>
          <DataTable
            columns={[
              { key: 'kind', label: t('admin.performance.welcome.kind'), render: (v: unknown) => t(`admin.performance.welcome.kinds.${String(v)}`, { defaultValue: String(v) }) },
              { key: 'welcomes', label: t('admin.performance.welcome.welcomes') },
              { key: 'avg_ms', label: t('admin.performance.welcome.avg'), render: (v: unknown) => (v == null ? '—' : formatMs(Number(v))) },
              { key: 'p95_ms', label: t('admin.performance.welcome.p95'), render: (v: unknown) => (v == null ? '—' : formatMs(Number(v))) },
            ]}
            data={rows}
          />
          {unmeasured > 0 && <p className="admin-help-text">{t('admin.performance.welcome.unmeasured', { count: unmeasured })}</p>}
        </>
      )}
    </section>
  );
};

const PerformanceTab: React.FC<PerformanceTabProps> = ({
  flowData, welcomeData, effectivenessData, dateRange, isLoading, filters, onFiltersChange, filterRows,
  view, onViewChange, renderLatency, renderEffectiveness, onOpenConversation,
}) => {
  const { t } = useTranslation();
  const [turnId, setTurnId] = useState<string | null>(null);
  // The detail a click opens sits below the flow, so it is brought into view and given focus each time it
  // opens or changes: the person sees what they asked for, and a keyboard user lands on it.
  const detailRef = useRef<HTMLElement>(null);
  const detailKey = view.view === 'overview' ? null : `${JSON.stringify(view)}|${turnId ?? ''}`;
  useEffect(() => {
    const el = detailRef.current;
    if (!detailKey || !el) return;
    el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    el.focus?.({ preventScroll: true });
  }, [detailKey]);
  useEffect(() => { setTurnId(null); }, [view]);

  const flowRows = useMemo(() => ((flowData?.data ?? []) as Row[]), [flowData]);
  const effRows = useMemo(() => ((effectivenessData?.data ?? []) as Row[]), [effectivenessData]);
  const tier = filters.classification;
  const { rows: folded, intents, folded: foldedNames } = useMemo(() => foldIntents(flowRows), [flowRows]);
  const intentLabel = (k: string) => (k === OTHER ? t('admin.performance.otherIntents', { count: foldedNames.length }) : k);
  const effByIntent = useMemo(() => new Map(effRows.map((r) => [String(r.intent), r])), [effRows]);

  if (isLoading && !flowData) return <div className="admin-tab-loading">{t('admin.performance.loading')}</div>;

  const totalTurns = sum(flowRows, 'turns');
  const byPath = (p: string) => flowRows.filter((r) => r.path === p);
  const ttffStd = weighted(byPath('flow'), 'avg_ttff_ms', 'ttff_n');
  const ttffLex = weighted(byPath('lex'), 'avg_ttff_ms', 'ttff_n');
  const e2e = weighted(flowRows, 'avg_e2e_ms', 'e2e_n');
  const worker = weighted(flowRows, 'avg_total_ms', 'total_n');

  // Quality, weighted from the per-intent rollup by each rate's own population.
  const q = (avg: string, n: string) => weighted(effRows, avg, n);
  const relevance = q('avg_relevance', 'relevance_scored_count');
  const grounded = q('groundedness_rate', 'groundedness_assessed_count');
  const confidence = q('avg_confidence', 'exchange_count');
  const completion = q('task_completion_rate', 'task_flow_count');
  const flagged = q('user_flag_rate', 'user_rated_count');
  const toolErrors = q('tool_error_rate', 'tool_calls');
  const cost = q('cost_per_reply_usd', 'exchange_count');

  type Card = { label: string; value: string; sub: string; st: TargetStatus | null; open?: PerfView; tip?: string; def?: string };
  const cardRows: Array<{ title: string; cards: Card[] }> = [
    { title: t('admin.performance.speedAndCost'), cards: [
      { label: t('admin.performance.card.turns'), def: t('admin.performance.pathHelp'), value: fmt(totalTurns), sub: t('admin.performance.card.turnsSub', { flowPath: fmt(sum(byPath('flow'), 'turns')), lexPath: fmt(sum(byPath('lex'), 'turns')), unrecorded: fmt(sum(byPath('unknown'), 'turns')) }), st: null, open: { view: 'latency' } },
      { label: t('admin.performance.card.e2e'), def: t('admin.metrics.avg_e2e_ms.description'), value: formatMs(e2e.value), sub: t('admin.performance.card.over', { count: e2e.n }), st: status(e2e.value, 'avg_e2e_ms', tier), open: { view: 'latency' } },
      { label: t('admin.performance.card.ttff'), def: t('admin.metrics.ttff_ms.description'), value: formatMs(ttffStd.value), sub: t('admin.performance.card.ttffSub', { lexPath: formatMs(ttffLex.value) }), st: status(ttffStd.value, 'ttff_ms', tier), open: { view: 'ttff' } },
      { label: t('admin.performance.card.worker'), def: t('admin.metrics.avg_total_ms.description'), value: formatMs(worker.value), sub: t('admin.performance.card.over', { count: worker.n }), st: status(worker.value, 'avg_total_ms', tier), open: { view: 'latency' } },
      { label: t('admin.performance.card.cost'), def: t('admin.metrics.cost_per_reply.description'), value: Number.isFinite(cost.value) ? `$${cost.value.toFixed(4)}` : '—', sub: t('admin.performance.card.costSub'), st: status(cost.value, 'cost_per_reply', tier), open: { view: 'quality' } },
    ] },
    { title: t('admin.performance.quality'), cards: [
      { label: t('admin.performance.card.relevance'), def: t('admin.metrics.relevance_score.description'), value: Number.isFinite(relevance.value) ? relevance.value.toFixed(0) : '—', sub: t('admin.performance.card.judged', { count: relevance.n }), st: status(relevance.value, 'relevance_score', tier), open: { view: 'quality' } },
      { label: t('admin.performance.card.grounded'), def: t('admin.metrics.grounded_rate.description'), value: Number.isFinite(grounded.value) ? `${grounded.value.toFixed(0)}%` : '—', sub: t('admin.performance.card.assessed', { count: grounded.n }), st: null, open: { view: 'quality' } },
      { label: t('admin.performance.card.confidence'), def: t('admin.metrics.intent_confidence.description'), value: Number.isFinite(confidence.value) ? confidence.value.toFixed(0) : '—', sub: t('admin.performance.card.over', { count: confidence.n }), st: status(confidence.value, 'intent_confidence', tier), open: { view: 'quality' } },
      { label: t('admin.performance.card.completion'), def: t('admin.metrics.task_completion_rate.description'), value: Number.isFinite(completion.value) ? `${completion.value.toFixed(0)}%` : '—', sub: t('admin.performance.card.tasks', { count: completion.n }), st: status(completion.value, 'task_completion_rate', tier), open: { view: 'outcome', key: 'task' } },
      { label: t('admin.performance.card.flagged'), def: t('admin.metrics.user_flag_rate.description'), value: Number.isFinite(flagged.value) ? `${flagged.value.toFixed(0)}%` : '—', sub: t('admin.performance.card.rated', { count: flagged.n }), st: status(flagged.value, 'user_flag_rate', tier), open: { view: 'quality' } },
      { label: t('admin.performance.card.toolErrors'), def: t('admin.metrics.tool_error_rate.description'), value: Number.isFinite(toolErrors.value) ? `${toolErrors.value.toFixed(0)}%` : '—', sub: t('admin.performance.card.calls', { count: toolErrors.n }), st: status(toolErrors.value, 'tool_error_rate', tier), open: { view: 'quality' } },
    ] },
  ];

  // ── the flow ──────────────────────────────────────────────────────────────────────────────────
  const W = 1240, k0 = 440, gap = 14, nodeW = 14;
  const X = { p: 190, i: 600, o: 1000 };
  const scale = totalTurns > 0 ? k0 / totalTurns : 0;
  type N = { key: string; n: number; y: number; h: number };
  const col = (keys: readonly string[], count: (k: string) => number): N[] => {
    let y = 0;
    return keys.map((key) => ({ key, n: count(key) })).filter((x) => x.n > 0).map((x) => {
      const h = Math.max(3, x.n * scale);
      const node = { ...x, y, h };
      y += h + gap;
      return node;
    });
  };
  const pNodes = col(PATHS, (p) => sum(folded.filter((r) => r.path === p), 'turns'));
  const iNodes = col(intents, (i) => sum(folded.filter((r) => r.intent === i), 'turns'));
  const oNodes = col(OUTCOMES, (o) => sum(folded.filter((r) => r.outcome === o), 'turns'));
  const height = (ns: N[]) => (ns.length ? ns[ns.length - 1].y + ns[ns.length - 1].h : 0);
  const H = Math.max(height(pNodes), height(iNodes), height(oNodes)) + 40;
  for (const ns of [pNodes, iNodes, oNodes]) { const off = (H - height(ns)) / 2; ns.forEach((n) => { n.y += off; }); }

  const intentStatus = (i: string): TargetStatus | null => {
    const e = effByIntent.get(i);
    return e ? status(num(e.avg_relevance), 'relevance_score', tier) : null;
  };
  const bandStatus = (i: string, o: string): TargetStatus | 'neutral' => {
    if (o === 'refused' || o === 'handed' || o === 'stopped') return 'neutral';
    const e = effByIntent.get(i);
    if (o === 'task') return (e && status(num(e.task_completion_rate), 'task_completion_rate', tier)) || 'neutral';
    return intentStatus(i) || 'neutral';
  };
  const path = (x0: number, y0: number, x1: number, y1: number, h: number) => {
    const xm = (x0 + x1) / 2;
    return `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + h} C${xm},${y1 + h} ${xm},${y0 + h} ${x0},${y0 + h} Z`;
  };
  const bands: Array<{ d: string; fill: string; op: number; key: string }> = [];
  const outP = new Map(pNodes.map((n) => [n.key, n.y]));
  const inI = new Map(iNodes.map((n) => [n.key, n.y]));
  for (const i of iNodes) for (const p of pNodes) {
    const n = sum(folded.filter((r) => r.intent === i.key && r.path === p.key), 'turns');
    if (!n) continue;
    const h = n * scale;
    bands.push({ key: `${p.key}>${i.key}`, d: path(X.p + nodeW, outP.get(p.key)!, X.i, inI.get(i.key)!, h), fill: PATH_COLOR[p.key], op: 0.22 });
    outP.set(p.key, outP.get(p.key)! + h); inI.set(i.key, inI.get(i.key)! + h);
  }
  const outI = new Map(iNodes.map((n) => [n.key, n.y]));
  const inO = new Map(oNodes.map((n) => [n.key, n.y]));
  for (const i of iNodes) for (const o of oNodes) {
    const n = sum(folded.filter((r) => r.intent === i.key && r.outcome === o.key), 'turns');
    if (!n) continue;
    const h = n * scale;
    const st = bandStatus(i.key, o.key);
    bands.push({ key: `${i.key}>${o.key}`, d: path(X.i + nodeW, outI.get(i.key)!, X.o, inO.get(o.key)!, h), fill: FILL[st], op: st === 'neutral' ? 0.32 : 0.38 });
    outI.set(i.key, outI.get(i.key)! + h); inO.set(o.key, inO.get(o.key)! + h);
  }

  const selected = (v: PerfView['view'], key: string) => view.view === v && 'key' in view && view.key === key;
  const nodeButton = (x: number, n: N, side: 'left' | 'right', label: string, sub: string, open: PerfView, color: string, subColor?: string) => (
    <React.Fragment key={`${open.view}:${n.key}`}>
      <div style={{ position: 'absolute', left: x, top: n.y, width: nodeW, height: n.h, background: color, borderRadius: 2 }} />
      <button
        type="button"
        className="perf-flow-node"
        aria-pressed={'key' in open ? selected(open.view, open.key) : false}
        onClick={() => onViewChange(open)}
        style={{
          position: 'absolute', top: n.y + n.h / 2 - 22,
          ...(side === 'left' ? { left: x - 192, width: 184, textAlign: 'right' as const } : { left: x + nodeW + 8, width: 236, textAlign: 'left' as const }),
        }}
      >
        <span className="perf-flow-node-label">{label}</span>
        <span className="perf-flow-node-sub" style={subColor ? { color: subColor } : undefined}>{sub}</span>
      </button>
    </React.Fragment>
  );

  const pathLabel = (p: string) => t(`admin.performance.path.${p}`);
  const viewLabel = (v: PerfView): string => {
    if (v.view === 'intent') return intentLabel(v.key);
    if (v.view === 'path') return pathLabel(v.key);
    if (v.view === 'outcome') return t(`admin.performance.outcome.${v.key}`);
    return t(`admin.performance.view.${v.view}`);
  };
  const outcomeLabel = (o: string) => t(`admin.performance.outcome.${o}`);

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>
          {t('admin.performance.title')}{' '}
          <InfoTooltip label={t('admin.performance.title')} content={t('admin.performance.tip')} />
        </h3>
      </div>
      <PerformanceFilterBar rows={filterRows} value={filters} onChange={onFiltersChange} />

      {cardRows.map((row) => (
        <div key={row.title} className="perf-card-row">
          <div className="perf-card-row-title">{row.title}</div>
          <div className="perf-card-grid">
            {row.cards.map((c) => (
              <div key={c.label} className="perf-card-wrap">
              <button
                type="button"
                className="perf-card"
                onClick={() => c.open && onViewChange(c.open)}
                aria-label={t('admin.performance.openCard', { label: c.label, value: c.value })}
              >
                <span className="perf-card-label">{c.label}</span>
                <span className="perf-card-value" style={{ color: c.st ? STATUS_VAR[c.st] : undefined }}>{c.value}</span>
                <span className="perf-card-sub">{c.sub}</span>
              </button>
              {c.def && (
                <span className="perf-card-help">
                  <InfoTooltip label={t('admin.performance.aboutMetric', { label: c.label })} content={c.def} />
                </span>
              )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="perf-flow" role="region" aria-label={t('admin.performance.flowTitle')}>
        <div className="perf-flow-head">
          <div>
            <h4>{t('admin.performance.flowTitle')}</h4>
            <p className="admin-tab-description">{t('admin.performance.flowDescription')}</p>
          </div>
          <button type="button" className={view.view === 'latency' ? 'btn-primary' : 'btn-secondary'} onClick={() => onViewChange({ view: 'latency' })}>
            {t('admin.performance.fullFlow')}
          </button>
        </div>
        {totalTurns === 0 ? (
          <p className="admin-tab-empty">{t('admin.performance.empty')}</p>
        ) : (
          <div className="perf-flow-scroll">
            <div className="perf-flow-columns" style={{ width: W }}>
              <span style={{ width: 184, textAlign: 'right' }}>
                {t('admin.performance.column.path')}{' '}
                <InfoTooltip label={t('admin.performance.pathHelpLabel')} content={t('admin.performance.pathHelp')} />
              </span>
              <span style={{ width: 260, marginLeft: 100 }}>{t('admin.performance.column.intent')}</span>
              <span style={{ width: 260 }}>{t('admin.performance.column.outcome')}</span>
            </div>
            <div style={{ position: 'relative', width: W, height: H }}>
              <svg aria-hidden="true" width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0 }}>
                {bands.map((b) => <path key={b.key} d={b.d} fill={b.fill} fillOpacity={b.op} />)}
              </svg>
              {pNodes.map((n) => nodeButton(X.p, n, 'left', pathLabel(n.key), t('admin.performance.pathSub', { count: n.n, ttff: formatMs(weighted(byPath(n.key), 'avg_ttff_ms', 'ttff_n').value) }), { view: 'path', key: n.key }, PATH_COLOR[n.key]))}
              {iNodes.map((n) => {
                const e = effByIntent.get(n.key);
                const st = intentStatus(n.key);
                const sub = e
                  ? t('admin.performance.intentSub', { relevance: Number.isFinite(num(e.avg_relevance)) ? num(e.avg_relevance).toFixed(0) : '—' })
                  : '';
                return nodeButton(X.i, n, 'right', `${intentLabel(n.key)} · ${fmt(n.n)}`, sub, { view: 'intent', key: n.key }, '#3D4856', st ? STATUS_VAR[st] : undefined);
              })}
              {oNodes.map((n) => nodeButton(X.o, n, 'right', `${outcomeLabel(n.key)} · ${fmt(n.n)}`, t(`admin.performance.outcomeSub.${n.key}`), { view: 'outcome', key: n.key }, n.key === 'answered' || n.key === 'task' ? '#3D4856' : FILL.neutral))}
            </div>
            <div className="perf-flow-legend">
              <span><i style={{ background: FILL.good }} />{t('admin.performance.legend.good')}</span>
              <span><i style={{ background: FILL.warn }} />{t('admin.performance.legend.warn')}</span>
              <span><i style={{ background: FILL.bad }} />{t('admin.performance.legend.bad')}</span>
              <span><i style={{ background: FILL.neutral }} />{t('admin.performance.legend.neutral')}</span>
            </div>
          </div>
        )}
      </div>

      {view.view !== 'overview' && (
        <section className="perf-detail" aria-label={t('admin.performance.detail')} ref={detailRef} tabIndex={-1}>
          <nav className="perf-crumbs" aria-label={t('admin.performance.breadcrumb')}>
            <button type="button" className="btn-link" onClick={() => onViewChange({ view: 'overview' })}>{t('admin.performance.title')}</button>
            <Sep />
            <button type="button" className="btn-link" onClick={() => setTurnId(null)} aria-current={turnId ? undefined : 'page'}>
              {viewLabel(view)}
            </button>
            {turnId && <Sep />}
            {turnId && <span aria-current="page">{t('admin.performance.turn')}</span>}
            <span className="perf-close">
              <button type="button" className="btn-secondary" onClick={() => onViewChange({ view: 'overview' })}>{t('admin.performance.close')}</button>
            </span>
          </nav>

          {turnId ? (
            <TurnRecord messageId={turnId} dateRange={dateRange} filters={filters} onOpenConversation={onOpenConversation} />
          ) : view.view === 'ttff' ? (
            <>
              <WelcomeLane data={welcomeData ?? null} />
              {renderLatency(true)}
            </>
          ) : view.view === 'latency' ? (
            renderLatency(false)
          ) : view.view === 'quality' ? (
            renderEffectiveness(null)
          ) : (
            <>
              <FlowSlice
                slice={view}
                rows={view.view === 'intent' && view.key === OTHER ? folded.filter((r) => r.intent === OTHER) : flowRows.filter((r) => String(r[view.view === 'intent' ? 'intent' : view.view]) === view.key)}
                title={view.view === 'intent' ? intentLabel(view.key) : view.view === 'path' ? pathLabel(view.key) : outcomeLabel(view.key)}
                totalTurns={totalTurns}
                onOpen={onViewChange}
                onOpenTurn={setTurnId}
                dateRange={dateRange}
                filters={filters}
                foldedNames={foldedNames}
              />
              {view.view === 'intent' && view.key !== OTHER && (
                <div className="perf-embedded">
                  <h4>{t('admin.performance.qualityFor', { intent: view.key })}</h4>
                  {renderEffectiveness(view.key)}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
};

/** The breadcrumb separator. */
const Sep: React.FC = () => <span aria-hidden="true">{'›'}</span>;

/** The shared bar as query parameters, one mapping for every Performance query. */
export function flowParams(filters: PerformanceFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (filters.assistant) p.agentType = filters.assistant;
  if (filters.role) p.assistantRole = filters.role;
  if (filters.version) p.profileVersion = filters.version;
  if (filters.classification) p.conversationClassification = filters.classification;
  if (filters.entry) p.turnEntry = filters.entry;
  if (filters.duel) p.duelRound = filters.duel;
  if (filters.responseType) p.responseType = filters.responseType;
  return p;
}

/** One node of the flow: its figures from the flow rows, how it splits, and the turns behind it. */
const FlowSlice: React.FC<{
  slice: { view: 'intent' | 'outcome' | 'path'; key: string };
  rows: Row[];
  title: string;
  totalTurns: number;
  onOpen: (v: PerfView) => void;
  onOpenTurn: (id: string) => void;
  dateRange: AnalyticsDateRange;
  filters: PerformanceFilters;
  foldedNames: string[];
}> = ({ slice, rows, title, totalTurns, onOpen, onOpenTurn, dateRange, filters, foldedNames }) => {
  const { t } = useTranslation();
  const [turns, setTurns] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnsKey = `${slice.view}:${slice.key}`;
  useEffect(() => {
    let cancelled = false;
    setTurns(null);
    setError(null);
    const extra: Record<string, string> = { ...flowParams(filters), limit: '50' };
    if (slice.view === 'path') extra.flowPath = slice.key;
    if (slice.view === 'outcome') extra.flowOutcome = slice.key;
    if (slice.view === 'intent' && slice.key !== OTHER) extra.flowIntent = slice.key;
    Promise.resolve()
      .then(() => queryAnalytics('flow_turns', dateRange, extra))
      .then((res) => { if (!cancelled) setTurns((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.performance.turnsError')); });
    return () => { cancelled = true; };
  }, [turnsKey, dateRange, filters, t]);

  const n = sum(rows, 'turns');
  const ttffStd = weighted(rows.filter((r) => r.path === 'flow'), 'avg_ttff_ms', 'ttff_n');
  const ttffLex = weighted(rows.filter((r) => r.path === 'lex'), 'avg_ttff_ms', 'ttff_n');
  const ttff = weighted(rows, 'avg_ttff_ms', 'ttff_n');
  const e2e = weighted(rows, 'avg_e2e_ms', 'e2e_n');
  const worker = weighted(rows, 'avg_total_ms', 'total_n');
  const model = weighted(rows, 'avg_model_ms', 'model_n');
  const tool = weighted(rows, 'avg_tool_ms', 'tool_n');
  const resolve = weighted(rows, 'avg_resolve_ms', 'resolve_n');
  const scans = sum(rows, 'poll_n');

  const stats: Array<{ label: string; value: string; def?: string }> = [
    { label: t('admin.performance.stat.turns'), value: `${fmt(n)} · ${totalTurns ? Math.round((n / totalTurns) * 100) : 0}%` },
    { label: t('admin.performance.stat.ttffFlow'), def: t('admin.metrics.ttff_ms.description'), value: formatMs(ttffStd.value) },
    { label: t('admin.performance.stat.ttffLex'), def: t('admin.metrics.ttff_ms.description'), value: formatMs(ttffLex.value) },
    { label: t('admin.performance.stat.e2e'), def: t('admin.metrics.avg_e2e_ms.description'), value: formatMs(e2e.value) },
    { label: t('admin.performance.stat.worker'), def: t('admin.metrics.avg_total_ms.description'), value: formatMs(worker.value) },
    { label: t('admin.performance.stat.lookup'), def: t('admin.metrics.placeholder_resolve_ms.description'), value: `${formatMs(resolve.value)} · ${t('admin.performance.stat.scans', { count: scans })}` },
  ];

  // The latency of these turns as one bar: first update, then the worker's model and tool time, then the rest.
  const other = Math.max(0, (Number.isFinite(e2e.value) ? e2e.value : 0) - (ttff.value || 0) - (model.value || 0) - (tool.value || 0));
  const parts = [
    { name: t('admin.performance.part.ttff'), v: ttff.value, color: '#9FB3C8' },
    { name: t('admin.performance.part.model'), v: model.value, color: '#1F5F8B' },
    { name: t('admin.performance.part.tool'), v: tool.value, color: '#4A7FA8' },
    { name: t('admin.performance.part.other'), v: other, color: '#7A8A9C' },
  ].filter((p) => Number.isFinite(p.v) && p.v > 0);
  const partTotal = parts.reduce((s, p) => s + p.v, 0);

  const splitBy = slice.view === 'outcome' ? 'intent' : 'outcome';
  const splitKeys = [...new Set(rows.map((r) => String(r[splitBy])))];
  const split = splitKeys
    .map((k) => ({ k, n: sum(rows.filter((r) => String(r[splitBy]) === k), 'turns') }))
    .sort((a, b) => b.n - a.n);

  return (
    <div className="perf-slice">
      <h4>{title}</h4>
      {slice.view === 'intent' && slice.key === OTHER && (
        <p className="admin-tab-description">{t('admin.performance.otherIncludes', { intents: foldedNames.join(', ') })}</p>
      )}
      <div className="perf-stat-grid">
        {stats.map((s) => (
          <div key={s.label} className="perf-stat">
            <span className="perf-stat-label">
              {s.label}
              {s.def && <><InfoTooltip label={t('admin.performance.aboutMetric', { label: s.label })} content={s.def} /></>}
            </span>
            <strong>{s.value}</strong>
          </div>
        ))}
      </div>
      {partTotal > 0 && (
        <div className="perf-bar-block">
          <div className="perf-bar" role="img" aria-label={parts.map((p) => `${p.name} ${formatMs(p.v)}`).join(', ')}>
            {parts.map((p) => <span key={p.name} style={{ width: `${(p.v / partTotal) * 100}%`, background: p.color }} />)}
          </div>
          <div className="perf-bar-legend">
            {parts.map((p) => <span key={p.name}><i style={{ background: p.color }} />{p.name} {formatMs(p.v)}</span>)}
          </div>
        </div>
      )}
      <h5>{t(`admin.performance.splitTitle.${splitBy}`)}</h5>
      <div className="perf-split">
        {split.map((s) => (
          <button
            key={s.k}
            type="button"
            className="btn-secondary"
            onClick={() => onOpen(splitBy === 'intent' ? { view: 'intent', key: s.k } : { view: 'outcome', key: s.k })}
          >
            {splitBy === 'intent' ? s.k : t(`admin.performance.outcome.${s.k}`)} · {fmt(s.n)}
          </button>
        ))}
      </div>
      <h5>{t('admin.performance.turnsTitle')}</h5>
      <p className="admin-help-text">{t('admin.performance.turnsNote')}</p>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && turns === null && <p className="admin-help-text">{t('admin.performance.loading')}</p>}
      {turns !== null && (
        <DataTable
          data={turns}
          emptyMessage={t('admin.performance.noTurns')}
          columns={[
            { key: 'created_at', label: t('admin.performance.column.when'), render: (v: unknown) => new Date(String(v)).toLocaleString() },
            { key: 'path', label: t('admin.performance.column.path'), render: (v: unknown) => t(`admin.performance.path.${String(v)}`) },
            { key: 'intent', label: t('admin.performance.column.intent') },
            { key: 'outcome', label: t('admin.performance.column.outcome'), render: (v: unknown) => t(`admin.performance.outcome.${String(v)}`) },
            { key: 'ttff_ms', label: 'TTFF', sortable: true, render: (v: unknown) => formatMs(num(v)) },
            { key: 'e2e_ms', label: 'E2E', sortable: true, render: (v: unknown) => formatMs(num(v)) },
            { key: 'relevance_score', label: t('admin.performance.column.relevance'), render: (v: unknown) => (Number.isFinite(num(v)) ? num(v).toFixed(0) : '—') },
            { key: 'cost_usd', label: t('admin.performance.column.cost'), render: (v: unknown) => (Number.isFinite(num(v)) ? `$${num(v).toFixed(4)}` : '—') },
            {
              key: 'message_id',
              label: '',
              render: (v: unknown) => <button type="button" className="btn-secondary" onClick={() => onOpenTurn(String(v))}>{t('admin.performance.openTurn')}</button>,
            },
          ]}
        />
      )}
    </div>
  );
};

/** What each recorded step of a turn is, and the latency metric it closes. */
const ROUTER_STEP_CLOSES: Record<string, string> = { classified: 'classifier', dispatched: 'routerLeg' };

/** One turn's record: its steps in order, the metric each closes, its verdicts and its spend. */
const TurnRecord: React.FC<{
  messageId: string;
  dateRange: AnalyticsDateRange;
  filters: PerformanceFilters;
  onOpenConversation?: (channelArn: string) => void;
}> = ({ messageId, dateRange, filters, onOpenConversation }) => {
  const { t } = useTranslation();
  const [turn, setTurn] = useState<Row | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTurn(undefined);
    setError(null);
    Promise.resolve()
      .then(() => queryAnalytics('flow_turn', dateRange, { ...flowParams(filters), messageId }))
      .then((res) => { if (!cancelled) setTurn(((res?.data ?? []) as Row[])[0] ?? null); })
      .catch(() => { if (!cancelled) setError(t('admin.performance.turnError')); });
    return () => { cancelled = true; };
  }, [messageId, dateRange, filters, t]);

  if (error) return <p className="admin-error" role="alert">{error}</p>;
  if (turn === undefined) return <p className="admin-help-text">{t('admin.performance.loading')}</p>;
  if (turn === null) return <p className="admin-tab-empty">{t('admin.performance.turnMissing')}</p>;

  const v = (key: string) => num(turn[key]);
  const routerSteps = (turn.router_steps as Row[] | undefined) ?? [];
  const latency = v('latency_ms'), model = v('model_ms'), tool = v('tool_ms');
  const total = v('total_ms'), guard = v('guard_ms'), resolve = v('placeholder_resolve_ms');
  const ttff = v('ttff_ms'), e2e = v('e2e_ms');
  const tail = total - (guard || 0) - (resolve || 0) - (latency || 0);
  const posting = e2e - ttff - total;
  type Seg = { name: string; ms: number; closes?: string; color: string };
  const segs: Seg[] = ([
    ...routerSteps.map((s) => ({
      name: t(`admin.latency.routerStep.label.${String(s.step_name)}`, { defaultValue: String(s.step_name) }),
      ms: num(s.step_ms),
      closes: ROUTER_STEP_CLOSES[String(s.step_name)] ? t(`admin.performance.closes.${ROUTER_STEP_CLOSES[String(s.step_name)]}`) : undefined,
      color: '#4A7FA8',
    })),
    { name: t('admin.performance.seg.placeholder'), ms: NaN, closes: t('admin.performance.closes.ttff', { value: formatMs(ttff) }), color: '#7A8A9C' },
    { name: t('admin.performance.seg.admission'), ms: guard, color: '#9FB3C8' },
    { name: t('admin.performance.seg.lookup'), ms: resolve, closes: v('poll_ms') > 0 ? t('admin.performance.closes.scanned', { value: formatMs(v('poll_ms')) }) : undefined, color: '#C98A12' },
    { name: t('admin.performance.seg.model'), ms: model, color: '#1F5F8B' },
    { name: t('admin.performance.seg.tool'), ms: tool, color: '#4A7FA8' },
    { name: t('admin.performance.seg.loopRest'), ms: latency - (model || 0) - (tool || 0), closes: t('admin.performance.closes.bedrock', { value: formatMs(latency) }), color: '#6E8FAE' },
    { name: t('admin.performance.seg.tail'), ms: tail, closes: t('admin.performance.closes.worker', { value: formatMs(total) }), color: '#B9C6D6' },
    { name: t('admin.performance.seg.posting'), ms: posting, closes: t('admin.performance.closes.e2e', { value: formatMs(e2e) }), color: '#7A8A9C' },
  ] as Seg[]).filter((s) => s.closes || (Number.isFinite(s.ms) && s.ms > 0));
  const barTotal = segs.reduce((s, x) => s + (Number.isFinite(x.ms) && x.ms > 0 ? x.ms : 0), 0);
  const verdict = turn.verdict as Row | null;
  const tools = (turn.tool_verdicts as Row[] | undefined) ?? [];

  return (
    <div className="perf-turn">
      <div className="perf-turn-head">
        <div>
          <h4>{t('admin.performance.turnTitle', { when: new Date(String(turn.created_at)).toLocaleString() })}</h4>
          <div className="admin-help-text">
            {[t(`admin.performance.path.${String(turn.path)}`), String(turn.intent), t(`admin.performance.outcome.${String(turn.outcome)}`), String(turn.assistant), String(turn.conversation_classification), turn.profile_version != null ? `v${String(turn.profile_version)}` : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
        {onOpenConversation && turn.channel_arn ? (
          <button type="button" className="btn-secondary" onClick={() => onOpenConversation(String(turn.channel_arn))}>
            {t('admin.performance.openConversation')}
          </button>
        ) : null}
      </div>
      <div className="perf-stat-grid">
        <div className="perf-stat"><span className={STAT_LABEL}>TTFF<InfoTooltip label={t('admin.performance.aboutMetric', { label: 'TTFF' })} content={t('admin.metrics.ttff_ms.description')} /></span><strong>{formatMs(ttff)}</strong></div>
        <div className="perf-stat"><span className={STAT_LABEL}>E2E<InfoTooltip label={t('admin.performance.aboutMetric', { label: 'E2E' })} content={t('admin.metrics.avg_e2e_ms.description')} /></span><strong>{formatMs(e2e)}</strong></div>
        <div className="perf-stat"><span className={STAT_LABEL}>{t('admin.performance.stat.worker')}<InfoTooltip label={t('admin.performance.aboutMetric', { label: t('admin.performance.stat.worker') })} content={t('admin.metrics.avg_total_ms.description')} /></span><strong>{formatMs(total)}</strong></div>
        <div className="perf-stat"><span className={STAT_LABEL}>{t('admin.performance.stat.inbound')}<InfoTooltip label={t('admin.performance.aboutMetric', { label: t('admin.performance.stat.inbound') })} content={t('admin.metrics.inbound_ms.description')} /></span><strong>{formatMs(v('inbound_ms'))}</strong></div>
        <div className="perf-stat"><span className={STAT_LABEL}>{t('admin.performance.column.cost')}<InfoTooltip label={t('admin.performance.aboutMetric', { label: t('admin.performance.column.cost') })} content={t('admin.metrics.cost_per_reply.description')} /></span><strong>{Number.isFinite(v('cost_usd')) ? `$${v('cost_usd').toFixed(4)}` : '—'}</strong></div>
        <div className="perf-stat"><span className={STAT_LABEL}>{t('admin.performance.stat.coldStart')}<InfoTooltip label={t('admin.performance.aboutMetric', { label: t('admin.performance.stat.coldStart') })} content={t('admin.metrics.cold_start_rate.description')} /></span><strong>{turn.cold_start ? t('admin.performance.yes') : t('admin.performance.no')}</strong></div>
      </div>
      {barTotal > 0 && (
        <div className="perf-bar" role="img" aria-label={t('admin.performance.turnBar')}>
          {segs.filter((s) => Number.isFinite(s.ms) && s.ms > 0).map((s, i) => <span key={i} style={{ width: `${(s.ms / barTotal) * 100}%`, background: s.color }} />)}
        </div>
      )}
      <table className="perf-steps">
        <thead><tr><th>{t('admin.performance.column.step')}</th><th>{t('admin.performance.column.took')}</th><th>{t('admin.performance.column.closes')}</th></tr></thead>
        <tbody>
          {segs.map((s, i) => (
            <tr key={i}>
              <td><i style={{ background: s.color }} />{s.name}</td>
              <td>{Number.isFinite(s.ms) && s.ms > 0 ? formatMs(s.ms) : ''}</td>
              <td className="perf-closes">{s.closes ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="perf-turn-panels">
        <div>
          <h5>{t('admin.performance.verdicts')}</h5>
          {verdict ? (
            <ul className="perf-kv">
              <li><span>{t('admin.performance.column.relevance')}</span><strong>{Number.isFinite(num(verdict.relevance_score)) ? `${num(verdict.relevance_score).toFixed(0)} · ${String(verdict.classification ?? '')}` : '—'}</strong></li>
              <li><span>{t('admin.performance.grounded')}</span><strong>{verdict.is_grounded == null ? t('admin.performance.notAssessed') : verdict.is_grounded ? t('admin.performance.supported', { used: verdict.used_passage_count ?? '—', retrieved: verdict.retrieved_passage_count ?? '—' }) : t('admin.performance.unsupported')}</strong></li>
              <li><span>{t('admin.performance.compliance')}</span><strong>{verdict.is_compliant == null ? t('admin.performance.notAssessed') : verdict.is_compliant ? t('admin.performance.noBreach') : (verdict.compliance_categories as string[] | null)?.join(', ')}</strong></li>
              {tools.map((tv, i) => (
                <li key={i}><span>{String(tv.tool_name)}</span><strong>{t(`admin.performance.toolOutcome.${String(tv.outcome)}`)}</strong></li>
              ))}
              <li><span>{t('admin.performance.judge')}</span><strong>{String(verdict.evaluator_model ?? '—')}</strong></li>
            </ul>
          ) : <p className="admin-help-text">{t('admin.performance.notJudged')}</p>}
        </div>
        <div>
          <h5>{t('admin.performance.spend')}</h5>
          <ul className="perf-kv">
            <li><span>{t('admin.performance.model')}</span><strong>{String(turn.bedrock_model ?? '—')}</strong></li>
            <li><span>{t('admin.performance.tokens')}</span><strong>{`${fmt(v('input_tokens'))} / ${fmt(v('output_tokens'))}`}</strong></li>
            {turn.task_id ? <li><span>{t('admin.performance.task')}</span><strong>{String(turn.task_id).slice(0, 8)}</strong></li> : null}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default PerformanceTab;
