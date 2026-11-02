/**
 * WHAT BOTH CREDENTIAL EXCHANGES SHARE: the person exchange (`credential-exchange.ts`, in `Identity`) and
 * the admin credential exchange (`admin-credential-exchange.ts`, in `AdminServices`).
 *
 * Two handlers, one way of vending: the caller is read from a verified source only (the authorizer's
 * claims or a console session the gateway authenticated), never from the body; every AssumeRole carries
 * the `person` and `classification` session tags the role trusts; every operator access is recorded
 * before the credential leaves (`accessRecorded`); and a person's identity carries their clearance as a
 * tag and their IdP name as its cached `Name`.
 */
import { STSClient } from '@aws-sdk/client-sts';
import {
  CreateAppInstanceUserCommand,
  DescribeAppInstanceUserCommand,
  UpdateAppInstanceUserCommand,
  TagResourceCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { ADMIN_ROLE_GROUP, type AdminRole } from '../../../lib/config/admin-capabilities.js';
import { ADMIN_TWIN_OWNER_TAG, userArnFor } from './person-arn.js';
import { recordAccess, type AccessAuditLine } from './access-log.js';
import { edgeCallerOf, edgeNamesAnUntrustedIssuer } from './auth.js';
import { claimValues, groupsOf, holderOfClaims, type TrustedIssuer } from '../../../lib/config/issuers.js';
import { responder, originsFrom, requestOrigin, DEV_ORIGIN, type HttpResult } from './http-response.js';
import { chimeIdentityClient, chimeMessagingClient } from './chime/clients.js';
import { accountStateOfPerson, defaultDirectory, type AccountState, type Directory } from './membership-source.js';
import { issuerById } from './trusted-issuers.js';

export const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
export const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
/** The channel ARN prefix of this app instance. */
export const CHANNEL_PREFIX = `${APP_INSTANCE_ARN}/channel/`;
// Both consoles may call an exchange, so ALLOWED_ORIGIN is a comma list and the matching request Origin
// is echoed. '*' short-circuits to allow-all, and only when a stack sets it explicitly: an unset value
// falls to the local dev origin, never to every origin.
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN, { trim: true, dropEmpty: true });
/**
 * How long an elevated credential lasts: enough to perform the action, then it expires (STS minimum is
 * 900s). Bounds the window in which an elevated credential exists at all.
 */
export const MODERATION_SESSION_SECONDS = Number(process.env.EXCHANGE_MODERATION_SESSION_SECONDS || '1800');
/** The longest reason a vend records. A reason is a sentence, not a document. */
export const MAX_REASON_LENGTH = 500;

export const sts = new STSClient({ region: AWS_REGION });
export const chimeIdentity = chimeIdentityClient({ region: AWS_REGION });
export const chimeMessaging = chimeMessagingClient({ region: AWS_REGION });

/**
 * Capability -> Amazon Chime SDK action set. A request names capabilities; the exchange vends a session
 * policy scoped to exactly those actions on the requested resource. The role is the boundary, so a
 * capability the role does not grant is denied by the intersection. `view` + `participate` is the
 * ordinary chat set (default).
 */
export const CAPABILITY_ACTIONS: Record<string, string[]> = {
  view: [
    'chime:GetChannelMessage', 'chime:ListChannelMessages',
    'chime:DescribeChannel', 'chime:ListChannelMemberships',
    // The channel's live moderator list, so the client reads "am I a moderator" from the authoritative
    // source instead of inferring it from createdBy. A member may read who moderates a channel they see.
    'chime:ListChannelModerators',
    // The user-scoped discovery action: the channels the caller is a member of. Pinned to the caller's
    // own user ARN by the role boundary, so it only ever enumerates the caller's OWN memberships.
    'chime:ListChannelMembershipsForAppInstanceUser',
  ],
  participate: ['chime:SendChannelMessage', 'chime:UpdateChannelReadMarker'],
  redact: ['chime:RedactChannelMessage'],
  delete: ['chime:DeleteChannelMessage'],
  'manage-membership': [
    'chime:CreateChannelMembership', 'chime:DeleteChannelMembership', 'chime:CreateChannelModerator',
  ],
  'manage-channel': ['chime:UpdateChannel', 'chime:DeleteChannel'],
  // Owner rename: UpdateChannel WITHOUT delete, and deliberately NOT a moderation capability, so it is
  // allowed on the chat plane. Amazon Chime SDK still authorizes the call on ChannelModerator status, so a
  // member who is not a moderator is denied. Delete stays admin-only.
  rename: ['chime:UpdateChannel'],
};

