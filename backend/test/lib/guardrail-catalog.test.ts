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

/**
 * WHAT THE PII POLICY REDACTS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * THIS IS THE PROJECT'S POSITION AND NOT A PER-DEPLOYMENT SETTING, which is why it is asserted here
 * rather than left to configuration. AgentEchelon is used inside an organization, where colleagues
 * share names, email addresses and phone numbers as the ordinary content of work. `EMAIL` and `PHONE`
 * were `ANONYMIZE` and that made the assistant worse at its job in two ways: it could not repeat a
 * colleague's address back ("email Jo at {EMAIL}"), and the phone detector fired on ordinary
 * arithmetic - measured 2026-09-17, "what is three plus three?" was answered `{PHONE} is six.`
 *
 * An external-facing use case is the trigger to revisit it, as a decision record rather than a flag.
 *
 * A payment card number and a social security number are a different kind of thing: there is no
 * legitimate reason to type either to an assistant, and they are the classic target of a
 * prompt-injection exfiltration. They stay, and they BLOCK rather than ANONYMIZE, so the person is
 * told the turn was refused instead of quietly getting rewritten text.
 *
 * This test exists so loosening the contact entities cannot silently become loosening everything.
 */
describe('the PII policy protects money and identity, not contact details', () => {
  const pii = (): Array<{ type: string; action: string }> =>
    (buildGuardrailPolicy({ name: 'x' }).sensitiveInformationPolicyConfig as
      { piiEntitiesConfig: Array<{ type: string; action: string }> }).piiEntitiesConfig;

  it('BLOCKS payment card and social security numbers, rather than masking them', () => {
    for (const type of ['CREDIT_DEBIT_CARD_NUMBER', 'US_SOCIAL_SECURITY_NUMBER']) {
      const entry = pii().find((e) => e.type === type);
      // Named in the assertion rather than in a message argument, so a failure says which one went.
      expect(`${type}: ${entry ? 'present' : 'MISSING from the PII policy'}`).toBe(`${type}: present`);
      // ANONYMIZE would rewrite the message and say nothing; BLOCK tells the person it was refused.
      expect(entry!.action).toBe('BLOCK');
    }
  });

  it('does NOT redact the contact details colleagues legitimately exchange', () => {
    const types = pii().map((e) => e.type);
    expect(types).not.toContain('EMAIL');
    expect(types).not.toContain('PHONE');
    expect(types).not.toContain('NAME');
    expect(types).not.toContain('ADDRESS');
  });

  it('every remaining entity is a BLOCK, so nothing silently rewrites a person\'s words', () => {
    // The whole point of the change is that quiet substitution was the harm. If a future entity is
    // added as ANONYMIZE, this fails and the author has to argue for it.
    expect(pii().filter((e) => e.action !== 'BLOCK')).toEqual([]);
  });

  it('keeps the metadata-marker regex, which is a control marker and not PII', () => {
    // That one IS an ANONYMIZE and is deliberately in the regex list rather than the entity list:
    // the mask is the intended output and the marker stripper reads the same shared declaration.
    const regexes = (buildGuardrailPolicy({ name: 'x' }).sensitiveInformationPolicyConfig as
      { regexesConfig: Array<{ action: string }> }).regexesConfig;
    expect(regexes.length).toBeGreaterThan(0);
    expect(regexes.some((r) => r.action === 'ANONYMIZE')).toBe(true);
  });
});
