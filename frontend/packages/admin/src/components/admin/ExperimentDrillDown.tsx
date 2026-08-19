/**
 * The evidence behind an experiment result (DESIGN-EXPERIMENTS-BATTLE §4.3).
 *
 * The bar this view is built to is REPRODUCIBILITY, not navigation: an operator must be able to
 * derive the number they are about to ship on from what is shown here, and read the transcripts
 * behind it. A list of conversation links would not clear that bar, so every row carries the values
 * that roll up, the full N is stated even when a page is displayed, and the recomputed figures are
 * checked against the aggregate on screen rather than assumed to agree.
 *
 * FOUR populations, not one view with a filter. The verdict rests on measurements that were taken
 * differently - randomly-assigned turns, hand-picked duels, self-selected thumbs, forced choices -
 * and a drill-down filtered for one of them is the wrong set for the others. Each axis therefore
 * carries its own query, its own predicate and its own statement of what is being shown.
 */
import { useEffect, useMemo, useState } from 'react';
import DataTable from './DataTable';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange, AnalyticsResult, QueryType } from '@ae/shared';

const PAGE_SIZE = 25;

/** Which evidence set is being shown. */
export type DrillAxis = 'metrics' | 'battle' | 'approval' | 'picks';

export interface DrillTarget {
  experimentId: string;
  axis: DrillAxis;
  /** The variant whose aggregate this drill reconciles against. Always set: an unscoped drill has
   *  nothing on screen to check itself against. */
  variantId: string;
}

/** The console figures this drill-down must reproduce, read from the same rows the operator sees. */
export interface DrillAggregate {
  /** Exchanges (metrics/battle), votes (approval) or picks (picks) the console reports. */
  count: number | null;
  /** The mean the console reports for this axis: avg_score, the approval %, or null where the axis
   *  has no mean (picks are a count). */
  mean: number | null;
}

interface AxisMeta {
  queryType: QueryType;
  title: string;
  /** What the operator is looking at, in the terms that make the population unambiguous. */
  population: string;
  countLabel: string;
  meanLabel: string | null;
  /** Extra params beyond experimentId/variantId/paging. */
  params?: Record<string, string>;
}

export const AXES: Record<DrillAxis, AxisMeta> = {
  metrics: {
    queryType: 'experiment_exchanges',
    title: 'Exchanges behind the metrics',
    population:
      'Randomly assigned turns only. Battle turns are excluded, exactly as they are from the A/B '
      + 'averages beside this - a battle variant is chosen rather than assigned, so counting those '
      + 'turns here would show evidence the comparison did not use.',
    countLabel: 'Exchanges',
    meanLabel: 'Quality (avg)',
    params: { axis: 'metrics' },
  },
  battle: {
    queryType: 'experiment_exchanges',
    title: 'Battle turns',
    population:
      'Battle turns only - the replies produced inside a duel. These are what the battle scorecard '
      + 'averages. They are NOT the picks: a duel produces a turn from each side and at most one '
      + 'pick per person.',
    countLabel: 'Turns',
    meanLabel: 'Quality (avg)',
    params: { axis: 'battle' },
  },
  approval: {
    queryType: 'experiment_feedback',
    title: 'Ratings behind the approval rate',
    population:
      'One row per counted vote on ordinary traffic. Thumbs are self-selected, so only a fraction of '
      + 'exchanges carry one. A voter who changed their mind appears once, on the thumb they ended '
      + 'on; a withdrawn thumb is not shown because it is not counted.',
    countLabel: 'Votes',
    meanLabel: 'Approval',
  },
  picks: {
    queryType: 'experiment_picks',
    title: 'Head-to-head picks',
    population:
      'One row per counted pick. A tie credits neither side and is therefore not counted and not '
      + 'shown - this list is shorter than the number of duels run.',
    countLabel: 'Picks',
    meanLabel: null,
  },
};

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconLine {
  label: string;
  /** What the drill-down's own full-match figures say. */
  shown: string;
  /** What the console displays beside the verdict. */
  aggregate: string;
  agrees: boolean;
}

export interface Reconciliation {
  status: 'ok' | 'mismatch' | 'unavailable';
  lines: ReconLine[];
  note?: string;
}

/** Means are compared with a tolerance because the aggregate rounds per row before weighting them;
 *  anything larger than rounding is a real disagreement, not a display artefact. */
const MEAN_TOLERANCE = 0.15;

/**
 * Check the drill-down against the aggregate it explains.
 *
 * This is the self-check the acceptance criterion asks for, and it is deliberately allowed to FAIL
 * loudly: if the row count or the recomputed mean disagrees with the number on screen, the pipeline
 * is wrong somewhere, and saying so is more useful than rendering a quiet contradiction the operator
 * would have to notice themselves.
 */
