/**
 * EACH ISSUER IS ASKED THROUGH ITS OWN SEAMS (C1-C5).
 *
 * A person's name, contact, groups and clearance are asked of `Directory` by AppInstanceUser, and the
 * directory asks each of their issuers through the directory adapter and the clearance source the seam
 * factory chose for that registry entry (`lambda/src/lib/issuer-seams.ts`). These tests drive the real
 * consumers with a STUB factory selected once, and the `claims` adapter with its store faked at the
 * DynamoDB and KMS edges.
 */
const mockSubjectsOf = jest.fn();
const mockResolve = jest.fn();
jest.mock('../../lambda/src/lib/person-identity', () => ({
  ...jest.requireActual('../../lambda/src/lib/person-identity'),
  subjectsOfPerson: (...a: unknown[]) => mockSubjectsOf(...a),
  resolvePerson: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock('../../lambda/src/lib/chime/clients', () => ({
  ...jest.requireActual('../../lambda/src/lib/chime/clients'),
  // No assistant exists and no AppInstanceUser carries a name: nothing here may reach the service.
  chimeIdentityClient: () => ({ send: async () => ({ AppInstanceBots: [], AppInstanceUser: {} }) }),
}));

import { compactIssuers, type TrustedIssuer } from '../../lib/config/issuers';
import type { DirectoryAdapter, IssuerSeam, SeamFactory } from '../../lambda/src/lib/issuer-seams';
import type { HeldBySource } from '../../lambda/src/lib/clearance-source';
import { oidcIssuer, poolIssuer, testDirectory } from '../helpers/directory';
import { claimsAdapter } from '../../lambda/src/lib/issuer-seams';
import {
  claimsDirectory,
  contactCopyKey,
  eraseContactCopies,
  writeContactCopy,
  type ContactCopyStore,
} from '../../lambda/src/lib/claims-directory';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/seams';
const person = (id: string) => `${APP}/user/${id}`;
const ALICE = '0192f0e0-0000-7000-8000-00000000a11c';
const OSCAR = '0192f0e0-0000-7000-8000-0000000000c5';
const RHEA = '0192f0e0-0000-7000-8000-00000000ae0a';

const DEPLOYMENT = poolIssuer('deployment', 'us-east-1_HOME', { adminGroups: ['admins'] });
const PARTNER = oidcIssuer('partner-oidc', { fixed: ['basic'], classifications: ['basic'] }, { directory: 'claims' });
const MAPPED = oidcIssuer('mapped-oidc', { mapping: { claim: 'roles', values: { analyst: 'standard' } }, classifications: ['basic', 'standard'] });

/** Every key an adapter was asked with, by method, so a test can say no key was an address. */
type Asked = Array<{ issuer: string; method: string; key: string }>;

/** A stub factory: every adapter answers from fixed data and records what it was asked. */
function stubSeams(asked: Asked, built: string[]): SeamFactory {
  return (issuer: TrustedIssuer): IssuerSeam => {
    built.push(issuer.id);
    const note = (method: string, key: string) => asked.push({ issuer: issuer.id, method, key });
    const directory: DirectoryAdapter = {
      kind: issuer.directory,
      issuerId: issuer.id,
      storeKey: `stub:${issuer.id}`,
      nameOf: async (s) => { note('nameOf', s); return `Name of ${s}`; },
      contactOf: async (s, arn) => { note('contactOf', s); note('contactOf.person', arn); return { email: `${s}@${issuer.id}.example`, name: null }; },
      // Only a store that keeps groups answers group questions, as the deployed adapters do.
      ...(issuer.directory === 'cognito' ? {
        usersInGroup: async (g: string) => { note('usersInGroup', g); return [{ subject: `${g}-member`, enabled: true, email: null, name: null }]; },
        listGroups: async (p?: string) => { note('listGroups', p ?? ''); return [`${p}${issuer.id}`]; },
        groupsOf: async (s: string) => { note('groupsOf', s); return ['premium']; },
      } : {}),
    };
    const clearance = {
      source: 'groups' as const,
      issuerId: issuer.id,
      heldFor: async (s: string): Promise<HeldBySource | null> => {
        note('heldFor', s);
        return 'fixed' in issuer.clearance ? { classifications: issuer.clearance.fixed } : 'groups' in issuer.clearance ? { groups: ['premium'] } : null;
      },
    };
    return { issuer, directory, clearance };
  };
}

describe('a stub adapter is selected once and used by every consumer (C1)', () => {
  const asked: Asked = [];
  const built: string[] = [];
  let seams: typeof import('../../lambda/src/lib/issuer-seams');

  beforeAll(() => {
    jest.resetModules();
    process.env.APP_INSTANCE_ARN = APP;
    process.env.TRUSTED_ISSUERS = JSON.stringify(compactIssuers([DEPLOYMENT, PARTNER]));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    seams = require('../../lambda/src/lib/issuer-seams');
    seams.__selectSeamsForTests(stubSeams(asked, built));
    mockSubjectsOf.mockImplementation(async (arn: string) => (arn === person(OSCAR)
      ? [{ issuer: 'partner-oidc', subject: 'oscar-oid' }]
      : [{ issuer: 'deployment', subject: `sub-of-${arn.split('/').pop()}` }]));
    mockResolve.mockImplementation(async (issuer: string, subject: string) => person(`${issuer}-${subject}`));
  });
  afterAll(() => {
    seams.__selectSeamsForTests(null);
    delete process.env.TRUSTED_ISSUERS;
  });

  it('the router reads the sender\'s clearance through the selected source', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveUserClearance } = require('../../lambda/src/lib/user-clearance');
    expect(await resolveUserClearance(person(ALICE))).toMatchObject({ clearance: 'premium', fromIssuer: true });
    expect(await resolveUserClearance(person(OSCAR))).toMatchObject({ clearance: 'basic', fromIssuer: true });
  });

  it('the membership audit reads a member\'s clearance through the selected source', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveMemberClearance } = require('../../lambda/src/membership-audit');
    expect(await resolveMemberClearance(person(RHEA))).toBe('premium');
  });

  it('a group-sourced conversation is resolved through the selected adapters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ms = require('../../lambda/src/lib/membership-source');
    const set = await ms.resolveAllowedSet({ group: 'ops' }, 'premium', APP, ms.defaultDirectory());
    expect([...set.admitted]).toEqual([person('deployment-ops-member')]);
  });

  it('the admin room is rostered through the selected adapters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { listAdminUserArns } = require('../../lambda/src/admin-notification-channel-provision');
    expect(await listAdminUserArns()).toEqual([person('deployment-admins-member')]);
  });

  it('team ownership lists the teams through the selected adapters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { edgeContext } = require('../helpers/edge-context');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handler } = require('../../lambda/src/assistant-ownership');
    const res = await handler({
      httpMethod: 'GET', headers: {},
      requestContext: { authorizer: edgeContext({ claims: { iss: DEPLOYMENT.iss, sub: 'owner' }, personId: ALICE }) },
    });
    expect(JSON.parse(res.body).teams).toEqual(['deployment']);
  });

  it('an email recipient is reached through the selected adapter', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { emailPeople } = require('../../lambda/src/lib/channel-notify');
    const sent: string[] = [];
    const res = await emailPeople({
      personArns: [person(OSCAR)], kind: 'conversation', subject: 's', bodyText: 'b',
      deps: { send: async (recipients: Array<{ email: string }>) => { sent.push(...recipients.map((r) => r.email)); return { sent: recipients.length, failed: [] }; } },
    });
    expect(res.skipped).toEqual([]);
    expect(sent).toEqual(['oscar-oid@partner-oidc.example']);
  });

  it('the router names a person through the selected adapter', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ms = require('../../lambda/src/lib/membership-source');
    expect(await ms.defaultDirectory().displayNameFor(person(ALICE))).toBe(`Name of sub-of-${ALICE}`);
  });

  it('built each issuer\'s seams once, for the whole container', () => {
    expect(built.sort()).toEqual(['deployment', 'partner-oidc']);
  });

  it('never called an adapter with an email address as its key', () => {
    expect(asked.length).toBeGreaterThan(8);
    const byAddress = asked.filter((a) => a.key.includes('@'));
    expect(byAddress).toEqual([]);
    // And every subject an adapter was asked about was the subject Identities names, never a person id.
    for (const a of asked.filter((x) => x.method === 'heldFor' || x.method === 'nameOf' || x.method === 'contactOf')) {
      expect(a.key).not.toMatch(/^arn:/);
    }
  });
});

