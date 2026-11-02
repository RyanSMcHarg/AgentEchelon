/**
 * THE EXCHANGE'S HALF OF AN INVITATION (M-10, M-5): mint the invitee, show the landing page what it may
 * know, and redeem, once, in the declared mode only.
 *
 * Every entry point here runs on the credential exchange (`credential-exchange.ts`), on its function and its
 * role, because the exchange is the one minter of an AppInstanceUser and the one writer of `Identities`.
 *
 * ── MINTING THE INVITEE (`op: 'mint-invitee'`) ───────────────────────────────────────────────────
 *
 * A direct invocation from the invitations function (`invitations.ts`, in `Conversations`), the one principal
 * granted the invoke. It mints an AppInstanceUser with an expiration and no `Identities` row
 * (`mintInvitee`), and tags it with the conversation's classification, as guest start tags a visitor.
 *
 * ── THE LANDING PAGE'S READ (`POST /invitations/peek`) ───────────────────────────────────────────
 *
 * Unauthenticated: the token in the body is what is asked about, and the answer is what its holder may
 * know: the conversation's name, who invited them and as whom, the mode and whether it can still be used.
 * It CONSUMES NOTHING, and it is a `POST` because the token is never in a URL (M-5): the landing page reads
 * it from the fragment, which no server, access log or `Referer` receives.
 *
 * ── A `link` REDEMPTION (`POST /invitations/redeem`) ─────────────────────────────────────────────
 *
 * Unauthenticated, with the deployment's `invitation-link` issuer declared. In this order, and nothing later
 * runs when anything earlier refuses (L16, every control failing closed):
 *
 *  1. The kill switch (`paused`), the per-address limit (`rate_limited`) and the captcha (`captcha_failed`),
 *     each `unavailable` when it cannot answer.
 *  2. The record: an invitation, `link` mode, not revoked, redeemed or expired, issued by a person who is
 *     still active, at a classification the issuer declares and the type's `linkClassifications` holds.
 *  3. One conditional update consumes it (`redeemToken`, with the mode in its condition), so a forwarded link
 *     admits whoever redeems it first, once (`redeemed_elsewhere` for every later one).
 *  4. A session pinned to the invitee is vended for that one conversation on the `link` session role, under
 *     its permissions boundary, for `LINK_SESSION_MAX_MINUTES`. It is not renewed: when it ends, the landing
 *     page shows `ended`.
 *
 * ── A `sign-in` REDEMPTION (the exchange's body: `{ invitation }`) ───────────────────────────────
 *
 * A first sign-in presents the token, and the signing-in subject becomes the invitee's (`bindInvitation`):
 *
 *  1. The subject has no `Identities` row and no revoked marker. A subject that already has an account is
 *     refused (`wrong_account`) and nothing is bound: an existing account is added by sharing, never by a
 *     second binding (R13). So a `sign-in` redemption never binds a second IdP record to an AppInstanceUser.
 *  2. The record is a `sign-in` invitation, live, its inviter still active, and the subject's own clearance
 *     reaches the conversation's classification (`wrong_account` otherwise: they could not read it).
 *  3. The invitee's expiration is removed, then ONE TRANSACTION writes the subject's row naming the invitee
 *     and consumes the record. Either failing changes nothing, and the expiration is put back.
 *
 * The invitee is then vended like any person, as itself, and already a member of the conversation.
 */
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { PutAppInstanceUserExpirationSettingsCommand } from '@aws-sdk/client-chime-sdk-identity';
import { TURNSTILE_TEST_SECRET_PASS, type ResolvedInvitationLinkSettings } from '../../../lib/config/issuers.js';
import { invitationPolicyOf, typeAdmitsIssuers } from '../../../lib/config/conversation-types.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import {
  issuerSubjectKey, mintInvitee, revokedMarkerKey, subjectsOfPerson, type IdentityRow, type MintedPerson,
} from './person-identity.js';
import { personIdFromArn, userArnFor } from './person-arn.js';
import { readTokenRecord, redeemTokenKey, tokenKey } from './tokens.js';
import { invitationAliasOf, invitationMetric, invitationStatusOf, isInvitationRecord, refusalOf, type InvitationRecord, type InvitationRefusal } from './invitations.js';
import { GuestRefused, REFUSAL_STATUS, countAddressStart, readSecret, requireNotPaused, verifyCaptcha } from './guest-abuse.js';
import { recordAccess, type AccessAuditLine } from './access-log.js';
import { defaultDirectory } from './membership-source.js';
import { APP_INSTANCE_ARN, CHANNEL_PREFIX, chimeIdentity, credentialsOf, literalChannelId, reply, sts, tagIdentity } from './vend.js';
import type { HttpResult } from './http-response.js';

