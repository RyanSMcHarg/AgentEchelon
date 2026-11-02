/**
 * INVITATIONS, FOR CONVERSATIONS (M-10, M-5, B8): the record, its states, and the reads and writes every
 * party to one shares.
 *
 * An invitation is a `Tokens` record of kind `invitation` (A8), keyed by its token's hash. It names the
 * conversation, the issuing AppInstanceUser and the invitee's AppInstanceUser, always. The invitee is an
 * AppInstanceUser minted for the invitation at invite time by the one minter (`mintInvitee`,
 * `lib/person-identity.ts`, on the credential exchange), given an expiration at the invitation's own, and
 * added as a member of that one conversation. It has no `Identities` row: the record is what names it until
 * a redemption binds one (SPEC-EMBEDDABLE-WIDGET FR3). Nothing finds an invitee by an address (K2): the
 * address the inviter typed is where the one email goes, and it is stored nowhere.
 *
 * WHO TOUCHES A RECORD, each on its own grant (`dynamodb:LeadingKeys` on `invitation#*`, or the sparse index alone):
 *  - `Conversations` (`invitations.ts`) writes it and revokes it, and lists a conversation's invitations
 *    through the one sparse index on `Tokens` (`INVITATIONS_BY_CHANNEL`), which holds no token;
 *  - the credential exchange reads it for the landing page (`peek`) and redeems it, in its declared mode
 *    only: a `link` redemption from the landing page, a `sign-in` redemption by a first sign-in
 *    (`lib/invitation-redemption.ts`);
 *  - offboarding deletes every invitation a person issued or is named by (`PERSON_TOKEN_KINDS`);
 *  - the router of the conversation's classification reads it to verify an invitation's event before it runs a workflow
 *    (`pendingInvitation`, ADR-061 decision 1): by its key, strongly consistent and only the attributes it needs, for the
 *    `invitation-sent` its writer names with the key, and through the sparse index otherwise. It writes nothing.
 *
 * REVOCATION sets `revokedAt` and removes the invitee's membership; a record carrying it is refused by the
 * redemption's own condition (`redeemToken`). A revoked link session's credential lives out its 15
 * minutes, and every channel call it makes is refused once the membership is gone.
 */
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { RedemptionMode } from '../../../lib/config/conversation-types.js';
import type { TokenRecord } from './tokens.js';
import { emitEmfMetric } from './emf-metrics.js';

type Sender = { send(command: unknown): Promise<any> };

/** The sparse index on `Tokens` that lists a conversation's invitations, newest first. Only invitations carry its key. */
export const INVITATIONS_BY_CHANNEL = 'invitationsByChannel';
/** The index's partition key: the conversation an invitation is to. */
export const INVITATION_CHANNEL_ATTRIBUTE = 'invitationChannel';

/** The landing page an invitation's link opens, on the origin of the client `invitationLandingFor` names: the chat app (`frontend/packages/chat/invite.html`). */
export const LANDING_PATH = '/invite.html';

/** What an invitation record carries beside the fields every token record does. */
export interface InvitationFields {
  /** The id the inviter, a moderator and the console name it by. Never the token. */
  invitationId: string;
  /** The AppInstanceUser that issued it. */
  inviterArn: string;
  /** The inviter's display name when it was issued, for the landing page and the email. */
  inviterName: string;
  /** The display name the inviter gave the invitee, which is also the invitee AppInstanceUser's `Name`. */
  inviteeName: string;
  mode: RedemptionMode;
  /** The invited conversation's classification, read from its immutable tag at invite time. */
  classification: string;
  conversationType: string;
  /** The conversation's display name, for the landing page. */
  conversationName: string;
  /** The index key: the conversation's ARN again, carried only by invitations. */
  invitationChannel: string;
  /** Whether the invitation email was sent. */
  emailed?: boolean;
  /**
   * The one line the inviter gave for inviting the person (`invitation:reason`, ADR-060): member text, said only in a
   * message addressed to a person and never deciding anything. Absent when the inviter gave none.
   */
  reason?: string;
  /**
   * The participant role the invitation records (`invitation:role`, DESIGN-CONVERSATION-TYPES section 6.1): a name the
   * conversation's type declares `invitable`, checked when the invitation is made. Absent when the inviter named none.
   */
  participantRole?: string;
}

export type InvitationRecord = TokenRecord & InvitationFields & {
  /** Epoch seconds, set by a revocation. */
  revokedAt?: number;
  /** Who revoked it: the inviter, a moderator, or the console's admin, as an AppInstanceUser ARN or `admin:<id>`. */
  revokedBy?: string;
  /** How it was redeemed, set with `consumedAt`. */
  redeemedVia?: RedemptionMode;
};