/**
 * Capabilities that mutate a channel. Vended ONLY by the admin credential exchange, on the
 * `${personId}-admin` identity, and always scoped to one channel.
 */
export const MODERATION_CAPS = new Set(['redact', 'delete', 'manage-membership', 'manage-channel']);

/** What an exchange answers with. */
export interface ExchangeResult {
  credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration?: string };
  userArn: string;
  tier: string;
  identity: 'chat' | 'admin';
  scopedTo?: string | null;
  // A DISPLAY HINT, never a grant: whether the chat app shows its link to the admin console. It vends
  // nothing; admin reach is issued only by the admin credential exchange, with a console session and a
  // stated reason, onto the separate `-admin` AppInstanceUser.
  consoleRole?: AdminRole | null;
  // Path A only: the visitor this sign-in was just bound to, the conversation they had, which this session
  // does not reach, and the conversation the visit continues in, which it does (`lib/guest-bind.ts`).
  bound?: { from: 'guest'; channelArn: string; conversationArn: string };
  // A sign-in redemption only: the conversation the invitation was to, which the person is already in.
  invitation?: { channelArn: string };
  // S3 attachment vend only: the bucket + region the client needs to presign the scoped GetObject with
  // the vended credentials. The session policy already confines the read to one channel's keys, so the
  // bucket name is not itself a grant.
  bucket?: string;
  region?: string;
}

const http = responder({
  origin: { allow: ALLOWED_ORIGINS, wildcard: true },
  allowHeaders: 'Authorization,Content-Type',
  methods: 'POST,OPTIONS',
  vary: false,
});
export const corsOrigin = (event: any): string => http.allowOrigin(requestOrigin(event));
export const cors = (event: any): Record<string, string> => http.headers(requestOrigin(event));

/** A JSON answer with this exchange's CORS headers. */
export function reply(event: any, statusCode: number, body: unknown): HttpResult {
  return { statusCode, headers: cors(event), body: JSON.stringify(body) };
}

/** The credential triple of an AssumeRole answer, or a throw when STS returned none. */
export function credentialsOf(assumed: { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } }): ExchangeResult['credentials'] {
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('AssumeRole returned no credentials');
  return {
    AccessKeyId: c.AccessKeyId,
    SecretAccessKey: c.SecretAccessKey,
    SessionToken: c.SessionToken,
    Expiration: c.Expiration ? new Date(c.Expiration).toISOString() : undefined,
  };
}

/**
 * WRITE THE ACCESS RECORD, OR WITHHOLD THE CREDENTIAL (ADR-052, SPEC-ADMIN-CONSOLE FR30).
 *
 * The audit line still goes to CloudWatch, and the same line is written durably to the Access Log
 * before the credential leaves. A record that cannot be written returns 503 and the credential just
 * minted is never handed over, so no operator holds an access nobody can account for.
 */
export async function accessRecorded(event: any, line: AccessAuditLine): Promise<HttpResult | null> {
  console.log(JSON.stringify(line));
  try {
    await recordAccess(line);
    return null;
  } catch (err) {
    console.error('[CredentialExchange][SecurityEvent] the access record could not be written; the credential is withheld', {
      auditEvent: line._auditEvent, err: (err as Error)?.message,
    });
    return reply(event, 503, { error: 'Access cannot be recorded right now, so it is not granted', code: 'ACCESS_LOG_UNAVAILABLE' });
  }
}

/** Parse the `cognito:groups` claim: an array, a JSON-ish `[a b]` string, or a comma/space list. */
export function parseGroups(raw: unknown): string[] {
  return claimValues(raw);
}

