/**
 * AN INVITATION IS REDEEMED ONCE, IN ITS DECLARED MODE ONLY (M-10, M-5, V18, §17).
 *
 * The exchange's half (`lambda/src/lib/invitation-redemption.ts`), as units against an in-memory `Tokens` and
 * `Identities`. The live proof is `scripts/deny-test-invitations.mjs`; these pin each refusal:
 *
 *  - the landing page's read consumes nothing, however often it is asked (a link scanner that posts it too);
 *  - a `link` redemption runs the kill switch, the per-address limit and the captcha first, each failing
 *    closed; then admits the first redeemer once (`redeemed_elsewhere` after), only in `link` mode, never a
 *    revoked or expired invitation, never one whose inviter no longer signs in, and only at a classification
 *    the issuer declares and the type's `linkClassifications` holds; the session is the `link` role, pinned to the
 *    invitee and the one conversation by its session tags, for 15 minutes;
 *  - a `sign-in` redemption binds a first sign-in to the invitee in one transaction, with the expiration
 *    removed; it never binds a subject that already has an account (`wrong_account`), one whose clearance
 *    does not reach the conversation, an invitee somebody already signs in as, or a `link` invitation; a
 *    transaction that fails puts the expiration back;
 *  - minting an invitee answers only the invitations function's invocation, and writes no `Identities` row.
 */
import type { InvitationConfig, RedemptionDeps } from '../../lambda/src/lib/invitation-redemption';
import { tokenKey, tokenRecordOf } from '../../lambda/src/lib/tokens';
import { __resetKillSwitchCacheForTests, __resetSecretCacheForTests } from '../../lambda/src/lib/guest-abuse';
import { invitationLinkSettingsOf } from '../../lib/config/issuers';
import { issuerSubjectKey, subjectsOfPerson } from '../../lambda/src/lib/person-identity';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
// The exchange's modules read the instance when they load, so it is set before they are required.
process.env.APP_INSTANCE_ARN = APP;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  bindInvitation, invitationRequestOf, isMintInviteeOperation, mintInviteeOperation, peekInvitation, redeemLink, __resetInvitationRedemptionCachesForTests,
} = require('../../lambda/src/lib/invitation-redemption') as typeof import('../../lambda/src/lib/invitation-redemption');
const CH = `${APP}/channel/room-1`;
const INVITEE_ID = '0190c0de-0000-7000-8000-0000000000ee';
const INVITEE = `${APP}/user/${INVITEE_ID}`;
const INVITER = `${APP}/user/0190c0de-0000-7000-8000-000000000001`;
const NOW = 1_800_000_000;
const ccf = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

const config = (link = true): InvitationConfig => ({
  tokensTableParameter: '/p/tokens',
  signInUrl: 'https://app.example.com',
  ...(link ? {
    link: {
      issuerId: 'invitation', reach: ['basic', 'standard'], settings: invitationLinkSettingsOf({}), roleArn: 'arn:aws:iam::111122223333:role/link',
      killSwitchParameter: '/p/paused', addressSaltSecret: 'salt', abuseTableParameter: '/p/abuse', environment: 'dev',
    },
  } : {}),
});

