/**
 * THE DIRECTORY IS ASKED BY PERSON (`lambda/src/lib/membership-source.ts`).
 *
 * A person is their AppInstanceUser. Which subjects sign in as them lives only in `Identities`, so every
 * question about a person - their name, where to reach them, their clearance groups - reaches their
 * issuer subject through the `byPerson` reverse lookup and asks THAT issuer's adapter, and a subject
 * becomes a person only through `resolvePerson`. Nothing here derives a person from a subject, binds one
 * by an address, or reads an id's shape.
 *
 * Driven through the real directory with the pools and the `Identities` lookups faked at their edges.
 */
import type { ClearanceSource } from '../../lambda/src/lib/clearance-source';
import { poolIssuer, testDirectory } from '../helpers/directory';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const person = (id: string) => `${APP}/user/${id}`;
const HOME = 'us-east-1_HOME';
const PARTNER = 'us-east-1_PARTNER';
/** Each pool's REGISTRY id: the issuer half of every `Identities` key its subjects sign in under. */
const iss = (pool: string) => (pool === HOME ? 'deployment' : 'partner');

const ALICE = '0192f0e0-0000-7000-8000-00000000a11c';
const PAT = '0192f0e0-0000-7000-8000-000000000ba7';

type User = { Username: string; Enabled?: boolean; Attributes: Array<{ Name: string; Value: string }> };

/** A pool holding the given users, answering AdminGetUser, ListUsers (by email) and ListUsersInGroup. */
function pool(users: Record<string, User>, groups: Record<string, string[]> = {}) {
  const asked: string[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, string> }) => {
      const name = cmd.constructor.name;
      asked.push(`${name}:${cmd.input.Username ?? cmd.input.Filter ?? cmd.input.GroupName}`);
      if (name === 'AdminGetUserCommand') {
        const u = users[cmd.input.Username];
        if (!u) throw Object.assign(new Error('nope'), { name: 'UserNotFoundException' });
        return { Username: u.Username, Enabled: u.Enabled, UserAttributes: u.Attributes };
      }
      if (name === 'ListUsersCommand') {
        const address = /email = "([^"]+)"/.exec(cmd.input.Filter)?.[1];
        return { Users: Object.values(users).filter((u) => u.Attributes.some((a) => a.Name === 'email' && a.Value === address)) };
      }
      if (name === 'ListUsersInGroupCommand') return { Users: (groups[cmd.input.GroupName] || []).map((s) => users[s]) };
      throw new Error(`unexpected ${name}`);
    },
  };
  return { client, asked };
}

const user = (sub: string, attrs: Record<string, string>, enabled = true): User => ({
  Username: `${sub}-username`,
  Enabled: enabled,
  Attributes: [{ Name: 'sub', Value: sub }, ...Object.entries(attrs).map(([Name, Value]) => ({ Name, Value }))],
});

function build(opts: {
  home: Record<string, User>;
  partner?: Record<string, User>;
  groups?: Record<string, string[]>;
  identities: Record<string, Array<{ issuer: string; subject: string }>>;
  clearance?: ClearanceSource | null;
  /** The classifications this deployment's own pool clears for, where narrower than every one. */
  homeClassifications?: string[];
}) {
  const home = pool(opts.home, opts.groups);
  const partner = pool(opts.partner || {});
  const resolveCalls: string[] = [];
  const directory = testDirectory({
    appInstanceArn: APP,
    issuers: [
      {
        issuer: poolIssuer('deployment', HOME, opts.homeClassifications ? { clearance: { groups: true, classifications: opts.homeClassifications } } : {}),
        client: home.client, ...(opts.clearance ? { groups: opts.clearance } : {}),
      },
      // The partner pool is trusted for names and contacts; its groups are not clearances here.
      { issuer: poolIssuer('partner', PARTNER, { clearance: { fixed: ['basic'], classifications: ['basic'] } }), client: partner.client },
    ],
    identities: {
      subjectsOf: async (arn) => opts.identities[arn] || [],
      resolve: async (issuer, subject) => {
        resolveCalls.push(`${issuer}|${subject}`);
        const hit = Object.entries(opts.identities).find(([, subs]) => subs.some((s) => s.issuer === issuer && s.subject === subject));
        return hit ? hit[0] : null;
      },
    },
  });
  return { directory, home, partner, resolveCalls };
}

