/**
 * PATH B: A VISITOR REGISTERS, AND THE ACCOUNT THAT SIGNS IN FROM THE EMAILED LINK CARRIES THE VISIT OVER
 * (PLAN §16.6, P-12, B6, FR26).
 *
 * Two routes on `PersonApi` and two operations for the admin console, one function in `Conversations`, the
 * writer of the `registration` and `claim` kinds in `Tokens` (A8: its grant carries `dynamodb:LeadingKeys`
 * on those two kinds alone). A visitor never opts in to keeping their visit: registering is the whole act,
 * and the sign-in from the link carries it over with nothing else to click.
 *
 * ── `POST /guest/register` (a guest token) ───────────────────────────────────────────────────────
 *
 * The edge admits a guest token here (`GUEST_ROUTES`) and this handler admits a guest and nobody else.
 * The visitor's conversation is the one their signed token names (`ch`), never the body's. The body's
 * structured fields (`lib/upgrade.ts`) are written to the visitor's one registration record, with the
 * address its sign-in link goes to, which is a delivery route and never a key (K2). Then, as the guest
 * issuer declares (`guest.registration.approval`, `lib/config/issuers.ts`):
 *
 *  - `none`: a fresh claim token is issued, any claim issued for the visit before is revoked, and the claim
 *    email is sent at once (the transactional `claim` kind, in the visit's assistant's words): its link is
 *    the chat app's sign-in carrying the token in its fragment. The address is not stored.
 *  - `admin`: the registration waits, holding the address, until an operator approves it (below); no claim
 *    exists yet.
 *
 * The answer never carries the claim token: the token is the link, and the link goes only to the address.
 * Refused once the registration is claimed.
 *
 * ── `POST /upgrade/claim` (a signed-in person) ───────────────────────────────────────────────────
 *
 * Made by the chat app on its own once a person signs in from the link (`settlePendingUpgrade`). An
 * ordinary person: the edge and `callerPerson` refuse a guest, a one-conversation person and a host
 * assertion. Never answered from the authorizer cache (`UNCACHED_ROUTES`), since it consumes a single-use
 * token. The claim is found by its token's hash and nothing else, never by an email. In this order:
 *
 *  1. The claim and its registration are read: the claim unconsumed and unexpired, the registration open,
 *     unexpired, and naming this claim as its current one.
 *  2. The account's clearance reaches the target type's classification (`claimTargetOf`): refused
 *     otherwise, with nothing consumed, since the conversation would be one they could not read.
 *  3. The claim is redeemed (one conditional update).
 *  4. The visitor's assistant assesses the visit (`assessVisit`, FR26). No assessment never stops it.
 *  5. The target classification's creator opens the `customer-engagement` conversation for the account,
 *     tagged with the visitor's conversation and AppInstanceUser, seeded with the assessment and the
 *     registered fields. If it cannot, the redemption is undone and the claim can be tried again.
 *  6. The registration is marked `claimed` and names the account and the new conversation.
 *  7. The visitor's conversation is deleted (`retireVisit`). The visitor's AppInstanceUser is untouched: it
 *     lapses on its own expiration (P-12).
 *
 * ── THE CONSOLE'S TWO OPERATIONS (`op`), invoked by the admin backend ────────────────────────────
 *
 * `admin-list-registrations` and `admin-approve-registration` are direct invocations, never a gateway
 * request: the admin backend's function (`admin-registrations.ts`) is the one principal granted the invoke,
 * behind its own IAM-authorized `AdminApi` routes (`approve-registrations`). Approving issues the claim,
 * sends the email to the address the registration held, and then forgets the address.
 */
