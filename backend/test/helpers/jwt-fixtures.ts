/**
 * Locally generated signing keys, hand-signed tokens and a stubbed key server, for the edge authorizer's
 * suites. Nothing here reaches the network: every JWKS and discovery read is answered from memory, and
 * each read is counted so a suite can assert how many fetches a check made.
 */
import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import type { Fetcher } from 'aws-jwt-verify/https';

export interface TestKey {
  kid: string;
  alg: 'RS256' | 'ES256';
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** The public key as a JWK, as an issuer publishes it. */
  jwk: Record<string, unknown>;
}

export function rsaKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, alg: 'RS256', privateKey, publicKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

export function ecKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, alg: 'ES256', privateKey, publicKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

const b64url = (v: unknown): string => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** A token signed by `key`. `header` overrides any header field, `alg` and `kid` included. */
export function signToken(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = { alg: key.alg, kid: key.kid, typ: 'JWT', ...header };
  const input = `${b64url(h)}.${b64url(payload)}`;
  const signature = key.alg === 'RS256'
    ? cryptoSign('sha256', Buffer.from(input), key.privateKey)
    : cryptoSign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/** A token whose header and payload are as given, with an arbitrary signature segment. */
export function unsignedToken(header: Record<string, unknown>, payload: Record<string, unknown>, signature = ''): string {
  return `${b64url(header)}.${b64url(payload)}.${signature}`;
}

/**
 * THE KEY-CONFUSION ATTEMPT: an HS256 token whose HMAC secret is the issuer's PUBLIC key, which an
 * attacker holds. A verifier that let the header pick the algorithm would check the HMAC with the same
 * public key and accept it.
 */
export function hmacWithPublicKey(key: TestKey, payload: Record<string, unknown>): string {
  const input = `${b64url({ alg: 'HS256', kid: key.kid, typ: 'JWT' })}.${b64url(payload)}`;
  const secret = key.publicKey.export({ format: 'pem', type: 'spki' });
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

/** A key server in memory: `uri -> document`, with a count of reads per uri. */
export class StubFetcher implements Fetcher {
  readonly reads = new Map<string, number>();
  constructor(readonly documents: Map<string, unknown> = new Map()) {}

  set(uri: string, doc: unknown): this {
    this.documents.set(uri, doc);
    return this;
  }

  readsOf(uri: string): number {
    return this.reads.get(uri) ?? 0;
  }

  async fetch(uri: string): Promise<ArrayBuffer> {
    this.reads.set(uri, this.readsOf(uri) + 1);
    if (!this.documents.has(uri)) throw new Error(`no document at ${uri} (the stub reaches no network)`);
    const bytes = new TextEncoder().encode(JSON.stringify(this.documents.get(uri)));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}

export const jwks = (...keys: TestKey[]): { keys: Record<string, unknown>[] } => ({ keys: keys.map((k) => k.jwk) });

/** Seconds since the epoch, now. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
