/**
 * WHICH TURNS ARE IN THE ANSWER POPULATION, AND WHICH ARE DELIBERATELY NOT.
 *
 * Owner direction, 2026-09-11: "Drift can be excluded from normal responses, but should still be
 * tracked in analytics and filterable / separately viewable like readings."
 *
 * CHECKING THAT PRECEDENT FOUND IT DID NOT EXIST. A reading was excluded and diagnosable, which is
 * not the same as tracked and viewable: the kind lived in metadata JSON, exactly one query surfaced
 * it, and nothing in this console mentioned it at all. So this is not "do for drift what was done
 * for readings" - it is the viewable half, built once for both kinds.
 *
 * WHY IT BELONGS BESIDE THE LATENCY BREAKDOWNS rather than on a tab of its own. The question it
 * answers is the same one `InteractionLatency` answers one level down: what is IN the number you are
 * reading. An operator who sees a fast average and cannot tell whether fast non-answers are in it
 * has no way to check, and that is exactly how `exchange_count` meant something other than its name
 * for months without anybody noticing.
 *
 * THE TWO COLUMNS THAT MAKE IT WORTH SHOWING:
 *  - `Exchanges` should be zero on every declared kind. A non-zero is a pairing that ignored a
 *    declaration, which is a defect and not a curiosity.
 *  - `Reply time` is the number the exclusion exists to keep out of the answer average. A drift
 *    suggestion answers fast and deliberately does not do the work; counted as an answer it drags
 *    every latency figure down while representing a turn that answered nothing. Here it is visible
 *    without being mixed in.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange, AnalyticsResult } from '@ae/shared';

interface Props {
  dateRange: AnalyticsDateRange;
}

interface TurnKindRow extends Record<string, unknown> {
  date: string;
  turn_kind: string;
  message_count: number | string;
  declared_target_count: number | string;
  exchange_count: number | string;
  avg_reply_ms: number | string | null;
  reply_measured_count: number | string;
}

/**
 * What each kind IS, in the operator's terms - now `admin.turnKinds.help.*` in `en.json`.
 *
 * THE FALLBACK IS THE SECOND KEY, not an `??` at the call site. i18next resolves an ARRAY of keys to
 * the first one that exists, so an unknown kind lands on `help.fallback` through the same lookup
 * rather than through a branch that has to be remembered everywhere the map is read. The set is closed
 * on purpose: a kind this console has not been taught about is a producer that shipped ahead of its
 * reader, which is worth saying rather than rendering as a bare string that looks deliberate.
 */
const kindHelpKeys = (kind: string): string[] => [
  `admin.turnKinds.help.${kind}`,
  'admin.turnKinds.help.fallback',
];

const fmtMs = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
};

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

const humanize = (s: string): string => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function TurnKinds({ dateRange }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<TurnKindRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Answers are the bulk of every window, so the question "what else ran" is one click away. */
  const [nonAnswersOnly, setNonAnswersOnly] = useState(false);

  const load = useCallback(async (range: AnalyticsDateRange) => {
    setLoading(true);
    setError(null);
    try {
      const res: AnalyticsResult = await queryAnalytics('turn_kinds', range);
      setRows(((res.data ?? []) as unknown as TurnKindRow[]));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.turnKinds.theTurnKindBreakdownFailed'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(dateRange); }, [dateRange, load]);

  const shown = nonAnswersOnly ? rows.filter((r) => r.turn_kind !== 'answer') : rows;

  return (
    <section className="admin-section" aria-label={t('admin.turnKinds.turnKinds')}>
      <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
        <span className="admin-tab-banner-label-text">{t('admin.turnKinds.title')}</span>
        <InfoTooltip
          label={t('admin.turnKinds.aboutTurnKinds')}
          content={t('admin.turnKinds.about')}
        />
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {!error && !loading && rows.length === 0 && (
        <p className="admin-help-text">{t('admin.turnKinds.empty')}</p>
      )}

      {rows.length > 0 && (
        <>
          <label className="admin-help-text" style={{ display: 'block', marginBottom: 'var(--space-1)' }}>
            <input
              type="checkbox"
              checked={nonAnswersOnly}
              onChange={(e) => setNonAnswersOnly(e.target.checked)}
            />
            {' '}Show only the turns that are not answers
          </label>

          <DataTable<TurnKindRow>
            columns={[
              { key: 'date', label: t('admin.turnKinds.columns.date') },
              {
                key: 'turn_kind',
                label: t('admin.turnKinds.columns.kind'),
                render: (v) => {
                  const key = String(v);
                  return <span title={t(kindHelpKeys(key))}>{humanize(key)}</span>;
                },
              },
              { key: 'message_count', label: t('admin.turnKinds.columns.messages') },
              {
                key: 'declared_target_count',
                label: t('admin.turnKinds.namedATarget'),
                // The pairing's own coverage. A kind that should name one and mostly does not is a
                // producer that is not declaring, which reads identically to one that has no target.
                render: (v, row) => (
                  <span title={t('admin.turnKinds.ofSaidWhichMessageThey', { v: num(v), messageCount: num(row.message_count) })}>
                    {num(v)}
                  </span>
                ),
              },
              {
                key: 'exchange_count',
                label: 'Exchanges',
                render: (v, row) => {
                  const n = num(v);
                  const isAnswer = row.turn_kind === 'answer';
                  if (isAnswer) {
                    return (
                      <span title={t('admin.turnKinds.ofOrdinaryRepliesPairedInto', { n: n, messageCount: num(row.message_count) })}>
                        {n}
                      </span>
                    );
                  }
                  return (
                    <span
                      className={n > 0 ? 'status-bad' : undefined}
                      title={n > 0
                        ? t('admin.turnKinds.aTurnThatDeclaredIt')
                        : t('admin.turnKinds.zeroWhichIsCorrectThis')}
                    >
                      {n}
                    </span>
                  );
                },
              },
              {
                key: 'avg_reply_ms',
                label: 'Reply time',
                render: (v, row) => (
                  <span title={num(row.reply_measured_count) > 0
                    ? t('admin.turnKinds.measuredFromTheMessageEach', { replyMeasuredCount: num(row.reply_measured_count), messageCount: num(row.message_count) })
                    : t('admin.turnKinds.nothingToMeasureFromThese')}>
                    {fmtMs(v)}
                  </span>
                ),
              },
            ]}
            data={shown}
          />
          <p className="admin-help-text">
            <strong>{t('admin.turnKinds.answer')}</strong> {t('admin.turnKinds.isThePopulationEveryResponse')}
            <strong> {t('admin.turnKinds.reading')}</strong> and <strong>drift</strong> {t('admin.turnKinds.declareThatTheyAreSomething')} <strong>{t('admin.turnKinds.replyTime')}</strong> {t('admin.turnKinds.isMeasuredFromTheMessage')}
          </p>
        </>
      )}
    </section>
  );
}

export default TurnKinds;
