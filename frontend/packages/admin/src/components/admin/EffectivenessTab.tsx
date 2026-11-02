import i18n from '@ae/shared/i18n';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
import PerformanceFilterBar, { type PerformanceFilters } from './PerformanceFilters';
import DeliveredDocumentsPanel from './DeliveredDocumentsPanel';
import WorkflowTrajectoryPanel from './WorkflowTrajectoryPanel';
import SafetyReadingsPanel from './SafetyReadingsPanel';
import FrustrationPanel from './FrustrationPanel';
import RetrievalSourcesPanel from './RetrievalSourcesPanel';
import ToolOutcomesPanel from './ToolOutcomesPanel';
import TemplateOutcomesPanel from './TemplateOutcomesPanel';
import IntentStepBreakdown from './IntentStepBreakdown';
import { withIntentParam } from './assistantLinks';
import { InfoTooltip, DocLink, GuideLinks, guide } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';
import { lambdaFunctionsSearchUrl } from '../../services/awsConsole';
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
  /** WHICH ROLE and WHICH VERSION. Owned by the dashboard because the L0 rollup is fetched there:
   *  held here they would filter the drill and leave the table above it unfiltered. */
  /**
   * THE FILTER SET THIS SURFACE SHARES WITH LATENCY.
   *
   * They read ONE population two ways - how fast a turn was, and how good it was - and used to cut
   * it with two different controls: pills there, a select and a number input here, sharing only the
   * date range. Narrowing one and moving to the other changed the population silently.
   */
  filters: PerformanceFilters;
  onFiltersChange: (next: PerformanceFilters) => void;
  /** The rows the bar derives its options from: the L0 rollup, which carries every axis. */
  filterRows?: Record<string, unknown>[];
  /**
   * Open the Latency surface over the SAME population this view is showing.
   *
   * The two surfaces read one population two ways - how fast a turn was, and how good it was - and
   * already share a filter set. What they did not share was a way across: a reader who found a slow
   * intent here had to remember it, switch tab and re-narrow by hand, which is the point at which the
   * two views stop describing the same rows.
   */
  onOpenLatency?: (intent: string) => void;
  /** Open the flagged surface. The signals themselves already live there. */
  onOpenFlagged?: () => void;
  /** Rendered as a drill of the Performance view, which owns the filter bar. */
  embedded?: boolean;
}

type Row = Record<string, unknown>;

export type Drill =
  | { level: 0 }
  | { level: 1; intent: string; step?: string }
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

/**
 * A RATE IS NOT REPORTABLE OVER A POPULATION THAT CANNOT SUPPORT IT.
 *
 * Measured on this surface, 30-day window: `image_generation` carried ONE exchange and `process_lookup`
 * five, beside intents carrying hundreds - every rate drawn to one decimal place, at the same visual
 * weight, and feeding the same worst-first ranking. Publishing the denominator (which this table already
 * does, everywhere) tells a reader the population; it does not stop them acting on a figure the
 * population cannot support, and the eye does not discount automatically.
 *
 * TEN IS A DECISION, NOT A DERIVATION, and it must not be described as one. It is the line below which a
 * per-intent rate on this console is treated as unreportable. It is not a significance test and implies
 * no confidence level - the same honesty LatencyTab takes with `P95_STABLE_MIN`, which it labels a rule
 * of thumb rather than an authoritative threshold.
 */
const MIN_RATE_POPULATION = 10;

/**
 * EACH RATE HAS ITS OWN POPULATION, AND IT IS NOT THE VOLUME COLUMN.
 *
 * Relevance averages the turns that were SCORED, task execution the flows that were OPENED, user signal
 * the replies somebody RATED, tools the calls actually MADE. Only routing confidence is over every
 * exchange, because every exchange is classified.
 *
 * Suppressing all five on `exchange_count` would be a different and wrong rule: it would hide a relevance
 * average over 200 scored turns because the intent had few exchanges, and show one over 2 because it had
 * many. The denominator each cell already prints beside itself is the one that governs it.
 */
const RATE_POPULATION: Record<string, string> = {
  avg_confidence: 'exchange_count',
  avg_relevance: 'relevance_scored_count',
  task_completion_rate: 'task_flow_count',
  user_flag_rate: 'user_rated_count',
  tool_error_rate: 'tool_calls',
  // The L1 card reports the POSITIVE share of the same votes the table reports the flag rate of. Two
  // readings of one population, so it is entered here rather than special-cased on the card: a card
  // that works out its own population is a card that can disagree with the cell it drills into.
  user_positive_rate: 'user_rated_count',
};

/**
 * The five rates the L0 table draws.
 *
 * `countUnderpopulated` reads THIS and not every key in `RATE_POPULATION`, because the map also carries
 * a rate only a drill card shows. Counting that one would tell a reader the table is hiding a cell it
 * never had - and would count one thin population twice, since user signal and user ratings are two
 * readings of the same votes.
 */
const L0_RATE_COLUMNS = [
  'avg_confidence', 'avg_relevance', 'task_completion_rate', 'user_flag_rate', 'tool_error_rate',
];

/**
 * THE THREE AXES `qualityRank` ACTUALLY READS - and it is only three.
 *
 * User signal and tool errors are suppressed and marked like the rest, because an unsupportable figure
 * is unsupportable wherever it is drawn, but they have never fed the worst-first order. Telling a reader
 * that a marked *User signal* cell is "ranking this intent" would be a false statement in the copy
 * written to stop false readings, so every sentence about ranking is scoped to this set.
 */
const RANKING_RATES = new Set(['avg_confidence', 'avg_relevance', 'task_completion_rate']);

/** How many observations a given rate on a given row is computed over. NaN when the row does not say. */
function populationFor(row: Row, key: string): number {
  const field = RATE_POPULATION[key];
  return field ? num(row[field]) : NaN;
}

/**
 * Is this rate computed over too few observations to report?
 *
 * A population of ZERO is not underpopulated - it is nothing to measure, which each cell already renders
 * as a dash with its own reason ("no task flows", "nobody rated"). Those are different statements and
 * collapsing them would lose the one the reader needs.
 */
function isUnderpopulated(row: Row, key: string): boolean {
  const n = populationFor(row, key);
  if (!Number.isFinite(n) || n <= 0) return false;
  return n < MIN_RATE_POPULATION && Number.isFinite(num(row[key]));
}

/**
 * Every underpopulated rate in the window, for the line that states what the option is doing.
 *
 * `ranking` is counted separately because only three of the five rates feed the order. A window whose
 * only thin figures are user signal and tool errors changes nothing about the ranking, and the line must
 * not say it does.
 */
function countUnderpopulated(rows: Row[]): { cells: number; intents: number; ranking: number } {
  const intents = new Set<string>();
  let cells = 0;
  let ranking = 0;
  for (const row of rows) {
    for (const key of L0_RATE_COLUMNS) {
      if (isUnderpopulated(row, key)) {
        cells += 1;
        if (RANKING_RATES.has(key)) ranking += 1;
        intents.add(String(row.intent));
      }
    }
  }
  return { cells, intents: intents.size, ranking };
}

/**
 * THE SAME RULE, FOR A DRILL CARD - AND FOR EVERY RATE CARD, NOT TWO OF THEM.
 *
 * The L1 cards are one click from the L0 table and were rendering the unqualified figure with full
 * status coloring: an intent whose routing confidence reads "too few to report" on the table showed a
 * red *Routing confidence 30* card the moment it was opened. A rule that a reader can step around by
 * clicking is not a rule, and the drill is the FIRST thing a reader clicks when a row looks wrong.
 *
 * It was then applied to routing confidence and relevance only, so task execution, user ratings and the
 * tool error rate still stepped around it: an intent with two tool calls read "too few to report" in the
 * table and a colored "50.0% · 2 calls" on the card one click away. Every rate card goes through here.
 *
 * Suppressed, the card drops `rawValue`/`target` as well as the number - keeping the color would paint a
 * verdict on a figure being withheld. The population moves into the subtitle, where it is visible
 * without a hover.
 *
 * NOTHING MEASURED IS NOT A GOOD SCORE, AND IT IS A DIFFERENT STATEMENT FROM "TOO FEW". `tool_error_rate`
 * is null where no tool ran, and a card handed the target anyway painted a green 0.0% - a verdict on
 * work that never happened, beside an L0 cell that renders a dash for the same row. So an empty
 * population drops the target with the number and the card says what it has: nothing.
 *
 * `value` is for a card whose figure the registry cannot format (user ratings reads "66.7% positive",
 * and "Nobody rated" when there are no votes). It is the card's own words in both branches.
 */
function rateCardProps(
  row: Row,
  key: string,
  suppress: boolean,
  opts: { targetKey?: string; value?: string; subtitle?: string } = {},
): { value: string; subtitle?: string; rawValue?: number; target?: typeof METRIC_TARGETS[string] } {
  const { targetKey, subtitle } = opts;
  const n = populationFor(row, key);
  const under = isUnderpopulated(row, key);
  const shown = opts.value ?? (targetKey ? fmtBy(row[key], targetKey) : '—');

  if (under && suppress) {
    return {
      value: i18n.t('admin.effectiveness.tooFewToReport'),
      subtitle: i18n.t('admin.effectiveness.lowNCardHidden', { count: n, min: MIN_RATE_POPULATION }),
    };
  }
  // Either nothing was observed or the row carries no figure. Both are "no data", never a rate - so a
  // card with no `value` of its own falls back to the dash the L0 cell prints for the same row, rather
  // than to the registry's formatting of a zero that means "nothing ran".
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(num(row[key]))) {
    return { value: opts.value ?? '—', subtitle };
  }
  return {
    value: shown,
    subtitle: under
      ? `${subtitle ? `${subtitle} · ` : ''}${i18n.t('admin.effectiveness.lowNCardShown', { count: n, min: MIN_RATE_POPULATION })}`
      : subtitle,
    rawValue: num(row[key]),
    target: targetKey ? METRIC_TARGETS[targetKey] : undefined,
  };
}