type Sender = { send(command: unknown): Promise<any> };

// ── CONFIGURATION, FROM THE STACK ────────────────────────────────────────────────────────────────

/** The `link` issuer's runtime settings, when the registry declares an `invitation-link` issuer. */
export interface LinkConfig {
  issuerId: string;
  /** The classifications a link session may be vended at: the issuer's `fixed` set. */
  reach: string[];
  settings: ResolvedInvitationLinkSettings;
  /** The `link` session role (`InvitationLinkIssuer`). */
  roleArn: string;
  killSwitchParameter: string;
  addressSaltSecret: string;
  abuseTableParameter: string;
  environment: string;
}

/** What every invitation entry point on the exchange reads. */
export interface InvitationConfig {
  /** The `Tokens` table's name parameter (Conversations deploys after Identity). */
  tokensTableParameter: string;
  /** Where a `sign-in` invitation's landing page sends its holder: the chat app. */
  signInUrl: string;
  link?: LinkConfig;
}

export function invitationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InvitationConfig | null {
  if (!env.INVITATION_CONFIG) return null;
  try {
    const c = JSON.parse(env.INVITATION_CONFIG) as InvitationConfig;
    if (!c.tokensTableParameter) return null;
    if (c.link && (!c.link.roleArn || !c.link.issuerId || !Array.isArray(c.link.reach))) delete c.link;
    return c;
  } catch {
    console.error('[Invitations] INVITATION_CONFIG is not readable; every invitation entry point refuses');
    return null;
  }
}

export interface RedemptionDeps {
  config?: InvitationConfig | null;
  doc?: Sender;
  ssm?: Sender;
  secrets?: Sender;
  sts?: Sender;
  chime?: Sender;
  fetch?: Parameters<typeof verifyCaptcha>[0]['fetch'];
  now?: () => number;
  identitiesTable?: string;
  /**
   * Whether a person still signs in as anybody, with an account their issuer reports active: the inviter
   * of a live invitation must. Throws when an issuer cannot be asked.
   */
  personActive?: (personArn: string) => Promise<boolean>;
  mint?: typeof mintInvitee;
  tag?: typeof tagIdentity;
  audit?: (line: AccessAuditLine) => Promise<unknown>;
}

let defaultDoc: Sender | null = null;
let defaultSsm: Sender | null = null;
let defaultSecrets: Sender | null = null;
const docOf = (d: RedemptionDeps): Sender => d.doc ?? (defaultDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));
const ssmOf = (d: RedemptionDeps): Sender => d.ssm ?? (defaultSsm ??= new SSMClient({}));
const secretsOf = (d: RedemptionDeps): Sender => d.secrets ?? (defaultSecrets ??= new SecretsManagerClient({}));
const configOf = (d: RedemptionDeps): InvitationConfig | null => (d.config === undefined ? invitationConfigFromEnv() : d.config);
const nameOf = (err: unknown): string => (err as { name?: string })?.name || '';

const parameterCache = new Map<string, string>();
export function __resetInvitationRedemptionCachesForTests(): void {
  parameterCache.clear();
}

async function laterStackParameter(name: string, d: RedemptionDeps): Promise<string> {
  const hit = parameterCache.get(name);
  if (hit) return hit;
  const value = (await ssmOf(d).send(new GetParameterCommand({ Name: name })))?.Parameter?.Value;
  if (!value) throw new Error(`${name} is empty`);
  parameterCache.set(name, value);
  return value;
}

/**
 * The inviter still signs in as somebody, through an account their issuer reports active now
 * (`Directory.accountState`, asked live and never copied): erased, disabled at every issuer or never a
 * person, their invitations do not redeem. THROWS when an issuer cannot be asked, and each caller refuses
 * `unavailable` rather than redeem on a failed read.
 */
