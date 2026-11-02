/**
 * T1, FR23: A CONVERSATION TYPE MAY NARROW WHO IT ADMITS BY ISSUER, AND NEVER WIDENS ANYTHING.
 *
 *  - a type with no `admitsIssuers` admits every issuer the classification admits; one with a list admits
 *    a person when any issuer they sign in through is listed; an unknown type admits nobody;
 *  - the membership-source admission applies it AFTER the clearance check: a listed issuer whose clearance
 *    does not reach is still refused, and an unlisted one whose clearance reaches is refused too;
 *  - synth refuses a type whose list names no issuer the registry declares, which would admit nobody.
 */
import {
  CONVERSATION_TYPES, admittedIssuersOf, typeAdmitsIssuers,
} from '../../lib/config/conversation-types';
import { resolveAllowedSet, type Directory } from '../../lambda/src/lib/membership-source';
import { issuerErrors } from '../../lib/config/issuers';
import { defaultProfileRegistry } from '../../lib/profile-registry';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const person = (id: string) => `${APP}/user/${id}`;
const TYPES = CONVERSATION_TYPES as Record<string, unknown>;

async function withType<T>(key: string, config: Record<string, unknown>, run: () => T | Promise<T>): Promise<T> {
  const prior = TYPES[key];
  TYPES[key] = config;
  try { return await run(); } finally {
    if (prior) TYPES[key] = prior; else delete TYPES[key];
  }
}

const DEAL_ROOM = { classifications: ['premium'], driftEnabled: false, membershipSource: { group: 'sales' }, admitsIssuers: ['sales-org'] };

describe('the narrowing itself', () => {
  it('no list admits every issuer; a list admits only its own; an unknown type admits nobody', async () => {
    expect(admittedIssuersOf('general')).toBeNull();
    expect(typeAdmitsIssuers('general', ['anything'])).toBe(true);
    expect(typeAdmitsIssuers('general', [])).toBe(true);
    await withType('deal-room', DEAL_ROOM, () => {
      expect(admittedIssuersOf('deal-room')).toEqual(['sales-org']);
      expect(typeAdmitsIssuers('deal-room', ['sales-org'])).toBe(true);
      expect(typeAdmitsIssuers('deal-room', ['customers', 'sales-org'])).toBe(true);
      expect(typeAdmitsIssuers('deal-room', ['customers'])).toBe(false);
      expect(typeAdmitsIssuers('deal-room', [])).toBe(false);
    });
    expect(typeAdmitsIssuers('no-such-type', ['sales-org'])).toBe(false);
  });

  it('no shipped type narrows, so no shipped admission changes', () => {
    for (const key of Object.keys(CONVERSATION_TYPES)) expect({ key, admits: admittedIssuersOf(key) }).toEqual({ key, admits: null });
  });
});

describe('admission applies it after the clearance check', () => {
  const directoryOf = (people: Record<string, { token?: string; issuers: string[] }>): Directory => ({
    personsInGroup: async () => ({ persons: Object.keys(people).map(person), unminted: [] }),
    personOf: async () => null,
    admins: async () => ({ persons: [], unminted: [] }),
    clearanceOf: async (arn: string) => {
      const p = people[arn.split('/').pop() || ''];
      return { state: 'held' as const, token: p.token, held: p.token ? [p.token] : [], groups: [], admin: false, issuers: p.issuers };
    },
    listGroups: async () => [],
    groupsFor: async () => [],
    clearedByGroups: async () => null,
    displayNameFor: async () => null,
    findByAddress: async () => null,
    accountState: async () => 'active' as const,
    contactFor: async () => null,
  });

  it('a listed issuer is admitted, an unlisted one refused, and a listed one the classification refuses stays refused', async () => {
    const directory = directoryOf({
      rep: { token: 'premium', issuers: ['sales-org'] },
      staffer: { token: 'premium', issuers: ['deployment'] },
      junior: { token: 'basic', issuers: ['sales-org'] },
      both: { token: 'premium', issuers: ['deployment', 'sales-org'] },
    });
    await withType('deal-room', DEAL_ROOM, async () => {
      const set = await resolveAllowedSet({ group: 'sales' }, 'premium', APP, directory, 'deal-room');
      expect([...set.admitted].sort()).toEqual([person('both'), person('rep')]);
      expect(set.refused.sort()).toEqual([person('junior'), person('staffer')]);
      // Without the type, the classification alone decides, as it always has.
      const plain = await resolveAllowedSet({ group: 'sales' }, 'premium', APP, directory);
      expect([...plain.admitted].sort()).toEqual([person('both'), person('rep'), person('staffer')]);
    });
  });
});

describe('synth refuses a narrowing that would admit nobody', () => {
  const registry = [{ id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: defaultProfileRegistry.memberClassificationValues() }, admin: true }];

  it('names the type when none of its issuers is declared', async () => {
    await withType('deal-room', DEAL_ROOM, () => {
      expect(issuerErrors(registry, defaultProfileRegistry).join('\n')).toMatch(/conversation type "deal-room" admits only issuers "sales-org"/);
    });
  });

  it('accepts a list naming at least one declared issuer', async () => {
    await withType('deal-room', { ...DEAL_ROOM, admitsIssuers: ['sales-org', 'deployment'] }, () => {
      expect(issuerErrors(registry, defaultProfileRegistry).join('\n')).not.toMatch(/deal-room/);
    });
  });
});