/**
 * The ENUM TOKEN a caller is vended at: the name of the classification role, the value asserted on the session,
 * and the tag written on their identity, resolved once.
 *
 * `resolveHolderToken` takes the UNION of what every held group clears for and returns the declared
 * classification whose grant set IS that union, so holding several is expressible and the answer is
 * still one short token. NOTHING IS VENDED WHEN THE COMBINATION IS UNNAMED: an undeclared combination
 * gets `undefined`, never the nearest fit, and the caller refuses the exchange.
 */
export function resolveRoleKey(groups: string[]): string | undefined {
  return profiles.resolveHolderToken(groups);
}

/**
 * WHICH CONSOLE ROLE A PERSON HOLDS: ADMIN ACCESS, decided from their issuer and groups and never from the
 * chat token. An issuer that does not declare `admin: true` has no admins (A6); one that does marks its
 * admins by its admin groups (`adminGroups`, default `admins`), the same rule `requireAdmin` and the
 * directory's `clearanceOf` apply. Holding the admin plane CLASSIFICATION clears a chat identity for admin
 * conversations and is not this (SPEC-ADMIN-IDENTITY FR1). Null when the person holds no admin capability.
 */
export function consoleRoleFor(issuer: Pick<TrustedIssuer, 'admin' | 'adminGroups'>, groups: string[]): AdminRole | null {
  if (issuer.admin !== true) return null;
  const adminGroups = issuer.adminGroups ?? [ADMIN_ROLE_GROUP.admins];
  if (groups.some((g) => adminGroups.includes(g))) return 'admins';
  if (groups.includes(ADMIN_ROLE_GROUP['team-members'])) return 'team-members';
  return null;
}

/** A token's caller, through their issuer's registry entry. */
export interface TokenCaller {
  issuer: TrustedIssuer;
  /** The subject the issuer's entry declares (`sub`, or Entra's `tid` and `oid`). Never `cognito:username`. */
  subject: string;
  claims: Record<string, unknown>;
  groups: string[];
  /** The token the caller holds, or undefined for a combination nobody declared. */
  roleKey: string | undefined;
  /** Whether the caller holds the admin plane classification beside (or as) their token: admin conversations. */
  adminPlane: boolean;
}

/**
 * ONE EXCHANGE FOR EVERY ISSUER. The edge authorizer matched the token's `iss` to its entry in the
 * trusted-issuer registry (`lib/config/issuers.ts`). Everything that differs between two people follows from that entry: the
 * subject claim, where their clearance comes from and the classifications it may grant, whether they may hold an admin role,
 * and whether they are vended one conversation. A token from an issuer the registry does not declare
 * reaches nothing.
 */
export function tokenCallerOf(event: any): TokenCaller | HttpResult {
  // THE EDGE AUTHORIZER VERIFIED THE TOKEN and names its issuer, subject and the claims the registry
  // reads (`edgeCallerOf`, lib/auth.ts). A request it did not authorize, or one naming an issuer this
  // function does not trust, reaches nothing.
  const edge = edgeCallerOf(event);
  if (!edge) {
    if (!edgeNamesAnUntrustedIssuer(event)) return reply(event, 401, { error: 'Unauthenticated' });
    console.warn('[CredentialExchange][SecurityEvent] a token from an issuer this function does not trust; vending nothing');
    return reply(event, 403, { error: 'this sign-in is from an issuer this deployment does not trust', code: 'ISSUER_NOT_TRUSTED' });
  }
  const { issuer, subject, claims } = edge;
  if (!subject) return reply(event, 401, { error: 'Unauthenticated' });
  const holder = holderOfClaims(issuer, claims, profiles);
  return {
    issuer,
    subject,
    claims,
    groups: groupsOf(issuer, claims),
    roleKey: holder.token,
    adminPlane: holder.adminPlane,
  };
}

export function isRefusal(v: unknown): v is HttpResult {
  return !!v && typeof (v as HttpResult).statusCode === 'number' && typeof (v as HttpResult).body === 'string';
}

