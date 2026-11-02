/**
 * THE PERSON CREDENTIAL EXCHANGE (docs/SPEC-CREDENTIAL-EXCHANGE.md).
 *
 * The one way a person obtains AWS credentials, and the one minter of a person's AppInstanceUser
 * (`lib/person-identity.ts`). It `AssumeRole`s the caller's classification role **with a `person` session
 * tag**, so that role's policy pins the bearer to `…/user/${aws:PrincipalTag/person}`: the caller can act
 * only as their OWN AppInstanceUser.
 *
 * Identity comes from the edge authorizer's context (`edgeCallerOf`, lib/auth.ts), NEVER from the request
 * body (IDOR guard). The edge matched the token's issuer to the trusted-issuer registry, which
 * decides the subject, the clearance and the classifications it may grant, and whether the person is vended one conversation.
 *
 * THE GUEST'S ENTRY POINTS ARE HERE TOO (`guest-session.ts`): guest start, which mints an anonymous
 * visitor, opens their conversation and vends their first session, and guest refresh, which rotates their
 * refresh credential. Both routes take no token and run their own abuse controls first. A guest token
 * presented at this exchange afterwards is vended the conversation it names and nothing else.
 *
 * A HOST ASSERTION (`host-assertion`, A9) is spent here before anything else: its `jti`, which the edge
 * recorded, is consumed (`spendHostAssertion`), then its subject is bound to the person `provisionSubject`
 * pre-assigned (`bindProvisionedPerson`), and its permission set is mapped through the issuer's clearance
 * within its declared classifications. A subject nobody provisioned is refused and nothing is created; a permission set the
 * mapping does not declare reaches nothing. Any `provisioned-only` issuer is bound the same way, never
 * minted for (P-13).
 *
 * A VISITOR BECOMES AN ACCOUNT HERE (path A, `lib/guest-bind.ts`): a first sign-in whose body carries the
 * live guest session's refresh credential (`bindGuest`) is bound to the visitor's AppInstanceUser instead
 * of minted, in one transaction that also ends the guest credential, and the visit continues in a new
 * conversation at the account's own classification, which the answer names (`bound.conversationArn`).
 * A SECOND ISSUER IS LINKED HERE (B7, `lib/issuer-link.ts`): a pinned person's session plus a second issuer's token (`linkIssuer`) adds the
 * second subject's row for the same AppInstanceUser, and nothing else is vended by that call.
 *
 * AN INVITATION IS MINTED FOR AND REDEEMED HERE (M-10, `lib/invitation-redemption.ts`): the invitee's
 * AppInstanceUser on the invitations function's invocation (`mint-invitee`); the landing page's read
 * (`/invitations/peek`) and its `link` redemption (`/invitations/redeem`), both unauthenticated with their
 * own controls; and a `sign-in` redemption, a first sign-in whose body carries the invitation
 * (`bindInvitation`), which binds the subject to the invitee instead of minting.
 *
 * A DISABLED ACCOUNT IS REFUSED AT EVERY VEND (`refuseInactiveAccount`, lib/vend.ts): the issuer is asked
 * whether the account may still sign in before anything is minted or recorded, at the first sign-in and
 * at each refresh, and a directory that cannot be read vends nothing (SPEC-CREDENTIAL-EXCHANGE §4b).
 *
 * ONLY THE PERSON PLANE IS HERE. A console session, a per-conversation admin credential and a team
 * attachment read are the admin credential exchange's (`admin-credential-exchange.ts`, in the
 * `AdminServices` stack), which exists with the `admin` capability. This exchange vends none of them and
 * holds no role that could.
 */
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { userArnFor } from './lib/person-arn.js';
import { resolveExchangeRoleArn } from './lib/exchange-role-arn.js';
import { ADMIN_PLANE_SESSION_TAG } from '../../lib/profile-registry';
import { bindProvisionedPerson, mintOrResolvePerson, PersonNotActive, PersonNotProvisioned, recordClearanceDecision } from './lib/person-identity.js';
import { clearanceBasisOf, isGuestIssuer, isProvisionedOnly, oneChannelOf, type TrustedIssuer } from '../../lib/config/issuers.js';
import { countExchangeRefusal, spendHostAssertion } from './lib/host-assertion-exchange.js';
import { guestConfigFromEnv, guestRefresh, guestStart, vendGuestSession } from './guest-session.js';
import type { HttpResult } from './lib/http-response.js';
import { defaultContactCopyStore, writeContactCopy } from './lib/claims-directory.js';
import { edgeCallerOf } from './lib/auth.js';
import { bindGuestPerson, bindRequestOf, BindRefused, boundVisitOf, continueBoundVisit } from './lib/guest-bind.js';
import { linkRequestOf, linkSecondIssuer, LinkRefused } from './lib/issuer-link.js';
import {
  InvitationRefused,
  bindInvitation,
  invitationRequestOf,
  isMintInviteeOperation,
  mintInviteeOperation,
  peekInvitation,
  redeemLink,
} from './lib/invitation-redemption.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  APP_INSTANCE_ARN,
  CAPABILITY_ACTIONS,
  CHANNEL_PREFIX,
  chimeIdentity,
  MODERATION_CAPS,
  classifyIdentity,
  consoleRoleFor,
  cors,
  credentialsOf,
  displayNameOf,
  isRefusal,
  literalChannelId,
  parseGroups,
  refuseInactiveAccount,
  reply,
  resolveRoleKey,
  sts,
  tokenCallerOf,
  type ExchangeResult,
} from './lib/vend.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

