import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { computeAlerts, type Alert, type AlertSources } from './alerts';
import { STATUS_VAR } from './metricTargets';
import { type PerformanceFilters } from './PerformanceFilters';
import { InfoTooltip } from './AdminHelp';
import type { AnalyticsResult } from '@ae/shared';

/**
 * Alerts — the consolidated "what is wrong right now" view (SPEC-ADMIN-CONSOLE "Alerts"). It scans the
 * results the dashboard already loads (effectiveness, latency, model effectiveness, flagged, error rate)
 * for anything in `bad`/`warn` status against `metricTargets.ts`, plus literal error rows, and lists each
 * with a link to its drill. No new backend query — this is assembly over data already in memory.
 */
interface AlertsTabProps {
  intentEffectiveness: AnalyticsResult | null;
  latency: AnalyticsResult | null;
  modelEffectiveness: AnalyticsResult | null;
  flagged: AnalyticsResult | null;
  errorRate: AnalyticsResult | null;
  isLoading: boolean;
  /**
   * The Performance surface's filters, so a latency alert describes the population the operator has
   * narrowed to and is judged against that tier's band - the same rows and the same band the Latency
   * tab shows them. Without it, an operator could read a green card on one tab and an alert about the
   * same window on the other.
   */
  filters: PerformanceFilters;
  /** Navigate to a tab (the alert's drill target). */
  onNavigate: (tab: string) => void;
}

const CATEGORY_LABEL: Record<Alert['category'], string> = {
  runtime: 'Runtime',
  latency: 'Latency',
  quality: 'Quality',
};

const AlertRow: React.FC<{ alert: Alert; onNavigate: (tab: string) => void }> = ({ alert, onNavigate }) => {
  // No translator here: this row renders an Alert whose title and detail were already resolved by
  // `computeAlerts`, and its only other strings were a CSS border value that never belonged in a locale file.
  const color = STATUS_VAR[alert.severity === 'error' ? 'bad' : 'warn'];
  return (
    <button
      className="admin-alert-row"
      onClick={() => onNavigate(alert.tab)}
      // The drill target + classification are exposed for the operator-flow e2e, which reads the
      // expected tab off the row, clicks it, and asserts navigation lands on `?admin=<data-tab>`.
      data-tab={alert.tab}
      data-category={alert.category}
      data-severity={alert.severity}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%', textAlign: 'left',
        padding: 'var(--space-3) var(--space-4)', background: 'var(--surface-0)',
        border: '1px solid var(--surface-200)', borderLeft: `3px solid ${color}`,
        borderRadius: 'var(--radius-md)', cursor: 'pointer', marginBottom: 'var(--space-2)',
      }}
    >
      <span aria-hidden style={{ color, fontWeight: 700, fontSize: 'var(--text-lg)' }}>
        {alert.severity === 'error' ? '✗' : '⚠'}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', textTransform: 'uppercase',
        letterSpacing: 'var(--tracking-wide)', color: 'var(--text-secondary)', flex: '0 0 4.5rem',
      }}>
        {CATEGORY_LABEL[alert.category]}
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{alert.title}</span>
        <span style={{ color: 'var(--text-secondary)', marginLeft: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
          {alert.detail}
        </span>
      </span>
      <span aria-hidden style={{ color: 'var(--text-tertiary)', fontWeight: 700 }}>›</span>
    </button>
  );
};

const AlertsTab: React.FC<AlertsTabProps> = ({
  intentEffectiveness, latency, modelEffectiveness, flagged, errorRate, filters, isLoading, onNavigate,
}) => {
  const { t } = useTranslation();
  const alerts = useMemo(() => {
    const sources: AlertSources = {
      intentEffectiveness: (intentEffectiveness?.data ?? []) as Array<Record<string, unknown>>,
      latency: (latency?.data ?? []) as Array<Record<string, unknown>>,
      modelEffectiveness: (modelEffectiveness?.data ?? []) as Array<Record<string, unknown>>,
      flagged: (flagged?.data ?? []) as Array<Record<string, unknown>>,
      errorRate: (errorRate?.data ?? []) as Array<Record<string, unknown>>,
      filters,
    };
    return computeAlerts(sources);
  }, [intentEffectiveness, latency, modelEffectiveness, flagged, errorRate, filters]);

  const errors = alerts.filter((a) => a.severity === 'error');
  const warnings = alerts.filter((a) => a.severity === 'warn');

  if (isLoading) return <div className="admin-tab-loading">{t('admin.alerts.scanningForAlerts')}</div>;

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>
          Alerts{' '}
          <InfoTooltip
            label={t('admin.alerts.aboutAlerts')}
            content={t('admin.alerts.everythingCurrentlyInBadOr')}
          />
        </h3>
      </div>

      <p className="admin-tab-description">
        {alerts.length === 0
          ? t('admin.alerts.noActiveAlertsEveryMeasured')
          : t('admin.alerts.andAnAlertIsAny', { errors: errors.length, errors2: errors.length === 1 ? 'error' : 'errors', warnings: warnings.length, warnings2: warnings.length === 1 ? 'warning' : 'warnings' })}
      </p>

      {alerts.length === 0 ? (
        <div className="admin-info-banner" style={{ borderLeft: `3px solid ${STATUS_VAR.good}` }}>
          ✓ All clear — no runtime errors, latency-SLO breaches, or quality regressions in this window.
        </div>
      ) : (
        <>
          {errors.length > 0 && (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <h4 style={{ margin: '0 0 var(--space-2)', color: STATUS_VAR.bad }}>Errors ({errors.length})</h4>
              {errors.map((a) => <AlertRow key={a.id} alert={a} onNavigate={onNavigate} />)}
            </div>
          )}
          {warnings.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 var(--space-2)', color: STATUS_VAR.warn }}>Warnings ({warnings.length})</h4>
              {warnings.map((a) => <AlertRow key={a.id} alert={a} onNavigate={onNavigate} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AlertsTab;
