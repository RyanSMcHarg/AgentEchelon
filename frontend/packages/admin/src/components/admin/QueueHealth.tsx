/**
 * IS THE QUEUE MECHANISM WORKING, AND WHAT IS IT COSTING PEOPLE (ADR-033).
 *
 * The operator's question here is not "how long did turns take" - the latency surface answers that.
 * It is whether a deliberate wait is being spent well, and whether the design's central claim is
 * holding.
 *
 * ── WHY IT SITS BESIDE THE INTERACTION BREAKDOWN AND NOT IN THE HEADLINE CARDS ───────────────────
 *
 * Queueing is a property of SOME turns. Folded into the aggregate, a deliberate wait becomes
 * indistinguishable from a slow one, and the number that was supposed to expose the cost is the first
 * thing to hide it.
 *
 * ── NULL IS NOT ZERO, AND THIS IS THE COMPONENT WHERE THAT MATTERS ───────────────────────────────
 *
 * A metric with no datapoints has never been emitted. For `Reaper releases` that is the HEALTHY
 * reading; for `Messages queued` it means the mechanism has not run at all. Rendering both as `0`
 * would let "queueing is switched off" read as "queueing is working perfectly", which is the one
 * misreading this panel must not enable. So an absent value renders as a dash and says why.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { fetchQueueHealth, type QueueHealthRow } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

interface Props {
  dateRange: AnalyticsDateRange;
}

/** The rows an operator should look at first, and why. Order is the reading order, not the emit order. */
const ALARMING = new Set(['Overflow drops', 'Reaper releases']);

export default function QueueHealth({ dateRange }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<QueueHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchQueueHealth(dateRange));
    } catch (e) {
      // NOT an empty table. Zeroes would read as "the mechanism is healthy and idle", which is the
      // one conclusion a failed read must never support.
      setError(e instanceof Error ? e.message : t('admin.queueHealth.couldNotReadTheQueue'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { void load(); }, [load]);

  const display = rows.map((r) => ({
    metric: r.metric,
    // An absent value is rendered as a dash rather than a zero, and the meaning column carries the
    // difference. See the header comment: this is the distinction the panel exists to preserve.
    value: r.value === null ? '—' : Number.isInteger(r.value) ? r.value : r.value.toFixed(1),
    meaning: r.meaning,
    _alarming: ALARMING.has(r.metric) && typeof r.value === 'number' && r.value > 0,
  }));

  return (
    <section className="admin-panel">
      <h3>
        {t('admin.queueHealth.queueHealth')}
        <InfoTooltip content={
          t('admin.queueHealth.whetherTheOneTurnAt')
          + t('admin.queueHealth.keptApartFromTheLatency')
          + t('admin.queueHealth.averagingItInWouldMake')
          + t('admin.queueHealth.hasNeverBeenEmittedWhich')
          + t('admin.queueHealth.zeroIsTheHealthyReading')
        } />
      </h3>

      {error && (
        <p className="admin-error" role="alert">
          {error}. The numbers below are not shown rather than shown as zero, because a failed read
          must not read as a healthy one.
        </p>
      )}

      {/* DataTable has no loading prop: the loading state is said in words rather than mimed by an
          empty table, which would read as "nothing is queued" - the misreading this panel avoids. */}
      {!error && loading && <p className="admin-muted">{t('admin.queueHealth.readingTheQueueMetrics')}</p>}
      {!error && !loading && (
        <DataTable
          data={display}
          columns={[
            { key: 'metric', label: 'Metric' },
            { key: 'value', label: 'Value' },
            { key: 'meaning', label: t('admin.queueHealth.whatItTellsYou') },
          ]}
          emptyMessage={t('admin.queueHealth.noQueueActivityInThis')}
        />
      )}
    </section>
  );
}
