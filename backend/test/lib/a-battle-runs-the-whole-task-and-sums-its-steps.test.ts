/**
 * ADR-064 DECISION 7: A BATTLE RUNS THE WHOLE TASK, AND THE IMAGE STEP COMPARES THE IMAGES.
 *
 * Arming refuses a battle whose intent draws an image (it needs one, or its workflow has a step that produces one)
 * unless both pinned versions name an image model for it, and the check that only warned at the turn is gone. A side's
 * scorecard cost is its steps summed, text and image alike, and is unknown rather than partial when a step's is.
 */
import * as fs from 'fs';
import * as path from 'path';
import { battleImageRefusal } from '../../lambda/src/manage-profiles';
import { summedStepCostUsd } from '../../lambda/src/lib/analytics-metadata';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const battle = { battleEnabled: true, experimentType: 'intent', intent: 'image_generation' };
const withImage = { byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } };

describe('arming an image battle', () => {
  it('refuses a battle whose sides name no image model for the intent', () => {
    expect(battleImageRefusal(battle, { byIntent: {} }, {}, DEFAULT_TASK_STATE_MACHINES))
      .toBe("image_generation draws an image, and the control and treatment versions name no image model for it; set models.byIntent['image_generation'].image on the live version, or arm with an image model on both variants");
  });
  it('arms where the control names one, which the treatment keeps, or the treatment\'s recipe names its own', () => {
    expect(battleImageRefusal(battle, withImage, {}, DEFAULT_TASK_STATE_MACHINES)).toBeNull();
    expect(battleImageRefusal(battle, withImage, { models: { byIntent: { image_generation: { image: { primary: 'stability_image_ultra' } } } } }, DEFAULT_TASK_STATE_MACHINES)).toBeNull();
  });
  it('a text battle, and an experiment that is not a battle, are not held to it', () => {
    expect(battleImageRefusal({ ...battle, intent: 'general' }, { byIntent: {} }, {}, DEFAULT_TASK_STATE_MACHINES)).toBeNull();
    expect(battleImageRefusal({ ...battle, battleEnabled: false }, { byIntent: {} }, {}, DEFAULT_TASK_STATE_MACHINES)).toBeNull();
  });
  it('the per-turn warning is gone, and arming applies the refusal', () => {
    const turn = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/battle-turn.ts'), 'utf8');
    expect(turn).not.toMatch(/needs an image but this side/);
    const mp = fs.readFileSync(path.join(__dirname, '../../lambda/src/manage-profiles.ts'), 'utf8');
    expect(mp).toContain("fail(409, imageRefusal, 'BATTLE_SIDE_HAS_NO_IMAGE_MODEL')");
  });
});

describe('a side\'s cost is its steps summed', () => {
  it('sums text and image steps', () => {
    expect(summedStepCostUsd([{ estCostUsd: 0.0012 }, { estCostUsd: 0.04 }, { estCostUsd: 0 }])).toBe(0.0412);
  });
  it('is unknown, not partial, when a step\'s cost is unknown, and absent with no steps', () => {
    expect(summedStepCostUsd([{ estCostUsd: 0.01 }, { estCostUsd: null }])).toBeNull();
    expect(summedStepCostUsd([])).toBeNull();
  });
  it('the scorecard reads the summed cost before the single-model estimate', () => {
    const core = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
    expect(core).toMatch(/const battleCost = summedStepCostUsd\(params\.steps\) \?\? estimateStepCostUsd\(/);
  });
});