/**
 * A rate cell that knows its own population.
 *
 * SUPPRESSED: the number is replaced and the reason is stated. The count beside it STAYS, and so does the
 * drill - hiding the denominator as well would be worse than the status quo, because a reader could no
 * longer tell a suppressed rate from an absent one.
 *
 * SHOWN: an underpopulated rate is still MARKED. The option controls whether the number is legible, never
 * whether the reader is told the population cannot support it. An option that could restore a surface
 * reading as confident would be the defect this was built for, wearing a checkbox.
 *
 * Every sentence here is copy (`admin.effectiveness.lowN*`), with plurals chosen by i18next from the
 * count, never assembled from English fragments: the assembled version read "1 rates across 2 intent
 * are shown", and worse in any other language.
 */
function RateCell({
  row, colKey, value, targetKey, suppress, fallback = '—', suffix,
}: {
  row: Row;
  colKey: string;
  value: unknown;
  targetKey: string;
  suppress: boolean;
  fallback?: string;
  suffix?: React.ReactNode;
}) {
  const { t: translate } = useTranslation();
  const n = populationFor(row, colKey);
  const under = isUnderpopulated(row, colKey);
  // Only three of the five rates feed the worst-first order, so only those three may say so.
  const ranks = RANKING_RATES.has(colKey);

  if (under && suppress) {
    const why = translate('admin.effectiveness.lowNCellHidden', { count: n, min: MIN_RATE_POPULATION });
    const order = translate(ranks ? 'admin.effectiveness.lowNCellHiddenRanks' : 'admin.effectiveness.lowNCellNoRank');
    return (
      <span>
        <span
          style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}
          title={`${why} ${order}`}
        >
          {translate('admin.effectiveness.tooFewToReport')}
        </span>
        {suffix}
      </span>
    );
  }

  return (
    <span>
      <StatusValue value={value} targetKey={targetKey} fallback={fallback} />
      {under && (
        <span
          style={{ color: 'var(--status-warn)', fontWeight: 600, fontSize: 'var(--text-sm)' }}
          title={`${translate('admin.effectiveness.lowNCellShown', { count: n, min: MIN_RATE_POPULATION })} ${translate(ranks ? 'admin.effectiveness.lowNCellShownRanks' : 'admin.effectiveness.lowNCellNoRank')}`}
        >
          {' '}⚠ n={n}
        </span>
      )}
      {suffix}
    </span>
  );
}

