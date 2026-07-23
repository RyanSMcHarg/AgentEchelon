import React from 'react';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import DistributionBar from './DistributionBar';
import Sparkline from './Sparkline';
import LineChart from './LineChart';
import { METRIC_TARGETS } from './metricTargets';
import { InfoTooltip, DocLink } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';
import type { AnalyticsResult } from '@ae/shared';

interface LatencyTabProps {
  data: AnalyticsResult | null;
  /** Web-vital / timer percentiles from client_events.performance. */
  pageLoadData?: AnalyticsResult | null;
  /** websocket_connected/disconnected/reconnected counts per day. */
  connectionHealthData?: AnalyticsResult | null;
  isLoading: boolean;
}

function latencyColor(ms: number): string {
  // Time-to-complete-response bands, sourced to Nielsen Norman Group response-time
  // limits (10s attention limit; ~30s abandon), NOT a self-imposed ceiling. An
  // agentic tool loop legitimately runs multiple Bedrock calls, so total time is
  // seconds. Perceived latency is judged separately by TTFF (<=1s). See
  // docs/LATENCY-TARGETS.md.
  if (ms <= 10000) return 'var(--status-good)';  // Good: within the 10s attention limit
  if (ms <= 30000) return 'var(--status-warn)';  // Warn: 10-30s (show progress; users tiring)
  return 'var(--status-bad)';                    // Bad: >30s (abandon threshold)
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Map raw web-vital metric names to display labels + good/needs-improvement
// thresholds. Other (custom timer) metrics render with the raw name and no
// threshold annotation.
const WEB_VITAL_META: Record<string, { label: string; goodMs: number; poorMs: number }> = {
  web_vital_ttfb: { label: 'Time to First Byte', goodMs: 800, poorMs: 1800 },
  web_vital_fcp:  { label: 'First Contentful Paint', goodMs: 1800, poorMs: 3000 },
  web_vital_lcp:  { label: 'Largest Contentful Paint', goodMs: 2500, poorMs: 4000 },
  web_vital_inp:  { label: 'Interaction to Next Paint', goodMs: 200, poorMs: 500 },
  // CLS is stored as value*1000 by the service so the table can still treat
  // it as a number — labelled separately so the unit is right.
  web_vital_cls:  { label: 'Cumulative Layout Shift (×1000)', goodMs: 100, poorMs: 250 },
};

const LatencyTab: React.FC<LatencyTabProps> = ({
  data,
  pageLoadData,
  connectionHealthData,
  isLoading,
}) => {
  // Response-type filter (by delivery_option). null = the default set (all NON-task response types, so
  // the perceived-single-reply headline excludes multi-step tasks); a Set = the operator's explicit
  // selection. Task turns show PER-TURN reply latency, not whole-task cycle time (a separate metric on
  // the Tasks / Effectiveness surface). Single-reply targets are shown only when no task type is selected.
  const [typeFilter, setTypeFilter] = React.useState<Set<string> | null>(null);

  if (isLoading) {
    return (
      <div className="admin-tab">
        <div className="skeleton skeleton--title" style={{ width: '32%' }} />
        <div className="skeleton skeleton--chart" />
        <div className="metric-cards-grid skeleton-grid">
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
        </div>
      </div>
    );
  }

  const rows = (data?.data ?? []) as Array<Record<string, unknown>>;

  // Aggregate metrics. Two corrections vs. the naive version:
  //  1) Filter by RESPONSE TYPE (delivery_option). The default excludes multi-step tasks: a task turn's
  //     total_ms / poll_ms on a heavy generation step (report / extraction) runs 20s-minutes and would
  //     drag the perceived single-reply headline. The operator can add task types back with the filter;
  //     task turns are PER-TURN reply latency (whole-task cycle time is measured on Tasks / Effectiveness).
  //  2) VOLUME-WEIGHT the averages + P95 by exchange_count, so one low-traffic slow group does not define
  //     "the" P95. (A true overall p95 is not recoverable from per-group p95 values; the traffic-weighted
  //     mean is the honest single-number summary — see the tooltip.)
  const isTaskType = (dt: string) => dt.toUpperCase().startsWith('TASK');
  const humanizeType = (dt: string) => dt.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const responseTypes = [...new Set(rows.map((r) => String(r.delivery_option || 'unknown')))].sort();
  const defaultTypes = new Set(responseTypes.filter((dt) => !isTaskType(dt)));
  const activeTypes = typeFilter ?? defaultTypes;
  const toggleType = (dt: string) => setTypeFilter((prev) => {
    const next = new Set(prev ?? defaultTypes);
    if (next.has(dt)) next.delete(dt); else next.add(dt);
    return next;
  });
  const anyTaskSelected = [...activeTypes].some(isTaskType);
  const scopeIsSingle = !anyTaskSelected; // single-reply targets apply only when no task type is selected
  const scopeMatch = (r: Record<string, unknown>) => activeTypes.has(String(r.delivery_option || 'unknown'));
  const withLatency = rows.filter((r) => r.avg_total_ms != null && Number(r.avg_total_ms) > 0 && scopeMatch(r));
  const totalExchanges = withLatency.reduce((s, r) => s + (Number(r.exchange_count) || 0), 0);
  const wavg = (field: string): number => {
    if (totalExchanges <= 0) {
      return withLatency.length > 0 ? withLatency.reduce((s, r) => s + Number(r[field] || 0), 0) / withLatency.length : 0;
    }
    return withLatency.reduce((s, r) => s + Number(r[field] || 0) * (Number(r.exchange_count) || 0), 0) / totalExchanges;
  };
  const avgTotal = wavg('avg_total_ms');
  const avgBedrock = wavg('avg_bedrock_ms');
  const avgPoll = wavg('avg_poll_ms');
  const p95Total = wavg('p95_total_ms');

  // Time to first feedback (TTFF) is the PRIMARY perceived-latency metric: the
  // placeholder-update delivery makes it the latency the user actually waits on
  // (docs/LATENCY-TARGETS.md). There is no token streaming, so TTFF is the delay
  // until the "One moment…" placeholder appears (acknowledgment latency) — the
  // only pre-answer signal distinct from total time. The latency query derives it
  // from the exchange's response_latency_ms (placeholder_at - user_message_at).
  const withTtff = rows.filter((r) => r.avg_ttff_ms != null && Number(r.avg_ttff_ms) > 0 && scopeMatch(r));
  const avgTtff = withTtff.length > 0
    ? withTtff.reduce((sum, r) => sum + Number(r.avg_ttff_ms), 0) / withTtff.length
    : 0;
  const ttffCaptured = avgTtff > 0;

  // Full latency set (docs/LATENCY-TARGETS.md). Same two corrections as wavg — EXCLUDE multi-step
  // tasks (base on withLatency) and traffic-WEIGHT by exchange_count — plus average only over rows
  // where the metric is present (> 0), so a multi-step task's minutes-long e2e_ms never pollutes the
  // headline and pre-migration/absent values do not dilute the mean during rollout.
  const favg = (field: string): number => {
    const rs = withLatency.filter((r) => r[field] != null && Number(r[field]) > 0);
    const w = rs.reduce((s, r) => s + (Number(r.exchange_count) || 0), 0);
    if (w <= 0) return rs.length > 0 ? rs.reduce((s, r) => s + Number(r[field]), 0) / rs.length : 0;
    return rs.reduce((s, r) => s + Number(r[field]) * (Number(r.exchange_count) || 0), 0) / w;
  };
  // E2E = user message -> FINAL answer (the true perceived wait); null until the final-answer update
  // is folded, so treat absent as "not captured yet" like TTFF.
  const avgE2e = favg('avg_e2e_ms');
  const e2eCaptured = avgE2e > 0;
  // Bedrock (latency_ms) split: model inference vs in-loop tool execution; plus the inbound hop.
  const avgModel = favg('avg_model_ms');
  const avgTool = favg('avg_tool_ms');
  const avgInbound = favg('avg_inbound_ms');

  // Round the upper-bound to nice numbers for the distribution rail.
  const distMax = p95Total > 0 ? Math.ceil((p95Total * 1.15) / 500) * 500 : 6000;

  // Per-date trend for the SLO chart: rows are per (date, agent, delivery), so
  // collapse to one point per date — mean of avg_total, worst (max) of p95.
  const byDate = new Map<string, { avgSum: number; avgCount: number; p95Max: number }>();
  for (const r of withLatency) {
    const d = String(r.date || '');
    if (!d) continue;
    const e = byDate.get(d) || { avgSum: 0, avgCount: 0, p95Max: 0 };
    e.avgSum += Number(r.avg_total_ms || 0);
    e.avgCount += 1;
    e.p95Max = Math.max(e.p95Max, Number(r.p95_total_ms || 0));
    byDate.set(d, e);
  }
  const latencyTrendDates = [...byDate.keys()].sort();
  const avgSeries = latencyTrendDates.map((d) => {
    const e = byDate.get(d)!;
    return e.avgCount ? e.avgSum / e.avgCount : 0;
  });
  const p95Series = latencyTrendDates.map((d) => byDate.get(d)!.p95Max);

  // ---------- Page-load percentiles ----------
  const pageLoadRows = pageLoadData?.data ?? [];

  // ---------- Connection health ----------
  const connRows = connectionHealthData?.data ?? [];
  const totalConn = connRows.reduce((s, r) => s + Number(r.connected || 0), 0);
  const totalDisc = connRows.reduce((s, r) => s + Number(r.disconnected || 0), 0);
  const totalRecon = connRows.reduce((s, r) => s + Number(r.reconnected || 0), 0);
  const reconTrend = connRows.map((r) => Number(r.reconnected || 0));

  return (
    <div className="admin-tab">
      <h3>Response Latency</h3>
      <p className="admin-tab-description">
        Latency breakdown across the message journey. <strong>TTFF</strong> (time to first feedback)
        is the delay to the "One moment…" placeholder; <strong>E2E</strong> is the full user wait to
        the final answer, the real perceived latency. <strong>Total</strong> is server compute only
        (processor entry to answer posted) and excludes the inbound hop, cold start, and delivery, so
        it is a lower bound on the wait. Bedrock time is split into <strong>Model</strong> (inference)
        and <strong>Tool</strong> (in-loop RAG / context reads). Use the response-type filter to include
        or exclude delivery types; the default excludes multi-step tasks (whose per-turn latency on a
        heavy generation step is much larger). Task turns show <strong>per-turn</strong> reply latency,
        not whole-task cycle time. Values are traffic-weighted.{' '}
        <DocLink href={DOC_LINKS.messageFlow}>Message flow</DocLink>
        {' · '}
        <DocLink href={DOC_LINKS.latencyTargets}>Latency targets</DocLink>
      </p>

      {responseTypes.length > 1 && (
        <div
          role="group"
          aria-label="Response-type filter"
          style={{ display: 'flex', gap: '8px', margin: 'var(--space-2, 8px) 0', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <span style={{ color: 'var(--text-secondary, #666)', fontSize: '0.85em' }}>Response type:</span>
          {responseTypes.map((dt) => {
            const on = activeTypes.has(dt);
            return (
              <button
                key={dt}
                type="button"
                aria-pressed={on}
                onClick={() => toggleType(dt)}
                title={isTaskType(dt) ? 'Multi-step task turns: per-turn reply latency, not whole-task cycle time' : undefined}
                style={{
                  padding: '3px 10px',
                  borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border, #ccc)',
                  cursor: 'pointer',
                  fontSize: '0.85em',
                  fontWeight: on ? 600 : 400,
                  background: on ? 'var(--accent, #2563eb)' : 'transparent',
                  color: on ? 'var(--accent-contrast, #fff)' : 'var(--text-primary, inherit)',
                }}
              >
                {humanizeType(dt)}
              </button>
            );
          })}
          {anyTaskSelected && (
            <span style={{ color: 'var(--text-secondary, #666)', fontSize: '0.8em' }}>
              task turns included - per-turn latency; single-reply targets do not apply
            </span>
          )}
        </div>
      )}

      {avgTotal > 0 && (
        <div className="admin-tab-banner" style={{ alignItems: 'stretch', flexDirection: 'column' }}>
          <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
            <span className="admin-tab-banner-label-text">Total latency · distribution</span>
          </div>
          <DistributionBar
            min={0}
            max={distMax}
            unit="ms"
            markers={[
              { value: Math.round(avgPoll), label: 'Poll', intensity: 'secondary' },
              { value: Math.round(avgBedrock), label: 'Bedrock', intensity: 'secondary' },
              { value: Math.round(avgTotal), label: 'Avg', intensity: 'primary' },
              { value: Math.round(p95Total), label: 'P95', intensity: 'primary' },
            ]}
          />
        </div>
      )}

      <div className="admin-metrics-row">
        <MetricCard
          title="TTFF"
          value={ttffCaptured ? formatMs(avgTtff) : 'n/a'}
          subtitle={ttffCaptured ? 'time to placeholder' : 'no paired exchanges yet'}
          target={scopeIsSingle ? METRIC_TARGETS.ttff_ms : undefined}
          rawValue={ttffCaptured ? avgTtff : undefined}
          tooltip="Time to first feedback: the delay from the user's message to the assistant's placeholder appearing. There is no token streaming, so this acknowledgment latency is the perceived wait — distinct from total time (the completed answer)."
        />
        <MetricCard
          title="E2E"
          value={e2eCaptured ? formatMs(avgE2e) : 'n/a'}
          subtitle={e2eCaptured ? 'user → final answer' : 'no completed answers yet'}
          target={scopeIsSingle ? METRIC_TARGETS.avg_e2e_ms : undefined}
          rawValue={e2eCaptured ? avgE2e : undefined}
          tooltip="End-to-end: the full wait from the user's message to the FINAL answer replacing the placeholder (agent_final_at − user_message_at, on the Chime clock, so skew-free). The real user-perceived latency — it includes the inbound hop and cold start that Total (server compute only) omits."
        />
        <MetricCard title="Avg Total" value={formatMs(avgTotal)} target={scopeIsSingle ? METRIC_TARGETS.avg_total_ms : undefined} rawValue={avgTotal} tooltip="Server compute for the turn, from processor entry to the answer being posted (history load + tool loop + guardrail + post). NOT the user's wall-clock wait: it excludes the inbound hop, cold start, and browser delivery, so it is a lower bound on perceived latency — see E2E for the full wait." />
        <MetricCard title="Avg Model" value={formatMs(avgModel)} target={scopeIsSingle ? METRIC_TARGETS.avg_bedrock_ms : undefined} rawValue={avgModel} tooltip="Model-inference time: the sum of the Converse (Bedrock) call durations in the tool loop. The pure model share of the former 'Bedrock' number, distinct from tool execution (see Avg Tool)." />
        <MetricCard title="Avg Tool" value={avgTool > 0 ? formatMs(avgTool) : 'n/a'} rawValue={avgTool > 0 ? avgTool : undefined} tooltip="In-loop tool-execution time (RAG / S3 company-context reads). The other half of the former 'Bedrock' number — a RAG-heavy turn shows here, not as slow model inference." />
        <MetricCard title="Inbound" value={avgInbound > 0 ? formatMs(avgInbound) : 'n/a'} rawValue={avgInbound > 0 ? avgInbound : undefined} tooltip="User message → async processor entry (routing / queue / cold start). Cross-clock and approximate (Chime start vs server-clock entry), clamped to ≥ 0. The front-of-turn latency that Total omits." />
        <MetricCard
          title="Avg Polling"
          value={formatMs(avgPoll)}
          tooltip="Mean time the async processor spent polling for the completed answer before swapping it in for the placeholder, for single-reply deliveries only (multi-step tasks are excluded — their polling spans the whole task). Part of total latency, distinct from model inference."
        />
        <MetricCard title="P95 Total" value={formatMs(p95Total)} target={scopeIsSingle ? METRIC_TARGETS.p95_total_ms : undefined} rawValue={p95Total} tooltip="95th-percentile single-reply latency, traffic-weighted across groups (excludes multi-step tasks). Not the exact global p95 — a per-group tail summary — but a stable headline rather than the single worst group." />
      </div>

      {latencyTrendDates.length >= 2 && (
        <div className="admin-section">
          <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-2)' }}>
            <span className="admin-tab-banner-label-text">Latency vs target · trend</span>
          </div>
          <LineChart
            label="Latency trend against SLO targets"
            categories={latencyTrendDates.map((d) => d.slice(5))}
            formatY={formatMs}
            series={[
              { label: 'P95 total', points: p95Series, color: 'var(--accent-500)' },
              { label: 'Avg total', points: avgSeries, color: 'var(--status-good)' },
            ]}
            referenceLines={[
              { value: METRIC_TARGETS.p95_total_ms.target, label: `P95 target ${formatMs(METRIC_TARGETS.p95_total_ms.target)}`, color: 'var(--status-bad)' },
              { value: METRIC_TARGETS.avg_total_ms.target, label: `Avg target ${formatMs(METRIC_TARGETS.avg_total_ms.target)}`, color: 'var(--status-warn)' },
            ]}
          />
          <div className="admin-latency-legend">
            <span style={{ color: 'var(--accent-500)' }}>● P95 total</span>
            <span style={{ color: 'var(--status-good)' }}>● Avg total</span>
            <span style={{ color: 'var(--status-bad)' }}>--- targets (good is below)</span>
          </div>
        </div>
      )}

      <div className="admin-latency-legend">
        <span style={{ color: 'var(--status-good)' }}>Good (&lt;2s)</span>
        <span style={{ color: 'var(--status-warn)' }}>Acceptable (2-5s)</span>
        <span style={{ color: 'var(--status-bad)' }}>Slow (&gt;5s)</span>
      </div>

      <DataTable
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'agent_type', label: 'Assistant' },
          {
            key: 'delivery_option',
            label: (
              <>
                Delivery
                <InfoTooltip
                  label="About Delivery"
                  content="How the reply was delivered to the user — typically the placeholder-then-update pattern, where a fast placeholder bubble is replaced in place by the final answer. See the Message delivery doc linked above."
                />
              </>
            ),
          },
          { key: 'exchange_count', label: 'Exchanges' },
          {
            key: 'avg_ttff_ms',
            label: (
              <>
                TTFF
                <InfoTooltip
                  label="About TTFF"
                  content="Time to first feedback — user message to the placeholder appearing. No token streaming, so this is the perceived wait, separate from total time. Blank for DIRECT/unpaired rows."
                />
              </>
            ),
            render: (v) => (v == null ? <span style={{ opacity: 0.5 }}>—</span> : formatMs(Number(v))),
          },
          {
            key: 'avg_total_ms',
            label: 'Avg Total',
            render: (v) => (
              <span style={{ color: latencyColor(Number(v)), fontWeight: 600 }}>
                {formatMs(Number(v))}
              </span>
            ),
          },
          {
            key: 'avg_bedrock_ms',
            label: 'Avg Bedrock',
            render: (v) => formatMs(Number(v)),
          },
          {
            key: 'avg_poll_ms',
            label: 'Avg Poll',
            render: (v) => formatMs(Number(v)),
          },
          {
            key: 'p95_total_ms',
            label: 'P95 Total',
            render: (v) => (
              <span style={{ color: latencyColor(Number(v)), fontWeight: 600 }}>
                {formatMs(Number(v))}
              </span>
            ),
          },
        ]}
        data={rows}
        emptyMessage="No latency data available for this period. Latency is recorded when assistants respond via the async processor."
      />

      {/* ---------- Page-load (web-vitals) ---------- */}
      <div className="admin-section">
        <h3>Page load · web vitals</h3>
        <p className="admin-tab-description">
          Real-user percentiles from the frontend <code>web-vitals</code> capture.
          Targets are Google's "Good" / "Needs Improvement" thresholds.
        </p>
        {pageLoadRows.length === 0 ? (
          <p className="admin-tab-empty">
            No page-load samples yet. Populates as users open the app and the
            <code> /events</code> Lambda starts receiving performance batches.
          </p>
        ) : (
          <div className="admin-pageload-stack">
            {pageLoadRows.map((r) => {
              const metric = String(r.metric || '');
              const meta = WEB_VITAL_META[metric];
              const label = meta?.label || metric;
              const p50 = Math.round(Number(r.p50_ms || 0));
              const p95 = Math.round(Number(r.p95_ms || 0));
              const p99 = Math.round(Number(r.p99_ms || 0));
              const avg = Math.round(Number(r.avg_ms || 0));
              const samples = Number(r.sample_count || 0);
              const upper = Math.max(p99, meta?.poorMs ?? 0) * 1.2 || 1000;
              const distMax = Math.ceil(upper / 250) * 250;
              return (
                <div key={metric} className="admin-pageload-row">
                  <div className="admin-pageload-row-head">
                    <div>
                      <div className="admin-pageload-row-label">{label}</div>
                      <div className="admin-pageload-row-sub">
                        {samples.toLocaleString()} samples · avg {p50 < 1000 ? `${avg}ms` : `${(avg / 1000).toFixed(2)}s`}
                      </div>
                    </div>
                    {meta && (
                      <div className="admin-pageload-row-thresholds">
                        <span className="admin-pageload-threshold admin-pageload-threshold--good">
                          ≤{meta.goodMs}
                        </span>
                        <span className="admin-pageload-threshold admin-pageload-threshold--poor">
                          {'>'}{meta.poorMs}
                        </span>
                      </div>
                    )}
                  </div>
                  <DistributionBar
                    min={0}
                    max={distMax}
                    unit="ms"
                    markers={[
                      { value: p50, label: 'P50', intensity: 'secondary' },
                      { value: p95, label: 'P95', intensity: 'primary' },
                      { value: p99, label: 'P99', intensity: 'primary' },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---------- Connection health ---------- */}
      <div className="admin-section">
        <h3>WebSocket connection health</h3>
        <p className="admin-tab-description">
          A spike in <strong>reconnects</strong> is usually the first sign of
          Chime instability or browser-tab WS suspension at scale.
        </p>
        <div className="admin-tab-banner admin-tab-banner--compact">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">Reconnects · trailing</span>
            <span className="admin-tab-banner-label-value">{totalRecon.toLocaleString()}</span>
          </div>
          {reconTrend.length >= 2 ? (
            <Sparkline data={reconTrend} width={320} height={56} label="Reconnects per day" />
          ) : (
            <span className="admin-tab-banner-empty">No connection events yet</span>
          )}
        </div>
        <div className="admin-metrics-row">
          <MetricCard
            title="Connects (window)"
            value={totalConn.toLocaleString()}
            tooltip="New WebSocket connections opened over the selected window."
          />
          <MetricCard
            title="Disconnects (window)"
            value={totalDisc.toLocaleString()}
            tooltip="WebSocket connections closed over the window — tab close, network drop, or server-side close."
          />
          <MetricCard
            title="Reconnects (window)"
            value={totalRecon.toLocaleString()}
            subtitle={totalConn > 0 ? `${((totalRecon / totalConn) * 100).toFixed(1)}% reconnect rate` : undefined}
            tooltip="WebSocket reconnections over the window. A spike is often the first sign of Chime instability or browser-tab WS suspension at scale."
          />
        </div>
        {connRows.length > 0 && (
          <DataTable
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'connected', label: 'Connected', render: (v) => Number(v).toLocaleString() },
              { key: 'disconnected', label: 'Disconnected', render: (v) => Number(v).toLocaleString() },
              { key: 'reconnected', label: 'Reconnected', render: (v) => Number(v).toLocaleString() },
            ]}
            data={connRows}
          />
        )}
      </div>
    </div>
  );
};

export default LatencyTab;
