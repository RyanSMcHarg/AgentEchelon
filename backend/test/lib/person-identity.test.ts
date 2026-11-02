/**
 * THE ONE MINTER (lambda/src/lib/person-identity.ts).
 *
 * A person is minted once per (issuer, subject) as an opaque UUID v7 AppInstanceUser, reserved in the
 * Identities table BEFORE the AppInstanceUser is created, so a race between two first sign-ins yields
 * one row and one AppInstanceUser. A Cognito `sub` is a UUID v4, which is why the version is asserted.
 */
// The real resolver: every other suite has `resolvePerson` answered in memory (test/setup/person-resolver.ts).
jest.unmock('../../lambda/src/lib/person-identity');
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  GetCommand: jest.fn((input: unknown) => ({ __type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ __type: 'Query', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn(() => ({ send: jest.fn() })),
  CreateAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'CreateAppInstanceUser', input })),
  DescribeAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'DescribeAppInstanceUser', input })),
}));

import {
  clearPersonCache,
  displayNameFor,
  IDENTITY_STATUSES,
  issuerSubjectKey,
  mintOrResolvePerson,
  mintPersonId,
  PersonNotActive,
  resolvePerson,
  revokedMarkerKey,
  subjectsOfPerson,
  uuidv7,
  uuidVersion,
  type PersonIdentityDeps,
} from '../../lambda/src/lib/person-identity';

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
const ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool';
const SUB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'; // a Cognito sub: UUID v4

const conflict = () => Object.assign(new Error('exists'), { name: 'ConflictException' });
const tick = () => new Promise((r) => setImmediate(r));

/** A DynamoDB that honours `attribute_not_exists`, and yields between calls so concurrent callers interleave. */
function fakeTable() {
  const rows = new Map<string, any>();
  const doc = {
    send: jest.fn(async (cmd: { __type: string; input: any }) => {
      await tick();
      if (cmd.__type === 'Get') return { Item: rows.get(cmd.input.Key.issuerSubject) };
      if (cmd.__type === 'Put') {
        const k = cmd.input.Item.issuerSubject;
        if (cmd.input.ConditionExpression === 'attribute_not_exists(issuerSubject)' && rows.has(k)) {
          throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
        }
        rows.set(k, cmd.input.Item);
        return {};
      }
      throw new Error(`unexpected ${cmd.__type}`);
    }),
  };
  return { rows, doc };
}

/** An Amazon Chime SDK identity service: one AppInstanceUser per id, ConflictException on a second. */
function fakeChime() {
  const users = new Map<string, { Name: string }>();
  const created: string[] = [];
  const chime = {
    send: jest.fn(async (cmd: { __type: string; input: any }) => {
      await tick();
      if (cmd.__type === 'CreateAppInstanceUser') {
        if (users.has(cmd.input.AppInstanceUserId)) throw conflict();
        users.set(cmd.input.AppInstanceUserId, { Name: cmd.input.Name });
        created.push(cmd.input.AppInstanceUserId);
        return {};
      }
      if (cmd.__type === 'DescribeAppInstanceUser') {
        const id = String(cmd.input.AppInstanceUserArn).split('/').pop() as string;
        if (!users.has(id)) throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
        return { AppInstanceUser: users.get(id) };
      }
      throw new Error(`unexpected ${cmd.__type}`);
    }),
  };
  return { users, created, chime };
}

function world() {
  const t = fakeTable();
  const c = fakeChime();
  const audit = jest.fn(async () => undefined);
  const deps: PersonIdentityDeps = { doc: t.doc, chime: c.chime, table: 'identities', appInstanceArn: APP, audit };
  return { ...t, ...c, audit, deps };
}

