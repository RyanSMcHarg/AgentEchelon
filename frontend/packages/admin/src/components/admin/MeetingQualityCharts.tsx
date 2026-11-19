/**
 * EACH ATTENDEE'S CONNECTION OVER THE MEETING (SPEC-ASSISTANT-MEETINGS FR47): one chart per measure (round trip, jitter,
 * audio lost each way, bandwidth available each way), one line per person, every chart on the timeline's time axis and
 * gutters so an instant sits at the same x in each (`meetingView.ts`). The threshold the server judged a measure against
 * (FR74) is drawn as a dashed reference line on its chart.
 *
 * THE MOMENT IS SHARED: pointing at a chart, or moving along one with the arrow keys, marks the same instant on every chart
 * and on the timeline, and each chart's readout lists every person's reading at it. A drag across a chart zooms the
 * meeting's view to that range. The people are told apart by a color and a dash in a fixed order, named in the legend, and
 * a legend entry picks one person out. A table beside the charts holds each connection's readings and its figures, drawn
 * only while it is open.
 *
 * THE READOUT IS ANNOUNCED ONLY FOR A MOVE MADE WITH THE KEYS: a screen reader hears each step an arrow key takes, and is not
 * read every reading a pointer passes over. A drag holds the pointer (pointer capture), so it ends where it is released even
 * outside the chart.
 *
 * The readings are the server's (`connectivity` on the detail answer, else the `connectivitySample` events); a meeting
 * with none says so rather than drawing empty charts. A person is shown by their id.
 */
import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExperienceThresholds } from '../../services/meetingAnalyticsService';
import type { ConnectivityLane } from './meetingLanes';
import { timeTicks } from './meetingLanes';
import { clockTime, formatSeconds } from './meetingFormat';
import { useMeasuredWidth } from './useMeasuredWidth';
import {
  CONNECTIVITY_SAMPLE_INTERVAL_MS, LINE_GAP_MS, PLOT_LEFT, PLOT_RIGHT, QUALITY_MEASURES, clampView, cx, qualityLines, readingAt, seriesStyle,
  timeAt, timeScale, type QualityLine, type QualityMeasure, type TimeView,
} from './meetingView';
import type { TimelineBand } from './MeetingTimeline';

const CHART_H = 132;
const PAD_T = 10;
const PAD_B = 20;
const DRAG_PX = 6;

/** The threshold a measure is judged against, where it has one. */
function thresholdOf(measure: QualityMeasure, t: ExperienceThresholds | undefined): number | null {
  if (!t) return null;
  if (measure === 'rttMs') return t.roundTripMs;
  if (measure === 'audioJitterMs') return t.jitterMs;
  if (measure === 'audioLossSendPct' || measure === 'audioLossReceivePct') return t.packetLossPct;
  return null;
}

const valueText = (v: number): string => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10));

/** A line's path across the view, broken where the app sent no reading for longer than two intervals. */
function pathOf(line: QualityLine, x: (t: number) => number, y: (v: number) => number, view: TimeView): string {
  const pts = line.points.filter((p, i, all) => (p.at >= view.from - LINE_GAP_MS && p.at <= view.to + LINE_GAP_MS) || (all[i + 1] && all[i + 1].at >= view.from && p.at < view.from));
  let d = '';
  pts.forEach((p, i) => {
    const join = i > 0 && p.at - pts[i - 1].at <= LINE_GAP_MS;
    d += `${join ? 'L' : 'M'}${x(p.at + CONNECTIVITY_SAMPLE_INTERVAL_MS / 2).toFixed(1)},${y(p.v).toFixed(1)} `;
  });
  return d.trim();
}

interface ChartProps {
  measure: QualityMeasure;
  lines: QualityLine[];
  styleOf: (person: string) => { color: string; dash?: string };
  picked: string | null;
  threshold: number | null;
  view: TimeView;
  full: TimeView;
  width: number;
  cursor: number | null;
  onCursor: (at: number | null) => void;
  onView: (v: TimeView) => void;
  band?: TimelineBand | null;
}

