import React from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Optional accessible label; rendered as title element + aria-label. */
  label?: string;
}

/**
 * Sparkline — single-pass SVG line + filled area for admin tab banners.
 *
 * Per docs/DESIGN-SYSTEM.md aesthetic: amber accent + gradient fill,
 * no chart library. ~40 LOC of pure SVG; everything is CSS-token-driven
 * so it auto-adopts dark theme.
 */
export const Sparkline: React.FC<SparklineProps> = ({
  data,
  width = 320,
  height = 56,
  label,
}) => {
  // Hooks first — must run unconditionally on every render path to satisfy
  // the rules of hooks (the empty-state early-return below would otherwise
  // skip useId when data.length < 2).
  const gradId = React.useId();

  if (data.length < 2) {
    return (
      <div
        className="sparkline-empty"
        style={{ width, height }}
        aria-label={label || 'Trend chart unavailable'}
      />
    );
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  // Inset top/bottom by 4px so the stroke isn't clipped.
  const usableHeight = height - 8;
  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = 4 + usableHeight - ((v - min) / range) * usableHeight;
    return `${x},${y}`;
  });
  const pointsStr = points.join(' ');
  const lastPoint = points[points.length - 1].split(',').map(Number);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
      role="img"
      aria-label={label || `Trend across ${data.length} data points`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-400)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--accent-400)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,${height} ${pointsStr} ${width},${height}`}
        fill={`url(#${gradId})`}
      />
      <polyline
        points={pointsStr}
        fill="none"
        stroke="var(--accent-500)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Endpoint marker — amber halo on the latest value. */}
      <circle
        cx={lastPoint[0]}
        cy={lastPoint[1]}
        r="3"
        fill="var(--accent-500)"
      />
      <circle
        cx={lastPoint[0]}
        cy={lastPoint[1]}
        r="6"
        fill="var(--accent-500)"
        opacity="0.2"
      />
    </svg>
  );
};

export default Sparkline;
