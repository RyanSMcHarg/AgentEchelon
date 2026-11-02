/**
 * Shared auth helpers for API Gateway Lambda handlers.
 *
 * Why this exists: without a shared helper, handlers each implement their own
 * claim-extraction + group-check logic, with inconsistent contracts — and drift
 * toward gating admin on `custom:tier === 'premium'` even though CLAUDE.md says
 * Cognito groups are authoritative. This centralises the contract.
 *
 * Use the helpers below in every handler that needs to verify identity,
 * clearance, or admin status. They normalize the cognito:groups shape
 * (sometimes a comma-separated string, sometimes an array depending on
 * how the API Gateway authorizer rehydrates the JWT), resolve who the
 * caller is to their AppInstanceUser (`callerPersonId`, the one resolver),
 * and return structured responses on failure so the caller pattern stays
 * one-liner.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { personIdFromArn, userArnFor } from './person-arn.js';
import { issuerById } from './trusted-issuers.js';
import {
  claimValues,
  groupsOf,
  holderTokenOf,
  oneChannelOf,
  isGuestIssuer,
  type TrustedIssuer,
} from '../../../lib/config/issuers.js';
import { responder, DEV_ORIGIN } from './http-response.js';

// `CLASSIFICATION_ORDER` IS DELETED, and with it the `Classification` type derived from it.
//
// It was `['admins', 'premium', 'standard', 'basic']` and `extractClaims` took the first entry the
// caller's groups contained, which is "the highest level wins". A classification is a declared set of
// grants rather than a level (ADR-046), so that list was wrong in two ways at once: it named four
// groups this deployment happens to ship, so a deployment declaring its own would resolve nobody, and
// it imposed an order on values that need not have one. A deployment declaring PEER classifications -
// two that grant only themselves, neither above the other - got `unknown` here while the credential
// exchange resolved the same person correctly.
//
// The type went with it because it described the same four literals. Every consumer of the removed
// type took a Cognito GROUP name, which is deployment config and therefore a `string`.

export interface AuthorizedClaims {
  /**
   * The caller's person id: the AppInstanceUser id `callerPersonId` resolved, never a token's `sub`.
   * Null only for a trusted service principal (`adminAuthMode=service`), which is not a person.
   */
  personId: string | null;
  /** Who an audit line names: the person id, or a trusted service principal's signing ARN. */
  actor: string;
  /** Email if present in claims (premium+admin pools typically have it). */
  email: string | null;
  /**
   * The one declared classification that means exactly what this caller's groups clear them for, or
   * `undefined` when no declared classification does.
   *
   * THE SAME RESOLVER THE CREDENTIAL EXCHANGE USES (`resolveHolderToken`), so a person resolves to one
   * token wherever they are read. This field used to be "the most-privileged group the user holds",
   * picked off a hardcoded order; `undefined` now means the deployment has not named the combination
   * this person holds, which is a config fault to fix rather than a value to substitute.
   */
  clearance: string | undefined;
  /** All groups the user holds, through their issuer's groups claim (`[]` for any other clearance source). */
  groups: string[];
  /** Whether the caller's issuer declares `admin: true`; only then can their groups make them an admin. */
  admin?: boolean;
}

/**
 * Normalize the `cognito:groups` claim. Three shapes are real in production:
 *  - a JSON array (when the authorizer rehydrates it),
 *  - a comma-separated string (raw JWT), and
 *  - a **bracketed, space-separated** string (e.g. `"[admins premium]"`) — this
 *    is how API Gateway serializes a *multi-group* claim. Splitting on commas
 *    only would return the single token `"[admins premium]"`, so a user who
 *    holds `admins` in addition to a clearance (the additive-admin design) would fail
 *    every group check. Strip surrounding brackets and split on whitespace OR
 *    commas so all three shapes parse. Cognito group names never contain
 *    whitespace, so this is unambiguous.
 */
export function parseGroups(raw: unknown): string[] {
  return claimValues(raw);
}

