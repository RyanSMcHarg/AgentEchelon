/**
 * THE TOKEN CHECK AT THE EDGE: is this string a genuine, current token from an issuer the registry
 * declares, issued to this deployment, of the kind that issuer's clients present?
 *
 * Built on `aws-jwt-verify`, the maintained verifier, which checks the signature against the issuer's
 * published keys, `iss`, `aud` (or a Cognito access token's `client_id`), Cognito's `token_use`, and
 * `exp` and `nbf` with a grace period. What it does not do, this file does, before or after it:
 *
 *  - THE ALGORITHM PIN. The library accepts any algorithm a key's type allows, EdDSA included, and has no
 *    separate pin. So the header `alg` must equal the one algorithm the issuer's entry declares, and
 *    `none` and every HMAC algorithm are refused before any key is looked at: an HMAC "signature" made
 *    with a public key as its secret is the key-confusion attack, and it never reaches a verifier here.
 *  - AN EMBEDDED KEY IS REFUSED. A header carrying its own key (`jwk`, `jku`, `x5u`, `x5c`) or a `crit`
 *    extension is refused. The library ignores those headers; refusing them means a later library change
 *    cannot start honoring one.
 *  - `exp` IS REQUIRED. The library checks `exp` only when a token carries one.
 *  - THE OIDC TOKEN TYPE. An access token is marked by the `at+jwt` header type (RFC 9068) or by the
 *    claim the entry declares; an ID token must carry neither, nor an OAuth `scp` claim.
 *  - THE ENTRY IS CHOSEN TWICE. The entry is picked from the unverified claims (it names the keys to
 *    verify with), then picked again from the verified claims, and the two must be the same entry.
 *
 * ── KEYS ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * One JWKS cache serves every issuer, keyed by its URI and then by `kid`. A `kid` the cache does not hold
 * fetches the JWKS once more (a rotation); a `kid` the fresh JWKS does not hold either is refused, and
 * the URI is not fetched again for that miss until the library's back-off ends, so a stream of made-up
 * `kid`s cannot turn the edge into a fetch amplifier. An OIDC issuer's JWKS location comes from its
 * discovery document, read once, and refused unless the document names the same `issuer`.
 *
 * ── THE GUEST ISSUER ─────────────────────────────────────────────────────────────────────────────
 *
 * The platform's own tokens (`kind: 'guest'`) are verified here too, with no JWKS to fetch: the `kid` must
 * name one of the issuer's key generations, its public key is read from AWS KMS once per container
 * (`guestPublicKey`, `lib/guest-token.ts`) and handed to the same library verifier as a supplied key
 * (`suppliedKeyVerifier`), which checks the ES256 signature, `iss` exact, `aud` this deployment's id, and
 * `nbf` and `exp` within the skew. Then what the library does not check: `exp` required, `token_use`
 * `guest`, and a lifetime from `iat` to `exp` no longer than the issuer allows, so a token signed with a
 * long expiry is refused even with a valid signature.
 *
 * ── THE HOST ASSERTION ───────────────────────────────────────────────────────────────────────────
 *
 * A host's assertion (`kind: 'host-assertion'`) is verified against the keys the registry pins for it, by
 * `kid`, through the same library verifier with those keys supplied (`RS256` or `ES256`, whichever the
 * entry declares): the signature, `iss` exact, `aud` this deployment's id, `nbf` and `exp` within the skew.
 * Then: `exp` required and no further ahead than the entry allows, `iat` required and `exp - iat` within
 * that lifetime, and a `jti` of at most 256 characters.
 *
 * ── SUPPLIED KEYS ────────────────────────────────────────────────────────────────────────────────
 *
 * The guest and host keys never come from a URL. They are handed to the library (`cacheJwks`) in a cache
 * of their own whose fetcher refuses every request, so a `kid` the supplied set does not hold is refused
 * and nothing is ever fetched for it. That the `jti` is presented once is the edge's and the exchange's
 * (`lambda/src/edge-authorizer.ts`, `lib/tokens.ts`), since it needs the store.
 *
 * Nothing here resolves a person. It answers which entry a token belongs to and what it verifiably says.
 */
