/**
 * THE ONE MINTER: who a signed-in person is, as an AppInstanceUser (README.md:3).
 *
 * An issuer and its subject are only a way to get a session as an AppInstanceUser. The person is the
 * AppInstanceUser, and its id is minted here, once per `(issuer, subject)`, as a UUID v7: opaque,
 * time-ordered and carrying no prefix, so it says nothing about which identity provider signed the
 * person in. Which issuers a person uses lives only in the `Identities` table, and nothing may branch
 * on an id's shape.
 *
 * A Cognito `sub` is a UUID v4, so a regression that keys a person on the token's `sub` again fails
 * visibly: `mintPersonId` asserts version 7, and so does the CI guard.
 *
 * ── THE ROW, AND ITS KEY ─────────────────────────────────────────────────────────────────────────
 *
 * `issuerSubject = <issuerId>|<subject>` -> `personArn`, `issuer`, `status`, `createdAt`, with the GSI
 * `byPerson` on `personArn` for the reverse lookup (erasure deletes by it; `Directory` reads it to
 * reach the issuer subject). `issuerId` is the issuer's REGISTRY id (`lib/config/issuers.ts`), never the
 * token's raw `iss`, and `subject` is the claim the entry declares (`sub`, or Entra's `tid` and `oid`).
 * Keying on the registry id keeps a row stable across an issuer URL that moves, and the same subject
 * value under two issuers is two people. The row's `issuer` attribute holds the same registry id.
 *
 * `status` is `active` or `pending`, the platform's own state and nothing else. The exchange writes
 * `active`, and a row that is not `active` is refused here. THE ROW KEEPS NO COPY OF THE IDENTITY
 * PROVIDER'S STATE: whether the subject's account is disabled or gone at its issuer is asked of the
 * issuer live at every vend (`Directory.accountState`, SPEC-CREDENTIAL-EXCHANGE §4b), never recorded here.
 *
 * ── A PROVISIONED SUBJECT (P-13) ─────────────────────────────────────────────────────────────────
 *
 * An issuer declared `provisioned-only` (a `host-assertion` host, `lib/config/issuers.ts`) never has a
 * person minted for it. `provisionSubject` writes its row ahead of the first sign-in, `pending`, naming
 * the AppInstanceUser the subject will sign in as: one the caller names (an administrator linking the
 * subject to a person who already exists) or a fresh id. Only the subject provisioners call it
 * (`lambda/src/provision-subject.ts`, one function per caller, for the admin backend and the connector
 * resolver). The row is only ever created, never changed: a subject with a row, or a revoked marker, is
 * left as it is. At that subject's first sign-in the exchange binds it once (`bindProvisionedPerson`):
 * `pending` becomes `active` with one conditional update, and only for the issuer that row was written
 * for. A provisioned-only subject with no row is refused and nothing is created for it.
 *
 * ── THE CLEARANCE DECISION (C3) ──────────────────────────────────────────────────────────────────
 *
 * Clearance is the credential exchange's decision: at each sign-in it applies the issuer's declared rule
 * to the person's verified token. It records that decision on the row (`clearanceDecision`: the
 * classification applied, the issuer, the rule's source and what it matched, and when), with one update
 * that may touch that attribute alone (`recordClearanceDecision`). For a `mapping` issuer, whose claim
 * nothing else this deployment reads holds, the readers with no token (the membership audit, the
 * reconcile, the router) read the record as evidence of the last sign-in and flag a mismatch or a record
 * older than the issuer allows. Nothing grants from it: every sign-in applies the rule to a fresh token.
 *
 * Erasing a person deletes their rows and writes, for each, a marker under `revokedMarkerKey` that holds
 * a hash of the subject and nothing else. A subject with a marker is refused here and nothing is minted
 * for it, so an offboarded person is never re-minted. Re-admission deletes the marker.
 *
 * ── THE MINT RACE ────────────────────────────────────────────────────────────────────────────────
 *
 * The row is reserved FIRST, with a conditional put (`attribute_not_exists`) carrying a freshly
 * generated id, and only then is `CreateAppInstanceUser` called. Two first sign-ins racing each
 * generate an id; one put wins, and the loser re-reads the row and uses the winner's id, so one subject
 * never holds two AppInstanceUsers. The create treats `ConflictException` as "already exists" and keeps
 * the existing resource, and it runs on every exchange, which is what repairs a reserved row whose
 * create failed: the next sign-in creates it with the same id.
 *
 * ── WHO MAY WRITE ────────────────────────────────────────────────────────────────────────────────
 *
 * Only the credential exchange's role holds an unconditioned write on `Identities` (identity-stack.ts).
 * The subject provisioners write `pending` rows of `provisioned-only` issuers alone, and offboarding
 * removes rows and writes markers; each is held to that by the conditions on its grant. The CI guard in
 * `single-entry-point.test.ts` refuses a `CreateAppInstanceUser` for a person anywhere but here. The post-confirmation trigger, user approval and the provisioning scripts create nothing: a
 * person comes into being at their first credential exchange.
 */
