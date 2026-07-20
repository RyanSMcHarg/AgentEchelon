import React from 'react';

export interface LineSeries {
  label: string;
  points: number[];
  color?: string;
}
export interface ReferenceLine {
  value: number;
  label: string;
  color?: string;
  dashed?: boolean;
}

interface LineChartProps {
  series: LineSeries[];
  /** x-axis category labels (e.g. dates); shown sparsely. */
  categories?: string[];
  /** Horizontal reference lines — used to draw SLO/"good" TARGET lines so the
   *  viewer sees actual-vs-target at a glance. */
  referenceLines?: ReferenceLine[];
  yMax?: number;
  height?: number;
  width?: number;
  formatY?: (v: number) => string;
  label?: string;
}

const PAD_L = 48;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 22;
const SERIES_COLORS = ['var(--accent-500)', 'var(--status-good)', '#6366f1', '#db2777'];

/**
 * Axis line chart (SVG, no chart lib) — multi-series with optional TARGET
 * reference lines. Token-driven so it adopts the dark theme. Richer than
 * Sparkline: y-axis ticks + labels, sparse x labels, gridlines, and dashed
 * target lines (e.g. an SLO) labelled at the right edge.
 */
const LineChart: React.FC<LineChartProps> = ({
  series,
  categories,
  referenceLines = [],
  yMax,
  height = 220,
  width = 640,
  formatY = (v) => String(Math.round(v)),
  label,
}) => {
  const allValues = [
    ...series.flatMap((s) => s.points),
    ...referenceLines.map((r) => r.value),
  ].filter((v) => Number.isFinite(v));
  const n = Math.max(...series.map((s) => s.points.length), 0);

  if (n < 2 || allValues.length === 0) {
    return <div className="linechart-empty" style={{ width, height }} aria-label={label || 'Not enough data to chart'} />;
  }

  const max = yMax ?? (Math.max(...allValues) * 1.12 || 1);
  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (i / (n - 1)) * plotW;
  const y = (v: number) => PAD_T + plotH - (Math.min(v, max) / max) * plotH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  // Show at most ~6 x labels evenly.
  const labelStep = categories && categories.length > 6 ? Math.ceil(categories.length / 6) : 1;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="linechart"
      role="img"
      aria-label={label || `Line chart, ${series.length} series`}
    >
      {/* y gridlines + labels */}
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={PAD_L} x2={width - PAD_R} y1={y(tv)} y2={y(tv)} stroke="var(--surface-200, #e4e4e7)" strokeWidth="1" />
          <text x={PAD_L - 6} y={y(tv) + 3} textAnchor="end" className="linechart-axis-label">{formatY(tv)}</text>
        </g>
      ))}

      {/* x labels */}
      {categories && categories.map((c, i) => (
        i % labelStep === 0 ? (
          <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="linechart-axis-label">{c}</text>
        ) : null
      ))}

      {/* TARGET reference lines (dashed, labelled at right) */}
      {referenceLines.map((r, i) => (
        <g key={`ref-${i}`}>
          <line
            x1={PAD_L} x2={width - PAD_R} y1={y(r.value)} y2={y(r.value)}
            stroke={r.color || 'var(--status-warn)'}
            strokeWidth="1.5"
            strokeDasharray={r.dashed === false ? undefined : '4 3'}
          />
          <text x={width - PAD_R} y={y(r.value) - 4} textAnchor="end" className="linechart-ref-label" fill={r.color || 'var(--status-warn)'}>
            {r.label}
          </text>
        </g>
      ))}

      {/* series */}
      {series.map((s, si) => {
        const color = s.color || SERIES_COLORS[si % SERIES_COLORS.length];
        const pts = s.points.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        const last = s.points.length - 1;
        return (
          <g key={s.label}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(last)} cy={y(s.points[last])} r="3" fill={color} />
          </g>
        );
      })}
    </svg>
  );
};

export default LineChart;
