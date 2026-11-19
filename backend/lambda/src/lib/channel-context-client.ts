/**
 * Channel Context Client.
 *
 * A SERVER-ONLY store for the sensitive host/participant grounding a conversation carries: the
 * participant profile, the domain context, any extra context blobs, and the resolved display name.
 * These describe WHO the assistant is talking to and WHAT the conversation is about, and are meant for
 * the assistant (server side) only - never for other channel members to read.
 *
 * Why a dedicated table and not Amazon Chime SDK channel Metadata: channel Metadata is returned by
 * `DescribeChannel`, which any channel MEMBER can call, so anything placed there is member-readable.
 * These fields must not be. They live in a DynamoDB table (`CHANNEL_CONTEXT_TABLE`) that only the
 * conversation-create Lambdas may write and only the assistant handler Lambda may read - no end-user /
 * Identity-Pool principal is granted access. Keyed by `channelArn`.
 *
 * WHAT IS LEFT IN CHANNEL METADATA, which is the question this header exists to answer. Metadata is
 * member-READABLE via `DescribeChannel` and member-WRITABLE via `chime:UpdateChannel` (a channel's
 * creator is a moderator of their own channel), so it holds only what a member may both see and rewrite
 * without consequence: the model fields (`modelId`, `modelName`, `modelTier`), the drift pointers
 * (`createdViaDrift`, `parentChannelArn`, `originatingMessageId`), and `triggerContext` - a sanitized,
 * short topic LABEL. Nothing else. A new field belongs HERE unless a member rewriting it would be
 * harmless.
 *
 * Everything that decides something moved into this store, and the whole record is now 13 fields rather
 * than the original four private grounding ones: `userLanguage` and `segment` because they select the
 * model and the reply language, the participant ROSTER because a member could otherwise add a `sub` and
 * have conversation content emailed out of band, and `priorMessage` because Metadata made the person's
 * own quoted words editable by the person it quotes.
 *
 * THIS PARAGRAPH PREVIOUSLY SAID THE OPPOSITE - that Metadata still carried `userLanguage`, `segment`
 * and the roster, and that only four fields lived here. Every part of that was contradicted further down
 * this same file. It is called out because this is the header a developer reads to decide where to put a
 * new field, so getting it wrong does not merely mislead: it points the next private field at storage a
 * member can rewrite.
 *
 * Reads FAIL SOFT (return null): a store outage degrades to "no host grounding this turn" rather than
 * erroring the turn. Writes are best-effort: a lost write degrades grounding, it never leaks.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { parseParticipantContext, type ParticipantContext } from './participant-shape.js';
import type { StoredIntake } from './onboarding-intake.js';
import type { ParticipantRoleHoldings } from './participant-roles.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionDocumentClient } from './assistant-session.js';
import { recordingPartsOf, type MeetingRecordings, type RecordingPart, type RecordingPartState } from './meeting-recording.js';

/** The private grounding for one conversation. All fields optional; absent ⇒ not set. */
export interface ChannelContext {
  /** Amazon Chime SDK channel ARN (partition key). */
  channelArn: string;
  /** Free-text profile of the participant the assistant is helping (e.g. "recruiter at Stratum"). */
  participantProfile?: string;
  /** Structured domain context (items the assistant should ground in). */
  domainContext?: unknown;
  /** Any additional context blobs carried onto the conversation. */
  otherContexts?: unknown;
  /** The resolved display name used to personalize the assistant's replies. */
  userName?: string;
  /**
   * The conversation's language and geography ROUTING signals
   * (SPEC-CONTEXT-AWARE-MODEL-ROUTING): `userLanguage` selects the reply language, and
   * `segment.country === 'CN'` routes the turn to the Chinese model.
   *
   * They live HERE, not in channel Metadata, for the same reason as the private grounding above: they
   * decide which model answers, and channel Metadata is member-WRITABLE (a channel's creator is a
   * moderator of their own channel and holds `chime:UpdateChannel`, which writes Name and Metadata in
   * one call). Sourced from Metadata, any member could redirect their own conversation's model
   * selection by rewriting them.
   */
  userLanguage?: string;
  segment?: { country?: string };
  /**
   * WHO is in the conversation, as a shape (SPEC-USER-PROFILE-AND-ONBOARDING §2). Written by the creating
   * path BEFORE the channel exists, because the assistant is added by creation itself and there is no window
   * afterwards. Read at `WelcomeIntent`, where live membership has not converged.
   */
  participants?: ParticipantContext;
  /**
   * WHY a drift-spawned conversation exists, read by the welcome composer at `WelcomeIntent`
   * (SPEC-DRIFT-CONVERGENCE, SPEC-WELCOME-AND-CONTEXT).
   *
   *   `priorSubject` - the short topic LABEL carried over from the conversation that spawned this one.
   *   `priorMessage` - the person's own words that started it, quoted back by the welcome.
   *   `parentRef`    - the deep link back to the originating message, composed at write time.
   *
   * THEY LIVE HERE, NOT IN CHANNEL METADATA, for three separate reasons, any one of which is
   * sufficient:
   *
   *   1. TIMING. `WelcomeIntent` fires on the assistant's automatic membership at `CreateChannel`, and
   *      channel Metadata is not reliably readable that early (eventually consistent, verified against
   *      live Chime). This store is written BEFORE `CreateChannel` and read consistently, which is the
   *      whole reason the participant shape above already lives here.
   *   2. TRUST. Channel Metadata is member-WRITABLE - a channel's creator is a moderator of their own
   *      channel and holds `chime:UpdateChannel`, which writes Name and Metadata in ONE call. Sourced
   *      from Metadata these are attacker-controlled text, which is why `welcome-orientation.ts`
   *      marker-strips them. (That stripping STAYS: this store removes the write path, not the reason
   *      to be careful with text that reaches composed copy.)
   *   3. SIZE. Metadata is capped at ~1KB for the whole blob, shared with modelId/modelTier/parent
   *      pointers, which is the only reason the quoted message was ever truncated.
   */
  priorSubject?: string;
  /**
   * WHAT THIS CONVERSATION IS ABOUT, in the person's own words from the create form.
   *
   * ALSO ON CHANNEL METADATA, and that is not a duplicate by accident. Metadata keeps it member-visible
   * and member-editable, which is right for a subject its own author typed. This copy exists because the
   * only reader is `WelcomeIntent`, which fires on the assistant's automatic membership at creation -
   * the moment Metadata is least reliably readable, as the note on `priorSubject` explains. Writing only
   * to Metadata made the grounding intermittent rather than absent, which is harder to notice.
   */
  topic?: string;
  /**
   * The line the originating EVENT wrote, for a type whose welcome template names it.
   *
   * Distinct from `priorSubject`, which is the topic LABEL and renders as a noun phrase, and from
   * `domainContext`, which is grounding the model reads and the welcome composer does not. A type that
   * should SAY what happened needs the sentence where the composer can reach it, and only a template
   * that names `{eventSummary}` renders it - so no un-templated type changes.
   */
  eventSummary?: string;
  /**
   * THE LINE A CARRIED-OVER VISIT OPENS WITH (FR26): the visitor's assistant's own sentence, written in the
   * visitor's language when the visit carried over (`lib/visit-assessment.ts`), saying it has the context of
   * the earlier conversation. Written by the creator of a claimed or bound conversation beside the seed in
   * `domainContext`, and rendered by the welcome composer. Never a copy of a message.
   */
  visitSummary?: string;
  priorMessage?: string;
  parentRef?: string;
  /**
   * The conversation's member roster, as `{sub, iss, role}` — server-only.
   *
   * WHY IT CANNOT LIVE IN CHANNEL METADATA. `METADATA-AND-TAGS.md` §1 puts identity on the NEVER list:
   * a user's `sub`, a federated `iss`, names, roles. Metadata is readable by every channel member and
   * writable by any moderator, so a roster there both discloses who else is in the conversation (and
   * which IdP they come from) and lets a member edit it.
   *
   * WHAT IT IS FOR, and what it is NOT. This is a record of the host-supplied role, never an
   * authority. Who is in the conversation is live `ListChannelMemberships`, and where to reach a person
   * is the directory's question, answered through `Identities` (`lib/membership-source.ts`). Host
   * grounding reads the role from here, matching a subject to a member through `resolvePerson`. Nothing
   * may treat it as the membership list.
   */
  memberIdentities?: Array<{ sub: string; iss?: string; role?: string }>;
  /**
   * An onboarding intake in progress in this conversation, and whose it is
   * (SPEC-USER-PROFILE-AND-ONBOARDING). Written when the intake starts and on every answer.
   *
   * HERE, NOT IN THE AMAZON LEX SESSION where it used to ride: that session existed only when Lex was the
   * entry and expired after five idle minutes, so a pause mid-intake filed the next answer under the
   * first question. Server-only, like everything else on this row, because the answers are personal.
   */
  onboardingIntake?: StoredIntake;
  /**
   * WHICH CONVERSATION TYPE this conversation is, as the registry key (ADR-053 decision 7's read path).
   *
   * Written at creation by the canonical creator and read where a turn needs the type's policy rather
   * than the classification's. Without it every consumer resolves a type config by CLASSIFICATION, so a
   * conversation created "of type `ops`" would resolve to type `premium` for its whole life - premium's
   * retention, and drift ON despite the type declaring it off. A dimension nobody can read is a
   * dimension that does not exist.
   *
   * HERE RATHER THAN IN CHANNEL METADATA, and unusually it is not because the value is private. It is
   * because Metadata is member-WRITABLE: a channel's creator is a moderator of their own channel and
   * holds `chime:UpdateChannel`, so a type stamped there could be rewritten by a member into any other
   * type in the registry - which is a member choosing their own conversation's policy. The value itself
   * is not a secret and a member learning it costs nothing.
   *
   * IT IS NOT PROVENANCE. This row is mutable and last-write-wins, so it answers "what type is this
   * conversation" and never "what configuration did it run under at the time". The durable answer is the
   * archived event in ADR-053 decision 7, which is **NOT BUILT**.
   */
  conversationType?: string;
  /**
   * The membership source this conversation ENFORCES, stamped at creation from its type: `group:<name>`,
   * `list`, or `group:<name>+list`. Absent is manual.
   *
   * READ BY THE PATHS THAT CANNOT IMPORT THE TYPE REGISTRY - the share Lambda refuses an invite on a
   * conversation that carries it, because the next reconcile would silently remove the person invited
   * (owner decision, 2026-10-05). Stamped rather than re-resolved for the same reason the type key is:
   * a change to a type reaches new conversations only (ADR-053), so the stamp states what this
   * conversation was created to be.
   */
  membershipSource?: string;
  /**
   * When the conversation was created (ISO), stamped by the creating path and never rewritten: the store
   * writes it only where it is absent, so a create-or-get re-stamp keeps the first value.
   *
   * READ TO ENROLL A CONVERSATION IN A PROFILE EXPERIMENT (ADR-050). A conversation is enrolled in the
   * experiment that was live for its classification at this instant, or in none. A row without it is a
   * conversation that predates the stamp, and is never enrolled.
   */
  createdAt?: string;
  /**
   * The profile experiment and variant this conversation serves for its whole life (ADR-050), written
   * once on the first turn that resolves it and never rewritten. It outlives the experiment: a
   * conversation that started on a variant finishes on it.
   */
  enrollment?: ConversationEnrollment;
  /**
   * THE CONVERSATION'S ACTIVE MEETING, or absent when no meeting is running.
   *
   * A meeting is an event on a conversation's timeline rather than a place of its own
   * (SPEC-ASSISTANT-MEETINGS FR12), so its identity belongs to the conversation and is keyed the same
   * way. HERE AND IN NO TABLE OF ITS OWN: one store answers "what is happening on this conversation", which is
   * what tenet 8 asks.
   *
   * HERE RATHER THAN IN CHANNEL METADATA for the `conversationType` reason above, and more sharply:
   * Metadata is member-WRITABLE, so a member could point their conversation at a meeting created under
   * a different classification and have the join path vend them a token for it.
   *
   * `classification` IS RECORDED AS READ, NOT RE-DERIVED. The join path must vend attendees for the
   * meeting the conversation actually created, under the classification that was in force when
   * `CreateMeeting` ran. Re-reading the parent's tag at join time would answer a different question and
   * would silently re-home an in-flight meeting if the tag were ever to change.
   *
   * CLEARED ON END, which is what makes `attribute_not_exists` a usable claim condition - see
   * {@link claimActiveMeeting}.
   */
  activeMeeting?: {
    /** Chime SDK Meetings `MeetingId`. */
    meetingId: string;
    /** The `Meeting` object `CreateMeeting` returned, passed to the client SDK verbatim. */
    meeting: unknown;
    /** The parent channel's `classification` tag as read at create time. */
    classification: string;
    createdAt: string;
    /** Who started it: a person's AppInstanceUser id, or the AppInstanceBot id of the assistant whose workflow run did. */
    createdBy: string;
    /** Whether a person started it from the conversation, or a workflow's `start_meeting` step did. */
    startedVia?: 'person' | 'workflow';
    /** How long the ring that announced it sounds, in whole seconds from `createdAt` (`meeting-ring.ts`). */
    ringSeconds?: number;
    /**
     * The hosts, decided once at the start (`meeting-host.ts`): each an AppInstanceUser id with the host role they hold.
     * Absent: a workflow's meeting in a parent conversation with no host role held and no moderator readable at its start.
     */
    hosts?: Array<{ personId: string; role?: string }>;
    /** How the hosts were decided: the parent conversation's host roles, starting the meeting, or moderating the conversation a workflow started it in. */
    hostVia?: 'role' | 'starter' | 'moderators';
    /**
     * When a person last joined it, at the service's time (`recordMeetingJoin`): the meeting's watch reads it so a join its
     * events store has not filed yet still keeps the meeting running.
     */
    lastJoinAt?: string;
    /** The people a host removed from it, by person id (`meeting-host-controls.ts`): a join of theirs is refused while it runs. */
    removedPersonIds?: Set<string> | string[];
    /** The people a host holds muted, by person id: their audio stays receive-only, and a request of theirs waits for a host. */
    heldPersonIds?: Set<string> | string[];
    /** The people asking a host to let them speak, by person id. */
    speakRequestIds?: Set<string> | string[];
  };
  /**
   * THE CONVERSATION'S MOST RECENT MEETING, kept after it ends: written with the claim and never removed by the release,
   * so the router can tell a meeting that ended was this conversation's, how long it ran, and which card it posted.
   */
  lastMeeting?: {
    meetingId: string;
    createdAt: string;
    createdBy: string;
    startedVia?: 'person' | 'workflow';
    hosts?: Array<{ personId: string; role?: string }>;
    hostVia?: 'role' | 'starter' | 'moderators';
    /** The ended card the router posted, so a later summary updates it in place. */
    endedCardMessageId?: string;
    /** The assistant that posted it, the one bearer that may edit it. */
    endedCardBy?: string;
    /** The conversation the card is in: the one the meeting was started from, where the meeting's cards are posted. */
    endedCardIn?: string;
    /**
     * WHETHER THE MEETING IS TRANSCRIBED NOW, AND IN WHICH MODE (SPEC-ASSISTANT-MEETINGS FR28, two modes):
     * `on` is live captions; `recording` adds the stored transcript and the summary. Turned on by the platform at the
     * start where the deployment transcribes its meetings, and by a host after; turned off by a host. `changedBy` is the
     * host's AppInstanceUser id, or `platform`. `everOn` and `everRecorded` stay once set, so the end knows whether a
     * transcript is kept and summarized. `recordedUntil` is when a host last turned recording off.
     */
    transcription?: { on: boolean; recording?: boolean; changedAt: string; changedBy: string; everOn?: boolean; everRecorded?: boolean; recordedFrom?: string; recordedUntil?: string };
    /**
     * EVERY ATTENDEE THE MEETING CREATED, as `<personId> <attendeeId>` (`recordMeetingAttendee`): once the service has ended
     * the meeting and answers for no attendee, a line reported late is kept only from an attendee recorded here for the
     * person reporting it.
     */
    attendeeKeys?: Set<string> | string[];
    /** How many characters of each person's speech the transcript holds, by person id (`chargeTranscriptChars`). */
    transcriptChars?: Record<string, number>;
    /** When the platform released it as ended: the lines its apps report just after are kept until a short while after this. */
    endedAt?: string;
    /** How it ended, where something ended it: a host, or the meeting's watch (`meeting-watch.ts`). Absent: everyone left. */
    endReason?: MeetingEndReason;
    /**
     * THE MEETING'S AUDIO AND VIDEO RECORDING, by part (SPEC-ASSISTANT-MEETINGS FR70, `meeting-recording.ts`): each stretch
     * of recording mode captured, then joined into one file. Written by the meetings functions only.
     */
    recordings?: MeetingRecordings;
    /**
     * THE MEETING'S SUMMARY (SPEC-ASSISTANT-MEETINGS FR66, FR67): the summary's sections as the owning assistant's turn wrote
     * them from the transcript, and each action item with the task it opened. Written once, by the router, after the
     * meeting was recorded; the ended card in the room says it.
     */
    summary?: import('./meeting-summary-turn.js').StoredMeetingSummary;
  };
  /**
   * WHO HOLDS WHICH PARTICIPANT ROLE (DESIGN-CONVERSATION-TYPES section 6.1): role name to AppInstanceUser id to the
   * holding's origin. Written by the canonical creator for the roles it resolves and by the invitations path for a
   * role an invitation records, and read through `holdersByRole` (`participant-roles.ts`). Here and never in
   * member-writable Metadata, because a holding decides which message a person receives and whether they moderate.
   */
  participantRoles?: ParticipantRoleHoldings;
  /**
   * THE ALARM THIS CONVERSATION WATCHES (ADR-061, the incident watch): the CloudWatch alarm the event that opened it named,
   * written by the canonical creator. The router runs `alarm-state-changed` here only while this row and the alarm's
   * watch record (`recordAlarmWatch`) both name it.
   */
  watchedAlarm?: string;
  /**
   * THE KEYS THIS CONVERSATION WATCHES (DESIGN-EVENT-TARGETS section 3), each `<kind>#<id>`: written by the canonical
   * creator when the opener that opened it declares `watches`. A watch trigger runs here only while this row and the key's
   * watch item (`claimRefWatch`) both name it.
   */
  watchedRefs?: string[];
  /**
   * THE `thread` CHILDREN THIS CONVERSATION OPENED (DESIGN-WORKFLOWS-AND-TASKS section 6), oldest first, written by the
   * creator as each opens (`recordChildConversation`). Server-only, never channel Metadata, which members can write. A
   * child that ended stays listed; whether a turn may read it is decided when it is read.
   */
  children?: ChildConversation[];
  /**
   * ON A MEETING'S OWN CONVERSATION: the conversation the meeting was started from, as its channel ARN, written by the
   * creator that opened it (`openMeetingConversation`). The meeting's cards are posted there, and its members may join
   * where the meeting's settings allow. Server-only, because it decides who is admitted.
   */
  meetingOf?: string;
  /**
   * ON A CONVERSATION A MEETING WAS STARTED FROM: the meeting's own conversation, the newest one, so a second start or a
   * join from here finds the meeting running rather than opening another. `opening` holds a start's claim from before the
   * meeting's conversation is opened until its meeting is recorded there (`confirmMeetingConversation`); `channelArn` is
   * written once that conversation stands. While `opening` is held, every other start goes to the conversation named
   * here, or waits, and none opens another.
   */
  meetingConversation?: { channelArn?: string; opening?: string; at: string };
  /**
   * ON A MEETING'S OWN CONVERSATION: the people a confirmed proposal added to it from outside its room (`add_to_meeting`,
   * `lib/meeting-invites.ts`), by AppInstanceUser id. Each names who confirmed it, the accounts it was for, the brief its
   * assistant (`briefBy`) says privately to the person when they join, and when that was said (`briefedAt`), so it is
   * said once. Server-only: it decides what a person is told.
   */
  meetingInvites?: Record<string, MeetingInviteRecord>;
  updatedAt?: string;
}