/** A metric value rendered in its good/warn/bad color, with the registry's formatter + glyph. */
function StatusValue({ value, targetKey, fallback = '—' }: { value: unknown; targetKey: string; fallback?: string }) {
  const { t: translate } = useTranslation();
  const n = num(value);
  const t = METRIC_TARGETS[targetKey];
  if (!Number.isFinite(n) || !t) return <span style={{ color: 'var(--status-neutral)' }}>{fallback}</span>;
  const status = evaluateTarget(n, t);
  const text = t.format ? t.format(n) : `${n}${t.unit ?? ''}`;
  return (
    <span style={{ color: STATUS_VAR[status], fontWeight: 600 }} title={translate('admin.effectiveness.target', { lower: t.direction === 'lower' ? '≤' : '≥', target: t.format ? t.format(t.target) : t.target })}>
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
  const { t: translate } = useTranslation();
  const arn = channelArn ? String(channelArn) : '';
  if (!arn || !onOpen) return <span style={{ color: 'var(--status-neutral)' }}>—</span>;
  return (
    <button
      className="btn-link"
      title={translate('admin.effectiveness.openTheRawConversationLog')}
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
 * RELEVANCE AND TASK EXECUTION ARE TWO COLUMNS, NOT ONE COLUMN THAT SWITCHES.
 *
 * This used to be a single "Execution" cell that showed the completion rate for intents whose traffic
 * was mostly task-shaped and the relevance score for the rest. Two intents in that column were
 * therefore not comparable: which number you got depended on which shape a row's traffic happened to
 * favour, and the cell label was the only thing telling you the question had changed underneath you.
 *
 * They answer different questions and belong side by side:
 *
 *   Relevance       was the answer any good?     EVERY message, inside a task or not
 *   Task execution  did the work finish?          only intents that open tasks; blank otherwise
 *
 * Blank rather than zero for an intent with no tasks. An intent that never opens one has no task
 * execution to report, and a 0% there would read as "it failed every time".
 */
function taskExecution(row: Row): { flows: number; completed: number; failed: number; abandoned: number; running: number } | null {
  const flows = num(row.task_flow_count) || 0;
  if (!flows) return null;
  return {
    flows,
    completed: num(row.task_completed) || 0,
    failed: num(row.task_failed) || 0,
    abandoned: num(row.task_abandoned) || 0,
    running: num(row.task_running) || 0,
  };
}

/** Worst-first (D2): rank by the WORST quality axis, so the axis that surfaces an intent is the reason
 *  it reads red. Relevance always counts; task completion only where tasks exist, so an intent without
 *  them is not ranked against a number it cannot have. Ties break on volume (more traffic first).
 *
 *  A SUPPRESSED RATE MUST NOT RANK, WHICH IS THE HALF THAT MATTERS. Refusing to print a number and then
 *  putting the row at the top BECAUSE of that number is worse than printing it: the reader sees "too few
 *  to report" at position one and reads the position as the finding. A row whose every axis is suppressed
 *  falls to the unranked tail, which is the behavior an intent with no quality data already has.
 *
 *  With suppression off, every axis ranks exactly as it did before - and each underpopulated cell carries
 *  its ⚠ marker, so the order is legible rather than merely restored. */
function qualityRank(row: Row, suppress: boolean): number {
  const axis = (key: string, targetKey: string, applies = true): number | null => {
    if (!applies) return null;
    if (suppress && isUnderpopulated(row, key)) return null;
    const status = statusOf(num(row[key]), targetKey);
    return status == null ? null : RANK[status];
  };
  const ranks = [
    axis('avg_confidence', 'intent_confidence'),
    axis('avg_relevance', 'relevance_score'),
    axis('task_completion_rate', 'task_completion_rate', taskExecution(row) != null),
  ].filter((r): r is number => r != null);
  return ranks.length ? Math.min(...ranks) : 3; // unknown quality sorts after ranked rows
}

// ---- L0 dashboard ----------------------------------------------------------------------------------
const L0Dashboard: React.FC<{
  rows: Row[];
  onPick: (intent: string) => void;
  /** Owned by the tab, not by this table: L0Dashboard unmounts on a drill, and a reader who switched
   *  suppression off to look at the numbers should not find it silently back on when they press Back.
   *  The drill position is lifted for the same reason. */
  hideLowN: boolean;
  setHideLowN: (v: boolean) => void;
}> = ({ rows, onPick, hideLowN, setHideLowN }) => {
  const { t: translate } = useTranslation();
  const ranked = useMemo(
    () => [...rows].sort(
      (a, b) => qualityRank(a, hideLowN) - qualityRank(b, hideLowN) || num(b.exchange_count) - num(a.exchange_count),
    ),
    [rows, hideLowN],
  );

  // What the option is DOING to this window, counted from the rows rather than asserted. A control whose
  // effect a reader has to infer by comparing two views is a control that gets misread.
  const low = useMemo(() => countUnderpopulated(rows), [rows]);

  /**
   * Column header with an inline "what is this / how to use it" tooltip.
   *
   * Takes the column's KEY and resolves both halves from the locale file, rather than taking two strings.
   * A header and its tooltip are one unit of copy - a translator needs to see them together, and passing
   * them separately is what let the label be converted while the tooltip stayed English.
   */
  const hdr = (col: string) => {
    const label = translate(`admin.effectiveness.column.${col}.label`);
    // A column that prints a metric is defined by the glossary entry its card uses, so a column and a
    // card cannot describe one figure two ways. Only a column with no metric carries its own tip.
    const metric = COLUMN_METRIC[col];
    return (
      <span>
        {label}{' '}
        <InfoTooltip
          content={translate(metric ? `admin.metrics.${metric}.description` : `admin.effectiveness.column.${col}.tip`)}
          label={translate('admin.effectiveness.column.aboutAria', { label })}
        />
      </span>
    );
  };

  /**
   * A COLUMN SORT IS A SECOND ORDERING, AND IT READS THE HIDDEN NUMBER.
   *
   * `qualityRank` governs the DEFAULT order only. Clicking a rate header hands ordering to DataTable,
   * which sorts on the raw row value - so a suppressed rate could still be sorted to position one, with
   * "too few to report" in the cell and the position doing the talking. That is the exact failure this
   * withholding exists to prevent, reachable in one click.
   *
   * Suppressed rows therefore form a second group that stays below the reportable ones in BOTH
   * directions. With suppression off there is no group, and the sort is the plain one it has always been.
   */
  const lowNLast = (key: string) => (row: Row) => (hideLowN && isUnderpopulated(row, key) ? 1 : 0);

  // Scoped to the three rates that feed `qualityRank`. When the thin figures are only user signal and
  // tool errors the order is untouched, and neither sentence may imply otherwise.
  const lowNNote = low.cells === 0
    ? translate('admin.effectiveness.lowNNone', { min: MIN_RATE_POPULATION })
    : hideLowN
      ? `${translate('admin.effectiveness.lowNHidden', { count: low.cells, min: MIN_RATE_POPULATION })} ${translate(
        low.ranking > 0 ? 'admin.effectiveness.lowNHiddenRanks' : 'admin.effectiveness.lowNNoRank')}`
      : `${translate('admin.effectiveness.lowNShown', { count: low.cells, min: MIN_RATE_POPULATION })} ${low.ranking > 0
        ? translate('admin.effectiveness.lowNShownRanks', { count: low.ranking })
        : translate('admin.effectiveness.lowNNoRank')}`;

  return (
    <>
    <div
      className="admin-help-text"
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <input
          type="checkbox"
          checked={hideLowN}
          onChange={(e) => setHideLowN(e.target.checked)}
        />
        {/* The label states the CONSEQUENCE, not the mechanism - the idiom the Experiments results
            toggle already uses ("Merge battle turns into metrics (biases the A/B read)"). */}
        <span>{translate('admin.effectiveness.lowNToggle', { min: MIN_RATE_POPULATION })}</span>
      </label>
      <span role="note" style={{ color: low.cells > 0 && !hideLowN ? 'var(--status-warn)' : 'var(--text-muted)' }}>
        {lowNNote}
      </span>
    </div>
    <DataTable
      data={ranked}
      emptyMessage={translate('admin.effectiveness.noIntentActivityForThis')}
      onRowClick={(row) => onPick(String(row.intent))}
      columns={[
        {
          key: 'intent',
          label: hdr('intent'),
          render: (v) => (
            <button className="btn-link" onClick={() => onPick(String(v))} style={{ fontWeight: 600 }}>
              {String(v)}
            </button>
          ),
        },
        { key: 'exchange_count', label: hdr('volume'), sortable: true },
        {
          // ── "REROUTED AWAY" IS GONE, BECAUSE THE PLATFORM DOES NOT DO IT ────
          //
          // It read `reroute_rate`, the share of exchanges where `was_rerouted` is true. NOTHING
          // writes that flag - it is not set anywhere in the tree, and it is not even declared on
          // the analytics metadata the archival reader pulls it from. So the figure was structurally
          // 0.0% on every row, forever.
          //
          // That is worse than a blank. "rerouted away 0.0%" reads as "we checked, routing was
          // clean", when what is true is that no reroute can ever be recorded. A reader cannot tell
          // a measured zero from an unmeasurable one.
          //
          // It is REMOVED rather than rendered as "not measured", because the classifier does not
          // reclassify a turn at all: there is no behavior here that is merely uninstrumented. (The
          // one reroute-shaped thing in the tree, `REROUTE_SIMILARITY_THRESHOLD` in drift detection,
          // is about offering a different CONVERSATION for a drifted topic - a different question.)
          // If intent reclassification is ever built, this comes back with it.
          key: 'avg_confidence',
          label: hdr('routingConfidence'),
          sortable: true,
          sortGroup: lowNLast('avg_confidence'),
          render: (v, row) => (
            <RateCell row={row} colKey="avg_confidence" value={v} targetKey="intent_confidence" suppress={hideLowN} />
          ),
        },
        {
          key: 'avg_relevance',
          label: hdr('relevance'),
          sortable: true,
          sortGroup: lowNLast('avg_relevance'),
          render: (v, row) => {
            const scored = num(row.relevance_scored_count) || 0;
            return (
              <RateCell
                row={row}
                colKey="avg_relevance"
                value={v}
                targetKey="relevance_score"
                suppress={hideLowN}
                suffix={scored > 0 ? (
                  <span style={{ color: 'var(--status-neutral)', fontSize: 'var(--text-sm)' }}> · {scored} scored</span>
                ) : undefined}
              />
            );
          },
        },
        {
          key: 'task_completion_rate',
          label: hdr('taskExecution'),
          sortable: true,
          sortGroup: lowNLast('task_completion_rate'),
          render: (v, row) => {
            const t = taskExecution(row);
            // No task flows at all. Not a zero - there is nothing here to measure.
            if (!t) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
            const parts: string[] = [];
            if (t.failed) parts.push(translate('admin.effectiveness.failed', { failed: t.failed }));
            if (t.abandoned) parts.push(`${t.abandoned} left`);
            if (t.running) parts.push(translate('admin.effectiveness.running', { running: t.running }));
            return (
              <RateCell
                row={row}
                colKey="task_completion_rate"
                value={v}
                targetKey="task_completion_rate"
                suppress={hideLowN}
                suffix={(
                  <span style={{ color: 'var(--status-neutral)', fontSize: 'var(--text-sm)' }}>
                    {' '}· {t.completed}/{t.flows} done{parts.length ? ` · ${parts.join(', ')}` : ''}
                  </span>
                )}
              />
            );
          },
        },
        {
          key: 'user_flag_rate',
          label: hdr('userSignal'),
          sortable: true,
          sortGroup: lowNLast('user_flag_rate'),
          render: (v, row) => {
            const rated = num(row.user_rated_count) || 0;
            // Nobody voted. NOT 0% - that would claim we asked and nobody objected.
            if (!rated) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
            const flagged = num(row.user_flag_count) || 0;
            const reasons: string[] = [];
            const push = (n: unknown, label: string) => { if (num(n)) reasons.push(`${num(n)} ${label}`); };
            push(row.user_flag_wrong_assistant, translate('admin.effectiveness.wrongAssistant'));
            push(row.user_flag_poor_answer, 'poor answer');
            push(row.user_flag_asked_again, 'had to re-ask');
            push(row.user_flag_unspecified, 'no reason given');
            return (
              <RateCell
                row={row}
                colKey="user_flag_rate"
                value={v}
                targetKey="user_flag_rate"
                suppress={hideLowN}
                suffix={(
                <span style={{ color: 'var(--status-neutral)', fontSize: 'var(--text-sm)' }}>
                  {' '}· {flagged} of {rated} rated
                  {reasons.length > 0 && (
                    <InfoTooltip
                      label={translate('admin.effectiveness.whyPeopleFlaggedIt')}
                      content={`What the ${flagged} flag${flagged === 1 ? '' : 's'} said: ${reasons.join(', ')}. Giving a reason is optional - somebody can vote without one - so "no reason given" is the common case rather than a gap.`}
                    />
                  )}
                </span>
                )}
              />
            );
          },
        },
        { key: 'avg_total_ms', label: hdr('latencyAvg'), sortable: true, render: (v) => <StatusValue value={v} targetKey="avg_total_ms" fallback="—" /> },
        { key: 'p95_total_ms', label: hdr('p95'), sortable: true, render: (v) => fmtMs(v) },
        { key: 'cost_per_reply_usd', label: hdr('costPerReply'), sortable: true, render: (v) => <StatusValue value={v} targetKey="cost_per_reply" /> },
        {
          key: 'tool_error_rate',
          label: hdr('tools'),
          sortable: true,
          sortGroup: lowNLast('tool_error_rate'),
          render: (v, row) => {
            const calls = num(row.tool_calls) || 0;
            if (!calls) return <span style={{ color: 'var(--status-neutral)' }}>—</span>;
            return (
              <RateCell
                row={row}
                colKey="tool_error_rate"
                value={v}
                targetKey="tool_error_rate"
                suppress={hideLowN}
                suffix={<span style={{ color: 'var(--status-neutral)', fontSize: 'var(--text-sm)' }}> ({calls})</span>}
              />
            );
          },
        },
        {
          // A COUNT, NOT A RATE, AND NO BAND. A refusal is the workflow holding the model to its steps,
          // which is not a failure and has no target; the error rate beside it excludes these. How often
          // the model tried a move its workflow forbids is a compliance signal to read, not to color.
          key: 'workflow_refusals',
          label: hdr('workflowRefusals'),
          sortable: true,
          render: (v, row) => {
            if (!(num(row.tool_calls) || 0)) return <span style={{ color: 'var(--status-neutral)' }}>—</span>;
            return <span>{num(v) || 0}</span>;
          },
        },
        {
          // A PLAIN COUNT. The steps the platform ran on entering a workflow state, apart from the model's
          // tool calls; there is no target, so nothing is colored.
          key: 'platform_actions',
          label: hdr('platformActions'),
          sortable: true,
          render: (v) => <span>{num(v) || 0}</span>,
        },
      ]}
    />
    </>
  );
};

// ---- L1 tool lens: per-tool usage folded in (the Steps aggregate, intent-scoped) ------------------
/** One failing tool call, kept so the lens can hand a reader the turn it happened in. */
type ToolFailure = { messageId: string; channelArn: string; timestamp: string; errorClass: string; intent: string };

type ToolAgg = {
  name: string;
  calls: number;
  errors: number;
  /** Calls the task workflow refused by a declared rule (`errorClass: 'workflow_refusal'`). Not errors. */
  refused: number;
  errorRate: number;
  /** How the failures broke down, by the bounded error class recorded on the step. */
  byClass: Record<string, number>;
  /** The failing calls themselves, newest first, so "go and look" is one click rather than a hunt. */
  failures: ToolFailure[];
};

/** Aggregate per-tool usage from execution_steps rows (steps[].tools[]), client-side. Pass an intent to
 *  scope to that intent (the L1 lens), or null to span every intent (the L0 system-wide view).
 *
 *  The failures are carried, not just counted. A count tells somebody a tool is failing and leaves
 *  them with nowhere to go; the whole complaint about this panel was that there was no route from
 *  "12 errors" to the errors. The raw error TEXT is deliberately never persisted (see
 *  `classifyToolError`), so the bounded class is the most specific thing that can be shown. */
function aggregateTools(stepRows: Row[], intent: string | null): ToolAgg[] {
  const map = new Map<string, { calls: number; errors: number; refused: number; byClass: Record<string, number>; failures: ToolFailure[] }>();
  for (const r of stepRows) {
    if (intent !== null && String(r.intent) !== intent) continue;
    const steps = Array.isArray(r.steps) ? (r.steps as Array<Record<string, unknown>>) : [];
    for (const s of steps) {
      const tools = Array.isArray(s.tools) ? (s.tools as Array<{ name?: string; ok?: boolean; errorClass?: string }>) : [];
      for (const t of tools) {
        const name = String(t.name ?? 'unknown');
        const e = map.get(name) ?? { calls: 0, errors: 0, refused: 0, byClass: {}, failures: [] };
        e.calls += 1;
        // A REFUSAL BY THE WORKFLOW'S OWN RULES IS NOT A FAILURE, the same split the server's
        // `tool_error_rate` makes: counted on its own, and kept out of the errors and their list.
        if (t.ok === false && t.errorClass === 'workflow_refusal') {
          e.refused += 1;
        } else if (t.ok === false) {
          e.errors += 1;
          // 'error' is the catch-all the classifier falls back to, and an absent class means the
          // step predates per-tool error classing. Both are shown as themselves rather than guessed.
          const cls = String(t.errorClass ?? 'error');
          e.byClass[cls] = (e.byClass[cls] ?? 0) + 1;
          e.failures.push({
            messageId: String(r.message_id ?? ''),
            channelArn: String(r.channel_arn ?? ''),
            timestamp: String(r.timestamp ?? ''),
            errorClass: cls,
            intent: String(r.intent ?? 'unknown'),
          });
        }
        map.set(name, e);
      }
    }
  }
  return [...map.entries()]
    .map(([name, v]) => ({
      name,
      calls: v.calls,
      errors: v.errors,
      refused: v.refused,
      errorRate: v.calls ? (v.errors / v.calls) * 100 : 0,
      byClass: v.byClass,
      failures: v.failures.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))),
    }))
    .sort((a, b) => b.calls - a.calls);
}

