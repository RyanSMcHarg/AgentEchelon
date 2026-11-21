/**
 * MeetingRoom: a conversation's meeting, full window (SPEC-ASSISTANT-MEETINGS).
 *
 * The conversation is the room, so this takes a `channelArn` and no meeting id: a conversation holds at most one
 * meeting and the server decides which. The conversation's own chat is passed in as `chat`, and the meeting's roster as
 * `roster`; both sit in the right column, the roster above the chat, each with its own header.
 *
 * Everyone in the meeting has a tile, laid out as an equal grid or as a speaker stage with a filmstrip; the viewer's
 * choice is remembered in this browser. The room renders only where the deployment serves meetings.
 *
 * BEFORE JOINING, the room says what the service says (`useConversationMeeting`): a meeting that runs offers Join; one
 * that has ended says so, and offers Start again to its host only; one not started offers Start to its host and tells
 * anyone else its host starts it; and Close closes the room without joining. The pre-join screen offers no End for
 * everyone, to anyone: its host and the moderators end a running meeting they are not in from the conversation's banner
 * (`MeetingInProgress`, FR50). IN THE MEETING, Leave leaves it running for the others; for its host and the moderators,
 * Leave first asks whether to leave or end it for everyone.
 *
 * START STARTS THE MEETING when it is pressed (`startNow`), as the sibling project creates the meeting before its pre-join
 * screen: the room's card and ring go out at once, and the device check then joins the meeting already running with the
 * start's own answer, with no second press.
 *
 * ALREADY IN THIS MEETING IN ANOTHER WINDOW OR TAB of this browser (`meetingPresence.ts`): the pre-join screen says so and
 * offers Join here, which moves the person's connection into this window, rather than a plain Join.
 *
 * THE WINDOW'S REGIONS: the header names the meeting; the video (grid or speaker stage) is the main region. Over it, as
 * in the sibling project's meeting interface: the view toggle and full screen at its top right; the microphone, camera,
 * screen share (and a host's captions and recording) with Leave, centered over its foot; and the device gear at its lower
 * right. Every control is an icon named in the reader's language. The group wraps, and the gear takes its own column
 * beside it, so nothing overlaps however narrow the video gets. LEAVING OR ENDING goes straight to the window's final
 * state: the pre-join screen is never shown on the way out.
 *
 * WHILE THE MEETING IS TRANSCRIBED (FR28): everyone in it sees the recording indicator in the header, is told aloud when
 * they join it and whenever transcription starts or stops, and a host may turn it on or off from the controls.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { classificationBadgeStyle, classificationName } from '@ae/shared/config/classifications.ts';
import { useMeeting, useMeetingCaptions } from '../../providers/MeetingProvider';
import { useMeetingSignals } from '../../providers/meetingSignals';
import { isMeetingEnabled } from '../../services/meetingService';
import { useConversationMeeting } from '../../hooks/useConversationMeeting';
import { watchMeetingPresenceAs } from '../../services/meetingPresence';
import { conversationIdOf } from '../../utils/meetingWindow';
import VideoTiles, { type MeetingLayout } from './VideoTiles';
import { MeetingDeviceMenu, MeetingPreJoin } from './MeetingDevices';
import { useNarrowWindow } from './meetingPanes';
import { announce } from '../../services/meetingTranscription';
import { MeetingChatPanel, MeetingPaneTabs, PANE_IDS, paneTabId, useMeetingPanes } from './MeetingChatPanel';
import {
  IconCamera, IconCameraOff, IconCaptions, IconExitFullscreen, IconFullscreen, IconGrid, IconHand, IconLeave, IconMic,
  IconMicOff, IconRecord, IconShare, IconShareStop, IconSpeaker,
} from './meetingIcons';
import './MeetingRoom.css';

const LAYOUT_KEY = 'ae.meeting.layout';
/** The viewer's last layout in this browser, else the grid. */
function storedLayout(): MeetingLayout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'speaker' ? 'speaker' : 'grid'; } catch { return 'grid'; }
}

/** Whether the browser shows this element full screen now. */
function isFullscreen(el: Element | null): boolean {
  return typeof document !== 'undefined' && !!el && document.fullscreenElement === el;
}

