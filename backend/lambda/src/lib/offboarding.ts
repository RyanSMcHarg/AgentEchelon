/**
 * OFFBOARDING: a person leaves the platform, by AppInstanceUser, whichever issuer signed them in.
 *
 * A person is their AppInstanceUser (README.md:3), and everything the platform keeps about them is keyed
 * by it, so offboarding needs to know nothing about an identity provider except, for this deployment's
 * own pool, to remove the pool account when one exists (ADR-058). There is ONE path:
 *
 *  - the console's delete (`POST /users/delete`, `user-management.ts`) calls `offboardPerson`;
 *  - an issuer event (a Cognito user deleted, recorded by CloudTrail and delivered by EventBridge) calls
 *    `convergeSubject` through `handleLifecycleEvent` (`offboarding-events.ts`), which reads the pool's
 *    CURRENT state and erases a subject the pool no longer holds;
 *  - a low-frequency sweep (`sweepPool`) converges every subject the same way, as the backstop for an
 *    event that was dropped (tenet D6: the event is primary, the sweep is the backstop).
 *
 * ── WHAT IS ERASED, IN THIS ORDER (SPEC-CREDENTIAL-EXCHANGE §5b) ────────────────────────────────────
 *
 *  1. the `-admin` twin, found by its `owner` tag, with its memberships and its app-instance-admin;
 *  1b. FOLLOWING THE UPGRADE TAG (P-11, P-12): in each conversation the person is in that an upgrade opened (a path B claim, or a path A bind's continuation)
 *     (it carries `upgradedFrom`), the visitor's conversation it names loses every message sent by the
 *     person or by the visitor `upgradedFromPerson` names, and the visit's registration record is deleted.
 *     The visitor's conversation and other members' messages remain until it expires;
 *  2. the person's channel memberships;
 *  3. the UserProfile row, the contact copies and the email preferences (`<personId>#notices`), the
 *     UserTasks partition (`principalId`) and the rows they own in another's (`ownerPersonId`), the task
 *     records naming them (`agentTaskFilter`), the turn-state stop records
 *     (`stop#<channel>#<personId>#<responder>`), their entries in each conversation's member identity lookup
 *     and an onboarding intake that is theirs (the conversation context row), their name on a conversation's
 *     battle setting (`enabledBy`, `battle` only) and the per-person budget rows (`budget#user#<personId>#`);
 *  4. the `attachments/<conversationId>/<personId>/` objects, every version;
 *  4a. in Aurora mode, the person's own rows in the projection, through the data plane's `erasePerson`
 *     (`analytics-aurora/person-erasure.ts`);
 *  4b. the person's connector grants (K3), when a declared connector takes them: each revoked at the
 *     vendor and then deleted, through the Connectors stack's revoker. A revocation the vendor does not
 *     confirm is retried there, left `revoke-failed` for its daily sweep and counted in the `offboarding`
 *     event (`connectorGrantsRevokeFailed`), so the erasure never waits on a vendor;
 *  4c. the person's own tokens in `Tokens` (`reply`, `unsubscribe`, a path B `claim` and every `invitation` they
 *     issued or are named by, `PERSON_TOKEN_KINDS`), so no reply address, preference link or claim outlives them
 *     and no invitation they issued can still be redeemed;
 *  5. each `Identities` row, replaced in the same transaction by a `revoked` marker that holds a hash of
 *     the subject and nothing else, so the subject is refused at its next sign-in and never re-minted;
 *  6. the AppInstanceUser;
 *  7. for this deployment's pool only, and only when the account exists: `AdminUserGlobalSignOut`, then
 *     `AdminDeleteUser`.
 *
 * Every step is idempotent, and a step that fails stops the run before the identity is touched, so a
 * retry starts where the last one stopped. Nothing to remove is `found: false` (the route's 404).
 *
 * ── WHAT IS KEPT ────────────────────────────────────────────────────────────────────────────────────
 *
 * Battle votes, thumbs feedback and the conversation archive stay, still carrying the AppInstanceUser
 * id, so tallies and quality signals do not move when a person leaves (`OFFBOARDING_KEPT`). Whether a
 * deletion also reaches them is the deployment's policy (Q9); nothing here redacts them.
 *
 * ── A DISABLE IS NOT AN OFFBOARDING ─────────────────────────────────────────────────────────────────
 *
 * Nothing here acts on a subject disabled at its issuer, and its `Identities` row is left as it is: the
 * table keeps no copy of the identity provider's state. The credential exchange asks the issuer at every
 * vend and refuses a disabled or gone account (`Directory.accountState`, SPEC-CREDENTIAL-EXCHANGE §4b);
 * `Directory.contactFor` answers no address for a disabled pool account, so no notice is sent and their
 * reply tokens are refused (`lib/reply-tokens.ts`); a pending invitation they issued is refused because a
 * redemption requires a sign-in of its inviter's to be active at its issuer (`lib/invitation-redemption.ts`).
 * Re-enabling the account restores all three. A session vended before the disable lasts at most its own
 * lifetime (one hour).
 *
 * ── RECORDS ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Each completed offboarding appends ONE `offboarding` event to the archive, with the actor and subject
 * AppInstanceUser ARNs and the count removed from each store. Each `Identities` change writes an access
 * log record. No email address or username appears in either, or in any log line here.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DeleteAppInstanceAdminCommand,
  DeleteAppInstanceUserCommand,
  DescribeAppInstanceUserCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import {
  DeleteChannelMembershipCommand,
  DeleteChannelMessageCommand,
  ListChannelMembershipsForAppInstanceUserCommand,
  ListTagsForResourceCommand as ListChannelTagsCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { registrationKeyOf, UPGRADE_SOURCE_PERSON_TAG, UPGRADE_SOURCE_TAG } from './upgrade.js';
import { everyChannelMessage } from './chime/history.js';
import { DeleteObjectsCommand, ListObjectsV2Command, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { AdminDeleteUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  ADMIN_TWIN_OWNER_TAG,
  adminTwinIdFor,
  adminTwinOwnerId,
  appInstanceArnOf,
  personIdFromArn,
  userArnFor,
} from './person-arn.js';
import {
  IDENTITIES_BY_PERSON,
  issuerSubjectKey,
  parseIssuerSubjectKey,
  revokedMarkerKey,
  type IdentityRow,
} from './person-identity.js';
import type { CognitoPoolDirectory } from './cognito-pool-directory.js';
import { poolAdapter } from './issuer-seams.js';
import { eraseContactCopies } from './claims-directory.js';
import { eraseNoticePreferences } from './notice-preferences.js';
import { issuerIdOf, trustedIssuers } from './trusted-issuers.js';
import { recordAccess, type AccessAuditLine } from './access-log.js';
import { appendServerEvent, eraseFromProjection } from './event-archive.js';
import { mapBounded } from './bounded-map.js';
import { hourKeyAt, userBudgetKey } from './abuse-control-keys.js';
import { appInstanceAdminBearer, chimeIdentityClient, chimeMessagingClient } from './chime/clients.js';

type Sender = { send(command: unknown): Promise<any> };

/** What offboarding keeps, by name. Stated by the console (tenet D11) and recorded in the event. */
export const OFFBOARDING_KEPT = ['battle_votes', 'feedback', 'archive'] as const;