/** How each bounded error class reads, and what a reader should do about it. */
/**
 * What each tool error class means - now `admin.effectiveness.toolErrorClass.*` in en.json, with the
 * fallback as the second key so an unrecognized class still says something.
 */
const toolErrorClassKeys = (cls: string): string[] => [
  `admin.effectiveness.toolErrorClass.${cls}`,
  'admin.effectiveness.toolErrorClass.fallback',
];

/**
 * The failures behind one tool's error count.
 *
 * This panel exists because the count had nowhere to go. A reader who saw "12 errors" had no way to
 * find out what kind, or where, and the next step was reading Lambda logs by hand - which is not a
 * step an operator can take from a dashboard.
 */
const ToolFailurePanel: React.FC<{ tool: ToolAgg; onOpenConversation?: (channelArn: string) => void; onClose: () => void }> = ({
  tool,
  onOpenConversation,
  onClose,
}) => {
  const { t } = useTranslation();
  const { t: translate } = useTranslation();
  const classes = Object.entries(tool.byClass).sort((a, b) => b[1] - a[1]);
  return (
    <div className="admin-review-panel" style={{ marginTop: 12 }}>
      <div className="admin-conversation-header">
        <h4 style={{ margin: 0 }}>{tool.name} — {tool.errors} of {tool.calls} calls failed</h4>
        <button className="btn-secondary" onClick={onClose}>Close ✕</button>
      </div>

      {tool.errors === 0 && tool.refused > 0 ? (
        <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.8 }}>
          {translate('admin.effectiveness.noFailuresSomeRefused', { count: tool.refused })}
        </p>
      ) : tool.errors === 0 ? (
        <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.8 }}>
          Every call to this tool succeeded in the window. Nothing to investigate.
        </p>
      ) : (
        <>
          <p className="admin-tab-description">
            {translate('admin.effectiveness.groupedByTheRecordedError')}
          </p>
          <div className="admin-metrics-row">
            {classes.map(([cls, n]) => (
              <div className="admin-metric-card" key={cls}>
                <div className="admin-metric-value">{n}</div>
                <div className="admin-metric-label">
                  {cls} <InfoTooltip label={`About ${cls}`} content={t(toolErrorClassKeys(cls))} />
                </div>
              </div>
            ))}
          </div>

          <DataTable
            data={tool.failures.slice(0, 50) as unknown as Row[]}
            emptyMessage={translate('admin.effectiveness.noFailingCallsRecorded')}
            columns={[
              { key: 'timestamp', label: 'When', render: (v) => (v ? new Date(String(v)).toLocaleString() : '—') },
              { key: 'intent', label: 'Intent' },
              { key: 'errorClass', label: 'Error' },
              {
                key: 'open',
                label: '',
                sortable: false,
                render: (_v, row) => {
                  // The route out. Without a channel there is nothing to open, so the cell says so
                  // rather than rendering a button that cannot work.
                  const arn = String(row.channelArn || '');
                  if (!arn || !onOpenConversation) {
                    return <span className="admin-muted">{translate('admin.effectiveness.noConversationRecorded')}</span>;
                  }
                  return (
                    <button className="btn-secondary" onClick={() => onOpenConversation(arn)}>
                      Open conversation ↗
                    </button>
                  );
                },
              },
            ]}
          />
          {tool.failures.length > 50 && (
            <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.8 }}>
              Showing the 50 most recent of {tool.failures.length} failing calls.
            </p>
          )}
        </>
      )}
    </div>
  );
};

const ToolLensPanel: React.FC<{
  tools: ToolAgg[] | null;
  titleKey?: string;
  tipKey?: string;
  emptyTextKey?: string;
  onOpenConversation?: (channelArn: string) => void;
}> = ({
  tools,
  // KEYS, not copy. The defaults describe the per-intent lens; the system-wide caller passes its own
  // three. Defaulting to English here is what put two paragraphs of copy in a parameter list.
  titleKey = 'admin.effectiveness.toolLens.title',
  tipKey = 'admin.effectiveness.toolLens.tip',
  emptyTextKey = 'admin.effectiveness.toolLens.empty',
  onOpenConversation,
}) => {
  const { t: translate } = useTranslation();
  const [openTool, setOpenTool] = useState<string | null>(null);
  const selected = tools?.find((t) => t.name === openTool) ?? null;
  const title = translate(titleKey);
  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ margin: '0 0 6px' }}>
        {title}{' '}
        <InfoTooltip content={translate(tipKey)} label={translate('admin.effectiveness.column.aboutAria', { label: title })} />
      </h4>
      {tools === null ? (
        <p className="admin-tab-description">{translate('admin.effectiveness.loadingToolUsage')}</p>
      ) : tools.length === 0 ? (
        <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.8 }}>{translate(emptyTextKey)}</p>
      ) : (
        <>
          <DataTable
            data={tools as unknown as Row[]}
            emptyMessage={translate('admin.effectiveness.noToolCalls')}
            // EVERY row opens, not only the failing ones. A table where some rows respond to a click
            // and others do not is the same complaint this panel started with, one level down - and
            // "every call succeeded" is a useful answer to have confirmed rather than inferred.
            onRowClick={(row) => setOpenTool((cur) => (cur === String(row.name) ? null : String(row.name)))}
            columns={[
              { key: 'name', label: 'Tool' },
              { key: 'calls', label: 'Calls', sortable: true },
              { key: 'errors', label: 'Errors', sortable: true },
              { key: 'refused', label: translate('admin.effectiveness.toolLensRefused'), sortable: true },
              { key: 'errorRate', label: 'Error rate', sortable: true, render: (v) => <StatusValue value={v} targetKey="tool_error_rate" /> },
              {
                // ── THE SAME SEAM THE PROFILES PAGE ALREADY USES (tenet D8) ────────────────────────
                //
                // That page links a tool to its CloudWatch log group filtered by the tool name, and
                // this is the same question asked from the other end - so it is the same link rather
                // than a second way of forming one.
                //
                // THE FILTERED LAMBDA LIST, NOT A LOG GROUP, because the tool loop runs in the async
                // processor and its function name varies per classification. Profiles knows the name
                // from the resolved profile; this view does not, and inventing one would produce a
                // link to a log group that does not exist. Naming the search is honest and still one
                // click from the logs.
                key: 'logs',
                label: 'Logs',
                render: (_v, r) => (
                  <a
                    href={lambdaFunctionsSearchUrl('AsyncProcessor')}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={translate('admin.effectiveness.findTheToolLoopLambda', { tool: String((r as { name?: unknown }).name ?? 'this tool') })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    logs ↗
                  </a>
                ),
              },
            ]}
          />
          {selected && (
            <ToolFailurePanel tool={selected} onOpenConversation={onOpenConversation} onClose={() => setOpenTool(null)} />
          )}
        </>
      )}
    </div>
  );
};