import { createPublicKey, type KeyObject } from 'crypto';
import { CognitoJwtVerifier, JwtVerifier } from 'aws-jwt-verify';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { decomposeUnverifiedJwt } from 'aws-jwt-verify/jwt';
import { SimpleFetcher, type Fetcher } from 'aws-jwt-verify/https';
import {
  CognitoJwtInvalidClientIdError,
  CognitoJwtInvalidTokenUseError,
  FetchError,
  JwksValidationError,
  JwtExpiredError,
  JwtInvalidAudienceError,
  JwtInvalidIssuerError,
  JwtNotBeforeError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
  WaitPeriodNotYetEndedJwkError,
} from 'aws-jwt-verify/error';
import { issuerForClaims, type TrustedIssuer } from '../../../lib/config/issuers.js';
import { MAX_CLOCK_SKEW_SECONDS, type EdgeIssuer, type EdgeVerification } from '../../../lib/config/edge-verification.js';
import { trustedIssuers } from './trusted-issuers.js';
import { GUEST_TOKEN_USE, guestPublicKey } from './guest-token.js';

/** The algorithms a token may name at all. An entry declares one of them. */
const ACCEPTED_ALGORITHMS = new Set(['RS256', 'ES256']);

/** Header fields that carry or point at a key, or demand an extension. A token naming any is refused. */
const REFUSED_HEADERS = ['jwk', 'jku', 'x5u', 'x5c', 'crit'] as const;

/** Why a token was refused, as a stable code a log line and a test can both name. */
export type RefusalCode =
  | 'required-claim'
  | 'malformed'
  | 'algorithm'
  | 'embedded-key'
  | 'unknown-issuer'
  | 'not-verifiable'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'token-use'
  | 'expired'
  | 'not-yet-valid'
  | 'no-expiry'
  | 'unknown-key'
  | 'keys-unavailable'
  | 'lifetime'
  | 'no-jti';

export class TokenRefused extends Error {
  /** The entry the token named, once one was matched; absent for a refusal before that. */
  issuer?: { id: string; kind: string };

  constructor(readonly code: RefusalCode, message: string) {
    super(message);
    this.name = 'TokenRefused';
  }
}

export interface VerifiedToken {
  /** The registry entry the token comes from. */
  issuer: EdgeIssuer;
  /** The verified claims. */
  claims: Record<string, unknown>;
}

// ── THE FETCHER AND THE CACHES ───────────────────────────────────────────────────────────────────

let fetcher: Fetcher = new SimpleFetcher();
let jwksCache = new SimpleJwksCache({ fetcher });
const verifiers = new Map<string, { verify(token: string): Promise<unknown> }>();
const discovered = new Map<string, Promise<string>>();

/**
 * Replace the fetcher every JWKS and discovery read goes through, and forget every cache. For tests,
 * which hand it locally generated keys so nothing reaches the network.
 */
export function __setFetcherForTests(next?: Fetcher): void {
  fetcher = next ?? new SimpleFetcher();
  jwksCache = new SimpleJwksCache({ fetcher });
  verifiers.clear();
  discovered.clear();
}

async function fetchJson(uri: string): Promise<unknown> {
  const body = await fetcher.fetch(uri);
  return JSON.parse(new TextDecoder().decode(body));
}

/** The JWKS location an OIDC discovery document names, checked to describe the same issuer. */
function jwksUriFromDiscovery(discoveryUrl: string, iss: string): Promise<string> {
  let pending = discovered.get(discoveryUrl);
  if (!pending) {
    pending = (async () => {
      const doc = (await fetchJson(discoveryUrl)) as { issuer?: unknown; jwks_uri?: unknown };
      if (doc?.issuer !== iss) throw new TokenRefused('not-verifiable', 'the discovery document names another issuer');
      if (typeof doc.jwks_uri !== 'string' || !/^https:\/\//.test(doc.jwks_uri)) {
        throw new TokenRefused('not-verifiable', 'the discovery document names no https jwks_uri');
      }
      return doc.jwks_uri;
    })();
    // A failed read is not remembered, so the next request tries again.
    pending.catch(() => discovered.delete(discoveryUrl));
    discovered.set(discoveryUrl, pending);
  }
  return pending;
}