/** The stores offboarding removes from, in the order it removes them. */
export const OFFBOARDED_STORES = [
  'adminTwin',
  'upgradeSources',
  'memberships',
  'userProfile',
  'contactCopies',
  'noticePreferences',
  'userTasks',
  'agentTasks',
  'turnState',
  'channelContext',
  'battleConfig',
  'budgetRows',
  'attachments',
  'auroraProjection',
  'connectorGrants',
  'personTokens',
  'identities',
  'appInstanceUser',
  'poolAccount',
] as const;
export type OffboardedStore = (typeof OFFBOARDED_STORES)[number];
export type RemovedCounts = Record<OffboardedStore, number>;

/** The tables and bucket a person's records live in. A store this deployment has not deployed is absent. */
export interface PersonStores {
  userProfile?: string;
  userTasks?: string;
  /** The task records (`taskId`, `channelArn`), naming the person who asked, owns or is assigned the work. */
  agentTasks?: string;
  turnState?: string;
  /** A conversation's server-only context: the member identity lookup and an onboarding intake. */
  channelContext?: string;
  /** `battle` only: a conversation's battle setting, naming who enabled it (`enabledBy`). */
  battleConfig?: string;
  abuseControls?: string;
  attachmentsBucket?: string;
  /** The token store (A8): the person's email and claim tokens, and a path B registration record. */
  tokens?: string;
}

/** The token kinds bound to a person that offboarding deletes with them: each names the person it was minted for. */
export const PERSON_TOKEN_KINDS = ['reply', 'unsubscribe', 'claim', 'invitation'] as const;

export interface OffboardingDeps {
  doc: Sender;
  chime: Sender;
  messaging: Sender;
  s3: Sender;
  cognito: Sender;
  identitiesTable: string;
  appInstanceArn: string;
  /** This deployment's own pool: the one whose accounts offboarding deletes. */
  primary: CognitoPoolDirectory;
  /** Other pools whose lifecycle events this deployment acts on. Their accounts are never deleted here. */
  others?: CognitoPoolDirectory[];
  /** The app-instance admin the membership removals bear. */
  adminBearer(): Promise<string | null>;
  stores(): Promise<PersonStores>;
  /**
   * The person's connector grants (K3), revoked at each vendor and deleted, when this deployment declares a
   * connector that takes them; absent otherwise. Throws when the revoker could not be reached at all.
   */
  connectorGrants?(personId: string): Promise<{ revoked: number; failed: number }>;
  /**
   * The person's own rows in the Aurora projection, erased through the data plane (`erasePerson`), in Aurora
   * mode; null where the deployment keeps no projection (Athena mode). Throws when the erasure failed.
   */
  auroraProjection?(personId: string): Promise<number | null>;
  /** Append the `offboarding` event to the archive. Throws when it was not delivered. */
  archive(event: { personId: string; properties: Record<string, string | number | boolean> }): Promise<void>;
  /** Write one access-log record for an `Identities` change. */
  audit(line: AccessAuditLine): Promise<unknown>;
  now?(): Date;
}

/** Who caused an offboarding change. Never an address or a username. */
export interface OffboardingActor {
  /** The acting person's AppInstanceUser ARN, or a fixed label for the platform (`issuer-event`, `sweep`). */
  arn: string;
}

export interface OffboardingResult {
  /** False when there was nothing to remove: the route answers 404. */
  found: boolean;
  removed: RemovedCounts;
  kept: readonly string[];
  /** False when the `offboarding` event could not be archived; the erasure itself completed. */
  archived: boolean;
}

/** Raised when a step failed before the identity was touched. A retry continues from where it stopped. */
export class OffboardingIncomplete extends Error {
  readonly code = 'OFFBOARDING_INCOMPLETE';
  constructor(readonly step: OffboardedStore, cause: unknown) {
    super(`offboarding stopped at ${step}: ${(cause as Error)?.name || 'error'}`);
    this.name = 'OffboardingIncomplete';
  }
}

const zero = (): RemovedCounts =>
  Object.fromEntries(OFFBOARDED_STORES.map((s) => [s, 0])) as RemovedCounts;

const nameOf = (err: unknown): string => (err as { name?: string })?.name || '';

// ── THE ROWS ────────────────────────────────────────────────────────────────────────────────────

