/**
 * WHAT A PERSON MAY DO ABOUT A CONVERSATION'S MEETING follows the service: Join while it runs (again after leaving it),
 * End for those the server says may end it, Start for its host, and nothing for a meeting the service has ended.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockStatus = vi.fn();
vi.mock('../services/meetingService', () => ({
  isMeetingEnabled: () => true,
  meetingService: { status: (...a: unknown[]) => mockStatus(...a) },
}));
let ringHeard: { channelArn: string; at: number } | null = null;
// One opener for the test's life, as the provider's is.
const ringLate = vi.fn();
const localTimeOf = (t: number) => t;
vi.mock('../providers/MessagingProvider', () => ({
  useMessaging: () => ({ sessionVersion: 1, incomingRing: null, ringHeard, ringLate, localTimeOf }),
}));
let presence: ((here: boolean) => void) | undefined;
let inMeeting = new Set<string>();
vi.mock('../services/meetingPresence', () => ({
  watchMeetingPresenceAs: (_ids: string[], on: (here: boolean) => void) => { presence = on; return () => undefined; },
  unlessInMeeting: (id: string, then: () => void) => { if (!inMeeting.has(id)) then(); },
}));

import { useConversationMeeting } from './useConversationMeeting';

const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/room-1';

beforeEach(() => { mockStatus.mockReset(); presence = undefined; ringHeard = null; inMeeting = new Set(); ringLate.mockReset(); });

describe("a late arrival's ring", () => {
  it("is the meeting's own ring, keyed by its own conversation, never the room being viewed", async () => {
    mockStatus.mockResolvedValue({ running: true, conversationId: 'meet-1', roomConversationId: 'room-1', ringSecondsLeft: 8 });
    renderHook(() => useConversationMeeting(ROOM, []));
    await waitFor(() => expect(ringLate).toHaveBeenCalled());
    expect(ringLate.mock.calls[0][0]).toBe('arn:aws:chime:us-east-1:1:app-instance/a/channel/meet-1');
  });

  it('does not ring a person already in the meeting in another window', async () => {
    inMeeting = new Set(['meet-1']);
    mockStatus.mockResolvedValue({ running: true, conversationId: 'meet-1', roomConversationId: 'room-1', ringSecondsLeft: 8 });
    const { result } = renderHook(() => useConversationMeeting(ROOM, []));
    await waitFor(() => expect(result.current.running).toBe(true));
    expect(ringLate).not.toHaveBeenCalled();
  });
});

describe('the conversation meeting a person sees', () => {
  it('offers End only where the read says the reader may end it', async () => {
    mockStatus.mockResolvedValue({ running: true, mayEnd: true, isHost: true, conversationId: 'meet-1' });
    const { result } = renderHook(() => useConversationMeeting(ROOM, []));
    await waitFor(() => expect(result.current.running).toBe(true));
    expect(result.current.mayEnd).toBe(true);
    expect(result.current.isHost).toBe(true);
  });

  it('runs nothing for a meeting the service has ended, however it was recorded', async () => {
    mockStatus.mockResolvedValue({ running: false, ended: true, mayStart: false });
    const { result } = renderHook(() => useConversationMeeting(ROOM, []));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.running).toBe(false);
    expect(result.current.ended).toBe(true);
    expect(result.current.mayStart).toBe(false);
  });

  it('reads again when this person leaves the meeting in another window, so Join returns while it still runs', async () => {
    mockStatus.mockResolvedValue({ running: true, conversationId: 'meet-1' });
    const { result } = renderHook(() => useConversationMeeting(ROOM, []));
    await waitFor(() => expect(result.current.running).toBe(true));
    act(() => presence?.(true));
    expect(result.current.joinedHere).toBe(true);
    const reads = mockStatus.mock.calls.length;
    act(() => presence?.(false));
    await waitFor(() => expect(mockStatus.mock.calls.length).toBeGreaterThan(reads));
    expect(result.current.joinedHere).toBe(false);
    expect(result.current.running).toBe(true);
  });

  it('says a refused read rather than showing no meeting at all', async () => {
    mockStatus.mockRejectedValue(Object.assign(new Error('not a member'), { code: 'NOT_A_MEMBER', status: 403 }));
    const { result } = renderHook(() => useConversationMeeting(ROOM, []));
    await waitFor(() => expect(result.current.errorCode).toBe('NOT_A_MEMBER'));
    expect(result.current.known).toBe(false);
    // The next read that answers clears it.
    mockStatus.mockResolvedValue({ running: true, conversationId: 'meet-1' });
    ringHeard = { channelArn: ROOM, at: 1 };
    const { result: again } = renderHook(() => useConversationMeeting(ROOM, []));
    await waitFor(() => expect(again.current.running).toBe(true));
    expect(again.current.errorCode).toBeUndefined();
  });

  it("reads again when a ring or a ring-off is heard for the meeting's room, as a meeting window waiting for its host does", async () => {
    const MEETING = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/meet-1';
    mockStatus.mockResolvedValue({ running: false, mayStart: false, roomConversationId: 'room-1' });
    const { result, rerender } = renderHook(() => useConversationMeeting(MEETING, []));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.running).toBe(false);
    mockStatus.mockResolvedValue({ running: true, conversationId: 'meet-1', roomConversationId: 'room-1' });
    // A ring for another conversation reads nothing again.
    ringHeard = { channelArn: 'arn:aws:chime:us-east-1:1:app-instance/a/channel/elsewhere', at: 5 };
    rerender();
    const reads = mockStatus.mock.calls.length;
    ringHeard = { channelArn: ROOM, at: 10 };
    rerender();
    await waitFor(() => expect(result.current.running).toBe(true));
    expect(mockStatus.mock.calls.length).toBe(reads + 1);
  });
});
