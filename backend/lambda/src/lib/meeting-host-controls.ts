/**
 * WHO MAY SEND AUDIO IN A RUNNING MEETING, AND WHO STAYS IN IT (SPEC-ASSISTANT-MEETINGS FR51, FR59): a host stops a
 * person sending audio, stops everyone but the hosts, lets them speak again, and removes a person; a person who joined
 * muted asks to speak. A host's control is a host's alone, checked here against the hosts recorded on the meeting at its
 * start (`meeting-host.ts`), never against anything the caller says; a request to speak acts on the caller's own
 * attendees alone.
 *
 * A MUTE IS THE SERVICE'S, NOT THE CLIENT'S. It sets the attendee's audio capability to `Receive` (Amazon Chime SDK
 * `CreateAttendee`, `UpdateAttendeeCapabilities`, `BatchUpdateAttendeeCapabilitiesExcept`), so the person keeps hearing
 * the meeting and the service carries none of their audio, whatever their app does. Letting them speak sets it back to
 * `SendReceive`; their own microphone stays as they left it. Video and content keep what the attendee holds, and are
 * `SendReceive` where the attendee is created, since content may be received only where video is.
 *
 * TWO KINDS OF MUTED. A person the room's speaking roles leave out joins with audio `Receive` and is granted
 * `SendReceive` on asking. A person a host muted is HELD (`activeMeeting.heldPersonIds`, written before their capability
 * changes, so a hold the record lost never lets them grant themselves): their request is recorded
 * (`activeMeeting.speakRequestIds`) for every host to allow or dismiss, and a rejoin keeps them `Receive`.
 *
 * A REMOVAL IS RECORDED ON THE MEETING BEFORE THE ATTENDEE IS DELETED. `CreateAttendee` answers the same person again,
 * so the record (`activeMeeting.removedPersonIds`) is what keeps a removed person out of this meeting: the join route
 * refuses them while it names them, and a delete that follows a failed record never happens.
 *
 * Every control, request and grant is filed as a meeting event keyed by the person it concerns, with who acted, so the
 * meeting's record and the console's figures name both by id.
 */
import {
  BatchUpdateAttendeeCapabilitiesExceptCommand,
  DeleteAttendeeCommand,
  GetAttendeeCommand,
  ListAttendeesCommand,
  UpdateAttendeeCapabilitiesCommand,
  type Attendee,
  type AttendeeCapabilities,
  type ChimeSDKMeetingsClient,
} from '@aws-sdk/client-chime-sdk-meetings';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { __setChannelContextStore, changeMeetingSets, readActiveMeetingNow } from './channel-context-client.js';
import { isRecordedHost, recordedHostIds, type MeetingHost } from './meeting-host.js';
import { fileMeetingEvents } from './meeting-event-archive.js';
import { PERSON_ID } from './meeting-lifecycle.js';
import type { MeetingEventRecord } from './meeting-event-shape.js';

const LOG = '[meeting-host-controls]';

/** An attendee that hears and sees the meeting and sends no audio. Content needs video at `Receive` or more. */
export const RECEIVE_ONLY_AUDIO: AttendeeCapabilities = { Audio: 'Receive', Video: 'SendReceive', Content: 'SendReceive' };

/** The meeting record the controls read: its id, its boundary, its hosts, who is held, who asks, and who was removed. */
export interface ControlledMeeting {
  meetingId: string;
  classification: string;
  hosts?: MeetingHost[];
  createdBy?: string;
  startedVia?: 'person' | 'workflow';
  removedPersonIds?: unknown;
  heldPersonIds?: unknown;
  speakRequestIds?: unknown;
}

/** A control's answer: status and body, as the meeting API returns it. */
export type ControlAnswer = { status: number; body: Record<string, unknown> };
const refusal = (status: number, code: string, error: string): ControlAnswer => ({ status, body: { error, code } });


type Meetings = Pick<ChimeSDKMeetingsClient, 'send'>;
type Store = Pick<DynamoDBDocumentClient, 'send'>;

/** Test seam: the conversation store the meeting's sets are written to, the one module that writes them (`channel-context-client.ts`). */
export function __setStore(s: Store | null): void { __setChannelContextStore(s); }

