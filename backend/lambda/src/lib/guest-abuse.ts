/**
 * THE ABUSE CONTROLS ON GUEST START (L16, R12): the kill switch, the per-address limit and the captcha.
 *
 * Guest start is unauthenticated, so these are what stand between an anonymous request and a minted
 * AppInstanceUser, a conversation and a KMS `Sign`. All three run before any of those, and every one of
 * them FAILS CLOSED: a store, a parameter or a verifier that cannot answer refuses the request with
 * `unavailable`, never admits it. There is no bypass token. communication-hub's versions of the same
 * controls failed open (its IP limit and circuit breaker) and carried a bypass token; this is the
 * correction.
 *
 * ── THE PER-ADDRESS LIMIT ────────────────────────────────────────────────────────────────────────
 *
 * Counted per source address: an IPv4 address, or an IPv6 address's /64 prefix (one subscriber is
 * usually handed a whole /64, so counting the full address would let one visitor rotate through 2^64
 * of them). The address is never stored: the key is an HMAC-SHA256 of it under a per-deployment salt
 * (a generated secret), plus the window it counts, and the row expires with its window. One
 * conditional `ADD` counts one start, so the count is exact under concurrency.
 *
 * ── THE REFUSALS ─────────────────────────────────────────────────────────────────────────────────
 *
 * Each is a settled state with a stable code (D-4): `paused` (the kill switch), `rate_limited` (with
 * how long to wait), `captcha_failed`, and `unavailable` (something that decides could not be read).
 * The widget shows each one's localized copy; nothing here writes copy a person reads.
 */
import { createHmac } from 'crypto';
import { isIP } from 'net';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretUnavailable, __resetSecretCacheForTests as resetSharedSecretCache, readCachedSecret } from './secret-cache.js';

type Sender = { send(command: unknown): Promise<any> };

export type GuestRefusalCode = 'paused' | 'rate_limited' | 'captcha_failed' | 'unavailable';

/** A refusal guest start answers with, and the HTTP status it is answered as. */
export class GuestRefused extends Error {
  constructor(readonly code: GuestRefusalCode, readonly detail: string, readonly retryAfterSeconds?: number) {
    super(`${code}: ${detail}`);
    this.name = 'GuestRefused';
  }
}

export const REFUSAL_STATUS: Record<GuestRefusalCode, number> = {
  paused: 503,
  rate_limited: 429,
  captcha_failed: 403,
  unavailable: 503,
};

// ── THE KILL SWITCH ──────────────────────────────────────────────────────────────────────────────

export interface KillSwitchState {
  paused: boolean;
  changedBy?: string;
  changedAt?: string;
  reason?: string;
}

/** How long one read of the kill switch is trusted, so a flood does not become a flood of SSM reads. */
export const KILL_SWITCH_CACHE_MS = 10_000;
let cachedSwitch: { name: string; at: number; state: KillSwitchState } | null = null;

export function __resetKillSwitchCacheForTests(): void {
  cachedSwitch = null;
}

/** The kill switch's state. Throws `GuestRefused('unavailable')` when it cannot be read or understood. */
export async function readKillSwitch(ssm: Sender, name: string, now: number = Date.now()): Promise<KillSwitchState> {
  if (!name) throw new GuestRefused('unavailable', 'no kill switch is configured');
  if (cachedSwitch && cachedSwitch.name === name && now - cachedSwitch.at < KILL_SWITCH_CACHE_MS) return cachedSwitch.state;
  let raw: string | undefined;
  try {
    raw = (await ssm.send(new GetParameterCommand({ Name: name })))?.Parameter?.Value;
  } catch (err) {
    throw new GuestRefused('unavailable', `the kill switch could not be read: ${(err as Error)?.name || 'error'}`);
  }
  let state: KillSwitchState;
  try {
    const parsed = JSON.parse(String(raw ?? '')) as Partial<KillSwitchState>;
    if (!parsed || typeof parsed.paused !== 'boolean') throw new Error('no paused flag');
    state = {
      paused: parsed.paused,
      ...(typeof parsed.changedBy === 'string' ? { changedBy: parsed.changedBy } : {}),
      ...(typeof parsed.changedAt === 'string' ? { changedAt: parsed.changedAt } : {}),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
    };
  } catch {
    // AN UNREADABLE SWITCH IS NOT "OFF": nobody can say it is safe to admit.
    throw new GuestRefused('unavailable', 'the kill switch holds no readable state');
  }
  cachedSwitch = { name, at: now, state };
  return state;
}

/** Refuse with `paused` while the kill switch is on. */
export async function requireNotPaused(ssm: Sender, name: string, now?: number): Promise<void> {
  const state = await readKillSwitch(ssm, name, now);
  if (state.paused) throw new GuestRefused('paused', 'guest start is paused');
}

/** What a per-address row counts: guest starts, or link invitation redemptions. */
export type AddressCount = 'guest-ip' | 'link-ip';

// ── THE PER-ADDRESS LIMIT ────────────────────────────────────────────────────────────────────────

/**
 * What an address is counted as: an IPv4 address, or an IPv6 address's /64 prefix. An IPv4-mapped IPv6
 * address counts as its IPv4 address. Null for anything that is not an address.
 */