function world(opts: { paused?: boolean; captcha?: boolean; limit?: boolean; inviterActive?: boolean } = {}) {
  const tokens = new Map<string, Record<string, any>>();
  const identities = new Map<string, Record<string, any>>();
  const writes: string[] = [];
  const chime: any[] = [];
  const assumed: any[] = [];
  let counted = 0;
  // The reverse lookup over this world's Identities (the suite-wide stand-in answers every person with a subject).
  (subjectsOfPerson as jest.Mock).mockImplementation(async (arn: string) => [...identities.values()]
    .filter((r) => r.personArn === arn).map((r) => ({ issuer: String(r.issuerSubject).split('|')[0], subject: String(r.issuerSubject).split('|')[1] })));
  const doc = {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      if (name === 'GetCommand') {
        if (i.TableName === 'Tokens') return { Item: tokens.get(i.Key.pk) };
        if (i.TableName === 'Identities') return { Item: identities.get(i.Key.issuerSubject) };
      }
      if (name === 'QueryCommand' && i.IndexName === 'byPerson') {
        return { Items: [...identities.values()].filter((r) => r.personArn === i.ExpressionAttributeValues[':p']) };
      }
      if (name === 'UpdateCommand' && i.TableName === 'Abuse') {
        counted++;
        if (opts.limit) throw ccf();
        return {};
      }
      if (name === 'UpdateCommand' && i.TableName === 'Tokens') {
        writes.push('consume');
        const row = tokens.get(i.Key.pk);
        const v = i.ExpressionAttributeValues;
        const modeOk = !i.ExpressionAttributeNames?.['#m0'] || row?.[i.ExpressionAttributeNames['#m0']] === v[':m0'];
        if (!row || row.consumedAt !== undefined || row.revokedAt !== undefined || !(row.expiresAt > v[':now'])
          || (v[':channel'] && row.channelArn !== v[':channel']) || !modeOk) throw ccf();
        row.consumedAt = v[':now'];
        if (v[':x0']) row.redeemedVia = v[':x0'];
        return { Attributes: { ...row } };
      }
      if (name === 'TransactWriteCommand') {
        writes.push('transaction');
        const [put, update] = i.TransactItems;
        const row = tokens.get(update.Update.Key.pk);
        const v = update.Update.ExpressionAttributeValues;
        const reasons = [
          { Code: identities.has(put.Put.Item.issuerSubject) ? 'ConditionalCheckFailed' : 'None' },
          { Code: !row || row.consumedAt !== undefined || row.revokedAt !== undefined || !(row.expiresAt > v[':now']) || row.mode !== v[':mode'] ? 'ConditionalCheckFailed' : 'None' },
        ];
        if (reasons.some((r) => r.Code !== 'None')) throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: reasons });
        identities.set(put.Put.Item.issuerSubject, put.Put.Item);
        row!.consumedAt = v[':now'];
        row!.redeemedVia = v[':mode'];
        return {};
      }
      throw new Error(`unexpected ${name} ${i.TableName}`);
    },
  };
  const ssm = {
    async send(cmd: any) {
      const n = cmd.input.Name;
      if (n === '/p/tokens') return { Parameter: { Value: 'Tokens' } };
      if (n === '/p/abuse') return { Parameter: { Value: 'Abuse' } };
      if (n === '/p/paused') return { Parameter: { Value: JSON.stringify({ paused: !!opts.paused }) } };
      throw new Error(`unexpected parameter ${n}`);
    },
  };
  const deps: RedemptionDeps = {
    config: config(),
    doc,
    ssm,
    secrets: { async send() { return { SecretString: 'salt-value' }; } },
    sts: { async send(cmd: any) { assumed.push(cmd.input); return { Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST', Expiration: new Date((NOW + 900) * 1000) } }; } },
    chime: { async send(cmd: any) { chime.push({ name: cmd.constructor.name, input: cmd.input }); return {}; } },
    fetch: (async () => ({ ok: true, status: 200, json: async () => ({ success: opts.captcha !== false }) })) as never,
    now: () => NOW * 1000,
    identitiesTable: 'Identities',
    personActive: async (arn: string) => arn === INVITER && opts.inviterActive !== false,
    audit: async () => undefined,
  };
  const issue = (token: string, fields: Record<string, unknown> = {}) => {
    tokens.set(tokenKey('invitation', token), {
      ...tokenRecordOf('invitation', token, { channelArn: CH, personArn: INVITEE, issuer: 'deployment', expiresAt: NOW + 86_400, createdAt: new Date((NOW - 3600) * 1000).toISOString() }),
      invitationId: 'inv-1', inviterArn: INVITER, inviterName: 'Riley', inviteeName: 'Jordan', mode: 'link', classification: 'standard',
      conversationType: 'general', conversationName: 'Quarterly plan', invitationChannel: CH,
      ...fields,
    });
  };
  return { tokens, identities, writes, chime, assumed, deps, issue, counted: () => counted };
}

beforeEach(() => {
  __resetInvitationRedemptionCachesForTests();
  __resetKillSwitchCacheForTests();
  __resetSecretCacheForTests();
});

const post = (body: unknown, ip = '203.0.113.9') => ({ httpMethod: 'POST', body: JSON.stringify(body), requestContext: { http: { sourceIp: ip } } });
const parse = (res: { body: string }) => JSON.parse(res.body);

describe('the landing page reads an invitation and spends nothing', () => {
  it('names the conversation, the inviter and the mode, however often it is asked', async () => {
    const w = world();
    w.issue('tok');
    for (let n = 0; n < 3; n++) {
      const res = await peekInvitation(post({ token: 'tok' }), w.deps);
      expect(res.statusCode).toBe(200);
      expect(parse(res)).toMatchObject({ status: 'pending', mode: 'link', conversationName: 'Quarterly plan', inviterName: 'Riley', linkAvailable: true, sessionMinutes: 15 });
    }
    expect(w.writes).toEqual([]);
    expect(w.tokens.get(tokenKey('invitation', 'tok'))!.consumedAt).toBeUndefined();
  });

  it('says where a sign-in invitation signs in, and calls one whose inviter is gone revoked', async () => {
    const w = world({ inviterActive: false });
    w.issue('tok', { mode: 'sign-in' });
    const body = parse(await peekInvitation(post({ token: 'tok' }), w.deps));
    expect(body).toMatchObject({ status: 'revoked', mode: 'sign-in', signInUrl: 'https://app.example.com' });
    expect(body).not.toHaveProperty('captchaSiteKey');
  });

  it('knows nothing of a token nobody issued, and nothing without one', async () => {
    const w = world();
    expect(parse(await peekInvitation(post({ token: 'nope' }), w.deps)).code).toBe('unknown');
    expect((await peekInvitation(post({}), w.deps)).statusCode).toBe(400);
  });
});

describe('a link redemption', () => {
  it('admits the first redeemer once, on the link role, pinned to the invitee and the conversation, for 15 minutes', async () => {
    const w = world();
    w.issue('tok');
    const res = await redeemLink(post({ token: 'tok', captchaToken: 'c' }), w.deps);
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toMatchObject({ userArn: INVITEE, channelArn: CH, tier: 'standard', sessionEndsAt: NOW + 900, scopedTo: CH });
    expect(w.assumed).toHaveLength(1);
    const assume = w.assumed[0];
    expect(assume).toMatchObject({ RoleArn: 'arn:aws:iam::111122223333:role/link', DurationSeconds: 900 });
    expect(assume.Tags).toEqual([
      { Key: 'person', Value: INVITEE_ID }, { Key: 'classification', Value: 'standard' }, { Key: 'channel', Value: 'room-1' },
    ]);
    const policy = JSON.parse(assume.Policy);
    expect(policy.Statement[1].Resource).toEqual([CH, INVITEE]);
    expect(policy.Statement[1].Action).not.toContain('chime:CreateChannelMembership');
    expect(w.tokens.get(tokenKey('invitation', 'tok'))).toMatchObject({ consumedAt: NOW, redeemedVia: 'link' });

    // A FORWARDED LINK ADMITS ONE SESSION, ONCE.
    const again = await redeemLink(post({ token: 'tok', captchaToken: 'c' }, '198.51.100.7'), w.deps);
    expect({ status: again.statusCode, code: parse(again).code }).toEqual({ status: 409, code: 'redeemed_elsewhere' });
    expect(w.assumed).toHaveLength(1);
  });

  it.each([
    ['paused', { paused: true }, 503, 'paused'],
    ['over the per-address limit', { limit: true }, 429, 'rate_limited'],
    ['with a captcha the vendor refuses', { captcha: false }, 403, 'captcha_failed'],
  ])('is refused when %s, before the invitation is read', async (_what, opts, status, code) => {
    const w = world(opts as never);
    w.issue('tok');
    const res = await redeemLink(post({ token: 'tok', captchaToken: 'c' }), w.deps);
    expect(parse(res).code).toBe(code);
    expect(res.statusCode).toBe(status);
    expect(w.writes).toEqual([]);
    expect(w.assumed).toEqual([]);
  });

  it.each([
    ['a sign-in invitation', { mode: 'sign-in' }, 'wrong_mode'],
    ['a revoked one', { revokedAt: NOW - 10 }, 'revoked'],
    ['an expired one, before TTL removes it', { expiresAt: NOW }, 'expired'],
    ['one at a classification no link session reaches', { classification: 'premium' }, 'wrong_mode'],
    ['one of a type that declares no link', { conversationType: 'ops' }, 'wrong_mode'],
  ])('refuses %s and vends nothing', async (_what, fields, code) => {
    const w = world();
    w.issue('tok', fields);
    const res = await redeemLink(post({ token: 'tok', captchaToken: 'c' }), w.deps);
    expect(parse(res).code).toBe(code);
    expect(w.assumed).toEqual([]);
    expect(w.tokens.get(tokenKey('invitation', 'tok'))!.consumedAt).toBeUndefined();
  });

  it('refuses one whose inviter no longer signs in as anybody (offboarded, or disabled at their issuer)', async () => {
    const w = world({ inviterActive: false });
    w.issue('tok');
    expect(parse(await redeemLink(post({ token: 'tok', captchaToken: 'c' }), w.deps)).code).toBe('revoked');
    expect(w.assumed).toEqual([]);
  });

  it('asks the inviter\'s issuer now: a disabled inviter is revoked, and an issuer that cannot be asked refuses unavailable', async () => {
    const { accountState } = (jest.requireMock('../../lambda/src/lib/membership-source') as { __accountStateForTests: { accountState: jest.Mock } }).__accountStateForTests;
    const w = world();
    delete w.deps.personActive;
    w.identities.set('deployment|riley-sub', { issuerSubject: 'deployment|riley-sub', personArn: INVITER, issuer: 'deployment', status: 'active' });
    w.issue('tok');
    accountState.mockClear();
    accountState.mockResolvedValueOnce('disabled');
    expect(parse(await redeemLink(post({ token: 'tok', captchaToken: 'c' }), w.deps)).code).toBe('revoked');
    expect(accountState).toHaveBeenCalledWith('deployment', 'riley-sub');
    accountState.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }));
    const unreadable = await redeemLink(post({ token: 'tok', captchaToken: 'c' }), w.deps);
    expect(unreadable.statusCode).toBe(503);
    expect(parse(unreadable).code).toBe('unavailable');
    expect(w.assumed).toEqual([]);
    expect(w.tokens.get(tokenKey('invitation', 'tok'))!.consumedAt).toBeUndefined();
  });

  it('does not exist where the deployment declares no invitation-link issuer', async () => {
    const w = world();
    w.deps.config = config(false);
    w.issue('tok');
    const res = await redeemLink(post({ token: 'tok' }), w.deps);
    expect(res.statusCode).toBe(404);
    expect(w.assumed).toEqual([]);
  });
});