/**
 * WHETHER THE CALLER'S ACCOUNT MAY STILL SIGN IN, asked of its issuer now (SPEC-CREDENTIAL-EXCHANGE §4b,
 * "An account disabled at its issuer"). Both exchanges call this right after `tokenCallerOf`, at every
 * vend (the first sign-in and each refresh), before anything is minted, bound or recorded.
 *
 *  - The issuer answers the account `active`: null, and the vend goes on.
 *  - `disabled` or `gone`: 403 `PERSON_NOT_ACTIVE`. Nothing is minted and nothing recorded.
 *  - The directory cannot be read: 503 `DIRECTORY_UNAVAILABLE`, and nothing is vended. FAIL CLOSED: a
 *    failed read is never taken for an enabled account.
 *
 * An issuer whose directory keeps no account state (an `oidc` token, a host assertion) is answered by the
 * token the edge verified, with no call (`Directory.accountState`). `directory` is injected for tests.
 */
export async function refuseInactiveAccount(
  event: any,
  caller: Pick<TokenCaller, 'issuer' | 'subject'>,
  directory: { accountState(issuer: string, subject: string): Promise<AccountState> } = defaultDirectory(),
): Promise<HttpResult | null> {
  let state: AccountState;
  try {
    state = await directory.accountState(caller.issuer.id, caller.subject);
  } catch (err) {
    console.error('[CredentialExchange] the issuer\'s directory could not be read; vending nothing', {
      issuer: caller.issuer.id, err: (err as Error)?.name,
    });
    return reply(event, 503, { error: 'the identity provider could not be asked whether this sign-in is active; retry', code: 'DIRECTORY_UNAVAILABLE' });
  }
  if (state === 'active') return null;
  console.warn('[CredentialExchange][SecurityEvent] the issuer reports this account is not active; vending nothing', {
    issuer: caller.issuer.id, state,
  });
  return reply(event, 403, { error: 'this sign-in is not active', code: 'PERSON_NOT_ACTIVE' });
}

/**
 * WHETHER THE PERSON A CONSOLE SESSION NAMES MAY STILL SIGN IN, asked of their issuers now, at every admin
 * vend (SPEC-CREDENTIAL-EXCHANGE §4b). A console session outlives the moment it was issued, so a
 * per-capability or attachment credential is not minted from the session alone: the person's subjects are
 * read from `Identities` (the `byPerson` index), and each subject at an issuer that declares `admin: true`
 * (the only issuers a console session is issued through) is asked of that issuer (`accountStateOfPerson`).
 *
 *  - Any of those accounts is active: null, and the vend goes on.
 *  - None is (disabled, or gone): 403 `PERSON_NOT_ACTIVE`. Nothing is assumed and nothing recorded.
 *  - `Identities` or an issuer cannot be read: 503 `DIRECTORY_UNAVAILABLE`. FAIL CLOSED.
 *
 * `directory` and `adminIssuer` are injected for tests.
 */
export async function refuseInactivePerson(
  event: any,
  personArn: string,
  directory: Pick<Directory, 'accountState'> = defaultDirectory(),
  adminIssuer: (issuer: string) => boolean = (id) => issuerById(id)?.admin === true,
): Promise<HttpResult | null> {
  let state: AccountState;
  try {
    state = await accountStateOfPerson(personArn, directory, { through: adminIssuer });
  } catch (err) {
    console.error('[AdminCredentialExchange] the person\'s issuers could not be asked; vending nothing', { err: (err as Error)?.name });
    return reply(event, 503, { error: 'the identity provider could not be asked whether this sign-in is active; retry', code: 'DIRECTORY_UNAVAILABLE' });
  }
  if (state === 'active') return null;
  console.warn('[AdminCredentialExchange][SecurityEvent] the person\'s admin sign-in is not active; vending nothing', { state });
  return reply(event, 403, { error: 'this sign-in is not active', code: 'PERSON_NOT_ACTIVE' });
}

/**
 * A display name, best-first: a real name claim; else the email LOCAL part (name-like, far better than a
 * GUID in the mention menu); else `cognito:username` when it is not a UUID; else the fallback. Never an
 * address.
 */
export function displayNameOf(claims: Record<string, unknown>, fallback = ''): string {
  const emailLocal = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email.split('@')[0] : '';
  const uname = (claims['cognito:username'] || '').toString();
  const unameUsable = uname && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(uname) ? uname : '';
  return (claims.name || emailLocal || unameUsable || fallback).toString();
}

