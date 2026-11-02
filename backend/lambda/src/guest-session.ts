/**
 * GUEST START AND GUEST REFRESH: how an anonymous visitor becomes, and stays, a person (A7, L16).
 *
 * Both are entry points of the credential exchange (`credential-exchange.ts`), on its function and its
 * role, because the exchange is the one minter of an AppInstanceUser and the one writer of `Identities`:
 * a visitor is minted here exactly as a first sign-in is, through `mintOrResolvePerson`. Both routes are
 * unauthenticated (`auth: 'none'`, a tight route throttle), so their abuse controls are in this handler.
 *
 * ── GUEST START (`POST /guest/start`) ────────────────────────────────────────────────────────────
 *
 * In this order, and nothing later runs when anything earlier refuses:
 *
 *  1. The kill switch (an SSM parameter under `SSM_ROOT`): `paused` while it is on.
 *  2. The per-address limit (`rate_limited`), then the captcha, verified server-side (`captcha_failed`).
 *     Either one that cannot answer refuses with `unavailable`. Nothing is minted, created or signed yet.
 *  3. The visitor is minted: a fresh subject under the guest issuer, an AppInstanceUser through the one
 *     minter, and that AppInstanceUser's expiration (`GUEST_LIFETIME_HOURS` after its creation).
 *  4. The privacy-notice version the widget showed is recorded, keyed by the visitor's AppInstanceUser
 *     (the access log's `byActor` index). Unrecordable, the visit is refused: a notice nobody can show
 *     was shown is not a notice.
 *  5. The visitor's one conversation is opened by the guest classification's own creator, as type
 *     `guest-visitor`, with the visitor a member and never a moderator.
 *  6. The guest token is signed (KMS `Sign`, the first and only KMS call), the refresh credential is
 *     written to `Tokens` (`guest-refresh#<sha256>`, a new `familyId`), and the first session is vended.
 *
 * ── GUEST REFRESH (`POST /guest/refresh`) ────────────────────────────────────────────────────────
 *
 * The refresh credential is single-use and rotated on every use, inside one family per visit, and never
 * valid past the visit's end. Redemption is one conditional update in the token store. Presenting a
 * credential already used:
 *
 *  - within `REFRESH_REUSE_GRACE_SECONDS` of its first use, at most `REFRESH_REUSE_LIMIT` times, is two
 *    tabs of one visitor refreshing at once, and each gets its own successor in the same family;
 *  - after that is a replay, and revokes the whole family, so the most recent legitimate credential is
 *    refused too and the visitor starts again (`replayed`, which the widget shows as "this conversation
 *    was opened elsewhere").
 *
 * A refused refresh answers with its reason code and never an empty widget (D-4).
 */
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { PutAppInstanceUserExpirationSettingsCommand } from '@aws-sdk/client-chime-sdk-identity';
import { GUEST_LIFETIME_HOURS, type ResolvedGuestSettings } from '../../lib/config/issuers.js';
import { TURNSTILE_TEST_SECRET_PASS } from '../../lib/config/issuers.js';
import { mintOrResolvePerson, identityStateOf, PersonNotActive } from './lib/person-identity.js';
import { userArnFor } from './lib/person-arn.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { recordAccess } from './lib/access-log.js';
import { adminNotice, postAdminNotice } from './lib/admin-notice.js';
import { signGuestToken } from './lib/guest-token.js';
import {
  GuestRefused,
  REFUSAL_STATUS,
  readSecret,
  requireNotPaused,
  countAddressStart,
  verifyCaptcha,
  type GuestRefusalCode,
} from './lib/guest-abuse.js';
import {
  newPlatformToken,
  putToken,
  readTokenRecord,
  redeemToken,
  sha256Hex,
  tokenKey,
  tokenRecordOf,
  type TokenRecord,
} from './lib/tokens.js';
import type { HttpResult } from './lib/http-response.js';
import { recordFunnelStage, type FunnelSink } from './lib/funnel.js';
import { emitEmfMetric } from './lib/emf-metrics.js';
import {
  APP_INSTANCE_ARN,
  CHANNEL_PREFIX,
  chimeIdentity,
  credentialsOf,
  literalChannelId,
  reply,
  sts,
  tagIdentity,
} from './lib/vend.js';

