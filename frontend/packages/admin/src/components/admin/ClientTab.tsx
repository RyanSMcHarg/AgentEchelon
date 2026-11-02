import React from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import Sparkline from './Sparkline';
import DistributionBar from './DistributionBar';
import { InfoTooltip, GuideLinks, guide } from './AdminHelp';
import type { AnalyticsResult } from '@ae/shared';

/**
 * THE CLIENT SURFACE: what the BROWSER experienced.
 *
 * These two panels were on the Latency tab, beside the server legs, and they do not belong there.
 * They are read from a different store - `client_events`, written by the SPA's own capture, not the
 * turn ledger - so they share neither a clock nor a population with `ttff_ms` and its parts (gap G5
 * in LATENCY-TARGETS). Rendered side by side, a reader is invited to add a web vital to a router leg,
 * or to read a reconnect spike as part of a response time.
 *
 * Tenet D7 is the rule this follows: know which store answers your question, and use one source per
 * question. The split is about provenance, not about the Latency tab being crowded.
 *
 * NO FILTER SET, AND THAT IS NOT AN OMISSION. The Performance surface slices by classification,
 * assistant, role and version because a turn HAS those. A page load does not: `client_events` records
 * a browser and a session, so offering an assistant filter here would advertise a cut the data cannot
 * honour and quietly return everything.
 */
const WEB_VITAL_META: Record<string, { labelKey: string; goodMs: number; poorMs: number }> = {
  web_vital_ttfb: { labelKey: 'admin.client.vital.ttfb', goodMs: 800, poorMs: 1800 },
  web_vital_fcp:  { labelKey: 'admin.client.vital.fcp', goodMs: 1800, poorMs: 3000 },
  web_vital_lcp:  { labelKey: 'admin.client.vital.lcp', goodMs: 2500, poorMs: 4000 },
  web_vital_inp:  { labelKey: 'admin.client.vital.inp', goodMs: 200, poorMs: 500 },
  // CLS is stored as value*1000 by the service so the table can still treat
  // it as a number — labeled separately so the unit is right.
  web_vital_cls:  { labelKey: 'admin.client.vital.cls', goodMs: 100, poorMs: 250 },
};

interface ClientTabProps {
  /** Web-vital / timer percentiles from client_events.performance. */
  pageLoadData?: AnalyticsResult | null;
  /** websocket_connected/disconnected/reconnected counts per day. */
  connectionHealthData?: AnalyticsResult | null;
}

const ClientTab: React.FC<ClientTabProps> = ({ pageLoadData, connectionHealthData }) => {
  const { t } = useTranslation();
  const pageLoadRows = pageLoadData?.data ?? [];
  const connRows = connectionHealthData?.data ?? [];
  const totalConn = connRows.reduce((s, r) => s + Number(r.connected || 0), 0);
  const totalDisc = connRows.reduce((s, r) => s + Number(r.disconnected || 0), 0);
  const totalRecon = connRows.reduce((s, r) => s + Number(r.reconnected || 0), 0);
  const reconTrend = connRows.map((r) => Number(r.reconnected || 0));

  return (
    <div className="admin-tab">
      {/* ---------- Page-load (web-vitals) ---------- */}
      <div className="admin-section">
        <h3>
          {t('admin.client.pageLoadWebVitals')}
          <InfoTooltip
            label={t('admin.client.whereThesePageLoadFigures')}
            content={
              <>
                Real-user percentiles from the frontend <code>web-vitals</code> {t('admin.client.captureReportedPerMetricRather')}
              </>
            }
          />
        </h3>
        <p className="admin-tab-description">
          How the app itself performed in the browser, for the people who actually loaded it.
        </p>
        <GuideLinks guides={[guide(t('admin.guides.client.telemetry'), 'frontendObservability')]} />
        {pageLoadRows.length === 0 ? (
          <p className="admin-tab-empty">
            {t('admin.client.noPageLoadSamplesYet')}
            <code> /events</code> {t('admin.client.lambdaStartsReceivingPerformanceBatches')}
          </p>
        ) : (
          <div className="admin-pageload-stack">
            {pageLoadRows.map((r) => {
              const metric = String(r.metric || '');
              const meta = WEB_VITAL_META[metric];
              // Falls back to the raw metric id: a vital this console does not know yet is more useful
              // named than blank, and a key would be worse than either.
              const label = meta ? t(meta.labelKey) : metric;
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
        <h3>
          {t('admin.client.websocketConnectionHealth')}
          <InfoTooltip
            label={t('admin.client.howToReadTheConnection')}
            content={
              <>
                A spike in <strong>reconnects</strong> {t('admin.client.isUsuallyTheFirstSign')}
              </>
            }
          />
        </h3>
        <p className="admin-tab-description">
          Whether the live message connection is holding.
        </p>
        <div className="admin-tab-banner admin-tab-banner--compact">
          <div className="admin-tab-banner-label">
            <span className="admin-tab-banner-label-text">{t('admin.client.reconnectsTrailing')}</span>
            <span className="admin-tab-banner-label-value">{totalRecon.toLocaleString()}</span>
          </div>
          {reconTrend.length >= 2 ? (
            <Sparkline data={reconTrend} width={320} height={56} label={t('admin.client.reconnectsPerDay')} />
          ) : (
            <span className="admin-tab-banner-empty">{t('admin.client.noConnectionEventsYet')}</span>
          )}
        </div>
        <div className="admin-metrics-row">
          <MetricCard
            title={t('admin.client.connectsWindow')}
            value={totalConn.toLocaleString()}
            tooltip={t('admin.client.newWebsocketConnectionsOpenedOver')}
          />
          <MetricCard
            title={t('admin.client.disconnectsWindow')}
            value={totalDisc.toLocaleString()}
            tooltip={t('admin.client.websocketConnectionsClosedOverThe')}
          />
          <MetricCard
            title={t('admin.client.reconnectsWindow')}
            value={totalRecon.toLocaleString()}
            subtitle={totalConn > 0 ? t('admin.client.reconnectRate', { totalConn: ((totalRecon / totalConn) * 100).toFixed(1) }) : undefined}
            tooltip={t('admin.client.websocketReconnectionsOverTheWindow')}
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

export default ClientTab;