// ── WHO THE CALLER IS: ONE RESOLVER ────────────────────────────────────────────────────────────────
//
// A person is their AppInstanceUser, and its id is minted by the credential exchange
// (`lib/person-identity.ts`), never the token's `sub`. Every handler asks this one function who called
// it, and there are two ways a request is authenticated:
//
//  - A CONSOLE SESSION (`AdminApi`, IAM). The exchange assumes the console roles for the person and names
//    the session `console-<personId>`; only the exchange may assume them, so after the role check the
//    session name IS the person, asserted by the exchange. No lookup.
//  - THE EDGE AUTHORIZER (`PersonApi`, and the admin console session's own route). The edge verified the
//    token against the trusted-issuer registry, resolved the subject its issuer's entry declares through
//    `Identities`, and handed the gateway a context naming the issuer, the subject, the person and the
//    claims the registry reads (`lambda/src/edge-authorizer.ts`). The handler reads that context and does
//    no lookup of its own: the edge already refused a token it could not prove, and a subject that is
//    revoked or gone.
//
// Read-only: a request with neither names nobody, and the handler answers the 401 or 403 it always did.
// The answer is cached on the request object, so one invocation resolves once.
//
// `backend/test/a-person-is-their-app-instance-user.test.ts` refuses a read of the authorizer's context,
// `claims.sub`, `cognito:username`, `claims.email`, `cognito:groups` or a JWT decode anywhere but here,
// the exchanges and the edge authorizer.

/** What the edge authorizer handed the gateway, as a payload format 1.0 event carries it. */
export interface EdgeCaller {
  /** The registry entry the token came from. */
  issuer: TrustedIssuer;
  /** The subject that entry declares. */
  subject: string;
  /** The verified claims the registry reads (subject, groups or mapping claim, name, email). */
  claims: Record<string, unknown>;
  /** The AppInstanceUser id, or null for a first sign-in the exchange has not minted yet. */
  personId: string | null;
  personArn: string | null;
}

const edgeCallers = new WeakMap<object, EdgeCaller | null>();

/**
 * The edge authorizer's context on a request, or null on any other request (an IAM-signed one, a route
 * with no authorizer). Payload format 1.0 carries a Lambda authorizer's context as the authorizer's own
 * fields; the nested `lambda` form is read too, so the one reader serves either shape the gateway sends.
 * Only the gateway writes `requestContext`, so a client cannot supply one.
 */
export function edgeCallerOf(event: APIGatewayProxyEvent): EdgeCaller | null {
  if (!event || typeof event !== 'object') return null;
  if (edgeCallers.has(event)) return edgeCallers.get(event) ?? null;
  const resolved = readEdgeCaller(event);
  edgeCallers.set(event, resolved);
  return resolved;
}

/** The edge authorizer's context fields on a request, in either shape, or null when it carries none. */
function edgeFieldsOf(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  const raw = event?.requestContext?.authorizer as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  return (raw.lambda && typeof raw.lambda === 'object' ? raw.lambda : raw) as Record<string, unknown>;
}

/**
 * True when the edge's context names an issuer this function's registry does not declare: a token the edge
 * admitted for an issuer since removed (a cached answer), which a caller is told plainly rather than
 * answered as unauthenticated.
 */
export function edgeNamesAnUntrustedIssuer(event: APIGatewayProxyEvent): boolean {
  const issuerId = edgeFieldsOf(event)?.issuerId;
  return typeof issuerId === 'string' && issuerId.length > 0 && !issuerById(issuerId);
}

function readEdgeCaller(event: APIGatewayProxyEvent): EdgeCaller | null {
  const ctx = edgeFieldsOf(event);
  if (!ctx) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const issuerId = str(ctx.issuerId);
  const subject = str(ctx.subject);
  if (!issuerId || !subject) return null;
  // THE REGISTRY ENTRY BY ITS ID, as this function was handed it. An issuer removed since the edge
  // answered (a cached answer) names nobody here.
  const issuer = issuerById(issuerId);
  if (!issuer) {
    console.warn('[auth][SecurityEvent] the edge named an issuer this function does not trust; refused', { issuerId });
    return null;
  }
  let claims: Record<string, unknown> = {};
  // `tokenClaims`, never `claims`: an HTTP API reserves `claims` and replaces it (lambda/src/edge-authorizer.ts).
  const rawClaims = ctx.tokenClaims;
  if (typeof rawClaims === 'string' && rawClaims) {
    try {
      const parsed = JSON.parse(rawClaims) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) claims = parsed as Record<string, unknown>;
    } catch {
      console.warn('[auth][SecurityEvent] the edge context carries unreadable claims; none are read', { issuerId });
    }
  } else if (rawClaims && typeof rawClaims === 'object' && !Array.isArray(rawClaims)) {
    claims = rawClaims as Record<string, unknown>;
  }
  const personArn = str(ctx.personArn);
  const personId = str(ctx.personId) ?? personIdFromArn(personArn);
  return { issuer, subject, claims, personId, personArn };
}