/** Every `Identities` row that signs in as `personArn`, whatever its status. A marker is never on the index. */
export async function rowsOfPerson(personArn: string, deps: Pick<OffboardingDeps, 'doc' | 'identitiesTable'>): Promise<IdentityRow[]> {
  const out: IdentityRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await deps.doc.send(new QueryCommand({
      TableName: deps.identitiesTable,
      IndexName: IDENTITIES_BY_PERSON,
      KeyConditionExpression: 'personArn = :p',
      ExpressionAttributeValues: { ':p': personArn },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    for (const item of (r?.Items || []) as IdentityRow[]) if (parseIssuerSubjectKey(item.issuerSubject)) out.push(item);
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * Every registry id whose people are accounts in `pool`: its own entry and each `cognito-federated` entry
 * on it (SPEC-CREDENTIAL-EXCHANGE §4b). A pool the registry does not list answers its own `issuer` alone.
 */
export function poolIssuerIds(pool: Pick<CognitoPoolDirectory, 'issuer'> & { issuers?: string[] }): string[] {
  return pool.issuers?.length ? pool.issuers : [pool.issuer];
}

/** A pool subject's row under whichever of the pool's issuers holds it, or null. */
export async function rowOfPoolSubject(pool: Pick<CognitoPoolDirectory, 'issuer'> & { issuers?: string[] }, subject: string, deps: Pick<OffboardingDeps, 'doc' | 'identitiesTable'>): Promise<IdentityRow | null> {
  // In parallel, and the first in the pool's issuer order wins: a sweep asks this for every account.
  const rows = await Promise.all(poolIssuerIds(pool).map((issuer) => rowOfSubject(issuer, subject, deps)));
  return rows.find((row) => row) ?? null;
}

/** The pool issuer whose revoked marker a subject carries, or null when none does. */
export async function revokedPoolIssuer(pool: Pick<CognitoPoolDirectory, 'issuer'> & { issuers?: string[] }, subject: string, deps: Pick<OffboardingDeps, 'doc' | 'identitiesTable'>): Promise<string | null> {
  const ids = poolIssuerIds(pool);
  const revoked = await Promise.all(ids.map((issuer) => isRevoked(issuer, subject, deps)));
  return ids.find((_, n) => revoked[n]) ?? null;
}

/** The row for one subject, whatever its status, or null. */
export async function rowOfSubject(issuer: string, subject: string, deps: Pick<OffboardingDeps, 'doc' | 'identitiesTable'>): Promise<IdentityRow | null> {
  const r = await deps.doc.send(new GetCommand({
    TableName: deps.identitiesTable, Key: { issuerSubject: issuerSubjectKey(issuer, subject) }, ConsistentRead: true,
  }));
  return (r?.Item as IdentityRow | undefined) ?? null;
}

/** Whether this subject was offboarded and has not been re-admitted. */
export async function isRevoked(issuer: string, subject: string, deps: Pick<OffboardingDeps, 'doc' | 'identitiesTable'>): Promise<boolean> {
  const r = await deps.doc.send(new GetCommand({
    TableName: deps.identitiesTable, Key: { issuerSubject: revokedMarkerKey(issuer, subject) }, ConsistentRead: true,
  }));
  return !!r?.Item;
}

async function auditIdentityChange(event: string, row: { issuer: string; personArn?: string }, actor: OffboardingActor, deps: OffboardingDeps): Promise<void> {
  const line: AccessAuditLine = {
    _auditEvent: event,
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
    // The access log is read by actor; a platform actor is recorded under its label.
    personId: personIdFromArn(actor.arn) || actor.arn,
    actorArn: actor.arn,
    issuer: row.issuer,
    ...(row.personArn ? { personArn: row.personArn } : {}),
  };
  console.log(JSON.stringify(line));
  try {
    await deps.audit(line);
  } catch (err) {
    console.error('[Offboarding][SecurityEvent] an Identities change could not be written to the access log', {
      event, personArn: row.personArn, err: nameOf(err),
    });
  }
}

// ── RE-ADMIT ────────────────────────────────────────────────────────────────────────────────────

/** Delete the subject's `revoked` marker, so their next sign-in is a first one. False when there was none. */
export async function readmitSubject(issuer: string, subject: string, actor: OffboardingActor, deps: OffboardingDeps): Promise<boolean> {
  const r = await deps.doc.send(new DeleteCommand({
    TableName: deps.identitiesTable,
    Key: { issuerSubject: revokedMarkerKey(issuer, subject) },
    ReturnValues: 'ALL_OLD',
  }));
  if (!r?.Attributes) return false;
  await auditIdentityChange('identity_readmitted', { issuer }, actor, deps);
  return true;
}

// ── THE ERASURE ─────────────────────────────────────────────────────────────────────────────────

export async function exists(chime: Sender, arn: string): Promise<boolean> {
  try {
    await chime.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: arn }));
    return true;
  } catch (err) {
    if (nameOf(err) === 'NotFoundException') return false;
    throw err;
  }
}

/**
 * Whether the twin exists and belongs to `ownerArn`. A twin's id is derived from its owner's, and the
 * exchange stamps the `owner` tag on every console session; a twin carrying no tag predates the tag and
 * is its owner's by its id. A tag naming anybody else is never removed here.
 */
export async function twinOf(chime: Sender, twinArn: string, ownerArn: string, controlArn: string = ownerArn): Promise<boolean> {
  // WHETHER THE TWIN EXISTS FIRST. Amazon Chime SDK answers ForbiddenException, not NotFoundException, to
  // DescribeAppInstanceUser and ListTagsForResource on an AppInstanceUser that does not exist - to an
  // administrator as well (measured, 2026-10-21) - so "absent" and "denied" arrive as the same error. The
  // OWNER tells them apart: they exist, so a Forbidden on the twin while the owner reads is an absent twin,
  // and a Forbidden on both is a denial, which throws. Read as "no twin", a denial would leave a twin
  // behind at erasure.
  try {
    if (!(await exists(chime, twinArn))) return false;
  } catch (err) {
    if (nameOf(err) !== 'ForbiddenException') throw err;
    // The control is the owner, or, once the owner is already gone, the person known to exist instead.
    if (await exists(chime, controlArn)) return false;
    throw err;
  }
  let tags: Array<{ Key?: string; Value?: string }>;
  try {
    tags = (await chime.send(new ListTagsForResourceCommand({ ResourceARN: twinArn })))?.Tags || [];
  } catch (err) {
    if (nameOf(err) === 'NotFoundException') return false;
    throw err;
  }
  const owner = tags.find((t) => t.Key === ADMIN_TWIN_OWNER_TAG)?.Value;
  if (owner && owner !== ownerArn) {
    console.error('[Offboarding][SecurityEvent] an admin twin names another owner; it is kept', { twinArn });
    return false;
  }
  return true;
}

/** Every channel the AppInstanceUser is a member of. */
export async function channelsOf(userArn: string, bearer: string, deps: OffboardingDeps): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await deps.messaging.send(new ListChannelMembershipsForAppInstanceUserCommand({
      AppInstanceUserArn: userArn, ChimeBearer: bearer, MaxResults: 50, NextToken,
    }));
    for (const m of page?.ChannelMemberships || []) if (m.ChannelSummary?.ChannelArn) out.push(m.ChannelSummary.ChannelArn);
    NextToken = page?.NextToken;
  } while (NextToken);
  return out;
}

/**
 * ERASURE FOLLOWS THE UPGRADE TAG (P-11, P-12). For each conversation of the person's that a claim or a bind opened, the
 * messages the person or the visitor sent in the visitor's conversation are deleted, and the visit's
 * registration record with them. The tags are read, never Metadata: only the creator's role writes them.
 * A visitor's conversation already gone (it expires a day after its last message) has nothing to remove.
 * Returns how many messages were removed.
 */
async function followUpgradeTags(personArn: string, deps: OffboardingDeps, stores: PersonStores): Promise<number> {
  const bearer = await deps.adminBearer();
  if (!bearer) throw new Error('no app-instance admin to bear the upgrade-source removals');
  let removed = 0;
  for (const channelArn of await channelsOf(personArn, bearer, deps)) {
    const tags = (await deps.messaging.send(new ListChannelTagsCommand({ ResourceARN: channelArn })))?.Tags as Array<{ Key?: string; Value?: string }> | undefined;
    const source = tags?.find((t) => t.Key === UPGRADE_SOURCE_TAG)?.Value;
    if (!source || appInstanceArnOf(source) !== deps.appInstanceArn) continue;
    const visitor = tags?.find((t) => t.Key === UPGRADE_SOURCE_PERSON_TAG)?.Value;
    const senders = new Set([personArn, ...(visitor ? [visitor] : [])]);
    try {
      for (const m of await everyChannelMessage(deps.messaging, source, bearer)) {
        if (!m.MessageId || !senders.has(m.Sender?.Arn ?? '')) continue;
        try {
          await deps.messaging.send(new DeleteChannelMessageCommand({ ChannelArn: source, MessageId: m.MessageId, ChimeBearer: bearer }));
          removed++;
        } catch (err) {
          if (nameOf(err) !== 'NotFoundException') throw err;
        }
      }
    } catch (err) {
      if (nameOf(err) !== 'NotFoundException') throw err;
    }
    if (stores.tokens) {
      await deps.doc.send(new DeleteCommand({ TableName: stores.tokens, Key: { pk: registrationKeyOf(source) } }));
    }
  }
  return removed;
}