/** One person a confirmed proposal added to a meeting, as its conversation's row holds them. */
export interface MeetingInviteRecord {
  accounts: string[];
  brief: string;
  /** The assistant that says the brief, as its AppInstanceBot ARN. */
  briefBy: string;
  /** Who confirmed the proposal, as their AppInstanceUser ARN. */
  invitedBy: string;
  at: string;
  briefedAt?: string;
}

/** A `thread` child a conversation opened: its channel id, its type, and when it opened. */
export interface ChildConversation {
  channelId: string;
  typeKey: string;
  openedAt: string;
}

/**
 * A conversation's pinned profile-experiment variant, carrying what the variant SERVES as it stood when
 * the conversation was enrolled: a profile ref resolved to a concrete version (so activating a new
 * version of the control later does not change an enrolled conversation), or a model key.
 */
export interface ConversationEnrollment {
  experimentId: string;
  variantId: string;
  /** When the conversation was enrolled (its createdAt). Supplied at read, never trusted from a member; a
   *  pause or end of the experiment after this instant releases the conversation (`enrollmentHolds`). */
  enrolledAt?: string;
  profileRef?: { profileName: string; version: number };
  modelKey?: string;
  imageGenModelKey?: string;
}

/**
 * The writable subset (everything except the key + server-managed timestamp). `null` is admitted on
 * every field as the explicit CLEAR signal - see {@link putChannelContext} for the three-way
 * absent / clear / set distinction.
 */
