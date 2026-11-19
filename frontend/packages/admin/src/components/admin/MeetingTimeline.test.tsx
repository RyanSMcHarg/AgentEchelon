import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@ae/shared/i18n';
import MeetingTimeline from './MeetingTimeline';
import { buildTimeline } from './meetingLanes';
import { ALICE, BOB, EVENTS, MEETING, at } from './meetingFixture';

const timeline = buildTimeline(MEETING, EVENTS);
const renderTimeline = (props: Partial<React.ComponentProps<typeof MeetingTimeline>> = {}) =>
  render(<MeetingTimeline timeline={timeline} events={EVENTS} {...props} />);
/** Every event drawn: a marker alone, or one counted in a group. */
const drawnCount = () => screen.queryAllByTestId('timeline-marker').length
  + screen.queryAllByTestId('timeline-group').reduce((n, g) => n + Number(g.getAttribute('data-count')), 0);
const MARKED = EVENTS.length - 2; // every event but the connectivity readings

describe('a meeting\'s timeline', () => {
  it('draws a lane per person, labelled by their id, with their connected, camera and sharing spans', () => {
    renderTimeline();
    const lanes = screen.getAllByTestId('timeline-lane');
    expect(lanes.map((l) => l.getAttribute('data-lane'))).toEqual(['__meeting', ALICE, BOB]);
    expect(lanes[1].textContent).toContain(ALICE);
    expect(within(lanes[1] as unknown as HTMLElement).getAllByTestId('span-camera')).toHaveLength(1);
    expect(within(lanes[1] as unknown as HTMLElement).getAllByTestId('span-sharing')).toHaveLength(1);
    expect(within(lanes[2] as unknown as HTMLElement).getAllByTestId('span-connected')).toHaveLength(2);
  });

  it('draws every event as a marker named beside its glyph, or in a group with its count, and lists each beneath', () => {
    renderTimeline();
    expect(drawnCount()).toBe(MARKED);
    // Readable without hovering: a lone marker carries its event's name as text on the plot.
    const lone = screen.getAllByTestId('timeline-marker');
    expect(lone.length).toBeGreaterThan(0);
    for (const m of lone) expect(m.querySelector('text')?.textContent).toBeTruthy();
    const groups = screen.getAllByTestId('timeline-group');
    expect(groups[0].textContent).toMatch(/\d+ events/);
    expect(screen.getAllByTestId('event-row')).toHaveLength(MARKED);
    expect(screen.getByTestId('event-list').textContent).toContain('Microphone failed');
  });

  it('expands a group to its events, from the mouse and the keyboard, and selects one from it', () => {
    renderTimeline();
    const group = screen.getAllByTestId('timeline-group').find((g) => g.getAttribute('data-lane') === BOB)!;
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(group.getAttribute('aria-expanded')).toBe('true');
    const open = screen.getByTestId('timeline-group-open');
    const items = within(open).getAllByTestId('group-event');
    expect(items.length).toBe(Number(group.getAttribute('data-count')));
    fireEvent.click(items[0]);
    expect(screen.getByTestId('event-detail')).toBeTruthy();
    fireEvent.click(group);
    expect(screen.queryByTestId('timeline-group-open')).toBeNull();
  });

  it('zooms in, pans and returns to the whole meeting, and the list follows the range drawn', () => {
    renderTimeline();
    const whole = screen.getByTestId('timeline-range').textContent;
    fireEvent.click(screen.getByTestId('zoom-in'));
    expect(screen.getByTestId('timeline-range').textContent).not.toBe(whole);
    expect(screen.getAllByTestId('event-row').length).toBeLessThan(MARKED);
    const plot = screen.getByTestId('timeline-plot');
    const zoomed = screen.getByTestId('timeline-range').textContent;
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(screen.getByTestId('timeline-range').textContent).not.toBe(zoomed);
    fireEvent.keyDown(plot, { key: '0' });
    expect(screen.getByTestId('timeline-range').textContent).toBe(whole);
    expect(screen.getAllByTestId('event-row')).toHaveLength(MARKED);
    fireEvent.keyDown(plot, { key: '+' });
    expect(screen.getByTestId('timeline-range').textContent).not.toBe(whole);
  });

  it('zooms to the range dragged across the plot, through the shared view where a parent holds it', () => {
    const onView = vi.fn();
    renderTimeline({ view: { from: timeline.start, to: timeline.end }, onView });
    const svg = screen.getByRole('group', { name: 'Timeline' });
    fireEvent.pointerDown(svg, { clientX: 300 });
    fireEvent.pointerMove(svg, { clientX: 500 });
    fireEvent.pointerUp(svg, { clientX: 500 });
    expect(onView).toHaveBeenCalledTimes(1);
    const [v] = onView.mock.calls[0];
    expect(v.from).toBeGreaterThan(timeline.start);
    expect(v.to).toBeLessThan(timeline.end);
  });

  it('a drag holds the pointer, so leaving the plot mid-drag does not drop it and the release ends it', () => {
    const onView = vi.fn();
    renderTimeline({ view: { from: timeline.start, to: timeline.end }, onView });
    const svg = screen.getByRole('group', { name: 'Timeline' });
    const captured = new Set<number>();
    Object.assign(svg, {
      setPointerCapture: (id: number) => { captured.add(id); },
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => { captured.delete(id); },
    });
    fireEvent.pointerDown(svg, { clientX: 300, pointerId: 3 });
    expect(captured.has(3)).toBe(true);
    fireEvent.pointerMove(svg, { clientX: 500, pointerId: 3 });
    fireEvent.pointerLeave(svg, { pointerId: 3 });
    fireEvent.pointerUp(svg, { clientX: 500, pointerId: 3 });
    expect(onView).toHaveBeenCalledTimes(1);
    expect(captured.size).toBe(0);
  });

  it('separates crowded markers once zoomed, and a lone marker selects its event and shows everything recorded about it', () => {
    renderTimeline({ view: { from: Date.parse(at(13.5)), to: Date.parse(at(14.5)) }, onView: vi.fn() });
    const dropped = screen.getAllByTestId('timeline-marker').find((m) => m.getAttribute('data-event') === 'AttendeeDropped')!;
    expect(dropped.textContent).toContain('Dropped');
    fireEvent.keyDown(dropped, { key: 'Enter' });
    expect(dropped.getAttribute('aria-pressed')).toBe('true');
    const detail = screen.getByTestId('event-detail');
    expect(detail.textContent).toContain(BOB);
    expect(screen.getAllByTestId('event-row').find((r) => r.getAttribute('aria-selected') === 'true')!.textContent).toContain('Dropped');
  });

  it('draws the moment pointed at and the stretch an issue jumped to, and reports the moment under the pointer', () => {
    const onCursor = vi.fn();
    renderTimeline({ cursor: Date.parse(at(6)), onCursor, band: { from: Date.parse(at(6)), to: Date.parse(at(7)), lane: BOB } });
    expect(screen.getByTestId('timeline-cursor')).toBeTruthy();
    expect(screen.getByTestId('timeline-band')).toBeTruthy();
    fireEvent.pointerMove(screen.getByRole('group', { name: 'Timeline' }), { clientX: 400 });
    expect(onCursor).toHaveBeenCalledWith(expect.any(Number));
  });

  it('hides a category from the chart and the list when its filter is turned off', () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId('category-failure'));
    expect(screen.getByTestId('category-failure').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('event-list').textContent).not.toContain('Microphone failed');
    expect(drawnCount()).toBeLessThan(MARKED);
    fireEvent.click(screen.getByTestId('category-failure'));
    expect(screen.getByTestId('event-list').textContent).toContain('Microphone failed');
  });

  it('narrows the list to one person from their lane', () => {
    renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: `Show only ${ALICE} in the list` }));
    const rows = screen.getAllByTestId('event-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.textContent?.includes(ALICE))).toBe(true);
  });

  it('shows everything recorded about an event when its row is chosen', () => {
    renderTimeline();
    fireEvent.click(screen.getAllByTestId('event-row').find((r) => r.textContent?.includes('Microphone failed'))!);
    const detail = screen.getByTestId('event-detail');
    expect(detail.textContent).toContain('Microphone failed');
    expect(detail.textContent).toContain(BOB);
    expect(detail.textContent).toContain('NotAllowedError');
    expect(detail.textContent).toContain("The person's app");
  });

  it('keeps the chosen event chosen when a refresh brings the events at other places in the list', () => {
    const { rerender } = renderTimeline();
    fireEvent.click(screen.getAllByTestId('event-row').find((r) => r.textContent?.includes('Microphone failed'))!);
    // A refresh: an event recorded early arrives late, so every later event sits one place further on.
    const early = { ...EVENTS[1], event_type: 'audioUnmuted', event_at: new Date(Date.parse(EVENTS[1].event_at) + 1).toISOString() };
    const next = [EVENTS[0], early, ...EVENTS.slice(1)];
    rerender(<MeetingTimeline timeline={buildTimeline(MEETING, next)} events={next} />);
    expect(screen.getByTestId('event-detail').textContent).toContain('Microphone failed');
  });
});
