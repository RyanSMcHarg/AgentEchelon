/**
 * Every value `seed-demo` writes to SSM must FIT, and that has to be knowable before a deploy.
 *
 * The seed writes each classification's persona to a 4096-character parameter, and each profile's
 * DEFINITION to another. When one outgrows its parameter the failure lands MID-SEED: basic and standard
 * are written, premium throws, and a retry reports the first two as "already set - leaving it" and dies
 * on the same parameter. Read as idempotent progress, the deployment is left part-seeded.
 *
 * Nothing could catch this before a deploy, because seed-demo calls main() at import: importing it to
 * measure anything would run the seeder. The content lives in demo/ modules (personas.ts,
 * intent-packs.ts) precisely so this test can weigh it.
 *
 * The INTENT PACK is no longer one of those writes. It rides each profile's version and is offloaded to
 * S3 as a body, so its budget is `MAX_INTENT_PACK_BYTES` (what a portable manifest can carry), not the
 * parameter limit. That is what lets a profile declare its whole taxonomy rather than inheriting the
 * platform set - and declaring it is what keeps a basic assistant from recognizing an internal-report
 * request at all.
 */
import { SSM_STANDARD_TIER_MAX } from '../lambda/src/lib/seed-profile-definitions';
import { stratumIntentPack, opsIntentPack } from '../demo/intent-packs';
import { MAX_INTENT_PACK_BYTES } from '../lambda/src/lib/intent-pack';
import { BASIC_PERSONA, STANDARD_PERSONA, PREMIUM_PERSONA, OPS_PERSONA } from '../demo/personas';
import { serializeSeedDefinition } from '../lambda/src/lib/active-profile';
import { defaultProfileRegistry } from '../lib/profile-registry';
import { OPS_BOUNDARY } from '../demo/boundaries';
import { OPS_WELCOME } from '../demo/welcomes';
import { legacyWelcomePlan } from '../lambda/src/lib/legacy-welcome-migration';

// CLASSIFICATIONS are classification values; the PROFILE serving each is a different string now that a
// profile name may not be a classification value, so the seed helpers are given the profile name.
const CLASSIFICATIONS = ['basic', 'standard', 'premium'] as const;
const profileNameFor = (c: string) => defaultProfileRegistry.requireProfileFor(c).name;
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
  it.each(CLASSIFICATIONS)('the %s intent pack fits its S3 body', (classification) => {
    // The pack is no longer written to the per-classification `assistant-intent-pack` parameter: it
    // rides the profile VERSION and is offloaded to S3 as a body, so the 4096-character parameter is
    // not its budget. `MAX_INTENT_PACK_BYTES` is, and it exists so a pack cannot grow past what a
    // portable manifest can carry - a pack that stores fine and fails only on EXPORT is the worst
    // moment to learn about it.
    const size = Buffer.byteLength(packValue(classification), 'utf8');
    if (size > MAX_INTENT_PACK_BYTES) {
      throw new Error(
        `${classification} intent pack is ${size}/${MAX_INTENT_PACK_BYTES} bytes. Trim the per-intent `
        + '`instructions` in demo/intent-packs.ts first - they are the field that grows.',
      );
    }
    expect(size).toBeLessThanOrEqual(MAX_INTENT_PACK_BYTES);
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
    const withPersona = serializeSeedDefinition(profileNameFor(classification), PERSONAS[classification]);
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

  it.each(CLASSIFICATIONS)('the %s definition fits once BOTH bodies are offloaded', (classification) => {
    // What the parameter actually holds on a deployment with a body store: the definition minus the
    // persona and minus the intent pack, both of which live in S3 (`personaRef`, `intentPackRef`).
    // Measured the way `seedActiveProfileDefinition` measures it, after `offloadBodies`.
    const seeded = serializeSeedDefinition(profileNameFor(classification), PERSONAS[classification], stratumIntentPack(classification));
    const def = JSON.parse(seeded as string) as Record<string, unknown>;
    delete def.persona;
    delete def.intentPack;
    const size = JSON.stringify(def).length;
    if (size > SSM_STANDARD_TIER_MAX) {
      throw new Error(
        `${report(`${classification} definition (both bodies offloaded)`, size)}. The persona and the pack `
        + 'are already outside this parameter, so the model bundle, tool allowlist, machines, onboarding '
        + 'and context selection are what exceed it.',
      );
    }
    expect(size).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
  });

  it('a materialized pack would NOT fit inline, which is why it is a body', () => {
    // The load-bearing consequence of each profile declaring its whole taxonomy instead of inheriting
    // the platform set: premium is over the parameter on its own. If someone later moves the pack back
    // inline to "simplify" storage, this fails and says why rather than dying part way through a seed.
    const premiumInline = JSON.parse(
      serializeSeedDefinition(profileNameFor('premium'), PERSONAS.premium, stratumIntentPack('premium')) as string,
    ) as Record<string, unknown>;
    delete premiumInline.persona;
    expect(JSON.stringify(premiumInline).length).toBeGreaterThan(SSM_STANDARD_TIER_MAX);
  });

  // THE `ops` ROLE'S ASSISTANT IS SEEDED TOO, so its two bodies have the same budget to keep. It is not
  // in `CLASSIFICATIONS` because it is not one: `ops-premium` is a second assistant inside `premium`, and
  // the seeder now walks every DECLARED assistant rather than one per classification.
  it('the ops definition fits once both bodies are offloaded', () => {
    const seeded = serializeSeedDefinition('ops-premium', OPS_PERSONA, opsIntentPack());
    expect(seeded).not.toBeNull();
    const def = JSON.parse(seeded as string) as Record<string, unknown>;
    delete def.persona;
    delete def.intentPack;
    const size = JSON.stringify(def).length;
    if (size > SSM_STANDARD_TIER_MAX) {
      throw new Error(report('ops definition (both bodies offloaded)', size));
    }
    expect(size).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
  });

  // THE WELCOME IS INLINE (W1): its workflows ride the parameter, so the ops assistant's, the largest the demo seeds,
  // must fit beside everything else, as the seed writes it and as `npm run migrate-legacy-welcome` writes the retired
  // welcome the seed wrote before (its fields repeated on the ops room's welcome, as the retired variant inherited them).
  it('the ops definition fits with its welcome workflows, as seeded and as the migration carries the retired one', () => {
    const fits = (eventWorkflows: Record<string, unknown>) => {
      const def = JSON.parse(serializeSeedDefinition('ops-premium', OPS_PERSONA, opsIntentPack(), undefined, OPS_BOUNDARY, eventWorkflows as never) as string) as Record<string, unknown>;
      delete def.persona;
      delete def.intentPack;
      return JSON.stringify(def).length;
    };
    const fields = { companyName: 'x'.repeat(20), companyBlurb: 'x'.repeat(80), accessBlurb: 'x'.repeat(220), examples: ['x'.repeat(60), 'x'.repeat(50), 'x'.repeat(55)], platformNote: 'x'.repeat(130) };
    const migrated = legacyWelcomePlan({ ...fields, byConversationType: { ops: { template: 'x'.repeat(170) } } }, undefined).eventWorkflows;
    for (const [what, size] of [['seeded', fits(OPS_WELCOME)], ['migrated', fits(migrated)]] as const) {
      if (size > SSM_STANDARD_TIER_MAX) throw new Error(report(`ops definition with its ${what} welcome`, size));
      expect(size).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
    }
  });

  it('the ops intent pack fits its S3 body', () => {
    const size = Buffer.byteLength(JSON.stringify(opsIntentPack()), 'utf8');
    expect(size).toBeLessThanOrEqual(MAX_INTENT_PACK_BYTES);
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
