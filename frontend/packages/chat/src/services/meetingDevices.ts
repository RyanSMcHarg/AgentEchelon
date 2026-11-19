/**
 * THE PERSON'S MEETING DEVICES: the microphone,
 * speaker and camera they chose, and whether they join muted or with the camera off, remembered in this browser so the
 * next meeting starts from the same choices.
 *
 * A choice names a device by the id the browser gave it. A device that is not plugged in now is never used: the choice
 * falls back to the browser's default (`pickDevice`), and the remembered choice stays, so the device is used again once
 * it is back.
 *
 * Storage can be refused (a private window, a blocked site); every read and write is guarded, and a refused write keeps
 * the choice for this window only.
 */
import { isPermissionDenied } from './meetingConnectivity';

export type MeetingDeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

export interface MeetingDeviceChoices {
  audioinput?: string;
  audiooutput?: string;
  videoinput?: string;
  /** Join with the microphone muted. A server's `startMuted` mutes the person whatever this says. */
  joinMuted?: boolean;
  /** Join with the camera off. */
  cameraOff?: boolean;
}

const KEY = 'ae.meeting.devices';

/** The choices remembered in this browser; none where storage is refused or holds something unreadable. */
export function readDeviceChoices(): MeetingDeviceChoices {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: MeetingDeviceChoices = {};
    for (const k of ['audioinput', 'audiooutput', 'videoinput'] as const) {
      if (typeof parsed[k] === 'string') out[k] = parsed[k] as string;
    }
    if (typeof parsed.joinMuted === 'boolean') out.joinMuted = parsed.joinMuted;
    if (typeof parsed.cameraOff === 'boolean') out.cameraOff = parsed.cameraOff;
    return out;
  } catch {
    return {};
  }
}

/** Remember a change to the choices, returning them all. */
export function saveDeviceChoices(patch: Partial<MeetingDeviceChoices>): MeetingDeviceChoices {
  const next = { ...readDeviceChoices(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* the choice lasts this window only */ }
  return next;
}

/**
 * The device to use from those plugged in now: the preferred one when it is among them, else the browser's default
 * (`default`, where the browser lists one), else the first. Undefined when there is none.
 */
export function pickDevice(list: ReadonlyArray<{ deviceId: string }>, preferred?: string | null): string | undefined {
  if (!list.length) return undefined;
  if (preferred && list.some((d) => d.deviceId === preferred)) return preferred;
  return (list.find((d) => d.deviceId === 'default') ?? list[0]).deviceId;
}

/**
 * WHAT THE BROWSER ALLOWS, as the pre-join asks it: `granted` once a camera or microphone may be opened (or there
 * is none to open, which still joins), `denied` where the person or the browser refused, or the browser offers no media
 * at all.
 */
export type MediaAccess = 'pending' | 'granted' | 'denied';

/**
 * Ask for the camera and microphone once, so the browser lists the devices by name, and release them again at once.
 * A machine without a camera is asked for its microphone alone (and one without a microphone for its camera), so the
 * device it has still gets its name.
 */
export async function requestMediaAccess(): Promise<Exclude<MediaAccess, 'pending'>> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media?.getUserMedia) return 'denied';
  const attempts: MediaStreamConstraints[] = [{ audio: true, video: true }, { audio: true }, { video: true }];
  for (const constraints of attempts) {
    try {
      const stream = await media.getUserMedia(constraints);
      stream.getTracks().forEach((track) => track.stop());
      return 'granted';
    } catch (e) {
      if (isPermissionDenied(e)) return 'denied';
      // No such device, or one busy elsewhere: the next, narrower request is tried, and a person with nothing to open
      // still joins to watch and listen.
    }
  }
  return 'granted';
}
