/**
 * Meeting lifecycle events - the roster's source (SPEC-ASSISTANT-MEETINGS FR18/FR22, DESIGN C.5).
 *
 * Amazon Chime SDK emits a meeting's lifecycle to EventBridge. This consumes those events and files
 * them in the conversation archive and then the Aurora projection, where the roster is a QUERY over them and is never stored. Everything the
 * roster shows is already in here: arrivals, departures, drops, video and screen-share transitions,
 * and the network each attendee connected over.
 *
 * ── WHY THIS EXISTS AT ALL, RATHER THAN THE API TRACKING ITS OWN ATTENDEES ──────────────────────
 *
 * A meeting ends when the last attendee leaves, and that is the ABSENCE of attendees rather than an
 * action anybody takes. Tenet 7: you cannot event-source the absence of an event. So the end has to
 * arrive as an event FROM the service, and until it does, the only way to notice is for the next
 * reader to call `GetMeeting` and find the meeting gone - which is what `meeting-api.ts` does today
 * and what this replaces as the primary signal.
 *
 * It is also the only place `AttendeeDropped` can be told from `AttendeeLeft`. Nothing the API sees
 * distinguishes somebody who left from somebody whose connection failed, and the operator goal for
 * this phase asks for drops separated from droppers. The service knows; the API never could.
 *
 * ── THE CONVERSATION A MEETING BELONGS TO IS DERIVED, NOT LOOKED UP ─────────────────────────────
 *
 * `meeting-api.ts` sets `ExternalMeetingId` to the channel's id precisely so this is possible: the
 * channel ARN is `${APP_INSTANCE_ARN}/channel/${externalMeetingId}`, deterministically, with no read.
 * That matters because these events arrive AFTER a meeting ends, when the conversation no longer
 * records it - a lookup through the active-meeting record would find nothing exactly when the most
 * interesting events land.
 *
 * ONLY THIS DEPLOYMENT'S MEETINGS ARE FILED. The EventBridge rule matches every Amazon Chime SDK meeting in
 * the account and region, including another deployment's and any other application's. An event is filed only
 * when this deployment's channel-context row for the derived conversation names its MeetingId, as the meeting
 * API records every meeting it creates (`isThisDeploymentsMeeting`). Every other event is skipped, so every
 * filed row is this deployment's and the console's figures and rosters count its meetings only.
 *
 * A READ THAT FAILED IS NOT AN ANSWER. A failed row or tag read throws, so EventBridge retries the
 * event and a persistent failure lands on the dead-letter queue: it is never filed or handed to a router
 * under a classification that was guessed.
 */
import type { EventBridgeEvent } from 'aws-lambda';
import { CLASSIFICATION_TAG, readChannelTags } from './lib/channel-classification.js';
import { memoizedTagReader } from './lib/conversation-primary.js';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { isMeetingId, lifecycleEventOf, type MeetingLifecycleDetail } from './lib/meeting-lifecycle.js';
import { publishMeetingLifecycle } from './lib/meeting-lifecycle-publish.js';
import { PROJECT_MEETING_EVENTS, deploymentSinks, fileMeetingEvents, type MeetingEventRecord } from './lib/meeting-event-archive.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { readChannelContext, recordMeetingJoin } from './lib/channel-context-client.js';
import { defaultProfileRegistry as profiles, loadProfileRegistry } from '../../lib/profile-registry';

const LOG = '[meeting-events] ';

const messagingClient = chimeMessagingClient();

const appInstanceArn = (): string => process.env.APP_INSTANCE_ARN || '';

/**
 * The event detail Amazon Chime SDK sends. Every field is optional because this is somebody else's
 * payload: a missing one is a shape to handle, not a contract to assume.
 */
interface ChimeMeetingEventDetail {
  eventType?: string;
  timestamp?: number;
  meetingId?: string;
  externalMeetingId?: string;
  attendeeId?: string;
  externalUserId?: string;
  mediaRegion?: string;
  networkType?: string;
  transitionReason?: string;
}

/**
 * The container's one memo of conversation tags (`memoizedTagReader`): bounded, and keeping only a recognized
 * classification, which is safe because a conversation's classification tag is immutable. One meeting produces many
 * events, so without it a busy meeting costs a `ListTagsForResource` per arrival and departure.
 */
const tagReader = memoizedTagReader(messagingClient);

/** The `ExternalUserId` prefix the Amazon Chime SDK reserves for its own attendees (a media pipeline's). */
export const SERVICE_ATTENDEE_PREFIX = 'aws:';

