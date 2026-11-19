/**
 * ONE MEETING ON ONE TIME AXIS (SPEC-ASSISTANT-MEETINGS FR46): a lane for the meeting itself and one per person, each
 * person's lane carrying when they were connected, on camera and sharing (the roster's own intervals), and a marker
 * for every recorded event.
 *
 * READABLE WITHOUT HOVERING: each marker is its category's glyph with the event's name beside it. Markers whose names
 * would collide on a lane are drawn as one group with a count, which expands to its events and zooms to them. The view
 * zooms to any range: drag across the plot, use the zoom buttons, or the keyboard on the plot (arrows move, plus and
 * minus zoom, 0 shows the whole meeting); the strip beneath shows where the view sits in the whole meeting.
 *
 * THE LIST BENEATH FOLLOWS THE VIEW: it holds the events in the range drawn, with their exact times, under the same
 * category filter and the person chosen from a lane. A marker, a group's event or a row selects its event, highlighted in
 * both, and shows everything recorded about it. The view, the moment pointed at and a stretch an experience issue jumps to
 * are shared with the quality charts beneath (`meetingView.ts`), which draw on the same x.
 *
 * A person is shown by their id, never a name.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeetingEvent } from '../../services/meetingAnalyticsService';
import {
  EVENT_CATEGORIES, MEETING_LANE, timeTicks, type EventCategory, type Marker, type Timeline,
} from './meetingLanes';
import { clockTime, eventLabel, formatSeconds } from './meetingFormat';
import { useMeasuredWidth } from './useMeasuredWidth';
import {
  PLOT_LEFT, PLOT_RIGHT, clampView, cx, groupMarkers, isWhole, labelWidth, panView, timeAt, timeScale, viewAround, zoomView,
  type MarkerGroup, type TimeView,
} from './meetingView';

/** Each category's mark: a series color and a shape, so a category never rests on color alone. */
export const CATEGORY_MARK: Record<EventCategory, { color: string; shape: 'circle' | 'square' | 'triangle' | 'diamond' }> = {
  lifecycle: { color: 'var(--text-secondary)', shape: 'square' },
  presence: { color: 'var(--chart-1)', shape: 'circle' },
  media: { color: 'var(--chart-2)', shape: 'square' },
  device: { color: 'var(--chart-4)', shape: 'square' },
  connection: { color: 'var(--chart-3)', shape: 'triangle' },
  failure: { color: 'var(--status-bad)', shape: 'diamond' },
  ring: { color: 'var(--chart-4)', shape: 'circle' },
  other: { color: 'var(--text-tertiary)', shape: 'circle' },
};

const SPAN_COLOR = { connected: 'var(--chart-1)', camera: 'var(--chart-2)', sharing: 'var(--chart-3)' } as const;

const LANE_H = 52;
const AXIS_H = 24;
const OVERVIEW_H = 22;
/** A drag shorter than this is a click, not a range. */
const DRAG_PX = 6;

/** A marker's glyph, centred on (x, y), with a surface ring so overlapping marks stay legible. */
export const Glyph: React.FC<{ shape: typeof CATEGORY_MARK[EventCategory]['shape']; x: number; y: number; r: number; color: string; selected?: boolean }> = ({ shape, x, y, r, color, selected }) => {
  const common = { fill: color, stroke: selected ? 'var(--text-primary)' : 'var(--surface-0)', strokeWidth: 2 };
  if (shape === 'square') return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} {...common} />;
  if (shape === 'triangle') return <path d={`M${x},${y - r - 1} L${x + r + 1},${y + r} L${x - r - 1},${y + r} Z`} {...common} />;
  if (shape === 'diamond') return <path d={`M${x},${y - r - 1.5} L${x + r + 1.5},${y} L${x},${y + r + 1.5} L${x - r - 1.5},${y} Z`} {...common} />;
  return <circle cx={x} cy={y} r={r} {...common} />;
};

const short = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What an event says beyond its name, as `key value` pairs: the transport, then each recorded attribute. */
export function eventFacts(e: MeetingEvent): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (e.network_transport) out.push(['transport', e.network_transport]);
  for (const [k, v] of Object.entries(e.detail ?? {})) if (v !== null && v !== undefined && typeof v !== 'object') out.push([k, String(v)]);
  return out;
}