/** The exact `iss` an Entra tenant's tokens carry, by the token version the entry declares. */
export function entraIssuer(tenant: string, tokenVersion: 1 | 2 | undefined): string {
  return tokenVersion === 1 ? `https://sts.windows.net/${tenant}/` : `https://login.microsoftonline.com/${tenant}/v2.0`;
}

/** Where an Entra tenant publishes its keys, by token version. */
function entraJwksUri(tenant: string, tokenVersion: 1 | 2 | undefined): string {
  return tokenVersion === 1
    ? `https://login.microsoftonline.com/${tenant}/discovery/keys`
    : `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`;
}

const isAtJwt = (typ: unknown): boolean => typeof typ === 'string' && /^(application\/)?at\+jwt$/i.test(typ);

/** The OIDC token-type check, run by the library after every standard check has passed. */
function oidcTokenTypeCheck(v: EdgeVerification) {
  return ({ header, payload }: { header: Record<string, unknown>; payload: Record<string, unknown> }): void => {
    const marked = v.tokenType ? payload[v.tokenType.claim] === v.tokenType.value : false;
    if (v.tokenUse === 'access') {
      if (!isAtJwt(header.typ) && !marked) throw new TokenRefused('token-use', 'an access token is declared and this is not one');
      return;
    }
    // An ID token: none of the marks of an access token.
    if (isAtJwt(header.typ) || payload.scp !== undefined || (payload.token_use !== undefined && payload.token_use !== 'id')) {
      throw new TokenRefused('token-use', 'an ID token is declared and this is an access token');
    }
  };
}

/**
 * The verifier for one entry and one exact `iss`, built once. `tenant` is the Entra tenant the entry was
 * matched on (`issuerForClaims` has already required `iss` to be that tenant's exact issuer).
 */
async function verifierFor(entry: EdgeIssuer, iss: string, tenant: string): Promise<{ verify(token: string): Promise<unknown> }> {
  const key = `${entry.id}\u0000${iss}`;
  const cached = verifiers.get(key);
  if (cached) return cached;
  const v = entry.verify!;
  let built: { verify(token: string): Promise<unknown> };
  if (entry.kind === 'cognito-pool' || entry.kind === 'cognito-federated') {
    const verifier = CognitoJwtVerifier.create(
      { userPoolId: entry.pool!, tokenUse: v.tokenUse, clientId: v.audience, graceSeconds: MAX_CLOCK_SKEW_SECONDS },
      { jwksCache },
    );
    built = { verify: (token) => verifier.verify(token) };
  } else {
    const jwksUri = entry.kind === 'oidc-entra'
      ? entraJwksUri(tenant, entry.tokenVersion)
      : await jwksUriFromDiscovery(v.discoveryUrl!, iss);
    const verifier = JwtVerifier.create(
      { issuer: iss, audience: v.audience, jwksUri, graceSeconds: MAX_CLOCK_SKEW_SECONDS, customJwtCheck: oidcTokenTypeCheck(v) },
      { jwksCache },
    );
    built = { verify: (token) => verifier.verify(token) };
  }
  verifiers.set(key, built);
  return built;
}

/** The library's refusal, as this file's code. Anything unrecognized is a signature refusal: fail closed. */
function refusalOf(err: unknown): TokenRefused {
  if (err instanceof TokenRefused) return err;
  const message = (err as Error)?.message || String(err);
  const code: RefusalCode = err instanceof JwtExpiredError ? 'expired'
    : err instanceof JwtNotBeforeError ? 'not-yet-valid'
    : err instanceof JwtInvalidIssuerError ? 'issuer'
    : err instanceof JwtInvalidAudienceError || err instanceof CognitoJwtInvalidClientIdError ? 'audience'
    : err instanceof CognitoJwtInvalidTokenUseError ? 'token-use'
    : err instanceof KidNotFoundInJwksError || err instanceof WaitPeriodNotYetEndedJwkError || err instanceof JwtWithoutValidKidError ? 'unknown-key'
    : err instanceof FetchError || err instanceof JwksValidationError ? 'keys-unavailable'
    : err instanceof JwtParseError ? 'malformed'
    : 'signature';
  return new TokenRefused(code, message);
}