/**
 * The groups the caller's verified token names, read from the claim their issuer declares. `[]` on a
 * request the edge did not authorize, and for an issuer whose clearance is not its groups: a host pool
 * declaring a mapping or the one-conversation session holds no group this deployment reads.
 */
function edgeGroups(event: APIGatewayProxyEvent): string[] {
  const caller = edgeCallerOf(event);
  return caller ? groupsOf(caller.issuer, caller.claims) : [];
}

/**
 * The one declared classification the caller's token is cleared for, through their issuer's clearance
 * source and within its declared classifications (`holderTokenOf`, `lib/config/issuers.ts`). Undefined when nothing
 * is declared for what they hold, and for a one-conversation issuer, whose people hold no classification.
 */
export function callerHolderToken(event: APIGatewayProxyEvent): string | undefined {
  const caller = edgeCallerOf(event);
  return caller ? holderTokenOf(caller.issuer, caller.claims, profiles) : undefined;
}

/**
 * The classification a one-conversation caller's conversations are created at, or null for any other
 * caller. Set when the caller's issuer declares `clearance: { oneChannel }`.
 */
export function callerOneChannel(event: APIGatewayProxyEvent): string | null {
  return oneChannelOf(edgeCallerOf(event)?.issuer);
}

export type CallerSource = 'console-session' | 'edge';

export interface CallerPerson {
  personId: string;
  /** The AppInstanceUser ARN, or null when the handler has no `APP_INSTANCE_ARN` to compose it from. */
  personArn: string | null;
  source: CallerSource;
  /** The registry entry they signed in through. Null for a console session, which the exchange named. */
  issuer: TrustedIssuer | null;
  /**
   * The display attributes their verified token carries, for copy a person reads (a sender name, a
   * reply-to address). Never an identity. Empty for a console session, which carries none.
   */
  contact: { email: string | null; name: string | null };
}

const resolvedCallers = new WeakMap<object, CallerPerson | null>();

function resolveCaller(event: APIGatewayProxyEvent): CallerPerson | null {
  const appInstanceArn = process.env.APP_INSTANCE_ARN || '';
  const identity = event?.requestContext?.identity as { userArn?: string | null } | undefined;
  const session = consoleSessionOf(identity?.userArn);
  if (session) {
    return {
      personId: session.personId,
      personArn: appInstanceArn ? userArnFor(appInstanceArn, session.personId) : null,
      source: 'console-session',
      issuer: null,
      contact: { email: null, name: null },
    };
  }
  const edge = edgeCallerOf(event);
  if (!edge?.personId) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    personId: edge.personId,
    personArn: edge.personArn ?? (appInstanceArn ? userArnFor(appInstanceArn, edge.personId) : null),
    source: 'edge',
    issuer: edge.issuer,
    contact: { email: str(edge.claims.email), name: str(edge.claims.name) },
  };
}

/**
 * True when an IAM-signed request is signed AS a person - a console session - whether or not that
 * person resolves. Structural, with no lookup, so a handler that admits only a signed principal naming
 * nobody (a service caller) cannot be reached by a person.
 */
export function signedAsPerson(event: APIGatewayProxyEvent): boolean {
  const identity = event?.requestContext?.identity as { userArn?: string | null } | undefined;
  return consoleSessionOf(identity?.userArn) !== null;
}

/**
 * What a handler admits beyond the ordinary person.
 *
 * `oneChannel`: a person whose issuer declares the one-conversation session. They reach the credential
 * exchange (which vends them one conversation) and the conversation they open, and nothing else, so
 * every other handler gets null for them without asking. A handler opts in only where what it does
 * next is decided by that person's one-conversation reach. The edge refuses them on every other route
 * first; this is the second layer (tenet D3).
 */
export interface CallerAdmission {
  oneChannel?: boolean;
  /**
   * A guest: the guest issuer's visitor. One handler admits one: path B's registration (`guest-upgrade.ts`).
   * The edge allows a guest token on `GUEST_ROUTES` alone, and every handler that does not ask resolves
   * nobody for a guest: the second layer behind the edge (tenet D3).
   */
  guest?: boolean;
}

