/**
 * Guardrail catalog + policy builder (SPEC-CONFIGURABLE-ASSISTANTS 4.6b).
 * The deployment's SELECTABLE guardrails, as data — a profile's guardrailId picks one.
 */
import { buildGuardrailPolicy } from '../../lib/constructs/bedrock-guardrails';
import { guardrailCatalog } from '../../lib/config/guardrail-catalog';

const words = (p: ReturnType<typeof buildGuardrailPolicy>): string[] =>
  (p.wordPolicyConfig as { wordsConfig?: Array<{ text: string }> })?.wordsConfig?.map((w) => w.text) ?? [];

describe('buildGuardrailPolicy', () => {
  it('carries the base content/PII/word filters', () => {
    const p = buildGuardrailPolicy({ name: 'x' });
    expect(p.name).toBe('x');
    expect(words(p)).toContain('system-admin');
    expect((p.contentPolicyConfig as { filtersConfig: unknown[] }).filtersConfig.length).toBeGreaterThan(0);
    expect((p.sensitiveInformationPolicyConfig as { piiEntitiesConfig: unknown[] }).piiEntitiesConfig.length).toBeGreaterThan(0);
  });

  it('appends extraBlockedWords (the cheap lever a stricter variant uses)', () => {
    const p = buildGuardrailPolicy({ name: 'x', extraBlockedWords: ['confidential-alpha', 'internal-only'] });
    expect(words(p)).toEqual(expect.arrayContaining(['system-admin', 'confidential-alpha', 'internal-only']));
  });
});

describe('guardrailCatalog', () => {
  const cat = guardrailCatalog('agent-echelon');

  it('entry 0 is the default (what GUARDRAIL_ID points at)', () => {
    expect(cat[0].key).toBe('default');
    expect(words(cat[0].policy)).not.toContain('confidential-alpha');
  });

  it('offers a stricter alternate that is OBSERVABLY different (extra blocked term)', () => {
    const strict = cat.find((e) => e.key === 'strict');
    expect(strict).toBeDefined();
    expect(words(strict!.policy)).toContain('confidential-alpha');
    // Same base policy otherwise — the alternate is the default plus the extra term.
    expect(words(strict!.policy)).toContain('system-admin');
  });

  it('every entry has a unique key + name', () => {
    const keys = cat.map((e) => e.key);
    const names = cat.map((e) => e.name);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size).toBe(names.length);
  });
});