/** A set of person ids on the meeting record, however the store returned it. */
function idsIn(meeting: object | null | undefined, field: 'removedPersonIds' | 'heldPersonIds' | 'speakRequestIds'): string[] {
  const raw = (meeting as ControlledMeeting | null | undefined)?.[field];
  if (raw instanceof Set) return [...raw].filter((x): x is string => typeof x === 'string');
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  return [];
}

/** The people removed from a meeting, by person id. */
export const removedFrom = (meeting: object | null | undefined): string[] => idsIn(meeting, 'removedPersonIds');
/** Whether a host removed this person from this meeting: a join of theirs is refused while it runs. */
export const isRemoved = (meeting: object | null | undefined, personId: string): boolean => removedFrom(meeting).includes(personId);
/** Whether a host holds this person's audio: their request to speak waits for a host. */
export const isHeld = (meeting: object | null | undefined, personId: string): boolean => idsIn(meeting, 'heldPersonIds').includes(personId);
/** The people asking a host to let them speak, by person id. */
export const speakRequestsOf = (meeting: object | null | undefined): string[] => idsIn(meeting, 'speakRequestIds');

/** Whether this attendee's audio capability is receive only: the service carries none of its audio. */
export const audioReceiveOnly = (attendee: { Capabilities?: { Audio?: string } } | undefined): boolean =>
  attendee?.Capabilities?.Audio === 'Receive';

/** Every attendee of the meeting now, each with its person and capabilities, read page by page. */
async function attendeesOf(meetings: Meetings, meetingId: string): Promise<Attendee[]> {
  const out: Attendee[] = [];
  let NextToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await meetings.send(new ListAttendeesCommand({ MeetingId: meetingId, MaxResults: 100, ...(NextToken ? { NextToken } : {}) }));
    out.push(...(res.Attendees ?? []));
    NextToken = res.NextToken;
    if (!NextToken) break;
  }
  return out;
}

/** File what was done, one event per person it concerns. A record that cannot be filed is logged; the act stands. */
async function fileControls(meetingArn: string, meeting: ControlledMeeting, eventType: string, by: string, people: Array<{ personId: string; attendeeId: string | null }>, detail: Record<string, unknown> = {}): Promise<void> {
  if (!people.length) return;
  const now = Date.now();
  // Each person's event on its own instant, so two people acted on together stay two events on the natural key.
  const records: MeetingEventRecord[] = people.map((p, i) => ({
    meeting_id: meeting.meetingId, channel_arn: meetingArn, classification: meeting.classification, event_type: eventType,
    source: 'platform', attendee_id: p.attendeeId, person_key: p.personId, is_content: false, network_transport: null,
    event_at: new Date(now + i).toISOString(), detail: { by, ...detail },
  }));
  try {
    await fileMeetingEvents(records, undefined, { projection: 'best-effort' });
  } catch (err) {
    console.warn(`${LOG} a control could not be filed`, { meetingId: meeting.meetingId, eventType, err: (err as Error).name });
  }
}

/**
 * Whether a host holds this person in the meeting the conversation holds now, read consistently from its record: true or
 * false, or undefined where it could not be read.
 */
async function heldNow(meetingArn: string, meetingId: string, personId: string): Promise<boolean | undefined> {
  try {
    const meeting = await readActiveMeetingNow(meetingArn);
    return meeting?.meetingId === meetingId ? isHeld(meeting, personId) : false;
  } catch (err) {
    console.warn(`${LOG} whether a person is held could not be read`, { meetingId, err: (err as Error).name });
    return undefined;
  }
}

/**
 * WHOSE EACH ATTENDEE IS, as the service answered it, kept for this container's life: an attendee's `ExternalUserId` is set
 * when it is created and never changes, so a meeting's reports ask the service once per attendee rather than once per
 * report. Only an answer naming an owner is kept; a refusal is asked again.
 */
const attendeeOwners = new Map<string, string>();
const ATTENDEE_OWNERS_KEPT = 5_000;
/** Test seam: forget every owner answered so far. */
export function __forgetAttendeeOwners(): void { attendeeOwners.clear(); }

/**
 * THE ONE CHECK THAT AN ATTENDEE IS THE CALLER'S, in the meeting the conversation holds: the service's own answer for the
 * attendee (`GetAttendee`), whose `ExternalUserId` must be the caller's AppInstanceUser id. Null where it is theirs; a
 * refusal where it is not, or names no attendee; a retryable refusal where the service could not answer.
 */
