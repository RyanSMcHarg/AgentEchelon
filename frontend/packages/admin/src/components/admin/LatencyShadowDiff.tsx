/**
 * THE LEDGER AND THE DERIVED PATH, TURN BY TURN (LATENCY-TARGETS.md).
 *
 * THE LEDGER IS THE AUTHORITATIVE SIDE. Every TTFF and E2E figure on the Latency tab is read from
 * `v_turn_latency`, which computes them from recorded instants. The exchange pairing's
 * `response_latency_ms` and `e2e_ms` compute the same two figures at archival and are now the second
 * opinion.
 *
 * KEPT AFTER THE REPOINT, not retired with it. The two were watched into agreement over live traffic
 * before the read moved, and that is a statement about one window rather than a property that holds
 * forever: an archival change, a re-pairing or a second final stamp would separate them again, and a
 * per-turn diff is the only thing that would show it. Retiring the comparison the moment it succeeded
 * would remove the check exactly when the number started being trusted.
 *
 * IT STATES ITS OWN SOURCE, in the panel and not only in a tooltip. A panel headed "derived vs ledger"
 * beside the headline cards does not by itself say which side those cards came from.
 *
 * THE SUMMARY IS THE WHOLE WINDOW; THE TABLE IS ONLY WHAT NEEDS A LOOK. Agreeing turns are counted and
 * not listed: a thousand identical rows would bury the one that decides whether the repoint is safe.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

interface Props {
  dateRange: AnalyticsDateRange;
}

type ShadowClass = 'agree' | 'disagree' | 'derived_only' | 'ledger_only';

interface ShadowRow extends Record<string, unknown> {
  response_id: string;
  channel_arn: string;
  turn_id: string | null;
  exchange_id: string | number | null;
  placeholder_at: string | null;
  assistant: string | null;
  paired_by: string | null;
  anchor_source: string | null;
  trigger_kind: string | null;
  derived_ttff_ms: number | string | null;
  ledger_ttff_ms: number | string | null;
  ttff_diff_ms: number | string | null;
  derived_e2e_ms: number | string | null;
  ledger_e2e_ms: number | string | null;
  e2e_diff_ms: number | string | null;
  classification: ShadowClass;
  disagreed_on: string | null;
}

interface ShadowSummary {
  tolerance_ms: number;
  compared_count: number;
  agree_count: number;
  disagree_count: number;
  derived_only_count: number;
  ledger_only_count: number;
  ttff_diff_sample_count: number;
  p50_abs_ttff_diff_ms: number | null;
  p95_abs_ttff_diff_ms: number | null;
  max_abs_ttff_diff_ms: number | null;
  e2e_diff_sample_count: number;
  p50_abs_e2e_diff_ms: number | null;
  p95_abs_e2e_diff_ms: number | null;
  max_abs_e2e_diff_ms: number | null;
  exchange_anchored_count: number;
}

/** The shape the analytics POST returns for this query: rows in `data`, the window's counts beside it. */
interface ShadowResult {
  data?: ShadowRow[];
  summary?: Partial<ShadowSummary>;
}

const NEEDS_A_LOOK: ShadowClass[] = ['disagree', 'derived_only', 'ledger_only'];

const isNum = (v: unknown): boolean => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const num = (v: unknown): number => (isNum(v) ? Number(v) : 0);

/** A duration; a dash only when there is no figure. Zero is a real value here and renders as 0ms. */
const fmtMs = (v: unknown): string => {
  if (!isNum(v)) return '—';
  const n = Number(v);
  return Math.abs(n) < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
};