export type ChannelContextPatch = {
  [K in keyof Omit<ChannelContext, 'channelArn' | 'updatedAt'>]?: ChannelContext[K] | null;
};

// Read at call time (not module load) so the table name is picked up even if env is set after import.
const tableName = (): string => process.env.CHANNEL_CONTEXT_TABLE || '';

// The fields this store owns. Anything outside this set is ignored on write (defense against a caller
// accidentally trying to persist a member-readable routing bit here).
const OWNED_FIELDS: Array<keyof ChannelContextPatch> = [
  'participantProfile',
  'domainContext',
  'otherContexts',
  'userName',
  // A field absent from this list is SILENTLY DISCARDED on write - the loop below only visits these keys, and
  // `putChannelContext` swallows failures, so a forgotten entry looks exactly like a working write.
  'participants',
  // Model-routing signals. Owned here rather than left in member-writable Metadata, because they choose
  // which model answers the turn.
  'userLanguage',
  'segment',
  // Drift carry-over, read by the welcome composer. Owned here rather than left in member-writable
  // Metadata: see the field docs above for the timing, trust and size reasons.
  'priorSubject',
  // The person's own subject for the conversation. Here for the TIMING reason only - it stays on
  // Metadata as well, because a member may edit their own conversation's subject.
  'topic',
  'eventSummary',
  'visitSummary',
  'priorMessage',
  'parentRef',
  // The member roster. Identity (`sub`, federated `iss`, role) — never channel Metadata.
  'memberIdentities',
  // Onboarding intake progress. Personal answers, so server-only.
  'onboardingIntake',
  // The conversation's TYPE key. Owned here rather than left in member-writable Metadata: a member who
  // could rewrite it would be choosing their own conversation's policy.
  'conversationType',
  // The enforced membership source, for the same reason: a member able to clear it could make an
  // enforced room accept invitations the reconcile then undoes.
  'membershipSource',
  // Write-once (see WRITE_ONCE_FIELDS): when the conversation began, and the experiment variant it serves.
  'createdAt',
  'enrollment',
  // Who holds which participant role. Owned here rather than in member-writable Metadata: a holding decides who is
  // addressed and who moderates.
  'participantRoles',
  // The alarm the incident watch follows here, which decides where `alarm-state-changed` runs.
  'watchedAlarm',
  // The keys a watch trigger follows here (DESIGN-EVENT-TARGETS), which decide where its `event-received` runs.
  'watchedRefs',
];

/**
 * Fields the store writes only where they are absent. A conversation is created once and enrolled once,
 * so a second write of either is a re-stamp or a race, and the first value is the true one.
 */
const WRITE_ONCE_FIELDS: ReadonlySet<keyof ChannelContextPatch> = new Set(['createdAt', 'enrollment']);

let _ddb: Pick<DynamoDBDocumentClient, 'send'> | null = null;
function ddb(): Pick<DynamoDBDocumentClient, 'send'> {
  if (!_ddb) _ddb = sessionDocumentClient({ requestHandler: BOUNDED_REQUEST_HANDLER });
  return _ddb;
}
/** Test seam: the store every read and write of this module goes to (null: the default client). */
export function __setChannelContextStore(store: Pick<DynamoDBDocumentClient, 'send'> | null): void { _ddb = store; }

/**
 * Fetch a channel's private grounding, or null when there is none / the store is unavailable.
 * Fail-soft: any store error returns null so the caller renders no host grounding rather than erroring.
 *
 * `opts.consistent` requests a strongly consistent read, and the welcome path MUST pass it. The participant
 * shape is written moments before the channel is created, so a default (eventually consistent) read can miss
 * a write that has already happened - which would defeat the entire point of writing ahead of creation and
 * put back the ambiguity between "nobody is here" and "not visible yet". It costs one extra read unit on one
 * read per conversation. Per-turn callers do not need it: by then the row is long settled.
 */
/** The sparse index over `conversationType`, which is how every conversation of one type is found. */
export const CONVERSATION_TYPE_INDEX = 'ByConversationType';

/**
 * Every conversation stamped with `typeKey`, as channel ARNs.
 *
 * FOR THE MEMBERSHIP RECONCILE, which has to reach every live conversation of a group-sourced type when
 * the group changes. The index is sparse - a row carries the attribute only once a creator stamped it -
 * and KEYS_ONLY, so this returns ARNs and nothing private. A conversation whose channel has since
 * expired still has a row (rows are not yet disposed of, see the table's note), so a caller must treat
 * a NotFound on the channel as "gone" rather than as a failure.
 */
export async function listChannelsOfType(typeKey: string): Promise<string[]> {
  const table = tableName();
  if (!table || !typeKey) return [];
  const arns: string[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb().send(new QueryCommand({
      TableName: table,
      IndexName: CONVERSATION_TYPE_INDEX,
      KeyConditionExpression: 'conversationType = :t',
      ExpressionAttributeValues: { ':t': typeKey },
      ExclusiveStartKey,
    }));
    for (const item of res.Items || []) if (typeof item.channelArn === 'string') arns.push(item.channelArn);
    ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return arns;
}

export async function getChannelContext(
  channelArn: string,
  opts: { consistent?: boolean } = {},
): Promise<ChannelContext | null> {
  const table = tableName();
  if (!channelArn || !table) return null;
  try {
    return await readChannelContext(channelArn, opts);
  } catch (err) {
    console.warn('[channel-context] getChannelContext failed (fail-soft → null):', (err as Error).message);
    return null;
  }
}

/** A row that could not be read: the store refused or failed, or the function has no table. Never "no row". */
export class ChannelContextUnreadable extends Error {
  constructor(cause: string) {
    super(cause);
    this.name = 'ChannelContextUnreadable';
  }
}

/**
 * A channel's row for a caller that decides from what is NOT there (no meeting, no claim): `null` only when the store
 * answered that there is no row, and a throw ({@link ChannelContextUnreadable}) when it could not answer.
 */
export async function readChannelContext(
  channelArn: string,
  opts: { consistent?: boolean } = {},
): Promise<ChannelContext | null> {
  const table = tableName();
  if (!channelArn) return null;
  if (!table) throw new ChannelContextUnreadable('CHANNEL_CONTEXT_TABLE is unset');
  try {
    const res = await ddb().send(new GetCommand({
      TableName: table,
      Key: { channelArn },
      ...(opts.consistent ? { ConsistentRead: true } : {}),
    }));
    return (res.Item as ChannelContext | undefined) ?? null;
  } catch (err) {
    throw new ChannelContextUnreadable((err as Error).name || 'read failed');
  }
}

/** The most rows one batch read asks for, the store's own limit. */
const BATCH_READ_MAX = 100;

/**
 * MANY CHANNELS' ROWS IN AS FEW READS AS THE STORE ALLOWS, each consistent, keyed by channel ARN: `null` where the store
 * answered there is no row. Only `fields` are read. Keys the store leaves unprocessed are asked once more; any still
 * unanswered, or a read that fails, throws ({@link ChannelContextUnreadable}), so a caller never decides from a short answer.
 */
export async function readChannelContexts(
  channelArns: readonly string[], fields: readonly (keyof ChannelContext)[],
): Promise<Map<string, ChannelContext | null>> {
  const table = tableName();
  if (!table) throw new ChannelContextUnreadable('CHANNEL_CONTEXT_TABLE is unset');
  const out = new Map<string, ChannelContext | null>();
  const wanted = [...new Set(channelArns.filter(Boolean))];
  const projection = [...new Set(['channelArn', ...fields])];
  const names = Object.fromEntries(projection.map((f, i) => [`#f${i}`, f]));
  for (let i = 0; i < wanted.length; i += BATCH_READ_MAX) {
    let keys: Array<Record<string, unknown>> = wanted.slice(i, i + BATCH_READ_MAX).map((channelArn) => ({ channelArn }));
    for (let attempt = 0; attempt < 2 && keys.length; attempt++) {
      try {
        const res = await ddb().send(new BatchGetCommand({
          RequestItems: { [table]: { Keys: keys, ConsistentRead: true, ProjectionExpression: Object.keys(names).join(', '), ExpressionAttributeNames: names } },
        }));
        for (const item of (res.Responses?.[table] ?? []) as ChannelContext[]) if (item.channelArn) out.set(item.channelArn, item);
        keys = (res.UnprocessedKeys?.[table]?.Keys ?? []) as Array<Record<string, unknown>>;
      } catch (err) {
        throw new ChannelContextUnreadable((err as Error).name || 'read failed');
      }
    }
    if (keys.length) throw new ChannelContextUnreadable('some rows were left unread');
  }
  for (const arn of wanted) if (!out.has(arn)) out.set(arn, null);
  return out;
}

/**
 * The participant shape for a channel, or null when none was recorded.
 *
 * Always a consistent read, and always re-derived by `parseParticipantContext` rather than trusted as stored.
 * Null means "nothing was recorded", which is DIFFERENT from a recorded `none`: the first is a legacy channel
 * or a failed write and the caller should fall back to reading live membership, while the second is a
 * positive statement that nobody is in the conversation.
 */
export async function getParticipantContext(channelArn: string): Promise<ParticipantContext | null> {
  const ctx = await getChannelContext(channelArn, { consistent: true });
  return parseParticipantContext(ctx?.participants);
}

/**
 * Upsert the private grounding for a channel. Only the owned fields actually present on the patch are
 * touched (a partial patch updates just those keys); unknown keys are ignored. Best-effort: a write
 * failure is logged and swallowed - the conversation still exists, only its host grounding is missing,
 * which is strictly safer than leaking it into member-readable Metadata.
 *
 * The three-way distinction on a field matters:
 *   - ABSENT (`undefined`, or `''` for the string fields) -> not part of this patch, leave the stored
 *     value alone. `''` stays in this bucket because callers use it for "the source had nothing here",
 *     which must not destroy a good stored value;
 *   - `null`          -> explicitly CLEAR it (REMOVE the attribute);
 *   - any other value -> set it.
 * Without an explicit clear signal a field was write-once-then-permanent: an edited plan that removed
 * its `domainContext` kept serving the stale one forever, because every way of expressing the removal
 * was discarded as "nothing to write".
 */
/**
 * Record ONE member's identity hint, without disturbing the ones already there.
 *
 * A member added AFTER creation needs this for their host-supplied role, which exists nowhere else. It is
 * not how they are reached: the directory resolves a person's contact through `Identities`.
 *
 * ONE ENTRY PER PERSON: the list is read and replaced, the person's old entry out and this one in, on the condition
 * that the list is still what was read, so two hosts adding two people at once both land and a re-add replaces.
 *
 * A NATIVE member needs no hint at all (their id IS their sub), so this is a no-op without an issuer.
 */
export async function recordMemberIdentity(
  channelArn: string,
  identity: { sub: string; iss?: string; role?: string },
): Promise<void> {
  const table = tableName();
  if (!channelArn || !table || !identity?.sub || !identity.iss) return;
  const entry = {
    sub: identity.sub,
    iss: identity.iss,
    ...(identity.role ? { role: identity.role } : {}),
  };
  const names = { '#memberIdentities': 'memberIdentities', '#updatedAt': 'updatedAt' };
  try {
    for (let attempt = 0; attempt < CHILD_LIST_REPLACE_TRIES; attempt += 1) {
      const read = (await getChannelContext(channelArn, { consistent: true }))?.memberIdentities;
      try {
        await ddb().send(new UpdateCommand({
          TableName: table,
          Key: { channelArn },
          UpdateExpression: 'SET #memberIdentities = :list, #updatedAt = :updatedAt',
          ConditionExpression: read ? '#memberIdentities = :read' : 'attribute_not_exists(#memberIdentities)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: {
            ':list': [...(read ?? []).filter((m) => m.sub !== identity.sub || m.iss !== identity.iss), entry],
            ':updatedAt': new Date().toISOString(),
            ...(read ? { ':read': read } : {}),
          },
        }));
        return;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
    }
    console.warn('[channel-context] recordMemberIdentity left a member unrecorded after', CHILD_LIST_REPLACE_TRIES, 'tries');
  } catch (err) {
    console.warn('[channel-context] recordMemberIdentity failed (non-fatal):', (err as Error).name);
  }
}

/** The children a parent's row lists, the newest of them. */
const MAX_CHILDREN_KEPT = 50;
/** How many times a full list is read and replaced before the child is left unlisted. */
const CHILD_LIST_REPLACE_TRIES = 3;

const isConditionFailure = (err: unknown): boolean => (err as Error)?.name === 'ConditionalCheckFailedException';

/**
 * LIST A `thread` CHILD ON ITS PARENT'S ROW (DESIGN-WORKFLOWS-AND-TASKS section 6, rule 1). Never throws: a child that is not
 * listed is one its parent's turns do not read.
 *
 * Under the cap it appends with no read, so two children opening at once both land. At the cap it reads the list and replaces
 * it, oldest entry dropped, on the condition that the list is still exactly what it read; a concurrent writer fails that
 * condition and the replace is made again from the new list.
 */
export async function recordChildConversation(parentArn: string, child: ChildConversation): Promise<boolean> {
  const table = tableName();
  if (!parentArn || !table || !child?.channelId) return false;
  const names = { '#children': 'children', '#updatedAt': 'updatedAt' };
  try {
    try {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: parentArn },
        UpdateExpression: 'SET #children = list_append(if_not_exists(#children, :empty), :child), #updatedAt = :updatedAt',
        ConditionExpression: 'attribute_not_exists(#children) OR size(#children) < :cap',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ':child': [child], ':empty': [], ':cap': MAX_CHILDREN_KEPT, ':updatedAt': new Date().toISOString() },
      }));
      return true;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
    for (let attempt = 0; attempt < CHILD_LIST_REPLACE_TRIES; attempt += 1) {
      const read = (await getChannelContext(parentArn, { consistent: true }))?.children ?? [];
      try {
        await ddb().send(new UpdateCommand({
          TableName: table,
          Key: { channelArn: parentArn },
          UpdateExpression: 'SET #children = :list, #updatedAt = :updatedAt',
          ConditionExpression: '#children = :read',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ':list': [...read.slice(-(MAX_CHILDREN_KEPT - 1)), child], ':read': read, ':updatedAt': new Date().toISOString() },
        }));
        return true;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
    }
    console.warn('[channel-context] recordChildConversation left a child unlisted after', CHILD_LIST_REPLACE_TRIES, 'tries');
    return false;
  } catch (err) {
    console.warn('[channel-context] recordChildConversation failed (non-fatal):', (err as Error).name);
    return false;
  }
}