const QualityChart: React.FC<ChartProps> = ({ measure, lines, styleOf, picked, threshold, view, full, width, cursor, onCursor, onView, band }) => {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const [announce, setAnnounce] = useState(false);
  const x = timeScale(view, width);
  const shown = lines.flatMap((l) => l.points.filter((p) => p.at + CONNECTIVITY_SAMPLE_INTERVAL_MS >= view.from && p.at <= view.to).map((p) => p.v));
  const max = Math.max(1, ...shown, threshold ?? 0) * 1.12;
  const plotH = CHART_H - PAD_T - PAD_B;
  const y = (v: number) => PAD_T + plotH - (Math.min(v, max) / max) * plotH;
  const yTicks = [0, 0.5, 1].map((f) => max * f);
  const xTicks = timeTicks(view.from, view.to, Math.max(3, Math.floor((width - PLOT_LEFT - PLOT_RIGHT) / 110)));
  const withSeconds = view.to - view.from < 10 * 60_000;
  const title = t(`admin.meetings.connectivity.measures.${measure}`);
  const at = cursor !== null && cursor >= view.from && cursor <= view.to ? cursor : null;
  const readings = at === null ? [] : lines.map((l) => ({ person: l.personKey, r: readingAt(l, at) })).filter((r) => r.r !== null);

  const pointerX = (e: React.PointerEvent): number => {
    const box = svgRef.current?.getBoundingClientRect();
    return box && box.width ? ((e.clientX - box.left) / box.width) * width : e.clientX;
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? CONNECTIVITY_SAMPLE_INTERVAL_MS : e.key === 'ArrowLeft' ? -CONNECTIVITY_SAMPLE_INTERVAL_MS : 0;
    if (step) {
      e.preventDefault();
      setAnnounce(true);
      const from = at ?? view.from;
      onCursor(Math.min(view.to, Math.max(view.from, from + step)));
    } else if (e.key === 'Escape') onCursor(null);
  };

  return (
    <figure className={cx('meetings-chart', 'meetings-quality-chart')} data-testid={`quality-${measure}`}>
      <figcaption className="meetings-chart-title">{title}</figcaption>
      <div
        className="meetings-quality-readout" data-testid={`readout-${measure}`} aria-live={announce ? 'polite' : 'off'}
      >
        {at === null ? <span className="meetings-muted">{t('admin.meetings.qualityChart.pointAt')}</span> : (
          <>
            <span className={cx('meetings-num', 'meetings-muted')}>{clockTime(at, true)}</span>
            {readings.length === 0 && <span className="meetings-muted">{t('admin.meetings.qualityChart.noReading')}</span>}
            {readings.map(({ person, r }) => (
              <span key={person} className="meetings-quality-reading">
                <svg width="14" height="6" aria-hidden="true"><line x1="0" x2="14" y1="3" y2="3" stroke={styleOf(person).color} strokeWidth="2" strokeDasharray={styleOf(person).dash} /></svg>
                <strong className="meetings-num">{valueText(r!.v)}</strong> <code>{person}</code>
              </span>
            ))}
          </>
        )}
      </div>
      <svg
        ref={svgRef} width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`} tabIndex={0} role="img"
        aria-label={t('admin.meetings.qualityChart.chartLabel', { measure: title, count: lines.length })}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          const px = pointerX(e);
          if (px < PLOT_LEFT) return;
          setDrag({ x0: px, x1: px });
          // THE DRAG HOLDS THE POINTER, so a release outside the chart still ends it here.
          if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const px = pointerX(e);
          if (drag) setDrag({ ...drag, x1: px });
          setAnnounce(false);
          onCursor(px >= PLOT_LEFT ? timeAt(px, view, width) : null);
        }}
        onPointerUp={(e) => {
          if (drag && Math.abs(drag.x1 - drag.x0) >= DRAG_PX) {
            onView(clampView({ from: timeAt(Math.min(drag.x0, drag.x1), view, width), to: timeAt(Math.max(drag.x0, drag.x1), view, width) }, full));
          }
          setDrag(null);
          if (typeof e.currentTarget.hasPointerCapture === 'function' && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => { if (!drag) onCursor(null); }}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PLOT_LEFT} x2={width - PLOT_RIGHT} y1={y(v)} y2={y(v)} className="meetings-grid" />
            <text x={PLOT_LEFT - 8} y={y(v) + 4} textAnchor="end" className="meetings-axis">{valueText(v)}</text>
          </g>
        ))}
        {xTicks.map((tk) => (
          <text key={tk} x={x(tk)} y={CHART_H - 4} textAnchor="middle" className="meetings-axis">{clockTime(tk, withSeconds)}</text>
        ))}
        {band && band.to >= view.from && band.from <= view.to && (
          <rect
            className="meetings-band" data-testid="quality-band"
            x={Math.max(PLOT_LEFT, x(band.from))} width={Math.max(3, Math.min(width - PLOT_RIGHT, x(band.to)) - Math.max(PLOT_LEFT, x(band.from)))}
            y={PAD_T} height={plotH}
          />
        )}
        {threshold !== null && (
          <g data-testid={`threshold-${measure}`}>
            <line x1={PLOT_LEFT} x2={width - PLOT_RIGHT} y1={y(threshold)} y2={y(threshold)} className="meetings-threshold" />
            <text x={width - PLOT_RIGHT} y={y(threshold) - 4} textAnchor="end" className="meetings-threshold-label">
              {t('admin.meetings.qualityChart.threshold', { value: valueText(threshold) })}
            </text>
          </g>
        )}
        <svg x={PLOT_LEFT} y={0} width={width - PLOT_LEFT - PLOT_RIGHT} height={CHART_H} viewBox={`${PLOT_LEFT} 0 ${width - PLOT_LEFT - PLOT_RIGHT} ${CHART_H}`} overflow="hidden">
          {lines.map((l) => {
            const s = styleOf(l.personKey);
            return (
              <path
                key={l.personKey} d={pathOf(l, x, y, view)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash}
                strokeLinejoin="round" strokeLinecap="round" className={cx('meetings-quality-line', picked !== null && picked !== l.personKey && 'is-dimmed')}
                data-testid="quality-line" data-person={l.personKey}
              />
            );
          })}
        </svg>
        {at !== null && <line x1={x(at)} x2={x(at)} y1={PAD_T} y2={PAD_T + plotH} className="meetings-cursor" data-testid="quality-cursor" />}
        {drag && Math.abs(drag.x1 - drag.x0) >= DRAG_PX && (
          <rect className="meetings-brush" x={Math.min(drag.x0, drag.x1)} width={Math.abs(drag.x1 - drag.x0)} y={PAD_T} height={plotH} />
        )}
      </svg>
    </figure>
  );
};

interface MeetingQualityChartsProps {
  lanes: ConnectivityLane[];
  /** The people in the meeting's order (the roster's), which fixes each person's color and dash. */
  people: string[];
  thresholds?: ExperienceThresholds;
  view: TimeView;
  full: TimeView;
  onView: (v: TimeView) => void;
  cursor: number | null;
  onCursor: (at: number | null) => void;
  band?: TimelineBand | null;
}

const MeetingQualityCharts: React.FC<MeetingQualityChartsProps> = ({ lanes, people, thresholds, view, full, onView, cursor, onCursor, band }) => {
  const { t } = useTranslation();
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>(900);
  const width = Math.max(480, measured);
  const [picked, setPicked] = useState<string | null>(null);
  const [tablesOpen, setTablesOpen] = useState(false);
  // HELD ACROSS RENDERS, so a pointer move, which re-renders every chart, recomputes no line.
  const recorded = useMemo(() => lanes.filter((l) => l.samples.length > 0 || l.healthChanges.length > 0), [lanes]);
  const charts = useMemo(() => QUALITY_MEASURES
    .map((m) => ({ measure: m, lines: qualityLines(recorded, m, people) }))
    .filter((c) => c.lines.some((l) => l.points.length > 0)), [recorded, people]);
  const order = useMemo(() => {
    const seen = [...people];
    for (const l of recorded) if (!seen.includes(l.personKey)) seen.push(l.personKey);
    return seen.filter((p) => recorded.some((l) => l.personKey === p));
  }, [people, recorded]);
  const styleOf = (person: string) => seriesStyle(Math.max(0, order.indexOf(person)));

  return (
    <section className="admin-panel" data-testid="connectivity-panel">
      <h3>{t('admin.meetings.connectivity.title')}</h3>
      {recorded.length === 0 ? (
        <p className="meetings-muted" data-testid="connectivity-none">{t('admin.meetings.connectivity.none')}</p>
      ) : (
        <>
          <div className="meetings-quality-legend" role="group" aria-label={t('admin.meetings.qualityChart.legend')}>
            {order.map((p) => (
              <button
                key={p} type="button" className="meetings-chip" aria-pressed={picked === p} data-testid="quality-legend"
                onClick={() => setPicked(picked === p ? null : p)} title={p}
              >
                <svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke={styleOf(p).color} strokeWidth="2" strokeDasharray={styleOf(p).dash} /></svg>
                <code>{p.length > 24 ? `${p.slice(0, 23)}…` : p}</code>
              </button>
            ))}
            <span className="meetings-muted">{t('admin.meetings.qualityChart.help')}</span>
          </div>
          <div ref={ref} className="meetings-quality-charts">
            {charts.map(({ measure, lines }) => (
              <QualityChart
                key={measure} measure={measure} lines={lines} styleOf={styleOf} picked={picked}
                threshold={thresholdOf(measure, thresholds)} view={view} full={full} width={width}
                cursor={cursor} onCursor={onCursor} onView={onView} band={band}
              />
            ))}
          </div>
          <details className="meetings-table-twin" data-testid="connectivity-table" onToggle={(e) => setTablesOpen(e.currentTarget.open)}>
            <summary>{t('admin.meetings.qualityChart.asTable')}</summary>
            {tablesOpen && <>
            <table className="meetings-events">
              <thead>
                <tr>
                  <th>{t('admin.meetings.person')}</th>
                  <th>{t('admin.meetings.timeline.attendee')}</th>
                  <th>{t('admin.meetings.qualityChart.readingsColumn')}</th>
                  <th>{t('admin.meetings.poorConnection')}</th>
                  <th>{t('admin.meetings.qualityChart.healthChanges')}</th>
                </tr>
              </thead>
              <tbody>
                {recorded.map((lane) => (
                  <tr key={lane.attendeeId} data-testid="connectivity-lane">
                    <td><code>{lane.personKey}</code></td>
                    <td><code>{lane.attendeeId}</code></td>
                    <td className="meetings-num">{t('admin.meetings.connectivity.readings', { count: lane.samples.length })}</td>
                    <td className="meetings-num">
                      {lane.poorSeconds !== undefined ? t('admin.meetings.connectivity.poorFor', { length: formatSeconds(lane.poorSeconds) }) : '-'}
                      {lane.videoStopSuggestions !== undefined && lane.videoStopSuggestions > 0 && <> · {t('admin.meetings.connectivity.videoStops', { count: lane.videoStopSuggestions })}</>}
                    </td>
                    <td className="meetings-muted">
                      {lane.healthChanges.map((c) => `${clockTime(Date.parse(c.at), true)} ${t(`admin.meetings.connectivity.health.${c.health}`)}`).join(' · ') || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {charts.map(({ measure, lines }) => (
              <table key={measure} className="meetings-events" data-testid={`quality-table-${measure}`}>
                <caption className="meetings-chart-title">{t(`admin.meetings.connectivity.measures.${measure}`)}</caption>
                <thead><tr><th>{t('admin.meetings.timeline.when')}</th><th>{t('admin.meetings.person')}</th><th>{t('admin.meetings.qualityChart.value')}</th></tr></thead>
                <tbody>
                  {lines.flatMap((l) => l.points.filter((p) => p.at + CONNECTIVITY_SAMPLE_INTERVAL_MS >= view.from && p.at <= view.to).map((p) => (
                    <tr key={`${l.personKey}-${p.at}`}><td className="meetings-num">{clockTime(p.at, true)}</td><td><code>{l.personKey}</code></td><td className="meetings-num">{valueText(p.v)}</td></tr>
                  )))}
                </tbody>
              </table>
            ))}
            </>}
          </details>
        </>
      )}
    </section>
  );
};

export default MeetingQualityCharts;
