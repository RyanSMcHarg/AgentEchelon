/**
 * A FEDERATED POOL ACCOUNT IS ADDRESSED BY ITS USERNAME, AND IS ONE OF THE POOL'S PEOPLE
 * (SPEC-CREDENTIAL-EXCHANGE §4b, "A pool's people are every entry on the pool").
 *
 * Cognito accepts a `sub` as `Username` for a LOCAL user only: "must be the sub of a local user or the
 * username of a user from a third-party IdP" (AdminGetUser, AdminListGroupsForUser). A person who signed
 * in through a provider on the pool is a pool account named `<providerName>_<id>`, and their
 * `Identities` row is keyed under their own `cognito-federated` entry's id, never the pool's. Before this,
 * their groups, name and enabled state were unreadable, and offboarding left their pool account behind.
 *
 * The fake Cognito client below enforces that rule, which the offboarding world's pool does not.
 */
import { __clearFederatedUsernamesForTests, cognitoPoolDirectory } from '../../lambda/src/lib/cognito-pool-directory';
import { CognitoClearanceSource } from '../../lambda/src/lib/clearance-source';
import { convergeSubject, offboardPerson, sweepPool } from '../../lambda/src/lib/offboarding';
import { revokedMarkerKey } from '../../lambda/src/lib/person-identity';
import { ISS, POOL_ID, offboardingWorld } from '../setup/offboarding-world';
import { poolIssuer, testDirectory } from '../helpers/directory';

const LOCAL_SUB = '11111111-1111-4111-8111-111111111111';
const FED_SUB = '22222222-2222-4222-8222-222222222222';
const FED_USERNAME = 'CorpSSO_8f2a1c';
const FED_ISS = 'corp-sso';

type User = { Username: string; sub: string; federated: boolean; groups: string[]; enabled?: boolean };

/** A pool that answers as Cognito does: a `sub` addresses a local user only. */
function realisticPool(users: User[], opts: { listUsersFails?: boolean } = {}) {
  const calls: string[] = [];
  const named = (name: string) => Object.assign(new Error(name), { name });
  const byUsername = (u: string) => users.find((x) => x.Username === u || (!x.federated && x.sub === u));
  const client = {
    send: jest.fn(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      const k = cmd.constructor.name;
      const i = cmd.input;
      calls.push(`${k}:${i.Username ?? i.Filter ?? ''}`);
      if (k === 'ListUsersCommand') {
        if (opts.listUsersFails) throw named('TooManyRequestsException');
        const m = /^sub = "(.+)"$/.exec(i.Filter || '');
        const hit = m ? users.filter((u) => u.sub === m[1]) : [];
        return { Users: hit.map((u) => ({ Username: u.Username, Attributes: [{ Name: 'sub', Value: u.sub }], Enabled: true })) };
      }
      const u = byUsername(i.Username);
      if (!u) throw named('UserNotFoundException');
      if (k === 'AdminGetUserCommand') return { Username: u.Username, UserAttributes: [{ Name: 'sub', Value: u.sub }, { Name: 'email', Value: `${u.Username}@example.com` }], Enabled: u.enabled !== false };
      if (k === 'AdminListGroupsForUserCommand') return { Groups: u.groups.map((GroupName) => ({ GroupName })) };
      throw new Error(`unexpected ${k}`);
    }),
  };
  return { client, calls };
}

const USERS: User[] = [
  { Username: 'jane@example.com', sub: LOCAL_SUB, federated: false, groups: ['standard'] },
  { Username: FED_USERNAME, sub: FED_SUB, federated: true, groups: ['premium'] },
];

