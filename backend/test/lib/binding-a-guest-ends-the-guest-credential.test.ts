/**
 * PATH A, THE BIND (B6, PLAN §16.5 P-11): a first sign-in carrying a live guest session becomes the
 * visitor's AppInstanceUser, and in the same operation the guest credential ends.
 *
 * The B6 deny-tests, as units against an in-memory store: a bound AppInstanceUser carries no expiration;
 * a `guest-refresh` issued before binding is refused after it (its family is revoked and the guest row
 * is gone); an existing account's sign-in cannot bind a guest AppInstanceUser; an upgrade without both
 * live tokens adds nothing; and a sign-in that did not start from the widget session that owns the visit
 * binds nothing: a forwarded link carries the hand-off's nonce and not its secret, and a hand-off is spent
 * by the bind. The live proof is `scripts/deny-test-upgrade.mjs`.
 */
import { bindGuestPerson, bindRequestOf, bindSecretHashOf, BindRefused } from '../../lambda/src/lib/guest-bind';
import { familyKey, type GuestConfig } from '../../lambda/src/guest-session';
import { tokenKey, tokenRecordOf } from '../../lambda/src/lib/tokens';
import { issuerSubjectKey, revokedMarkerKey } from '../../lambda/src/lib/person-identity';

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const VISITOR = `${INSTANCE}/user/0190c0de-0000-7000-8000-000000000001`;
const CHANNEL = `${INSTANCE}/channel/guest-1`;
const NOW = 1_800_000_000;
const CONFIG = { issuerId: 'guest', classification: 'guest', tokensTableParameter: '/p' } as unknown as GuestConfig;

type Item = Record<string, any>;