import { resolveConversationCreatorArn } from './lib/conversation-creator-arn.js';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { claimTargetOf, GUEST_VISITOR_TYPE, typeAdmitsIssuers } from '../../lib/config/conversation-types.js';
import { isGuestIssuer, type RegistrationApproval } from '../../lib/config/issuers.js';
import { callerHolderToken, callerPerson, edgeCallerOf } from './lib/auth.js';
import { newPlatformToken, putToken, readTokenRecord, redeemToken, tokenKey, tokenRecordOf, type TokenRecord } from './lib/tokens.js';
import {
  APPROVAL_QUEUE_ATTRIBUTE, assessVisit, openUpgradeConversation, REGISTRATIONS_AWAITING_APPROVAL, REGISTRATION_DAYS, registrationAddressOf, registrationFieldsOf, registrationKeyOf, retireVisit,
  visitSeedOf, type RegistrationFields,
} from './lib/upgrade.js';
import { responder, type HttpResult } from './lib/http-response.js';
import { recordFunnelStage, type FunnelSink } from './lib/funnel.js';
import { invokeTransactionalMail, type TransactionalMail } from './lib/transactional-mail.js';
import { userArnFor } from './lib/person-arn.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

const http = responder({ origin: { fixed: '*' }, allowHeaders: '*' });

/** How many times one visit may register (each one a sign-in link emailed, now or on approval). */
export const MAX_CLAIM_EMAILS_PER_VISIT = 5;

export const REGISTER_ROUTE = '/guest/register';
export const CLAIM_ROUTE = '/upgrade/claim';

const AWAITING = 'awaiting';

export interface UpgradeDeps {
  doc?: Sender;
  lambda?: Sender;
  tokensTable?: string;
  appInstanceArn?: string;
  /** The target classification's creator, by classification. */
  creators?: Record<string, string>;
  /** The guest classification's creator, which assesses and retires the visitor's conversation. */
  guestCreator?: string;
  /** The guest classification, which that creator serves. */
  guestClassification?: string;
  /** Whether a registration waits for an operator (`guest.registration.approval`). Default the env. */
  approval?: RegistrationApproval;
  /** The chat app's origin, where the sign-in link lands. */
  appUrl?: string;
  /** The claim email's hand-off to `Notifications`, which sends it. Default `invokeTransactionalMail`. */
  mail?: (m: TransactionalMail) => Promise<boolean>;
  now?: () => number;
  /** Where the funnel's stages are archived (B12). Default the archive. */
  funnel?: FunnelSink;
}

let defaultDoc: Sender | null = null;
let defaultLambda: Sender | null = null;
const docOf = (d: UpgradeDeps): Sender => d.doc ?? (defaultDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));
const lambdaOf = (d: UpgradeDeps): Sender => d.lambda ?? (defaultLambda ??= new LambdaClient({}));
const tableOf = (d: UpgradeDeps): string => d.tokensTable ?? process.env.TOKENS_TABLE ?? '';
const instanceOf = (d: UpgradeDeps): string => d.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '';
const approvalOf = (d: UpgradeDeps): RegistrationApproval => d.approval ?? (process.env.REGISTRATION_APPROVAL === 'admin' ? 'admin' : 'none');
const appUrlOf = (d: UpgradeDeps): string => (d.appUrl ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
const guestClassificationOf = (d: UpgradeDeps): string => d.guestClassification ?? process.env.GUEST_CLASSIFICATION ?? '';
/** A classification's creator, from the caller's deps or found by its key at call time (`resolveConversationCreatorArn`). */
async function creatorOf(d: UpgradeDeps, classification: string): Promise<string> {
  if (d.creators) return d.creators[classification] ?? '';
  return (await resolveConversationCreatorArn(classification)) ?? '';
}
/** The visitor classification's creator, which assesses and retires the visit. */
async function guestCreatorOf(d: UpgradeDeps): Promise<string> {
  if (d.guestCreator !== undefined) return d.guestCreator;
  const visitor = guestClassificationOf(d);
  return visitor ? creatorOf({ ...d, creators: undefined }, visitor) : '';
}

const refuse = (status: number, code: string, message: string): HttpResult => http.error(status, message, undefined, code);

function bodyOf(event: any): Record<string, unknown> | null {
  try {
    const parsed = event?.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const nameOf = (err: unknown): string => (err as { name?: string })?.name || '';

// ── THE CLAIM AND ITS EMAIL ──────────────────────────────────────────────────────────────────────

/** The sign-in link a claim rides in: the chat app, with the token in the fragment no server receives. */
export function claimLinkOf(appUrl: string, claimToken: string): string {
  return `${appUrl}/#claim=${encodeURIComponent(claimToken)}`;
}

/**
 * THE ONE EMAIL: the account's sign-in link, to the address the visitor registered, as the transactional
 * `claim` kind, in the words of the visit's assistant. No reply address: a reply would post as the visitor.
 * Handed to `Notifications`, which sends it (`lib/transactional-mail.ts`). True when it was sent.
 */
function sendClaimEmail(
  args: { personArn: string; channelArn: string; address: string; name: string; link: string },
  d: UpgradeDeps,
): Promise<boolean> {
  return (d.mail ?? invokeTransactionalMail)({ mail: 'claim', ...args });
}

/** Revoke a claim shown before, so only the latest redeems. A claim already used or revoked is left alone. */
async function revokeClaim(doc: Sender, table: string, claimKey: unknown, now: number, why: string): Promise<void> {
  if (typeof claimKey !== 'string' || !claimKey) return;
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: { pk: claimKey },
    UpdateExpression: 'SET consumedAt = :now, revokedBy = :why',
    ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(consumedAt)',
    ExpressionAttributeValues: { ':now': now, ':why': why },
  })).catch((err: unknown) => {
    if (nameOf(err) !== 'ConditionalCheckFailedException') throw err;
  });
}

