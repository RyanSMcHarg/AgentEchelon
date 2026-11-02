/**
 * ONE RULE FOR EVERY MODEL (`lib/config/model-availability.ts`).
 *
 * 1. The platform allows (the catalog), the classification selects (`models` on its registry entry), text and
 *    image alike; a model is available in a classification exactly when it selects it.
 * 2. A model serves only uses its output fits: an image model an intent that needs an image, a text model
 *    everything else.
 * 3. An assistant manager selects within that: the profile write path refuses any other base model,
 *    classifier, per-intent route or image model, and a stored body that breaks it is ignored at read.
 * 4. No default an assistant did not choose (covered in `active-profile.test.ts`).
 *
 * The grant side is `test/image-gen-iam-parity.test.ts`; the resolver side is
 * `battle-generation-out-plan.test.ts` and `experiment-manager.resolution.test.ts`.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import {
  IMAGE_MODEL_KEYS,
  modelFits,
  outputForNeed,
  classificationAllows,
} from '../../lib/config/model-availability';
import { validateBody } from '../../lambda/src/lib/profile-lifecycle';
import { confineModelsToClassification, type ProfileDefinitionBody } from '../../lambda/src/lib/active-profile';
import { validateProfilesConfig, DEFAULT_PROFILES_CONFIG } from '../../lib/config/profiles';
import { defaultProfileRegistry } from '../../lib/profile-registry';

const CATALOG = getModelCatalog('us-east-1', '123456789012');
const CLASSIFICATIONS = ['basic', 'standard', 'premium'] as const;

describe('the classification\'s selection decides availability, and the catalog purpose, for every model', () => {
  const selected = (c: string) => DEFAULT_PROFILES_CONFIG.classifications.find((x) => x.value === c)!.models!.selected;
  const rows = [
    ...Object.values(CATALOG).flatMap((m) => CLASSIFICATIONS.map((c) => ({
      key: m.key as string, classification: c, output: 'text' as const, allowed: selected(c).includes(m.key),
    }))),
    ...IMAGE_MODEL_KEYS.flatMap((key) => CLASSIFICATIONS.map((c) => ({
      key: key as string, classification: c, output: 'image' as const, allowed: selected(c).includes(key),
    }))),
  ];

  it('reads the selection through the registry', () => {
    for (const c of CLASSIFICATIONS) expect(defaultProfileRegistry.modelsOf(c)!.selected).toEqual(selected(c));
  });

  it.each(rows)('$key in $classification: fits its own output iff allowed, never the other', ({ key, classification, output, allowed }) => {
    expect(modelFits(key, classification, output) === null).toBe(allowed);
    expect(modelFits(key, classification, output === 'text' ? 'image' : 'text')).not.toBeNull();
  });

  it('an intent that needs an image needs an image model; every other intent a text model', () => {
    expect(outputForNeed('image')).toBe('image');
    expect(outputForNeed('document')).toBe('text');
    expect(outputForNeed(undefined)).toBe('text');
  });

  it('only premium is allowed image models as shipped', () => {
    expect(CLASSIFICATIONS.filter((c) => classificationAllows(c, 'image'))).toEqual(['premium']);
  });
});

describe('the profile write path selects only within what the classification allows', () => {
  const body = (models: Record<string, unknown>, extra: Partial<ProfileDefinitionBody> = {}) =>
    ({ modelKey: 'haiku', models, ...extra }) as ProfileDefinitionBody;
  const errs = (b: ProfileDefinitionBody, classification: string) => validateBody(b, CATALOG, undefined, classification);
  const mentions = (list: string[], field: string) => list.some((e) => e.includes(field));

  it.each([
    ['modelKey', body({}, { modelKey: 'opus' })],
    ['models.default', body({ default: 'opus' })],
    ['models.classifier', body({ classifier: 'opus' })],
    ["models.byIntent['general'].primary", body({ byIntent: { general: { primary: 'opus' } } })],
    ["models.byIntent['general'].fallback", body({ byIntent: { general: { primary: 'haiku', fallback: 'opus' } } })],
    ['models.image', body({ image: 'stability_image_core' })],
    // ADR-064: a step override and an image part are held to the selection like every other model.
    ["models.byIntent['report_generation'].steps['generating'].primary", body({ byIntent: { report_generation: { primary: 'haiku', steps: { generating: { primary: 'opus' } } } } })],
    ["models.byIntent['report_generation'].steps['generating'].fallback", body({ byIntent: { report_generation: { primary: 'haiku', steps: { generating: { primary: 'haiku', fallback: 'opus' } } } } })],
    ["models.byIntent['image_generation'].image.primary", body({ byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } })],
  ])('refuses %s naming a model basic is not allowed', (field, b) => {
    expect(mentions(errs(b, 'basic'), field)).toBe(true);
  });

  it.each([
    ['models.image naming a text model', body({ image: 'opus' }), 'models.image'],
    ['models.default naming an image model', body({ default: 'stability_image_core' }), 'models.default'],
    ['models.classifier naming an image model', body({ classifier: 'stability_image_core' }), 'models.classifier'],
  ])('refuses %s, even where the model is allowed', (_why, b, field) => {
    expect(mentions(errs(b, 'premium'), field)).toBe(true);
  });

  it('accepts every field within what premium allows, each fit for its use', () => {
    const ok = body({
      default: 'opus', classifier: 'haiku',
      byIntent: { general: { primary: 'sonnet', fallback: 'haiku' }, image_generation: { primary: 'haiku', image: { primary: 'stability_image_core' } } },
    }, { modelKey: 'opus' });
    expect(errs(ok, 'premium').filter((e) => /model/.test(e))).toEqual([]);
  });
});

describe('a selection outside the classification is dropped by name, never crashed on', () => {
  it('drops the disallowed base model, classifier, image model and routes, and keeps the rest', () => {
    const { models, dropped } = confineModelsToClassification({
      default: 'opus', classifier: 'default', image: 'stability_image_core',
      byIntent: { general: { primary: 'haiku', fallback: 'opus' }, strategic_analysis: { primary: 'opus' } },
    }, 'basic');
    expect(models).toEqual({ classifier: 'default', byIntent: { general: { primary: 'haiku' } } });
    expect(dropped.length).toBe(4);
  });

  it('drops a step override and an image part the classification does not select, keeping the route (ADR-064)', () => {
    const { models, dropped } = confineModelsToClassification({
      byIntent: { report_generation: { primary: 'haiku', steps: { generating: { primary: 'opus' }, reviewing: { primary: 'haiku' } }, image: { primary: 'stability_image_core' } } },
    }, 'basic');
    expect(models?.byIntent).toEqual({ report_generation: { primary: 'haiku', steps: { reviewing: { primary: 'haiku' } } } });
    expect(dropped.map((d) => d.split(':')[0])).toEqual([
      "models.byIntent['report_generation'].image.primary",
      "models.byIntent['report_generation'].steps['generating'].primary",
    ]);
  });

  it('leaves the routes to the resolver when asked to (the read path)', () => {
    const { models } = confineModelsToClassification({ byIntent: { strategic_analysis: { primary: 'opus' } } }, 'basic', { routes: false });
    expect(models?.byIntent).toEqual({ strategic_analysis: { primary: 'opus' } });
  });

  it('confines nothing when the classification is unknown', () => {
    expect(confineModelsToClassification({ image: 'stability_image_core' }, undefined).dropped).toEqual([]);
  });
});

describe('`produces: image` is the model selection\'s to decide, not a declared output', () => {
  it('refuses a classification config that declares image in produces', () => {
    const bad = {
      ...DEFAULT_PROFILES_CONFIG,
      classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'standard' ? { ...c, produces: ['document', 'image'] } : c)),
    };
    expect(() => validateProfilesConfig(bad as never)).toThrow(/its model selection's to decide/);
  });
});