type Sender = { send(command: unknown): Promise<any> };

/** How long a used refresh credential may be presented again by another tab of the same visitor. */
export const REFRESH_REUSE_GRACE_SECONDS = 10;
/** How many other tabs may do so. */
export const REFRESH_REUSE_LIMIT = 2;
/**
 * How long a sign-in hand-off lasts (path A, `guest-bind`): long enough to open the chat app and sign in,
 * short enough that a link copied out of the address bar is soon worth nothing even with its secret.
 */
export const BIND_HANDOFF_SECONDS = 600;
/** The hash of the widget's hand-off secret: SHA-256, base64url, unpadded. */
const BIND_SECRET_HASH = /^[A-Za-z0-9_-]{43}$/;
/** How long a guest's AWS credential lasts: the STS minimum, so a revoked family ends the session soon. */
export const GUEST_SESSION_SECONDS = 900;

// ── CONFIGURATION, FROM THE STACK ────────────────────────────────────────────────────────────────

export interface GuestConfig {
  issuerId: string;
  /** The guest classification its visitors are vended at. */
  classification: string;
  issuerUri: string;
  deploymentId: string;
  settings: ResolvedGuestSettings;
  /** The KMS key that signs, and its `kid` (the last key generation). */
  signingKeyArn: string;
  signingKid: string;
  killSwitchParameter: string;
  /** The Secrets Manager secret the address hash is salted with. */
  addressSaltSecret: string;
  guestRoleArn: string;
  /** SSM names of what lives in Conversations, read at runtime: it deploys after this stack. */
  tokensTableParameter: string;
  abuseTableParameter: string;
  /** The visitor classification's creator, under its own key. */
  creatorParameter: string;
  /**
   * The root a classification's creator is published under (`<root>/<classification>/conversation-creator-arn`),
   * which a bind continues a visit through (`lib/guest-bind.ts`).
   */
  creatorParameterRoot?: string;
  environment: string;
}

/** The guest configuration this function was deployed with, or null when the deployment declares no guest issuer. */
export function guestConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GuestConfig | null {
  if (!env.GUEST_CONFIG) return null;
  try {
    const c = JSON.parse(env.GUEST_CONFIG) as GuestConfig;
    if (!c.issuerId || !c.classification || !c.signingKeyArn || !c.guestRoleArn) return null;
    return c;
  } catch {
    console.error('[GuestSession] GUEST_CONFIG is not readable; guest start refuses');
    return null;
  }
}

export interface GuestDeps {
  config?: GuestConfig | null;
  doc?: Sender;
  ssm?: Sender;
  secrets?: Sender;
  lambda?: Sender;
  sts?: Sender;
  chime?: Sender;
  kms?: Sender;
  fetch?: Parameters<typeof verifyCaptcha>[0]['fetch'];
  now?: () => number;
  /** The minter and the identity read, replaced in tests. */
  mint?: typeof mintOrResolvePerson;
  identityState?: typeof identityStateOf;
  audit?: typeof recordAccess;
  alert?: typeof postAdminNotice;
  tag?: typeof tagIdentity;
  /** Where the funnel's stages are archived (B12). Default the archive. */
  funnel?: FunnelSink;
}

let defaultDoc: Sender | null = null;
let defaultSsm: Sender | null = null;
let defaultSecrets: Sender | null = null;
let defaultLambda: Sender | null = null;
const docOf = (d: GuestDeps) => d.doc ?? (defaultDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({})));
const ssmOf = (d: GuestDeps) => d.ssm ?? (defaultSsm ??= new SSMClient({}));
const secretsOf = (d: GuestDeps) => d.secrets ?? (defaultSecrets ??= new SecretsManagerClient({}));
const lambdaOf = (d: GuestDeps) => d.lambda ?? (defaultLambda ??= new LambdaClient({}));

const parameterCache = new Map<string, string>();
export function __resetGuestSessionCachesForTests(): void {
  parameterCache.clear();
}