interface RegistrationFacts { pk: string; channelArn: string; personArn: string; issuer: string; expiresAt: number; fields: RegistrationFields }

/** A fresh claim for a registration, written to the store. The token is returned once, for its link. */
async function issueClaim(doc: Sender, table: string, reg: RegistrationFacts): Promise<{ claimToken: string; claimKey: string }> {
  const claimToken = newPlatformToken();
  const record = tokenRecordOf('claim', claimToken, { channelArn: reg.channelArn, personArn: reg.personArn, issuer: reg.issuer, expiresAt: reg.expiresAt, registrationKey: reg.pk });
  await putToken(doc, table, record);
  return { claimToken, claimKey: record.pk };
}

/** The claim's email, to the registered address. */
function sendClaimFor(reg: RegistrationFacts, address: string, claimToken: string, d: UpgradeDeps): Promise<boolean> {
  return sendClaimEmail({ personArn: reg.personArn, channelArn: reg.channelArn, address, name: reg.fields.name, link: claimLinkOf(appUrlOf(d), claimToken) }, d);
}

// ── REGISTER ─────────────────────────────────────────────────────────────────────────────────────

export async function register(event: any, d: UpgradeDeps = {}): Promise<HttpResult> {
  const caller = await callerPerson(event, { guest: true });
  if (!caller || !isGuestIssuer(caller.issuer)) return refuse(403, 'GUEST_ONLY', 'a registration is made from a visitor\'s own conversation');
  const target = claimTargetOf(GUEST_VISITOR_TYPE);
  if (!target) return refuse(403, 'CLAIM_NOT_DECLARED', 'this deployment declares no registration for a visitor');
  const table = tableOf(d);
  const appInstanceArn = instanceOf(d);
  if (!table || !appInstanceArn || !appUrlOf(d)) return refuse(500, 'SERVER_MISCONFIG', 'the token store or the chat app is not configured');
  const channelId = typeof edgeCallerOf(event)?.claims?.ch === 'string' ? String(edgeCallerOf(event)!.claims.ch) : '';
  if (!channelId || !/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) return refuse(403, 'GUEST_NO_CONVERSATION', 'the guest token names no conversation');
  const channelArn = `${appInstanceArn}/channel/${channelId}`;
  const personArn = caller.personArn ?? userArnFor(appInstanceArn, caller.personId);
  const body = bodyOf(event);
  const fields = registrationFieldsOf(body?.fields);
  const address = registrationAddressOf(body?.email);
  if (!fields || !address) return refuse(400, 'REGISTRATION_INVALID', 'a registration carries a name, and the address its sign-in link is sent to');

  const doc = docOf(d);
  const now = Math.floor((d.now ?? Date.now)() / 1000);
  const expiresAt = now + REGISTRATION_DAYS * 86_400;
  const regKey = registrationKeyOf(channelArn);
  const approval = approvalOf(d);
  try {
    const existing = await readTokenRecord(doc, table, regKey);
    if (existing && existing.personArn !== personArn) return refuse(403, 'REGISTRATION_NOT_YOURS', 'this conversation was registered by somebody else');
    if (existing?.status === 'claimed') return refuse(409, 'REGISTRATION_CLAIMED', 'this registration was already claimed');
    // AN ANONYMOUS VISITOR TYPES THE ADDRESS, so one visit sends a bounded number of emails: the route is not a
    // relay to arbitrary inboxes. Each visit is already behind the captcha and the per-address start limit.
    const sends = Number(existing?.sends || 0);
    if (sends >= MAX_CLAIM_EMAILS_PER_VISIT) return refuse(429, 'REGISTRATION_LIMIT', 'this visit has sent as many sign-in links as it may');
    const registrationId = typeof existing?.registrationId === 'string' ? existing.registrationId : randomUUID();
    const base: TokenRecord = {
      ...tokenRecordOf('registration', channelArn, { channelArn, personArn, issuer: caller.issuer!.id, expiresAt }),
      registrationId,
      fields,
      sourceType: GUEST_VISITOR_TYPE,
      sends: sends + 1,
    };
    // THE VISITOR'S OWN, AND NOT YET CLAIMED: written over only by the visitor who wrote it.
    const put = (item: TokenRecord) => doc.send(new PutCommand({
      TableName: table,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) OR (personArn = :p AND #s IN (:open, :awaiting))',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':p': personArn, ':open': 'open', ':awaiting': 'awaiting-approval' },
    }));

    if (approval === 'admin') {
      // HELD FOR AN OPERATOR, with the address the link will go to. No claim exists until it is approved.
      await put({ ...base, status: 'awaiting-approval', deliverTo: address, [APPROVAL_QUEUE_ATTRIBUTE]: AWAITING });
      await revokeClaim(doc, table, existing?.claimKey, now, 're-registered');
      return http.respond(200, { registrationId, status: 'awaiting-approval', into: target.typeKey });
    }

    // THE CLAIM, THEN THE RECORD NAMING IT, THEN THE EMAIL: a link that arrives always redeems.
    const facts: RegistrationFacts = { pk: regKey, channelArn, personArn, issuer: caller.issuer!.id, expiresAt, fields };
    const { claimToken, claimKey } = await issueClaim(doc, table, facts);
    await put({ ...base, status: 'open', claimKey });
    // THE CLAIM ISSUED BEFORE NO LONGER REDEEMS.
    await revokeClaim(doc, table, existing?.claimKey, now, 're-registered');
    if (!(await sendClaimFor(facts, address, claimToken, d))) {
      return refuse(503, 'CLAIM_EMAIL_UNSENT', 'the registration is kept, and its sign-in link could not be emailed; register again to resend it');
    }
    // THE FUNNEL (B12): the claim is issued, on the visitor and their conversation's journey.
    await recordFunnelStage({ stage: 'claim_sent', personArn, journeyChannelArn: channelArn }, d.funnel);
    return http.respond(200, { registrationId, status: 'sent', into: target.typeKey });
  } catch (err) {
    if (nameOf(err) === 'ConditionalCheckFailedException') return refuse(409, 'REGISTRATION_CLAIMED', 'this registration changed meanwhile');
    console.error('[GuestUpgrade] registration failed', { err: nameOf(err) });
    return refuse(503, 'REGISTRATION_UNAVAILABLE', 'the registration could not be written');
  }
}