import { createHash, randomBytes } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
  DescribeAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { isPersonOf, personIdFromArn, userArnFor } from './person-arn.js';
import { recordAccess, type AccessAuditLine } from './access-log.js';
import { chimeIdentityClient } from './chime/clients.js';

/** The GSI that answers "which issuer subjects sign in as this AppInstanceUser". */
export const IDENTITIES_BY_PERSON = 'byPerson';

/**
 * Every state a row can hold. Any but `active` is refused. An erased subject has no row at all, only a
 * marker (`revokedMarkerKey`), so offboarding never writes `revoked` on a row.
 */
export const IDENTITY_STATUSES = ['active', 'revoked', 'pending'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export interface IdentityRow {
  issuerSubject: string;
  personArn: string;
  issuer: string;
  status: IdentityStatus;
  createdAt: string;
  /** A `pending` row: which provisioner wrote it (`admin` or `connectors`). */
  provisionedBy?: string;
  /** A provisioned row, once its subject's first sign-in bound it. */
  boundAt?: string;
  /** What the credential exchange decided at this subject's last sign-in. Evidence, never a grant. */
  clearanceDecision?: ClearanceDecision;
}

/**
 * WHAT THE EXCHANGE DECIDED AT A SIGN-IN: the classification it vended, through which issuer, by which
 * rule, matching what, and when. Recorded on the row; read by the offline readers as evidence only.
 */
export interface ClearanceDecision {
  /** The holder token the exchange vended at that sign-in. */
  classification: string;
  /** The issuer's registry id. */
  issuer: string;
  /** The rule's source: the issuer's declared clearance source. */
  source: 'groups' | 'mapping' | 'fixed';
  /** A mapping's claim, by name. */
  claim?: string;
  /** What the rule matched: the claim values a mapping declares, the groups, or the fixed set. Capped. */
  matched: string[];
  /** ISO 8601, when the exchange decided. */
  at: string;
}

/** The longest list of matched values a record keeps, and the longest value. Bounds the row. */
const MAX_MATCHED = 20;
const MAX_MATCHED_LENGTH = 256;

/** A `provisioned-only` subject with no row: nothing pre-assigned it, so nothing is vended and nothing created. */
export class PersonNotProvisioned extends Error {
  constructor() {
    super('this sign-in was not provisioned');
    this.name = 'PersonNotProvisioned';
  }
}

/** A row exists for this subject and is not `active`: the exchange refuses to vend, and mints nothing. */
export class PersonNotActive extends Error {
  constructor(readonly status: string) {
    super(`this sign-in is ${status}`);
    this.name = 'PersonNotActive';
  }
}

// ── THE ID ──────────────────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The version nibble of an RFC 9562 UUID, or null for anything that is not one. */
export function uuidVersion(id: string | null | undefined): number | null {
  const m = UUID.exec(String(id ?? ''));
  return m ? parseInt(m[1], 16) : null;
}

/**
 * An RFC 9562 UUID v7: 48 bits of Unix milliseconds, the version, 74 random bits and the variant.
 * Written out rather than taken from a dependency, because it is twelve lines and runs inside the one
 * function every sign-in passes through.
 */
export function uuidv7(nowMs: number = Date.now(), rand: Buffer = randomBytes(10)): string {
  const b = Buffer.alloc(16);
  b.writeUIntBE(Math.floor(nowMs) % 2 ** 48, 0, 6);
  rand.copy(b, 6, 0, 10);
  b[6] = 0x70 | (b[6] & 0x0f); // version 7
  b[8] = 0x80 | (b[8] & 0x3f); // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A fresh person id, refused unless it is a UUID v7 (a regression to a `sub` is a v4). */
export function mintPersonId(generate: () => string = uuidv7): string {
  const id = generate();
  if (uuidVersion(id) !== 7) throw new Error(`person-identity: a person id is a UUID v7, refused '${id}'`);
  return id;
}

// ── THE KEYS ────────────────────────────────────────────────────────────────────────────────────

/** The row key for one issuer's subject. `issuerId` is the registry id, never a raw `iss`. */
export function issuerSubjectKey(issuerId: string, subject: string): string {
  if (!issuerId || !subject) throw new Error('person-identity: an issuer and a subject are required');
  return `${issuerId}|${subject}`;
}

/**
 * The key of the marker offboarding writes when it erases a person, so the subject is refused at its
 * next sign-in rather than minted again. It holds a hash of the subject, never the subject. Defined
 * here so the shape has one definition; offboarding writes it and the minter reads it.
 */
export function revokedMarkerKey(issuer: string, subject: string): string {
  if (!issuer || !subject) throw new Error('person-identity: an issuer and a subject are required');
  return `revoked#${issuer}#${createHash('sha256').update(subject).digest('hex')}`;
}

/**
 * The AppInstanceUser `Name`: a display name, never an address. An address-shaped value keeps only its
 * local part, and nothing usable falls back to the person id.
 */
export function displayNameFor(name: string | null | undefined, personId: string): string {
  const raw = String(name ?? '').trim();
  const local = raw.includes('@') ? raw.split('@')[0].trim() : raw;
  return (local || personId).slice(0, 100);
}

// ── DEPENDENCIES ────────────────────────────────────────────────────────────────────────────────

type Sender = { send(command: unknown): Promise<any> };

export interface PersonIdentityDeps {
  doc?: Sender;
  chime?: Sender;
  table?: string;
  appInstanceArn?: string;
  /** Who is writing, for the audit record. */
  actor?: string;
  newId?: () => string;
  now?: () => Date;
  audit?: (line: AccessAuditLine) => Promise<unknown>;
}

let defaultDoc: Sender | null = null;
let defaultChime: Sender | null = null;
const docOf = (d: PersonIdentityDeps): Sender =>
  d.doc ?? (defaultDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({})));
const chimeOf = (d: PersonIdentityDeps): Sender =>
  d.chime ?? (defaultChime ??= chimeIdentityClient({ region: process.env.AWS_REGION || 'us-east-1' }));

function settings(d: PersonIdentityDeps): { table: string; appInstanceArn: string } {
  const table = d.table ?? process.env.IDENTITIES_TABLE ?? '';
  const appInstanceArn = d.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '';
  if (!table) throw new Error('person-identity: IDENTITIES_TABLE is not set');
  if (!appInstanceArn) throw new Error('person-identity: APP_INSTANCE_ARN is not set');
  return { table, appInstanceArn };
}

async function readRow(doc: Sender, table: string, key: string): Promise<IdentityRow | null> {
  const r = await doc.send(new GetCommand({ TableName: table, Key: { issuerSubject: key }, ConsistentRead: true }));
  return (r?.Item as IdentityRow | undefined) ?? null;
}

function activeIdOf(row: IdentityRow): string {
  if (row.status && row.status !== 'active') throw new PersonNotActive(row.status);
  const id = personIdFromArn(row.personArn);
  if (!id) throw new Error('person-identity: an Identities row names no AppInstanceUser');
  return id;
}

// ── THE MINTER ──────────────────────────────────────────────────────────────────────────────────

export interface MintedPerson {
  personId: string;
  personArn: string;
  /** True when this call created the AppInstanceUser; false when it already existed. */
  created: boolean;
}

/**
 * The AppInstanceUser for `(issuer, subject)`, minted on the first sign-in and resolved on every one
 * after. `issuer` is the registry id. Called only by the credential exchange.
 *
 * THROWS `PersonNotActive` for a row that is not `active` or a revoked subject, and creates nothing for either.
 */
export async function mintOrResolvePerson(
  input: { issuer: string; subject: string; name?: string | null },
  deps: PersonIdentityDeps = {},
): Promise<MintedPerson> {
  const { table, appInstanceArn } = settings(deps);
  const doc = docOf(deps);
  const key = issuerSubjectKey(input.issuer, input.subject);

  let personId: string;
  const existing = await readRow(doc, table, key);
  if (existing) {
    personId = activeIdOf(existing);
  } else {
    // AN OFFBOARDED SUBJECT IS NEVER RE-MINTED. Read only on a miss, so a returning person pays nothing.
    if (await readRow(doc, table, revokedMarkerKey(input.issuer, input.subject))) throw new PersonNotActive('revoked');
    const candidate = mintPersonId(deps.newId);
    const row: IdentityRow = {
      issuerSubject: key,
      personArn: userArnFor(appInstanceArn, candidate),
      issuer: input.issuer,
      status: 'active',
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    try {
      await doc.send(new PutCommand({
        TableName: table,
        Item: row,
        ConditionExpression: 'attribute_not_exists(issuerSubject)',
      }));
      personId = candidate;
      await auditMint(row, deps);
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      // LOST THE RACE: another first sign-in for this subject reserved the row first. Its id is the
      // person, and the candidate above is discarded before anything was created with it.
      const winner = await readRow(doc, table, key);
      if (!winner) throw new Error('person-identity: the reservation was refused but no row is readable');
      personId = activeIdOf(winner);
    }
  }

  const personArn = userArnFor(appInstanceArn, personId);
  let created = false;
  try {
    // NO TAGS ON CREATE. A create carrying `Tags` also needs `chime:TagResource`, and failing the create
    // on a missing permission for a decorative field is a total sign-in outage (measured 2026-09-13).
    await chimeOf(deps).send(new CreateAppInstanceUserCommand({
      AppInstanceArn: appInstanceArn,
      AppInstanceUserId: personId,
      Name: displayNameFor(input.name, personId),
    }));
    created = true;
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
  }
  return { personId, personArn, created };
}

/**
 * THE AUDIT RECORD FOR A NEW ROW (actor, issuer, AppInstanceUser ARN, time).
 *
 * The CloudWatch line is always written. The durable record is attempted and its failure is reported
 * as a security event rather than refusing the sign-in: this is a person's own first session, not an
 * operator's access, and withholding it would turn an access-log outage into a sign-in outage.
 */
async function auditMint(row: IdentityRow, deps: PersonIdentityDeps): Promise<void> {
  const line: AccessAuditLine = {
    _auditEvent: 'identity_minted',
    timestamp: row.createdAt,
    // The actor: the service that minted the row, not the person minted.
    personId: deps.actor || 'credential-exchange',
    issuer: row.issuer,
    personArn: row.personArn,
  };
  console.log(JSON.stringify(line));
  try {
    await (deps.audit ?? ((l: AccessAuditLine) => recordAccess(l)))(line);
  } catch (err) {
    console.error('[PersonIdentity][SecurityEvent] the identity record could not be written to the access log', {
      personArn: row.personArn, err: (err as Error)?.message,
    });
  }
}

// ── AN INVITEE NOT YET KNOWN (M-10) ─────────────────────────────────────────────────────────────

/** How long an unredeemed invitee lives at most, in days: its invitation's own expiry, never more. */
export const MAX_INVITEE_DAYS = 30;

/**
 * MINT THE AppInstanceUser AN INVITATION NAMES, before anybody has signed in as it (M-10). Called only by
 * the credential exchange, on an invocation from the invitations function (`invitations.ts`), which holds
 * the one grant to ask for it.
 *
 * The id is a fresh UUID v7 like every person's, and NO `Identities` ROW IS WRITTEN: the invitation's
 * `Tokens` record is what names this person until a sign-in redemption binds a subject to it
 * (`lib/invitation-redemption.ts`). The AppInstanceUser is created WITH its expiration, in the one call,
 * counted from creation at the invitation's own expiry, so an invitee nobody redeems lapses with its
 * invitation and none is ever left without one. `Name` is the display name the inviter gave, never an
 * address.
 */
export async function mintInvitee(
  input: { name: string; expirationDays: number },
  deps: PersonIdentityDeps = {},
): Promise<{ personId: string; personArn: string }> {
  const appInstanceArn = deps.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '';
  if (!appInstanceArn) throw new Error('person-identity: APP_INSTANCE_ARN is not set');
  const days = Math.floor(input.expirationDays);
  if (!(days >= 1 && days <= MAX_INVITEE_DAYS)) throw new Error(`person-identity: an invitee expires within 1 to ${MAX_INVITEE_DAYS} days`);
  const personId = mintPersonId(deps.newId);
  const personArn = userArnFor(appInstanceArn, personId);
  await chimeOf(deps).send(new CreateAppInstanceUserCommand({
    AppInstanceArn: appInstanceArn,
    AppInstanceUserId: personId,
    Name: displayNameFor(input.name, personId),
    ExpirationSettings: { ExpirationDays: days, ExpirationCriterion: 'CREATED_TIMESTAMP' },
  }));
  const line: AccessAuditLine = {
    _auditEvent: 'invitee_minted',
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
    personId: deps.actor || 'credential-exchange',
    personArn,
    expirationDays: days,
  };
  console.log(JSON.stringify(line));
  try {
    await (deps.audit ?? ((l: AccessAuditLine) => recordAccess(l)))(line);
  } catch (err) {
    console.error('[PersonIdentity][SecurityEvent] the invitee record could not be written to the access log', { personArn, err: (err as Error)?.message });
  }
  return { personId, personArn };
}

// ── PROVISIONED SUBJECTS (P-13) ─────────────────────────────────────────────────────────────────

/** Who wrote a `pending` row: the admin backend's provisioner, or the connector resolver's. */
export type Provisioner = 'admin' | 'connectors';

export type ProvisionResult =
  | { state: 'provisioned'; personArn: string }
  /** The subject already has a row (or a revoked marker): nothing was written. */
  | { state: 'exists'; status: IdentityStatus };

/**
 * PRE-ASSIGN A SUBJECT OF A `provisioned-only` ISSUER: write its `Identities` row, `pending`, naming
 * `personArn` (a person who already exists) or a fresh person id. Created only: a subject that already has
 * a row, or was revoked, is left as it is and the answer says which. The caller has already checked that
 * the issuer is one it may provision for (`lambda/src/provision-subject.ts`); IAM holds its role to those
 * issuers' keys.
 */
export async function provisionSubject(
  input: { issuer: string; subject: string; personArn?: string; provisionedBy: Provisioner },
  deps: PersonIdentityDeps = {},
): Promise<ProvisionResult> {
  const { table, appInstanceArn } = settings(deps);
  const doc = docOf(deps);
  const key = issuerSubjectKey(input.issuer, input.subject);
  if (await readRow(doc, table, revokedMarkerKey(input.issuer, input.subject))) return { state: 'exists', status: 'revoked' };
  const personArn = input.personArn ?? userArnFor(appInstanceArn, mintPersonId(deps.newId));
  if (!isPersonOf(personArn, appInstanceArn)) {
    throw new Error('person-identity: a provisioned subject names an AppInstanceUser of this app instance');
  }
  const row: IdentityRow = {
    issuerSubject: key,
    personArn,
    issuer: input.issuer,
    status: 'pending',
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    provisionedBy: input.provisionedBy,
  };
  try {
    await doc.send(new PutCommand({ TableName: table, Item: row, ConditionExpression: 'attribute_not_exists(issuerSubject)' }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    const existing = await readRow(doc, table, key);
    return { state: 'exists', status: existing?.status ?? 'pending' };
  }
  await auditIdentity('identity_provisioned', row, deps);
  return { state: 'provisioned', personArn };
}

/**
 * THE AppInstanceUser A `provisioned-only` SUBJECT SIGNS IN AS, bound at its first sign-in. Called only by
 * the credential exchange, in place of `mintOrResolvePerson`, for an issuer the registry declares
 * `provisioned-only`.
 *
 *  - No row: `PersonNotProvisioned`, and nothing is created.
 *  - A `pending` row written for this issuer: one conditional update makes it `active` (`boundAt`), so a
 *    pending row is accepted once; two sign-ins racing both resolve to the one person it names.
 *  - An `active` row: the person, as for every issuer.
 *  - Anything else (a row written for another issuer, a revoked marker): `PersonNotActive`.
 *
 * The AppInstanceUser is then created if it does not exist yet, as the minter does, so a pre-assigned id
 * becomes a person at the first sign-in and not before.
 */
export async function bindProvisionedPerson(
  input: { issuer: string; subject: string; name?: string | null },
  deps: PersonIdentityDeps = {},
): Promise<MintedPerson> {
  const { table, appInstanceArn } = settings(deps);
  const doc = docOf(deps);
  const key = issuerSubjectKey(input.issuer, input.subject);
  let row = await readRow(doc, table, key);
  if (!row) {
    if (await readRow(doc, table, revokedMarkerKey(input.issuer, input.subject))) throw new PersonNotActive('revoked');
    throw new PersonNotProvisioned();
  }
  // A ROW IS ONE ISSUER'S. The key names the issuer already; the attribute must agree with it.
  if (row.issuer !== input.issuer) throw new PersonNotActive('another-issuer');
  if (row.status === 'pending') {
    const boundAt = (deps.now?.() ?? new Date()).toISOString();
    try {
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: { issuerSubject: key },
        UpdateExpression: 'SET #status = :active, boundAt = :boundAt',
        ConditionExpression: '#status = :pending AND issuer = :issuer',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':pending': 'pending', ':issuer': input.issuer, ':boundAt': boundAt },
      }));
      await auditIdentity('identity_bound', { ...row, status: 'active', boundAt }, deps);
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
    // Bound by this call or by a racing one: read what the row now says.
    row = await readRow(doc, table, key);
    if (!row) throw new PersonNotProvisioned();
  }
  const personId = activeIdOf(row);
  const personArn = userArnFor(appInstanceArn, personId);
  let created = false;
  try {
    await chimeOf(deps).send(new CreateAppInstanceUserCommand({
      AppInstanceArn: appInstanceArn,
      AppInstanceUserId: personId,
      Name: displayNameFor(input.name, personId),
    }));
    created = true;
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
  }
  return { personId, personArn, created };
}

/** The audit record of a provisioned or bound row (actor, issuer, AppInstanceUser ARN, time), as `auditMint` writes one. */
async function auditIdentity(event: 'identity_provisioned' | 'identity_bound', row: IdentityRow, deps: PersonIdentityDeps): Promise<void> {
  const line: AccessAuditLine = {
    _auditEvent: event,
    timestamp: row.boundAt ?? row.createdAt,
    personId: deps.actor || (event === 'identity_bound' ? 'credential-exchange' : `provisioner:${row.provisionedBy ?? 'unknown'}`),
    issuer: row.issuer,
    personArn: row.personArn,
  };
  console.log(JSON.stringify(line));
  try {
    await (deps.audit ?? ((l: AccessAuditLine) => recordAccess(l)))(line);
  } catch (err) {
    console.error('[PersonIdentity][SecurityEvent] the identity record could not be written to the access log', {
      personArn: row.personArn, err: (err as Error)?.message,
    });
  }
}

// ── THE RESOLVER ────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT IS CACHED, AND WHAT NEVER IS.
 *
 * The row is read on every call, with a consistent read, because its presence and `status` are the access
 * decision: erasing a subject takes effect on the next request in every warm container. A resolved ARN
 * is never cached, so an offboarded subject never keeps resolving.
 *
 * Only the AppInstanceUser's existence is cached, keyed by its ARN. It decides nothing on its own: an
 * AppInstanceUser goes away through erasure, which deletes the subject's rows first (`offboardPerson`
 * step 5 before step 6), so the fresh row read refuses an erased person before a cached existence is
 * consulted.
 */
