import React from 'react';

interface DistributionBarProps {
  /** Lower bound of the axis (e.g., 0 ms). */
  min: number;
  /** Upper bound — typically the P99 + some headroom, or a fixed cap. */
  max: number;
  /** Named markers along the axis (e.g., P50/P95/P99). */
  markers: Array<{
    value: number;
    label: string;
    /** 'primary' (amber) | 'secondary' (zinc) — defaults to 'secondary'. */
    intensity?: 'primary' | 'secondary';
  }>;
  /** Unit suffix for the marker labels — e.g., 'ms', '%'. */
  unit?: string;
  /** Display height — defaults to 8px (the rail) plus 28px for labels above. */
  width?: number | string;
}

/**
 * DistributionBar — horizontal axis with named percentile markers.
 *
 * Replaces the "three latency numbers stacked in cards" pattern with one
 * scannable image. Designed for P50/P95/P99 latency, score histograms,
 * cost distributions — anywhere a single number needs to be located on
 * a continuous range.
 *
 * Aesthetics:
 *   - amber-gradient rail (from accent-100 to accent-300)
 *   - markers are vertical lines with mono uppercase labels above
 *   - primary marker (typically P95) gets amber + bolder weight
 */
export const DistributionBar: React.FC<DistributionBarProps> = ({
  min,
  max,
  markers,
  unit = '',
  width = '100%',
}) => {
  const range = max - min || 1;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - min) / range) * 100));

  return (
    <div className="distribution-bar" style={{ width }}>
      <div className="distribution-bar-markers">
        {markers.map((m, i) => {
          const left = pct(m.value);
          const align = left > 75 ? 'flex-end' : left < 25 ? 'flex-start' : 'center';
          const transform = left > 75 ? 'translateX(-100%)' : left < 25 ? 'translateX(0)' : 'translateX(-50%)';
          return (
            <div
              key={i}
              className={`distribution-bar-marker distribution-bar-marker--${m.intensity || 'secondary'}`}
              style={{ left: `${left}%`, alignItems: align, transform }}
            >
              <span className="distribution-bar-marker-label">{m.label}</span>
              <span className="distribution-bar-marker-value">
                {m.value.toLocaleString()}
                {unit && <span className="distribution-bar-marker-unit">{unit}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <div className="distribution-bar-rail" role="img" aria-label="Distribution">
        {markers.map((m, i) => (
          <span
            key={i}
            className={`distribution-bar-tick distribution-bar-tick--${m.intensity || 'secondary'}`}
            style={{ left: `${pct(m.value)}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="distribution-bar-bounds">
        <span>
          {min.toLocaleString()}
          {unit}
        </span>
        <span>
          {max.toLocaleString()}
          {unit}
        </span>
      </div>
    </div>
  );
};

export default DistributionBar;