/** Who called, as their AppInstanceUser, or null when the request names no person this handler admits. */
export async function callerPerson(event: APIGatewayProxyEvent, admit: CallerAdmission = {}): Promise<CallerPerson | null> {
  if (!event || typeof event !== 'object') return null;
  let person = resolvedCallers.get(event);
  if (person === undefined) {
    person = resolveCaller(event);
    resolvedCallers.set(event, person);
  }
  // A ONE-CONVERSATION PERSON REACHES ONLY WHAT ADMITS THEM. Refused by default, so a route that never
  // considered them cannot be reached with a token whose reach is one conversation.
  if (person && oneChannelOf(person.issuer) && !admit.oneChannel) return null;
  // A GUEST REACHES ONLY WHAT ADMITS THEM, the same way.
  if (person && isGuestIssuer(person.issuer) && !admit.guest) return null;
  // A HOST ASSERTION IS A BEARER ON THE EXCHANGE ALONE (A9), which reads the edge context itself, so no
  // handler resolves anybody from one: the second layer behind the edge's route check.
  if (person && person.issuer?.kind === 'host-assertion') return null;
  return person;
}

/** The caller's person id (their AppInstanceUser id), or null. */
export async function callerPersonId(event: APIGatewayProxyEvent, admit: CallerAdmission = {}): Promise<string | null> {
  return (await callerPerson(event, admit))?.personId ?? null;
}

/**
 * The caller's AppInstanceUser ARN, or null. Use this wherever a handler would otherwise accept a
 * `userArn` from the request body: the body is attacker-controlled and is ignored in favor of this.
 */
export async function callerPersonArn(
  event: APIGatewayProxyEvent,
  appInstanceArn: string = process.env.APP_INSTANCE_ARN || '',
): Promise<string | null> {
  const person = await callerPerson(event);
  if (!person) return null;
  return person.personArn ?? (appInstanceArn ? userArnFor(appInstanceArn, person.personId) : null);
}

/**
 * The caller's person and the authorization facts their token carries, or null when no person is
 * resolved (the handler answers 401).
 */
async function personClaims(event: APIGatewayProxyEvent): Promise<AuthorizedClaims | null> {
  const personId = await callerPersonId(event);
  if (!personId) return null;
  const person = await callerPerson(event);
  const groups = edgeGroups(event);
  return {
    personId,
    actor: personId,
    email: person?.contact.email ?? null,
    // THE REGISTRIES RESOLVE THIS, not a list in this file: the caller's issuer names the clearance
    // source and the classifications it may grant, and the profile registry the token. See `AuthorizedClaims.clearance`.
    clearance: callerHolderToken(event),
    groups,
    admin: edgeCallerOf(event)?.issuer.admin === true,
  };
}

/**
 * Group values that mark the caller as an admin.
 *
 * Defaults to AE's own `admins` Cognito group. Override with the
 * `ADMIN_GROUP_NAMES` env var (comma-separated) when the admin group
 * claim carries another value (e.g. `operators` or `partner-admins`).
 * Every admin route, `GET /feedback` included, is AWS_IAM, where these
 * are the groups `iamPrincipalClaims` names; the claim check in
 * `callerIsAdmin` binds only where the edge authorizer delivers claims,
 * which no admin route does. See
 * docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md.
 */