const EXISTS_TTL_MS = 5 * 60_000;
const confirmedUsers = new Map<string, number>();

/** Forget every cached existence check. For tests. */
export function clearPersonCache(): void {
  confirmedUsers.clear();
}

/**
 * The AppInstanceUser ARN `(issuer, subject)` signs in as, or null. Read-only: it never mints.
 *
 * Null for a subject with no row, a row that is not `active`, and a row whose AppInstanceUser no longer
 * exists. The row is read on every call; the AppInstanceUser's existence is checked only on a cache miss.
 */
export async function resolvePerson(issuer: string, subject: string, deps: PersonIdentityDeps = {}): Promise<string | null> {
  const { table } = settings(deps);
  const row = await readRow(docOf(deps), table, issuerSubjectKey(issuer, subject));
  if (!row || (row.status && row.status !== 'active') || !personIdFromArn(row.personArn)) return null;

  const now = Date.now();
  if ((confirmedUsers.get(row.personArn) ?? 0) > now) return row.personArn;
  try {
    await chimeOf(deps).send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: row.personArn }));
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') return null;
    throw err;
  }
  confirmedUsers.set(row.personArn, now + EXISTS_TTL_MS);
  return row.personArn;
}

/**
 * Where a subject stands, for the edge authorizer, which must tell three answers apart that
 * `resolvePerson` folds into one null:
 *
 *  - `active`: the row is active and its AppInstanceUser exists. The person is the ARN.
 *  - `unbound`: no row and no revocation marker, or a row whose AppInstanceUser is gone. The subject
 *    has not been through the exchange yet (or its create failed), so only the exchange can help it.
 *  - `refused`: a row that is not active, a revocation marker, or a row naming no AppInstanceUser.
 *    Nothing helps it; the exchange would refuse it too.
 *
 * Read-only, like `resolvePerson`: the row is read on every call, and only existence is cached.
 */
