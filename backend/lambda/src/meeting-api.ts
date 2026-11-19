/**
 * THE MEETING A CONVERSATION HOLDS (SPEC-ASSISTANT-MEETINGS FR12 to FR15): Amazon Chime SDK Meetings media, bound to an
 * Amazon Chime SDK Messaging conversation.
 *
 * Person routes, on the person API with the `meetings` capability:
 *   POST /meetings         start the conversation's meeting, or join the one already running.
 *   POST /meetings/join    join the conversation's running meeting.
 *   POST /meetings/status  whether the conversation's meeting runs, and how long its ring still sounds.
 *   POST /meetings/end     end the conversation's meeting.
 *   POST /meetings/events  file what the caller's app saw of the meeting, and of its ring (`meeting-client-events.ts`).
 * And `runHandler`, which a workflow run's `start_meeting` step invokes (`router-agent-handler.ts`).
 *
 * EVERY MEETING IS ITS OWN CONVERSATION (FR27, DESIGN-ASSISTANT-MEETINGS C.7). A start from a conversation opens a
 * `meeting` conversation, a child of it at its classification, through the classification's creator, and the meeting is
 * held there: recorded on that conversation's server-only context item (`activeMeeting`), its chat the meeting's chat,
 * its members the people who may join. The conversation it was started from (its room) names it
 * (`meetingConversation`), so every route accepts either conversation and reaches the same meeting. A request names a
 * conversation and never a meeting id: nobody can address a meeting a conversation does not hold.
 *
 * ONE MEETING PER ROOM, held by one claim. A start claims the room's next meeting on the room's row
 * (`claimMeetingConversation`), and the claim holds until the meeting is recorded in its own conversation
 * (`confirmMeetingConversation`). A start that finds the claim goes to the conversation it names, where the meeting's own
 * claim (`claimActiveMeeting`) leaves one meeting, or is told the meeting is starting; it never opens a second. A start
 * from a meeting's conversation takes the same claim, so a meeting is held only in the conversation its room names now.
 * A row that cannot be read is an outage, answered as one, and never read as "no meeting".
 *
 * WHO MAY JOIN. A member of the meeting's conversation; and, by the one rule this function and the creator both apply
 * (`meeting-admission.ts`), a member of its room, who is added to the meeting's conversation alone. Being in a meeting's
 * conversation gives nothing in its room. Nothing starts or joins in an archived conversation.
 *
 * THE HOSTS (FR50, `meeting-host.ts`): every holder of the room's host roles (an incident's lead, its on-call and its
 * secondary on-call), else the person who starts the meeting; decided once at the start and recorded on it. Where a host
 * role is held, only its holders start the meeting or start it again after it ended; every member joins it while it runs.
 *
 * WHO MAY END. A host, and a moderator of its room or of its own conversation, from either conversation and without
 * joining (`mayEndMeeting`). Amazon Chime SDK also ends a meeting on its own once no attendee has been connected for five
 * continuous minutes, so a meeting nobody joins, or everyone left, ends without anyone's action.
 *
 * WHAT HOLDS THE BOUNDARY. The control-plane actions here take no resource a policy can name ahead of time (a meeting id
 * is minted by `CreateMeeting`), so the grant on them is account-wide and the boundary is this handler's:
 *   1. Every person route passes `callerReachesConversation`: the caller is a member now, proven with their own
 *      AppInstanceUser as bearer, and cleared for the conversation's classification now.
 *   2. The conversation is a channel of this deployment's app instance (`conversationChannelArn`).
 *   3. A meeting is created only under the classification read from the conversation's immutable tag, and carries it
 *      as a resource tag, so a running meeting stays attributable to its boundary.
 * An attendee is keyed by the person's AppInstanceUser id, the one person key (`ExternalUserId`).
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  ChimeSDKMeetingsClient,
  CreateMeetingCommand,
  CreateAttendeeCommand,
  DeleteMeetingCommand,
  GetMeetingCommand,
} from '@aws-sdk/client-chime-sdk-meetings';
import { randomUUID } from 'crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { meetingSettingsOf } from '../../lib/config/conversation-types';
import { userArnFor } from './lib/person-arn.js';
import type { MeetingConversationAnswer, MeetingConversationRequest } from './typed-conversation-from-event.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { callerReachesConversation, conversationChannelArn, listReach, refusalAnswer, type ConversationAccess } from './lib/conversation-access.js';
import { ListChannelMembershipsForAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { meetingCandidates, meetingRoomsOf, meetingRunsFor, type Membership } from './lib/my-meetings.js';
import { callerPersonId } from './lib/auth.js';
import { readChannelClassificationTag } from './lib/channel-classification.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { CLOCK_TOLERANCE_MS, recordClientFailures, recordsFromReport } from './lib/meeting-client-events.js';
import { fileMeetingEvents } from './lib/meeting-event-archive.js';
import { originsFrom, requestOrigin, responder, DEV_ORIGIN } from './lib/http-response.js';
import { isArchived, roomMemberMayEnter } from './lib/meeting-admission.js';
import { ringSecondsLeft, ringSecondsOf } from './lib/meeting-ring.js';
import { isHostOrModerator, isRecordedHost, mayStartMeeting, meetingHostsFor, recordedHostIds, type MeetingHost, type ModeratorReader } from './lib/meeting-host.js';
import {
  readChannelContext,
  readChannelContexts,
  claimActiveMeeting,
  releaseActiveMeeting,
  claimMeetingConversation,
  settleMeetingConversation,
  confirmMeetingConversation,
  releaseMeetingConversation,
  MEETING_OPENING_HOLD_MS,
  type ChannelContext,
} from './lib/channel-context-client.js';

import { joinsMuted, mutingReadsRoomMembership } from './lib/meeting-invites.js';
import { chargeTranscriptChars, meetingRecordedAttendee, recordMeetingAttendee, recordMeetingFact, type MeetingEndReason } from './lib/channel-context-client.js';
import { conversationIdOf } from './lib/dashboard-keys.js';
import { meetingRecordingByDefault, meetingTranscriptionEnabled, readReportedSegments } from './lib/meeting-transcript.js';
import {
  keepSegments, recordingNow, setTranscription, transcribingNow, transcriptCostOf, transcriptShareOf, transcriptWindow, writeTranscript,
} from './lib/meeting-transcription.js';
import { stopMediaCapture } from './lib/meeting-media-capture.js';
import { publishMeetingLifecycle, type LifecycleBus } from './lib/meeting-lifecycle-publish.js';
import { meetingMediaRecordingEnabled, recordingPartsOf } from './lib/meeting-recording.js';
import {
  attendeeRefusal, audioReceiveOnly, isHeld, isRemoved, joinCapabilities, keepHold, removedFrom, removeFromMeeting, requestToSpeak, setSpeaking, speakRequestsOf,
} from './lib/meeting-host-controls.js';

const LOG = '[meeting-api]';

// Read at call time, so the unconfigured answer can be exercised by a test.
const appInstanceArn = (): string => process.env.APP_INSTANCE_ARN || '';
/** This deployment's meeting metrics namespace, set by the Meetings stack beside its dashboard and alarm. */
const meetingsMetricNamespace = (): string => process.env.MEETINGS_METRIC_NAMESPACE || 'AgentEchelon/Meetings';
const mediaRegion = (): string => process.env.MEDIA_REGION || process.env.AWS_REGION || 'us-east-1';

/**
 * HOW LONG THE CREATOR IS WAITED FOR. A workflow's start answers inside the run entry's own timeout
 * (`MEETING_RUN_TIMEOUT_SECONDS`), so the creator's open is bounded well inside it, and a call that never answers ends
 * while there is still time to say so.
 */
export const CREATOR_CALL_TIMEOUT_MS = 10_000;

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN) }, methods: 'POST,OPTIONS' });

let meetings: Pick<ChimeSDKMeetingsClient, 'send'> = new ChimeSDKMeetingsClient({});
let messaging: Parameters<typeof readChannelClassificationTag>[0] = chimeMessagingClient({});
// ONE ATTEMPT: an `open` the creator is still running is never asked for a second time, so a slow open never leaves a
// second meeting conversation beside the first, and a call that does not answer ends inside the start's own timeout.
let lambda: Pick<LambdaClient, 'send'> = new LambdaClient({
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 2_000, requestTimeout: CREATOR_CALL_TIMEOUT_MS, throwOnRequestTimeout: true },
});

/** Test seam: the clients the handler calls. */
export function __setClients(c: {
  meetings?: Pick<ChimeSDKMeetingsClient, 'send'>; messaging?: Parameters<typeof readChannelClassificationTag>[0]; lambda?: Pick<LambdaClient, 'send'>;
}): void {
  if (c.meetings) meetings = c.meetings;
  if (c.messaging) messaging = c.messaging;
  if (c.lambda) lambda = c.lambda;
}

/** A conversation id from its channel ARN: the one parse every transcript writer and reader keys by. */
const idOf = conversationIdOf;

/** A route's answer: status and body, for the handler's responder. */
type Answer = { status: number; body: Record<string, unknown> };
const refusal = (status: number, code: string, error: string): Answer => ({ status, body: { error, code } });
const ARCHIVED: Answer = refusal(409, 'CONVERSATION_ARCHIVED', 'This conversation is archived');

/**
 * ASK THE CLASSIFICATION'S CREATOR (`typed-conversation-from-event.ts`) to open a meeting's conversation or admit a person
 * to one. The creator is found by its fixed name at the classification of the conversation the meeting concerns, read
 * from that conversation's tag; it checks the classification again and acts on no other.
 */
