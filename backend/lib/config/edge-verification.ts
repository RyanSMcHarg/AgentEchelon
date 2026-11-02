/**
 * WHAT THE EDGE AUTHORIZER NEEDS TO VERIFY EACH ISSUER'S TOKENS, derived from the trusted-issuer registry.
 *
 * The registry (`lib/config/issuers.ts`) says who an issuer's people are and what they reach. The edge
 * authorizer also needs to know how to tell a genuine token from that issuer from every other string:
 * the audience it is issued to, which token the client presents, the one algorithm it signs with, and
 * where its keys are published. This file derives that from each entry, once, at synth, and refuses a
 * registry the edge could not verify safely.
 *
 * ── WHAT IS REFUSED HERE, AND WHY IT IS NOT IN THE REGISTRY'S OWN CHECK ──────────────────────────
 *
 * An issuer with no audience is refused. A token verified without its audience is a token for any
 * client of that issuer, which is the first way the edge admits a token it should not (plan risk R1).
 * The deployment's own pool takes its own app clients as the audience; any other Cognito pool must
 * declare `audience`. The registry's own check does not require it of a Cognito pool, since an entry is
 * valid whatever verifies its tokens; the refusal binds where the
 * check is made, which is the edge.
 *
 * ── THE GUEST ISSUER ─────────────────────────────────────────────────────────────────────────────
 *
 * The platform's own issuer (`kind: 'guest'`) has no JWKS: its tokens are signed with this deployment's
 * KMS key, and the edge reads each key generation's public key with `kms:GetPublicKey`. So its
 * verification names the keys by `kid` (handed in by the stack that owns them), the audience is this
 * deployment's id, the algorithm is ES256, and a token may live no longer than `GUEST_TOKEN_MAX_MINUTES`.
 * A guest entry with no key handed in is refused here, so a guest issuer cannot be declared on an edge
 * that could not check its tokens.
 *
 * ── THE HOST ASSERTION ───────────────────────────────────────────────────────────────────────────
 *
 * A `host-assertion` entry has no JWKS either: its keys are pinned in the registry
 * (`hostAssertion.publicKeys`) and travel to the edge in its verification block, by `kid`. The audience
 * is this deployment's id, the algorithm the one the entry declares (RS256 by default), and an assertion
 * may live no longer than the entry's `maxMinutes`. Its `jti` is single-use (`singleUse`), so the edge
 * records it in `Tokens` the first time it verifies one, and the exchange consumes it.
 *
 * ── THE TRAVELLING FORM ──────────────────────────────────────────────────────────────────────────
 *
 * The edge function is handed the registry's runtime form (`runtimeIssuers`, `compactIssuers`) with a
 * `verify` block added to each entry. The registry reader (`lambda/src/lib/trusted-issuers.ts`) keeps
 * fields it does not know, so the edge reads the registry through the same reader, cache and fail-closed
 * rule as every other function, and an entry without `verify` is an issuer the edge refuses.
 */
import {
  GUEST_TOKEN_MAX_MINUTES,
  NO_TOKEN_KINDS,
  SIGNING_ALGORITHMS,
  guestSettingsOf,
  hostAssertionMaxSeconds,
  compactIssuers,
  runtimeIssuers,
  type IssuerConfig,
  type IssuerKind,
  type IssuerRegistry,
  type SigningAlgorithm,
  type TrustedIssuer,
} from './issuers';

/** The most clock skew the edge tolerates on `exp` and `nbf`, in seconds. */
export const MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * How long the gateway may answer from a cached authorizer result, in seconds. It bounds how long a
 * removed issuer or a deleted `Identities` row keeps resolving.
 */
export const EDGE_RESULT_TTL_SECONDS = 300;

/** How long a direct provider's token may live from `iat` to `exp` unless its entry declares `maxLifetimeMinutes`: 90 minutes, the longest Entra randomizes an access token to. */
export const DIRECT_TOKEN_MAX_MINUTES = 90;