/** Where an invitation stands. */
export type InvitationStatus = 'pending' | 'redeemed' | 'expired' | 'revoked';

/**
 * Why a redemption was refused, as the landing page and the chat app show it (D-4). Each is a settled
 * state with localized copy naming the inviter, never a raw error:
 *  - `expired`, `revoked`: the invitation can no longer be used;
 *  - `redeemed`: it was used, by this sign-in or another;
 *  - `redeemed_elsewhere`: a forwarded `link` already used;
 *  - `wrong_account`: a sign-in that already has an account, or one whose clearance does not reach the
 *    conversation. Nothing is bound to it;
 *  - `wrong_mode`: redeemed in a mode it was not issued for;
 *  - `ended`: a link session's 15 minutes are over (the landing page's own state);
 *  - `unknown`: no such invitation (an altered link).
 */
export type InvitationRefusal = 'expired' | 'redeemed' | 'revoked' | 'redeemed_elsewhere' | 'wrong_account' | 'wrong_mode' | 'ended' | 'unknown';

/**
 * A REMINDED INVITATION'S SECOND LINK (ADR-061, `send_nudge`). The store keeps only a token's hash, so a reminder cannot
 * resend the first link; it mints a second token whose record is an alias: the invitation's key (`aliasOf`), its
 * expiry, and the people it names, so offboarding finds it with theirs. It carries no `invitationId` or `mode`, so
 * nothing reads it as an invitation; every redemption path resolves it to the one record (`invitationAliasOf`), which
 * holds the invitation's whole state. Either link redeems until that record is spent, and spending or revoking it ends
 * both.
 */
export interface InvitationAlias {
  pk: string;
  kind: 'invitation';
  aliasOf: string;
  channelArn: string;
  personArn: string;
  inviterArn: string;
  issuer: string;
  redemption: 'single-use';
  expiresAt: number;
  reclaimAt: number;
  createdAt: string;
}

/** The invitation record an alias names, or undefined when the record is not an alias. */
export function invitationAliasOf(r: Record<string, unknown> | null | undefined): string | undefined {
  if (!r || r.kind !== 'invitation' || r.invitationId !== undefined) return undefined;
  const target = r.aliasOf;
  return typeof target === 'string' && target.startsWith('invitation#') && target !== r.pk ? target : undefined;
}

/** The status of a record at `now` (epoch seconds). */
export function invitationStatusOf(r: Pick<InvitationRecord, 'consumedAt' | 'revokedAt' | 'expiresAt'>, now: number): InvitationStatus {
  if (r.revokedAt !== undefined) return 'revoked';
  if (r.consumedAt !== undefined) return 'redeemed';
  if (!(r.expiresAt > now)) return 'expired';
  return 'pending';
}

/** What an inviter, a moderator or the console is shown of one invitation: never its key, never an address. */
export interface InvitationView {
  invitationId: string;
  channelArn: string;
  inviteeArn: string;
  inviteeName: string;
  inviterArn: string;
  inviterName: string;
  mode: RedemptionMode;
  classification: string;
  status: InvitationStatus;
  createdAt: string;
  /** Epoch seconds. */
  expiresAt: number;
  redeemedAt?: number;
  revokedAt?: number;
  revokedBy?: string;
  emailed: boolean;
  /** The participant role the invitation records, when it records one. */
  participantRole?: string;
}

export function invitationViewOf(r: InvitationRecord, now: number): InvitationView {
  return {
    invitationId: r.invitationId,
    channelArn: r.channelArn,
    inviteeArn: r.personArn,
    inviteeName: r.inviteeName,
    inviterArn: r.inviterArn,
    inviterName: r.inviterName,
    mode: r.mode,
    classification: r.classification,
    status: invitationStatusOf(r, now),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.consumedAt !== undefined ? { redeemedAt: r.consumedAt } : {}),
    ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
    ...(r.revokedBy ? { revokedBy: r.revokedBy } : {}),
    emailed: r.emailed === true,
    ...(typeof r.participantRole === 'string' ? { participantRole: r.participantRole } : {}),
  };
}

/** True for a record that is an invitation: the kind, and the fields only an invitation carries. */
export function isInvitationRecord(r: TokenRecord | null | undefined): r is InvitationRecord {
  return !!r && r.kind === 'invitation' && typeof r.invitationId === 'string' && typeof r.inviterArn === 'string'
    && (r.mode === 'sign-in' || r.mode === 'link');
}