async function askCreator(classification: string, request: MeetingConversationRequest): Promise<MeetingConversationAnswer> {
  const pattern = process.env.TYPED_CREATOR_NAME_PATTERN || '';
  if (!pattern || !classification) return { ok: false, code: 'NOT_CONFIGURED' };
  try {
    const res = await lambda.send(new InvokeCommand({ FunctionName: pattern.replace('{classification}', classification), Payload: Buffer.from(JSON.stringify(request)) }));
    if (res.FunctionError || !res.Payload) {
      console.error(`${LOG} the creator failed`, { op: request.aeMeeting, functionError: res.FunctionError ?? 'no payload' });
      return { ok: false, code: 'FAILED' };
    }
    const answer = JSON.parse(Buffer.from(res.Payload).toString('utf8')) as MeetingConversationAnswer;
    return answer && typeof answer === 'object' && 'ok' in answer ? answer : { ok: false, code: 'FAILED' };
  } catch (err) {
    console.error(`${LOG} the creator could not be asked`, { op: request.aeMeeting, err: (err as Error).name });
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * WHETHER THE CALLER JOINS MUTED (SPEC-ASSISTANT-MEETINGS FR51), decided here from the room's server-side row and never by
 * the app: a person holding one of the room's speaking roles (`meetingSpeakers`) speaks, and anyone else, such as a person
 * added to the meeting alone, joins muted: the service carries none of their audio until they ask to speak
 * (`/meetings/unmute-request`). The room's membership is read, bearing the caller, only where the type's default role
 * would let them speak. A READ THAT FAILS JOINS THEM MUTED, and they may still ask to speak.
 */
async function startsMuted(event: APIGatewayProxyEvent, home: MeetingHome, personId: string, callerInRoom: boolean): Promise<boolean> {
  try {
    const roomRow = home.isMeeting ? await readChannelContext(home.roomArn, { consistent: true }) : home.row;
    if (!mutingReadsRoomMembership(roomRow, personId)) return joinsMuted(roomRow, personId, false);
    const member = callerInRoom || (await callerReachesConversation(event, home.roomArn, {})).ok;
    return joinsMuted(roomRow, personId, member);
  } catch (err) {
    console.warn(`${LOG} whether the caller joins muted could not be read; they join muted and may ask to speak`, { err: (err as Error).name });
    return true;
  }
}

/**
 * A PERSON A CONFIRMED PROPOSAL ADDED TO THE MEETING JOINED: the creator says their arrival brief, once, privately, as the
 * assistant that proposed it (`lib/meeting-additions.ts`). Asked without waiting, so the join is never held for it.
 */
async function askForArrivalBrief(classification: string, meetingArn: string, personId: string): Promise<void> {
  const pattern = process.env.TYPED_CREATOR_NAME_PATTERN || '';
  if (!pattern || !classification) return;
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: pattern.replace('{classification}', classification), InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ aeMeeting: 'arrived', meetingChannelArn: meetingArn, personArn: userArnFor(appInstanceArn(), personId) })),
    }));
  } catch (err) {
    console.warn(`${LOG} the arrival brief could not be asked for`, { err: (err as Error).name });
  }
}

/**
 * WHERE A CONVERSATION'S MEETING IS HELD: the conversation itself when it is a meeting's conversation, else the newest
 * meeting conversation it names; and the meeting's room (`roomArn`), the conversation it was started from. The row read
 * here is handed on, so one request reads each row once.
 */
interface MeetingHome { isMeeting: boolean; row: ChannelContext | null; meetingArn?: string; roomArn: string }
async function meetingHomeOf(channelArn: string): Promise<MeetingHome> {
  const row = await readChannelContext(channelArn, { consistent: true });
  if (meetingSettingsOf(row?.conversationType)) return { isMeeting: true, row, meetingArn: channelArn, roomArn: row?.meetingOf || channelArn };
  const named = row?.meetingConversation?.channelArn;
  return { isMeeting: false, row, roomArn: channelArn, ...(named ? { meetingArn: named } : {}) };
}

/** A caller who may enter a meeting's conversation: a member already, or a member of its room to be admitted (`admitFrom`). */
type Entry = { ok: true; classification: string; admitFrom?: string } | { ok: false; answer: Answer };

/**
 * MAY THE CALLER ENTER A MEETING'S CONVERSATION: already its member, or a member of its room by `roomMemberMayEnter`.
 * Decides only; `admit` adds them. What the request already knows (the caller's access to either conversation, a row) is
 * passed in rather than read again. A caller in neither conversation is told only that they are not a member.
 */
async function entryTo(
  event: APIGatewayProxyEvent, meetingArn: string,
  known: { own?: ConversationAccess; meetingRow?: ChannelContext | null; roomAccess?: ConversationAccess; roomRow?: ChannelContext | null } = {},
): Promise<Entry> {
  const own = known.own ?? await callerReachesConversation(event, meetingArn, { liveTags: true });
  if (own.ok) return isArchived(own.tags) ? { ok: false, answer: ARCHIVED } : { ok: true, classification: own.classification };
  const notOwn = (): Entry => { const r = refusalAnswer(own); return { ok: false, answer: { status: r.statusCode, body: r.body } }; };
  if (own.code !== 'NOT_A_MEMBER') return notOwn();
  const meetingRow = known.meetingRow !== undefined ? known.meetingRow : await readChannelContext(meetingArn, { consistent: true });
  const roomArn = meetingRow?.meetingOf;
  if (!roomArn || !meetingSettingsOf(meetingRow?.conversationType)) return notOwn();
  const room = known.roomAccess ?? await callerReachesConversation(event, roomArn, { liveTags: true });
  if (!room.ok) return notOwn();
  const roomRow = known.roomRow !== undefined ? known.roomRow : await readChannelContext(roomArn, { consistent: true });
  const rule = roomMemberMayEnter({ meetingArn, meetingRow, parentRow: roomRow, parentArchived: isArchived(room.tags) });
  if (rule.ok) return { ok: true, classification: room.classification, admitFrom: rule.parentArn };
  if (rule.code === 'CONVERSATION_ARCHIVED') return { ok: false, answer: ARCHIVED };
  if (rule.code === 'NOT_THE_ROOMS_MEETING') return { ok: false, answer: refusal(409, 'MEETING_MOVED', 'This meeting has ended; its conversation holds a newer one') };
  return notOwn();
}

/** ADD THE CALLER to a meeting's conversation, by the creator of its room's classification, which applies the rule again. */
async function admit(meetingArn: string, personId: string, roomArn: string, classification: string): Promise<Answer | null> {
  const admitted = await askCreator(classification, {
    aeMeeting: 'admit', meetingChannelArn: meetingArn, personArn: userArnFor(appInstanceArn(), personId), parentChannelArn: roomArn,
  });
  if (admitted.ok) return null;
  if (admitted.code === 'CONVERSATION_ARCHIVED') return ARCHIVED;
  console.warn(`${LOG} a member of the conversation a meeting was started from could not be admitted`, { code: admitted.code });
  return refusal(503, 'NOT_ADMITTED', 'You could not be added to the meeting just now; try again');
}

/** Why no meeting conversation was found or opened. */
type OpenRefusal = 'MEETING_STARTING' | 'MEETING_NOT_RECORDED' | 'CONVERSATION_NOT_OPENED' | 'MEETING_MOVED' | 'CONVERSATION_ARCHIVED';
/** Why a start did not produce the conversation's meeting. */
export type StartRefusal = 'CREATE_FAILED' | 'MEETING_RACE' | 'MEETING_NOT_RECORDED' | 'NOT_HOST';
const REFUSAL_STATUS: Record<OpenRefusal | StartRefusal, number> = {
  MEETING_STARTING: 409, MEETING_NOT_RECORDED: 503, CONVERSATION_NOT_OPENED: 502, MEETING_MOVED: 409, CONVERSATION_ARCHIVED: 409,
  CREATE_FAILED: 502, MEETING_RACE: 409, NOT_HOST: 403,
};

type ActiveMeeting = NonNullable<ChannelContext['activeMeeting']>;

/**
 * Where a start holds the meeting: `meetingArn`; `opened` when this start opened it; `token` when this start holds the
 * room's claim (given back when no meeting follows); `pending` while the room's claim waits for the meeting to be recorded;
 * `live` the meeting already running there; `roomModeratorIds` the parent conversation's moderators the creator read when it opened the
 * conversation for nobody (a workflow's start), who host a meeting no host role holder hosts.
 */
type Held = { meetingArn: string; opened: boolean; token?: string; pending: boolean; live?: ActiveMeeting; roomModeratorIds?: string[] };

/** A start's claim, held for less than {@link MEETING_OPENING_HOLD_MS}. */
const claimHeld = (mc: ChannelContext['meetingConversation'], now = Date.now()): boolean =>
  !!mc?.opening && Date.parse(mc.at) >= now - MEETING_OPENING_HOLD_MS;

/**
 * THE MEETING'S CONVERSATION FOR A START, decided on the room's claim (the module header). From the room: the conversation
 * it names while its meeting runs or a start holds it; that conversation again while it never held a meeting; else a new
 * one, opened for `forUserArn` (or for nobody, for a workflow's start). From a meeting's own conversation (`onlyIn`): only
 * while its room names it, and on the same terms, so a start after its meeting ended opens the room's next one. A claim
 * lost to another start is read once more.
 */
async function holdRoomMeeting(
  roomArn: string, roomRow: ChannelContext | null, classification: string, opts: { forUserArn?: string; onlyIn?: string }, again = false,
): Promise<Held | { refused: OpenRefusal }> {
  const mc = roomRow?.meetingConversation;
  if (opts.onlyIn && mc?.channelArn !== opts.onlyIn) return { refused: 'MEETING_MOVED' };
  const lost = async (): Promise<Held | { refused: OpenRefusal }> => again
    ? { refused: 'MEETING_STARTING' }
    : holdRoomMeeting(roomArn, await readChannelContext(roomArn, { consistent: true }), classification, opts, true);

  const token = randomUUID();
  if (mc?.channelArn) {
    const current = mc.channelArn;
    const row = await readChannelContext(current, { consistent: true });
    const live = await readLiveMeeting(current, row);
    if (live) return { meetingArn: current, opened: false, pending: !!mc.opening, live };
    if (claimHeld(mc)) return { meetingArn: current, opened: false, pending: true };
    // A conversation that never held a meeting (its start stopped short) is held again rather than left empty beside a new
    // one. One that held a meeting keeps that meeting's record, from either conversation: the next meeting is a new
    // conversation, so the ended meeting's card, transcript, summary and recording stay its own.
    const reuse = !row?.lastMeeting && (!!opts.onlyIn || !!meetingSettingsOf(row?.conversationType)?.parentMembersJoin);
    const claim = await claimMeetingConversation(roomArn, current, token, { reuse });
    if (claim === 'failed') return { refused: 'MEETING_NOT_RECORDED' };
    if (claim === 'lost') return lost();
    if (reuse) return { meetingArn: current, opened: false, token, pending: true };
    return openMeetingConversation(roomArn, classification, token, current, opts.forUserArn);
  }
  if (claimHeld(mc)) return { refused: 'MEETING_STARTING' };
  const claim = await claimMeetingConversation(roomArn, undefined, token);
  if (claim === 'failed') return { refused: 'MEETING_NOT_RECORDED' };
  if (claim === 'lost') return lost();
  return openMeetingConversation(roomArn, classification, token, undefined, opts.forUserArn);
}