export async function putChannelContext(channelArn: string, patch: ChannelContextPatch): Promise<boolean> {
  if (!channelArn) return false;
  const table = tableName();
  if (!table) {
    console.warn('[channel-context] putChannelContext skipped: CHANNEL_CONTEXT_TABLE unset');
    return false;
  }
  const now = new Date().toISOString();
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': now };
  const sets: string[] = ['#updatedAt = :updatedAt'];
  const removes: string[] = [];
  for (const field of OWNED_FIELDS) {
    const val = patch[field];
    if (val === undefined || val === '') continue; // not part of this patch
    names[`#${field}`] = field;
    if (val === null) { // explicit clear
      removes.push(`#${field}`);
      continue;
    }
    values[`:${field}`] = val;
    sets.push(WRITE_ONCE_FIELDS.has(field)
      ? `#${field} = if_not_exists(#${field}, :${field})`
      : `#${field} = :${field}`);
  }
  // Nothing but the timestamp and no removals ⇒ no-op.
  if (sets.length === 1 && removes.length === 0) return true;
  const expression = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    console.warn('[channel-context] putChannelContext failed (non-fatal):', (err as Error).name);
    return false;
  }
}

/**
 * WRITE EVERY FIELD OF `patch` ONLY WHERE IT IS ABSENT, in one update and without a read.
 *
 * For a creator that finds a conversation whose first creation stopped part way: the row it would have
 * written may be missing, partly written, or complete, and this fills in exactly what is missing while
 * leaving whatever is there (a later edit, a re-stamped grounding) alone. A `null` or empty field is not
 * part of the seed. Never throws, like `putChannelContext`.
 */
export async function seedChannelContext(channelArn: string, patch: ChannelContextPatch): Promise<boolean> {
  const table = tableName();
  if (!channelArn || !table) return false;
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  const sets: string[] = ['#updatedAt = :updatedAt'];
  for (const field of OWNED_FIELDS) {
    const val = patch[field];
    if (val === undefined || val === null || val === '') continue;
    names[`#${field}`] = field;
    values[`:${field}`] = val;
    sets.push(`#${field} = if_not_exists(#${field}, :${field})`);
  }
  if (sets.length === 1) return true;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    console.warn('[channel-context] seedChannelContext failed (non-fatal):', (err as Error).name);
    return false;
  }
}

/**
 * Advance an onboarding intake ONLY from the state that was read.
 *
 * Two deliveries of one answer (at-least-once), or two quick messages, each read the same stored
 * intake and each advance it. An unconditional write lets the second one file the same answer under the
 * NEXT question and skip it. So the write is conditional on the cursor and phase this turn advanced
 * from, and a losing write changes nothing.
 *
 * Returns 'advanced', 'lost' (another turn advanced it first) or 'failed' (the store could not be written).
 */
export async function advanceOnboardingIntake(
  channelArn: string,
  from: { cursor: number; phase: StoredIntake['phase']; subject: string },
  next: StoredIntake,
): Promise<'advanced' | 'lost' | 'failed'> {
  const table = tableName();
  if (!channelArn || !table) return 'failed';
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #intake = :next, #updatedAt = :updatedAt',
      ConditionExpression: '#intake.#cursor = :cursor AND #intake.#phase = :phase AND #intake.#subject = :subject',
      ExpressionAttributeNames: {
        '#intake': 'onboardingIntake', '#cursor': 'cursor', '#phase': 'phase', '#subject': 'subject', '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':next': next, ':cursor': from.cursor, ':phase': from.phase, ':subject': from.subject,
        ':updatedAt': new Date().toISOString(),
      },
    }));
    return 'advanced';
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return 'lost';
    console.warn('[channel-context] advanceOnboardingIntake failed (non-fatal):', (err as Error).name);
    return 'failed';
  }
}

/**
 * START AN ONBOARDING INTAKE ONLY WHERE NO OTHER PERSON'S IS IN PROGRESS (ADR-061 decision 2, `start_intake`).
 *
 * A conversation holds one intake at a time, keyed by its subject, and only that subject's messages answer it. Two people
 * joining at once would otherwise overwrite each other's, filing one person's answers under the other's questions. So the
 * write holds only where there is no intake, the one there is done, or it is already this person's.
 *
 * Returns 'started', 'busy' (another person's intake is in progress) or 'failed'.
 */
export async function startOnboardingIntake(channelArn: string, intake: StoredIntake): Promise<'started' | 'busy' | 'failed'> {
  const table = tableName();
  if (!channelArn || !table || !intake?.subject) return 'failed';
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #intake = :next, #updatedAt = :updatedAt',
      ConditionExpression: 'attribute_not_exists(#intake) OR #intake.#phase = :done OR #intake.#subject = :subject',
      ExpressionAttributeNames: { '#intake': 'onboardingIntake', '#phase': 'phase', '#subject': 'subject', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':next': intake, ':done': 'done', ':subject': intake.subject, ':updatedAt': new Date().toISOString() },
    }));
    return 'started';
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return 'busy';
    console.warn('[channel-context] startOnboardingIntake failed (non-fatal):', (err as Error).name);
    return 'failed';
  }
}

/**
 * HOW LONG A CLAIM ON A ROOM'S NAMING HOLDS (`room-naming.ts`): longer than any processor run can last (Lambda's
 * fifteen-minute limit on a run), so while one is held no second naming run can be in flight, and once it lapses a run that
 * named nothing (its derivation failed, or the asynchronous invoke never ran) is retried by the next message that can
 * name the room.
 */
export const ROOM_NAMING_LEASE_MS = 15 * 60 * 1000;

/** What a claim on a room's naming found: this caller holds it, the room is named, or another caller's claim holds. */
export type RoomNamingClaim =
  | { claimed: true; at: number; /** An earlier claim had lapsed, so its run may already have named the room. */ lapsed: boolean }
  | { claimed: false; named: true }
  | { claimed: false; named: false; heldUntil?: number };

