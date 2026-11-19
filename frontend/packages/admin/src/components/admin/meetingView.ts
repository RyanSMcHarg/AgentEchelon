/**
 * ONE MEETING'S VIEW, SHARED BY ITS TIMELINE AND ITS QUALITY CHARTS: the time range drawn, the moment pointed at, and the
 * stretch an experience issue jumps to. Pure functions of the answer and the view, so every surface that draws the meeting
 * places the same instant at the same x, and nothing here computes a figure (the server's `meeting-figures.ts` and
 * `meeting-experience.ts` do).
 */
import type { AttendeeConnectivity, ConnectivitySample, ExperienceIssue } from '../../services/meetingAnalyticsService';
import { CONNECTIVITY_SAMPLE_INTERVAL_MS } from '../../../../../../backend/lambda/src/lib/meeting-client-events.ts';
import type { Marker } from './meetingLanes';

/** A time range in epoch milliseconds. */
export interface TimeView { from: number; to: number }

/** The narrowest range a view zooms to: below it, two readings no longer fit beside each other. */
export const MIN_VIEW_MS = 20_000;

/** The left gutter every meeting surface keeps for its lane names and axis labels, so their plots line up. */
export const PLOT_LEFT = 170;
/** The right gutter of every meeting surface. */
export const PLOT_RIGHT = 16;

/** The range kept inside the meeting's own, and no narrower than {@link MIN_VIEW_MS}. */
export function clampView(view: TimeView, full: TimeView): TimeView {
  const fullSpan = Math.max(1, full.to - full.from);
  const span = Math.min(fullSpan, Math.max(MIN_VIEW_MS, view.to - view.from));
  const from = Math.min(Math.max(full.from, view.from), full.to - span);
  return { from: Math.max(full.from, from), to: Math.max(full.from, from) + span };
}

/** The view zoomed by `factor` (below 1 zooms in) about `center`, else its middle. */
export function zoomView(view: TimeView, full: TimeView, factor: number, center?: number): TimeView {
  const c = center ?? (view.from + view.to) / 2;
  const span = (view.to - view.from) * factor;
  const left = (c - view.from) / Math.max(1, view.to - view.from);
  return clampView({ from: c - span * left, to: c - span * left + span }, full);
}

/** The view moved by `fraction` of its own width (negative moves earlier). */
export function panView(view: TimeView, full: TimeView, fraction: number): TimeView {
  const shift = (view.to - view.from) * fraction;
  return clampView({ from: view.from + shift, to: view.to + shift }, full);
}

/** A view around a stretch, with a margin either side so its start and end are visible. A moment gets a minute around it. */
export function viewAround(from: number, to: number, full: TimeView): TimeView {
  const span = Math.max(to - from, 0);
  const pad = Math.max(span * 0.5, 30_000);
  return clampView({ from: from - pad, to: to + pad }, full);
}

/** Whether the view is the whole meeting. */
export const isWhole = (view: TimeView, full: TimeView): boolean => view.from <= full.from && view.to >= full.to;

/** A scale from time to x across a plot of `width`, between the shared gutters. */
export function timeScale(view: TimeView, width: number): (t: number) => number {
  const plotW = Math.max(1, width - PLOT_LEFT - PLOT_RIGHT);
  const span = Math.max(1, view.to - view.from);
  return (t: number) => PLOT_LEFT + ((t - view.from) / span) * plotW;
}

/** The time at an x across a plot of `width`, the inverse of {@link timeScale}. */
export function timeAt(x: number, view: TimeView, width: number): number {
  const plotW = Math.max(1, width - PLOT_LEFT - PLOT_RIGHT);
  const f = Math.min(1, Math.max(0, (x - PLOT_LEFT) / plotW));
  return view.from + f * (view.to - view.from);
}

/** Markers on one lane that sit close enough for their labels to collide, drawn as one group with a count. */
export interface MarkerGroup {
  lane: string;
  markers: Marker[];
  at: number;
  /** The last marker's time: the group's stretch. */
  until: number;
  x: number;
}

/** The space a marker's label takes, in pixels, at the console's 12px label size. */
export const labelWidth = (label: string): number => 18 + label.length * 6.6;

/**
 * THE MARKERS OF EACH LANE, GROUPED WHERE THEIR LABELS WOULD COLLIDE: walking a lane in time order, a marker joins the
 * group before it while it falls inside that group's first label. A group of one is a marker drawn with its label; a
 * larger one is drawn as a count that expands to its events.
 */
