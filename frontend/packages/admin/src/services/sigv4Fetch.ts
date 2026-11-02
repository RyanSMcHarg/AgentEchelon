/**
 * Signed requests to the admin APIs, on short-lived credentials the admin credential exchange issues
 * (SPEC-ADMIN-CONSOLE "Temporary, scoped credentials").
 *
 * The console holds no standing credential. It signs the person in at the person credential exchange
 * (which mints or resolves them; the admin exchange never mints), then asks the admin credential
 * exchange, with the person's Cognito token, for a console session: an hour on the console role the person's groups name (`admins` or `team-members`),
 * holding exactly that role's capabilities. Every admin route is IAM-authorized, so each call is
 * SigV4-signed with that session, and API Gateway refuses a role that does not hold the route.
 *
 * Two credential sources, and the second is narrower than the first:
 *   - the CONSOLE SESSION (`consoleCredentials`), for the standing reads and writes a role holds;
 *   - a PER-CONVERSATION VEND (`vendAdminCapability`), requested on the capability's own route with a
 *     stated reason, for message content, attachments and every live action on a conversation.
 */
import i18n from '@ae/shared/i18n';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { REGION, ApiError, ensureFreshIdToken, exchangeCredentials } from '@ae/shared';
import { teamAssistant } from './teamScope';
import { ADMIN_API_MOUNTS, adminApiConfigured, adminSurfaceRoot, adminUrl, type AdminSurface } from './adminApi';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** One admin route and the capability that authorizes it, as the exchange publishes them. */
export interface CapabilityRoute {
  capability: string;
  api: string;
  method: string;
  path: string;
}

/** What a console session is, beyond its keys: the role it runs as, the capabilities that role holds, and
 *  which capability authorizes each admin route - so a refusal can say what was missing. */
export interface ConsoleSession {
  credentials: SigV4Credentials;
  role: 'admins' | 'team-members';
  capabilities: string[];
  routes: CapabilityRoute[];
  /** For a team member: the assistants their team owns and they are cleared for. Absent for an admin. */
  assistants?: string[];
  /** For a team member: the teams their `team-<name>` groups make them a member of. Absent for an admin. */
  teams?: string[];
  /** For a team member: the team that owns each of `assistants`. */
  owners?: Record<string, string>;
  /**
   * Which of `capabilities` the session does not carry and the exchange vends on request (the catalog's
   * `exchangeVend` entries), and how long one such credential lasts. Absent from an exchange that does
   * not report it, in which case the console cannot say which is which.
   */
  onRequest?: { capabilities: string[]; ttlSeconds: number };
}

/**
 * Whether the admin credential exchange can be reached: its routes (console sessions, the per-capability
 * admin vends and the access log) are on `AdminApi`, so it is configured exactly when `VITE_ADMIN_API_URL`
 * is. An admin-only URL, so it is read in the admin package (`adminApi.ts`), never from the shared config
 * the chat bundle also carries.
 */
export const adminCredentialExchangeConfigured = (): boolean => adminApiConfigured();

/** Throws `message` when the admin API is unconfigured, so a caller names what it needed. */
export function requireAdminApi(message: string): void {
  if (!adminApiConfigured()) throw new Error(message);
}

/** The last session issued, read synchronously when a refusal needs naming. */
let lastSession: ConsoleSession | null = null;

/** The root each admin surface is served at on `AdminApi`, from its mount (`ADMIN_API_MOUNTS`). */
function apiRoots(): Record<string, string> {
  const roots: Record<string, string> = {};
  for (const surface of Object.keys(ADMIN_API_MOUNTS) as AdminSurface[]) roots[surface] = adminSurfaceRoot(surface);
  return roots;
}

/** The capability that authorizes a request, from the session's route list, or null when none matches. */
export function capabilityForRequest(method: string, url: string): string | null {
  if (!lastSession) return null;
  const roots = apiRoots();
  const target = url.split('?')[0].replace(/\/$/, '');
  for (const r of lastSession.routes) {
    if (r.method !== method || !roots[r.api]) continue;
    const pattern = `${roots[r.api]}/${r.path}`.replace(/\/$/, '');
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, (ch) => '\\' + ch).replace(/\*/g, '[^/]+') + '$');
    if (re.test(target)) return r.capability;
  }
  return null;
}

