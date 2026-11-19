import { describe, it, expect } from 'vitest';
import {
  MIN_VIEW_MS, PLOT_LEFT, clampView, groupMarkers, panView, qualityLines, readingAt, seriesStyle, timeAt, timeScale, viewAround, zoomView,
} from './meetingView';
import type { Marker } from './meetingLanes';
import type { MeetingEvent } from '../../services/meetingAnalyticsService';

const FULL = { from: 0, to: 600_000 };

describe('one meeting\'s shared view', () => {
  it('zooms about a moment and pans, inside the meeting and never narrower than two readings', () => {
    const z = zoomView(FULL, FULL, 0.5, 300_000);
    expect(z).toEqual({ from: 150_000, to: 450_000 });
    expect(panView(z, FULL, 1)).toEqual({ from: 300_000, to: 600_000 });
    expect(panView(z, FULL, -5)).toEqual({ from: 0, to: 300_000 });
    expect(zoomView(FULL, FULL, 0.0001).to - zoomView(FULL, FULL, 0.0001).from).toBe(MIN_VIEW_MS);
    expect(zoomView(z, FULL, 10)).toEqual(FULL);
    expect(clampView({ from: -50, to: 900_000 }, FULL)).toEqual(FULL);
  });

  it('frames a stretch with a margin, and a moment with a minute around it', () => {
    expect(viewAround(200_000, 260_000, FULL)).toEqual({ from: 170_000, to: 290_000 });
    expect(viewAround(300_000, 300_000, FULL)).toEqual({ from: 270_000, to: 330_000 });
  });

  it('places an instant at the same x on every surface of one width, and reads it back', () => {
    const x = timeScale(FULL, 1000);
    expect(x(0)).toBe(PLOT_LEFT);
    expect(timeAt(x(123_000), FULL, 1000)).toBeCloseTo(123_000, 0);
  });

  it('groups a lane\'s markers whose names would collide, and keeps lanes apart', () => {
    const ev = { event_type: 'AttendeeJoined' } as MeetingEvent;
    const m = (index: number, at: number, lane: string): Marker => ({ index, at, lane, category: 'presence', event: ev });
    const x = (t: number) => t / 1000;
    const groups = groupMarkers([m(0, 0, 'a'), m(1, 30_000, 'a'), m(2, 500_000, 'a'), m(3, 0, 'b')], x, () => 'Joined');
    expect(groups.map((g) => [g.lane, g.markers.length])).toEqual([['a', 2], ['a', 1], ['b', 1]]);
    expect(groups[0].until).toBe(30_000);
  });

  it('draws each person\'s measure as one line across their connections, in the meeting\'s order', () => {
    const s = (at: number, rttMs: number | null) => ({ at: new Date(at).toISOString(), rttMs }) as never;
    const lines = qualityLines([
      { personKey: 'p2', samples: [s(15_000, 90)] },
      { personKey: 'p1', samples: [s(30_000, 80), s(0, null)] },
      { personKey: 'p1', samples: [s(0, 70)] },
    ], 'rttMs', ['p1', 'p2']);
    expect(lines.map((l) => [l.personKey, l.points.map((p) => p.v)])).toEqual([['p1', [70, 80]], ['p2', [90]]]);
    expect(readingAt(lines[0], 31_000)?.v).toBe(80);
    expect(readingAt(lines[0], 46_000)).toBeNull();
  });

  it('tells eight people apart by a color and a dash, and draws a ninth in the neutral ink', () => {
    expect(seriesStyle(0)).toEqual({ color: 'var(--chart-1)' });
    expect(seriesStyle(4)).toEqual({ color: 'var(--chart-1)', dash: '6 3' });
    expect(seriesStyle(8).color).toBe('var(--text-tertiary)');
  });
});
