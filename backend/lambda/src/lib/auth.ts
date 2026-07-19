/**
 * Shared auth helpers for API Gateway Lambda handlers.
 *
 * Why this exists: without a shared helper, handlers each implement their own
 * claim-extraction + group-check logic, with inconsistent contracts — and drift
 * toward gating admin on `custom:tier === 'premium'` even though CLAUDE.md says
 * Cognito groups are authoritative. This centralises the contract.
 *
 * Use the helpers below in every handler that needs to verify identity,
 * tier, or admin status. They normalise the cognito:groups shape
 * (sometimes a comma-separated string, sometimes an array depending on
 * how the API Gateway authorizer rehydrates the JWT), pull `userArn`
 * from authoritative sources (Chime AppInstance + JWT sub), and return
 * structured responses on failure so the caller pattern stays one-liner.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/** The four Cognito groups, most-privileged first. */
export const CLASSIFICATION_ORDER = ['admins', 'premium', 'standard', 'basic'] as const;
export type Tier = (typeof CLASSIFICATION_ORDER)[number];

export interface AuthorizedClaims {
  /** Cognito user sub (UUID). */
  sub: string;
  /** Email if present in claims (premium+admin pools typically have it). */
  email: string | null;
  /** Most-privileged group the user holds. */
  tier: Tier | 'unknown';
  /** All groups the user holds. */
  groups: string[];
}

/**
 * Extract identity from API Gateway Cognito Authorizer claims. Returns
 * null if no claims are present (handler should respond 401 — the
 * authorizer SHOULD have blocked this upstream, but defense-in-depth).
 */
/**
 * Normalize the `cognito:groups` claim. Three shapes are real in production:
 *  - a JSON array (when the authorizer rehydrates it),
 *  - a comma-separated string (raw JWT), and
 *  - a **bracketed, space-separated** string (e.g. `"[admins premium]"`) — this
 *    is how API Gateway serializes a *multi-group* claim. Splitting on commas
 *    only would return the single token `"[admins premium]"`, so a user who
 *    holds `admins` in addition to a tier (the additive-admin design) would fail
 *    every group check. Strip surrounding brackets and split on whitespace OR
 *    commas so all three shapes parse. Cognito group names never contain
 *    whitespace, so this is unambiguous.
 */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    return raw
      .replace(/^\[|\]$/g, '')
      .split(/[\s,]+/)
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

export function extractClaims(event: APIGatewayProxyEvent): AuthorizedClaims | null {
  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined;
  if (!claims) return null;
  const sub = (claims.sub as string) || (claims['cognito:username'] as string);
  if (!sub) return null;

  const groups = parseGroups(claims['cognito:groups']);

  const tier = (CLASSIFICATION_ORDER.find((t) => groups.includes(t)) as Tier) || 'unknown';

  return {
    sub,
    email: (claims.email as string) ?? null,
    tier,
    groups,
  };
}

/**
 * Compose the Chime AppInstanceUser ARN for the caller. The caller's
 * Cognito sub is mapped 1:1 to a Chime AppInstanceUser of the same id.
 * Use this everywhere a handler currently accepts `userArn` from the
 * request body — the body value is attacker-controlled (see audit
 * findings C2/C3/C4) and must be ignored in favor of this server-derived
 * ARN.
 */
export function callerUserArn(claims: AuthorizedClaims, appInstanceArn: string): string {
  return `${appInstanceArn}/user/${claims.sub}`;
}

/**
 * Group values that mark the caller as an admin.
 *
 * Defaults to AE's own `admins` Cognito group. Override with the
 * `ADMIN_GROUP_NAMES` env var (comma-separated) when AE is deployed
 * behind a host application that owns admin auth — set it to whatever
 * group/role value your IdP emits in the `cognito:groups` claim (e.g.
 * `operators` or `partner-admins`). This is the handler-layer half of
 * "admin is a claim you choose, not AE's `admins` group" — see
 * docs/ADMIN-INTEGRATION-GUIDE.md. The API Gateway authorizer must also
 * be pointed at the host pool (Approach 1) for these claims to arrive.
 */