/** A signed difference (ledger minus derived), so the direction of a disagreement is readable. */
const fmtDiff = (v: unknown): string => {
  if (!isNum(v)) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmtMs(Math.abs(n))}`;
};

export function LatencyShadowDiff({ dateRange }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ShadowRow[]>([]);
  const [summary, setSummary] = useState<ShadowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [classFilter, setClassFilter] = useState<ShadowClass | null>(null);

  const load = useCallback(async (range: AnalyticsDateRange) => {
    setLoading(true);
    setError(null);
    try {
      const res = (await queryAnalytics('turn_latency_shadow_diff', range)) as unknown as ShadowResult;
      setRows(res.data ?? []);
      const s = res.summary ?? {};
      setSummary({
        tolerance_ms: num(s.tolerance_ms),
        compared_count: num(s.compared_count),
        agree_count: num(s.agree_count),
        disagree_count: num(s.disagree_count),
        derived_only_count: num(s.derived_only_count),
        ledger_only_count: num(s.ledger_only_count),
        ttff_diff_sample_count: num(s.ttff_diff_sample_count),
        p50_abs_ttff_diff_ms: isNum(s.p50_abs_ttff_diff_ms) ? Number(s.p50_abs_ttff_diff_ms) : null,
        p95_abs_ttff_diff_ms: isNum(s.p95_abs_ttff_diff_ms) ? Number(s.p95_abs_ttff_diff_ms) : null,
        max_abs_ttff_diff_ms: isNum(s.max_abs_ttff_diff_ms) ? Number(s.max_abs_ttff_diff_ms) : null,
        e2e_diff_sample_count: num(s.e2e_diff_sample_count),
        p50_abs_e2e_diff_ms: isNum(s.p50_abs_e2e_diff_ms) ? Number(s.p50_abs_e2e_diff_ms) : null,
        p95_abs_e2e_diff_ms: isNum(s.p95_abs_e2e_diff_ms) ? Number(s.p95_abs_e2e_diff_ms) : null,
        max_abs_e2e_diff_ms: isNum(s.max_abs_e2e_diff_ms) ? Number(s.max_abs_e2e_diff_ms) : null,
        exchange_anchored_count: num(s.exchange_anchored_count),
      });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('admin.latency.shadowDiff.loadFailed'));
      setRows([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(dateRange); }, [dateRange, load]);

  const shown = classFilter ? rows.filter((r) => r.classification === classFilter) : rows;
  const needsALook = summary
    ? summary.disagree_count + summary.derived_only_count + summary.ledger_only_count
    : 0;

  const diffCard = (
    title: string,
    p50: number | null,
    p95: number | null,
    max: number | null,
    count: number,
  ) => (
    <MetricCard
      title={title}
      value={count > 0 ? t('admin.latency.shadowDiff.cards.diffValue', { p50: fmtMs(p50), p95: fmtMs(p95) }) : '—'}
      subtitle={count > 0
        ? t('admin.latency.shadowDiff.cards.diffHint', { max: fmtMs(max), count })
        : t('admin.latency.shadowDiff.cards.noSamples')}
    />
  );

  return (
    <section className="admin-section" aria-label={t('admin.latency.shadowDiff.ariaLabel')}>
      <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
        <span className="admin-tab-banner-label-text">{t('admin.latency.shadowDiff.title')}</span>
        <InfoTooltip label={t('admin.latency.shadowDiff.aboutLabel')} content={t('admin.latency.shadowDiff.about')} />
      </div>

      {/* The source statement is always shown, before any number, so no figure on this panel can be
          read as the tab's own. It names which side the cards above came from. */}
      <p className="admin-tab-description" role="note">
        <strong>{t('admin.latency.shadowDiff.source')}</strong>
      </p>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {!error && !loading && summary && summary.compared_count === 0 && (
        <p className="admin-help-text">{t('admin.latency.shadowDiff.empty')}</p>
      )}

      {!error && summary && summary.compared_count > 0 && (
        <>
          <div className="admin-metrics-row">
            <MetricCard
              title={t('admin.latency.shadowDiff.cards.compared')}
              value={summary.compared_count.toLocaleString()}
              subtitle={t('admin.latency.shadowDiff.cards.comparedHint')}
            />
            <MetricCard title={t('admin.latency.shadowDiff.cards.agree')} value={summary.agree_count.toLocaleString()} />
            <MetricCard title={t('admin.latency.shadowDiff.cards.disagree')} value={summary.disagree_count.toLocaleString()} />
            <MetricCard
              title={t('admin.latency.shadowDiff.cards.derivedOnly')}
              value={summary.derived_only_count.toLocaleString()}
              subtitle={t('admin.latency.shadowDiff.cards.derivedOnlyHint')}
            />
            <MetricCard
              title={t('admin.latency.shadowDiff.cards.ledgerOnly')}
              value={summary.ledger_only_count.toLocaleString()}
              subtitle={t('admin.latency.shadowDiff.cards.ledgerOnlyHint')}
            />
            {diffCard(
              t('admin.latency.shadowDiff.cards.ttffDiff'),
              summary.p50_abs_ttff_diff_ms,
              summary.p95_abs_ttff_diff_ms,
              summary.max_abs_ttff_diff_ms,
              summary.ttff_diff_sample_count,
            )}
            {diffCard(
              t('admin.latency.shadowDiff.cards.e2eDiff'),
              summary.p50_abs_e2e_diff_ms,
              summary.p95_abs_e2e_diff_ms,
              summary.max_abs_e2e_diff_ms,
              summary.e2e_diff_sample_count,
            )}
          </div>

          <p className="admin-help-text">{t('admin.latency.shadowDiff.tolerance', { ms: summary.tolerance_ms })}</p>
          {summary.exchange_anchored_count > 0 && (
            <p className="admin-help-text">
              {t('admin.latency.shadowDiff.exchangeAnchored', { count: summary.exchange_anchored_count })}
            </p>
          )}

          {needsALook === 0 ? (
            <p className="admin-help-text">{t('admin.latency.shadowDiff.allAgree')}</p>
          ) : (
            <>
              <div
                role="group"
                aria-label={t('admin.latency.shadowDiff.filterLabel')}
                className="admin-filter-group"
              >
                <span className="admin-filter-label">{t('admin.latency.shadowDiff.filterLabel')}:</span>
                {([null, ...NEEDS_A_LOOK] as Array<ShadowClass | null>).map((c) => (
                  <button
                    key={c ?? '__all'}
                    type="button"
                    aria-pressed={classFilter === c}
                    className="admin-filter-btn"
                    onClick={() => setClassFilter(c)}
                  >
                    {c === null
                      ? t('admin.latency.shadowDiff.filterAll')
                      : t(`admin.latency.shadowDiff.class.${c}`)}
                  </button>
                ))}
              </div>

              {rows.length < needsALook && (
                <p className="admin-help-text">
                  {t('admin.latency.shadowDiff.truncated', { shown: rows.length, total: needsALook })}
                </p>
              )}

              <DataTable<ShadowRow>
                columns={[
                  {
                    key: 'placeholder_at',
                    label: t('admin.latency.shadowDiff.columns.when'),
                    render: (v) => (typeof v === 'string' ? v.replace('T', ' ').slice(0, 19) : '—'),
                  },
                  {
                    key: 'classification',
                    label: t('admin.latency.shadowDiff.columns.class'),
                    render: (v) => {
                      const c = String(v);
                      return (
                        <span
                          className={c === 'disagree' ? 'status-bad' : 'status-warn'}
                          title={t(`admin.latency.shadowDiff.class.${c}Help`)}
                        >
                          {t(`admin.latency.shadowDiff.class.${c}`)}
                        </span>
                      );
                    },
                  },
                  { key: 'disagreed_on', label: t('admin.latency.shadowDiff.columns.differsOn'), render: (v) => (v ? String(v) : '—') },
                  { key: 'derived_ttff_ms', label: t('admin.latency.shadowDiff.columns.derivedTtff'), render: (v) => fmtMs(v) },
                  { key: 'ledger_ttff_ms', label: t('admin.latency.shadowDiff.columns.ledgerTtff'), render: (v) => fmtMs(v) },
                  { key: 'ttff_diff_ms', label: t('admin.latency.shadowDiff.columns.ttffDiff'), render: (v) => fmtDiff(v) },
                  { key: 'derived_e2e_ms', label: t('admin.latency.shadowDiff.columns.derivedE2e'), render: (v) => fmtMs(v) },
                  { key: 'ledger_e2e_ms', label: t('admin.latency.shadowDiff.columns.ledgerE2e'), render: (v) => fmtMs(v) },
                  { key: 'e2e_diff_ms', label: t('admin.latency.shadowDiff.columns.e2eDiff'), render: (v) => fmtDiff(v) },
                  { key: 'anchor_source', label: t('admin.latency.shadowDiff.columns.anchor'), render: (v) => (v ? String(v) : '—') },
                  {
                    key: 'paired_by',
                    label: t('admin.latency.shadowDiff.columns.pairing'),
                    render: (v) => (v === 'swept'
                      ? <span className="status-warn" title={t('admin.latency.shadowDiff.sweptHelp')}>{String(v)}</span>
                      : (v ? String(v) : '—')),
                  },
                  { key: 'response_id', label: t('admin.latency.shadowDiff.columns.response') },
                ]}
                data={shown}
                emptyMessage={t('admin.latency.shadowDiff.filterEmpty')}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

export default LatencyShadowDiff;