/** Open a new meeting conversation under the room's claim `token`; a creator that does not open one gives the claim back. */
async function openMeetingConversation(
  roomArn: string, classification: string, token: string, prior: string | undefined, forUserArn?: string,
): Promise<Held | { refused: OpenRefusal }> {
  const opened = await askCreator(classification, { aeMeeting: 'open', parentChannelArn: roomArn, ...(forUserArn ? { forUserArn } : {}) });
  if (!opened.ok) {
    console.error(`${LOG} the meeting's conversation was not opened`, { code: opened.code });
    await releaseMeetingConversation(roomArn, token, prior);
    return { refused: opened.code === 'CONVERSATION_ARCHIVED' ? 'CONVERSATION_ARCHIVED' : 'CONVERSATION_NOT_OPENED' };
  }
  if (!(await settleMeetingConversation(roomArn, token, opened.channelArn))) {
    // The room does not name it, so no meeting is held there: nobody in the room could find it.
    console.warn(`${LOG} the meeting's conversation opened after its claim was taken over; no meeting is held in it`, { channelArn: opened.channelArn });
    return { refused: 'MEETING_NOT_RECORDED' };
  }
  // THE REST OF THE ROOM IS CARRIED AFTER THE ANSWER: the creator answered with some of its people not yet members.
  if (opened.carryLeft) await askCreatorToCarry(classification, opened.channelArn, roomArn);
  return { meetingArn: opened.channelArn, opened: true, token, pending: true, ...(opened.roomModeratorIds?.length ? { roomModeratorIds: opened.roomModeratorIds } : {}) };
}

/**
 * THE ROOM'S PEOPLE NOT CARRIED BY THE OPEN'S ANSWER are carried by the creator after it (`carry`), asked without waiting, so
 * the start is never held for a large room. A request that cannot be sent leaves them to enter by joining.
 */
async function askCreatorToCarry(classification: string, meetingArn: string, roomArn: string): Promise<void> {
  const pattern = process.env.TYPED_CREATOR_NAME_PATTERN || '';
  if (!pattern || !classification) return;
  try {
    const request: MeetingConversationRequest = { aeMeeting: 'carry', meetingChannelArn: meetingArn, parentChannelArn: roomArn };
    await lambda.send(new InvokeCommand({
      FunctionName: pattern.replace('{classification}', classification), InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(request)),
    }));
  } catch (err) {
    console.warn(`${LOG} the rest of the room could not be asked for; they enter by joining`, { err: (err as Error).name });
  }
}

/** What a start or a join answers: what the client SDK connects with, and the boundary the meeting runs inside. */
export interface JoinInfo {
  meeting: unknown;
  attendee: unknown;
  classification: string;
  startedAt: string;
}

/**
 * A MEETING THE SERVICE SAID IS RUNNING, kept for {@link RUNNING_KEPT_MS} in this container, for the reports alone: every
 * attendee's app reports once a minute, so a meeting's reports ask the service about once per window rather than once per
 * report. Only "running" is kept; a meeting found gone, or a question that could not be answered, is asked again. A start,
 * a join and a status read always ask the service.
 */
const runningSeen = new Map<string, number>();
const RUNNING_KEPT_MS = 30_000;
const RUNNING_SEEN_KEPT = 5_000;
/** Test seam: forget every meeting seen running. */
export function __forgetRunningMeetings(): void { runningSeen.clear(); }

/**
 * Is this meeting still running in Amazon Chime SDK? `undefined` when the question could not be answered. With `kept`, a
 * meeting the service said is running within the window is answered from that.
 */
async function meetingStillExists(meetingId: string, opts: { kept?: boolean } = {}): Promise<boolean | undefined> {
  const seen = runningSeen.get(meetingId);
  if (opts.kept && seen !== undefined && Date.now() - seen < RUNNING_KEPT_MS) return true;
  try {
    const res = await meetings.send(new GetMeetingCommand({ MeetingId: meetingId }));
    const running = Boolean(res.Meeting?.MeetingId);
    if (running) {
      if (!runningSeen.has(meetingId) && runningSeen.size >= RUNNING_SEEN_KEPT) runningSeen.delete(runningSeen.keys().next().value as string);
      runningSeen.set(meetingId, Date.now());
    } else runningSeen.delete(meetingId);
    return running;
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'NotFoundException' || name === 'ResourceNotFoundException') { runningSeen.delete(meetingId); return false; }
    console.warn(`${LOG} could not confirm whether the meeting is still running`, { meetingId, err: name });
    return undefined;
  }
}

/**
 * RELEASE A MEETING THAT ENDED, and record when in the same write, so the lines and the last report batch its apps send
 * just after are still kept (`lateLinesCutoff`, `reportedMeeting`). Only the release that cleared the record says when it
 * ended: the moment the service deleted it, for an end asked here; the moment it was found gone, for one found ended,
 * which the service's own end event then corrects to the service's time (`router-agent-handler.ts`).
 */
async function releaseEnded(channelArn: string, meetingId: string): Promise<'released' | 'superseded' | 'failed'> {
  return releaseActiveMeeting(channelArn, meetingId, new Date().toISOString());
}

/**
 * THE CONVERSATION'S RUNNING MEETING. Amazon Chime SDK ends a meeting once its last attendee leaves, so the recorded one
 * is checked: one that has ended is released, which frees the conversation to start the next. One whose state cannot be
 * read is treated as running and kept, and the caller can retry. `row` is the conversation's row where it was just read.
 */
async function readLiveMeeting(channelArn: string, row?: ChannelContext | null, opts: { kept?: boolean } = {}): Promise<ActiveMeeting | null> {
  // Consistent, so a join that follows the start that claimed the meeting finds it.
  const recorded = (row !== undefined ? row : await readChannelContext(channelArn, { consistent: true }))?.activeMeeting;
  if (!recorded?.meetingId) return null;
  if (await meetingStillExists(recorded.meetingId, opts) === false) {
    const outcome = await releaseEnded(channelArn, recorded.meetingId);
    console.log(`${LOG} released a meeting Amazon Chime SDK had ended`, { channelArn, meetingId: recorded.meetingId, outcome });
    return null;
  }
  return recorded;
}

let lifecycleBus: LifecycleBus | undefined;
/** Test seam: the bus a person's attendance is published on. */
export function __setLifecycleBus(b: LifecycleBus): void { lifecycleBus = b; }

/**
 * A PERSON TOOK THE MEETING (`person-attended`): published once their attendee is created, so the meeting conversation's
 * router sends them a ring-off addressed to them alone, and their other tabs and devices stop ringing for it (the sibling
 * project's cancel on accept). Never throws: a ring left sounding elsewhere ends on its own.
 */
async function publishAttended(meetingArn: string, meeting: ActiveMeeting, personId: string): Promise<void> {
  const instance = process.env.MEETING_LIFECYCLE_INSTANCE || '';
  if (!instance) return;
  try {
    await publishMeetingLifecycle({
      instance, classification: meeting.classification, channelArn: meetingArn, meetingId: meeting.meetingId,
      event: 'person-attended', at: new Date().toISOString(), personId,
    }, lifecycleBus);
  } catch (err) {
    console.warn(`${LOG} a person's attendance could not be published; a ring elsewhere ends on its own`, { err: (err as Error).name });
  }
}

/** This person's attendee in the meeting, and what the client SDK needs to connect. Their attendance is published. */
async function joinInfoFor(meetingArn: string, meeting: ActiveMeeting, personId: string, joinsMuted = false): Promise<JoinInfo & { receiveOnly: boolean }> {
  // RECEIVE-ONLY FROM THE FIRST PACKET for a person who joins muted or whom a host holds; a host's hold is kept on the
  // attendee the service answers again on a rejoin (`meeting-host-controls.ts`).
  const capabilities = joinCapabilities(meeting, personId, joinsMuted);
  const created = await meetings.send(new CreateAttendeeCommand({ MeetingId: meeting.meetingId, ExternalUserId: personId, ...(capabilities ? { Capabilities: capabilities } : {}) }));
  const attendee = await keepHold(meetings, meeting, personId, created.Attendee);
  if (attendee?.AttendeeId) {
    // THE MEETING RECORDS WHOSE ATTENDEE THIS IS, so a line reported once the service has ended the meeting is kept only
    // from an attendee it created for that person. One that cannot be recorded costs only that person's late lines.
    if (!(await recordMeetingAttendee(meetingArn, meeting.meetingId, personId, attendee.AttendeeId))) {
      console.warn(`${LOG} the attendee could not be recorded on the meeting; their lines after its end are not kept`, { meetingId: meeting.meetingId });
    }
    await publishAttended(meetingArn, meeting, personId);
  }
  return { meeting: meeting.meeting, attendee, classification: meeting.classification, startedAt: meeting.createdAt, receiveOnly: audioReceiveOnly(attendee) };
}

/** What a join answers of the caller's audio: muted on joining, receive-only on the service, held by a host, and for a host who asks to speak. */
function audioAnswer(meeting: ActiveMeeting, personId: string, joinsMuted: boolean, info: { receiveOnly: boolean }): Record<string, unknown> {
  const held = isHeld(meeting, personId);
  return {
    startMuted: joinsMuted || info.receiveOnly, receiveOnly: info.receiveOnly, mutedByHost: held,
    ...(isRecordedHost(meeting, personId) ? { speakRequests: speakRequestsOf(meeting) } : {}),
  };
}

/**
 * WHAT A START, A JOIN AND A STATUS READ SAY OF THE MEETING'S TRANSCRIPTION, from its conversation's record: whether it is
 * captioned now (`transcribing`), whether it is recorded now (`recording`: its transcript kept and summarized), and
 * whether its audio and video are being captured now (`mediaRecording`: a recording part of this meeting is capturing),
 * so every app says so before anyone is heard, and a session that reconnects reads it again.
 */
function transcriptionAnswer(row: ChannelContext | null | undefined, meetingId: string): { transcribing: boolean; recording: boolean; mediaRecording: boolean } {
  const recording = recordingNow(row, meetingId);
  const last = row?.lastMeeting;
  const mediaRecording = recording && meetingMediaRecordingEnabled() && last?.meetingId === meetingId
    && recordingPartsOf(last.recordings).some((p) => p.state === 'capturing');
  return { transcribing: transcribingNow(row, meetingId), recording, mediaRecording };
}