const ADMIN_GROUPS = new Set<string>(
  (process.env.ADMIN_GROUP_NAMES || 'admins')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

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
  return claims.groups.some((g) => ADMIN_GROUPS.has(g));
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
 * docs/ADMIN-INTEGRATION-GUIDE.md (Approach 2).
 */
export function isServiceAdminCall(event: APIGatewayProxyEvent): boolean {
  if (process.env.ADMIN_AUTH_MODE !== 'service') return false;
  const id = event.requestContext?.identity as
    | { userArn?: string | null; caller?: string | null; accountId?: string | null }
    | undefined;
  return Boolean(id?.userArn || id?.caller || id?.accountId);
}

/** Synthesize admin claims for an IAM-signed service call (service mode). */
function serviceAdminClaims(event: APIGatewayProxyEvent): AuthorizedClaims {
  const id = event.requestContext?.identity as
    | { userArn?: string | null; caller?: string | null; accountId?: string | null }
    | undefined;
  const sub = id?.userArn || id?.caller || id?.accountId || 'service';
  return { sub, email: null, tier: 'admins', groups: ['admins'] };
}

/**
 * Handler-level admin check that honors all three admin auth modes:
 *  - `service`: an IAM-signed service call is treated as admin (the caller
 *    enforced admin upstream — see {@link isServiceAdminCall}).
 *  - `ae-cognito` / `federated`: the caller's `cognito:groups` must contain a
 *    configured admin group (`ADMIN_GROUP_NAMES`, default `admins`).
 *
 * Prefer this over hand-rolled `cognito:groups` parsing so every admin handler
 * shares one IdP-agnostic gate. Behavior is identical to the legacy
 * `groups.includes('admins')` checks under the default `ae-cognito` mode.
 */
export function callerIsAdmin(event: APIGatewayProxyEvent): boolean {
  if (isServiceAdminCall(event)) return true;
  // Group-only check, independent of `sub` — matches the legacy inline
  // `cognito:groups.includes('admins')` gates exactly (some authorizer configs
  // omit sub but always carry groups for an admin).
  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined;
  if (!claims) return false;
  return parseGroups(claims['cognito:groups']).some((g) => ADMIN_GROUPS.has(g));
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
 * the final control. See memory `admin-actions-iam-enforceable` + PLAN-NEXT-STEPS.
 */
const ARCHIVE_VIEW_GROUPS = new Set<string>(
  (process.env.ARCHIVE_VIEW_GROUP_NAMES || process.env.ADMIN_GROUP_NAMES || 'admins')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

export function callerCanReadArchive(event: APIGatewayProxyEvent): boolean {
  if (isServiceAdminCall(event)) return true;
  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined;
  if (!claims) return false;
  return parseGroups(claims['cognito:groups']).some((g) => ARCHIVE_VIEW_GROUPS.has(g));
}

/** Standard CORS headers for API Gateway responses. */
export function corsHeaders(origin?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || process.env.ALLOWED_ORIGIN || 'http://localhost:5173',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

/** Build a JSON response. */
export function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

/**
 * Guard: returns null if the caller is admin; otherwise returns an
 * APIGatewayProxyResult the handler should return immediately. Pattern:
 *
 *   const auth = requireAdmin(event);
 *   if ('statusCode' in auth) return auth;
 *   const { claims } = auth;
 *   // ... admin-only logic
 */
export function requireAdmin(
  event: APIGatewayProxyEvent,
): { claims: AuthorizedClaims } | APIGatewayProxyResult {
  // Service mode: an IAM-signed call from a trusted backend principal is admin.
  if (isServiceAdminCall(event)) return { claims: serviceAdminClaims(event) };
  const claims = extractClaims(event);
  if (!claims) return respond(401, { error: 'Unauthorized' });
  if (!isAdmin(claims)) {
    // Don't leak whether the user exists or what tier they hold.
    console.warn('[auth] requireAdmin denied', { sub: claims.sub, groups: claims.groups });
    return respond(403, { error: 'Admin access required' });
  }
  return { claims };
}

/**
 * Guard: returns the caller's claims if any valid Cognito session exists,
 * otherwise an APIGatewayProxyResult to return.
 */
export function requireAuth(
  event: APIGatewayProxyEvent,
): { claims: AuthorizedClaims } | APIGatewayProxyResult {
  const claims = extractClaims(event);
  if (!claims) return respond(401, { error: 'Unauthorized' });
  return { claims };
}

/**
 * Guard: returns claims if the caller is in the given Cognito group OR
 * is admin (admins implicitly satisfy every tier check); otherwise the
 * 403 response.
 */
export function requireGroup(
  event: APIGatewayProxyEvent,
  group: Tier,
): { claims: AuthorizedClaims } | APIGatewayProxyResult {
  const auth = requireAuth(event);
  if ('statusCode' in auth) return auth;
  const { claims } = auth;
  if (isAdmin(claims) || claims.groups.includes(group)) return { claims };
  return respond(403, { error: `Requires ${group} group membership` });
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
    return respond(400, { error: 'Invalid JSON body' }, origin);
  }
}