export async function attendeeRefusal(meetings: Meetings, meetingId: string, attendeeId: unknown, personId: string): Promise<ControlAnswer | null> {
  if (typeof attendeeId !== 'string' || !attendeeId || attendeeId.length > 128) return refusal(400, 'INVALID_ATTENDEE', 'Name one attendee');
  const known = attendeeOwners.get(`${meetingId}/${attendeeId}`);
  if (known !== undefined) return known === personId ? null : refusal(403, 'NOT_YOUR_ATTENDEE', 'That attendee is not yours in this meeting');
  let owner: string | undefined;
  try {
    owner = (await meetings.send(new GetAttendeeCommand({ MeetingId: meetingId, AttendeeId: attendeeId })))?.Attendee?.ExternalUserId;
    if (owner) {
      if (attendeeOwners.size >= ATTENDEE_OWNERS_KEPT) attendeeOwners.delete(attendeeOwners.keys().next().value as string);
      attendeeOwners.set(`${meetingId}/${attendeeId}`, owner);
    }
  } catch (err) {
    const name = (err as Error)?.name;
    if (name !== 'NotFoundException' && name !== 'ResourceNotFoundException' && name !== 'BadRequestException') {
      console.warn(`${LOG} the attendee could not be read`, { meetingId, err: name });
      return refusal(503, 'UNAVAILABLE', 'The attendee could not be checked just now; try again');
    }
  }
  return owner === personId ? null : refusal(403, 'NOT_YOUR_ATTENDEE', 'That attendee is not yours in this meeting');
}

/** Set one attendee's audio, keeping its video and content. */
const setAudio = (meetings: Meetings, meetingId: string, a: Attendee, audio: 'Receive' | 'SendReceive') =>
  meetings.send(new UpdateAttendeeCapabilitiesCommand({
    MeetingId: meetingId, AttendeeId: a.AttendeeId!,
    Capabilities: { Audio: audio, Video: a.Capabilities?.Video ?? 'SendReceive', Content: a.Capabilities?.Content ?? 'SendReceive' },
  }));

/** The person ids the caller names: one person, or `all`. */
function targetOf(raw: unknown): string | 'all' | undefined {
  if (raw === 'all') return 'all';
  return typeof raw === 'string' && PERSON_ID.test(raw) ? raw : undefined;
}

/**
 * THE CAPABILITIES A JOINING ATTENDEE IS CREATED WITH: receive-only audio for a person the room's speaking roles leave
 * out, or whom a host holds; the service's own default for anyone else.
 */
export function joinCapabilities(meeting: object, personId: string, joinsMuted: boolean): AttendeeCapabilities | undefined {
  return joinsMuted || isHeld(meeting, personId) ? RECEIVE_ONLY_AUDIO : undefined;
}

/**
 * A HOST'S HOLD SURVIVES A REJOIN. `CreateAttendee` answers the person's existing attendee as it stands, so an attendee a
 * held person comes back to with audio open is set to receive only again; anyone else's is left as the service answered.
 */
export async function keepHold(meetings: Meetings, meeting: ControlledMeeting, personId: string, attendee: Attendee | undefined): Promise<Attendee | undefined> {
  if (!attendee?.AttendeeId || !isHeld(meeting, personId) || audioReceiveOnly(attendee)) return attendee;
  await setAudio(meetings, meeting.meetingId, attendee, 'Receive');
  return { ...attendee, Capabilities: { ...RECEIVE_ONLY_AUDIO, ...attendee.Capabilities, Audio: 'Receive' } };
}

/**
 * STOP OR RESTORE A PERSON'S AUDIO, or everyone's but the hosts'. `allow` false holds them (recorded first, then audio
 * `Receive`); true ends the hold and any request of theirs (recorded first, then audio `SendReceive`). Either way a record
 * that cannot be written changes no audio and refuses, so the host is never told a change the meeting does not keep. For one person, every attendee of
 * theirs is set and keeps its video and content. For everyone, every attendee of a host is left out, so no host is muted
 * by another; the caller must be in the meeting. A host dismissing a request holds the person again.
 */
