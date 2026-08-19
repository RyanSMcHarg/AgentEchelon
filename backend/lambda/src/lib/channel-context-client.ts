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
 * Scope note: the channel Metadata still carries ROUTING bits that are legitimately member-visible
 * (topic, triggerContext, userLanguage, segment, contextId) and the participant ROSTER of member subs
 * (already visible to members via `ListChannelMemberships`, and consumed by the notification fan-out).
 * Only the four private grounding fields below move here.
 *
 * Reads FAIL SOFT (return null): a store outage degrades to "no host grounding this turn" rather than
 * erroring the turn. Writes are best-effort: a lost write degrades grounding, it never leaks.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { parseParticipantContext, type ParticipantContext } from './participant-shape.js';

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
   * WHAT IT IS FOR, and what it is NOT. This is a LOOKUP, never an authority. The notification
   * fan-out decides WHO to notify from live `ListChannelMemberships`; this only supplies the `iss` for
   * a member whose AppInstanceUser id is `deriveFederatedSub(iss, sub)` — a one-way SHA-256 that
   * membership alone cannot reverse into an IdP. Host grounding reads it to say who is in the
   * conversation. Neither may treat it as the membership list.
   */
  memberIdentities?: Array<{ sub: string; iss?: string; role?: string }>;
  updatedAt?: string;
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
  'priorMessage',
  'parentRef',
  // The member roster. Identity (`sub`, federated `iss`, role) — never channel Metadata.
  'memberIdentities',
];

let _ddb: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
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
 * A member added AFTER creation needs this: their AppInstanceUser id is `deriveFederatedSub(iss, sub)`,
 * a one-way hash, so nothing downstream can recover which IdP to ask about them. Without a hint the
 * notification fan-out resolves them against the DEFAULT pool, fails, and skips them — a member added
 * on purpose who then silently never hears anything — and host grounding can name everyone in the
 * conversation except them.
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

export async function putChannelContext(channelArn: string, patch: ChannelContextPatch): Promise<void> {
  if (!channelArn) return;
  const table = tableName();
  if (!table) {
    console.warn('[channel-context] putChannelContext skipped: CHANNEL_CONTEXT_TABLE unset');
    return;
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
    sets.push(`#${field} = :${field}`);
  }
  // Nothing but the timestamp and no removals ⇒ no-op.
  if (sets.length === 1 && removes.length === 0) return;
  const expression = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`;
  try {
    await ddb().send(new UpdateCommand({
      TableName: table,
      Key: { channelArn },
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    console.warn('[channel-context] putChannelContext failed (non-fatal):', (err as Error).name);
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
