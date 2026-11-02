/**
 * THE GUEST TOKEN: a short-lived ES256 JWT this deployment signs for an anonymous visitor (A7).
 *
 * The platform is the issuer. Guest start signs one after the captcha, the per-address limit and the
 * kill switch have passed (`lambda/src/guest-session.ts`), and the edge authorizer verifies it like any
 * other issuer's token (`lib/token-verification.ts`). The private key never leaves AWS KMS: signing is a
 * KMS `Sign` call on an `ECC_NIST_P256` `SIGN_VERIFY` key, and verifying reads the public key once per
 * key generation with `GetPublicKey`.
 *
 * ── WHAT IT SAYS ─────────────────────────────────────────────────────────────────────────────────
 *
 * Header `{ alg: 'ES256', typ: 'JWT', kid }`, where `kid` is the key generation (`g1`, `g2`, ...).
 * Claims: `iss` (this deployment's guest issuer URI, `guestIssuerUri`), `aud` (the deployment id), `sub`
 * (the subject guest start minted the visitor under), `ch` (the id of the visitor's one conversation),
 * `token_use: 'guest'`, `iat`, `nbf`, `exp` and a `jti`. It is a bearer for minutes
 * (`tokenMinutes`, at most `GUEST_TOKEN_MAX_MINUTES`); the visitor keeps their session by rotating the
 * refresh credential, never by holding this.
 *
 * ── THE SIGNATURE FORMAT ─────────────────────────────────────────────────────────────────────────
 *
 * KMS returns an ECDSA signature DER-encoded (an ASN.1 SEQUENCE of two INTEGERs). A JWS carries the
 * raw `r || s`, 32 bytes each (RFC 7518 §3.4), so the one is converted to the other here, and a
 * signature that is not a well-formed P-256 DER signature is refused rather than truncated.
 */
import { createPublicKey, randomUUID, type KeyObject } from 'crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';

type Sender = { send(command: unknown): Promise<any> };

let defaultKms: Sender | null = null;
const kmsOf = (k?: Sender): Sender => k ?? (defaultKms ??= new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' }));

export const GUEST_TOKEN_USE = 'guest';

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** A DER ECDSA signature as the 64-byte `r || s` a JWS carries. Throws on anything else. */
export function derToJose(der: Uint8Array): Buffer {
  const b = Buffer.from(der);
  let i = 0;
  const fail = (why: string): never => { throw new Error(`guest-token: not a P-256 DER signature (${why})`); };
  if (b[i++] !== 0x30) fail('no sequence');
  let seqLen = b[i++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n !== 1) fail('sequence length');
    seqLen = b[i++];
  }
  if (seqLen !== b.length - i) fail('sequence length');
  const int = (): Buffer => {
    if (b[i++] !== 0x02) fail('no integer');
    const len = b[i++];
    if (!len || len > 33 || i + len > b.length) fail('integer length');
    let v = b.subarray(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) fail('integer too long');
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  const r = int();
  const s = int();
  if (i !== b.length) fail('trailing bytes');
  return Buffer.concat([r, s]);
}

export interface GuestClaims {
  iss: string;
  aud: string;
  sub: string;
  /** The id of the visitor's one conversation (the last segment of its channel ARN). */
  ch: string;
  token_use: typeof GUEST_TOKEN_USE;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export interface SignGuestTokenInput {
  keyArn: string;
  kid: string;
  iss: string;
  aud: string;
  sub: string;
  ch: string;
  ttlSeconds: number;
}

/** Sign a guest token with the KMS key. Returns the compact JWS and its claims. */
export async function signGuestToken(
  input: SignGuestTokenInput,
  deps: { kms?: Sender; now?: () => number } = {},
): Promise<{ token: string; claims: GuestClaims }> {
  const iat = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const claims: GuestClaims = {
    iss: input.iss, aud: input.aud, sub: input.sub, ch: input.ch, token_use: GUEST_TOKEN_USE,
    iat, nbf: iat, exp: iat + input.ttlSeconds, jti: randomUUID(),
  };
  const header = { alg: 'ES256', typ: 'JWT', kid: input.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signed = await kmsOf(deps.kms).send(new SignCommand({
    KeyId: input.keyArn,
    Message: Buffer.from(signingInput),
    MessageType: 'RAW',
    SigningAlgorithm: 'ECDSA_SHA_256',
  }));
  if (!signed?.Signature) throw new Error('guest-token: KMS returned no signature');
  return { token: `${signingInput}.${b64url(derToJose(signed.Signature))}`, claims };
}

// ── VERIFYING ────────────────────────────────────────────────────────────────────────────────────

const publicKeys = new Map<string, Promise<KeyObject>>();

/** Forget every cached public key. For tests. */
export function clearGuestKeyCache(): void {
  publicKeys.clear();
}

/** The public key of one KMS key, read once per container. A failed read is not remembered. */
export function guestPublicKey(keyArn: string, deps: { kms?: Sender } = {}): Promise<KeyObject> {
  let pending = publicKeys.get(keyArn);
  if (!pending) {
    pending = (async () => {
      const r = await kmsOf(deps.kms).send(new GetPublicKeyCommand({ KeyId: keyArn }));
      if (!r?.PublicKey || r.KeySpec !== 'ECC_NIST_P256' || r.KeyUsage !== 'SIGN_VERIFY') {
        throw new Error('guest-token: the signing key is not an ECC_NIST_P256 SIGN_VERIFY key');
      }
      return createPublicKey({ key: Buffer.from(r.PublicKey), format: 'der', type: 'spki' });
    })();
    pending.catch(() => publicKeys.delete(keyArn));
    publicKeys.set(keyArn, pending);
  }
  return pending;
}

