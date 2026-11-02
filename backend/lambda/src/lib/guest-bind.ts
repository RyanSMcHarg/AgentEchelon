/**
 * PATH A, THE BIND: a visitor signs in while their guest session is live, and the guest AppInstanceUser
 * becomes the account (PLAN §16.5 P-11, B6).
 *
 * One call presents both: the sign-in token on `Authorization`, which the edge verified and found no
 * `Identities` row for (a first sign-in), and the visit's sign-in hand-off in the body: its nonce and its
 * secret. The hand-off (`guest-bind` in `Tokens`) is minted by the guest refresh the widget makes as the
 * visitor signs in, single-use and ten minutes long; it names the refresh credential that refresh issued,
 * which is what proves the guest session is live (single-use, server-side and bound to the visitor's
 * AppInstanceUser and conversation, `lib/tokens.ts`), and the hash of a secret the widget keeps in the page.
 *
 * ── THE SIGN-IN STARTS FROM THE WIDGET SESSION THAT OWNS THE VISIT ──────────────────────────────
 *
 * The link the widget opens carries the nonce alone (`#bindNonce=`). The secret goes only to the chat app
 * tab the widget itself opened, over `postMessage` between the two windows, after the widget has checked
 * the tab's origin and that it is the window it opened. So a link copied out of the address bar or
 * forwarded to anybody, opened in another browser or another tab, carries no secret and binds nothing: the
 * secret's hash must match the record's, and the record is consumed by the bind. The refresh credential
 * never leaves the widget.
 *
 * ── IN THIS ORDER ────────────────────────────────────────────────────────────────────────────────
 *
 *  1. The deployment declares a guest issuer and the visitor's conversation type declares `bind` (T2).
 *     Nothing else is asked of the visitor: signing in from the widget is the whole act (the owner's
 *     decision that a guest never opts in to keeping their visit). The refusals below are what make an
 *     unasked bind safe.
 *  2. The signing-in subject has no `Identities` row and no revoked marker. A subject with a row is an
 *     existing account, which is path B: refused, which also closes login CSRF (an attacker's sign-in
 *     cannot be bound to a victim's visit, nor a victim's account to an attacker's visit).
 *  3. The refresh credential is unconsumed and unexpired, its visit has not ended, its family is active,
 *     and its subject's guest row is active and names the same AppInstanceUser.
 *  4. The AppInstanceUser's expiration is removed (`PutAppInstanceUserExpirationSettings` with no
 *     `ExpirationSettings`): a visitor expires a day after creation, and a customer must not.
 *  5. ONE TRANSACTION: the refresh credential is consumed, the family is revoked (so every credential in
 *     it, the latest included, is refused at its next refresh), the signing-in subject's row is written
 *     naming the guest AppInstanceUser, and the guest issuer's row is deleted, so the guest credential
 *     ends. Any condition failing cancels all four, and the expiration is put back.
 *  6. The bind is written to the access log (actor, issuer, AppInstanceUser ARN, time).
 *  7. THE VISIT CONTINUES IN A NEW CONVERSATION (`continueBoundVisit`). The account is vended at its own
 *     classification, which never includes the visitor's, so the visitor's conversation is out of its
 *     reach and stays so. The exchange opens a conversation at the account's classification through that
 *     classification's creator (`bindTargetOf`), tagged `upgradedFrom` and `upgradedFromPerson` and seeded
 *     from the visit exactly as a claim's is (`lib/upgrade.ts`), and answers with it. Its channel id is
 *     deterministic from the visitor's conversation, so the same call retried after a failure here
 *     (`boundVisitOf` recognizes it) opens the same one. Erasure follows the tags (`lib/offboarding.ts`).
 *     The seed is the visitor's assistant's assessment of the visit and the visit's registered fields, if
 *     any (FR26); without an assessment, the fields alone. Once it is open, the visitor's conversation is
 *     deleted (`retireVisit`).
 *
 * The visitor's guest-session AWS credential, vended before the bind, lasts out its own 15 minutes; it
 * reaches the one conversation it always did, as the same AppInstanceUser.
 *
 * ── THE O13 ANSWER IS OWED ───────────────────────────────────────────────────────────────────────
 *
 * Whether `PutAppInstanceUserExpirationSettings` with no settings removes an existing expiration is the
 * open question O13, probed live in W18. If it cannot, the fallback is to create visitors
 * without an expiration and sweep the unbound ones; that fallback is **NOT BUILT**.
 */
import { TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PutAppInstanceUserExpirationSettingsCommand } from '@aws-sdk/client-chime-sdk-identity';
import { bindTargetOf, upgradePathsOf, GUEST_VISITOR_TYPE } from '../../../lib/config/conversation-types.js';
import { identityStateOf, issuerSubjectKey, revokedMarkerKey, type IdentityRow, type MintedPerson } from './person-identity.js';
import { personIdFromArn } from './person-arn.js';
import { readTokenRecord, tokenKey, type TokenRecord } from './tokens.js';
import { createHash, timingSafeEqual } from 'crypto';
import { recordAccess, type AccessAuditLine } from './access-log.js';
import { recordFunnelStage, type FunnelSink } from './funnel.js';
import { familyKey, guestBindCreatorOf, guestConfigFromEnv, guestCreatorOf, guestTokensTable, type GuestConfig } from '../guest-session.js';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { assessVisit, openUpgradeConversation, readVisitRegistration, retireVisit, visitSeedOf, type RegistrationFields } from './upgrade.js';

type Sender = { send(command: unknown): Promise<any> };

/** Why a bind was refused, with the status the exchange answers. Nothing was changed for any of them. */
export const BIND_REFUSALS = {
  /** No guest issuer, or the visitor's conversation type declares no `bind`. */
  BIND_NOT_DECLARED: 403,
  /** The sign-in's issuer never mints on a first sign-in (a provisioned-only host): it cannot become a visitor's account. */
  BIND_NOT_SUPPORTED: 403,
  /** The signing-in subject already has an `Identities` row: an existing account, which is path B. */
  SUBJECT_ALREADY_BOUND: 409,
  /** The refresh credential, its family or the visitor's row is not live. */
  GUEST_SESSION_NOT_LIVE: 401,
  /** No live hand-off answers to the nonce and secret: a forwarded or copied link, or one already used. */
  BIND_NOT_HANDED_OFF: 403,
  /** The expiration could not be removed, or a store could not answer. */
  BIND_UNAVAILABLE: 503,
} as const;
export type BindRefusalCode = keyof typeof BIND_REFUSALS;

export class BindRefused extends Error {
  readonly status: number;
  constructor(readonly code: BindRefusalCode, detail: string) {
    super(detail);
    this.name = 'BindRefused';
    this.status = BIND_REFUSALS[code];
  }
}

/**
 * What the body of an exchange call asks for when it binds: `{ bindGuest: { nonce, secret } }`, the visit's
 * sign-in hand-off. A refresh credential is never accepted here: one that travelled in a link could be
 * forwarded, so a body naming `refreshToken` is malformed.
 */
export interface BindRequest {
  nonce: string;
  secret: string;
}

const isBounded = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

/** The bind a request body asks for, or null when it asks for none. A malformed one is refused, not ignored. */
export function bindRequestOf(body: unknown): BindRequest | null | 'malformed' {
  const b = (body && typeof body === 'object' ? (body as Record<string, unknown>).bindGuest : undefined) as Record<string, unknown> | undefined;
  if (b === undefined) return null;
  if (!b || typeof b !== 'object' || b.refreshToken !== undefined || !isBounded(b.nonce) || !isBounded(b.secret)) return 'malformed';
  return { nonce: b.nonce, secret: b.secret };
}

/** The base64url SHA-256 of a hand-off secret, as the guest refresh stored it. */
export function bindSecretHashOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/**
 * The hand-off a nonce names, when its secret matches: the record, or null for a nonce nobody minted, another
 * issuer's, or a secret that is not its own. Live or not is the caller's question.
 */
async function handOffOf(doc: Sender, tokensTable: string, issuerId: string, request: BindRequest): Promise<TokenRecord | null> {
  const record = await readTokenRecord(doc, tokensTable, tokenKey('guest-bind', request.nonce));
  if (!record || record.kind !== 'guest-bind' || record.issuer !== issuerId || typeof record.secretHash !== 'string' || typeof record.refreshPk !== 'string') return null;
  const want = Buffer.from(record.secretHash, 'utf8');
  const got = Buffer.from(bindSecretHashOf(request.secret), 'utf8');
  return want.length === got.length && timingSafeEqual(want, got) ? record : null;
}

export interface BindDeps {
  config?: GuestConfig | null;
  doc?: Sender;
  chime?: Sender;
  identitiesTable?: string;
  tokensTable?: string;
  appInstanceArn?: string;
  now?: () => number;
  identityState?: typeof identityStateOf;
  audit?: (line: AccessAuditLine) => Promise<unknown>;
  /** Where the funnel's stages are archived (B12). Default the archive. */
  funnel?: FunnelSink;
}