// ---- L1 intent header (reuses the L0 row) ----------------------------------------------------------
const L1Intent: React.FC<{
  row: Row;
  toolLens: ToolAgg[] | null;
  onDrill: (delivery: 'direct' | 'task') => void;
  /** Hand this view's population to the Latency surface - same rows, read the other way. */
  onOpenLatency?: () => void;
  /** Open the flagged surface, which lists deliberately-raised flags. */
  onOpenFlagged?: () => void;
  /** Show the ratings themselves: which reply, which way, and anything written with it. */
  onOpenRatings?: () => void;
  /** Passed through to the tool lens so a failing tool call can open the conversation it happened in. */
  onOpenConversation?: (channelArn: string) => void;
  /** The L0 suppression setting, carried into the drill so a reader cannot step around it by clicking. */
  hideLowN: boolean;
}> = ({ row, toolLens, onDrill, onOpenLatency, onOpenFlagged, onOpenRatings, onOpenConversation, hideLowN }) => {
  const { t: translate } = useTranslation();
  const task = taskExecution(row);
  // Which tool contributed the most failures. Errors rather than rate, because a tool that failed
  // once out of one is a 100% rate and not the thing making this intent's number what it is.
  const worstFailingTool = (toolLens ?? [])
    .filter((t) => (Number(t.errors) || 0) > 0)
    .sort((a, b) => (Number(b.errors) || 0) - (Number(a.errors) || 0))[0]?.name ?? null;
  const lensRef = React.useRef<HTMLDivElement | null>(null);
  const scrollToLens = React.useCallback(() => {
    lensRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const hasFailingTool = worstFailingTool != null;
  const hasTasks = (num(row.task_count) || 0) > 0;
  const hasDirect = (num(row.direct_count) || 0) > 0;
  // THE ASSISTANT THAT ANSWERED. `answering_assistant` is the column the effectiveness query publishes it under; the raw
  // `assistant` column is the same fact where a row carries it, and is read as the fallback rather than left
  // to a deployment whose query predates the column, which would print no name at all.
  const answeringAssistant = row.answering_assistant ?? row.assistant;
  const definitions = num(row.assistant_definition_count);
  // ── WHICH JUDGE PRODUCED THE RELEVANCE AVERAGE ────────────────────────────────────────────────
  // The model is named only where naming it is honest: with exactly one judge in the window there is
  // one answer to print, and with two there is none, so the count takes over and the name is dropped
  // rather than picked. A NULL model (rows scored before the column was written) leaves both silent.
  const judgeCount = num(row.evaluator_model_count);
  const judge = judgeCount === 1 && row.evaluator_model != null
    ? modelDisplayName(String(row.evaluator_model)) || String(row.evaluator_model)
    : null;
  return (
    <div>
      {/* ── THE ASSISTANT ANSWERED; THE DEFINITION IS WHAT IT WAS SERVING ───────────────────────
          This led with `assistant`, which the query derives as the MODAL `profileName` over the rows -
          the definition SERVED. The rows were selected by the assistant that answered (`e.assistant`,
          migration 058). The two agree on ordinary traffic and come apart exactly on a duel, where an
          assistant serves a rival's definition, so the banner could name an assistant that did not answer
          the turns being counted.
          MODE() also collapses a mixed intent to whichever name won a plurality, which is why the
          COUNT is read before either name is printed: a single name over several definitions is not a
          summary of them, it is the wrong answer stated confidently. */}
      {(answeringAssistant != null || row.assistant != null) && (
        <p className="admin-tab-description" style={{ marginBottom: 8 }}>
          {answeringAssistant != null
            ? <>{translate('admin.effectiveness.answeredBy')} <strong>{String(answeringAssistant)}</strong></>
            : <>{translate('admin.effectiveness.answeredByUnnamedAssistant')}</>}
          {definitions > 1
            ? (
              <>
                {' '}— serving <strong>{definitions} different assistant definitions</strong> in this
                window, so no single one describes this intent's traffic
                {row.assistant != null && <> (most often <strong>{String(row.assistant)}</strong>)</>}.
              </>
            )
            : row.assistant != null && String(row.assistant) !== String(answeringAssistant ?? '')
              ? (
                <>
                  {' '}— serving the <strong>{String(row.assistant)}</strong> definition
                  {row.profile_version != null && <> · profile <strong>v{String(row.profile_version)}</strong></>}
                  {row.profile_config_id != null && <> <span className="admin-muted">(config {String(row.profile_config_id).slice(0, 12)})</span></>}.
                </>
              )
              : (
                <>
                  {row.profile_version != null && <> · profile <strong>v{String(row.profile_version)}</strong></>}
                  {row.profile_config_id != null && <> <span className="admin-muted">(config {String(row.profile_config_id).slice(0, 12)})</span></>}
                  {' '}— the portable profile version that produced this intent's traffic in the window.
                </>
              )}
        </p>
      )}
      <div className="admin-metrics-row">
        <MetricCard
          title={translate('admin.effectiveness.routingConfidence')}
          {...rateCardProps(row, 'avg_confidence', hideLowN, {
            targetKey: 'intent_confidence',
            subtitle: translate('admin.effectiveness.overExchanges', { exchangeCount: num(row.exchange_count) || 0 }),
          })}
        />
        {/* Two cards, matching the two columns on the dashboard. Relevance always; task execution
            only where tasks exist, and then saying what happened to the ones that did not complete
            rather than leaving them in an undifferentiated "not completed" remainder. */}
        {/* ── A METRIC REACHES ITS OWN EVIDENCE ──────────────────────────────
            The drill used to hang off the ROW, so pressing relevance and pressing error rate landed
            in the same place. A number a reader distrusts has to lead to the rows it was computed
            from, not to a general view of the intent. */}
        <MetricCard
          title={translate('admin.effectiveness.relevance')}
          {...rateCardProps(row, 'avg_relevance', hideLowN, {
            targetKey: 'relevance_score',
            subtitle: judge
              ? translate('admin.effectiveness.relevanceSubJudge', { count: num(row.relevance_scored_count) || 0, judge })
              : translate('admin.effectiveness.relevanceSub', { count: num(row.relevance_scored_count) || 0 }),
          })}
          onDrill={hasDirect ? () => onDrill('direct') : undefined}
          tooltip={translate('admin.metrics.relevance_score.description')}
        />
        {/* ── AN AVERAGE OVER TWO JUDGES IS NOT ONE NUMBER ───────────────────────────────────────
            The judge model is recorded on every scored row and was read by nothing, so a window that
            spans a model swap looked exactly like one that does not: the same column, the same
            average, silently re-baselined. Tenet P3 makes the swap an expected event, which is what
            turns this from an edge case into a warning the surface owes a reader.

            Shown only above one, for the reason the rubric warning beside it is: a banner that is
            always on is noise, and noise is why nobody reads the one that matters. */}
        {judgeCount > 1 && (
          <MetricCard
            title={translate('admin.effectiveness.judgesInWindow')}
            value={String(judgeCount)}
            subtitle={translate('admin.effectiveness.theAverageSpansMoreThan')}
            tooltip={translate('admin.effectiveness.theEvaluatorModelIsRecorded')}
          />
        )}
        {/* THE RUBRIC BOUNDARY, WHICH IS THE ONLY REASON rubric_version EXISTS. A changed prompt makes
            scores incomparable, and the column was stored so a reader could refuse the comparison -
            then surfaced nowhere, so nobody could. More than one version in a window is the warning. */}
        {num(row.rubric_version_count) > 1 && (
          <MetricCard
            title={translate('admin.effectiveness.rubricsInWindow')}
            value={String(num(row.rubric_version_count))}
            subtitle={translate('admin.effectiveness.scoresAreNotComparableAcross')}
            tooltip={translate('admin.effectiveness.theRelevanceRubricIsDerived')}
          />
        )}
        {/* ── GROUNDEDNESS WAS BUILT, STORED AND INVISIBLE ────────────────────
            Pass D has judged whether an answer is supported by what the turn retrieved since
            migration 062, writing is_grounded on every scored exchange. No query returned it and no
            surface showed it, so the metric a retrieval system is normally judged on existed only in
            a column. The spec said BUILT, which was true of the pipeline and false of the product. */}
        <MetricCard
          title={translate('admin.effectiveness.groundedness')}
          value={row.groundedness_assessed_count == null || num(row.groundedness_assessed_count) === 0
            ? translate('admin.effectiveness.notAssessed')
            : translate('admin.effectiveness.groundedValue', { rate: num(row.groundedness_rate) })}
          subtitle={num(row.groundedness_assessed_count) > 0
            ? [
              translate('admin.effectiveness.groundedSub', { assessed: num(row.groundedness_assessed_count), total: num(row.exchange_count) }),
              ...(row.avg_retrieved_passages != null ? [translate('admin.effectiveness.passagesAvg', { count: num(row.avg_retrieved_passages) })] : []),
            ].join(' · ')
            : translate('admin.effectiveness.noRetrieval')}
          rawValue={num(row.groundedness_assessed_count) ? num(row.groundedness_rate) : NaN}
          onDrill={hasDirect ? () => onDrill('direct') : undefined}
          tooltip={translate('admin.metrics.grounded_rate.description')}
        />
        {/* Which retrieved passages the answer used (SPEC-EVALUATION Appendix C7). Shown only where the
            judge assessed it; a low share is a retrieval finding for whoever curates the source. */}
        {num(row.passage_use_assessed_count) > 0 && (
          <MetricCard
            title={translate('admin.effectiveness.passagesUsed')}
            value={translate('admin.effectiveness.passagesUsedValue', { rate: num(row.passage_use_rate) })}
            subtitle={translate('admin.effectiveness.passagesUsedSubtitle', { count: num(row.passage_use_assessed_count) })}
            tooltip={translate('admin.metrics.passages_used.description')}
          />
        )}
        {task && (
          <MetricCard
            title={translate('admin.effectiveness.taskExecution')}
            onDrill={hasTasks ? () => onDrill('task') : undefined}
            {...rateCardProps(row, 'task_completion_rate', hideLowN, {
              targetKey: 'task_completion_rate',
              subtitle: [
                translate('admin.effectiveness.taskDone', { done: task.completed, total: task.flows }),
                ...(task.failed ? [translate('admin.effectiveness.failed', { failed: task.failed })] : []),
                ...(task.abandoned ? [translate('admin.effectiveness.abandoned', { count: task.abandoned })] : []),
                ...(task.running ? [translate('admin.effectiveness.running', { running: task.running })] : []),
              ].join(' · '),
            })}
          />
        )}
        {/* ── A RATING AND A FLAG ARE DIFFERENT SIGNALS ──────────────────────
            One card reported "N flagged of M rated" where N was a thumbs DOWN. The word collided with
            the Flagged surface, which counts something else entirely - a flag raised deliberately with
            a reason, by a person or a moderator or a judge - so an intent reading "0 flagged" could
            have flags on it, and following the number there found rows it never counted.

            Two cards now, and the rating one leads with the POSITIVE share: "3 rated, 0 flagged" told
            a reader almost nothing, while "100% positive of 3" says what happened. Both are only ever
            a floor, because rating is voluntary. */}
        <MetricCard
          title={translate('admin.effectiveness.userRatings')}
          {...rateCardProps(row, 'user_positive_rate', hideLowN, {
            value: row.user_rated_count == null || num(row.user_rated_count) === 0
              ? translate('admin.effectiveness.nobodyRated')
              : translate('admin.effectiveness.positiveValue', { rate: num(row.user_positive_rate) }),
            subtitle: row.user_rated_count == null || num(row.user_rated_count) === 0
              ? translate('admin.effectiveness.noVotesInThisWindow')
              : [
                translate('admin.effectiveness.ratingsSub', { up: num(row.user_up_count) || 0, down: num(row.user_down_count) || 0, rated: num(row.user_rated_count) }),
                ...(row.user_rated_share != null ? [translate('admin.effectiveness.ratedShare', { share: num(row.user_rated_share) })] : []),
              ].join(' · '),
          })}
          onDrill={onOpenRatings && (num(row.user_rated_count) || 0) > 0 ? () => onOpenRatings() : undefined}
          tooltip={translate('admin.metrics.user_positive_rate.description')}
        />
        <MetricCard
          title={translate('admin.effectiveness.flagsRaised')}
          value={row.raised_flag_count == null ? '—' : String(num(row.raised_flag_count) || 0)}
          subtitle={translate('admin.effectiveness.deliberateAPersonAModerator')}
          rawValue={num(row.raised_flag_count)}
          onDrill={onOpenFlagged && (num(row.raised_flag_count) || 0) > 0 ? () => onOpenFlagged() : undefined}
          tooltip={translate('admin.metrics.flags_raised.description')}
        />
        <MetricCard
          title={translate('admin.effectiveness.avgLatency')}
          value={fmtMs(row.avg_total_ms)}
          subtitle={translate('admin.effectiveness.p95Sub', { value: fmtMs(row.p95_total_ms) })}
          rawValue={num(row.avg_total_ms)}
          target={METRIC_TARGETS.avg_total_ms}
          onDrill={onOpenLatency ? () => onOpenLatency() : undefined}
          tooltip={translate('admin.metrics.avg_total_ms.description')}
        />
        <MetricCard
          title={translate('admin.effectiveness.modelCostReply')}
          value={fmtUsd(row.cost_per_reply_usd)}
          subtitle={costMixSubtitle(row)}
          rawValue={num(row.cost_per_reply_usd)}
          target={METRIC_TARGETS.cost_per_reply}
          tooltip={translate('admin.metrics.cost_per_reply.description')}
        />
        <MetricCard
          title={translate('admin.effectiveness.toolErrorRate')}
          {...rateCardProps(row, 'tool_error_rate', hideLowN, {
            targetKey: 'tool_error_rate',
            subtitle: (num(row.tool_calls) || 0) === 0
              ? translate('admin.effectiveness.noToolRan')
              : (num(row.workflow_refusals) || 0) > 0
                ? translate('admin.effectiveness.toolCallsWithRefusals', { calls: num(row.tool_calls), refusals: num(row.workflow_refusals) })
                : translate('admin.effectiveness.toolCalls', { count: num(row.tool_calls) }),
          })}
          // OPENS THE LIST, NOT ONE TOOL. Preselecting the worst offender skipped the thing a reader
          // asking about an error rate actually wants first: which tools ran, how often, and which of
          // them is failing. The per-tool failures are one more click from there, and so are the logs.
          onDrill={hasFailingTool ? () => scrollToLens() : undefined}
          tooltip={translate('admin.metrics.tool_error_rate.description')}
        />
        {/* COMPLIANCE IS A SEPARATE QUESTION FROM RELEVANCE, and gets its own card. A reply can answer
            the request perfectly and still breach a rule, so the two never share one. The coverage
            sits in the subtitle because a rate without it cannot be told from "nothing was judged" —
            and this is the only place Aurora mode shows the rate at all (Evaluations is Athena-only). */}
        <MetricCard
          title={translate('admin.effectiveness.compliance')}
          value={row.compliance_rate == null ? translate('admin.effectiveness.notAssessed') : `${num(row.compliance_rate).toFixed(1)}%`}
          subtitle={
            (num(row.compliance_assessed_count) || 0) === 0
              ? translate('admin.effectiveness.0OfAssessed', { exchangeCount: num(row.exchange_count) || 0 })
              : translate('admin.effectiveness.breaches', { count: num(row.violation_count) || 0 })
                + ((num(row.blocking_violation_count) || 0) > 0 ? translate('admin.effectiveness.blocking', { blockingViolationCount: num(row.blocking_violation_count) }) : '')
                + translate('admin.effectiveness.inOfAssessed', { complianceAssessedCount: num(row.compliance_assessed_count) || 0, exchangeCount: num(row.exchange_count) || 0 })
          }
          tooltip={translate('admin.metrics.compliance_rate.description')}
        />
      </div>
      <div className="admin-filter-group" style={{ marginTop: 12 }}>
        {hasDirect && <button className="admin-filter-btn" onClick={() => onDrill('direct')}>{translate('admin.effectiveness.exchangesBtn', { count: num(row.direct_count) || 0 })}</button>}
        {hasTasks && <button className="admin-filter-btn" onClick={() => onDrill('task')}>{translate('admin.effectiveness.tasksBtn', { count: num(row.task_count) || 0 })}</button>}
      </div>
      {/*
        THREE SENTENCES, THREE KEYS - not fourteen.

        An earlier pass converted this paragraph piece by piece, leaving alternating `translate()` calls and
        English fragments: "Each turn runs a" was one key, ": the assistant reasons, optionally calls..." the
        next, with `<strong>` tags and plain text in between. That is worse than leaving it in English,
        because a translator receives clauses with no sentence to put them in and cannot reorder around the
        emphasis - and in most languages the word order has to change. `<Trans>` keeps each sentence whole
        and lets the markup sit inside the translated string, which is what it exists for.
      */}
      <p className="admin-tab-description" style={{ marginTop: 12 }}>
        <Trans
          i18nKey="admin.effectiveness.toolsIntro"
          components={{ b: <strong />, i: <em />, c: <code /> }}
        />
        {' '}
        <Trans
          i18nKey={hasTasks && hasDirect
            ? 'admin.effectiveness.mix.both'
            : hasTasks
              ? 'admin.effectiveness.mix.tasksOnly'
              : 'admin.effectiveness.mix.directOnly'}
          components={{ b: <strong /> }}
        />
        {' '}
        <Trans
          i18nKey="admin.effectiveness.toolLensHowTo"
          components={{ b: <strong />, i: <em /> }}
          values={{
            // The object to open, named rather than assembled from "a"/"an" plus a noun: the article
            // belongs to the noun in most languages, and splitting them makes the phrase untranslatable.
            opener: translate(hasTasks && hasDirect
              ? 'admin.effectiveness.opener.exchangeOrTask'
              : hasTasks
                ? 'admin.effectiveness.opener.task'
                : 'admin.effectiveness.opener.exchange'),
          }}
        />
      </p>
      <div ref={lensRef}>
        <ToolLensPanel tools={toolLens} onOpenConversation={onOpenConversation} />
      </div>
    </div>
  );
};

// ---- L3 turn timeline + inline L4 steps ------------------------------------------------------------
const L3Timeline: React.FC<{ rows: Row[] }> = ({ rows }) => {
  const { t: translate } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  if (rows.length === 0) return <div className="admin-info-banner">{translate('admin.effectiveness.noTurnsRecordedForThis')}</div>;
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
              <span style={{ color: 'var(--status-neutral)', fontSize: 'var(--text-sm)' }}>{r.created_at ? new Date(String(r.created_at)).toLocaleString() : ''}</span>
              {Number.isFinite(num(r.relevance_score)) && <StatusValue value={r.relevance_score} targetKey="relevance_score" />}
              <span style={{ fontSize: 'var(--text-sm)' }}>latency {fmtMs(r.total_ms ?? r.response_latency_ms)}</span>
              {Number.isFinite(num(r.input_tokens)) && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--status-neutral)' }}>{num(r.input_tokens)}→{num(r.output_tokens)} tok</span>}
              {r.bedrock_model != null && (
                <span style={{ fontSize: 'var(--text-sm)' }} data-testid="timeline-turn-model">
                  {translate('admin.effectiveness.timeline.model', { model: modelDisplayName(String(r.bedrock_model)) || String(r.bedrock_model) })}
                  {r.task_step != null && <> {' · '}{translate('admin.effectiveness.timeline.step', { step: String(r.task_step) })}</>}
                  {r.model_from != null && <> {' · '}{translate('admin.effectiveness.timeline.modelFrom', { from: String(r.model_from) })}</>}
                </span>
              )}
              {steps.length > 0 && (
                <button className="btn-link" onClick={() => setOpen(isOpen ? null : i)}>
                  {isOpen ? '▾' : '▸'} {steps.length} step{steps.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
            {isOpen && steps.length > 0 && (
              <DataTable
                data={steps}
                emptyMessage={translate('admin.effectiveness.noSteps')}
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
                      const tools = Array.isArray(v) ? (v as Array<{ name: string; ok: boolean; errorClass?: string; refusal?: string }>) : [];
                      if (tools.length === 0) return '—';
                      return (
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {tools.map((tl, k) => {
                            // A workflow refusal is the workflow holding the model to its steps, not a
                            // failure, so it reads as a caution with the rule it ran into.
                            const refused = !tl.ok && tl.errorClass === 'workflow_refusal';
                            const color = tl.ok ? 'var(--status-good)' : refused ? 'var(--status-warn)' : 'var(--status-bad)';
                            const detail = refused && tl.refusal ? `${tl.errorClass}: ${tl.refusal}` : tl.errorClass;
                            return (
                              <span key={k} style={{ color, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                                {tl.ok ? '✓' : '✗'} {tl.name}{detail ? ` (${detail})` : ''}
                              </span>
                            );
                          })}
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
/** The glossary entry (`admin.metrics.<id>`) behind each column that prints a metric. */
const COLUMN_METRIC: Record<string, string> = {
  volume: 'volume',
  relevance: 'relevance_score',
  routingConfidence: 'intent_confidence',
  taskExecution: 'task_completion_rate',
  userSignal: 'user_flag_rate',
  latencyAvg: 'avg_total_ms',
  p95: 'p95_total_ms',
  costPerReply: 'cost_per_reply',
  tools: 'tool_error_rate',
  workflowRefusals: 'workflow_refusals',
  platformActions: 'platform_actions',
};

const FlowScorePanel: React.FC<{ flow: Row }> = ({ flow }) => {
  const { t: translate } = useTranslation();
  const composite = FLOW_DIMS.reduce((s, d) => s + (num(flow[d.key]) || 0) * d.weight, 0);
  return (
    <div className="admin-metrics-row" style={{ marginBottom: 12 }}>
      <div className="metric-card">
        <div className="metric-card-title">
          {translate('admin.metrics.flow_score.label')}
          <InfoTooltip
            content={translate('admin.metrics.flow_score.description')}
            label={translate('admin.effectiveness.aboutFlowScore')}
          />
        </div>
        <div className="metric-card-value" style={{ color: scoreColor(composite) }}>{Number.isFinite(composite) ? composite.toFixed(0) : '—'}</div>
        {Boolean(flow.outcome || flow.status) && <div className="metric-card-subtitle">{String(flow.outcome || flow.status)}</div>}
      </div>
      {FLOW_DIMS.map((d) => {
        const n = num(flow[d.key]);
        return (
          <div className="metric-card" key={d.key}>
            <div className="metric-card-title">{d.label} <span style={{ color: 'var(--status-neutral)', fontSize: 'var(--text-xs)' }}>{Math.round(d.weight * 100)}%</span></div>
            <div className="metric-card-value" style={{ color: scoreColor(n) }}>{Number.isFinite(n) ? n.toFixed(0) : '—'}</div>
          </div>
        );
      })}
    </div>
  );
};

// ---- the tab: L0 dashboard + drill state -----------------------------------------------------------
/**
 * What the blended cost was actually blended over: each model and how many replies it served.
 *
 * THE CARD USED TO NAME ONE MODEL under this number, which was true when the figure was priced at the
 * mode and is a misrepresentation now that it is a blend. Reported as the cost appearing to be "just
 * for Opus" on an intent that ran three models - and the number underneath it was never Opus's.
 *
 * Replies rather than share, because the denominator is the thing a reader needs when the count beside
 * the card (`exchange_count`) is larger: a turn whose model was never recorded cannot be priced.
 */
function costMixSubtitle(row: Record<string, unknown>): string {
  const mix = Array.isArray(row.model_mix) ? row.model_mix as Array<Record<string, unknown>> : [];
  const named = mix
    .filter((m) => m && m.model)
    .map((m) => ({
      name: modelDisplayName(String(m.model)),
      replies: Number(m.replies) || 0,
      // A TURN CAN RUN AND RECORD NO TOKENS, and then it cannot be priced however well known its
      // model is. Measured live: advisor v3 served five replies on Opus with 867ms of compute and
      // null tokens, so the cost read NULL while the mix listed a model that prices fine everywhere
      // else. Naming the reason is the difference between a gap and a bug.
      // WHY it could not be priced, not just that it could not. An image model reports no tokens BY
      // CONSTRUCTION - it is priced per image - so calling that "no tokens recorded" describes a
      // telemetry gap on a turn where nothing is missing. The server marks the image case, because
      // that is where the image-model registry lives.
      imageModel: m.imageModel === true,
      unpriced: m.tokensIn == null && m.tokensOut == null,
    }))
    .filter((m) => m.replies > 0)
    .sort((a, b) => b.replies - a.replies);
  if (!named.length) return i18n.t('admin.effectiveness.answerInferenceOnlyNotThe');
  const priced = Number(row.cost_priced_replies);
  const total = Number(row.exchange_count);
  const why = (m: { imageModel: boolean; unpriced: boolean }) => {
    if (m.imageModel) return i18n.t('admin.effectiveness.pricedPerImageNotPer');
    return m.unpriced ? i18n.t('admin.effectiveness.noTokensRecorded') : '';
  };
  const models = named.map((m) => `${m.name} ${m.replies}${why(m)}`).join(' · ');
  // Nothing priceable at all: say that outright rather than leaving a blank cost beside a model list
  // that looks like it was counted - and say WHICH reason, since an image turn is not a gap.
  if (Number.isFinite(priced) && priced === 0) {
    const allImage = named.every((m) => m.imageModel);
    return allImage
      ? `${models} — no cost: per-image pricing is not recorded for these turns`
      : `${models} — no cost: no tokens recorded`;
  }
  // Only worth saying when they differ; equal counts would just be noise on every row.
  const over = Number.isFinite(priced) && Number.isFinite(total) && priced !== total
    ? ` · over ${priced} of ${total} replies`
    : '';
  return `${models}${over}`;
}

const EffectivenessTab: React.FC<EffectivenessTabProps> = ({ data, dateRange, isLoading, onOpenConversation, registerBack, drill: drillProp, onDrillChange, filters, onFiltersChange, filterRows = [], onOpenLatency, onOpenFlagged, embedded }) => {
  const { t: translate } = useTranslation();

  const l0Rows = useMemo(() => (data?.data ?? []) as Row[], [data]);
  // Use the parent-owned drill when provided (survives tab-switch unmounts — C2); else internal state.
  const [internalDrill, setInternalDrill] = useState<Drill>({ level: 0 });
  const drill = drillProp ?? internalDrill;
  // Lives here rather than in L0Dashboard, which unmounts on every drill: a reader who switched
  // suppression off to look at the numbers should not find it back on after pressing Back. On by
  // default, because the suppressed view is the honest one.
  const [hideLowN, setHideLowN] = useState(true);
  const setDrill = onDrillChange ?? setInternalDrill;
  const [drillData, setDrillData] = useState<AnalyticsResult | null>(null);
  // L3 only: the task's holistic flow score (evaluation_flows) — the 5 weighted dimensions folded into
  // the drill so the Flows detail lives here instead of a separate tab.
  const [flowSummary, setFlowSummary] = useState<Row | null>(null);
  // L1 only: per-tool usage aggregated from execution_steps for the intent (the tool lens). null = loading.
  const [toolLens, setToolLens] = useState<ToolAgg[] | null>([]);
  // L0 only: the same aggregate across ALL intents (the system-wide tool view). null = loading.
  const [l0Tools, setL0Tools] = useState<ToolAgg[] | null>([]);
  // The ratings themselves, fetched on demand: one intent's votes with whatever was written on them.
  const [ratings, setRatings] = useState<{ intent: string; rows: Row[]; loading: boolean; error: string | null } | null>(null);
  const setRatingsFor = useCallback(async (intent: string) => {
    setRatings({ intent, rows: [], loading: true, error: null });
    try {
      const res = await queryAnalytics('user_ratings', dateRange, { intent, limit: '200' });
      setRatings({ intent, rows: (res?.data ?? []) as Row[], loading: false, error: null });
    } catch (e) {
      setRatings({ intent, rows: [], loading: false, error: e instanceof Error ? e.message : translate('admin.effectiveness.couldNotReadTheRatings') });
    }
  }, [dateRange]);
  // THE TOOL LENS MUST DESCRIBE THE SAME POPULATION AS THE CARD ABOVE IT. The card's error rate is
  // computed inside intent_effectiveness, which is filtered; the lens is built from execution_steps,
  // which was not. Reported live as a card reading 0.0% above a table showing a row at 27% - both
  // right about their own population, with nothing on the surface saying there were two.
  const stepFilterParams = useMemo(() => ({
    ...(filters.assistant ? { agentType: filters.assistant } : {}),
    ...(filters.classification ? { conversationClassification: filters.classification } : {}),
    ...(filters.role ? { assistantRole: filters.role } : {}),
    ...(filters.version ? { profileVersion: String(filters.version) } : {}),
  }), [filters.assistant, filters.classification, filters.role, filters.version]);
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
          const steps = await queryAnalytics('execution_steps', dateRange, { limit: '200', ...stepFilterParams });
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
          const steps = await queryAnalytics('execution_steps', dateRange, { limit: '200', ...stepFilterParams });
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
        // Scope the drill to the same CLASSIFICATION as the L0 view when the filter is set. Sent as
        // `conversationClassification` (the room's) rather than `agentType` (the assistant that
        // answered) - the two were the same string until `agent_type` started naming the assistant,
        // and a drill that kept sending the old one would silently return nothing.
        const clsExtra: Record<string, string> = {
          // ONE SOURCE FOR THE SCOPE, so the drill asks for exactly the population the bar shows.
          ...(filters.assistant ? { agentType: filters.assistant } : {}),
          ...(filters.role ? { assistantRole: filters.role } : {}),
          ...(filters.version ? { profileVersion: filters.version } : {}),
        };
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
  }, [drill, dateRange, filters, drillPage]);

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

  if (isLoading) return <div className="admin-tab-loading">{translate('admin.effectiveness.loadingEffectiveness')}</div>;

  // Breadcrumb — every level links back to L0 (§9). `level !== 0` narrows to the members carrying
  // `intent`; `=== 2` / `=== 3` narrow to those carrying `delivery` / `taskId`.
  const crumbs: React.ReactNode[] = [
    <button key="l0" className="btn-link" onClick={() => setDrill({ level: 0 })}>Intents</button>,
  ];
  if (drill.level !== 0) {
    const intent = drill.intent;
    crumbs.push(<span key="s1"> / </span>, <button key="l1" className="btn-link" onClick={() => setDrill({ level: 1, intent })}>{intent}</button>);
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
        {/* THE GLOSSARY IS GONE AND THE SPEC IS LINKED INSTEAD. Moving it behind this affordance was
            already an admission that it is read once: it defined four columns and enumerated how their
            combinations read, which is a page of SPEC-ADMIN-CONSOLE-EFFECTIVENESS reproduced in a
            tooltip where it could silently diverge from it. Each column keeps its own `hdr()` tooltip,
            so a definition is still one hover from the column it describes - nearer than it was here. */}
        <h3>
          {translate('admin.effectiveness.title')}
          <InfoTooltip
            label={translate('admin.effectiveness.howToReadTheEffectiveness')}
            content={
              <>
                {translate('admin.effectiveness.howToReadText')}{' '}
                <DocLink href={DOC_LINKS.effectiveness}>{translate('admin.docs.title.effectiveness')}</DocLink>.
              </>
            }
          />
        </h3>
        {drill.level > 0 && <nav className="admin-breadcrumb" aria-label={translate('admin.effectiveness.drillPath')}>{crumbs}</nav>}
      </div>


      {/* THE SHARED BAR. Role and Version used to be a select and a number input declared here, with
          their own tooltip copy, while Latency rendered pills for the same two axes - two controls
          over one population. The bar also CASCADES, which the bespoke pair could not: a version
          number means nothing except against the assistant that ran it, and this accepted one with
          no assistant chosen at all. */}
      {!embedded && <PerformanceFilterBar
        rows={filterRows}
        value={filters}
        onChange={onFiltersChange}
        showEntry={false}
        showDuel={false}
      />}

      {drill.level === 0 && (
        <>
          <p className="admin-tab-description">{translate('admin.effectiveness.l0Lead')}</p>
          <GuideLinks guides={[
            guide(translate('admin.guides.effectiveness.read'), 'effectiveness'),
            guide(translate('admin.guides.effectiveness.quality'), 'evaluationSpec'),
          ]} />
          {/* THE COST WARNING KEEPS ITS OWN LINE. A reader who takes this column for a bill makes a
              budgeting error, and a hint that has to be opened is the wrong place for the one claim
              on this page that is actively misread. What the figure covers and what it leaves out is
              the detail, so that is what moved. */}
          <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.85 }}>
            <strong>{translate('admin.effectiveness.costNote')}</strong>
            <InfoTooltip
              label={translate('admin.effectiveness.whatModelCostPerReply')}
              content={
                <>
                  {translate('admin.metrics.cost_per_reply.description')}{' '}
                  {translate('admin.effectiveness.costNoteMore')}{' '}
                  <DocLink href={DOC_LINKS.effectiveness}>{translate('admin.docs.title.effectiveness')}</DocLink>.
                </>
              }
            />
          </p>
          <L0Dashboard
            rows={l0Rows}
            onPick={(intent) => setDrill({ level: 1, intent })}
            hideLowN={hideLowN}
            setHideLowN={setHideLowN}
          />
          <ToolLensPanel
            tools={l0Tools}
            titleKey="admin.effectiveness.toolUsageAllIntents"
            tipKey="admin.effectiveness.toolLensAll.tip"
            emptyTextKey="admin.effectiveness.toolLensAll.empty"
            onOpenConversation={onOpenConversation}
          />
          {/* The delivered files' own grades, beside the intents above and never pooled into them:
              the Relevance column is the reply's, and this is the document's (FR22). */}
          <DeliveredDocumentsPanel dateRange={dateRange} />
          <TemplateOutcomesPanel dateRange={dateRange} assistant={filters.assistant} classification={filters.classification} />
          <WorkflowTrajectoryPanel dateRange={dateRange} assistant={filters.assistant} classification={filters.classification} />
          <SafetyReadingsPanel dateRange={dateRange} assistant={filters.assistant} classification={filters.classification} />
          <ToolOutcomesPanel dateRange={dateRange} assistant={filters.assistant} classification={filters.classification} />
          <RetrievalSourcesPanel dateRange={dateRange} assistant={filters.assistant} classification={filters.classification} />
          <FrustrationPanel dateRange={dateRange} assistant={filters.assistant} classification={filters.classification} onOpenConversation={onOpenConversation} />
        </>
      )}

      {drill.level === 1 && (() => {
        const row = intentRow(drill.intent);
        if (!row) return <div className="admin-info-banner">{translate('admin.effectiveness.noDataFor', { intent: drill.intent })}</div>;
        return (
          <>
          <L1Intent
            row={row}
            toolLens={toolLens}
            onDrill={(delivery) => setDrill({ level: 2, intent: drill.intent, delivery })}
            onOpenLatency={onOpenLatency ? () => onOpenLatency(drill.intent) : undefined}
            onOpenFlagged={onOpenFlagged}
            onOpenRatings={() => { void setRatingsFor(drill.intent); }}
            onOpenConversation={onOpenConversation}
            hideLowN={hideLowN}
          />
          <IntentStepBreakdown intent={drill.intent} step={drill.step} dateRange={dateRange} filters={filters}
            onStep={(step) => {
              setDrill({ level: 1, intent: drill.intent, ...(step ? { step } : {}) });
              // The step rides the URL beside the intent, so the narrowed view can be sent to someone.
              try { window.history.replaceState(null, '', `${window.location.pathname}${withIntentParam(drill.intent, window.location.search, step)}${window.location.hash}`); } catch { /* the view stands; only sharing it is lost */ }
            }} />
          {ratings && (
            <div className="admin-section admin-metric-drill" role="region" aria-label={translate('admin.effectiveness.userRatings')}>
              <h4>
                {translate('admin.effectiveness.ratingsTitle', { intent: ratings.intent })}
                <button className="btn-secondary" style={{ marginLeft: 'var(--space-3)' }} onClick={() => setRatings(null)}>{translate('admin.effectiveness.close')}</button>
              </h4>
              <p className="admin-tab-description">
                {translate('admin.effectiveness.everyRatedReplyInThe')}
              </p>
              {ratings.loading && <p className="admin-help-text">{translate('admin.effectiveness.readingTheRatings')}</p>}
              {ratings.error && <p className="admin-error" role="alert">{ratings.error}</p>}
              {!ratings.loading && !ratings.error && ratings.rows.length === 0 && (
                <p className="admin-tab-empty">{translate('admin.effectiveness.nobodyRatedAReplyOn')}</p>
              )}
              {ratings.rows.length > 0 && (
                <DataTable
                  columns={[
                    { key: 'created_at', label: 'When', render: (v) => new Date(String(v)).toLocaleString() },
                    { key: 'rating', label: 'Rating', render: (v) => (String(v) === 'up' ? '👍 helpful' : translate('admin.effectiveness.needsWork')) },
                    // Null means they voted without saying why, which is the common case and is NOT a
                    // reason of its own - rendering 'unspecified' as a category would invent one.
                    { key: 'reason', label: 'Reason', render: (v) => (v ? String(v).replace(/_/g, ' ') : '—') },
                    { key: 'note', label: translate('admin.effectiveness.whatTheyWrote'), render: (v) => (v ? String(v) : '—') },
                    { key: 'agent_response', label: 'The reply', render: (v) => (v ? String(v).slice(0, 160) + (String(v).length > 160 ? '…' : '') : '—') },
                    { key: 'channel_arn', label: 'Conversation', render: (v) => <ConvLink channelArn={v} onOpen={onOpenConversation} /> },
                  ]}
                  data={ratings.rows}
                />
              )}
            </div>
          )}
          </>
        );
      })()}

      {drill.level === 2 && (
        drillLoading ? <div className="admin-tab-loading">{translate('admin.effectiveness.loading')}</div> :
        drill.delivery === 'task' ? (
          <>
          <p className="admin-tab-description">
            <Trans i18nKey="admin.effectiveness.taskLead" components={{ b: <strong />, c: <code /> }} />
          </p>
          <DataTable
            data={(drillData?.data ?? []) as Row[]}
            emptyMessage={translate('admin.effectiveness.noTasksForThisIntent')}
            serverPagination={{ page: drillPage, pageSize: DRILL_PAGE_SIZE, total: drillTotal, onPageChange: setDrillPage, loading: drillLoading }}
            onRowClick={(row) => setDrill({ level: 3, intent: drill.intent, taskId: String(row.task_id) })}
            columns={[
              { key: 'task_id', label: 'Task', render: (v) => <button className="btn-link" onClick={() => setDrill({ level: 3, intent: drill.intent, taskId: String(v) })}>{shortId(v)}</button> },
              { key: 'status', label: 'Status (lifecycle)' },
              { key: 'task_state', label: translate('admin.effectiveness.machineStateFlow'), render: (v) => (v ? String(v) : '—') },
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
            emptyMessage={translate('admin.effectiveness.noExchangesForThisIntent')}
            serverPagination={{ page: drillPage, pageSize: DRILL_PAGE_SIZE, total: drillTotal, onPageChange: setDrillPage, loading: drillLoading }}
            columns={[
              { key: 'created_at', label: 'When', render: (v) => (v ? new Date(String(v)).toLocaleString() : '—') },
              { key: 'relevance_score', label: 'Relevance', sortable: true, render: (v) => <StatusValue value={v} targetKey="relevance_score" /> },
              {
                // THREE STATES, NOT TWO. Null is "the turn retrieved nothing, so there was no ground
                // to check against" - a fact about coverage, not a failing grade, and rendering it as
                // a cross would invent a retrieval failure on a turn that never retrieved.
                key: 'is_grounded',
                label: 'Grounded',
                render: (v, row) => {
                  if (v === null || v === undefined) return <span title={translate('admin.effectiveness.noRetrievalOnThisTurn')}>—</span>;
                  const passages = num((row as Row).retrieved_passage_count);
                  const over = Number.isFinite(passages) && passages > 0 ? ` over ${passages} passage${passages === 1 ? '' : 's'}` : '';
                  return v === true
                    ? <span style={{ color: 'var(--status-good)' }} title={translate('admin.effectiveness.supportedByWhatTheTurn', { over: over })}>✓ grounded</span>
                    : <span style={{ color: 'var(--status-bad)' }} title={translate('admin.effectiveness.notSupportedByWhatThe', { over: over })}>✗ ungrounded</span>;
                },
              },
              {
                // WHY THIS ROW WAS JUDGED AT ALL. Under stratified sampling a flagged or low-confidence
                // exchange is always taken while the rest are sampled at a recorded rate, so a rate over
                // these rows means nothing without knowing which population produced them.
                key: 'sample_stratum',
                label: 'Why judged',
                render: (v) => (v === 'always'
                  ? <span title={translate('admin.effectiveness.alwaysJudgedFlaggedOrThe')}>always</span>
                  : v === 'sampled'
                    ? <span title={translate('admin.effectiveness.partOfTheSampledRemainder')}>sampled</span>
                    : '—'),
              },
              {
                // The instrument. Two versions in one table means these scores were not produced by
                // the same judge and should not be averaged against each other.
                key: 'rubric_version',
                label: 'Rubric',
                render: (v) => (v ? <code title={translate('admin.effectiveness.theRelevanceRubricThatProduced')}>{String(v).slice(0, 8)}</code> : '—'),
              },
              {
                // WHO DID THE JUDGING. The column beside it names what the judge was asked; this names
                // the judge. Two models in one table means these scores came from different instruments
                // and should not be read against each other, exactly as two rubrics would.
                //
                // A row scored before the runner wrote this column carries NULL, and a dash says so.
                // Printing the current judge's name there would attribute a score to a model that
                // never saw it, which is worse than the gap.
                key: 'evaluator_model',
                label: 'Judge',
                render: (v, row) => {
                  // The evaluation row folded in from evaluation_exchanges is the fallback: both
                  // queries carry the judge, and either one answering is enough to fill the cell.
                  const raw = v ?? (row as { _eval?: Row })._eval?.evaluator_model;
                  if (raw == null || raw === '') return <span title={translate('admin.effectiveness.thisScoreWasRecordedBefore')}>—</span>;
                  return <span title={translate('admin.effectiveness.theModelThatJudgedThis', { raw: String(raw) })}>{modelDisplayName(String(raw)) || String(raw)}</span>;
                },
              },
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
        drillLoading ? <div className="admin-tab-loading">{translate('admin.effectiveness.loading')}</div> :
        <>
          {/* The whole task lives in one conversation; a single link opens its raw log (all turns below). */}
          {onOpenConversation && (() => {
            const arn = String(((drillData?.data ?? [])[0] as Row | undefined)?.channel_arn ?? '');
            return arn ? (
              <p className="admin-tab-description" style={{ marginBottom: 'var(--space-2)' }}>
                <ConvLink channelArn={arn} onOpen={onOpenConversation} />{' '}
                <span style={{ color: 'var(--text-secondary)' }}>{translate('admin.effectiveness.seeActualMessages')}</span>
              </p>
            ) : null;
          })()}
          {flowSummary
            ? <FlowScorePanel flow={flowSummary} />
            : <p className="admin-tab-description" style={{ fontStyle: 'italic', opacity: 0.8 }}>{translate('admin.effectiveness.noHolisticFlowScore')}</p>}
          <L3Timeline rows={(drillData?.data ?? []) as Row[]} />
        </>
      )}
    </div>
  );
};

export default EffectivenessTab;