/** A stretch drawn across the plot (and across one lane, where it names one): where an experience issue jumped to. */
export interface TimelineBand { from: number; to: number; lane?: string }

interface MeetingTimelineProps {
  timeline: Timeline;
  events: MeetingEvent[];
  /** Each person who fared badly, with how: their lane is tinted. */
  issues?: ReadonlyMap<string, 'warning' | 'error'>;
  /** The range drawn, shared with the quality charts; held here where no parent holds it. */
  view?: TimeView;
  onView?: (view: TimeView) => void;
  /** The moment pointed at, here or on a chart. */
  cursor?: number | null;
  onCursor?: (at: number | null) => void;
  band?: TimelineBand | null;
}

/**
 * An event's identity across reads of the meeting: the same fields the server tells events apart by. A selection held by
 * it stays on its event when Refresh brings an answer whose events sit at other places in the list.
 */
export const eventKey = (e: MeetingEvent): string => `${e.meeting_id}|${e.attendee_id ?? ''}|${e.event_type}|${e.event_at}`;

/** The error an event's app gave, where it gave one. */
const errorOf = (e: MeetingEvent): string | null => (typeof e.detail?.errorMessage === 'string' ? e.detail.errorMessage : null);

/** The category a group shows: a failure first, then the first category in the filter's order. */
const groupCategory = (g: MarkerGroup): EventCategory =>
  g.markers.some((m) => m.category === 'failure') ? 'failure' : EVENT_CATEGORIES.find((c) => g.markers.some((m) => m.category === c)) ?? 'other';
const groupKey = (g: MarkerGroup): string => `${g.lane}|${g.at}`;