export { parseGroups, resolveRoleKey, consoleRoleFor };

/** The person the edge resolved the token to, when it resolved one. */
const edgePersonIdOf = (event: any): string | undefined => edgeCallerOf(event)?.personId ?? undefined;

/**
 * THE ROLE A ONE-CONVERSATION PERSON IS VENDED ON: the `restricted` role, bounded by the session policy
 * to one channel and by membership, never by a classification tag (SPEC-CONVERSATION-SECURITY 4a).
 */
const EXCHANGE_ROLE_RESTRICTED = process.env.EXCHANGE_ROLE_RESTRICTED || '';
/** How long a one-conversation credential lasts. */
const ONE_CHANNEL_SESSION_SECONDS = 3600;
const SESSION_DURATION_SECONDS = Number(process.env.EXCHANGE_SESSION_SECONDS || '3600');

/** The capabilities this exchange vends: the chat set, and an owner's rename. */
const PERSON_CAPABILITIES = new Set(['view', 'participate', 'rename']);

/**
 * THE CONTACT COPY (C5), for an issuer whose directory is `claims`: the contact claims of THIS sign-in
 * replace the last ones. Best-effort: a person is never refused a credential because their address could
 * not be kept, and the failure is logged without the address.
 */
async function keepContactCopy(issuer: TrustedIssuer, personId: string, claims: Record<string, unknown>): Promise<void> {
  if (issuer.directory !== 'claims') return;
  try {
    await writeContactCopy({ personId, issuerId: issuer.id, contact: { email: claims.email, name: claims.name } }, defaultContactCopyStore());
  } catch (err) {
    console.warn('[CredentialExchange] the contact copy could not be kept (non-fatal)', { issuer: issuer.id, err: (err as Error)?.name });
  }
}

/**
 * THE ONE-CONVERSATION VEND, for a person whose issuer declares `clearance: { oneChannel }` (Q5).
 *
 * The least-trusted caller in the system, a person a host app embedded into one conversation, gets the
 * narrowest credential: read and participate, on the one channel they name, as their own AppInstanceUser,
 * for an hour, on the `restricted` role. The session policy names the channel; Amazon Chime SDK
 * membership is the second layer, so naming somebody else's conversation yields a credential that is
 * refused there.
 */