describe('an OIDC member under clearance is flagged, and so is a removed issuer\'s member (C3)', () => {
  const directory = () => testDirectory({
    appInstanceArn: APP,
    issuers: [{ issuer: PARTNER }, { issuer: MAPPED }],
    identities: {
      resolve: async () => null,
      subjectsOf: async (arn: string) => ({
        [person(OSCAR)]: [{ issuer: 'partner-oidc', subject: 'oscar-oid' }],
        [person(RHEA)]: [{ issuer: 'removed-oidc', subject: 'rhea-oid' }],
        [person(ALICE)]: [{ issuer: 'mapped-oidc', subject: 'alice-oid' }],
      } as Record<string, Array<{ issuer: string; subject: string }>>)[arn] ?? [],
    },
  });
  let audit: typeof import('../../lambda/src/membership-audit');
  let ms: typeof import('../../lambda/src/lib/membership-source');

  beforeAll(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ms = require('../../lambda/src/lib/membership-source');
    ms.__setDefaultDirectoryForTests(directory());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    audit = require('../../lambda/src/membership-audit');
  });
  afterAll(() => ms.__setDefaultDirectoryForTests(null));

  it('an OIDC member whose fixed source reaches basic is a violation in a premium room, and not in a basic one', async () => {
    const clearance = await audit.resolveMemberClearance(person(OSCAR));
    expect(clearance).toBe('basic');
    expect(audit.isClassificationViolation(clearance!, 'premium')).toBe(true);
    expect(audit.isClassificationViolation(clearance!, 'basic')).toBe(false);
  });

  it('a member whose only issuer was removed from the registry reaches nothing, and is flagged wherever they sit', async () => {
    const clearance = await audit.resolveMemberClearance(person(RHEA));
    expect(clearance).toBe(audit.NO_CLEARANCE);
    expect(audit.isClassificationViolation(clearance!, 'basic')).toBe(true);
  });

  it('a member whose issuer decides only from a token is undetermined: recorded as unaudited, never cleared', async () => {
    expect(await audit.resolveMemberClearance(person(ALICE))).toBeNull();
    expect(await ms.defaultDirectory().clearanceOf(person(ALICE))).toEqual({ state: 'undetermined', issuers: ['mapped-oidc'] });
  });

  it('the issuer\'s classifications bind a source that names more than they allow', async () => {
    const wide = oidcIssuer('wide', { fixed: ['basic', 'premium'], classifications: ['basic'] });
    const d = testDirectory({
      appInstanceArn: APP,
      issuers: [{ issuer: wide }],
      identities: { resolve: async () => null, subjectsOf: async () => [{ issuer: 'wide', subject: 'w' }] },
    });
    expect(await d.clearanceOf(person(OSCAR))).toMatchObject({ state: 'held', token: 'basic', held: ['basic'] });
  });
});

