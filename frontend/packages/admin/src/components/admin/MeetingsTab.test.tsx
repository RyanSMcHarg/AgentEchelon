import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@ae/shared/i18n';
import MeetingsTab, { figureText, formatSeconds } from './MeetingsTab';
import { ALICE, BOB, DETAIL } from './meetingFixture';
import { CapabilityTestProvider } from '../../capabilities';
import { ReasonDeclinedError } from '../../services/adminReason';

// The tab shows people by their id and looks up no names.
const nameLookup = vi.fn();
vi.mock('./usePersonNames', () => ({ usePersonNames: (...a: unknown[]) => { nameLookup(...a); return {}; }, default: (...a: unknown[]) => { nameLookup(...a); return {}; } }));

const fetchMeetings = vi.fn();
const fetchMeeting = vi.fn();
const endMeetingForEveryone = vi.fn();
vi.mock('../../services/meetingAnalyticsService', () => ({
  INCIDENT_KINDS: ['drop', 'joinFailure', 'mediaFailure', 'connectionFailure'],
  fetchMeetings: (...a: unknown[]) => fetchMeetings(...a),
  fetchMeeting: (...a: unknown[]) => fetchMeeting(...a),
  endMeetingForEveryone: (...a: unknown[]) => endMeetingForEveryone(...a),
}));

const NONE = { value: null, over: 0 };
const FIGURES = {
  meetings: 1, byStatus: { active: 0, ended: 1, abandoned: 0 }, durationSeconds: { value: 1800, over: 1 }, peoplePerMeeting: { value: 2, over: 1 },
  dropRate: { value: 0.5, over: 2 }, dropEvents: 1, dropsPerPersonWhoDropped: { value: 1, over: 1 }, phoneShare: { value: 0, over: 2 },
  joinLatencyMs: { p50: { value: null, over: 2 }, p95: NONE, mean: { value: 1500, over: 2 } }, joinSuccessRate: { value: 1, over: 2 },
  failuresByType: { audioInputFailed: 1 }, reconnects: 0,
  ring: { sent: 1, answered: 1, dismissed: 0, timedOut: 0, answerRate: { value: 1, over: 1 }, timeToAnswerMs: { p50: NONE, p95: NONE } },
  byDay: [{ day: '2026-11-06', meetings: 2, people: 5, dropEvents: 1, clientFailures: 0 }, { day: '2026-11-11', meetings: 1, people: 2, dropEvents: 0, clientFailures: 3 }], browsers: { 'Chrome 131': 2 }, operatingSystems: {}, sdkVersions: {}, startedVia: { person: 1, workflow: 0, unknown: 0 },
  quality: { good: 3, warning: 1, error: 1 },
  incidents: {
    drop: { count: 1, recent: [{ kind: 'drop', meetingId: 'm-1', personKey: BOB, eventType: 'AttendeeDropped', at: '2026-11-11T10:14:00.000Z', errorMessage: null }] },
    joinFailure: { count: 0, recent: [] },
    mediaFailure: { count: 60, recent: [{ kind: 'mediaFailure', meetingId: 'm-1', personKey: BOB, eventType: 'audioInputFailed', at: '2026-11-11T10:09:00.000Z', errorMessage: 'NotAllowedError' }] },
    connectionFailure: { count: 0, recent: [] },
  },
};
const MEETING = {
  meetingId: 'm-1', channelArn: 'arn:c', classification: 'premium', status: 'ended', startedAt: '2026-11-11T10:00:00.000Z', endedAt: '2026-11-11T10:30:00.000Z',
  durationSeconds: 1800, startedVia: 'person', people: 2, phonePeople: 0, dropEvents: 1, peopleWhoDropped: 1, reconnects: 0, clientFailures: 1,
  joinLatencyMs: { p50: NONE, p95: NONE }, ring: { answered: 1, dismissed: 0, timedOut: 0 },
};
const COVER = { days: 7, from: '2026-11-05T12:00:00.000Z', to: '2026-11-12T12:00:00.000Z', store: 'athena', truncated: false, unreadClassifications: [] };

beforeEach(() => {
  vi.clearAllMocks();
  // A meeting opened in one test is in the address; each test starts from the tab's own address.
  window.history.replaceState({}, '', '/?admin=meetings');
  fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [MEETING] });
});

