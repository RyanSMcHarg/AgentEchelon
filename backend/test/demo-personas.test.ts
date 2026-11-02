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
import { BASIC_PERSONA, STANDARD_PERSONA, PREMIUM_PERSONA, OPS_PERSONA } from '../demo/personas';
import { serializeSeedDefinition } from '../lambda/src/lib/active-profile';
import { SSM_STANDARD_TIER_MAX } from '../lambda/src/lib/seed-profile-definitions';
import { defaultProfileRegistry } from '../lib/profile-registry';

// THE PROFILE NAMES COME FROM THE REGISTRY, not from a literal. They were `basic`/`standard`/
// `premium` here, which is the same coincidence the config itself carried: a profile named after the
// classification it serves. When the config renamed them, `serializeSeedDefinition` returned null for
// every unknown name and this reported a budget failure rather than a stale fixture. Reading the
// registry means a future rename moves this test with it.
const PERSONAS = [
  { classification: 'basic', persona: BASIC_PERSONA },
  { classification: 'standard', persona: STANDARD_PERSONA },
  { classification: 'premium', persona: PREMIUM_PERSONA },
].map(({ classification, persona }) => ({
  name: defaultProfileRegistry.requireProfileFor(classification).name,
  persona,
}));

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

/**
 * AN ASSISTANT DECIDES ONCE: IT ANSWERS, OR IT DECLINES.
 *
 * Observed live on a standard conversation. Asked what causes tides, the assistant answered in full -
 * "the gravitational pull of the Moon on Earth's oceans, with the Sun playing a secondary role" - and
 * THEN said "This is outside my scope as Stratum's assistant".
 *
 * Two gaps produced that, and only one of them was about ordering.
 *
 *  1. The rule was one-directional. It said "never refuse and then comply", which is the opposite
 *     failure. Complying and then refusing is the worse of the two: the answer is already given, so
 *     the disclaimer only tells the person the assistant knew it should not have given it.
 *
 *  2. Scope was defined entirely in terms of ACCESS - what this tier may read of the company corpus.
 *     Nothing said what to do with a question that has no relationship to the company at all. The
 *     model had no instruction covering tides, so it did the natural thing and answered, then noticed
 *     it was off-brief and appended a disclaimer.
 */
describe('a persona decides once rather than doing both', () => {
  const personas: Array<[string, string]> = [
    ['basic', BASIC_PERSONA],
    ['standard', STANDARD_PERSONA],
    ['premium', PREMIUM_PERSONA],
  ];

  it.each(personas)('%s forbids answering and declining in the same reply, in either order', (_n, persona) => {
    expect(persona).toMatch(/DECIDE ONCE, THEN COMMIT/);
    // The ordering must be named in BOTH directions, or the rule reads as covering only the one that
    // was written down first - which is exactly how this shipped.
    expect(persona).toMatch(/never both in one reply, in either order/i);
  });

  it.each(personas)('%s carries no scope rule of its own: scope comes from the intent pack', (_n, persona) => {
    // The off-topic rule moved to the answering prompt, derived from the pack (`intentAnswerPrompt`):
    // the pack lists what the assistant offers and the prompt says to decline anything else, briefly,
    // and never answer it first. A persona that restated scope could contradict the pack - which is how
    // a code request the pack offered was declined as "outside my lane".
    expect(persona).not.toMatch(/nothing to do with Stratum or the platform/i);
  });

  // The ops assistant keeps the same three rules, so it is asserted here rather than in a parallel
  // block. Its OFF-TOPIC rule points the other way and is checked in the ops describe below.
  it.each([['ops', OPS_PERSONA]] as Array<[string, string]>)('%s keeps the decide-once rule', (_n, persona) => {
    expect(persona).toMatch(/DECIDE ONCE, THEN COMMIT/);
    expect(persona).toMatch(/never both in one reply, in either order/i);
  });
});

describe('the off-topic rule rides the pack-derived prompt, for every assistant', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { intentAnswerPrompt } = require('../lambda/src/lib/intent-answer');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DEFAULT_INTENT_PACK } = require('../lambda/src/lib/intent-pack');

  it('declines what the pack does not offer, briefly, and never answers it first', () => {
    const text = intentAnswerPrompt('general', DEFAULT_INTENT_PACK);
    expect(text).toMatch(/not what you are here for/i);
    expect(text).toMatch(/not an access problem/i);
    expect(text).toMatch(/Do not answer it first/i);
  });
});

/**
 * THE `ops` ROLE'S PERSONA, which is the first persona in this tree that belongs to an ASSISTANT rather
 * than to a classification.
 *
 * It has to be authored, and the absence was not cosmetic. `ops-premium` runs on premium's async
 * processor, so with no persona of its own the resolution chain (version persona ->
 * ASSISTANT_SYSTEM_PROMPT[_PARAM] -> `defaultPersonaFor(CLASSIFICATION)`) landed on premium's built-in
 * tier prose - premium is `systemPromptParam: false`, so the middle step does not exist for it. An
 * operations assistant was therefore introducing itself as a general premium-tier assistant.
 *
 * These assert the four things that make it an OPERATIONS persona rather than another business one: what
 * it reads, what it must say when it cannot read it, that it reports rather than acts, and that its
 * off-topic rule sends Stratum questions away instead of keeping them.
 */
describe('the ops persona', () => {
  const p = OPS_PERSONA.toLowerCase();

  it('fits the definition parameter it is seeded into', () => {
    const def = serializeSeedDefinition('ops-premium', OPS_PERSONA);
    expect(def).not.toBeNull();
    expect((def as string).length).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
  });

  it('names the deployment it assesses and the telemetry it reads', () => {
    expect(p).toContain('this deployment');
    expect(p).toContain('cloudwatch');
    // The four measurements the tool actually returns. A persona promising more than the read carries
    // is what produces a confident answer about something nobody measured.
    for (const metric of ['invocations', 'errors', 'throttles', 'duration']) {
      expect(p).toContain(metric);
    }
  });

  it('says an unavailable figure is said plainly, never estimated', () => {
    expect(p).toContain('unavailable');
    expect(p).toMatch(/never estimate/);
  });

  it('reports rather than acts, and says so', () => {
    // Nothing below the prompt enforces this: the role's boundary grants READS, so an assistant that
    // claims to have restarted something is not refused - it has just said something untrue.
    expect(OPS_PERSONA).toMatch(/YOU REPORT, YOU DO NOT ACT/);
    expect(p).toMatch(/restart/);
  });

  it('leaves its off-topic direction to its intent pack', () => {
    // A Stratum business question is outside what the ops pack offers, so the pack-derived prompt
    // declines it; a roommate that offers it is handed the question by the router.
    expect(p).not.toContain("stratum's business - a revenue figure");
  });

  it('does not claim the business corpus the premium assistant reads', () => {
    // A persona that offered financials would be promising material this assistant has no reason to
    // load and every reason to leave to the advisor sitting in the same conversation.
    expect(p).not.toMatch(/state the exact figure/);
    expect(p).toContain('is not yours');
  });
});
