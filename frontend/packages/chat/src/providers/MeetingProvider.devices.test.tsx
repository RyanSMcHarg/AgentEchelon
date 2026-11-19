/**
 * MeetingProvider - the person's devices (SPEC-ASSISTANT-MEETINGS FR60).
 *
 * The devices chosen before joining are the ones the meeting opens; a device chosen mid-meeting is switched to at once;
 * a device unplugged gives way to the default; and the pre-join's "join muted" choice only adds to the server's
 * `startMuted` (FR51), which no choice made before joining lifts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act } from '@testing-library/react';
import type { AudioVideoObserver } from 'amazon-chime-sdk-js';
import '@ae/shared/i18n';
import { MeetingProvider, useMeeting } from './MeetingProvider';
import { saveDeviceChoices } from '../services/meetingDevices';

let observers: AudioVideoObserver[] = [];
let deviceChangeObservers: Array<Record<string, (...a: unknown[]) => void>> = [];
let mics: Array<{ deviceId: string; label: string }> = [];
let cams: Array<{ deviceId: string; label: string }> = [];
let outputs: Array<{ deviceId: string; label: string }> = [];
const startAudioInput = vi.fn((_id: string | null) => Promise.resolve());
const startVideoInput = vi.fn((_id: string) => Promise.resolve());
const chooseAudioOutput = vi.fn((_id: string | null) => Promise.resolve());
const startLocalVideoTile = vi.fn();
let muteCalls: boolean[] = [];

vi.mock('amazon-chime-sdk-js', () => {
  class ConsoleLogger { constructor(_n?: string, _l?: number) {} }
  class DefaultDeviceController { constructor(_l?: unknown) {} destroy() { return Promise.resolve(); } }
  class DefaultActiveSpeakerPolicy {}
  class VideoPriorityBasedPolicy { chooseRemoteVideoSources() {} }
  class MeetingSessionConfiguration { constructor(_m: unknown, _a: unknown) {} }
  class DefaultMeetingSession {
    eventController = { addObserver: () => undefined, removeObserver: () => undefined };
    audioVideo = {
      addObserver: (o: AudioVideoObserver) => { observers.push(o); },
      removeObserver: (o: AudioVideoObserver) => { observers = observers.filter((x) => x !== o); },
      start: () => { observers[observers.length - 1]?.audioVideoDidStart?.(); },
      stop: vi.fn(),
      bindVideoElement: vi.fn(),
      stopLocalVideoTile: vi.fn(),
      startLocalVideoTile: () => startLocalVideoTile(),
      stopContentShare: vi.fn(),
      listAudioInputDevices: () => Promise.resolve(mics),
      listVideoInputDevices: () => Promise.resolve(cams),
      listAudioOutputDevices: () => Promise.resolve(outputs),
      startAudioInput: (id: string | null) => startAudioInput(id),
      startVideoInput: (id: string) => startVideoInput(id),
      chooseAudioOutput: (id: string | null) => chooseAudioOutput(id),
      stopAudioInput: () => Promise.resolve(),
      stopVideoInput: () => Promise.resolve(),
      bindAudioElement: () => Promise.resolve(),
      realtimeMuteLocalAudio: () => { muteCalls.push(true); },
      realtimeUnmuteLocalAudio: () => { muteCalls.push(false); },
      realtimeSetCanUnmuteLocalAudio: vi.fn(),
      realtimeSubscribeToMuteAndUnmuteLocalAudio: vi.fn(),
      realtimeUnsubscribeToMuteAndUnmuteLocalAudio: vi.fn(),
      addDeviceChangeObserver: (o: Record<string, (...a: unknown[]) => void>) => { deviceChangeObservers.push(o); },
      removeDeviceChangeObserver: (o: unknown) => { deviceChangeObservers = deviceChangeObservers.filter((x) => x !== o); },
      addContentShareObserver: vi.fn(),
      removeContentShareObserver: vi.fn(),
      realtimeSubscribeToAttendeeIdPresence: vi.fn(),
      realtimeUnsubscribeToAttendeeIdPresence: vi.fn(),
      realtimeSubscribeToVolumeIndicator: vi.fn(),
      realtimeUnsubscribeFromVolumeIndicator: vi.fn(),
      subscribeToActiveSpeakerDetector: vi.fn(),
      unsubscribeFromActiveSpeakerDetector: vi.fn(),
    };
  }
  return {
    ConsoleLogger,
    DefaultActiveSpeakerPolicy,
    VideoPriorityBasedPolicy,
    DefaultDeviceController,
    DefaultMeetingSession,
    MeetingSessionConfiguration,
    MeetingSessionStatusCode: { Left: 1, AudioJoinedFromAnotherDevice: 2, AudioCallAtCapacity: 4, MeetingEnded: 5, VideoCallAtSourceCapacity: 10, AudioAttendeeRemoved: 22 },
    LogLevel: { WARN: 2 },
  };
});

const startMeeting = vi.fn();
vi.mock('../services/meetingService', () => ({
  meetingService: {
    startMeeting: (a: string) => startMeeting(a),
    joinMeeting: (a: string) => startMeeting(a),
    endMeeting: () => Promise.resolve(),
    reportEvents: () => Promise.resolve(),
    reportTranscript: () => Promise.resolve(),
  },
  isMeetingEnabled: () => true,
}));
vi.mock('../services/chimeService', () => ({ chimeService: { sendRing: () => Promise.resolve() } }));
vi.mock('./meetingKeepalive', () => ({ startKeepalive: () => Promise.resolve({ stop: vi.fn(), resume: vi.fn() }) }));

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const JOIN_INFO = {
  meeting: { MeetingId: 'm-1', MediaPlacement: {} },
  attendee: { AttendeeId: 'a-1', ExternalUserId: 'alice', JoinToken: 'tok' },
  classification: 'premium',
  startedAt: '2026-10-01T00:00:00.000Z',
};

/** The provider's value as last rendered, for a test to call. */
const live: { current: ReturnType<typeof useMeeting> | null } = { current: null };
function Probe() {
  const m = useMeeting();
  useEffect(() => { live.current = m; });
  return (
    <div>
      <span data-testid="status">{m.status}</span>
      <span data-testid="muted">{String(m.muted)}</span>
      <span data-testid="camera">{String(m.cameraOn)}</span>
      <span data-testid="mic">{m.deviceIds.audioinput ?? ''}</span>
    </div>
  );
}

