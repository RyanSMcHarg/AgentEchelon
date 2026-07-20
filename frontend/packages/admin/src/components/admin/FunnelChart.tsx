import React from 'react';
import './FunnelChart.css';

export interface FunnelStep {
  /** Internal step id (e.g. signup_form_viewed). Used for React keys. */
  id: string;
  /** Human label for the step (e.g. "Form viewed"). */
  label: string;
  /** Total event count for this step (events.COUNT(*)). */
  eventCount: number;
  /** Distinct sessions that hit this step (events.COUNT DISTINCT session_id). */
  sessionCount: number;
}

interface FunnelChartProps {
  /** Steps in *canonical sequence order*. The component does not reorder. */
  steps: FunnelStep[];
  /**
   * Optional terminal step that should be styled as the "happy path"
   * outcome (e.g. signin_succeeded). If matched by id, it renders with
   * the success accent instead of the neutral chevron.
   */
  successStepId?: string;
  /**
   * Optional terminal step that should be styled as the failure outcome
   * (e.g. signup_failed). Drawn beneath the chevron row, peeling off the
   * funnel so it doesn't distort the conversion-rate math.
   */
  failureStepId?: string;
  /** Falls through to admin-tab-loading skeleton when true. */
  isLoading?: boolean;
}

/**
 * FunnelChart — horizontal-step conversion funnel.
 *
 * Why a custom component instead of DataTable: a funnel's information
 * IS the drop-off between adjacent steps, not the per-step row. Eyes
 * track the conversion deltas (chevron labels), not the raw counts.
 *
 * Width: each step is `flex: 1` so the chart fills its container; the
 * connector chevrons sit between tiles and carry the % retained.
 *
 * Aesthetics: chevron-row visual cribs from the existing DistributionBar
 * — mono uppercase labels, accent fill on the rail, secondary on the
 * drop-off. Failure-step rendered as a peel-off so it never inflates
 * the "% retained" between true funnel steps.
 */
export const FunnelChart: React.FC<FunnelChartProps> = ({
  steps,
  successStepId,
  failureStepId,
  isLoading = false,
}) => {
  if (isLoading) {
    return (
      <div className="funnel-chart funnel-chart--loading">
        <div className="skeleton skeleton--row" style={{ height: 88 }} />
      </div>
    );
  }

  // Split into the canonical funnel (everything except the failure step)
  // and the peel-off failure tile, if any.
  const funnelSteps = steps.filter((s) => s.id !== failureStepId);
  const failureStep = steps.find((s) => s.id === failureStepId) ?? null;

  if (funnelSteps.length === 0) {
    return (
      <div className="funnel-chart funnel-chart--empty">
        <p className="funnel-chart-empty-msg">
          No events recorded for this funnel in the current window.
        </p>
      </div>
    );
  }

  // Baseline for the conversion-rate math is the first step's session count.
  // Sessions are the right denominator (one user reloading the page should
  // not appear three times in the form-viewed total).
  const baseline = funnelSteps[0].sessionCount || 1;

  return (
    <div className="funnel-chart">
      <div className="funnel-chart-row" role="list">
        {funnelSteps.map((step, i) => {
          const isLast = i === funnelSteps.length - 1;
          const isSuccess = step.id === successStepId;
          const overallPct = (step.sessionCount / baseline) * 100;

          // Per-step drop-off is the *delta from the previous step*, not
          // from baseline. The first step's "drop-off" is undefined.
          const prev = i === 0 ? null : funnelSteps[i - 1];
          const stepPct = prev
            ? (step.sessionCount / (prev.sessionCount || 1)) * 100
            : null;

          return (
            <React.Fragment key={step.id}>
              <div
                role="listitem"
                className={`funnel-chart-step${isSuccess ? ' funnel-chart-step--success' : ''}`}
              >
                <div className="funnel-chart-step-rank">{String(i + 1).padStart(2, '0')}</div>
                <div className="funnel-chart-step-label">{step.label}</div>
                <div className="funnel-chart-step-value">
                  {step.sessionCount.toLocaleString()}
                  <span className="funnel-chart-step-unit">sessions</span>
                </div>
                <div className="funnel-chart-step-meta">
                  <span className="funnel-chart-step-events">
                    {step.eventCount.toLocaleString()} events
                  </span>
                  <span className="funnel-chart-step-pct">
                    {overallPct.toFixed(0)}% overall
                  </span>
                </div>
              </div>
              {!isLast && (
                <div className="funnel-chart-connector" aria-hidden="true">
                  <span className="funnel-chart-connector-rate">
                    {stepPct !== null ? `${(funnelSteps[i + 1].sessionCount / (step.sessionCount || 1) * 100).toFixed(0)}%` : '–'}
                  </span>
                  <svg className="funnel-chart-connector-arrow" viewBox="0 0 24 16" width="24" height="16" aria-hidden="true">
                    <path
                      d="M0 0 L18 8 L0 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {failureStep && (
        <div className="funnel-chart-failure" role="note">
          <span className="funnel-chart-failure-icon" aria-hidden="true">⤴</span>
          <span className="funnel-chart-failure-label">{failureStep.label}</span>
          <span className="funnel-chart-failure-value">
            {failureStep.sessionCount.toLocaleString()} sessions
          </span>
          <span className="funnel-chart-failure-events">
            {failureStep.eventCount.toLocaleString()} events
          </span>
        </div>
      )}
    </div>
  );
};

export default FunnelChart;