/** The refusal a record's state names for a redemption attempt in `mode`, or null when it may be redeemed. */
export function refusalOf(r: InvitationRecord | null, now: number, mode: RedemptionMode): InvitationRefusal | null {
  if (!r) return 'unknown';
  if (r.revokedAt !== undefined) return 'revoked';
  if (r.consumedAt !== undefined) return mode === 'link' ? 'redeemed_elsewhere' : 'redeemed';
  if (!(r.expiresAt > now)) return 'expired';
  if (r.mode !== mode) return 'wrong_mode';
  return null;
}

/** A conversation's invitations, newest first, through the sparse index. At most `limit`. */
export async function listInvitations(doc: Sender, table: string, channelArn: string, limit = 100): Promise<InvitationRecord[]> {
  const out: InvitationRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: INVITATIONS_BY_CHANNEL,
      KeyConditionExpression: '#c = :c',
      ExpressionAttributeNames: { '#c': INVITATION_CHANNEL_ATTRIBUTE },
      ExpressionAttributeValues: { ':c': channelArn },
      ScanIndexForward: false,
      Limit: limit,
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    for (const item of (r?.Items ?? []) as TokenRecord[]) {
      // THE INDEX HOLDS ONLY THIS CONVERSATION'S INVITATIONS; a record that says otherwise is not trusted.
      if (isInvitationRecord(item) && item.channelArn === channelArn) out.push(item);
    }
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < limit);
  return out.slice(0, limit);
}

/**
 * EVERY ONE OF A CONVERSATION'S INVITATIONS, through the sparse index, read to the end of the index however many there
 * are: a path that must reach each one (deleting their deadline schedules) never stops at a page or a count.
 */
