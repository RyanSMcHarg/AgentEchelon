/**
 * THE VIDEO LAYOUT (SPEC-ASSISTANT-MEETINGS FR61): a share on the stage and off it, the one-sharer rule, the self view,
 * the paged grid and what it subscribes to, and the placeholder of a tile with no video.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';

const mockMeeting = vi.fn();
vi.mock('../../providers/MeetingProvider', () => ({ useMeeting: () => mockMeeting() }));
const mockSignals = vi.fn();
vi.mock('../../providers/meetingSignals', () => ({ useMeetingSignals: () => mockSignals() }));

import VideoTiles from './VideoTiles';

const names: Record<string, string> = { me: 'Ada Lovelace', bo: 'Bo Diddley', cy: 'Cy Young', di: 'Di' };
const nameOf = (id: string) => names[id];
const people = [
  { attendeeId: 'a-me', personId: 'me' },
  { attendeeId: 'a-bo', personId: 'bo' },
  { attendeeId: 'a-cy', personId: 'cy' },
];
const base = (over: Record<string, unknown> = {}) => ({
  status: 'joined', tiles: [], activeSpeaker: undefined, bindVideoElement: vi.fn(), muted: false, selfAttendeeId: 'a-me',
  cameraOn: true, sharing: false, toggleShare: vi.fn(), videoSources: [], videoPolicy: () => null, attendees: people,
  ...over,
});
const share = (tileId: number, who: string) => ({ tileId, attendeeId: `${who}#content`, isLocal: false, isContent: true });
const stageText = (c: HTMLElement) => c.querySelector('.ae-video-stage > [data-testid="meeting-tile"]')?.textContent ?? '';
const tileOf = (label: string) => screen.getAllByTestId('meeting-tile').find((t) => t.querySelector('.ae-video-badge')?.textContent?.startsWith(label))!;
const badges = (root: ParentNode = document) => [...root.querySelectorAll('.ae-video-badge')].map((b) => b.textContent?.trim());
const hasSelfTile = () => badges().includes(en.meeting.you);

beforeEach(() => {
  mockSignals.mockReturnValue({ hostMuted: new Set(), poorSignal: new Set() });
  try { localStorage.removeItem('ae.meeting.selfView'); } catch { /* none kept */ }
});

