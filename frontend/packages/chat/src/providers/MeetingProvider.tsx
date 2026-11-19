/**
 * MeetingProvider - the live Amazon Chime SDK Meetings session for the conversation being viewed.
 *
 * Sits alongside the messaging provider rather than replacing it: the conversation is the room, so the
 * chat plane keeps running while a meeting is up. Exposes a join/leave state machine, device controls,
 * and the video-tile list the grid renders.
 *
 * ERRORS ARE CODES HERE, NOT SENTENCES. This provider never holds display text. The server's failure
 * `code` is kept as-is and local failures get codes of their own, and the room maps a code to a
 * localized string at render. A provider that stored "Camera unavailable" would put fixed English in
 * the one layer no translation can reach.
 *
 * ── SURVIVING A BACKGROUNDED TAB, WHICH IS THE HARDEST PART OF THIS FILE ─────────────────────────
 *
 * A meeting is the one surface here that breaks when nobody is looking at it. Browsers throttle a
 * backgrounded tab's timers to roughly once a minute and can freeze a hidden tab outright, and Amazon
 * Chime SDK's own reconnection runs on those timers - so the recovery mechanism is throttled exactly
 * when it is needed. Switch tabs mid-meeting, come back, and the session is dead with no reconnect
 * ever attempted. Three things together, because no one of them is sufficient:
 *
 *   1. `meetingKeepalive` plays a near-silent tone for the life of the meeting. An audible tab is
 *      exempt from throttling, which leaves Chime's own recovery working rather than replacing it.
 *      It can be refused by autoplay policy, which is why it is not the only measure.
 *   2. On becoming visible again after being hidden, the session's health is CHECKED rather than
 *      assumed. A status of "connected" is not trusted straight away: a stale WebRTC connection
 *      reports fine until something is sent over it, so a short grace period is allowed for the SDK
 *      to notice, and only a session still degraded after it is rejoined.
 *   3. A rejoin REUSES THE CACHED CREDENTIALS and calls no API.
 *
 * WHY (3) MATTERS BEYOND SPEED, and it is the part most easily got wrong: the server mints a NEW
 * attendee on every join call. Rejoining through the API would therefore add an attendee per
 * reconnect, so one person on a train would appear as a dozen - inflating the roster and every
 * attendance figure derived from it. The meeting and attendee from the original join stay valid for
 * the life of the meeting, so a reconnect is a local operation.
 *
 * A REJOIN IS BOUNDED AND THE PERSON'S OUTCOME IS NOT RETRIED. A meeting that has genuinely ended, that
 * no longer exists, or that turned the attendee away is cleaned up instead of retried: retrying would
 * spin until the attempt cap and then report a connection failure for a meeting that simply finished.
 * The SDK's terminal TRANSPORT stops are retried, since a backgrounded tab is where they happen
 * (`meetingRecovery.ts`, `stopOutcome`).
 *
 * A PERSON WHO WAS AWAY IS NOT DROPPED FOR IT. A rejoin waits for the network rather than spending its
 * attempts offline, a round that gives up while the tab is hidden or offline starts again when the
 * person or the network is back, the keepalive plays through a rejoin, and what the browser paused
 * plays again on return. A backgrounded person whose session is alive stays joined on the service,
 * which is what the meeting's bounded timeouts read (`present`, `meeting-figures.ts`).
 */
import {
  createContext, useContext, useState, useCallback, useMemo, useRef, useEffect, type ReactNode,
} from 'react';
import { onSessionEnd } from '@ae/shared/services/sessionEpoch.ts';
import {
  ConsoleLogger,
  LogLevel,
  DefaultActiveSpeakerPolicy,
  DefaultDeviceController,
  DefaultMeetingSession,
  MeetingSessionConfiguration,
  MeetingSessionStatusCode,
  VideoPriorityBasedPolicy,
  type AudioVideoObserver,
  type ContentShareObserver,
  type VideoTileState,
  type VideoSource,
  type MeetingSessionStatus,
  type EventObserver,
  type DeviceChangeObserver,
  type TranscriptEvent,
  type AudioVideoFacade,
} from 'amazon-chime-sdk-js';
import {
  createNoticeMicHold, createRecordingTimeline, createTranscriptReporter, nextCaptions, readTranscriptEvent, transcriptionModeOf, TRANSCRIPTION_TOPIC, type CaptionLine, type TranscriptReporter,
} from '../services/meetingTranscription';
import { startScreenShare, type ShareStarted } from '../services/meetingShare';
import { meetingService, type MeetingJoinInfo, type MeetingApiError } from '../services/meetingService';
import { createMeetingEventReporter, type MeetingEventReporter } from '../services/meetingEventReporter';
import { createConnectivitySampler, deviceClassOf, isPermissionDenied, type ConnectivitySampler } from '../services/meetingConnectivity';
import { startKeepalive, type Keepalive } from './meetingKeepalive';
import { MAX_REJOIN_ATTEMPTS, networkOffline, rejoinDelayMs, resumePlayback, stopOutcome, tabHidden } from './meetingRecovery';
import { pickDevice, readDeviceChoices, saveDeviceChoices, type MeetingDeviceKind } from '../services/meetingDevices';
import { holdMeetingPresenceAs } from '../services/meetingPresence';
import { conversationIdOf } from '../utils/meetingWindow';

export type MeetingStatus = 'idle' | 'joining' | 'joined' | 'reconnecting' | 'error';

/** How long a tab must have been hidden before its session is worth checking. */
const HIDDEN_CHECK_THRESHOLD_MS = 2000;
/**
 * How long the SDK is given to notice a connection that went stale while hidden.
 *
 * A returning tab reports "connected" before anything has been sent over the connection, so an
 * immediate check passes on a session that is actually dead. This waits for the SDK's own detection
 * rather than second-guessing it, and only a session still degraded afterwards is rejoined.
 */
const STALE_DETECTION_GRACE_MS = 5000;
/** How long the service keeps a mode message for an attendee not connected when it was sent (the most it keeps one). */
const MODE_LIFETIME_MS = 300_000;

/**
 * STOP THE SDK'S OWN RECONNECT FOR GOOD. Stopping a session does not cancel a reconnect already waiting out its backoff
 * (amazon-chime-sdk-js 3.x: `stop()` only disables further attempts), so a session torn down while it waits would join
 * again as the same attendee and push out the session that replaced it. The reconnect controller's `cancel()` stops
 * that timer; it is reached through the session's controller, which the SDK does not expose by type.
 */
function cancelSdkReconnect(session: DefaultMeetingSession): void {
  try {
    const controller = (session as unknown as { audioVideoController?: { _reconnectController?: { cancel?: () => void } } })
      .audioVideoController?._reconnectController;
    controller?.cancel?.();
  } catch { /* nothing waiting */ }
}

/** A rendered video tile: a participant camera, the local preview, or shared content. */
export interface MeetingTile {
  tileId: number;
  attendeeId: string;
  isLocal: boolean;
  /** A screen-share tile. Amazon Chime SDK joins shared content as its own attendee. */
  isContent: boolean;
  /** The video downlink policy paused this tile's stream to save bandwidth; the tile shows its placeholder meanwhile. */
  paused?: boolean;
}

/** Someone in the meeting, camera on or off: their attendee id and the person key they joined as (`ExternalUserId`). */
export interface MeetingAttendee {
  attendeeId: string;
  personId: string;
  /** Their microphone is muted, as the service reports it; absent until their audio is reported. */
  muted?: boolean;
  /** Their audio reaches the meeting weakly (the service's signal strength under one half); absent until reported. */
  weakSignal?: boolean;
}