beforeEach(() => {
  clearPersonCache();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the person id', () => {
  it('is a UUID v7, with the RFC 9562 variant, and time-ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidVersion(a)).toBe(7);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });

  it('reads a Cognito sub as a v4, and refuses to mint one', () => {
    expect(uuidVersion(SUB)).toBe(4);
    expect(uuidVersion('fed_abc')).toBeNull();
    expect(() => mintPersonId(() => SUB)).toThrow(/UUID v7/);
    expect(uuidVersion(mintPersonId())).toBe(7);
  });

  it('keys a row on issuer and subject, and the offboarding marker on a hash of the subject', () => {
    expect(issuerSubjectKey(ISS, SUB)).toBe(`${ISS}|${SUB}`);
    const marker = revokedMarkerKey(ISS, SUB);
    expect(marker).toMatch(new RegExp(`^revoked#${ISS.replace(/[.]/g, '\\.')}#[0-9a-f]{64}$`));
    expect(marker).not.toContain(SUB);
    expect(() => issuerSubjectKey('', SUB)).toThrow();
  });

  it('names a person by a display name, never an address', () => {
    expect(displayNameFor('Jane Doe', 'id')).toBe('Jane Doe');
    expect(displayNameFor('jane@example.com', 'id')).toBe('jane');
    expect(displayNameFor('@example.com', 'id-1')).toBe('id-1');
    expect(displayNameFor('', 'id-1')).toBe('id-1');
  });
});

describe('mintOrResolvePerson', () => {
  it('mints on the first sign-in: the row is reserved before the AppInstanceUser is created', async () => {
    const w = world();
    const p = await mintOrResolvePerson({ issuer: ISS, subject: SUB, name: 'jane@example.com' }, w.deps);
    expect(uuidVersion(p.personId)).toBe(7);
    expect(p.personId).not.toBe(SUB);
    expect(p.created).toBe(true);
    expect(p.personArn).toBe(`${APP}/user/${p.personId}`);
    expect(w.rows.get(`${ISS}|${SUB}`)).toMatchObject({ personArn: p.personArn, issuer: ISS, status: 'active' });
    // Reserved first: the row, then the offboarding marker, are read; the conditional put precedes the create.
    const order = [...w.doc.send.mock.calls.map((c) => c[0].__type), ...w.chime.send.mock.calls.map((c) => c[0].__type)];
    expect(order).toEqual(['Get', 'Get', 'Put', 'CreateAppInstanceUser']);
    expect(w.doc.send.mock.calls[1][0].input.Key.issuerSubject).toBe(revokedMarkerKey(ISS, SUB));
    const put = w.doc.send.mock.calls.find((c) => c[0].__type === 'Put')![0].input;
    expect(put.ConditionExpression).toBe('attribute_not_exists(issuerSubject)');
    expect(w.users.get(p.personId)!.Name).toBe('jane');
    expect(w.audit).toHaveBeenCalledWith(expect.objectContaining({ _auditEvent: 'identity_minted', issuer: ISS, personArn: p.personArn }));
  });

  it('resolves the same ARN on every sign-in after, and writes no second row', async () => {
    const w = world();
    const first = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    const again = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    expect(again.personArn).toBe(first.personArn);
    expect(again.created).toBe(false);
    expect(w.rows.size).toBe(1);
    expect(w.audit).toHaveBeenCalledTimes(1);
  });

  it('gives another subject, or the same subject under another issuer, a different person', async () => {
    const w = world();
    const a = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    const b = await mintOrResolvePerson({ issuer: ISS, subject: 'other' }, w.deps);
    const c = await mintOrResolvePerson({ issuer: 'https://issuer.example', subject: SUB }, w.deps);
    expect(new Set([a.personId, b.personId, c.personId]).size).toBe(3);
  });

  it('ten concurrent first sign-ins yield one row and one AppInstanceUser', async () => {
    const w = world();
    const results = await Promise.all(Array.from({ length: 10 }, () => mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps)));
    expect(new Set(results.map((r) => r.personArn)).size).toBe(1);
    expect(w.rows.size).toBe(1);
    expect(w.created).toHaveLength(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    // Every loser of the reservation re-read the winner's row rather than creating with its own id.
    expect(w.created[0]).toBe(results[0].personId);
  });

  it('keeps an existing AppInstanceUser on ConflictException, and repairs a reserved row whose create failed', async () => {
    const w = world();
    // The first sign-in reserves the row, then its create fails.
    w.chime.send.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps)).rejects.toThrow('throttled');
    const reserved = w.rows.get(`${ISS}|${SUB}`).personArn;
    // The next sign-in creates it under the reserved id.
    const healed = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    expect(healed.personArn).toBe(reserved);
    expect(healed.created).toBe(true);
    // And one after that hits ConflictException and keeps it.
    const kept = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    expect(kept).toMatchObject({ personArn: reserved, created: false });
  });

  it('refuses a row that is not active (a pending or revoked one), and creates nothing', async () => {
    for (const status of ['pending', 'revoked']) {
      const w = world();
      w.rows.set(`${ISS}|${SUB}`, { issuerSubject: `${ISS}|${SUB}`, personArn: `${APP}/user/${uuidv7()}`, status });
      await expect(mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps)).rejects.toBeInstanceOf(PersonNotActive);
      expect(w.chime.send).not.toHaveBeenCalled();
    }
  });

  it('never re-mints an offboarded subject: a revoked marker refuses the sign-in and creates nothing', async () => {
    const w = world();
    w.rows.set(revokedMarkerKey(ISS, SUB), { issuerSubject: revokedMarkerKey(ISS, SUB) });
    await expect(mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps)).rejects.toMatchObject({ name: 'PersonNotActive', status: 'revoked' });
    expect(w.chime.send).not.toHaveBeenCalled();
    expect(w.doc.send.mock.calls.map((c) => c[0].__type)).toEqual(['Get', 'Get']);
    expect([...w.rows.keys()]).toEqual([revokedMarkerKey(ISS, SUB)]);
    // And a token for the subject, issued before the offboarding, resolves to nobody.
    expect(await resolvePerson(ISS, SUB, w.deps)).toBeNull();
  });

  it('still mints when the access log cannot take the record, and says so as a security event', async () => {
    const w = world();
    w.audit.mockRejectedValueOnce(new Error('down'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    expect(p.created).toBe(true);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.anything());
  });

  it('refuses to run without its table', async () => {
    const w = world();
    await expect(mintOrResolvePerson({ issuer: ISS, subject: SUB }, { ...w.deps, table: '' })).rejects.toThrow(/IDENTITIES_TABLE/);
  });
});

