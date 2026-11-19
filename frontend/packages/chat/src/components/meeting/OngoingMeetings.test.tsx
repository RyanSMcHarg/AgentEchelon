/**
 * MEETINGS NOW (`OngoingMeetings.tsx`, `useOngoingMeetings.ts`): filled from `POST /meetings/mine` on load and on a new
 * messaging session only, the platform's pushed started and ended cards applied directly (no read per event), Return for
 * a meeting the person is in elsewhere and Join otherwise, and one ring on opening the app for a running meeting they are
 * not in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
// The deployment serves meetings at its person API, and the person is signed in.
vi.mock('@ae/shared', async (orig) => ({
  ...(await orig<object>()),
  APP_INSTANCE_ARN: 'arn:aws:chime:us-east-1:1:app-instance/i',
  ensureFreshIdToken: async () => 'token',
  personApiServes: (capability: string) => capability === 'meetings',
  personUrl: (path: string) => 'https://api.example' + path,
}));
let mockConversations: Array<{ conversationArn: string; title: string }> = [];
vi.mock('../../providers/ConversationProvider.chime', () => ({ useConversations: () => ({ messages: [], conversations: mockConversations }) }));
const mockRingLate = vi.fn();
type News = { seq?: number; channelArn: string; at: number; card?: { event: 'meeting-started' | 'meeting-ended'; meetingId: string; conversationId?: string; roomConversationId?: string; ringUntil?: number }; sentAt?: number; removed?: true };
let mockMessaging: { sessionVersion: number; ringHeard: null | { channelArn: string; at: number }; meetingNews: null | News; meetingNewsAfter?: (seq: number) => News[]; ringLate: typeof mockRingLate } = { sessionVersion: 1, ringHeard: null, meetingNews: null, ringLate: mockRingLate };
vi.mock('../../providers/MessagingProvider', () => ({ useMessaging: () => mockMessaging }));
const mockOpen = vi.fn();
const mockForward = vi.fn((..._a: unknown[]) => true);
vi.mock('../../utils/meetingWindow', async (orig) => ({
  ...(await orig<object>()),
  openMeetingWindow: (...a: unknown[]) => mockOpen(...a),
  bringMeetingWindowForward: (...a: unknown[]) => mockForward(...a),
}));
const mockAskForward = vi.fn();
/** The meetings this person is in, in a window of this browser, by any name the meeting goes by. */
let inMeeting = new Set<string>();
vi.mock('../../services/meetingPresence', () => ({
  unlessInMeeting: (id: string, then: () => void) => { if (!inMeeting.has(id)) then(); },
  askMeetingWindowForward: (ids: readonly string[]) => mockAskForward(ids),
  watchMeetingPresenceAs: (ids: readonly string[], on: (here: boolean) => void) => {
    if (ids.some((id) => inMeeting.has(id))) on(true);
    return () => undefined;
  },
}));

import OngoingMeetings from './OngoingMeetings';

const RUNNING = { conversationId: 'meet-1', roomConversationId: 'room-1', name: 'Meeting in Checkout latency', startedAt: new Date(Date.now() - 12 * 60000).toISOString(), isHost: false };
let answer: unknown = { meetings: [RUNNING] };
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  void url; void init;
  return { ok: true, status: 200, json: async () => answer } as Response;
});