describe('the Meetings tab', () => {
  it('shows a figure over too little as a dash with its population, never as zero', async () => {
    await act(async () => { render(<MeetingsTab />); });
    const tiles = screen.getAllByTestId('meeting-figure');
    const join = tiles.find((t) => t.textContent?.includes('Join time (median)'))!;
    expect(join.textContent).toContain('-');
    expect(join.textContent).toContain('over 2');
    expect(join.textContent).not.toContain('0ms');
  });

  it('says when the answer is missing rows or a classification', async () => {
    fetchMeetings.mockResolvedValue({ ...COVER, truncated: true, unreadClassifications: ['premium'], figures: FIGURES, meetings: [] });
    await act(async () => { render(<MeetingsTab />); });
    expect(screen.getAllByRole('status').map((s) => s.textContent).join(' ')).toMatch(/premium/);
  });

  it('opens a meeting’s roster from its row', async () => {
    fetchMeeting.mockResolvedValue({ ...COVER, meeting: { ...MEETING, roster: [{
      personKey: 'p1', state: 'left', firstJoinedAt: '', lastLeftAt: null, connectedSeconds: 1200, drops: 1, reconnects: 0, transports: [],
      phone: false, cameraSeconds: 0, sharedSeconds: 60, joinLatencyMs: 900, device: { browser: 'Chrome', os: null, sdk: null }, quality: 'warning', failures: [],
    }] } });
    await act(async () => { render(<MeetingsTab />); });
    await act(async () => { fireEvent.click(screen.getAllByText('Ended').find((el) => el.closest('tr'))!); });
    expect(fetchMeeting).toHaveBeenCalledWith('m-1', 7);
    expect(screen.getByTestId('meeting-detail').textContent).toContain('20m 00s');
  });

  it('formats a length and a missing figure', () => {
    expect(formatSeconds(3900)).toBe('1h 05m');
    expect(formatSeconds(null)).toBe('-');
    expect(figureText({ value: null, over: 3 }, String)).toBe('-');
  });

  it('never writes a negative length, as a viewer clock behind the server would give', () => {
    expect(formatSeconds(-61)).toBe('0s');
    expect(formatSeconds(-0.4)).toBe('0s');
  });

  it('rounds a fractional length to the whole second before splitting it into parts', () => {
    expect(formatSeconds(779.5)).toBe('13m 00s');
    expect(formatSeconds(59.5)).toBe('1m 00s');
    expect(formatSeconds(3599.5)).toBe('1h 00m');
    expect(formatSeconds(40.4)).toBe('40s');
  });

  it('shows the figures of the selected window when an earlier window answers last', async () => {
    let finishWeek: (v: unknown) => void = () => {};
    fetchMeetings.mockReset();
    fetchMeetings
      .mockImplementationOnce(() => new Promise((r) => { finishWeek = r; }))
      .mockResolvedValueOnce({ ...COVER, days: 1, figures: { ...FIGURES, meetings: 11 }, meetings: [] });
    await act(async () => { render(<MeetingsTab />); });
    await act(async () => { fireEvent.change(screen.getByLabelText('Window'), { target: { value: '1' } }); });
    await act(async () => { finishWeek({ ...COVER, figures: { ...FIGURES, meetings: 77 }, meetings: [MEETING] }); });
    const count = screen.getAllByTestId('meeting-figure')[0];
    expect(count.textContent).toContain('11');
    expect(count.textContent).not.toContain('77');
  });

  it('drops a meeting detail that answers after the window changed', async () => {
    let finishDetail: (v: unknown) => void = () => {};
    fetchMeeting.mockImplementationOnce(() => new Promise((r) => { finishDetail = r; }));
    await act(async () => { render(<MeetingsTab />); });
    await act(async () => { fireEvent.click(screen.getAllByText('Ended').find((el) => el.closest('tr'))!); });
    await act(async () => { fireEvent.change(screen.getByLabelText('Window'), { target: { value: '30' } }); });
    await act(async () => { finishDetail({ ...COVER, meeting: { ...MEETING, roster: [] } }); });
    expect(screen.queryByTestId('meeting-detail')).toBeNull();
  });

  it('draws meetings, people, drops and failures for every day of the window, with a table of the same numbers', async () => {
    await act(async () => { render(<MeetingsTab />); });
    const charts = screen.getAllByTestId('column-chart');
    expect(charts.map((c) => c.querySelector('figcaption')?.textContent)).toEqual(['Meetings', 'People', 'Drops', 'App failures']);
    const meetings = charts[0].querySelectorAll('[data-testid="column"]');
    expect(meetings).toHaveLength(8);
    expect(meetings[1].getAttribute('aria-label')).toMatch(/: 2$/);
    expect(meetings[2].getAttribute('aria-label')).toMatch(/: 0$/);
    const rows = screen.getByTestId('by-day-table').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(8);
    expect(rows[6].textContent).toContain('3');
    // The days are UTC days, and both the chart and its table say so.
    expect(screen.getByTestId('meetings-by-day').querySelector('h3')?.textContent).toContain('UTC');
    expect(screen.getByTestId('by-day-table').querySelector('th')?.textContent).toContain('UTC');
  });

  it('splits the people by how they fared, each part named', async () => {
    await act(async () => { render(<MeetingsTab />); });
    const q = screen.getByTestId('meetings-quality');
    expect(q.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('Good 3');
    expect(q.textContent).toContain('A failure');
  });

  it('lists each kind of incident with its count, by person id, each opening its meeting', async () => {
    fetchMeeting.mockResolvedValue(DETAIL);
    await act(async () => { render(<MeetingsTab />); });
    const media = screen.getByTestId('incidents-mediaFailure');
    expect(media.textContent).toContain('60');
    expect(media.textContent).toContain('The newest 1 of 60.');
    expect(media.textContent).toContain(BOB);
    expect(media.textContent).toContain('NotAllowedError');
    expect(screen.getByTestId('incidents-joinFailure').textContent).toContain('None in this window.');
    await act(async () => { fireEvent.click(media.querySelector('button')!); });
    expect(fetchMeeting).toHaveBeenCalledWith('m-1', 7);
    expect(screen.getByTestId('meeting-detail')).toBeTruthy();
  });

  it('opens a meeting to its timeline, roster and connection, showing people by id', async () => {
    fetchMeeting.mockResolvedValue(DETAIL);
    await act(async () => { render(<MeetingsTab />); });
    await act(async () => { fireEvent.click(screen.getAllByText('Ended').find((el) => el.closest('tr'))!); });
    const detail = screen.getByTestId('meeting-detail');
    expect(screen.getByTestId('meeting-timeline')).toBeTruthy();
    expect(screen.getByTestId('connectivity-panel')).toBeTruthy();
    expect(detail.textContent).toContain(ALICE);
    expect(detail.textContent).toContain(BOB);
    expect(nameLookup).not.toHaveBeenCalled();
  });

  it('puts the population rule in the tooltip of a figure that can be a dash, and the tab carries no help line under its title', async () => {
    await act(async () => { render(<MeetingsTab />); });
    expect(screen.queryByText(/How the window's meetings went/)).toBeNull();
    expect(screen.getByRole('button', { name: 'About Join time (median)' })).toBeTruthy();
  });

  describe('which meetings run now', () => {
    const LIVE = { ...MEETING, meetingId: 'm-live', status: 'active', endedAt: null, durationSeconds: null, startedAt: '2026-11-11T11:00:00.000Z', live: true, present: 2, people: 3 };
    const STALE = { ...MEETING, meetingId: 'm-stale', status: 'active', endedAt: null, durationSeconds: null, startedAt: '2026-11-11T11:30:00.000Z', live: false };
    const ENDED = { ...MEETING, live: false, endedHow: 'everyoneLeft' };
    beforeEach(() => {
      fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [ENDED, STALE, LIVE] });
    });

    it('lists live meetings first, saying how many are in each, and a stale record as ended', async () => {
      await act(async () => { render(<MeetingsTab />); });
      const states = screen.getAllByTestId('meeting-state').map((el) => el.getAttribute('data-state'));
      expect(states[0]).toBe('live');
      expect(states.filter((x) => x === 'live')).toHaveLength(1);
      expect(screen.getByText(/2 in it now · 3 joined/)).toBeTruthy();
      expect(screen.getByText('Ended: everyone left')).toBeTruthy();
      expect(screen.getByText('Ended (no end recorded)')).toBeTruthy();
    });

    it('narrows the list to the meetings running now', async () => {
      await act(async () => { render(<MeetingsTab />); });
      expect(screen.getByTestId('live-filter').textContent).toContain('1');
      await act(async () => { fireEvent.click(screen.getByTestId('live-filter')); });
      expect(screen.getAllByTestId('meeting-state').map((el) => el.getAttribute('data-state'))).toEqual(['live']);
    });

    const openLive = async (capabilities: string[]) => {
      fetchMeeting.mockResolvedValue({ ...DETAIL, meeting: { ...DETAIL.meeting, ...LIVE, roster: DETAIL.meeting.roster } });
      await act(async () => {
        render(<CapabilityTestProvider capabilities={capabilities}><MeetingsTab /></CapabilityTestProvider>);
      });
      await act(async () => { fireEvent.click(screen.getAllByTestId('meeting-state').find((el) => el.getAttribute('data-state') === 'live')!); });
    };

    it('offers End for everyone on a live meeting only to an operator who holds end-meetings', async () => {
      await openLive(['view-meeting-analytics']);
      expect(screen.getByTestId('meeting-detail')).toBeTruthy();
      expect(screen.queryByTestId('end-meeting')).toBeNull();
    });

    it('ends a live meeting with its conversation, then reads it again', async () => {
      endMeetingForEveryone.mockResolvedValue({ ended: true });
      await openLive(['view-meeting-analytics', 'end-meetings']);
      await act(async () => { fireEvent.click(screen.getByTestId('end-meeting')); });
      expect(endMeetingForEveryone).toHaveBeenCalledWith('m-live', MEETING.channelArn);
      expect(fetchMeeting).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the operator gives no reason', async () => {
      endMeetingForEveryone.mockRejectedValue(new ReasonDeclinedError());
      await openLive(['view-meeting-analytics', 'end-meetings']);
      await act(async () => { fireEvent.click(screen.getByTestId('end-meeting')); });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(fetchMeeting).toHaveBeenCalledTimes(1);
    });

    it('never offers to end a meeting that is not live', async () => {
      fetchMeeting.mockResolvedValue({ ...DETAIL, meeting: { ...DETAIL.meeting, live: false } });
      await act(async () => { render(<CapabilityTestProvider capabilities={['end-meetings']}><MeetingsTab /></CapabilityTestProvider>); });
      await act(async () => { fireEvent.click(screen.getByText('Ended: everyone left')); });
      expect(screen.queryByTestId('end-meeting')).toBeNull();
    });
  });
});