// ── SUPPLIED KEYS: THE GUEST ISSUER'S AND A HOST'S ───────────────────────────────────────────────

/** A fetcher that fetches nothing: a supplied key set is all there is, so a `kid` outside it is refused. */
const REFUSING_FETCHER: Fetcher = {
  fetch: async () => { throw new TokenRefused('unknown-key', 'a key outside the supplied set is refused; nothing is fetched'); },
};
let suppliedJwksCache = new SimpleJwksCache({ fetcher: REFUSING_FETCHER });
const suppliedVerifiers = new Map<string, { verify(token: string): Promise<unknown> }>();

/**
 * The library verifier for one entry and one supplied key, built once: the key handed in as a JWKS of one
 * (`cacheJwks`) under a cache key that is never a URL, with the refusing fetcher behind it. It checks the
 * signature under the entry's one algorithm, `iss` exact, `aud`, and `nbf` and `exp` within the skew.
 * `source` is where the key came from (its KMS key ARN, its pinned SPKI), so a key replaced under the same
 * `kid` gets a verifier of its own rather than the old one.
 */
function suppliedKeyVerifier(entry: EdgeIssuer, kid: string, key: KeyObject, source: string): { verify(token: string): Promise<unknown> } {
  const v = entry.verify!;
  const cacheKey = JSON.stringify([entry.id, kid, source]);
  const cached = suppliedVerifiers.get(cacheKey);
  if (cached) return cached;
  if (!entry.iss) throw new TokenRefused('not-verifiable', `issuer "${entry.id}" names no issuer its tokens carry`);
  const jwk = { ...(key.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: v.algorithm, use: 'sig' };
  const verifier = JwtVerifier.create(
    {
      issuer: entry.iss as string,
      audience: [...v.audience],
      jwksUri: `urn:agent-echelon:supplied-keys:${encodeURIComponent(cacheKey)}`,
      graceSeconds: MAX_CLOCK_SKEW_SECONDS,
    },
    { jwksCache: suppliedJwksCache },
  );
  verifier.cacheJwks({ keys: [jwk as never] });
  const built = { verify: (token: string) => verifier.verify(token) };
  suppliedVerifiers.set(cacheKey, built);
  return built;
}

/** Forget every supplied-key verifier. For tests that hand in new keys under the same `kid`. */
function forgetSuppliedKeys(): void {
  suppliedJwksCache = new SimpleJwksCache({ fetcher: REFUSING_FETCHER });
  suppliedVerifiers.clear();
}

// ── THE GUEST ISSUER'S TOKENS ──────────────────────────────────────────────────────────────────

/** Replace how a guest signing key's public key is read. For tests, which hand in a local key. */
let guestKeyReader: (keyArn: string) => Promise<KeyObject> = (keyArn) => guestPublicKey(keyArn);
export function __setGuestKeyReaderForTests(next?: (keyArn: string) => Promise<KeyObject>): void {
  guestKeyReader = next ?? ((keyArn) => guestPublicKey(keyArn));
  forgetSuppliedKeys();
}

/** Verify a guest token's signature and claims. Throws `TokenRefused`. */
async function verifyGuestToken(token: string, header: Record<string, unknown>, entry: EdgeIssuer, nowMs: number): Promise<Record<string, unknown>> {
  const v = entry.verify!;
  const kid = typeof header.kid === 'string' ? header.kid : '';
  const keyArn = kid && v.keys && Object.prototype.hasOwnProperty.call(v.keys, kid) ? v.keys[kid] : '';
  if (!keyArn) throw new TokenRefused('unknown-key', `a guest token naming the key "${kid || '(none)'}" is refused`);
  if (header.typ !== undefined && header.typ !== 'JWT') throw new TokenRefused('token-use', 'a guest token is typed JWT');
  let key: KeyObject;
  try {
    key = await guestKeyReader(keyArn);
  } catch (err) {
    throw new TokenRefused('keys-unavailable', `the guest signing key could not be read: ${(err as Error)?.name || 'error'}`);
  }
  let claims: Record<string, unknown>;
  try {
    claims = (await suppliedKeyVerifier(entry, kid, key, keyArn).verify(token)) as Record<string, unknown>;
  } catch (err) {
    throw refusalOf(err);
  }
  const now = Math.floor(nowMs / 1000);
  if (claims.token_use !== GUEST_TOKEN_USE) throw new TokenRefused('token-use', 'the token is not a guest token');
  if (typeof claims.exp !== 'number') throw new TokenRefused('no-expiry', 'a token with no expiry is refused');
  if (typeof claims.iat !== 'number' || claims.iat - MAX_CLOCK_SKEW_SECONDS > now
    || claims.exp - claims.iat > (v.maxLifetimeSeconds ?? 0)) {
    throw new TokenRefused('lifetime', 'the guest token lives longer than its issuer allows');
  }
  return claims;
}

// ── A HOST'S ASSERTION ───────────────────────────────────────────────────────────────────────────

/** The longest `jti` accepted. A host's own ids are far shorter; this bounds what the store is asked to hash. */
const MAX_JTI_LENGTH = 256;

/** Verify a host assertion's signature and claims against its entry's pinned keys. Throws `TokenRefused`. */
async function verifyHostAssertion(token: string, header: Record<string, unknown>, entry: EdgeIssuer, nowMs: number): Promise<Record<string, unknown>> {
  const v = entry.verify!;
  const kid = typeof header.kid === 'string' ? header.kid : '';
  const spki = kid && v.pinnedKeys && Object.prototype.hasOwnProperty.call(v.pinnedKeys, kid) ? v.pinnedKeys[kid] : '';
  if (!spki) throw new TokenRefused('unknown-key', `an assertion naming the key "${kid || '(none)'}" is refused; the registry pins no such key`);
  if (header.typ !== undefined && header.typ !== 'JWT') throw new TokenRefused('token-use', 'a host assertion is typed JWT');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new TokenRefused('not-verifiable', `issuer "${entry.id}" pins a key that is not a public key`);
  }
  let claims: Record<string, unknown>;
  try {
    claims = (await suppliedKeyVerifier(entry, kid, key, spki).verify(token)) as Record<string, unknown>;
  } catch (err) {
    throw refusalOf(err);
  }
  const now = Math.floor(nowMs / 1000);
  const max = v.maxLifetimeSeconds ?? 0;
  if (typeof claims.exp !== 'number') throw new TokenRefused('no-expiry', 'an assertion with no expiry is refused');
  // A LONG EXPIRY IS REFUSED with a valid signature: ahead of now, and from its own `iat`.
  if (claims.exp - now > max + MAX_CLOCK_SKEW_SECONDS || typeof claims.iat !== 'number'
    || claims.iat - MAX_CLOCK_SKEW_SECONDS > now || claims.exp - claims.iat > max) {
    throw new TokenRefused('lifetime', `the assertion lives longer than its issuer allows (${max} seconds)`);
  }
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > MAX_JTI_LENGTH) {
    throw new TokenRefused('no-jti', 'an assertion carries a jti, presented once');
  }
  return claims;
}