/**
 * CLAIM THE ROOM'S NAMING, the one time at once its own assistant is asked to name it from a message another assistant
 * answered (`room-naming.ts`). A room whose first person message goes to an assistant that does not moderate it (a
 * duel's alt, a member assistant) is named by its primary instead, and this claim keeps that to one title derivation
 * in flight per room however many such turns arrive before the name lands. It is refused once the room is recorded as
 * named (`markRoomNamed`), and a claim older than {@link ROOM_NAMING_LEASE_MS} has lapsed and is taken over. Written on
 * the room's own row, which every creator writes before the room exists, so a channel with no row claims nothing.
 *
 * A store that cannot be written claims nothing (tenet D5).
 */
export async function claimRoomNaming(channelArn: string, now: number = Date.now()): Promise<RoomNamingClaim> {
  const table = tableName();
  if (!channelArn || !table) return { claimed: false, named: false };
  try {
    const res = await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #naming = :now',
      ConditionExpression: 'attribute_exists(#arn) AND attribute_not_exists(#named) AND (attribute_not_exists(#naming) OR #naming < :lapsed)',
      ExpressionAttributeNames: { '#naming': 'namingClaimedAt', '#named': 'roomNamedAt', '#arn': 'channelArn' },
      ExpressionAttributeValues: { ':now': now, ':lapsed': now - ROOM_NAMING_LEASE_MS },
      ReturnValues: 'UPDATED_OLD',
    }));
    return { claimed: true, at: now, lapsed: typeof res.Attributes?.namingClaimedAt === 'number' };
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') {
      console.warn('[channel-context] claimRoomNaming failed (non-fatal):', (err as Error).name);
      return { claimed: false, named: false };
    }
  }
  const state = await roomNamingOf(channelArn);
  return state.named
    ? { claimed: false, named: true }
    : { claimed: false, named: false, ...(state.claimedAt !== undefined ? { heldUntil: state.claimedAt + ROOM_NAMING_LEASE_MS } : {}) };
}

/** The room's naming as its row records it: whether it is named, and when its naming was last claimed. */
export async function roomNamingOf(channelArn: string): Promise<{ named: boolean; claimedAt?: number }> {
  const table = tableName();
  if (!channelArn || !table) return { named: false };
  try {
    const res = await ddb().send(new GetCommand({
      TableName: table,
      Key: { channelArn },
      ProjectionExpression: '#named, #naming',
      ExpressionAttributeNames: { '#named': 'roomNamedAt', '#naming': 'namingClaimedAt' },
    }));
    const item = res.Item ?? {};
    return { named: item.roomNamedAt !== undefined, ...(typeof item.namingClaimedAt === 'number' ? { claimedAt: item.namingClaimedAt } : {}) };
  } catch (err) {
    console.warn('[channel-context] roomNamingOf failed (fail-soft: not named):', (err as Error).name);
    return { named: false };
  }
}

/**
 * GIVE BACK A CLAIM THIS CALLER HOLDS, when its naming run could not be started, so the next message that can name the
 * room asks again rather than waiting out the lease. Only the claim set at `claimedAt` is removed. Never throws.
 */
export async function releaseRoomNaming(channelArn: string, claimedAt: number): Promise<void> {
  const table = tableName();
  if (!channelArn || !table) return;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'REMOVE #naming',
      ConditionExpression: '#naming = :at',
      ExpressionAttributeNames: { '#naming': 'namingClaimedAt' },
      ExpressionAttributeValues: { ':at': claimedAt },
    }));
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') {
      console.warn('[channel-context] releaseRoomNaming failed (non-fatal; the claim lapses):', (err as Error).name);
    }
  }
}

/**
 * RECORD THAT THE ROOM HAS A NAME, read from the Amazon Chime SDK by the caller, so every later turn of any container
 * learns it from the row and asks nobody to name the room. Written once; never throws.
 */
export async function markRoomNamed(channelArn: string, now: number = Date.now()): Promise<void> {
  const table = tableName();
  if (!channelArn || !table) return;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #named = :now REMOVE #naming',
      ConditionExpression: 'attribute_exists(#arn) AND attribute_not_exists(#named)',
      ExpressionAttributeNames: { '#named': 'roomNamedAt', '#naming': 'namingClaimedAt', '#arn': 'channelArn' },
      ExpressionAttributeValues: { ':now': now },
    }));
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') {
      console.warn('[channel-context] markRoomNamed failed (non-fatal):', (err as Error).name);
    }
  }
}

/**
 * WHICH CONVERSATION WATCHES AN ALARM (ADR-061, the incident watch): one record per alarm, keyed `watch#alarm#<name>` in
 * this table beside the rows it points at, naming the conversation the event that opened it said it was about and that
 * conversation's classification. The newest room opened for an alarm watches it. The creator writes it with the same
 * owned-field update it writes the room's row with, and the router reads it by key; no scan finds it.
 */
export async function recordAlarmWatch(watchKey: string, watch: { room: string; classification: string }): Promise<boolean> {
  const table = tableName();
  if (!table || !watchKey.startsWith('watch#alarm#') || !watch.room) return false;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn: watchKey },
      UpdateExpression: 'SET #room = :room, #classification = :classification, #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#room': 'room', '#classification': 'classification', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':room': watch.room, ':classification': watch.classification, ':updatedAt': new Date().toISOString() },
    }));
    return true;
  } catch (err) {
    console.warn('[channel-context] recordAlarmWatch failed (non-fatal):', (err as Error).name);
    return false;
  }
}

/**
 * A WATCHED KEY'S ITEM (DESIGN-EVENT-TARGETS section 3), keyed per classification, kind and id: the first live conversation
 * to watch a key keeps it. The write succeeds where no item exists or it names this room; where it names another room, it
 * succeeds only when `released` says that room no longer holds it (archived or gone), and then only if the item still
 * names that room. Returns the room that holds the key after the call, or null when the store cannot be written.
 */
export async function claimRefWatch(
  watchKey: string,
  watch: { room: string; classification: string },
  released: (room: string) => Promise<boolean>,
): Promise<string | null> {
  const table = tableName();
  if (!table || !watchKey.startsWith('watch#ref#') || !watch.room) return null;
  const put = (condition: string, values: Record<string, unknown>) => ddb().send(new UpdateCommand({
    TableName: table,
    Key: { channelArn: watchKey },
    UpdateExpression: 'SET #room = :room, #classification = :classification, #updatedAt = :updatedAt',
    ConditionExpression: condition,
    ExpressionAttributeNames: { '#room': 'room', '#classification': 'classification', '#updatedAt': 'updatedAt' },
    ExpressionAttributeValues: { ':room': watch.room, ':classification': watch.classification, ':updatedAt': new Date().toISOString(), ...values },
  }));
  try {
    await put('attribute_not_exists(#room) OR #room = :room', {});
    return watch.room;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') {
      console.warn('[channel-context] claimRefWatch failed (non-fatal):', (err as Error).name);
      return null;
    }
  }
  const held = await refWatchOf(watchKey);
  if (!held) return null;
  if (held.room === watch.room) return watch.room;
  if (!(await released(held.room))) return held.room;
  try {
    await put('#room = :held', { ':held': held.room });
    return watch.room;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.warn('[channel-context] claimRefWatch takeover failed (non-fatal):', (err as Error).name);
    return (await refWatchOf(watchKey))?.room ?? null;
  }
}

/**
 * The conversation a watched key's item names, or null when none watches it or the store cannot be read. With `strict`,
 * a store that cannot be read throws ({@link ChannelContextUnreadable}), so null means only that none watches it.
 */
export async function refWatchOf(watchKey: string, opts: { strict?: boolean } = {}): Promise<{ room: string; classification: string } | null> {
  return watchKeyOf(watchKey, 'watch#ref#', opts.strict);
}

/**
 * The conversation an alarm's watch record names, or null when none watches it or the store cannot be read. With `strict`,
 * a store that cannot be read throws ({@link ChannelContextUnreadable}), so null means only that none watches it.
 */
export async function alarmWatchOf(watchKey: string, opts: { strict?: boolean } = {}): Promise<{ room: string; classification: string } | null> {
  return watchKeyOf(watchKey, 'watch#alarm#', opts.strict);
}

/** One watch item, read consistently by its key, under the family its prefix names. */
async function watchKeyOf(watchKey: string, family: string, strict = false): Promise<{ room: string; classification: string } | null> {
  const table = tableName();
  if (!watchKey.startsWith(family)) return null;
  if (!table) {
    if (strict) throw new ChannelContextUnreadable('CHANNEL_CONTEXT_TABLE is unset');
    return null;
  }
  try {
    const res = await ddb().send(new GetCommand({ TableName: table, Key: { channelArn: watchKey }, ConsistentRead: true }));
    const item = res.Item as { room?: unknown; classification?: unknown } | undefined;
    return item && typeof item.room === 'string' && typeof item.classification === 'string'
      ? { room: item.room, classification: item.classification } : null;
  } catch (err) {
    if (strict) throw new ChannelContextUnreadable((err as Error).name || 'read failed');
    console.warn('[channel-context] watch read failed (fail-soft → null):', (err as Error).name);
    return null;
  }
}

/** How long a claim on an opening event that produced no room holds before the event may open one again. */
export const OPENING_CLAIM_STALE_MS = 5 * 60_000;

/**
 * ONE CONVERSATION PER OPENING EVENT (ADR-061 decision 1, `conversation-opened`): the canonical creator claims the event,
 * by the declaration that delivered it and the event's own id (`opened#<opener>#<event id>`), before it creates anything,
 * so a redelivered event opens no second room and starts no second run. The claim names the room once it exists
 * (`settleOpening`). A claim that never named a room, because its creation failed, is taken again once it is stale, so
 * an event an operator re-drives from the dead-letter queue still opens its room.
 *
 * Returns `{ claimed: true }`, `{ existing: <room> }` when the event already opened one, or `{ busy: true }` while another
 * delivery of it is creating the room, and `{ failed: true }` when the store cannot be written.
 */
export async function claimOpening(key: string, now: number = Date.now()): Promise<{ claimed: true } | { existing: string } | { busy: true } | { failed: true }> {
  const table = tableName();
  if (!table || !key.startsWith('opened#')) return { failed: true };
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn: key },
      UpdateExpression: 'SET #claimedAt = :now',
      ConditionExpression: 'attribute_not_exists(#claimedAt) OR (attribute_not_exists(#room) AND #claimedAt < :stale)',
      ExpressionAttributeNames: { '#claimedAt': 'claimedAt', '#room': 'room' },
      ExpressionAttributeValues: { ':now': now, ':stale': now - OPENING_CLAIM_STALE_MS },
    }));
    return { claimed: true };
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') {
      console.warn('[channel-context] claimOpening failed:', (err as Error).name);
      return { failed: true };
    }
    const res = await ddb().send(new GetCommand({ TableName: table, Key: { channelArn: key }, ConsistentRead: true })).catch(() => null);
    const room = (res?.Item as { room?: unknown } | undefined)?.room;
    return typeof room === 'string' && room ? { existing: room } : { busy: true };
  }
}