/**
 * THE PLATFORM RECORDS THAT IT CREATED THE MEETING, and by which path: a person's start, or a workflow's. The start that
 * creates a meeting is the one that rings the room, so this is also when the ring went out, and a ring's answer is
 * timed from it. It carries the Region the service hosts the meeting's media in and the hosts decided at the start, by
 * AppInstanceUser id, so the console shows both from the record. A record that cannot be filed is logged and the
 * meeting runs: the service's own lifecycle still records the start.
 */
async function recordCreated(record: ActiveMeeting, channelArn: string, startedVia: 'person' | 'workflow'): Promise<void> {
  const region = (record.meeting as { MediaRegion?: string } | undefined)?.MediaRegion;
  const hosts = (record.hosts ?? []).map((h) => h.personId).filter(Boolean);
  try {
    await fileMeetingEvents([{
      meeting_id: record.meetingId, channel_arn: channelArn, classification: record.classification, event_type: 'meetingCreated',
      source: 'platform', attendee_id: null, person_key: record.createdBy || null, is_content: false, network_transport: null,
      event_at: record.createdAt, detail: { startedVia, ...(region ? { mediaRegion: region } : {}), ...(hosts.length ? { hosts } : {}) },
    // FILED ONCE THE ARCHIVE HOLDS IT: a projection that fails is handed on and retried from the archive, never lost.
    }], undefined, { projection: 'best-effort' });
  } catch (err) {
    console.warn(`${LOG} the meeting's creation could not be filed`, { meetingId: record.meetingId, err: (err as Error).name });
  }
}

/** Who starts a meeting, by which path, how long its ring sounds, and the meeting already found running, if any. */
interface StartBy {
  by: string; via: 'person' | 'workflow'; ringSeconds: number;
  /** Whether the person is a member of the meeting's room now: asked only of a start from a meeting's own conversation. */
  inRoom?: () => Promise<boolean>;
}

/** What the room decided for a start: who hosts a meeting it creates, and whether this start may create one. */
interface Hosting { hosts?: MeetingHost[]; hostVia?: 'role' | 'starter' | 'moderators'; mayCreate: boolean }

/**
 * The parent conversation's answer for a start (`meeting-host.ts`): a workflow's start always may create; a person's, where they may host.
 * A workflow's start with no host role held is hosted by the parent conversation's moderators the creator read (`roomModeratorIds`).
 */
function hostingFor(roomRow: ChannelContext | null | undefined, start: StartBy, roomModeratorIds: readonly string[] = []): Hosting {
  return { ...meetingHostsFor(roomRow, start, roomModeratorIds), mayCreate: start.via === 'workflow' || mayStartMeeting(roomRow, start.by) };
}

/**
 * START THE CONVERSATION'S MEETING, or find the one running. One path for a person and a workflow run, so both claim it
 * the same way: `claimActiveMeeting` writes only where no meeting is recorded, and a start that loses the race deletes
 * the meeting it made and takes the winner's. `recorded` settles once the creation is filed, beside the caller's own
 * next call rather than before it.
 */
async function startOrFind(
  channelArn: string, classification: string, start: StartBy, hosting: Hosting, live?: ActiveMeeting | null,
): Promise<{ meeting: ActiveMeeting; created: boolean; recorded: Promise<void> } | { refused: StartRefusal }> {
  const running = live !== undefined ? live : await readLiveMeeting(channelArn);
  if (running) return { meeting: running, created: false, recorded: Promise.resolve() };
  // Starting, and starting again after it ended, is the host's where the room has a host role held.
  if (!hosting.mayCreate) return { refused: 'NOT_HOST' };

  const created = await meetings.send(new CreateMeetingCommand({
    ClientRequestToken: randomUUID(),
    MediaRegion: mediaRegion(),
    // The channel id (2 to 64 characters), so a meeting is traceable to its conversation in the Amazon Chime SDK console.
    ExternalMeetingId: (channelArn.split('/').pop() || randomUUID()).slice(0, 64),
    Tags: [{ Key: 'classification', Value: classification }],
  }));
  const meeting = created.Meeting;
  if (!meeting?.MeetingId) {
    console.error(`${LOG} CreateMeeting returned no meeting`, { channelArn });
    return { refused: 'CREATE_FAILED' };
  }
  const record: ActiveMeeting = {
    meetingId: meeting.MeetingId, meeting, classification, createdAt: new Date().toISOString(), createdBy: start.by, startedVia: start.via,
    ringSeconds: start.ringSeconds,
    ...(hosting.hosts ? { hosts: hosting.hosts, ...(hosting.hostVia ? { hostVia: hosting.hostVia } : {}) } : {}),
  };
  const claim = await claimActiveMeeting(channelArn, record);
  if (claim === 'claimed') {
    console.log(`${LOG} meeting started`, { channelArn, meetingId: meeting.MeetingId, classification });
    // TRANSCRIBED FROM ITS START where the deployment transcribes its meetings, started with the meeting.
    // Every person is told before their audio is heard: on joining, and in the meeting's chat when the service confirms.
    const transcribed = meetingTranscriptionEnabled()
      ? setTranscription(meetings, { meetingArn: channelArn, meetingId: meeting.MeetingId, classification }, { on: true, recording: meetingRecordingByDefault() }, 'platform', null).then(() => undefined)
      : Promise.resolve();
    return { meeting: record, created: true, recorded: Promise.all([recordCreated(record, channelArn, start.via), transcribed]).then(() => undefined) };
  }
  // The conversation's meeting is somebody else's (`lost`), or this one could not be recorded (`failed`). Either way
  // this one is deleted now, while this request still knows it exists.
  await meetings.send(new DeleteMeetingCommand({ MeetingId: meeting.MeetingId }))
    .catch((err) => console.warn(`${LOG} could not delete an unrecorded meeting`, { meetingId: meeting.MeetingId, err: (err as Error).name }));
  if (claim === 'failed') return { refused: 'MEETING_NOT_RECORDED' };
  const winner = await readLiveMeeting(channelArn);
  return winner ? { meeting: winner, created: false, recorded: Promise.resolve() } : { refused: 'MEETING_RACE' };
}

/**
 * A START, FROM A ROOM OR FROM A MEETING'S CONVERSATION: hold the room's claim (`holdRoomMeeting`), let the caller in where
 * they are not a member yet (`enter`), start or find the meeting, then confirm the room's claim, or give it back when no
 * meeting followed. A meeting's conversation that names no room holds its meeting on its own claim alone.
 */
type HomeStart = { meetingArn: string; meeting: ActiveMeeting; created: boolean; recorded: Promise<void> } | { refused: OpenRefusal | StartRefusal };
/** A start that lets nobody in (a workflow run's): it is answered a meeting or a refusal, never an admission's answer. */
async function startInHome(home: MeetingHome, classification: string, start: StartBy & { forUserArn?: string }): Promise<HomeStart>;
/** A person's start, which lets the caller in where they are not a member yet (`enter`). */
async function startInHome(
  home: MeetingHome, classification: string, start: StartBy & { forUserArn?: string }, enter: (held: Held) => Promise<Answer | null>,
): Promise<HomeStart | { answer: Answer }>;
async function startInHome(
  home: MeetingHome, classification: string, start: StartBy & { forUserArn?: string },
  enter?: (held: Held) => Promise<Answer | null>,
): Promise<HomeStart | { answer: Answer }> {
  if (home.isMeeting && !home.row?.meetingOf) {
    const here = home.meetingArn as string;
    const started = await startOrFind(here, classification, start, hostingFor(home.row, start), await readLiveMeeting(here, home.row));
    return 'refused' in started ? started : { meetingArn: here, ...started };
  }
  const roomArn = home.roomArn;
  const roomRow = home.isMeeting ? await readChannelContext(roomArn, { consistent: true }) : home.row;
  let hosting = hostingFor(roomRow, start);
  // A PERSON STARTS A MEETING IN A ROOM ONLY AS ITS MEMBER: one added to a meeting alone joins the meeting that runs, and
  // starts, hosts and announces nothing in a room they are not in.
  if (hosting.mayCreate && start.via === 'person' && home.isMeeting && !(await start.inRoom?.())) hosting = { mayCreate: false };
  // A PERSON WHO MAY NOT HOST joins the meeting that runs and opens nothing: with none running, they are refused before
  // any conversation is opened for a meeting they may not start.
  if (!hosting.mayCreate) {
    const named = home.isMeeting ? home.meetingArn : roomRow?.meetingConversation?.channelArn;
    if (!named || !(await readLiveMeeting(named))) return { refused: 'NOT_HOST' };
  }
  const held = await holdRoomMeeting(roomArn, roomRow, classification, {
    ...(home.isMeeting ? { onlyIn: home.meetingArn } : {}), ...(start.forUserArn ? { forUserArn: start.forUserArn } : {}),
  });
  if ('refused' in held) return held;
  const giveBack = async (): Promise<void> => { if (held.token) await releaseMeetingConversation(roomArn, held.token, held.meetingArn); };
  const notEntered = enter ? await enter(held) : null;
  if (notEntered) {
    await giveBack();
    return { answer: notEntered };
  }
  // A WORKFLOW'S MEETING IN A PARENT CONVERSATION WITH NO HOST ROLE HELD is hosted by the parent conversation's moderators (FR50).
  if (held.roomModeratorIds?.length && hosting.mayCreate && !hosting.hosts) hosting = hostingFor(roomRow, start, held.roomModeratorIds);
  const started = await startOrFind(held.meetingArn, classification, start, hosting, held.live);
  if ('refused' in started) {
    await giveBack();
    return started;
  }
  if (held.pending && !(await confirmMeetingConversation(roomArn, held.meetingArn))) {
    console.warn(`${LOG} the room's claim on its meeting could not be confirmed; it lapses after its hold`, { roomArn });
  }
  return { meetingArn: held.meetingArn, ...started };
}

/**
 * WHO MAY END A MEETING, for everyone and without joining it: one of its hosts, and a moderator of its room or of its own
 * conversation. A room's lead, on-call and secondary on-call hold participant roles that confer moderation
 * (`conversation-types.ts`), so they end a meeting a workflow started as the assistant even where no host role was held
 * at its start. Moderation is read live, never from a copy, and an unreadable answer denies.
 */
async function mayEndMeeting(recorded: ActiveMeeting, personId: string, conversations: { roomArn: string; meetingArn: string }): Promise<boolean> {
  return isHostOrModerator(recorded, { personId, personArn: userArnFor(appInstanceArn(), personId) }, conversations, messaging as unknown as ModeratorReader);
}