async function startAMeeting() {
  render(<MeetingProvider><Probe /></MeetingProvider>);
  await act(async () => { await live.current!.start(CHANNEL); });
  expect(screen.getByTestId('status').textContent).toBe('joined');
}

/** The SDK's device observers run on its own tick; this lets them and what they start settle. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  localStorage.clear();
  observers = [];
  deviceChangeObservers = [];
  muteCalls = [];
  mics = [{ deviceId: 'default', label: 'Default - Built-in Microphone' }, { deviceId: 'usb-mic', label: 'USB Microphone' }];
  cams = [{ deviceId: 'cam-built-in', label: 'FaceTime HD Camera' }, { deviceId: 'cam-usb', label: 'USB Camera' }];
  outputs = [{ deviceId: 'default', label: 'Default - Speakers' }, { deviceId: 'headset', label: 'Headset' }];
  startAudioInput.mockReset().mockResolvedValue(undefined);
  startVideoInput.mockReset().mockResolvedValue(undefined);
  chooseAudioOutput.mockReset().mockResolvedValue(undefined);
  startLocalVideoTile.mockReset();
  startMeeting.mockReset().mockResolvedValue(JOIN_INFO);
});

describe('the devices chosen before joining are the ones the meeting opens', () => {
  it('opens the chosen microphone, speaker and camera', async () => {
    saveDeviceChoices({ audioinput: 'usb-mic', audiooutput: 'headset', videoinput: 'cam-usb' });
    await startAMeeting();
    expect(startAudioInput).toHaveBeenCalledWith('usb-mic');
    expect(startAudioInput).not.toHaveBeenCalledWith('default');
    expect(chooseAudioOutput).toHaveBeenCalledWith('headset');
    await settle();
    expect(startVideoInput).toHaveBeenCalledWith('cam-usb');
    expect(startLocalVideoTile).toHaveBeenCalled();
    expect(screen.getByTestId('camera').textContent).toBe('true');
    expect(screen.getByTestId('mic').textContent).toBe('usb-mic');
  });

  it('opens the default where the chosen device is not plugged in', async () => {
    saveDeviceChoices({ audioinput: 'gone-mic' });
    await startAMeeting();
    expect(startAudioInput).toHaveBeenCalledWith('default');
  });

  it('joins with the camera off where the person chose it off', async () => {
    saveDeviceChoices({ cameraOff: true });
    await startAMeeting();
    await settle();
    expect(startVideoInput).not.toHaveBeenCalled();
    expect(screen.getByTestId('camera').textContent).toBe('false');
  });
});

describe('a device changed mid-meeting', () => {
  it('switches the microphone at once and remembers it for the next meeting', async () => {
    await startAMeeting();
    startAudioInput.mockClear();
    await act(async () => { await live.current!.chooseDevice('audioinput', 'usb-mic'); });
    expect(startAudioInput).toHaveBeenCalledWith('usb-mic');
    expect(screen.getByTestId('mic').textContent).toBe('usb-mic');
    expect(JSON.parse(localStorage.getItem('ae.meeting.devices') ?? '{}').audioinput).toBe('usb-mic');
  });

  it('keeps a muted person muted on the new microphone', async () => {
    saveDeviceChoices({ joinMuted: true });
    await startAMeeting();
    muteCalls = [];
    await act(async () => { await live.current!.chooseDevice('audioinput', 'usb-mic'); });
    expect(muteCalls).toEqual([true]);
    expect(screen.getByTestId('muted').textContent).toBe('true');
  });
});

describe('a device unplugged', () => {
  it('falls back to the default microphone when the one in use leaves the list', async () => {
    saveDeviceChoices({ audioinput: 'usb-mic' });
    await startAMeeting();
    startAudioInput.mockClear();
    mics = [{ deviceId: 'default', label: 'Default - Built-in Microphone' }];
    await act(async () => { deviceChangeObservers[0].audioInputsChanged?.(mics); });
    await settle();
    expect(startAudioInput).toHaveBeenCalledWith('default');
    expect(screen.getByTestId('mic').textContent).toBe('default');
  });

  it('goes back to the chosen microphone once it is plugged in again', async () => {
    saveDeviceChoices({ audioinput: 'usb-mic' });
    mics = [{ deviceId: 'default', label: 'Default' }];
    await startAMeeting();
    expect(startAudioInput).toHaveBeenCalledWith('default');
    mics = [{ deviceId: 'default', label: 'Default' }, { deviceId: 'usb-mic', label: 'USB Microphone' }];
    await act(async () => { deviceChangeObservers[0].audioInputsChanged?.(mics); });
    await settle();
    expect(startAudioInput).toHaveBeenLastCalledWith('usb-mic');
  });

  it('opens the default when the microphone stream ends', async () => {
    saveDeviceChoices({ audioinput: 'usb-mic' });
    await startAMeeting();
    startAudioInput.mockClear();
    mics = [{ deviceId: 'default', label: 'Default' }];
    await act(async () => { deviceChangeObservers[0].audioInputStreamEnded?.('usb-mic'); });
    await settle();
    expect(startAudioInput).toHaveBeenCalledWith('default');
  });

  it('turns the camera off when the last camera is unplugged', async () => {
    await startAMeeting();
    await settle();
    expect(screen.getByTestId('camera').textContent).toBe('true');
    cams = [];
    await act(async () => { deviceChangeObservers[0].videoInputsChanged?.(cams); });
    await settle();
    expect(screen.getByTestId('camera').textContent).toBe('false');
  });

  it('switches the speaker back to the default when the chosen one goes', async () => {
    saveDeviceChoices({ audiooutput: 'headset' });
    await startAMeeting();
    outputs = [{ deviceId: 'default', label: 'Default - Speakers' }];
    await act(async () => { deviceChangeObservers[0].audioOutputsChanged?.(outputs); });
    await settle();
    expect(chooseAudioOutput).toHaveBeenLastCalledWith('default');
  });
});

describe('joining muted (FR51)', () => {
  it('keeps a server startMuted whatever the pre-join chose', async () => {
    saveDeviceChoices({ joinMuted: false });
    startMeeting.mockReset().mockResolvedValue({ ...JOIN_INFO, startMuted: true });
    await startAMeeting();
    expect(screen.getByTestId('muted').textContent).toBe('true');
    expect(muteCalls.length).toBeGreaterThan(0);
    expect(muteCalls.every((m) => m)).toBe(true);
  });

  it('joins muted where the person chose it and the server did not', async () => {
    saveDeviceChoices({ joinMuted: true });
    await startAMeeting();
    expect(screen.getByTestId('muted').textContent).toBe('true');
    expect(muteCalls).toContain(true);
  });

  it('joins unmuted where neither asked for muting', async () => {
    await startAMeeting();
    expect(screen.getByTestId('muted').textContent).toBe('false');
    expect(muteCalls).toEqual([]);
  });
});
