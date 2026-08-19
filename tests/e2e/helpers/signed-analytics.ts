/**
 * SigV4-signed POST to the admin analytics API.
 *
 * Under A14 IAM enforcement (`adminIamEnforcement`) the analytics API is AWS_IAM-authorized:
 * a Bearer Cognito JWT is rejected (403) — the admin app SIGNS its requests with the caller's
 * Identity-Pool credentials. This helper mirrors that for the e2e tests: it exchanges the
 * signed-in user's id token for Identity-Pool credentials (via the AWS CLI the tests already
 * use — no extra SDK dependency) and SigV4-signs the request with @smithy/signature-v4.
 *
 * Needs: VITE_IDENTITY_POOL_ID (or IDENTITY_POOL_ID) + VITE_USER_POOL_ID (or USER_POOL_ID) +
 * AWS_PROFILE + AWS_REGION.
 */
import { execSync } from 'child_process';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_PROFILE = process.env.AWS_PROFILE || 'default';

function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, AWS_PROFILE },
  }).trim();
  return out ? JSON.parse(out) : null;
}

/** Identity-Pool credentials for a signed-in user's id token (mirrors the admin app's sign-on). */
function identityPoolCreds(idToken: string): { accessKeyId: string; secretAccessKey: string; sessionToken: string } {
  const pool = process.env.VITE_USER_POOL_ID || process.env.USER_POOL_ID;
  const idPool = process.env.VITE_IDENTITY_POOL_ID || process.env.IDENTITY_POOL_ID;
  if (!pool || !idPool) {
    throw new Error('signed-analytics needs VITE_USER_POOL_ID + VITE_IDENTITY_POOL_ID (or the un-prefixed vars)');
  }
  // A Cognito login map entry: `<provider>=<idToken>`. The provider has no spaces and a JWT has
  // no `=`, so the CLI shorthand parses cleanly with no quoting (Windows-safe).
  const login = `cognito-idp.${REGION}.amazonaws.com/${pool}`;
  const idResp = aws(`cognito-identity get-id --identity-pool-id "${idPool}" --logins ${login}=${idToken}`);
  const identityId = idResp?.IdentityId;
  const credResp = aws(`cognito-identity get-credentials-for-identity --identity-id "${identityId}" --logins ${login}=${idToken}`);
  const c = credResp?.Credentials;
  if (!c?.AccessKeyId) throw new Error('failed to obtain Identity-Pool credentials for signed analytics');
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretKey, sessionToken: c.SessionToken };
}

/**
 * SigV4-signed POST to the IAM-enforced analytics API. Returns parsed JSON (or `{status, text}`
 * on a non-JSON/error body). `idToken` is the caller's Cognito id token (localStorage `idToken`).
 */
export async function signedAnalyticsPost(analyticsUrl: string, idToken: string, body: unknown): Promise<any> {
  const creds = identityPoolCreds(idToken);
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
  const creds = identityPoolCreds(idToken);
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
