import React from 'react';
import { useTranslation } from 'react-i18next';
import QueueHealth from './QueueHealth';
import type { AnalyticsDateRange } from '@ae/shared';

/**
 * THE OPERATIONS SURFACE: is it healthy RIGHT NOW.
 *
 * Queue health was on the Latency tab, and it is the one panel there read from CloudWatch
 * `GetMetricData` rather than from the Aurora ledger. Two things separate it from everything it sat
 * beside, and both matter more than the tab being crowded:
 *
 *   1. PROVENANCE. A CloudWatch series and a SQL aggregate over `v_turn_latency` do not share a
 *      population or a refresh cadence, so a reader comparing them is comparing two different things
 *      that happen to be rendered as numbers next to each other (tenet D7).
 *   2. TIME. Every other panel on Performance answers "over the window you chose". This one answers
 *      "now, and the short trailing window" - an operator reads it to decide whether to act today,
 *      not to understand last week.
 *
 * It keeps the date range because the series is still drawn over one; what changes is that the
 * question the surface asks is an operational one.
 */
interface OperationsTabProps {
  dateRange: AnalyticsDateRange;
  /** Queue health is served from the Aurora stack's own endpoint; Athena deployments have none. */
  analyticsMode?: 'athena' | 'aurora';
}

const OperationsTab: React.FC<OperationsTabProps> = ({ dateRange, analyticsMode }) => {
  const { t } = useTranslation();
  if (analyticsMode === 'athena') {
    return (
      <div className="admin-tab">
        <div className="admin-tab-banner">
          {t('admin.operations.queueHealthReadsCloudwatchMetrics')}
        </div>
      </div>
    );
  }
  return (
    <div className="admin-tab">
      {/* ── ONE QUESTION PER SURFACE ───────────────────────────────────────
          The latency shadow diff rendered here and is gone. It compares the turn ledger against the
          older derived path to say whether the measurement is still sound, which is a real question
          and not this one: a reader on a tab named for queue health met a panel about latency
          provenance, with no queue in it. "Both are watchdogs" is a property of the code rather than
          of the question a person came here to ask, and it is not enough to put them on one page.
          The component and its query are untouched; what changed is that nothing renders it. */}
      <QueueHealth dateRange={dateRange} />
    </div>
  );
};

export default OperationsTab;