/** True for API Gateway's own IAM refusal, as against a handler's 403. */
function isGatewayRefusal(status: number, message: string | undefined): boolean {
  if (status !== 403) return false;
  // An HTTP API refuses a signed call it does not authorize with the bare body `{"message":"Forbidden"}`;
  // the IAM sentences are what an authorizer or a REST gateway says.
  if ((message || '').trim() === 'Forbidden') return true;
  return /not authorized to perform|explicit deny|no identity-based policy/i.test(message || '');
}

/**
 * The message an operator reads when the gateway refuses them (SPEC-ADMIN-CONSOLE FR53): the capability
 * they lack and who can grant it, never the raw IAM sentence.
 */
function refusalMessage(method: string, url: string, status: number, message: string | undefined, code?: string): string | undefined {
  // A TEAM ROUTE REFUSED IS A SCOPE REFUSAL, NOT A MISSING CAPABILITY. The person holds the capability;
  // the assistant in the path is one their team does not own (or no longer does), which IAM refuses by
  // the session policy and the handler by its own check. Say that, and name the assistant.
  const assistant = /\/assistants\/([^/?]+)\//.exec(url)?.[1];
  if (assistant && (code === 'ASSISTANT_NOT_OWNED' || isGatewayRefusal(status, message))) {
    return i18n.t('admin.refusal.assistantNotOwned', { assistant: decodeURIComponent(assistant) });
  }
  if (!isGatewayRefusal(status, message)) return message;
  const capability = capabilityForRequest(method, url);
  return capability
    ? i18n.t('admin.refusal.lacksCapability', { capability })
    : i18n.t('admin.refusal.lacksUnknownCapability');
}

/**
 * The resolved (or in-flight) session, so a BURST of concurrent callers issues one exchange call instead
 * of one per caller. The dashboard mounts and fires every section's reads at once; holding the PROMISE,
 * not just the value, is what collapses the burst, because the window that matters is before the first
 * request resolves. Keyed on the idToken it was issued for, so a different sign-in never reuses it.
 */
let sessionCache: { promise: Promise<ConsoleSession>; expiresAt: number; token: string } | null = null;

/** Re-fetch this far before the session actually expires, so a signed request never races it. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** Used when the exchange does not report an expiry; well inside the console session length. */
const FALLBACK_TTL_MS = 10 * 60_000;

function consoleSessionUrl(): string {
  requireAdminApi(i18n.t('admin.sigv4Fetch.consoleSessionRequiresTheExchange'));
  return adminUrl('admin-exchange', '/exchange-credentials');
}

async function fetchConsoleSession(idToken: string): Promise<ConsoleSession & { expiration?: number }> {
  const url = consoleSessionUrl();
  // THE PERSON EXCHANGE FIRST. It is the only minter: a first sign-in creates the person there, and the
  // admin exchange answers a person it has never seen with 409 PERSON_NOT_SIGNED_IN. A refusal here (a
  // person their issuer reports disabled, an untrusted issuer) is the person's answer, and is thrown as it came.
  await exchangeCredentials({}, idToken);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'console' }),
  });
  let body: { error?: string; credentials?: Record<string, string>; role?: ConsoleSession['role']; capabilities?: string[] } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || !body.credentials) {
    throw new ApiError(res.status, body.error ?? `Console session failed: ${res.status}`, body);
  }
  const c = body.credentials;
  return {
    credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
    role: body.role ?? 'admins',
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
    routes: Array.isArray((body as { routes?: CapabilityRoute[] }).routes) ? (body as { routes: CapabilityRoute[] }).routes : [],
    ...(Array.isArray((body as { assistants?: string[] }).assistants) ? { assistants: (body as { assistants: string[] }).assistants } : {}),
    ...(Array.isArray((body as { teams?: string[] }).teams) ? { teams: (body as { teams: string[] }).teams } : {}),
    ...ownersOf((body as { owners?: unknown }).owners),
    ...onRequestOf((body as { onRequest?: unknown }).onRequest),
    expiration: c.Expiration ? new Date(c.Expiration).getTime() : undefined,
  };
}

/** The exchange's `owners` map, kept only when every value is a team name string. */
function ownersOf(raw: unknown): Pick<ConsoleSession, 'owners'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
  return { owners: Object.fromEntries(entries) };
}

/** The exchange's `onRequest` block, kept only when it is well formed. */
function onRequestOf(raw: unknown): Pick<ConsoleSession, 'onRequest'> {
  const o = raw as { capabilities?: unknown; ttlSeconds?: unknown } | undefined;
  if (!o || !Array.isArray(o.capabilities) || typeof o.ttlSeconds !== 'number') return {};
  return { onRequest: { capabilities: o.capabilities.filter((c): c is string => typeof c === 'string'), ttlSeconds: o.ttlSeconds } };
}

