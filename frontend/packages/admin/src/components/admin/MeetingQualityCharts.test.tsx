import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@ae/shared/i18n';
import MeetingQualityCharts from './MeetingQualityCharts';
import { connectivityLanes, type ConnectivityLane } from './meetingLanes';
import { ALICE, BOB, EVENTS, at } from './meetingFixture';
import type { ConnectivitySample } from '../../services/meetingAnalyticsService';
import en from '@ae/shared/locales/en.json';
import { QUALITY_MEASURES } from './meetingView';

const THRESHOLDS = { packetLossPct: 3, jitterMs: 30, roundTripMs: 300, sustainedSeconds: 30 };
const FULL = { from: Date.parse(at(0)), to: Date.parse(at(20)) };
const reading = (min: number, over: Partial<ConnectivitySample>): ConnectivitySample => ({
  at: at(min), health: 'good', audioLossSendPct: 0, audioLossReceivePct: 0, audioJitterMs: 8, rttMs: 70,
  availableSendKbps: 1500, availableReceiveKbps: 4000, videoSendKbps: null, videoReceiveKbps: null, ...over,
});
/** Two people, read every 15 seconds for two minutes; Bob's round trip and loss climb past their thresholds. */
const LANES: ConnectivityLane[] = [
  { personKey: ALICE, attendeeId: 'a1', samples: [0, 0.25, 0.5, 0.75, 1, 1.25].map((m) => reading(5 + m, {})), healthChanges: [], poorSeconds: 0, videoStopSuggestions: 0 },
  {
    personKey: BOB, attendeeId: 'b1', samples: [0, 0.25, 0.5, 0.75, 1, 1.25].map((m, i) => reading(5 + m, { rttMs: 100 + i * 100, audioLossReceivePct: i })),
    healthChanges: [{ at: at(6), health: 'poor' }], poorSeconds: 45, videoStopSuggestions: 1,
  },
];

const renderCharts = (props: Partial<React.ComponentProps<typeof MeetingQualityCharts>> = {}) => render(
  <MeetingQualityCharts
    lanes={LANES} people={[ALICE, BOB]} thresholds={THRESHOLDS} view={FULL} full={FULL} onView={vi.fn()} cursor={null} onCursor={vi.fn()} {...props}
  />,
);