async function removeMemberships(userArn: string, deps: OffboardingDeps): Promise<number> {
  const bearer = await deps.adminBearer();
  if (!bearer) throw new Error('no app-instance admin to bear the membership removals');
  let removed = 0;
  let NextToken: string | undefined;
  do {
    const page = await deps.messaging.send(new ListChannelMembershipsForAppInstanceUserCommand({
      AppInstanceUserArn: userArn, ChimeBearer: bearer, MaxResults: 50, NextToken,
    }));
    for (const m of page?.ChannelMemberships || []) {
      const ChannelArn = m.ChannelSummary?.ChannelArn;
      if (!ChannelArn) continue;
      try {
        await deps.messaging.send(new DeleteChannelMembershipCommand({ ChannelArn, MemberArn: userArn, ChimeBearer: bearer }));
        removed++;
      } catch (err) {
        if (nameOf(err) !== 'NotFoundException') throw err;
      }
    }
    NextToken = page?.NextToken;
  } while (NextToken);
  return removed;
}

/** How many deletes or listings one offboarding keeps in flight against one store. */
const STORE_CONCURRENCY = 8;

async function deleteAll(doc: Sender, table: string, keys: Array<Record<string, unknown>>): Promise<number> {
  await mapBounded(keys, STORE_CONCURRENCY, (Key) => doc.send(new DeleteCommand({ TableName: table, Key })));
  return keys.length;
}

/**
 * HOW FAR BACK A PERSON'S BUDGET ROW CAN STILL BE PRESENT. A row is keyed on its hour and expires
 * `BUDGET_TTL_SECONDS` after its first write, but DynamoDB removes an expired item only some time after
 * it expires (typically within a few days), and until then it is still readable. Seven days of hours
 * covers that sweep with margin.
 */
export const BUDGET_ROW_HORIZON_HOURS = 7 * 24;

/**
 * The person's budget rows, BY KEY: one per hour of the horizon (`userBudgetKey`, the writer's own key).
 * The person is in the key, so no scan of the table is needed. Returns how many rows existed.
 */
async function removeBudgetRows(doc: Sender, table: string, personId: string, now: Date): Promise<number> {
  const hours = Array.from({ length: BUDGET_ROW_HORIZON_HOURS + 1 }, (_, h) => hourKeyAt(new Date(now.getTime() - h * 3_600_000)));
  const existed = await mapBounded(hours, STORE_CONCURRENCY, async (hour) => {
    const r = await doc.send(new DeleteCommand({ TableName: table, Key: { pk: userBudgetKey(personId, hour) }, ReturnValues: 'ALL_OLD' }));
    return r?.Attributes ? 1 : 0;
  });
  return existed.reduce((a: number, b: number) => a + b, 0);
}

async function queryKeys(doc: Sender, input: Record<string, unknown>, keyOf: (item: any) => Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const keys: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({ ...input, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) } as never));
    for (const item of r?.Items || []) keys.push(keyOf(item));
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return keys;
}

/** The user-task mirror's index of the rows a person owns, whoever holds them (`conversations-stack.ts`). */
export const USER_TASKS_BY_OWNER = 'ownerPersonId-index';

/** The person's user-task mirror rows: their own partition, and the rows they own in another's. */
export async function userTaskKeys(doc: Sender, table: string, personId: string): Promise<Array<Record<string, unknown>>> {
  const keyOf = (i: any) => ({ principalId: i.principalId, taskId: i.taskId });
  const values = { ':p': personId };
  const [held, owned] = await Promise.all([
    queryKeys(doc, { TableName: table, KeyConditionExpression: 'principalId = :p', ExpressionAttributeValues: values, ProjectionExpression: 'principalId, taskId' }, keyOf),
    queryKeys(doc, { TableName: table, IndexName: USER_TASKS_BY_OWNER, KeyConditionExpression: 'ownerPersonId = :p', ExpressionAttributeValues: values, ProjectionExpression: 'principalId, taskId' }, keyOf),
  ]);
  const seen = new Map<string, Record<string, unknown>>();
  for (const k of [...held, ...owned]) seen.set(`${k.principalId}#${k.taskId}`, k);
  return [...seen.values()];
}

async function scanItems(doc: Sender, input: Record<string, unknown>): Promise<Array<Record<string, any>>> {
  const items: Array<Record<string, any>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new ScanCommand({ ...input, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) } as never));
    items.push(...(r?.Items || []));
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function scanKeys(doc: Sender, input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  return (await scanItems(doc, { ...input, ProjectionExpression: 'pk' })).map((item) => ({ pk: item.pk }));
}

/**
 * THE TASK RECORDS THAT NAME THE PERSON, in every field a task names a person by: who asked (`userArn`), who
 * owns it (`ownerPersonId`, or `ownerId` of type `user`) and who it is assigned to (`assigneePersonId`, or
 * `assigneeId` of type `user`). Shared with the export, so the two read the same rows.
 */
export function agentTaskFilter(personArn: string, personId: string): Record<string, unknown> {
  return {
    FilterExpression: 'userArn = :arn OR ownerPersonId = :p OR assigneePersonId = :p'
      + ' OR (ownerType = :user AND ownerId = :p) OR (assigneeType = :user AND assigneeId = :p)',
    ExpressionAttributeValues: { ':arn': personArn, ':p': personId, ':user': 'user' },
  };
}

/** One entry of a conversation's member identity lookup (`memberIdentities`, lib/channel-context-client.ts). */
export interface MemberIdentityEntry { sub?: unknown; iss?: unknown; role?: unknown }

/**
 * Whether a member identity entry names the person: its issuer and subject are one of the person's
 * `Identities` rows (the issuer named by registry id or `iss`, `issuerIdOf`), or it carries no issuer and its
 * subject is the person's id.
 */
export function memberIdentityNamesPerson(
  entry: MemberIdentityEntry, personId: string, subjects: Array<{ issuer: string; subject: string }>,
): boolean {
  if (!entry || typeof entry.sub !== 'string' || !entry.sub) return false;
  if (typeof entry.iss !== 'string' || !entry.iss) return entry.sub === personId;
  const issuer = issuerIdOf(entry.iss);
  return !!issuer && subjects.some((s) => s.issuer === issuer && s.subject === entry.sub);
}

/** The filter that finds a conversation context row which may name the person. */
export function channelContextFilter(personId: string): Record<string, unknown> {
  return {
    FilterExpression: 'attribute_exists(#m) OR #i.#s = :p',
    ExpressionAttributeNames: { '#m': 'memberIdentities', '#i': 'onboardingIntake', '#s': 'subject' },
    ExpressionAttributeValues: { ':p': personId },
  };
}

/**
 * Remove the person from one conversation's context row: their entries in the member identity lookup, and
 * an onboarding intake that is theirs. Conditioned on the row being as it was read, because a host can add a
 * member concurrently; a row that changed is read again, a bounded number of times. Returns how many entries
 * (and intakes) were removed.
 */