export function groupMarkers(markers: Marker[], x: (t: number) => number, labelOf: (m: Marker) => string): MarkerGroup[] {
  const byLane = new Map<string, Marker[]>();
  for (const m of [...markers].sort((a, b) => a.at - b.at)) byLane.set(m.lane, [...(byLane.get(m.lane) ?? []), m]);
  const out: MarkerGroup[] = [];
  for (const [lane, list] of byLane) {
    let current: MarkerGroup | null = null;
    let reach = -Infinity;
    for (const m of list) {
      const mx = x(m.at);
      if (current && mx < reach) {
        current.markers.push(m);
        current.until = m.at;
        continue;
      }
      current = { lane, markers: [m], at: m.at, until: m.at, x: mx };
      reach = mx + labelWidth(labelOf(m)) + 4;
      out.push(current);
    }
  }
  return out;
}

/** One person's readings of one measure, in time order, merged across their attendee records. */
export interface QualityLine {
  personKey: string;
  points: Array<{ at: number; v: number }>;
}

/** The measures the quality charts draw, each its own chart on the shared time axis. */
export const QUALITY_MEASURES = ['rttMs', 'audioJitterMs', 'audioLossSendPct', 'audioLossReceivePct', 'availableSendKbps', 'availableReceiveKbps'] as const;
export type QualityMeasure = typeof QUALITY_MEASURES[number];

/** Each person's line of one measure, in the order the people are given (the roster's), then anyone else in reading order. */
export function qualityLines(connectivity: Array<Pick<AttendeeConnectivity, 'personKey' | 'samples'>>, measure: keyof ConnectivitySample, order: string[]): QualityLine[] {
  const byPerson = new Map<string, Array<{ at: number; v: number }>>();
  for (const c of connectivity) {
    for (const s of c.samples) {
      const v = s[measure];
      const at = Date.parse(s.at);
      if (typeof v !== 'number' || !Number.isFinite(at)) continue;
      const points = byPerson.get(c.personKey);
      if (points) points.push({ at, v });
      else byPerson.set(c.personKey, [{ at, v }]);
    }
  }
  const people = [...order.filter((p) => byPerson.has(p)), ...[...byPerson.keys()].filter((p) => !order.includes(p))];
  return people.map((personKey) => ({ personKey, points: (byPerson.get(personKey) ?? []).sort((a, b) => a.at - b.at) }));
}

/**
 * A reading covers its interval, the one the app files a reading per (`CONNECTIVITY_SAMPLE_INTERVAL_MS`, the server's own);
 * two further apart than two intervals are not joined by a line.
 */
export { CONNECTIVITY_SAMPLE_INTERVAL_MS };
export const LINE_GAP_MS = 2 * CONNECTIVITY_SAMPLE_INTERVAL_MS;

/** A line's reading at an instant: the reading whose interval holds it, else none. */
export function readingAt(line: QualityLine, t: number): { at: number; v: number } | null {
  let best: { at: number; v: number } | null = null;
  for (const p of line.points) {
    if (p.at <= t && t < p.at + CONNECTIVITY_SAMPLE_INTERVAL_MS) best = p;
  }
  return best;
}

/**
 * EACH PERSON'S SERIES STYLE, by their place in the meeting's order: the four chart colors solid, then the same four
 * dashed, so eight people are told apart by a color and a dash and never by color alone. A ninth and later person is
 * drawn in the neutral ink and named in the legend and the readout.
 */
export function seriesStyle(index: number): { color: string; dash?: string } {
  if (index >= 8) return { color: 'var(--text-tertiary)', dash: '2 3' };
  return { color: `var(--chart-${(index % 4) + 1})`, ...(index >= 4 ? { dash: '6 3' } : {}) };
}

/** Join class names, leaving out the ones that do not apply. */
export const cx = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');

/**
 * WHICH EXPERIENCE ISSUE THIS IS, by what it is rather than by the answer it came in: its person, attendee, kind and start. A
 * Refresh reads a new answer, so the issue jumped to is found again in it by this key, or is gone.
 */
export const issueKey = (i: Pick<ExperienceIssue, 'personKey' | 'attendeeId' | 'kind' | 'from'>): string => [i.personKey, i.attendeeId ?? '', i.kind, i.from].join('|');