async function oneChannelVend(
  event: any,
  issuer: TrustedIssuer,
  subject: string,
  claims: Record<string, unknown>,
): Promise<HttpResult> {
  let body: { channelArn?: unknown; identity?: unknown; capabilities?: unknown };
  try {
    body = event?.body ? JSON.parse(event.body) : {};
  } catch {
    return reply(event, 400, { error: 'Malformed body' });
  }
  if (body?.identity === 'console' || body?.identity === 'admin' || (Array.isArray(body?.capabilities) && body.capabilities.length)) {
    return reply(event, 403, { error: 'a one-conversation sign-in is vended its one conversation and nothing else', code: 'ONE_CONVERSATION_ONLY' });
  }
  // REQUIRED, not optional: defaulting to `channel/*` when the field is missing would leave that grant
  // reachable by simply omitting it. Anchored to this app instance, with no wildcard and no path
  // traversal, so the policy resource cannot be widened by a crafted string.
  const channelArn = String(body?.channelArn || '');
  if (!APP_INSTANCE_ARN || !channelArn.startsWith(CHANNEL_PREFIX) || channelArn.includes('*') || channelArn.length > 512
    || channelArn.slice(CHANNEL_PREFIX.length).includes('/') || !channelArn.slice(CHANNEL_PREFIX.length)) {
    return reply(event, 400, { error: 'channelArn is required and must name one channel in this app instance' });
  }
  if (!EXCHANGE_ROLE_RESTRICTED) {
    console.error('[CredentialExchange] no restricted classification role is configured for a one-conversation vend');
    return reply(event, 500, { error: 'Exchange misconfigured' });
  }

  const displayName = String(claims.name || claims['cognito:username'] || '');
  let personId: string;
  try {
    personId = (await mintOrResolvePerson({ issuer: issuer.id, subject, name: displayName })).personId;
  } catch (err) {
    if (err instanceof PersonNotActive) return reply(event, 403, { error: 'this sign-in is not active', code: 'PERSON_NOT_ACTIVE' });
    console.error('[CredentialExchange] could not resolve the one-conversation person:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
  await keepContactCopy(issuer, personId, claims);
  const userArn = userArnFor(APP_INSTANCE_ARN, personId);
  try {
    const sessionPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'SessionAndConnect', Effect: 'Allow', Action: ['chime:GetMessagingSessionEndpoint', 'chime:Connect'], Resource: '*' },
        {
          Sid: 'OneConversation',
          Effect: 'Allow',
          // The read + participate set only. This person never moderates, never manages membership and
          // never renames: neither the list nor the role carries those.
          Action: [
            'chime:GetChannelMessage', 'chime:ListChannelMessages',
            'chime:DescribeChannel', 'chime:ListChannelMemberships',
            'chime:SendChannelMessage', 'chime:UpdateChannelReadMarker',
          ],
          Resource: [channelArn, userArn],
        },
      ],
    });
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: EXCHANGE_ROLE_RESTRICTED,
      RoleSessionName: `one-${personId}`.slice(0, 64),
      DurationSeconds: ONE_CHANNEL_SESSION_SECONDS,
      Policy: sessionPolicy,
      // BOTH ASSERTIONS, because the classification role's trust policy requires both: `person` pins the bearer,
      // and `classification` must equal the role's own, `restricted`.
      Tags: [
        { Key: 'person', Value: personId },
        { Key: 'classification', Value: 'restricted' },
      ],
    }));
    return reply(event, 200, {
      credentials: credentialsOf(assumed),
      userArn,
      tier: 'restricted',
      identity: 'chat',
      scopedTo: channelArn,
    });
  } catch (err) {
    console.error('[CredentialExchange] one-conversation vend failed:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
}

/**
 * A GUEST TOKEN IS VENDED ITS OWN CONVERSATION AND NOTHING ELSE: the one its signed `ch` claim names, on
 * the guest-session role. A body naming any other conversation, an identity or a capability is refused.
 */
async function guestVend(event: any, personId: string | undefined, claims: Record<string, unknown>): Promise<HttpResult> {
  const config = guestConfigFromEnv();
  if (!config) return reply(event, 403, { error: 'this deployment declares no guest issuer', code: 'GUEST_NOT_DECLARED' });
  if (!personId) return reply(event, 403, { error: 'this guest was never started', code: 'GUEST_NOT_STARTED' });
  let body: { channelArn?: unknown; identity?: unknown; capabilities?: unknown };
  try {
    body = event?.body ? JSON.parse(event.body) : {};
  } catch {
    return reply(event, 400, { error: 'Malformed body' });
  }
  const channelId = typeof claims.ch === 'string' ? claims.ch : '';
  const channelArn = `${CHANNEL_PREFIX}${channelId}`;
  if (!channelId || !literalChannelId(channelArn)) return reply(event, 403, { error: 'the guest token names no conversation', code: 'GUEST_NO_CONVERSATION' });
  if ((body?.identity !== undefined && body.identity !== 'chat')
    || (Array.isArray(body?.capabilities) && body.capabilities.length)
    || (body?.channelArn !== undefined && body.channelArn !== channelArn)) {
    console.warn('[CredentialExchange][SecurityEvent] a guest asked for more than their own conversation; vending nothing');
    return reply(event, 403, { error: 'a guest is vended their own conversation and nothing else', code: 'GUEST_ONE_CONVERSATION_ONLY' });
  }
  try {
    // The classification the session is vended at, sent back under the exchange's one wire field.
    const accessClass = config.classification;
    const session = await vendGuestSession({ personId, channelId, classification: accessClass, roleArn: config.guestRoleArn });
    return reply(event, 200, {
      credentials: session.credentials,
      userArn: session.userArn,
      tier: accessClass,
      identity: 'chat',
      scopedTo: session.channelArn,
    });
  } catch (err) {
    console.error('[CredentialExchange] guest vend failed:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
}

let exchangeDoc: DynamoDBDocumentClient | null = null;
const docClient = (): DynamoDBDocumentClient => (exchangeDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));

/** The request body as an object, or `{}` for none or a malformed one. */
function bodyOf(event: any): Record<string, unknown> {
  try {
    const parsed = event?.body ? JSON.parse(event.body) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * B7: LINK A SECOND ISSUER to the person this session is pinned to. Vends nothing: the person signs in
 * through the second issuer afterwards, as themselves.
 */
async function linkVend(event: any, issuer: TrustedIssuer, token: string): Promise<HttpResult> {
  const personArn = edgeCallerOf(event)?.personArn || (edgePersonIdOf(event) ? userArnFor(APP_INSTANCE_ARN, edgePersonIdOf(event)!) : '');
  if (!personArn) {
    return reply(event, 403, { error: 'a second issuer is linked from a session already signed in as the person', code: 'LINK_NEEDS_A_PERSON' });
  }
  try {
    const linked = await linkSecondIssuer({ personArn, issuer }, token, { doc: docClient() });
    return reply(event, 200, { linked: true, issuerId: linked.issuerId, userArn: linked.personArn, created: linked.created });
  } catch (err) {
    if (err instanceof LinkRefused) {
      console.warn('[CredentialExchange][SecurityEvent] a second-issuer link was refused', { code: err.code, issuer: issuer.id });
      return reply(event, err.status, { error: err.message, code: err.code });
    }
    console.error('[CredentialExchange] link failed:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
}

/** Which of this function's routes a request came in on: `resource` is the route's own path (payload 1.0). */
function routeOf(event: any): string {
  return String(event?.resource || event?.path || '');
}

export const handler = async (event: any): Promise<HttpResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  // THE INVITATIONS FUNCTION'S ONE INVOCATION: mint an invitee. No gateway request carries an `op` and no
  // request context, and only that function's role is granted the invoke.
  if (isMintInviteeOperation(event)) return mintInviteeOperation(event) as unknown as HttpResult;
  if (event?.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(event), body: '' };

  // THE GUEST'S TWO UNAUTHENTICATED ENTRY POINTS, AND THE INVITATION LANDING PAGE'S TWO. None reads an
  // authorizer context: there is none.
  const route = routeOf(event);
  if (route === '/guest/start') return guestStart(event);
  if (route === '/guest/refresh') return guestRefresh(event);
  if (route === '/invitations/peek') return peekInvitation(event);
  if (route === '/invitations/redeem') return redeemLink(event);

  const caller = tokenCallerOf(event);
  if (isRefusal(caller)) return caller;
  const { issuer, subject, claims, groups, roleKey, adminPlane } = caller;

  // A GUEST (the platform's own issuer) is vended the conversation its token names, on its own path.
  if (isGuestIssuer(issuer)) return guestVend(event, edgePersonIdOf(event), claims);

  // THE ISSUER IS ASKED WHETHER THIS ACCOUNT MAY STILL SIGN IN, before anything below mints, binds, spends
  // or records: a disabled or gone account is refused, and an unreadable directory vends nothing.
  const inactive = await refuseInactiveAccount(event, caller);
  if (inactive) return inactive;

  // A ONE-CONVERSATION ISSUER (`clearance: { oneChannel }`) is vended one conversation, on its own path,
  // and reaches nothing else this handler vends.
  if (oneChannelOf(issuer)) return oneChannelVend(event, issuer, subject, claims);

  // B7 AND PATH A ARE ASKED FOR IN THE BODY, and a malformed ask is refused rather than ignored: ignored,
  // a bind would silently mint a second person for the visitor.
  const requestBody = bodyOf(event);
  const link = linkRequestOf(requestBody);
  const bind = bindRequestOf(requestBody);
  const invitation = invitationRequestOf(requestBody);
  if (link === 'malformed' || bind === 'malformed') return reply(event, 400, { error: 'Malformed body', code: 'UPGRADE_MALFORMED' });
  if (invitation === 'malformed') return reply(event, 400, { error: 'Malformed body', code: 'invalid_request' });
  if ([link, bind, invitation].filter(Boolean).length > 1) return reply(event, 400, { error: 'a call binds a visitor, links an issuer or redeems an invitation, one at a time', code: 'UPGRADE_MALFORMED' });
  if (link) return linkVend(event, issuer, link.token);
  // A SIGN-IN WITH AN ACCOUNT IS PATH B, unless it is this visit's own bind retried: then the visit's
  // continuation is opened again (the same conversation), and nothing is bound twice.
  let boundReplay: string | null = null;
  if (bind && edgePersonIdOf(event)) {
    boundReplay = await boundVisitOf({ personId: edgePersonIdOf(event)!, request: bind }, { doc: docClient() });
    if (!boundReplay) {
      return reply(event, 409, { error: 'this sign-in already has an account; a registration claim carries the visit into it', code: 'SUBJECT_ALREADY_BOUND' });
    }
  }
  // A SIGN-IN THAT ALREADY HAS AN ACCOUNT IS NEVER BOUND TO AN INVITEE (R13): it is added by sharing.
  if (invitation && edgePersonIdOf(event)) {
    return reply(event, 409, { error: 'this sign-in already has an account; ask the inviter to add it to the conversation', code: 'wrong_account' });
  }
  if (invitation && isProvisionedOnly(issuer)) {
    return reply(event, 403, { error: 'this sign-in cannot redeem an invitation', code: 'wrong_account' });
  }

  // A HOST ASSERTION IS SPENT BEFORE ANYTHING IS DECIDED FROM IT: presented twice, the second is refused.
  const assertion = issuer.kind === 'host-assertion';
  if (assertion) {
    const refused = await spendHostAssertion(event, issuer.id, claims);
    if (refused) return refused;
  }

  // Per-request scope: the client names the capabilities it needs (default: the chat set) and,
  // optionally, one channel. STS session policies only NARROW, so taking these from the body is safe.
  let scopeChannelArn = '';
  let requestedCaps: string[] = [];
  let requestedIdentity = 'chat';
  try {
    const body = event?.body ? JSON.parse(event.body) : {};
    if (typeof body?.channelArn === 'string' && body.channelArn) scopeChannelArn = body.channelArn;
    if (Array.isArray(body?.capabilities)) requestedCaps = body.capabilities.map((c: unknown) => String(c));
    if (typeof body?.identity === 'string') requestedIdentity = body.identity;
  } catch {
    /* malformed body: ignore and vend the default chat identity */
  }
  // ADMIN REACH IS NOT VENDED HERE. A console session and every admin credential are requested from the
  // admin credential exchange, with the admin console's own session.
  if (requestedIdentity === 'admin' || requestedIdentity === 'console') {
    return reply(event, 403, {
      error: 'console sessions and admin credentials are requested from the admin credential exchange',
      code: 'ADMIN_VEND_MOVED',
    });
  }
  if (requestedCaps.some((c) => MODERATION_CAPS.has(c))) {
    return reply(event, 400, { error: 'moderation capabilities are vended by the admin credential exchange, on the admin identity, for one conversation' });
  }
  const unknownCaps = requestedCaps.filter((c) => !PERSON_CAPABILITIES.has(c));
  if (unknownCaps.length) return reply(event, 400, { error: `unknown capabilities: ${unknownCaps.join(', ')}` });
  if (scopeChannelArn && !literalChannelId(scopeChannelArn)) {
    return scopeChannelArn.startsWith(CHANNEL_PREFIX)
      ? reply(event, 400, { error: 'channelArn must name a single conversation', code: 'CHANNEL_NOT_LITERAL' })
      : reply(event, 400, { error: 'channelArn must be a channel of this app instance' });
  }
  // NOTHING IS VENDED FOR A COMBINATION NOBODY DECLARED: refusing names the actual fault, which is in the
  // deployment's config rather than in the person.
  if (!roleKey) {
    // A host's permission set the mapping does not declare reaches nothing (Q5): no floor.
    if (assertion) countExchangeRefusal(issuer.id, 'unmapped-permission-set');
    console.error('[CredentialExchange][SecurityEvent] groups name no declared classification combination; vending nothing', { groups });
    return reply(event, 403, { error: 'no credential is configured for this combination of groups' });
  }
  // FOUND BY NAME AT CALL TIME, under the key the classification's own stack publishes (`resolveExchangeRoleArn`).
  const roleArn = await resolveExchangeRoleArn(roleKey);
  if (!roleArn) {
    console.error('[CredentialExchange] No exchange role ARN configured for', roleKey);
    return reply(event, 500, { error: 'Exchange misconfigured' });
  }
  // THE INVARIANT IN EXECUTABLE FORM, deliberately silent: by here `roleKey` is a declared classification
  // whose grants ARE the union of what the caller holds, so this cannot fire. If a change to
  // `resolveHolderToken` reintroduces a near-fit token, this turns it into a logged security event
  // instead of a quiet under-vend. Asked only of a token the groups chose uncapped.
  if (profiles.resolveHolderToken(groups) === roleKey && !profiles.holderTokenCovers(groups)) {
    console.error('[CredentialExchange][SecurityEvent] the vended token does not cover this caller\'s clearances; '
      + 'this is unreachable by construction, so resolveHolderToken has changed and is now under-vending', {
      groups, holds: profiles.clearancesForGroups(groups), vendedAs: roleKey,
    });
  }

  // ── WHO THIS IS: THE PERSON ID, MINTED ONCE PER (ISSUER, SUBJECT) ──────────────────────────────────
  //
  // The token's `(iss, sub)` resolves to the person's AppInstanceUser through `Identities`, minting it on
  // the first sign-in. The id is a UUID v7 and never the token's `sub`. Keyed on the REGISTRY id, never
  // the raw `iss`, so the row stays the same person across an issuer URL that moves.
  let personId: string;
  let personCreated: boolean;
  let boundFromChannel: string | null = null;
  let invitedTo: string | null = null;
  //
  // A `provisioned-only` issuer is never minted for: its subject is bound to the person pre-assigned to it.
  // A first sign-in carrying a live guest session (path A) is bound to the visitor instead of minted.
  if (bind && isProvisionedOnly(issuer)) {
    return reply(event, 403, { error: 'this sign-in cannot become a visitor account', code: 'BIND_NOT_SUPPORTED' });
  }
  try {
    const person = invitation
      ? await bindInvitation({ issuer: issuer.id, subject, roleKey, token: invitation })
      : bind && !boundReplay
      ? await bindGuestPerson({ issuer: issuer.id, subject, request: bind }, { doc: docClient(), chime: chimeIdentity })
      : isProvisionedOnly(issuer)
      ? await bindProvisionedPerson({ issuer: issuer.id, subject, name: displayNameOf(claims) })
      : await mintOrResolvePerson({ issuer: issuer.id, subject, name: displayNameOf(claims) });
    personId = person.personId;
    personCreated = person.created;
    if ('guestChannelArn' in person && typeof person.guestChannelArn === 'string') boundFromChannel = person.guestChannelArn;
    if (boundReplay) boundFromChannel = boundReplay;
    if (invitation && 'channelArn' in person && typeof person.channelArn === 'string') invitedTo = person.channelArn;
  } catch (err) {
    if (err instanceof InvitationRefused) {
      console.warn('[CredentialExchange][SecurityEvent] an invitation redemption was refused; nothing was bound', { code: err.code, issuer: issuer.id });
      return reply(event, err.status, { error: err.message, code: err.code });
    }
    if (err instanceof BindRefused) {
      console.warn('[CredentialExchange][SecurityEvent] a guest bind was refused; nothing changed', { code: err.code, issuer: issuer.id });
      return reply(event, err.status, { error: err.message, code: err.code });
    }
    if (err instanceof PersonNotProvisioned) {
      if (assertion) countExchangeRefusal(issuer.id, 'not-provisioned');
      console.warn('[CredentialExchange][SecurityEvent] a provisioned-only subject nobody provisioned; creating nothing', { issuer: issuer.id });
      return reply(event, 403, { error: 'this sign-in was not provisioned for this deployment', code: 'PERSON_NOT_PROVISIONED' });
    }
    if (err instanceof PersonNotActive) {
      if (assertion) countExchangeRefusal(issuer.id, `person-${err.status}`);
      return reply(event, 403, { error: 'this sign-in is not active', code: 'PERSON_NOT_ACTIVE' });
    }
    console.error('[CredentialExchange] could not resolve the person:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
  await keepContactCopy(issuer, personId, claims);
  // THE DECISION, RECORDED (C3): the classification this sign-in is vended, the issuer, the rule and what it
  // matched, on the subject's own row. Evidence for the readers with no token; nothing grants from it.
  const basis = clearanceBasisOf(issuer, claims);
  if (basis) await recordClearanceDecision({ issuer: issuer.id, subject, classification: roleKey, ...basis });

  try {
    // The minter created the identity (or found it); here it is classified with the same token the role
    // was chosen from, and its name refreshed from the IdP's own name claim and only that.
    const idpName = typeof claims.name === 'string' ? claims.name : undefined;
    await classifyIdentity(personId, roleKey, idpName, personCreated);
    const bearerArn = userArnFor(APP_INSTANCE_ARN, personId);

    // A BOUND VISIT CONTINUES IN A CONVERSATION AT THE PERSON'S OWN CLASSIFICATION (P-11), never the
    // visitor's, which this session does not reach. Unopened, nothing is vended and the same call is
    // retried: the bind has happened, and its retry opens the same conversation.
    let bound: { from: 'guest'; channelArn: string; conversationArn: string } | null = null;
    if (boundFromChannel) {
      const continued = await continueBoundVisit({ personArn: bearerArn, guestChannelArn: boundFromChannel, classification: roleKey }, { doc: docClient() });
      if (!continued.ok) {
        console.error('[CredentialExchange] a bound visit\'s conversation could not be opened', { why: continued.why });
        return reply(event, 503, { error: 'the account is linked, and its conversation could not be opened yet; retry the same call', code: 'CONTINUATION_UNAVAILABLE' });
      }
      bound = { from: 'guest', channelArn: boundFromChannel, conversationArn: continued.conversationArn };
    }

    // A session policy scoped to exactly the requested capabilities on the requested resource. The role
    // role is the BOUNDARY, so this only narrows. The default (view + participate) is the chat set.
    const caps = requestedCaps.length ? requestedCaps : ['view', 'participate'];
    const requestedActions = [...new Set(caps.flatMap((c) => CAPABILITY_ACTIONS[c]))];
    const channelResource = scopeChannelArn || `${CHANNEL_PREFIX}*`;
    const sessionPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'SessionAndConnect', Effect: 'Allow', Action: ['chime:GetMessagingSessionEndpoint', 'chime:Connect'], Resource: '*' },
        { Sid: 'RequestedActions', Effect: 'Allow', Action: requestedActions, Resource: [channelResource, bearerArn] },
      ],
    });
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `chime-${personId}`.slice(0, 64),
      DurationSeconds: SESSION_DURATION_SECONDS,
      // ── THE SESSION'S TWO ASSERTIONS: WHO, AND AT WHAT CLASSIFICATION ────────────────────────
      //
      // `person` is what the role's policy pins the bearer on: the person id, never a token's subject.
      // `classification` is asserted ON THE SESSION, and the role's trust requires it to equal the role's
      // own, so a session asserting `basic` cannot be minted on the role carrying premium's grants.
      //
      // `adminPlane` is asserted when the person holds the admin plane classification: the one statement on a
      // member vend role that reaches admin-plane channels conditions on it, so admin conversations join the
      // member classification's reach and nothing else does (`exchangeVendStatements`). It is never admin
      // access, which is the admin credential exchange's (SPEC-ADMIN-IDENTITY FR1).
      Tags: [
        { Key: 'person', Value: personId },
        { Key: 'classification', Value: roleKey },
        ...(adminPlane ? [{ Key: ADMIN_PLANE_SESSION_TAG, Value: 'true' }] : []),
      ],
      Policy: sessionPolicy,
    }));
    const result: ExchangeResult = {
      credentials: credentialsOf(assumed),
      userArn: bearerArn,
      tier: roleKey, // wire field stays `tier` (the frontend reads response.tier); value is the caller's classification
      identity: 'chat',
      scopedTo: scopeChannelArn || null,
      consoleRole: consoleRoleFor(issuer, groups),
      ...(bound ? { bound } : {}),
      ...(invitedTo ? { invitation: { channelArn: invitedTo } } : {}),
    };
    return reply(event, 200, result);
  } catch (err) {
    console.error('[CredentialExchange] failed:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
};