export function addressBucket(ip: string | null | undefined): string | null {
  const raw = String(ip ?? '').trim();
  if (isIP(raw) === 4) return `v4:${raw}`;
  if (isIP(raw) !== 6) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped && isIP(mapped[1]) === 4) return `v4:${mapped[1]}`;
  // Expand `::` so the first four groups are the /64, whatever the spelling.
  const [head, tail = ''] = raw.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = raw.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = raw.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length < 4) return null;
  return `v6:${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

/**
 * The limit row's key: the salted hash of the address bucket, and the window it counts. Never the address.
 * `prefix` names what is counted: guest starts (`guest-ip`) or link redemptions (`link-ip`), each its own
 * rows under its own grant.
 */
export function addressKey(salt: string, bucket: string, windowStart: number, prefix: AddressCount = 'guest-ip'): string {
  return `${prefix}#${createHmac('sha256', salt).update(bucket).digest('hex')}#${windowStart}`;
}

/**
 * Count one guest start against this address's window, or refuse. `max: 0` limits nothing, which synth
 * refuses in production. Throws `GuestRefused('rate_limited')` over the limit, and
 * `GuestRefused('unavailable')` when the store cannot answer or the address is unreadable.
 */
export async function countAddressStart(
  doc: Sender,
  input: { table: string; salt: string; ip: string | null | undefined; max: number; windowMinutes: number; now: number; prefix?: AddressCount },
): Promise<void> {
  if (input.max === 0) return;
  const bucket = addressBucket(input.ip);
  if (!bucket) throw new GuestRefused('unavailable', 'the request carries no source address to count');
  if (!input.table || !input.salt) throw new GuestRefused('unavailable', 'the limit store is not configured');
  const windowSeconds = input.windowMinutes * 60;
  const nowSeconds = Math.floor(input.now / 1000);
  const windowStart = nowSeconds - (nowSeconds % windowSeconds);
  const windowEnd = windowStart + windowSeconds;
  try {
    await doc.send(new UpdateCommand({
      TableName: input.table,
      Key: { pk: addressKey(input.salt, bucket, windowStart, input.prefix) },
      UpdateExpression: 'ADD n :one SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(n) OR n < :max',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':max': input.max, ':ttl': windowEnd + 60 },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new GuestRefused('rate_limited', 'this address has started its limit of guest sessions for now', Math.max(1, windowEnd - nowSeconds));
    }
    throw new GuestRefused('unavailable', `the limit store could not be read: ${(err as Error)?.name || 'error'}`);
  }
}

// ── THE CAPTCHA ──────────────────────────────────────────────────────────────────────────────────

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const CAPTCHA_TIMEOUT_MS = 3_000;

type FetchLike = (url: string, init: { method: string; body: URLSearchParams; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Verify a Turnstile response server-side. Refuses `captcha_failed` when the vendor says no (or no
 * response was sent), and `unavailable` when the vendor cannot be reached or answers with no verdict.
 */
export async function verifyCaptcha(input: {
  secret: string;
  response: string | null | undefined;
  remoteIp?: string | null;
  idempotencyKey?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const response = String(input.response ?? '').trim();
  if (!response || response.length > 2048) throw new GuestRefused('captcha_failed', 'no captcha response was sent');
  if (!input.secret) throw new GuestRefused('unavailable', 'no captcha secret is configured');
  const body = new URLSearchParams({ secret: input.secret, response });
  if (input.remoteIp) body.set('remoteip', input.remoteIp);
  if (input.idempotencyKey) body.set('idempotency_key', input.idempotencyKey);
  const doFetch = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let verdict: { success?: unknown };
  try {
    const r = await doFetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? CAPTCHA_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`siteverify answered ${r.status}`);
    verdict = (await r.json()) as { success?: unknown };
  } catch (err) {
    throw new GuestRefused('unavailable', `the captcha verifier could not be reached: ${(err as Error)?.message || 'error'}`);
  }
  if (typeof verdict?.success !== 'boolean') throw new GuestRefused('unavailable', 'the captcha verifier answered with no verdict');
  if (!verdict.success) throw new GuestRefused('captcha_failed', 'the captcha was not solved');
}

// ── SECRETS, BY NAME ─────────────────────────────────────────────────────────────────────────────

export function __resetSecretCacheForTests(): void {
  resetSharedSecretCache();
}

/**
 * A secret's value, from Secrets Manager (`secretId`) or an SSM SecureString (`parameter`), through the
 * shared five-minute cache (`lib/secret-cache.ts`). Throws `GuestRefused('unavailable')` when it cannot be read.
 */
export async function readSecret(
  ref: { secretId?: string; parameter?: string },
  deps: { secrets?: Sender; ssm?: Sender; now?: number },
): Promise<string> {
  try {
    return await readCachedSecret(ref, deps);
  } catch (err) {
    if (!(err instanceof SecretUnavailable)) throw err;
    throw new GuestRefused('unavailable', err.reason === 'unnamed' ? 'no secret is named'
      : err.reason === 'empty' ? 'a secret is empty'
      : `a secret could not be read: ${err.cause || 'error'}`);
  }
}