export interface BoundPerson extends MintedPerson {
  /** The visitor's conversation, which the account keeps as the same AppInstanceUser. */
  guestChannelArn: string;
}

const nameOf = (err: unknown): string => (err as { name?: string })?.name || '';

/**
 * Bind the visitor whose refresh credential this is to the signing-in subject `(issuer, subject)`.
 * Throws `BindRefused`; on success the subject signs in as the visitor's AppInstanceUser from now on.
 */
export async function bindGuestPerson(
  input: { issuer: string; subject: string; request: BindRequest },
  deps: BindDeps & { doc: Sender; chime: Sender },
): Promise<BoundPerson> {
  const c = deps.config === undefined ? guestConfigFromEnv() : deps.config;
  if (!c || !upgradePathsOf(GUEST_VISITOR_TYPE).includes('bind')) throw new BindRefused('BIND_NOT_DECLARED', 'this deployment binds no visitor');
  if (input.issuer === c.issuerId) throw new BindRefused('BIND_NOT_SUPPORTED', 'a guest token is not an account');
  const identitiesTable = deps.identitiesTable ?? process.env.IDENTITIES_TABLE ?? '';
  if (!identitiesTable) throw new BindRefused('BIND_UNAVAILABLE', 'IDENTITIES_TABLE is not set');
  const nowMs = (deps.now ?? Date.now)();
  const now = Math.floor(nowMs / 1000);
  const doc = deps.doc;

  // 2. AN EXISTING ACCOUNT IS PATH B. Read consistently, whatever the edge's cached answer said.
  const key = issuerSubjectKey(input.issuer, input.subject);
  const readItem = async (k: string) => (await doc.send(new GetCommand({ TableName: identitiesTable, Key: { issuerSubject: k }, ConsistentRead: true })))?.Item as IdentityRow | undefined;
  if (await readItem(key)) throw new BindRefused('SUBJECT_ALREADY_BOUND', 'this sign-in already has an account; a registration claim carries the visit into it');
  if (await readItem(revokedMarkerKey(input.issuer, input.subject))) throw new BindRefused('SUBJECT_ALREADY_BOUND', 'this sign-in was offboarded');

  // 3. THE GUEST SESSION IS LIVE.
  let tokensTable: string;
  try {
    tokensTable = deps.tokensTable ?? await guestTokensTable(c);
  } catch (err) {
    throw new BindRefused('BIND_UNAVAILABLE', `the token store could not be found: ${nameOf(err) || 'error'}`);
  }
  // THE HAND-OFF: the nonce with its own secret, unused and unexpired. Anything else is a link that did not
  // come from the widget session that owns the visit.
  const handOff = await handOffOf(doc, tokensTable, c.issuerId, input.request);
  if (!handOff || handOff.consumedAt !== undefined || !(handOff.expiresAt > now)) {
    throw new BindRefused('BIND_NOT_HANDED_OFF', 'this sign-in did not start from the visit\'s own widget, or its hand-off was used or has expired');
  }
  const handOffPk = handOff.pk;
  const refreshPk = String(handOff.refreshPk);
  const refresh = await readTokenRecord(doc, tokensTable, refreshPk);
  const notLive = (why: string) => new BindRefused('GUEST_SESSION_NOT_LIVE', why);
  if (refresh && refresh.personArn !== handOff.personArn) throw notLive('the hand-off names another visit');
  if (!refresh || refresh.kind !== 'guest-refresh' || refresh.issuer !== c.issuerId) throw notLive('no such guest session');
  if (refresh.consumedAt !== undefined) throw notLive('the refresh credential was already used');
  if (!(refresh.expiresAt > now) || !(Number(refresh.sessionEndsAt) > now)) throw notLive('the guest session has ended');
  const family = await readTokenRecord(doc, tokensTable, familyKey(String(refresh.familyId)));
  if (!family || family.status !== 'active') throw notLive('the guest session was revoked');
  const guestSubject = String(refresh.subject || '');
  const guestState = await (deps.identityState ?? identityStateOf)(c.issuerId, guestSubject, { doc, table: identitiesTable, appInstanceArn: deps.appInstanceArn });
  if (guestState.state !== 'active' || guestState.personArn !== refresh.personArn) throw notLive('the visitor is no longer active');
  const personArn = refresh.personArn;
  const personId = personIdFromArn(personArn);
  if (!personId) throw notLive('the guest session names no AppInstanceUser');

  // 4. A CUSTOMER DOES NOT EXPIRE. Removed before the transaction, so a failure here changes nothing.
  try {
    await deps.chime.send(new PutAppInstanceUserExpirationSettingsCommand({ AppInstanceUserArn: personArn }));
  } catch (err) {
    throw new BindRefused('BIND_UNAVAILABLE', `the visitor's expiration could not be removed: ${nameOf(err) || 'error'}`);
  }

  // 5. ONE TRANSACTION, or nothing.
  const at = new Date(nowMs).toISOString();
  const row: IdentityRow & { boundFrom: string } = {
    issuerSubject: key, personArn, issuer: input.issuer, status: 'active', createdAt: at, boundFrom: c.issuerId,
  };
  try {
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        { Update: {
          TableName: tokensTable,
          Key: { pk: refreshPk },
          UpdateExpression: 'SET consumedAt = :now',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(consumedAt) AND expiresAt > :now',
          ExpressionAttributeValues: { ':now': now },
        } },
        { Update: {
          TableName: tokensTable,
          Key: { pk: familyKey(String(refresh.familyId)) },
          UpdateExpression: 'SET #s = :revoked, revokedAt = :now, revokedBy = :bind',
          ConditionExpression: '#s = :active',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':revoked': 'revoked', ':active': 'active', ':now': now, ':bind': 'bind' },
        } },
        { Put: { TableName: identitiesTable, Item: row, ConditionExpression: 'attribute_not_exists(issuerSubject)' } },
        { Delete: {
          TableName: identitiesTable,
          Key: { issuerSubject: issuerSubjectKey(c.issuerId, guestSubject) },
          ConditionExpression: 'personArn = :p AND #s = :active',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':p': personArn, ':active': 'active' },
        } },
        // THE HAND-OFF IS SPENT WITH THE BIND: presented again, it binds nothing.
        { Update: {
          TableName: tokensTable,
          Key: { pk: handOffPk },
          UpdateExpression: 'SET consumedAt = :now',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(consumedAt) AND expiresAt > :now',
          ExpressionAttributeValues: { ':now': now },
        } },
      ],
    }));
  } catch (err) {
    // PUT THE EXPIRATION BACK, ONLY ON A VISITOR WHO IS STILL ONE. A concurrent bind of the same hand-off (a
    // retry while the first call still runs) may have committed and deleted the guest row: restoring the
    // expiration then would expire the customer it just bound. So the guest row is read again, consistently,
    // and the expiration goes back only while it still names this AppInstanceUser.
    try {
      const guestRow = await readItem(issuerSubjectKey(c.issuerId, guestSubject));
      if (guestRow && guestRow.personArn === personArn && guestRow.status === 'active') {
        await deps.chime.send(new PutAppInstanceUserExpirationSettingsCommand({
          AppInstanceUserArn: personArn, ExpirationSettings: { ExpirationDays: 1, ExpirationCriterion: 'CREATED_TIMESTAMP' },
        }));
      }
    } catch (restoreErr) {
      console.error('[GuestBind][SecurityEvent] a refused bind could not restore the visitor\'s expiration', { personArn, err: nameOf(restoreErr) });
    }
    if (nameOf(err) === 'TransactionCanceledException') {
      const reasons = ((err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((r) => r?.Code);
      if (reasons[2] === 'ConditionalCheckFailed') throw new BindRefused('SUBJECT_ALREADY_BOUND', 'this sign-in was bound by another call');
      throw notLive('the guest session changed while it was being bound');
    }
    throw new BindRefused('BIND_UNAVAILABLE', `the bind could not be written: ${nameOf(err) || 'error'}`);
  }

  // 6. THE RECORD. Best-effort, as every Identities write's is: the bind has happened.
  const line: AccessAuditLine = {
    _auditEvent: 'identity_bound_guest', timestamp: at, personId: 'credential-exchange', issuer: input.issuer, personArn, fromIssuer: c.issuerId,
  };
  console.log(JSON.stringify(line));
  try {
    await (deps.audit ?? ((l: AccessAuditLine) => recordAccess(l)))(line);
  } catch (err) {
    console.error('[GuestBind][SecurityEvent] the bind could not be written to the access log', { personArn, err: nameOf(err) });
  }
  // THE FUNNEL (B12): under path A the visitor's AppInstanceUser is the account, so the journey is theirs.
  await recordFunnelStage({ stage: 'guest_bound', personArn, journeyChannelArn: refresh.channelArn }, deps.funnel);
  return { personId, personArn, created: false, guestChannelArn: refresh.channelArn };
}

/**
 * A RETRIED BIND: the signing-in subject is already this visit's account. True of a refresh credential of
 * the visit whose family a bind revoked, presented by the AppInstanceUser it names. The visitor's
 * conversation, or null for anything else (which the exchange refuses as an existing account's, path B).
 */
export async function boundVisitOf(
  input: { personId: string; request: BindRequest },
  deps: { config?: GuestConfig | null; doc: Sender; tokensTable?: string },
): Promise<string | null> {
  const c = deps.config === undefined ? guestConfigFromEnv() : deps.config;
  if (!c) return null;
  try {
    const tokensTable = deps.tokensTable ?? await guestTokensTable(c);
    // THE SAME HAND-OFF, its own secret, already spent by the bind this call retries.
    const handOff = await handOffOf(deps.doc, tokensTable, c.issuerId, input.request);
    if (!handOff || handOff.consumedAt === undefined) return null;
    const refresh = await readTokenRecord(deps.doc, tokensTable, String(handOff.refreshPk));
    if (!refresh || refresh.kind !== 'guest-refresh' || refresh.issuer !== c.issuerId || refresh.consumedAt === undefined) return null;
    if (personIdFromArn(refresh.personArn) !== input.personId || typeof refresh.channelArn !== 'string') return null;
    const family = await readTokenRecord(deps.doc, tokensTable, familyKey(String(refresh.familyId)));
    if (!family || family.status !== 'revoked' || family.revokedBy !== 'bind') return null;
    return refresh.channelArn;
  } catch (err) {
    console.error('[GuestBind] a retried bind could not be read; answered as an existing account', { err: nameOf(err) });
    return null;
  }
}

let defaultLambda: Sender | null = null;

/**
 * 7. THE VISIT CONTINUES: open (or re-open) the bound person's conversation at their own classification,
 * through that classification's creator, tagged with the visitor's conversation and AppInstanceUser, and
 * seeded from the visit. The new conversation, or why there is none. Never the visitor's classification:
 * `bindTargetOf` refuses it, and so does the creator.
 */
export async function continueBoundVisit(
  input: { personArn: string; guestChannelArn: string; classification: string },
  deps: { config?: GuestConfig | null; doc: Sender; lambda?: Sender; tokensTable?: string; creators?: Record<string, string>; guestCreator?: string },
): Promise<{ ok: true; conversationArn: string } | { ok: false; why: string }> {
  const c = deps.config === undefined ? guestConfigFromEnv() : deps.config;
  if (!c) return { ok: false, why: 'this deployment binds no visitor' };
  const target = bindTargetOf(GUEST_VISITOR_TYPE, input.classification);
  if (!target) return { ok: false, why: `no conversation continues a visit at "${input.classification}"` };
  try {
    const [creator, tokensTable, guestCreator] = await Promise.all([
      deps.creators ? deps.creators[input.classification] : guestBindCreatorOf(c, input.classification),
      deps.tokensTable ?? guestTokensTable(c),
      deps.guestCreator ?? guestCreatorOf(c),
    ]);
    if (!creator) return { ok: false, why: `no creator continues a visit at "${input.classification}"` };
    const lambda = deps.lambda ?? (defaultLambda ??= new LambdaClient({}));
    const registration = await readVisitRegistration(deps.doc, tokensTable, input.guestChannelArn);
    // THE ASSISTANT'S ACCOUNT OF THE VISIT, or none: the carry-over goes ahead either way (tenet D5).
    const assessment = await assessVisit(lambda, guestCreator, {
      classification: c.classification,
      channelArn: input.guestChannelArn,
      fields: (registration?.fields as RegistrationFields | undefined) ?? null,
    });
    const seed = visitSeedOf(registration, assessment);
    const created = await openUpgradeConversation(lambda, creator, {
      kind: 'bind',
      classification: input.classification,
      userArn: input.personArn,
      sourceChannelArn: input.guestChannelArn,
      sourcePersonArn: input.personArn,
      seed,
    });
    if (!created?.ok || !created.channelArn) return { ok: false, why: created?.error || 'the creator did not answer' };
    console.log(JSON.stringify({ _auditEvent: 'guest_bind_continued', personArn: input.personArn, channelArn: created.channelArn, sourceChannelArn: input.guestChannelArn, assessed: !!assessment }));
    // THE SEED IS WRITTEN, SO THE VISITOR'S CONVERSATION GOES. Best-effort: it lapses on its own otherwise.
    await retireVisit(lambda, guestCreator, { classification: c.classification, channelArn: input.guestChannelArn });
    return { ok: true, conversationArn: created.channelArn };
  } catch (err) {
    return { ok: false, why: `the conversation could not be opened: ${nameOf(err) || 'error'}` };
  }
}
