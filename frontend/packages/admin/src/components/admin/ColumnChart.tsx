/**
 * A COLUMN CHART of one series over ordered categories (days), drawn in SVG with the console's chart tokens, no chart
 * library. Columns are at most 24px wide with a 4px rounded top, square at the baseline; the grid is hairline. Each
 * column's band is its hover and focus target, and shows the column's label and value; the caller gives a table twin.
 */
import React, { useState } from 'react';
import { countTicks } from './meetingLanes';
import { useMeasuredWidth } from './useMeasuredWidth';

export interface Column { key: string; label: string; value: number }

interface ColumnChartProps {
  title: string;
  columns: Column[];
  height?: number;
  /** The series' token: `--chart-1` unless the chart is about something else. */
  color?: string;
}

const PAD_L = 32;
const PAD_R = 8;
const PAD_T = 8;
const AXIS_H = 20;
const MAX_BAR = 24;

/** A column's path: square at the baseline, 4px rounded at its top. */
function columnPath(x: number, w: number, top: number, base: number): string {
  const r = Math.min(4, w / 2, Math.max(0, base - top));
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

const ColumnChart: React.FC<ColumnChartProps> = ({ title, columns, height = 150, color = 'var(--chart-1)' }) => {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>(320);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...columns.map((c) => c.value));
  const ticks = countTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(10, width - PAD_L - PAD_R);
  const plotH = height - PAD_T - AXIS_H;
  const band = plotW / Math.max(1, columns.length);
  const barW = Math.max(2, Math.min(MAX_BAR, band - 2));
  const y = (v: number) => PAD_T + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(columns.length / 7));
  const hovered = hover === null ? null : columns[hover];

  return (
    <figure className="meetings-chart" data-testid="column-chart">
      <figcaption className="meetings-chart-title">{title}</figcaption>
      <div ref={ref} className="meetings-chart-plot">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={PAD_L} x2={width - PAD_R} y1={y(tv)} y2={y(tv)} className="meetings-grid" />
              <text x={PAD_L - 6} y={y(tv) + 4} textAnchor="end" className="meetings-axis">{tv.toLocaleString()}</text>
            </g>
          ))}
          {columns.map((c, i) => {
            const cx = PAD_L + band * i + band / 2;
            return (
              <g key={c.key}>
                {c.value > 0 && <path d={columnPath(cx - barW / 2, barW, y(c.value), y(0))} fill={color} opacity={hover === null || hover === i ? 1 : 0.55} />}
                <rect
                  x={PAD_L + band * i} y={PAD_T} width={band} height={plotH} fill="transparent"
                  tabIndex={0} role="img" aria-label={`${c.label}: ${c.value}`} data-testid="column"
                  onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                />
                {i % labelEvery === 0 && <text x={cx} y={height - 6} textAnchor="middle" className="meetings-axis">{c.label}</text>}
              </g>
            );
          })}
        </svg>
        {hovered && hover !== null && (
          <div className="meetings-tip" role="presentation" style={{ left: Math.min(width - 120, Math.max(0, PAD_L + band * hover + band / 2 - 50)) }}>
            <strong>{hovered.value.toLocaleString()}</strong>
            <span>{hovered.label}</span>
          </div>
        )}
      </div>
    </figure>
  );
};

export default ColumnChart;