/** How the edge verifies one issuer's tokens. */
export interface EdgeVerification {
  /** The audiences (`aud`, or a Cognito access token's `client_id`) a token must carry one of. Never empty. */
  audience: string[];
  /** The token the client presents. The other one is refused. */
  tokenUse: 'id' | 'access';
  /** The one algorithm a token's header may name. */
  algorithm: SigningAlgorithm;
  /** `oidc`: the discovery document, read once for the JWKS location and checked to name the same issuer. */
  discoveryUrl?: string;
  /** `oidc`, `oidc-entra` access tokens: the claim and value that mark one, in place of the `at+jwt` header type. */
  tokenType?: { claim: string; value: string };
  /** `guest`: the KMS key ARN of each signing key generation, by `kid`. A token naming any other `kid` is refused. */
  keys?: Record<string, string>;
  /**
   * `guest`, `host-assertion`: the longest a token may live from `iat` to `exp`, and how far ahead its `exp`
   * may be, in seconds. `oidc`, `oidc-entra`: the longest from `iat` to `exp` (`maxLifetimeMinutes`).
   */
  maxLifetimeSeconds?: number;
  /** `oidc`, `oidc-entra`: claims a token must carry with exactly these values (`requiredClaims`). */
  requiredClaims?: Record<string, string>;
  /** `host-assertion`: the pinned public keys, base64 DER SubjectPublicKeyInfo, by `kid`. */
  pinnedKeys?: Record<string, string>;
  /** `host-assertion`: the token is single-use. Its `jti` is required, and recorded once at the edge. */
  singleUse?: boolean;
}

/** What the edge is told beyond the registry: this deployment's id and the guest issuer's keys. */
export interface EdgeVerificationContext {
  /** The deployment id a guest token's `aud` must equal (the instance name). */
  deploymentId?: string;
  /** The guest issuer's KMS key ARN per key generation (`kid`). */
  guestKeys?: Record<string, string>;
  /**
   * Leave the guest and host-assertion issuers out of this edge altogether, so their tokens name an issuer
   * it does not know (401). The admin plane does: neither is ever an admin, that edge holds no guest key,
   * and an assertion is accepted on the person exchange alone.
   */
  omitGuest?: boolean;
}

/** The kinds the admin plane's edge leaves out (`omitGuest`). */
const NEVER_ON_THE_ADMIN_EDGE: readonly IssuerKind[] = ['guest', 'host-assertion'];

/** An entry of the registry's runtime form, as the edge reads it. */
export type EdgeIssuer = TrustedIssuer & { verify?: EdgeVerification };

const COGNITO: readonly IssuerKind[] = ['cognito-pool', 'cognito-federated'];
const VERIFIABLE: readonly IssuerKind[] = [...COGNITO, 'oidc', 'oidc-entra', 'guest', 'host-assertion'];

const listOf = (v: string | string[] | undefined): string[] =>
  (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []).filter((s) => typeof s === 'string' && s.length > 0);

/** The audience an entry's tokens must carry. `selfClientIds` stands in for the deployment's own pool. */
function audienceOf(e: IssuerConfig, selfClientIds: readonly string[]): string[] {
  const declared = listOf(e.audience);
  if (declared.length) return declared;
  return COGNITO.includes(e.kind) && e.pool === 'self' ? [...selfClientIds] : [];
}

/** Every reason the edge could not verify this registry's tokens safely, one line each. Empty when it can. */
export function edgeVerificationErrors(registry: IssuerRegistry, selfClientIds: readonly string[], ctx: EdgeVerificationContext = {}): string[] {
  const errors: string[] = [];
  for (const e of registry.entries) {
    const at = `issuer "${e.id}"`;
    if (ctx.omitGuest && NEVER_ON_THE_ADMIN_EDGE.includes(e.kind)) continue;
    // AN ISSUER WITH NO TOKEN (`invitation-link`): its redemption is the credential, at the exchange.
    if (NO_TOKEN_KINDS.includes(e.kind)) continue;
    if (!VERIFIABLE.includes(e.kind)) {
      errors.push(`${at}: the edge authorizer verifies cognito-pool, cognito-federated, oidc, oidc-entra, guest and host-assertion tokens; a ${e.kind} token is NOT BUILT at the edge`);
      continue;
    }
    if (e.kind === 'host-assertion') {
      if (!ctx.deploymentId) errors.push(`${at}: the edge authorizer needs this deployment's id, the audience a host assertion carries`);
      continue;
    }
    if (e.kind === 'guest') {
      if (!ctx.deploymentId) errors.push(`${at}: the edge authorizer needs this deployment's id, the audience a guest token carries`);
      const missing = guestSettingsOf(e).signingKeys.filter((kid) => !ctx.guestKeys?.[kid]);
      if (missing.length) errors.push(`${at}: the edge authorizer was given no signing key for ${missing.join(', ')}; a guest token it cannot check is refused`);
      continue;
    }
    if (!audienceOf(e, selfClientIds).length) {
      errors.push(COGNITO.includes(e.kind) && e.pool === 'self'
        ? `${at}: the edge authorizer needs this deployment's app client ids as the audience of its own pool; none were given`
        : `${at}: declares no audience; the edge authorizer refuses an issuer whose tokens it cannot check are issued to this deployment. `
          + 'Declare audience: the app client ids (a Cognito pool) or the client id (OIDC) its tokens carry');
    }
    if (e.algorithm !== undefined && !(SIGNING_ALGORITHMS as readonly string[]).includes(e.algorithm)) {
      errors.push(`${at}: algorithm "${String(e.algorithm)}" is refused at the edge; declare one of ${SIGNING_ALGORITHMS.join(', ')}`);
    }
  }
  return errors;
}