/** Name the room an opening event opened, on its claim. A failure is logged: the room stands either way. */
export async function settleOpening(key: string, room: string): Promise<void> {
  const table = tableName();
  if (!table || !key.startsWith('opened#') || !room) return;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table, Key: { channelArn: key },
      UpdateExpression: 'SET #room = :room', ExpressionAttributeNames: { '#room': 'room' }, ExpressionAttributeValues: { ':room': room },
    }));
  } catch (err) {
    console.warn('[channel-context] settleOpening failed (non-fatal):', (err as Error).name);
  }
}

/**
 * Record a meeting as the conversation's active one, ONLY if it has none.
 *
 * Returns 'claimed', 'lost' (a meeting was already recorded, so the caller's own meeting is surplus) or
 * 'failed' (the store could not be written).
 *
 * WHY THIS IS CONDITIONAL AND `putChannelContext` WOULD NOT DO. "Start the meeting" is a read of the
 * active meeting followed by a create, and two people pressing it at once both read nothing and both
 * create. Under last-write-wins the store keeps the second meeting and the first is orphaned: it exists
 * and is billable in Chime, nothing points at it, and the two callers sit in different meetings each
 * believing it is the conversation's. So the create path writes on `attribute_not_exists` and the loser
 * is told it lost, which is the only point at which it can still delete the meeting it made.
 *
 * A LOSER MUST NOT TREAT ITS OWN MEETING AS THE ANSWER. On 'lost' the caller deletes the meeting it
 * created and re-reads, because the winner's meeting is the conversation's.
 *
 * FAILURE IS NOT FAIL-SOFT HERE, which is the one place this store's usual posture is wrong. Absent
 * grounding costs a less personal reply; an unrecorded meeting is a meeting running in Chime that no
 * join, no end and no roster can ever find. The caller refuses and deletes rather than returning join
 * information for a meeting it could not record.
 */
export async function claimActiveMeeting(
  channelArn: string,
  meeting: NonNullable<ChannelContext['activeMeeting']>,
): Promise<'claimed' | 'lost' | 'failed'> {
  const table = tableName();
  if (!channelArn || !table) return 'failed';
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #meeting = :meeting, #last = :last, #updatedAt = :updatedAt',
      ConditionExpression: 'attribute_not_exists(#meeting)',
      ExpressionAttributeNames: { '#meeting': 'activeMeeting', '#last': 'lastMeeting', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: {
        ':meeting': meeting,
        ':last': {
          meetingId: meeting.meetingId, createdAt: meeting.createdAt, createdBy: meeting.createdBy,
          ...(meeting.startedVia ? { startedVia: meeting.startedVia } : {}),
          ...(meeting.hosts ? { hosts: meeting.hosts, ...(meeting.hostVia ? { hostVia: meeting.hostVia } : {}) } : {}),
        },
        ':updatedAt': new Date().toISOString(),
      },
    }));
    return 'claimed';
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return 'lost';
    console.error('[channel-context] claimActiveMeeting failed:', (err as Error).name);
    return 'failed';
  }
}

/**
 * Clear the conversation's active meeting, ONLY if it is still the one the caller observed.
 *
 * Returns 'released', 'superseded' (a different meeting is recorded now, so there was nothing of the
 * caller's to clear) or 'failed'.
 *
 * WHY A MEETING IS CLEARED FROM A READ PATH AT ALL. Amazon Chime SDK terminates a meeting on its own
 * once the last attendee leaves, so the recorded meeting goes stale as a matter of NORMAL operation
 * rather than only on an explicit end. Nothing tells this platform when that happened - a meeting
 * ending is the absence of attendees, and per tenet 7 the absence of an event cannot be event-sourced -
 * so the staleness is discovered by the next reader, on a `GetMeeting` that comes back not-found. A
 * reader that merely reported "no meeting" and left the record in place would leave the conversation
 * permanently unable to start another one, because the claim condition would never again be free.
 *
 * WHY IT IS CONDITIONAL ON THE ID. The clear races the next start. Between a reader seeing a dead
 * meeting and clearing it, somebody can claim a live one, and an unconditional clear would delete that
 * live claim - orphaning a running meeting and handing the conversation the same stale-record problem
 * from the other direction. Conditioning on the observed id makes the loser a no-op.
 *
 * THE END IS RECORDED IN THE SAME WRITE THAT CLEARS THE MEETING: `endedAt`, where given, is written on its record
 * (`lastMeeting.endedAt`) by the update that removes it, so no reader ever finds the meeting no longer running and not yet
 * said to have ended. A record whose last meeting is not this one is released without it.
 */
export async function releaseActiveMeeting(
  channelArn: string,
  meetingId: string,
  endedAt?: string,
): Promise<'released' | 'superseded' | 'failed'> {
  const table = tableName();
  if (!channelArn || !meetingId || !table) return 'failed';
  const release = async (stamp: string | undefined): Promise<'released' | 'superseded' | 'failed'> => {
    try {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { channelArn },
        UpdateExpression: 'REMOVE #meeting SET #updatedAt = :updatedAt' + (stamp ? ', #last.#endedAt = :endedAt' : ''),
        ConditionExpression: stamp ? '#meeting.#meetingId = :meetingId AND #last.#meetingId = :meetingId' : '#meeting.#meetingId = :meetingId',
        ExpressionAttributeNames: {
          '#meeting': 'activeMeeting', '#meetingId': 'meetingId', '#updatedAt': 'updatedAt',
          ...(stamp ? { '#last': 'lastMeeting', '#endedAt': 'endedAt' } : {}),
        },
        ExpressionAttributeValues: { ':meetingId': meetingId, ':updatedAt': new Date().toISOString(), ...(stamp ? { ':endedAt': stamp } : {}) },
      }));
      return 'released';
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return 'superseded';
      console.error('[channel-context] releaseActiveMeeting failed:', (err as Error).name);
      return 'failed';
    }
  };
  const outcome = await release(endedAt);
  return outcome === 'superseded' && endedAt ? release(undefined) : outcome;
}

/**
 * RECORD THAT A PERSON JOINED THE CONVERSATION'S RUNNING MEETING, at the service's time: `activeMeeting.lastJoinAt`, only while
 * the row still names this meeting and only forward, so a redelivered or late join never moves it back. Returns 'recorded',
 * 'not-running' (the row names no such running meeting, or a later join is recorded) or 'failed'.
 */
export async function recordMeetingJoin(channelArn: string, meetingId: string, at: string): Promise<'recorded' | 'not-running' | 'failed'> {
  const table = tableName();
  if (!channelArn || !meetingId || !table || !Number.isFinite(Date.parse(at))) return 'failed';
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #meeting.#lastJoinAt = :at',
      ConditionExpression: '#meeting.#meetingId = :meetingId AND (attribute_not_exists(#meeting.#lastJoinAt) OR #meeting.#lastJoinAt < :at)',
      ExpressionAttributeNames: { '#meeting': 'activeMeeting', '#meetingId': 'meetingId', '#lastJoinAt': 'lastJoinAt' },
      ExpressionAttributeValues: { ':meetingId': meetingId, ':at': at },
    }));
    return 'recorded';
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return 'not-running';
    console.error('[channel-context] recordMeetingJoin failed:', (err as Error).name);
    return 'failed';
  }
}

/** How long a start's claim on a conversation's meeting holds before another start may take it over. */
export const MEETING_OPENING_HOLD_MS = 60_000;

/**
 * CLAIM A CONVERSATION'S NEXT MEETING, so two starts at once hold one meeting in one meeting conversation. The claim is the
 * parent's `meetingConversation.opening` token, and it holds until the meeting is recorded in its conversation
 * ({@link confirmMeetingConversation}), so a start that reads the parent in between finds the claim, not an ended meeting.
 *
 * Two shapes:
 *  - a new meeting conversation: taken where none is recorded, where the one recorded is still `prior` and no start
 *    holds it (its meeting ended), or where another start's claim outlived {@link MEETING_OPENING_HOLD_MS};
 *  - `reuse`: the meeting is held again in `prior`, the conversation already recorded, which stays recorded; taken while
 *    no start holds it, or its claim outlived the hold.
 * Returns 'claimed', 'lost' (another start holds it, or the parent names another conversation now) or 'failed'.
 */
export async function claimMeetingConversation(
  parentArn: string, prior: string | undefined, token: string, opts: { now?: number; reuse?: boolean } = {},
): Promise<'claimed' | 'lost' | 'failed'> {
  const table = tableName();
  const now = opts.now ?? Date.now();
  if (!parentArn || !token || !table || (opts.reuse && !prior)) return 'failed';
  const at = new Date(now).toISOString();
  const stale = new Date(now - MEETING_OPENING_HOLD_MS).toISOString();
  try {
    if (opts.reuse) {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: parentArn },
        UpdateExpression: 'SET #mc = :mc, #updatedAt = :updatedAt',
        ConditionExpression: '#mc.#arn = :prior AND (attribute_not_exists(#mc.#opening) OR #mc.#at < :stale)',
        ExpressionAttributeNames: { '#mc': 'meetingConversation', '#arn': 'channelArn', '#opening': 'opening', '#at': 'at', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':mc': { channelArn: prior, opening: token, at }, ':prior': prior, ':stale': stale, ':updatedAt': at },
      }));
    } else if (prior) {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: parentArn },
        UpdateExpression: 'SET #mc = :mc, #updatedAt = :updatedAt',
        ConditionExpression: 'attribute_not_exists(#mc) OR (#mc.#arn = :prior AND attribute_not_exists(#mc.#opening)) OR (attribute_exists(#mc.#opening) AND #mc.#at < :stale)',
        ExpressionAttributeNames: { '#mc': 'meetingConversation', '#arn': 'channelArn', '#opening': 'opening', '#at': 'at', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':mc': { opening: token, at }, ':prior': prior, ':stale': stale, ':updatedAt': at },
      }));
    } else {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: parentArn },
        UpdateExpression: 'SET #mc = :mc, #updatedAt = :updatedAt',
        ConditionExpression: 'attribute_not_exists(#mc) OR (attribute_exists(#mc.#opening) AND #mc.#at < :stale)',
        ExpressionAttributeNames: { '#mc': 'meetingConversation', '#opening': 'opening', '#at': 'at', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':mc': { opening: token, at }, ':stale': stale, ':updatedAt': at },
      }));
    }
    return 'claimed';
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return 'lost';
    console.error('[channel-context] claimMeetingConversation failed:', (err as Error).name);
    return 'failed';
  }
}