// ── THE claims ADAPTER (C5) ──────────────────────────────────────────────────────────────────────

/** A user-profile table and a KMS key in memory. The "ciphertext" is the plaintext reversed, bound to its context. */
function copyStore(now = Date.parse('2026-10-19T00:00:00Z')) {
  const items = new Map<string, Record<string, any>>();
  const contexts: Array<Record<string, string>> = [];
  const store: ContactCopyStore = {
    table: async () => 'UserProfile',
    keyArn: async () => 'arn:aws:kms:us-east-1:111122223333:key/contact',
    now: () => now,
    doc: {
      send: async (cmd: any) => {
        const k = cmd.constructor.name;
        if (k === 'PutCommand') { items.set(cmd.input.Item.personId, cmd.input.Item); return {}; }
        if (k === 'GetCommand') return { Item: items.get(cmd.input.Key.personId) };
        if (k === 'DeleteCommand') {
          const old = items.get(cmd.input.Key.personId);
          items.delete(cmd.input.Key.personId);
          return old ? { Attributes: old } : {};
        }
        throw new Error(`unexpected ${k}`);
      },
    },
    kms: {
      send: async (cmd: any) => {
        const k = cmd.constructor.name;
        contexts.push(cmd.input.EncryptionContext);
        const ctx = JSON.stringify(cmd.input.EncryptionContext);
        if (k === 'EncryptCommand') return { CiphertextBlob: Buffer.from(`${ctx}|${Buffer.from(cmd.input.Plaintext).toString('utf8').split('').reverse().join('')}`) };
        if (k === 'DecryptCommand') {
          const [boundTo, body] = Buffer.from(cmd.input.CiphertextBlob).toString('utf8').split('|');
          if (boundTo !== ctx) throw Object.assign(new Error('context'), { name: 'InvalidCiphertextException' });
          return { Plaintext: Buffer.from(body.split('').reverse().join('')) };
        }
        throw new Error(`unexpected ${k}`);
      },
    },
  };
  return { store, items, contexts };
}

