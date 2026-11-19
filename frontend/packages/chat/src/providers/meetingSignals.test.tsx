/**
 * THE MEETING'S SIGNALS (`meetingSignals.tsx`): speaking and a poor network change only once they have held, a host's
 * control counts only from a host by the join's answer, and every subscription is taken off when the session goes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  MeetingSignalsProvider, useMeetingSignals, debouncedFlag, hostControlOf, HOST_CONTROL_TOPIC, CONTROL_LIFETIME_MS,
  SPEAKING_ON_MS, SPEAKING_OFF_MS, POOR_SIGNAL_ON_MS, POOR_SIGNAL_OFF_MS,
} from './meetingSignals';

const mockMeeting = vi.fn();
vi.mock('./MeetingProvider', () => ({ useMeeting: () => mockMeeting() }));
vi.mock('../services/chimeService', () => ({ chimeService: { getUserArn: () => 'arn:app/user/me' } }));
const setSpeaking = vi.fn();
const removePerson = vi.fn();
const requestToSpeak = vi.fn();
vi.mock('../services/meetingService', () => ({
  meetingService: { setSpeaking: (...a: unknown[]) => setSpeaking(...a), removePerson: (...a: unknown[]) => removePerson(...a), requestToSpeak: (...a: unknown[]) => requestToSpeak(...a) },
}));

type VolumeCb = (id: string, v: number | null, m: boolean | null, s: number | null) => void;
let volume: Map<string, VolumeCb>;
let messages: Map<string, (m: unknown) => void>;
const sendData = vi.fn();
const av = {
  realtimeSubscribeToVolumeIndicator: (id: string, cb: VolumeCb) => { volume.set(id, cb); },
  realtimeUnsubscribeFromVolumeIndicator: (id: string) => { volume.delete(id); },
  realtimeSubscribeToReceiveDataMessage: (topic: string, cb: (m: unknown) => void) => { messages.set(topic, cb); },
  realtimeUnsubscribeFromReceiveDataMessage: (topic: string) => { messages.delete(topic); },
  realtimeSendDataMessage: (...a: unknown[]) => sendData(...a),
};
const holdMute = vi.fn();
const state = (over: Record<string, unknown> = {}) => ({
  status: 'joined', isHost: false, hostIds: ['host'], conversationId: 'meeting-conv', selfAttendeeId: 'a-me',
  attendees: [{ attendeeId: 'a-me', personId: 'me' }, { attendeeId: 'a-bo', personId: 'bo' }, { attendeeId: 'a-host', personId: 'host' }],
  removedIds: [], mutedByHost: false, holdMute, audioVideo: () => av, ...over,
});

function Probe() {
  const s = useMeetingSignals();
  return (
    <div>
      <span data-testid="speaking">{[...s.speaking].sort().join(',')}</span>
      <span data-testid="poor">{[...s.poorSignal].sort().join(',')}</span>
      <span data-testid="held">{[...s.hostMuted].sort().join(',')}</span>
      <span data-testid="removed">{[...s.removed].sort().join(',')}</span>
      <button onClick={() => { void s.setSpeaking('bo', false); }}>mute-bo</button>
      <button onClick={() => { void s.setSpeaking('all', false); }}>mute-all</button>
      <button onClick={() => { void s.remove('bo'); }}>remove-bo</button>
    </div>
  );
}
const text = (id: string) => screen.getByTestId(id).textContent;
const message = (sender: string, body: unknown, throttled = false) => ({ senderExternalUserId: sender, throttled, text: () => JSON.stringify(body) });
const deliver = (m: unknown) => act(() => { messages.get(HOST_CONTROL_TOPIC)!(m); });
const report = (id: string, v: number | null, m: boolean | null, s: number | null) => act(() => { volume.get(id)!(id, v, m, s); });
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  volume = new Map();
  messages = new Map();
  vi.clearAllMocks();
  mockMeeting.mockReturnValue(state());
  setSpeaking.mockResolvedValue(['bo']);
  removePerson.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('debouncedFlag', () => {
  it('ignores a spike shorter than its on delay and a dip shorter than its off delay', () => {
    const seen: boolean[] = [];
    const f = debouncedFlag(200, 800, (v) => seen.push(v));
    f.set(true); vi.advanceTimersByTime(100); f.set(false); vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
    f.set(true); vi.advanceTimersByTime(200);
    expect(seen).toEqual([true]);
    f.set(false); vi.advanceTimersByTime(500); f.set(true); vi.advanceTimersByTime(2000);
    expect(seen).toEqual([true]);
    f.set(false); vi.advanceTimersByTime(800);
    expect(seen).toEqual([true, false]);
  });
});

describe('hostControlOf', () => {
  it('counts a control only from a host, by the sender the service set, and never a throttled one', () => {
    expect(hostControlOf(message('host', { action: 'mute', personId: 'me' }) as never, ['host'])).toEqual({ action: 'mute', personId: 'me' });
    expect(hostControlOf(message('bo', { action: 'mute', personId: 'me' }) as never, ['host'])).toBeNull();
    expect(hostControlOf(message('host', { action: 'mute', personId: 'me' }, true) as never, ['host'])).toBeNull();
    expect(hostControlOf(message('host', { action: 'explode', personId: 'me' }) as never, ['host'])).toBeNull();
  });
});

describe('speaking, from volume', () => {
  it('a short spike does not show speaking, a held voice does, and a short dip does not clear it', async () => {
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await report('a-bo', 0.6, false, null);
    await wait(SPEAKING_ON_MS / 2);
    await report('a-bo', 0.01, null, null);
    await wait(SPEAKING_OFF_MS * 2);
    expect(text('speaking')).toBe('');
    await report('a-bo', 0.6, null, null);
    await wait(SPEAKING_ON_MS);
    expect(text('speaking')).toBe('a-bo');
    await report('a-bo', 0.01, null, null);
    await wait(SPEAKING_OFF_MS / 2);
    await report('a-bo', 0.5, null, null);
    await wait(SPEAKING_OFF_MS * 2);
    expect(text('speaking')).toBe('a-bo');
  });

  it('a muted attendee is never speaking, however loud', async () => {
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await report('a-bo', 0.9, true, null);
    await wait(SPEAKING_ON_MS * 3);
    expect(text('speaking')).toBe('');
  });
});

describe('a poor network, from signal strength', () => {
  it('shows once poor signal has held, the viewer\'s own included, and clears once recovered long enough', async () => {
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await report('a-me', null, null, 0);
    await wait(POOR_SIGNAL_ON_MS - 1);
    expect(text('poor')).toBe('');
    await wait(1);
    expect(text('poor')).toBe('a-me');
    await report('a-me', null, null, 1);
    await wait(POOR_SIGNAL_OFF_MS - 1);
    expect(text('poor')).toBe('a-me');
    await wait(1);
    expect(text('poor')).toBe('');
  });
});

describe('a host\'s controls', () => {
  it('IGNORES a mute sent by a member who is not a host', async () => {
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await deliver(message('bo', { action: 'mute', personId: 'me' }));
    await deliver(message('bo', { action: 'mute', personId: 'all' }));
    expect(holdMute).not.toHaveBeenCalled();
    expect(text('held')).toBe('');
  });

  it('holds the viewer\'s microphone when a host mutes them, and releases it when a host lets them speak', async () => {
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await deliver(message('host', { action: 'mute', personId: 'me' }));
    expect(holdMute).toHaveBeenLastCalledWith(true);
    expect(text('held')).toBe('me');
    await deliver(message('host', { action: 'allow', personId: 'me' }));
    expect(holdMute).toHaveBeenLastCalledWith(false);
  });

  it('muting everyone holds every person who is not a host, and leaves a host\'s own microphone alone', async () => {
    mockMeeting.mockReturnValue(state({ isHost: true, hostIds: ['host', 'me'] }));
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await deliver(message('host', { action: 'mute', personId: 'all' }));
    expect(holdMute).not.toHaveBeenCalled();
    expect(text('held')).toBe('bo');
  });

  it('a host\'s control goes to the server first, then is announced to the meeting', async () => {
    mockMeeting.mockReturnValue(state({ isHost: true, hostIds: ['host', 'me'] }));
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await act(async () => { screen.getByText('mute-bo').click(); });
    expect(setSpeaking).toHaveBeenCalledWith('meeting-conv', 'bo', false);
    expect(sendData).toHaveBeenCalledWith(HOST_CONTROL_TOPIC, JSON.stringify({ action: 'mute', personId: 'bo' }), CONTROL_LIFETIME_MS);
    await act(async () => { screen.getByText('remove-bo').click(); });
    expect(removePerson).toHaveBeenCalledWith('meeting-conv', 'bo');
    expect(text('removed')).toBe('bo');
  });

  it('announces nothing when the server refuses', async () => {
    setSpeaking.mockRejectedValue(Object.assign(new Error('x'), { code: 'HOST_ONLY' }));
    render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    await act(async () => { screen.getByText('mute-all').click(); });
    expect(sendData).not.toHaveBeenCalled();
  });
});

describe('the subscriptions', () => {
  it('are taken off when the person leaves the meeting', async () => {
    const view = render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    expect([...volume.keys()].sort()).toEqual(['a-bo', 'a-host', 'a-me']);
    expect(messages.has(HOST_CONTROL_TOPIC)).toBe(true);
    mockMeeting.mockReturnValue(state({ status: 'idle', attendees: [], selfAttendeeId: undefined, audioVideo: () => null }));
    view.rerender(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    expect(volume.size).toBe(0);
    expect(messages.size).toBe(0);
  });

  it('take off an attendee who goes, and subscribe one who arrives', async () => {
    const view = render(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    mockMeeting.mockReturnValue(state({ attendees: [{ attendeeId: 'a-me', personId: 'me' }, { attendeeId: 'a-cy', personId: 'cy' }] }));
    view.rerender(<MeetingSignalsProvider><Probe /></MeetingSignalsProvider>);
    expect([...volume.keys()].sort()).toEqual(['a-cy', 'a-me']);
  });
});

describe('asking to speak (FR51, FR59)', () => {
  function Asker() {
    const s = useMeetingSignals();
    return (
      <div>
        <span data-testid="asking">{[...s.asking].sort().join(',')}</span>
        <span data-testid="pending">{String(s.speakRequestPending)}</span>
        <button onClick={() => { void s.requestToSpeak(); }}>ask</button>
        <button onClick={() => { void s.dismiss('bo'); }}>dismiss-bo</button>
      </div>
    );
  }
  const toggleMute = vi.fn();

  it('an ask counts only from the person it names: one sent for somebody else is ignored', () => {
    expect(hostControlOf(message('bo', { action: 'ask', personId: 'bo' }) as never, ['host'])).toEqual({ action: 'ask', personId: 'bo' });
    expect(hostControlOf(message('bo', { action: 'ask', personId: 'cy' }) as never, ['host'])).toBeNull();
  });

  it('a person the room muted is granted at once: the hold is released and the microphone unmuted here', async () => {
    requestToSpeak.mockResolvedValue({ granted: true });
    mockMeeting.mockReturnValue(state({ mutedByRoom: true, toggleMute }));
    render(<MeetingSignalsProvider><Asker /></MeetingSignalsProvider>);
    await act(async () => { screen.getByText('ask').click(); });
    expect(requestToSpeak).toHaveBeenCalledWith('meeting-conv');
    expect(holdMute).toHaveBeenCalledWith(false);
    expect(toggleMute).toHaveBeenCalledTimes(1);
    expect(sendData).not.toHaveBeenCalled();
    expect(text('pending')).toBe('false');
  });

  it('a person a host holds is not granted: the hosts are told, the request waits, and a host\'s allow ends it', async () => {
    requestToSpeak.mockResolvedValue({ granted: false });
    mockMeeting.mockReturnValue(state({ mutedByHost: true, toggleMute }));
    render(<MeetingSignalsProvider><Asker /></MeetingSignalsProvider>);
    await act(async () => { screen.getByText('ask').click(); });
    expect(holdMute).not.toHaveBeenCalled();
    expect(toggleMute).not.toHaveBeenCalled();
    expect(sendData).toHaveBeenCalledWith(HOST_CONTROL_TOPIC, JSON.stringify({ action: 'ask', personId: 'me' }), CONTROL_LIFETIME_MS);
    expect(text('pending')).toBe('true');
    await deliver(message('host', { action: 'allow', personId: 'me' }));
    expect(holdMute).toHaveBeenLastCalledWith(false);
    expect(text('pending')).toBe('false');
  });

  it('a host sees who asks, from the join\'s answer and from an ask, and an answer clears it', async () => {
    setSpeaking.mockResolvedValue(['bo']);
    mockMeeting.mockReturnValue(state({ isHost: true, hostIds: ['host', 'me'], speakRequests: ['cy'] }));
    render(<MeetingSignalsProvider><Asker /></MeetingSignalsProvider>);
    expect(text('asking')).toBe('cy');
    await deliver(message('bo', { action: 'ask', personId: 'bo' }));
    expect(text('asking')).toBe('bo,cy');
    await act(async () => { screen.getByText('dismiss-bo').click(); });
    expect(setSpeaking).toHaveBeenCalledWith('meeting-conv', 'bo', false);
    expect(text('asking')).toBe('cy');
    await deliver(message('host', { action: 'allow', personId: 'cy' }));
    expect(text('asking')).toBe('');
  });
});
