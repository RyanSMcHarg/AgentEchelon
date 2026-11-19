/**
 * AN OPEN MEETING IS A DRILL-DOWN, ITS FAILURES ARE WORDED FROM THE LOCALE, AND ITS CLOCK TICKS ONE ELEMENT.
 *
 * What it proves: the console's Back closes an open meeting to the list rather than leaving the tab; a refusal the route
 * answers with a code reads as that code's locale text, never the handler's own `error`, and an unknown code reads as the
 * fallback; and a live meeting's running length ticks without re-rendering the timeline beside it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import i18n from '@ae/shared/i18n';
import { ApiError } from '@ae/shared';
import MeetingsTab from './MeetingsTab';
import { DETAIL, MEETING, at } from './meetingFixture';
import { CapabilityTestProvider } from '../../capabilities';

vi.mock('./usePersonNames', () => ({ usePersonNames: () => ({}), default: () => ({}) }));

const fetchMeetings = vi.fn();
const fetchMeeting = vi.fn();
const endMeetingForEveryone = vi.fn();
vi.mock('../../services/meetingAnalyticsService', () => ({
  INCIDENT_KINDS: ['drop', 'joinFailure', 'mediaFailure', 'connectionFailure'],
  fetchMeetings: (...a: unknown[]) => fetchMeetings(...a),
  fetchMeeting: (...a: unknown[]) => fetchMeeting(...a),
  fetchMeetingContent: vi.fn(),
  endMeetingForEveryone: (...a: unknown[]) => endMeetingForEveryone(...a),
}));

// Each render of the timeline is counted, so a clock tick that re-renders the page shows here.
const timelineRenders = vi.fn();
vi.mock('./MeetingTimeline', () => ({ default: () => { timelineRenders(); return <div data-testid="meeting-timeline" />; } }));

const NONE = { value: null, over: 0 };
const FIGURES = {
  meetings: 1, byStatus: { active: 0, ended: 1, abandoned: 0 }, durationSeconds: { value: 1800, over: 1 }, peoplePerMeeting: { value: 2, over: 1 },
  dropRate: NONE, dropEvents: 0, dropsPerPersonWhoDropped: NONE, phoneShare: NONE,
  joinLatencyMs: { p50: NONE, p95: NONE, mean: NONE }, joinSuccessRate: NONE,
  failuresByType: {}, reconnects: 0,
  ring: { sent: 0, answered: 0, dismissed: 0, timedOut: 0, answerRate: NONE, timeToAnswerMs: { p50: NONE, p95: NONE } },
  byDay: [], browsers: {}, operatingSystems: {}, sdkVersions: {}, startedVia: { person: 1, workflow: 0, unknown: 0 },
  quality: { good: 2, warning: 0, error: 0 },
  incidents: { drop: { count: 0, recent: [] }, joinFailure: { count: 0, recent: [] }, mediaFailure: { count: 0, recent: [] }, connectionFailure: { count: 0, recent: [] } },
};
const COVER = { days: 7, from: '2026-11-05T12:00:00.000Z', to: '2026-11-12T12:00:00.000Z', store: 'athena', truncated: false, unreadClassifications: [] };
const ENDED = { ...MEETING, live: false, endedHow: 'everyoneLeft' };
const LIVE = { ...MEETING, meetingId: 'm-live', status: 'active', endedAt: null, durationSeconds: null, startedAt: at(0), live: true, present: 2 };

const openFirst = async () => {
  await act(async () => { fireEvent.click(screen.getAllByTestId('meeting-state')[0]); });
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/?admin=meetings');
  fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [ENDED] });
  fetchMeeting.mockResolvedValue({ ...DETAIL, meeting: { ...DETAIL.meeting, ...ENDED, roster: DETAIL.meeting.roster } });
});
afterEach(() => { vi.useRealTimers(); });

describe('the console Back on an open meeting', () => {
  it('closes the meeting to the list, and hands Back to the tab history once the list shows', async () => {
    const registerBack = vi.fn();
    await act(async () => { render(<MeetingsTab registerBack={registerBack} />); });
    expect(registerBack).toHaveBeenLastCalledWith(null);
    await openFirst();
    expect(screen.getByTestId('meeting-detail')).toBeTruthy();
    const back = registerBack.mock.calls.at(-1)?.[0];
    expect(typeof back).toBe('function');
    await act(async () => { back(); });
    expect(screen.queryByTestId('meeting-detail')).toBeNull();
    expect(screen.getAllByTestId('meeting-state').length).toBeGreaterThan(0);
    expect(new URL(window.location.href).searchParams.get('meeting')).toBeNull();
    expect(registerBack).toHaveBeenLastCalledWith(null);
  });
});

describe('a failure the meetings route answers', () => {
  it('reads as its code\'s locale text, never the handler\'s own words', async () => {
    fetchMeeting.mockRejectedValue(new ApiError(404, 'HANDLER ENGLISH', { error: 'HANDLER ENGLISH', code: 'NO_MEETING' }));
    await act(async () => { render(<MeetingsTab />); });
    await openFirst();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(i18n.t('admin.meetings.errors.NO_MEETING'));
    expect(alert.textContent).not.toContain('HANDLER ENGLISH');
  });

  it('reads as the fallback when the code is one the locale does not word', async () => {
    fetchMeetings.mockRejectedValue(new ApiError(502, 'HANDLER ENGLISH', { error: 'HANDLER ENGLISH', code: 'SOMETHING_NEW' }));
    await act(async () => { render(<MeetingsTab />); });
    expect(screen.getByRole('alert').textContent).toBe(i18n.t('admin.meetings.loadFailed'));
  });

  it('words a refused end from its code', async () => {
    fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [LIVE] });
    fetchMeeting.mockResolvedValue({ ...DETAIL, meeting: { ...DETAIL.meeting, ...LIVE, roster: DETAIL.meeting.roster } });
    endMeetingForEveryone.mockRejectedValue(new ApiError(409, 'HANDLER ENGLISH', { error: 'HANDLER ENGLISH', code: 'NOT_RUNNING' }));
    await act(async () => { render(<CapabilityTestProvider capabilities={['view-meeting-analytics', 'end-meetings']}><MeetingsTab /></CapabilityTestProvider>); });
    await openFirst();
    await act(async () => { fireEvent.click(screen.getByTestId('end-meeting')); });
    expect(screen.getByRole('alert').textContent).toBe(i18n.t('admin.meetings.errors.NOT_RUNNING'));
  });
});

describe('a live meeting\'s clock', () => {
  it('ticks the running length alone, never re-rendering the timeline', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse(at(10)));
    fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [LIVE] });
    fetchMeeting.mockResolvedValue({ ...DETAIL, meeting: { ...DETAIL.meeting, ...LIVE, roster: DETAIL.meeting.roster } });
    await act(async () => { render(<MeetingsTab />); });
    await openFirst();
    expect(screen.getByTestId('meeting-length').textContent).toContain('10m 00s');
    const renders = timelineRenders.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('meeting-length').textContent).toContain('10m 03s');
    expect(timelineRenders.mock.calls.length).toBe(renders);
  });
});
