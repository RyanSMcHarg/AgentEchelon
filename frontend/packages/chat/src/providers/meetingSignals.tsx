/**
 * THE MEETING'S SIGNALS PER ATTENDEE, and a host's controls (SPEC-ASSISTANT-MEETINGS FR54, FR59), read from the live
 * session the meeting provider runs (`useMeeting().audioVideo`), so its own subscriptions live and die here.
 *
 *  - SPEAKING, from each attendee's volume (`realtimeSubscribeToVolumeIndicator`, about five reports a second): over
 *    `SPEAKING_THRESHOLD` (0.15, and not muted) for `SPEAKING_ON_MS` before it shows, and under
 *    it for `SPEAKING_OFF_MS` before it clears, so a breath or a single loud sample does not flicker the indicator.
 *  - A POOR NETWORK, from the same report's signal strength, which is the attendee's audio packet loss: under 0.5 is
 *    half or more of their audio lost (amazon-chime-sdk-js API overview, "Subscribe to volume indicators"). It shows once
 *    it has held for `POOR_SIGNAL_ON_MS` and clears once recovered for `POOR_SIGNAL_OFF_MS`. The viewer's own attendee is
 *    read the same way.
 *  - A HOST'S CONTROLS. The service enforces a mute (`/meetings/speaking` sets the attendee's audio capability); the
 *    app is told by a data message on `HOST_CONTROL_TOPIC`, the practice the SDK's FAQ names for remote mute, so the
 *    person's microphone control can say a host muted them. A message counts only from an attendee whose service-set
 *    `senderExternalUserId` is one of the meeting's hosts as the join answered; any attendee can send on any topic.
 *  - ASKING TO SPEAK (FR51, FR59). A person the room muted on joining is granted at once by the server and unmutes here;
 *    one a host holds is recorded as asking, and their app tells the hosts on the same topic, where an ask counts only
 *    when its service-set sender is the person it names. Every host then sees them asking, with Allow and Dismiss.
 *
 * The active speaker (the SDK's `DefaultActiveSpeakerPolicy`) is the provider's own `activeSpeaker`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AudioVideoFacade, DataMessage } from 'amazon-chime-sdk-js';
import { useMeeting } from './MeetingProvider';
import { meetingService, type MeetingApiError } from '../services/meetingService';
import { chimeService } from '../services/chimeService';

/** The volume over which an unmuted attendee counts as speaking. */
export const SPEAKING_THRESHOLD = 0.15;
/** One volume report (the SDK reports five a second) before speaking shows, and four before it clears. */
export const SPEAKING_ON_MS = 200;
export const SPEAKING_OFF_MS = 800;
/** Under this signal strength, half or more of the attendee's audio is lost (amazon-chime-sdk-js API overview). */
export const POOR_SIGNAL_BELOW = 0.5;
/** A poor network shows once it has lasted two seconds, and clears after three seconds recovered. */
export const POOR_SIGNAL_ON_MS = 2000;
export const POOR_SIGNAL_OFF_MS = 3000;
/** The data message topic a host's app announces its controls on. */
export const HOST_CONTROL_TOPIC = 'ae-meeting-host';
/**
 * HOW LONG THE SERVICE KEEPS A CONTROL FOR AN ATTENDEE WHO WAS NOT CONNECTED WHEN IT WAS SENT (the data message's
 * `lifetimeMs`, at most five minutes): an attendee whose connection dropped and came back is given the controls sent
 * meanwhile, in order, so a host's Allow or Mute reaches a person who was reconnecting.
 */
export const CONTROL_LIFETIME_MS = 300_000;

/** A boolean that changes only once its new value has held: `onMs` to become true, `offMs` to become false. */
export function debouncedFlag(onMs: number, offMs: number, onChange: (value: boolean) => void): { set: (raw: boolean) => void; dispose: () => void } {
  let value = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let target = false;
  return {
    set(raw: boolean) {
      if (raw === target && (pending || raw === value)) return;
      target = raw;
      if (pending) { clearTimeout(pending); pending = null; }
      if (raw === value) return;
      pending = setTimeout(() => { pending = null; value = raw; onChange(raw); }, raw ? onMs : offMs);
    },
    dispose() { if (pending) clearTimeout(pending); pending = null; },
  };
}

