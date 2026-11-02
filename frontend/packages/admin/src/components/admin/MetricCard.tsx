import React from 'react';
import { useTranslation } from 'react-i18next';
import { evaluateTarget, formatTarget, statusGlyph, STATUS_VAR, type MetricTarget } from './metricTargets';
import { InfoTooltip, MetricProvenanceLinks } from './AdminHelp';

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
  /**
   * OPENS THIS CARD'S BREAKDOWN. Set only on a card that actually HAS one.
   *
   * Every card used to carry the hover treatment below - a lift, a shadow and an amber accent stripe -
   * and none of them did anything. That is the affordance for a card you can press, so the console was
   * inviting a click on fourteen cards that ignored it. Reported as "components appear clickable but
   * are not", which is exactly what an unconditional hover state says.
   *
   * Passing this is now the ONLY way to get that treatment, so the two cannot drift apart again: the
   * card that looks pressable is the card with a handler, by construction rather than by review. The
   * same rule was applied to table rows earlier (see DataTable.css) after the same report.
   */
  onDrill?: () => void;
  /** Whether this card's breakdown is currently open. Reported to assistive tech; ignored without `onDrill`. */
  drillOpen?: boolean;
}

const MetricCard: React.FC<MetricCardProps> = ({
  title, value, subtitle, target, rawValue, tooltip, onDrill, drillOpen,
}) => {
  const { t } = useTranslation();
  const status = target && rawValue != null && Number.isFinite(rawValue)
    ? evaluateTarget(rawValue, target)
    : null;
  const accent = status ? STATUS_VAR[status] : undefined;
  // THE EXPLANATION AND ITS SOURCES TRAVEL TOGETHER. A description without the guide and the code
  // behind it is a claim a reader has no way to check, and a stale claim reads exactly like a current
  // one - which is how the handover tooltip went on describing one producer after a second appeared.
  // So whenever the registry supplies provenance, the links are appended to the tooltip here rather
  // than at each call site, where forgetting them would be invisible.
  // THE REGISTRY HOLDS A KEY, NOT A SENTENCE, so the text is resolved here. `tooltip` still wins when
  // a call site passes one - card-specific nuance that does not belong to the metric everywhere it
  // appears - and that literal is itself on the localization ratchet's list to convert.
  const described = tooltip
    ?? (target?.descriptionKey ? t(target.descriptionKey) : undefined);
  const tip = described && target?.provenance
    ? (
      <>
        {described}
        <MetricProvenanceLinks provenance={target.provenance} />
      </>
    )
    : described;

  // A REAL BUTTON when it does something, a plain div when it does not. Not a div with an onClick and
  // a role: a button is focusable, reachable by keyboard and announced as pressable without any of
  // that being re-implemented here, and the tooltip inside it is itself a button, which is why the
  // title is excluded from the pressable region rather than the whole card being one element.
  const Card = onDrill ? 'button' : 'div';
  const interactive = onDrill
    ? {
        type: 'button' as const,
        onClick: onDrill,
        'aria-expanded': !!drillOpen,
        // The label says what pressing it does. "TTFF" alone, announced as a button, does not.
        'aria-label': `${title} — ${drillOpen ? 'hide' : 'show'} breakdown`,
      }
    : {};

  return (
    <Card
      className={`metric-card${onDrill ? ' metric-card--interactive' : ''}`}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
      {...interactive}
    >
      <div className="metric-card-title">
        {title}
        {tip && <InfoTooltip content={tip} label={`About ${title}`} />}
        {onDrill && <span className="metric-card-drill-glyph" aria-hidden>{drillOpen ? '▾' : '▸'}</span>}
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
    </Card>
  );
};

export default MetricCard;
