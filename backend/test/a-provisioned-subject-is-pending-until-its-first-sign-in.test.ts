/**
 * A PROVISIONED SUBJECT IS `pending` UNTIL ITS FIRST SIGN-IN, AND ONLY ITS TWO CALLERS PROVISION ONE (P-13).
 *
 * `provisionSubject` pre-assigns a subject of a `provisioned-only` issuer (a `host-assertion` host) to a
 * person: a `pending` row in `Identities`. The provisioner that runs it is built once per caller
 * (`lambda/src/provision-subject.ts`), and this suite proves its handler's half of the boundary (IAM's half
 * is `the-host-assertion-boundary.test.ts`):
 *
 *  - a provisioner with no caller writes nothing; the issuer must be one its caller provisions for and one
 *    the registry declares `provisioned-only`, so a subject of a minting issuer is never pre-assigned;
 *  - the connector caller pre-assigns a new person and never links one who exists; an administrator links
 *    only a person of this app instance who exists, never an admin-plane twin;
 *  - the row is created and never changed: a subject with a row, or a revoked marker, is left as it is;
 *  - two provisions racing write one row, and two first sign-ins racing bind one person;
 *  - a `pending` row is the edge's `pending` state for its own issuer and a refusal for any other, and the
 *    minter refuses it outright, so a pending subject is never minted a second person.
 */
import { handleProvision } from '../lambda/src/provision-subject';
import {
  bindProvisionedPerson,
  identityStateOf,
  mintOrResolvePerson,
  PersonNotActive,
  PersonNotProvisioned,
  provisionSubject,
  revokedMarkerKey,
} from '../lambda/src/lib/person-identity';
import { compactIssuers, issuerRegistry, runtimeIssuers } from '../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { __resetTrustedIssuersForTests } from '../lambda/src/lib/trusted-issuers';
import { generateKeyPairSync } from 'crypto';

/** A direct OIDC entry is a multi-tenant Entra one: a generic `oidc` entry is refused (it federates into the pool). */
const ENTRA_TENANTS = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000'];
const ENTRA_DISCOVERY = 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const TABLE = 'identities';
const SUBJECT = '00D000000000001:005000000000001';
const KEY = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
const REGISTRY = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  {
    id: 'salesforce-org', kind: 'host-assertion', issuer: 'https://example.my.salesforce.com', allowedOrigins: ['https://example.lightning.force.com'],
    hostAssertion: { publicKeys: { k1: KEY } }, clearance: { mapping: { claim: 'permsets', values: { AE_Sales: 'standard' } }, classifications: ['basic', 'standard'] },
  },
  {
    id: 'partner', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY,
    audience: 'client', clearance: { fixed: ['basic'], classifications: ['basic'] },
  },
];

