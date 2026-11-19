/**
 * THE CONVERSATION'S MEETING, from the chat app: start, join and end, on the person API's meeting routes
 * (`POST /meetings`, `/meetings/join`, `/meetings/end`), served where the deployment declares the `meetings` capability.
 *
 * A meeting belongs to a conversation, so every call names the conversation and nothing else: there is no meeting id to
 * pass, and the caller cannot address a meeting the conversation does not hold. Where the capability is not declared,
 * `isMeetingEnabled()` is false and the app shows no meeting control at all.
 */
import { ensureFreshIdToken, isAssistantArn, personApiServes, personUrl } from '@ae/shared';
import type { ReportedEvent } from './meetingEventNames';
import type { OwnSegment } from './meetingTranscription';

/** Amazon Chime SDK Meetings `CreateMeeting` result: the fields the client SDK connects with. */
export interface ChimeMeetingInfo {
  MeetingId: string;
  MediaRegion?: string;
  MediaPlacement: Record<string, string>;
}

/** Amazon Chime SDK Meetings `CreateAttendee` result. */
export interface ChimeAttendeeInfo {
  AttendeeId: string;
  ExternalUserId: string;
  JoinToken: string;
}

/**
 * What a start or a join answers. `classification` is the boundary the meeting was created under, recorded when it
 * started, so the room can show which boundary people are meeting inside.
 */
export interface MeetingJoinInfo {
  meeting: ChimeMeetingInfo;
  attendee: ChimeAttendeeInfo;
  classification: string;
  startedAt: string;
  /** The meeting's own conversation (FR27), whose chat is the meeting's: the window shows it beside the meeting. */
  conversationId?: string;
  /**
   * The room: the conversation the meeting was started from, where its ring sounds. The meeting's own conversation when
   * it was started there.
   */
  roomConversationId?: string;
  /** On a start: true when this call created the meeting, false when it joined the one running. */
  created?: boolean;
  /** Whether the caller hosts the meeting (`meeting-host.ts`). */
  isHost?: boolean;
  /** Every host of the meeting, by person id, so the roster marks each one. */
  hostIds?: string[];
  /** Whether the caller may end it for everyone: its host, or a moderator of its room or its conversation. */
  mayEnd?: boolean;
  /**
   * Whether the caller joins with the microphone off, as the server decided from the room's speaking roles (FR51): a
   * person added to the meeting alone joins muted, and may unmute.
   */
  startMuted?: boolean;
  /** The people a host removed from this meeting, by person id (SPEC-ASSISTANT-MEETINGS FR59). */
  removedIds?: string[];
  /** Whether a host holds the caller's audio (FR59): their request to speak waits for a host. */
  mutedByHost?: boolean;
  /** Whether the service carries none of the caller's audio: their attendee's audio is receive only (FR51, FR59). */
  receiveOnly?: boolean;
  /** For a host: the people asking to speak, by person id. */
  speakRequests?: string[];
  /** Whether the meeting is transcribed now (FR28), so the room tells the person before their audio is heard. */
  transcribing?: boolean;
  /** Whether it is recorded now: captions, the stored transcript and the summary (recording mode). */
  recording?: boolean;
  /** Whether recording keeps the meeting's audio and video too (the deployment's `meetingMediaRecording`, FR70). */
  mediaRecording?: boolean;
}

/** An API failure with the server's `code`, so the room words it in the reader's language. */
export interface MeetingApiError extends Error {
  code?: string;
  status?: number;
}

/** Whether the conversation's meeting runs, as a status read answers it. It creates nothing. */
export interface MeetingStatusInfo {
  running: boolean;
  startedAt?: string;
  /** Whether the reader started it, so their own start does not ring them. */
  startedByYou?: boolean;
  /** The meeting's own conversation, where it is held, while it runs. */
  conversationId?: string;
  /** The room the meeting was started from, while it runs. */
  roomConversationId?: string;
  /**
   * Whole seconds left of the ring that announced the meeting, counted on the server's clock and at the ring's own length,
   * so a person arriving late rings for what is left whatever their own clock says.
   */
  ringSecondsLeft?: number;
  /** While it runs: whether the reader hosts it. */
  isHost?: boolean;
  /** While it runs: whether the reader may end it for everyone, without joining. */
  mayEnd?: boolean;
  /** While none runs: whether the reader may start it (the host, where the room has a host role held; else anyone). */
  mayStart?: boolean;
  /** While none runs, in a meeting's own conversation: its meeting has ended. */
  ended?: boolean;
  /** While it runs: a host removed the reader from it, so it offers them no Join. */
  removed?: boolean;
  /** While it runs: whether it is transcribed now. */
  transcribing?: boolean;
  /** While it runs: whether it is recorded now (the stored transcript and the summary). */
  recording?: boolean;
  /** While it runs and recorded: whether the recording keeps the meeting's audio and video too (FR70). */
  mediaRecording?: boolean;
  /** While it runs: whether a host stopped the reader's audio (FR59), so a session that reconnects holds the microphone. */
  mutedByHost?: boolean;
}

