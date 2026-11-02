/**
 * GUEST START AND GUEST REFRESH FAIL CLOSED, IN ORDER, AND ROTATE ONE FAMILY PER VISIT (A7, L16, R12).
 *
 * The handlers (`lambda/src/guest-session.ts`) are driven with every dependency in memory: the token and
 * limit stores (a small table that honours the conditions the handlers write), the kill switch, the
 * captcha verifier, the minter, the creator, STS and a KMS whose key is a P-256 pair made here. So each
 * refusal is asserted with what did NOT happen after it: nothing minted, created or signed once a control
 * refuses, and every control that cannot answer refuses with `unavailable` rather than admitting.
 *
 * The live half is `scripts/deny-test-guest.mjs`, against a deployed instance.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'crypto';

process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst';
process.env.ALLOWED_ORIGIN = 'https://app.example.com';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const session = require('../lambda/src/guest-session') as typeof import('../lambda/src/guest-session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const abuse = require('../lambda/src/lib/guest-abuse') as typeof import('../lambda/src/lib/guest-abuse');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guestToken = require('../lambda/src/lib/guest-token') as typeof import('../lambda/src/lib/guest-token');
import { guestSettingsOf } from '../lib/config/issuers';

const APP = process.env.APP_INSTANCE_ARN!;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

// ── THE STORES, IN MEMORY ────────────────────────────────────────────────────────────────────────

class CondFail extends Error { name = 'ConditionalCheckFailedException'; }

function memoryDoc(opts: { failAbuse?: boolean } = {}) {
  const tables = new Map<string, Map<string, any>>();
  const t = (n: string) => { if (!tables.has(n)) tables.set(n, new Map()); return tables.get(n)!; };
  const calls: string[] = [];
  const send = jest.fn(async (cmd: any) => {
    const kind = cmd.constructor.name as string;
    const i = cmd.input;
    calls.push(`${kind}:${i.TableName}`);
    const table = t(i.TableName);
    if (kind === 'PutCommand') {
      if (i.ConditionExpression?.includes('attribute_not_exists') && table.has(i.Item.pk)) throw new CondFail();
      table.set(i.Item.pk, { ...i.Item });
      return {};
    }
    if (kind === 'GetCommand') return { Item: table.get(i.Key.pk) ? { ...table.get(i.Key.pk) } : undefined };
    if (kind === 'UpdateCommand') {
      const v = i.ExpressionAttributeValues;
      const row = table.get(i.Key.pk);
      if (i.UpdateExpression.startsWith('ADD n')) {
        if (opts.failAbuse) throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
        const n = row?.n ?? 0;
        if (n >= v[':max']) throw new CondFail();
        table.set(i.Key.pk, { pk: i.Key.pk, n: n + 1, ttl: v[':ttl'] });
        return {};
      }
      if (i.UpdateExpression.startsWith('SET consumedAt')) {
        if (!row || row.consumedAt !== undefined || !(row.expiresAt > v[':now'])) throw new CondFail();
        if (v[':channel'] !== undefined && row.channelArn !== v[':channel']) throw new CondFail();
        const next = { ...row, consumedAt: v[':now'] };
        for (const [k, name] of Object.entries(i.ExpressionAttributeNames ?? {})) next[name as string] = v[`:${k.slice(1)}`];
        table.set(i.Key.pk, next);
        return { Attributes: { ...next } };
      }
      if (i.UpdateExpression.startsWith('ADD reuses')) {
        if (!row || !(row.graceUntil >= v[':now']) || (row.reuses ?? 0) >= v[':limit']) throw new CondFail();
        table.set(i.Key.pk, { ...row, reuses: (row.reuses ?? 0) + 1 });
        return {};
      }
      if (i.UpdateExpression.startsWith('SET #s')) {
        if (!row) throw new CondFail();
        table.set(i.Key.pk, { ...row, status: v[':revoked'], revokedAt: v[':now'] });
        return {};
      }
    }
    throw new Error(`the memory table does not answer ${kind} ${JSON.stringify(i)}`);
  });
  return { send, tables, calls, table: t };
}

// ── KMS, WITH A KEY MADE HERE ────────────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
function memoryKms(opts: { throttle?: boolean } = {}) {
  return {
    send: jest.fn(async (cmd: any) => {
      if (cmd.constructor.name === 'SignCommand') {
        if (opts.throttle) throw Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' });
        return { Signature: signBytes('sha256', Buffer.from(cmd.input.Message), privateKey) };
      }
      if (cmd.constructor.name === 'GetPublicKeyCommand') {
        return { PublicKey: publicKey.export({ format: 'der', type: 'spki' }), KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' };
      }
      throw new Error('unexpected KMS call');
    }),
  };
}

// ── THE WORLD ────────────────────────────────────────────────────────────────────────────────────

const CONFIG = (over: Partial<ReturnType<typeof guestSettingsOf>> = {}): import('../lambda/src/guest-session').GuestConfig => ({
  issuerId: 'guest',
  classification: 'guest',
  issuerUri: 'urn:agentechelon:test:issuer:guest',
  deploymentId: 'test',
  settings: { ...guestSettingsOf({}), ...over },
  signingKeyArn: 'arn:aws:kms:us-east-1:111122223333:key/g1',
  signingKid: 'g1',
  killSwitchParameter: '/test/guest/guest/paused',
  addressSaltSecret: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:salt',
  guestRoleArn: 'arn:aws:iam::111122223333:role/guest-session',
  tokensTableParameter: '/test/shared/tables/tokens-name',
  abuseTableParameter: '/test/shared/tables/abuse-controls-name',
  creatorParameter: '/test/shared/guest-conversation-creator-arn',
  environment: 'dev',
});

function world(opts: {
  paused?: boolean | 'unreadable' | 'throws';
  captcha?: 'pass' | 'fail' | 'unreachable';
  failAbuse?: boolean;
  throttle?: boolean;
  config?: ReturnType<typeof CONFIG>;
} = {}) {
  let now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const doc = memoryDoc({ failAbuse: opts.failAbuse });
  const kms = memoryKms({ throttle: opts.throttle });
  const ssm = {
    send: jest.fn(async (cmd: any) => {
      const name = cmd.input.Name;
      if (name === '/test/guest/guest/paused') {
        if (opts.paused === 'throws') throw Object.assign(new Error('down'), { name: 'InternalServerError' });
        if (opts.paused === 'unreadable') return { Parameter: { Value: 'not json' } };
        return { Parameter: { Value: JSON.stringify({ paused: opts.paused === true, changedBy: 'test' }) } };
      }
      if (name === '/test/shared/tables/tokens-name') return { Parameter: { Value: 'tokens' } };
      if (name === '/test/shared/tables/abuse-controls-name') return { Parameter: { Value: 'abuse' } };
      if (name === '/test/shared/guest-conversation-creator-arn') return { Parameter: { Value: 'arn:aws:lambda:us-east-1:111122223333:function:creator' } };
      throw new Error(`unexpected parameter ${name}`);
    }),
  };
  const secrets = { send: jest.fn(async () => ({ SecretString: 'salt-for-the-test' })) };
  let channel = 0;
  const lambda = {
    send: jest.fn(async (cmd: any) => {
      const req = JSON.parse(new TextDecoder().decode(cmd.input.Payload));
      channel += 1;
      return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, channelArn: `${APP}/channel/guest-visitor-${channel}`, channelId: `guest-visitor-${channel}`, req })) };
    }),
  };
  const sts = { send: jest.fn(async (_cmd: any) => ({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST', Expiration: new Date(now + 900_000) } })) };
  const chime = { send: jest.fn(async (_cmd: any) => ({})) };
  const fetch = jest.fn(async () => {
    if (opts.captcha === 'unreachable') throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ success: opts.captcha !== 'fail' }) };
  });
  let minted = 0;
  const mint = jest.fn(async () => {
    minted += 1;
    const personId = `0190a000-0000-7000-8000-00000000000${minted}`;
    return { personId, personArn: `${APP}/user/${personId}`, created: true };
  });
  const people = new Map<string, string>();
  const identityState = jest.fn(async (_issuer: string, subject: string) => {
    const arn = people.get(subject);
    return arn ? { state: 'active' as const, personArn: arn } : { state: 'refused' as const, status: 'revoked' };
  });
  const audit = jest.fn(async () => ({}) as never);
  const alert = jest.fn(async () => true);
  const tag = jest.fn(async () => undefined);
  // The funnel's archive (B12), in memory.
  const funnel = jest.fn(async (_e: { eventType: string; personId: string; properties: Record<string, unknown> }) => undefined);
  const deps = {
    config: opts.config ?? CONFIG(), doc, ssm, secrets, lambda, sts, chime, kms, fetch, mint, identityState, audit, alert, tag, funnel,
    now: () => now,
  };
  return { deps, doc, kms, ssm, lambda, sts, chime, fetch, mint, audit, alert, funnel, people, advance: (s: number) => { now += s * 1000; } };
}

const startEvent = (ip = '203.0.113.7', body: Record<string, unknown> = { captchaToken: 'XXXX.DUMMY.TOKEN.XXXX', noticeVersion: 'sample-1' }) => ({
  resource: '/guest/start', httpMethod: 'POST', headers: {}, body: JSON.stringify(body), requestContext: { identity: { sourceIp: ip } },
});
const refreshEvent = (refreshToken: string) => ({
  resource: '/guest/refresh', httpMethod: 'POST', headers: {}, body: JSON.stringify({ refreshToken }), requestContext: { identity: { sourceIp: '203.0.113.7' } },
});
const json = (r: { body: string }) => JSON.parse(r.body);
const signs = (kms: { send: jest.Mock }) => kms.send.mock.calls.filter(([c]) => c.constructor.name === 'SignCommand').length;

beforeEach(() => {
  abuse.__resetKillSwitchCacheForTests();
  abuse.__resetSecretCacheForTests();
  session.__resetGuestSessionCachesForTests();
  guestToken.clearGuestKeyCache();
});

/** Nothing past the controls ran: no visitor, no conversation, no signature, no session. */
function nothingMinted(w: ReturnType<typeof world>) {
  expect(w.mint).not.toHaveBeenCalled();
  expect(w.lambda.send).not.toHaveBeenCalled();
  expect(signs(w.kms)).toBe(0);
  expect(w.sts.send).not.toHaveBeenCalled();
}