describe('each attendee\'s connection, charted over the meeting', () => {
  it('draws one chart per measure with one line per person, on the people\'s fixed styles', () => {
    renderCharts();
    for (const m of ['rttMs', 'audioJitterMs', 'audioLossSendPct', 'audioLossReceivePct', 'availableSendKbps', 'availableReceiveKbps']) {
      const chart = screen.getByTestId(`quality-${m}`);
      expect(within(chart).getAllByTestId('quality-line').map((l) => l.getAttribute('data-person'))).toEqual([ALICE, BOB]);
    }
    const [alice, bob] = within(screen.getByTestId('quality-rttMs')).getAllByTestId('quality-line');
    expect(alice.getAttribute('stroke')).toBe('var(--chart-1)');
    expect(bob.getAttribute('stroke')).toBe('var(--chart-2)');
    expect(screen.getAllByTestId('quality-legend').map((b) => b.textContent)).toEqual([ALICE, BOB]);
  });

  it('draws the threshold each measure was judged against as a reference line, and none where there is none', () => {
    renderCharts();
    expect(screen.getByTestId('threshold-rttMs').textContent).toContain('300');
    expect(screen.getByTestId('threshold-audioJitterMs').textContent).toContain('30');
    expect(screen.getByTestId('threshold-audioLossReceivePct').textContent).toContain('3');
    expect(screen.queryByTestId('threshold-availableSendKbps')).toBeNull();
  });

  it('reads every person at the moment pointed at, on every chart, and draws that moment on each', () => {
    renderCharts({ cursor: Date.parse(at(6)) + 5_000 });
    const readout = screen.getByTestId('readout-rttMs');
    expect(readout.textContent).toContain('70');
    expect(readout.textContent).toContain('500');
    expect(readout.textContent).toContain(ALICE);
    expect(readout.textContent).toContain(BOB);
    expect(screen.getAllByTestId('quality-cursor').length).toBe(6);
  });

  it('reports the moment under the pointer, and moves it a reading at a time from the keyboard', () => {
    const onCursor = vi.fn();
    renderCharts({ onCursor, cursor: Date.parse(at(5)) });
    const svg = within(screen.getByTestId('quality-rttMs')).getByRole('img');
    fireEvent.pointerMove(svg, { clientX: 400 });
    expect(onCursor).toHaveBeenLastCalledWith(expect.any(Number));
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(onCursor).toHaveBeenLastCalledWith(Date.parse(at(5)) + 15_000);
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(onCursor).toHaveBeenLastCalledWith(null);
  });

  it('zooms the shared view to a range dragged across a chart', () => {
    const onView = vi.fn();
    renderCharts({ onView });
    const svg = within(screen.getByTestId('quality-audioJitterMs')).getByRole('img');
    fireEvent.pointerDown(svg, { clientX: 300 });
    fireEvent.pointerMove(svg, { clientX: 520 });
    fireEvent.pointerUp(svg, { clientX: 520 });
    expect(onView).toHaveBeenCalledTimes(1);
    expect(onView.mock.calls[0][0].from).toBeGreaterThan(FULL.from);
  });

  it('picks one person out from the legend, and draws an issue\'s stretch on each chart', () => {
    renderCharts({ band: { from: Date.parse(at(5.5)), to: Date.parse(at(6.25)), lane: BOB } });
    fireEvent.click(screen.getAllByTestId('quality-legend')[1]);
    const [alice, bob] = within(screen.getByTestId('quality-rttMs')).getAllByTestId('quality-line');
    expect(alice.getAttribute('class')).toContain('is-dimmed');
    expect(bob.getAttribute('class')).not.toContain('is-dimmed');
    expect(screen.getAllByTestId('quality-band').length).toBe(6);
  });

  it('announces the readout only for a move made with the keys, never for one the pointer makes', () => {
    renderCharts({ cursor: Date.parse(at(5)) });
    const svg = within(screen.getByTestId('quality-rttMs')).getByRole('img');
    const live = () => screen.getByTestId('readout-rttMs').getAttribute('aria-live');
    expect(live()).toBe('off');
    fireEvent.pointerMove(svg, { clientX: 400 });
    expect(live()).toBe('off');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(live()).toBe('polite');
    fireEvent.pointerMove(svg, { clientX: 420 });
    expect(live()).toBe('off');
  });

  it('a drag holds the pointer, so it ends where it is released, and leaving the chart mid-drag does not drop it', () => {
    const onView = vi.fn();
    renderCharts({ onView });
    const svg = within(screen.getByTestId('quality-audioJitterMs')).getByRole('img') as unknown as SVGSVGElement;
    const captured = new Set<number>();
    Object.assign(svg, {
      setPointerCapture: (id: number) => { captured.add(id); },
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => { captured.delete(id); },
    });
    fireEvent.pointerDown(svg, { clientX: 300, pointerId: 7 });
    expect(captured.has(7)).toBe(true);
    fireEvent.pointerMove(svg, { clientX: 520, pointerId: 7 });
    fireEvent.pointerLeave(svg, { pointerId: 7 });
    fireEvent.pointerUp(svg, { clientX: 520, pointerId: 7 });
    expect(onView).toHaveBeenCalledTimes(1);
    expect(captured.size).toBe(0);
  });

  it('draws no readings table while the tables are closed', () => {
    renderCharts();
    expect(screen.queryByTestId('quality-table-rttMs')).toBeNull();
    expect(screen.queryAllByTestId('connectivity-lane')).toHaveLength(0);
  });

  it('holds each connection\'s readings and figures in tables, with the server\'s poor seconds', () => {
    renderCharts();
    const table = screen.getByTestId('connectivity-table');
    (table as HTMLDetailsElement).open = true;
    fireEvent(table, new Event('toggle'));
    expect(within(table).getAllByTestId('connectivity-lane')).toHaveLength(2);
    expect(table.textContent).toContain('poor for 45s');
    expect(within(screen.getByTestId('quality-table-rttMs')).getAllByRole('row').length).toBe(1 + 12);
  });

  it('reads the connection from the events where the answer carries none', () => {
    renderCharts({ lanes: connectivityLanes(undefined, EVENTS), people: [ALICE, BOB] });
    expect(within(screen.getByTestId('quality-rttMs')).getAllByTestId('quality-line').map((l) => l.getAttribute('data-person'))).toEqual([BOB]);
  });

  it('says the connection was not recorded, rather than drawing empty charts', () => {
    renderCharts({ lanes: [] });
    expect(screen.getByTestId('connectivity-none').textContent).toBe('Not recorded for this meeting.');
    expect(screen.queryByTestId('quality-rttMs')).toBeNull();
  });

  it('the locale file holds only the connection copy the charts and tables say, one title per charted measure', () => {
    const copy = (en as { admin: { meetings: { connectivity: Record<string, unknown> } } }).admin.meetings.connectivity;
    expect(Object.keys(copy).sort()).toEqual(['health', 'measures', 'none', 'poorFor', 'readings_one', 'readings_other', 'title', 'videoStops_one', 'videoStops_other']);
    expect(Object.keys(copy.health as object).sort()).toEqual(['good', 'poor']);
    expect(Object.keys(copy.measures as object).sort()).toEqual([...QUALITY_MEASURES].sort());
  });
});