const MeetingTimeline: React.FC<MeetingTimelineProps> = ({ timeline, events, issues, view: heldView, onView, cursor = null, onCursor, band }) => {
  const { t } = useTranslation();
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>(900);
  const width = Math.max(480, measured);
  const [shown, setShown] = useState<Set<EventCategory>>(() => new Set(EVENT_CATEGORIES));
  const [person, setPerson] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const { start, end, lanes, markers } = timeline;
  const full = useMemo<TimeView>(() => ({ from: start, to: end }), [start, end]);
  const [ownView, setOwnView] = useState<TimeView>(full);
  useEffect(() => { if (!heldView) setOwnView(full); }, [full, heldView]);
  const view = heldView ?? ownView;
  const setView = (v: TimeView) => { setExpanded(null); if (onView) onView(v); else setOwnView(v); };

  const x = timeScale(view, width);
  const plotRight = width - PLOT_RIGHT;
  const lanesH = lanes.length * LANE_H;
  const height = lanesH + AXIS_H;
  const ticks = timeTicks(view.from, view.to, Math.max(3, Math.floor((plotRight - PLOT_LEFT) / 90)));
  const withSeconds = view.to - view.from < 10 * 60_000;
  const inView = (at: number) => at >= view.from && at <= view.to;

  const counts = useMemo(() => {
    const c = {} as Record<EventCategory, number>;
    for (const k of EVENT_CATEGORIES) c[k] = 0;
    for (const m of markers) c[m.category] += 1;
    return c;
  }, [markers]);
  const visible = markers.filter((m) => shown.has(m.category));
  const drawn = visible.filter((m) => inView(m.at));
  const groups = groupMarkers(drawn, x, (m) => eventLabel(m.event.event_type));
  const listed = drawn.filter((m) => !person || m.lane === person);
  const chosen = selected === null ? null : events.find((e) => eventKey(e) === selected) ?? null;
  const open = expanded === null ? null : groups.find((g) => groupKey(g) === expanded) ?? null;

  const toggle = (c: EventCategory) => setShown((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });
  const only = (c: EventCategory) => setShown(new Set([c]));
  const present = EVENT_CATEGORIES.filter((c) => counts[c] > 0);
  const filtered = present.some((c) => !shown.has(c));
  const laneName = (key: string) => (key === MEETING_LANE ? t('admin.meetings.timeline.meetingLane') : key);
  const offset = (at: number) => formatSeconds(Math.max(0, (at - start) / 1000));
  const select = (m: Marker) => {
    const key = eventKey(m.event);
    setSelected(selected === key ? null : key);
    onCursor?.(m.at);
  };

  // THE CHOSEN ROW IS BROUGHT INTO SIGHT, so a marker chosen on the plot shows its row in a long list.
  const listRef = useRef<HTMLTableSectionElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    const row = listRef.current?.querySelector<HTMLElement>('tr[aria-selected="true"]');
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  /** Where the pointer is on the plot, in the SVG's own units. */
  const pointerX = (e: React.PointerEvent): number => {
    const box = svgRef.current?.getBoundingClientRect();
    return box && box.width ? ((e.clientX - box.left) / box.width) * width : e.clientX;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest?.('[data-marker]')) return;
    const px = pointerX(e);
    if (px < PLOT_LEFT) return;
    setDrag({ x0: px, x1: px });
    // THE DRAG HOLDS THE POINTER, so a release outside the plot still ends it here.
    if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const px = pointerX(e);
    if (drag) setDrag({ ...drag, x1: px });
    onCursor?.(px >= PLOT_LEFT ? timeAt(px, view, width) : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag && Math.abs(drag.x1 - drag.x0) >= DRAG_PX) {
      const a = timeAt(Math.min(drag.x0, drag.x1), view, width);
      const b = timeAt(Math.max(drag.x0, drag.x1), view, width);
      setView(clampView({ from: a, to: b }, full));
    }
    setDrag(null);
    if (typeof e.currentTarget.hasPointerCapture === 'function' && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onPlotKey = (e: React.KeyboardEvent) => {
    const keys: Record<string, () => TimeView> = {
      ArrowLeft: () => panView(view, full, -0.2),
      ArrowRight: () => panView(view, full, 0.2),
      '+': () => zoomView(view, full, 0.5),
      '=': () => zoomView(view, full, 0.5),
      '-': () => zoomView(view, full, 2),
      '0': () => full,
      Home: () => full,
    };
    const next = keys[e.key];
    if (!next) return;
    e.preventDefault();
    setView(next());
  };

  const overviewX = timeScale(full, width);
  const rangeText = `${clockTime(view.from, true)} - ${clockTime(view.to, true)}`;

  return (
    <section className="meetings-timeline" data-testid="meeting-timeline">
      <div className="meetings-filters" role="group" aria-label={t('admin.meetings.timeline.filter')}>
        {present.map((c) => (
          <span key={c} className="meetings-chip-group">
            <button
              type="button" className="meetings-chip" aria-pressed={shown.has(c)} onClick={() => toggle(c)} data-testid={`category-${c}`}
            >
              <svg width="14" height="14" aria-hidden="true"><Glyph shape={CATEGORY_MARK[c].shape} x={7} y={7} r={4} color={CATEGORY_MARK[c].color} /></svg>
              {t(`admin.meetings.categories.${c}`)} <span className="meetings-chip-count">{counts[c]}</span>
            </button>
            <button
              type="button" className="meetings-chip-only" onClick={() => only(c)} data-testid={`only-${c}`}
              aria-label={t('admin.meetings.timeline.onlyCategory', { category: t(`admin.meetings.categories.${c}`) })}
            >
              {t('admin.meetings.timeline.only')}
            </button>
          </span>
        ))}
        {filtered && (
          <button type="button" className="meetings-link" onClick={() => setShown(new Set(EVENT_CATEGORIES))} data-testid="category-clear">
            {t('admin.meetings.timeline.showAll')}
          </button>
        )}
        <span className="meetings-line-key" aria-hidden="true">
          {(['connected', 'camera', 'sharing'] as const).map((k) => (
            <span key={k}><i style={{ background: SPAN_COLOR[k] }} />{t(`admin.meetings.timeline.spans.${k}`)}</span>
          ))}
        </span>
      </div>

      <div className="meetings-zoom" role="group" aria-label={t('admin.meetings.timeline.zoom')}>
        <button type="button" className="btn-secondary" onClick={() => setView(zoomView(view, full, 0.5))} data-testid="zoom-in">{t('admin.meetings.timeline.zoomIn')}</button>
        <button type="button" className="btn-secondary" onClick={() => setView(zoomView(view, full, 2))} disabled={isWhole(view, full)} data-testid="zoom-out">{t('admin.meetings.timeline.zoomOut')}</button>
        <button type="button" className="btn-secondary" onClick={() => setView(full)} disabled={isWhole(view, full)} data-testid="zoom-reset">{t('admin.meetings.timeline.wholeMeeting')}</button>
        <span className={cx('meetings-muted', 'meetings-num')} data-testid="timeline-range" aria-live="polite">{rangeText}</span>
        <span className="meetings-muted">{t('admin.meetings.timeline.zoomHelp')}</span>
      </div>

      <div
        ref={ref} className="meetings-timeline-plot" tabIndex={0} onKeyDown={onPlotKey} data-testid="timeline-plot"
        role="group" aria-label={t('admin.meetings.timeline.plotLabel', { range: rangeText })}
      >
        <svg
          ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t('admin.meetings.timeline.title')}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={() => { if (!drag) onCursor?.(null); }}
        >
          <defs>
            <clipPath id="meetings-timeline-clip"><rect x={PLOT_LEFT - 8} y={0} width={plotRight - PLOT_LEFT + 16} height={lanesH} /></clipPath>
          </defs>
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={x(tk)} x2={x(tk)} y1={0} y2={lanesH} className="meetings-grid" />
              <text x={x(tk)} y={height - 6} textAnchor="middle" className="meetings-axis">{clockTime(tk, withSeconds)}</text>
            </g>
          ))}
          {band && band.to >= view.from && band.from <= view.to && (
            <rect
              data-testid="timeline-band" className="meetings-band"
              x={Math.max(PLOT_LEFT, x(band.from))} width={Math.max(3, Math.min(plotRight, x(band.to)) - Math.max(PLOT_LEFT, x(band.from)))}
              y={band.lane ? Math.max(0, lanes.findIndex((l) => l.key === band.lane)) * LANE_H : 0} height={band.lane ? LANE_H : lanesH}
            />
          )}
          {lanes.map((lane, li) => {
            const top = li * LANE_H;
            const isPerson = lane.personKey !== null;
            return (
              <g key={lane.key} data-testid="timeline-lane" data-lane={lane.key} data-issue={lane.personKey ? issues?.get(lane.personKey) : undefined}>
                {lane.personKey && issues?.get(lane.personKey) && (
                  <rect x={0} y={top} width={plotRight} height={LANE_H} className={`meetings-lane-issue is-${issues.get(lane.personKey)}`} />
                )}
                <line x1={0} x2={plotRight} y1={top + LANE_H} y2={top + LANE_H} className="meetings-grid" />
                {isPerson ? (
                  <text
                    x={4} y={top + 20} className={cx('meetings-lane-label', person === lane.key && 'is-active')}
                    tabIndex={0} role="button" aria-pressed={person === lane.key}
                    aria-label={t('admin.meetings.timeline.onlyPerson', { person: lane.key })}
                    onClick={() => setPerson(person === lane.key ? '' : lane.key)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setPerson(person === lane.key ? '' : lane.key); } }}
                  >
                    <title>{lane.key}</title>
                    {short(lane.key)}
                  </text>
                ) : (
                  <text x={4} y={top + 20} className="meetings-meeting-label">{laneName(lane.key)}</text>
                )}
                <g clipPath="url(#meetings-timeline-clip)">
                  {(['connected', 'camera', 'sharing'] as const).map((k, ki) => lane[k].filter((s) => s.to >= view.from && s.from <= view.to).map((s, si) => (
                    <rect
                      key={`${k}-${si}`} data-testid={`span-${k}`}
                      x={x(Math.max(s.from, view.from))} y={top + 34 + ki * 6} width={Math.max(2, x(Math.min(s.to, view.to)) - x(Math.max(s.from, view.from)))} height={4} rx={2}
                      fill={SPAN_COLOR[k]}
                    >
                      <title>{`${t(`admin.meetings.timeline.spans.${k}`)} ${clockTime(s.from, true)} - ${clockTime(s.to, true)}`}</title>
                    </rect>
                  )))}
                </g>
              </g>
            );
          })}
          {groups.map((g) => {
            const li = lanes.findIndex((l) => l.key === g.lane);
            const cy = li * LANE_H + 16;
            if (g.markers.length === 1) {
              const m = g.markers[0];
              const mark = CATEGORY_MARK[m.category];
              const key = eventKey(m.event);
              const name = eventLabel(m.event.event_type);
              const flip = g.x + labelWidth(name) > plotRight;
              const label = `${name}, ${clockTime(m.at, true)}, ${laneName(m.lane)}`;
              return (
                <g
                  key={key} data-marker="" data-testid="timeline-marker" data-category={m.category} data-event={m.event.event_type}
                  tabIndex={0} role="button" aria-label={label} aria-pressed={selected === key} className="meetings-marker"
                  onClick={() => select(m)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(m); } }}
                >
                  <title>{label}</title>
                  <rect x={g.x - 12} y={cy - 12} width={24} height={24} fill="transparent" />
                  <Glyph shape={mark.shape} x={g.x} y={cy} r={selected === key ? 6 : 4.5} color={mark.color} selected={selected === key} />
                  <text x={flip ? g.x - 9 : g.x + 9} y={cy + 4} textAnchor={flip ? 'end' : 'start'} className={cx('meetings-marker-label', selected === key && 'is-selected')}>{name}</text>
                </g>
              );
            }
            const category = groupCategory(g);
            const mark = CATEGORY_MARK[category];
            const key = groupKey(g);
            const text = t('admin.meetings.timeline.groupCount', { count: g.markers.length });
            const label = t('admin.meetings.timeline.groupLabel', { count: g.markers.length, from: clockTime(g.at, true), to: clockTime(g.until, true), who: laneName(g.lane) });
            return (
              <g
                key={key} data-marker="" data-testid="timeline-group" data-count={g.markers.length} data-lane={g.lane}
                tabIndex={0} role="button" aria-label={label} aria-expanded={expanded === key} className="meetings-marker"
                onClick={() => setExpanded(expanded === key ? null : key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setExpanded(expanded === key ? null : key); } }}
              >
                <title>{label}</title>
                <rect x={g.x - 12} y={cy - 12} width={24 + labelWidth(text)} height={24} fill="transparent" />
                <Glyph shape={mark.shape} x={g.x} y={cy} r={5} color={mark.color} selected={expanded === key} />
                <text x={g.x + 9} y={cy + 4} className="meetings-group-label">{text}</text>
              </g>
            );
          })}
          {drag && Math.abs(drag.x1 - drag.x0) >= DRAG_PX && (
            <rect className="meetings-brush" x={Math.min(drag.x0, drag.x1)} width={Math.abs(drag.x1 - drag.x0)} y={0} height={lanesH} />
          )}
          {cursor !== null && inView(cursor) && (
            <line data-testid="timeline-cursor" className="meetings-cursor" x1={x(cursor)} x2={x(cursor)} y1={0} y2={lanesH} />
          )}
        </svg>
        <svg width={width} height={OVERVIEW_H} viewBox={`0 0 ${width} ${OVERVIEW_H}`} aria-hidden="true" data-testid="timeline-overview">
          <rect x={PLOT_LEFT} y={4} width={plotRight - PLOT_LEFT} height={OVERVIEW_H - 8} className="meetings-overview-track" />
          {visible.map((m) => <line key={m.index} x1={overviewX(m.at)} x2={overviewX(m.at)} y1={6} y2={OVERVIEW_H - 6} stroke={CATEGORY_MARK[m.category].color} strokeWidth={1} />)}
          <rect
            x={overviewX(view.from)} width={Math.max(3, overviewX(view.to) - overviewX(view.from))} y={2} height={OVERVIEW_H - 4}
            className="meetings-overview-view" data-testid="timeline-overview-view"
          />
          <text x={PLOT_LEFT - 8} y={OVERVIEW_H - 7} textAnchor="end" className="meetings-axis">{t('admin.meetings.timeline.overview')}</text>
        </svg>
      </div>

      {open && (
        <div className="meetings-group-open" data-testid="timeline-group-open" role="region" aria-label={t('admin.meetings.timeline.groupOpen')}>
          <div className="meetings-list-head">
            <h4>{t('admin.meetings.timeline.groupLabel', { count: open.markers.length, from: clockTime(open.at, true), to: clockTime(open.until, true), who: laneName(open.lane) })}</h4>
            {open.until > open.at && (
              <button type="button" className="btn-secondary" onClick={() => setView(viewAround(open.at, open.until, full))} data-testid="group-zoom">
                {t('admin.meetings.timeline.zoomToGroup')}
              </button>
            )}
          </div>
          <ul>
            {open.markers.map((m) => (
              <li key={eventKey(m.event)}>
                <button type="button" className="meetings-link" aria-pressed={selected === eventKey(m.event)} onClick={() => select(m)} data-testid="group-event">
                  <svg width="14" height="14" aria-hidden="true"><Glyph shape={CATEGORY_MARK[m.category].shape} x={7} y={7} r={4} color={CATEGORY_MARK[m.category].color} /></svg>
                  {' '}<span className="meetings-num">{clockTime(m.at, true)}</span> {eventLabel(m.event.event_type)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {chosen && (
        <div className="meetings-event-detail" data-testid="event-detail" role="region" aria-label={t('admin.meetings.timeline.selected')}>
          <h4>{eventLabel(chosen.event_type)}</h4>
          <dl>
            <dt>{t('admin.meetings.timeline.when')}</dt><dd>{new Date(chosen.event_at).toLocaleString()} (+{offset(Date.parse(chosen.event_at))})</dd>
            <dt>{t('admin.meetings.person')}</dt><dd><code>{chosen.person_key ?? '-'}</code></dd>
            <dt>{t('admin.meetings.timeline.attendee')}</dt><dd><code>{chosen.attendee_id ?? '-'}</code></dd>
            <dt>{t('admin.meetings.timeline.recordedBy')}</dt><dd>{t(`admin.meetings.sources.${chosen.source}`)}</dd>
            <dt>{t('admin.meetings.timeline.eventName')}</dt><dd><code>{chosen.event_type}</code></dd>
            {eventFacts(chosen).map(([k, v]) => (<React.Fragment key={k}><dt><code>{k}</code></dt><dd>{v}</dd></React.Fragment>))}
          </dl>
        </div>
      )}

      <div className="meetings-list-head">
        <h4>
          {t('admin.meetings.timeline.events', { count: listed.length })}
          {!isWhole(view, full) && <span className="meetings-muted"> {t('admin.meetings.timeline.inRange', { range: rangeText })}</span>}
        </h4>
        <label>
          {t('admin.meetings.person')}
          <select className="select" value={person} onChange={(e) => setPerson(e.target.value)} aria-label={t('admin.meetings.timeline.personFilter')}>
            <option value="">{t('admin.meetings.timeline.everyone')}</option>
            {lanes.map((l) => <option key={l.key} value={l.key}>{laneName(l.key)}</option>)}
          </select>
        </label>
      </div>
      <table className="meetings-events" data-testid="event-list">
        <thead>
          <tr>
            <th>{t('admin.meetings.timeline.when')}</th>
            <th>{t('admin.meetings.timeline.lane')}</th>
            <th>{t('admin.meetings.timeline.event')}</th>
            <th>{t('admin.meetings.timeline.facts')}</th>
          </tr>
        </thead>
        <tbody ref={listRef}>
          {listed.map((m) => (
            <tr
              key={m.index} data-testid="event-row" aria-selected={selected === eventKey(m.event)}
              className={cx(selected === eventKey(m.event) && 'is-selected', m.category === 'failure' && 'is-failure') || undefined}
              tabIndex={0} onClick={() => { setSelected(eventKey(m.event)); onCursor?.(m.at); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setSelected(eventKey(m.event)); onCursor?.(m.at); } }}
            >
              <td className="meetings-num">{clockTime(m.at, true)} <span className="meetings-muted">+{offset(m.at)}</span></td>
              <td>{m.lane === MEETING_LANE ? laneName(m.lane) : <code>{m.lane}</code>}</td>
              <td>
                <svg width="14" height="14" aria-hidden="true"><Glyph shape={CATEGORY_MARK[m.category].shape} x={7} y={7} r={4} color={CATEGORY_MARK[m.category].color} /></svg>{' '}
                {eventLabel(m.event.event_type)}
                {errorOf(m.event) && <span className="meetings-error-text" data-testid="event-error"> {errorOf(m.event)}</span>}
                {' '}<span className={`meetings-source source-${m.event.source}`} data-testid="event-source">{t(`admin.meetings.sourceTags.${m.event.source}`)}</span>
              </td>
              <td className="meetings-muted">{eventFacts(m.event).map(([k, v]) => `${k} ${v}`).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {listed.length === 0 && <p className="meetings-muted">{t('admin.meetings.timeline.noEvents')}</p>}
    </section>
  );
};


export default MeetingTimeline;