/** One meeting running now whose own conversation the person is a member of (`POST /meetings/mine`). */
export interface MyMeeting {
  /** The meeting's own conversation. */
  conversationId: string;
  /** The room it was started from. */
  roomConversationId: string;
  /** The meeting conversation's own name, as the person's membership lists it: a full name, shown as it is. */
  name?: string;
  startedAt: string;
  isHost: boolean;
  /** Whole seconds left of the ring that announced it, while it still sounds. */
  ringSecondsLeft?: number;
}

/** A meeting conversation the person is in, running or ended, and the room its server-written record names. */
export interface MyMeetingRoom {
  conversationId: string;
  roomConversationId: string;
}

export interface MyMeetingsInfo {
  meetings: MyMeeting[];
  /** Each of the person's meeting conversations, running or ended, with its room, where they are in both. */
  rooms?: MyMeetingRoom[];
  partial?: true;
}

/** A conversation id as the platform names one. */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An Amazon Chime SDK meeting id, by the backend's pattern (`MEETING_ID` in `backend/lambda/src/lib/meeting-lifecycle.ts`); a
 * backend test holds the two to one another.
 */
export const MEETING_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * A meeting card on a message's Metadata, or undefined: THE PLATFORM'S CARD ONLY. Metadata is member-writable, so a card
 * counts only from an assistant (`senderArn`), with its event, meeting id and meeting conversation checked.
 */
export function meetingCardFromMetadata(
  metadata: Record<string, unknown>, senderArn: string | null | undefined,
): { event: 'meeting-started' | 'meeting-ended'; meetingId: string; conversationId?: string; roomConversationId?: string; hosts?: string[]; ringUntil?: number } | undefined {
  if (!isAssistantArn(senderArn)) return undefined;
  const card = metadata.meetingCard as { event?: unknown; meetingId?: unknown; conversationId?: unknown; roomConversationId?: unknown; hosts?: unknown; ringUntil?: unknown } | undefined;
  if (!card || typeof card !== 'object') return undefined;
  if (card.event !== 'meeting-started' && card.event !== 'meeting-ended') return undefined;
  if (typeof card.meetingId !== 'string' || !MEETING_ID.test(card.meetingId)) return undefined;
  const conversationId = typeof card.conversationId === 'string' && CONVERSATION_ID.test(card.conversationId) ? card.conversationId : undefined;
  // THE ROOM IT WAS STARTED FROM, named on the card the meeting's own conversation is given.
  const roomConversationId = typeof card.roomConversationId === 'string' && CONVERSATION_ID.test(card.roomConversationId) ? card.roomConversationId : undefined;
  // THE MEETING'S HOSTS, by person id: its transcript and recording are offered to them alone, as the server signs them.
  const hosts = Array.isArray(card.hosts) ? card.hosts.filter((h): h is string => typeof h === 'string' && h.length > 0 && h.length <= 128).slice(0, 20) : undefined;
  // WHEN A STARTED MEETING'S RING STOPS, on the server's clock: a person the ring did not reach hears it from the card.
  const ringUntil = card.event === 'meeting-started' && typeof card.ringUntil === 'string' ? Date.parse(card.ringUntil) : NaN;
  return {
    event: card.event, meetingId: card.meetingId, ...(conversationId ? { conversationId } : {}), ...(roomConversationId ? { roomConversationId } : {}), ...(hosts ? { hosts } : {}),
    ...(Number.isFinite(ringUntil) ? { ringUntil } : {}),
  };
}

/** Whether this deployment serves meetings. Every meeting entry point is gated on it. */
export function isMeetingEnabled(): boolean {
  return personApiServes('meetings');
}

/**
 * POST to one meeting route, its URL built after the capability check (`url` names the route written out). `keepalive`
 * lets a report sent as the window closes (leaving the meeting closes the meeting window) finish after the page is gone.
 */