/**
 * Create an identity if it does not exist, and carry a clearance on it.
 *
 * THE DISPLAY NAME BELONGS TO THE IDENTITY PROVIDER. The AppInstanceUser `Name` is a cache of it, kept
 * current from the verified token's `name` claim, which the caller cannot set for themselves. Only a real
 * name claim refreshes it.
 *
 * TAGGED SEPARATELY, NOT ON CREATE. `CreateAppInstanceUser` with `Tags` requires `chime:TagResource` as
 * well, so on a role without it the CREATE itself fails, and coupling the tag to the create turned a
 * missing permission on a decorative field into a total authentication outage (measured live). The tag is
 * a separate best-effort call, re-attempted on the next exchange.
 */
export async function ensureAppInstanceUser(userId: string, name: string, clearance?: string, idpName?: string, ownerArn?: string): Promise<void> {
  try {
    await chimeIdentity.send(new CreateAppInstanceUserCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      AppInstanceUserId: userId,
      Name: name,
    }));
    await tagIdentity(userId, clearance, ownerArn);
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
    await classifyIdentity(userId, clearance, idpName, false, ownerArn);
  }
}

/**
 * Stamp the clearance on an identity and, for one that already existed, bring its name up to the IdP's.
 * The repair path, on every exchange: an untagged identity becomes classified, and a promotion or
 * demotion is re-stamped, without a migration.
 */
export async function classifyIdentity(
  userId: string, clearance: string | undefined, idpName: string | undefined, created: boolean, ownerArn?: string,
): Promise<void> {
  await tagIdentity(userId, clearance, ownerArn);
  if (!created) await refreshDisplayName(userId, idpName);
}

/**
 * `ownerArn` is set only for an admin-plane twin: the AppInstanceUser ARN of the person it belongs to,
 * stamped as its `owner` tag on every console session like the classification.
 */
export async function tagIdentity(userId: string, clearance: string | undefined, ownerArn?: string): Promise<void> {
  const tags = [
    ...(clearance ? [{ Key: 'classification', Value: clearance }] : []),
    ...(ownerArn ? [{ Key: ADMIN_TWIN_OWNER_TAG, Value: ownerArn }] : []),
  ];
  if (!tags.length) return;
  try {
    await chimeIdentity.send(new TagResourceCommand({ ResourceARN: userArnFor(APP_INSTANCE_ARN, userId), Tags: tags }));
  } catch (e) {
    // NEVER FATAL. The tag makes the clearance readable on the identity; it is not what enforces it.
    console.warn('[CredentialExchange] could not tag the identity with its clearance (non-fatal):', e);
  }
}

/**
 * Bring an existing identity's cached `Name` up to the IdP's. Read before write: `UpdateAppInstanceUser`
 * replaces `Metadata` along with `Name`, and an unchanged name costs one read and no write. Never fatal.
 */
export async function refreshDisplayName(userId: string, idpName: string | undefined): Promise<void> {
  const wanted = idpName?.trim().slice(0, 100);
  if (!wanted) return;
  const userArn = userArnFor(APP_INSTANCE_ARN, userId);
  try {
    const current = await chimeIdentity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: userArn }));
    const user = current.AppInstanceUser;
    if (user?.Name === wanted) return;
    await chimeIdentity.send(new UpdateAppInstanceUserCommand({ AppInstanceUserArn: userArn, Name: wanted, Metadata: user?.Metadata ?? '' }));
  } catch (e) {
    console.warn('[CredentialExchange] could not refresh the display name from the IdP (non-fatal):', e);
  }
}

/**
 * ONE CONVERSATION, NAMED LITERALLY. A prefix test passes `${APP_INSTANCE_ARN}/channel/*`, and a session
 * policy writes the requested ARN straight into its Resource, so a wildcard would reach every
 * conversation for the credential's lifetime. The id after the prefix is a literal or it is refused.
 */
export function literalChannelId(channelArn: string): string | null {
  if (!APP_INSTANCE_ARN || !channelArn.startsWith(CHANNEL_PREFIX)) return null;
  const id = channelArn.slice(CHANNEL_PREFIX.length);
  return /^[A-Za-z0-9._-]+$/.test(id) ? id : null;
}