async function eraseFromChannelContext(
  doc: Sender, table: string, first: Record<string, any>, personId: string, subjects: Array<{ issuer: string; subject: string }>,
): Promise<number> {
  let item: Record<string, any> | undefined = first;
  for (let attempt = 0; attempt < 3 && item; attempt++) {
    const list: MemberIdentityEntry[] = Array.isArray(item.memberIdentities) ? item.memberIdentities : [];
    const kept = list.filter((e) => !memberIdentityNamesPerson(e, personId, subjects));
    const dropped = list.length - kept.length;
    const intake = item.onboardingIntake?.subject === personId;
    if (!dropped && !intake) return 0;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const conditions: string[] = [];
    const clauses: string[] = [];
    if (dropped) {
      names['#m'] = 'memberIdentities';
      values[':kept'] = kept;
      values[':read'] = list;
      clauses.push('SET #m = :kept');
      conditions.push('#m = :read');
    }
    if (intake) {
      names['#i'] = 'onboardingIntake';
      names['#s'] = 'subject';
      values[':p'] = personId;
      clauses.push('REMOVE #i');
      conditions.push('#i.#s = :p');
    }
    try {
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: item.channelArn },
        UpdateExpression: clauses.join(' '),
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
      return dropped + (intake ? 1 : 0);
    } catch (err) {
      if (nameOf(err) !== 'ConditionalCheckFailedException') throw err;
      item = (await doc.send(new GetCommand({ TableName: table, Key: { channelArn: item.channelArn }, ConsistentRead: true })))?.Item;
    }
  }
  if (!item) return 0;
  throw new Error('a conversation context row kept changing while the person was removed from it');
}

/** Remove the person who enabled a conversation's battle setting from it; the setting itself is the conversation's. */
async function eraseBattleEnabler(doc: Sender, table: string, personArn: string): Promise<number> {
  const rows = await scanItems(doc, {
    TableName: table,
    FilterExpression: 'enabledBy = :arn',
    ExpressionAttributeValues: { ':arn': personArn },
    ProjectionExpression: 'channelArn',
  });
  const changed = await mapBounded(rows, STORE_CONCURRENCY, async (row) => {
    try {
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: { channelArn: row.channelArn },
        UpdateExpression: 'REMOVE enabledBy',
        ConditionExpression: 'enabledBy = :arn',
        ExpressionAttributeValues: { ':arn': personArn },
      }));
      return 1;
    } catch (err) {
      if (nameOf(err) === 'ConditionalCheckFailedException') return 0;
      throw err;
    }
  });
  return changed.reduce((a: number, b: number) => a + b, 0);
}

/**
 * Every version of every object under `attachments/<conversation>/<personId>/`, removed. Returns the keys removed.
 *
 * THE COST GROWS WITH THE BUCKET'S CONVERSATIONS, NOT WITH THE PERSON'S, and it cannot be bounded per
 * person without changing the key layout (tenet D15): the person is the second segment, so S3 has no
 * listing of one person's objects across conversations, and the rooms they are a member of now do not
 * name the rooms they have left. So every conversation prefix is listed once, and each conversation's
 * versions under the person are listed and deleted with `STORE_CONCURRENCY` in flight rather than one
 * after another. It is safe to retry: a step that fails throws before any identity is removed, and a
 * re-run lists only what is still there, so the retry continues where the failed run stopped.
 */
async function removeAttachments(s3: Sender, bucket: string, personId: string): Promise<number> {
  const conversations: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'attachments/', Delimiter: '/', ContinuationToken }));
    for (const p of page?.CommonPrefixes || []) if (p.Prefix) conversations.push(p.Prefix);
    ContinuationToken = page?.NextContinuationToken;
  } while (ContinuationToken);

  const keys = new Set<string>();
  await mapBounded(conversations, STORE_CONCURRENCY, async (conversation) => {
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const page = await s3.send(new ListObjectVersionsCommand({
        Bucket: bucket, Prefix: `${conversation}${personId}/`, KeyMarker, VersionIdMarker,
      }));
      const objects = [...(page?.Versions || []), ...(page?.DeleteMarkers || [])]
        .filter((v: { Key?: string }) => v.Key)
        .map((v: { Key: string; VersionId?: string }) => ({ Key: v.Key, ...(v.VersionId ? { VersionId: v.VersionId } : {}) }));
      for (let i = 0; i < objects.length; i += 1000) {
        const batch = objects.slice(i, i + 1000);
        const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
        if (res?.Errors?.length) throw new Error(`${res.Errors.length} attachment objects could not be deleted`);
        for (const o of batch) keys.add(o.Key);
      }
      KeyMarker = page?.IsTruncated ? page?.NextKeyMarker : undefined;
      VersionIdMarker = page?.IsTruncated ? page?.NextVersionIdMarker : undefined;
    } while (KeyMarker);
  });
  return keys.size;
}

async function step<T>(name: OffboardedStore, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error('[Offboarding] a step failed; nothing about the identity was removed', { step: name, err: nameOf(err) || String(err) });
    throw new OffboardingIncomplete(name, err);
  }
}

/** Remove a pool account: sign every session out, then delete it. False when the account was already gone. */
async function deletePoolAccount(deps: OffboardingDeps, username: string): Promise<boolean> {
  const poolId = deps.primary.poolId;
  try {
    await deps.cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: username }));
    await deps.cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username }));
    return true;
  } catch (err) {
    if (nameOf(err) === 'UserNotFoundException') return false;
    throw err;
  }
}

/**
 * Whether the person exists, telling an absent person from a denied read. Amazon Chime SDK answers
 * ForbiddenException to DescribeAppInstanceUser on a user that does not exist (see `twinOf`), so an
 * offboarding repeated on someone already removed would otherwise fail rather than answer 404. The ACTOR
 * is the control: a person of this app instance who exists, so a Forbidden on the subject while the actor
 * reads is an absent subject, and a Forbidden on both, or an actor that is not a person here, throws.
 */
async function personExistsOrAbsent(chime: Sender, personArn: string, actorArn: string | undefined, appInstanceArn: string): Promise<boolean> {
  try {
    return await exists(chime, personArn);
  } catch (err) {
    if (nameOf(err) !== 'ForbiddenException') throw err;
    if (!actorArn || actorArn === personArn || appInstanceArnOf(actorArn) !== appInstanceArn) throw err;
    if (await exists(chime, actorArn)) return false;
    throw err;
  }
}

