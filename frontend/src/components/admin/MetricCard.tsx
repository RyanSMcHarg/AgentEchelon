import React from 'react';
import { evaluateTarget, formatTarget, statusGlyph, STATUS_VAR, type MetricTarget } from './metricTargets';
import { InfoTooltip } from './AdminHelp';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  /** Target definition — when provided with rawValue, the card shows the goal
   *  and a good/warn/bad status so people see what "good" is. */
  target?: MetricTarget;
  /** The numeric value to evaluate against `target` (the displayed `value` may
   *  be pre-formatted, so pass the raw number here). */
  rawValue?: number;
  /** Explanation shown in an info tooltip beside the title. Falls back to the
   *  target's `description` when omitted. */
  tooltip?: React.ReactNode;
}

const MetricCard: React.FC<MetricCardProps> = ({ title, value, subtitle, target, rawValue, tooltip }) => {
  const status = target && rawValue != null && Number.isFinite(rawValue)
    ? evaluateTarget(rawValue, target)
    : null;
  const accent = status ? STATUS_VAR[status] : undefined;
  const tip = tooltip ?? target?.description;

  return (
    <div className="metric-card" style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <div className="metric-card-title">
        {title}
        {tip && <InfoTooltip content={tip} label={`About ${title}`} />}
      </div>
      <div className="metric-card-value">{value}</div>
      {subtitle && <div className="metric-card-subtitle">{subtitle}</div>}
      {target && (
        <div
          className="metric-card-target"
          style={status ? { color: accent } : undefined}
          title={`Target ${formatTarget(target)}`}
        >
          {status && <span aria-hidden>{statusGlyph(status)} </span>}
          Target {formatTarget(target)}
        </div>
      )}
    </div>
  );
};

export default MetricCard;
