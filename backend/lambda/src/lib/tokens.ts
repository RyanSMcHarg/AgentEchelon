/**
 * THE TOKEN STORE (A8): one table for every single-use or bounded token the platform issues or
 * remembers, in `Conversations` (`Tokens`).
 *
 * ── THE KEY ──────────────────────────────────────────────────────────────────────────────────────
 *
 * `pk = <kind>#<sha256(token)>`, hex. The store keeps only the hash, never a usable token: a platform
 * token is 256 bits from a CSPRNG (`newPlatformToken`), handed to its holder once and never readable
 * here again. Putting the kind first is what lets IAM scope each writer to its own kinds: every role's
 * grant carries `dynamodb:LeadingKeys` limited to `<kind>#*` (`TOKEN_KINDS`, and the grant in
 * `conversations-stack.ts`), so the exchange that writes `guest-refresh#...` cannot write an
 * `invitation#...`, and a role with no kind writes nothing.
 *
 * ── THE RECORD ───────────────────────────────────────────────────────────────────────────────────
 *
 * Every record carries `kind`, the channel ARN and AppInstanceUser ARN it is bound to, the `issuer`,
 * its `redemption` mode, `expiresAt` (epoch seconds) and, once used, `consumedAt`. Redemption is one
 * conditional update, `attribute_not_exists(consumedAt) AND expiresAt > :now`, so a second redemption
 * and an expired token are refused by the store itself, before DynamoDB TTL has deleted anything:
 * `reclaimAt` (the TTL attribute, `expiresAt` plus 7 days) only reclaims space, and nothing decides on it.
 *
 * ── THE KINDS ────────────────────────────────────────────────────────────────────────────────────
 *
 * `TOKEN_KINDS` is the one list, with each kind's writer and whether it is built. Every kind is built.
 * One sparse index lists a conversation's invitations (`lib/invitations.ts`); it holds no token.
 *
 * ── A HOST ASSERTION'S `jti` (A9) ────────────────────────────────────────────────────────────────
 *
 * Not a token the platform issues: a replay record of the host's own `jti`, keyed
 * `assertion-jti#<sha256(<issuer id>|<jti>)>` so two hosts' ids never collide. The edge authorizer
 * RECORDS it the first time it verifies the assertion, with a conditional put, and refuses an assertion
 * whose record exists (`recordAssertionJti`); the credential exchange CONSUMES it, with the one conditional
 * update every single-use kind gets, before it vends (`consumeAssertionJti`). The edge's grant is
 * `PutItem` on `assertion-jti#*` alone and the exchange's `UpdateItem` and `GetItem`, so neither layer can
 * do the other's half, and an assertion that reached the exchange without passing the edge has no record
 * to consume.
 */
import { createHash, randomBytes } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

type Sender = { send(command: unknown): Promise<any> };

/** Every token kind, its writer, and how it is redeemed. A kind's records are written by its writer alone. */
export const TOKEN_KINDS = {
  /** A guest's refresh credential (A7): single-use, rotated on every refresh, one family per visit. */
  'guest-refresh': { writer: 'credential-exchange', redemption: 'single-use', built: true },
  /** A guest visit's refresh family: revoked as a whole when a used refresh credential is replayed. */
  'guest-family': { writer: 'credential-exchange', redemption: 'bounded', built: true },
  /**
   * A sign-in hand-off (path A): single-use and short-lived, minted by the guest refresh the widget makes
   * when a visitor signs in. It names the refresh credential that refresh issued and the hash of a secret
   * the widget keeps in the page and hands only to the chat app tab it opened, so a forwarded link binds
   * nothing (`lib/guest-bind.ts`).
   */
  'guest-bind': { writer: 'credential-exchange', redemption: 'single-use', built: true },
  /**
   * A conversation invitation (M-10): single-use, naming the invitee AppInstanceUser minted for it. Written and
   * revoked by `Conversations` (`invitations.ts`); redeemed by the credential exchange, in its declared mode only.
   */
  invitation: { writer: 'conversations', redemption: 'single-use', built: true },
  /** A registration claim (path B, §16.6): single-use, redeemed by a signed-in account (`guest-upgrade.ts`). */
  claim: { writer: 'conversations', redemption: 'single-use', built: true },
  /**
   * A visitor's registration record (path B): not a token but the record a claim names, keyed by the
   * hash of the visitor's conversation ARN, so one conversation has one registration. Kept 30 days.
   */
  registration: { writer: 'conversations', redemption: 'bounded', built: true },
  /** An email reply token (M-8): bounded, never single-use, bound to (channel, person, notice). */
  reply: { writer: 'notifications', redemption: 'bounded', built: true },
  /** An email's unsubscribe and preference link (B9): bounded, names the person and the notice kind. */
  unsubscribe: { writer: 'notifications', redemption: 'bounded', built: true },
  /**
   * An agent step's proposal (ADR-061 decision 8, rule 8): single-use and expiring, bound to its conversation and to the
   * one person it is addressed to (`personArn`). Written on the assistant's session when its step drafts it, and
   * applied or declined once by the apply endpoint (`proposals-api.ts`), for that person alone.
   */
  proposal: { writer: 'assistant', redemption: 'single-use', built: true },
  /** A host assertion's `jti`, remembered to refuse its replay (A9): recorded by the edge, consumed by the exchange. */
  'assertion-jti': { writer: 'edge-authorizer', redemption: 'single-use', built: true },
} as const;
export type TokenKind = keyof typeof TOKEN_KINDS;