/**
 * END THE CONVERSATION'S MEETING, for a caller `mayEndMeeting` admits. The record is cleared once Amazon Chime SDK
 * confirms the meeting is gone; a delete that fails keeps the record, so the meeting stays reachable to end again.
 *
 * A MEETING THAT DID NOT END IS LEFT AS IT RAN: its capture is stopped only once the service has deleted the meeting, and
 * the reason recorded for its ended card is put back where the delete fails, so a meeting that keeps running is still
 * recorded while its joiners are told it is, and its record never says a host ended it.
 */
async function endMeeting(channelArn: string, row: ChannelContext | null, reason?: MeetingEndReason): Promise<Answer> {
  const recorded = row?.activeMeeting;
  if (!recorded?.meetingId) return { status: 200, body: { ended: false, reason: 'no active meeting' } };
  // WHY IT ENDS, recorded before the end so the ended card the service's end event raises can say it.
  const priorReason = row?.lastMeeting?.meetingId === recorded.meetingId ? row.lastMeeting.endReason : undefined;
  if (reason) await recordMeetingFact(channelArn, recorded.meetingId, { endReason: reason });
  try {
    await meetings.send(new DeleteMeetingCommand({ MeetingId: recorded.meetingId }));
  } catch (err) {
    const name = (err as Error).name;
    if (name !== 'NotFoundException' && name !== 'ResourceNotFoundException') {
      console.warn(`${LOG} DeleteMeeting failed; the record is kept`, { meetingId: recorded.meetingId, err: name });
      if (reason && priorReason !== reason) await recordMeetingFact(channelArn, recorded.meetingId, { endReason: (priorReason ?? null) as MeetingEndReason });
      return refusal(502, 'END_FAILED', 'The meeting could not be ended. Try again');
    }
  }
  // ITS AUDIO AND VIDEO CAPTURE IS STOPPED AND JOINED INTO ONE FILE once the meeting is gone (`meeting-media-capture.ts`);
  // a capture the service already stopped with the meeting is joined all the same.
  await stopMediaCapture({ meetingArn: channelArn, meetingId: recorded.meetingId, classification: recorded.classification });
  const released = await releaseEnded(channelArn, recorded.meetingId);
  if (released === 'failed') return refusal(503, 'RELEASE_FAILED', 'The meeting was ended but the conversation could not be updated');
  console.log(`${LOG} meeting ended`, { channelArn, meetingId: recorded.meetingId, released });
  return { status: 200, body: { ended: true } };
}

/**
 * WHICH MEETING A REPORT IS FILED AGAINST, or why it is refused. The conversation's running meeting takes a report from an
 * attendee the service confirms is the caller's, and a ring outcome from the caller alone.
 *
 * THE LAST BATCH OF A MEETING THAT JUST ENDED is filed too: an app sends what it holds as its person leaves, and when the
 * meeting ends for everyone that report arrives after the service has deleted the meeting, which then answers for no
 * attendee. It is filed against the conversation's last meeting where that meeting's own record (`lastMeeting`, written
 * by the server) names the attendee as one the meeting created for the caller (`attendeeKeys`), and the meeting ended no
 * longer ago than the clock tolerance an event's own time is held to (`CLOCK_TOLERANCE_MS`). Nothing in the body chooses
 * the meeting.
 */
async function reportedMeeting(
  channelArn: string, personId: string, attendeeId: unknown, classification: string, row: ChannelContext | null | undefined, now: number,
): Promise<{ meetingId: string; classification: string; attendeeId: string | null } | { refused: Answer; reason: string; meetingId?: string }> {
  // A REPORT TAKES THE SERVICE'S RECENT "RUNNING" (`RUNNING_KEPT_MS`): a meeting's apps report once a minute each.
  const running = await readLiveMeeting(channelArn, row, { kept: true });
  if (running) {
    if (attendeeId === undefined || attendeeId === null) return { meetingId: running.meetingId, classification: running.classification, attendeeId: null };
    const notYours = await attendeeRefusal(meetings, running.meetingId, attendeeId, personId);
    if (notYours) return { refused: notYours, reason: String(notYours.body.code), meetingId: running.meetingId };
    return { meetingId: running.meetingId, classification: running.classification, attendeeId: attendeeId as string };
  }
  const noMeeting = refusal(404, 'NO_ACTIVE_MEETING', 'No meeting is running in this conversation');
  // A meeting released just now is read again, so its record says it ended and when.
  const rowNow = !row?.activeMeeting ? row : await readChannelContext(channelArn, { consistent: true });
  const last = rowNow?.lastMeeting;
  if (!last?.meetingId || rowNow?.activeMeeting?.meetingId === last.meetingId) return { refused: noMeeting, reason: 'NO_MEETING' };
  if (typeof attendeeId !== 'string' || !attendeeId || attendeeId.length > 128) {
    return { refused: noMeeting, reason: 'ENDED_NO_ATTENDEE', meetingId: last.meetingId };
  }
  const endedAt = Date.parse(last.endedAt ?? '');
  if (!Number.isFinite(endedAt) || now - endedAt > CLOCK_TOLERANCE_MS) {
    return { refused: noMeeting, reason: 'ENDED_TOO_LONG_AGO', meetingId: last.meetingId };
  }
  if (!meetingRecordedAttendee(rowNow, last.meetingId, personId, attendeeId)) {
    return { refused: refusal(403, 'NOT_YOUR_ATTENDEE', 'That attendee is not yours in this meeting'), reason: 'ENDED_NOT_YOUR_ATTENDEE', meetingId: last.meetingId };
  }
  return { meetingId: last.meetingId, classification, attendeeId };
}

/**
 * FILE WHAT THE CALLER'S APP REPORTS about the conversation's meeting, as `source: client` events, against the meeting
 * `reportedMeeting` names: the running one, or the last batch of one that just ended.
 *
 * EVERY REFUSAL IS LOGGED with its reason and the meeting, never the report's content, so a report the server turned away
 * is counted rather than lost without trace: the app does not retry one.
 */
async function reportEvents(
  channelArn: string, personId: string, attendeeId: unknown, events: unknown, classification: string, row?: ChannelContext | null,
): Promise<Answer> {
  const now = Date.now();
  const refused = (out: Answer, reason: string, meetingId?: string): Answer => {
    console.warn(`${LOG} a meeting event report was refused`, { reason, status: out.status, ...(meetingId ? { meetingId } : {}) });
    return out;
  };
  const target = await reportedMeeting(channelArn, personId, attendeeId, classification, row, now);
  if ('refused' in target) return refused(target.refused, target.reason, target.meetingId);
  const report = recordsFromReport(events, {
    meetingId: target.meetingId, channelArn, classification: target.classification, personId, attendeeId: target.attendeeId, now,
  });
  if ('refused' in report) return refused(refusal(400, report.refused, 'The report could not be read'), report.refused, target.meetingId);
  if (report.records.length === 0) return { status: 202, body: { filed: 0, skipped: report.skipped } };
  try {
    // FILED ONCE THE ARCHIVE HOLDS THEM. The app does not retry a report, so an answer of failure after the archive took
    // the events would lose a batch that was in fact filed; the projection is rebuildable from the archive.
    await fileMeetingEvents(report.records, undefined, { projection: 'best-effort' });
    // The alarm's series, written only once the events are in the record it summarizes.
    recordClientFailures(report.records, meetingsMetricNamespace());
  } catch (err) {
    console.error(`${LOG} the report could not be filed`, { err: (err as Error).name });
    return refusal(503, 'UNAVAILABLE', 'The report could not be filed just now');
  }
  return { status: 202, body: { filed: report.records.length, skipped: report.skipped } };
}

/** The most pages of the caller's memberships the list of their meetings reads, fifty conversations a page. */
const MY_MEETINGS_MAX_PAGES = 20;

/**
 * THE MEETINGS THE CALLER CAN JOIN NOW (`POST /meetings/mine`, `lib/my-meetings.ts`): their conversations, listed bearing
 * the caller so only their own memberships answer; those conversations' rows and their meetings' rows, read in batches;
 * each meeting kept only where the caller reaches the conversation that admits them (a member now, cleared for it now)
 * and the service says it still runs. It creates nothing. A read that cannot be completed answers 503, never a shorter list.
 *
 * With them, `rooms`: each of the caller's meeting conversations, running or ended, with the room its row names
 * (`meetingOf`, server-written), where the caller is a member of both, so the app files a meeting's conversation under its
 * room by an answer no member can write.
 */