const ADMIN_GROUPS = new Set<string>(
  (process.env.ADMIN_GROUP_NAMES || 'admins')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

/** Whether any of a person's groups, as their directory holds them, is one of this deployment's admin groups. */
export function holdsAdminGroup(groups: readonly string[]): boolean {
  return groups.some((g) => ADMIN_GROUPS.has(g));
}

/**
 * True iff the caller holds one of the configured admin groups
 * (`ADMIN_GROUPS`, default `admins`).
 *
 * IMPORTANT: admin status is the **authoritative** permission signal per
 * CLAUDE.md. Do NOT check `custom:tier === 'premium'` — that's the user's
 * pricing tier, not their permission level. The post-confirmation trigger
 * mirrors `custom:tier` into the matching group, but admins are added to
 * the admin group separately.
 */
export function isAdmin(claims: AuthorizedClaims): boolean {
  // An issuer that does not declare `admin: true` has no admins, whatever groups its tokens carry (A6).
  if (claims.admin === false) return false;
  return claims.groups.some((g) => ADMIN_GROUPS.has(g));
}

/** The IAM principal on an `AWS_IAM`-authorized request (null on a
 *  Cognito-authorized one). API Gateway populates `requestContext.identity`
 *  with the signing principal for SigV4-signed calls; it is empty otherwise. */
function iamPrincipal(event: APIGatewayProxyEvent): string | null {
  const id = event.requestContext?.identity as
    | { userArn?: string | null; caller?: string | null; accountId?: string | null }
    | undefined;
  return id?.userArn || id?.caller || id?.accountId || null;
}

/**
 * True when the deployment runs in `adminAuthMode=service` AND this request
 * arrived as an IAM-signed (SigV4) call — i.e. the admin/analytics API is
 * behind an IAM authorizer and only a trusted backend principal (your proxy's
 * role, granted `execute-api:Invoke`) can reach the handler. In that mode there
 * is no Cognito JWT; the caller has already enforced "is this operator an
 * admin?" in its own pool, so AgentEchelon trusts the signed principal.
 *
 * `ADMIN_AUTH_MODE` is set by the CDK admin-auth-mode helper. The presence of
 * an IAM identity (userArn / caller / accountId) is what API Gateway populates
 * for `AWS_IAM`-authorized methods; it is null for Cognito-authorized ones, so
 * a mis-set env on a Cognito API fails closed (no identity → not a service
 * admin → falls through to the normal claim check). See
 * docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md (Approach 2).
 */
export function isServiceAdminCall(event: APIGatewayProxyEvent): boolean {
  if (process.env.ADMIN_AUTH_MODE !== 'service') return false;
  return iamPrincipal(event) !== null;
}

/**
 * A console session ARN. Group 1 is the console kind (`admin` or `team`), group 2 the person id the
 * exchange named the session after, group 3 a team session's clearance. The id is whatever the minter
 * minted: role-session-name characters other than `@`, which separates the clearance. Nothing here reads
 * the id's shape.
 */
const CONSOLE_SESSION_ARN = /^arn:aws:sts::\d+:assumed-role\/[^/]+-(admin|team)-console\/console-([\w+=,.-]+)(?:@([a-z0-9-]+))?$/i;

export interface ConsoleSession {
  kind: 'admin' | 'team';
  personId: string;
  /** The clearance a team session carries in its name (`console-<personId>@<clearance>`), else null. */
  clearance: string | null;
}

/**
 * The console session a signed caller's ARN names, or null for any other principal. The role check is
 * the role name's `-admin-console` / `-team-console` suffix, which only the exchange's console roles
 * carry and only the exchange may assume; the session name after it is the person.
 */
export function consoleSessionOf(userArn: string | null | undefined): ConsoleSession | null {
  const match = CONSOLE_SESSION_ARN.exec(userArn || '');
  if (!match) return null;
  return { kind: match[1].toLowerCase() as 'admin' | 'team', personId: match[2], clearance: match[3] ?? null };
}

/**
 * True when the request is signed by an ADMIN console session (`<prefix>-admin-console`). A team console
 * session, an Identity-Pool principal and any other signed principal are not, so a handler serving a
 * route with no team route can refuse them itself rather than relying on the gateway alone.
 */
export function isAdminConsoleSession(event: APIGatewayProxyEvent): boolean {
  const userArn = (event.requestContext?.identity as { userArn?: string | null } | undefined)?.userArn;
  return consoleSessionOf(userArn)?.kind === 'admin';
}

/**
 * True when this handler sits behind an `AWS_IAM` admin route
 * (`ADMIN_IAM_ENFORCEMENT=true`, which the CDK sets on every handler behind one;
 * every admin route is AWS_IAM, with no opt-out)
 * AND the request arrived IAM-signed. Unlike service mode (all-or-nothing), the
 * gateway has already enforced `execute-api:Invoke` on the SPECIFIC resource —
 * so reaching this handler proves the signed principal holds that capability
 * (its console session, or an exchange-vended per-use cred). The handler
 * therefore trusts the principal and derives the actor from it
 * (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md section 3). Fails closed the same way:
 * no env → false; no IAM identity → false. See {@link iamPrincipal}.
 */
export function isAdminIamEnforcedCall(event: APIGatewayProxyEvent): boolean {
  if (process.env.ADMIN_IAM_ENFORCEMENT !== 'true') return false;
  return iamPrincipal(event) !== null;
}

/**
 * An IAM-signed admin call the handler may trust because a gateway IAM
 * authorizer already vetted it — either service mode (a trusted upstream proxy)
 * or A14 per-resource enforcement (the signed principal held the capability).
 */
function isTrustedIamAdminCall(event: APIGatewayProxyEvent): boolean {
  return isServiceAdminCall(event) || isAdminIamEnforcedCall(event);
}

/** Synthesize admin claims for a trusted IAM-signed call (service or A14 mode),
 *  deriving the actor from the signed principal.
 *
 *  THE GROUPS ARE THE CONFIGURED ADMIN GROUPS and the clearance is resolved from them, rather than the
 *  literal `groups: ['admins']` / `clearance: 'admins'` this returned. `admins` is a GROUP name; the
 *  classification the shipped config maps it to is `admin`, so the old value was a group name in a
 *  classification field, and it was the default group name at that - a deployment that set
 *  `ADMIN_GROUP_NAMES` got claims naming a group it does not have. */
async function iamPrincipalClaims(event: APIGatewayProxyEvent): Promise<AuthorizedClaims> {
  const groups = [...ADMIN_GROUPS];
  // THE PERSON, NOT THE ROLE. A console session names the person the exchange vended it for, and every
  // admin route is IAM-authorized, so this is the actor an audit line must name. The principal ARN is
  // the fallback for a service-mode caller, which is not a person.
  const personId = await callerPersonId(event);
  return {
    personId,
    actor: personId || iamPrincipal(event) || 'iam-principal',
    email: null,
    clearance: profiles.resolveHolderToken(groups),
    groups,
    admin: true,
  };
}

/**
 * Who an admin action is attributed to: the person behind the signed session, or the signing principal
 * when it is not a person (a service caller), or null when nothing signed the request.
 */
export async function callerActor(event: APIGatewayProxyEvent): Promise<string | null> {
  const id = event?.requestContext?.identity as { userArn?: string | null; caller?: string | null } | undefined;
  return (await callerPersonId(event)) || id?.userArn || id?.caller || null;
}

/**
 * Handler-level admin check:
 *  - an IAM-signed call the gateway already vetted is admin: on a handler
 *    behind an AWS_IAM admin route (`ADMIN_IAM_ENFORCEMENT=true`, see
 *    {@link isAdminIamEnforcedCall}) or under `adminAuthMode=service`
 *    (see {@link isServiceAdminCall});
 *  - otherwise the caller's Cognito `cognito:groups` claim must contain a
 *    configured admin group (`ADMIN_GROUP_NAMES`, default `admins`).
 *
 * Prefer this over hand-rolled `cognito:groups` parsing so every admin handler
 * shares one IdP-agnostic gate. Behavior is identical to the legacy
 * `groups.includes('admins')` checks under the default `ae-cognito` mode.
 */
export function callerIsAdmin(event: APIGatewayProxyEvent): boolean {
  if (isTrustedIamAdminCall(event)) return true;
  // Group-only check, independent of `sub` — matches the legacy inline
  // `cognito:groups.includes('admins')` gates exactly (some authorizer configs
  // omit sub but always carry groups for an admin). Only an issuer declaring `admin: true` has admins.
  if (edgeCallerOf(event)?.issuer.admin !== true) return false;
  return edgeGroups(event).some((g) => ADMIN_GROUPS.has(g));
}

/**
 * Reading conversation ARCHIVE content — the conversation/message reads and the complete raw
 * event log — is a **separable** authorization from base admin, so a deployer can build a role
 * that is admin for other functions yet is DENIED archive access.
 *
 * INTERIM (this seam): a distinct, configurable Cognito group `ARCHIVE_VIEW_GROUP_NAMES`,
 * defaulting to the admin groups so current admins keep access; narrow it to deny a role.
 * The IAM-ENFORCEABLE version (a credential-exchange `view-archive` capability, like redact/
 * delete) is the tracked follow-up — this group gate is the placeholder for that action, NOT
 * the final control. The rule it is a placeholder for: a privileged admin action gates on an
 * IAM-enforceable capability, never on group membership alone.
 */
const ARCHIVE_VIEW_GROUPS = new Set<string>(
  (process.env.ARCHIVE_VIEW_GROUP_NAMES || process.env.ADMIN_GROUP_NAMES || 'admins')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

/**
 * `see-user-identity` - MAY THIS CALLER BE TOLD WHO A PERSON IS, rather than only that a person acted.
 *
 * Distinct from `view-user-activity`, which gates the per-person ANALYTICS panels at their own route.
 * This one gates resolving a conversation participant's ARN to their name.
 *
 * ── WHY THIS IS A ROUTE OF ITS OWN AND NOT A FIELD ON THE CONVERSATION READ ──────────────────────
 *
 * An operator investigating a weak answer needs the messages, the membership and the timeline; they do
 * not necessarily need to know which human sent which line. Refusing the whole read would stop the
 * investigation, and serving it with names attached discloses more than the task requires. So the
 * conversation reads return participant ARNs to anyone holding `view-conversations` and names to nobody,
 * and `GET admin/conversations/identities` resolves an ARN to a name under `see-user-identity`.
 *
 * A FIELD DECISION CANNOT BE IAM-ENFORCED, which is why it is not one. A check guarding a field on a
 * route another capability already admits the caller to has no resource for the gateway to refuse, so
 * the trusted-IAM path below would assert a proof nobody gave. Its own resource is what earns that
 * trust. The same shape also removes a bug class: while a name rode on the conversation payload,
 * withholding it meant remembering every field it travelled in, and three were missed in one pass.
 *
 * ── WHAT IS ACTUALLY BEING WITHHELD, WHICH IS WORSE THAN A NICKNAME ──────────────────────────────
 *
 * The Amazon Chime SDK `AppInstanceUser` is created with `Name: email`
 * (`cognito-triggers/post-confirmation.js`), so every `senderName`, `memberName` and user card in the
 * console is an EMAIL ADDRESS. There is no separate display name to leak instead of one.
 *
 * SERVER-SIDE, BECAUSE A CLIENT CHECK IS NOT AN ENFORCEMENT LAYER (SPEC-ADMIN-CONSOLE FR0a). A value
 * that reaches the browser is one devtools panel from being read, whatever the component draws - so the
 * conversation reads return no name to anyone, and resolving an ARN to a name is a separate route.
 *
 * THE GATEWAY BINDS. `see-user-identity` owns `GET admin/conversations/identities` in
 * `ADMIN_CAPABILITIES`, and that route is AWS_IAM in every deployment, so a role without the statement
 * is refused before this code runs. The group set below is the fallback for a call with no trusted IAM
 * identity, which no deployed admin route receives.
 */
const USER_IDENTITY_VIEW_GROUPS = new Set<string>(
  (process.env.USER_IDENTITY_VIEW_GROUP_NAMES || process.env.ADMIN_GROUP_NAMES || 'admins')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

export function callerCanSeeUserIdentity(event: APIGatewayProxyEvent): boolean {
  // THE EARLY RETURN IS SOUND HERE ONLY BECAUSE THE CAPABILITY OWNS A RESOURCE, which is the whole
  // point of the sub-path. The gateway has already refused any signed principal
  // lacking `execute-api:Invoke` on `GET admin/conversations/identities`, and that resource authorizes
  // NOTHING ELSE - so reaching this code proves the caller holds `see-user-identity`, exactly the way
  // `callerCanReadArchive` relies on `view-archive` having its own resource.
  //
  // IT WAS NOT SOUND WHEN THIS DECIDED A FIELD on the shared conversation route, and that was measured
  // rather than reasoned about: on the deployed API, every caller reaching that route still received
  // names, because `isAdminIamEnforcedCall` is true for ANY IAM-signed caller and
  // the field had no resource of its own to be refused at. Reaching a conversation read proves the
  // caller may read the conversation, never that they may be told who is in it. Keep this check on a
  // route whose resource covers only identity; putting it back on a shared read reinstates that bug.
  if (isTrustedIamAdminCall(event)) return true;
  return edgeGroups(event).some((g) => USER_IDENTITY_VIEW_GROUPS.has(g));
}

export function callerCanReadArchive(event: APIGatewayProxyEvent): boolean {
  // The archive routes are AWS_IAM, so the gateway already proved the
  // signed principal holds this archive capability (its `execute-api:Invoke`
  // on the specific resource). The group gate is the fallback for a call
  // with no trusted IAM identity.
  if (isTrustedIamAdminCall(event)) return true;
  return edgeGroups(event).some((g) => ARCHIVE_VIEW_GROUPS.has(g));
}

/**
 * Profile management — versioning/import lifecycle for assistant profiles
 * (SPEC-PORTABLE-PROFILES §7). Who may view, edit or activate an assistant's profile is
 * separately denyable, not "any admin".
 *
 * THE GATEWAY IS THE CONTROL (same shape as `callerCanReadArchive`): the profile routes are AWS_IAM
 * and the profile capabilities (`view-profiles`, `edit-profiles`, `activate-profiles`) own their
 * resources in `ADMIN_CAPABILITIES`, so a privileged admin action gates on an IAM-enforceable
 * capability, never on group membership alone. `MANAGE_PROFILES_GROUP_NAMES`, defaulting to the admin
 * groups, is the fallback for a call with no trusted IAM identity.
 */
const MANAGE_PROFILES_GROUPS = new Set<string>(
  (process.env.MANAGE_PROFILES_GROUP_NAMES || process.env.ADMIN_GROUP_NAMES || 'admins')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

export function callerCanManageProfiles(event: APIGatewayProxyEvent): boolean {
  // The profile routes are AWS_IAM, so the gateway proved the signed principal
  // holds the route's profile capability (execute-api on that resource); the
  // group gate is the fallback for a call with no trusted IAM identity.
  if (isTrustedIamAdminCall(event)) return true;
  return edgeGroups(event).some((g) => MANAGE_PROFILES_GROUPS.has(g));
}

/**
 * Creating and retiring an assistant at runtime (ADR-048, `manage-assistants`). An assistant is an
 * IAM-visible principal, so who may mint one is its own capability, held by admins only.
 *
 * The same shape as `callerCanManageProfiles`: the routes are AWS_IAM and the capability owns them, so
 * the gateway is the control; `MANAGE_ASSISTANTS_GROUP_NAMES`, defaulting to the admin groups, is the
 * fallback for a call with no trusted IAM identity.
 */
const MANAGE_ASSISTANTS_GROUPS = new Set<string>(
  (process.env.MANAGE_ASSISTANTS_GROUP_NAMES || process.env.ADMIN_GROUP_NAMES || 'admins')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

export function callerCanManageAssistants(event: APIGatewayProxyEvent): boolean {
  if (isTrustedIamAdminCall(event)) return true;
  return edgeGroups(event).some((g) => MANAGE_ASSISTANTS_GROUPS.has(g));
}

/**
 * The default responder: the origin the handler passes (it picked it from its own list), else
 * `ALLOWED_ORIGIN`. A route that sends other headers builds its own (`lib/http-response.ts`).
 */
const authHttp = responder({
  origin: { fixed: () => process.env.ALLOWED_ORIGIN || DEV_ORIGIN, callerPicked: true },
  methods: 'GET,POST,OPTIONS',
});

/** Standard CORS headers for API Gateway responses. */
export function corsHeaders(origin?: string): Record<string, string> {
  return authHttp.headers(origin);
}

/** Build a JSON response. */
export function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return authHttp.respond(statusCode, body, origin);
}

/**
 * Guard: returns null if the caller is admin; otherwise returns an
 * APIGatewayProxyResult the handler should return immediately. Pattern:
 *
 *   const auth = await requireAdmin(event);
 *   if ('statusCode' in auth) return auth;
 *   const { claims } = auth;
 *   // ... admin-only logic
 */
export async function requireAdmin(
  event: APIGatewayProxyEvent,
): Promise<{ claims: AuthorizedClaims } | APIGatewayProxyResult> {
  // A trusted IAM-signed call (service mode, or A14 per-resource enforcement)
  // derives its actor from the signed principal — the gateway already vetted it.
  if (isTrustedIamAdminCall(event)) return { claims: await iamPrincipalClaims(event) };
  const claims = await personClaims(event);
  if (!claims) return authHttp.error(401, 'Unauthorized');
  if (!isAdmin(claims)) {
    // Don't leak whether the user exists or what clearance they hold.
    console.warn('[auth] requireAdmin denied', { personId: claims.personId, groups: claims.groups });
    return authHttp.error(403, 'Admin access required');
  }
  return { claims };
}

/**
 * Guard: returns the caller's claims when the request resolves to a person,
 * otherwise an APIGatewayProxyResult to return.
 */
export async function requireAuth(
  event: APIGatewayProxyEvent,
): Promise<{ claims: AuthorizedClaims } | APIGatewayProxyResult> {
  const claims = await personClaims(event);
  if (!claims) return authHttp.error(401, 'Unauthorized');
  return { claims };
}

/**
 * Parse `event.body` as JSON, returning either the parsed value or an
 * APIGatewayProxyResult 400 if the body is missing / malformed.
 *
 * Without this, `const body = JSON.parse(event.body || '{}')` scattered across
 * handlers with no try/catch means malformed JSON returns 500 + leaks
 * error.message text. Use this everywhere a handler accepts a JSON body so the
 * 400 response is consistent and free of internals.
 */
export function parseJsonBody<T = Record<string, unknown>>(
  event: APIGatewayProxyEvent,
  origin?: string,
): { body: T } | APIGatewayProxyResult {
  if (!event.body) return { body: {} as T };
  try {
    return { body: JSON.parse(event.body) as T };
  } catch {
    return authHttp.error(400, 'Invalid JSON body', origin);
  }
}