/** How long a record outlives its expiry before DynamoDB TTL reclaims it. Nothing decides on this. */
export const RECLAIM_AFTER_SECONDS = 7 * 86_400;

/** A fresh platform token: 256 bits from the CSPRNG, base64url. Shown to its holder once. */
export function newPlatformToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * A fresh platform token that survives a mail system: 256 bits from the CSPRNG, lowercase base32 with no
 * padding (52 characters). An address's local part is case-insensitive in practice, so a token carried in
 * one (`reply+<token>@...`) must not depend on case the way base64url does.
 */
export function newCaseFreeToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of randomBytes(32)) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The record key for a token of a kind: `<kind>#<sha256(token)>`. */
export function tokenKey(kind: TokenKind, token: string): string {
  if (!TOKEN_KINDS[kind]) throw new Error(`tokens: "${String(kind)}" is not a token kind`);
  if (!token) throw new Error('tokens: a token is required');
  return `${kind}#${sha256Hex(token)}`;
}

export interface TokenRecord {
  pk: string;
  kind: TokenKind;
  /** The conversation the token is bound to. */
  channelArn: string;
  /** The AppInstanceUser it is bound to. */
  personArn: string;
  /** The registry id of the issuer it belongs to. */
  issuer: string;
  redemption: 'single-use' | 'bounded';
  /** Epoch seconds. A record at or past it is refused. */
  expiresAt: number;
  /** Epoch seconds: the DynamoDB TTL attribute, `expiresAt` plus `RECLAIM_AFTER_SECONDS`. */
  reclaimAt: number;
  createdAt: string;
  /** Epoch seconds, set by the one redemption a single-use token gets. */
  consumedAt?: number;
  [field: string]: unknown;
}

/** The record for a new token. Pure, so the shape is testable without a table. */
/** What a caller supplies for a new record: the binding, the expiry, and any kind-specific fields. */
export interface NewTokenFields {
  channelArn: string;
  personArn: string;
  issuer: string;
  expiresAt: number;
  createdAt?: string;
  [field: string]: unknown;
}

export function tokenRecordOf(kind: TokenKind, token: string, fields: NewTokenFields): TokenRecord {
  return {
    ...fields,
    pk: tokenKey(kind, token),
    kind,
    redemption: TOKEN_KINDS[kind].redemption,
    reclaimAt: fields.expiresAt + RECLAIM_AFTER_SECONDS,
    createdAt: fields.createdAt ?? new Date().toISOString(),
  };
}

/** Write a new record. Refused when one already holds the key, which for a 256-bit token never happens. */
export async function putToken(doc: Sender, table: string, record: TokenRecord): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: record, ConditionExpression: 'attribute_not_exists(pk)' }));
}

/** Why a redemption was refused. */
export type RedemptionRefusal = 'unknown' | 'consumed' | 'expired' | 'wrong-channel' | 'revoked' | 'mismatch';

export type Redemption =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: RedemptionRefusal; record?: TokenRecord };

/**
 * REDEEM A SINGLE-USE TOKEN: one conditional update sets `consumedAt`, refused when the record is
 * missing, already consumed, at or past its expiry, or bound to another conversation than `channelArn`
 * (when given). `extra` is written in the same update (a reuse window, for example). `match` names fields
 * the record must hold exactly (an invitation's redemption mode), and a record carrying `revokedAt` is
 * refused too. On a refusal the record is read once, consistently, only to say which of those it was.
 */
export async function redeemToken(
  doc: Sender,
  table: string,
  kind: TokenKind,
  token: string,
  opts: { now: number; channelArn?: string; extra?: Record<string, unknown>; match?: Record<string, string> },
): Promise<Redemption> {
  return redeemTokenKey(doc, table, tokenKey(kind, token), opts);
}

/**
 * REDEEM A RECORD BY ITS KEY, the same one conditional update: for a token presented through an alias that names the
 * record it stands for (a reminded invitation's second link, `lib/invitations.ts`), so the one record is spent.
 */