export async function setSpeaking(
  meetings: Meetings, meetingArn: string, meeting: ControlledMeeting, hostId: string, rawTarget: unknown, rawAllow: unknown,
): Promise<ControlAnswer> {
  if (!isRecordedHost(meeting, hostId)) return refusal(403, 'HOST_ONLY', 'Only a host of the meeting can do this');
  const target = targetOf(rawTarget);
  if (!target || typeof rawAllow !== 'boolean') return refusal(400, 'INVALID_BODY', 'Name one person or everyone, and whether they may speak');
  const audio = rawAllow ? 'SendReceive' : 'Receive';
  const eventType = rawAllow ? 'attendeeAllowedToSpeak' : 'attendeeMutedByHost';
  const attendees = await attendeesOf(meetings, meeting.meetingId);
  const hostIds = new Set(recordedHostIds(meeting));
  const unrecorded = refusal(503, 'CONTROL_FAILED', 'The meeting could not be changed just now; try again');

  if (target === 'all') {
    const excluded = attendees.filter((a) => a.ExternalUserId && hostIds.has(a.ExternalUserId));
    if (!excluded.some((a) => a.ExternalUserId === hostId)) return refusal(409, 'NOT_IN_MEETING', 'Join the meeting to do this');
    const people = attendees.filter((a) => a.ExternalUserId && !hostIds.has(a.ExternalUserId))
      .map((a) => ({ personId: a.ExternalUserId!, attendeeId: a.AttendeeId ?? null }));
    const ids = [...new Set(people.map((p) => p.personId))];
    const recorded = rawAllow
      ? await changeMeetingSets(meetingArn, meeting.meetingId, { clear: ['heldPersonIds', 'speakRequestIds'] })
      : await changeMeetingSets(meetingArn, meeting.meetingId, { add: { heldPersonIds: ids }, del: { speakRequestIds: ids } });
    if (!recorded) return unrecorded;
    await meetings.send(new BatchUpdateAttendeeCapabilitiesExceptCommand({
      MeetingId: meeting.meetingId,
      // The meeting is created with video and content open to everyone, which is what each attendee keeps.
      Capabilities: { Audio: audio, Video: 'SendReceive', Content: 'SendReceive' },
      ExcludedAttendeeIds: excluded.map((a) => ({ AttendeeId: a.AttendeeId! })).slice(0, 250),
    }));
    await fileControls(meetingArn, meeting, eventType, hostId, people, { scope: 'all' });
    return { status: 200, body: { allowed: rawAllow, people: ids } };
  }

  if (target === hostId) return refusal(400, 'NOT_YOURSELF', 'Use your own microphone');
  if (hostIds.has(target)) return refusal(403, 'NOT_A_HOST', 'A host of the meeting cannot be muted by another');
  const theirs = attendees.filter((a) => a.ExternalUserId === target && a.AttendeeId);
  if (!theirs.length) return refusal(404, 'NOT_IN_MEETING', 'That person is not in the meeting');
  const recorded = rawAllow
    ? await changeMeetingSets(meetingArn, meeting.meetingId, { del: { heldPersonIds: [target], speakRequestIds: [target] } })
    : await changeMeetingSets(meetingArn, meeting.meetingId, { add: { heldPersonIds: [target] }, del: { speakRequestIds: [target] } });
  if (!recorded) return unrecorded;
  for (const a of theirs) await setAudio(meetings, meeting.meetingId, a, audio);
  await fileControls(meetingArn, meeting, eventType, hostId, theirs.map((a) => ({ personId: target, attendeeId: a.AttendeeId ?? null })), { scope: 'one' });
  return { status: 200, body: { allowed: rawAllow, people: [target] } };
}

/**
 * A PERSON ASKS TO SPEAK, for their own attendees only. One the room's speaking roles muted on joining is granted at once
 * (`SendReceive`); one a host holds is recorded as asking, for a host to allow or dismiss. An attendee the caller names
 * must be theirs, and a person the caller names must be the caller.
 */
