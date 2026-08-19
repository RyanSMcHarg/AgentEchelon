/**
 * Every value `seed-demo` writes to SSM must FIT, and that has to be knowable before a deploy.
 *
 * The seed writes each classification's persona and intent pack to a Standard-tier parameter, capped at
 * 4096 characters. When one outgrows it the failure is bad in a specific way: it lands MID-SEED. Basic
 * and standard are written, premium throws, and a retry reports the first two as "already set - leaving
 * it" and dies on the same parameter. Read as idempotent progress, the deployment is left with one
 * classification on the generic default taxonomy - which surfaces later as a classifier behaving oddly,
 * not as a seed that never finished.
 *
 * Nothing could catch this before a deploy, because seed-demo calls main() at import: importing it to
 * measure anything would run the seeder. The content now lives in demo/ modules (personas.ts,
 * intent-packs.ts) precisely so this test can weigh it.
 *
 * The budget is not an incidental AWS number. `intent-pack.ts` keeps keyword lists short *because* the
 * seeded packs live inside it, so a pack that no longer fits is a content decision to make deliberately,
 * not a limit to raise.
 */
import { SSM_STANDARD_TIER_MAX } from '../lambda/src/lib/seed-profile-definitions';
import { stratumIntentPack } from '../demo/intent-packs';
import { BASIC_PERSONA, STANDARD_PERSONA, PREMIUM_PERSONA } from '../demo/personas';
import { serializeSeedDefinition } from '../lambda/src/lib/active-profile';

const CLASSIFICATIONS = ['basic', 'standard', 'premium'] as const;
const PERSONAS: Record<(typeof CLASSIFICATIONS)[number], string> = {
  basic: BASIC_PERSONA,
  standard: STANDARD_PERSONA,
  premium: PREMIUM_PERSONA,
};

/** How the seeder serializes a pack for the parameter — must match seed-demo's own write. */
const packValue = (c: (typeof CLASSIFICATIONS)[number]) => JSON.stringify(stratumIntentPack(c));

function report(label: string, size: number): string {
  const over = size - SSM_STANDARD_TIER_MAX;
  return `${label}: ${size}/${SSM_STANDARD_TIER_MAX} (${over > 0 ? `${over} OVER` : `${-over} left`})`;
}

describe('every seeded value fits the parameter it is written to', () => {
  it.each(CLASSIFICATIONS)('the %s intent pack fits', (classification) => {
    const size = packValue(classification).length;
    if (size > SSM_STANDARD_TIER_MAX) {
      throw new Error(
        `${report(`${classification} intent pack`, size)}.\n`
        + 'seed-demo will throw on this parameter AFTER writing the earlier classifications, leaving the '
        + 'deployment part-seeded: the classification runs on the generic default taxonomy and the retry '
        + 'reports the others as "already set". Shorten this pack in demo/intent-packs.ts - trim keywords '
        + 'first (the LLM classifier reads `description`, so keywords only matter on the fallback path), '
        + 'and treat raising the parameter tier as the wrong lever.',
      );
    }
    expect(size).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
  });

  it.each(CLASSIFICATIONS)('the %s persona parameter fits', (classification) => {
    const size = PERSONAS[classification].length;
    if (size > SSM_STANDARD_TIER_MAX) {
      throw new Error(
        `${report(`${classification} persona`, size)}. seed-demo writes this to the per-deployment `
        + 'assistant-system-prompt parameter, which is the fallback seam when a profile version carries '
        + 'no persona. Shorten it in demo/personas.ts.',
      );
    }
    expect(size).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
  });

  it.each(CLASSIFICATIONS)('the %s profile definition fits once its persona is offloaded', (classification) => {
    // The DEFINITION is the other Standard-tier write in the seed. Its persona goes to S3
    // (SPEC-PORTABLE-PROFILES), so what has to fit is the definition without it - measured that way
    // here, matching seedActiveProfileDefinition.
    const withPersona = serializeSeedDefinition(classification, PERSONAS[classification]);
    expect(withPersona).not.toBeNull();
    const def = JSON.parse(withPersona as string) as Record<string, unknown>;
    delete def.persona;
    const size = JSON.stringify(def).length;
    if (size > SSM_STANDARD_TIER_MAX) {
      throw new Error(
        `${report(`${classification} definition (persona offloaded)`, size)}. The persona is already `
        + 'stored outside this parameter, so the model bundle, tool allowlist, machines and context '
        + 'selection are what exceed it.',
      );
    }
    expect(size).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
  });

  it('reports the headroom for every seeded value, so a shrinking margin is visible before it fails', () => {
    // Not an assertion - a printed budget. The premium pack was 36 characters from failing once, which
    // no test would have surfaced until it did.
    const lines = CLASSIFICATIONS.flatMap((c) => [
      report(`${c} intent pack`, packValue(c).length),
      report(`${c} persona`, PERSONAS[c].length),
    ]);
    console.log(`[seed budget]\n  ${lines.join('\n  ')}`);
    expect(lines.length).toBe(CLASSIFICATIONS.length * 2);
  });
});