async function myMeetings(event: APIGatewayProxyEvent, personId: string): Promise<Answer> {
  const personArn = userArnFor(appInstanceArn(), personId);
  const memberships: Membership[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  try {
    do {
      pages += 1;
      const res = await (messaging as unknown as { send(c: unknown): Promise<{ ChannelMemberships?: Array<{ ChannelSummary?: { ChannelArn?: string; Name?: string } }>; NextToken?: string }> })
        .send(new ListChannelMembershipsForAppInstanceUserCommand({ AppInstanceUserArn: personArn, ChimeBearer: personArn, MaxResults: 50, NextToken: nextToken }));
      for (const m of res.ChannelMemberships ?? []) {
        if (m.ChannelSummary?.ChannelArn) memberships.push({ channelArn: m.ChannelSummary.ChannelArn, ...(m.ChannelSummary.Name ? { name: m.ChannelSummary.Name } : {}) });
      }
      nextToken = res.NextToken;
    } while (nextToken && pages < MY_MEETINGS_MAX_PAGES);
  } catch (err) {
    console.warn(`${LOG} the caller's conversations could not be listed`, { err: (err as Error).name });
    return refusal(503, 'UNAVAILABLE', 'Your meetings could not be read just now; try again');
  }
  const fields = ['conversationType', 'meetingOf', 'meetingConversation', 'activeMeeting'] as const;
  let rows: Map<string, ChannelContext | null>;
  try {
    rows = await readChannelContexts(memberships.map((m) => m.channelArn), fields);
    const candidates = meetingCandidates(memberships, rows);
    const missing = candidates.flatMap((c) => [c.meetingArn, c.roomArn]).filter((arn) => !rows.has(arn));
    if (missing.length) for (const [arn, row] of await readChannelContexts(missing, fields)) rows.set(arn, row);
    // THE MEETING CONVERSATION ITSELF ADMITS THE CALLER, checked as every route checks it: a member now, cleared now.
    const reach = await listReach(event, { client: messaging as never }).reaches(candidates.map((c) => c.meetingArn));
    const reached = candidates.filter((c) => {
      const r = reach.get(c.meetingArn);
      // A REACH THAT COULD NOT BE READ IS NOT A REFUSAL: the answer is 503, never a list short of a meeting that runs.
      if (r && !r.ok && r.code === 'UNAVAILABLE') throw new Error('the reach of a meeting conversation could not be read');
      // The room's row says only whether it moved on to a newer meeting; nothing of the room is answered.
      return !!r?.ok && meetingRunsFor(c, rows.get(c.meetingArn), rows.get(c.roomArn));
    });
    // Each candidate's meeting is confirmed with the service at once, not one after another.
    const runs = await Promise.all(reached.map((c) => readLiveMeeting(c.meetingArn, rows.get(c.meetingArn))));
    const out: Array<Record<string, unknown>> = [];
    reached.forEach((c, i) => {
      const running = runs[i];
      // A PERSON A HOST REMOVED is not offered the meeting they would be refused (`join` and `status` say the same).
      if (!running || isRemoved(running, personId)) return;
      const left = ringSecondsLeft(running);
      out.push({
        conversationId: idOf(c.meetingArn), roomConversationId: idOf(c.roomArn), ...(c.name ? { name: c.name } : {}),
        startedAt: running.createdAt, isHost: isRecordedHost(running, personId), ...(left > 0 ? { ringSecondsLeft: left } : {}),
      });
    });
    out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const rooms = meetingRoomsOf(memberships, rows).map((r) => ({ conversationId: idOf(r.meetingArn), roomConversationId: idOf(r.roomArn) }));
    return { status: 200, body: { meetings: out, rooms, ...(nextToken ? { partial: true } : {}) } };
  } catch (err) {
    console.warn(`${LOG} the caller's meetings could not be read`, { err: (err as Error).name });
    return refusal(503, 'UNAVAILABLE', 'Your meetings could not be read just now; try again');
  }
}

/** The person routes, each its own API resource. */
type Route = 'start' | 'join' | 'status' | 'end' | 'events' | 'transcription' | 'transcript' | 'speaking' | 'remove' | 'unmute-request' | 'mine';
const ROUTES: Readonly<Record<string, Route>> = {
  '/meetings': 'start', '/meetings/join': 'join', '/meetings/status': 'status', '/meetings/end': 'end', '/meetings/events': 'events', '/meetings/mine': 'mine',
  '/meetings/transcription': 'transcription', '/meetings/transcript': 'transcript',
  '/meetings/speaking': 'speaking', '/meetings/remove': 'remove', '/meetings/unmute-request': 'unmute-request',
};
const routeOf = (event: APIGatewayProxyEvent): Route | undefined =>
  ROUTES[(event.resource || '').replace(/\/+$/, '')] ?? ROUTES[(event.path || '').replace(/\/+$/, '')];

/** The person routes. */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origin = requestOrigin(event);
  if (event.httpMethod === 'OPTIONS') return http.empty(204, origin);
  if (!appInstanceArn()) {
    console.error(`${LOG} APP_INSTANCE_ARN is unset; refusing`);
    return http.respond(503, { error: 'Meetings are not configured', code: 'NOT_CONFIGURED' }, origin);
  }
  const route = routeOf(event);
  if (!route) return http.respond(404, { error: 'No such meeting route', code: 'NOT_FOUND' }, origin);
  const answer = (a: Answer) => http.respond(a.status, a.body, origin);

  let body: { conversationId?: unknown; channelArn?: unknown; attendeeId?: unknown; events?: unknown; on?: unknown; recording?: unknown; segments?: unknown; personId?: unknown; allow?: unknown } = {};
  try {
    body = event.body ? JSON.parse(event.body) as typeof body : {};
  } catch {
    return answer(refusal(400, 'INVALID_BODY', 'The body is not JSON'));
  }
  // THE CALLER'S OWN MEETINGS name no conversation: each one found is checked as its own route would check it.
  if (route === 'mine') {
    try {
      await loadProfileRegistry();
    } catch {
      return answer(refusal(503, 'UNAVAILABLE', 'Your meetings could not be read just now; try again'));
    }
    const me = await callerPersonId(event);
    if (!me) return answer(refusal(403, 'NOT_A_PERSON_SESSION', 'This request must be made from a person\'s own sign-in'));
    return answer(await myMeetings(event, me));
  }
  const named = conversationChannelArn(body.conversationId ?? body.channelArn, appInstanceArn());
  if (!named) return answer(refusal(400, 'INVALID_CONVERSATION', 'Name one conversation of this deployment'));

  // EVERY ROUTE, END INCLUDED: a member now, cleared for the conversation now. Nothing is read for a caller refused here,
  // except where a start, a join or a status read names a meeting's conversation the caller may enter from its room
  // (`entryTo`): a start and a join admit them, and a status read answers them as the join would, admitting nobody.
  const entering = route === 'start' || route === 'join';
  const mayEnterFromRoom = entering || route === 'status';
  let access: ConversationAccess;
  try {
    await loadProfileRegistry();
    access = await callerReachesConversation(event, named, entering ? { liveTags: true } : {});
  } catch (err) {
    console.error(`${LOG} the conversation check could not run`, { err: (err as Error).name });
    return answer(refusal(503, 'UNAVAILABLE', 'The conversation could not be checked just now; try again'));
  }
  const personId = await callerPersonId(event);

  try {
    let admitFrom: string | undefined;
    let classification: string;
    // AN ARCHIVED MEETING CONVERSATION STARTS ITS ROOM'S NEXT MEETING, in a new conversation, and holds none itself.
    const archivedHere = access.ok && isArchived(access.tags);
    if (access.ok) {
      if (entering && archivedHere && route !== 'start') return answer(ARCHIVED);
      classification = access.classification;
    } else if (mayEnterFromRoom && access.code === 'NOT_A_MEMBER' && personId) {
      // A MEETING'S CONVERSATION THE CALLER IS NOT IN YET, named from the meeting's link: a member of its room enters it
      // by the rule, once the route knows there is a meeting to enter.
      const entry = await entryTo(event, named, { own: access });
      if (!entry.ok) return answer(entry.answer);
      admitFrom = entry.admitFrom;
      classification = entry.classification;
    } else {
      const { statusCode, body: refused } = refusalAnswer(access);
      return http.respond(statusCode, refused, origin);
    }
    if (!personId) return answer(refusal(403, 'NOT_A_PERSON_SESSION', 'This request must be made from a person\'s own sign-in'));

    const home = await meetingHomeOf(named);
    if (archivedHere && route === 'start' && !(home.isMeeting && home.row?.meetingOf)) return answer(ARCHIVED);
    const meetingArn = home.meetingArn;
    // Whether the caller is a member of the meeting's room now: from the room, the check above; entered from the room, the
    // rule that admitted them; from a meeting's own conversation, asked as the person.
    // A ROOM CHECK THAT COULD NOT BE ANSWERED IS AN OUTAGE, answered 503 so the caller retries, never "not in the room".
    const inRoom = async (): Promise<boolean> => {
      if (!home.isMeeting) return access.ok;
      if (admitFrom) return true;
      const room = await callerReachesConversation(event, home.roomArn, { liveTags: true });
      if (!room.ok && room.code === 'UNAVAILABLE') throw Object.assign(new Error('the room could not be checked'), { name: 'ChannelContextUnreadable' });
      return room.ok;
    };
    const room = { roomConversationId: idOf(home.roomArn) };
    /** The meeting conversation's row, read once a request: the row already read where the caller named that conversation. */
    let meetingRowRead: Promise<ChannelContext | null> | undefined;
    const meetingRowOf = (): Promise<ChannelContext | null> => (meetingRowRead ??= home.isMeeting
      ? Promise.resolve(home.row)
      : readChannelContext(meetingArn as string, { consistent: true }));
    /**
     * THE ONE ANSWER FOR ENTERING THE RUNNING MEETING, from a join or a start: what the client SDK connects with, who
     * hosts and may end it, who was removed, the caller's audio and whether it is transcribed and recorded now. `after`
     * settles before the row is read (a start's filing of its transcription); `row` is the meeting's row where it is current.
     */
    const enterAnswer = async (
      target: string, meeting: ActiveMeeting, muted: boolean, after: Promise<void>, row?: ChannelContext | null,
    ): Promise<Record<string, unknown>> => {
      const [info, mayEnd] = await Promise.all([
        joinInfoFor(target, meeting, personId, muted), mayEndMeeting(meeting, personId, { roomArn: home.roomArn, meetingArn: target }), after,
      ]);
      const transcription = transcriptionAnswer(row !== undefined ? row : await readChannelContext(target, { consistent: true }), meeting.meetingId);
      return {
        ...info, conversationId: idOf(target), ...room, isHost: isRecordedHost(meeting, personId), hostIds: recordedHostIds(meeting), mayEnd,
        removedIds: removedFrom(meeting), ...audioAnswer(meeting, personId, muted, info), ...transcription,
      };
    };
    const noMeeting = () => answer(refusal(404, 'NO_ACTIVE_MEETING', 'No meeting is running in this conversation'));
    // A caller entering the meeting's conversation: by the link (checked above), or from its room, by the same rule.
    const enterMeeting = async (target: string): Promise<Answer | null> => {
      if (admitFrom) return admit(target, personId, admitFrom, classification);
      if (home.isMeeting) return null;
      const entry = await entryTo(event, target, { roomAccess: access, roomRow: home.row });
      if (!entry.ok) return entry.answer;
      return entry.admitFrom ? admit(target, personId, entry.admitFrom, classification) : null;
    };

    switch (route) {
      case 'events': {
        if (!meetingArn) {
          console.warn(`${LOG} a meeting event report was refused`, { reason: 'NO_MEETING_CONVERSATION', status: 404 });
          return noMeeting();
        }
        return answer(await reportEvents(meetingArn, personId, body.attendeeId, body.events, classification, await meetingRowOf()));
      }
      case 'speaking':
      case 'remove': {
        // A HOST'S CONTROLS OVER THE PEOPLE IN THE RUNNING MEETING (`meeting-host-controls.ts`): the host is checked there
        // against the hosts recorded on the meeting, from either conversation.
        if (!meetingArn) return noMeeting();
        const running = await readLiveMeeting(meetingArn, await meetingRowOf());
        if (!running) return noMeeting();
        return answer(route === 'speaking'
          ? await setSpeaking(meetings, meetingArn, running, personId, body.personId, body.allow)
          : await removeFromMeeting(meetings, meetingArn, running, personId, body.personId));
      }
      case 'unmute-request': {
        // A PERSON ASKS TO SPEAK, for their own attendees only: granted at once where the room's speaking roles muted them,
        // recorded for a host where a host holds them (`meeting-host-controls.ts`).
        if (!meetingArn) return noMeeting();
        const running = await readLiveMeeting(meetingArn, await meetingRowOf());
        if (!running) return noMeeting();
        return answer(await requestToSpeak(meetings, meetingArn, running, personId, { personId: body.personId, attendeeId: body.attendeeId }));
      }
      case 'transcription': {
        // A HOST TURNS THE RUNNING MEETING'S CAPTIONS OR RECORDING ON OR OFF, from either
        // conversation; captions stay on while it records. Everyone in it is told in
        // the meeting's chat, and aloud by their app.
        if (!meetingArn) return noMeeting();
        const ask = { ...(typeof body.on === 'boolean' ? { on: body.on } : {}), ...(typeof body.recording === 'boolean' ? { recording: body.recording } : {}) };
        if (ask.on === undefined && ask.recording === undefined) return answer(refusal(400, 'INVALID_BODY', 'Say whether transcription or recording is on'));
        const meetingRow = await meetingRowOf();
        const running = await readLiveMeeting(meetingArn, meetingRow);
        if (!running) return noMeeting();
        if (!isRecordedHost(running, personId)) return answer(refusal(403, 'TRANSCRIPTION_HOST_ONLY', 'Only a host of the meeting can turn transcription on or off'));
        const set = await setTranscription(meetings, { meetingArn, meetingId: running.meetingId, classification: running.classification }, ask, personId, meetingRow);
        if (set === 'failed') return answer(refusal(502, 'TRANSCRIPTION_FAILED', 'Transcription could not be changed just now; try again'));
        if ('refused' in set) return answer(refusal(set.refused === 'RECORDING_ON' ? 409 : 400, set.refused, 'Captions stay on while the meeting is recorded'));
        return answer({ status: 200, body: { transcribing: set.on, recording: set.recording } });
      }
      case 'transcript': {
        // WHAT THE CALLER'S APP HEARD THEM SAY while the meeting is transcribed: kept only
        // from the caller's own attendee, which the service confirms is theirs, and only their own speech.
        if (!meetingArn) return noMeeting();
        const meetingRow = await meetingRowOf();
        const running = await readLiveMeeting(meetingArn, meetingRow);
        // A meeting released just now is read again, so its record says it ended and when.
        const rowNow = running || !meetingRow?.activeMeeting ? meetingRow : await readChannelContext(meetingArn, { consistent: true });
        const meetingId = running?.meetingId ?? rowNow?.lastMeeting?.meetingId;
        if (!meetingId) return noMeeting();
        // KEPT IN RECORDING MODE ONLY: captions alone store nothing. The last lines of a
        // recording that stopped, or of a recorded meeting that ended, a moment ago are kept up to that instant
        // (`lateLinesCutoff`), so what was said just before the end is in the transcript.
        // THE WINDOW A LINE MUST HAVE BEEN SPOKEN IN (`transcriptWindow`): from when the latest stretch of recording began
        // to now while it records, or to the instant it stopped, a moment ago. A line spoken under captions alone, before
        // the recording began or after it stopped is not kept, whenever the app reports it.
        const window = transcriptWindow(rowNow, meetingId);
        if (!window) return running ? answer(refusal(409, 'NOT_TRANSCRIBING', 'This meeting is not being recorded')) : noMeeting();
        if (running) {
          const notYours = await attendeeRefusal(meetings, running.meetingId, body.attendeeId, personId);
          if (notYours) return answer(notYours);
        } else {
          // The service answers for no attendee of a meeting it has ended: the caller's own lines are kept where they are a
          // member of the meeting's own conversation and the attendee is one the meeting created for them.
          if (typeof body.attendeeId !== 'string' || !body.attendeeId || body.attendeeId.length > 128) return answer(refusal(400, 'INVALID_ATTENDEE', 'Name one attendee'));
          const member = (access.ok && home.isMeeting) || (await callerReachesConversation(event, meetingArn, {})).ok;
          if (!member) return answer(refusal(403, 'NOT_A_MEMBER', 'You are not a member of this meeting'));
          if (!meetingRecordedAttendee(rowNow, meetingId, personId, body.attendeeId)) {
            return answer(refusal(403, 'NOT_YOUR_ATTENDEE', 'That attendee is not yours in this meeting'));
          }
        }
        const read = readReportedSegments(body.segments, { attendeeId: body.attendeeId as string, personId }, window);
        if ('refused' in read) return answer(refusal(400, read.refused, 'The transcript could not be read'));
        if (!read.segments.length) return answer({ status: 202, body: { kept: 0, skipped: read.skipped } });
        // ONE PERSON'S SHARE OF THE TRANSCRIPT (`transcriptShareOf`): lines past it are not kept, so no one person's reports
        // push everyone else out of the transcript and its summary.
        const createdAt = rowNow?.lastMeeting?.createdAt ?? running?.createdAt ?? '';
        const charged = await chargeTranscriptChars(meetingArn, meetingId, personId, transcriptCostOf(read.segments), transcriptShareOf(createdAt, window.untilMs));
        if (charged === 'failed') return answer(refusal(503, 'UNAVAILABLE', 'The transcript could not be kept just now; try again'));
        if (charged === 'over') return answer(refusal(429, 'TRANSCRIPT_SHARE_SPENT', 'Your share of this meeting\'s transcript is full'));
        const kept = await keepSegments({ classification: running?.classification ?? classification, conversationId: idOf(meetingArn), meetingId }, read.segments);
        return answer({ status: 202, body: { kept, skipped: read.skipped } });
      }
      case 'status': {
        // WHETHER THE CONVERSATION'S MEETING RUNS, read once on load and on reconnect, so a person who arrives late sees it,
        // and how much of its ring is left. It creates nothing: no attendee, no meeting, no membership.
        // Running is the service's answer (`readLiveMeeting`), so a record the service has ended offers no Join.
        const running = meetingArn ? await readLiveMeeting(meetingArn, await meetingRowOf()) : null;
        if (!running || !meetingArn) {
          // Not running: whether the reader may start it (the host, `meeting-host.ts`), and, in a meeting's own
          // conversation, that its meeting has ended.
          const roomRow = home.isMeeting ? (home.row?.meetingOf ? await readChannelContext(home.roomArn, { consistent: true }) : home.row) : home.row;
          return answer({ status: 200, body: {
            running: false, ...room, mayStart: mayStartMeeting(roomRow, personId) && await inRoom(),
            ...(home.isMeeting && home.row?.lastMeeting ? { ended: true } : {}),
          } });
        }
        const left = ringSecondsLeft(running);
        return answer({ status: 200, body: {
          running: true, startedAt: running.createdAt, startedByYou: running.createdBy === personId, conversationId: idOf(meetingArn), ...room,
          ...(isRemoved(running, personId) ? { removed: true } : {}),
          isHost: isRecordedHost(running, personId), hostIds: recordedHostIds(running),
          // WHETHER A HOST HOLDS THE READER'S AUDIO, so a session that reconnects holds or frees its microphone as the
          // service does, whatever host message it missed.
          mutedByHost: isHeld(running, personId),
          mayEnd: await mayEndMeeting(running, personId, { roomArn: home.roomArn, meetingArn }),
          ...(left > 0 ? { ringSecondsLeft: left } : {}),
          ...transcriptionAnswer(await meetingRowOf(), running.meetingId),
        } });
      }
      case 'end': {
        if (!meetingArn) return answer({ status: 200, body: { ended: false, reason: 'no active meeting' } });
        // FROM THE ROOM OR THE MEETING'S OWN CONVERSATION, joined or not: the caller reached one of them above, and the
        // right to end is the host's and the moderators' (`mayEndMeeting`).
        const meetingRow = await meetingRowOf();
        const recorded = meetingRow?.activeMeeting;
        if (recorded?.meetingId && !(await mayEndMeeting(recorded, personId, { roomArn: home.roomArn, meetingArn }))) {
          return answer(refusal(403, 'NOT_PERMITTED_TO_END', 'Only the person who started the meeting or a moderator of its conversation can end it'));
        }
        return answer(await endMeeting(meetingArn, meetingRow, 'host'));
      }
      case 'join': {
        if (!meetingArn) return noMeeting();
        const running = await readLiveMeeting(meetingArn, await meetingRowOf());
        if (!running) return noMeeting();
        const notEntered = await enterMeeting(meetingArn);
        if (notEntered) return answer(notEntered);
        // The recorded classification is the meeting's boundary; membership and clearance were checked above.
        // A PERSON A HOST REMOVED stays out of this meeting: the service would answer them a new attendee.
        if (isRemoved(running, personId)) return answer(refusal(403, 'REMOVED_FROM_MEETING', 'A host removed you from this meeting'));
        // Whether they join muted is read first: the attendee is created receive-only for a person who does.
        const muted = await startsMuted(event, home, personId, access.ok && !home.isMeeting);
        // WHETHER IT IS TRANSCRIBED AND RECORDED NOW, so the app tells the person before their audio is heard (the join notice).
        const body = await enterAnswer(meetingArn, running, muted, Promise.resolve(), await meetingRowOf());
        // A PERSON ADDED TO THE MEETING ALONE is briefed when they first join, in the meeting's own conversation.
        const invited = home.isMeeting ? home.row?.meetingInvites?.[personId] : undefined;
        if (invited && !invited.briefedAt) await askForArrivalBrief(classification, meetingArn, personId);
        return answer({ status: 200, body });
      }
      case 'start': {
        // A START: in a meeting's conversation, its meeting, while its room names it; from any other, the meeting's own
        // conversation, opened for the person starting it, or the one running or starting, which they enter.
        const started = await startInHome(home, classification, {
          by: personId, via: 'person', ringSeconds: ringSecondsOf(undefined), forUserArn: userArnFor(appInstanceArn(), personId), inRoom,
        }, (held) => (held.opened ? Promise.resolve(null) : enterMeeting(held.meetingArn)));
        if ('answer' in started) return answer(started.answer);
        if ('refused' in started) return answer(refusal(REFUSAL_STATUS[started.refused], started.refused, 'The meeting could not be started'));
        if (!started.created && isRemoved(started.meeting, personId)) return answer(refusal(403, 'REMOVED_FROM_MEETING', 'A host removed you from this meeting'));
        // A start that joins the meeting already running joins it as a join would, muted where the room's roles say so.
        const startMuted = started.created ? false : await startsMuted(event, home, personId, access.ok && !home.isMeeting);
        // The row is read once the start's transcription is filed, so the answer says the mode it set.
        const body = await enterAnswer(started.meetingArn, started.meeting, startMuted, started.recorded);
        return answer({ status: started.created ? 201 : 200, body: { ...body, created: started.created } });
      }
    }
    return answer(refusal(404, 'NOT_FOUND', 'No such meeting route'));
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'ChannelContextUnreadable') {
      console.error(`${LOG} a conversation's record could not be read`, { route, err: (err as Error).message });
      return answer(refusal(503, 'UNAVAILABLE', 'The meeting could not be checked just now; try again'));
    }
    console.error(`${LOG} unhandled failure`, { route, err: name });
    return answer(refusal(500, 'INTERNAL', 'Meeting operation failed'));
  }
}

