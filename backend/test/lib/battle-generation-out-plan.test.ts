/**
 * Phase-4 generation-out: resolveBattleGenerationOutPlan (pure). The
 * gen-out analogue of battle-vision-plan — pins the branch the premium
 * processor switches on: a registered image-gen id → 'generation' with
 * the resolved model/key/displayName; absent or unknown → 'text' (the
 * turn proceeds as a normal text battle, never fabricated/crashed).
 */
import { resolveBattleGenerationOutPlan } from '../../lambda/src/lib/async-processor-core';
import { IMAGE_GEN_MODELS } from '../../lambda/src/lib/image-gen-models';

const TITAN = 'amazon.titan-image-generator-v2:0';
const NOVA = 'amazon.nova-canvas-v1:0';

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
});
