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
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { parseParticipantContext, type ParticipantContext } from './participant-shape.js';
import type { StoredIntake } from './onboarding-intake.js';
import type { ParticipantRoleHoldings } from './participant-roles.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionDocumentClient } from './assistant-session.js';

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
  updatedAt?: string;
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
];

/**
 * Fields the store writes only where they are absent. A conversation is created once and enrolled once,
 * so a second write of either is a re-stamp or a race, and the first value is the true one.
 */
const WRITE_ONCE_FIELDS: ReadonlySet<keyof ChannelContextPatch> = new Set(['createdAt', 'enrollment']);

let _ddb: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) _ddb = sessionDocumentClient({ requestHandler: BOUNDED_REQUEST_HANDLER });
  return _ddb;
}

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
    const res = await ddb().send(new GetCommand({
      TableName: table,
      Key: { channelArn },
      ...(opts.consistent ? { ConsistentRead: true } : {}),
    }));
    return (res.Item as ChannelContext | undefined) ?? null;
  } catch (err) {
    console.warn('[channel-context] getChannelContext failed (fail-soft → null):', (err as Error).name);
    return null;
  }
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
 * `list_append` rather than read-modify-write: adds are concurrent (two hosts can add two people at
 * once) and a lost update here costs exactly the member it dropped. A repeated add can leave a
 * duplicate entry, which is harmless — every reader keys these into a Map by derived sub — and is the
 * right trade against dropping one.
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
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression:
        'SET #memberIdentities = list_append(if_not_exists(#memberIdentities, :empty), :entry), #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#memberIdentities': 'memberIdentities', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':entry': [entry], ':empty': [], ':updatedAt': new Date().toISOString() },
    }));
  } catch (err) {
    console.warn('[channel-context] recordMemberIdentity failed (non-fatal):', (err as Error).name);
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

/**
 * THE HOST TITLE A CONTEXT ROOM WAS LAST NAMED FROM, and nothing else of its row: the creator reads this one attribute
 * (its grant is limited to it) to decide whether a reopened room still carries its context name. Undefined when absent
 * or unreadable, so a reopen then keeps the room's name.
 */
export async function contextTitleOf(channelArn: string): Promise<string | undefined> {
  const table = tableName();
  if (!channelArn || !table) return undefined;
  try {
    const res = await ddb().send(new GetCommand({
      TableName: table,
      Key: { channelArn },
      ConsistentRead: true,
      ProjectionExpression: '#topic',
      ExpressionAttributeNames: { '#topic': 'topic' },
    }));
    return typeof res.Item?.topic === 'string' ? res.Item.topic : undefined;
  } catch (err) {
    console.warn('[channel-context] contextTitleOf failed (fail-soft: the room keeps its name):', (err as Error).name);
    return undefined;
  }
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

/** The conversation an alarm's watch record names, or null when none watches it or the store cannot be read. */
export async function alarmWatchOf(watchKey: string): Promise<{ room: string; classification: string } | null> {
  const table = tableName();
  if (!table || !watchKey.startsWith('watch#alarm#')) return null;
  try {
    const res = await ddb().send(new GetCommand({ TableName: table, Key: { channelArn: watchKey }, ConsistentRead: true }));
    const item = res.Item as { room?: unknown; classification?: unknown } | undefined;
    return item && typeof item.room === 'string' && typeof item.classification === 'string'
      ? { room: item.room, classification: item.classification } : null;
  } catch (err) {
    console.warn('[channel-context] alarmWatchOf failed (fail-soft → null):', (err as Error).name);
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
