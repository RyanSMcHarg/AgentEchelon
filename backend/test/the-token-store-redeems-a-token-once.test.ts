/**
 * THE TOKEN STORE KEEPS ONLY A HASH, AND REDEEMS A SINGLE-USE TOKEN ONCE, IN TIME, ON ITS CHANNEL (A8).
 *
 * `lambda/src/lib/tokens.ts` is the one key scheme and redemption for every token kind. These pin:
 *  - the key is `<kind>#<sha256(token)>`, so no record holds a usable token, and the kind leads every key
 *    (which is what lets IAM scope each writer by `dynamodb:LeadingKeys`, `lib/constructs/token-store.ts`);
 *  - a record's TTL attribute is its expiry plus 7 days: TTL only reclaims space;
 *  - redemption is ONE conditional update, `attribute_not_exists(consumedAt) AND expiresAt > :now`, and a
 *    channel when the kind is bound to one; a refusal is read back once only to say which it was:
 *    a second redemption, an expired token (before TTL has deleted it), or another channel.
 */
import { createHash } from 'crypto';
import {
  RECLAIM_AFTER_SECONDS,
  TOKEN_KINDS,
  newPlatformToken,
  redeemToken,
  tokenKey,
  tokenRecordOf,
} from '../lambda/src/lib/tokens';
import { leadingKeysFor } from '../lib/constructs/token-store';

class CondFail extends Error { name = 'ConditionalCheckFailedException'; }

/** A one-table store that evaluates exactly the redemption condition the library writes. */
function store() {
  const rows = new Map<string, any>();
  const updates: any[] = [];
  const send = jest.fn(async (cmd: any) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'UpdateCommand') {
      updates.push(i);
      const row = rows.get(i.Key.pk);
      const v = i.ExpressionAttributeValues;
      const names = i.ExpressionAttributeNames ?? {};
      const matches = Object.entries(names).filter(([k]) => k.startsWith('#m')).every(([k, field]) => row?.[field as string] === v[`:${k.slice(1)}`]);
      const ok = !!row && row.consumedAt === undefined && row.revokedAt === undefined && row.expiresAt > v[':now']
        && (v[':channel'] === undefined || row.channelArn === v[':channel']) && matches;
      if (!ok) throw new CondFail();
      rows.set(i.Key.pk, { ...row, consumedAt: v[':now'] });
      return { Attributes: rows.get(i.Key.pk) };
    }
    if (cmd.constructor.name === 'GetCommand') return { Item: rows.get(i.Key.pk) };
    throw new Error('unexpected');
  });
  return { send, rows, updates };
}

const CH = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1';
const PERSON = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/p1';

describe('the key and the record', () => {
  it('a platform token is 256 bits, and its key is its kind and its SHA-256, never the token', () => {
    const token = newPlatformToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(tokenKey('guest-refresh', token)).toBe(`guest-refresh#${createHash('sha256').update(token).digest('hex')}`);
    const record = tokenRecordOf('guest-refresh', token, { channelArn: CH, personArn: PERSON, issuer: 'guest', expiresAt: 1000 });
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record).toMatchObject({ kind: 'guest-refresh', redemption: 'single-use', expiresAt: 1000, reclaimAt: 1000 + RECLAIM_AFTER_SECONDS });
    expect(RECLAIM_AFTER_SECONDS).toBe(7 * 86_400);
  });

  it('names every kind the plan does, each with its one writer', () => {
    expect(Object.keys(TOKEN_KINDS).sort()).toEqual(['assertion-jti', 'claim', 'guest-bind', 'guest-family', 'guest-refresh', 'invitation', 'proposal', 'registration', 'reply', 'unsubscribe']);
    // An agent step's proposal (ADR-061 decision 8): written by the processor, applied once by its addressee.
    expect(TOKEN_KINDS.proposal).toEqual({ writer: 'assistant', redemption: 'single-use', built: true });
    expect(TOKEN_KINDS.unsubscribe.redemption).toBe('bounded');
    expect(TOKEN_KINDS.reply.redemption).toBe('bounded');
    expect(() => tokenKey('nope' as never, 'x')).toThrow(/not a token kind/);
    expect(leadingKeysFor(['guest-refresh', 'guest-family'])).toEqual(['guest-refresh#*', 'guest-family#*']);
    expect(() => leadingKeysFor(['nope' as never])).toThrow(/not a token kind/);
  });
});

describe('redemption', () => {
  const put = (s: ReturnType<typeof store>, token: string, expiresAt: number) =>
    s.rows.set(tokenKey('invitation', token), tokenRecordOf('invitation', token, { channelArn: CH, personArn: PERSON, issuer: 'x', expiresAt }));

  it('is one conditional update on consumedAt and expiresAt, and admits the first redemption', async () => {
    const s = store();
    put(s, 't1', 2000);
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000 })).toMatchObject({ ok: true });
    expect(s.updates[0].ConditionExpression).toBe('attribute_exists(pk) AND attribute_not_exists(consumedAt) AND attribute_not_exists(revokedAt) AND expiresAt > :now');
  });

  it('refuses a second redemption', async () => {
    const s = store();
    put(s, 't1', 2000);
    await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000 });
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1001 })).toMatchObject({ ok: false, reason: 'consumed' });
  });

  it('refuses an expired token while its record is still there (TTL has not run)', async () => {
    const s = store();
    put(s, 't1', 1000);
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000 })).toMatchObject({ ok: false, reason: 'expired' });
    expect(s.rows.has(tokenKey('invitation', 't1'))).toBe(true);
  });

  it('refuses a token used against another channel', async () => {
    const s = store();
    put(s, 't1', 2000);
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000, channelArn: `${CH}-other` })).toMatchObject({ ok: false, reason: 'wrong-channel' });
    expect(s.updates[0].ConditionExpression).toContain('channelArn = :channel');
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000, channelArn: CH })).toMatchObject({ ok: true });
  });

  it('refuses a revoked record, whatever else holds (an invitation\'s revocation)', async () => {
    const s = store();
    put(s, 't1', 2000);
    s.rows.set(tokenKey('invitation', 't1'), { ...s.rows.get(tokenKey('invitation', 't1')), revokedAt: 900 });
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000 })).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('refuses a record whose named fields differ (an invitation redeemed in a mode it was not issued for)', async () => {
    const s = store();
    s.rows.set(tokenKey('invitation', 't1'), { ...tokenRecordOf('invitation', 't1', { channelArn: CH, personArn: PERSON, issuer: 'x', expiresAt: 2000 }), mode: 'sign-in' });
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000, match: { mode: 'link' } })).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(s.updates[0].ConditionExpression).toContain('#m0 = :m0');
    expect(await redeemToken(s, 'tokens', 'invitation', 't1', { now: 1000, match: { mode: 'sign-in' } })).toMatchObject({ ok: true });
  });

  it('refuses a token nobody issued, and never under another kind\'s key', async () => {
    const s = store();
    put(s, 't1', 2000);
    expect(await redeemToken(s, 'tokens', 'invitation', 'never-issued', { now: 1000 })).toMatchObject({ ok: false, reason: 'unknown' });
    expect(await redeemToken(s, 'tokens', 'claim', 't1', { now: 1000 })).toMatchObject({ ok: false, reason: 'unknown' });
  });
});