/** The verification block for one entry. Call only on a registry `edgeVerificationErrors` passed. */
export function edgeVerificationOf(e: IssuerConfig, selfClientIds: readonly string[], ctx: EdgeVerificationContext = {}): EdgeVerification {
  if (e.kind === 'guest') {
    const kids = guestSettingsOf(e).signingKeys;
    return {
      audience: [ctx.deploymentId!],
      tokenUse: 'access',
      algorithm: 'ES256',
      keys: Object.fromEntries(kids.map((kid) => [kid, ctx.guestKeys![kid]])),
      maxLifetimeSeconds: GUEST_TOKEN_MAX_MINUTES * 60,
    };
  }
  if (e.kind === 'host-assertion') {
    return {
      audience: [ctx.deploymentId!],
      tokenUse: 'access',
      algorithm: e.algorithm ?? 'RS256',
      pinnedKeys: { ...(e.hostAssertion?.publicKeys ?? {}) },
      maxLifetimeSeconds: hostAssertionMaxSeconds(e),
      singleUse: true,
    };
  }
  return {
    audience: audienceOf(e, selfClientIds),
    tokenUse: e.tokenUse ?? 'id',
    algorithm: e.algorithm ?? 'RS256',
    ...(e.kind === 'oidc' && e.discoveryUrl ? { discoveryUrl: e.discoveryUrl } : {}),
    ...(e.tokenType ? { tokenType: { claim: e.tokenType.claim, value: e.tokenType.value } } : {}),
    ...(e.kind === 'oidc' || e.kind === 'oidc-entra'
      ? { maxLifetimeSeconds: (e.maxLifetimeMinutes ?? DIRECT_TOKEN_MAX_MINUTES) * 60 }
      : {}),
    ...(e.requiredClaims && Object.keys(e.requiredClaims).length ? { requiredClaims: { ...e.requiredClaims } } : {}),
  };
}

/**
 * The registry's travelling form with each entry's verification added, for the edge function's
 * `TRUSTED_ISSUERS`. Throws naming every reason the edge could not verify the registry.
 */
export function edgeIssuers(
  registry: IssuerRegistry,
  selfPoolId: string,
  region: string,
  selfClientIds: readonly string[],
  ctx: EdgeVerificationContext = {},
): Array<ReturnType<typeof compactIssuers>[number] & { verify: EdgeVerification }> {
  const errors = edgeVerificationErrors(registry, selfClientIds, ctx);
  if (errors.length) throw new Error(`the edge authorizer cannot verify this registry:\n  ${errors.join('\n  ')}`);
  const verifyById = new Map(registry.entries
    .filter((e) => !(ctx.omitGuest && NEVER_ON_THE_ADMIN_EDGE.includes(e.kind)) && !NO_TOKEN_KINDS.includes(e.kind))
    .map((e) => [e.id, edgeVerificationOf(e, selfClientIds, ctx)]));
  return compactIssuers(runtimeIssuers(registry, selfPoolId, region, ctx.deploymentId))
    .filter((t) => !(ctx.omitGuest && NEVER_ON_THE_ADMIN_EDGE.includes(t.kind)) && !NO_TOKEN_KINDS.includes(t.kind))
    .map((t) => ({ ...t, verify: verifyById.get(t.id)! }));
}
