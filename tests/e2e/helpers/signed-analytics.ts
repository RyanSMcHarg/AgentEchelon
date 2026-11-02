/**
 * SigV4-signed calls to the admin APIs, as the admin app makes them.
 *
 * Every admin route is AWS_IAM-authorized (SPEC-ADMIN-CONSOLE FR43): a Bearer Cognito JWT is refused.
 * The admin app trades the signed-in operator's id token for a console session at the admin credential
 * exchange and signs with that; these helpers do the same, then SigV4-sign with @smithy/signature-v4.
 *
 * Needs: VITE_PERSON_API_URL and VITE_ADMIN_API_URL + AWS_REGION.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { consoleSession } from './admin-api';
import { ADMIN_API_URL } from './api-urls';

const REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * CACHED PER ID TOKEN, because a poll calls this every few seconds. A console session lasts an hour; a
 * cached one is reused for 45 minutes.
 */
type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken: string };
const credsCache = new Map<string, { at: number; creds: Promise<Creds> }>();
const CREDS_TTL_MS = 45 * 60_000;

/**
 * THE CONSOLE SESSION for a signed-in operator (SPEC-ADMIN-CONSOLE FR45): the credentials the admin app
 * signs with. A person's own chat credential holds no admin route, so signing with it is refused at the
 * gateway exactly as the deny-test proves; the console role is what carries the caller's capabilities.
 */
export function consoleCreds(idToken: string): Promise<Creds> {
  const hit = credsCache.get(idToken);
  if (hit && Date.now() - hit.at < CREDS_TTL_MS) return hit.creds;
  const creds = fetchConsoleCreds(idToken);
  credsCache.set(idToken, { at: Date.now(), creds });
  creds.catch(() => credsCache.delete(idToken));
  return creds;
}

async function fetchConsoleCreds(idToken: string): Promise<Creds> {
  if (!ADMIN_API_URL) throw new Error('signed admin calls need VITE_ADMIN_API_URL for the console session');
  const session = await consoleSession(idToken);
  if (session.status !== 200) throw new Error(`console session refused (${session.status}): ${JSON.stringify(session.body).slice(0, 300)}`);
  const c = session.body.credentials ?? {};
  const accessKeyId = c.accessKeyId ?? c.AccessKeyId;
  const secretAccessKey = c.secretAccessKey ?? c.SecretAccessKey;
  const sessionToken = c.sessionToken ?? c.SessionToken;
  if (!accessKeyId || !secretAccessKey) throw new Error('the console session returned no usable credentials');
  return { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * SigV4-signed POST to the IAM-enforced analytics API. Returns parsed JSON (or `{status, text}`
 * on a non-JSON/error body). `idToken` is the caller's Cognito id token (localStorage `idToken`).
 */
export async function signedAnalyticsPost(analyticsUrl: string, idToken: string, body: unknown): Promise<any> {
  const creds = await consoleCreds(idToken);
  const u = new URL(analyticsUrl);
  const signer = new SignatureV4({ credentials: creds, region: REGION, service: 'execute-api', sha256: Sha256 });
  const bodyStr = JSON.stringify(body);
  // A REAL HttpRequest, not `{...} as any`. The cast defeated overload resolution on `sign()`, so TS
  // picked the string-returning (presign) overload and `signed.headers` below was a type error on a
  // `string`. It happened to work at runtime, which is exactly why it survived - and it is the same
  // shape-mismatch class as the console guard that "never once reported a console error usefully".
  // Neither was caught because tests/ had no typecheck until now.
  const signed = await signer.sign(new HttpRequest({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    headers: { host: u.hostname, 'content-type': 'application/json' },
    body: bodyStr,
  }));
  const resp = await fetch(u.toString(), { method: 'POST', headers: signed.headers as Record<string, string>, body: bodyStr });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: resp.status, text };
  }
}

/**
 * SigV4-signed GET against an IAM-enforced admin endpoint.
 *
 * The archive routes (`/admin/conversations`, `.../messages`, `.../membership-history`) are
 * AWS_IAM-authorized under A14 the same way the analytics API is, so a Cognito Bearer token is
 * rejected with a 403 and the browser cannot sign the request itself. Returns the parsed body
 * ALONGSIDE the HTTP status, because these handlers answer 200 with an `archiveError` field when
 * the underlying read fails - a caller that only checks the status would read a broken archive as
 * a healthy empty one.
 */
export async function signedAdminGet(
  url: string,
  idToken: string,
  query: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const creds = await consoleCreds(idToken);
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);

  // SignatureV4 takes the query as a map, not as a pre-encoded string; passing an already-encoded
  // path would double-encode the ARN colons and produce a signature mismatch.
  const signer = new SignatureV4({ credentials: creds, region: REGION, service: 'execute-api', sha256: Sha256 });
  const signed = await signer.sign(new HttpRequest({
    method: 'GET',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams.entries()),
    headers: { host: u.hostname },
  }));

  const resp = await fetch(u.toString(), { method: 'GET', headers: signed.headers as Record<string, string> });
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: { raw: text } };
  }
}

/**
 * A SIGNED STAND-IN FOR PLAYWRIGHT'S `APIRequestContext`, for the admin APIs.
 *
 * Every admin route is IAM-authorized (SPEC-ADMIN-CONSOLE FR43), so a Cognito Bearer token is refused
 * at the gateway on the experiments, battle-settings, profile and user-management routes as it is on
 * analytics. The specs that drove those routes held a Playwright request context with a Bearer header;
 * this answers the same `get` / `post` / `delete` / `dispose` calls with SigV4-signed requests on the
 * caller's Identity-Pool credentials, so a spec swaps its context and keeps its assertions.
 *
 * Only the response surface those specs read is implemented: `ok()`, `status()`, `json()`, `text()`.
 */
export interface SignedResponse {
  ok(): boolean;
  status(): number;
  json(): Promise<any>;
  text(): Promise<string>;
}
export interface SignedAdminContext {
  get(url: string, opts?: { params?: Record<string, string | number> }): Promise<SignedResponse>;
  post(url: string, opts?: { data?: unknown }): Promise<SignedResponse>;
  delete(url: string): Promise<SignedResponse>;
  dispose(): Promise<void>;
}

export function signedAdminContext(idToken: string): SignedAdminContext {
  let creds: Creds | null = null;
  const send = async (method: string, url: string, data?: unknown, params?: Record<string, string | number>) => {
    creds = creds ?? await consoleCreds(idToken);
    const u = new URL(url);
    for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, String(v));
    const body = data === undefined ? undefined : JSON.stringify(data);
    const signer = new SignatureV4({ credentials: creds, region: REGION, service: 'execute-api', sha256: Sha256 });
    const signed = await signer.sign(new HttpRequest({
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: { host: u.hostname, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
    }));
    const resp = await fetch(u.toString(), { method, headers: signed.headers as Record<string, string>, ...(body ? { body } : {}) });
    const text = await resp.text();
    const response: SignedResponse = {
      ok: () => resp.ok,
      status: () => resp.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
    return response;
  };
  return {
    get: (url, opts) => send('GET', url, undefined, opts?.params),
    post: (url, opts) => send('POST', url, opts?.data ?? {}),
    delete: (url) => send('DELETE', url),
    dispose: async () => { creds = null; },
  };
}
