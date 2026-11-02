import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import MetricCard from './MetricCard';
import DataTable from './DataTable';
import Sparkline from './Sparkline';
import { METRIC_TARGETS } from './metricTargets';
import type { AnalyticsResult } from '@ae/shared';

interface OverviewTabProps {
  volumeData: AnalyticsResult | null;
  intentData: AnalyticsResult | null;
  /** Session DAU — distinct users that auth-resolved at least once
   *  per day (from session_started). Includes signed-in-and-bounced users. */
  activeUsersData?: AnalyticsResult | null;
  /** Engaged messaging DAU — distinct users that connected the
   *  WebSocket OR sent a message OR listed channel messages. Excludes
   *  signed-in-and-bounced. The right "actually using the product" signal. */
  messagingUsersData?: AnalyticsResult | null;
  /** Per-day { error_count, total_events } from client_events. */
  errorRateData?: AnalyticsResult | null;
  isLoading: boolean;
}

const OverviewTab: React.FC<OverviewTabProps> = ({
  volumeData,
  intentData,
  activeUsersData,
  messagingUsersData,
  errorRateData,
  isLoading,
}) => {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <div className="admin-tab">
        <div className="skeleton skeleton--chart" />
        <div className="metric-cards-grid skeleton-grid">
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
        </div>
        <div className="admin-section skeleton-stack">
          <div className="skeleton skeleton--title" style={{ width: '32%' }} />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </div>
      </div>
    );
  }

  const totalMessages = volumeData?.data.reduce((sum, r) => sum + Number(r.message_count || 0), 0) ?? 0;
  const totalConversations = volumeData?.data.reduce((sum, r) => sum + Number(r.conversation_count || 0), 0) ?? 0;
  const uniqueDates = volumeData?.data.length ?? 0;
  const messageTrend = volumeData?.data
    .slice()
    .reverse()
    .map((r) => Number(r.message_count || 0)) ?? [];

  // Client-events aggregates. Active users from client_events.session_started:
  // collapse per-tier rows into a daily total, then trend.
  const dauByDate = new Map<string, number>();
  for (const r of activeUsersData?.data ?? []) {
    const date = String(r.date || '');
    dauByDate.set(date, (dauByDate.get(date) || 0) + Number(r.active_users || 0));
  }
  const sortedDauDates = Array.from(dauByDate.keys()).sort();
  const dauTrend = sortedDauDates.map((d) => dauByDate.get(d) || 0);
  const dauTotal = dauTrend.reduce((a, b) => a + b, 0);
  const dauLatest = dauTrend.length > 0 ? dauTrend[dauTrend.length - 1] : 0;

  // Messaging DAU — same shape, different signal. The gap between this and
  // session DAU is the "signed in but didn't engage" cohort.
  const mauByDate = new Map<string, number>();
  for (const r of messagingUsersData?.data ?? []) {
    const date = String(r.date || '');
    mauByDate.set(date, (mauByDate.get(date) || 0) + Number(r.active_messaging_users || 0));
  }
  const sortedMauDates = Array.from(mauByDate.keys()).sort();
  const mauTrend = sortedMauDates.map((d) => mauByDate.get(d) || 0);
  const mauLatest = mauTrend.length > 0 ? mauTrend[mauTrend.length - 1] : 0;

  // Error rate aggregates: sum errors / total over the window.
  const errorRows = errorRateData?.data ?? [];
  const totalErrors = errorRows.reduce((sum, r) => sum + Number(r.error_count || 0), 0);
  const totalEvents = errorRows.reduce((sum, r) => sum + Number(r.total_events || 0), 0);
  const errorPct = totalEvents > 0 ? (totalErrors / totalEvents) * 100 : 0;
  const errorTrend = errorRows
    .slice()
    .map((r) => Number(r.error_count || 0));

  // Intent distribution — the query (both Athena and Aurora) emits `intent` +
  // `count`, not `intent_type`/`percentage`. Read `intent` and derive the
  // percentage client-side so the card renders in both modes (was blank before).
  const intentRows = intentData?.data ?? [];
  const intentTotal = intentRows.reduce((sum, r) => sum + Number(r.count || 0), 0);
  const intentTable = intentRows.map((r) => ({
    intent: r.intent,
    count: r.count,
    percentage: intentTotal > 0 ? (Number(r.count || 0) / intentTotal) * 100 : 0,
  }));

  return (
    <div className="admin-tab">
      {messageTrend.length >= 2 && (
        <div className="admin-tab-banner">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">{t('admin.overview.messageVolumeTrailingWindow')}</span>
            <span className="admin-tab-banner-label-value">{totalMessages.toLocaleString()}</span>
          </div>
          <Sparkline data={messageTrend} width={320} height={56} label={t('admin.overview.messageVolumeTrend')} />
        </div>
      )}
      <div className="metric-cards-grid">
        <MetricCard title={t('admin.overview.totalMessages')} value={totalMessages.toLocaleString()} />
        <MetricCard title={t('admin.overview.activeConversations')} value={totalConversations.toLocaleString()} />
        <MetricCard title={t('admin.overview.activeDays')} value={uniqueDates} />
        <MetricCard title={t('admin.overview.avgMessagesDay')} value={uniqueDates > 0 ? Math.round(totalMessages / uniqueDates) : 0} />
      </div>

      {/* Health row — three signals on one glance: who signed in,
          who actually engaged with messaging, and how the platform is
          erroring. The gap between sessions and messaging users is the
          "auth'd but bounced" cohort and the most useful product signal. */}
      <div className="admin-tab-banner-row admin-tab-banner-row--three">
        <div className="admin-tab-banner admin-tab-banner--compact">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">{t('admin.overview.signedInUsersSessions')}</span>
            <span className="admin-tab-banner-label-value">{dauLatest.toLocaleString()}</span>
          </div>
          {dauTrend.length >= 2 ? (
            <Sparkline data={dauTrend} width={200} height={42} label={t('admin.overview.signedInUsersTrend')} />
          ) : (
            <span className="admin-tab-banner-empty">{t('admin.overview.noSessionDataYet')}</span>
          )}
        </div>
        <div className="admin-tab-banner admin-tab-banner--compact admin-tab-banner--accented">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">{t('admin.overview.messagingUsersEngaged')}</span>
            <span className="admin-tab-banner-label-value">{mauLatest.toLocaleString()}</span>
          </div>
          {mauTrend.length >= 2 ? (
            <Sparkline data={mauTrend} width={200} height={42} label={t('admin.overview.messagingUsersTrend')} />
          ) : (
            <span className="admin-tab-banner-empty">{t('admin.overview.noMessagingDataYet')}</span>
          )}
        </div>
        <div className="admin-tab-banner admin-tab-banner--compact">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">{t('admin.overview.errorRateTrailing')}</span>
            <span className="admin-tab-banner-label-value">
              {errorPct.toFixed(2)}<small style={{ fontSize: '0.6em', fontWeight: 500, marginLeft: 4 }}>%</small>
            </span>
          </div>
          {errorTrend.length >= 2 ? (
            <Sparkline data={errorTrend} width={200} height={42} label={t('admin.overview.errorsPerDay')} />
          ) : (
            <span className="admin-tab-banner-empty">{t('admin.overview.noErrorDataYet')}</span>
          )}
        </div>
      </div>

      {!activeUsersData && !messagingUsersData && !errorRateData && (
        <p className="admin-tab-description" style={{ marginTop: 0 }}>
          <Trans i18nKey="admin.overview.bandsPending" components={{ c: <code /> }} />
        </p>
      )}

      <div className="metric-cards-grid">
        <MetricCard title={t('admin.overview.signedInWindow')} value={dauTotal.toLocaleString()} subtitle={t('admin.overview.anyCognitoSession')} />
        <MetricCard
          title={t('admin.overview.messagingWindow')}
          value={mauTrend.reduce((a, b) => a + b, 0).toLocaleString()}
          subtitle={dauTotal > 0 ? t('admin.overview.ofSignedIn', { dauTotal: Math.round((mauTrend.reduce((a, b) => a + b, 0) / dauTotal) * 100) }) : t('admin.overview.engagedAtLeastOnce')}
        />
        <MetricCard title={t('admin.overview.errorsWindow')} value={totalErrors.toLocaleString()} subtitle={t('admin.overview.totalEvents', { totalEvents: totalEvents.toLocaleString() })} />
        <MetricCard title={t('admin.overview.error')} value={`${errorPct.toFixed(2)}%`} target={METRIC_TARGETS.error_rate} rawValue={errorPct} />
      </div>

      {volumeData && volumeData.data.length > 0 && (
        <div className="admin-section">
          <h3>{t('admin.overview.messageVolumeByDate')}</h3>
          <DataTable
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'message_count', label: 'Messages' },
              { key: 'conversation_count', label: 'Conversations' },
            ]}
            data={volumeData.data}
          />
        </div>
      )}

      {intentData && intentData.data.length > 0 && (
        <div className="admin-section">
          <h3>{t('admin.overview.intentDistribution')}</h3>
          <DataTable
            columns={[
              { key: 'intent', label: 'Intent' },
              { key: 'count', label: 'Count' },
              { key: 'percentage', label: 'Percentage', render: (v) => `${Number(v).toFixed(1)}%` },
            ]}
            data={intentTable}
          />
        </div>
      )}
    </div>
  );
};

export default OverviewTab;
