/**
 * SIGNED CALLS FOR THE WATCHDOG'S STREAMS: the operator's credentials, a SigV4-signed request, and a
 * presigned WebSocket URL.
 *
 * The streams the watchdog subscribes to (CloudWatch Logs Live Tail, an Amazon Chime SDK messaging
 * session) are long-lived connections the AWS CLI cannot hold for a caller, so they are opened here with
 * the same signer `admin-api.ts` uses. The operator's credentials are the ones every e2e helper already
 * runs the CLI with: the environment's keys when set, else what the CLI resolves for `AWS_PROFILE`
 * (`aws configure export-credentials`), which covers SSO and assumed-role profiles alike.
 */
import { execFileSync } from 'child_process';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';

export const REGION = process.env.AWS_REGION || 'us-east-1';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Epoch ms the credentials stop working, when known. */
  expiresAt?: number;
}

/** A source of credentials, asked again whenever a stream reconnects, so an expiring session is renewed. */
export type CredentialSource = () => Promise<AwsCredentials>;

let operatorCache: AwsCredentials | null = null;

/** Whether this process holds operator credentials at all (the same test `backendErrorCheckEnabled` makes). */
export function operatorCredentialsPresent(): boolean {
  return Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
}

/** The operator's credentials, renewed five minutes before they expire. */
export const operatorCredentials: CredentialSource = async () => {
  if (operatorCache && (!operatorCache.expiresAt || operatorCache.expiresAt - Date.now() > 5 * 60_000)) return operatorCache;
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    operatorCache = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    };
    return operatorCache;
  }
  const out = execFileSync('aws', ['configure', 'export-credentials', '--format', 'process'], {
    encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  const j = JSON.parse(out);
  operatorCache = {
    accessKeyId: j.AccessKeyId,
    secretAccessKey: j.SecretAccessKey,
    ...(j.SessionToken ? { sessionToken: j.SessionToken } : {}),
    ...(j.Expiration ? { expiresAt: Date.parse(j.Expiration) } : {}),
  };
  return operatorCache;
};

/** Credentials in either casing (the exchange answers in STS casing), as a signer takes them. */
export function credentialsFrom(raw: Record<string, any>): AwsCredentials {
  const accessKeyId = raw.accessKeyId ?? raw.AccessKeyId ?? '';
  const secretAccessKey = raw.secretAccessKey ?? raw.SecretAccessKey ?? '';
  const sessionToken = raw.sessionToken ?? raw.SessionToken;
  const exp = raw.expiration ?? raw.Expiration;
  return {
    accessKeyId, secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(exp ? { expiresAt: typeof exp === 'number' ? exp : Date.parse(String(exp)) } : {}),
  };
}

function signer(creds: AwsCredentials, service: string): SignatureV4 {
  const { accessKeyId, secretAccessKey, sessionToken } = creds;
  return new SignatureV4({
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    region: REGION,
    service,
    sha256: Sha256,
  });
}

export interface SignedRequest {
  method: 'GET' | 'POST';
  hostname: string;
  /** The path as it goes on the wire: already URI-encoded where a segment needs it. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

/** Sign a request and return its headers, for a caller that sends it on its own transport. */
export async function signHeaders(creds: AwsCredentials, service: string, req: SignedRequest): Promise<Record<string, string>> {
  const signed = await signer(creds, service).sign(new HttpRequest({
    method: req.method,
    protocol: 'https:',
    hostname: req.hostname,
    path: req.path,
    query: req.query ?? {},
    headers: { host: req.hostname, ...(req.headers ?? {}) },
    ...(req.body !== undefined ? { body: req.body } : {}),
  }));
  return signed.headers as Record<string, string>;
}

/** A signed HTTPS call answering parsed JSON; throws with the status and body on a refusal. */
export async function signedJson(creds: AwsCredentials, service: string, req: SignedRequest): Promise<any> {
  const headers = await signHeaders(creds, service, req);
  const qs = new URLSearchParams(req.query ?? {}).toString();
  const resp = await fetch(`https://${req.hostname}${req.path}${qs ? `?${qs}` : ''}`, {
    method: req.method, headers, ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${service} ${req.method} ${req.path} answered ${resp.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** A presigned `wss://` URL, the way the Amazon Chime SDK client signs its messaging session. */
export async function presignWebSocket(creds: AwsCredentials, service: string, hostname: string, path: string, query: Record<string, string>): Promise<string> {
  const presigned = await signer(creds, service).presign(new HttpRequest({
    method: 'GET',
    protocol: 'wss:',
    hostname,
    path,
    query,
    headers: { host: hostname },
  }), { expiresIn: 10 });
  const qs = Object.entries(presigned.query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `wss://${hostname}${path}?${qs}`;
}