beforeEach(() => {
  vi.clearAllMocks();
  inMeeting = new Set();
  mockConversations = [];
  answer = { meetings: [RUNNING] };
  mockMessaging = { sessionVersion: 1, ringHeard: null, meetingNews: null, ringLate: mockRingLate };
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('meetings now, at the top of the navigation', () => {
  it("lists each meeting the service answers, by its own conversation's name as it is, with how long it has run and Join from that conversation", async () => {
    render(<OngoingMeetings />);
    const row = await screen.findByTestId('ongoing-meeting');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/meetings\/mine$/);
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(row).toHaveTextContent('Meeting in Checkout latency');
    expect(row).toHaveTextContent('12 min');
    screen.getByRole('button', { name: /Join Meeting in Checkout latency/ }).click();
    expect(mockOpen).toHaveBeenCalledWith(`${APP}/channel/meet-1`, 'meet-1');
  });

  it("uses the generic name where neither the service nor the person's conversations name it", async () => {
    answer = { meetings: [{ ...RUNNING, name: undefined }] };
    render(<OngoingMeetings />);
    expect(await screen.findByTestId('ongoing-meeting')).toHaveTextContent(en.meeting.title);
    screen.getByRole('button', { name: new RegExp(en.meeting.ongoing.join) }).click();
    expect(mockOpen).toHaveBeenCalledWith(`${APP}/channel/meet-1`, 'meet-1');
  });

  it('shows nothing while no meeting runs', async () => {
    answer = { meetings: [] };
    const { container } = render(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads nothing on a ring or a ring-off: the list is read on load and on a new session only', async () => {
    const { rerender } = render(<OngoingMeetings />);
    await screen.findByTestId('ongoing-meeting');
    mockMessaging = { ...mockMessaging, ringHeard: { channelArn: `${APP}/channel/meet-1`, at: Date.now() } };
    rerender(<OngoingMeetings />);
    await act(async () => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mockMessaging = { ...mockMessaging, sessionVersion: 2 };
    rerender(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('takes a meeting off the list when its ended card arrives, in its own conversation or its room, with no read', async () => {
    const { rerender } = render(<OngoingMeetings />);
    await screen.findByTestId('ongoing-meeting');
    mockMessaging = { ...mockMessaging, meetingNews: { channelArn: `${APP}/channel/meet-1`, at: Date.now(), card: { event: 'meeting-ended', meetingId: 'm-1', conversationId: 'meet-1', roomConversationId: 'room-1' } } };
    rerender(<OngoingMeetings />);
    await waitFor(() => expect(screen.queryByTestId('ongoing-meeting')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('takes a meeting off the list when this person is removed from its conversation', async () => {
    const { rerender } = render(<OngoingMeetings />);
    await screen.findByTestId('ongoing-meeting');
    mockMessaging = { ...mockMessaging, meetingNews: { channelArn: `${APP}/channel/meet-1`, at: Date.now(), removed: true } };
    rerender(<OngoingMeetings />);
    await waitFor(() => expect(screen.queryByTestId('ongoing-meeting')).toBeNull());
  });

  it('says the person is in a meeting they joined from another window, and Return brings that window forward without opening another', async () => {
    inMeeting = new Set(['meet-1']);
    render(<OngoingMeetings />);
    const back = await screen.findByRole('button', { name: /Return to Meeting in Checkout latency/ });
    expect(back).toHaveTextContent(en.meeting.ongoing.return);
    expect(screen.getByTestId('ongoing-in-meeting')).toHaveTextContent(en.meeting.ongoing.inMeeting);
    back.click();
    expect(mockAskForward).toHaveBeenCalledWith(['meet-1', 'room-1']);
    expect(mockForward).toHaveBeenCalledWith(`${APP}/channel/meet-1`, 'meet-1');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('names the other tab when the browser cannot bring it forward, and still opens no second window', async () => {
    inMeeting = new Set(['meet-1']);
    mockForward.mockReturnValueOnce(false);
    render(<OngoingMeetings />);
    (await screen.findByRole('button', { name: /Return to Meeting in Checkout latency/ })).click();
    expect(await screen.findByText(en.meeting.ongoing.inAnotherTab)).toBeInTheDocument();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("shows a meeting started elsewhere as soon as its started card arrives, by its conversation's name, with no read and no timer", async () => {
    answer = { meetings: [] };
    mockConversations = [{ conversationArn: `${APP}/channel/meet-2`, title: 'Meeting in Billing' }];
    const { rerender } = render(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('ongoing-meeting')).toBeNull();
    mockMessaging = { ...mockMessaging, meetingNews: { channelArn: `${APP}/channel/meet-2`, at: Date.now(), card: { event: 'meeting-started', meetingId: 'm-2', conversationId: 'meet-2', roomConversationId: 'room-2' } } };
    rerender(<OngoingMeetings />);
    const row = await screen.findByTestId('ongoing-meeting');
    expect(row).toHaveTextContent('Meeting in Billing');
    expect(row).toHaveAttribute('data-meeting', 'meet-2');
    // The same card posted in its parent conversation lists it once.
    mockMessaging = { ...mockMessaging, meetingNews: { channelArn: `${APP}/channel/room-2`, at: Date.now(), card: { event: 'meeting-started', meetingId: 'm-2', conversationId: 'meet-2' } } };
    rerender(<OngoingMeetings />);
    await act(async () => undefined);
    expect(screen.getAllByTestId('ongoing-meeting')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('news that lands in one render', () => {
  it('is applied whole: two meetings started at once are both listed', async () => {
    answer = { meetings: [] };
    const { rerender } = render(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const started = (seq: number, id: string): News => ({ seq, channelArn: `${APP}/channel/${id}`, at: Date.now(), card: { event: 'meeting-started', meetingId: `m-${id}`, conversationId: id, roomConversationId: `room-${id}` } });
    const log = [started(1, 'meet-a'), started(2, 'meet-b')];
    mockMessaging = { ...mockMessaging, meetingNews: log[1], meetingNewsAfter: (seq) => log.filter((n) => (n.seq ?? 0) > seq) };
    rerender(<OngoingMeetings />);
    await waitFor(() => expect(screen.getAllByTestId('ongoing-meeting')).toHaveLength(2));
  });

  it("heard before the list mounted is the read's to answer, and is not applied", async () => {
    answer = { meetings: [] };
    const old: News = { seq: 4, channelArn: `${APP}/channel/meet-old`, at: Date.now(), card: { event: 'meeting-started', meetingId: 'm-old', conversationId: 'meet-old', roomConversationId: 'room-old' } };
    mockMessaging = { ...mockMessaging, meetingNews: old, meetingNewsAfter: (seq) => [old].filter((n) => (n.seq ?? 0) > seq) };
    render(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(screen.queryByTestId('ongoing-meeting')).toBeNull();
  });
});

describe('the ring on opening the app', () => {
  it('rings once for a running meeting the person is not in, for the ring length, and not again this load', async () => {
    const before = Date.now();
    const { rerender } = render(<OngoingMeetings />);
    await waitFor(() => expect(mockRingLate).toHaveBeenCalledTimes(1));
    const [arn, endsAt] = mockRingLate.mock.calls[0] as [string, number];
    expect(arn).toBe(`${APP}/channel/meet-1`);
    expect(endsAt - before).toBeGreaterThanOrEqual(5000);
    expect(endsAt - before).toBeLessThanOrEqual(61000);
    mockMessaging = { ...mockMessaging, sessionVersion: 2 };
    rerender(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(mockRingLate).toHaveBeenCalledTimes(1);
  });

  it("rings for what is left of the meeting's own ring", async () => {
    answer = { meetings: [{ ...RUNNING, ringSecondsLeft: 7 }] };
    const before = Date.now();
    render(<OngoingMeetings />);
    await waitFor(() => expect(mockRingLate).toHaveBeenCalled());
    const endsAt = mockRingLate.mock.calls[0][1] as number;
    expect(endsAt - before).toBeGreaterThanOrEqual(7000);
    expect(endsAt - before).toBeLessThan(9000);
  });

  it("a meeting started while the app is open rings a person its ring did not reach, from its started card, for what is left, with no read", async () => {
    answer = { meetings: [] };
    const { rerender } = render(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const before = Date.now();
    const card = { event: 'meeting-started' as const, meetingId: 'm-3', conversationId: 'meet-3', roomConversationId: 'room-3', ringUntil: before + 8_000 };
    mockMessaging = { ...mockMessaging, meetingNews: { seq: 1, channelArn: `${APP}/channel/room-3`, at: before, card } };
    rerender(<OngoingMeetings />);
    await waitFor(() => expect(mockRingLate).toHaveBeenCalledTimes(1));
    const [arn, endsAt] = mockRingLate.mock.calls[0] as [string, number];
    expect(arn).toBe(`${APP}/channel/meet-3`);
    expect(endsAt).toBe(before + 8_000);
    // The same card in the meeting's own conversation rings nobody again, and nothing was read for it.
    mockMessaging = { ...mockMessaging, meetingNews: { seq: 2, channelArn: `${APP}/channel/meet-3`, at: Date.now(), card } };
    rerender(<OngoingMeetings />);
    await act(async () => undefined);
    expect(mockRingLate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a started card whose ring is over, or that carries none, rings nobody', async () => {
    answer = { meetings: [] };
    const { rerender } = render(<OngoingMeetings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    mockMessaging = { ...mockMessaging, meetingNews: { seq: 1, channelArn: `${APP}/channel/room-4`, at: Date.now(), card: { event: 'meeting-started', meetingId: 'm-4', conversationId: 'meet-4', ringUntil: Date.now() - 1_000 } as News['card'] } };
    rerender(<OngoingMeetings />);
    mockMessaging = { ...mockMessaging, meetingNews: { seq: 2, channelArn: `${APP}/channel/room-5`, at: Date.now(), card: { event: 'meeting-started', meetingId: 'm-5', conversationId: 'meet-5' } } };
    rerender(<OngoingMeetings />);
    await act(async () => undefined);
    expect(mockRingLate).not.toHaveBeenCalled();
  });

  it('does not ring for a meeting the person is already in, and still lists it', async () => {
    inMeeting = new Set(['meet-1']);
    render(<OngoingMeetings />);
    await screen.findByTestId('ongoing-meeting');
    expect(mockRingLate).not.toHaveBeenCalled();
  });
});
