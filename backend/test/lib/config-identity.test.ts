/**
 * Config identity (lib/config-identity.ts) — the config-attribution fingerprint.
 * Pins the contract the quality stamps depend on:
 *  - DETERMINISTIC: identical inputs ⇒ identical `configId` (so a turn, an eval row, and a battle are
 *    comparable across producers).
 *  - SENSITIVE: a changed persona / pack / system prompt ⇒ a changed `configId`.
 *  - STABLE COMPONENTS: each component version is a short hash (or 'default'), never the config text.
 */
import {
  componentVersion,
  buildConfigIdentity,
  deriveConfigIdentity,
} from '../../lambda/src/lib/config-identity';

describe('config-identity — componentVersion', () => {
  test('non-empty value ⇒ stable 12-char hex hash (not the text)', () => {
    const v = componentVersion('You are Aria, a helpful assistant.');
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(v).not.toContain('Aria');
    // deterministic
    expect(componentVersion('You are Aria, a helpful assistant.')).toBe(v);
  });

  test('empty / whitespace / undefined ⇒ the fallback label', () => {
    expect(componentVersion('')).toBe('default');
    expect(componentVersion('   ')).toBe('default');
    expect(componentVersion(undefined)).toBe('default');
    expect(componentVersion(null)).toBe('default');
    expect(componentVersion('', 'none')).toBe('none');
  });

  test('different values ⇒ different versions', () => {
    expect(componentVersion('a')).not.toBe(componentVersion('b'));
  });
});

describe('config-identity — buildConfigIdentity', () => {
  const base = { personaVersion: 'p1', intentPackVersion: 'k1', systemPromptHash: 's1' };

  test('deterministic 16-char configId; echoes the component versions', () => {
    const a = buildConfigIdentity(base);
    const b = buildConfigIdentity({ ...base });
    expect(a.configId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.configId).toBe(b.configId);
    expect(a.personaVersion).toBe('p1');
    expect(a.intentPackVersion).toBe('k1');
    expect(a.systemPromptHash).toBe('s1');
  });

  test('any component change flips the configId', () => {
    const id0 = buildConfigIdentity(base).configId;
    expect(buildConfigIdentity({ ...base, personaVersion: 'p2' }).configId).not.toBe(id0);
    expect(buildConfigIdentity({ ...base, intentPackVersion: 'k2' }).configId).not.toBe(id0);
    expect(buildConfigIdentity({ ...base, systemPromptHash: 's2' }).configId).not.toBe(id0);
  });
});

describe('config-identity — deriveConfigIdentity', () => {
  test('default persona + no pack ⇒ default component versions', () => {
    const id = deriveConfigIdentity({ systemPrompt: 'AE generic default prompt' });
    expect(id.personaVersion).toBe('default');
    expect(id.intentPackVersion).toBe('default');
    expect(id.systemPromptHash).toMatch(/^[0-9a-f]{12}$/);
  });

  test('a persona equal to defaultPersona is recorded as default, not a hash', () => {
    const DEFAULT = 'AE generic default prompt';
    const id = deriveConfigIdentity({ persona: DEFAULT, systemPrompt: DEFAULT, defaultPersona: DEFAULT });
    expect(id.personaVersion).toBe('default');
  });

  test('custom persona + pack ⇒ hashed versions and a distinct configId', () => {
    const custom = deriveConfigIdentity({
      persona: 'You are Aria.',
      intentPackRaw: '[{"key":"find_recipe","delivery":"PLACEHOLDER_UPDATE"}]',
      systemPrompt: 'You are Aria.',
    });
    const def = deriveConfigIdentity({ systemPrompt: 'AE generic default prompt' });
    expect(custom.personaVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(custom.intentPackVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(custom.configId).not.toBe(def.configId);
  });

  test('the raw pack (which carries per-intent response settings) drives the pack version', () => {
    // P3 settings live IN the pack JSON, so changing maxTokens changes the pack version → configId.
    const a = deriveConfigIdentity({
      persona: 'p',
      intentPackRaw: '[{"key":"logistics","delivery":"PLACEHOLDER_UPDATE","maxTokens":700}]',
      systemPrompt: 'p',
    });
    const b = deriveConfigIdentity({
      persona: 'p',
      intentPackRaw: '[{"key":"logistics","delivery":"PLACEHOLDER_UPDATE","maxTokens":1600}]',
      systemPrompt: 'p',
    });
    expect(a.intentPackVersion).not.toBe(b.intentPackVersion);
    expect(a.configId).not.toBe(b.configId);
  });
});