export interface MeetingContextValue {
  status: MeetingStatus;
  /** Everyone present, in the order they arrived; a screen share is not one of them. */
  attendees: MeetingAttendee[];
  /**
   * WHO LEFT, by person id: everyone this window saw in the meeting who has since gone and not come back, so the roster
   * tells a person who left from one who never joined. Kept across a reconnect, cleared when this person leaves.
   */
  leftPersonIds: string[];
  /** The attendee speaking now, by the SDK's active-speaker detector, or undefined. */
  activeSpeaker?: string;
  /** A stable code, never display text. The room localizes it. */
  errorCode?: string;
  /** Put away a control's failure the person has read (a camera, a device, a share, the transcription): the meeting goes on. */
  dismissError: () => void;
  /**
   * THE MEETING'S OWN CONVERSATION (FR27), by id, once a start or a join answers: the conversation whose chat is the
   * meeting's, which may be another than the one the meeting was started from.
   */
  conversationId?: string;
  /** The room the meeting was started from, as a start or a join answered: the server's word, never a channel's Metadata. */
  roomConversationId?: string;
  /** The boundary the meeting was created under, for the room to display. */
  classification?: string;
  /** This person hosts the meeting, as the start or the join answered (`meeting-host.ts`). */
  isHost: boolean;
  /** Every host of the meeting, by person id, as the start or the join answered. */
  hostIds: string[];
  /** This person may end it for everyone: its host, or a moderator of its room or its conversation. */
  mayEnd: boolean;
  /**
   * WHETHER THE MEETING IS TRANSCRIBED NOW (FR28): as the join answered, then as the service's own transcription status
   * says on the meeting's data channel, so every attendee sees the same.
   */
  transcribing: boolean;
  /** Whether it is recorded now: captions, the stored transcript and the summary (recording mode). */
  recording: boolean;
  /** Whether recording keeps the meeting's audio and video too (FR70), so everything that says recording says so. */
  mediaRecording: boolean;
  /**
   * A host turns captions or recording on or off. Recording keeps captions on, and captions cannot be turned off while it
   * records. Resolves true once the mode changed; false with `errorCode` set when refused.
   */
  setTranscription: (ask: { on?: boolean; recording?: boolean }) => Promise<boolean>;
  tiles: MeetingTile[];
  /**
   * THE REMOTE VIDEOS PUBLISHED IN THE MEETING, by attendee id (a share's `#content` attendee included), as the SDK reports
   * them (`remoteVideoSourcesDidChange`): what the layout may subscribe to through `videoPolicy` (`useVideoSubscriptions.ts`).
   */
  videoSources: string[];
  /** The session's video downlink policy (`VideoPriorityBasedPolicy`), which receives only the videos chosen; null while none runs. */
  videoPolicy: () => VideoPriorityBasedPolicy | null;
  muted: boolean;
  cameraOn: boolean;
  sharing: boolean;
  /** While sharing: what is shared and whether its sound goes with it, as the browser reported the pick. */
  share?: ShareStarted;
  /**
   * Hold the microphone while a spoken notice plays (`announce`), so the notice never enters the meeting's audio or this
   * person's transcript; the function returned gives the microphone back to the person's own state.
   */
  holdMicForNotice: () => () => void;
  /**
   * A spoken notice holds this person's microphone now: nothing they say reaches the meeting until it ends, whatever
   * their own mute says. Their own control, tile and roster row say so.
   */
  mutedForNotice: boolean;
  /** Start the conversation's meeting, or connect to the one already running. */
  start: (channelArn: string) => Promise<void>;
  /**
   * START THE MEETING NOW, WITHOUT CONNECTING: the meeting is created (the room's card and ring follow from the service)
   * the moment the person presses Start, and the answer is kept for the join that follows the device check, which then
   * connects to the meeting already running with no second call. Resolves true once it runs.
   */
  startNow: (channelArn: string) => Promise<boolean>;
  /** A start this window made is running and waiting for this person to finish the device check and connect. */
  startedHere: boolean;
  /** Connect to a meeting already running. Fails with NO_ACTIVE_MEETING when there is none. */
  join: (channelArn: string) => Promise<void>;
  /** Leave without ending it for anybody else. */
  leave: () => void;
  /** End it for everyone, then leave. */
  /** Resolves true once the meeting has ended for everyone; false when the server refused, with `errorCode` set. */
  end: (channelArn: string) => Promise<boolean>;
  toggleMute: () => void;
  /**
   * A HOST STOPPED THIS PERSON'S AUDIO (SPEC-ASSISTANT-MEETINGS FR59): the service carries none of it, and the microphone
   * is muted here and cannot be unmuted until a host lets them speak, so restoring the service's capability never opens
   * a microphone the person did not open themselves.
   */
  mutedByHost: boolean;
  /**
   * THE ROOM'S SPEAKING ROLES MUTED THIS PERSON ON JOINING (FR51): the service carries none of their audio until they ask
   * to speak, which is granted at once, so the microphone is held here the same way until then.
   */
  mutedByRoom: boolean;
  /** Hold this person's microphone, for a host or for the room's rule (`meetingSignals.tsx`), or release it, which leaves it muted. */
  holdMute: (held: boolean, by?: 'host' | 'room') => void;
  /** The people a host removed from this meeting, as the join answered. */
  removedIds: string[];
  /** The people asking a host to let them speak, as the join answered a host. */
  speakRequests: string[];
  /** This person's own attendee in the meeting, once joined. */
  selfAttendeeId?: string;
  /** The live session's audio and video, for the meeting's signals (`meetingSignals.tsx`); null while none runs. */
  audioVideo: () => AudioVideoFacade | null;
  toggleCamera: () => void;
  /** The microphone, speaker and camera in use now, by device id; a kind not in use is absent. */
  deviceIds: Partial<Record<MeetingDeviceKind, string>>;
  /** Switch to another device mid-meeting, and remember it as the person's choice (`services/meetingDevices.ts`). */
  chooseDevice: (kind: MeetingDeviceKind, deviceId: string) => Promise<void>;
  toggleShare: () => void;
  /** Bind a <video> element to a tile, called by the tile component on mount. */
  bindVideoElement: (tileId: number, el: HTMLVideoElement | null) => void;
}

const MeetingContext = createContext<MeetingContextValue | null>(null);
/**
 * THE LIVE CAPTIONS, IN A CONTEXT OF THEIR OWN: every transcript event (a line still forming included) replaces them
 * several times a second while someone speaks, so only what shows them re-renders for it, never the rest of the meeting.
 */
const MeetingCaptionsContext = createContext<CaptionLine[]>([]);
const NO_CAPTIONS: CaptionLine[] = [];

/** The control failures a later success of the same control puts away: the meeting runs on either way. */
const CONTROL_ERRORS: Record<string, readonly string[]> = {
  camera: ['CAMERA_UNAVAILABLE'],
  device: ['CAMERA_UNAVAILABLE', 'DEVICE_UNAVAILABLE'],
  share: ['SHARE_UNAVAILABLE'],
};

/** The code a thrown error carries, falling back to one that says only that connecting failed. */
function codeOf(e: unknown, fallback: string): string {
  const code = (e as MeetingApiError | undefined)?.code;
  return code || fallback;
}

/**
 * WHAT A TERMINAL STOP TELLS THE PERSON. This person leaving and the meeting ending say nothing; every other terminal
 * stop is a refusal the room explains, so a join the service turned away never drops silently to the pre-join screen.
 */
export function terminalStopCode(code: MeetingSessionStatusCode): string | undefined {
  switch (code) {
    case MeetingSessionStatusCode.Left:
    case MeetingSessionStatusCode.MeetingEnded:
      return undefined;
    case MeetingSessionStatusCode.AudioCallAtCapacity:
    case MeetingSessionStatusCode.VideoCallAtSourceCapacity:
      return 'MEETING_FULL';
    case MeetingSessionStatusCode.AudioJoinedFromAnotherDevice:
      return 'JOINED_ELSEWHERE';
    case MeetingSessionStatusCode.AudioAttendeeRemoved:
      return 'REMOVED_FROM_MEETING';
    default:
      return 'CONNECTION_LOST';
  }
}

/** A rejoin failure that means the meeting itself is gone, so retrying cannot help. */
function meetingIsGone(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not found|does not exist|gone|deleted|expired/i.test(msg);
}

