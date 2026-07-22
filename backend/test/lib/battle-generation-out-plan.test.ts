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

// The normal-turn generation trigger (Phase 2). Precedence: battle variant image model >
// legacy battle imageGenModelId > the active profile's models.image on an image_generation turn.
describe('resolveTurnImageGenModelId — the normal-turn generation trigger', () => {
  it("a NON-battle image_generation turn uses the profile's models.image", () => {
    expect(
      resolveTurnImageGenModelId({
        battleOn: false,
        intent: 'image_generation',
        profileImageModelKey: 'stability_image_core',
      }),
    ).toBe(STABILITY_CORE);
  });

  it('the profile image model only fires on the image_generation intent (not other intents)', () => {
    for (const intent of ['general', 'report_generation', undefined]) {
      expect(
        resolveTurnImageGenModelId({ battleOn: false, intent, profileImageModelKey: 'stability_image_core' }),
      ).toBeUndefined();
    }
  });

  it('a profile with no image capability yields undefined (text turn)', () => {
    expect(
      resolveTurnImageGenModelId({ battleOn: false, intent: 'image_generation', profileImageModelKey: undefined }),
    ).toBeUndefined();
  });

  it('a battle variant image model WINS over the profile image model', () => {
    expect(
      resolveTurnImageGenModelId({
        battleOn: true,
        intent: 'image_generation',
        variantImageModelKey: 'stability_image_ultra',
        profileImageModelKey: 'stability_image_core',
      }),
    ).toBe(STABILITY_ULTRA);
  });

  it('the legacy battle imageGenModelId path still works (below the variant, above the profile)', () => {
    // No variant image key ⇒ the legacy resolveBattleImageGenPair id is used.
    expect(
      resolveTurnImageGenModelId({ battleOn: true, intent: 'general', battleImageGenModelId: TITAN }),
    ).toBe(TITAN);
    // A variant image key still wins over the legacy id.
    expect(
      resolveTurnImageGenModelId({
        battleOn: true,
        intent: 'general',
        variantImageModelKey: 'nova_canvas',
        battleImageGenModelId: TITAN,
      }),
    ).toBe(NOVA);
  });

  it('battle-sourced image ids are ignored when battleOn is false', () => {
    expect(
      resolveTurnImageGenModelId({
        battleOn: false,
        intent: 'image_generation',
        variantImageModelKey: 'stability_image_ultra',
        battleImageGenModelId: TITAN,
        // Only the profile path applies off-battle.
        profileImageModelKey: 'stability_image_core',
      }),
    ).toBe(STABILITY_CORE);
  });

  it('an unknown variant/profile image key resolves to a text plan (validated downstream)', () => {
    const id = resolveTurnImageGenModelId({
      battleOn: false,
      intent: 'image_generation',
      profileImageModelKey: 'not_a_real_image_model',
    });
    expect(id).toBeUndefined();
    expect(resolveGenerationOutPlan({ imageGenModelId: id }).action).toBe('text');
  });
});
