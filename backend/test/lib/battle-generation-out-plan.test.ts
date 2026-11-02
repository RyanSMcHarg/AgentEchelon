/**
 * Phase-4 generation-out: resolveBattleGenerationOutPlan (pure). The
 * gen-out analogue of battle-vision-plan — pins the branch the premium
 * processor switches on: a registered image-gen id → 'generation' with
 * the resolved model/key/displayName; absent or unknown → 'text' (the
 * turn proceeds as a normal text battle, never fabricated/crashed).
 */
import {
  resolveBattleGenerationOutPlan,
  resolveGenerationOutPlan,
  resolveTurnImageGenModelId,
} from '../../lambda/src/lib/async-processor-core';
import { IMAGE_GEN_MODELS } from '../../lambda/src/lib/image-gen-models';
import { ensureModelsBundle, type ProfileDefinitionBody } from '../../lambda/src/lib/active-profile';

const TITAN = 'amazon.titan-image-generator-v2:0';
const NOVA = 'amazon.nova-canvas-v1:0';
const STABILITY_CORE = IMAGE_GEN_MODELS.stability_image_core.bedrockModelId;
const STABILITY_ULTRA = IMAGE_GEN_MODELS.stability_image_ultra.bedrockModelId;

describe('resolveBattleGenerationOutPlan', () => {
  it("no imageGenModelId → 'text' (normal text battle)", () => {
    expect(resolveBattleGenerationOutPlan({})).toEqual({ action: 'text' });
    expect(resolveBattleGenerationOutPlan({ imageGenModelId: undefined })).toEqual({
      action: 'text',
    });
  });

  it("registered Titan id → 'generation' with model/key/displayName", () => {
    expect(resolveBattleGenerationOutPlan({ imageGenModelId: TITAN })).toEqual({
      action: 'generation',
      modelId: TITAN,
      modelKey: 'titan_image',
      displayName: IMAGE_GEN_MODELS.titan_image.displayName,
    });
  });

  it("registered Nova id → 'generation' (head-to-head, not a fallback pair)", () => {
    const plan = resolveBattleGenerationOutPlan({ imageGenModelId: NOVA });
    expect(plan.action).toBe('generation');
    expect(plan.modelId).toBe(NOVA);
    expect(plan.modelKey).toBe('nova_canvas');
  });

  it("unknown / non-image id → 'text' (honest fall-through, no fabrication)", () => {
    expect(resolveBattleGenerationOutPlan({ imageGenModelId: 'mystery.image' })).toEqual({
      action: 'text',
    });
    expect(
      resolveBattleGenerationOutPlan({ imageGenModelId: 'anthropic.claude-opus-4-6-v1' }),
    ).toEqual({ action: 'text' });
  });

  it('resolveBattleGenerationOutPlan is the same function as resolveGenerationOutPlan (back-compat alias)', () => {
    expect(resolveBattleGenerationOutPlan).toBe(resolveGenerationOutPlan);
  });
});
// The normal-turn generation trigger. Precedence: the experiment variant's image model > the served
// version's models.image, on an image_generation turn only. A duel side's image model is its pinned
// version's models.image, so a battle has no source of its own (DESIGN-SEPARATE-ASSISTANTS §3.7).
describe('resolveTurnImageGenModelId — the normal-turn generation trigger', () => {
  it("an image_generation turn uses the served version's models.image", () => {
    expect(
      resolveTurnImageGenModelId({ classification: 'premium',
        intent: 'image_generation',
        profileImageModelKey: 'stability_image_core',
      }),
    ).toBe(STABILITY_CORE);
  });

  it('the profile image model only fires on the image_generation intent (not other intents)', () => {
    for (const intent of ['general', 'report_generation', undefined]) {
      expect(
        resolveTurnImageGenModelId({ classification: 'premium', intent, profileImageModelKey: 'stability_image_core' }),
      ).toBeUndefined();
    }
  });

  it('a profile with no image capability yields undefined (text turn)', () => {
    expect(
      resolveTurnImageGenModelId({ classification: 'premium', intent: 'image_generation', profileImageModelKey: undefined }),
    ).toBeUndefined();
  });

  it('a duel side serves the image model its pinned version carries', () => {
    // Each side's version carries its own variant's image model, so the two sides of an image duel
    // reach this function with different profile image models and nothing else.
    expect(resolveTurnImageGenModelId({ classification: 'premium', intent: 'image_generation', profileImageModelKey: 'titan_image' })).toBe(TITAN);
    expect(resolveTurnImageGenModelId({ classification: 'premium', intent: 'image_generation', profileImageModelKey: 'nova_canvas' })).toBe(NOVA);
  });

  it('an unknown profile image key resolves to a text plan (validated downstream)', () => {
    const id = resolveTurnImageGenModelId({
      classification: 'premium',
      intent: 'image_generation',
      profileImageModelKey: 'not_a_real_image_model',
    });
    expect(id).toBeUndefined();
    expect(resolveGenerationOutPlan({ imageGenModelId: id }).action).toBe('text');
  });

  // An image experiment: the resolved variant's image model serves the turn in the NORMAL flow, so
  // probabilistic traffic A/Bs the variants' image models.
  it("an experiment image model WINS over the served version's models.image", () => {
    expect(
      resolveTurnImageGenModelId({ classification: 'premium',
        intent: 'image_generation',
        experimentImageModelKey: 'stability_image_ultra',
        profileImageModelKey: 'stability_image_core',
      }),
    ).toBe(STABILITY_ULTRA);
  });

  it('the experiment image model only fires on an image_generation turn', () => {
    for (const intent of ['general', 'report_generation', undefined]) {
      expect(
        resolveTurnImageGenModelId({ classification: 'premium', intent, experimentImageModelKey: 'stability_image_ultra' }),
      ).toBeUndefined();
    }
  });
});