describe('resolvePerson', () => {
  it('resolves a minted person, and never writes', async () => {
    const w = world();
    const p = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    w.doc.send.mockClear();
    w.chime.send.mockClear();
    expect(await resolvePerson(ISS, SUB, w.deps)).toBe(p.personArn);
    const types = [...w.doc.send.mock.calls, ...w.chime.send.mock.calls].map((c) => c[0].__type);
    expect(types).toEqual(['Get', 'DescribeAppInstanceUser']);
  });

  it('resolves nothing for an unknown subject, and mints nothing', async () => {
    const w = world();
    expect(await resolvePerson(ISS, SUB, w.deps)).toBeNull();
    expect(w.rows.size).toBe(0);
    expect(w.chime.send).not.toHaveBeenCalled();
  });

  it('resolves nothing for a row whose AppInstanceUser is gone', async () => {
    const w = world();
    const p = await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    w.users.delete(p.personId);
    expect(await resolvePerson(ISS, SUB, w.deps)).toBeNull();
  });

  it('resolves nothing for a row that is not active', async () => {
    const w = world();
    w.rows.set(`${ISS}|${SUB}`, { issuerSubject: `${ISS}|${SUB}`, personArn: `${APP}/user/${uuidv7()}`, status: 'revoked' });
    expect(await resolvePerson(ISS, SUB, w.deps)).toBeNull();
  });

  it('checks the AppInstanceUser only on a cache miss, and reads the row every time', async () => {
    const w = world();
    await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    await resolvePerson(ISS, SUB, w.deps);
    w.doc.send.mockClear();
    w.chime.send.mockClear();
    expect(await resolvePerson(ISS, SUB, w.deps)).toMatch(/\/user\//);
    expect(w.doc.send.mock.calls.map((c) => c[0].__type)).toEqual(['Get']);
    expect(w.chime.send).not.toHaveBeenCalled();
  });

  it('has no suspended status: the row keeps no copy of the identity provider\'s state', () => {
    expect([...IDENTITY_STATUSES]).toEqual(['active', 'revoked', 'pending']);
  });

  it('stops resolving an erased subject on the next call, in the same container', async () => {
    const w = world();
    await mintOrResolvePerson({ issuer: ISS, subject: SUB }, w.deps);
    await resolvePerson(ISS, SUB, w.deps);
    w.rows.delete(`${ISS}|${SUB}`);
    expect(await resolvePerson(ISS, SUB, w.deps)).toBeNull();
  });
});

describe('subjectsOfPerson', () => {
  const ARN = `${APP}/user/${uuidv7()}`;
  const doc = {
    send: jest.fn(async () => ({
      Items: [
        { issuerSubject: `${ISS}|active-sub`, personArn: ARN, status: 'active' },
        { issuerSubject: `${ISS}|pending-sub`, personArn: ARN, status: 'pending' },
      ],
    })),
  };

  it('answers only active sign-ins by default, so a pending one holds nothing', async () => {
    expect(await subjectsOfPerson(ARN, { doc, table: 'identities' })).toEqual([{ issuer: ISS, subject: 'active-sub' }]);
  });

  it('answers a pending sign-in too when asked for any status (whether an invitee is anybody\'s yet)', async () => {
    expect(await subjectsOfPerson(ARN, { doc, table: 'identities' }, { anyStatus: true })).toEqual([
      { issuer: ISS, subject: 'active-sub' },
      { issuer: ISS, subject: 'pending-sub' },
    ]);
  });
});