// ── CLAIM ────────────────────────────────────────────────────────────────────────────────────────

export async function claim(event: any, d: UpgradeDeps = {}): Promise<HttpResult> {
  // A GUEST, A ONE-CONVERSATION PERSON AND A HOST ASSERTION RESOLVE TO NOBODY HERE.
  const caller = await callerPerson(event);
  if (!caller) return refuse(401, 'UNAUTHENTICATED', 'a claim is redeemed by a signed-in account');
  const table = tableOf(d);
  const appInstanceArn = instanceOf(d);
  if (!table || !appInstanceArn) return refuse(500, 'SERVER_MISCONFIG', 'the token store is not configured');
  const personArn = caller.personArn ?? userArnFor(appInstanceArn, caller.personId);
  const body = bodyOf(event);
  const token = typeof body?.claimToken === 'string' ? body.claimToken : '';
  if (!token || token.length > 128) return refuse(400, 'CLAIM_INVALID', 'claimToken is required');
  const target = claimTargetOf(GUEST_VISITOR_TYPE);
  if (!target) return refuse(403, 'CLAIM_NOT_DECLARED', 'this deployment declares no registration claim');

  const doc = docOf(d);
  const now = Math.floor((d.now ?? Date.now)() / 1000);
  const claimPk = tokenKey('claim', token);

  // 1. THE CLAIM AND ITS REGISTRATION, read before anything is consumed.
  const claimRecord = await readTokenRecord(doc, table, claimPk);
  if (!claimRecord || claimRecord.kind !== 'claim') return refuse(404, 'CLAIM_UNKNOWN', 'no such claim');
  if (claimRecord.consumedAt !== undefined) return refuse(409, 'CLAIM_USED', 'this claim was already used');
  if (!(claimRecord.expiresAt > now)) return refuse(410, 'CLAIM_EXPIRED', 'this claim has expired');
  const registration = await readTokenRecord(doc, table, String(claimRecord.registrationKey || ''));
  if (!registration || registration.kind !== 'registration' || registration.claimKey !== claimPk) return refuse(409, 'CLAIM_USED', 'this claim no longer redeems its registration');
  if (registration.status !== 'open') return refuse(409, 'REGISTRATION_CLAIMED', 'this registration was already claimed');
  if (!(registration.expiresAt > now)) return refuse(410, 'CLAIM_EXPIRED', 'this registration has expired');
  if (registration.personArn === personArn) return refuse(403, 'CLAIM_BY_THE_VISITOR', 'a visitor\'s own session cannot claim their registration');

  // 2. THE ACCOUNT MUST REACH WHAT IT IS ABOUT TO BE GIVEN.
  const holder = callerHolderToken(event);
  if (!holder || !profiles.grantsFor(holder).includes(target.classification)) {
    console.warn('[GuestUpgrade][SecurityEvent] a claim by an account whose clearance does not reach the target; nothing consumed', { target: target.classification });
    return refuse(403, 'NOT_CLEARED_FOR_TARGET', 'this account cannot hold the conversation this claim opens');
  }
  // 2b. AND THE TARGET TYPE ADMITS THE ISSUER THEY SIGNED IN THROUGH (T1, FR23), after the clearance check.
  if (!typeAdmitsIssuers(target.typeKey, caller.issuer ? [caller.issuer.id] : [])) {
    console.warn('[GuestUpgrade] a claim by an account of an issuer the target type does not admit; nothing consumed', { target: target.typeKey });
    return refuse(403, 'ISSUER_NOT_ADMITTED', 'conversations of this kind do not admit people who sign in this way');
  }
  const creator = await creatorOf(d, target.classification);
  if (!creator) return refuse(500, 'SERVER_MISCONFIG', 'no creator is configured for the claim\'s conversation');

  // 3. REDEEMED ONCE.
  const redeemed = await redeemToken(doc, table, 'claim', token, { now, extra: { claimedBy: personArn } });
  if (!redeemed.ok) return refuse(redeemed.reason === 'expired' ? 410 : 409, redeemed.reason === 'expired' ? 'CLAIM_EXPIRED' : 'CLAIM_USED', 'this claim cannot be redeemed');

  // 4. THE ASSISTANT'S ACCOUNT OF THE VISIT (FR26), or none: the carry-over goes ahead either way (tenet D5).
  const lambda = lambdaOf(d);
  const guestCreator = await guestCreatorOf(d);
  const guestClassification = guestClassificationOf(d);
  const fields = (registration.fields as RegistrationFields | undefined) ?? null;
  const assessment = guestCreator && guestClassification
    ? await assessVisit(lambda, guestCreator, { classification: guestClassification, channelArn: registration.channelArn, fields })
    : null;

  // 5. THE CUSTOMER'S CONVERSATION.
  const created = await openUpgradeConversation(lambda, creator, {
    kind: 'upgrade',
    classification: target.classification,
    userArn: personArn,
    sourceChannelArn: registration.channelArn,
    sourcePersonArn: registration.personArn,
    seed: visitSeedOf(registration, assessment),
  });
  if (!created?.ok || !created.channelArn) {
    // UNDONE, so the claim can be tried again.
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: { pk: claimPk },
      UpdateExpression: 'REMOVE consumedAt, claimedBy',
      ConditionExpression: 'claimedBy = :me',
      ExpressionAttributeValues: { ':me': personArn },
    })).catch((err: unknown) => console.error('[GuestUpgrade] a failed claim could not be undone', { err: nameOf(err) }));
    return refuse(503, 'CLAIM_UNAVAILABLE', `the conversation could not be opened: ${created?.error || 'no answer'}`);
  }

  // 6. THE REGISTRATION IS CLAIMED.
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: { pk: registration.pk },
    UpdateExpression: 'SET #s = :claimed, claimedAt = :now, claimedBy = :me, conversationArn = :c',
    ConditionExpression: '#s = :open',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':claimed': 'claimed', ':open': 'open', ':now': now, ':me': personArn, ':c': created.channelArn },
  })).catch((err: unknown) => console.error('[GuestUpgrade] the registration could not be marked claimed', { err: nameOf(err) }));
  // 7. THE SEED IS WRITTEN, SO THE VISITOR'S CONVERSATION GOES. Best-effort: it lapses on its own otherwise.
  if (guestCreator && guestClassification) await retireVisit(lambda, guestCreator, { classification: guestClassification, channelArn: registration.channelArn });
  // THE FUNNEL (B12): on the account, and on the visitor's journey, which the new conversation's
  // `upgradedFrom` tag names too, so path B is joined by the conversation and never by an address.
  await recordFunnelStage({ stage: 'claim_redeemed', personArn, journeyChannelArn: registration.channelArn }, d.funnel);
  return http.respond(200, { conversationArn: created.channelArn, type: target.typeKey, sourceChannelArn: registration.channelArn });
}

