/**
 * THE MEETING'S DEVICES (SPEC-ASSISTANT-MEETINGS FR60): the check before joining, and the device menu in the meeting.
 *
 * `MeetingPreJoin` is the check before joining: the camera preview, the microphone's live level, the microphone, speaker
 * and camera to use, and whether to join muted or with the camera off. It asks the browser once on opening; a refusal
 * says how to allow access, and the person may still join to watch and listen. Its choices are remembered in this
 * browser (`services/meetingDevices.ts`) and the meeting opens the same devices (`MeetingProvider`). A server that has
 * the person join muted (FR51) mutes them whatever they chose here.
 *
 * `MeetingDeviceMenu` changes the microphone, speaker or camera during the meeting.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMeeting } from '../../providers/MeetingProvider';
import { useMeetingDevices, type MeetingDevices } from '../../hooks/useMeetingDevices';
import type { MeetingDeviceKind } from '../../services/meetingDevices';
import './MeetingDevices.css';
import { IconGear } from './meetingIcons';

/** The browser can send meeting audio to a chosen speaker. Where it cannot, the speaker is the system's own. */
const canChooseSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const LABELS: Record<MeetingDeviceKind, { label: string; unnamed: string; none: string }> = {
  audioinput: { label: 'meeting.devices.microphone', unnamed: 'meeting.devices.unnamedMicrophone', none: 'meeting.devices.noMicrophone' },
  audiooutput: { label: 'meeting.devices.speaker', unnamed: 'meeting.devices.unnamedSpeaker', none: 'meeting.devices.noSpeaker' },
  videoinput: { label: 'meeting.devices.camera', unnamed: 'meeting.devices.unnamedCamera', none: 'meeting.devices.noCamera' },
};

function DeviceSelect({ kind, devices, value, onChoose }: {
  kind: MeetingDeviceKind;
  devices: MeetingDevices;
  value: string | undefined;
  onChoose: (kind: MeetingDeviceKind, deviceId: string) => void;
}) {
  const { t } = useTranslation();
  const keys = LABELS[kind];
  const list = devices.devices[kind];
  const id = `ae-meeting-device-${kind}`;
  return (
    <div className="ae-meeting-device-row">
      <label htmlFor={id}>{t(keys.label)}</label>
      {devices.access !== 'granted' ? (
        <select id={id} disabled>
          <option>{t(devices.access === 'pending' ? 'meeting.devices.loading' : 'meeting.devices.noAccess')}</option>
        </select>
      ) : list.length === 0 ? (
        <select id={id} disabled><option>{t(keys.none)}</option></select>
      ) : (
        <select id={id} value={value ?? ''} onChange={(e) => onChoose(kind, e.target.value)}>
          {list.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || t(keys.unnamed, { n: i + 1 })}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** The level meter: how loud the chosen microphone is now. */
function MicLevel({ level }: { level: number }) {
  const { t } = useTranslation();
  const pct = Math.round(level * 100);
  return (
    <div className="ae-meeting-level" role="meter" aria-label={t('meeting.devices.level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="ae-meeting-level-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function MeetingPreJoin({ onReady }: { onReady?: (ready: boolean) => void }) {
  const { t } = useTranslation();
  const meeting = useMeeting();
  // THE PREVIEW ENDS AS THE JOIN BEGINS, so the meeting's session is the only thing holding the camera and microphone.
  const previewing = meeting.status === 'idle' || meeting.status === 'error';
  const devices = useMeetingDevices({ preview: true, active: previewing });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => { onReady?.(devices.access !== 'pending'); }, [devices.access, onReady]);
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.srcObject = devices.previewStream;
  }, [devices.previewStream]);

  const denied = devices.access === 'denied';
  const cameraOff = !!devices.choices.cameraOff;
  return (
    <div className="ae-meeting-devices" data-testid="meeting-prejoin-devices">
      {denied && (
        <div className="ae-meeting-permission" aria-live="polite" data-testid="meeting-permission-denied">
          <strong>{t('meeting.devices.permissionDenied')}</strong>
          <p>{t('meeting.devices.permissionInstructions')}</p>
          <p>{t('meeting.devices.joinWithoutDevices')}</p>
        </div>
      )}
      <div className="ae-meeting-devices-layout">
        <div className="ae-meeting-preview">
          {devices.previewStream && !cameraOff ? (
            <video ref={videoRef} autoPlay playsInline muted data-testid="meeting-preview-video" />
          ) : (
            <p className="ae-meeting-preview-off">
              {t(devices.access === 'pending' ? 'meeting.devices.checking'
                : denied ? 'meeting.devices.noCameraAccess' : 'meeting.devices.cameraOff')}
            </p>
          )}
        </div>
        <div className="ae-meeting-device-settings">
          <DeviceSelect kind="audioinput" devices={devices} value={devices.selected.audioinput} onChoose={devices.choose} />
          {devices.access === 'granted' && devices.devices.audioinput.length > 0 && <MicLevel level={devices.level} />}
          {canChooseSpeaker && <DeviceSelect kind="audiooutput" devices={devices} value={devices.selected.audiooutput} onChoose={devices.choose} />}
          <DeviceSelect kind="videoinput" devices={devices} value={devices.selected.videoinput} onChoose={devices.choose} />
          <label className="ae-meeting-option">
            <input type="checkbox" checked={cameraOff} onChange={(e) => devices.setCameraOff(e.target.checked)} />
            <span>{t('meeting.devices.joinVideoOff')}</span>
          </label>
          <label className="ae-meeting-option">
            <input type="checkbox" checked={!!devices.choices.joinMuted} onChange={(e) => devices.setJoinMuted(e.target.checked)} />
            <span>{t('meeting.devices.joinMuted')}</span>
          </label>
        </div>
      </div>
    </div>
  );
}

/**
 * The device menu in the meeting's video area: a gear at its lower right, as the sibling project's meeting settings are
 * reached, opening another microphone, speaker or camera, switched at once.
 */
export function MeetingDeviceMenu() {
  const { t } = useTranslation();
  const meeting = useMeeting();
  const [open, setOpen] = useState(false);
  const devices = useMeetingDevices({ active: open });
  const choose = (kind: MeetingDeviceKind, deviceId: string) => {
    devices.choose(kind, deviceId);
    void meeting.chooseDevice(kind, deviceId);
  };
  // The device in use, as the session holds it; a camera that is off shows the one it will open.
  const valueOf = (kind: MeetingDeviceKind) => (kind === 'videoinput' && !meeting.cameraOn
    ? devices.selected.videoinput
    : meeting.deviceIds[kind] ?? devices.selected[kind]);
  return (
    <div className="ae-meeting-device-menu">
      <button
        type="button"
        className={`ae-mc-btn ae-mc-btn--icon ae-mc-btn--overlay${open ? ' ae-mc-btn--on' : ''}`}
        aria-expanded={open}
        aria-label={t('meeting.devices.title')}
        title={t('meeting.devices.title')}
        onClick={() => setOpen((o) => !o)}
        data-testid="meeting-device-menu"
      >
        <IconGear />
      </button>
      {open && (
        <div className="ae-meeting-device-popover" role="group" aria-label={t('meeting.devices.title')}>
          <DeviceSelect kind="audioinput" devices={devices} value={valueOf('audioinput')} onChoose={choose} />
          {canChooseSpeaker && <DeviceSelect kind="audiooutput" devices={devices} value={valueOf('audiooutput')} onChoose={choose} />}
          <DeviceSelect kind="videoinput" devices={devices} value={valueOf('videoinput')} onChoose={choose} />
        </div>
      )}
    </div>
  );
}