/** What an app announces: a host's control over a person (or `all`), or a person asking to speak for themselves. */
export interface HostControl { action: 'mute' | 'allow' | 'remove' | 'ask'; personId: string }

/**
 * The control a data message carries, or null. A host's control counts only from a host by the join's answer; an ask
 * counts only from the person it names. The sender is the service's, so neither can be claimed in the message.
 */
export function hostControlOf(message: Pick<DataMessage, 'senderExternalUserId' | 'throttled' | 'text'>, hostIds: readonly string[]): HostControl | null {
  if (message.throttled) return null;
  try {
    const body = JSON.parse(message.text()) as Partial<HostControl>;
    if (typeof body.personId !== 'string' || !body.personId) return null;
    if (body.action === 'ask') return body.personId === message.senderExternalUserId ? { action: 'ask', personId: body.personId } : null;
    if (!hostIds.includes(message.senderExternalUserId)) return null;
    if (body.action === 'mute' || body.action === 'allow' || body.action === 'remove') return { action: body.action, personId: body.personId };
  } catch { /* not a control */ }
  return null;
}

export interface MeetingSignals {
  /** Attendees speaking now, by attendee id, debounced. */
  speaking: ReadonlySet<string>;
  /** Attendees whose audio reaches the meeting poorly, by attendee id, debounced. */
  poorSignal: ReadonlySet<string>;
  /** People a host stopped from speaking, by person id. */
  hostMuted: ReadonlySet<string>;
  /** People a host removed from the meeting, by person id. */
  removed: ReadonlySet<string>;
  /** A host stops or restores a person's audio (`all`: everyone's but the hosts'). Resolves false when the server refused. */
  setSpeaking: (personId: string, allow: boolean) => Promise<boolean>;
  /** A host removes a person from the meeting. Resolves false when the server refused. */
  remove: (personId: string) => Promise<boolean>;
  /** People asking a host to let them speak, by person id. */
  asking: ReadonlySet<string>;
  /** A host turns down a request to speak: the person stays muted. */
  dismiss: (personId: string) => Promise<boolean>;
  /** The viewer asks to speak: granted at once where the room muted them, sent to the hosts where a host holds them. */
  requestToSpeak: () => Promise<void>;
  /** The viewer asked a host to speak and no host has answered yet. */
  speakRequestPending: boolean;
  /** The code of the last control the server refused, for the roster to word. */
  controlError?: string;
}

const EMPTY: ReadonlySet<string> = new Set();
const noSignals: MeetingSignals = {
  speaking: EMPTY, poorSignal: EMPTY, hostMuted: EMPTY, removed: EMPTY,
  setSpeaking: async () => false, remove: async () => false,
  asking: EMPTY, dismiss: async () => false, requestToSpeak: async () => undefined, speakRequestPending: false,
};
const SignalsContext = createContext<MeetingSignals>(noSignals);

/** The meeting's signals; outside a `MeetingSignalsProvider`, none. */
export function useMeetingSignals(): MeetingSignals {
  return useContext(SignalsContext);
}

interface Watched { cb: (id: string, volume: number | null, muted: boolean | null, signal: number | null) => void; dispose: () => void }