describe('a sign-in redemption', () => {
  const bind = (w: ReturnType<typeof world>, roleKey: string | undefined = 'standard', token = 'tok', subject = 'new-sub') =>
    bindInvitation({ issuer: 'deployment', subject, roleKey, token }, w.deps);

  it('binds a first sign-in to the invitee, once, in one transaction, with its expiration removed', async () => {
    const w = world();
    w.issue('tok', { mode: 'sign-in' });
    const bound = await bind(w);
    expect(bound).toEqual({ personId: INVITEE_ID, personArn: INVITEE, created: false, channelArn: CH });
    expect(w.identities.get(issuerSubjectKey('deployment', 'new-sub'))).toMatchObject({ personArn: INVITEE, status: 'active', boundFrom: 'invitation' });
    expect(w.chime[0]).toEqual({ name: 'PutAppInstanceUserExpirationSettingsCommand', input: { AppInstanceUserArn: INVITEE } });
    expect(w.tokens.get(tokenKey('invitation', 'tok'))).toMatchObject({ consumedAt: NOW, redeemedVia: 'sign-in' });
    // A second sign-in with the same token is refused.
    await expect(bind(w, 'standard', 'tok', 'another-sub')).rejects.toMatchObject({ code: 'redeemed' });
  });

  it('never binds a sign-in that already has an account', async () => {
    const w = world();
    w.issue('tok', { mode: 'sign-in' });
    w.identities.set(issuerSubjectKey('deployment', 'existing'), { issuerSubject: issuerSubjectKey('deployment', 'existing'), personArn: `${APP}/user/someone`, status: 'active' });
    await expect(bind(w, 'standard', 'tok', 'existing')).rejects.toMatchObject({ code: 'wrong_account' });
    expect(w.writes).toEqual([]);
  });

  it('never binds a second IdP record to an invitee somebody already signs in as', async () => {
    const w = world();
    w.issue('tok', { mode: 'sign-in' });
    w.identities.set('deployment|first', { issuerSubject: 'deployment|first', personArn: INVITEE, status: 'active' });
    await expect(bind(w)).rejects.toMatchObject({ code: 'redeemed' });
    expect(w.writes).toEqual([]);
  });

  it.each([
    ['a link invitation', { mode: 'link' }, 'standard', 'wrong_mode'],
    ['a sign-in whose clearance does not reach the conversation', { mode: 'sign-in' }, 'basic', 'wrong_account'],
    ['a revoked invitation', { mode: 'sign-in', revokedAt: NOW - 1 }, 'standard', 'revoked'],
  ])('refuses %s, binding nothing', async (_what, fields, roleKey, code) => {
    const w = world();
    w.issue('tok', fields);
    await expect(bind(w, roleKey)).rejects.toMatchObject({ code });
    expect(w.identities.size).toBe(0);
    expect(w.writes).toEqual([]);
  });

  it('leaves the bound person without an expiration when another redemption of the invitation won the race', async () => {
    const w = world();
    w.issue('tok', { mode: 'sign-in' });
    // Another redemption wins between the read and the transaction: it spends the invitation and binds the
    // invitee. Putting the expiration back now would expire the person it just bound.
    const realSend = w.deps.doc!.send.bind(w.deps.doc);
    w.deps.doc = { send: async (cmd: any) => {
      if (cmd.constructor.name === 'TransactWriteCommand') w.tokens.get(tokenKey('invitation', 'tok'))!.consumedAt = NOW - 1;
      return realSend(cmd);
    } };
    await expect(bind(w)).rejects.toMatchObject({ code: 'redeemed' });
    expect(w.chime.map((c) => c.name)).toEqual(['PutAppInstanceUserExpirationSettingsCommand']);
    expect(w.chime[0].input.ExpirationSettings).toBeUndefined();
  });

  it('puts the expiration back when the transaction is refused and the invitation is still unspent', async () => {
    const w = world();
    w.issue('tok', { mode: 'sign-in' });
    // The sign-in's own subject was bound by another call: the invitation is untouched, so the invitee is
    // still nobody's and lapses with it.
    const realSend = w.deps.doc!.send.bind(w.deps.doc);
    w.deps.doc = { send: async (cmd: any) => {
      if (cmd.constructor.name === 'TransactWriteCommand') {
        const put = cmd.input.TransactItems[0].Put.Item;
        w.identities.set(put.issuerSubject, { ...put, personArn: 'someone-else' });
      }
      return realSend(cmd);
    } };
    await expect(bind(w)).rejects.toMatchObject({ code: 'wrong_account' });
    expect(w.chime.map((c) => c.name)).toEqual(['PutAppInstanceUserExpirationSettingsCommand', 'PutAppInstanceUserExpirationSettingsCommand']);
    expect(w.chime[1].input.ExpirationSettings).toEqual({ ExpirationDays: 1, ExpirationCriterion: 'CREATED_TIMESTAMP' });
  });

  it('reads the invitation a body asks to redeem, and refuses a malformed one', () => {
    expect(invitationRequestOf({})).toBeNull();
    expect(invitationRequestOf({ invitation: 'tok' })).toBe('tok');
    expect(invitationRequestOf({ invitation: 7 })).toBe('malformed');
    expect(invitationRequestOf({ invitation: 'x'.repeat(200) })).toBe('malformed');
  });
});

