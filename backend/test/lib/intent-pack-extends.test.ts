/**
 * `extends: 'default'` — inherit the platform taxonomy instead of copying it into every parameter.
 *
 * The behaviour that matters is EQUIVALENCE: a pack that inherits must resolve to exactly what the
 * copied-out pack resolved to, or this is a classification change wearing a storage change's clothes.
 * The demo seed's packs are the real subject, so they are what this compares.
 *
 * The other half is that the default stays REPLACE. A pack with no `extends` must still substitute for
 * the platform taxonomy outright - that is what lets a deployment REMOVE an intent it does not want,
 * and quietly turning every pack into an additive one would take that away without anyone asking.
 */
import {
  DEFAULT_INTENT_PACK,
  getIntentPack,
  _resetIntentPackCache,
} from '../../lambda/src/lib/intent-pack';
import { STRATUM_INLINE_INTENTS, stratumIntentPack } from '../../demo/intent-packs';

/** What the seeder used to write: own intents, then a verbatim copy of the platform pack. */
function inlinedCopy(tier: 'basic' | 'standard' | 'premium') {
  return { intents: [...STRATUM_INLINE_INTENTS[tier], ...DEFAULT_INTENT_PACK.intents] };
}

function resolveFrom(pack: unknown) {
  process.env.ASSISTANT_INTENT_PACK = JSON.stringify(pack);
  _resetIntentPackCache();
  return getIntentPack();
}

afterEach(() => {
  delete process.env.ASSISTANT_INTENT_PACK;
  _resetIntentPackCache();
});

describe('extends: default', () => {
  it.each(['basic', 'standard', 'premium'] as const)(
    'the %s pack resolves IDENTICALLY to the copy it replaced',
    (tier) => {
      const inherited = resolveFrom(stratumIntentPack(tier));
      const copied = resolveFrom(inlinedCopy(tier));
      // Same intents, same order, same content - the classifier prompt is built from this list, so
      // order is part of the contract, not an incidental.
      expect(inherited.intents).toEqual(copied.intents);
      expect(inherited.intents.map((i) => i.key)).toEqual(copied.intents.map((i) => i.key));
    },
  );

  it.each(['basic', 'standard', 'premium'] as const)(
    'the %s pack still carries every platform intent after inheriting',
    (tier) => {
      const resolved = resolveFrom(stratumIntentPack(tier));
      for (const d of DEFAULT_INTENT_PACK.intents) {
        expect(resolved.intents.map((i) => i.key)).toContain(d.key);
      }
      // ...and its own, first.
      expect(resolved.intents[0].key).toBe(STRATUM_INLINE_INTENTS[tier][0].key);
    },
  );

  it('a pack WITHOUT extends still REPLACES, so a deployment can drop an intent', () => {
    const resolved = resolveFrom({ intents: [{ key: 'only_this', description: 'the one intent', keywords: ['x'] }] });
    expect(resolved.intents.map((i) => i.key)).toEqual(['only_this']);
    // The platform intents are gone, which is the point of replace semantics.
    expect(resolved.intents.map((i) => i.key)).not.toContain('report_generation');
  });

  it('a bare ARRAY pack still replaces (the oldest supported shape)', () => {
    const resolved = resolveFrom([{ key: 'legacy_only', description: 'array form', keywords: ['y'] }]);
    expect(resolved.intents.map((i) => i.key)).toEqual(['legacy_only']);
  });

  it('an own intent OVERRIDES a platform intent of the same key rather than duplicating it', () => {
    const resolved = resolveFrom({
      extends: 'default',
      intents: [{ key: 'report_generation', description: 'our own take', keywords: ['ours'] }],
    });
    const matches = resolved.intents.filter((i) => i.key === 'report_generation');
    expect(matches).toHaveLength(1);
    expect(matches[0].description).toBe('our own take');
  });

  it('inheriting is what keeps the seeded pack inside its parameter', () => {
    // The reason the flag exists, asserted as a number: the copied form was over the limit.
    const SSM_STANDARD_TIER_MAX = 4096;
    expect(JSON.stringify(inlinedCopy('premium')).length).toBeGreaterThan(SSM_STANDARD_TIER_MAX);
    expect(JSON.stringify(stratumIntentPack('premium')).length).toBeLessThan(SSM_STANDARD_TIER_MAX);
  });
});