describe('guest start runs every control before it mints or signs anything, and each fails closed', () => {
  it('admits a visitor: minted with an expiration, the notice recorded, one conversation, a signed token and a hashed refresh credential', async () => {
    const w = world();
    const r = await session.guestStart(startEvent(), w.deps);
    expect(r.statusCode).toBe(200);
    const out = json(r);
    // The visitor expires a day after creation.
    expect(w.chime.send.mock.calls[0][0].input).toEqual({
      AppInstanceUserArn: out.userArn, ExpirationSettings: { ExpirationDays: 1, ExpirationCriterion: 'CREATED_TIMESTAMP' },
    });
    // The notice shown is recorded, keyed by the visitor.
    expect(w.audit).toHaveBeenCalledWith(expect.objectContaining({ _auditEvent: 'guest_notice_shown', personArn: out.userArn, noticeVersion: 'sample-1' }));
    // The guest classification's creator opens the conversation, for this visitor.
    expect(JSON.parse(new TextDecoder().decode(w.lambda.send.mock.calls[0][0].input.Payload))).toEqual({ kind: 'guest', classification: 'guest', userArn: out.userArn });
    // The token verifies under the key, names the conversation and lives minutes.
    const [h, p] = out.guestToken.split('.').slice(0, 2).map((s: string) => JSON.parse(Buffer.from(s, 'base64url').toString()));
    expect(h).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'g1' });
    expect(p).toMatchObject({ iss: 'urn:agentechelon:test:issuer:guest', aud: 'test', ch: 'guest-visitor-1', token_use: 'guest' });
    expect(p.exp - p.iat).toBe(600);
    const [head64, body64, sig64] = out.guestToken.split('.');
    expect(verifyBytes('sha256', Buffer.from(`${head64}.${body64}`), { key: createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig64, 'base64url'))).toBe(true);
    // The store holds the hash of the refresh credential, never the credential.
    const tokens = w.doc.table('tokens');
    expect(tokens.has(`guest-refresh#${sha(out.refreshToken)}`)).toBe(true);
    expect(JSON.stringify([...tokens.values()])).not.toContain(out.refreshToken);
    // The first session is on the guest-session role, tagged with the visitor and their one conversation.
    const assume = w.sts.send.mock.calls[0][0].input;
    expect(assume.RoleArn).toBe('arn:aws:iam::111122223333:role/guest-session');
    expect(assume.Tags).toEqual([
      { Key: 'person', Value: out.userArn.split('/user/')[1] },
      { Key: 'classification', Value: 'guest' },
      { Key: 'channel', Value: 'guest-visitor-1' },
    ]);
    expect(JSON.parse(assume.Policy).Statement[1].Resource).toEqual([out.channelArn, out.userArn]);
    expect(JSON.parse(assume.Policy).Statement[1].Action).not.toEqual(expect.arrayContaining(['chime:CreateChannel', 'chime:CreateChannelMembership']));
  });

  it('paused: refused with `paused`, before the limit, the captcha or anything else', async () => {
    const w = world({ paused: true });
    const r = await session.guestStart(startEvent(), w.deps);
    expect([r.statusCode, json(r).code]).toEqual([503, 'paused']);
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.doc.calls.filter((c) => c.startsWith('UpdateCommand'))).toEqual([]);
    nothingMinted(w);
    expect(w.alert).not.toHaveBeenCalled();
  });

  it.each([['unreadable' as const], ['throws' as const]])('a kill switch that is %s: refused with `unavailable`, and an alert is raised', async (paused) => {
    const w = world({ paused });
    const r = await session.guestStart(startEvent(), w.deps);
    expect([r.statusCode, json(r).code]).toEqual([503, 'unavailable']);
    expect(w.fetch).not.toHaveBeenCalled();
    nothingMinted(w);
    expect(w.alert).toHaveBeenCalledWith(expect.objectContaining({ messageType: 'guest-unavailable' }));
  });

  it('a burst from one address: refused with `rate_limited` and when to retry, and nothing signed for it', async () => {
    const w = world({ config: CONFIG({ perIpLimit: { max: 2, windowMinutes: 60 } }) });
    expect((await session.guestStart(startEvent(), w.deps)).statusCode).toBe(200);
    expect((await session.guestStart(startEvent(), w.deps)).statusCode).toBe(200);
    const r = await session.guestStart(startEvent(), w.deps);
    expect([r.statusCode, json(r).code]).toEqual([429, 'rate_limited']);
    expect(json(r).retryAfterSeconds).toBeGreaterThan(0);
    expect(r.headers?.['Retry-After']).toBe(String(json(r).retryAfterSeconds));
    expect(signs(w.kms)).toBe(2);
    expect(w.mint).toHaveBeenCalledTimes(2);
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it('counts an IPv6 address by its /64, and stores a salted hash, never the address', async () => {
    const w = world({ config: CONFIG({ perIpLimit: { max: 1, windowMinutes: 60 } }) });
    expect((await session.guestStart(startEvent('2001:db8:abcd:12::1'), w.deps)).statusCode).toBe(200);
    expect(json(await session.guestStart(startEvent('2001:db8:abcd:12:ffff::9'), w.deps)).code).toBe('rate_limited');
    expect((await session.guestStart(startEvent('2001:db8:abcd:13::1'), w.deps)).statusCode).toBe(200);
    const keys = [...w.doc.table('abuse').keys()];
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k).toMatch(/^guest-ip#[0-9a-f]{64}#\d+$/);
      expect(k).not.toContain('2001');
    }
    expect(abuse.addressBucket('2001:0db8:abcd:0012:0000:0000:0000:0001')).toBe(abuse.addressBucket('2001:db8:abcd:12::99'));
    expect(abuse.addressBucket('::ffff:198.51.100.4')).toBe(abuse.addressBucket('198.51.100.4'));
    expect(abuse.addressBucket('not an address')).toBeNull();
  });

  it('a limit store that cannot answer: refused with `unavailable`, nothing signed', async () => {
    const w = world({ failAbuse: true });
    const r = await session.guestStart(startEvent(), w.deps);
    expect([r.statusCode, json(r).code]).toEqual([503, 'unavailable']);
    expect(w.fetch).not.toHaveBeenCalled();
    nothingMinted(w);
  });

  it('a request with no source address to count: refused with `unavailable`', async () => {
    const w = world();
    const r = await session.guestStart({ ...startEvent(), requestContext: {} }, w.deps);
    expect([r.statusCode, json(r).code]).toEqual([503, 'unavailable']);
    nothingMinted(w);
  });

  it('a captcha the vendor refuses: `captcha_failed`; a vendor that cannot be reached: `unavailable`; and nothing signed for either', async () => {
    const failed = world({ captcha: 'fail' });
    const r1 = await session.guestStart(startEvent(), failed.deps);
    expect([r1.statusCode, json(r1).code]).toEqual([403, 'captcha_failed']);
    nothingMinted(failed);
    const down = world({ captcha: 'unreachable' });
    const r2 = await session.guestStart(startEvent(), down.deps);
    expect([r2.statusCode, json(r2).code]).toEqual([503, 'unavailable']);
    nothingMinted(down);
    const none = world();
    const r3 = await session.guestStart(startEvent(undefined, { noticeVersion: 'sample-1' }), none.deps);
    expect([r3.statusCode, json(r3).code]).toEqual([403, 'captcha_failed']);
    expect(none.fetch).not.toHaveBeenCalled();
    nothingMinted(none);
  });

  it('a notice version other than the declared one is refused before any control runs', async () => {
    const w = world();
    const r = await session.guestStart(startEvent(undefined, { captchaToken: 'x', noticeVersion: 'old-1' }), w.deps);
    expect([r.statusCode, json(r).code]).toEqual([400, 'invalid_request']);
    expect(w.ssm.send).not.toHaveBeenCalled();
    nothingMinted(w);
  });

  it('a production configuration with no captcha secret refuses rather than using the test keys', async () => {
    const w = world({ config: { ...CONFIG(), environment: 'production' } });
    const r = await session.guestStart(startEvent(), w.deps);
    expect(json(r).code).toBe('unavailable');
    expect(w.fetch).not.toHaveBeenCalled();
    nothingMinted(w);
  });

  it('a throttled KMS Sign: refused with `unavailable`, and counted for the throttle alarm', async () => {
    const w = world({ throttle: true });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await session.guestStart(startEvent(), w.deps);
    const lines = log.mock.calls.map(([l]) => String(l));
    log.mockRestore();
    expect(json(r).code).toBe('unavailable');
    expect(lines.some((l) => l.includes('"GuestSigningThrottled":1'))).toBe(true);
    expect(w.sts.send).not.toHaveBeenCalled();
  });

  it('a notice that cannot be recorded refuses the visit', async () => {
    const w = world();
    w.deps.audit = jest.fn(async () => { throw new Error('access log down'); });
    const r = await session.guestStart(startEvent(), w.deps);
    expect(json(r).code).toBe('unavailable');
    expect(w.lambda.send).not.toHaveBeenCalled();
    expect(signs(w.kms)).toBe(0);
  });
});