describe('minting an invitee', () => {
  it('answers only a direct invocation naming the operation', () => {
    expect(isMintInviteeOperation({ op: 'mint-invitee' })).toBe(true);
    expect(isMintInviteeOperation({ op: 'mint-invitee', requestContext: {} })).toBe(false);
    expect(isMintInviteeOperation({ op: 'mint-invitee', httpMethod: 'POST' })).toBe(false);
  });

  it('mints with an expiration, tags the classification, and refuses what is not a conversation classification', async () => {
    const minted: any[] = [];
    const tagged: any[] = [];
    const deps: RedemptionDeps = {
      mint: (async (input: any) => { minted.push(input); return { personId: INVITEE_ID, personArn: INVITEE }; }) as never,
      tag: (async (id: string, c: string) => { tagged.push([id, c]); }) as never,
    };
    expect(await mintInviteeOperation({ op: 'mint-invitee', name: 'Jordan', expirationDays: 7, classification: 'standard' }, deps))
      .toEqual({ ok: true, personArn: INVITEE, personId: INVITEE_ID });
    expect(minted).toEqual([{ name: 'Jordan', expirationDays: 7 }]);
    expect(tagged).toEqual([[INVITEE_ID, 'standard']]);
    expect((await mintInviteeOperation({ op: 'mint-invitee', name: 'J', expirationDays: 7, classification: 'admin' }, deps)).ok).toBe(false);
  });
});