async function inviterActive(record: InvitationRecord, d: RedemptionDeps): Promise<boolean> {
  if (d.personActive) return d.personActive(record.inviterArn);
  const subjects = await subjectsOfPerson(record.inviterArn, { doc: docOf(d), table: d.identitiesTable });
  if (!subjects.length) return false;
  const directory = defaultDirectory();
  const states = await Promise.all(subjects.map((s) => directory.accountState(s.issuer, s.subject)));
  return states.includes('active');
}

function parseBody(event: any): Record<string, unknown> | null {
  try {
    const raw = typeof event?.body === 'string' ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : event?.body;
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const tokenIn = (body: Record<string, unknown> | null): string => {
  const t = typeof body?.token === 'string' ? body.token : '';
  return t && t.length <= 128 ? t : '';
};

/** A refusal as the landing page reads it: the code, and how long to wait where waiting helps. */
function refusal(event: unknown, code: InvitationRefusal | 'invalid_request' | 'paused' | 'rate_limited' | 'captcha_failed' | 'unavailable', status: number, retryAfterSeconds?: number): HttpResult {
  if (code !== 'invalid_request') invitationMetric('InvitationRefused', { Reason: code });
  const out = reply(event, status, { code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
  if (retryAfterSeconds) out.headers = { ...out.headers, 'Retry-After': String(retryAfterSeconds) };
  return out;
}

const REFUSAL_HTTP: Record<InvitationRefusal, number> = {
  unknown: 404, expired: 410, redeemed: 409, redeemed_elsewhere: 409, revoked: 410, wrong_account: 409, wrong_mode: 409, ended: 410,
};

/** A record read by its token, or null when it is not an invitation. */
async function invitationByToken(token: string, d: RedemptionDeps): Promise<{ table: string; record: InvitationRecord | null }> {
  const c = configOf(d);
  if (!c) throw new Error('invitations are not configured');
  const table = await laterStackParameter(c.tokensTableParameter, d);
  const presented = await readTokenRecord(docOf(d), table, tokenKey('invitation', token));
  // A REMINDED INVITATION'S SECOND LINK is an alias naming the one record (`invitationAliasOf`): both links read, and
  // spend, that record, so redeeming either consumes both and revoking it ends both.
  const target = invitationAliasOf(presented);
  const record = target ? await readTokenRecord(docOf(d), table, target) : presented;
  return { table, record: isInvitationRecord(record) ? record : null };
}

/** Whether a link session may be vended at this record's classification: the issuer declares it and the type's link classifications hold it. */
function linkReaches(record: InvitationRecord, link: LinkConfig | undefined): boolean {
  if (!link) return false;
  const policy = invitationPolicyOf(record.conversationType);
  return !!policy?.modes.includes('link') && policy.linkClassifications.includes(record.classification as never) && link.reach.includes(record.classification)
    // AND THE TYPE ADMITS THE LINK ISSUER (T1, FR23): a type narrowed to other issuers redeems no link.
    && typeAdmitsIssuers(record.conversationType, [link.issuerId]);
}

// ── MINT ─────────────────────────────────────────────────────────────────────────────────────────

/** True for the invitations function's invocation: no gateway request context, the op named. */
export function isMintInviteeOperation(event: any): boolean {
  return !!event && typeof event === 'object' && !event.requestContext && !event.httpMethod && event.op === 'mint-invitee';
}

export async function mintInviteeOperation(event: any, d: RedemptionDeps = {}): Promise<{ ok: boolean; personArn?: string; personId?: string; error?: string }> {
  const name = typeof event?.name === 'string' ? event.name.trim() : '';
  const days = Number(event?.expirationDays);
  const classification = typeof event?.classification === 'string' ? event.classification : '';
  if (!name || !Number.isInteger(days) || !profiles.isConversational(classification)) return { ok: false, error: 'a name, an expiry and a conversation classification are required' };
  try {
    const minted = await (d.mint ?? mintInvitee)({ name, expirationDays: days }, { chime: d.chime ?? chimeIdentity, audit: d.audit });
    await (d.tag ?? tagIdentity)(minted.personId, classification);
    return { ok: true, personArn: minted.personArn, personId: minted.personId };
  } catch (err) {
    console.error('[Invitations] the invitee could not be minted', { err: nameOf(err) });
    return { ok: false, error: 'the invitee could not be minted' };
  }
}

// ── PEEK ─────────────────────────────────────────────────────────────────────────────────────────

export async function peekInvitation(event: any, d: RedemptionDeps = {}): Promise<HttpResult> {
  const c = configOf(d);
  if (!c) return refusal(event, 'unavailable', 404);
  const token = tokenIn(parseBody(event));
  if (!token) return refusal(event, 'invalid_request', 400);
  const now = Math.floor((d.now ?? Date.now)() / 1000);
  try {
    const { record } = await invitationByToken(token, d);
    if (!record) return refusal(event, 'unknown', 404);
    let status = invitationStatusOf(record, now);
    if (status === 'pending' && !(await inviterActive(record, d))) status = 'revoked';
    const linkAvailable = record.mode === 'link' && linkReaches(record, c.link);
    return reply(event, 200, {
      status,
      mode: record.mode,
      conversationName: record.conversationName,
      inviterName: record.inviterName,
      inviteeName: record.inviteeName,
      expiresAt: record.expiresAt,
      ...(record.mode === 'sign-in' ? { signInUrl: c.signInUrl } : {}),
      ...(record.mode === 'link' ? {
        linkAvailable,
        ...(linkAvailable && c.link ? { captchaSiteKey: c.link.settings.captcha.siteKey, sessionMinutes: c.link.settings.sessionMinutes } : {}),
      } : {}),
    });
  } catch (err) {
    console.error('[Invitations] a landing page read failed', { err: nameOf(err) });
    return refusal(event, 'unavailable', 503);
  }
}

// ── A `link` REDEMPTION ──────────────────────────────────────────────────────────────────────────

/**
 * Vend a link session: the `link` role, assumed with the `person`, `classification` and `channel` session
 * tags its trust requires, and a session policy naming the one conversation. The role's own policy and its
 * boundary are pinned to the same tags (`lib/constructs/invitation-link-issuer.ts`).
 */
export async function vendLinkSession(
  input: { personId: string; channelId: string; classification: string; roleArn: string; seconds: number },
  deps: { sts?: Sender } = {},
): Promise<{ credentials: ReturnType<typeof credentialsOf>; userArn: string; channelArn: string }> {
  const channelArn = `${CHANNEL_PREFIX}${input.channelId}`;
  if (!literalChannelId(channelArn)) throw new Error('a link session names one literal conversation');
  const userArn = userArnFor(APP_INSTANCE_ARN, input.personId);
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'SessionAndConnect', Effect: 'Allow', Action: ['chime:GetMessagingSessionEndpoint', 'chime:Connect'], Resource: '*' },
      {
        Sid: 'OneConversation',
        Effect: 'Allow',
        Action: [
          'chime:GetChannelMessage', 'chime:ListChannelMessages', 'chime:DescribeChannel', 'chime:ListChannelMemberships',
          'chime:SendChannelMessage', 'chime:UpdateChannelReadMarker',
        ],
        Resource: [channelArn, userArn],
      },
    ],
  });
  const assumed = await (deps.sts ?? sts).send(new AssumeRoleCommand({
    RoleArn: input.roleArn,
    RoleSessionName: `link-${input.personId}`.slice(0, 64),
    DurationSeconds: input.seconds,
    Policy: policy,
    Tags: [
      { Key: 'person', Value: input.personId },
      { Key: 'classification', Value: input.classification },
      { Key: 'channel', Value: input.channelId },
    ],
  }));
  return { credentials: credentialsOf(assumed), userArn, channelArn };
}