describe('a shared screen', () => {
  it('takes the stage with its presenter named and the speaker over it, and stopping it gives the stage back', () => {
    mockMeeting.mockReturnValue(base({ activeSpeaker: 'a-cy', tiles: [share(7, 'a-bo')] }));
    const { container, rerender } = render(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(stageText(container)).toContain('Bo Diddley is presenting');
    expect(screen.getByTestId('meeting-share-overlay').textContent).toContain('Cy Young');

    mockMeeting.mockReturnValue(base({ activeSpeaker: 'a-cy', tiles: [] }));
    rerender(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(stageText(container)).toContain('Cy Young');
    expect(screen.queryByTestId('meeting-share-overlay')).toBeNull();
    expect(container.querySelector('.ae-video-strip')?.textContent).toContain('Bo Diddley');
  });

  it('sits above the grid, named by who presents', () => {
    mockMeeting.mockReturnValue(base({ tiles: [share(7, 'a-bo')] }));
    const { container } = render(<VideoTiles layout="grid" nameOf={nameOf} />);
    expect(container.querySelector('.ae-video-grid-content')?.textContent).toContain('Bo Diddley is presenting');
  });

  it('tells a sharer they present, and stops their share when a newer one starts, not an older one', () => {
    const toggleShare = vi.fn();
    const own = share(5, 'a-me');
    mockMeeting.mockReturnValue(base({ sharing: true, toggleShare, tiles: [own] }));
    const { rerender } = render(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(screen.getByText(en.meeting.youArePresenting)).toBeTruthy();
    mockMeeting.mockReturnValue(base({ sharing: true, toggleShare, tiles: [share(3, 'a-bo'), own] }));
    rerender(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(toggleShare).not.toHaveBeenCalled();
    mockMeeting.mockReturnValue(base({ sharing: true, toggleShare, tiles: [own, share(9, 'a-cy')] }));
    rerender(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(toggleShare).toHaveBeenCalledTimes(1);
  });
});

describe('the speaker layout', () => {
  it('follows the active speaker among the others, and keeps the last one while the viewer speaks', () => {
    mockMeeting.mockReturnValue(base({ activeSpeaker: 'a-cy' }));
    const { container, rerender } = render(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(stageText(container)).toContain('Cy Young');
    mockMeeting.mockReturnValue(base({ activeSpeaker: 'a-me' }));
    rerender(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(stageText(container)).toContain('Cy Young');
    mockMeeting.mockReturnValue(base({ activeSpeaker: 'a-bo' }));
    rerender(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(stageText(container)).toContain('Bo Diddley');
  });

  it('shows the viewer in their own view over the stage, not in the filmstrip', () => {
    mockMeeting.mockReturnValue(base());
    const { container } = render(<VideoTiles layout="speaker" nameOf={nameOf} />);
    expect(within(screen.getByTestId('meeting-self-view')).getByText(en.meeting.you)).toBeTruthy();
    expect(badges(container.querySelector('.ae-video-strip')!)).not.toContain(en.meeting.you);
  });

  it('captures the pointer a mouse presses on the self view, so the release that ends a drag reaches it', () => {
    mockMeeting.mockReturnValue(base());
    render(<VideoTiles layout="speaker" nameOf={nameOf} />);
    const selfView = screen.getByTestId('meeting-self-view');
    const capture = vi.fn();
    (selfView as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = capture;
    const down = createEvent.pointerDown(selfView, { pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent(selfView, down);
    expect(capture).toHaveBeenCalledWith(7);
    // No native drag of the video takes the gesture away.
    expect(down.defaultPrevented).toBe(true);
  });

  it('hides and shows the self view, and remembers the choice in this browser', () => {
    mockMeeting.mockReturnValue(base());
    const first = render(<VideoTiles layout="speaker" nameOf={nameOf} />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.selfView.hideLabel }));
    expect(screen.queryByTestId('meeting-self-view')).toBeNull();
    first.unmount();
    render(<VideoTiles layout="grid" nameOf={nameOf} />);
    expect(hasSelfTile()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.selfView.show }));
    expect(hasSelfTile()).toBe(true);
  });
});

describe('a tile with no video', () => {
  it('shows initials where a camera is off or the network paused the video, and the video where it plays', () => {
    mockMeeting.mockReturnValue(base({
      cameraOn: false,
      attendees: [...people, { attendeeId: 'a-di', personId: 'di' }],
      tiles: [
        { tileId: 1, attendeeId: 'a-me', isLocal: true, isContent: false },
        { tileId: 2, attendeeId: 'a-bo', isLocal: false, isContent: false, paused: true },
        { tileId: 3, attendeeId: 'a-cy', isLocal: false, isContent: false },
      ],
    }));
    render(<VideoTiles layout="grid" nameOf={nameOf} />);
    // The viewer, camera off: initials of their own name.
    expect(within(tileOf(en.meeting.you)).getByTestId('meeting-tile-placeholder').textContent).toBe('AL');
    expect(within(tileOf('Bo Diddley')).getByLabelText(en.meeting.videoPaused).textContent).toBe('BD');
    expect(within(tileOf('Di')).getByLabelText(en.meeting.cameraOff).textContent).toBe('D');
    expect(within(tileOf('Cy Young')).queryByTestId('meeting-tile-placeholder')).toBeNull();
    // A paused video keeps its element, so it plays again in place.
    expect(tileOf('Bo Diddley').querySelector('video')).not.toBeNull();
  });
});

describe('the grid', () => {
  // The viewer and eleven others, each publishing video, and the last of them sharing a screen.
  const others = Array.from({ length: 11 }, (_, i) => ({ attendeeId: `a-${i + 1}`, personId: `p-${i + 1}` }));
  const crowd = (choose: ReturnType<typeof vi.fn>) => base({
    attendees: [{ attendeeId: 'a-me', personId: 'me' }, ...others],
    videoSources: [...others.map((o) => o.attendeeId), 'a-11#content'],
    videoPolicy: () => ({ chooseRemoteVideoSources: choose }),
  });
  const chosen = (choose: ReturnType<typeof vi.fn>) =>
    new Set([...(choose.mock.calls[choose.mock.calls.length - 1][0] as Iterable<{ attendeeId: string }>)].map((p) => p.attendeeId));

  it('pages past nine people and receives only the page in view, and every share', () => {
    const choose = vi.fn();
    mockMeeting.mockReturnValue(crowd(choose));
    render(<VideoTiles layout="grid" />);
    // Page one: the viewer (sent, not received) and the first eight others; the share is received whatever the page.
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(screen.getAllByTestId('meeting-tile')).toHaveLength(9);
    expect(chosen(choose)).toEqual(new Set(['a-11#content', ...others.slice(0, 8).map((o) => o.attendeeId)]));
    fireEvent.click(screen.getByRole('button', { name: en.meeting.grid.next }));
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect(chosen(choose)).toEqual(new Set(['a-11#content', 'a-9', 'a-10', 'a-11']));
    expect(screen.getByRole('button', { name: en.meeting.grid.next })).toBeDisabled();
  });

  it('keeps its page across a change of layout', () => {
    mockMeeting.mockReturnValue(crowd(vi.fn()));
    const { rerender } = render(<VideoTiles layout="grid" />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.grid.next }));
    rerender(<VideoTiles layout="speaker" />);
    expect(screen.queryByText('Page 2 of 2')).toBeNull();
    rerender(<VideoTiles layout="grid" />);
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
  });

  it('rings the active speaker and carries the mute and network signs on a grid tile', () => {
    mockSignals.mockReturnValue({ hostMuted: new Set(), poorSignal: new Set(['a-cy']) });
    mockMeeting.mockReturnValue(base({ activeSpeaker: 'a-bo', attendees: [people[0], { ...people[1], muted: true }, people[2]] }));
    render(<VideoTiles layout="grid" nameOf={nameOf} />);
    expect(tileOf('Bo Diddley').className).toContain('ae-video-tile--speaking');
    expect(within(tileOf('Bo Diddley')).getByTestId('mic-muted')).toBeTruthy();
    expect(within(tileOf('Cy Young')).getByTestId('mic-network')).toBeTruthy();
  });
});
