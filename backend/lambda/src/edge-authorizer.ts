/**
 * THE EDGE AUTHORIZER: the one Lambda authorizer in front of every person-facing route.
 *
 * It answers one question per token: who, as an AppInstanceUser, is presenting it, and which routes may
 * they call with it. The token is checked against the trusted-issuer registry (`lib/token-verification.ts`),
 * the subject the issuer's entry declares is resolved through `Identities` (`identityStateOf`), and the
 * answer goes to the gateway as an IAM policy plus a context. A handler behind it reads the person from
 * that context (`callerPersonId`); no handler parses a token.
 *
 * ── THE ANSWERS ──────────────────────────────────────────────────────────────────────────────────
 *
 *  - No token, a malformed one, or one that fails any check: `Unauthorized` (401). Nothing is resolved.
 *  - A subject that is revoked, or whose row names no AppInstanceUser: a policy denying every route
 *    (403). Whether the account is disabled at its issuer is not read here: the credential exchange asks
 *    the issuer at every vend (SPEC-CREDENTIAL-EXCHANGE §4b), and a session already vended lasts out its
 *    hour.
 *  - A subject with no `Identities` row yet (a first sign-in), or whose AppInstanceUser create never
 *    landed: allowed on the credential exchange route only, with no person in the context. The exchange
 *    is what mints or repairs the person.
 *  - A person whose issuer declares the one-conversation session: allowed on the one-conversation routes
 *    only (`ONE_CHANNEL_ROUTES`, handed in as data).
 *  - A guest (the guest issuer's token): allowed on the guest routes only (`GUEST_ROUTES`: the credential
 *    exchange, which vends their one conversation, and path B's registration). A guest subject with no `Identities` row is denied
 *    every route rather than sent to the exchange: guest start mints the visitor before it signs their
 *    first token, so a guest token naming nobody is one the exchange must never mint for.
 *  - Any other person: allowed on every route.
 *
 * A `provisioned-only` issuer (P-13) is never minted for: its subject with no `Identities` row is denied
 * every route (`not-provisioned`) rather than sent to the exchange, and its `pending` row (pre-assigned,
 * not signed in yet) is allowed on the exchange alone, with no person in the context, since the exchange is
 * what binds it.
 *
 * ── A HOST'S ASSERTION (A9) ──────────────────────────────────────────────────────────────────────
 *
 * A `host-assertion` token is accepted on the credential exchange route and nowhere else. On any other
 * route it is refused (401) before anything is recorded. On the exchange route, once it verifies, its
 * `jti` is recorded in `Tokens` with a conditional put (`recordAssertionJti`), and an assertion whose
 * `jti` is already recorded is refused (401): presented twice, it is refused the second time whatever
 * else it says. The exchange route is never answered from the authorizer cache, so every presentation
 * reaches this check. Its person, when it has one, is allowed on the exchange alone. Every refusal of an
 * assertion is counted by check (`AssertionRefused`, namespace `AgentEchelon/HostAssertion`).
 *
 * On the admin plane (`AdminApi`, `plane: 'admin'`) the one route a token reaches is the console
 * session (`admin`), and only a token whose issuer declares `admin: true` is allowed there, with its
 * person in the context when it has one. Any other issuer is denied every route. The admin exchange
 * refuses again on the registry entry the token resolves to (tenet D3: two layers).
 *
 * ── WHY A POLICY, NOT A YES OR NO ────────────────────────────────────────────────────────────────
 *
 * The gateway caches an authorizer's answer by token, for every route behind that authorizer, for up to
 * `EDGE_RESULT_TTL_SECONDS`. A yes or no is the answer to "this route", and a cached yes would then admit
 * the same token on routes it was never decided for: a one-conversation person admitted on conversation
 * creation would reach every other cached route for five minutes. A policy names the routes it allows,
 * and the gateway evaluates the cached policy against each request's own route, so the answer stays
 * correct for every route it is reused on. Which routes is data (`EDGE_ROUTES`), never a branch here.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────────
 *
 * An unreadable `EDGE_ROUTES` admits a first sign-in and a one-conversation person nowhere. An unreadable
 * registry trusts no issuer. A lookup that throws is not answered at all: the gateway returns an error,
 * caches nothing, and admits nobody.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { identityStateOf, type IdentityState } from './lib/person-identity.js';
import { personIdFromArn } from './lib/person-arn.js';
import { TokenRefused, verifyToken, type VerifiedToken } from './lib/token-verification.js';
import { recordAssertionJti } from './lib/tokens.js';
import { MAX_CLOCK_SKEW_SECONDS } from '../../lib/config/edge-verification.js';
import { isGuestIssuer, isProvisionedOnly, oneChannelOf, subjectOf } from '../../lib/config/issuers.js';
import { countAssertionRefused } from './lib/host-assertion-metric.js';
// The deployment's set, read at runtime from the rows its stacks publish, before the handler runs.
import { withProfileRegistry } from '../../lib/profile-registry';

/** The routes, as `METHOD /path`, the edge admits a caller to without full reach. */
export interface EdgeRoutes {
  /** Which API this function answers for. Absent: `person`. */
  plane?: 'person' | 'admin';
  /** The credential exchange: the one route a subject with no person yet may call. */
  exchange: string[];
  /** The routes a one-conversation person calls. */
  oneChannel: string[];
  /** The routes a guest calls. Absent or unreadable: none. */
  guest?: string[];
  /** The admin plane: the routes an `admin: true` issuer's token reaches, and the only ones any token does. */
  admin?: string[];
}

