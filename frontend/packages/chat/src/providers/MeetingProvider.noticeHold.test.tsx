/**
 * MeetingProvider - the microphone while a spoken notice plays (`announce`, `createNoticeMicHold`): the session's
 * microphone is muted for the notice and the person is shown that it is; a mute they press meanwhile is what the
 * microphone returns to; and a session brought up while a notice plays is held too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
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
  const release = useRef<(() => void) | null>(null);
  return (
    <div>
      <span data-testid="status">{m.status}</span>
      <span data-testid="muted">{String(m.muted)}</span>
      <span data-testid="notice">{String(m.mutedForNotice)}</span>
      <button onClick={() => { void m.join(CHANNEL); }}>join</button>
      <button onClick={() => m.toggleMute()}>mic</button>
      <button onClick={() => { release.current = m.holdMicForNotice(); }}>notice</button>
      <button onClick={() => { release.current?.(); }}>notice-ends</button>
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

describe('the microphone while a spoken notice plays', () => {
  it('is muted for the notice, shown as held, and opened again when it ends', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    calls = [];
    await click('notice');
    expect(calls).toEqual(['mute']);
    expect(text('notice')).toBe('true');
    // The person's own mute is unchanged: the hold is the notice's.
    expect(text('muted')).toBe('false');
    await click('notice-ends');
    expect(calls).toEqual(['mute', 'unmute']);
    expect(text('notice')).toBe('false');
  });

  it('honors a mute pressed while the notice plays: the microphone stays muted when it ends', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    await click('notice');
    await click('mic');
    expect(text('muted')).toBe('true');
    calls = [];
    await click('notice-ends');
    expect(calls).not.toContain('unmute');
    expect(text('muted')).toBe('true');
    expect(text('notice')).toBe('false');
  });

  it('keeps an unmute pressed while the notice plays for when it ends', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    await click('mic');
    await click('notice');
    calls = [];
    await click('mic');
    expect(text('muted')).toBe('false');
    expect(calls).not.toContain('unmute');
    await click('notice-ends');
    expect(calls).toEqual(['unmute']);
  });

  it('holds a session brought up while a notice plays, and gives that session back when it ends', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('notice');
    // Not in a meeting yet: nothing is shown as held.
    expect(text('notice')).toBe('false');
    await click('join');
    expect(calls).toContain('mute');
    expect(calls).not.toContain('unmute');
    expect(text('notice')).toBe('true');
    calls = [];
    await click('notice-ends');
    expect(calls).toEqual(['unmute']);
    expect(text('notice')).toBe('false');
  });

  it('ends cleanly when the person leaves while a notice plays', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    await click('notice');
    await click('leave');
    expect(text('notice')).toBe('false');
    calls = [];
    await click('notice-ends');
    expect(calls).toEqual([]);
  });
});
