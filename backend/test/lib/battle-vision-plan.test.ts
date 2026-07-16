/**
 * Phase-3 vision-in: resolveBattleVisionPlan (pure). Pins the in-flight
 * branch the tier processor will switch on — model-key resolution
 * (variant key OR base bedrock id), the vision/text/reject decision,
 * and the "never send a malformed image" guards (unknown model or
 * unsupported content type → reject, not vision).
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { resolveBattleVisionPlan } from '../../lambda/src/lib/async-processor-core';

const catalog = getModelCatalog('us-east-1', '123456789012');
// Config-driven: derive a vision-capable model and a text-only model from the catalog's
// `visionCapable` flag, rather than hardcoding which specific models support vision.
type CatKey = keyof typeof catalog;
const VISION_KEY = (Object.keys(catalog) as CatKey[]).find((k) => catalog[k].visionCapable)!;
const TEXT_ONLY_KEY = (Object.keys(catalog) as CatKey[]).find((k) => !catalog[k].visionCapable)!;
const VISION_ID = catalog[VISION_KEY].bedrockModelId;
const TEXT_ONLY_ID = catalog[TEXT_ONLY_KEY].bedrockModelId;

describe('resolveBattleVisionPlan', () => {
  it("no image → 'text' with the resolved model key (variant side)", () => {
    expect(
      resolveBattleVisionPlan({ variantModelKey: VISION_KEY, baseModelId: VISION_ID, hasImageAttachment: false }),
    ).toEqual({ action: 'text', modelKey: VISION_KEY });
  });

  it("no image → 'text' resolving the default side via base bedrock id", () => {
    expect(
      resolveBattleVisionPlan({ baseModelId: VISION_ID, hasImageAttachment: false }),
    ).toEqual({ action: 'text', modelKey: VISION_KEY });
  });

  it("image + vision variant + png → 'vision' with the Converse format", () => {
    expect(
      resolveBattleVisionPlan({
        variantModelKey: VISION_KEY,
        baseModelId: VISION_ID,
        hasImageAttachment: true,
        imageContentType: 'image/png',
      }),
    ).toEqual({ action: 'vision', modelKey: VISION_KEY, imageFormat: 'png' });
  });

  it("image + default-side vision model (resolved from bedrock id) + jpeg → 'vision'", () => {
    const plan = resolveBattleVisionPlan({
      baseModelId: VISION_ID,
      hasImageAttachment: true,
      imageContentType: 'image/jpeg',
    });
    expect(plan).toEqual({ action: 'vision', modelKey: VISION_KEY, imageFormat: 'jpeg' });
  });

  it("image + text-only variant (titan) → reject with an actionable message", () => {
    const plan = resolveBattleVisionPlan({
      variantModelKey: TEXT_ONLY_KEY,
      baseModelId: VISION_ID,
      hasImageAttachment: true,
      imageContentType: 'image/png',
    });
    expect(plan.action).toBe('reject-text-only');
    expect(plan.modelKey).toBe(TEXT_ONLY_KEY);
    expect(plan.rejectMessage).toMatch(/can't read images/i);
  });

  it('image + unresolvable model (unknown variant AND unknown base id) → reject, modelKey null', () => {
    const plan = resolveBattleVisionPlan({
      variantModelKey: 'mystery',
      baseModelId: 'unknown.model.v9',
      hasImageAttachment: true,
      imageContentType: 'image/png',
    });
    expect(plan.action).toBe('reject-text-only');
    expect(plan.modelKey).toBeNull();
    expect(plan.rejectMessage).toContain('unknown.model.v9');
  });

  it('image + vision model but unsupported content type → reject (no malformed block)', () => {
    for (const ct of ['application/pdf', undefined]) {
      const plan = resolveBattleVisionPlan({
        variantModelKey: VISION_KEY,
        baseModelId: VISION_ID,
        hasImageAttachment: true,
        imageContentType: ct,
      });
      expect(plan.action).toBe('reject-text-only');
    }
  });

  it('default-side text-only base model (titan id) + image → reject', () => {
    const plan = resolveBattleVisionPlan({
      baseModelId: TEXT_ONLY_ID,
      hasImageAttachment: true,
      imageContentType: 'image/png',
    });
    expect(plan.action).toBe('reject-text-only');
    expect(plan.modelKey).toBe(TEXT_ONLY_KEY);
  });
});