/** What the gateway hands a REQUEST authorizer, in either payload format. */
export interface EdgeAuthorizerEvent {
  type?: string;
  /** Payload format 2.0. */
  routeArn?: string;
  routeKey?: string;
  /** Payload format 1.0. */
  methodArn?: string;
  authorizationToken?: string;
  identitySource?: string[] | string;
  headers?: Record<string, string | undefined> | null;
}

/** The context a handler reads its caller from. Every value is a string; an absent one is left out. */
export interface EdgeContext {
  /** The AppInstanceUser id. Absent for a subject with no person yet. */
  personId?: string;
  personArn?: string;
  /** The registry id of the issuer the token came from. */
  issuerId: string;
  /** The subject that entry declares, for the exchange to mint a first sign-in by. */
  subject: string;
  /**
   * The verified claims the registry reads (subject, groups or mapping claim, name, email), as JSON. Never
   * named `claims`: an HTTP API reserves that context key and replaces it before the integration sees it.
   */
  tokenClaims: string;
}

export interface EdgePolicy {
  principalId: string;
  policyDocument: {
    Version: '2012-10-17';
    Statement: Array<{ Action: 'execute-api:Invoke'; Effect: 'Allow' | 'Deny'; Resource: string[] }>;
  };
  context?: EdgeContext;
}

/** What one token is decided as, before it is written as a policy. */
export type EdgeDecision =
  | { effect: 'unauthorized'; reason: string }
  | { effect: 'deny'; reason: string; issuerId: string }
  | { effect: 'allow'; routes: 'all' | string[]; context: EdgeContext; reason: string };

export interface EdgeDeps {
  verify?: (token: string) => Promise<VerifiedToken>;
  lookup?: (issuerId: string, subject: string) => Promise<IdentityState>;
  routes?: EdgeRoutes;
  /**
   * Record a host assertion's `jti`, once. False when it was already recorded. Default: a conditional put
   * on `Tokens` (`TOKENS_TABLE`), refused by IAM on every key but `assertion-jti#*`.
   */
  recordJti?: (issuerId: string, jti: string, expiresAt: number) => Promise<boolean>;
  /** Count a refused assertion by check. Default: the `AssertionRefused` metric. */
  countRefusal?: (issuerId: string, check: string) => void;
}

let tokensDoc: DynamoDBDocumentClient | null = null;

/** The `jti` record, on `Tokens`. With no table configured it throws: an assertion is never admitted unrecorded. */
async function recordJtiInTokens(issuerId: string, jti: string, expiresAt: number): Promise<boolean> {
  const table = process.env.TOKENS_TABLE || '';
  if (!table) throw new Error('edge-authorizer: TOKENS_TABLE is not set, so a host assertion cannot be recorded');
  tokensDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return recordAssertionJti(tokensDoc, table, { issuerId, jti, expiresAt });
}

/** The routes from `EDGE_ROUTES`. Unreadable or absent, no route admits anyone without full reach. */
export function edgeRoutesFromEnv(raw: string | undefined = process.env.EDGE_ROUTES): EdgeRoutes {
  const none: EdgeRoutes = { exchange: [], oneChannel: [] };
  if (!raw) return none;
  try {
    const parsed = JSON.parse(raw) as Partial<EdgeRoutes>;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string' && /^[A-Z]+ \//.test(r)) : []);
    // A plane it does not know is the admin plane with no route: it admits nobody, never a person everywhere.
    if (parsed.plane !== undefined && parsed.plane !== 'person') {
      return { plane: 'admin', exchange: [], oneChannel: [], guest: [], admin: parsed.plane === 'admin' ? list(parsed.admin) : [] };
    }
    return { exchange: list(parsed.exchange), oneChannel: list(parsed.oneChannel), guest: list(parsed.guest) };
  } catch {
    console.error('[edge-authorizer][SecurityEvent] EDGE_ROUTES is not readable; a first sign-in and a one-conversation person are admitted nowhere');
    return none;
  }
}