const sourceIpOf = (event: any): string | null => {
  const ip = event?.requestContext?.identity?.sourceIp ?? event?.requestContext?.http?.sourceIp;
  return typeof ip === 'string' && ip ? ip : null;
};

export async function redeemLink(event: any, d: RedemptionDeps = {}): Promise<HttpResult> {
  const c = configOf(d);
  const link = c?.link;
  if (!c || !link) return refusal(event, 'unavailable', 404);
  const body = parseBody(event);
  const token = tokenIn(body);
  if (!token) return refusal(event, 'invalid_request', 400);
  const nowMs = (d.now ?? Date.now)();
  const now = Math.floor(nowMs / 1000);
  const ip = sourceIpOf(event);

  // 1. EVERY CONTROL, BEFORE THE TOKEN IS READ.
  try {
    await requireNotPaused(ssmOf(d), link.killSwitchParameter, nowMs);
    const [abuseTable, salt] = await Promise.all([
      laterStackParameter(link.abuseTableParameter, d).catch((err) => { throw new GuestRefused('unavailable', `the limit store could not be found: ${nameOf(err)}`); }),
      readSecret({ secretId: link.addressSaltSecret }, { secrets: secretsOf(d), now: nowMs }),
    ]);
    await countAddressStart(docOf(d), {
      table: abuseTable, salt, ip, max: link.settings.perIpLimit.max, windowMinutes: link.settings.perIpLimit.windowMinutes, now: nowMs, prefix: 'link-ip',
    });
    if (link.settings.captcha.testKeys && link.environment === 'production') throw new GuestRefused('unavailable', 'a production invitation-link issuer declared no captcha secret');
    const secret = link.settings.captcha.testKeys
      ? TURNSTILE_TEST_SECRET_PASS
      : await readSecret({ secretId: link.settings.captcha.secretName, parameter: link.settings.captcha.secretParameter }, { secrets: secretsOf(d), ssm: ssmOf(d), now: nowMs });
    await verifyCaptcha({ secret, response: body?.captchaToken as string, remoteIp: ip, idempotencyKey: randomUUID(), fetch: d.fetch });
  } catch (err) {
    if (err instanceof GuestRefused) {
      console.warn('[Invitations][SecurityEvent] a link redemption was refused by its controls', { code: err.code, detail: err.detail });
      return refusal(event, err.code, REFUSAL_STATUS[err.code], err.retryAfterSeconds);
    }
    console.error('[Invitations] a link redemption control failed', { err: nameOf(err) });
    return refusal(event, 'unavailable', 503);
  }

  // 2-4. THE RECORD, SPENT ONCE, AND THE SESSION.
  try {
    const { table, record } = await invitationByToken(token, d);
    const why = refusalOf(record, now, 'link');
    if (why) return refusal(event, why, REFUSAL_HTTP[why]);
    if (!(await inviterActive(record!, d))) return refusal(event, 'revoked', REFUSAL_HTTP.revoked);
    if (!linkReaches(record!, link)) {
      console.warn('[Invitations][SecurityEvent] a link invitation at a classification no link session reaches; vending nothing', { classification: record!.classification });
      return refusal(event, 'wrong_mode', REFUSAL_HTTP.wrong_mode);
    }
    const channelId = literalChannelId(record!.channelArn);
    const personId = personIdFromArn(record!.personArn);
    if (!channelId || !personId) return refusal(event, 'unknown', 404);
    const redeemed = await redeemTokenKey(docOf(d), table, record!.pk, {
      now, channelArn: record!.channelArn, match: { mode: 'link' }, extra: { redeemedVia: 'link' },
    });
    if (!redeemed.ok) {
      const code: InvitationRefusal = redeemed.reason === 'consumed' ? 'redeemed_elsewhere'
        : redeemed.reason === 'expired' ? 'expired' : redeemed.reason === 'revoked' ? 'revoked' : redeemed.reason === 'mismatch' ? 'wrong_mode' : 'unknown';
      return refusal(event, code, REFUSAL_HTTP[code]);
    }
    // The classification the session is vended at, sent back under the exchange's one wire field.
    const accessClass = record!.classification;
    const session = await vendLinkSession({
      personId, channelId, classification: accessClass, roleArn: link.roleArn, seconds: link.settings.sessionMinutes * 60,
    }, { sts: d.sts });
    console.log(JSON.stringify({ _auditEvent: 'invitation_redeemed', via: 'link', inviteeArn: record!.personArn, channelArn: record!.channelArn, invitationId: record!.invitationId }));
    return reply(event, 200, {
      credentials: session.credentials,
      userArn: session.userArn,
      channelArn: session.channelArn,
      sessionEndsAt: now + link.settings.sessionMinutes * 60,
      conversationName: record!.conversationName,
      inviterName: record!.inviterName,
      tier: accessClass,
      identity: 'chat',
      scopedTo: session.channelArn,
    });
  } catch (err) {
    console.error('[Invitations] a link redemption failed', { err: nameOf(err) });
    return refusal(event, 'unavailable', 503);
  }
}