/** A parameter a later stack publishes, read once per container. Unreadable is `unavailable`. */
async function laterStackParameter(name: string, d: GuestDeps): Promise<string> {
  const hit = parameterCache.get(name);
  if (hit) return hit;
  let value: string | undefined;
  try {
    value = (await ssmOf(d).send(new GetParameterCommand({ Name: name })))?.Parameter?.Value;
  } catch (err) {
    throw new GuestRefused('unavailable', `${name} could not be read: ${(err as Error)?.name || 'error'}`);
  }
  if (!value) throw new GuestRefused('unavailable', `${name} is empty`);
  parameterCache.set(name, value);
  return value;
}

/** The `Tokens` table's name, which Conversations publishes. For the bind (`lib/guest-bind.ts`). */
export function guestTokensTable(c: GuestConfig, d: GuestDeps = {}): Promise<string> {
  return laterStackParameter(c.tokensTableParameter, d);
}

/**
 * The guest classification's creator, which Conversations publishes: it opens a visitor's conversation, and
 * assesses and retires it when the visit carries over (`lib/guest-bind.ts`).
 */
export function guestCreatorOf(c: GuestConfig, d: GuestDeps = {}): Promise<string> {
  return laterStackParameter(c.creatorParameter, d);
}

/**
 * The conversation creator a bind continues a visit through at `classification`, which that classification's own
 * stack publishes under its key. Undefined when no root is configured or the value is undeclared; unreadable is
 * `unavailable`.
 */
export async function guestBindCreatorOf(c: GuestConfig, classification: string, d: GuestDeps = {}): Promise<string | undefined> {
  if (!c.creatorParameterRoot || !profiles.isKnownClassification(classification)) return undefined;
  return laterStackParameter(`${c.creatorParameterRoot}/${classification}/conversation-creator-arn`, d);
}

// ── ANSWERS ──────────────────────────────────────────────────────────────────────────────────────

/** A refusal as the widget reads it: the code, and how long to wait where waiting helps. */
export function refusal(event: unknown, code: GuestRefusalCode | 'invalid_request' | 'expired' | 'replayed' | 'revoked' | 'ended', status?: number, retryAfterSeconds?: number): HttpResult {
  const statusCode = status ?? (code in REFUSAL_STATUS ? REFUSAL_STATUS[code as GuestRefusalCode] : 401);
  const out = reply(event, statusCode, { code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
  if (retryAfterSeconds) out.headers = { ...out.headers, 'Retry-After': String(retryAfterSeconds) };
  return out;
}

/** A refusal or a throttle, counted as an EMF line CloudWatch extracts from the log, with no call. */
export function guestMetric(name: string, dims: Record<string, string> = {}): void {
  emitEmfMetric({
    namespace: 'AgentEchelon/Guest',
    metrics: [{ name, unit: 'Count' }],
    dimensionSets: [['Instance', ...Object.keys(dims)]],
    properties: { Instance: process.env.ALERT_INSTANCE || '', ...dims, [name]: 1 },
  });
}

async function refuse(event: unknown, err: GuestRefused, flow: 'start' | 'refresh', d: GuestDeps): Promise<HttpResult> {
  console.warn(`[GuestSession][SecurityEvent] guest ${flow} refused`, { code: err.code, detail: err.detail });
  // The alarm's signal (`UnavailableAlarm`), and, for a start, the funnel's refusal by reason (B12).
  guestMetric('GuestRefused', { Reason: err.code });
  if (flow === 'start') await recordFunnelStage({ stage: 'guest_refused', reason: err.code }, d.funnel);
  // AN OUTAGE IS AN OPERATOR'S PROBLEM, NOT THE VISITOR'S (L2): `unavailable` raises an alert.
  if (err.code === 'unavailable') {
    await (d.alert ?? postAdminNotice)(adminNotice({ name: 'guest-unavailable', values: { flow, detail: err.detail } }, 'guest-unavailable', { flow }));
  }
  return refusal(event, err.code, undefined, err.retryAfterSeconds);
}

// ── THE SESSION A GUEST IS VENDED ────────────────────────────────────────────────────────────────

/**
 * Vend a guest's one-conversation session: the guest-session role, assumed with the `person`,
 * `classification` and `channel` session tags its trust policy requires, and a session policy naming the
 * one conversation. The role's own policy is pinned to the same two tags (`identity-stack.ts`), so even
 * with no session policy it reaches this visitor's conversation and nothing else.
 */
export async function vendGuestSession(
  input: { personId: string; channelId: string; classification: string; roleArn: string },
  deps: { sts?: Sender } = {},
): Promise<{ credentials: ReturnType<typeof credentialsOf>; userArn: string; channelArn: string }> {
  const channelArn = `${CHANNEL_PREFIX}${input.channelId}`;
  if (!literalChannelId(channelArn)) throw new Error('a guest session names one literal conversation');
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
    RoleSessionName: `guest-${input.personId}`.slice(0, 64),
    DurationSeconds: GUEST_SESSION_SECONDS,
    Policy: policy,
    Tags: [
      { Key: 'person', Value: input.personId },
      { Key: 'classification', Value: input.classification },
      { Key: 'channel', Value: input.channelId },
    ],
  }));
  return { credentials: credentialsOf(assumed), userArn, channelArn };
}

