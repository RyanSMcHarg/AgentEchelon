/**
 * MeetingProvider - what a host's controls do to the person they act on (SPEC-ASSISTANT-MEETINGS FR59), and the active
 * speaker the SDK's detector names.
 *
 *  - A HELD MICROPHONE STAYS MUTED: the session is told it cannot unmute, the person's own unmute does nothing, and a
 *    host letting them speak leaves the microphone muted, so restoring the service's capability never opens it.
 *  - A join whose answer says a host stopped the person's audio enters held, before the session connects.
 *  - The active speaker follows the detector's callback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { AudioVideoObserver } from 'amazon-chime-sdk-js';
import '@ae/shared/i18n';
import { MeetingProvider, useMeeting } from './MeetingProvider';

let observers: AudioVideoObserver[] = [];
let calls: string[] = [];
let canUnmute = true;
let speakerCallbacks: Array<(ids: string[]) => void> = [];

vi.mock('amazon-chime-sdk-js', () => {
  class ConsoleLogger { constructor(_n?: string, _l?: number) {} }
  class DefaultDeviceController { constructor(_l?: unknown) {} destroy() { return Promise.resolve(); } }
  class DefaultActiveSpeakerPolicy {}
  class VideoPriorityBasedPolicy { chooseRemoteVideoSources() {} }
  class MeetingSessionConfiguration { constructor(_m: unknown, _a: unknown) {} }
  class DefaultMeetingSession {
    eventController = { addObserver: () => undefined, removeObserver: () => undefined };
    audioVideo: Record<string, unknown> = {
      addObserver: (o: AudioVideoObserver) => { observers.push(o); },
      removeObserver: () => undefined,
      start: () => { observers[observers.length - 1]?.audioVideoDidStart?.(); },
      stop: vi.fn(), stopLocalVideoTile: vi.fn(), stopContentShare: vi.fn(), bindVideoElement: vi.fn(),
      listAudioInputDevices: () => Promise.resolve([]), listAudioOutputDevices: () => Promise.resolve([]), listVideoInputDevices: () => Promise.resolve([]),
      startAudioInput: () => Promise.resolve(), stopAudioInput: () => Promise.resolve(), stopVideoInput: () => Promise.resolve(),
      bindAudioElement: () => Promise.resolve(),
      realtimeSubscribeToMuteAndUnmuteLocalAudio: () => undefined, realtimeUnsubscribeToMuteAndUnmuteLocalAudio: () => undefined,
      addDeviceChangeObserver: () => undefined, removeDeviceChangeObserver: () => undefined,
      addContentShareObserver: () => undefined, removeContentShareObserver: () => undefined,
      realtimeMuteLocalAudio: () => { calls.push('mute'); },
      realtimeUnmuteLocalAudio: () => { calls.push('unmute'); return canUnmute; },
      realtimeSetCanUnmuteLocalAudio: (v: boolean) => { canUnmute = v; calls.push(`canUnmute:${v}`); },
      realtimeSubscribeToAttendeeIdPresence: () => undefined, realtimeUnsubscribeToAttendeeIdPresence: () => undefined,
      realtimeSubscribeToVolumeIndicator: () => undefined, realtimeUnsubscribeFromVolumeIndicator: () => undefined,
      subscribeToActiveSpeakerDetector: (_p: unknown, cb: (ids: string[]) => void) => { speakerCallbacks.push(cb); },
      unsubscribeFromActiveSpeakerDetector: (cb: unknown) => { speakerCallbacks = speakerCallbacks.filter((x) => x !== cb); },
      transcriptionController: { subscribeToTranscriptEvent: () => undefined, unsubscribeFromTranscriptEvent: () => undefined },
    };
    constructor(_c: unknown, _l: unknown, _d: unknown) {}
  }
  return {
    ConsoleLogger, DefaultActiveSpeakerPolicy, VideoPriorityBasedPolicy, DefaultDeviceController, DefaultMeetingSession, MeetingSessionConfiguration,
    MeetingSessionStatusCode: { Left: 1, MeetingEnded: 5, AudioAttendeeRemoved: 22 }, LogLevel: { WARN: 2 },
  };
});

const joinMeeting = vi.fn();
vi.mock('../services/meetingService', () => ({
  meetingService: { joinMeeting: (a: string) => joinMeeting(a), reportEvents: () => Promise.resolve() },
  isMeetingEnabled: () => true,
}));
vi.mock('../services/chimeService', () => ({ chimeService: { sendRing: () => Promise.resolve() } }));
vi.mock('./meetingKeepalive', () => ({ startKeepalive: () => Promise.resolve({ stop: vi.fn(), resume: vi.fn() }) }));

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const JOIN = {
  meeting: { MeetingId: 'm-1', MediaPlacement: {} }, attendee: { AttendeeId: 'a-1', ExternalUserId: 'alice', JoinToken: 't' },
  classification: 'premium', startedAt: '2026-11-12T00:00:00.000Z', removedIds: ['bo'],
};

function Probe() {
  const m = useMeeting();
  return (
    <div>
      <span data-testid="status">{m.status}</span>
      <span data-testid="muted">{String(m.muted)}</span>
      <span data-testid="held">{String(m.mutedByHost)}</span>
      <span data-testid="room">{String(m.mutedByRoom)}</span>
      <span data-testid="asks">{m.speakRequests.join(',')}</span>
      <span data-testid="removed">{m.removedIds.join(',')}</span>
      <span data-testid="speaker">{m.activeSpeaker ?? ''}</span>
      <button onClick={() => { void m.join(CHANNEL); }}>join</button>
      <button onClick={() => m.toggleMute()}>mic</button>
      <button onClick={() => m.holdMute(true)}>hold</button>
      <button onClick={() => m.holdMute(false)}>release</button>
      <button onClick={() => m.leave()}>leave</button>
    </div>
  );
}
const text = (id: string) => screen.getByTestId(id).textContent;
const click = (name: string) => act(async () => { screen.getByText(name).click(); });

beforeEach(() => {
  observers = [];
  calls = [];
  canUnmute = true;
  speakerCallbacks = [];
  joinMeeting.mockReset().mockResolvedValue(JOIN);
});

describe('a microphone a host holds', () => {
  it('is muted and cannot be unmuted by the person, and stays muted when a host lets them speak', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(text('status')).toBe('joined');
    expect(text('removed')).toBe('bo');
    await click('hold');
    expect(text('muted')).toBe('true');
    expect(text('held')).toBe('true');
    expect(calls).toContain('canUnmute:false');
    calls = [];
    await click('mic');
    expect(calls).not.toContain('unmute');
    expect(text('muted')).toBe('true');
    await click('release');
    expect(text('held')).toBe('false');
    expect(text('muted')).toBe('true');
    expect(calls).toEqual(['canUnmute:true']);
    // Released, the person unmutes themselves.
    await click('mic');
    expect(text('muted')).toBe('false');
  });

  it('a join the answer says a host muted enters held, before the session connects', async () => {
    joinMeeting.mockResolvedValue({ ...JOIN, mutedByHost: true });
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(text('held')).toBe('true');
    expect(text('muted')).toBe('true');
    // Muted and held before the session starts, and both applied again once it has connected.
    expect(calls.slice(0, 2)).toEqual(['mute', 'canUnmute:false']);
    expect(calls).toContain('canUnmute:false');
  });

  it('is forgotten when the person leaves', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    await click('hold');
    await click('leave');
    expect(text('held')).toBe('false');
    expect(text('removed')).toBe('');
  });
});

describe('the active speaker', () => {
  it('follows the detector\'s callback, most active first', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(speakerCallbacks).toHaveLength(1);
    await act(async () => { speakerCallbacks[0](['a-2', 'a-1']); });
    expect(text('speaker')).toBe('a-2');
    await act(async () => { speakerCallbacks[0](['a-1']); });
    expect(text('speaker')).toBe('a-1');
    await click('leave');
    expect(speakerCallbacks).toHaveLength(0);
  });
});

describe('a person the room muted on joining (FR51)', () => {
  it('a receive-only join enters held by the room: the microphone cannot be unmuted until the hold is released', async () => {
    joinMeeting.mockResolvedValue({ ...JOIN, startMuted: true, receiveOnly: true });
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(text('room')).toBe('true');
    expect(text('held')).toBe('false');
    expect(text('muted')).toBe('true');
    calls = [];
    await click('mic');
    expect(calls).not.toContain('unmute');
    expect(text('muted')).toBe('true');
    await click('release');
    expect(text('room')).toBe('false');
    await click('mic');
    expect(text('muted')).toBe('false');
  });

  it('a host joining is told who asks to speak', async () => {
    joinMeeting.mockResolvedValue({ ...JOIN, speakRequests: ['bo'] });
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(text('asks')).toBe('bo');
  });
});