export function reconcile(
  axis: DrillAxis,
  stats: Record<string, number | string | null> | undefined,
  aggregate: DrillAggregate,
): Reconciliation {
  if (!stats) return { status: 'unavailable', lines: [], note: 'The drill-down returned no totals to check against.' };

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lines: ReconLine[] = [];

  const shownCount = num(stats.total);
  if (shownCount != null && aggregate.count != null) {
    lines.push({
      label: AXES[axis].countLabel,
      shown: shownCount.toLocaleString(),
      aggregate: aggregate.count.toLocaleString(),
      agrees: shownCount === aggregate.count,
    });
  }

  const meanLabel = AXES[axis].meanLabel;
  if (meanLabel) {
    const shownMean = axis === 'approval' ? num(stats.approval_rate) : num(stats.avg_score);
    if (shownMean != null && aggregate.mean != null) {
      const suffix = axis === 'approval' ? '%' : '';
      lines.push({
        label: meanLabel,
        shown: `${Math.round(shownMean * 10) / 10}${suffix}`,
        aggregate: `${Math.round(aggregate.mean * 10) / 10}${suffix}`,
        agrees: Math.abs(shownMean - aggregate.mean) <= MEAN_TOLERANCE,
      });
    }
  }

  if (!lines.length) {
    return {
      status: 'unavailable',
      lines,
      note: 'Nothing to check yet - the console has no aggregate for this variant on this axis.',
    };
  }
  return { status: lines.every((l) => l.agrees) ? 'ok' : 'mismatch', lines };
}

/** Unscored exchanges count as ZERO in the mean, because that is what the aggregate does. Stating it
 *  is the difference between an operator being able to reproduce the number and merely seeing it. */
function scoringNote(stats: Record<string, number | string | null> | undefined): string | null {
  if (!stats) return null;
  const total = Number(stats.total);
  const scored = Number(stats.scored_count);
  if (!Number.isFinite(total) || !Number.isFinite(scored) || total === 0) return null;
  if (scored >= total) return null;
  return `${(total - scored).toLocaleString()} of ${total.toLocaleString()} exchanges carry no evaluator score. `
    + 'They count as 0 in the mean above, matching the aggregate - so part of this average is scoring '
    + 'coverage rather than reply quality.';
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const fmtWhen = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : '—');
const fmtMs = (v: unknown) => (v == null || v === '' ? '—' : `${Math.round(Number(v)).toLocaleString()} ms`);

/** The transcript control. A withheld row keeps its numbers and loses its link, and SAYS which. */
function TranscriptCell({
  row,
  onOpenConversation,
}: {
  row: Row;
  onOpenConversation?: (channelArn: string) => void;
}) {
  const arn = row.channel_arn ? String(row.channel_arn) : '';
  const withheld = row.deleted === true || row.redacted === true;
  if (withheld) {
    // Redaction and deletion carry through: the row still counted toward the score, so it stays, but
    // the content it contributed was retracted and must not be reachable from here.
    return (
      <span className="exp-drill-withheld" title="This exchange counted toward the score. Its content was redacted or deleted, so the transcript is withheld.">
        {row.deleted === true ? 'deleted' : 'redacted'}
      </span>
    );
  }
  if (!arn || !onOpenConversation) return <span className="exp-drill-muted">—</span>;
  return (
    <button className="admin-link-btn" onClick={(e) => { e.stopPropagation(); onOpenConversation(arn); }}>
      View
    </button>
  );
}

function columnsFor(axis: DrillAxis, onOpenConversation?: (arn: string) => void) {
  const transcript = {
    key: 'channel_arn',
    label: 'Transcript',
    sortable: false,
    render: (_v: unknown, row: Row) => <TranscriptCell row={row} onOpenConversation={onOpenConversation} />,
  };

  if (axis === 'approval') {
    return [
      { key: 'created_at', label: 'When', render: fmtWhen },
      { key: 'variant_id', label: 'Variant' },
      { key: 'intent', label: 'Intent' },
      {
        key: 'feedback',
        label: 'Vote',
        render: (v: unknown) => (
          <span className="exp-drill-vote" data-vote={String(v)}>{v === 'up' ? '👍 up' : '👎 down'}</span>
        ),
      },
      transcript,
    ];
  }
  if (axis === 'picks') {
    return [
      { key: 'chosen_at', label: 'When', render: fmtWhen },
      { key: 'variant_id', label: 'Picked' },
      { key: 'intent', label: 'Intent' },
      { key: 'battle_id', label: 'Battle', render: (v: unknown) => (v ? String(v).slice(0, 8) : '—') },
      transcript,
    ];
  }
  return [
    { key: 'created_at', label: 'When', render: fmtWhen },
    { key: 'variant_id', label: 'Variant' },
    {
      key: 'relevance_score',
      label: 'Quality',
      sortable: true,
      // An unscored exchange is '—' here and 0 in the mean. Showing 0 would misreport it as a bad
      // reply rather than an unjudged one.
      render: (v: unknown) => (v == null ? <span className="exp-drill-muted" title="not scored — counts as 0 in the mean">—</span> : String(v)),
    },
    { key: 'total_ms', label: 'Latency', sortable: true, render: fmtMs },
    { key: 'input_tokens', label: 'In', sortable: true },
    { key: 'output_tokens', label: 'Out', sortable: true },
    { key: 'bedrock_model', label: 'Model', render: (v: unknown) => (v ? String(v) : '—') },
    transcript,
  ];
}

