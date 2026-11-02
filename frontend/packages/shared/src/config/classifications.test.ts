/**
 * THE DEPLOYMENT'S CLASSIFICATIONS AS THE CLIENTS RENDER THEM: read from the declared set, never a list
 * of names in the client.
 *
 *  - Signed in, the set is what `GET /classifications` answers; before sign-in, the chat build's fallback
 *    `VITE_CLASSIFICATIONS` carries it, URI-encoded behind `uri:` (UTF-8 names included); an unreadable value is an
 *    empty set, never a guess, and a load that fails keeps the set installed.
 *  - A badge's colors are the token its definition names (`--cls-<n>`), whatever the classification is
 *    called; an undeclared value is neutral.
 *  - What the New conversation picker offers is set membership over the declared grants: an administrator
 *    every member classification, a custom set its own, a person with no classification nothing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  classificationAudience,
  classificationBadgeStyle,
  classificationName,
  creatableClassifications,
  deploymentClassifications,
  loadDeploymentClassifications,
  subscribeClassifications,
  memberConversationalClassifications,
  parseClassifications,
  setClassificationsForTest,
  type ClientClassification,
} from './classifications';
import { SAMPLE_CLASSIFICATIONS } from './sampleClassifications';

const CUSTOM: ClientClassification[] = [
  { value: 'legal', displayName: 'Légal', audience: 'members', badgeToken: 'cls-7', grants: ['legal'], conversational: true, models: { selected: ['haiku', 'sonnet'], default: 'sonnet' } },
  { value: 'finance', displayName: 'Finance', audience: 'members', badgeToken: 'cls-2', grants: ['finance'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'client', displayName: 'Client', audience: 'outside', badgeToken: 'cls-5', grants: ['client'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'admin', displayName: 'Admin', audience: 'members', badgeToken: 'cls-3', grants: ['legal', 'finance', 'admin'], conversational: false, adminPlane: true },
];

const encoded = (v: unknown) => `uri:${encodeURIComponent(JSON.stringify(v))}`;

afterEach(() => setClassificationsForTest(null));

describe('the declared set', () => {
  it('is read from its encoded form, a UTF-8 name included', () => {
    expect(parseClassifications(encoded(CUSTOM)).map((c) => [c.value, c.displayName])).toEqual([
      ['legal', 'Légal'], ['finance', 'Finance'], ['client', 'Client'], ['admin', 'Admin'],
    ]);
    expect(parseClassifications(JSON.stringify(CUSTOM))).toHaveLength(4);
  });

  it('is empty, never a guess, when the value is absent or unreadable', () => {
    for (const raw of [undefined, '', 'uri:%%%', 'not json', '{"value":"x"}']) expect(parseClassifications(raw)).toEqual([]);
  });

  it('keeps a badge token only from the palette', () => {
    const [c] = parseClassifications(JSON.stringify([{ value: 'x', badgeToken: 'tier-premium', grants: ['x'] }]));
    expect(c.badgeToken).toBe('cls-1');
  });
});

describe('a custom set renders its own names and badge colors', () => {
  it('names each classification by its declared display name, and an undeclared one by its value', () => {
    setClassificationsForTest(CUSTOM);
    expect(classificationName('legal')).toBe('Légal');
    expect(classificationName('premium')).toBe('premium');
  });

  it('colors each badge by its declared token, not by its name', () => {
    setClassificationsForTest(CUSTOM);
    expect(classificationBadgeStyle('legal')).toEqual({ '--cls-fg': 'var(--cls-7)', '--cls-bg': 'var(--cls-7-bg)' });
    expect(classificationBadgeStyle('finance')).toEqual({ '--cls-fg': 'var(--cls-2)', '--cls-bg': 'var(--cls-2-bg)' });
    expect(classificationBadgeStyle('premium')).toEqual({ '--cls-fg': 'var(--text-tertiary)', '--cls-bg': 'var(--surface-100)' });
  });

  it('reads the audience from the definition', () => {
    setClassificationsForTest(CUSTOM);
    expect(classificationAudience('client')).toBe('outside');
    expect(classificationAudience('legal')).toBe('members');
    expect(classificationAudience('unknown')).toBe('members');
  });
});

describe('what a person may open a conversation at', () => {
  it('is the member classifications their own grants, in declaration order', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    const values = (holder?: string) => creatableClassifications(holder).map((c) => c.value);
    // The admin plane grants itself alone, and no conversation is opened at it from the picker.
    expect(values('admin')).toEqual([]);
    expect(values('premium')).toEqual(['basic', 'standard', 'premium']);
    expect(values('standard')).toEqual(['basic', 'standard']);
    expect(values('basic')).toEqual(['basic']);
  });

  it('never offers an outside conversation, nor the admin plane, from the picker', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    expect(creatableClassifications('customer')).toEqual([]);
    expect(creatableClassifications('guest')).toEqual([]);
  });

  it('is a custom set\'s own classifications, which no sample list names', () => {
    setClassificationsForTest(CUSTOM);
    expect(creatableClassifications('legal').map((c) => c.value)).toEqual(['legal']);
    expect(creatableClassifications('admin').map((c) => c.value)).toEqual(['legal', 'finance']);
  });

  it('is nothing for a person whose token names no classification, or one the deployment does not declare', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    for (const holder of [undefined, '', 'legal']) expect(creatableClassifications(holder)).toEqual([]);
  });
});

/**
 * A DEPLOYMENT WHOSE CLASSIFICATIONS SHARE NO NAME WITH THE SAMPLE: `internal`, `partner` and `customer`, with
 * disjoint grants, as the backend publishes them (`a-deployment-of-other-names-runs-on-its-own-classifications.test.ts`).
 */