export function MeetingProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<MeetingStatus>('idle');
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [classification, setClassification] = useState<string | undefined>();
  const [isHost, setIsHost] = useState(false);
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [mediaRecording, setMediaRecording] = useState(false);
  const [captions, setCaptions] = useState<CaptionLine[]>([]);
  /**
   * WHEN THE MEETING WAS RECORDED, read inside the session's callbacks: a line of this person's is kept by whether it was
   * recorded when they began saying it (`createRecordingTimeline`).
   */
  const [recordingTimeline] = useState(() => createRecordingTimeline());
  /** The recording mode from now on (or from `at`), as the timeline and the room both read it. */
  const applyRecording = useCallback((on: boolean, at?: number) => {
    recordingTimeline.set(on, at);
    setRecording(on);
  }, [recordingTimeline]);
  const hostIdsRef = useRef<string[]>([]);
  const [mutedByHost, setMutedByHost] = useState(false);
  /** Whether a host holds this person's microphone, applied to every session this provider builds, as the mute is. */
  const mutedByHostRef = useRef(false);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [mutedByRoom, setMutedByRoom] = useState(false);
  /** The hold on this person's microphone is the room's (FR51) rather than a host's, for a re-read that says only a host's. */
  const mutedByRoomRef = useRef(false);
  const [speakRequests, setSpeakRequests] = useState<string[]>([]);
  /** This person's own transcript lines, batched to the server while the meeting is transcribed (`meetingTranscription.ts`). */
  const transcriptReporterRef = useRef<TranscriptReporter | null>(null);
  const [mayEnd, setMayEnd] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  /** The room the meeting was started from, where its ring sounds, once a start or a join names it. */
  const [roomConversationId, setRoomConversationId] = useState<string | undefined>();
  /** The parent conversation, read by a start made after its state was set, so a start it has moved on from is made from it. */
  const roomRef = useRef<string | undefined>(undefined);
  roomRef.current = roomConversationId;
  const [tiles, setTiles] = useState<MeetingTile[]>([]);
  const [videoSources, setVideoSources] = useState<string[]>([]);
  const videoPolicyRef = useRef<VideoPriorityBasedPolicy | null>(null);
  const [muted, setMuted] = useState(false);
  /**
   * THE PERSON'S MUTE, as every session reads it. A new session starts unmuted, so each session this provider builds (a
   * join, and every rejoin after it) applies this before it connects: a person who muted stays muted across a reconnect.
   */
  const mutedRef = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  /** The camera is on, for the device handlers the session's observer holds. */
  const cameraOnRef = useRef(false);
  cameraOnRef.current = cameraOn;
  const [deviceIds, setDeviceIds] = useState<Partial<Record<MeetingDeviceKind, string>>>({});
  /** The devices in use, for the session's device handlers; `deviceIds` renders them. */
  const deviceIdsRef = useRef<Partial<Record<MeetingDeviceKind, string>>>({});
  const [sharing, setSharing] = useState(false);
  const [share, setShare] = useState<ShareStarted | undefined>();
  const [attendees, setAttendees] = useState<MeetingAttendee[]>([]);
  const [leftPersonIds, setLeftPersonIds] = useState<string[]>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<string | undefined>();
  /** Takes the active-speaker and presence subscriptions off the live session. */
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const sessionRef = useRef<DefaultMeetingSession | null>(null);
  /** The live session's device controller, which holds the microphone and camera until teardown releases them. */
  const deviceControllerRef = useRef<DefaultDeviceController | null>(null);
  /** The live session's observer, kept so teardown can take it off again. */
  const observerRef = useRef<AudioVideoObserver | null>(null);
  /** The live session's content-share observer, so a share the browser stops is reflected in the control. */
  const contentShareObserverRef = useRef<ContentShareObserver | null>(null);
  /**
   * THE MICROPHONE A SPOKEN NOTICE HOLDS (`announce`): the live session's microphone muted while a notice plays, then
   * returned to the person's own state (`mutedRef`, which a host's hold also sets).
   */
  const [noticeHolding, setNoticeHolding] = useState(false);
  const [noticeHold] = useState(() => createNoticeMicHold(() => {
    const av = sessionRef.current?.audioVideo;
    return av ? { personMuted: () => mutedRef.current, mute: () => av.realtimeMuteLocalAudio(), unmute: () => { av.realtimeUnmuteLocalAudio(); } } : null;
  }, (held) => {
    if (mountedRef.current) setNoticeHolding(held);
    // WHAT THE PERSON PRESSED WHILE THE NOTICE PLAYED IS REPORTED WHEN IT ENDS: a mute pressed meanwhile changes nothing
    // on a microphone the notice already holds, so the session says nothing of it, and it is said here.
    if (!held && sessionRef.current && reportedRef.current.muted !== mutedRef.current) {
      reportedRef.current.muted = mutedRef.current;
      reporterRef.current?.record(mutedRef.current ? 'audioMuted' : 'audioUnmuted');
    }
  }));
  /** The credentials a rejoin reuses. Kept for the life of the meeting; see the header. */
  const joinInfoRef = useRef<MeetingJoinInfo | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const hiddenAtRef = useRef<number | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pause before the next rejoin attempt (`meetingRecovery.ts`), cleared when the person leaves. */
  const rejoinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A REJOIN WAITS FOR THE PERSON OR THE NETWORK. Set when a rejoin found the browser offline, or a round of rejoins
   * gave up while the tab was hidden or offline: the tab coming back or the network returning starts a fresh round with
   * the same credentials, so a person who was away when the connection failed is back in the meeting when they return.
   */
  const recoverOnReturnRef = useRef(false);
  /**
   * The status the grace timer reads when it fires. A ref, not the effect's dependency: with `status`
   * as a dependency, the SDK turning to `reconnecting` inside the grace period - the case the timer
   * exists for - re-ran the effect, and its cleanup cancelled the timer before it could rejoin.
   */
  const statusRef = useRef<MeetingStatus>('idle');
  statusRef.current = status;
  const keepaliveRef = useRef<Keepalive | null>(null);
  /** What this app sees of the meeting, reported for its analytics (`meetingEventReporter.ts`), and its SDK observer. */
  const reporterRef = useRef<MeetingEventReporter | null>(null);
  /** The conversation whose meeting this session is in. */
  const channelArnRef = useRef<string | null>(null);
  /** The answer of a start made before the device check finished (`startNow`), kept for the join that follows it. */
  const startedInfoRef = useRef<{ channelArn: string; info: MeetingJoinInfo } | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  // THIS PERSON IS IN THE MEETING, said to their other windows (`meetingPresence.ts`), so the conversation's banner
  // offers no Join to someone already in it. Said under every name the meeting goes by (the conversation this window
  // entered from, the meeting's own conversation and its room), so whichever way the person came in, the room and the
  // meeting's conversation both see them in it. The browser lets go of it when this window closes.
  // ENTERING COUNTS: from the moment a start or a join is asked for (and while a start made here waits for the device
  // check), so the ring and the membership news the start or join itself causes never ring or offer Join to the person
  // who is entering it.
  const inMeeting = status === 'joined' || status === 'reconnecting';
  const present = inMeeting || status === 'joining' || startedHere;
  useEffect(() => {
    const arn = channelArnRef.current;
    if (!present || !arn) return undefined;
    return holdMeetingPresenceAs([conversationIdOf(arn), conversationId ?? '', roomConversationId ?? '']);
  }, [present, conversationId, roomConversationId]);
  const eventObserverRef = useRef<EventObserver | null>(null);
  /** The live session's device-change observer, which reports a device added or removed. */
  const deviceChangeObserverRef = useRef<DeviceChangeObserver | null>(null);
  /**
   * WHAT THIS MEETING HAS REPORTED of the person's own mute and devices, kept across a rejoin so a new session re-applying
   * the same mute or reopening the same microphone reports no change. The device ids stay here; only a class is sent.
   */
  const reportedRef = useRef<{ muted: boolean; audioinput: string | null; videoinput: string | null; audiooutput: boolean }>(
    { muted: false, audioinput: null, videoinput: null, audiooutput: false },
  );
  /** Report one event of this meeting, when there is a report to add it to. */
  const report = useCallback((name: string, attributes?: Record<string, unknown>) => reporterRef.current?.record(name, attributes), []);
  /** Guards every async continuation: a session can finish connecting after the room unmounted. */
  const mountedRef = useRef(true);
  // Hidden sink the mixed remote audio binds to.
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // Mounted is set in the effect body as well as the initial value, so a development remount (StrictMode) leaves it true.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      if (rejoinTimerRef.current) clearTimeout(rejoinTimerRef.current);
      keepaliveRef.current?.stop();
    };
  }, []);

  /**
   * Tear the local session down. Safe to call repeatedly and on a session that is already dead.
   *
   * A REJOIN KEEPS THE TAB AUDIBLE (`keepAudible`): the keepalive belongs to the meeting, not to one session, so the
   * rejoin's own pauses run on timers the browser does not throttle, in a backgrounded tab as in a visible one.
   */
  const teardown = useCallback((opts?: { keepAudible?: boolean }) => {
    const session = sessionRef.current;
    if (session) {
      try {
        // THE OBSERVER COMES OFF FIRST: a
        // rejoin builds a new session and registers a new observer, so without this the dead
        // session's observer stays registered and can still report a stop. That stop would be read
        // as the LIVE session dropping and trigger another rejoin, which drops the session somebody
        // is actually in - once per reconnect, compounding.
        if (observerRef.current) session.audioVideo.removeObserver(observerRef.current);
        if (contentShareObserverRef.current) session.audioVideo.removeContentShareObserver(contentShareObserverRef.current);
        if (eventObserverRef.current) session.eventController.removeObserver(eventObserverRef.current);
        if (deviceChangeObserverRef.current) session.audioVideo.removeDeviceChangeObserver(deviceChangeObserverRef.current);
        unsubscribeRef.current?.();
        // This person's last lines go with them.
        transcriptReporterRef.current?.flush();
        session.audioVideo.stopLocalVideoTile();
        session.audioVideo.stopContentShare();
        // A RECONNECT THE SDK HAS WAITING NEVER RUNS, and a session that starts again all the same is stopped the moment it
        // does: a torn-down session never holds this attendee in the meeting.
        cancelSdkReconnect(session);
        const ghost: AudioVideoObserver = {
          audioVideoDidStart: () => { try { session.audioVideo.stop(); } catch { /* already stopped */ } },
        };
        session.audioVideo.addObserver(ghost);
        session.audioVideo.stop();
        session.audioVideo.unbindAudioElement?.();
      } catch { /* tearing down anyway */ }
      // THE MICROPHONE AND CAMERA ARE RELEASED with the session: stopping the session leaves the devices captured, so
      // each input is stopped and the device controller destroyed, and the browser's capture indicator goes out.
      const av = session.audioVideo;
      const devices = deviceControllerRef.current;
      void (async () => {
        await av.stopAudioInput().catch(() => undefined);
        await av.stopVideoInput().catch(() => undefined);
        await devices?.destroy().catch(() => undefined);
      })();
    }
    deviceControllerRef.current = null;
    contentShareObserverRef.current = null;
    observerRef.current = null;
    eventObserverRef.current = null;
    deviceChangeObserverRef.current = null;
    unsubscribeRef.current = null;
    sessionRef.current = null;
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    if (opts?.keepAudible) return;
    keepaliveRef.current?.stop();
    keepaliveRef.current = null;
  }, []);

  // THE PROVIDER GOING AWAY ENDS THIS PERSON'S SESSION: losing sign-in, or an error boundary replacing the app, unmounts it,
  // and the microphone and camera are released with it rather than left live behind a screen that no longer shows them.
  useEffect(() => () => {
    void reporterRef.current?.flush();
    teardown();
  }, [teardown]);

  const leave = useCallback((): Promise<void> => {
    // WHAT IS WAITING IS SENT AS THE SESSION GOES, and the send is answered to a caller that can wait on it (`end`). One
    // that cannot, the meeting ending for everyone under this person, still has it kept: the server files the last batch
    // of a meeting that ended a moment ago from an attendee it created for the caller.
    const sent = reporterRef.current?.flush() ?? Promise.resolve();
    reporterRef.current = null;
    reportedRef.current = { muted: false, audioinput: null, videoinput: null, audiooutput: false };
    teardown();
    joinInfoRef.current = null;
    reconnectAttemptsRef.current = 0;
    if (rejoinTimerRef.current) { clearTimeout(rejoinTimerRef.current); rejoinTimerRef.current = null; }
    recoverOnReturnRef.current = false;
    setTiles([]);
    setVideoSources([]);
    setAttendees([]);
    setLeftPersonIds([]);
    mutedByHostRef.current = false;
    mutedByRoomRef.current = false;
    setMutedByHost(false);
    setMutedByRoom(false);
    setCaptions([]);
    setTranscribing(false);
    recordingTimeline.reset();
    setRecording(false);
    setRemovedIds([]);
    setSpeakRequests([]);
    setActiveSpeaker(undefined);
    setSharing(false);
    setCameraOn(false);
    deviceIdsRef.current = {};
    setDeviceIds({});
    mutedRef.current = false;
    setMuted(false);
    setClassification(undefined);
    setIsHost(false);
    setHostIds([]);
    setMayEnd(false);
    setConversationId(undefined);
    setRoomConversationId(undefined);
    setErrorCode(undefined);
    startedInfoRef.current = null;
    setStartedHere(false);
    setStatus('idle');
    return sent;
  }, [teardown, recordingTimeline]);

  /**
   * Bring up a live session from join information.
   *
   * Declared as a ref-held function because the rejoin path and the observer that triggers it refer
   * to each other: the observer is created inside this function and calls the rejoin, which calls
   * this function again.
   */
  const connectRef = useRef<(info: MeetingJoinInfo, opts?: { rejoin?: boolean }) => Promise<void>>(async () => {});
  const rejoinRef = useRef<() => Promise<void>>(async () => {});

  /**
   * PUT A DEVICE TO USE on the session: the one the person chose where it is
   * plugged in now, else the browser's default (`pickDevice`). A microphone with none plugged in leaves the session
   * without one, a camera with none turns the camera off, and the change is reported by its class only. Resolves the id
   * now in use.
   */
  const applyDeviceRef = useRef<(av: AudioVideoFacade, kind: MeetingDeviceKind, list?: MediaDeviceInfo[]) => Promise<string | undefined>>(
    async () => undefined,
  );
  applyDeviceRef.current = async (av, kind, list) => {
    const devices = list ?? await (kind === 'audioinput' ? av.listAudioInputDevices()
      : kind === 'videoinput' ? av.listVideoInputDevices() : av.listAudioOutputDevices());
    const id = pickDevice(devices, readDeviceChoices()[kind]);
    const deviceClass = id ? deviceClassOf(devices.find((d) => d.deviceId === id)?.label) : 'none';
    // A DEVICE OPENED FOR A SESSION THAT HAS SINCE GONE (torn down while it was opening) is closed again at once, so no
    // microphone or camera stays captured by a session nobody holds.
    const gone = () => sessionRef.current?.audioVideo !== av;
    if (kind === 'audioinput') {
      if (id) await av.startAudioInput(id);
      if (gone()) { await av.stopAudioInput().catch(() => undefined); return undefined; }
      if (reportedRef.current.audioinput !== (id ?? '')) {
        reportedRef.current.audioinput = id ?? '';
        report('audioInputChanged', { deviceClass });
      }
    } else if (kind === 'videoinput') {
      if (id) {
        await av.startVideoInput(id);
        if (gone()) { await av.stopVideoInput().catch(() => undefined); return undefined; }
        av.startLocalVideoTile();
      } else {
        av.stopLocalVideoTile();
        await av.stopVideoInput().catch(() => undefined);
      }
      if (mountedRef.current) setCameraOn(!!id);
      if (reportedRef.current.videoinput !== (id ?? null)) {
        reportedRef.current.videoinput = id ?? null;
        report('videoInputChanged', { deviceClass });
      }
    } else {
      await av.chooseAudioOutput(id ?? null);
    }
    deviceIdsRef.current = { ...deviceIdsRef.current, [kind]: id };
    if (mountedRef.current) setDeviceIds(deviceIdsRef.current);
    return id;
  };

  /**
   * A ROUND OF REJOINS GAVE UP: the session is released and the room says the connection was lost. Where the tab was
   * hidden or the browser offline, the person was not there to see it, so the tab or the network coming back starts a
   * fresh round (`recoverOnReturnRef`) rather than leaving them out of a meeting they never chose to leave.
   */
  const giveUp = () => {
    teardown();
    recoverOnReturnRef.current = tabHidden() || networkOffline();
    setErrorCode('CONNECTION_LOST');
    setStatus('error');
  };

  /**
   * THE MODE NOW, AS THE SERVICE SAYS IT, after a session came back (an app-level rejoin, or the SDK's own reconnect): a
   * host may have turned captions or recording on or off, or held or let go of this person's microphone, while it was
   * down, and the data message that said so reached only the sessions that were up. A recording that started meanwhile is
   * shown, and the room says it aloud, as a recording started in front of the person is.
   */
  const rereadModeRef = useRef<(info: MeetingJoinInfo) => void>(() => undefined);
  rereadModeRef.current = (info) => {
    const arn = channelArnRef.current;
    if (!arn) return;
    void meetingService.status(arn).then((s) => {
      if (!mountedRef.current || joinInfoRef.current !== info || !s.running) return;
      if (typeof s.transcribing === 'boolean') {
        setTranscribing(s.transcribing);
        if (!s.transcribing) setCaptions([]);
      }
      if (typeof s.recording === 'boolean') applyRecording(s.recording);
      if (typeof s.mediaRecording === 'boolean') setMediaRecording(s.mediaRecording);
      if (typeof s.mutedByHost === 'boolean' && s.mutedByHost !== (mutedByHostRef.current && !mutedByRoomRef.current)) holdMuteRef.current(s.mutedByHost);
    }).catch(() => undefined);
  };

  rejoinRef.current = async () => {
    const info = joinInfoRef.current;
    // One rejoin at a time: a stop reported while an attempt is pausing is the same loss, already being recovered.
    if (!mountedRef.current || !info || rejoinTimerRef.current) return;
    // NO NETWORK, NO ATTEMPT: a rejoin while the browser is offline cannot connect, and would spend the round and drop
    // the person. It waits, reconnecting, for the network to return (the `online` listener below).
    if (networkOffline()) {
      recoverOnReturnRef.current = true;
      setStatus('reconnecting');
      return;
    }
    if (reconnectAttemptsRef.current >= MAX_REJOIN_ATTEMPTS) {
      giveUp();
      return;
    }
    reconnectAttemptsRef.current += 1;
    setStatus('reconnecting');
    // The dead session is torn down before the new one: two sessions on one meeting would both hold
    // devices and both publish. The keepalive stays, so the pause below is not throttled in a hidden tab.
    teardown({ keepAudible: true });
    // THE NEW SESSION STARTS FROM NOTHING: its tiles are numbered afresh and it re-announces who is present, so the dead
    // session's tiles and roster go, and the camera and screen share, which the new session does not send, read as off.
    // The mute is the exception, carried by `mutedRef` and applied before the new session connects.
    setTiles([]);
    setVideoSources([]);
    setAttendees([]);
    setActiveSpeaker(undefined);
    setCameraOn(false);
    setSharing(false);
    // THE PAUSE BEFORE CONNECTING (`rejoinDelayMs`): the dead session's leave reaches the
    // service before the same attendee joins again, and each failed attempt waits longer than the last. A leave, or a
    // new join, during the pause ends this attempt.
    await new Promise<void>((resolve) => { rejoinTimerRef.current = setTimeout(resolve, rejoinDelayMs(reconnectAttemptsRef.current)); });
    rejoinTimerRef.current = null;
    if (!mountedRef.current || joinInfoRef.current !== info) return;
    if (networkOffline()) {
      recoverOnReturnRef.current = true;
      return;
    }
    try {
      // The SAME credentials, so no attendee is created and the roster does not grow per reconnect. The attempt count is
      // reset only when the SDK reports the session started (`audioVideoDidStart`), so a connection that never comes up
      // counts toward the cap and ends at CONNECTION_LOST.
      await connectRef.current(info, { rejoin: true });
      rereadModeRef.current(info);
    } catch (e) {
      if (!mountedRef.current) return;
      if (meetingIsGone(e)) {
        // Nothing to reconnect to. Reported as the meeting having ended rather than as a failure.
        leave();
        setErrorCode('NO_ACTIVE_MEETING');
        setStatus('error');
        return;
      }
      if (reconnectAttemptsRef.current < MAX_REJOIN_ATTEMPTS) {
        await rejoinRef.current();
        return;
      }
      giveUp();
    }
  };

  connectRef.current = async (info: MeetingJoinInfo, opts?: { rejoin?: boolean }) => {
    joinInfoRef.current = info;
    const logger = new ConsoleLogger('AEMeeting', LogLevel.WARN);
    const deviceController = new DefaultDeviceController(logger);
    const configuration = new MeetingSessionConfiguration(info.meeting, info.attendee);
    // ONLY THE VIDEOS ON SCREEN ARE RECEIVED: the priority-based policy subscribes to the ones the layout chooses
    // (`useVideoSubscriptions.ts`), and pauses the lowest priority first when the network cannot carry them all.
    const videoPolicy = new VideoPriorityBasedPolicy(logger);
    configuration.videoDownlinkBandwidthPolicy = videoPolicy;
    videoPolicyRef.current = videoPolicy;
    const session = new DefaultMeetingSession(configuration, logger, deviceController);
    sessionRef.current = session;
    deviceControllerRef.current = deviceController;
    const av = session.audioVideo;
    // This session's connectivity sampler, set once the meeting's report exists (below).
    let sampler: ConnectivitySampler | null = null;
    /** This session is still the one the person is in: a leave, an end or a rejoin during an await below replaced it. */
    const current = () => mountedRef.current && sessionRef.current === session;
    /** The SDK is reconnecting this session itself, so its next start is a return from a reconnect. */
    let sdkReconnecting = false;

    const observer: AudioVideoObserver = {
      // THE CONNECTION, as the SDK measures it each second and judges it: sampled to one reading per interval, and a change
      // of health reported the moment it happens (`meetingConnectivity.ts`).
      metricsDidReceive: (metricReport) => sampler?.metrics(metricReport),
      connectionDidBecomePoor: () => sampler?.becamePoor(),
      connectionDidBecomeGood: () => sampler?.becameGood(),
      connectionDidSuggestStopVideo: () => sampler?.suggestedStopVideo(),
      // Amazon Chime SDK tiles mapped onto our list. Each <video> is bound to its tile by the grid's
      // ref callback once it mounts, because the element does not exist when the tile is announced.
      videoTileDidUpdate: (tileState: VideoTileState) => {
        if (tileState.tileId == null || !tileState.boundAttendeeId) return;
        const next: MeetingTile = {
          tileId: tileState.tileId,
          attendeeId: tileState.boundAttendeeId,
          isLocal: Boolean(tileState.localTile),
          isContent: Boolean(tileState.isContent),
          paused: Boolean(tileState.paused),
        };
        setTiles((prev) => {
          const existing = prev.find((t) => t.tileId === next.tileId);
          if (existing) {
            // The SDK re-announces a tile on every state change; an unchanged one keeps the same array,
            // so the grid does not re-render for nothing.
            if (existing.attendeeId === next.attendeeId && existing.isLocal === next.isLocal
              && existing.isContent === next.isContent && !!existing.paused === next.paused) return prev;
            return prev.map((t) => (t.tileId === next.tileId ? next : t));
          }
          return [...prev, next];
        });
      },
      // The remote videos published, for the layout to choose among; an unchanged list keeps the same array.
      remoteVideoSourcesDidChange: (sources: VideoSource[]) => {
        if (!mountedRef.current) return;
        const ids = [...new Set(sources.map((v) => v.attendee.attendeeId))].sort();
        setVideoSources((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids));
      },
      videoTileWasRemoved: (tileId: number) => {
        setTiles((prev) => prev.filter((t) => t.tileId !== tileId));
      },
      // The SDK recovering by itself is reported, so the room can say so rather than looking frozen.
      audioVideoDidStartConnecting: (reconnecting: boolean) => {
        if (!reconnecting) return;
        sdkReconnecting = true;
        if (mountedRef.current) setStatus('reconnecting');
      },
      audioVideoDidStart: () => {
        if (!mountedRef.current) return;
        // The mute is applied again once connected, so the session sends nothing a muted person did not choose to send.
        if (mutedRef.current || noticeHold.held()) av.realtimeMuteLocalAudio();
        if (mutedByHostRef.current) av.realtimeSetCanUnmuteLocalAudio(false);
        reconnectAttemptsRef.current = 0;
        setStatus('joined');
        // BACK FROM THE SDK'S OWN RECONNECT: what was said on the data channel while it was down is read from the service.
        if (sdkReconnecting) {
          sdkReconnecting = false;
          rereadModeRef.current(info);
        }
      },
      audioVideoDidStop: (sessionStatus: MeetingSessionStatus) => {
        if (!mountedRef.current) return;
        // THE PERSON'S OUTCOME IS NOT A FAILURE TO RECOVER FROM (`stopOutcome`, `meetingRecovery.ts`): this person leaving,
        // the meeting ending for everyone, and the service refusing the attendee are left, and a refusal is said, not
        // dropped. Every other stop, the SDK's terminal transport stops included, is rejoined with the same credentials.
        const outcome = stopOutcome(sessionStatus);
        if (outcome === 'leave') {
          const code = terminalStopCode(sessionStatus.statusCode());
          leave();
          if (code) { setErrorCode(code); setStatus('error'); }
          return;
        }
        if (outcome === 'rejoin') { void rejoinRef.current(); }
      },
    };
    observerRef.current = observer;
    av.addObserver(observer);
    // A share the browser ends (its own "Stop sharing" bar, or the shared window closing) turns the control off too.
    const contentShareObserver: ContentShareObserver = {
      contentShareDidStop: () => { if (mountedRef.current) setSharing(false); },
    };
    contentShareObserverRef.current = contentShareObserver;
    av.addContentShareObserver(contentShareObserver);

    // WHAT THIS APP SEES OF THE MEETING, for its analytics: one reporter per meeting, kept across a rejoin, which reuses
    // the same attendee.
    if (!reporterRef.current && channelArnRef.current) {
      const channelArn = channelArnRef.current;
      const attendeeId = info.attendee.AttendeeId;
      reporterRef.current = createMeetingEventReporter((events) => meetingService.reportEvents(channelArn, attendeeId, events));
    }
    const reporter = reporterRef.current;
    if (reporter) {
      const eventObserver: EventObserver = {
        eventDidReceive: (name, attributes) => reporter.record(name, attributes as unknown as Record<string, unknown>),
      };
      eventObserverRef.current = eventObserver;
      session.eventController.addObserver(eventObserver);
      sampler = createConnectivitySampler(reporter.record, { selfAttendeeId: info.attendee.AttendeeId });
      // A DEVICE ADDED OR REMOVED: how many of its kind the browser now lists, never which ones.
      // THE DEVICE IN USE FOLLOWS THE LIST: one unplugged gives way to the default, and the person's chosen device is
      // used again once it is plugged back in. A camera that is off stays off.
      const follow = async (kind: MeetingDeviceKind, list?: MediaDeviceInfo[]) => {
        if (!mountedRef.current || sessionRef.current !== session) return;
        if (kind === 'videoinput' && !cameraOnRef.current) return;
        if (list && pickDevice(list, readDeviceChoices()[kind]) === deviceIdsRef.current[kind]) return;
        try {
          await applyDeviceRef.current(av, kind, list);
          if (kind === 'audioinput' && (mutedRef.current || noticeHold.held())) av.realtimeMuteLocalAudio();
        } catch (e) {
          if (isPermissionDenied(e)) reporter.record('devicePermissionDenied', { deviceKind: kind });
        }
      };
      const devicesChanged = (deviceKind: MeetingDeviceKind) => (list?: MediaDeviceInfo[]) => {
        reporter.record('devicesChanged', { deviceKind, deviceCount: list?.length ?? 0 });
        if (list) void follow(deviceKind, list);
      };
      // A device in use that goes away releases its input, and the default takes its place.
      const deviceChangeObserver: DeviceChangeObserver = {
        audioInputsChanged: devicesChanged('audioinput'),
        videoInputsChanged: devicesChanged('videoinput'),
        audioOutputsChanged: devicesChanged('audiooutput'),
        audioInputStreamEnded: () => {
          reportedRef.current.audioinput = null;
          reporter.record('audioInputChanged', { deviceClass: 'none' });
          void follow('audioinput');
        },
        videoInputStreamEnded: () => {
          reportedRef.current.videoinput = null;
          reporter.record('videoInputChanged', { deviceClass: 'none' });
          void follow('videoinput');
        },
      };
      deviceChangeObserverRef.current = deviceChangeObserver;
      av.addDeviceChangeObserver(deviceChangeObserver);
    }

    // WHO IS HERE, camera or not, so the grid has a tile for everyone (a shared screen joins as its own attendee and is
    // left to its video tile), and WHO IS SPEAKING, which the speaker layout puts on the stage.
    // EACH ATTENDEE'S MUTE AND SIGNAL, as the service reports their audio, for the meeting's roster. The service reports
    // every change of volume too; the attendees change only when the mute or the signal does.
    const audioOf = (attendeeId: string, _volume: number | null, muted: boolean | null, signalStrength: number | null) => {
      if (!mountedRef.current || (muted === null && signalStrength === null)) return;
      setAttendees((prev) => {
        const at = prev.find((x) => x.attendeeId === attendeeId);
        if (!at) return prev;
        const next = {
          ...at,
          ...(muted !== null ? { muted } : {}),
          ...(signalStrength !== null ? { weakSignal: signalStrength < 0.5 } : {}),
        };
        return next.muted === at.muted && next.weakSignal === at.weakSignal ? prev : prev.map((x) => (x === at ? next : x));
      });
    };
    const heard = new Set<string>();
    const presence = (attendeeId: string, present: boolean, externalUserId?: string) => {
      // A SERVICE ATTENDEE IS NOBODY IN THE MEETING: the media capture pipeline that records it joins with an `aws:`
      // external user id, and is never a tile, a roster row or a person who left.
      if (!mountedRef.current || attendeeId.includes('#content') || externalUserId?.startsWith('aws:')) return;
      setAttendees((prev) => {
        const without = prev.filter((a) => a.attendeeId !== attendeeId);
        return present ? [...without, { attendeeId, personId: externalUserId || '' }] : without;
      });
      // A person who goes is marked as left and one who comes back is not. Whether they are in the meeting now is read
      // from the attendees, so a person still present on another attendee reads as in it.
      if (externalUserId) {
        setLeftPersonIds((prev) => {
          const has = prev.includes(externalUserId);
          if (present) return has ? prev.filter((id) => id !== externalUserId) : prev;
          return has ? prev : [...prev, externalUserId];
        });
      }
      if (present && !heard.has(attendeeId)) {
        heard.add(attendeeId);
        av.realtimeSubscribeToVolumeIndicator(attendeeId, audioOf);
      } else if (!present && heard.delete(attendeeId)) {
        av.realtimeUnsubscribeFromVolumeIndicator(attendeeId, audioOf);
      }
    };
    av.realtimeSubscribeToAttendeeIdPresence(presence);
    const policy = new DefaultActiveSpeakerPolicy();
    const onSpeakers = (ids: string[]) => { if (mountedRef.current) setActiveSpeaker(ids[0]); };
    av.subscribeToActiveSpeakerDetector(policy, onSpeakers);
    // THE PERSON'S OWN MUTE, as the session applies it: reported when it changes, so a rejoin re-applying it reports nothing.
    const onMute = (muted: boolean) => {
      // A spoken notice's hold is not the person muting.
      if (noticeHold.held() || reportedRef.current.muted === muted) return;
      reportedRef.current.muted = muted;
      report(muted ? 'audioMuted' : 'audioUnmuted');
    };
    av.realtimeSubscribeToMuteAndUnmuteLocalAudio(onMute);
    // THE MEETING'S TRANSCRIPTION (FR28): its status for the room's indicator, and this
    // person's own final lines, reported as their own attendee.
    const selfAttendeeId = info.attendee.AttendeeId;
    const transcriptArn = channelArnRef.current;
    if (transcriptArn && !transcriptReporterRef.current) {
      transcriptReporterRef.current = createTranscriptReporter((segments) => meetingService.reportTranscript(transcriptArn, selfAttendeeId, segments));
    }
    const onTranscript = (event: TranscriptEvent) => {
      if (!mountedRef.current) return;
      const read = readTranscriptEvent(event, selfAttendeeId);
      if (read.transcribing !== undefined) {
        setTranscribing(read.transcribing);
        if (!read.transcribing) { setCaptions([]); applyRecording(false); }
      }
      if (read.captions.length) setCaptions((shown) => nextCaptions(shown, read.captions));
      // KEPT BY WHEN IT WAS SAID: a line begun while the meeting was recorded is sent, one begun under captions alone is
      // not (the server refuses those as well), whenever the service finished it.
      const kept = read.own.filter((line) => recordingTimeline.recordedAt(line.startMs));
      if (kept.length) transcriptReporterRef.current?.add(kept);
    };
    av.transcriptionController?.subscribeToTranscriptEvent(onTranscript);
    // A HOST'S CHANGE OF MODE, said on the meeting's data channel and read only from a host the join answered.
    const onMode = (message: { senderExternalUserId: string; text(): string }) => {
      if (!mountedRef.current || !hostIdsRef.current.includes(message.senderExternalUserId)) return;
      const mode = transcriptionModeOf(message.text());
      if (!mode) return;
      applyRecording(mode.recording);
      setTranscribing(mode.on);
    };
    av.realtimeSubscribeToReceiveDataMessage?.(TRANSCRIPTION_TOPIC, onMode);
    unsubscribeRef.current = () => {
      av.realtimeUnsubscribeFromReceiveDataMessage?.(TRANSCRIPTION_TOPIC);
      av.transcriptionController?.unsubscribeFromTranscriptEvent(onTranscript);
      av.realtimeUnsubscribeToAttendeeIdPresence(presence);
      heard.forEach((id) => av.realtimeUnsubscribeFromVolumeIndicator(id, audioOf));
      av.unsubscribeFromActiveSpeakerDetector(onSpeakers);
      av.realtimeUnsubscribeToMuteAndUnmuteLocalAudio(onMute);
    };

    // No microphone, or a refused permission, is NOT a failed join: somebody can still watch and listen.
    // The microphone is the one the person chose before joining (`MeetingPreJoin`), where it is plugged in, else the default.
    try {
      await applyDeviceRef.current(av, 'audioinput');
    } catch (e) {
      // Joining without a mic is a valid way to attend; a refused permission is reported as such.
      if (isPermissionDenied(e)) report('devicePermissionDenied', { deviceKind: 'audioinput' });
    }
    // A SESSION TORN DOWN WHILE IT WAS BEING BROUGHT UP NEVER STARTS: the person left, ended the meeting, or a rejoin
    // replaced it, so it joins nobody to the meeting. Checked after every await before the start.
    if (!current()) return;
    // A MUTED PERSON JOINS MUTED: applied to the microphone before the session starts, so the track is disabled and the
    // service is told "muted" from the first packet, on a rejoin as on a first join.
    if (mutedRef.current || noticeHold.held()) av.realtimeMuteLocalAudio();
    if (mutedByHostRef.current) av.realtimeSetCanUnmuteLocalAudio(false);
    try {
      if (audioElRef.current) {
        await av.bindAudioElement(audioElRef.current);
        // The output is the speaker the person chose where it is plugged in, else the browser's default, reported once
        // per meeting by its class.
        const outputs = await av.listAudioOutputDevices().catch(() => [] as MediaDeviceInfo[]);
        const out = pickDevice(outputs, readDeviceChoices().audiooutput);
        if (out && out !== 'default') await av.chooseAudioOutput(out);
        deviceIdsRef.current = { ...deviceIdsRef.current, audiooutput: out };
        if (mountedRef.current) setDeviceIds(deviceIdsRef.current);
        if (!reportedRef.current.audiooutput) {
          reportedRef.current.audiooutput = true;
          const used = outputs.find((d) => d.deviceId === out);
          report('audioOutputChanged', { deviceClass: deviceClassOf(used?.label) });
        }
      }
    } catch { /* output binding is best effort */ }
    if (!current()) return;

    av.start();

    // Started AFTER the session, so a tab backgrounded mid-meeting keeps its timers. One per meeting: a rejoin keeps the
    // one playing (`teardown({ keepAudible })`) and starts none beside it, and one started for a session that went while
    // it started is stopped again.
    if (!keepaliveRef.current) {
      const keepalive = await startKeepalive();
      if (keepaliveRef.current || !current()) keepalive.stop();
      else keepaliveRef.current = keepalive;
    }

    if (!current()) return;
    setClassification(info.classification);
    setIsHost(!!info.isHost);
    setHostIds(Array.isArray(info.hostIds) ? info.hostIds : []);
    setMayEnd(!!info.mayEnd);
    // THE MODE THE JOIN ANSWERED holds for the session it was answered for. A rejoin reuses that answer's credentials, so
    // its mode is the one the meeting had then; the rejoin reads the mode now instead (`rejoinRef`).
    if (!opts?.rejoin) {
      setTranscribing(!!info.transcribing);
      // Recorded since the join: every line this person says from here is recorded.
      applyRecording(!!info.recording, 0);
    }
    setMediaRecording(!!info.mediaRecording);
    hostIdsRef.current = Array.isArray(info.hostIds) ? info.hostIds : [];
    setRemovedIds(Array.isArray(info.removedIds) ? info.removedIds : []);
    setSpeakRequests(Array.isArray(info.speakRequests) ? info.speakRequests : []);
    if (info.conversationId) setConversationId(info.conversationId);
    if (info.roomConversationId) setRoomConversationId(info.roomConversationId);
    // JOINED IS SAID BY THE SDK (`audioVideoDidStart`), once the session is connected: a session still connecting reads
    // as joining or reconnecting, never as joined.
  };

  const enter = useCallback(async (
    channelArn: string,
    askedCall: (arn: string) => Promise<MeetingJoinInfo>,
  ) => {
    // A START THIS WINDOW ALREADY MADE (`startNow`) is joined with its own answer: the meeting is running, and the
    // service is not asked again. It is the same meeting whichever of its names the window now enters by.
    const kept = startedInfoRef.current;
    const keptFits = !!kept && (kept.channelArn === channelArn
      || conversationIdOf(channelArn) === kept.info.conversationId || conversationIdOf(channelArn) === kept.info.roomConversationId);
    const call = keptFits ? () => Promise.resolve(kept.info) : askedCall;
    startedInfoRef.current = null;
    setStartedHere(false);
    setStatus('joining');
    setErrorCode(undefined);
    reconnectAttemptsRef.current = 0;
    if (rejoinTimerRef.current) { clearTimeout(rejoinTimerRef.current); rejoinTimerRef.current = null; }
    recoverOnReturnRef.current = false;
    // A new meeting entry starts a new report; a rejoin inside it keeps the one it has.
    channelArnRef.current = channelArn;
    reporterRef.current = null;
    transcriptReporterRef.current = null;
    reportedRef.current = { muted: mutedRef.current, audioinput: null, videoinput: null, audiooutput: false };
    // A NEW ENTRY CARRIES NOTHING OF THE LAST MEETING: a hold the last one placed (a join that ended in an error never
    // passes through `leave`), and its captions and mode, which this meeting's join answers afresh.
    mutedByHostRef.current = false;
    mutedByRoomRef.current = false;
    setMutedByHost(false);
    setMutedByRoom(false);
    setCaptions([]);
    setTranscribing(false);
    recordingTimeline.reset();
    setRecording(false);
    try {
      const info = await call(channelArn);
      // THE MEETING'S OWN CONVERSATION IS NAMED AS SOON AS THE ANSWER ARRIVES, before the session connects, so the window
      // opens that conversation's chat while the audio and video come up, never the room the meeting was entered from.
      if (mountedRef.current && info.conversationId) setConversationId(info.conversationId);
      if (mountedRef.current && info.roomConversationId) setRoomConversationId(info.roomConversationId);
      // THE PERSON'S OWN PRE-JOIN CHOICES (`MeetingPreJoin`): joining muted only ever adds to the
      // server's rule below, which it cannot lift, and the camera opens once the session does unless they chose it off.
      const chosen = readDeviceChoices();
      if (chosen.joinMuted) {
        mutedRef.current = true;
        setMuted(true);
      }
      // THE SERVER DECIDES WHO JOINS MUTED (SPEC-ASSISTANT-MEETINGS FR51): a person outside the room's speaking roles enters
      // with the microphone off, applied before the first session connects. They may unmute, and a rejoin keeps their choice.
      if (info.startMuted) {
        mutedRef.current = true;
        setMuted(true);
      }
      // A HOST STOPPED THEIR AUDIO before this join (the service's attendee says so): they enter muted and held.
      if (info.mutedByHost) {
        mutedRef.current = true;
        mutedByHostRef.current = true;
        setMuted(true);
        setMutedByHost(true);
      } else if (info.receiveOnly) {
        // THE SERVICE CARRIES NONE OF THEIR AUDIO until they ask to speak: the microphone is held to match.
        mutedRef.current = true;
        mutedByHostRef.current = true;
        mutedByRoomRef.current = true;
        setMuted(true);
        setMutedByRoom(true);
      }
      await connectRef.current(info);
      const av = sessionRef.current?.audioVideo;
      if (!chosen.cameraOff && av && mountedRef.current) {
        // Best effort: a camera that cannot open leaves the person in the meeting, camera off.
        try {
          const cams = await av.listVideoInputDevices();
          if (cams.length) await applyDeviceRef.current(av, 'videoinput', cams);
        } catch (e) {
          if (isPermissionDenied(e)) report('devicePermissionDenied', { deviceKind: 'videoinput' });
        }
      }
    } catch (e) {
      teardown();
      joinInfoRef.current = null;
      setErrorCode(codeOf(e, 'JOIN_FAILED'));
      setStatus('error');
    }
  }, [teardown, report, recordingTimeline]);

  // A START THAT CREATED THE MEETING RINGS THE ROOM'S CONNECTED MEMBERS (`meetingRing.ts`), and an end stops the ring:
  // both are sent by the platform as the room's assistant, the one sender a ring is honored from, never by this app.
  const start = useCallback(
    (channelArn: string) => enter(channelArn, (arn) => meetingService.startMeeting(arn, roomRef.current)),
    [enter],
  );
  const join = useCallback(
    (channelArn: string) => enter(channelArn, meetingService.joinMeeting),
    [enter],
  );

  // THE MEETING STARTS WHEN THE PERSON PRESSES START, as the sibling project creates the meeting before its pre-join
  // screen and joins with the answer it kept: the service creates it now (the room's card and ring follow from its
  // start), this person is added to its own conversation, and the window opens that conversation's chat. The device
  // check then joins the meeting already running with the answer kept here (`enter`).
  const startNow = useCallback(async (channelArn: string): Promise<boolean> => {
    setErrorCode(undefined);
    channelArnRef.current = channelArn;
    try {
      // A WINDOW KEPT OPEN ACROSS MEETINGS starts from the parent conversation once its parent conversation has moved on (`MEETING_MOVED`).
      const info = await meetingService.startMeeting(channelArn, roomRef.current);
      if (!mountedRef.current) return false;
      startedInfoRef.current = { channelArn, info };
      if (info.conversationId) setConversationId(info.conversationId);
      if (info.roomConversationId) setRoomConversationId(info.roomConversationId);
      setIsHost(!!info.isHost);
      setHostIds(Array.isArray(info.hostIds) ? info.hostIds : []);
      setMayEnd(!!info.mayEnd);
      setStartedHere(true);
      return true;
    } catch (e) {
      startedInfoRef.current = null;
      setStartedHere(false);
      setErrorCode(codeOf(e, 'JOIN_FAILED'));
      setStatus('error');
      return false;
    }
  }, []);

  const end = useCallback(async (channelArn: string): Promise<boolean> => {
    // The local session is torn down FIRST, so a failed server call still leaves this person out of a
    // meeting they asked to leave. Ending it for everybody is the part that can fail.
    // THE LAST BATCH IS SENT FIRST AND THE END AT ONCE: nothing waits on the batch, so a window closed right after End still
    // sent the end, and the server keeps a verified attendee's batch that lands just after the meeting ended.
    void leave();
    try {
      await meetingService.endMeeting(channelArn);
      return true;
    } catch (e) {
      setErrorCode(codeOf(e, 'END_FAILED'));
      setStatus('error');
      return false;
    }
  }, [leave]);

  /** The current `leave`, for the page listeners bound once below. */
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  // THE WINDOW'S SIGN-IN ENDING ENDS THIS PERSON'S PART IN THE MEETING: a sign-out, a refresh the issuer refused or a
  // token that expired stops the microphone, the camera and the meeting's audio, and forgets the attendee, so nobody who
  // signs in next in this window is ever in the meeting as the person who was.
  useEffect(() => onSessionEnd(() => { leaveRef.current(); }), []);

  /**
   * Check the session when the tab comes back, and rejoin only if it is actually degraded.
   *
   * Bound for the life of the provider rather than only while joined: the listener has to be in place
   * BEFORE the tab is hidden, and a hidden tab cannot add one.
   */
  useEffect(() => {
    /**
     * A ROUND THAT WAITED FOR THE PERSON OR THE NETWORK STARTS AGAIN once both are back: a fresh count of attempts, the
     * same credentials, so no attendee is created. True when a round was started.
     */
    const recoverWhenBack = (): boolean => {
      if (!recoverOnReturnRef.current || !joinInfoRef.current || !mountedRef.current || networkOffline()) return false;
      recoverOnReturnRef.current = false;
      reconnectAttemptsRef.current = 0;
      setErrorCode(undefined);
      void rejoinRef.current();
      return true;
    };
    // THE NETWORK CAME BACK: a rejoin that waited for it runs now, in a hidden tab as in a visible one.
    const onOnline = () => { recoverWhenBack(); };
    // THE PAGE IS GOING AWAY: the session is stopped, so the
    // service records this person leaving now, rather than a drop once their connection times out. `pagehide` fires
    // only once the page is really unloading, never for a leave the person cancelled.
    const onPageHide = () => { if (sessionRef.current || joinInfoRef.current) leaveRef.current(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenFor = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      hiddenAtRef.current = null;
      // THE MEETING IS HEARD AGAIN: whatever the browser paused while the tab was away (the meeting's audio, the
      // keepalive) plays again, before any check, since a session that is fine is the usual case.
      if (sessionRef.current) {
        resumePlayback(audioElRef.current);
        keepaliveRef.current?.resume();
      }
      // A connection lost while the person was away is recovered now they are back.
      if (recoverWhenBack()) return;
      // Nothing to check without a live session, and a blink of hiddenness breaks nothing.
      if (hiddenFor <= HIDDEN_CHECK_THRESHOLD_MS) return;
      if (!sessionRef.current || !joinInfoRef.current) return;

      // A returning tab reports healthy before anything crosses the connection, so the SDK is given
      // time to notice a connection that died while hidden, and only a session still degraded
      // afterwards is rejoined. Checking immediately would pass on a dead session every time.
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        if (!mountedRef.current || !joinInfoRef.current) return;
        // Still reconnecting after the grace period means the SDK's own recovery is not getting
        // there, which is the case this rejoin exists for.
        if (!sessionRef.current || statusRef.current === 'reconnecting') void rejoinRef.current();
      }, STALE_DETECTION_GRACE_MS);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
      if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    };
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    // A microphone a host holds stays muted until a host lets the person speak.
    if (!next && mutedByHostRef.current) return;
    mutedRef.current = next;
    const av = sessionRef.current?.audioVideo;
    if (av) {
      if (next) av.realtimeMuteLocalAudio();
      // An unmute while a spoken notice plays takes effect when the notice ends (`noticeHold`).
      else if (!noticeHold.held()) av.realtimeUnmuteLocalAudio();
    }
    setMuted(next);
  }, [noticeHold]);

  const holdMute = useCallback((held: boolean, by: 'host' | 'room' = 'host') => {
    mutedByHostRef.current = held;
    mutedByRoomRef.current = held && by === 'room';
    setMutedByHost(held && by === 'host');
    setMutedByRoom(held && by === 'room');
    const av = sessionRef.current?.audioVideo;
    if (held) {
      mutedRef.current = true;
      setMuted(true);
      av?.realtimeMuteLocalAudio();
    }
    av?.realtimeSetCanUnmuteLocalAudio(!held);
  }, []);
  const holdMuteRef = useRef(holdMute);
  holdMuteRef.current = holdMute;

  /** A control that failed has now worked: its failure is put away; any other stays. */
  const clearControlError = useCallback((codes: readonly string[]) => {
    setErrorCode((now) => (now && codes.includes(now) ? undefined : now));
  }, []);
  /** The code a refused transcription change set, so the next change that works puts it away. */
  const transcriptionErrorRef = useRef<string | undefined>(undefined);

  const toggleCamera = useCallback(async () => {
    const av = sessionRef.current?.audioVideo;
    if (!av) return;
    if (cameraOn) {
      av.stopLocalVideoTile();
      await av.stopVideoInput().catch(() => undefined);
      setCameraOn(false);
      reportedRef.current.videoinput = null;
      report('videoInputChanged', { deviceClass: 'none' });
      return;
    }
    try {
      // The camera the person chose, where it is plugged in, else the default.
      const cams = await av.listVideoInputDevices();
      if (!cams.length) { setErrorCode('CAMERA_UNAVAILABLE'); return; }
      const opened = await applyDeviceRef.current(av, 'videoinput', cams);
      if (opened) clearControlError(CONTROL_ERRORS.camera);
    } catch (e) {
      if (isPermissionDenied(e)) report('devicePermissionDenied', { deviceKind: 'videoinput' });
      // The meeting is still up, so this reports the control that failed rather than failing the room.
      setErrorCode('CAMERA_UNAVAILABLE');
    }
  }, [cameraOn, report, clearControlError]);

  /**
   * ANOTHER DEVICE, MID-MEETING: remembered as the person's choice,
   * then put to use. A muted microphone stays muted on the new one, and a camera that is off stays off and opens on the
   * chosen camera when turned on.
   */
  const chooseDevice = useCallback(async (kind: MeetingDeviceKind, deviceId: string) => {
    saveDeviceChoices({ [kind]: deviceId });
    const av = sessionRef.current?.audioVideo;
    if (!av || (kind === 'videoinput' && !cameraOnRef.current)) return;
    try {
      await applyDeviceRef.current(av, kind);
      if (kind === 'audioinput' && (mutedRef.current || noticeHold.held())) av.realtimeMuteLocalAudio();
      clearControlError(CONTROL_ERRORS.device);
    } catch (e) {
      if (isPermissionDenied(e)) report('devicePermissionDenied', { deviceKind: kind });
      setErrorCode(kind === 'videoinput' ? 'CAMERA_UNAVAILABLE' : 'DEVICE_UNAVAILABLE');
    }
  }, [report, noticeHold, clearControlError]);

  const toggleShare = useCallback(async () => {
    const av = sessionRef.current?.audioVideo;
    if (!av) return;
    if (sharing) {
      // `stopContentShare` is synchronous in this SDK version, so it is guarded rather than awaited.
      try { av.stopContentShare(); } catch { /* already stopped */ }
      setSharing(false);
      return;
    }
    // THE MEETING IS UNTOUCHED BY THE PICKER: a dismissed picker changes nothing, and a share that cannot start says so
    // beside the controls while the person stays in the meeting (`services/meetingShare.ts`).
    const outcome = await startScreenShare(av, undefined, () => mountedRef.current && sessionRef.current?.audioVideo === av);
    if (!mountedRef.current || sessionRef.current?.audioVideo !== av) return;
    if (outcome.kind === 'started') {
      setShare(outcome.share);
      setSharing(true);
      clearControlError(CONTROL_ERRORS.share);
    } else if (outcome.kind === 'failed') {
      setErrorCode('SHARE_UNAVAILABLE');
    }
  }, [sharing, clearControlError]);

  const setTranscription = useCallback(async (ask: { on?: boolean; recording?: boolean }): Promise<boolean> => {
    const arn = channelArnRef.current;
    if (!arn) return false;
    try {
      const now = await meetingService.setTranscription(arn, ask);
      if (!mountedRef.current) return true;
      if (transcriptionErrorRef.current) {
        clearControlError([transcriptionErrorRef.current]);
        transcriptionErrorRef.current = undefined;
      }
      applyRecording(now.recording);
      setTranscribing(now.on);
      // EVERYONE ELSE IN THE MEETING learns the mode from this host's app, an attendee reconnecting at the time included:
      // the service keeps the message for them (`MODE_LIFETIME_MS`), and their own reconnect reads the mode as well.
      try { sessionRef.current?.audioVideo.realtimeSendDataMessage(TRANSCRIPTION_TOPIC, JSON.stringify(now), MODE_LIFETIME_MS); } catch { /* the chat notice still tells them */ }
      return true;
    } catch (e) {
      const code = codeOf(e, 'TRANSCRIPTION_FAILED');
      transcriptionErrorRef.current = code;
      if (mountedRef.current) setErrorCode(code);
      return false;
    }
  }, [applyRecording, clearControlError]);

  // NO STATE IS SET HERE. It runs from a ref callback, so a state change would re-render the grid, which
  // runs the ref again: React's "Maximum update depth exceeded" on the first tile. The element binding
  // lives in the SDK, which is the only thing that reads it.
  const bindVideoElement = useCallback((tileId: number, el: HTMLVideoElement | null) => {
    const av = sessionRef.current?.audioVideo;
    if (av && el) {
      try { av.bindVideoElement(tileId, el); } catch { /* the tile went away */ }
    }
  }, []);

  const audioVideo = useCallback(() => sessionRef.current?.audioVideo ?? null, []);
  const videoPolicy = useCallback(() => (sessionRef.current ? videoPolicyRef.current : null), []);
  const dismissError = useCallback(() => setErrorCode(undefined), []);
  const selfAttendeeId = status === 'idle' ? undefined : joinInfoRef.current?.attendee.AttendeeId;
  const mutedForNotice = noticeHolding && inMeeting;
  // ONE VALUE PER CHANGE: a render of the provider that changed nothing the meeting shows hands its consumers the same value.
  const value = useMemo<MeetingContextValue>(() => ({
    status, attendees, leftPersonIds, activeSpeaker, errorCode, dismissError, classification, isHost, hostIds, mayEnd, transcribing, recording, mediaRecording, conversationId, roomConversationId, tiles, muted, cameraOn, sharing,
    share: sharing ? share : undefined, holdMicForNotice: noticeHold.hold, mutedForNotice,
    start, startNow, startedHere, join, leave, end, toggleMute, toggleCamera, toggleShare, bindVideoElement, setTranscription, deviceIds, chooseDevice,
    mutedByHost, mutedByRoom, holdMute, removedIds, speakRequests, selfAttendeeId, audioVideo, videoSources, videoPolicy,
  }), [
    status, attendees, leftPersonIds, activeSpeaker, errorCode, dismissError, classification, isHost, hostIds, mayEnd, transcribing, recording, mediaRecording, conversationId, roomConversationId, tiles, muted, cameraOn, sharing,
    share, noticeHold.hold, mutedForNotice,
    start, startNow, startedHere, join, leave, end, toggleMute, toggleCamera, toggleShare, bindVideoElement, setTranscription, deviceIds, chooseDevice,
    mutedByHost, mutedByRoom, holdMute, removedIds, speakRequests, selfAttendeeId, audioVideo, videoSources, videoPolicy,
  ]);
  return (
    <MeetingContext.Provider value={value}>
      <MeetingCaptionsContext.Provider value={transcribing ? captions : NO_CAPTIONS}>
        {children}
      </MeetingCaptionsContext.Provider>
      {/* The mixed remote audio binds here. */}
      <audio ref={audioElRef} style={{ display: 'none' }} />
    </MeetingContext.Provider>
  );
}

/** The meeting's live caption lines, every speaker's, while it is transcribed; none otherwise. */
export function useMeetingCaptions(): CaptionLine[] {
  return useContext(MeetingCaptionsContext);
}

export function useMeeting(): MeetingContextValue {
  const ctx = useContext(MeetingContext);
  if (!ctx) throw new Error('useMeeting must be used within a MeetingProvider');
  return ctx;
}