/** A channel id as Amazon Chime SDK accepts one. Anything else cannot be a conversation of this app instance. */
const CHANNEL_ID = /^[A-Za-z0-9]([A-Za-z0-9:_.@-]{0,62}[A-Za-z0-9])?$/;

/**
 * Where this deployment files a meeting held in `channelArn`:
 *  - `null` when the channel is not this app instance's, so the meeting is another application's;
 *  - `{ classification, known: true }` from the conversation's own classification tag;
 *  - `{ known: false }` at the most restrictive value, for a conversation of this deployment whose tag is missing or not a
 *    declared classification. The row is the operator's record of who was in the meeting, so it is kept where the fewest
 *    principals can read it (the choice migration 068 makes), and it is handed to no router.
 * A tag read that failed throws: nothing is filed or handed on under a guess, and the event is retried.
 */
async function filingOf(channelArn: string, externalMeetingId: string): Promise<{ classification: string; known: boolean } | null> {
  if (!CHANNEL_ID.test(externalMeetingId)) return null;
  let tag: string | undefined;
  try {
    tag = (await readChannelTags(tagReader, channelArn))[CLASSIFICATION_TAG];
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NotFoundException') return null;
    throw err;
  }
  const classification = profiles.isKnownClassification(tag) ? profiles.resolveClassification(tag) : undefined;
  if (classification) return { classification, known: true };
  console.warn(`${LOG}[SecurityEvent] conversation missing/invalid classification tag; filing at the most restrictive classification`, { channelArn, tag });
  return { classification: profiles.failClosedContentValue, known: false };
}

/**
 * How long after its start a meeting's `MeetingStarted` waits for the start's record. The meeting API creates the meeting
 * and then records it on the conversation (`claimActiveMeeting`), so the service's start can arrive first; an attendee
 * can only join once the record is written. Lambda's first asynchronous retry comes about a minute later, past this, so
 * that retry decides for good.
 */
export const START_RECORD_GRACE_MS = 30_000;

/** Meetings already confirmed as this deployment's, so a busy meeting is one row read. Bounded; oldest first out. */
const confirmedMeetings = new Set<string>();
const CONFIRMED_CAPACITY = 5000;

/**
 * IS THIS MEETING ONE THIS DEPLOYMENT CREATED? The meeting API records every meeting it creates on the conversation's
 * channel-context item, in this deployment's own table, as `activeMeeting` and `lastMeeting`. A meeting that row does not
 * name is another deployment's or another application's, even in a conversation with the same channel id (a team room's
 * id is the same in every deployment), and is skipped.
 *
 * A row that could not be read throws, so the event is retried; it is never read as "not ours". A `MeetingStarted` the
 * row does not name yet, within {@link START_RECORD_GRACE_MS}, throws too, because the start's record may still be on its
 * way.
 */