describe('the pool directory addresses a federated person by their pool username', () => {
  beforeEach(() => __clearFederatedUsernamesForTests());

  it('reads a federated person\'s record by their sub, through the username ListUsers finds', async () => {
    const { client, calls } = realisticPool(USERS);
    const record = await cognitoPoolDirectory(POOL_ID, client).record(FED_SUB);
    expect(record).toMatchObject({ subject: FED_SUB, username: FED_USERNAME });
    expect(calls).toEqual([`AdminGetUserCommand:${FED_SUB}`, `ListUsersCommand:sub = "${FED_SUB}"`, `AdminGetUserCommand:${FED_USERNAME}`]);
  });

  it('asks for a federated person by their pool username once it has resolved them', async () => {
    const { client, calls } = realisticPool(USERS);
    const dir = cognitoPoolDirectory(POOL_ID, client);
    await dir.record(FED_SUB);
    calls.length = 0;
    expect(await dir.record(FED_SUB)).toMatchObject({ username: FED_USERNAME });
    expect(calls).toEqual([`AdminGetUserCommand:${FED_USERNAME}`]);
  });

  it('reads a local person by their sub in one call, as before', async () => {
    const { client, calls } = realisticPool(USERS);
    expect(await cognitoPoolDirectory(POOL_ID, client).record(LOCAL_SUB)).toMatchObject({ username: 'jane@example.com' });
    expect(calls).toHaveLength(1);
  });

  it('answers "no account" only when no user carries the sub', async () => {
    const { client } = realisticPool(USERS);
    expect(await cognitoPoolDirectory(POOL_ID, client).record('33333333-3333-4333-8333-333333333333')).toBeNull();
  });

  it('throws, never "no account", when the pool cannot be asked', async () => {
    const { client } = realisticPool(USERS, { listUsersFails: true });
    await expect(cognitoPoolDirectory(POOL_ID, client).record(FED_SUB)).rejects.toMatchObject({ name: 'TooManyRequestsException' });
  });

  it('asks whether a federated person\'s account may sign in by their pool username (the vend\'s live read)', async () => {
    const { client, calls } = realisticPool([USERS[0], { ...USERS[1], enabled: false }]);
    const dir = testDirectory({
      appInstanceArn: 'arn:aws:chime:us-east-1:111:app-instance/abc',
      issuers: [{ issuer: poolIssuer(FED_ISS, POOL_ID, { kind: 'cognito-federated' }), client }],
      identities: { resolve: async () => null, subjectsOf: async () => [] },
    });
    expect(await dir.accountState(FED_ISS, FED_SUB)).toBe('disabled');
    expect(calls).toContain(`AdminGetUserCommand:${FED_USERNAME}`);
    expect(await dir.accountState(FED_ISS, '33333333-3333-4333-8333-333333333333')).toBe('gone');
  });

  it('reads a federated person\'s pool groups by their sub', async () => {
    const { client } = realisticPool(USERS);
    expect(await new CognitoClearanceSource(client as never, POOL_ID).groupsFor(FED_SUB)).toEqual(['premium']);
    expect(await new CognitoClearanceSource(client as never, POOL_ID).groupsFor(LOCAL_SUB)).toEqual(['standard']);
  });
});

describe('offboarding treats every entry on the pool as the pool\'s people', () => {
  const PERSON = '01928a3b-1c2d-7e4f-8a9b-0c1d2e3f4a5c';

  function federatedWorld() {
    const w = offboardingWorld();
    (w.primary as { issuers?: string[] }).issuers = [ISS, FED_ISS];
    const arn = w.seedPerson(PERSON, [{ issuer: FED_ISS, subject: FED_SUB }]);
    w.seedAccount(POOL_ID, { subject: FED_SUB, username: FED_USERNAME, email: 'fed@example.com', enabled: true });
    return { w, arn, row: () => w.identities.get(`${FED_ISS}|${FED_SUB}`) };
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('deletes a federated person\'s pool account, by its username, when they are offboarded', async () => {
    const { w, arn } = federatedWorld();
    const result = await offboardPerson(arn, { arn: 'console' }, w.deps);
    expect(result.removed.poolAccount).toBe(1);
    expect(w.pools.get(POOL_ID)!.has(FED_SUB)).toBe(false);
    expect(w.cognitoCalls.filter((c) => c.command === 'AdminDeleteUserCommand').map((c) => c.input.Username)).toEqual([FED_USERNAME]);
    expect(w.identities.has(revokedMarkerKey(FED_ISS, FED_SUB))).toBe(true);
  });

  it('leaves a federated person whose pool account is disabled as they are: the vend refuses them, not offboarding', async () => {
    const { w, arn, row } = federatedWorld();
    w.pools.get(POOL_ID)!.get(FED_SUB)!.enabled = false;
    expect(await convergeSubject(w.primary, FED_SUB, { arn: 'issuer-event' }, w.deps)).toBe('unchanged');
    expect(row()!.status).toBe('active');
    expect(w.users.has(arn)).toBe(true);
  });

  it('leaves a live federated pool account unchanged when the sweep passes over it', async () => {
    const { w, arn, row } = federatedWorld();
    const counts = await sweepPool(w.primary, w.deps);
    expect(counts.erased).toBe(0);
    expect(w.users.has(arn)).toBe(true);
    expect(row()!.status).toBe('active');
  });
});
