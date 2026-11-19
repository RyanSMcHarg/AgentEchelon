/**
 * A MEETING RINGING FOR THE VIEWER (`MessagingProvider.incomingRing`): which conversation's meeting has started, with
 * Join, which opens its meeting window, and Dismiss. It rings audibly where the browser allows sound, and stops when the
 * ring's time is up, when the viewer answers, or when they dismiss it.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMessaging } from '../../providers/MessagingProvider';
import { useConversations } from '../../providers/ConversationProvider.chime';
import { openMeetingWindow } from '../../utils/meetingWindow';
import { ringInOneTab } from '../../services/meetingPresence';
import './MeetingRoom.css';

/** The gestures a browser accepts as unlocking sound: a touch ends as `touchend` and `click` on a phone, never `pointerdown`. */
export const UNLOCK_GESTURES = ['pointerdown', 'touchend', 'click', 'keydown'] as const;

/**
 * Two short tones every two seconds while the ring lasts. Where the browser holds sound until the person interacts with
 * the page (its autoplay rule), the ring shows at once and its tones start on a gesture: every gesture tries again, a
 * gesture the browser does not count included, until the sound runs, and then the page stops listening.
 */
export function startRingTone(): () => void {
  let ctx: AudioContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const unlisten = () => { for (const g of UNLOCK_GESTURES) window.removeEventListener(g, resume); };
  function resume(): void {
    if (!ctx) return;
    if (ctx.state === 'running') { unlisten(); return; }
    void ctx.resume().then(() => { if (ctx?.state === 'running') unlisten(); }).catch(() => undefined);
  }
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return () => undefined;
    ctx = new Ctor();
    const beep = (at: number) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.08, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    };
    const ring = () => { if (ctx && ctx.state === 'running') { beep(ctx.currentTime); beep(ctx.currentTime + 0.5); } };
    ring();
    timer = setInterval(ring, 2000);
    if (ctx.state !== 'running') {
      for (const g of UNLOCK_GESTURES) window.addEventListener(g, resume);
    }
  } catch { /* a ring without sound still shows */ }
  return () => {
    unlisten();
    if (timer) clearInterval(timer);
    void ctx?.close().catch(() => undefined);
  };
}

export default function IncomingRing() {
  const { t } = useTranslation();
  const { incomingRing, dismissRing } = useMessaging();
  const { conversations } = useConversations();

  // One tab of this person's rings aloud; the others show the ring silently.
  useEffect(() => (incomingRing ? ringInOneTab(startRingTone) : undefined), [incomingRing]);
  if (!incomingRing) return null;

  const conversation = conversations.find((c) => c.conversationArn === incomingRing.channelArn);
  const title = conversation?.title || t('meeting.title');
  return (
    <div className="ae-meeting-ring" role="alertdialog" aria-live="assertive" aria-label={t('meeting.ringing', { title })} data-testid="meeting-ring">
      <span className="ae-meeting-ring-text">{t('meeting.ringing', { title })}</span>
      <button
        type="button"
        className="ae-meeting-join-btn"
        onClick={() => { openMeetingWindow(incomingRing.channelArn); dismissRing('ringAnswered'); }}
      >
        {t('meeting.join')}
      </button>
      <button type="button" className="ae-meeting-join-btn ae-meeting-join-btn--secondary" onClick={() => dismissRing('ringDismissed')}>
        {t('meeting.dismiss')}
      </button>
    </div>
  );
}