describe('a reminded invitation has two links, and one invitation (ADR-061, send_nudge)', () => {
  /** The reminder's second link, as `nudgeOperation` writes it: an alias naming the invitation's one record. */
  const remind = (w: ReturnType<typeof world>, original: string, second: string) => {
    const target = w.tokens.get(tokenKey('invitation', original))!;
    target.nudgedAt = NOW - 60;
    w.tokens.set(tokenKey('invitation', second), {
      pk: tokenKey('invitation', second), kind: 'invitation', aliasOf: target.pk, channelArn: CH, personArn: INVITEE, inviterArn: INVITER,
      issuer: 'deployment', redemption: 'single-use', expiresAt: target.expiresAt, reclaimAt: target.reclaimAt, createdAt: new Date((NOW - 60) * 1000).toISOString(),
    });
  };

  it('the first link still redeems after the reminder, and then the reminder\'s link is refused', async () => {
    const w = world();
    w.issue('first');
    remind(w, 'first', 'second');
    expect((await redeemLink(post({ token: 'first', captchaToken: 'c' }), w.deps)).statusCode).toBe(200);
    const again = await redeemLink(post({ token: 'second', captchaToken: 'c' }, '198.51.100.7'), w.deps);
    expect({ status: again.statusCode, code: parse(again).code }).toEqual({ status: 409, code: 'redeemed_elsewhere' });
    expect(w.assumed).toHaveLength(1);
  });

  it('the reminder\'s link redeems the one invitation, and then the first link is refused', async () => {
    const w = world();
    w.issue('first');
    remind(w, 'first', 'second');
    expect((await peekInvitation(post({ token: 'second' }), w.deps)).statusCode).toBe(200);
    expect((await redeemLink(post({ token: 'second', captchaToken: 'c' }), w.deps)).statusCode).toBe(200);
    // The one record is spent; the alias holds no state of its own.
    expect(w.tokens.get(tokenKey('invitation', 'first'))).toMatchObject({ consumedAt: NOW, redeemedVia: 'link' });
    expect(w.tokens.get(tokenKey('invitation', 'second'))!.consumedAt).toBeUndefined();
    expect(parse(await redeemLink(post({ token: 'first', captchaToken: 'c' }, '198.51.100.7'), w.deps)).code).toBe('redeemed_elsewhere');
  });

  it('a sign-in through either link binds once; the other is refused', async () => {
    const w = world();
    w.issue('first', { mode: 'sign-in' });
    remind(w, 'first', 'second');
    await expect(bindInvitation({ issuer: 'deployment', subject: 'new-sub', roleKey: 'standard', token: 'second' }, w.deps)).resolves.toMatchObject({ personArn: INVITEE });
    await expect(bindInvitation({ issuer: 'deployment', subject: 'other-sub', roleKey: 'standard', token: 'first' }, w.deps)).rejects.toMatchObject({ code: 'redeemed' });
  });

  it('revoking the invitation ends both links', async () => {
    const w = world();
    w.issue('first', { revokedAt: NOW - 1 });
    remind(w, 'first', 'second');
    expect(parse(await redeemLink(post({ token: 'first', captchaToken: 'c' }), w.deps)).code).toBe('revoked');
    expect(parse(await redeemLink(post({ token: 'second', captchaToken: 'c' }), w.deps)).code).toBe('revoked');
    expect(w.assumed).toHaveLength(0);
  });

  it('an alias is never read as an invitation of its own, and one naming nothing is unknown', async () => {
    const w = world();
    w.tokens.set(tokenKey('invitation', 'stray'), { pk: tokenKey('invitation', 'stray'), kind: 'invitation', aliasOf: tokenKey('invitation', 'gone'), channelArn: CH, personArn: INVITEE, expiresAt: NOW + 60 });
    expect(parse(await peekInvitation(post({ token: 'stray' }), w.deps)).code).toBe('unknown');
  });
});
