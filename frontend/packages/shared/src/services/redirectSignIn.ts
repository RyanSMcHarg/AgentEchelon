/**
 * REDIRECT SIGN-IN: the authorization code flow with PKCE, beside the password flow.
 *
 * It serves the two redirect kinds the trusted-issuer registry declares (`backend/lib/config/issuers.ts`):
 *
 *  - `cognito-federated`: a SAML or OIDC provider configured on this deployment's own pool, reached
 *    through Cognito managed login with `identity_provider` naming it. The app client is this build's own.
 *  - `oidc` and `oidc-entra`: a foreign OpenID Connect issuer, reached at its own authorization endpoint.
 *
 * Both read their endpoints from the issuer's discovery document, so the client carries no URL beyond
 * the one the registry declares. The ID token that comes back goes to the credential exchange exactly as
 * the password flow's does: the exchange, not the token, says who the person is.
 *
 * ── WHAT IS CHECKED, AND WHERE IT IS KEPT ────────────────────────────────────────────────────────
 *
 *  - `state`: random per sign-in, compared exactly on the callback. A callback this tab did not start
 *    is refused before any code is redeemed.
 *  - `nonce`: random per sign-in, sent in the authorization request and required in the ID token.
 *  - The PKCE verifier (S256): random per sign-in, held only in `sessionStorage`, which is scoped to the
 *    tab, and deleted the moment the callback reads it, whatever the outcome. A sign-in is single-use.
 *  - The redirect URI is this origin's `/callback`, fixed. It is recorded at the start and must still be
 *    this origin's at the callback; it is never read from the callback URL.
 *  - The discovery document's `issuer` must be the registry's, and the ID token's `iss` and `aud` must be
 *    the issuer's and this client's. A pending sign-in older than ten minutes is refused.
 *
 * The signature is not checked here: the token arrives over TLS straight from the token endpoint
 * (OpenID Connect Core 3.1.3.7), and the credential exchange and the edge verify it before it reaches
 * anything.
 */
import { idTokenProtocolClaims } from './idTokenClaims';

// ── THE ISSUERS ─────────────────────────────────────────────────────────────────────────────────────

/** The registry kinds a person signs in through by redirect. */
export const REDIRECT_KINDS = ['cognito-federated', 'oidc', 'oidc-entra'] as const;
export type RedirectKind = (typeof REDIRECT_KINDS)[number];

/** One redirect issuer, as `VITE_ISSUERS` carries it. Public fields only. */
export interface SignInIssuer {
  /** The registry id. */
  id: string;
  kind: RedirectKind;
  /** What the sign-in screen calls it, per locale. */
  displayName: Record<string, string>;
  /** The issuer's OpenID discovery document. */
  discoveryUrl: string;
  /** The exact `iss` its tokens carry, when it is one value (an Entra entry with several tenants has none). */
  issuer?: string;
  /** The OAuth client id this deployment is registered under. Absent: this build's own pool client. */
  clientId?: string;
  /** `cognito-federated`: the provider name configured on the pool. */
  providerName?: string;
  /** May this issuer's people hold an admin role. The admin console offers only these. */
  admin?: boolean;
}

const HTTPS = /^https:\/\/[^\s]+$/;
const ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The issuers `VITE_ISSUERS` declares, each checked. An entry that is not one is dropped rather than
 * offered: a button that cannot complete a sign-in is worse than no button.
 */
export function parseSignInIssuers(raw: string | undefined | null): SignInIssuer[] {
  if (!raw || !raw.trim()) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    console.error('[SignIn] VITE_ISSUERS is not JSON; no redirect sign-in is offered');
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: SignInIssuer[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const i = e as Partial<SignInIssuer>;
    if (typeof i.id !== 'string' || !ID.test(i.id)) continue;
    if (!REDIRECT_KINDS.includes(i.kind as RedirectKind)) continue;
    if (typeof i.discoveryUrl !== 'string' || !HTTPS.test(i.discoveryUrl)) continue;
    if (i.issuer !== undefined && (typeof i.issuer !== 'string' || !HTTPS.test(i.issuer))) continue;
    if (i.kind === 'cognito-federated' && (typeof i.providerName !== 'string' || !i.providerName)) continue;
    // A foreign issuer registers this deployment under its own client id; there is no default for it.
    if (i.kind !== 'cognito-federated' && (typeof i.clientId !== 'string' || !i.clientId)) continue;
    const names = i.displayName && typeof i.displayName === 'object' ? i.displayName : {};
    out.push({
      id: i.id,
      kind: i.kind as RedirectKind,
      displayName: Object.fromEntries(Object.entries(names).filter(([, v]) => typeof v === 'string' && v)),
      discoveryUrl: i.discoveryUrl,
      ...(i.issuer ? { issuer: i.issuer } : {}),
      ...(i.clientId ? { clientId: i.clientId } : {}),
      ...(i.providerName ? { providerName: i.providerName } : {}),
      admin: i.admin === true,
    });
  }
  return out;
}