/**
 * Record the meeting's conversation the claim `token` opened, KEEPING the claim: the parent names the conversation, and
 * every other start goes there, until the meeting is recorded in it. False when the claim was taken over, or the write failed.
 */
export async function settleMeetingConversation(parentArn: string, token: string, meetingArn: string): Promise<boolean> {
  const table = tableName();
  if (!parentArn || !token || !meetingArn || !table) return false;
  const at = new Date().toISOString();
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn: parentArn },
      UpdateExpression: 'SET #mc = :mc, #updatedAt = :updatedAt',
      ConditionExpression: '#mc.#opening = :token',
      ExpressionAttributeNames: { '#mc': 'meetingConversation', '#opening': 'opening', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':mc': { channelArn: meetingArn, opening: token, at }, ':token': token, ':updatedAt': at },
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] settleMeetingConversation failed:', (err as Error).name);
    return false;
  }
}

/**
 * THE MEETING IS RECORDED IN ITS CONVERSATION: the parent's claim is cleared while the parent still names that
 * conversation, so a later start reads a running or an ended meeting there. False when it names another, or the write failed.
 */
export async function confirmMeetingConversation(parentArn: string, meetingArn: string): Promise<boolean> {
  const table = tableName();
  if (!parentArn || !meetingArn || !table) return false;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn: parentArn },
      UpdateExpression: 'REMOVE #mc.#opening SET #updatedAt = :updatedAt',
      ConditionExpression: '#mc.#arn = :arn',
      ExpressionAttributeNames: { '#mc': 'meetingConversation', '#opening': 'opening', '#arn': 'channelArn', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':arn': meetingArn, ':updatedAt': new Date().toISOString() },
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] confirmMeetingConversation failed:', (err as Error).name);
    return false;
  }
}

/**
 * GIVE UP THE CLAIM `token` holds, for a start that produced no meeting: the parent names `keepArn` again (the
 * conversation it named before, or the one this start opened) with no claim, or nothing when there is none. A claim
 * another start holds now is left alone. False when it was, or the write failed.
 */
export async function releaseMeetingConversation(parentArn: string, token: string, keepArn?: string): Promise<boolean> {
  const table = tableName();
  if (!parentArn || !token || !table) return false;
  const at = new Date().toISOString();
  try {
    if (keepArn) {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: parentArn },
        UpdateExpression: 'SET #mc = :mc, #updatedAt = :updatedAt',
        ConditionExpression: '#mc.#opening = :token',
        ExpressionAttributeNames: { '#mc': 'meetingConversation', '#opening': 'opening', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':mc': { channelArn: keepArn, at }, ':token': token, ':updatedAt': at },
      }));
    } else {
      await ddb().send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: parentArn },
        UpdateExpression: 'REMOVE #mc SET #updatedAt = :updatedAt',
        ConditionExpression: '#mc.#opening = :token',
        ExpressionAttributeNames: { '#mc': 'meetingConversation', '#opening': 'opening', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':token': token, ':updatedAt': at },
      }));
    }
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] releaseMeetingConversation failed:', (err as Error).name);
    return false;
  }
}

/** Record, on a meeting's own conversation, the conversation it was started from. Written once, by the creator. */
export async function recordMeetingOf(meetingArn: string, parentArn: string): Promise<boolean> {
  const table = tableName();
  if (!meetingArn || !parentArn || !table) return false;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn: meetingArn },
      UpdateExpression: 'SET #of = :of, #updatedAt = :updatedAt',
      ConditionExpression: 'attribute_not_exists(#of)',
      ExpressionAttributeNames: { '#of': 'meetingOf', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':of': parentArn, ':updatedAt': new Date().toISOString() },
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] recordMeetingOf failed:', (err as Error).name);
    return false;
  }
}

/**
 * RECORD THE PEOPLE A CONFIRMED PROPOSAL ADDED TO A MEETING'S CONVERSATION, by AppInstanceUser id, only on a row that names
 * the room it was started from (`meetingOf`). A person invited again keeps the brief already said to them. Returns false
 * when nothing was written.
 */
export async function recordMeetingInvites(meetingArn: string, invites: Record<string, MeetingInviteRecord>): Promise<boolean> {
  const table = tableName();
  const ids = Object.keys(invites);
  if (!meetingArn || !table || !ids.length) return false;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table, Key: { channelArn: meetingArn },
      UpdateExpression: 'SET #inv = if_not_exists(#inv, :empty), #updatedAt = :updatedAt',
      ConditionExpression: 'attribute_exists(#of)',
      ExpressionAttributeNames: { '#inv': 'meetingInvites', '#of': 'meetingOf', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':empty': {}, ':updatedAt': new Date().toISOString() },
    }));
    const names: Record<string, string> = { '#inv': 'meetingInvites' };
    const values: Record<string, unknown> = {};
    const sets = ids.map((id, i) => {
      names[`#p${i}`] = id;
      values[`:v${i}`] = invites[id];
      return `#inv.#p${i} = if_not_exists(#inv.#p${i}, :v${i})`;
    });
    await ddb().send(new UpdateCommand({
      TableName: table, Key: { channelArn: meetingArn },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    console.error('[channel-context] recordMeetingInvites failed:', (err as Error).name);
    return false;
  }
}

/**
 * CLAIM A PERSON'S ARRIVAL BRIEF, once: their invitation on the meeting's row, marked said. Returns the invitation when this
 * call claimed it, and null when there is none, it was said already, or the write failed.
 */
export async function claimArrivalBrief(meetingArn: string, personId: string): Promise<MeetingInviteRecord | null> {
  const table = tableName();
  if (!meetingArn || !personId || !table) return null;
  try {
    const res = await ddb().send(new UpdateCommand({
      TableName: table, Key: { channelArn: meetingArn },
      UpdateExpression: 'SET #inv.#p.#at = :now',
      ConditionExpression: 'attribute_exists(#inv.#p) AND attribute_not_exists(#inv.#p.#at)',
      ExpressionAttributeNames: { '#inv': 'meetingInvites', '#p': personId, '#at': 'briefedAt' },
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
      ReturnValues: 'ALL_NEW',
    }));
    return ((res.Attributes as ChannelContext | undefined)?.meetingInvites?.[personId]) ?? null;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] claimArrivalBrief failed:', (err as Error).name);
    return null;
  }
}

/**
 * Record the ended card the router posted for the conversation's last meeting, ONLY if that meeting is still its last.
 * Returns false when it is not, or the write failed: the card stays, and a later summary posts its own.
 */
/** Why a meeting ended, as its ended card words it. */
export type MeetingEndReason = 'host' | 'nobody-joined' | 'left-alone' | 'time-limit';

/**
 * RECORD A FACT OF THE CONVERSATION'S LAST MEETING, ONLY if that meeting is still its last: whether it is transcribed now,
 * when and why it ended, or its summary. Returns false when it is not, or the write failed.
 */
export async function recordMeetingFact(
  channelArn: string, meetingId: string,
  fact: { transcription: NonNullable<NonNullable<ChannelContext['lastMeeting']>['transcription']> } | { endReason: MeetingEndReason } | { endedAt: string }
    | { summary: NonNullable<NonNullable<ChannelContext['lastMeeting']>['summary']> },
  /**
   * WRITTEN OVER THE STATE IT WAS DECIDED FROM, OR NOT AT ALL: the fact is written only while the field's `changedAt` is
   * this value (null: while the field is absent), so two changes decided from one read never both land.
   */
  opts: { ifChangedAt?: string | null } = {},
): Promise<boolean> {
  const table = tableName();
  if (!channelArn || !meetingId || !table) return false;
  const [field, value] = Object.entries(fact)[0] as [string, unknown];
  const guarded = opts.ifChangedAt !== undefined;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #last.#field = :value, #updatedAt = :updatedAt',
      ConditionExpression: '#last.#meetingId = :meetingId'
        + (!guarded ? '' : opts.ifChangedAt === null ? ' AND attribute_not_exists(#last.#field)' : ' AND #last.#field.#changedAt = :prior'),
      ExpressionAttributeNames: {
        '#last': 'lastMeeting', '#field': field, '#meetingId': 'meetingId', '#updatedAt': 'updatedAt',
        ...(guarded && opts.ifChangedAt !== null ? { '#changedAt': 'changedAt' } : {}),
      },
      ExpressionAttributeValues: {
        ':value': value, ':meetingId': meetingId, ':updatedAt': new Date().toISOString(),
        ...(guarded && opts.ifChangedAt !== null ? { ':prior': opts.ifChangedAt } : {}),
      },
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] recordMeetingFact failed:', (err as Error).name);
    return false;
  }
}

/**
 * RECORD AN ATTENDEE THE MEETING CREATED FOR A PERSON, on its record (`lastMeeting.attendeeKeys`), only while the meeting is
 * the conversation's last. False when it could not be written.
 */
export async function recordMeetingAttendee(channelArn: string, meetingId: string, personId: string, attendeeId: string): Promise<boolean> {
  const table = tableName();
  if (!channelArn || !meetingId || !personId || !attendeeId || !table) return false;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'ADD #last.#keys :key',
      ConditionExpression: '#last.#meetingId = :meetingId',
      ExpressionAttributeNames: { '#last': 'lastMeeting', '#keys': 'attendeeKeys', '#meetingId': 'meetingId' },
      ExpressionAttributeValues: { ':key': new Set([meetingAttendeeKey(personId, attendeeId)]), ':meetingId': meetingId },
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] recordMeetingAttendee failed:', (err as Error).name);
    return false;
  }
}

/** How an attendee the meeting created for a person is recorded. */
export const meetingAttendeeKey = (personId: string, attendeeId: string): string => `${personId} ${attendeeId}`;

/** Whether the meeting recorded this attendee as this person's, by its record. */
export function meetingRecordedAttendee(row: Pick<ChannelContext, 'lastMeeting'> | null | undefined, meetingId: string, personId: string, attendeeId: string): boolean {
  const last = row?.lastMeeting;
  if (!last || last.meetingId !== meetingId) return false;
  const keys = last.attendeeKeys instanceof Set ? [...last.attendeeKeys] : Array.isArray(last.attendeeKeys) ? last.attendeeKeys : [];
  return keys.includes(meetingAttendeeKey(personId, attendeeId));
}