export default function MeetingRoom({
  channelArn,
  title,
  chat,
  roster,
  onLeave,
  nameOf,
}: {
  channelArn: string;
  /** The meeting's name as a person reads it (`meeting.inRoom` over its room's name). Falls back to the generic label. */
  title?: string;
  chat?: ReactNode;
  /** The meeting's roster, at the top of the right column above the chat. */
  roster?: ReactNode;
  onLeave?: () => void;
  /** A person's display name by their person id, for a tile whose camera is off. */
  nameOf?: (personId: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const meeting = useMeeting();
  const signals = useMeetingSignals();
  const [ending, setEnding] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  // ON THE WAY OUT: once Leave or End for everyone is chosen in a window that closes, the room says so until it closes,
  // rather than falling back to the pre-join screen the session's end would otherwise show.
  const [departing, setDeparting] = useState<null | "leaving" | "ending">(null);
  const [layout, setLayout] = useState<MeetingLayout>(storedLayout);
  // Joining waits for the device check's one permission request to settle; starting does not. Unsettled until the check
  // (`MeetingPreJoin`, on the pre-join screen) first reports, so a start made here never joins ahead of its answer.
  const [devicesReady, setDevicesReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const chooseLayout = (next: MeetingLayout) => {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* the choice lasts this window only */ }
  };

  // RECONNECTING COUNTS AS BEING IN THE MEETING. Dropping back to the pre-join screen would take the
  // stage and the controls away from somebody whose connection is being restored, and offer them a
  // "start meeting" button for the meeting they are already in.
  const connected = meeting.status === 'joined' || meeting.status === 'reconnecting';
  // WHAT THE SERVICE SAYS OF THE MEETING while this person is not in it, read again whenever this window's own session
  // settles (a failed join, a leave) or a start made here answers, so Join and Start follow the meeting.
  const here = useConversationMeeting(connected ? undefined : channelArn, [], { ringLate: false, refresh: `${meeting.status}:${meeting.startedHere ? 1 : 0}` });

  // A START MADE HERE JOINS once the device check has settled, with the start's own answer.
  useEffect(() => {
    if (meeting.startedHere && devicesReady && meeting.status !== 'joining' && !connected) void meeting.start(channelArn);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- joins once per start, when the check settles
  }, [meeting.startedHere, devicesReady]);

  // IN THIS MEETING IN ANOTHER WINDOW: while this window holds no part of it, a window that does is another of this
  // person's, so the pre-join screen says so.
  const [elsewhere, setElsewhere] = useState(false);
  const watching = !connected && meeting.status !== 'joining' && !meeting.startedHere;
  const watchedIds = [conversationIdOf(channelArn), here.meetingConversationId ?? ''].join(',');
  useEffect(() => {
    if (!watching) { setElsewhere(false); return undefined; }
    return watchMeetingPresenceAs(watchedIds.split(','), setElsewhere);
  }, [watching, watchedIds]);

  // FULL SCREEN, on the video area itself, so the controls over it come along.
  const videoRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setFullscreen(isFullscreen(videoRef.current));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  // Offered only where the browser can do it: a button that does nothing is not shown.
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled === true
    && typeof document.documentElement.requestFullscreen === 'function';
  const toggleFullscreen = () => {
    const el = videoRef.current;
    if (!el) return;
    if (isFullscreen(el)) { void document.exitFullscreen?.().catch(() => undefined); return; }
    void el.requestFullscreen?.().catch(() => undefined);
  };

  // TOLD ALOUD, in the reader's language: on joining a recorded or captioned meeting, then on each start or stop of
  // recording or captions while in it.
  const { t: tn, i18n } = useTranslation();
  const toldRef = useRef<{ connected: boolean; transcribing: boolean; recording: boolean }>({ connected: false, transcribing: false, recording: false });
  useEffect(() => {
    const before = toldRef.current;
    const recording = meeting.transcribing && meeting.recording;
    toldRef.current = { connected, transcribing: meeting.transcribing, recording };
    if (!connected) return;
    // Where recording keeps audio and video too (FR70), every recording notice says so.
    // Each notice holds the microphone while it plays, so it never reaches the meeting or this person's transcript.
    const say = (key: string) => announce(tn(`meeting.transcription.${key}${meeting.mediaRecording && key.startsWith('recording') && key !== 'recordingStoppedNotice' ? 'Media' : ''}`), i18n.language, meeting.holdMicForNotice);
    if (!before.connected) {
      if (recording) say('recordingJoinNotice');
      else if (meeting.transcribing) say('captionsJoinNotice');
    } else if (before.recording !== recording) {
      say(recording ? 'recordingStartedNotice' : 'recordingStoppedNotice');
    } else if (before.transcribing !== meeting.transcribing) {
      say(meeting.transcribing ? 'captionsStartedNotice' : 'captionsStoppedNotice');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the hold is read when a notice is said, never a reason to say one
  }, [connected, meeting.transcribing, meeting.recording, meeting.mediaRecording, tn, i18n.language]);

  // ON A PHONE-WIDTH SCREEN the video, the roster and the chat are panes, one shown at a time (`meetingPanes.ts`).
  const panes = useMeetingPanes({ people: !!roster, chat: !!chat });
  const narrow = useNarrowWindow();
  const shareable = !narrow || (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function');
  const videoHidden = !!panes && panes.shown !== 'video';

  // A START KEPT HERE WHOSE MEETING HAS SINCE ENDED (ended by another host, or by the service): once the service has said
  // the started meeting runs, its saying that none runs means it ended. The kept start is let go and the room says so.
  const [keptSeenRunning, setKeptSeenRunning] = useState(false);
  const [endedWhileWaiting, setEndedWhileWaiting] = useState(false);
  const keptEnded = meeting.startedHere && keptSeenRunning && here.known && !here.running;
  useEffect(() => {
    if (!meeting.startedHere) setKeptSeenRunning(false);
    else if (here.running) setKeptSeenRunning(true);
  }, [meeting.startedHere, here.running]);
  useEffect(() => {
    if (!keptEnded) return;
    setEndedWhileWaiting(true);
    meeting.leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lets the kept start go once, when the service says it ended
  }, [keptEnded]);

  // Defensive. Entry points are gated on the same check, but a room must never render without an API.
  if (!isMeetingEnabled()) return null;

  const name = title || t('meeting.title');
  const busy = meeting.status === 'joining';
  const isHost = connected ? meeting.isHost : here.isHost;
  const removed = !connected && (here.removed || meeting.errorCode === 'REMOVED_FROM_MEETING');
  // No answer from the service yet, only a refusal or a failure to read it.
  const unread = !here.known && !!here.errorCode;
  // A start made here runs: the room shows it as running whatever the last read said.
  const running = here.running || meeting.startedHere;

  const handleLeave = () => {
    setConfirmingLeave(false);
    if (onLeave) setDeparting("leaving");
    meeting.leave();
    onLeave?.();
  };
  // The host and the moderators choose between leaving and ending it for everyone; anyone else just leaves.
  // THE CONFIRMATION IS OUTSIDE THE VIDEO, and full screen paints the video alone, so asking first leaves full screen.
  const askLeave = () => {
    if (isFullscreen(videoRef.current)) void document.exitFullscreen?.().catch(() => undefined);
    return meeting.mayEnd ? setConfirmingLeave(true) : handleLeave();
  };

  const handleEnd = async () => {
    setConfirmingLeave(false);
    setEnding(true);
    if (onLeave) setDeparting("ending");
    try {
      // A FAILED END KEEPS THE ROOM OPEN. The meeting is still running for everyone else, and closing
      // the room would hide the only place that says so.
      if (await meeting.end(channelArn)) onLeave?.();
      else setDeparting(null);
    } catch {
      setDeparting(null);
    } finally {
      setEnding(false);
    }
  };

  const handleStart = async () => {
    setEndedWhileWaiting(false);
    setCreating(true);
    try { await meeting.startNow(channelArn); } finally { setCreating(false); }
  };

  // The pre-join screen: the room's state, the device check and the actions, while this person is not in the meeting.
  const prejoin = (
    <div className="ae-meeting-prejoin">
      {/* The code is mapped to copy HERE. The provider holds codes so that none of this is
          fixed English anywhere a translation cannot reach. An unrecognized code still says
          something true rather than rendering the code itself. */}
      {/* A HOST REMOVED THIS PERSON: said as the room's state, not as a failure, and no Join is offered. */}
      {removed ? (
        <p className="ae-meeting-note" role="status">{t('meeting.removedByHost')}</p>
      ) : meeting.errorCode && (
        <p className="ae-meeting-error" role="alert">
          {t([`meeting.errors.${meeting.errorCode}`, 'meeting.errors.JOIN_FAILED'])}
        </p>
      )}
      {/* THE SERVICE COULD NOT SAY whether it runs (a refusal, an outage): said, and Join stays, since the join route
          decides who may enter and says why when it will not. */}
      {unread && !removed && !meeting.errorCode && <p className="ae-meeting-note" role="status">{t('meeting.statusUnread')}</p>}
      {meeting.startedHere && <p className="ae-meeting-note" role="status" data-testid="meeting-started-here">{t('meeting.startedJoining')}</p>}
      {elsewhere && running && !removed && <p className="ae-meeting-note" role="status" data-testid="meeting-elsewhere">{t('meeting.inAnotherWindow')}</p>}
      {!running && ((here.known && here.ended) || endedWhileWaiting) && <p className="ae-meeting-note" role="status" data-testid="meeting-ended-note">{t('meeting.ended')}</p>}
      {here.known && !running && !here.ended && !here.mayStart && (
        <p className="ae-meeting-note" role="status">{t('meeting.waitingForHost')}</p>
      )}
      <MeetingPreJoin onReady={setDevicesReady} />
      <div className="ae-meeting-actions">
        {(running || unread) && !removed ? (
          // A RUNNING MEETING OFFERS JOIN ONLY, even to its host: End for everyone is in the Leave dialog and the banner.
          meeting.startedHere ? (
            <button className="ae-meeting-join-btn" onClick={() => { void meeting.start(channelArn); }} disabled={busy} data-testid="meeting-join-started">
              {busy ? t('meeting.joining') : t('meeting.join')}
            </button>
          ) : (
            <button className="ae-meeting-join-btn" onClick={() => { void meeting.join(channelArn); }} disabled={busy || !devicesReady}>
              {busy ? t('meeting.joining') : t(elsewhere ? 'meeting.joinHere' : 'meeting.join')}
            </button>
          )
        ) : here.known && here.mayStart && (
          <button className="ae-meeting-join-btn" onClick={() => { void handleStart(); }} disabled={busy || creating}>
            {busy || creating ? t('meeting.starting') : t(here.ended ? 'meeting.startAgain' : 'meeting.start')}
          </button>
        )}
        {/* Opening the room only to look is supported, so it can be closed without joining. */}
        {onLeave && (
          <button
            className="ae-meeting-join-btn ae-meeting-join-btn--secondary"
            onClick={handleLeave}
            disabled={busy}
          >
            {t('meeting.close')}
          </button>
        )}
      </div>
    </div>
  );

  // AN ICON CONTROL: its name in the reader's language, said to assistive technology and shown on hover.
  const iconBtn = (props: {
    label: string; icon: ReactNode; onClick: () => void; pressed?: boolean; disabled?: boolean; hint?: string; extra?: string; testId?: string;
  }) => (
    <button
      type="button"
      className={`ae-mc-btn ae-mc-btn--icon ae-mc-btn--overlay${props.pressed ? ' ae-mc-btn--on' : ''}${props.extra ? ` ${props.extra}` : ''}`}
      onClick={props.onClick}
      aria-label={props.label}
      title={props.hint ?? props.label}
      {...(props.pressed !== undefined ? { 'aria-pressed': props.pressed } : {})}
      disabled={props.disabled}
      data-testid={props.testId}
    >
      {props.icon}
    </button>
  );

  const mic = meeting.mutedByHost || meeting.mutedByRoom
    // WHILE THE SERVICE CARRIES NONE OF THEIR AUDIO the microphone asks rather than unmutes (FR51, FR59): a person the room
    // muted on joining requests to unmute and is granted at once; one a host muted asks to speak and waits.
    ? iconBtn({
      label: signals.speakRequestPending
        ? t(meeting.mutedByHost ? 'meeting.askedToSpeak' : 'meeting.requestingToUnmute')
        : t(meeting.mutedByHost ? 'meeting.askToSpeak' : 'meeting.requestToUnmute'),
      hint: meeting.mutedByHost ? t('meeting.mutedByHostHint') : t('meeting.mutedByRoomHint'),
      icon: <IconHand />, pressed: true, disabled: signals.speakRequestPending,
      onClick: () => { void signals.requestToSpeak(); },
    })
    // WHILE A SPOKEN NOTICE HOLDS THE MICROPHONE it shows as off and says why; pressing it still sets the person's own
    // mute, which is what the microphone returns to when the notice ends.
    : iconBtn({
      label: meeting.muted ? t('meeting.unmute') : t('meeting.mute'),
      hint: meeting.mutedForNotice ? t('meeting.mutedForNotice') : undefined,
      icon: meeting.muted || meeting.mutedForNotice ? <IconMicOff /> : <IconMic />, pressed: meeting.muted, onClick: meeting.toggleMute,
      extra: meeting.mutedForNotice && !meeting.muted ? 'ae-mc-btn--held' : undefined,
    });

  return (
    <div className={`ae-meeting-room${panes ? ' ae-meeting-room--panes' : ''}`} role="dialog" aria-label={name}>
      <header className="ae-meeting-header">
        <span className="ae-meeting-title" title={name}>{name}</span>
        {isHost && <span className="ae-meeting-host">{t('meeting.host')}</span>}
        {/* THE RECORDING INDICATOR, for everyone in the meeting while it is transcribed: a blinking red dot while it
            records, an amber one for captions alone. */}
        {connected && meeting.transcribing && (
          <span
            className={`ae-meeting-transcribing${meeting.recording ? ' ae-meeting-transcribing--recording' : ''}`}
            role="status" data-testid="meeting-transcribing" data-mode={meeting.recording ? 'recording' : 'captions'}
          >
            <span className="ae-meeting-transcribing-dot" aria-hidden="true" />
            {t(meeting.recording ? (meeting.mediaRecording ? 'meeting.transcription.recordingOnMedia' : 'meeting.transcription.recordingOn') : 'meeting.transcription.on')}
          </span>
        )}
        {meeting.status === 'reconnecting' && (
          <span className="ae-meeting-reconnecting" role="status">{t('meeting.reconnecting')}</span>
        )}
        {meeting.classification && (
          <span className="ae-meeting-boundary" style={classificationBadgeStyle(meeting.classification)} title={t('meeting.classificationTag', { classification: classificationName(meeting.classification) })}>
            {classificationName(meeting.classification)}
          </span>
        )}
      </header>

      <div className="ae-meeting-body" {...panes?.swipe}>
        <main
          id={PANE_IDS.video}
          className="ae-meeting-main"
          hidden={videoHidden}
          {...(panes ? { role: 'tabpanel', 'aria-labelledby': paneTabId('video') } : {})}
        >
          {departing ? (
            // THE WAY OUT: what was chosen, said until the window closes, never the pre-join screen.
            <div className="ae-meeting-prejoin" role="status" data-testid="meeting-departing">
              <p className="ae-meeting-note">{t(departing === 'ending' ? 'meeting.ending' : 'meeting.leaving')}</p>
            </div>
          ) : connected ? (
            <>
              {/* WHILE THIS PERSON SHARES: what is shared, whether its sound goes with it, and Stop sharing, in the window
                  they stay in. */}
              {meeting.sharing && (
                <div className="ae-meeting-sharing-bar" role="status" data-testid="meeting-sharing-bar">
                  <span className="ae-meeting-sharing-dot" aria-hidden="true" />
                  <span className="ae-meeting-sharing-text">
                    {t(`meeting.sharingBar.${meeting.share?.surface ?? 'unknown'}`)}
                    {meeting.share?.audio ? ` ${t('meeting.sharingBar.withAudio')}` : ''}
                  </span>
                  <button type="button" className="ae-mc-btn ae-mc-btn--danger-outline" onClick={() => { void meeting.toggleShare(); }}>
                    {t('meeting.stopShare')}
                  </button>
                </div>
              )}
              {/* THE VIDEO AREA: the tiles, and over them the controls. It is what full screen shows. */}
              <div className="ae-meeting-video" ref={videoRef} data-testid="meeting-video">
                {/* TOP RIGHT: the view (grid or speaker) and full screen, in a band of their own above the tiles. */}
                <div className="ae-meeting-stage-top" role="group" aria-label={t('meeting.layout')}>
                  {iconBtn({ label: t('meeting.layoutGrid'), icon: <IconGrid />, pressed: layout === 'grid', onClick: () => chooseLayout('grid') })}
                  {iconBtn({ label: t('meeting.layoutSpeaker'), icon: <IconSpeaker />, pressed: layout === 'speaker', onClick: () => chooseLayout('speaker') })}
                  {canFullscreen && iconBtn({
                    label: t(fullscreen ? 'meeting.exitFullscreen' : 'meeting.fullscreen'),
                    icon: fullscreen ? <IconExitFullscreen /> : <IconFullscreen />, pressed: fullscreen, onClick: toggleFullscreen,
                    testId: 'meeting-fullscreen',
                  })}
                </div>

                {/* THE TILES, between the two bands of controls, so the tiles' own controls (the self view's, the grid's
                    pages) are never under them. */}
                <div className="ae-meeting-stage-wrap">
                  <div className="ae-meeting-stage">
                    <VideoTiles layout={layout} nameOf={nameOf} />
                  </div>
                  {/* LIVE CAPTIONS, every speaker's newest lines, while it is transcribed, over the foot of the tiles. */}
                  <MeetingCaptions nameOf={nameOf} />
                </div>

                {/* THE FOOT OF THE VIDEO: what the controls have to say, the controls centered, the device gear at the right. */}
                <div className="ae-meeting-stage-bottom">
                  {(meeting.mutedByHost || meeting.errorCode || meeting.mutedForNotice) && (
                    <div className="ae-meeting-controls-status">
                      {meeting.mutedForNotice && (
                        <span className="ae-meeting-note ae-meeting-note--overlay" role="status" data-testid="meeting-muted-for-notice">{t('meeting.mutedForNotice')}</span>
                      )}
                      {meeting.mutedByHost && <span className="ae-meeting-note ae-meeting-note--overlay" role="status">{t('meeting.mutedByHost')}</span>}
                      {/* A control failing mid-meeting reports itself without tearing the room down. */}
                      {meeting.errorCode && (
                        <span className="ae-meeting-error ae-meeting-error--overlay" role="alert">
                          {t([`meeting.errors.${meeting.errorCode}`, 'meeting.errors.JOIN_FAILED'])}
                          {/* Read and put away: a failed control never stays over the video for the rest of the meeting. */}
                          <button
                            type="button" className="ae-meeting-error-dismiss" onClick={meeting.dismissError}
                            aria-label={t('common.dismiss')} title={t('common.dismiss')} data-testid="meeting-error-dismiss"
                          >
                            &times;
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                  <div className="ae-meeting-controls" role="toolbar" aria-label={t('meeting.controls')}>
                    {mic}
                    {iconBtn({
                      label: meeting.cameraOn ? t('meeting.stopVideo') : t('meeting.startVideo'),
                      icon: meeting.cameraOn ? <IconCamera /> : <IconCameraOff />, pressed: meeting.cameraOn,
                      onClick: () => { void meeting.toggleCamera(); },
                    })}
                    {/* A PHONE'S BROWSER THAT CANNOT SHARE A SCREEN offers no share, as the sibling project hides it on mobile. */}
                    {(shareable || meeting.sharing) && iconBtn({
                      label: meeting.sharing ? t('meeting.stopShare') : t('meeting.share'),
                      hint: meeting.sharing ? undefined : t('meeting.shareHint'),
                      icon: meeting.sharing ? <IconShareStop /> : <IconShare />, pressed: meeting.sharing,
                      onClick: () => { void meeting.toggleShare(); },
                    })}
                    {/* A HOST TURNS CAPTIONS AND RECORDING ON OR OFF; the server holds the same rules. Captions cannot be
                        turned off while it records. */}
                    {meeting.isHost && (
                      <>
                        {iconBtn({
                          label: meeting.transcribing ? t('meeting.transcription.turnOff') : t('meeting.transcription.turnOn'),
                          hint: meeting.recording ? t('meeting.transcription.captionsWhileRecording') : undefined,
                          icon: <IconCaptions />, pressed: meeting.transcribing, disabled: meeting.recording,
                          onClick: () => { void meeting.setTranscription({ on: !meeting.transcribing }); },
                        })}
                        {iconBtn({
                          label: meeting.recording ? t('meeting.transcription.stopRecording') : t('meeting.transcription.startRecording'),
                          icon: <IconRecord />, pressed: meeting.recording, extra: meeting.recording ? 'ae-mc-btn--recording' : undefined,
                          onClick: () => { void meeting.setTranscription({ recording: !meeting.recording }); },
                        })}
                      </>
                    )}
                    {iconBtn({
                      label: ending ? t('meeting.ending') : t('meeting.leave'),
                      icon: <IconLeave />, disabled: ending, extra: 'ae-mc-btn--leave', onClick: askLeave,
                    })}
                  </div>
                  <div className="ae-meeting-stage-corner">
                    <MeetingDeviceMenu />
                  </div>
                </div>
              </div>
            </>
          ) : prejoin}
        </main>
        {(chat || roster) && <MeetingChatPanel roster={roster}>{chat}</MeetingChatPanel>}
      </div>
      <MeetingPaneTabs panes={panes} />

      {confirmingLeave && (
        <LeaveDialog onCancel={() => setConfirmingLeave(false)} onLeave={handleLeave} onEnd={() => { void handleEnd(); }} />
      )}
    </div>
  );
}

/** The live caption lines, every speaker's newest, while the meeting is transcribed: the one part of the room they re-render. */
function MeetingCaptions({ nameOf }: { nameOf?: (personId: string) => string | undefined }) {
  const { t } = useTranslation();
  const captions = useMeetingCaptions();
  if (captions.length === 0) return null;
  return (
    <div className="ae-meeting-captions" aria-live="polite" data-testid="meeting-captions">
      {captions.map((c) => (
        <p key={c.resultId} className={`ae-meeting-caption${c.partial ? ' ae-meeting-caption--partial' : ''}`}>
          <span className="ae-meeting-caption-who">{nameOf?.(c.personId) || t('meeting.participant')}</span>
          {c.text}
        </p>
      ))}
    </div>
  );
}

/**
 * LEAVE OR END FOR EVERYONE, asked in a modal dialog: focus moves into it (to Cancel, the choice that changes nothing),
 * Tab stays among its choices, Escape cancels, and focus returns to where it was when the dialog closes.
 */
function LeaveDialog({ onCancel, onLeave, onEnd }: { onCancel: () => void; onLeave: () => void; onEnd: () => void }) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => { if (returnTo?.isConnected) returnTo.focus(); };
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const choices = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    if (choices.length === 0) return;
    const at = choices.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey ? (at <= 0 ? choices.length - 1 : at - 1) : (at === choices.length - 1 ? 0 : at + 1);
    e.preventDefault();
    choices[next].focus();
  };
  return (
    <div className="ae-meeting-dialog-backdrop">
      <div
        ref={dialogRef} className="ae-meeting-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="ae-meeting-leave-title" aria-describedby="ae-meeting-leave-body" onKeyDown={onKeyDown}
      >
        <h2 id="ae-meeting-leave-title">{t('meeting.leaveDialog.title')}</h2>
        <p id="ae-meeting-leave-body">{t('meeting.leaveDialog.body')}</p>
        <div className="ae-meeting-actions ae-meeting-dialog-actions">
          <button ref={cancelRef} className="ae-meeting-join-btn ae-meeting-join-btn--secondary" onClick={onCancel}>{t('meeting.leaveDialog.cancel')}</button>
          <button className="ae-meeting-join-btn ae-meeting-join-btn--secondary" onClick={onLeave}>{t('meeting.leaveDialog.leave')}</button>
          <button className="ae-meeting-join-btn ae-meeting-join-btn--danger" onClick={onEnd}>{t('meeting.end')}</button>
        </div>
      </div>
    </div>
  );
}