export type IdentityState =
  | { state: 'active'; personArn: string }
  | { state: 'unbound' }
  /** A `provisioned-only` subject pre-assigned and not signed in yet (P-13): only the exchange binds it. */
  | { state: 'pending'; personArn: string }
  | { state: 'refused'; status: string };

export async function identityStateOf(issuer: string, subject: string, deps: PersonIdentityDeps = {}): Promise<IdentityState> {
  const { table } = settings(deps);
  const doc = docOf(deps);
  const row = await readRow(doc, table, issuerSubjectKey(issuer, subject));
  if (!row) {
    // A REVOKED SUBJECT IS REFUSED, not sent to the exchange. Read only on a miss.
    if (await readRow(doc, table, revokedMarkerKey(issuer, subject))) return { state: 'refused', status: 'revoked' };
    return { state: 'unbound' };
  }
  if (!personIdFromArn(row.personArn)) return { state: 'refused', status: 'no-app-instance-user' };
  // A PENDING ROW NAMES A PERSON WHO DOES NOT EXIST YET: the exchange creates them at the bind.
  if (row.status === 'pending' && row.issuer === issuer) return { state: 'pending', personArn: row.personArn };
  if (row.status && row.status !== 'active') return { state: 'refused', status: row.status };

  const now = Date.now();
  if ((confirmedUsers.get(row.personArn) ?? 0) > now) return { state: 'active', personArn: row.personArn };
  try {
    await chimeOf(deps).send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: row.personArn }));
  } catch (err) {
    // The row was reserved but its create never landed: the exchange repairs it with the same id.
    if ((err as { name?: string }).name === 'NotFoundException') return { state: 'unbound' };
    throw err;
  }
  confirmedUsers.set(row.personArn, now + EXISTS_TTL_MS);
  return { state: 'active', personArn: row.personArn };
}