/**
 * The issuer's name in a locale: the exact locale, then its language (`pt` for `pt-BR`), then English,
 * then the registry id, which is what the registry itself defaults the name to.
 */
export function issuerDisplayName(issuer: SignInIssuer, language: string | undefined): string {
  const names = issuer.displayName;
  const lang = language || 'en';
  return names[lang] || names[lang.split('-')[0]] || names.en || issuer.id;
}

// ── THE FAILURES ────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a redirect sign-in did not finish. Each has a localized message under `auth.redirect.errors`;
 * the code, never the provider's own text, is what the person is shown.
 */
export const REDIRECT_FAILURES = [
  'state-mismatch',
  'no-pending-sign-in',
  'expired',
  'provider-refused',
  'undeclared-issuer',
  'nonce-mismatch',
  'token-mismatch',
  'token-exchange-failed',
  'unavailable',
] as const;
export type RedirectFailure = (typeof REDIRECT_FAILURES)[number];

export class RedirectSignInError extends Error {
  readonly code: RedirectFailure;
  constructor(code: RedirectFailure, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RedirectSignInError';
    this.code = code;
  }
}

// ── STORAGE ─────────────────────────────────────────────────────────────────────────────────────────

/** The path the issuer returns to. Registered on the pool's app clients as `<origin>/callback`. */
export const CALLBACK_PATH = '/callback';
/** sessionStorage: the one sign-in this tab has in flight. */
const PENDING_KEY = 'ae.signin.pending';
/** localStorage: the redirect issuer the stored tokens came from. Absent: the password flow. */
const SESSION_ISSUER_KEY = 'ae.signin.issuer';
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingSignIn {
  issuerId: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

/** This origin's callback URI. Fixed: never read from a URL the issuer sent back. */
export function redirectUri(): string {
  return `${window.location.origin}${CALLBACK_PATH}`;
}

/** Is this page load an issuer returning to the callback route? */
export function isRedirectCallback(): boolean {
  return window.location.pathname === CALLBACK_PATH;
}

/** The redirect issuer the stored session came from, or null for a password session. */
export function sessionIssuerId(): string | null {
  return localStorage.getItem(SESSION_ISSUER_KEY);
}

export function setSessionIssuerId(id: string | null): void {
  if (id) localStorage.setItem(SESSION_ISSUER_KEY, id);
  else localStorage.removeItem(SESSION_ISSUER_KEY);
}

/** Read the pending sign-in and delete it in the same step, so it can be used once. */
function takePending(): PendingSignIn | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingSignIn;
    return p && typeof p.state === 'string' && typeof p.verifier === 'string' ? p : null;
  } catch {
    return null;
  }
}

// ── PKCE ────────────────────────────────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url: 43 characters, inside RFC 7636's 43 to 128. */
function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ── DISCOVERY ───────────────────────────────────────────────────────────────────────────────────────

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
}

async function discover(issuer: SignInIssuer, fetchImpl: typeof fetch): Promise<Discovery> {
  let doc: Partial<Discovery>;
  try {
    const res = await fetchImpl(issuer.discoveryUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`discovery answered ${res.status}`);
    doc = (await res.json()) as Partial<Discovery>;
  } catch (error) {
    throw new RedirectSignInError('unavailable', error instanceof Error ? error.message : String(error));
  }
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint
    || !HTTPS.test(doc.authorization_endpoint) || !HTTPS.test(doc.token_endpoint)) {
    throw new RedirectSignInError('undeclared-issuer', 'the discovery document names no https endpoints');
  }
  // MIX-UP DEFENSE: the document must describe the issuer the registry declares.
  if (issuer.issuer && doc.issuer !== issuer.issuer) {
    throw new RedirectSignInError('undeclared-issuer', 'the discovery document names another issuer');
  }
  return doc as Discovery;
}