// ── THE REFRESH CREDENTIAL ───────────────────────────────────────────────────────────────────────

interface RefreshFields {
  familyId: string;
  subject: string;
  /** Epoch seconds: the visit's end. No credential in the family lives past it. */
  sessionEndsAt: number;
}

/** Issue one refresh credential in a family. Returns the token, shown to the visitor once. */
async function issueRefresh(
  table: string,
  c: GuestConfig,
  fields: RefreshFields & { channelArn: string; personArn: string },
  now: number,
  d: GuestDeps,
): Promise<{ token: string; expiresAt: number }> {
  const token = newPlatformToken();
  const expiresAt = Math.min(now + c.settings.refreshMinutes * 60, fields.sessionEndsAt);
  await putToken(docOf(d), table, tokenRecordOf('guest-refresh', token, {
    channelArn: fields.channelArn,
    personArn: fields.personArn,
    issuer: c.issuerId,
    expiresAt,
    familyId: fields.familyId,
    subject: fields.subject,
    sessionEndsAt: fields.sessionEndsAt,
  }));
  return { token, expiresAt };
}

/** A visit's family record key. The bind revokes it, as a replay does. */
export const familyKey = (familyId: string): string => `guest-family#${sha256Hex(familyId)}`;

// ── GUEST START ──────────────────────────────────────────────────────────────────────────────────

