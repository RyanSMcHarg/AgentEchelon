/**
 * THE OPERATOR'S SIGNED PATH TO THE ADMIN API: a vended credential, then a SigV4-signed call.
 *
 * Lifted out of `admin-task-routes.spec.ts` when a second spec needed the same read. The shape is
 * load-bearing and easy to get subtly wrong - the exchange answers in STS casing, and the authorizer sits
 * on `/exchange-credentials` rather than the API root - and a copy that drifted from it would report a
 * working route as a refused one.
 *
 * Evidence read this way is evidence through the deployed, signed API: the same credential vend and
 * the same authorizer an operator's console goes through, never a direct Lambda invoke with claims
 * the test wrote itself.
 */
import { expect } from '@playwright/test';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { ADMIN_API_URL, adminUrl, personUrl } from './api-urls';

const REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * A console session for the signed-in person: the person exchange first (which mints or resolves the
 * person; the admin exchange never mints), then the admin exchange's console session.
 */
export async function consoleSession(idToken: string): Promise<{ status: number; body: any }> {
  if (!ADMIN_API_URL) return { status: 0, body: { error: 'VITE_ADMIN_API_URL is not set' } };
  const person = await exchange(idToken, {});
  if (person.status !== 200) return person;
  const resp = await fetch(adminUrl('admin-exchange', '/exchange-credentials'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'console' }),
  });
  const text = await resp.text();
  try { return { status: resp.status, body: JSON.parse(text) }; }
  catch { return { status: resp.status, body: { raw: text } }; }
}

/**
 * The exchange answers in the STS casing (`AccessKeyId`), which is what the wire carries; the
 * frontend maps it to the SDK's casing before signing. Both spellings are accepted here for the
 * same reason `redactWith` in the moderation spec accepts both: a signer handed the wrong casing
 * fails with "Resolved credential object is not valid", which reads like a refused vend and is
 * really a field name.
 */
export interface VendedCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
}

function forSigning(creds: VendedCredentials): {
  accessKeyId: string; secretAccessKey: string; sessionToken?: string;
} {
  const accessKeyId = creds.accessKeyId ?? creds.AccessKeyId ?? '';
  const secretAccessKey = creds.secretAccessKey ?? creds.SecretAccessKey ?? '';
  const sessionToken = creds.sessionToken ?? creds.SessionToken;
  expect(accessKeyId && secretAccessKey, 'the vend returned no usable credentials').toBeTruthy();
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** The catalog capability an exchange capability is requested under (admin-capabilities.ts `vends`). */
const ADMIN_VEND_KEY: Record<string, string> = { view: 'view-live-members', 'manage-channel': 'delete-conversation' };

/**
 * POST the credential exchange. Returns `{status, body}` so a REFUSAL is inspectable, not thrown.
 *
 * AN ADMIN-PLANE REQUEST TAKES THE CONSOLE'S PATH (SPEC-ADMIN-CONSOLE FR45, FR51). The Cognito route no
 * longer vends on the admin plane, so a payload naming `identity: 'admin'` is sent the way the console
 * sends it: a console session for the person, then the capability's own IAM-authorized route, signed with
 * that session and carrying a stated reason. A spec keeps asking for what it asked for; the refusals it
 * asserts are now IAM's.
 */
export async function exchange(idToken: string, payload: unknown): Promise<{ status: number; body: any }> {
  const p = (payload ?? {}) as { identity?: string; capabilities?: string[]; channelArn?: string; principalId?: string; reason?: string };
  if (p.identity === 'admin' || p.identity === 'console') {
    const session = await consoleSession(idToken);
    if (p.identity === 'console' || session.status !== 200) return session;
    const caps = p.capabilities?.length ? p.capabilities : ['view'];
    if (caps.length !== 1) return { status: 400, body: { error: 'one admin capability per request' } };
    const key = ADMIN_VEND_KEY[caps[0]] ?? caps[0];
    return signedCall(adminUrl('admin-exchange', `/exchange-credentials/admin/${key}`), session.body.credentials, 'POST', {
      ...(p.channelArn ? { channelArn: p.channelArn } : {}),
      ...(p.principalId ? { principalId: p.principalId } : {}),
      reason: p.reason ?? 'automated end-to-end verification',
    });
  }
  // The Cognito authorizer is on `/exchange-credentials`, not the API root; posting to the root
  // falls through to SigV4 parsing and answers a 403 that reads like an authorization refusal.
  const resp = await fetch(personUrl('/exchange-credentials'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  try { return { status: resp.status, body: JSON.parse(text) }; }
  catch { return { status: resp.status, body: { raw: text } }; }
}

/** SigV4-sign a call to the admin API with EXPLICIT credentials, and return status plus parsed body. */
export async function signedCall(
  url: string,
  creds: VendedCredentials,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const u = new URL(url);
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const signer = new SignatureV4({
    credentials: forSigning(creds),
    region: REGION,
    service: 'execute-api',
    sha256: Sha256,
  });
  const headers: Record<string, string> = { host: u.hostname };
  if (bodyStr !== undefined) headers['content-type'] = 'application/json';
  const signed = await signer.sign(new HttpRequest({
    method,
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams.entries()),
    headers,
    body: bodyStr,
  }));
  const resp = await fetch(u.toString(), {
    method,
    headers: signed.headers as Record<string, string>,
    body: bodyStr,
  });
  const text = await resp.text();
  try { return { status: resp.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: resp.status, body: { raw: text.slice(0, 400) } }; }
}