/** What a workflow run asks for: the conversation, the assistant whose run starts it, and how long its ring sounds. */
export interface RunStartRequest {
  channelArn: string;
  /** The starting assistant's AppInstanceBot id, recorded as `createdBy`. */
  startedBy: string;
  /** The step's `ringSeconds`, recorded on the meeting so a person who arrives during the ring hears the rest of it. */
  ringSeconds?: number;
}

/** What a run is told: the meeting is running (new or already), or why not. Never join information: a run joins nobody. */
export type RunStartResult =
  | { ok: true; meetingId: string; created: boolean; meetingConversationArn: string; ringSeconds?: number }
  | { ok: false; code: StartRefusal | OpenRefusal | 'INVALID_CONVERSATION' | 'CLASSIFICATION_UNREADABLE' | 'OTHER_CLASSIFICATION' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'INTERNAL' };

/**
 * What the console asks of the run entry (`end-meetings`): end the meeting this conversation holds now, for everyone. The
 * console's own function decided who may (its capability, the caller's classifications, a recorded reason).
 */
export interface RunEndRequest {
  op: 'end';
  channelArn: string;
  meetingId: string;
  /** Why the run ends it: the meeting's watch names its reason (`meeting-watch.ts`), which the ended card words. */
  reason?: MeetingEndReason;
}