export async function everyInvitation(doc: Sender, table: string, channelArn: string): Promise<InvitationRecord[]> {
  const out: InvitationRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: INVITATIONS_BY_CHANNEL,
      KeyConditionExpression: '#c = :c',
      ExpressionAttributeNames: { '#c': INVITATION_CHANNEL_ATTRIBUTE },
      ExpressionAttributeValues: { ':c': channelArn },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    for (const item of (r?.Items ?? []) as TokenRecord[]) {
      if (isInvitationRecord(item) && item.channelArn === channelArn) out.push(item);
    }
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * One of a conversation's invitations by its id, or null: the index read page by page, filtered to the id, until it is
 * found or the index ends, so an invitation is found however many the conversation holds.
 */
export async function findInvitation(doc: Sender, table: string, channelArn: string, invitationId: string): Promise<InvitationRecord | null> {
  if (!invitationId) return null;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: INVITATIONS_BY_CHANNEL,
      KeyConditionExpression: '#c = :c',
      FilterExpression: '#i = :i',
      ExpressionAttributeNames: { '#c': INVITATION_CHANNEL_ATTRIBUTE, '#i': 'invitationId' },
      ExpressionAttributeValues: { ':c': channelArn, ':i': invitationId },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    const hit = ((r?.Items ?? []) as TokenRecord[])
      .find((item) => isInvitationRecord(item) && item.channelArn === channelArn && item.invitationId === invitationId);
    if (hit) return hit as InvitationRecord;
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return null;
}

/**
 * EVERY ONE OF A CONVERSATION'S INVITATIONS NAMING `personArn` AS ITS INVITEE: the index read page by page, filtered to the
 * invitee, to the end of the index, so the answer does not depend on how many invitations the conversation holds.
 */
export async function invitationsNaming(doc: Sender, table: string, channelArn: string, personArn: string): Promise<InvitationRecord[]> {
  if (!personArn) return [];
  const out: InvitationRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: INVITATIONS_BY_CHANNEL,
      KeyConditionExpression: '#c = :c',
      FilterExpression: '#p = :p',
      ExpressionAttributeNames: { '#c': INVITATION_CHANNEL_ATTRIBUTE, '#p': 'personArn' },
      ExpressionAttributeValues: { ':c': channelArn, ':p': personArn },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    for (const item of (r?.Items ?? []) as TokenRecord[]) {
      if (isInvitationRecord(item) && item.channelArn === channelArn && item.personArn === personArn) out.push(item);
    }
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** An invitation record's key: the kind and its token's hash, never a token (`tokenKey`). */
export const INVITATION_KEY = /^invitation#[0-9a-f]{64}$/;

/**
 * THE ATTRIBUTES A ROUTER READS OF AN INVITATION BY ITS KEY: what verifying an invitation's event and running its workflow
 * need, and nothing else of the record. The router's grant names exactly these (`invitationRecordReadStatement`,
 * `token-store.ts`), so a read that asks for more, or for the whole item, is refused at IAM.
 */
export const INVITATION_RECORD_ATTRIBUTES = [
  'pk', 'kind', 'invitationId', 'channelArn', 'personArn', 'inviterArn', 'inviterName', 'inviteeName', 'mode', 'classification',
  'conversationType', 'conversationName', 'reason', 'participantRole', 'expiresAt', 'consumedAt', 'revokedAt',
] as const;

/**
 * AN INVITATION BY ITS KEY, READ STRONGLY CONSISTENT: the record exactly as its writer left it, so one written a moment
 * ago is read, which the eventually consistent sparse index cannot promise. Only `INVITATION_RECORD_ATTRIBUTES` are read.
 */
export async function invitationByKey(doc: Sender, table: string, pk: string): Promise<InvitationRecord | null> {
  if (!INVITATION_KEY.test(pk)) return null;
  const names = Object.fromEntries(INVITATION_RECORD_ATTRIBUTES.map((a, i) => [`#a${i}`, a]));
  const r = await doc.send(new GetCommand({
    TableName: table, Key: { pk }, ConsistentRead: true,
    ProjectionExpression: Object.keys(names).join(', '), ExpressionAttributeNames: names,
  }));
  const item = r?.Item as TokenRecord | undefined;
  return isInvitationRecord(item) ? item : null;
}

/**
 * THE INVITATION AN `invitation-sent` EVENT NAMES, AS ITS RECORD HOLDS IT (ADR-061 decision 1, "verified on arrival"):
 * one of THIS conversation's invitations by its id, of `classification`, and still pending: unredeemed, unrevoked and
 * unexpired. Anything else is refused with why, so a naming for an invitation that does not exist, belongs to another
 * conversation or classification, or no longer matters starts nothing. With the record's key (`key`, which the
 * invitations function names with the event it has just written) the record is read by that key, strongly consistent,
 * so an invitation written a moment ago is never missed; the key decides nothing, because the record it reads must still
 * name this id and this conversation. Without it (a deadline that fires, a hand-back) the record is found through the
 * sparse index, which holds no token, to the end of the index.
 */
export async function pendingInvitation(
  doc: Sender, table: string, channelArn: string, invitationId: string, classification: string, now: number, key?: string,
): Promise<{ record: InvitationRecord } | { refused: 'unknown' | 'another classification' | Exclude<InvitationStatus, 'pending'> }> {
  const found = key ? await invitationByKey(doc, table, key) : await findInvitation(doc, table, channelArn, invitationId);
  const record = found && found.invitationId === invitationId ? found : null;
  if (!record || record.channelArn !== channelArn) return { refused: 'unknown' };
  if (record.classification !== classification) return { refused: 'another classification' };
  const status = invitationStatusOf(record, now);
  return status === 'pending' ? { record } : { refused: status };
}

/**
 * Mark an invitation revoked, once. Returns the revoked record, or null when it was already revoked or is
 * gone. A redeemed one is revoked too: revocation is what removes the invitee from the conversation.
 */
export async function markRevoked(doc: Sender, table: string, pk: string, revokedBy: string, now: number): Promise<InvitationRecord | null> {
  try {
    const r = await doc.send(new UpdateCommand({
      TableName: table,
      Key: { pk },
      UpdateExpression: 'SET revokedAt = :now, revokedBy = :by',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(revokedAt)',
      ExpressionAttributeValues: { ':now': now, ':by': revokedBy },
      ReturnValues: 'ALL_NEW',
    }));
    return (r?.Attributes as InvitationRecord | undefined) ?? null;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/** The link an invitation email carries: the landing page, with the token in the fragment (M-5), which no server receives. */
export function invitationLink(landingOrigin: string, token: string): string {
  return `${landingOrigin.replace(/\/$/, '')}${LANDING_PATH}#t=${encodeURIComponent(token)}`;
}

/**
 * A REFUSED REDEMPTION, COUNTED BY REASON (B8), as an EMF line CloudWatch extracts with no call. Only the
 * refusal: what was sent, redeemed and revoked is on the record itself (tenet D7), and a refusal is on none.
 */
export function invitationMetric(name: 'InvitationRefused', dims: Record<string, string> = {}): void {
  emitEmfMetric({
    namespace: 'AgentEchelon/Invitations',
    metrics: [{ name, unit: 'Count' }],
    dimensionSets: [['Instance', ...Object.keys(dims)]],
    properties: { Instance: process.env.ALERT_INSTANCE || process.env.INSTANCE_NAME || '', ...dims, [name]: 1 },
  });
}