async function isThisDeploymentsMeeting(channelArn: string, meetingId: string, eventType: string, eventAtMs: number): Promise<boolean> {
  if (confirmedMeetings.has(meetingId)) return true;
  const row = await readChannelContext(channelArn, { consistent: true });
  if (row?.activeMeeting?.meetingId === meetingId || row?.lastMeeting?.meetingId === meetingId) {
    confirmedMeetings.add(meetingId);
    if (confirmedMeetings.size > CONFIRMED_CAPACITY) confirmedMeetings.delete(confirmedMeetings.values().next().value as string);
    return true;
  }
  if (eventType === 'MeetingStarted' && Date.now() - eventAtMs < START_RECORD_GRACE_MS) {
    throw new Error('the meeting start is not recorded on its conversation yet');
  }
  return false;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** The records a hand-on carries, read strictly: each a meeting event of a conversation of this app instance. */
export function projectableRecords(raw: unknown): MeetingEventRecord[] {
  const instance = appInstanceArn();
  if (!instance || !Array.isArray(raw)) return [];
  return raw.filter((r): r is MeetingEventRecord => {
    const o = r && typeof r === 'object' ? r as Record<string, unknown> : {};
    return typeof o.meeting_id === 'string' && isMeetingId(o.meeting_id)
      && typeof o.channel_arn === 'string' && o.channel_arn.startsWith(`${instance}/channel/`)
      && typeof o.classification === 'string' && typeof o.event_type === 'string' && o.event_type.length <= 64
      && typeof o.event_at === 'string' && ISO_INSTANT.test(o.event_at)
      && (o.source === 'server' || o.source === 'client' || o.source === 'platform');
  });
}

/** Whether a filed event is a person's own attendee: not a shared screen's, and naming the person it is. */
const isPersonsOwn = (record: MeetingEventRecord): boolean => !record.is_content && !!record.person_key;

/** `chime:AttendeeJoined` -> `AttendeeJoined`. The prefix is constant and carries nothing. */
function bareEventType(eventType: string): string {
  return eventType.startsWith('chime:') ? eventType.slice('chime:'.length) : eventType;
}

/**
 * Is this the screen-share attendee rather than the person?
 *
 * Amazon Chime SDK joins shared content as a SEPARATE attendee whose id carries a `#content` suffix.
 * Its external user id is the owner's, so marking it here is what lets the roster attribute the share
 * to the person and still count them once. The event name is checked too, because the content events
 * are named for it and relying on the suffix alone would miss a rename.
 */
function isContentAttendee(attendeeId: string | null, eventType: string): boolean {
  return Boolean(attendeeId?.includes('#content')) || eventType.includes('Content');
}

/**
 * The record this event becomes, and whether its classification was read from the conversation; null when it cannot be
 * attributed to a meeting of this deployment.
 */
async function toRecord(
  detail: ChimeMeetingEventDetail, envelopeTime: string | undefined,
): Promise<{ record: MeetingEventRecord; known: boolean } | null> {
  const eventType = bareEventType(detail.eventType || '');
  const meetingId = detail.meetingId;
  if (!eventType || !meetingId) {
    console.warn(`${LOG}event names no meeting or no type; skipping`, { eventType, meetingId });
    return null;
  }

  if (detail.timestamp === undefined && !envelopeTime) {
    console.warn(`${LOG}event carries no time; skipping`, { eventType, meetingId });
    return null;
  }

  const instance = appInstanceArn();
  if (!instance) {
    // Without it the conversation cannot be derived, so the row could not say which conversation the
    // meeting belonged to - which is the fact the roster is read through. Refuse rather than file a
    // row with an unusable key.
    console.error(`${LOG}APP_INSTANCE_ARN is unset; cannot attribute meeting events to a conversation`);
    return null;
  }
  const externalMeetingId = detail.externalMeetingId || '';
  const channelArn = `${instance}/channel/${externalMeetingId}`;
  const eventAt = new Date((detail.timestamp ?? envelopeTime) as number | string).toISOString();
  const ours = CHANNEL_ID.test(externalMeetingId) && await isThisDeploymentsMeeting(channelArn, meetingId, eventType, Date.parse(eventAt));
  const filing = ours ? await filingOf(channelArn, externalMeetingId) : null;
  if (!filing) {
    console.log(`${LOG}not a meeting of this deployment's conversations; skipping`, { eventType, meetingId });
    return null;
  }

  // A SERVICE'S OWN ATTENDEE IS NOT A PERSON: the Amazon Chime SDK reserves the `aws:` prefix of an `ExternalUserId` for the
  // attendees its media pipelines join as, which no application can create, while every person's is their AppInstanceUser id
  // (`meeting-api.ts`). Its events are not the meeting's people, so they are not filed, counted or watched.
  if (detail.externalUserId?.startsWith(SERVICE_ATTENDEE_PREFIX)) {
    console.log(`${LOG}a service attendee's event; skipping`, { eventType, meetingId });
    return null;
  }
  const attendeeId = detail.attendeeId || null;
  const record: MeetingEventRecord = {
    meeting_id: meetingId,
    channel_arn: channelArn,
    classification: filing.classification,
    event_type: eventType,
    source: 'server',
    attendee_id: attendeeId,
    // The stable person key. `meeting-api.ts` sets `ExternalUserId` to the caller's Cognito sub, so
    // every attendee record one person produces folds onto the same row.
    person_key: detail.externalUserId || null,
    is_content: isContentAttendee(attendeeId, eventType),
    network_transport: detail.networkType || null,
    // The service's own timestamp, in milliseconds. A roster built on arrival time instead would be
    // reordered by any redelivery. Without one, the EventBridge envelope's time, which a redelivered
    // copy carries unchanged; the clock at arrival would differ per copy and slip past the unique key.
    event_at: eventAt,
    // The unmapped remainder, so a fact the service emits that nothing reads yet is still recorded
    // rather than dropped by this translation.
    detail: {
      mediaRegion: detail.mediaRegion ?? null,
      transitionReason: detail.transitionReason ?? null,
      externalMeetingId: detail.externalMeetingId ?? null,
    },
  };
  return { record, known: filing.known };
}

/**
 * One EventBridge event per invocation, filed in the archive and then projected (`meeting-event-archive.ts`).
 *
 * THROWING IS THE CORRECT RESPONSE TO A DELIVERY FAILURE HERE, and the opposite of what most writers
 * on this platform do. An assistant whose store is unavailable degrades to a less personal reply
 * (tenet 5); a roster with a missing arrival is just wrong, and nothing downstream can detect the
 * gap. So a failed write is re-raised: EventBridge retries it, and a persistent failure lands on the
 * dead-letter queue where it can be replayed. Readers fold the archive on the event's natural key and the
 * projection's insert is idempotent, so a retry cannot double an arrival.
 */
let bus: Pick<EventBridgeClient, 'send'> | null = null;
/** Test seam: the bus the lifecycle event is published on. */
export function __setBus(b: Pick<EventBridgeClient, 'send'>): void { bus = b; }

/**
 * A MEETING THAT STARTED OR ENDED IS HANDED TO ITS CONVERSATION'S ROUTER (`meeting-lifecycle.ts`), once the event is in
 * the archive. A publish that fails throws, so the retry files the event again (folded on its natural key) and publishes
 * again (the router acts once per meeting per event).
 */
async function publishLifecycle(record: MeetingEventRecord): Promise<boolean> {
  const lifecycle = lifecycleEventOf(record.event_type, isPersonsOwn(record));
  const instance = process.env.MEETING_LIFECYCLE_INSTANCE || '';
  if (!lifecycle || !instance) return false;
  const detail: MeetingLifecycleDetail = {
    instance, classification: record.classification, channelArn: record.channel_arn, meetingId: record.meeting_id, event: lifecycle, at: record.event_at,
  };
  if (!(await publishMeetingLifecycle(detail, bus ?? undefined))) throw new Error('the meeting lifecycle event was not published');
  return true;
}

/**
 * The rule's target. Lambda calls it with the event and its own context, so it takes the event alone: the stores it files
 * into are the deployment's (`deploymentSinks`), never an argument.
 */
export async function handler(event: EventBridgeEvent<string, ChimeMeetingEventDetail> | { [PROJECT_MEETING_EVENTS]?: unknown }): Promise<void> {
  // EVENTS ALREADY IN THE ARCHIVE THAT A WRITER COULD NOT PROJECT (`fileMeetingEvents`, best-effort), handed on to be
  // projected here: a failure throws, so the asynchronous invoke retries it and one that keeps failing is kept in this
  // function's dead-letter queue to replay. Only this app instance's conversations' rows are taken.
  if (PROJECT_MEETING_EVENTS in event) {
    const records = projectableRecords((event as Record<string, unknown>)[PROJECT_MEETING_EVENTS]);
    if (!records.length) return;
    const sinks = await deploymentSinks();
    if (!sinks.projection) return;
    const { inserted, duplicates } = await sinks.projection(records);
    console.log(`${LOG}projected events handed on`, { events: records.length, inserted, duplicates });
    return;
  }
  await loadProfileRegistry();
  const bridged = event as EventBridgeEvent<string, ChimeMeetingEventDetail>;
  const filed = await toRecord(bridged.detail || {}, bridged.time);
  if (!filed) return;
  const { record, known } = filed;

  const { archived, projected, duplicates } = await fileMeetingEvents([record]);
  console.log(`${LOG}filed`, {
    meetingId: record.meeting_id,
    eventType: record.event_type,
    classification: record.classification,
    archived,
    // Null where the deployment keeps no Aurora projection: the archive holds the event either way.
    projected,
    // Expected rather than exceptional: delivery is at-least-once.
    duplicates,
  });
  // A PERSON'S JOIN IS ON THE RUNNING MEETING'S RECORD at once, ahead of the events store (whose archive is filed in
  // batches), so the meeting's watch never ends a meeting someone just joined. A write that failed throws and is retried.
  if (record.event_type === 'AttendeeJoined' && isPersonsOwn(record)) {
    if (await recordMeetingJoin(record.channel_arn, record.meeting_id, record.event_at) === 'failed') {
      throw new Error('the join could not be recorded on the running meeting');
    }
  }
  // A start or an end goes to the router of the conversation's own classification, so one filed at the restrictive value
  // because its conversation carries no declared classification is handed to nobody.
  if (!known) {
    if (lifecycleEventOf(record.event_type, isPersonsOwn(record))) console.error(`${LOG}the conversation has no declared classification; the meeting is not handed to a router`, { meetingId: record.meeting_id, eventType: record.event_type });
    return;
  }
  if (await publishLifecycle(record)) console.log(`${LOG}handed to the conversation's router`, { meetingId: record.meeting_id, eventType: record.event_type });
}