/** The bearer token on a request: `Authorization: Bearer <jwt>`, or the bare token. */
export function bearerOf(event: EdgeAuthorizerEvent): string | null {
  const header = event.headers
    ? Object.entries(event.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
    : undefined;
  const source = Array.isArray(event.identitySource) ? event.identitySource[0] : event.identitySource;
  const raw = (header ?? event.authorizationToken ?? source ?? '').trim();
  const token = /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, '').trim() : raw;
  return token || null;
}

/** The claims a handler may need, and nothing else: the registry's subject, groups and mapping claims, a name and an email. */
function contextClaims(t: VerifiedToken): string {
  const c = t.issuer.clearance as { mapping?: { claim: string }; groups?: true };
  const keep = new Set<string>([...t.issuer.subject, 'name', 'email', 'token_use']);
  // A guest token's one conversation, which the exchange vends and nothing else.
  if (isGuestIssuer(t.issuer)) keep.add('ch');
  // A host assertion's `jti`, which the exchange consumes before it vends.
  if (t.issuer.kind === 'host-assertion') keep.add('jti');
  if (c.groups) keep.add(t.issuer.groupsClaim);
  if (c.mapping) keep.add(c.mapping.claim);
  // A TRANSLATION READS MORE THAN THE GROUPS CLAIM (`providerGroupsOf`, lib/config/issuers.ts): a federated
  // pool token's `custom:groups` counts only beside the `identities` claim that names the entry's provider,
  // and an Entra token's overage marker (`_claim_names`, `hasgroups`) means its groups reach nothing. Leaving
  // either out of the context would read every translated person as holding no group.
  if (c.groups && typeof c.groups === 'object') {
    keep.add('_claim_names');
    keep.add('hasgroups');
    if (t.issuer.kind === 'cognito-federated') keep.add('identities');
  }
  const out: Record<string, unknown> = {};
  for (const k of keep) if (t.claims[k] !== undefined) out[k] = t.claims[k];
  return JSON.stringify(out);
}

/**
 * Decide one token. `routeKey` is the route the request is for (`METHOD /path`), which a host assertion
 * is checked against. Throws only when a lookup or a record cannot be answered, which the gateway answers
 * as an error.
 */
export async function decide(token: string | null, deps: EdgeDeps = {}, routeKey?: string): Promise<EdgeDecision> {
  if (!token) return { effect: 'unauthorized', reason: 'no-token' };
  const count = deps.countRefusal ?? countAssertionRefused;
  let verified: VerifiedToken;
  try {
    verified = await (deps.verify ?? ((t: string) => verifyToken(t)))(token);
  } catch (err) {
    if (err instanceof TokenRefused) {
      if (err.issuer?.kind === 'host-assertion') count(err.issuer.id, err.code);
      return { effect: 'unauthorized', reason: err.code };
    }
    throw err;
  }
  const { issuer } = verified;
  const assertion = issuer.kind === 'host-assertion';
  const refuseAssertion = (reason: string): EdgeDecision => {
    count(issuer.id, reason);
    return { effect: 'unauthorized', reason };
  };
  const subject = subjectOf(issuer, verified.claims);
  if (!subject) return assertion ? refuseAssertion('no-subject') : { effect: 'unauthorized', reason: 'no-subject' };

  const routes = deps.routes ?? edgeRoutesFromEnv();
  if (assertion) {
    // ON THE EXCHANGE ALONE, and refused anywhere else before its `jti` is spent.
    if (routes.plane === 'admin' || !routeKey || !routes.exchange.includes(routeKey)) return refuseAssertion('off-route');
    const jti = String(verified.claims.jti);
    const expiresAt = Number(verified.claims.exp) + MAX_CLOCK_SKEW_SECONDS;
    const first = await (deps.recordJti ?? recordJtiInTokens)(issuer.id, jti, expiresAt);
    if (!first) return refuseAssertion('replayed');
  }

  const state = await (deps.lookup ?? ((i: string, s: string) => identityStateOf(i, s)))(issuer.id, subject);
  const provisionedOnly = isProvisionedOnly(issuer);
  const deny = (reason: string): EdgeDecision => {
    if (assertion) count(issuer.id, reason);
    return { effect: 'deny', reason, issuerId: issuer.id };
  };
  if (state.state === 'refused') return deny(`person-${state.status}`);
  // A PROVISIONED-ONLY ISSUER IS NEVER MINTED FOR (P-13): an unknown subject reaches nothing, the exchange
  // least of all, and a pending one reaches the exchange alone, which binds it.
  if (state.state === 'pending' && !provisionedOnly) return deny('person-pending');
  if (provisionedOnly && state.state === 'unbound') return deny('not-provisioned');

  const base = { issuerId: issuer.id, subject, tokenClaims: contextClaims(verified) };
  if (state.state === 'pending') return { effect: 'allow', routes: routes.exchange, context: base, reason: 'provisioned-first-sign-in' };
  if (routes.plane === 'admin') {
    // THE ADMIN PLANE ADMITS ONLY AN ADMIN ISSUER, and only to its console session. A first sign-in is let
    // through with no person, so the exchange can say it must sign in through the person exchange first.
    if (issuer.admin !== true) return { effect: 'deny', reason: 'not-an-admin-issuer', issuerId: issuer.id };
    const adminRoutes = routes.admin ?? [];
    if (state.state === 'unbound') return { effect: 'allow', routes: adminRoutes, context: base, reason: 'admin-first-sign-in' };
    const adminPersonId = personIdFromArn(state.personArn);
    if (!adminPersonId) return { effect: 'deny', reason: 'person-no-app-instance-user', issuerId: issuer.id };
    return { effect: 'allow', routes: adminRoutes, context: { ...base, personId: adminPersonId, personArn: state.personArn }, reason: 'admin' };
  }
  // A GUEST IS MINTED BEFORE ITS FIRST TOKEN IS SIGNED, so a guest subject with no row was never one guest
  // start opened, or was erased since. Nothing helps it, the exchange least of all.
  if (isGuestIssuer(issuer) && state.state === 'unbound') return { effect: 'deny', reason: 'guest-not-minted', issuerId: issuer.id };
  if (state.state === 'unbound') {
    return { effect: 'allow', routes: routes.exchange, context: base, reason: 'first-sign-in' };
  }
  const personId = personIdFromArn(state.personArn);
  if (!personId) return { effect: 'deny', reason: 'person-no-app-instance-user', issuerId: issuer.id };
  const context: EdgeContext = { ...base, personId, personArn: state.personArn };
  if (isGuestIssuer(issuer)) return { effect: 'allow', routes: routes.guest ?? [], context, reason: 'guest' };
  if (assertion) return { effect: 'allow', routes: routes.exchange, context, reason: 'host-assertion' };
  if (oneChannelOf(issuer)) return { effect: 'allow', routes: routes.oneChannel, context, reason: 'one-conversation' };
  return { effect: 'allow', routes: 'all', context, reason: 'person' };
}