export function MeetingSignalsProvider({ children }: { children: ReactNode }) {
  const meeting = useMeeting();
  const [speaking, setSpeakingSet] = useState<ReadonlySet<string>>(EMPTY);
  const [poorSignal, setPoorSignal] = useState<ReadonlySet<string>>(EMPTY);
  const [hostMuted, setHostMuted] = useState<ReadonlySet<string>>(EMPTY);
  const [announcedRemoved, setAnnouncedRemoved] = useState<ReadonlySet<string>>(EMPTY);
  const [controlError, setControlError] = useState<string | undefined>();
  const [announcedAsks, setAnnouncedAsks] = useState<ReadonlySet<string>>(EMPTY);
  const [answeredAsks, setAnsweredAsks] = useState<ReadonlySet<string>>(EMPTY);
  const [speakRequestPending, setSpeakRequestPending] = useState(false);
  const avRef = useRef<AudioVideoFacade | null>(null);
  const watched = useRef(new Map<string, Watched>());
  // The latest of what a control message is read against, so the one subscription per session reads it fresh.
  const latest = useRef({ hostIds: meeting.hostIds, selfId: '', isHost: meeting.isHost, attendees: meeting.attendees, holdMute: meeting.holdMute });
  // The viewer's person id: the AppInstanceUser their attendee joined as.
  const selfId = chimeService.getUserArn()?.split('/').pop() ?? '';
  latest.current = { hostIds: meeting.hostIds ?? [], selfId, isHost: meeting.isHost, attendees: meeting.attendees, holdMute: meeting.holdMute };

  const toggleIn = (setter: typeof setSpeakingSet, id: string, on: boolean) => setter((prev) => {
    if (prev.has(id) === on) return prev;
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  /** Apply a host's control here: to the viewer's own microphone when it names them, and to the roster's view. */
  const apply = useCallback((c: HostControl) => {
    const { hostIds, selfId: me, isHost, attendees, holdMute } = latest.current;
    if (c.action === 'remove') { toggleIn(setAnnouncedRemoved, c.personId, true); return; }
    if (c.action === 'ask') { toggleIn(setAnnouncedAsks, c.personId, true); toggleIn(setAnsweredAsks, c.personId, false); return; }
    const muted = c.action === 'mute';
    const everyone = c.personId === 'all';
    // A host's answer to a person ends their request, whichever way it went.
    if (everyone) { setAnnouncedAsks(EMPTY); setAnsweredAsks(new Set(attendees.map((a) => a.personId))); }
    else { toggleIn(setAnnouncedAsks, c.personId, false); toggleIn(setAnsweredAsks, c.personId, true); }
    if ((everyone && !isHost) || c.personId === me) { holdMute(muted); setSpeakRequestPending(false); }
    if (everyone) {
      setHostMuted(muted ? new Set(attendees.map((a) => a.personId).filter((p) => p && !hostIds.includes(p))) : EMPTY);
    } else {
      toggleIn(setHostMuted, c.personId, muted);
    }
  }, []);

  const connected = meeting.status === 'joined' || meeting.status === 'reconnecting';

  // ONE SESSION'S SUBSCRIPTIONS: the control topic now, the attendees' volumes as they arrive (below); all taken off,
  // and every pending timer cleared, when the session goes.
  useEffect(() => {
    if (!connected) return;
    const av = meeting.audioVideo();
    if (!av) return;
    avRef.current = av;
    const onMessage = (m: DataMessage) => {
      const control = hostControlOf(m, latest.current.hostIds);
      if (control) apply(control);
    };
    av.realtimeSubscribeToReceiveDataMessage(HOST_CONTROL_TOPIC, onMessage);
    const subs = watched.current;
    return () => {
      av.realtimeUnsubscribeFromReceiveDataMessage(HOST_CONTROL_TOPIC);
      subs.forEach((w, id) => { av.realtimeUnsubscribeFromVolumeIndicator(id, w.cb); w.dispose(); });
      subs.clear();
      avRef.current = null;
      setSpeakingSet(EMPTY);
      setPoorSignal(EMPTY);
    };
  // A new session (a rejoin) is a status change; the reader of the session is stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.status, apply]);

  // EACH ATTENDEE'S VOLUME AND SIGNAL, the viewer's own included, subscribed as they arrive and taken off as they go.
  const ids = useMemo(() => {
    const set = new Set(meeting.attendees.map((a) => a.attendeeId));
    if (meeting.selfAttendeeId) set.add(meeting.selfAttendeeId);
    return [...set].sort();
  }, [meeting.attendees, meeting.selfAttendeeId]);
  const idsKey = ids.join(',');
  useEffect(() => {
    const av = avRef.current;
    if (!av) return;
    const subs = watched.current;
    for (const [id, w] of subs) {
      if (ids.includes(id)) continue;
      av.realtimeUnsubscribeFromVolumeIndicator(id, w.cb);
      w.dispose();
      subs.delete(id);
      toggleIn(setSpeakingSet, id, false);
      toggleIn(setPoorSignal, id, false);
    }
    for (const id of ids) {
      if (subs.has(id)) continue;
      const talk = debouncedFlag(SPEAKING_ON_MS, SPEAKING_OFF_MS, (on) => toggleIn(setSpeakingSet, id, on));
      const network = debouncedFlag(POOR_SIGNAL_ON_MS, POOR_SIGNAL_OFF_MS, (on) => toggleIn(setPoorSignal, id, on));
      // The SDK reports null for a field that has not changed, so the last known value stands in for it.
      let volume = 0;
      let muted = false;
      const cb: Watched['cb'] = (_id, v, m, s) => {
        if (v !== null) volume = v;
        if (m !== null) muted = m;
        if (v !== null || m !== null) talk.set(volume > SPEAKING_THRESHOLD && !muted);
        if (s !== null) network.set(s < POOR_SIGNAL_BELOW);
      };
      av.realtimeSubscribeToVolumeIndicator(id, cb);
      subs.set(id, { cb, dispose: () => { talk.dispose(); network.dispose(); } });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, meeting.status]);

  // A meeting left clears what a host did in it.
  useEffect(() => {
    if (meeting.status !== 'idle') return;
    setHostMuted(EMPTY);
    setAnnouncedRemoved(EMPTY);
    setAnnouncedAsks(EMPTY);
    setAnsweredAsks(EMPTY);
    setSpeakRequestPending(false);
    setControlError(undefined);
  }, [meeting.status]);

  const conversation = meeting.conversationId;
  const announce = (c: HostControl) => {
    try { avRef.current?.realtimeSendDataMessage(HOST_CONTROL_TOPIC, JSON.stringify(c), CONTROL_LIFETIME_MS); } catch { /* the service enforced it; the notice is best effort */ }
    apply(c);
  };
  const run = async (call: () => Promise<unknown>, control: HostControl): Promise<boolean> => {
    if (!conversation) return false;
    setControlError(undefined);
    try {
      await call();
      announce(control);
      return true;
    } catch (e) {
      setControlError((e as MeetingApiError).code || 'CONTROL_FAILED');
      return false;
    }
  };

  const removed = useMemo(() => new Set([...(meeting.removedIds ?? []), ...announcedRemoved]), [meeting.removedIds, announcedRemoved]);
  const asking = useMemo(
    () => new Set([...(meeting.speakRequests ?? []).filter((p) => !answeredAsks.has(p)), ...announcedAsks]),
    [meeting.speakRequests, announcedAsks, answeredAsks],
  );
  /**
   * THE VIEWER ASKS TO SPEAK. Granted, the microphone is released and unmuted here, the service now carrying it; recorded
   * for a host, the hosts are told and the request waits for a host's answer.
   */
  const requestToSpeak = async (): Promise<void> => {
    if (!conversation || speakRequestPending) return;
    setControlError(undefined);
    setSpeakRequestPending(true);
    try {
      const { granted } = await meetingService.requestToSpeak(conversation);
      if (granted) {
        setSpeakRequestPending(false);
        meeting.holdMute(false);
        meeting.toggleMute();
        return;
      }
      try { avRef.current?.realtimeSendDataMessage(HOST_CONTROL_TOPIC, JSON.stringify({ action: 'ask', personId: selfId }), CONTROL_LIFETIME_MS); } catch { /* the request is recorded; a host sees it on joining */ }
    } catch (e) {
      setSpeakRequestPending(false);
      setControlError((e as MeetingApiError).code || 'CONTROL_FAILED');
    }
  };
  const selfHeld = meeting.mutedByHost && selfId ? new Set([...hostMuted, selfId]) : hostMuted;
  const value: MeetingSignals = {
    speaking, poorSignal, hostMuted: selfHeld, removed, controlError,
    setSpeaking: (personId, allow) => run(() => meetingService.setSpeaking(conversation!, personId, allow), { action: allow ? 'allow' : 'mute', personId }),
    remove: (personId) => run(() => meetingService.removePerson(conversation!, personId), { action: 'remove', personId }),
    asking, speakRequestPending, requestToSpeak,
    dismiss: (personId) => run(() => meetingService.setSpeaking(conversation!, personId, false), { action: 'mute', personId }),
  };
  return <SignalsContext.Provider value={value}>{children}</SignalsContext.Provider>;
}