const OTHER_NAMES: ClientClassification[] = [
  { value: 'internal', displayName: 'Internal', audience: 'members', badgeToken: 'cls-1', grants: ['internal'], conversational: true, models: { selected: ['haiku', 'sonnet'], default: 'sonnet' } },
  { value: 'partner', displayName: 'Partner', audience: 'members', badgeToken: 'cls-2', grants: ['partner'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'customer', displayName: 'Customer', audience: 'outside', badgeToken: 'cls-3', grants: ['customer'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'admin', displayName: 'Admin', audience: 'members', badgeToken: 'cls-4', grants: ['internal', 'partner', 'admin'], conversational: false, adminPlane: true },
];

describe('a deployment of other names is offered its own classifications', () => {
  it('offers each holder exactly what its own grants name, and nothing across disjoint grants', () => {
    setClassificationsForTest(OTHER_NAMES);
    const offer = (holder: string) => creatableClassifications(holder).map((c) => c.value);
    expect(offer('internal')).toEqual(['internal']);
    expect(offer('partner')).toEqual(['partner']);
    expect(offer('admin')).toEqual(['internal', 'partner']);
    expect(offer('customer')).toEqual([]);
    for (const sample of ['basic', 'standard', 'premium']) expect({ sample, offered: offer(sample) }).toEqual({ sample, offered: [] });
  });

  it('gives an operator form the member conversational classifications, in declaration order', () => {
    setClassificationsForTest(OTHER_NAMES);
    expect(memberConversationalClassifications().map((c) => c.value)).toEqual(['internal', 'partner']);
    setClassificationsForTest([]);
    expect(memberConversationalClassifications()).toEqual([]);
  });
});

describe('the signed-in app loads the set from GET /classifications', () => {
  it('installs the set the route answers, and tells every subscriber', async () => {
    vi.stubEnv('VITE_PERSON_API_URL', 'https://person.example.com');
    const seen: number[] = [];
    const off = subscribeClassifications(() => seen.push(deploymentClassifications().length));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ classifications: CUSTOM }), { status: 200 }));
    try {
      await expect(loadDeploymentClassifications('token-1', fetcher as unknown as typeof fetch)).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledWith('https://person.example.com/classifications', { headers: { Authorization: 'Bearer token-1' } });
      expect(classificationName('legal')).toBe('Légal');
      expect(seen).toEqual([4]);
    } finally {
      off();
      vi.unstubAllEnvs();
    }
  });

  it('keeps the set already installed when the route cannot be read', async () => {
    vi.stubEnv('VITE_PERSON_API_URL', 'https://person.example.com');
    setClassificationsForTest(CUSTOM);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(loadDeploymentClassifications('t', (async () => new Response('', { status: 403 })) as unknown as typeof fetch)).resolves.toBe(false);
      await expect(loadDeploymentClassifications('t', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).resolves.toBe(false);
      await expect(loadDeploymentClassifications('t', (async () => new Response('{"nope":1}', { status: 200 })) as unknown as typeof fetch)).resolves.toBe(false);
      expect(classificationName('legal')).toBe('Légal');
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