describe('the claims copy (C5)', () => {
  it('keeps the contact claims of the last sign-in, encrypted, keyed by the person, expiring in 90 days', async () => {
    const { store, items } = copyStore();
    await writeContactCopy({ personId: OSCAR, issuerId: 'partner-oidc', contact: { email: 'oscar@partner.example', name: 'Oscar' } }, store);
    const item = items.get(contactCopyKey(OSCAR, 'partner-oidc'))!;
    expect(item.owner).toBe(OSCAR);
    expect(JSON.stringify(item)).not.toContain('oscar@partner.example');
    expect(item.expiresAt).toBe(Date.parse('2026-10-19T00:00:00Z') / 1000 + 90 * 86_400);
    expect(await claimsDirectory('partner-oidc', store).contactOf('oscar-oid', person(OSCAR))).toEqual({ email: 'oscar@partner.example', name: 'Oscar' });
  });

  it('answers nothing past the expiry, whether or not the item is gone yet', async () => {
    const { store } = copyStore();
    await writeContactCopy({ personId: OSCAR, issuerId: 'partner-oidc', contact: { email: 'o@p.example' } }, store);
    const later = { ...store, now: () => Date.parse('2027-01-18T00:00:01Z') };
    expect(await claimsDirectory('partner-oidc', later).contactOf('oscar-oid', person(OSCAR))).toBeNull();
  });

  it('a copy is bound to its person and issuer: another person\'s key reads nothing', async () => {
    const { store, items } = copyStore();
    await writeContactCopy({ personId: OSCAR, issuerId: 'partner-oidc', contact: { email: 'o@p.example' } }, store);
    items.set(contactCopyKey(RHEA, 'partner-oidc'), { ...items.get(contactCopyKey(OSCAR, 'partner-oidc'))!, personId: contactCopyKey(RHEA, 'partner-oidc') });
    expect(await claimsDirectory('partner-oidc', store).contactOf('r', person(RHEA))).toBeNull();
  });

  it('a sign-in that carries no contact claims removes the old copy', async () => {
    const { store, items } = copyStore();
    await writeContactCopy({ personId: OSCAR, issuerId: 'partner-oidc', contact: { email: 'o@p.example' } }, store);
    await writeContactCopy({ personId: OSCAR, issuerId: 'partner-oidc', contact: {} }, store);
    expect(items.size).toBe(0);
  });

  it('has no address search: nobody is ever found in a claims copy by email', () => {
    const { store } = copyStore();
    expect(claimsAdapter('partner-oidc', claimsDirectory('partner-oidc', store)).subjectsByAddress).toBeUndefined();
  });
});

