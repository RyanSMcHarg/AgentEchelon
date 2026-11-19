/**
 * A PERSON'S AUDIO AT A GLANCE, the same on the roster and on their tile (SPEC-ASSISTANT-MEETINGS FR54):
 *  - a struck microphone while they are muted, worded "muted by host" when a host stopped their audio;
 *  - a red microphone while the network loses much of their audio (the SDK's signal strength under one half,
 *    `meetingSignals.tsx`), with a hint saying so.
 * The two are separate signs: a person can be muted on a poor network, and each says its own thing.
 *
 * And what else they are doing, as icons rather than words, all drawn alike: a microphone while their microphone is on,
 * which flickers while they speak, a camera while their camera is on, a screen while they share.
 */
import { useTranslation } from 'react-i18next';
import './MeetingIndicators.css';

const Mic = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const StruckMic = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const Camera = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M23 7l-7 5 7 5V7z" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);

const Screen = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

/** What a person in the meeting is doing: microphone on (flickering while they speak), camera on, sharing, each an icon. */
export function ActivityIndicators({ micOn, speaking, camera, sharing }: { micOn?: boolean; speaking?: boolean; camera?: boolean; sharing?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {(micOn || speaking) && (
        <span
          className={`ae-meeting-mic ae-meeting-activity${speaking ? ' ae-meeting-mic--speaking' : ''}`}
          role="img"
          aria-label={t(speaking ? 'meeting.roster.speaking' : 'meeting.roster.micOn')}
          title={t(speaking ? 'meeting.roster.speaking' : 'meeting.roster.micOn')}
          data-testid={speaking ? 'mic-speaking' : 'mic-on'}
        >
          <Mic />
        </span>
      )}
      {camera && (
        <span className="ae-meeting-mic ae-meeting-activity" role="img" aria-label={t('meeting.roster.camera')} title={t('meeting.roster.camera')} data-testid="activity-camera">
          <Camera />
        </span>
      )}
      {sharing && (
        <span className="ae-meeting-mic ae-meeting-activity" role="img" aria-label={t('meeting.roster.sharing')} title={t('meeting.roster.sharing')} data-testid="activity-sharing">
          <Screen />
        </span>
      )}
    </>
  );
}

export function AudioIndicators({ muted, mutedByHost, poorNetwork, isYou, heldForNotice }: {
  muted?: boolean; mutedByHost?: boolean; poorNetwork?: boolean; isYou?: boolean;
  /** The viewer's own microphone, held while a spoken notice plays: shown as muted, saying why. */
  heldForNotice?: boolean;
}) {
  const { t } = useTranslation();
  const noticeOnly = !!heldForNotice && !muted && !mutedByHost;
  const mutedLabel = mutedByHost ? t('meeting.roster.mutedByHost') : noticeOnly ? t('meeting.roster.mutedForNotice') : t('meeting.roster.muted');
  const networkHint = t(isYou ? 'meeting.roster.poorNetworkHintYou' : 'meeting.roster.poorNetworkHint');
  return (
    <>
      {(muted || mutedByHost || noticeOnly) && (
        <span className={`ae-meeting-mic ae-meeting-mic--muted${mutedByHost ? ' ae-meeting-mic--host' : ''}`} role="img" aria-label={mutedLabel} title={mutedLabel} data-testid="mic-muted" {...(noticeOnly ? { 'data-held': 'notice' } : {})}>
          <StruckMic />
          {mutedByHost && <span className="ae-meeting-mic-text">{t('meeting.roster.mutedByHost')}</span>}
        </span>
      )}
      {poorNetwork && (
        <span className="ae-meeting-mic ae-meeting-mic--network" role="img" aria-label={`${t('meeting.roster.poorNetwork')}: ${networkHint}`} title={networkHint} data-testid="mic-network">
          <Mic />
        </span>
      )}
    </>
  );
}