export async function redeemTokenKey(
  doc: Sender,
  table: string,
  pk: string,
  opts: { now: number; channelArn?: string; extra?: Record<string, unknown>; match?: Record<string, string> },
): Promise<Redemption> {
  const extra = opts.extra ?? {};
  const match = opts.match ?? {};
  const sets = ['consumedAt = :now', ...Object.keys(extra).map((k, i) => `#x${i} = :x${i}`)];
  const names: Record<string, string> = {
    ...Object.fromEntries(Object.keys(extra).map((k, i) => [`#x${i}`, k])),
    ...Object.fromEntries(Object.keys(match).map((k, i) => [`#m${i}`, k])),
  };
  const values: Record<string, unknown> = {
    ':now': opts.now,
    ...Object.fromEntries(Object.values(extra).map((v, i) => [`:x${i}`, v])),
    ...Object.fromEntries(Object.values(match).map((v, i) => [`:m${i}`, v])),
  };
  let condition = 'attribute_exists(pk) AND attribute_not_exists(consumedAt) AND attribute_not_exists(revokedAt) AND expiresAt > :now';
  for (let i = 0; i < Object.keys(match).length; i++) condition += ` AND #m${i} = :m${i}`;
  if (opts.channelArn !== undefined) {
    condition += ' AND channelArn = :channel';
    values[':channel'] = opts.channelArn;
  }
  try {
    const r = await doc.send(new UpdateCommand({
      TableName: table,
      Key: { pk },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: condition,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return { ok: true, record: r.Attributes as TokenRecord };
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  const record = (await doc.send(new GetCommand({ TableName: table, Key: { pk }, ConsistentRead: true })))?.Item as TokenRecord | undefined;
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.consumedAt !== undefined) return { ok: false, reason: 'consumed', record };
  if (record.revokedAt !== undefined) return { ok: false, reason: 'revoked', record };
  if (record.expiresAt <= opts.now) return { ok: false, reason: 'expired', record };
  if (Object.entries(match).some(([k, v]) => record[k] !== v)) return { ok: false, reason: 'mismatch', record };
  return { ok: false, reason: 'wrong-channel', record };
}

// ── A HOST ASSERTION'S `jti` ─────────────────────────────────────────────────────────────────────

/** The value an assertion's record is keyed on: the issuer and the host's `jti`, so two hosts never collide. */
export const assertionJtiValue = (issuerId: string, jti: string): string => `${issuerId}|${jti}`;

/**
 * THE EDGE'S HALF: record an assertion's `jti` the first time it is verified. False when a record already
 * holds it: the assertion was presented before, and is refused. The record expires with the assertion
 * (`exp`, plus the clock skew the edge allows).
 */
export async function recordAssertionJti(
  doc: Sender,
  table: string,
  input: { issuerId: string; jti: string; expiresAt: number; now?: Date },
): Promise<boolean> {
  const record = tokenRecordOf('assertion-jti', assertionJtiValue(input.issuerId, input.jti), {
    channelArn: '',
    personArn: '',
    issuer: input.issuerId,
    expiresAt: input.expiresAt,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  try {
    await putToken(doc, table, record);
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * THE EXCHANGE'S HALF: consume the record the edge wrote, once, before anything is vended. Refused when
 * there is no record (the assertion did not pass the edge), when it was already consumed, and when it has
 * expired.
 */
export function consumeAssertionJti(doc: Sender, table: string, input: { issuerId: string; jti: string; now: number }): Promise<Redemption> {
  return redeemToken(doc, table, 'assertion-jti', assertionJtiValue(input.issuerId, input.jti), { now: input.now });
}

/**
 * PRESENT A BOUNDED TOKEN (`reply`, `unsubscribe`): it is accepted as often as it is presented until it
 * expires, so nothing is consumed. Refused when there is no record, when the record is of another kind,
 * and when it is at or past its expiry, whether or not TTL has reclaimed it.
 */
export async function presentBoundedToken(
  doc: Sender,
  table: string,
  kind: TokenKind,
  token: string,
  now: number,
): Promise<Redemption> {
  if (TOKEN_KINDS[kind].redemption !== 'bounded') throw new Error(`tokens: "${kind}" is single-use; redeem it`);
  const record = await readTokenRecord(doc, table, tokenKey(kind, token));
  if (!record || record.kind !== kind) return { ok: false, reason: 'unknown' };
  if (record.consumedAt !== undefined) return { ok: false, reason: 'consumed', record };
  if (!(record.expiresAt > now)) return { ok: false, reason: 'expired', record };
  return { ok: true, record };
}

/** Read one record by its key, consistently. */
export async function readTokenRecord(doc: Sender, table: string, pk: string): Promise<TokenRecord | null> {
  return ((await doc.send(new GetCommand({ TableName: table, Key: { pk }, ConsistentRead: true })))?.Item as TokenRecord | undefined) ?? null;
}