// AN IMAGE MODEL IS RESOLVED ONLY WHERE THE CATALOG ALLOWS THE CLASSIFICATION ONE, whatever names it: a
// version, an experiment variant, or a duel side's pinned version all reach this one gate.
describe('resolveTurnImageGenModelId: only an image model the classification allows', () => {
  it.each(['basic', 'standard'])('%s, allowed no image model, resolves none from any source', (classification) => {
    expect(resolveTurnImageGenModelId({
      classification, intent: 'image_generation',
      experimentImageModelKey: 'stability_image_ultra', profileImageModelKey: 'stability_image_core',
    })).toBeUndefined();
  });

  it('premium resolves the same sources', () => {
    expect(resolveTurnImageGenModelId({
      classification: 'premium', intent: 'image_generation', profileImageModelKey: 'stability_image_core',
    })).toBe(STABILITY_CORE);
  });

  it('a TEXT model named as the image model is never used for an image', () => {
    expect(resolveTurnImageGenModelId({
      classification: 'premium', intent: 'image_generation', profileImageModelKey: 'opus',
    })).toBeUndefined();
  });

  it('an intent the served pack says needs an image counts, and one that needs none does not', () => {
    expect(resolveTurnImageGenModelId({
      classification: 'premium', intent: 'draw_me_a_chart', need: 'image', profileImageModelKey: 'stability_image_core',
    })).toBe(STABILITY_CORE);
    expect(resolveTurnImageGenModelId({
      classification: 'premium', intent: 'image_generation', need: 'document', profileImageModelKey: 'stability_image_core',
    })).toBeUndefined();
  });
});

// A TEXT QUESTION TO A BATTLE SIDE IS ANSWERED AS TEXT, even when that side's pinned version carries an
// image model: modality follows the intent, never the version.
describe('resolveTurnImageGenModelId: a battle side answers a text question as text', () => {
  const pinnedVersion = ensureModelsBundle({ modelKey: 'opus', models: { image: 'stability_image_core' } } as ProfileDefinitionBody);

  it('a text intent on a side whose version carries an image model resolves NO image model', () => {
    for (const intent of ['general', 'financial_metric', 'general', undefined]) {
      const id = resolveTurnImageGenModelId({ classification: 'premium', intent, profileImageModelKey: pinnedVersion.models?.image });
      expect(id).toBeUndefined();
      expect(resolveGenerationOutPlan({ imageGenModelId: id })).toEqual({ action: 'text' });
    }
  });

  it('the same side still generates an image on an image_generation turn', () => {
    expect(
      resolveTurnImageGenModelId({ classification: 'premium', intent: 'image_generation', profileImageModelKey: pinnedVersion.models?.image }),
    ).toBe(STABILITY_CORE);
  });
});