describe('guest refresh rotates one family per visit, and a replay revokes it', () => {
  async function started() {
    const w = world();
    const out = json(await session.guestStart(startEvent(), w.deps));
    const family = [...w.doc.table('tokens').values()].find((r) => r.kind === 'guest-refresh');
    w.people.set(family.subject, out.userArn);
    return { w, out };
  }

  it('rotates: the credential is redeemed once, and its successor is in the same family', async () => {
    const { w, out } = await started();
    const r = await session.guestRefresh(refreshEvent(out.refreshToken), w.deps);
    expect(r.statusCode).toBe(200);
    const next = json(r);
    expect(next.refreshToken).not.toBe(out.refreshToken);
    const rows = [...w.doc.table('tokens').values()].filter((x) => x.kind === 'guest-refresh');
    expect(new Set(rows.map((x) => x.familyId)).size).toBe(1);
    expect(rows.find((x) => x.pk === `guest-refresh#${sha(out.refreshToken)}`).consumedAt).toBeDefined();
  });

  it('mints a sign-in hand-off when the widget asks with its secret\'s hash: the nonce names the credential this refresh issued', async () => {
    const { w, out } = await started();
    const secretHash = createHash('sha256').update('the-widget-secret').digest('base64url');
    const r = await session.guestRefresh({ ...refreshEvent(out.refreshToken), body: JSON.stringify({ refreshToken: out.refreshToken, bindSecretHash: secretHash }) }, w.deps);
    expect(r.statusCode).toBe(200);
    const next = json(r);
    expect(typeof next.bindNonce).toBe('string');
    const handOff = w.doc.table('tokens').get(`guest-bind#${sha(next.bindNonce)}`);
    expect(handOff).toMatchObject({
      kind: 'guest-bind', redemption: 'single-use', issuer: 'guest', personArn: out.userArn,
      refreshPk: `guest-refresh#${sha(next.refreshToken)}`, secretHash,
    });
    // The store keeps the hash of the secret, never the secret, and never the nonce.
    expect(JSON.stringify(handOff)).not.toContain('the-widget-secret');
    expect(JSON.stringify(handOff)).not.toContain(next.bindNonce);
    // A refresh that asks for none mints none, and a malformed hash is refused before anything is spent.
    expect(json(await session.guestRefresh(refreshEvent(next.refreshToken), w.deps)).bindNonce).toBeUndefined();
    const bad = await session.guestRefresh({ ...refreshEvent(out.refreshToken), body: JSON.stringify({ refreshToken: out.refreshToken, bindSecretHash: 'short' }) }, w.deps);
    expect(bad.statusCode).toBe(400);
  });

  it('two tabs at once both keep the session; a third presentation in the grace is a replay', async () => {
    const { w, out } = await started();
    const [a, b] = await Promise.all([
      session.guestRefresh(refreshEvent(out.refreshToken), w.deps),
      session.guestRefresh(refreshEvent(out.refreshToken), w.deps),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(json(a).refreshToken).not.toBe(json(b).refreshToken);
    // REFRESH_REUSE_LIMIT other tabs are admitted; one more is a replay.
    await session.guestRefresh(refreshEvent(out.refreshToken), w.deps);
    const replay = await session.guestRefresh(refreshEvent(out.refreshToken), w.deps);
    expect([replay.statusCode, json(replay).code]).toEqual([401, 'replayed']);
  });

  it('a widget refreshing after its visit was bound to an account is told the visit ended, not that it replayed', async () => {
    const { w, out } = await started();
    // What a path A bind does to the token store (lib/guest-bind.ts): it spends the credential the widget
    // still holds, with no grace, and ends its family as the bind's own revocation.
    const tokens = w.doc.table('tokens');
    const credential = tokens.get(`guest-refresh#${sha(out.refreshToken)}`);
    credential.consumedAt = Math.floor(Date.UTC(2026, 9, 19, 12, 0, 0) / 1000);
    const family = tokens.get(session.familyKey(String(credential.familyId)));
    Object.assign(family, { status: 'revoked', revokedBy: 'bind' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await session.guestRefresh(refreshEvent(out.refreshToken), w.deps);
    expect([r.statusCode, json(r).code]).toEqual([401, 'ended']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[GuestSession][SecurityEvent]'))).toBe(false);
    warn.mockRestore();
  });

  it('a replay after the grace revokes the family: the most recent legitimate credential is refused too', async () => {
    const { w, out } = await started();
    const next = json(await session.guestRefresh(refreshEvent(out.refreshToken), w.deps));
    w.advance(session.REFRESH_REUSE_GRACE_SECONDS + 1);
    const replay = await session.guestRefresh(refreshEvent(out.refreshToken), w.deps);
    expect([replay.statusCode, json(replay).code]).toEqual([401, 'replayed']);
    const latest = await session.guestRefresh(refreshEvent(next.refreshToken), w.deps);
    expect([latest.statusCode, json(latest).code]).toEqual([401, 'revoked']);
  });

  it('an expired credential is refused, by the store, before anything reclaims it', async () => {
    const { w, out } = await started();
    w.advance(61 * 60);
    const r = await session.guestRefresh(refreshEvent(out.refreshToken), w.deps);
    expect([r.statusCode, json(r).code]).toEqual([401, 'expired']);
  });

  it('a credential nobody issued is refused, and a visitor offboarded since is refused', async () => {
    const { w, out } = await started();
    expect(json(await session.guestRefresh(refreshEvent('made-up'), w.deps)).code).toBe('invalid_request');
    w.people.clear();
    expect(json(await session.guestRefresh(refreshEvent(out.refreshToken), w.deps)).code).toBe('revoked');
  });

  it('refresh is paused by the kill switch too', async () => {
    const { w, out } = await started();
    abuse.__resetKillSwitchCacheForTests();
    w.deps.ssm = { send: jest.fn(async () => ({ Parameter: { Value: JSON.stringify({ paused: true }) } })) } as never;
    expect(json(await session.guestRefresh(refreshEvent(out.refreshToken), w.deps)).code).toBe('paused');
  });

  it('never refreshes past the visit\'s end', async () => {
    const { w, out } = await started();
    let token = out.refreshToken;
    for (let i = 0; i < 25; i++) {
      w.advance(59 * 60);
      const r = await session.guestRefresh(refreshEvent(token), w.deps);
      if (r.statusCode !== 200) {
        expect(['ended', 'expired']).toContain(json(r).code);
        return;
      }
      expect(json(r).refreshExpiresAt).toBeLessThanOrEqual(out.sessionEndsAt);
      token = json(r).refreshToken;
    }
    throw new Error('a refresh family outlived the visit');
  });
});

describe('the captcha verifier', () => {
  it('sends the secret and the response to Turnstile, and reads only the verdict', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    await abuse.verifyCaptcha({ secret: 's', response: 'r', remoteIp: '198.51.100.1', fetch });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(url).toBe(abuse.TURNSTILE_SITEVERIFY_URL);
    expect(Object.fromEntries(init.body)).toEqual({ secret: 's', response: 'r', remoteip: '198.51.100.1' });
  });

  it('answers with no verdict, or a 5xx, as unavailable', async () => {
    await expect(abuse.verifyCaptcha({ secret: 's', response: 'r', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }))
      .rejects.toMatchObject({ code: 'unavailable' });
    await expect(abuse.verifyCaptcha({ secret: 's', response: 'r', fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }) }))
      .rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('the funnel stages guest start records (B12)', () => {
  it('a visit started is guest_started, once, on the visitor and the journey of their conversation', async () => {
    const w = world();
    const out = json(await session.guestStart(startEvent(), w.deps));
    expect(w.funnel.mock.calls.map(([e]) => e)).toEqual([
      { eventType: 'guest_started', personId: out.userArn.split('/user/')[1], properties: { journey: 'guest-visitor-1' } },
    ]);
  });

  it('a refused start is guest_refused, once, by its reason, naming nobody', async () => {
    const w = world({ captcha: 'fail' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await session.guestStart(startEvent(), w.deps);
    warn.mockRestore();
    expect(w.funnel.mock.calls.map(([e]) => e)).toEqual([
      { eventType: 'guest_refused', personId: '', properties: { reason: 'captcha_failed' } },
    ]);
  });

  it('an archive that cannot take the stage never fails the visit', async () => {
    const w = world();
    w.funnel.mockRejectedValue(new Error('firehose down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await session.guestStart(startEvent(), w.deps);
    warn.mockRestore();
    expect(r.statusCode).toBe(200);
  });
});