/** Offboard one AppInstanceUser. Nothing to remove is `found: false`. */
export async function offboardPerson(personArn: string, actor: OffboardingActor, deps: OffboardingDeps): Promise<OffboardingResult> {
  const personId = personIdFromArn(personArn);
  if (!personId || appInstanceArnOf(personArn) !== deps.appInstanceArn || adminTwinOwnerId(personId)) {
    throw new Error('offboarding: not a person of this app instance');
  }
  const removed = zero();
  const kept = [...OFFBOARDING_KEPT];

  const rows = await rowsOfPerson(personArn, deps);
  const personExists = await personExistsOrAbsent(deps.chime, personArn, actor.arn, deps.appInstanceArn);
  const twinArn = userArnFor(deps.appInstanceArn, adminTwinIdFor(personId));
  const twin = await twinOf(deps.chime, twinArn, personArn, personExists ? personArn : actor.arn);
  if (!personExists && rows.length === 0 && !twin) return { found: false, removed, kept, archived: false };

  // 1. THE ADMIN TWIN.
  if (twin) {
    await step('adminTwin', async () => {
      removed.memberships += await removeMemberships(twinArn, deps);
      try {
        await deps.chime.send(new DeleteAppInstanceAdminCommand({ AppInstanceArn: deps.appInstanceArn, AppInstanceAdminArn: twinArn }));
      } catch (err) {
        if (nameOf(err) !== 'NotFoundException') throw err;
      }
      try {
        await deps.chime.send(new DeleteAppInstanceUserCommand({ AppInstanceUserArn: twinArn }));
        removed.adminTwin = 1;
      } catch (err) {
        if (nameOf(err) !== 'NotFoundException') throw err;
      }
    });
  }

  const stores = await step('userProfile', () => deps.stores());

  // 1b. FOLLOW THE UPGRADE TAG, while the person's memberships still name the conversations that carry it.
  if (personExists) removed.upgradeSources = await step('upgradeSources', () => followUpgradeTags(personArn, deps, stores));

  // 2. MEMBERSHIPS, while the AppInstanceUser still exists to be listed.
  if (personExists) removed.memberships += await step('memberships', () => removeMemberships(personArn, deps));

  // 3. THE PERSON'S RECORDS.
  if (stores.userProfile) {
    removed.userProfile = await step('userProfile', async () => {
      const r = await deps.doc.send(new DeleteCommand({ TableName: stores.userProfile, Key: { personId }, ReturnValues: 'ALL_OLD' }));
      return r?.Attributes ? 1 : 0;
    });
    // THE CONTACT COPIES (C5): one per issuer the person signed in through whose directory is the claims
    // copy, and every claims issuer the registry declares, so a copy outlives no row it came from.
    const issuerIds = [...rows.map((row) => row.issuer), ...trustedIssuers().filter((t) => t.directory === 'claims').map((t) => t.id)];
    removed.contactCopies = await step('contactCopies', () => eraseContactCopies(personId, issuerIds, deps.doc, stores.userProfile!));
    removed.noticePreferences = await step('noticePreferences', () => eraseNoticePreferences(deps.doc, stores.userProfile!, personId));
  }
  if (stores.userTasks) {
    // THE PERSON'S PARTITION, AND THE ROWS THEY OWN IN AN ASSISTANT'S: while an assistant works on the
    // person's task its mirror row sits in the assistant's partition, carrying the person as `ownerPersonId`.
    removed.userTasks = await step('userTasks', async () => deleteAll(deps.doc, stores.userTasks!, await userTaskKeys(deps.doc, stores.userTasks!, personId)));
  }
  // THE TASK RECORDS. A SCAN, as for the stop records: a task is keyed by its id and conversation, and the
  // person is one of several attributes (`agentTaskFilter`). The table's records expire on their `ttl`.
  if (stores.agentTasks) {
    removed.agentTasks = await step('agentTasks', async () => deleteAll(deps.doc, stores.agentTasks!, (await scanItems(deps.doc, {
      TableName: stores.agentTasks,
      ...agentTaskFilter(personArn, personId),
      ProjectionExpression: 'taskId, channelArn',
    })).map((i) => ({ taskId: i.taskId, channelArn: i.channelArn }))));
  }
  // A SCAN, AND IT STAYS ONE: a stop marker is `stop#<channel>#<person>#<assistant>`, so the person is not
  // a key prefix and the rooms they stopped work in include rooms they have left. The markers expire on the
  // table's TTL a few minutes after they are written (`STOP_MARKER_TTL_SECONDS`, lib/turn-lock.ts), so the
  // erasure removes what has not been reclaimed yet. Its cost is the turn-state table's size.
  if (stores.turnState) {
    removed.turnState = await step('turnState', async () => deleteAll(deps.doc, stores.turnState!, await scanKeys(deps.doc, {
      TableName: stores.turnState,
      FilterExpression: 'begins_with(pk, :stop) AND contains(pk, :person)',
      ExpressionAttributeValues: { ':stop': 'stop#', ':person': `#${personId}#` },
    })));
  }
  // THE CONVERSATION CONTEXT ROWS, by a scan for the same reason: a row is keyed by conversation, and the
  // conversations the person is in now do not name the ones they have left.
  if (stores.channelContext) {
    const subjects = rows.map((r) => parseIssuerSubjectKey(r.issuerSubject)).filter(Boolean) as Array<{ issuer: string; subject: string }>;
    removed.channelContext = await step('channelContext', async () => {
      const items = await scanItems(deps.doc, {
        TableName: stores.channelContext,
        ...channelContextFilter(personId),
        ProjectionExpression: 'channelArn, #m, #i',
      });
      const counts = await mapBounded(items, STORE_CONCURRENCY, (item) => eraseFromChannelContext(deps.doc, stores.channelContext!, item, personId, subjects));
      return counts.reduce((a: number, b: number) => a + b, 0);
    });
  }
  if (stores.battleConfig) {
    removed.battleConfig = await step('battleConfig', () => eraseBattleEnabler(deps.doc, stores.battleConfig!, personArn));
  }
  if (stores.abuseControls) {
    removed.budgetRows = await step('budgetRows', () => removeBudgetRows(deps.doc, stores.abuseControls!, personId, deps.now?.() ?? new Date()));
  }

  // 4. ATTACHMENTS.
  if (stores.attachmentsBucket) {
    removed.attachments = await step('attachments', () => removeAttachments(deps.s3, stores.attachmentsBucket!, personId));
  }

  // 4a. THE AURORA PROJECTION (Aurora mode): the person's own rows, through the data plane.
  if (deps.auroraProjection) {
    removed.auroraProjection = (await step('auroraProjection', () => deps.auroraProjection!(personId))) ?? 0;
  }

  // 4b. CONNECTOR GRANTS: revoked at the vendor, then deleted. One the vendor does not confirm is left for the
  // revoker's retry and counted in the event; failing to reach the revoker at all stops the run here.
  let connectorGrantsRevokeFailed = 0;
  if (deps.connectorGrants) {
    const grants = await step('connectorGrants', () => deps.connectorGrants!(personId));
    removed.connectorGrants = grants.revoked;
    connectorGrantsRevokeFailed = grants.failed;
  }

  // 4c. THE PERSON'S TOKENS. A SCAN, as for the stop records: a token is found by its hash, and the store has no
  // index by person (`conversations-stack.ts`). Its records are short-lived (days to weeks), so it stays small.
  if (stores.tokens) {
    const kinds = Object.fromEntries(PERSON_TOKEN_KINDS.map((k, i) => [`:k${i}`, k]));
    removed.personTokens = await step('personTokens', async () => deleteAll(deps.doc, stores.tokens!, await scanKeys(deps.doc, {
      TableName: stores.tokens,
      // AN INVITATION IS THE PERSON'S TWICE OVER: the ones they are named by, and the ones they issued
      // (`inviterArn`), which a deleted record makes unredeemable.
      FilterExpression: `(personArn = :person OR inviterArn = :person) AND #k IN (${Object.keys(kinds).join(', ')})`,
      ExpressionAttributeNames: { '#k': 'kind' },
      ExpressionAttributeValues: { ':person': personArn, ...kinds },
    })));
  }

  // 5. IDENTITIES: each row and its marker in one transaction, so a subject is never neither.
  const poolAccounts: string[] = [];
  for (const row of rows) {
    const parsed = parseIssuerSubjectKey(row.issuerSubject)!;
    if (poolIssuerIds(deps.primary).includes(parsed.issuer)) poolAccounts.push(parsed.subject);
    await deps.doc.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: deps.identitiesTable, Key: { issuerSubject: row.issuerSubject } } },
        { Put: { TableName: deps.identitiesTable, Item: { issuerSubject: revokedMarkerKey(parsed.issuer, parsed.subject) } } },
      ],
    }));
    removed.identities++;
    await auditIdentityChange('identity_revoked', row, actor, deps);
  }

  // 6. THE APPINSTANCEUSER.
  if (personExists) {
    try {
      await deps.chime.send(new DeleteAppInstanceUserCommand({ AppInstanceUserArn: personArn }));
      removed.appInstanceUser = 1;
    } catch (err) {
      if (nameOf(err) !== 'NotFoundException') throw err;
    }
  }

  // 7. THE POOL ACCOUNT, only this deployment's pool and only when it exists. A failure here leaves a
  // pool account whose subject carries a marker; the sweep removes it.
  for (const subject of poolAccounts) {
    const record = await deps.primary.record(subject);
    if (record && await deletePoolAccount(deps, record.username)) removed.poolAccount++;
  }

  const archived = await recordOffboarding(actor, personArn, removed, deps, { connectorGrantsRevokeFailed });
  return { found: true, removed, kept, archived };
}