/**
 * CHARGE A PERSON'S LINES TO THEIR SHARE OF THE TRANSCRIPT (`lastMeeting.transcriptChars`): added only while what they hold
 * stays within `budget`, so no one person's reports can crowd everyone else out of the transcript and its summary.
 * `over` where the lines would pass it; `failed` where the record could not be written.
 */
export async function chargeTranscriptChars(
  channelArn: string, meetingId: string, personId: string, chars: number, budget: number,
): Promise<'charged' | 'over' | 'failed'> {
  const table = tableName();
  if (!channelArn || !meetingId || !personId || !table) return 'failed';
  if (chars > budget) return 'over';
  const names = { '#last': 'lastMeeting', '#chars': 'transcriptChars', '#meetingId': 'meetingId' };
  try {
    // The map first, where the meeting has none yet: one write may not set a path and its child together.
    await ddb().send(new UpdateCommand({
      TableName: table, Key: { channelArn },
      UpdateExpression: 'SET #last.#chars = if_not_exists(#last.#chars, :empty)',
      ConditionExpression: '#last.#meetingId = :meetingId',
      ExpressionAttributeNames: names, ExpressionAttributeValues: { ':empty': {}, ':meetingId': meetingId },
    }));
    await ddb().send(new UpdateCommand({
      TableName: table, Key: { channelArn },
      UpdateExpression: 'ADD #last.#chars.#person :n',
      ConditionExpression: '#last.#meetingId = :meetingId AND (attribute_not_exists(#last.#chars.#person) OR #last.#chars.#person <= :room)',
      ExpressionAttributeNames: { ...names, '#person': personId },
      ExpressionAttributeValues: { ':n': chars, ':room': budget - chars, ':meetingId': meetingId },
    }));
    return 'charged';
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return 'over';
    console.error('[channel-context] chargeTranscriptChars failed:', (err as Error).name);
    return 'failed';
  }
}

export async function recordEndedMeetingCard(channelArn: string, meetingId: string, messageId: string, by: string, cardIn: string = channelArn): Promise<boolean> {
  const table = tableName();
  if (!channelArn || !meetingId || !messageId || !by || !table) return false;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: 'SET #last.#card = :card, #last.#by = :by, #last.#in = :in, #updatedAt = :updatedAt',
      ConditionExpression: '#last.#meetingId = :meetingId',
      ExpressionAttributeNames: { '#last': 'lastMeeting', '#card': 'endedCardMessageId', '#by': 'endedCardBy', '#in': 'endedCardIn', '#meetingId': 'meetingId', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':card': messageId, ':by': by, ':in': cardIn, ':meetingId': meetingId, ':updatedAt': new Date().toISOString() },
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] recordEndedMeetingCard failed:', (err as Error).name);
    return false;
  }
}

// ── THE MEETING'S SETS AND ITS RECORDING PARTS ─────────────────────────────────
// Written here and nowhere else, on the meeting the conversation holds now: a host's controls (`meeting-host-controls.ts`)
// change `activeMeeting`'s sets, and the media capture (`meeting-media-capture.ts`) records `lastMeeting.recordings`.

/** The sets on the running meeting's record a host's controls change. */
export type MeetingSetField = 'removedPersonIds' | 'heldPersonIds' | 'speakRequestIds';

/** A change to the running meeting's sets: ids added to or deleted from each, and whole sets removed. */
export interface MeetingSetChange {
  add?: Partial<Record<MeetingSetField, string[]>>;
  del?: Partial<Record<'heldPersonIds' | 'speakRequestIds', string[]>>;
  clear?: Array<'heldPersonIds' | 'speakRequestIds'>;
}

/** Change the running meeting's sets, on the meeting the conversation holds now and on no other. False when it could not. */
export async function changeMeetingSets(meetingArn: string, meetingId: string, change: MeetingSetChange): Promise<boolean> {
  const table = tableName();
  if (!table) return false;
  const names: Record<string, string> = { '#meeting': 'activeMeeting', '#meetingId': 'meetingId', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':meetingId': meetingId, ':now': new Date().toISOString() };
  const adds: string[] = [];
  const dels: string[] = [];
  const removes: string[] = [];
  for (const [field, ids] of Object.entries(change.add ?? {})) {
    if (!ids?.length) continue;
    names[`#${field}`] = field;
    values[`:add_${field}`] = new Set(ids);
    adds.push(`#meeting.#${field} :add_${field}`);
  }
  for (const [field, ids] of Object.entries(change.del ?? {})) {
    if (!ids?.length) continue;
    names[`#${field}`] = field;
    values[`:del_${field}`] = new Set(ids);
    dels.push(`#meeting.#${field} :del_${field}`);
  }
  for (const field of change.clear ?? []) {
    names[`#${field}`] = field;
    removes.push(`#meeting.#${field}`);
  }
  if (!adds.length && !dels.length && !removes.length) return true;
  const expression = [
    adds.length ? `ADD ${adds.join(', ')}` : '',
    dels.length ? `DELETE ${dels.join(', ')}` : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
    'SET #updatedAt = :now',
  ].filter(Boolean).join(' ');
  try {
    await ddb().send(new UpdateCommand({
      TableName: table, Key: { channelArn: meetingArn }, UpdateExpression: expression,
      ConditionExpression: '#meeting.#meetingId = :meetingId', ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    console.warn('[channel-context] changeMeetingSets failed:', (err as Error).name);
    return false;
  }
}

/**
 * THE MEETING THE CONVERSATION HOLDS NOW, read consistently: its record, or null where none is held. Throws where it could
 * not be read, so a caller tells an unreadable record from an absent one.
 */
export async function readActiveMeetingNow(meetingArn: string): Promise<ChannelContext['activeMeeting'] | null> {
  const table = tableName();
  if (!table) throw Object.assign(new Error('no channel context table'), { name: 'ChannelContextUnconfigured' });
  const out = await ddb().send(new GetCommand({
    TableName: table, Key: { channelArn: meetingArn }, ConsistentRead: true,
    ProjectionExpression: '#meeting', ExpressionAttributeNames: { '#meeting': 'activeMeeting' },
  })) as { Item?: { activeMeeting?: ChannelContext['activeMeeting'] } };
  return out.Item?.activeMeeting ?? null;
}

/** The meeting's recording parts, read from its conversation's record; only while the meeting is that record's last. */
export async function readMeetingRecordings(meetingArn: string, meetingId: string): Promise<Array<{ partId: string } & RecordingPart>> {
  const out = await ddb().send(new GetCommand({ TableName: tableName(), Key: { channelArn: meetingArn }, ConsistentRead: true })) as
    { Item?: { lastMeeting?: { meetingId?: string; recordings?: unknown } } };
  const last = out.Item?.lastMeeting;
  return last?.meetingId === meetingId ? recordingPartsOf(last.recordings) : [];
}

/** Record a new recording part, only while the meeting is the conversation's last. */
export async function recordMeetingRecordingPart(meetingArn: string, meetingId: string, partId: string, part: RecordingPart): Promise<boolean> {
  const names = { '#last': 'lastMeeting', '#recs': 'recordings', '#meetingId': 'meetingId' };
  try {
    // The map first, where the meeting has none yet: one write may not set a path and its child together.
    await ddb().send(new UpdateCommand({
      TableName: tableName(), Key: { channelArn: meetingArn },
      UpdateExpression: 'SET #last.#recs = if_not_exists(#last.#recs, :empty)',
      ConditionExpression: '#last.#meetingId = :meetingId',
      ExpressionAttributeNames: names, ExpressionAttributeValues: { ':empty': {}, ':meetingId': meetingId },
    }));
    await ddb().send(new UpdateCommand({
      TableName: tableName(), Key: { channelArn: meetingArn },
      UpdateExpression: 'SET #last.#recs.#part = :part',
      ConditionExpression: '#last.#meetingId = :meetingId',
      ExpressionAttributeNames: { ...names, '#part': partId }, ExpressionAttributeValues: { ':part': part, ':meetingId': meetingId },
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] recordMeetingRecordingPart failed:', (err as Error).name);
    return false;
  }
}

/**
 * MOVE A RECORDING PART FROM ONE OF `from` TO `to`, with the fields that come with it, only while the meeting is the
 * conversation's last and the part is still in one of `from`. Answers whether this call moved it, so two racing callers
 * act once.
 */
export async function moveMeetingRecordingPart(
  meetingArn: string, meetingId: string, partId: string, from: readonly RecordingPartState[], to: RecordingPartState,
  fields: Partial<Pick<RecordingPart, 'concatenation' | 'key' | 'failure'>> = {},
): Promise<boolean> {
  const sets = ['#last.#recs.#part.#state = :to', '#last.#recs.#part.#changedAt = :at'];
  const names: Record<string, string> = { '#last': 'lastMeeting', '#recs': 'recordings', '#part': partId, '#state': 'state', '#changedAt': 'changedAt', '#meetingId': 'meetingId' };
  const values: Record<string, unknown> = { ':to': to, ':at': new Date().toISOString(), ':meetingId': meetingId };
  for (const [f, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`#last.#recs.#part.#f_${f} = :f_${f}`);
    names[`#f_${f}`] = f;
    values[`:f_${f}`] = v;
  }
  from.forEach((st, i) => { values[`:from${i}`] = st; });
  const fromStates = from.map((_s, i) => `:from${i}`).join(', ');
  try {
    await ddb().send(new UpdateCommand({
      TableName: tableName(), Key: { channelArn: meetingArn },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: `#last.#meetingId = :meetingId AND #last.#recs.#part.#state IN (${fromStates})`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
    return true;
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') console.error('[channel-context] moveMeetingRecordingPart failed:', to, (err as Error).name);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NO MEMBER COUNT IS STORED ON THIS ITEM, and a writer for one does not belong here.
//
// A cached count exists to keep a `ListChannelMemberships` off the `@all` request path, and it cannot
// serve that purpose: the responder branch resolves size through `lib/channel-size.ts`, which takes
// the live read because a count derived from archived membership events collapses assistants into the
// human roster (a battle channel of three reports 2), and because only one of the two callers that
// must agree on size can reach this table at all.
//
// A row from an earlier deployment can carry `memberCount` and `memberCountUpdatedAt`. Both are inert,
// and `lib/legacy-channel-context.ts` accounts for that shape: neither is stamped onto `updatedAt`, so
// such a row stays eligible for legacy grounding promotion.
// ─────────────────────────────────────────────────────────────────────────────