/** Two tables in memory, and the commands the bind sends. A transaction is all-or-nothing on its conditions. */
function world() {
  const tables: Record<string, Map<string, Item>> = { ids: new Map(), tokens: new Map() };
  const keyOf = (t: string, k: Item) => String(t === 'ids' ? k.issuerSubject : k.pk);
  const sent: Array<{ name: string; input: any }> = [];
  let failTransaction: string | null = null;
  const doc = {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      sent.push({ name, input });
      if (name === 'GetCommand') return { Item: tables[input.TableName].get(keyOf(input.TableName, input.Key)) };
      if (name === 'TransactWriteCommand') {
        if (failTransaction === 'raced') {
          // ANOTHER CALL BOUND THIS VISIT FIRST: its transaction deleted the guest row and wrote the account's.
          for (const k of [...tables.ids.keys()]) if (k.startsWith('guest|')) tables.ids.delete(k);
        }
        if (failTransaction) {
          const e: any = new Error('cancelled');
          e.name = 'TransactionCanceledException';
          e.CancellationReasons = [{ Code: 'None' }, { Code: 'None' }, { Code: failTransaction === 'put' || failTransaction === 'raced' ? 'ConditionalCheckFailed' : 'None' }, { Code: failTransaction === 'delete' ? 'ConditionalCheckFailed' : 'None' }];
          throw e;
        }
        for (const op of input.TransactItems) {
          if (op.Put) tables[op.Put.TableName].set(keyOf(op.Put.TableName, op.Put.Item), op.Put.Item);
          if (op.Delete) tables[op.Delete.TableName].delete(keyOf(op.Delete.TableName, op.Delete.Key));
          if (op.Update) {
            const row = tables[op.Update.TableName].get(keyOf(op.Update.TableName, op.Update.Key))!;
            const v = op.Update.ExpressionAttributeValues;
            if (op.Update.UpdateExpression.includes('consumedAt')) row.consumedAt = v[':now'];
            if (op.Update.UpdateExpression.includes(':revoked')) row.status = 'revoked';
          }
        }
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const chime = { calls: [] as any[], async send(cmd: any) { this.calls.push(cmd.input); return {}; } };
  return { tables, doc, chime, sent, fail: (what: string | null) => { failTransaction = what; } };
}

/** A sign-in hand-off the widget's refresh minted: its nonce, the hash of its secret, the credential it names. */
function handOff(w: ReturnType<typeof world>, nonce = 'nonce-1', over: Partial<Item> = {}) {
  const record = tokenRecordOf('guest-bind', nonce, { channelArn: CHANNEL, personArn: VISITOR, issuer: 'guest', expiresAt: NOW + 600 });
  w.tables.tokens.set(record.pk, { ...record, refreshPk: tokenKey('guest-refresh', 'refresh-1'), secretHash: bindSecretHashOf('secret-1'), ...over });
}

/** A live visit: its family, its refresh credential, its guest row, and the widget's hand-off of it. */
function seed(w: ReturnType<typeof world>, over: Partial<Item> = {}, family: Partial<Item> = {}) {
  handOff(w);
  w.tables.ids.set(issuerSubjectKey('guest', 'g-sub'), { issuerSubject: issuerSubjectKey('guest', 'g-sub'), personArn: VISITOR, issuer: 'guest', status: 'active' });
  w.tables.tokens.set(familyKey('fam-1'), { ...tokenRecordOf('guest-family', 'fam-1', { channelArn: CHANNEL, personArn: VISITOR, issuer: 'guest', expiresAt: NOW + 3600 }), status: 'active', ...family });
  const refresh = tokenRecordOf('guest-refresh', 'refresh-1', { channelArn: CHANNEL, personArn: VISITOR, issuer: 'guest', expiresAt: NOW + 600 });
  w.tables.tokens.set(refresh.pk, { ...refresh, familyId: 'fam-1', subject: 'g-sub', sessionEndsAt: NOW + 3600, ...over });
}

const funnelEvents: Array<{ eventType: string; personId: string; properties: Record<string, unknown> }> = [];
const bind = (w: ReturnType<typeof world>, opts: { subject?: string; nonce?: string; secret?: string } = {}) => bindGuestPerson(
  { issuer: 'customers', subject: opts.subject ?? 'c-sub', request: { nonce: opts.nonce ?? 'nonce-1', secret: opts.secret ?? 'secret-1' } },
  {
    config: CONFIG, doc: w.doc, chime: w.chime, identitiesTable: 'ids', tokensTable: 'tokens', appInstanceArn: INSTANCE,
    now: () => NOW * 1000,
    identityState: async (issuer, subject) => {
      const row = w.tables.ids.get(issuerSubjectKey(issuer, subject));
      return row && row.status === 'active' ? { state: 'active', personArn: row.personArn } : { state: 'unbound' };
    },
    audit: async () => undefined,
    funnel: async (e) => { funnelEvents.push(e); },
  },
);

const refused = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(BindRefused);
  await p.catch((e: BindRefused) => expect(e.code).toBe(code));
};

describe('the bind request', () => {
  it('is read from bindGuest as a hand-off, and a malformed one is refused rather than ignored', () => {
    expect(bindRequestOf({})).toBeNull();
    expect(bindRequestOf({ bindGuest: { nonce: 'n', secret: 's' } })).toEqual({ nonce: 'n', secret: 's' });
    // NOTHING IS ASKED OF THE VISITOR: a confirmation an older client still sends is ignored, either way.
    expect(bindRequestOf({ bindGuest: { nonce: 'n', secret: 's', confirmed: false } })).toEqual({ nonce: 'n', secret: 's' });
    expect(bindRequestOf({ bindGuest: {} })).toBe('malformed');
    expect(bindRequestOf({ bindGuest: { nonce: 'n' } })).toBe('malformed');
    expect(bindRequestOf({ bindGuest: { nonce: 'x'.repeat(200), secret: 's' } })).toBe('malformed');
    // A REFRESH CREDENTIAL IS NEVER ACCEPTED: one that travelled in a link could be forwarded.
    expect(bindRequestOf({ bindGuest: { refreshToken: 'r' } })).toBe('malformed');
    expect(bindRequestOf({ bindGuest: { refreshToken: 'r', nonce: 'n', secret: 's' } })).toBe('malformed');
  });
});

describe('binding a live visit', () => {
  it('makes the visitor the account, removes the expiration, revokes the family and deletes the guest row, in one transaction', async () => {
    const w = world();
    seed(w);
    const bound = await bind(w);
    expect(bound).toEqual(expect.objectContaining({ personArn: VISITOR, created: false, guestChannelArn: CHANNEL }));
    // A BOUND AppInstanceUser CARRIES NO EXPIRATION: the call names no settings.
    expect(w.chime.calls).toEqual([{ AppInstanceUserArn: VISITOR }]);
    const tx = w.sent.filter((s) => s.name === 'TransactWriteCommand');
    expect(tx).toHaveLength(1);
    expect(tx[0].input.TransactItems).toHaveLength(5);
    expect(w.tables.ids.get(issuerSubjectKey('customers', 'c-sub'))).toMatchObject({ personArn: VISITOR, status: 'active', boundFrom: 'guest' });
    expect(w.tables.ids.has(issuerSubjectKey('guest', 'g-sub'))).toBe(false);
    expect(w.tables.tokens.get(familyKey('fam-1'))!.status).toBe('revoked');
    expect(w.tables.tokens.get(tokenKey('guest-refresh', 'refresh-1'))!.consumedAt).toBe(NOW);
    // THE HAND-OFF IS SPENT WITH IT.
    expect(w.tables.tokens.get(tokenKey('guest-bind', 'nonce-1'))!.consumedAt).toBe(NOW);
  });

  it('a refresh issued before the bind is refused after it: its family is revoked and its credential spent', async () => {
    const w = world();
    seed(w);
    await bind(w);
    // The same hand-off again binds nothing: it was spent.
    await refused(bind(w, { subject: 'other' }), 'BIND_NOT_HANDED_OFF');
    // A second hand-off naming the same credential finds the visit ended.
    handOff(w, 'nonce-2');
    await refused(bind(w, { subject: 'other', nonce: 'nonce-2' }), 'GUEST_SESSION_NOT_LIVE');
  });
});

describe('a sign-in that did not start from the widget session that owns the visit binds nothing', () => {
  it.each([
    ['a forwarded link: the nonce without its secret', { secret: 'a-guess' }, {}],
    ['a nonce nobody minted', { nonce: 'nonce-never' }, {}],
    ['a hand-off already used', {}, { consumedAt: NOW - 5 }],
    ['an expired hand-off', {}, { expiresAt: NOW - 1 }],
    ['another issuer\'s hand-off', {}, { issuer: 'other-guest' }],
  ])('%s', async (_why, opts, over) => {
    const w = world();
    seed(w);
    handOff(w, 'nonce-1', over);
    await refused(bind(w, opts), 'BIND_NOT_HANDED_OFF');
    expect(w.sent.some((s) => s.name === 'TransactWriteCommand')).toBe(false);
    expect(w.chime.calls).toEqual([]);
    expect(w.tables.tokens.get(familyKey('fam-1'))!.status).toBe('active');
    expect(w.tables.ids.has(issuerSubjectKey('customers', 'c-sub'))).toBe(false);
  });
});

describe('a bind that is refused changes nothing', () => {
  const unchanged = (w: ReturnType<typeof world>) => {
    expect(w.sent.some((s) => s.name === 'TransactWriteCommand')).toBe(false);
    expect(w.chime.calls).toEqual([]);
    expect(w.tables.ids.has(issuerSubjectKey('customers', 'c-sub'))).toBe(false);
  };

  it('an existing account cannot bind a visitor: that is path B', async () => {
    const w = world();
    seed(w);
    w.tables.ids.set(issuerSubjectKey('customers', 'c-sub'), { issuerSubject: issuerSubjectKey('customers', 'c-sub'), personArn: `${INSTANCE}/user/someone`, status: 'active' });
    await refused(bind(w), 'SUBJECT_ALREADY_BOUND');
    expect(w.chime.calls).toEqual([]);
    expect(w.tables.tokens.get(familyKey('fam-1'))!.status).toBe('active');
  });

  it('an offboarded subject cannot bind', async () => {
    const w = world();
    seed(w);
    w.tables.ids.set(revokedMarkerKey('customers', 'c-sub'), { issuerSubject: revokedMarkerKey('customers', 'c-sub') });
    await refused(bind(w), 'SUBJECT_ALREADY_BOUND');
    unchanged(w);
  });

  it.each([
    ['no such refresh credential', {}, {}, true],
    ['a refresh credential already used', { consumedAt: NOW - 5 }, {}, false],
    ['an expired refresh credential', { expiresAt: NOW - 1 }, {}, false],
    ['a visit that has ended', { sessionEndsAt: NOW - 1 }, {}, false],
    ['a revoked family', {}, { status: 'revoked' }, false],
  ])('without a live guest session (%s), nothing is added', async (_why, over, family, missing) => {
    const w = world();
    seed(w, over, family);
    if (missing) w.tables.tokens.delete(tokenKey('guest-refresh', 'refresh-1'));
    await refused(bind(w), 'GUEST_SESSION_NOT_LIVE');
    unchanged(w);
  });

  it('a visitor whose guest row is gone has no live session', async () => {
    const w = world();
    seed(w);
    w.tables.ids.delete(issuerSubjectKey('guest', 'g-sub'));
    await refused(bind(w), 'GUEST_SESSION_NOT_LIVE');
    unchanged(w);
  });

  it('binds with no confirmation step: signing in from the widget is the whole act, and the refusals above still hold', async () => {
    const w = world();
    seed(w);
    const request = bindRequestOf({ bindGuest: { nonce: 'nonce-1', secret: 'secret-1', confirmed: false } });
    expect(request).toEqual({ nonce: 'nonce-1', secret: 'secret-1' });
    await expect(bind(w)).resolves.toMatchObject({ personArn: VISITOR, guestChannelArn: CHANNEL });
  });

  it('a transaction that cancels puts the expiration back and binds nobody', async () => {
    const w = world();
    seed(w);
    w.fail('put');
    await refused(bind(w), 'SUBJECT_ALREADY_BOUND');
    expect(w.chime.calls).toEqual([
      { AppInstanceUserArn: VISITOR },
      { AppInstanceUserArn: VISITOR, ExpirationSettings: { ExpirationDays: 1, ExpirationCriterion: 'CREATED_TIMESTAMP' } },
    ]);
    const w2 = world();
    seed(w2);
    w2.fail('delete');
    await refused(bind(w2), 'GUEST_SESSION_NOT_LIVE');
  });

  it('a bind that loses a race to another call of the same hand-off leaves the bound customer without an expiration', async () => {
    const w = world();
    seed(w);
    w.fail('raced');
    await refused(bind(w), 'SUBJECT_ALREADY_BOUND');
    // The expiration was removed before the transaction, and is NOT put back: the visitor is a customer now.
    expect(w.chime.calls).toEqual([{ AppInstanceUserArn: VISITOR }]);
  });

  it('a deployment with no guest issuer binds nobody', async () => {
    const w = world();
    await expect(bindGuestPerson({ issuer: 'customers', subject: 's', request: { nonce: 'n', secret: 's' } }, { config: null, doc: w.doc, chime: w.chime }))
      .rejects.toMatchObject({ code: 'BIND_NOT_DECLARED' });
  });
});

describe('the funnel stage a bind records (B12, path A)', () => {
  beforeEach(() => { funnelEvents.length = 0; });

  it('a bind is guest_bound, once, on the visitor who is now the account, on the journey of their conversation', async () => {
    const w = world();
    seed(w);
    await bind(w);
    expect(funnelEvents).toEqual([
      { eventType: 'guest_bound', personId: VISITOR.split('/user/')[1], properties: { journey: CHANNEL.split('/').pop(), path: 'A' } },
    ]);
  });

  it('a refused bind records nothing', async () => {
    const w = world();
    seed(w);
    w.tables.ids.delete(issuerSubjectKey('guest', 'g-sub'));
    await bind(w).catch(() => undefined);
    expect(funnelEvents).toEqual([]);
  });
});