/** The scopes asked for. `offline_access` only where the issuer says it supports it (refresh). */
function scopesFor(issuer: SignInIssuer, doc: Discovery): string {
  const scopes = ['openid', 'email', 'profile'];
  if (issuer.kind !== 'cognito-federated' && doc.scopes_supported?.includes('offline_access')) scopes.push('offline_access');
  return scopes.join(' ');
}

// ── THE FLOW ────────────────────────────────────────────────────────────────────────────────────────

export interface RedirectDeps {
  /** This build's own pool app client, for a password session's refresh. */
  ownClientId?: string;
  /** The pool's federated app client (`VITE_FEDERATED_CLIENT_ID`), the one a `cognito-federated` provider is offered on. */
  federatedClientId?: string;
  fetchImpl?: typeof fetch;
  /** Navigates the tab. Injected so a test can read the URL instead of leaving the page. */
  assign?: (url: string) => void;
}

const clientIdOf = (issuer: SignInIssuer, deps: RedirectDeps): string => {
  const id = issuer.clientId || (issuer.kind === 'cognito-federated' ? deps.federatedClientId : undefined);
  if (!id) throw new RedirectSignInError('undeclared-issuer', 'no client id for this issuer');
  return id;
};

/** Start a sign-in: record what the callback must match, then send the tab to the issuer. */
export async function beginRedirectSignIn(issuer: SignInIssuer, deps: RedirectDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const clientId = clientIdOf(issuer, deps);
  const doc = await discover(issuer, fetchImpl);
  const pending: PendingSignIn = {
    issuerId: issuer.id,
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    redirectUri: redirectUri(),
    createdAt: Date.now(),
  };
  // One sign-in per tab: a second start replaces the first, whose callback then fails its state check.
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', pending.redirectUri);
  url.searchParams.set('scope', scopesFor(issuer, doc));
  url.searchParams.set('state', pending.state);
  url.searchParams.set('nonce', pending.nonce);
  url.searchParams.set('code_challenge', await codeChallengeFor(pending.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (issuer.kind === 'cognito-federated' && issuer.providerName) url.searchParams.set('identity_provider', issuer.providerName);
  (deps.assign ?? navigation.assign)(url.toString());
}

/** How the tab leaves for the issuer. One seam, so a component test reads the URL instead of navigating. */
export const navigation = {
  assign: (url: string): void => window.location.assign(url),
};

/**
 * One completion per callback URL. React's development double-mount runs the mount effect twice; the
 * second run would find the pending sign-in already spent and report a failure for a sign-in that
 * succeeded, so both runs share the first one's answer.
 */
let completion: { href: string; promise: Promise<RedirectTokens> } | null = null;
export function completeRedirectSignInOnce(
  href: string,
  issuers: readonly SignInIssuer[],
  deps: RedirectDeps = {},
): Promise<RedirectTokens> {
  if (!completion || completion.href !== href) completion = { href, promise: completeRedirectSignIn(href, issuers, deps) };
  return completion.promise;
}

/**
 * The pool app client a Cognito session refreshes on: the federated client for a `cognito-federated`
 * session, whose refresh token that client issued, and the build's own client for a password session.
 */
export function cognitoRefreshClientId(issuers: readonly SignInIssuer[], ownClientId: string, federatedClientId: string): string {
  const id = sessionIssuerId();
  const issuer = id ? issuers.find((i) => i.id === id) : undefined;
  return issuer?.kind === 'cognito-federated' ? federatedClientId : ownClientId;
}

/** The session's issuer when it is a foreign one, whose refresh goes to its own token endpoint. */
export function foreignSessionIssuer(issuers: readonly SignInIssuer[]): SignInIssuer | 'undeclared' | null {
  const id = sessionIssuerId();
  if (!id) return null;
  const issuer = issuers.find((i) => i.id === id);
  if (!issuer) return 'undeclared';
  return issuer.kind === 'cognito-federated' ? null : issuer;
}

export interface RedirectTokens {
  issuerId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

async function postToken(endpoint: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
}

/** The `iss` a token from this issuer must carry. An Entra template takes the token's own tenant. */
function expectedIss(issuer: SignInIssuer, doc: Discovery, tid: string | undefined): string {
  const iss = issuer.issuer || doc.issuer;
  return iss.includes('{tenantid}') && tid ? iss.replace('{tenantid}', tid) : iss;
}

/** The ID token's claims must be the issuer's, for this client, carrying this sign-in's nonce. */
function checkIdToken(idToken: string, issuer: SignInIssuer, doc: Discovery, clientId: string, nonce: string): void {
  const claims = idTokenProtocolClaims(idToken);
  if (!claims) throw new RedirectSignInError('token-mismatch', 'the ID token is unreadable');
  if (claims.nonce !== nonce) throw new RedirectSignInError('nonce-mismatch');
  if (claims.iss !== expectedIss(issuer, doc, claims.tid)) throw new RedirectSignInError('token-mismatch', 'iss');
  if (!claims.aud.includes(clientId)) throw new RedirectSignInError('token-mismatch', 'aud');
}

/**
 * Finish a sign-in from the callback URL, or throw a `RedirectSignInError` naming why not.
 *
 * The order is the defense: the pending sign-in is taken (and so spent) first, the state is compared
 * before anything else is read, and no code is redeemed for a callback this tab did not start.
 */
export async function completeRedirectSignIn(
  href: string,
  issuers: readonly SignInIssuer[],
  deps: RedirectDeps = {},
): Promise<RedirectTokens> {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const params = new URL(href).searchParams;
  const pending = takePending();
  if (!pending) throw new RedirectSignInError('no-pending-sign-in');
  const state = params.get('state');
  if (!state || state !== pending.state) throw new RedirectSignInError('state-mismatch');
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) throw new RedirectSignInError('expired');
  if (params.get('error')) throw new RedirectSignInError('provider-refused', params.get('error') || undefined);
  const code = params.get('code');
  if (!code) throw new RedirectSignInError('provider-refused', 'no code');
  if (pending.redirectUri !== redirectUri()) throw new RedirectSignInError('state-mismatch', 'redirect URI');
  const issuer = issuers.find((i) => i.id === pending.issuerId);
  if (!issuer) throw new RedirectSignInError('undeclared-issuer');
  const clientId = clientIdOf(issuer, deps);
  const doc = await discover(issuer, fetchImpl);

  let res: Response;
  try {
    res = await postToken(doc.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
    }, fetchImpl);
  } catch (error) {
    throw new RedirectSignInError('unavailable', error instanceof Error ? error.message : String(error));
  }
  if (!res.ok) throw new RedirectSignInError('token-exchange-failed', `token endpoint answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!body.id_token || !body.access_token) throw new RedirectSignInError('token-exchange-failed', 'no ID or access token');
  checkIdToken(body.id_token, issuer, doc, clientId, pending.nonce);
  return {
    issuerId: issuer.id,
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || '',
  };
}

/**
 * Redeem a refresh token at a foreign issuer's token endpoint. A `cognito-federated` session is
 * refreshed through Cognito like a password session, so this is never called for one.
 *
 * Failures carry `$metadata.httpStatusCode` the way an AWS SDK error does, so the provider classifies
 * a refusal and an outage with the one rule it already has.
 */
export async function refreshRedirectTokens(
  issuer: SignInIssuer,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<{ idToken: string; accessToken: string; refreshToken?: string }> {
  const doc = await discover(issuer, fetchImpl).catch((error) => {
    throw Object.assign(new Error(`discovery failed: ${(error as Error).message}`), { name: 'NetworkError' });
  });
  const res = await postToken(doc.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: issuer.clientId || '',
  }, fetchImpl);
  if (!res.ok) {
    throw Object.assign(new Error(`the token endpoint answered ${res.status}`), { $metadata: { httpStatusCode: res.status } });
  }
  const body = (await res.json()) as TokenResponse;
  if (!body.id_token) throw Object.assign(new Error('no ID token in the refresh answer'), { $metadata: { httpStatusCode: 400 } });
  return { idToken: body.id_token, accessToken: body.access_token || '', ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}) };
}