// ── THE REVERSE LOOKUP ──────────────────────────────────────────────────────────────────────────

/** One issuer subject a person signs in as. */
export interface PersonSubject {
  issuer: string;
  subject: string;
  /** What the exchange decided at this subject's last sign-in, when it recorded one. Evidence, never a grant. */
  clearanceDecision?: ClearanceDecision;
}

/** The issuer and subject a row key names, or null for a key that is not `<issuer>|<subject>`. */
export function parseIssuerSubjectKey(key: string | null | undefined): PersonSubject | null {
  const raw = String(key ?? '');
  // A registry id never carries `|`; a subject may, so the split is at the first one.
  const at = raw.indexOf('|');
  if (at <= 0 || at === raw.length - 1 || raw.startsWith('revoked#')) return null;
  return { issuer: raw.slice(0, at), subject: raw.slice(at + 1) };
}

/**
 * Every active issuer subject that signs in as the AppInstanceUser `personArn`, through the `byPerson`
 * index. Read-only. An offboarding marker carries no `personArn`, so it is never on the index.
 *
 * `anyStatus` includes a `pending` row's subject too, for a check that a person is nobody's yet (an
 * invitee bound by nobody), never for a decision that grants.
 *
 * `[]` is a real answer: a person nobody signs in as (a service principal, an admin-plane twin). A read
 * that fails throws, and the caller decides what an unanswerable lookup means.
 */