describe('a recipient resolves from the AppInstanceUser ARN for each adapter kind (C5)', () => {
  it('cognito: the pool record of the subject Identities names', async () => {
    const pool = { send: async (cmd: any) => ({ Username: cmd.input.Username, UserAttributes: [{ Name: 'email', Value: `${cmd.input.Username}@home.example` }] }) };
    const d = testDirectory({
      appInstanceArn: APP,
      issuers: [{ issuer: DEPLOYMENT, client: pool }],
      identities: { resolve: async () => null, subjectsOf: async () => [{ issuer: 'deployment', subject: 'alice-sub' }] },
    });
    expect(await d.contactFor(person(ALICE), 'email')).toMatchObject({ address: 'alice-sub@home.example' });
  });

  it('claims: the contact copy of the person\'s last sign-in', async () => {
    const { store } = copyStore();
    await writeContactCopy({ personId: OSCAR, issuerId: 'partner-oidc', contact: { email: 'oscar@partner.example', name: 'Oscar' } }, store);
    const { createDirectory } = await import('../../lambda/src/lib/membership-source');
    const { clearanceSourceFor } = await import('../../lambda/src/lib/issuer-seams');
    const d = createDirectory({
      appInstanceArn: APP,
      issuers: [PARTNER],
      seams: (issuer) => {
        const directory = claimsAdapter(issuer.id, claimsDirectory(issuer.id, store));
        return { issuer, directory, clearance: clearanceSourceFor(issuer, directory) };
      },
      identities: { resolve: async () => null, subjectsOf: async () => [{ issuer: 'partner-oidc', subject: 'oscar-oid' }] },
    });
    expect(await d.contactFor(person(OSCAR), 'email')).toEqual({ route: 'email', address: 'oscar@partner.example', name: 'Oscar' });
  });

  it('none: no contact, and the person is named by their AppInstanceUser', async () => {
    const d = testDirectory({
      appInstanceArn: APP,
      issuers: [{ issuer: MAPPED }],
      identities: { resolve: async () => null, subjectsOf: async () => [{ issuer: 'mapped-oidc', subject: 'alice-oid' }] },
      appInstanceUserName: async () => 'Alice Chen',
    });
    expect(await d.contactFor(person(ALICE), 'email')).toBeNull();
    expect(await d.displayNameFor(person(ALICE))).toBe('Alice Chen');
  });
});

describe('the claims copy is erased with the person (C5)', () => {
  it('offboarding deletes every contact copy of the person, and no one else\'s', async () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { offboardingWorld } = require('../setup/offboarding-world');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { offboardPerson } = require('../../lambda/src/lib/offboarding');
    const w = offboardingWorld();
    const arn = w.seedPerson(OSCAR, [{ issuer: 'partner-oidc', subject: 'oscar-oid' }]);
    w.profiles.set(contactCopyKey(OSCAR, 'partner-oidc'), { personId: contactCopyKey(OSCAR, 'partner-oidc'), owner: OSCAR, contact: 'x' });
    w.profiles.set(contactCopyKey(RHEA, 'partner-oidc'), { personId: contactCopyKey(RHEA, 'partner-oidc'), owner: RHEA, contact: 'y' });
    const quiet = [jest.spyOn(console, 'log').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
    const res = await offboardPerson(arn, { arn: 'sweep' }, w.deps);
    quiet.forEach((s) => s.mockRestore());
    expect(res.removed.contactCopies).toBe(1);
    expect([...w.profiles.keys()].filter((k: string) => k.startsWith(`${OSCAR}#contact#`))).toEqual([]);
    expect(w.profiles.has(contactCopyKey(RHEA, 'partner-oidc'))).toBe(true);
  });

  it('erases one copy per issuer named, counting what existed', async () => {
    const { store, items } = copyStore();
    await writeContactCopy({ personId: OSCAR, issuerId: 'a', contact: { email: 'o@a.example' } }, store);
    await writeContactCopy({ personId: OSCAR, issuerId: 'b', contact: { email: 'o@b.example' } }, store);
    expect(await eraseContactCopies(OSCAR, ['a', 'b', 'c', 'a'], store.doc, 'UserProfile')).toBe(2);
    expect(items.size).toBe(0);
  });
});