/**
 * Remove a pool account that never became a person: a sign-up nobody approved, or an account whose
 * subject was offboarded before the pool delete completed. False when the pool has no such account.
 */
export async function offboardPoolAccount(username: string, actor: OffboardingActor, deps: OffboardingDeps): Promise<OffboardingResult> {
  const removed = zero();
  const kept = [...OFFBOARDING_KEPT];
  if (!(await deletePoolAccount(deps, username))) return { found: false, removed, kept, archived: false };
  removed.poolAccount = 1;
  const archived = await recordOffboarding(actor, null, removed, deps);
  return { found: true, removed, kept, archived };
}

/** The one `offboarding` event. Retried once; a second failure is a security event, never a silent skip. */
async function recordOffboarding(
  actor: OffboardingActor,
  subjectArn: string | null,
  removed: RemovedCounts,
  deps: OffboardingDeps,
  pending: { connectorGrantsRevokeFailed?: number } = {},
): Promise<boolean> {
  const properties: Record<string, string | number | boolean> = {
    actorArn: actor.arn,
    subjectArn: subjectArn ?? '',
    kept: OFFBOARDING_KEPT.join(','),
  };
  for (const s of OFFBOARDED_STORES) properties[`removed_${s}`] = removed[s];
  // A grant the vendor has not revoked yet: kept for the revoker's retry, and recorded here (K3).
  properties.connectorGrantsRevokeFailed = pending.connectorGrantsRevokeFailed ?? 0;
  const personId = (subjectArn && personIdFromArn(subjectArn)) || personIdFromArn(actor.arn) || actor.arn;
  console.log(JSON.stringify({ _auditEvent: 'offboarding', ...properties }));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.archive({ personId, properties });
      return true;
    } catch (err) {
      if (attempt === 1) {
        console.error('[Offboarding][SecurityEvent] the offboarding event could not be archived', { subjectArn, err: nameOf(err) });
      }
    }
  }
  return false;
}

// ── CONVERGE ONE SUBJECT, FROM THE ISSUER'S CURRENT STATE ───────────────────────────────────────

export type Convergence = 'erased' | 'pool-account-removed' | 'unchanged';

/**
 * Bring one subject of `pool` into line with what the pool says NOW. Reading the pool rather than the
 * event's name is what makes a duplicate or out-of-order event converge: a delete replayed after the
 * erasure finds nothing left to erase. An account the pool still holds, enabled or disabled, is left as
 * it is: a disable is refused at the next vend, by the exchange's live read, and never recorded here.
 */
export async function convergeSubject(
  pool: CognitoPoolDirectory, subject: string, actor: OffboardingActor, deps: OffboardingDeps,
): Promise<Convergence> {
  // THE POOL'S ANSWER COMES FIRST AND A FAILED READ THROWS: `record` resolves a federated person's `sub`
  // to their pool username, so null means the pool holds no such user, never that it could not be asked.
  const record = await pool.record(subject);
  const row = await rowOfPoolSubject(pool, subject, deps);
  if (!record) {
    if (!row) return 'unchanged';
    return (await offboardPerson(row.personArn, actor, deps)).found ? 'erased' : 'unchanged';
  }
  if (!row) {
    // An offboarded subject whose pool delete did not complete. Only this deployment's pool is ours to delete.
    if (pool === deps.primary && await revokedPoolIssuer(pool, subject, deps)) {
      return (await offboardPoolAccount(record.username, actor, deps)).found ? 'pool-account-removed' : 'unchanged';
    }
    return 'unchanged';
  }
  return 'unchanged';
}

/**
 * THE BACKSTOP: converge every subject of `pool` the platform knows about. Two passes: every
 * `Identities` row of the pool's issuers (a deleted account the event path missed), then every
 * account in the pool (an offboarded subject whose pool delete did not complete). Low frequency by
 * design; it never replaces the event path.
 */
