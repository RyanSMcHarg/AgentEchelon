/**
 * A HOST-ASSERTED ROLE ADDRESSES AND NEVER DECIDES (DESIGN-CONVERSATION-TYPES section 6.1, the `host` participant-role
 * source; ADR-060 decision 2).
 *
 * What it proves:
 *  - the `host` source is built: synthesis accepts `{ host: true }`, and refuses another shape and a conferral;
 *  - a member holds a host-sourced role when the creating application's `memberIdentities[].role` names it, read when the
 *    holdings are read and never stored; an entry naming an issuer's subject becomes a person through Identities, and
 *    only a member counts, so a tampered entry adds nobody;
 *  - stored holdings come first, and a person a host names no longer holds the type's default role;
 *  - `host:role` is member trust: inserted for the person it describes, refused in a condition, and the router keeps a
 *    host's holdings out of everything a condition reads.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  NOT_BUILT_ROLE_SOURCES,
  hostSourcedRoles,
  participantRoleDeclarationErrors,
} from '../../lib/config/participant-roles';
import { hostRoleHoldings, withHostHoldings } from '../../lambda/src/lib/participant-roles';
import { NOT_BUILT_SOURCES, buildSourceTable, sourceLookup, whenErrors } from '../../lambda/src/lib/variables';
import { CONVERSATION_TYPES, type ConversationTypeConfig } from '../../lib/config/conversation-types';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const user = (id: string) => `${APP}/user/${id}`;

/** A type a creating application opens and names its members' roles for: a host role beside the default. */
const HOSTED = 'test-hosted';
const hosted: ConversationTypeConfig = {
  ...CONVERSATION_TYPES.general,
  participants: {
    participantRoles: {
      advisor: { from: [{ host: true }] },
      owner: { from: [{ host: true }], holders: 'one' },
      member: { from: [] },
    },
    defaultRole: 'member',
  },
} as ConversationTypeConfig;

describe('the host source is built', () => {
  beforeAll(() => { (CONVERSATION_TYPES as Record<string, ConversationTypeConfig>)[HOSTED] = hosted; });
  afterAll(() => { delete (CONVERSATION_TYPES as Record<string, ConversationTypeConfig>)[HOSTED]; });

  it('is no longer refused as not built, and its roles are listed', () => {
    expect(NOT_BUILT_ROLE_SOURCES.host).toBeUndefined();
    expect(NOT_BUILT_SOURCES['host:role']).toBeUndefined();
    expect(hostSourcedRoles(HOSTED)).toEqual(['advisor', 'owner']);
    expect(participantRoleDeclarationErrors({ [HOSTED]: hosted }, { membershipGroups: {} })).toEqual([]);
  });

  it('refuses another shape, and a conferral, because a host\'s assertion is member trust', () => {
    const bad = { ...hosted, participants: { participantRoles: { advisor: { from: [{ host: 'yes' }] }, lead: { from: [{ host: true }], confers: { moderator: true } } } } } as unknown as ConversationTypeConfig;
    const errs = participantRoleDeclarationErrors({ [HOSTED]: bad }, { membershipGroups: {} }).join('\n');
    expect(errs).toMatch(/a host source is \{ host: true \}/);
    expect(errs).toMatch(/a role with a host source confers nothing/);
  });

  it('a member holds what the host asserted for them, read through Identities, and only a member', async () => {
    const identities = [
      { sub: 'ext-1', iss: 'https://host.example', role: 'advisor' },
      { sub: 'ext-2', iss: 'https://host.example', role: 'owner' },
      { sub: 'ext-3', iss: 'https://host.example', role: 'owner' },
      { sub: 'native', role: 'advisor' },
      { sub: 'stranger', role: 'advisor' },
      { sub: 'ext-1', iss: 'https://host.example', role: 'not-a-role' },
    ];
    const resolve = async (_iss: string, sub: string) => ({ 'ext-1': user('p1'), 'ext-2': user('p2'), 'ext-3': user('p3') } as Record<string, string>)[sub] ?? null;
    const members = [user('p1'), user('p2'), user('p3'), user('native')];
    const held = await hostRoleHoldings(identities, HOSTED, members, resolve);
    expect(held.advisor.sort()).toEqual([user('native'), user('p1')].sort());
    // A one-holder role takes its first holder; a non-member and a role the type does not declare name nobody.
    expect(held.owner).toEqual([user('p2')]);
    expect(Object.values(held).flat()).not.toContain(user('stranger'));
    expect(await hostRoleHoldings(identities, 'general', members, resolve)).toEqual({});
  });

  it('stored holdings come first, and a person a host names leaves the default role', () => {
    const stored = { owner: [user('p9')], member: [user('p1'), user('p2'), user('p9')] };
    const merged = withHostHoldings(stored, { advisor: [user('p1')], owner: [user('p2')] }, HOSTED);
    expect(merged.owner).toEqual([user('p9')]);
    expect(merged.advisor).toEqual([user('p1')]);
    expect(merged.member).toEqual([user('p2'), user('p9')]);
  });
});

describe('host:role is member trust', () => {
  it('is published, inserts for the person it describes, and no condition reads it', () => {
    const table = buildSourceTable({ catalog: [] });
    expect(table.sources['host:role']).toMatchObject({ trust: 'member', describesPerson: true });
    expect(whenErrors({ 'host:role': 'advisor' }, sourceLookup(table), { event: 'person-joined', selects: 'addressed' }).join()).toMatch(/host:role/);
  });

  it('the router reads a host\'s holdings for addresses and mentions, keeps them out of conditions, and resolves host:role for one reader', () => {
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/const roles = Object\.keys\(host\)\.length \? withHostHoldings\(stored, host, conversationType\) : stored;/);
    expect(router).toMatch(/\.\.\.\(roles !== stored \? \{ deciding: stored \} : \{\}\),/);
    expect(router).toMatch(/const held = ctx\.decidingRoles \?\? ctx\.roles;/);
    expect(router).toMatch(/const hostRole = args\.to\.length === 1 && Object\.values\(written\.fields \?\? \{\}\)\.includes\('host:role'\)/);
  });
});