export async function requestToSpeak(
  meetings: Meetings, meetingArn: string, meeting: ControlledMeeting, personId: string, body: { personId?: unknown; attendeeId?: unknown },
): Promise<ControlAnswer> {
  if (body.personId !== undefined && body.personId !== personId) return refusal(403, 'NOT_YOUR_ATTENDEE', 'Ask for yourself only');
  if (body.attendeeId !== undefined) {
    const notYours = await attendeeRefusal(meetings, meeting.meetingId, body.attendeeId, personId);
    if (notYours) return notYours;
  }
  const mine = (await attendeesOf(meetings, meeting.meetingId)).filter((a) => a.ExternalUserId === personId && a.AttendeeId);
  if (!mine.length) return refusal(404, 'NOT_IN_MEETING', 'Join the meeting to do this');
  const attendees = mine.map((a) => ({ personId, attendeeId: a.AttendeeId ?? null }));

  if (isHeld(meeting, personId)) {
    if (!(await changeMeetingSets(meetingArn, meeting.meetingId, { add: { speakRequestIds: [personId] } }))) {
      return refusal(503, 'CONTROL_FAILED', 'The request could not be sent just now; try again');
    }
    await fileControls(meetingArn, meeting, 'speakRequested', personId, attendees.slice(0, 1));
    return { status: 202, body: { granted: false, requested: true } };
  }
  const opened = mine.filter((x) => audioReceiveOnly(x));
  for (const a of opened) await setAudio(meetings, meeting.meetingId, a, 'SendReceive');
  // A HOST'S HOLD WINS OVER A GRANT MADE AT THE SAME TIME. A host records a hold before it changes any audio, so a hold read
  // here, after the grant, covers every hold whose audio change the grant could have overtaken: the audio goes back to
  // receive only and the request waits for a host. A record that cannot be read leaves the audio receive only.
  const held = opened.length ? await heldNow(meetingArn, meeting.meetingId, personId) : false;
  if (held !== false) {
    for (const a of opened) await setAudio(meetings, meeting.meetingId, a, 'Receive');
    if (held === undefined || !(await changeMeetingSets(meetingArn, meeting.meetingId, { add: { speakRequestIds: [personId] } }))) {
      return refusal(503, 'CONTROL_FAILED', 'The request could not be sent just now; try again');
    }
    await fileControls(meetingArn, meeting, 'speakRequested', personId, attendees.slice(0, 1));
    return { status: 202, body: { granted: false, requested: true } };
  }
  await fileControls(meetingArn, meeting, 'speakGranted', 'room', attendees.slice(0, 1));
  return { status: 200, body: { granted: true } };
}

/**
 * REMOVE A PERSON FROM THE MEETING: recorded on the meeting first, so their join is refused from then on, then every
 * attendee of theirs deleted. Never the caller, and never another host.
 */
export async function removeFromMeeting(
  meetings: Meetings, meetingArn: string, meeting: ControlledMeeting, hostId: string, rawTarget: unknown,
): Promise<ControlAnswer> {
  if (!isRecordedHost(meeting, hostId)) return refusal(403, 'HOST_ONLY', 'Only a host of the meeting can do this');
  const target = targetOf(rawTarget);
  if (!target || target === 'all') return refusal(400, 'INVALID_BODY', 'Name one person');
  if (target === hostId) return refusal(400, 'NOT_YOURSELF', 'Leave the meeting instead');
  if (isRecordedHost(meeting, target)) return refusal(403, 'NOT_A_HOST', 'A host of the meeting cannot be removed');
  const theirs = (await attendeesOf(meetings, meeting.meetingId)).filter((a) => a.ExternalUserId === target && a.AttendeeId);
  if (!theirs.length) return refusal(404, 'NOT_IN_MEETING', 'That person is not in the meeting');
  if (!(await changeMeetingSets(meetingArn, meeting.meetingId, { add: { removedPersonIds: [target] } }))) {
    return refusal(503, 'REMOVE_FAILED', 'The person could not be removed just now; try again');
  }
  for (const a of theirs) {
    try {
      await meetings.send(new DeleteAttendeeCommand({ MeetingId: meeting.meetingId, AttendeeId: a.AttendeeId! }));
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'NotFoundException' && name !== 'ResourceNotFoundException') throw err;
    }
  }
  await fileControls(meetingArn, meeting, 'attendeeRemoved', hostId, theirs.map((a) => ({ personId: target, attendeeId: a.AttendeeId ?? null })));
  return { status: 200, body: { removed: target } };
}