// ── THE CHECK ────────────────────────────────────────────────────────────────────────────────────

/**
 * Verify a token against the registry, or throw `TokenRefused` naming why. `issuers` defaults to the
 * registry this function was handed (`TRUSTED_ISSUERS`).
 */
export async function verifyToken(
  token: string,
  issuers: readonly EdgeIssuer[] = trustedIssuers() as EdgeIssuer[],
  nowMs: number = Date.now(),
): Promise<VerifiedToken> {
  let header: Record<string, unknown>;
  let unverified: Record<string, unknown>;
  try {
    const decomposed = decomposeUnverifiedJwt(token);
    header = decomposed.header as Record<string, unknown>;
    unverified = decomposed.payload as Record<string, unknown>;
  } catch (err) {
    throw new TokenRefused('malformed', (err as Error)?.message || 'not a JWT');
  }

  // THE ALGORITHM, BEFORE ANY KEY. `none` and HMAC never reach a verifier.
  const alg = typeof header.alg === 'string' ? header.alg : '';
  if (!ACCEPTED_ALGORITHMS.has(alg)) throw new TokenRefused('algorithm', `the algorithm "${alg || '(none)'}" is refused`);
  for (const field of REFUSED_HEADERS) {
    if (header[field] !== undefined) throw new TokenRefused('embedded-key', `a token header carrying "${field}" is refused`);
  }

  // THE ENTRY, from the unverified claims: it names the keys to verify with, and nothing else yet.
  const entry = issuerForClaims(issuers as TrustedIssuer[], unverified) as EdgeIssuer | null;
  if (!entry) throw new TokenRefused('unknown-issuer', 'a token from an issuer the registry does not declare');
  // EVERY REFUSAL FROM HERE NAMES THE ENTRY, so a count by issuer and check can be kept (A9's metric).
  const named = (err: TokenRefused): TokenRefused => {
    err.issuer = { id: entry.id, kind: entry.kind };
    return err;
  };
  if (!entry.verify || !entry.verify.audience?.length) {
    throw named(new TokenRefused('not-verifiable', `issuer "${entry.id}" carries no verification for the edge`));
  }
  if (alg !== entry.verify.algorithm) {
    throw named(new TokenRefused('algorithm', `issuer "${entry.id}" signs with ${entry.verify.algorithm}; a token naming ${alg} is refused`));
  }
  const iss = String(unverified.iss);
  const tenant = typeof unverified.tid === 'string' ? unverified.tid : '';

  let claims: Record<string, unknown>;
  try {
    if (entry.kind === 'guest') {
      claims = await verifyGuestToken(token, header, entry, nowMs);
    } else if (entry.kind === 'host-assertion') {
      claims = await verifyHostAssertion(token, header, entry, nowMs);
    } else {
      try {
        claims = (await (await verifierFor(entry, iss, tenant)).verify(token)) as Record<string, unknown>;
      } catch (err) {
        throw refusalOf(err);
      }
    }
  } catch (err) {
    throw err instanceof TokenRefused ? named(err) : err;
  }

  if (typeof claims.exp !== 'number') throw named(new TokenRefused('no-expiry', 'a token with no expiry is refused'));
  if (entry.kind === 'oidc' || entry.kind === 'oidc-entra') {
    const v = entry.verify;
    // A DIRECT PROVIDER'S TOKEN IS BOUNDED (SPEC-CREDENTIAL-EXCHANGE §4b): from its own `iat` to its `exp`,
    // no longer than the entry allows.
    if (v.maxLifetimeSeconds !== undefined && (typeof claims.iat !== 'number' || claims.exp - claims.iat > v.maxLifetimeSeconds)) {
      throw named(new TokenRefused('lifetime', `a token from "${entry.id}" lives longer than its issuer allows`));
    }
    // AN `iss` SHARED ACROSS ORGANIZATIONS IS NOT ONE ORGANIZATION: Google's is every Google account's, so
    // the entry names the claims that make a token its own (`hd` for a Workspace domain), compared exactly.
    for (const [claim, value] of Object.entries(v.requiredClaims ?? {})) {
      if (claims[claim] !== value) throw named(new TokenRefused('required-claim', `a token from "${entry.id}" does not carry ${claim} as its entry requires`));
    }
  }
  // THE ENTRY AGAIN, from what the signature covers. A different answer means the unverified claims lied.
  const confirmed = issuerForClaims(issuers as TrustedIssuer[], claims);
  if (!confirmed || confirmed.id !== entry.id) throw named(new TokenRefused('issuer', 'the verified claims name another issuer'));
  return { issuer: entry, claims };
}
