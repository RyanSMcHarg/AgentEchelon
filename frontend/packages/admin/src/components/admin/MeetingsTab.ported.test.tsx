/**
 * THE MEETINGS TAB, WITH ITS DASHBOARD DETAIL (SPEC-ASSISTANT-MEETINGS FR68): each feature renders, the
 * transcript is read only under the content capability with a reason, a link opens one meeting, and every section the
 * tab already had still renders beside them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within, cleanup, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import MeetingsTab from './MeetingsTab';
import MeetingTimeline from './MeetingTimeline';
import { clearConversationNames } from './MeetingContext';
import { buildTimeline } from './meetingLanes';
import { ALICE, BOB, DETAIL, EVENTS, MEETING as FIXTURE_MEETING, at } from './meetingFixture';
import { CapabilityTestProvider } from '../../capabilities';
import { ReasonDeclinedError } from '../../services/adminReason';
import type { MeetingAnswer, MeetingEvent } from '../../services/meetingAnalyticsService';

const fetchMeetings = vi.fn();
const fetchMeeting = vi.fn();
const fetchMeetingContent = vi.fn();
vi.mock('../../services/meetingAnalyticsService', () => ({
  INCIDENT_KINDS: ['drop', 'joinFailure', 'mediaFailure', 'connectionFailure'],
  fetchMeetings: (...a: unknown[]) => fetchMeetings(...a),
  fetchMeeting: (...a: unknown[]) => fetchMeeting(...a),
  fetchMeetingContent: (...a: unknown[]) => fetchMeetingContent(...a),
  endMeetingForEveryone: vi.fn(),
}));
const findAdminConversation = vi.fn();
vi.mock('../../services/adminConversationService', () => ({ findAdminConversation: (...a: unknown[]) => findAdminConversation(...a) }));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/a';
const CHANNEL = `${APP}/channel/meet-1`;
const ROOM = `${APP}/channel/room-1`;
const NONE = { value: null, over: 0 };
const FIGURES = {
  meetings: 2, byStatus: { active: 0, ended: 2, abandoned: 0 }, durationSeconds: { value: 1200, over: 2 }, peoplePerMeeting: { value: 2, over: 2 },
  dropRate: { value: 0.25, over: 4 }, dropEvents: 1, dropsPerPersonWhoDropped: { value: 1, over: 1 }, phoneShare: { value: 0, over: 4 },
  joinLatencyMs: { p50: { value: 6200, over: 6 }, p95: { value: 1200, over: 6 }, mean: NONE }, joinSuccessRate: { value: 1, over: 4 },
  healthyMeetings: { value: 0.5, over: 2 },
  failuresByType: { audioInputFailed: 1 }, reconnects: 0,
  ring: { sent: 1, answered: 1, dismissed: 0, timedOut: 0, answerRate: { value: 1, over: 1 }, timeToAnswerMs: { p50: NONE, p95: NONE } },
  byDay: [{ day: '2026-11-11', meetings: 2, people: 4, dropEvents: 1, clientFailures: 1 }],
  browsers: { 'Chrome 131': 2 }, operatingSystems: { 'macOS 15': 1 }, sdkVersions: { '3.31.0': 2 }, startedVia: { person: 2, workflow: 0, unknown: 0 },
  quality: { good: 3, warning: 0, error: 1 },
  incidents: {
    drop: { count: 1, recent: [{ kind: 'drop', meetingId: 'm-1', personKey: BOB, eventType: 'AttendeeDropped', at: at(14), errorMessage: null }] },
    joinFailure: { count: 0, recent: [] }, mediaFailure: { count: 0, recent: [] }, connectionFailure: { count: 0, recent: [] },
  },
};
const SUMMARY = {
  ...FIXTURE_MEETING, channelArn: CHANNEL, roster: undefined, live: false, endedHow: 'everyoneLeft' as const,
  createdBy: ALICE, hosts: [ALICE], mediaRegion: 'eu-west-2', transcribed: true,
};
const COVER = { days: 7, from: '2026-11-05T12:00:00.000Z', to: '2026-11-12T12:00:00.000Z', store: 'athena' as const, truncated: false, unreadClassifications: [] };

const BOB_ROW = FIXTURE_MEETING.roster![1];
const ROSTER = [
  { ...FIXTURE_MEETING.roster![0], device: { browser: 'Chrome 131', os: 'macOS 15.1', name: 'MacBook Pro', sdk: '3.31.0' }, presenceReceivedMs: 820 },
  { ...BOB_ROW, failureEvents: [{ eventType: 'audioInputFailed', at: at(9), errorMessage: 'NotAllowedError' }] },
];
const EVENTS_ON_CHANNEL: MeetingEvent[] = EVENTS.map((e) => ({ ...e, channel_arn: CHANNEL }));
const OPENED: MeetingAnswer = {
  ...DETAIL, meeting: { ...SUMMARY, roster: ROSTER }, events: EVENTS_ON_CHANNEL,
  conversation: { type: 'meeting', room: { channelArn: ROOM, type: 'account-room' } },
};

const ALL = ['view-meeting-analytics', 'end-meetings', 'find-conversation', 'view-events'];
const renderTab = async (capabilities: string[] = ALL, onOpenConversation = vi.fn()) => {
  await act(async () => {
    render(<CapabilityTestProvider capabilities={capabilities}><MeetingsTab onOpenConversation={onOpenConversation} /></CapabilityTestProvider>);
  });
  return onOpenConversation;
};
const openMeeting = async () => {
  await act(async () => { fireEvent.click(screen.getAllByTestId('meeting-state').find((el) => el.closest('tr'))!); });
};

beforeEach(() => {
  vi.clearAllMocks();
  clearConversationNames();
  window.history.replaceState({}, '', '/?admin=meetings');
  fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [SUMMARY] });
  fetchMeeting.mockResolvedValue(OPENED);
  findAdminConversation.mockImplementation(async (id: string) => ({ channelArn: `${APP}/channel/${id}`, name: id === 'room-1' ? 'Northwind account room' : 'Northwind call' }));
});
afterEach(() => { vi.useRealTimers(); });

describe('the overview', () => {
  it('shows the meeting health score and colors the health, drop and join tiles by their thresholds', async () => {
    await renderTab();
    const tiles = screen.getAllByTestId('meeting-figure');
    const tile = (label: string) => tiles.find((t) => t.textContent?.includes(label))!;
    expect(tile('Healthy meetings').textContent).toContain('50%');
    expect(tile('Healthy meetings').getAttribute('data-tone')).toBe('bad');
    expect(tile('People who dropped').getAttribute('data-tone')).toBe('bad');
    expect(tile('Join time (median)').getAttribute('data-tone')).toBe('bad');
    expect(tile('Join time (95th)').getAttribute('data-tone')).toBe('good');
    // The tone is said in words, not by color alone.
    expect(tile('Healthy meetings').textContent).toContain('bad');
  });

  it('lists each meeting with its conversation by name and its host by id', async () => {
    await renderTab();
    const row = screen.getAllByTestId('meeting-state')[0].closest('tr')!;
    expect(row.textContent).toContain('Northwind call');
    expect(row.textContent).toContain(ALICE);
  });

  it('asks again for a name whose lookup failed, rather than showing the id for the rest of the session', async () => {
    findAdminConversation.mockRejectedValueOnce(new Error('throttled'));
    await renderTab();
    expect(screen.getAllByTestId('meeting-state')[0].closest('tr')!.textContent).toContain('meet-1');
    cleanup();
    await renderTab();
    expect(screen.getAllByTestId('meeting-state')[0].closest('tr')!.textContent).toContain('Northwind call');
  });

  it('shows a conversation by its id to an operator who may not look conversations up', async () => {
    await renderTab(['view-meeting-analytics']);
    expect(findAdminConversation).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('meeting-state')[0].closest('tr')!.textContent).toContain('meet-1');
  });

  it('draws the day chart in a one-day window', async () => {
    fetchMeetings.mockResolvedValue({ ...COVER, days: 1, from: '2026-11-11T01:00:00.000Z', to: '2026-11-11T23:00:00.000Z', figures: FIGURES, meetings: [SUMMARY] });
    await renderTab();
    expect(screen.getByTestId('meetings-by-day')).toBeTruthy();
  });

  it('opens an incident\'s meeting from its row', async () => {
    await renderTab();
    await act(async () => { fireEvent.click(within(screen.getByTestId('incidents-drop')).getAllByTestId('incident-row')[0].querySelector('td')!); });
    expect(fetchMeeting).toHaveBeenCalledWith('m-1', 7);
  });

  it('reads the window again on Refresh, and the open meeting with it', async () => {
    await renderTab();
    await openMeeting();
    await act(async () => { fireEvent.click(screen.getByTestId('meetings-refresh')); });
    expect(fetchMeetings).toHaveBeenCalledTimes(2);
    expect(fetchMeeting).toHaveBeenCalledTimes(2);
  });
});

describe('one meeting', () => {
  it('shows where it was held, opening the conversation and the room in the viewer, and who started and hosts it by id', async () => {
    const onOpen = await renderTab();
    await openMeeting();
    const ctx = screen.getByTestId('meeting-context');
    expect(ctx.textContent).toContain('Northwind call');
    expect(screen.getByTestId('meeting-room').textContent).toContain('Northwind account room');
    expect(screen.getByTestId('meeting-creator').textContent).toBe(ALICE);
    expect(screen.getByTestId('meeting-hosts').textContent).toBe(ALICE);
    expect(screen.getByTestId('meeting-region').textContent).toBe('eu-west-2');
    expect(ctx.textContent).toContain('A person');
    expect(ctx.textContent).toContain('account-room');
    fireEvent.click(within(screen.getByTestId('meeting-room')).getByTestId('conversation-link'));
    expect(onOpen).toHaveBeenCalledWith(ROOM);
  });

  it('shows its start and end, and each person\'s join and leave times', async () => {
    await renderTab();
    await openMeeting();
    expect(screen.getByTestId('meeting-times').textContent).toContain(new Date(FIXTURE_MEETING.endedAt!).toLocaleString());
    const roster = screen.getByTestId('meeting-detail').querySelector('.data-table')!;
    expect(roster.textContent).toContain('Joined');
    expect(roster.textContent).toContain('Left');
  });

  it('shows its quality bar, how many had issues, and its drops and reconnects', async () => {
    await renderTab();
    await openMeeting();
    const q = screen.getByTestId('meeting-quality');
    expect(q.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('Good 1');
    expect(screen.getByTestId('meeting-issues').textContent).toContain('1 with issues');
    expect(screen.getByTestId('meeting-issues').textContent).toContain('0 reconnects');
  });

  it('says why a person fared as they did and the text of their failure, and tints their row', async () => {
    await renderTab();
    await openMeeting();
    expect(screen.getAllByTestId('quality-reasons').map((r) => r.textContent).join(' ')).toContain('Microphone failed');
    expect(screen.getByTestId('roster-errors').textContent).toBe('Microphone failed: NotAllowedError');
    expect(screen.getByTestId('roster-errors').closest('tr')!.className).toContain('meetings-row-error');
  });

  it('opens each person\'s panel: their device, timings, issues, errors and their own events', async () => {
    await renderTab();
    await openMeeting();
    const panels = screen.getAllByTestId('person-panel');
    expect(panels[0].getAttribute('data-person')).toBe(BOB);
    const alice = panels.find((p) => p.getAttribute('data-person') === ALICE)!;
    expect(alice.textContent).toContain('MacBook Pro');
    expect(alice.textContent).toContain('macOS 15.1');
    expect(alice.textContent).toContain('3.31.0');
    expect(alice.textContent).toContain('820ms');
    expect(within(panels[0]).getByTestId('person-errors').textContent).toContain('NotAllowedError');
    const own = within(panels[0]).getByTestId('person-events');
    expect(own.textContent).toContain('Microphone failed');
    expect(own.textContent).not.toContain('Camera on');
    expect(own.querySelector('tr.is-failure')).toBeTruthy();
  });

  it('opens from a link to it, and the open meeting is in the address', async () => {
    window.history.replaceState({}, '', '/?admin=meetings&meeting=m-1');
    await renderTab();
    expect(fetchMeeting).toHaveBeenCalledWith('m-1', 7);
    expect(screen.getByTestId('meeting-detail')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('All meetings')); });
    expect(new URL(window.location.href).searchParams.get('meeting')).toBeNull();
    await openMeeting();
    expect(new URL(window.location.href).searchParams.get('meeting')).toBe('m-1');
  });

  it('keeps the window in the address, so a link reopens the meeting over the days it was read in', async () => {
    await renderTab();
    await act(async () => { fireEvent.change(screen.getByLabelText('Window'), { target: { value: '30' } }); });
    await openMeeting();
    expect(fetchMeeting).toHaveBeenLastCalledWith('m-1', 30);
    expect(new URL(window.location.href).searchParams.get('meetingDays')).toBe('30');
    cleanup();
    vi.clearAllMocks();
    fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [SUMMARY] });
    fetchMeeting.mockResolvedValue(OPENED);
    await renderTab();
    expect(fetchMeetings).toHaveBeenCalledWith(30);
    expect(fetchMeeting).toHaveBeenCalledWith('m-1', 30);
    await act(async () => { fireEvent.click(screen.getByText('All meetings')); });
    expect(new URL(window.location.href).searchParams.get('meetingDays')).toBeNull();
  });

  it('counts a live meeting\'s length on the viewer\'s clock, without reading the server again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse(at(10)));
    const LIVE = { ...SUMMARY, live: true, endedAt: null, durationSeconds: null, status: 'active' as const };
    fetchMeetings.mockResolvedValue({ ...COVER, figures: FIGURES, meetings: [LIVE] });
    fetchMeeting.mockResolvedValue({ ...OPENED, meeting: { ...OPENED.meeting, ...LIVE } });
    await renderTab();
    await openMeeting();
    const before = screen.getByTestId('meeting-length').textContent;
    expect(before).toContain('10m 00s');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.getByTestId('meeting-length').textContent).toContain('10m 05s');
    expect(fetchMeetings).toHaveBeenCalledTimes(1);
    expect(fetchMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('its transcript', () => {
  it('says a transcript exists, and reads nothing for an operator without the content capability', async () => {
    await renderTab(['view-meeting-analytics', 'find-conversation']);
    await openMeeting();
    expect(screen.getByTestId('transcript-exists')).toBeTruthy();
    expect(screen.getByTestId('transcript-needs-capability')).toBeTruthy();
    expect(screen.queryByTestId('read-transcript')).toBeNull();
    expect(screen.queryByTestId('transcript-text')).toBeNull();
    expect(fetchMeetingContent).not.toHaveBeenCalled();
    // The detail itself never carries what was said.
    expect(JSON.stringify(OPENED)).not.toContain('transcript"');
  });

  it('reads it on request under the content capability, for this meeting and window', async () => {
    fetchMeetingContent.mockResolvedValue({ transcript: '[0:00] **Alice**: we agreed the renewal', summary: null });
    await renderTab();
    await openMeeting();
    expect(fetchMeetingContent).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('read-transcript')); });
    expect(fetchMeetingContent).toHaveBeenCalledWith('m-1', CHANNEL, 7);
    expect(screen.getByTestId('transcript-text').textContent).toContain('we agreed the renewal');
  });

  it('shows the summary with each action item linked to its task on the room, its assignee by id', async () => {
    fetchMeeting.mockResolvedValue({ ...OPENED, conversation: { ...OPENED.conversation!, summarized: true } });
    fetchMeetingContent.mockResolvedValue({
      transcript: null,
      summary: {
        summary: 'Renewal agreed.', keyPoints: ['Price held'], nextSteps: ['Send the order form'], topics: ['renewal'],
        actionItems: [{ text: 'Send the order form', due: '2026-11-20', taskId: 't-1', assignee: BOB }, { text: 'Book the review', heldBy: ALICE }],
      },
    });
    const onOpen = await renderTab();
    await openMeeting();
    expect(screen.getByTestId('transcript-exists').textContent).toContain('summary');
    await act(async () => { fireEvent.click(screen.getByTestId('read-transcript')); });
    expect(screen.getByTestId('meeting-summary').textContent).toContain('Renewal agreed.');
    expect(screen.getByTestId('summary-key-points').textContent).toContain('Price held');
    expect(screen.getByTestId('summary-next-steps').textContent).toContain('Send the order form');
    const items = screen.getAllByTestId('action-item');
    expect(items[0].textContent).toContain(BOB);
    expect(items[0].textContent).toContain('2026-11-20');
    expect(items[1].textContent).toContain(ALICE);
    expect(within(items[1]).queryByTestId('action-item-task')).toBeNull();
    fireEvent.click(within(items[0]).getByTestId('action-item-task'));
    expect(onOpen).toHaveBeenCalledWith(ROOM);
    expect(screen.getByTestId('transcript-absent').textContent).toMatch(/No transcript/);
  });

  it('shows nothing when the operator gives no reason', async () => {
    fetchMeetingContent.mockRejectedValue(new ReasonDeclinedError());
    await renderTab();
    await openMeeting();
    await act(async () => { fireEvent.click(screen.getByTestId('read-transcript')); });
    expect(screen.queryByTestId('transcript-text')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a captions-only meeting kept no transcript, and offers no read', async () => {
    fetchMeeting.mockResolvedValue({ ...OPENED, conversation: { ...OPENED.conversation!, transcriptKept: false } });
    await renderTab();
    await openMeeting();
    expect(screen.getByTestId('transcript-absent').textContent).toMatch(/Captions only/);
    expect(screen.queryByTestId('read-transcript')).toBeNull();
    expect(fetchMeetingContent).not.toHaveBeenCalled();
  });

  it('lets a read made before the transcript was written be made again, and Refresh starts it over', async () => {
    fetchMeetingContent.mockResolvedValueOnce(null);
    // Each read of the meeting is its own answer, as each response is parsed anew.
    fetchMeeting.mockImplementation(async () => ({ ...OPENED }));
    await renderTab();
    await openMeeting();
    await act(async () => { fireEvent.click(screen.getByTestId('read-transcript')); });
    expect(screen.getByTestId('transcript-absent').textContent).toMatch(/yet/);
    expect(screen.getByTestId('read-transcript')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('meetings-refresh')); });
    expect(screen.getByTestId('transcript-exists')).toBeTruthy();
    fetchMeetingContent.mockResolvedValueOnce({ transcript: '[0:00] **Alice**: written now', summary: null });
    await act(async () => { fireEvent.click(screen.getByTestId('read-transcript')); });
    expect(screen.getByTestId('transcript-text').textContent).toContain('written now');
  });

  it('explains a meeting that was not transcribed', async () => {
    fetchMeeting.mockResolvedValue({ ...OPENED, meeting: { ...OPENED.meeting, transcribed: false } });
    await renderTab();
    await openMeeting();
    expect(screen.getByTestId('transcript-absent').textContent).toMatch(/Not transcribed/);
    expect(screen.queryByTestId('read-transcript')).toBeNull();
  });
});

describe('the timeline filter', () => {
  const renderTimeline = () => render(
    <MeetingTimeline timeline={buildTimeline(FIXTURE_MEETING, EVENTS)} events={EVENTS} issues={new Map([[BOB, 'error' as const]])} />,
  );

  it('shows one category alone, and Show all brings every category back', () => {
    renderTimeline();
    fireEvent.click(screen.getByTestId('only-failure'));
    expect(screen.getAllByTestId('timeline-marker').every((m) => m.getAttribute('data-category') === 'failure')).toBe(true);
    expect(screen.getByTestId('category-presence').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('category-clear'));
    expect(screen.queryByTestId('category-clear')).toBeNull();
    expect(screen.getAllByTestId('timeline-marker').some((m) => m.getAttribute('data-category') === 'presence')).toBe(true);
  });

  it('gives each row its source and its error, tints a failure, and tints the lane of a person who fared badly', () => {
    renderTimeline();
    const failure = screen.getAllByTestId('event-row').find((r) => r.textContent?.includes('Microphone failed'))!;
    expect(within(failure).getByTestId('event-error').textContent).toContain('NotAllowedError');
    expect(within(failure).getByTestId('event-source').textContent).toBe('app');
    expect(failure.className).toContain('is-failure');
    expect(screen.getAllByTestId('timeline-lane').find((l) => l.getAttribute('data-lane') === BOB)!.getAttribute('data-issue')).toBe('error');
  });
});

describe('a meeting\'s experience issues, first on its dashboard', () => {
  const ISSUE = { personKey: BOB, attendeeId: `${BOB}-a1`, kind: 'roundTrip' as const, from: at(6), to: at(7), seconds: 60, peak: 420, eventType: null };
  const sample = (min: number, rttMs: number) => ({
    at: at(min), health: 'good' as const, audioLossSendPct: 0, audioLossReceivePct: 0, audioJitterMs: 10, rttMs,
    availableSendKbps: 1500, availableReceiveKbps: 3000, videoSendKbps: null, videoReceiveKbps: null,
  });

  it('comes before the rest of the meeting, and an issue jumps the timeline and the charts to its moment', async () => {
    fetchMeeting.mockResolvedValue({
      ...OPENED,
      connectivity: [{ personKey: BOB, attendeeId: `${BOB}-a1`, samples: [5, 5.25, 5.5, 5.75, 6, 6.25, 6.5, 6.75, 7].map((m, i) => sample(m, 80 + i * 60)), healthChanges: [], poorSeconds: 0, videoStopSuggestions: 0 }],
      experience: { thresholds: { packetLossPct: 3, jitterMs: 30, roundTripMs: 300, sustainedSeconds: 30 }, issues: [ISSUE] },
    });
    await renderTab();
    await openMeeting();
    const detail = screen.getByTestId('meeting-detail');
    const order = [...detail.querySelectorAll('[data-testid="meeting-experience"], [data-testid="timeline-section"], [data-testid="connectivity-panel"]')].map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual(['meeting-experience', 'timeline-section', 'connectivity-panel']);
    const whole = screen.getByTestId('timeline-range').textContent;
    expect(screen.queryByTestId('timeline-band')).toBeNull();
    fireEvent.click(screen.getByTestId('experience-item'));
    expect(screen.getByTestId('timeline-range').textContent).not.toBe(whole);
    expect(screen.getByTestId('timeline-band')).toBeTruthy();
    expect(screen.getAllByTestId('quality-band').length).toBeGreaterThan(0);
    expect(screen.getByTestId('timeline-cursor')).toBeTruthy();
    expect(screen.getByTestId('readout-rttMs').textContent).toContain(BOB);
    expect(screen.getByTestId('threshold-rttMs')).toBeTruthy();
    // The list beneath the timeline holds the events of the range jumped to.
    expect(screen.getAllByTestId('event-row').every((r) => r.textContent && !r.textContent.includes('Meeting ended'))).toBe(true);
  });

  it('a Refresh keeps the jump while its issue is still in the new answer, marked and framed, and drops it once the issue is gone', async () => {
    const answer = (issues: Array<typeof ISSUE>) => ({
      ...OPENED,
      connectivity: [{ personKey: BOB, attendeeId: `${BOB}-a1`, samples: [5, 5.5, 6, 6.5, 7].map((m, i) => sample(m, 80 + i * 60)), healthChanges: [], poorSeconds: 0, videoStopSuggestions: 0 }],
      // A new answer each read: the issue is equal, never the same object.
      experience: { thresholds: { packetLossPct: 3, jitterMs: 30, roundTripMs: 300, sustainedSeconds: 30 }, issues: issues.map((i) => ({ ...i })) },
    });
    fetchMeeting.mockImplementation(async () => answer([ISSUE]));
    await renderTab();
    await openMeeting();
    fireEvent.click(screen.getByTestId('experience-item'));
    const jumpedRange = screen.getByTestId('timeline-range').textContent;
    expect(screen.getByTestId('experience-item').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('meetings-refresh'));
    await waitFor(() => expect(fetchMeeting).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('experience-item').getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByTestId('timeline-band')).toBeTruthy();
    expect(screen.getByTestId('timeline-range').textContent).toBe(jumpedRange);
    // THE ISSUE IS GONE FROM THE NEXT ANSWER: its band and its mark go with it, and the view is the whole meeting.
    fetchMeeting.mockImplementation(async () => answer([]));
    fireEvent.click(screen.getByTestId('meetings-refresh'));
    await waitFor(() => expect(screen.getByTestId('experience-none')).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId('timeline-band')).toBeNull());
    expect(screen.queryAllByTestId('quality-band')).toHaveLength(0);
    expect(screen.getByTestId('timeline-range').textContent).not.toBe(jumpedRange);
  });
});

describe('what the tab already had', () => {
  it('still renders every kept section beside the ported ones', async () => {
    fetchMeetings.mockResolvedValue({ ...COVER, truncated: true, figures: FIGURES, meetings: [SUMMARY] });
    await renderTab();
    const labels = screen.getAllByTestId('meeting-figure').map((t) => t.textContent ?? '');
    for (const l of ['Join time (median)', 'Join time (95th)', 'Joins that worked', 'Rings answered', 'Time to answer']) expect(labels.some((x) => x.includes(l))).toBe(true);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getByTestId('meetings-by-day')).toBeTruthy();
    expect(screen.getByTestId('by-day-table')).toBeTruthy();
    expect(screen.getByTestId('meetings-quality')).toBeTruthy();
    expect(screen.getByTestId('meetings-status').textContent).toContain('Started by');
    expect(screen.getAllByTestId('bar-list').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByTestId('meetings-incidents')).toBeTruthy();
    expect(screen.getByTestId('live-filter')).toBeTruthy();
    expect(screen.getAllByTestId('meeting-state')[0].closest('tr')!.textContent).toContain('A person');
    await openMeeting();
    expect(screen.getByTestId('meeting-timeline')).toBeTruthy();
    expect(screen.getAllByTestId('span-connected').length).toBeGreaterThan(0);
    expect(screen.getByTestId('connectivity-panel')).toBeTruthy();
    fireEvent.click(screen.getAllByTestId('timeline-marker')[0]);
    expect(screen.getByTestId('event-detail')).toBeTruthy();
    expect(screen.getByTestId('meeting-detail').textContent).not.toMatch(/Alice|Bob/);
  });
});