// ── THE CONSOLE: REGISTRATIONS WAITING FOR AN OPERATOR ───────────────────────────────────────────

/** What the console is shown of a waiting registration: what the visitor registered, and when. */
export interface RegistrationView {
  registrationId: string;
  fields: RegistrationFields;
  /** The address the sign-in link will go to, shown so the operator knows whom they approve. */
  deliverTo: string;
  createdAt: string;
  expiresAt: number;
}

export type AdminRegistrationOp =
  | { op: 'admin-list-registrations' }
  | { op: 'admin-approve-registration'; registrationId: string; actor: string };

const answer = (status: number, body: unknown) => ({ status, body });

async function awaitingRegistrations(doc: Sender, table: string): Promise<TokenRecord[]> {
  const out: TokenRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: REGISTRATIONS_AWAITING_APPROVAL,
      KeyConditionExpression: '#q = :awaiting',
      ExpressionAttributeNames: { '#q': APPROVAL_QUEUE_ATTRIBUTE },
      ExpressionAttributeValues: { ':awaiting': AWAITING },
      ExclusiveStartKey,
    }));
    out.push(...((page?.Items ?? []) as TokenRecord[]));
    ExclusiveStartKey = page?.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < 500);
  return out;
}

export async function adminOperation(req: AdminRegistrationOp, d: UpgradeDeps = {}): Promise<{ status: number; body: unknown }> {
  if (approvalOf(d) !== 'admin') return answer(404, { error: 'this deployment approves no registration', code: 'APPROVAL_NOT_DECLARED' });
  const table = tableOf(d);
  if (!table || !appUrlOf(d)) return answer(500, { error: 'the token store or the chat app is not configured', code: 'SERVER_MISCONFIG' });
  const doc = docOf(d);
  const now = Math.floor((d.now ?? Date.now)() / 1000);
  const waiting = (await awaitingRegistrations(doc, table)).filter((r) => r.status === 'awaiting-approval' && r.expiresAt > now);
  if (req.op === 'admin-list-registrations') {
    const registrations: RegistrationView[] = waiting.map((r) => ({
      registrationId: String(r.registrationId), fields: r.fields as RegistrationFields, deliverTo: String(r.deliverTo || ''), createdAt: r.createdAt, expiresAt: r.expiresAt,
    }));
    return answer(200, { registrations });
  }
  const id = typeof req.registrationId === 'string' ? req.registrationId : '';
  if (!/^[0-9a-f-]{36}$/i.test(id) || !req.actor) return answer(400, { error: 'registrationId names one registration, approved by a person', code: 'REGISTRATION_INVALID' });
  const reg = waiting.find((r) => r.registrationId === id);
  if (!reg) return answer(404, { error: 'no registration is waiting under that id', code: 'REGISTRATION_UNKNOWN' });
  const address = registrationAddressOf(reg.deliverTo);
  if (!address) return answer(409, { error: 'the registration holds no address to send its link to', code: 'REGISTRATION_INVALID' });
  try {
    const facts: RegistrationFacts = { pk: reg.pk, channelArn: reg.channelArn, personArn: reg.personArn, issuer: reg.issuer, expiresAt: reg.expiresAt, fields: reg.fields as RegistrationFields };
    const { claimToken, claimKey } = await issueClaim(doc, table, facts);
    // SENT BEFORE THE RECORD MOVES, so a mail that cannot be sent leaves the registration waiting with its address.
    if (!(await sendClaimFor(facts, address, claimToken, d))) {
      await revokeClaim(doc, table, claimKey, now, 'unsent');
      return answer(503, { error: 'the sign-in link could not be emailed; the registration still waits', code: 'CLAIM_EMAIL_UNSENT' });
    }
    // OPEN, NAMING ITS CLAIM, AND THE ADDRESS FORGOTTEN: it was a route for this one email.
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: { pk: reg.pk },
      UpdateExpression: `SET #s = :open, claimKey = :k, approvedAt = :now, approvedBy = :actor REMOVE deliverTo, ${APPROVAL_QUEUE_ATTRIBUTE}`,
      ConditionExpression: '#s = :awaiting AND registrationId = :id',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':open': 'open', ':awaiting': 'awaiting-approval', ':k': claimKey, ':now': now, ':actor': req.actor, ':id': id },
    }));
    console.log(JSON.stringify({ _auditEvent: 'registration_approved', actor: req.actor, registrationId: id, journeyChannelArn: reg.channelArn }));
    await recordFunnelStage({ stage: 'claim_sent', personArn: reg.personArn, journeyChannelArn: reg.channelArn }, d.funnel);
    return answer(200, { registrationId: id, status: 'sent' });
  } catch (err) {
    if (nameOf(err) === 'ConditionalCheckFailedException') return answer(409, { error: 'the registration changed meanwhile', code: 'REGISTRATION_CHANGED' });
    console.error('[GuestUpgrade] an approval failed', { err: nameOf(err) });
    return answer(503, { error: 'the approval could not be written', code: 'REGISTRATION_UNAVAILABLE' });
  }
}

export const handler = async (event: any): Promise<HttpResult | { status: number; body: unknown }> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  // A DIRECT INVOCATION from the admin backend: never a gateway request, which always carries a route.
  if (event?.op === 'admin-list-registrations' || event?.op === 'admin-approve-registration') return adminOperation(event as AdminRegistrationOp);
  if (event?.httpMethod === 'OPTIONS') return http.empty(204);
  const route = String(event?.resource || event?.path || '');
  if (route === REGISTER_ROUTE) return register(event);
  if (route === CLAIM_ROUTE) return claim(event);
  return refuse(404, 'NOT_FOUND', 'no such route');
};