// ── A `sign-in` REDEMPTION ───────────────────────────────────────────────────────────────────────

/** Why a sign-in redemption was refused. Nothing was bound for any of them. */
export class InvitationRefused extends Error {
  readonly status: number;
  constructor(readonly code: InvitationRefusal | 'unavailable', detail: string) {
    super(detail);
    this.name = 'InvitationRefused';
    this.status = code === 'unavailable' ? 503 : REFUSAL_HTTP[code];
  }
}

/** The invitation a request body redeems: `{ invitation: <token> }`. A malformed one is refused, not ignored. */
export function invitationRequestOf(body: unknown): string | null | 'malformed' {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>).invitation : undefined;
  if (v === undefined) return null;
  return typeof v === 'string' && v && v.length <= 128 ? v : 'malformed';
}

export interface BoundInvitee extends MintedPerson {
  /** The conversation the invitation was to: the person is already its member. */
  channelArn: string;
}

/**
 * Bind the signing-in subject `(issuer, subject)` to the invitee its token names. `roleKey` is the
 * classification the subject's own clearance resolved to. Throws `InvitationRefused`.
 */
export async function bindInvitation(
  input: { issuer: string; subject: string; roleKey: string | undefined; token: string },
  d: RedemptionDeps = {},
): Promise<BoundInvitee> {
  const identitiesTable = d.identitiesTable ?? process.env.IDENTITIES_TABLE ?? '';
  if (!identitiesTable || !configOf(d)) throw new InvitationRefused('unavailable', 'invitations are not configured');
  const doc = docOf(d);
  const nowMs = (d.now ?? Date.now)();
  const now = Math.floor(nowMs / 1000);

  // 1. A SUBJECT WITH AN ACCOUNT IS NOT BOUND AGAIN.
  const key = issuerSubjectKey(input.issuer, input.subject);
  const readItem = async (k: string) => (await doc.send(new GetCommand({ TableName: identitiesTable, Key: { issuerSubject: k }, ConsistentRead: true })))?.Item;
  if (await readItem(key)) throw new InvitationRefused('wrong_account', 'this sign-in already has an account');
  if (await readItem(revokedMarkerKey(input.issuer, input.subject))) throw new InvitationRefused('wrong_account', 'this sign-in was offboarded');

  // 2. THE INVITATION, LIVE, IN THIS MODE, AND REACHABLE BY THIS SIGN-IN.
  let table: string;
  let record: InvitationRecord | null;
  try {
    ({ table, record } = await invitationByToken(input.token, d));
  } catch (err) {
    throw new InvitationRefused('unavailable', `the invitation could not be read: ${nameOf(err) || 'error'}`);
  }
  const why = refusalOf(record, now, 'sign-in');
  if (why) throw new InvitationRefused(why, `this invitation cannot be redeemed: ${why}`);
  const invite = record!;
  let inviterHere: boolean;
  try {
    inviterHere = await inviterActive(invite, d);
  } catch (err) {
    throw new InvitationRefused('unavailable', `the inviter's issuer could not be asked: ${nameOf(err) || 'error'}`);
  }
  if (!inviterHere) throw new InvitationRefused('revoked', 'the person who issued this invitation is no longer here');
  if (!input.roleKey || !profiles.grantsFor(input.roleKey).includes(invite.classification)) {
    throw new InvitationRefused('wrong_account', 'this sign-in\'s clearance does not reach the conversation');
  }
  // THE TYPE'S ISSUER NARROWING (T1, FR23), after the clearance check: a sign-in through an issuer the type
  // does not list binds nothing, and is told so as the wrong account.
  if (!typeAdmitsIssuers(invite.conversationType, [input.issuer])) {
    throw new InvitationRefused('wrong_account', 'conversations of this kind do not admit this sign-in\'s issuer');
  }
  // The invitee is an AppInstanceUser nobody signs in as yet: a bound one is somebody's.
  const inviteeBound = (await subjectsOfPerson(invite.personArn, { doc, table: identitiesTable }, { anyStatus: true })).length;
  if (inviteeBound) throw new InvitationRefused('redeemed', 'this invitee is already somebody\'s');
  const personId = personIdFromArn(invite.personArn);
  if (!personId) throw new InvitationRefused('unknown', 'the invitation names no AppInstanceUser');

  // 3. THE EXPIRATION, THEN ONE TRANSACTION, OR NOTHING.
  const chime = d.chime ?? chimeIdentity;
  try {
    await chime.send(new PutAppInstanceUserExpirationSettingsCommand({ AppInstanceUserArn: invite.personArn }));
  } catch (err) {
    throw new InvitationRefused('unavailable', `the invitee's expiration could not be removed: ${nameOf(err) || 'error'}`);
  }
  const at = new Date(nowMs).toISOString();
  const row: IdentityRow & { boundFrom: string } = {
    issuerSubject: key, personArn: invite.personArn, issuer: input.issuer, status: 'active', createdAt: at, boundFrom: 'invitation',
  };
  try {
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: identitiesTable, Item: row, ConditionExpression: 'attribute_not_exists(issuerSubject)' } },
        { Update: {
          TableName: table,
          Key: { pk: invite.pk },
          UpdateExpression: 'SET consumedAt = :now, redeemedVia = :mode',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(consumedAt) AND attribute_not_exists(revokedAt) AND expiresAt > :now AND #m = :mode AND channelArn = :c',
          ExpressionAttributeNames: { '#m': 'mode' },
          ExpressionAttributeValues: { ':now': now, ':mode': 'sign-in', ':c': invite.channelArn },
        } },
      ],
    }));
  } catch (err) {
    // PUT THE EXPIRATION BACK, ONLY ON AN INVITEE NOBODY HAS BOUND. A concurrent redemption of the same
    // invitation (a retry after a slow answer) may have committed: restoring the expiration then would expire
    // the person it just bound, with their membership and history. The winning redemption spends the
    // invitation in the same transaction, so the invitation is read again, consistently, and the expiration
    // goes back only while it is still unspent.
    const lifetimeDays = Math.max(1, Math.round((invite.expiresAt - Math.floor(Date.parse(invite.createdAt) / 1000)) / 86_400));
    await (async () => {
      const current = (await doc.send(new GetCommand({ TableName: table, Key: { pk: invite.pk }, ConsistentRead: true })))?.Item;
      if (!current || current.consumedAt !== undefined) return;
      await chime.send(new PutAppInstanceUserExpirationSettingsCommand({
        AppInstanceUserArn: invite.personArn, ExpirationSettings: { ExpirationDays: lifetimeDays, ExpirationCriterion: 'CREATED_TIMESTAMP' },
      }));
    })().catch((restoreErr: unknown) => console.error('[Invitations][SecurityEvent] a refused bind could not restore the invitee\'s expiration', { err: nameOf(restoreErr) }));
    if (nameOf(err) === 'TransactionCanceledException') {
      const reasons = ((err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((r) => r?.Code);
      if (reasons[0] === 'ConditionalCheckFailed') throw new InvitationRefused('wrong_account', 'this sign-in was bound by another call');
      throw new InvitationRefused('redeemed', 'the invitation changed while it was being redeemed');
    }
    throw new InvitationRefused('unavailable', `the binding could not be written: ${nameOf(err) || 'error'}`);
  }

  const line: AccessAuditLine = {
    _auditEvent: 'identity_bound_invitation', timestamp: at, personId: 'credential-exchange', issuer: input.issuer,
    personArn: invite.personArn, channelArn: invite.channelArn, invitationId: invite.invitationId,
  };
  console.log(JSON.stringify(line));
  try {
    await (d.audit ?? ((l: AccessAuditLine) => recordAccess(l)))(line);
  } catch (err) {
    console.error('[Invitations][SecurityEvent] the binding could not be written to the access log', { err: nameOf(err) });
  }
  return { personId, personArn: invite.personArn, created: false, channelArn: invite.channelArn };
}