describe('displayNameFor', () => {
  it('names a person from the record their subject has, never from their id', async () => {
    const { directory, home } = build({
      home: { 'home-sub': user('home-sub', { name: 'Alice Chen', email: 'alice@example.com' }) },
      identities: { [person(ALICE)]: [{ issuer: iss(HOME), subject: 'home-sub' }] },
    });
    expect(await directory.displayNameFor(person(ALICE))).toBe('Alice Chen');
    expect(home.asked).toEqual(['AdminGetUserCommand:home-sub']);
  });

  it('never answers an address: a record with only an email is named by its local part', async () => {
    const { directory } = build({
      home: { s: user('s', { email: 'riley.oncall@example.com' }) },
      identities: { [person(ALICE)]: [{ issuer: iss(HOME), subject: 's' }] },
    });
    expect(await directory.displayNameFor(person(ALICE))).toBe('riley.oncall');
  });

  it('names a person of another trusted issuer from THAT issuer\'s record', async () => {
    const { directory, home, partner } = build({
      home: {},
      partner: { 'partner-sub': user('partner-sub', { given_name: 'Pat', family_name: 'Lee' }) },
      identities: { [person(PAT)]: [{ issuer: iss(PARTNER), subject: 'partner-sub' }] },
    });
    expect(await directory.displayNameFor(person(PAT))).toBe('Pat Lee');
    expect(home.asked).toEqual([]);
    expect(partner.asked).toEqual(['AdminGetUserCommand:partner-sub']);
  });

  it('is null for a person nobody signs in as, and for an assistant', async () => {
    const { directory } = build({ home: {}, identities: {} });
    expect(await directory.displayNameFor(person('nobody'))).toBeNull();
    expect(await directory.displayNameFor(`${APP}/bot/advisor`)).toBeNull();
  });
});