export async function subjectsOfPerson(
  personArn: string,
  deps: PersonIdentityDeps = {},
  opts: { anyStatus?: boolean } = {},
): Promise<PersonSubject[]> {
  if (!personIdFromArn(personArn)) return [];
  const table = deps.table ?? process.env.IDENTITIES_TABLE ?? '';
  if (!table) throw new Error('person-identity: IDENTITIES_TABLE is not set');
  const out: PersonSubject[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await docOf(deps).send(new QueryCommand({
      TableName: table,
      IndexName: IDENTITIES_BY_PERSON,
      KeyConditionExpression: 'personArn = :p',
      ExpressionAttributeValues: { ':p': personArn },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    for (const item of (r?.Items || []) as IdentityRow[]) {
      if (!opts.anyStatus && item.status && item.status !== 'active') continue;
      const parsed = parseIssuerSubjectKey(item.issuerSubject);
      if (parsed) out.push(item.clearanceDecision ? { ...parsed, clearanceDecision: item.clearanceDecision } : parsed);
    }
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

// ── THE CLEARANCE DECISION ──────────────────────────────────────────────────────────────────────

/**
 * Record what the exchange decided at this sign-in on the subject's row, and nothing else: the one
 * attribute `clearanceDecision` (the exchange's grant on `Identities` is held to it, `identity-stack.ts`),
 * on a row that exists. The decision is the classification the exchange vended, so it is recorded after
 * the person is resolved and before the credential leaves.
 *
 * NEVER FATAL to the sign-in. A record that could not be written is stale evidence, which the readers
 * flag as stale once it passes its issuer's age; a refused sign-in would be an outage for a log.
 */
export async function recordClearanceDecision(
  input: { issuer: string; subject: string; classification: string; source: ClearanceDecision['source']; claim?: string; matched: readonly string[] },
  deps: PersonIdentityDeps = {},
): Promise<boolean> {
  const table = deps.table ?? process.env.IDENTITIES_TABLE ?? '';
  if (!table) return false;
  const decision: ClearanceDecision = {
    classification: input.classification,
    issuer: input.issuer,
    source: input.source,
    ...(input.claim ? { claim: input.claim } : {}),
    matched: [...new Set(input.matched.map((v) => String(v).slice(0, MAX_MATCHED_LENGTH)))].slice(0, MAX_MATCHED),
    at: (deps.now?.() ?? new Date()).toISOString(),
  };
  try {
    await docOf(deps).send(new UpdateCommand({
      TableName: table,
      Key: { issuerSubject: issuerSubjectKey(input.issuer, input.subject) },
      UpdateExpression: 'SET clearanceDecision = :d',
      ConditionExpression: 'attribute_exists(issuerSubject)',
      ExpressionAttributeValues: { ':d': decision },
    }));
    return true;
  } catch (err) {
    console.warn('[person-identity] the clearance decision could not be recorded; the readers will see the last one', {
      issuer: input.issuer, name: (err as { name?: string })?.name,
    });
    return false;
  }
}