/** `arn:aws:execute-api:<region>:<account>:<api>/<stage>`: the part of a route ARN every route of the API shares. */
export function apiStageArnOf(routeArn: string): string | null {
  const m = /^(arn:aws[a-z-]*:execute-api:[a-z0-9-]+:\d{12}:[A-Za-z0-9]+\/[^/]+)\//.exec(routeArn || '');
  return m ? m[1] : null;
}

/** The ARN a route key covers on this API: `POST /a/{id}` -> `<api>/<stage>/POST/a/*`. */
export function routeResource(apiStageArn: string, routeKey: string): string {
  const [method, ...rest] = routeKey.split(' ');
  const path = rest.join(' ').replace(/\{[^}]+\}/g, '*').replace(/^\//, '');
  return `${apiStageArn}/${method}/${path}`;
}

/** The decision as the gateway's policy. A deny, or an allow naming no route, denies every route. */
export function policyOf(decision: Exclude<EdgeDecision, { effect: 'unauthorized' }>, routeArn: string): EdgePolicy {
  const apiStage = apiStageArnOf(routeArn);
  const all = apiStage ? `${apiStage}/*` : routeArn;
  if (decision.effect === 'deny' || !apiStage || (decision.routes !== 'all' && decision.routes.length === 0)) {
    return {
      principalId: decision.effect === 'allow' ? (decision.context.personId ?? 'unbound') : 'refused',
      policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: [all] }] },
    };
  }
  const resources = decision.routes === 'all' ? [all] : decision.routes.map((r) => routeResource(apiStage, r));
  return {
    principalId: decision.context.personId ?? 'unbound',
    policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: resources }] },
    context: decision.context,
  };
}

/** One request, decided and written as the gateway's policy. `deps` replace the verifier, the lookup and the routes in tests. */
export async function authorize(event: EdgeAuthorizerEvent, deps: EdgeDeps = {}): Promise<EdgePolicy> {
  const routeArn = event.routeArn ?? event.methodArn ?? '';
  const decision = await decide(bearerOf(event), deps, event.routeKey);
  if (decision.effect === 'unauthorized') {
    console.warn('[edge-authorizer][SecurityEvent] token refused', { reason: decision.reason, route: event.routeKey ?? null });
    // The gateway's documented signal for a 401.
    throw new Error('Unauthorized');
  }
  if (decision.effect === 'deny') {
    console.warn('[edge-authorizer][SecurityEvent] subject refused', { reason: decision.reason, issuer: decision.issuerId });
  }
  return policyOf(decision, routeArn);
}

/** The Lambda entry point. The second argument a Lambda receives is its context, never a dependency. */
export const handler = withProfileRegistry((event: EdgeAuthorizerEvent): Promise<EdgePolicy> => authorize(event));