// ── IDENTITIES, IN MEMORY, HONORING ITS CONDITIONS ──────────────────────────────────────────────────
type Row = Record<string, any>;
function table() {
  const rows = new Map<string, Row>();
  const writes: string[] = [];
  const doc = {
    send: jest.fn(async (cmd: any) => {
      const name = cmd.constructor?.name as string;
      const input = cmd.input;
      if (name === 'GetCommand') return { Item: rows.get(input.Key.issuerSubject) };
      if (name === 'PutCommand') {
        if (rows.has(input.Item.issuerSubject)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
        rows.set(input.Item.issuerSubject, input.Item);
        writes.push(`put ${input.Item.issuerSubject} ${input.Item.status}`);
        return {};
      }
      if (name === 'UpdateCommand') {
        const row = rows.get(input.Key.issuerSubject);
        const v = input.ExpressionAttributeValues;
        if (!row || row.status !== v[':pending'] || row.issuer !== v[':issuer']) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
        rows.set(input.Key.issuerSubject, { ...row, status: v[':active'], boundAt: v[':boundAt'] });
        writes.push(`bind ${input.Key.issuerSubject}`);
        return {};
      }
      throw new Error(`unexpected ${name}`);
    }),
  };
  const chime = { send: jest.fn(async (cmd: any) => (cmd.constructor?.name === 'DescribeAppInstanceUserCommand' ? {} : {})) };
  const deps = { doc, chime, table: TABLE, appInstanceArn: APP, audit: jest.fn(async () => undefined) };
  return { rows, writes, deps, chime };
}

beforeAll(() => {
  process.env.TRUSTED_ISSUERS = JSON.stringify(compactIssuers(runtimeIssuers(issuerRegistry(REGISTRY, profiles), 'us-east-1_pool', 'us-east-1', 'test-instance')));
  __resetTrustedIssuersForTests();
});
afterAll(() => {
  delete process.env.TRUSTED_ISSUERS;
  __resetTrustedIssuersForTests();
});

const request = (over: Record<string, unknown> = {}) => ({ op: 'provisionSubject', issuer: 'salesforce-org', subject: SUBJECT, actor: 'sfdc', ...over });

describe('the subject provisioner writes pending rows for its own caller\'s issuers alone', () => {
  const provisioner = (t: ReturnType<typeof table>, caller: 'admin' | 'connectors' | null, issuers = ['salesforce-org'], personExists = async () => true) => (
    (raw: unknown) => handleProvision(raw, { caller, issuers, appInstanceArn: APP, identity: t.deps, personExists })
  );

  it('pre-assigns a new person, pending, for the connector caller', async () => {
    const t = table();
    const answer = await provisioner(t, 'connectors')(request());
    expect(answer).toMatchObject({ ok: true, state: 'provisioned' });
    const row = t.rows.get(`salesforce-org|${SUBJECT}`)!;
    expect(row).toMatchObject({ status: 'pending', issuer: 'salesforce-org', provisionedBy: 'connectors' });
    expect(row.personArn).toMatch(new RegExp(`^${APP}/user/[0-9a-f-]{36}$`));
    // Nothing exists in the Amazon Chime SDK yet: the exchange creates the person at the bind.
    expect(t.chime.send).not.toHaveBeenCalled();
  });

  it('writes nothing for a provisioner built with no caller', async () => {
    const t = table();
    expect(await provisioner(t, null)(request())).toMatchObject({ ok: false, code: 'NOT_THIS_CALLER' });
    expect(t.writes).toEqual([]);
  });

  it('refuses an issuer its caller does not provision for, and one that mints at first sign-in', async () => {
    const t = table();
    expect(await provisioner(t, 'connectors', [])(request())).toMatchObject({ ok: false, code: 'ISSUER_NOT_PROVISIONABLE' });
    // Named in the caller's list, but the registry declares it minting: still refused.
    expect(await provisioner(t, 'admin', ['partner'])(request({ issuer: 'partner', subject: 'someone' }))).toMatchObject({ ok: false, code: 'ISSUER_NOT_PROVISIONABLE' });
    expect(await provisioner(t, 'admin', ['nobody'])(request({ issuer: 'nobody' }))).toMatchObject({ ok: false, code: 'ISSUER_NOT_PROVISIONABLE' });
    expect(t.writes).toEqual([]);
  });

  it('refuses a malformed request', async () => {
    const t = table();
    const p = provisioner(t, 'admin');
    for (const bad of [request({ op: 'delete' }), request({ subject: '' }), request({ subject: 'a|b' }), request({ subject: 'x\u0001' }), request({ actor: '' }), null, 'text']) {
      expect(await p(bad)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    }
    expect(t.writes).toEqual([]);
  });

  it('lets the connector caller pre-assign a new person only, never link one who exists', async () => {
    const t = table();
    const answer = await provisioner(t, 'connectors')(request({ appInstanceUserArn: `${APP}/user/0190a000-0000-7000-8000-000000000001` }));
    expect(answer).toMatchObject({ ok: false, code: 'NOT_THIS_CALLER' });
    expect(t.writes).toEqual([]);
  });

  it('lets an administrator link a subject to a person who exists, and nobody else', async () => {
    const t = table();
    const person = `${APP}/user/0190a000-0000-7000-8000-000000000001`;
    expect(await provisioner(t, 'admin')(request({ appInstanceUserArn: person, actor: `${APP}/user/admin-person` }))).toEqual({ ok: true, state: 'provisioned', personArn: person });
    expect(t.rows.get(`salesforce-org|${SUBJECT}`)).toMatchObject({ personArn: person, status: 'pending', provisionedBy: 'admin' });
    const t2 = table();
    const missing = provisioner(t2, 'admin', ['salesforce-org'], async () => false);
    expect(await missing(request({ appInstanceUserArn: person }))).toMatchObject({ ok: false, code: 'UNKNOWN_PERSON' });
    for (const arn of [`arn:aws:chime:us-east-1:111122223333:app-instance/other/user/0190a000-0000-7000-8000-000000000001`, `${APP}/user/0190a000-0000-7000-8000-000000000001-admin`, `${APP}/bot/x`]) {
      expect(await provisioner(t2, 'admin')(request({ appInstanceUserArn: arn }))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    }
    expect(t2.writes).toEqual([]);
  });

  it('never changes a row that exists, and leaves a revoked subject revoked', async () => {
    const t = table();
    const active = { issuerSubject: `salesforce-org|${SUBJECT}`, personArn: `${APP}/user/someone`, issuer: 'salesforce-org', status: 'active' };
    t.rows.set(active.issuerSubject, active);
    expect(await provisioner(t, 'connectors')(request())).toEqual({ ok: true, state: 'exists', status: 'active' });
    expect(t.rows.get(active.issuerSubject)).toBe(active);
    const r = table();
    r.rows.set(revokedMarkerKey('salesforce-org', SUBJECT), { issuerSubject: revokedMarkerKey('salesforce-org', SUBJECT) });
    expect(await provisioner(r, 'connectors')(request())).toEqual({ ok: true, state: 'exists', status: 'revoked' });
    expect(r.writes).toEqual([]);
  });

  it('writes one row when two provisions race', async () => {
    const t = table();
    const p = provisioner(t, 'connectors');
    const answers = await Promise.all([p(request()), p(request())]);
    expect(answers.map((a) => (a as { state?: string }).state).sort()).toEqual(['exists', 'provisioned']);
    expect(t.writes).toHaveLength(1);
  });
});

describe('a pending row is bound once, by its own issuer, at the first sign-in', () => {
  const seed = (t: ReturnType<typeof table>, issuer = 'salesforce-org') => provisionSubject({ issuer, subject: SUBJECT, provisionedBy: 'connectors' }, t.deps);

  it('binds to the pre-assigned person and creates them then', async () => {
    const t = table();
    const seeded = await seed(t);
    const person = await bindProvisionedPerson({ issuer: 'salesforce-org', subject: SUBJECT, name: 'Rep' }, t.deps);
    expect(person.personArn).toBe((seeded as { personArn: string }).personArn);
    expect(t.rows.get(`salesforce-org|${SUBJECT}`)!.status).toBe('active');
    expect(t.chime.send.mock.calls.map((c) => c[0].constructor.name)).toEqual(['CreateAppInstanceUserCommand']);
  });

  it('refuses a subject nobody provisioned, and a revoked one, creating nothing', async () => {
    const t = table();
    await expect(bindProvisionedPerson({ issuer: 'salesforce-org', subject: SUBJECT }, t.deps)).rejects.toBeInstanceOf(PersonNotProvisioned);
    t.rows.set(revokedMarkerKey('salesforce-org', SUBJECT), { issuerSubject: revokedMarkerKey('salesforce-org', SUBJECT) });
    await expect(bindProvisionedPerson({ issuer: 'salesforce-org', subject: SUBJECT }, t.deps)).rejects.toBeInstanceOf(PersonNotActive);
    expect(t.writes).toEqual([]);
    expect(t.chime.send).not.toHaveBeenCalled();
  });

  it('binds one person when two first sign-ins race', async () => {
    const t = table();
    await seed(t);
    const [a, b] = await Promise.all([
      bindProvisionedPerson({ issuer: 'salesforce-org', subject: SUBJECT }, t.deps),
      bindProvisionedPerson({ issuer: 'salesforce-org', subject: SUBJECT }, t.deps),
    ]);
    expect(a.personArn).toBe(b.personArn);
    expect(t.writes.filter((w) => w.startsWith('bind'))).toHaveLength(1);
  });

  it('is never minted a second person, and a pending row of one issuer is refused for another', async () => {
    const t = table();
    await seed(t);
    // The minter, which every other issuer uses, refuses a pending row outright.
    await expect(mintOrResolvePerson({ issuer: 'salesforce-org', subject: SUBJECT }, t.deps)).rejects.toMatchObject({ status: 'pending' });
    // A row written under this key for another issuer's subject is not this issuer's to bind.
    const key = `salesforce-org|${SUBJECT}`;
    t.rows.set(key, { ...t.rows.get(key)!, issuer: 'partner' });
    await expect(bindProvisionedPerson({ issuer: 'salesforce-org', subject: SUBJECT }, t.deps)).rejects.toMatchObject({ status: 'another-issuer' });
    expect(t.rows.get(key)!.status).toBe('pending');
  });

  it('is the edge\'s pending state for its own issuer, and a refusal for any other', async () => {
    const t = table();
    await seed(t);
    expect(await identityStateOf('salesforce-org', SUBJECT, t.deps)).toMatchObject({ state: 'pending' });
    const key = `salesforce-org|${SUBJECT}`;
    t.rows.set(key, { ...t.rows.get(key)!, issuer: 'partner' });
    expect(await identityStateOf('salesforce-org', SUBJECT, t.deps)).toEqual({ state: 'refused', status: 'pending' });
  });
});
