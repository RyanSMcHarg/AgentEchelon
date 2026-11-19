/**
 * MeetingDevices - the check before joining and the device menu (SPEC-ASSISTANT-MEETINGS FR60).
 * Uses the real locale file, so a missing key fails here rather than rendering a key on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';
import { MeetingDeviceMenu, MeetingPreJoin } from './MeetingDevices';
import { readDeviceChoices, requestMediaAccess, pickDevice } from '../../services/meetingDevices';

const mockMeeting = vi.fn();
vi.mock('../../providers/MeetingProvider', () => ({ useMeeting: () => mockMeeting() }));

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: '', toJSON: () => ({}) });
let listed: ReturnType<typeof device>[] = [];
let getUserMedia = vi.fn();
let deviceChange: (() => void) | null = null;
const track = () => ({ stop: vi.fn() });

function installMedia() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: (c: MediaStreamConstraints) => getUserMedia(c),
      enumerateDevices: () => Promise.resolve(listed),
      addEventListener: (_n: string, cb: () => void) => { deviceChange = cb; },
      removeEventListener: () => { deviceChange = null; },
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  listed = [
    device('audioinput', 'default', 'Default - Built-in Microphone'),
    device('audioinput', 'usb-mic', 'USB Microphone'),
    device('videoinput', 'cam-1', 'FaceTime HD Camera'),
  ];
  getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [track()] }));
  installMedia();
  mockMeeting.mockReturnValue({ status: 'idle', cameraOn: false, deviceIds: {}, chooseDevice: vi.fn(() => Promise.resolve()) });
});

afterEach(() => {
  // jsdom offers no media devices; the next file starts from that.
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
});

describe('the check before joining', () => {
  it('lists the microphones by name once access is granted, and remembers the one chosen', async () => {
    const onReady = vi.fn();
    render(<MeetingPreJoin onReady={onReady} />);
    const mic = await screen.findByLabelText(en.meeting.devices.microphone);
    await waitFor(() => expect(mic).not.toBeDisabled());
    expect(screen.getByRole('option', { name: 'USB Microphone' })).toBeInTheDocument();
    fireEvent.change(mic, { target: { value: 'usb-mic' } });
    expect(readDeviceChoices().audioinput).toBe('usb-mic');
    expect(onReady).toHaveBeenLastCalledWith(true);
  });

  it('remembers joining muted and with the camera off', async () => {
    render(<MeetingPreJoin />);
    fireEvent.click(screen.getByLabelText(en.meeting.devices.joinMuted));
    fireEvent.click(screen.getByLabelText(en.meeting.devices.joinVideoOff));
    expect(readDeviceChoices()).toMatchObject({ joinMuted: true, cameraOff: true });
  });

  it('shows the guidance when the browser refuses access, and the person may still join', async () => {
    getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })));
    const onReady = vi.fn();
    render(<MeetingPreJoin onReady={onReady} />);
    expect(await screen.findByText(en.meeting.devices.permissionDenied)).toBeInTheDocument();
    expect(screen.getByText(en.meeting.devices.permissionInstructions)).toBeInTheDocument();
    expect(screen.getByText(en.meeting.devices.noCameraAccess)).toBeInTheDocument();
    expect(onReady).toHaveBeenLastCalledWith(true);
  });

  it('says no device was found, rather than offering an empty list', async () => {
    listed = [];
    render(<MeetingPreJoin />);
    expect(await screen.findByText(en.meeting.devices.noMicrophone)).toBeInTheDocument();
    expect(screen.getByText(en.meeting.devices.noCamera)).toBeInTheDocument();
  });

  it('follows a device plugged in while the check is open', async () => {
    render(<MeetingPreJoin />);
    await screen.findByRole('option', { name: 'USB Microphone' });
    listed = [...listed, device('audioinput', 'headset', 'Headset Microphone')];
    await act(async () => { deviceChange?.(); });
    expect(await screen.findByRole('option', { name: 'Headset Microphone' })).toBeInTheDocument();
  });
});

describe('the device menu in the meeting', () => {
  it('switches the microphone through the meeting', async () => {
    const chooseDevice = vi.fn(() => Promise.resolve());
    mockMeeting.mockReturnValue({ status: 'joined', cameraOn: false, deviceIds: { audioinput: 'default' }, chooseDevice });
    render(<MeetingDeviceMenu />);
    fireEvent.click(screen.getByRole('button', { name: en.meeting.devices.title }));
    const mic = await screen.findByLabelText(en.meeting.devices.microphone);
    await screen.findByRole('option', { name: 'USB Microphone' });
    fireEvent.change(mic, { target: { value: 'usb-mic' } });
    expect(chooseDevice).toHaveBeenCalledWith('audioinput', 'usb-mic');
  });
});

describe('asking the browser and picking a device', () => {
  it('asks for the microphone alone where there is no camera', async () => {
    getUserMedia = vi.fn((c: MediaStreamConstraints) => (c.video
      ? Promise.reject(Object.assign(new Error('none'), { name: 'NotFoundError' }))
      : Promise.resolve({ getTracks: () => [track()] })));
    expect(await requestMediaAccess()).toBe('granted');
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('is denied where the browser offers no media at all', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    expect(await requestMediaAccess()).toBe('denied');
  });

  it('picks the chosen device, else the default, else the first', () => {
    const list = [{ deviceId: 'a' }, { deviceId: 'default' }, { deviceId: 'b' }];
    expect(pickDevice(list, 'b')).toBe('b');
    expect(pickDevice(list, 'gone')).toBe('default');
    expect(pickDevice([{ deviceId: 'a' }], 'gone')).toBe('a');
    expect(pickDevice([], 'a')).toBeUndefined();
  });

  it('reads no choices where storage refuses', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readDeviceChoices()).toEqual({});
    spy.mockRestore();
  });
});
