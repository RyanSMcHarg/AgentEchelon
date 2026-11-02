/**
 * ADR-064 DECISION 6: AN EXPERIMENT VARIES ONE MODEL OF ONE INTENT, AND A TASK KEEPS ITS ARM.
 *
 * An `intent` experiment names a target: the intent's text model (the default), its image model (`kind: 'image'`) or
 * one step's model (`step`). The recipe changes only that model. A turn bound to a task counts toward an `intent`
 * experiment by the task's intent, whatever its message was classified as. A task records the arm it was opened under,
 * and stays on it while the experiment runs; once the experiment stops, the losing version is no longer served and the
 * task carries on with the live version.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  taskArmServes, countsTowardExperiment, experimentArmOf, experimentTargetError, validateAndSanitizeExperiment, ExperimentValidationError,
  type Experiment,
} from '../../lambda/src/lib/experiment-manager';
import { variantDeltaOf, controlMismatch } from '../../lambda/src/manage-profiles';

const exp = (target?: Record<string, unknown>, modelKeys: [string, string] = ['haiku', 'sonnet']) => ({
  experimentId: 'e', status: 'draft', experimentType: 'intent', intent: 'image_generation', tiers: ['premium'],
  ...(target ? { target } : {}),
  variants: [{ variantId: 'control', modelKey: modelKeys[0], weight: 50 }, { variantId: 'treatment', modelKey: modelKeys[1], weight: 50 }],
});

describe('the recipe changes only the targeted model', () => {
  it('the text model by default', () => {
    expect(variantDeltaOf(exp(), 'treatment').patch.models?.byIntent).toEqual({ image_generation: { primary: 'sonnet' } });
  });
  it('the image part for kind image', () => {
    expect(variantDeltaOf(exp({ kind: 'image' }, ['stability_image_core', 'stability_image_ultra']), 'treatment').patch.models?.byIntent)
      .toEqual({ image_generation: { image: { primary: 'stability_image_ultra' } } });
  });
  it('one step\'s override for a step target', () => {
    expect(variantDeltaOf(exp({ step: 'confirm' }), 'treatment').patch.models?.byIntent)
      .toEqual({ image_generation: { steps: { confirm: { primary: 'sonnet' } } } });
  });
  it('the control is compared against the live model the target names', () => {
    const live = { modelKey: 'opus', models: { default: 'opus', byIntent: { image_generation: { image: { primary: 'stability_image_core' }, steps: { confirm: { primary: 'haiku' } } } } } } as never;
    expect(controlMismatch(exp({ kind: 'image' }, ['stability_image_core', 'stability_image_ultra']), live, 'premium')).toBeNull();
    expect(controlMismatch(exp({ step: 'confirm' }), live, 'premium')).toBeNull();
    expect(controlMismatch(exp({ step: 'confirm' }, ['sonnet', 'opus']), live, 'premium')).toContain("step confirm");
  });
});

describe('the target is validated', () => {
  it('refuses a malformed target, and one on an experiment that does not vary an intent', () => {
    expect(experimentTargetError({ kind: 'video' }, 'intent')).toContain("'text' or 'image'");
    expect(experimentTargetError({ step: 'Not A State' }, 'intent')).toContain('target.step');
    expect(experimentTargetError({ kind: 'image' }, 'base_model')).toContain('only an intent experiment');
    expect(() => validateAndSanitizeExperiment({ ...exp({ wrong: 1 }) } as never)).toThrow(ExperimentValidationError);
  });
  it('an image target holds its variants to image models the classification selects', () => {
    expect(() => validateAndSanitizeExperiment(exp({ kind: 'image' }, ['stability_image_core', 'stability_image_ultra']) as never)).not.toThrow();
    expect(() => validateAndSanitizeExperiment(exp({ kind: 'image' }, ['haiku', 'sonnet']) as never)).toThrow(/modelKey/);
  });
});

describe('a task\'s turns count by its intent, and a task records its arm', () => {
  const served = { experimentType: 'intent' as const, intent: 'image_generation' };
  it('a "looks good" inside an image task counts toward the image experiment', () => {
    expect(countsTowardExperiment(served, 'acknowledgment', true)).toBe(false);
    expect(countsTowardExperiment(served, 'acknowledgment', true, 'image_generation')).toBe(true);
  });
  it('the arm is read off the task\'s own field, never off its details', () => {
    expect(experimentArmOf({ experimentArm: { experimentId: 'e', variantId: 'treatment', configId: 'c' } }))
      .toEqual({ experimentId: 'e', variantId: 'treatment', configId: 'c' });
    expect(experimentArmOf({ details: { experimentArm: { experimentId: 'e', variantId: 'treatment' } } } as never)).toBeNull();
    expect(experimentArmOf(null)).toBeNull();
  });
  it('the router records the arm on the task it opens, and passes the task intent to attribution', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/experimentArm: \{\s*experimentId: enrolledResolution\.experimentId, variantId: enrolledResolution\.variantId/);
    expect(router).toContain('countsTowardExperiment(enrolledResolution, classification.intent, !!classification.classifierModelId, activeTaskIntent)');
  });
});

describe('a task stays on its arm while the experiment runs, and takes the live version once it stops (decision J)', () => {
  const OPENED = '2026-10-20T10:00:00.000Z';
  const NOW = new Date('2026-10-21T10:00:00.000Z');
  const ARM = { experimentId: 'e', variantId: 'treatment' };
  const running = {
    experimentId: 'e', status: 'active', experimentType: 'intent', intent: 'image_generation', tiers: ['premium'],
    startDate: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z',
    variants: [{ variantId: 'control', modelKey: 'haiku', weight: 50 }, { variantId: 'treatment', modelKey: 'sonnet', weight: 50 }],
    transitions: [{ from: 'draft', to: 'active', at: '2026-10-01T00:00:00.000Z' }],
  } as never as Experiment;
  const stopped = (to: 'completed' | 'paused', at = '2026-10-20T12:00:00.000Z') =>
    ({ ...(running as object), status: to, transitions: [...(running.transitions ?? []), { from: 'active', to, at }] }) as never as Experiment;

  it('while it runs, the task is served the arm it was opened under', () => {
    expect(taskArmServes(running, 'premium', ARM, OPENED, NOW)).toBe(true);
  });

  it('once it stops, the arm is no longer served and the task takes the live version', () => {
    expect(taskArmServes(stopped('completed'), 'premium', ARM, OPENED, NOW)).toBe(false);
    // The arm is the version that became live: the live version is the one the task was already on.
    expect(taskArmServes(stopped('completed'), 'premium', { experimentId: 'e', variantId: 'control' }, OPENED, NOW)).toBe(false);
  });

  it('a pause after the task opened stops it too, and a resume does not bring the task back', () => {
    const resumed = { ...(stopped('paused') as object), status: 'active', transitions: [...(stopped('paused').transitions ?? []), { from: 'paused', to: 'active', at: '2026-10-20T13:00:00.000Z' }] } as never as Experiment;
    expect(taskArmServes(stopped('paused'), 'premium', ARM, OPENED, NOW)).toBe(false);
    expect(taskArmServes(resumed, 'premium', ARM, OPENED, NOW)).toBe(false);
  });

  it('an arm the experiment no longer holds, another experiment, or another classification is not served', () => {
    expect(taskArmServes(running, 'premium', { experimentId: 'e', variantId: 'gone' }, OPENED, NOW)).toBe(false);
    expect(taskArmServes(running, 'premium', { experimentId: 'other', variantId: 'treatment' }, OPENED, NOW)).toBe(false);
    expect(taskArmServes(running, 'standard', ARM, OPENED, NOW)).toBe(false);
    expect(taskArmServes(null, 'premium', ARM, OPENED, NOW)).toBe(false);
  });

  it('the router serves a resumed task its recorded arm where the conversation\'s enrollment differs', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toContain('experimentArmOf(activeTask)');
    expect(router).toMatch(/const taskArm = await resolveTaskArm\(openTaskArm, activeTask\?\.createdAt, effectiveClassification, channelArn,/);
    expect(router).toContain('if (taskArm) {\n          enrolledResolution = taskArm;');
    // Before the served version is read for the dispatch.
    expect(router.indexOf('enrolledResolution = taskArm;')).toBeLessThan(router.indexOf('resolvedVariantProfile = enrolledResolution.variantProfile;'));
  });
});