const parseBody = (event: any): Record<string, unknown> | null => {
  try {
    const raw = typeof event?.body === 'string' ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : event?.body;
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const sourceIpOf = (event: any): string | null => {
  const ip = event?.requestContext?.identity?.sourceIp ?? event?.requestContext?.http?.sourceIp;
  return typeof ip === 'string' && ip ? ip : null;
};

export async function guestStart(event: any, d: GuestDeps = {}): Promise<HttpResult> {
  const c = d.config === undefined ? guestConfigFromEnv() : d.config;
  if (!c) return refusal(event, 'unavailable', 404);
  const body = parseBody(event);
  if (!body) return refusal(event, 'invalid_request', 400);
  // THE NOTICE SHOWN IS THE ONE DECLARED. A widget showing another version is stale, and what it showed
  // is not what this deployment would be recording as shown.
  if (body.noticeVersion !== c.settings.noticeVersion) return refusal(event, 'invalid_request', 400);
  const nowMs = (d.now ?? Date.now)();
  const now = Math.floor(nowMs / 1000);
  const ip = sourceIpOf(event);

  // ── 1-2. EVERY CONTROL, BEFORE ANYTHING IS MINTED OR SIGNED ──────────────────────────────────────
  try {
    await requireNotPaused(ssmOf(d), c.killSwitchParameter, nowMs);
    const [abuseTable, salt] = await Promise.all([
      laterStackParameter(c.abuseTableParameter, d),
      readSecret({ secretId: c.addressSaltSecret }, { secrets: secretsOf(d), now: nowMs }),
    ]);
    await countAddressStart(docOf(d), {
      table: abuseTable, salt, ip, max: c.settings.perIpLimit.max, windowMinutes: c.settings.perIpLimit.windowMinutes, now: nowMs,
    });
    // TEST KEYS ARE A NON-PRODUCTION THING, checked here as well as at synth.
    if (c.settings.captcha.testKeys && c.environment === 'production') throw new GuestRefused('unavailable', 'a production guest issuer declared no captcha secret');
    const secret = c.settings.captcha.testKeys
      ? TURNSTILE_TEST_SECRET_PASS
      : await readSecret({ secretId: c.settings.captcha.secretName, parameter: c.settings.captcha.secretParameter }, { secrets: secretsOf(d), ssm: ssmOf(d), now: nowMs });
    await verifyCaptcha({ secret, response: body.captchaToken as string, remoteIp: ip, idempotencyKey: randomUUID(), fetch: d.fetch });
  } catch (err) {
    if (err instanceof GuestRefused) return refuse(event, err, 'start', d);
    throw err;
  }

  // ── 3-6. THE VISITOR, THEIR NOTICE, THEIR CONVERSATION, THEIR TOKENS ────────────────────────────
  try {
    const [tokensTable, creator] = await Promise.all([
      laterStackParameter(c.tokensTableParameter, d),
      laterStackParameter(c.creatorParameter, d),
    ]);
    const subject = randomUUID();
    const person = await (d.mint ?? mintOrResolvePerson)({ issuer: c.issuerId, subject, name: 'Visitor' });
    const userArn = userArnFor(APP_INSTANCE_ARN, person.personId);
    try {
      await (d.chime ?? chimeIdentity).send(new PutAppInstanceUserExpirationSettingsCommand({
        AppInstanceUserArn: userArn,
        ExpirationSettings: { ExpirationDays: 1, ExpirationCriterion: 'CREATED_TIMESTAMP' },
      }));
    } catch (err) {
      // A VISITOR WHO NEVER EXPIRES IS NOT A VISITOR: refused rather than left behind forever.
      throw new GuestRefused('unavailable', `the visitor's expiration could not be set: ${(err as Error)?.name || 'error'}`);
    }
    await (d.tag ?? tagIdentity)(person.personId, c.classification);

    try {
      await (d.audit ?? recordAccess)({
        _auditEvent: 'guest_notice_shown',
        timestamp: new Date(nowMs).toISOString(),
        personId: person.personId,
        personArn: userArn,
        issuer: c.issuerId,
        noticeVersion: c.settings.noticeVersion,
      });
    } catch (err) {
      throw new GuestRefused('unavailable', `the notice shown could not be recorded: ${(err as Error)?.message || 'error'}`);
    }

    const invoked = await lambdaOf(d).send(new InvokeCommand({
      FunctionName: creator,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify({ kind: 'guest', classification: c.classification, userArn })),
    }));
    const created = invoked?.FunctionError ? null : JSON.parse(new TextDecoder().decode(invoked?.Payload)) as { ok: boolean; channelArn?: string; channelId?: string; error?: string };
    if (!created?.ok || !created.channelArn || !created.channelId) {
      throw new GuestRefused('unavailable', `the visitor's conversation could not be opened: ${created?.error || invoked?.FunctionError || 'no answer'}`);
    }

    let signed;
    try {
      signed = await signGuestToken({
        keyArn: c.signingKeyArn, kid: c.signingKid, iss: c.issuerUri, aud: c.deploymentId,
        sub: subject, ch: created.channelId, ttlSeconds: c.settings.tokenMinutes * 60,
      }, { kms: d.kms, now: () => nowMs });
    } catch (err) {
      if ((err as { name?: string }).name === 'ThrottlingException') guestMetric('GuestSigningThrottled');
      throw new GuestRefused('unavailable', `the guest token could not be signed: ${(err as Error)?.name || 'error'}`);
    }

    const familyId = randomUUID();
    const sessionEndsAt = now + GUEST_LIFETIME_HOURS * 3600;
    await docOf(d).send(new PutCommand({
      TableName: tokensTable,
      Item: tokenRecordOf('guest-family', familyId, {
        channelArn: created.channelArn, personArn: userArn, issuer: c.issuerId, expiresAt: sessionEndsAt, status: 'active',
      }),
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    const refresh = await issueRefresh(tokensTable, c, {
      familyId, subject, sessionEndsAt, channelArn: created.channelArn, personArn: userArn,
    }, now, d);
    const session = await vendGuestSession({
      personId: person.personId, channelId: created.channelId, classification: c.classification, roleArn: c.guestRoleArn,
    }, { sts: d.sts });
    // THE FUNNEL'S FIRST STAGE (B12), on the visitor and the conversation their journey is named by. The
    // archive is its one count: no metric beside it.
    await recordFunnelStage({ stage: 'guest_started', personArn: userArn, journeyChannelArn: created.channelArn }, d.funnel);
    // The classification the session is vended at, under the exchange's one wire field.
    const accessClass = c.classification;
    return reply(event, 200, {
      guestToken: signed.token,
      guestTokenExpiresAt: signed.claims.exp,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
      sessionEndsAt,
      channelArn: created.channelArn,
      userArn,
      noticeVersion: c.settings.noticeVersion,
      credentials: session.credentials,
      tier: accessClass,
      identity: 'chat',
      scopedTo: created.channelArn,
    });
  } catch (err) {
    if (err instanceof GuestRefused) return refuse(event, err, 'start', d);
    if (err instanceof PersonNotActive) return refuse(event, new GuestRefused('unavailable', 'the minted visitor is not active'), 'start', d);
    console.error('[GuestSession] guest start failed', { err: (err as Error)?.name, message: (err as Error)?.message });
    return refuse(event, new GuestRefused('unavailable', (err as Error)?.name || 'error'), 'start', d);
  }
}

// ── GUEST REFRESH ────────────────────────────────────────────────────────────────────────────────

export async function guestRefresh(event: any, d: GuestDeps = {}): Promise<HttpResult> {
  const c = d.config === undefined ? guestConfigFromEnv() : d.config;
  if (!c) return refusal(event, 'unavailable', 404);
  const body = parseBody(event);
  const presented = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (!presented || presented.length > 128) return refusal(event, 'invalid_request', 400);
  // A SIGN-IN HAND-OFF (path A): the widget asks for one with the hash of a secret it keeps in the page.
  const bindSecretHash = body?.bindSecretHash === undefined ? undefined : String(body.bindSecretHash);
  if (bindSecretHash !== undefined && !BIND_SECRET_HASH.test(bindSecretHash)) return refusal(event, 'invalid_request', 400);
  const nowMs = (d.now ?? Date.now)();
  const now = Math.floor(nowMs / 1000);

  try {
    await requireNotPaused(ssmOf(d), c.killSwitchParameter, nowMs);
    const table = await laterStackParameter(c.tokensTableParameter, d);
    const doc = docOf(d);

    const redeemed = await redeemToken(doc, table, 'guest-refresh', presented, {
      now, extra: { graceUntil: now + REFRESH_REUSE_GRACE_SECONDS },
    });
    let record: TokenRecord;
    if (redeemed.ok) {
      record = redeemed.record;
    } else if (redeemed.reason === 'consumed' && redeemed.record) {
      // A USED CREDENTIAL AGAIN: another tab of the same visitor inside the grace, or a replay.
      record = redeemed.record;
      // ...OR THE VISIT BECAME AN ACCOUNT. A path A bind spends the credential the open widget still holds and
      // ends its family with `revokedBy: 'bind'` (lib/guest-bind.ts), so that widget's next refresh is not an
      // attack: it is answered as an ended visit, with no security event and no replay metric, which would
      // otherwise rise with every successful sign-up.
      const boundFamily = await readTokenRecord(doc, table, familyKey(String(record.familyId)));
      if (boundFamily?.status === 'revoked' && boundFamily.revokedBy === 'bind') return refusal(event, 'ended', 401);
      const reused = await doc.send(new UpdateCommand({
        TableName: table,
        Key: { pk: record.pk },
        UpdateExpression: 'ADD reuses :one',
        ConditionExpression: 'graceUntil >= :now AND (attribute_not_exists(reuses) OR reuses < :limit)',
        ExpressionAttributeValues: { ':one': 1, ':now': now, ':limit': REFRESH_REUSE_LIMIT },
      })).then(() => true, (err: { name?: string }) => {
        if (err?.name === 'ConditionalCheckFailedException') return false;
        throw err;
      });
      if (!reused) {
        // A REPLAY REVOKES THE FAMILY: every credential in it, the latest legitimate one included.
        await doc.send(new UpdateCommand({
          TableName: table,
          Key: { pk: familyKey(String(record.familyId)) },
          UpdateExpression: 'SET #s = :revoked, revokedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now },
        }));
        console.warn('[GuestSession][SecurityEvent] a used refresh credential was replayed; its family is revoked', { personArn: record.personArn });
        guestMetric('GuestRefreshReplayed');
        return refusal(event, 'replayed', 401);
      }
    } else {
      return refusal(event, redeemed.reason === 'expired' ? 'expired' : 'invalid_request', 401);
    }

    // THE FAMILY, AND THE VISITOR, ARE STILL THERE.
    const family = await readTokenRecord(doc, table, familyKey(String(record.familyId)));
    if (!family || family.status !== 'active') return refusal(event, 'revoked', 401);
    const sessionEndsAt = Number(record.sessionEndsAt);
    if (!(sessionEndsAt > now)) return refusal(event, 'ended', 401);
    const state = await (d.identityState ?? identityStateOf)(c.issuerId, String(record.subject));
    if (state.state !== 'active' || state.personArn !== record.personArn) return refusal(event, 'revoked', 401);

    const channelId = literalChannelId(record.channelArn);
    if (!channelId) return refusal(event, 'revoked', 401);
    let signed;
    try {
      signed = await signGuestToken({
        keyArn: c.signingKeyArn, kid: c.signingKid, iss: c.issuerUri, aud: c.deploymentId,
        sub: String(record.subject), ch: channelId,
        ttlSeconds: Math.min(c.settings.tokenMinutes * 60, sessionEndsAt - now),
      }, { kms: d.kms, now: () => nowMs });
    } catch (err) {
      if ((err as { name?: string }).name === 'ThrottlingException') guestMetric('GuestSigningThrottled');
      throw new GuestRefused('unavailable', `the guest token could not be signed: ${(err as Error)?.name || 'error'}`);
    }
    const next = await issueRefresh(table, c, {
      familyId: String(record.familyId), subject: String(record.subject), sessionEndsAt,
      channelArn: record.channelArn, personArn: record.personArn,
    }, now, d);
    // THE HAND-OFF NAMES THE CREDENTIAL THIS REFRESH ISSUED, and the hash of the widget's secret. The nonce
    // goes into the sign-in link; the secret never leaves the widget except to the tab it opened.
    let bindNonce: string | undefined;
    if (bindSecretHash) {
      bindNonce = newPlatformToken();
      await putToken(docOf(d), table, tokenRecordOf('guest-bind', bindNonce, {
        channelArn: record.channelArn,
        personArn: record.personArn,
        issuer: c.issuerId,
        expiresAt: Math.min(now + BIND_HANDOFF_SECONDS, sessionEndsAt),
        refreshPk: tokenKey('guest-refresh', next.token),
        secretHash: bindSecretHash,
      }));
    }
    return reply(event, 200, {
      ...(bindNonce ? { bindNonce } : {}),
      guestToken: signed.token,
      guestTokenExpiresAt: signed.claims.exp,
      refreshToken: next.token,
      refreshExpiresAt: next.expiresAt,
      sessionEndsAt,
      channelArn: record.channelArn,
      userArn: record.personArn,
    });
  } catch (err) {
    if (err instanceof GuestRefused) return refuse(event, err, 'refresh', d);
    console.error('[GuestSession] guest refresh failed', { err: (err as Error)?.name, message: (err as Error)?.message });
    return refuse(event, new GuestRefused('unavailable', (err as Error)?.name || 'error'), 'refresh', d);
  }
}
