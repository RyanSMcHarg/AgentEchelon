/**
 * `extends: 'default'` - inherit the platform taxonomy instead of copying it - and the reason the
 * shipped demo does NOT use it.
 *
 * Two separate things are tested here, and keeping them apart is the point:
 *
 * 1. THE MECHANISM still works and is still supported. A deployment may inherit the platform intents
 *    and override one of them partially. A pack with no `extends` REPLACES outright, which is what lets
 *    a deployment DROP an intent it does not want.
 *
 * 2. THE DEMO USES REPLACE, deliberately. Inheriting gives every classification every platform intent,
 *    so a basic assistant answering an EXTERNAL conversation would recognize `report_generation` and
 *    attempt an internal-data report - declining well at best, which is not the same as not offering.
 *    Each demo pack therefore declares the whole taxonomy that assistant actually does. The scoping
 *    assertions below are the guard on that: they fail if a classification regains an intent it has no
 *    business recognizing.
 */
import {
  DEFAULT_INTENT_PACK,
  getIntentPack,
  _resetIntentPackCache,
  WORK_MANAGEMENT_INTENT_KEYS,
  canOpenWork,
} from '../../lambda/src/lib/intent-pack';
import { STRATUM_INLINE_INTENTS, stratumIntentPack } from '../../demo/intent-packs';

function resolveFrom(pack: unknown) {
  process.env.ASSISTANT_INTENT_PACK = JSON.stringify(pack);
  _resetIntentPackCache();
  return getIntentPack();
}

const keysOf = (pack: unknown) => resolveFrom(pack).intents.map((i) => i.key);

afterEach(() => {
  delete process.env.ASSISTANT_INTENT_PACK;
  _resetIntentPackCache();
});

describe('the extends mechanism', () => {
  const own = { key: 'find_recipe', description: 'ours', keywords: ['recipe'], delivery: 'PLACEHOLDER_UPDATE' };

  it('inherits every platform intent, own intents first', () => {
    const keys = keysOf({ extends: 'default', intents: [own] });
    expect(keys[0]).toBe('find_recipe');
    for (const d of DEFAULT_INTENT_PACK.intents) expect(keys).toContain(d.key);
  });

  it('a pack WITHOUT extends REPLACES, so a deployment can drop an intent', () => {
    // NOTHING IS INJECTED INTO AN AUTHORED PACK. A replacing pack contains exactly what it declares,
    // which is the feature `extends` exists to provide. The platform guarantees the assistant can open
    // work by REFUSING a version-carried pack that cannot (`canOpenWork`), not by adding to one.
    expect(keysOf({ intents: [own] })).toEqual(['find_recipe']);
  });

  it('a bare ARRAY pack still replaces (the oldest supported shape)', () => {
    expect(keysOf([own])).toEqual(['find_recipe']);
  });

  it('a PARTIAL override keeps every field it does not declare', () => {
    // The footgun this exists to remove: restating a platform intent without its `delivery` silently
    // dropped `report_generation` from TASK_MULTI_STEP to a one-shot reply.
    const platform = DEFAULT_INTENT_PACK.intents.find((d) => d.key === 'report_generation')!;
    const resolved = resolveFrom({
      extends: 'default',
      intents: [{ key: 'report_generation', instructions: 'Our way.' }],
    });
    const overridden = resolved.intents.find((i) => i.key === 'report_generation')!;
    expect(overridden.instructions).toBe('Our way.');
    expect(overridden.delivery).toBe(platform.delivery);
    expect(overridden.delivery).toBe('TASK_MULTI_STEP');
    expect(overridden.description).toBe(platform.description);
    expect(overridden.keywords).toEqual(platform.keywords);
    // And it replaces rather than duplicating.
    expect(resolved.intents.filter((i) => i.key === 'report_generation')).toHaveLength(1);
  });
});

describe('what each shipped assistant recognizes is scoped to what it can reach', () => {
  it('the demo packs REPLACE rather than inherit', () => {
    // If this regains `extends`, every classification silently regains every platform intent and the
    // scoping assertions below become vacuous.
    for (const tier of ['basic', 'standard', 'premium'] as const) {
      expect(stratumIntentPack(tier).extends).toBeUndefined();
    }
  });

  it('BASIC offers no work it cannot hand over, and no internal-data work', () => {
    // The rule, stated as a test: an EXTERNAL conversation must not hold an assistant that OFFERS a
    // report, an export or an image. Absent from the pack is what makes the router refuse one rather
    // than answer it (DESIGN-CAPABILITY-REFUSAL); see `capability-refusal.test.ts`.
    const keys = keysOf(stratumIntentPack('basic'));
    expect(keys).not.toContain('report_generation');
    expect(keys).not.toContain('data_extraction');
    expect(keys).not.toContain('image_generation');
    expect(keys).not.toContain('strategic_analysis');
    expect(keys).not.toContain('financial_metric');
    expect(keys).not.toContain('account_status');
    expect(keys).not.toContain('competitive_intel');
    // What it does do.
    expect(keys).toContain('product_info');
    expect(keys).toContain('guided_troubleshooting');
  });

  it('STANDARD reports from internal sources but reaches no financial or account material', () => {
    const keys = keysOf(stratumIntentPack('standard'));
    expect(keys).toContain('report_generation');
    expect(keys).toContain('data_extraction');
    expect(keys).toContain('directory_lookup');
    expect(keys).toContain('process_lookup');
    expect(keys).not.toContain('financial_metric');
    expect(keys).not.toContain('account_status');
    expect(keys).not.toContain('competitive_intel');
  });

  it('PREMIUM is the only one recognizing financial, account and competitive work', () => {
    const keys = keysOf(stratumIntentPack('premium'));
    for (const k of ['financial_metric', 'account_status', 'competitive_intel', 'report_generation', 'strategic_analysis']) {
      expect(keys).toContain(k);
    }
  });

  it('each classification declares its whole taxonomy, so nothing is inherited invisibly', () => {
    for (const tier of ['basic', 'standard', 'premium'] as const) {
      expect(keysOf(stratumIntentPack(tier)).sort())
        .toEqual(STRATUM_INLINE_INTENTS[tier].map((i) => i.key).sort());
    }
  });
});

describe('a pack that cannot open work is refused rather than repaired', () => {
  it('accepts a replacing pack that declares a work-management intent', () => {
    const core = WORK_MANAGEMENT_INTENT_KEYS[0];
    const pack = { intents: [{ key: core, description: 'work', delivery: 'TASK_MULTI_STEP' }] };
    expect(canOpenWork(pack.intents)).toBe(true);
  });

  it('reports a replacing pack that declares none, which is the assistant that cannot track work', () => {
    // The failure it names: a pack without `extends` replaces the taxonomy, so one declaring only its
    // own domain intents leaves nothing that opens a tracked task. Nothing errors at runtime - every
    // turn simply answers one-shot - which is why the write path is where it has to be caught.
    expect(canOpenWork([{ key: 'find_recipe' }, { key: 'wine_pairing' }])).toBe(false);
  });

  it('an EXTENDING pack is never at risk, because it inherits the core', () => {
    const inherited = DEFAULT_INTENT_PACK.intents.map((d) => ({ key: d.key }));
    expect(canOpenWork(inherited)).toBe(true);
  });
});