async function post<T>(url: () => string, channelArn: string | null, extra: Record<string, unknown> = {}, opts: { keepalive?: boolean } = {}): Promise<T> {
  if (!isMeetingEnabled()) {
    const err = new Error('Meetings are not served here') as MeetingApiError;
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const token = await ensureFreshIdToken();
  if (!token) throw new Error('Not authenticated');
  const response = await fetch(url(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(channelArn === null ? extra : { ...extra, channelArn }),
    ...(opts.keepalive ? { keepalive: true } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string; code?: string };
    const err = new Error(body.error || `Request failed: ${response.status}`) as MeetingApiError;
    if (body.code) err.code = body.code;
    err.status = response.status;
    throw err;
  }
  return response.json() as Promise<T>;
}

export const meetingService = {
  /**
   * Start the conversation's meeting, or join the one already running (`created` says which). A start named for an
   * earlier meeting's own conversation that its parent conversation has moved on from (`MEETING_MOVED`, a window kept open across
   * meetings) is made again from the conversation it was started from, `parent`, where the parent conversation's meeting now is.
   */
  async startMeeting(channelArn: string, parent?: string): Promise<MeetingJoinInfo> {
    try {
      return await post<MeetingJoinInfo>(() => personUrl('/meetings'), channelArn);
    } catch (e) {
      if ((e as MeetingApiError)?.code !== 'MEETING_MOVED' || !parent || parent === channelArn) throw e;
      return post<MeetingJoinInfo>(() => personUrl('/meetings'), parent);
    }
  },
  /** Join the conversation's running meeting. Rejects with code NO_ACTIVE_MEETING when none is running. */
  async joinMeeting(channelArn: string): Promise<MeetingJoinInfo> {
    return post<MeetingJoinInfo>(() => personUrl('/meetings/join'), channelArn);
  },
  /** Whether the conversation's meeting runs: read when the conversation opens and on reconnect, never on an interval. */
  async status(channelArn: string): Promise<MeetingStatusInfo> {
    return post<MeetingStatusInfo>(() => personUrl('/meetings/status'), channelArn);
  },
  /**
   * Every meeting running now in a conversation the person is in, newest first, as the service confirms it: read when the
   * app loads and when a meeting starts, ends or is left, never on an interval. `partial` says the list may be incomplete.
   */
  async mine(): Promise<MyMeetingsInfo> {
    return post<MyMeetingsInfo>(() => personUrl('/meetings/mine'), null);
  },
  /** End the conversation's meeting for everyone: its host, or a moderator of its room or its conversation. */
  async endMeeting(channelArn: string): Promise<void> {
    await post<{ ended: boolean }>(() => personUrl('/meetings/end'), channelArn);
  },
  /**
   * Report what this app saw of the conversation's running meeting (`meetingEventReporter.ts`), as this attendee, or a
   * ring's outcome with no attendee. The server confirms the attendee is the caller's.
   */
  async reportEvents(channelArn: string, attendeeId: string | null, events: ReportedEvent[]): Promise<void> {
    await post<{ filed: number }>(() => personUrl('/meetings/events'), channelArn, { ...(attendeeId ? { attendeeId } : {}), events }, { keepalive: true });
  },
  /**
   * A host turns the running meeting's captions or recording on or off (FR28). Recording keeps captions on; captions
   * cannot be turned off while it records (`RECORDING_ON`). Resolves the mode now.
   */
  async setTranscription(channelArn: string, ask: { on?: boolean; recording?: boolean }): Promise<{ on: boolean; recording: boolean }> {
    const out = await post<{ transcribing: boolean; recording?: boolean }>(() => personUrl('/meetings/transcription'), channelArn, ask);
    return { on: !!out.transcribing, recording: !!out.recording };
  },
  /**
   * A host stops or restores one person's audio, or everyone's but the hosts' (`personId: 'all'`), on the service
   * (FR59). Resolves the people it acted on.
   */
  async setSpeaking(channelArn: string, personId: string, allow: boolean): Promise<string[]> {
    const out = await post<{ people?: string[] }>(() => personUrl('/meetings/speaking'), channelArn, { personId, allow });
    return Array.isArray(out.people) ? out.people : [];
  },
  /** A host removes a person from the running meeting; the server keeps them out of it from then on (FR59). */
  async removePerson(channelArn: string, personId: string): Promise<void> {
    await post<{ removed: string }>(() => personUrl('/meetings/remove'), channelArn, { personId });
  },
  /**
   * The caller asks to speak, for themselves only (FR51, FR59): granted at once where the room's roles muted them on
   * joining, recorded for a host where a host holds them.
   */
  async requestToSpeak(channelArn: string): Promise<{ granted: boolean }> {
    const out = await post<{ granted?: boolean }>(() => personUrl('/meetings/unmute-request'), channelArn);
    return { granted: !!out.granted };
  },
  /** Send what this person said while the meeting is transcribed, as their own attendee; the server keeps only their lines. */
  async reportTranscript(channelArn: string, attendeeId: string, segments: OwnSegment[]): Promise<void> {
    await post<{ kept: number }>(() => personUrl('/meetings/transcript'), channelArn, { attendeeId, segments }, { keepalive: true });
  },
};