export async function sweepPool(pool: CognitoPoolDirectory, deps: OffboardingDeps): Promise<Record<Convergence, number>> {
  const actor: OffboardingActor = { arn: 'sweep' };
  const counts: Record<Convergence, number> = { erased: 0, 'pool-account-removed': 0, unchanged: 0 };
  const seen = new Set<string>();
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await deps.doc.send(new ScanCommand({
      TableName: deps.identitiesTable,
      FilterExpression: `#i IN (${poolIssuerIds(pool).map((_, n) => `:i${n}`).join(', ')})`,
      ExpressionAttributeNames: { '#i': 'issuer' },
      ExpressionAttributeValues: Object.fromEntries(poolIssuerIds(pool).map((id, n) => [`:i${n}`, id])),
      ProjectionExpression: 'issuerSubject',
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    for (const item of r?.Items || []) {
      const parsed = parseIssuerSubjectKey(item.issuerSubject);
      if (!parsed || seen.has(parsed.subject)) continue;
      seen.add(parsed.subject);
      counts[await convergeSubject(pool, parsed.subject, actor, deps)]++;
    }
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  if (pool === deps.primary) {
    let next: string | undefined;
    do {
      const page = await pool.listPage(next);
      for (const account of page.users) {
        if (!account.subject || seen.has(account.subject)) continue;
        seen.add(account.subject);
        if (await revokedPoolIssuer(pool, account.subject, deps)) {
          counts[(await offboardPoolAccount(account.username, actor, deps)).found ? 'pool-account-removed' : 'unchanged']++;
        }
      }
      next = page.next;
    } while (next);
  }
  return counts;
}

// ── THE DEPLOYMENT'S WIRING ─────────────────────────────────────────────────────────────────────

/**
 * Store names are read from the SSM contract on first use, because the stacks that own those stores
 * deploy after the one that runs offboarding. A parameter that does not exist means the store is not
 * deployed here, and there is nothing in it to remove; any other read failure throws.
 */
async function storeName(ssm: Sender, param: string | undefined): Promise<string | undefined> {
  if (!param) return undefined;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: param }));
    return r?.Parameter?.Value || undefined;
  } catch (err) {
    if (nameOf(err) === 'ParameterNotFound') return undefined;
    throw err;
  }
}

/** The SSM parameter each store's name is published under, by store. */
export type StoreParams = Partial<Record<keyof PersonStores, string>>;

/**
 * THE STORES, READ BY NAME, WITH ONLY A FOUND NAME KEPT. A store whose stack deploys after this one has
 * no parameter yet, and remembering that absence would skip the store in this container for as long as
 * it lives: every offboarding after its deploy would answer 200 having removed nothing from it. So a
 * name is cached once found and a missing one is read again on the next offboarding. A failed read
 * throws and caches nothing.
 */
export function storeNamesReader(ssm: Sender, params: StoreParams): () => Promise<PersonStores> {
  const found: PersonStores = {};
  return async () => {
    const keys = Object.keys(params) as Array<keyof PersonStores>;
    await Promise.all(keys.map(async (key) => {
      if (found[key]) return;
      const value = await storeName(ssm, params[key]);
      if (!value) return;
      found[key] = key === 'attachmentsBucket' ? value.split(':::').pop() || undefined : value;
    }));
    return { ...found };
  };
}

/**
 * THE CONNECTOR GRANT REVOKER, invoked by name: the Connectors stack deploys after this one and names its
 * function so. The variable is set at synth exactly when a declared connector takes grants, and the
 * Connectors stack grants this role the invoke on that one function. A function error is a failed step.
 */
export function connectorGrantsRevoker(
  functionName: string,
  region: string,
  client?: Sender,
): (personId: string) => Promise<{ revoked: number; failed: number }> {
  const lambda = client ?? new LambdaClient({ region });
  return async (personId) => {
    const r = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify({ personId })) }));
    if (r?.FunctionError) throw new Error(`the connector grant revoker failed: ${r.FunctionError}`);
    const text = r?.Payload ? Buffer.from(r.Payload as Uint8Array).toString('utf8') : '';
    const out = JSON.parse(text || '{}') as { revoked?: unknown; failed?: unknown };
    if (typeof out.revoked !== 'number' || typeof out.failed !== 'number') throw new Error('the connector grant revoker answered with no counts');
    return { revoked: out.revoked, failed: out.failed };
  };
}

let defaults: OffboardingDeps | null = null;

/** The deployment's offboarding, built once per container from the environment. */
export function defaultOffboardingDeps(): OffboardingDeps {
  if (defaults) return defaults;
  const region = process.env.AWS_REGION || 'us-east-1';
  const ssm = new SSMClient({ region });
  const cognito = new CognitoIdentityProviderClient({ region });
  const others = (process.env.OFFBOARDING_OTHER_POOL_IDS || '').split(',').map((s) => s.trim())
    .filter((id) => id && id !== process.env.USER_POOL_ID);
  defaults = {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } }),
    // ADAPTIVE RETRY, MORE ATTEMPTS: erasure and export walk a call per conversation the person is in
    // (tags, memberships, messages), on Amazon Chime SDK APIs with low request limits. Three attempts left
    // the export of a person in many conversations failing on ThrottledClientException (2026-10-21). These
    // run on an operator's or an issuer event's request, never on a turn, so waiting is the right answer.
    chime: chimeIdentityClient({ region, retryMode: 'adaptive', maxAttempts: 10 }),
    messaging: chimeMessagingClient({ region, retryMode: 'adaptive', maxAttempts: 10 }),
    s3: new S3Client({ region }),
    cognito,
    identitiesTable: process.env.IDENTITIES_TABLE || '',
    appInstanceArn: process.env.APP_INSTANCE_ARN || '',
    primary: poolAdapter(process.env.USER_POOL_ID || '', cognito),
    others: others.map((id) => poolAdapter(id, cognito)),
    adminBearer: appInstanceAdminBearer({ ssm, param: process.env.ADMIN_ARN_PARAM || '', onFailure: 'retry' }),
    stores: storeNamesReader(ssm, {
      userProfile: process.env.USER_PROFILE_NAME_PARAM,
      userTasks: process.env.USER_TASKS_NAME_PARAM,
      agentTasks: process.env.AGENT_TASKS_NAME_PARAM,
      turnState: process.env.TURN_STATE_NAME_PARAM,
      channelContext: process.env.CHANNEL_CONTEXT_NAME_PARAM,
      // Set where `battle` is declared, naming the parameter the Battle stack publishes. Unset, the store is not
      // part of this deployment and `storeName` makes no read for it.
      battleConfig: process.env.CHANNEL_BATTLE_CONFIG_NAME_PARAM,
      abuseControls: process.env.ABUSE_CONTROLS_NAME_PARAM,
      // The bucket's ARN is published; the store is its name.
      attachmentsBucket: process.env.ATTACHMENTS_BUCKET_ARN_PARAM,
      tokens: process.env.TOKENS_NAME_PARAM,
    }),
    ...(process.env.CONNECTOR_GRANTS_FUNCTION
      ? { connectorGrants: connectorGrantsRevoker(process.env.CONNECTOR_GRANTS_FUNCTION, region) }
      : {}),
    // The Aurora projection exists exactly when the data plane does: its ARN is published by the Archive stack
    // in Aurora mode, and read the way the offboarding event's delivery reads it.
    auroraProjection: (personId) => eraseFromProjection(personId),
    archive: ({ personId, properties }) => appendServerEvent({ eventType: 'offboarding', personId, properties }),
    audit: (line) => recordAccess(line),
  };
  return defaults;
}

/** Test seam: replace the deployment's offboarding wiring. `null` restores it. */
export function __setOffboardingDepsForTests(d: OffboardingDeps | null): void {
  defaults = d;
}