/** The console session for the signed-in person, issued once and reused until shortly before it expires. */
export async function consoleSession(): Promise<ConsoleSession> {
  // Always ask with a LIVE idToken - it refreshes on demand (the AuthProvider timer can miss in a bg tab).
  const idToken = await ensureFreshIdToken();
  const now = Date.now();
  if (sessionCache && sessionCache.token === idToken && sessionCache.expiresAt > now) return sessionCache.promise;

  // The handlers write the cache only if it still holds THIS request's entry, so a request in flight
  // when the cache is dropped (a sign-out, a new token) cannot republish the previous person's session.
  let entry: { promise: Promise<ConsoleSession>; expiresAt: number; token: string } | null = null;
  const promise = fetchConsoleSession(idToken)
    .then(({ expiration, ...session }) => {
      lastSession = session;
      if (sessionCache === entry) {
        sessionCache = {
          promise: Promise.resolve(session),
          expiresAt: expiration ? expiration - EXPIRY_MARGIN_MS : Date.now() + FALLBACK_TTL_MS,
          token: idToken,
        };
      }
      return session;
    })
    .catch((err) => {
      // Never cache a failure: the next caller must be able to retry, or one transient error would
      // wedge every signed call for the life of the page.
      if (sessionCache === entry) sessionCache = null;
      throw err;
    });
  // Publish the in-flight promise immediately - this is the line that collapses the burst.
  entry = { promise, expiresAt: now + 60_000, token: idToken };
  sessionCache = entry;
  return promise;
}

/** The console session's credentials, for signing a standing admin call. */
export async function consoleCredentials(): Promise<SigV4Credentials> {
  return (await consoleSession()).credentials;
}

/** Drop the cached console session (call on sign-out). */
export function resetSignOnCredentials(): void {
  sessionCache = null;
  lastSession = null;
}

/** What a per-conversation vend returns: credentials narrowed to one capability on one subject. */
export interface VendedAdminCredential {
  credentials: SigV4Credentials & { expiration?: Date };
  /** The identity the credential acts as - the operator's `${sub}-admin` for a live action. */
  userArn: string;
  /** An attachment vend's bucket and region, for presigning the one object it permits. */
  bucket?: string;
  region?: string;
}

/**
 * Request a per-conversation admin credential on the capability's own IAM-authorized route, with the
 * operator's stated reason (SPEC-ADMIN-CONSOLE FR45, FR51). The console session signs the request, so a
 * role that does not hold the capability is refused at the gateway; the exchange records the reason
 * beside what the credential reaches.
 */
/**
 * Where a capability is vended: the admin route, or, for a team member, the route under the assistant
 * the console is scoped to (only `attachment-read` has one), which the exchange binds to that assistant.
 */
export function vendUrl(capability: string): string {
  requireAdminApi(i18n.t('admin.sigv4Fetch.consoleSessionRequiresTheExchange'));
  const team = teamAssistant();
  if (team && capability === 'attachment-read') {
    return adminUrl('admin-exchange', `/exchange-credentials/admin/assistants/${encodeURIComponent(team)}/attachment-read`);
  }
  return adminUrl('admin-exchange', `/exchange-credentials/admin/${encodeURIComponent(capability)}`);
}

export async function vendAdminCapability(
  capability: string,
  scope: { channelArn?: string; principalId?: string; reason: string },
): Promise<VendedAdminCredential> {
  const creds = await consoleCredentials();
  const data = await sigv4PostJson<{
    credentials: Record<string, string>;
    userArn: string;
    bucket?: string;
    region?: string;
  }>(vendUrl(capability), scope, creds);
  const c = data.credentials;
  return {
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    },
    userArn: data.userArn,
    bucket: data.bucket,
    region: data.region,
  };
}

/**
 * SigV4-sign a GET to an `execute-api` URL with the given credentials and fetch it,
 * returning the parsed JSON. Query params are signed and re-serialized with the SAME
 * RFC3986 encoding SigV4 canonicalizes with (`encodeURIComponent`), so the signature
 * matches the sent request — AE's params (a Chime channel ARN, an integer limit) carry
 * no characters where `encodeURIComponent` diverges from SigV4.
 *
 * A query written into `url` is sent and signed with the rest; a key in `query` takes its place.
 */
