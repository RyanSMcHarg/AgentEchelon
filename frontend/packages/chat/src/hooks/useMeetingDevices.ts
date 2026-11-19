/**
 * useMeetingDevices: the person's microphones, speakers and cameras, and which of each they chose
 * (`services/meetingDevices.ts`), for the meeting's pre-join check and its device menu.
 *
 * BEFORE JOINING, the browser is asked once for the camera and microphone
 * so the devices are listed by name; a refusal is the denied state, which says how to allow them, and a machine with
 * nothing to open still joins. The list follows the browser's `devicechange` event, so a device plugged in shows up
 * and one unplugged goes, and a chosen device that is gone reads as the default until it is back.
 *
 * WITH `preview`, the chosen camera plays in a preview and the chosen microphone's level is measured, both released the
 * moment the preview ends (the meeting starts, the window closes), so the session opens the devices alone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pickDevice, readDeviceChoices, requestMediaAccess, saveDeviceChoices,
  type MediaAccess, type MeetingDeviceChoices, type MeetingDeviceKind,
} from '../services/meetingDevices';

export type MeetingDeviceLists = Record<MeetingDeviceKind, MediaDeviceInfo[]>;

const NONE: MeetingDeviceLists = { audioinput: [], audiooutput: [], videoinput: [] };

export interface MeetingDevices {
  access: MediaAccess;
  devices: MeetingDeviceLists;
  /** The device of each kind in use: the chosen one where it is plugged in, else the default. */
  selected: Record<MeetingDeviceKind, string | undefined>;
  choices: MeetingDeviceChoices;
  choose: (kind: MeetingDeviceKind, deviceId: string) => void;
  setJoinMuted: (on: boolean) => void;
  setCameraOff: (on: boolean) => void;
  /** The chosen camera's preview, while previewing with the camera on. */
  previewStream: MediaStream | null;
  /** The chosen microphone's level now, 0 to 1, while previewing. */
  level: number;
}

/** The browser's devices by kind. A device the browser lists without an id (before any permission) is left out. */
async function listDevices(): Promise<MeetingDeviceLists> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media?.enumerateDevices) return NONE;
  try {
    const all = await media.enumerateDevices();
    const of = (kind: MeetingDeviceKind) => all.filter((d) => d.kind === kind && d.deviceId);
    return { audioinput: of('audioinput'), audiooutput: of('audiooutput'), videoinput: of('videoinput') };
  } catch {
    return NONE;
  }
}

export function useMeetingDevices({ preview = false, active = true }: { preview?: boolean; active?: boolean } = {}): MeetingDevices {
  const hasMedia = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  // The pre-join asks; the in-meeting menu reads what the session already opened.
  const [access, setAccess] = useState<MediaAccess>(preview ? (hasMedia ? 'pending' : 'denied') : 'granted');
  const [devices, setDevices] = useState<MeetingDeviceLists>(NONE);
  const [choices, setChoices] = useState<MeetingDeviceChoices>(readDeviceChoices);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Asked once per pre-join, on opening it.
  useEffect(() => {
    if (!preview || !active || !hasMedia) return;
    let cancelled = false;
    void requestMediaAccess().then((a) => { if (!cancelled && mountedRef.current) setAccess(a); });
    return () => { cancelled = true; };
  }, [preview, active, hasMedia]);

  // THE DEVICES, listed again on the browser's own event whenever one is plugged in or out, and once access settles
  // (the browser names them only then).
  useEffect(() => {
    if (!active || access === 'pending') return;
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    const refresh = () => { void listDevices().then((d) => { if (mountedRef.current) setDevices(d); }); };
    refresh();
    media?.addEventListener?.('devicechange', refresh);
    return () => media?.removeEventListener?.('devicechange', refresh);
  }, [active, access]);

  const selected = {
    audioinput: pickDevice(devices.audioinput, choices.audioinput),
    audiooutput: pickDevice(devices.audiooutput, choices.audiooutput),
    videoinput: pickDevice(devices.videoinput, choices.videoinput),
  };

  const choose = useCallback((kind: MeetingDeviceKind, deviceId: string) => setChoices(saveDeviceChoices({ [kind]: deviceId })), []);
  const setJoinMuted = useCallback((on: boolean) => setChoices(saveDeviceChoices({ joinMuted: on })), []);
  const setCameraOff = useCallback((on: boolean) => setChoices(saveDeviceChoices({ cameraOff: on })), []);

  // THE CAMERA PREVIEW, of the chosen camera, while the camera is to be on.
  const camera = preview && active && access === 'granted' && !choices.cameraOff ? selected.videoinput : undefined;
  useEffect(() => {
    if (!camera) { setPreviewStream(null); return; }
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camera } } })
      .then((s) => {
        if (cancelled || !mountedRef.current) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        setPreviewStream(s);
      })
      .catch(() => { if (!cancelled && mountedRef.current) setPreviewStream(null); });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setPreviewStream(null);
    };
  }, [camera]);

  // THE MICROPHONE'S LEVEL, of the chosen microphone, measured each frame from its signal's loudness.
  const mic = preview && active && access === 'granted' ? selected.audioinput : undefined;
  useEffect(() => {
    if (!mic) { setLevel(0); return; }
    const Ctx: typeof AudioContext | undefined = typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
    if (!Ctx) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: mic } } })
      .then((s) => {
        if (cancelled || !mountedRef.current) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const v of samples) { const x = (v - 128) / 128; sum += x * x; }
          // Root mean square, scaled so ordinary speech fills most of the meter.
          setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
          frame = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => { if (!cancelled && mountedRef.current) setLevel(0); });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      setLevel(0);
    };
  }, [mic]);

  return { access, devices, selected, choices, choose, setJoinMuted, setCameraOff, previewStream, level };
}
