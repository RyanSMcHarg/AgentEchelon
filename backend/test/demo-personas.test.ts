/**
 * The demo (Stratum) personas, one per classification.
 *
 * These are not decoration. Each one is seeded INTO its profile's versioned definition, so it is the
 * portable payload a manifest export carries to another instance, and it is the system prompt every
 * turn on that classification runs under. Two things can go wrong silently:
 *
 *  - a persona grows past what the definition's SSM parameter can hold, which surfaces only when
 *    somebody runs the seeder and gets an opaque AWS ValidationException;
 *  - a persona drifts out of step with the corpus its classification can actually read, so the
 *    assistant either promises material it cannot see or disclaims material it can.
 *
 * IMPORTANT about the boundary assertions below: the persona DESCRIBES the access boundary so the
 * assistant declines gracefully. It does not ENFORCE it - enforcement is the IAM policy on each
 * classification's async-processor role. These tests check the prose is consistent with that
 * boundary; the negative assertions in tests/e2e/classification-context.spec.ts are what prove the
 * boundary actually holds.
 */
import { BASIC_PERSONA, STANDARD_PERSONA, PREMIUM_PERSONA } from '../demo/personas';
import { serializeSeedDefinition } from '../lambda/src/lib/active-profile';
import { SSM_STANDARD_TIER_MAX } from '../lambda/src/lib/seed-profile-definitions';

const PERSONAS = [
  { name: 'basic', persona: BASIC_PERSONA },
  { name: 'standard', persona: STANDARD_PERSONA },
  { name: 'premium', persona: PREMIUM_PERSONA },
] as const;

describe('demo personas', () => {
  describe('fit the parameter budget', () => {
    it.each(PERSONAS)('$name definition fits in a Standard-tier SSM parameter', ({ name, persona }) => {
      const def = serializeSeedDefinition(name, persona)!;
      expect(def).not.toBeNull();
      // Reported rather than asserted bare, so a near-miss is visible in the failure message.
      expect({ profile: name, definitionChars: def.length, limit: SSM_STANDARD_TIER_MAX })
        .toEqual(expect.objectContaining({ definitionChars: expect.any(Number) }));
      expect(def.length).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
    });
  });

  describe('each persona matches the corpus its classification can read', () => {
    // basic reads context/basic/company-public.json ONLY: products, plans, pricing, FAQ.
    it('basic offers public material and disclaims the internal prefixes', () => {
      const p = BASIC_PERSONA.toLowerCase();
      expect(p).toContain('public');
      for (const product of ['stratumflow', 'stratumconnect', 'stratumanalytics']) {
        expect(p).toContain(product);
      }
      // It must tell the model the internal material is NOT available to it. Without this the model
      // improvises when asked "who leads platform engineering" instead of declining.
      expect(p).toContain('employee directory');
      expect(p).toMatch(/not available on this tier|is internal/);
    });

    // The demo's whole tiering story is that basic cannot produce these and premium can. A persona
    // that NAMES them would hand the model the answer without any S3 read, making the e2e negative
    // assertions pass for the wrong reason - or fail outright.
    it('basic names no restricted fact', () => {
      const p = BASIC_PERSONA.toLowerCase();
      for (const leak of ['priya', 'patel', 'david kim', 'marcus rivera', 'sarah chen', '4.2', 'meridian']) {
        expect(p).not.toContain(leak);
      }
    });

    it('standard covers the internal prefixes and defers leadership material', () => {
      const p = STANDARD_PERSONA.toLowerCase();
      expect(p).toContain('employee directory');
      expect(p).toContain('roadmap');
      expect(p).toMatch(/financials|leadership/);
    });

    it('premium claims the leadership corpus and is told to state exact figures', () => {
      const p = PREMIUM_PERSONA.toLowerCase();
      for (const scope of ['financial', 'board', 'customer account', 'competitive']) {
        expect(p).toContain(scope);
      }
      // The ARR assertion in classification-context.spec.ts depends on premium quoting the figure
      // rather than describing it, so the instruction to do that is load-bearing.
      expect(p).toMatch(/exact figure|state the exact/);
      expect(p).toMatch(/do not round|never fabricate/);
    });

    it('no persona names a restricted fact outright — every tier must read it from context', () => {
      for (const { name, persona } of PERSONAS) {
        const p = persona.toLowerCase();
        expect([name, p.includes('4.2')]).toEqual([name, false]);
        expect([name, p.includes('priya patel')]).toEqual([name, false]);
      }
    });
  });

  describe('shared contract every persona keeps', () => {
    it.each(PERSONAS)('$name grounds answers in the turn context and refuses to fabricate', ({ persona }) => {
      const p = persona.toLowerCase();
      expect(p).toContain('stratum');
      expect(p).toMatch(/context provided to you this turn/);
      expect(p).toMatch(/never invent|never fabricate/);
      // The anti-disclaimer line: the demo's recurring failure is a reply that refuses and then
      // complies, or opens with "as an AI assistant".
      expect(p).toContain('as an ai assistant');
    });
  });
});