export async function sigv4GetJson<T>(
  url: string,
  query: Record<string, string | number | undefined>,
  credentials: SigV4Credentials,
): Promise<T> {
  const u = new URL(url);
  const cleanQuery: Record<string, string> = Object.fromEntries(u.searchParams.entries());
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) cleanQuery[k] = String(v);
  }

  const signer = new SignatureV4({
    service: 'execute-api',
    region: REGION,
    credentials,
    sha256: Sha256,
  });

  const signed = await signer.sign({
    method: 'GET',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    query: cleanQuery,
    headers: { host: u.host },
  });

  const qs = Object.entries(cleanQuery)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const fetchUrl = qs ? `${u.origin}${u.pathname}?${qs}` : `${u.origin}${u.pathname}`;

  const res = await fetch(fetchUrl, {
    method: 'GET',
    headers: signed.headers as Record<string, string>,
  });

  if (!res.ok) {
    // THE WHOLE BODY RIDES THE ERROR, not just its message: a 409 carries the `conflicts` that the
    // console's resolution flow renders, and a caller that only got the string had nothing to show.
    let errBody: unknown;
    try {
      errBody = await res.clone().json();
    } catch {
      /* non-JSON error body */
    }
    const be = (errBody as { error?: string; message?: string; Message?: string } | undefined);
    const said = be?.error ?? be?.message ?? be?.Message;
    throw new ApiError(res.status, refusalMessage('GET', fetchUrl, res.status, said, (errBody as { code?: string } | undefined)?.code) ?? `Signed admin request failed: ${res.status}`, errBody);
  }
  return res.json() as Promise<T>;
}

/**
 * SigV4-sign a POST (JSON body) to an `execute-api` URL and fetch it. Used for the
 * analytics query plane (the frontend's queryType contract is a POST) under A14
 * IAM enforcement — the body is signed, so it cannot be tampered in flight.
 */
export async function sigv4PostJson<T>(
  url: string,
  body: unknown,
  credentials: SigV4Credentials,
): Promise<T> {
  const u = new URL(url);
  const payload = JSON.stringify(body ?? {});

  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const signed = await signer.sign({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    headers: { host: u.host, 'content-type': 'application/json' },
    body: payload,
  });

  const res = await fetch(url, { method: 'POST', headers: signed.headers as Record<string, string>, body: payload });
  if (!res.ok) {
    // THE WHOLE BODY RIDES THE ERROR, not just its message: a 409 carries the `conflicts` that the
    // console's resolution flow renders, and a caller that only got the string had nothing to show.
    let errBody: unknown;
    try {
      errBody = await res.clone().json();
    } catch {
      /* non-JSON error body */
    }
    const be = (errBody as { error?: string; message?: string; Message?: string } | undefined);
    const said = be?.error ?? be?.message ?? be?.Message;
    throw new ApiError(res.status, refusalMessage('POST', url, res.status, said, (errBody as { code?: string } | undefined)?.code) ?? `Signed admin request failed: ${res.status}`, errBody);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** SigV4-sign a DELETE to an `execute-api` URL and fetch it. */
export async function sigv4Delete<T>(url: string, credentials: SigV4Credentials): Promise<T> {
  const u = new URL(url);
  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const signed = await signer.sign({
    method: 'DELETE',
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    headers: { host: u.host },
  });
  const res = await fetch(url, { method: 'DELETE', headers: signed.headers as Record<string, string> });
  if (!res.ok) {
    // THE WHOLE BODY RIDES THE ERROR, not just its message: a 409 carries the `conflicts` that the
    // console's resolution flow renders, and a caller that only got the string had nothing to show.
    let errBody: unknown;
    try {
      errBody = await res.clone().json();
    } catch {
      /* non-JSON error body */
    }
    const be = (errBody as { error?: string; message?: string; Message?: string } | undefined);
    const said = be?.error ?? be?.message ?? be?.Message;
    throw new ApiError(res.status, refusalMessage('DELETE', url, res.status, said, (errBody as { code?: string } | undefined)?.code) ?? `Signed admin request failed: ${res.status}`, errBody);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * One admin call, signed with the operator's own sign-on credentials. Every admin route is
 * IAM-authorized (SPEC-ADMIN-CONSOLE FR43), so there is no unsigned path to fall back to: a role that
 * does not hold the route's capability is refused at the gateway.
 */
export async function adminRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const creds = await consoleCredentials();
  if (method === 'GET') return sigv4GetJson<T>(url, opts.query ?? {}, creds);
  if (method === 'DELETE') return sigv4Delete<T>(url, creds);
  return sigv4PostJson<T>(url, opts.body ?? {}, creds);
}