describe('contactFor', () => {
  it('resolves the email route from the issuer subject, at send time', async () => {
    const { directory } = build({
      home: { s: user('s', { name: 'Alice', email: 'alice@example.com' }) },
      identities: { [person(ALICE)]: [{ issuer: iss(HOME), subject: 's' }] },
    });
    expect(await directory.contactFor(person(ALICE), 'email')).toEqual({ route: 'email', address: 'alice@example.com', name: 'Alice' });
  });

  it('a non-pool person resolves a contact through the pool that holds their subject', async () => {
    const { directory } = build({
      home: {},
      partner: { p: user('p', { email: 'pat@partner.example' }) },
      identities: { [person(PAT)]: [{ issuer: iss(PARTNER), subject: 'p' }] },
    });
    expect(await directory.contactFor(person(PAT), 'email')).toMatchObject({ address: 'pat@partner.example' });
  });

  it('is null, and never throws, for an untrusted issuer or a failed read', async () => {
    const { directory } = build({
      home: {},
      identities: { [person(PAT)]: [{ issuer: 'https://idp.untrusted.example', subject: 'p' }] },
    });
    expect(await directory.contactFor(person(PAT), 'email')).toBeNull();
    const broken = testDirectory({
      appInstanceArn: APP,
      issuers: [{ issuer: poolIssuer('deployment', HOME), client: { send: async () => { throw new Error('throttled'); } } }],
      identities: { resolve: async () => null, subjectsOf: async () => [{ issuer: iss(HOME), subject: 's' }] },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await broken.contactFor(person(ALICE), 'email')).toBeNull();
    warn.mockRestore();
  });

  it('answers the email route only', async () => {
    const { directory } = build({
      home: { s: user('s', { email: 'alice@example.com' }) },
      identities: { [person(ALICE)]: [{ issuer: iss(HOME), subject: 's' }] },
    });
    expect(await directory.contactFor(person(ALICE), 'sms' as never)).toBeNull();
  });
});

describe('findByAddress', () => {
  it('finds the subject an address names in ONE issuer\'s directory, and resolves it like a sign-in', async () => {
    const { directory, resolveCalls } = build({
      home: { s: user('s', { email: 'alice@example.com' }) },
      identities: { [person(ALICE)]: [{ issuer: iss(HOME), subject: 's' }] },
    });
    expect(await directory.findByAddress(iss(HOME), 'alice@example.com')).toBe(person(ALICE));
    expect(resolveCalls).toEqual([`${iss(HOME)}|s`]);
  });

  it('resolves to nobody for an address no subject carries, a subject never signed in, or two subjects', async () => {
    const { directory } = build({
      home: {
        s: user('s', { email: 'new@example.com' }),
        d1: user('d1', { email: 'shared@example.com' }),
        d2: user('d2', { email: 'shared@example.com' }),
      },
      identities: {},
    });
    expect(await directory.findByAddress(iss(HOME), 'nobody@example.com')).toBeNull();
    expect(await directory.findByAddress(iss(HOME), 'new@example.com')).toBeNull();
    expect(await directory.findByAddress(iss(HOME), 'shared@example.com')).toBeNull();
  });

  it('never looks in another issuer\'s directory, and refuses an untrusted one', async () => {
    const { directory, partner } = build({
      home: {},
      partner: { p: user('p', { email: 'pat@partner.example' }) },
      identities: { [person(PAT)]: [{ issuer: iss(PARTNER), subject: 'p' }] },
    });
    expect(await directory.findByAddress(iss(HOME), 'pat@partner.example')).toBeNull();
    expect(partner.asked).toEqual([]);
    expect(await directory.findByAddress('https://idp.untrusted.example', 'pat@partner.example')).toBeNull();
  });

  it('never interpolates an address the filter grammar cannot carry', async () => {
    const { directory, home } = build({ home: {}, identities: {} });
    expect(await directory.findByAddress(iss(HOME), 'x" or email ^= "')).toBeNull();
    expect(home.asked).toEqual([]);
  });
});

describe('groupsFor and personsInGroup', () => {
  const clearance: ClearanceSource = { name: 'test', groupsFor: async (subject) => (subject === 's' ? ['premium'] : []) };

  it('reads a person\'s groups for their subject in this deployment\'s pool', async () => {
    const { directory } = build({ home: {}, clearance, identities: { [person(ALICE)]: [{ issuer: iss(HOME), subject: 's' }] } });
    expect(await directory.groupsFor(person(ALICE))).toEqual(['premium']);
  });

  it('is null for a person with no subject in any trusted directory that keeps groups', async () => {
    const { directory } = build({ home: {}, clearance, identities: { [person(PAT)]: [{ issuer: 'https://idp.untrusted.example', subject: 'p' }] } });
    expect(await directory.groupsFor(person(PAT))).toBeNull();
    expect(await directory.clearedByGroups(person(PAT))).toBeNull();
  });

  it('clears from those groups only within the issuer\'s own classifications, as the exchange does', async () => {
    const identities = { [person(ALICE)]: [{ issuer: iss(HOME), subject: 's' }] };
    expect(await build({ home: {}, clearance, identities }).directory.clearedByGroups(person(ALICE))).toContain('premium');
    // The pool's groups name premium, but this pool clears for basic and standard only: premium is not held.
    const bounded = await build({ home: {}, clearance, identities, homeClassifications: ['basic', 'standard'] }).directory.clearedByGroups(person(ALICE));
    expect(bounded).not.toContain('premium');
  });

  it('lists a group\'s enabled members as people; a disabled one is out and an unminted one undetermined', async () => {
    const { directory } = build({
      home: { a: user('a', {}), b: user('b', {}, false), c: user('c', {}) },
      groups: { ops: ['a', 'b', 'c'] },
      identities: { [person(ALICE)]: [{ issuer: iss(HOME), subject: 'a' }] },
    });
    expect(await directory.personsInGroup('ops')).toEqual({ persons: [person(ALICE)], unminted: ['c'] });
  });
});