export default function ExperimentDrillDown({
  target,
  aggregate,
  dateRange,
  includeBattle,
  onClose,
  onOpenConversation,
}: {
  target: DrillTarget;
  aggregate: DrillAggregate;
  dateRange: AnalyticsDateRange;
  /**
   * Whether battle turns are folded into the aggregate this panel is reconciling against (CR-12).
   *
   * MUST match what produced the aggregate. The parent queries `experiment_results` with
   * `includeBattle: 'true'`, and this panel's queries defaulted to EXCLUDING battle turns - so with the
   * merge toggle on, the drill-down counted a different population from the figure it was opened to
   * explain, `reconcile` reported a mismatch, and the panel printed "DOES NOT reconcile … treat the
   * verdict as unverified" over data that was correct. A reconciliation check comparing two different
   * questions is worse than none: it teaches the operator to distrust the number that was right.
   */
  includeBattle: boolean;
  onClose: () => void;
  onOpenConversation?: (channelArn: string) => void;
}) {
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<AnalyticsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = AXES[target.axis];

  // A new target starts at the first page; leaving the operator on page 7 of the previous axis would
  // show them rows from a set they did not ask for.
  useEffect(() => setPage(0), [target.experimentId, target.axis, target.variantId]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await queryAnalytics(meta.queryType, dateRange, {
          experimentId: target.experimentId,
          variantId: target.variantId,
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
          // Same population as the aggregate this panel reconciles against (see the prop docs).
          ...(includeBattle ? { includeBattle: 'true' } : {}),
          ...(meta.params ?? {}),
        });
        if (!cancelled) setResult(res);
      } catch (e) {
        if (!cancelled) {
          setResult(null);
          setError(e instanceof Error ? e.message : 'Failed to load the exchanges behind this result');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    // The catch inside `run` handles the failure; this one exists so a rejection can never escape as
    // an unhandled promise (the effect body is not awaited by React).
    run().catch(() => {});
    return () => { cancelled = true; };
  }, [meta.queryType, meta.params, dateRange, target.experimentId, target.variantId, page, includeBattle]);

  const rows = (result?.data ?? []) as Row[];
  const stats = result?.stats;
  const total = Number(result?.total ?? 0);
  const recon = useMemo(() => reconcile(target.axis, stats, aggregate), [target.axis, stats, aggregate]);
  const withheld = Number(stats?.withheld_count ?? 0);
  const unresolved = Number(stats?.unresolved_conversations ?? 0);
  const coverage = scoringNote(stats);

  return (
    <div className="exp-drill">
      <div className="exp-drill-head">
        <div>
          <h5 className="exp-drill-title">
            {meta.title} · <span className="exp-drill-variant">{target.variantId}</span>
          </h5>
          <p className="exp-drill-population">{meta.population}</p>
        </div>
        <button className="admin-inline-btn" onClick={onClose}>Close</button>
      </div>

      {error && <div className="admin-error"><span>{error}</span></div>}

      {!error && (
        <div className="exp-drill-recon" data-status={recon.status}>
          {recon.status === 'unavailable' ? (
            <span className="exp-drill-recon-note">{recon.note}</span>
          ) : (
            <>
              <span className="exp-drill-recon-verdict">
                {recon.status === 'ok'
                  ? 'Reconciles with the result above'
                  : 'DOES NOT reconcile with the result above'}
              </span>
              {recon.lines.map((l) => (
                <span className="exp-drill-recon-line" data-agrees={l.agrees} key={l.label}>
                  {l.label}: {l.shown} here vs {l.aggregate} shown
                </span>
              ))}
              {recon.status === 'mismatch' && (
                <span className="exp-drill-recon-note">
                  These should be identical - they are two readings of the same set. Treat the
                  verdict as unverified until they agree.
                </span>
              )}
            </>
          )}
        </div>
      )}

      {coverage && <p className="exp-drill-note">{coverage}</p>}

      {withheld > 0 && (
        <p className="exp-drill-note">
          {withheld.toLocaleString()} of {total.toLocaleString()} rows have a redacted or deleted
          message. They still count toward the numbers above - they contributed to the score - but
          their transcripts are withheld.
        </p>
      )}

      {target.axis === 'picks' && unresolved > 0 && (
        <p className="exp-drill-note">
          {unresolved.toLocaleString()} pick{unresolved === 1 ? '' : 's'} on this page cannot be traced
          to a conversation: the battle it judged has no archived turn carrying its id.
        </p>
      )}

      {total > PAGE_SIZE && (
        <p className="exp-drill-note">
          Showing {(page * PAGE_SIZE + 1).toLocaleString()}–
          {Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}.
          The figures checked above are computed over ALL {total.toLocaleString()}, not this page.
        </p>
      )}

      <DataTable
        columns={columnsFor(target.axis, onOpenConversation)}
        data={rows}
        emptyMessage={
          loading
            ? 'Loading…'
            : `No ${meta.countLabel.toLowerCase()} recorded for ${target.variantId} on this axis in this window.`
        }
        serverPagination={{ page, pageSize: PAGE_SIZE, total, onPageChange: setPage, loading }}
      />
    </div>
  );
}