const END_REASONS: ReadonlySet<MeetingEndReason> = new Set(['host', 'nobody-joined', 'left-alone', 'time-limit']);

/** What an end is told: ended, or why not. `RELEASE_FAILED`: the service ended it and only the record was left. */
export type RunEndResult =
  | { ok: true }
  | { ok: false; code: 'INVALID_CONVERSATION' | 'CLASSIFICATION_UNREADABLE' | 'OTHER_CLASSIFICATION' | 'NOT_RUNNING' | 'END_FAILED' | 'RELEASE_FAILED' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'INTERNAL' };

/**
 * THE CONSOLE ENDS A MEETING FOR EVERYONE through the same end a host or moderator uses (`endMeeting`): the service
 * deletes the meeting, the conversation's record is released, and the room hears the end from the service's own event.
 * Only the meeting the conversation holds now is ended, so a stale request names nothing.
 */
async function endFromRun(event: RunEndRequest): Promise<RunEndResult> {
  return inRunConversation(event, () => typeof event.meetingId === 'string' && !!event.meetingId, "a console's end failed", async ({ channelArn }) => {
    const row = await readChannelContext(channelArn, { consistent: true });
    if (row?.activeMeeting?.meetingId !== event.meetingId) return { ok: false, code: 'NOT_RUNNING' };
    const answer = await endMeeting(channelArn, row, END_REASONS.has(event.reason as MeetingEndReason) ? event.reason : undefined);
    if (answer.status === 200) return { ok: true };
    return { ok: false, code: answer.status === 503 ? 'RELEASE_FAILED' : 'END_FAILED' };
  });
}

/** What the router asks once a meeting has ended: write its transcript, where it was transcribed. */
export interface RunTranscriptRequest {
  op: 'transcript';
  channelArn: string;
  meetingId: string;
}

/** The transcript's key, or none where the meeting was never transcribed or nobody was heard. */
export type RunTranscriptResult =
  | { ok: true; key?: string }
  | { ok: false; code: 'INVALID_CONVERSATION' | 'CLASSIFICATION_UNREADABLE' | 'OTHER_CLASSIFICATION' | 'NOT_THIS_MEETING' | 'STILL_RUNNING' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'INTERNAL' };

/**
 * A MEETING THAT HAS ENDED IS WRITTEN UP (`writeTranscript`): only the conversation's last meeting, only once the
 * conversation no longer holds it running, and only where it was transcribed at some point. The classification is the one
 * the meeting was recorded under, read from the conversation's immutable tag, so the key carries the conversation's own.
 */
async function transcriptFromRun(event: RunTranscriptRequest): Promise<RunTranscriptResult> {
  return inRunConversation(event, () => typeof event.meetingId === 'string' && !!event.meetingId, 'the transcript could not be written', async ({ app, own, channelArn }) => {
    const row = await readChannelContext(channelArn, { consistent: true });
    if (row?.lastMeeting?.meetingId !== event.meetingId) return { ok: false, code: 'NOT_THIS_MEETING' };
    if (row.activeMeeting?.meetingId === event.meetingId) return { ok: false, code: 'STILL_RUNNING' };
    // A TRANSCRIPT IS KEPT ONLY FOR A MEETING THAT WAS RECORDED at some point; captions alone keep nothing.
    if (row.lastMeeting.transcription?.everRecorded !== true) return { ok: true };
    // The key carries the conversation's own classification, which the gate found to be this run entry's.
    const key = await writeTranscript(app, { classification: own, conversationId: idOf(channelArn), meetingId: event.meetingId });
    return key ? { ok: true, key } : { ok: true };
  });
}

/**
 * THE CLASSIFICATION THIS RUN ENTRY SERVES (`MEETING_RUN_CLASSIFICATION`), set by its stack. Each classification has its own
 * run entry, which only that classification's router may invoke, and an entry acts only in a conversation of its own
 * classification. An entry deployed without one serves none.
 */
function runClassification(): string {
  return (process.env.MEETING_RUN_CLASSIFICATION || '').trim();
}

/**
 * WHY A CONVERSATION IS NOT THIS RUN ENTRY'S, or undefined where it is: its immutable classification tag, read against the
 * deployment's classifications, must be the entry's own. A tag that cannot be read refuses as surely as another's.
 */
async function notThisRunsClassification(channelArn: string, own: string): Promise<'CLASSIFICATION_UNREADABLE' | 'OTHER_CLASSIFICATION' | undefined> {
  await loadProfileRegistry();
  const classification = await readChannelClassificationTag(messaging, channelArn, LOG);
  if (!classification) return 'CLASSIFICATION_UNREADABLE';
  if (classification !== own) {
    console.warn(`${LOG}[SecurityEvent] a run entry was asked to act in another classification's conversation; refusing`, { channelArn, own, classification });
    return 'OTHER_CLASSIFICATION';
  }
  return undefined;
}

/** What every run entry may answer before it acts: unconfigured, an invalid request, another classification's, or a failure. */
type RunGateCode = 'NOT_CONFIGURED' | 'INVALID_CONVERSATION' | 'CLASSIFICATION_UNREADABLE' | 'OTHER_CLASSIFICATION' | 'UNAVAILABLE' | 'INTERNAL';

/**
 * EVERY RUN ENTRY ACTS ONLY IN A CONVERSATION OF ITS OWN CLASSIFICATION, through this one gate: the entry is configured,
 * the conversation is this app instance's and the request is well formed (`valid`), and the conversation's immutable tag
 * names this entry's classification. A failure answers `UNAVAILABLE` for a record that could not be read, else `INTERNAL`.
 */
async function inRunConversation<R>(
  event: { channelArn?: string } | undefined, valid: () => boolean, failure: string,
  act: (at: { app: string; own: string; channelArn: string }) => Promise<R>,
): Promise<R | { ok: false; code: RunGateCode }> {
  const app = appInstanceArn();
  const own = runClassification();
  if (!app || !own) return { ok: false, code: 'NOT_CONFIGURED' };
  const channelArn = conversationChannelArn(event?.channelArn, app);
  if (!channelArn || !valid()) return { ok: false, code: 'INVALID_CONVERSATION' };
  try {
    const refused = await notThisRunsClassification(channelArn, own);
    if (refused) return { ok: false, code: refused };
    return await act({ app, own, channelArn });
  } catch (err) {
    const name = (err as Error).name;
    console.error(`${LOG} ${failure}`, { channelArn, err: name });
    return { ok: false, code: name === 'ChannelContextUnreadable' ? 'UNAVAILABLE' : 'INTERNAL' };
  }
}

/** The run entry: a workflow run's start, the console's end, or an ended meeting's transcript. */
export function runHandler(event: RunTranscriptRequest): Promise<RunTranscriptResult>;
export function runHandler(event: RunEndRequest): Promise<RunEndResult>;
export function runHandler(event: RunStartRequest): Promise<RunStartResult>;
export async function runHandler(event: RunStartRequest | RunEndRequest | RunTranscriptRequest): Promise<RunStartResult | RunEndResult | RunTranscriptResult> {
  await loadProfileRegistry();
  if ((event as RunTranscriptRequest | undefined)?.op === 'transcript') return transcriptFromRun(event as RunTranscriptRequest);
  if ((event as RunEndRequest | undefined)?.op === 'end') return endFromRun(event as RunEndRequest);
  return startFromRun(event as RunStartRequest);
}

/**
 * A WORKFLOW RUN STARTS THE CONVERSATION'S MEETING (`start_meeting`). Invoked by the conversation's own router, which ran
 * the step in that conversation, so there is no person to check: the classification is read from the conversation's
 * immutable tag here and must be this run entry's own, and a conversation outside this app instance, without a readable
 * classification, or of another classification starts nothing.
 */
async function startFromRun(event: RunStartRequest): Promise<RunStartResult> {
  return inRunConversation(event, () => typeof event.startedBy === 'string' && !!event.startedBy, "a run's start failed", async ({ own, channelArn }) => {
    // The meeting's own conversation, opened for nobody: the run's room hears the ring and is told, and its members join from it.
    const started = await startInHome(await meetingHomeOf(channelArn), own, {
      by: event.startedBy, via: 'workflow', ringSeconds: ringSecondsOf(event.ringSeconds),
    });
    if ('refused' in started) return { ok: false, code: started.refused };
    await started.recorded;
    // THE RING LENGTH THE MEETING RECORDS, answered to the run, so the run rings for the length a late arrival hears the rest of.
    const ringSeconds = started.meeting.ringSeconds;
    return {
      ok: true, meetingId: started.meeting.meetingId, created: started.created, meetingConversationArn: started.meetingArn,
      ...(typeof ringSeconds === 'number' ? { ringSeconds } : {}),
    };
  });
}
