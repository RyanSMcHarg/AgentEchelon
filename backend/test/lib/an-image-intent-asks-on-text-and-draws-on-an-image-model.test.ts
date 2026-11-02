/**
 * ADR-064 SLICE 3: TEXT AND IMAGE IN ONE INTENT.
 *
 * A step declares what it produces (`produces`, replacing `delivers`, which is refused by name); each shipped machine
 * delivers from the same states as before. `image_generation` is a multi-step task (gather, confirm, generate, done, revise):
 * its text steps run on a text model, and `generate` is the platform's `generate_image` action, run on entry with its
 * prompt bound to the recorded brief, on the image model of the route's `image` part, recorded as a step with its model
 * and cost. A route names an image model only in its image part, and the legacy `models.image` is refused.
 */
jest.mock('../../lambda/src/lib/task-store', () => ({
  claimStateAction: jest.fn(async (task: { taskState?: string }) => ({ claimed: true, key: `${task.taskState}#1` })),
  advanceTaskStateTo: jest.fn(async (args: { task: { taskState?: string }; toState: string }) => ({ ok: true, from: args.task.taskState, to: args.toState })),
}));
import { DEFAULT_TASK_STATE_MACHINES, validateTaskStateMachine, deliversDocument, GENERATE_IMAGE_ACTION } from '../../lambda/src/lib/task-state-machines';
import { runStepActions, stepActionStep } from '../../lambda/src/lib/state-actions';
import { imageRouteFor, routeKindError, textRoutesOf } from '../../lambda/src/lib/image-route';
import { validateDefinitionBody, defaultImageRoute } from '../../lambda/src/lib/active-profile';
import { DEFAULT_INTENT_PACK } from '../../lambda/src/lib/intent-pack';
import { stepOutputOf } from '../../lambda/src/lib/step-models';

const image = DEFAULT_TASK_STATE_MACHINES.image_generation;

describe('a step declares what it produces', () => {
  it('every shipped machine delivers a document from the same states as before', () => {
    const delivering = Object.fromEntries(Object.entries(DEFAULT_TASK_STATE_MACHINES)
      .map(([k, m]) => [k, Object.entries(m.states).filter(([, d]) => deliversDocument(d)).map(([s]) => s)])
      .filter(([, s]) => (s as string[]).length));
    expect(delivering).toEqual({
      data_extraction: expect.any(Array),
      report_generation: ['generating', 'revising'],
      code_delivery: expect.any(Array),
      technical_design: expect.any(Array),
    });
    for (const m of Object.values(DEFAULT_TASK_STATE_MACHINES)) for (const d of Object.values(m.states)) expect((d as { delivers?: unknown }).delivers).toBeUndefined();
  });

  it('a machine that still says delivers is refused naming produces', () => {
    expect(() => validateTaskStateMachine('legacy', { initial: 'a', states: { a: { transitions: ['b'] }, b: { transitions: [], terminal: 'success', delivers: true } } } as never))
      .toThrow(/declares delivers, which is retired; declare produces: 'document'/);
  });

  it('a step producing an image declares generate_image, and only it does', () => {
    expect(() => validateTaskStateMachine('x', { initial: 'a', states: { a: { transitions: ['b'], produces: 'image' }, b: { transitions: [], terminal: 'success' } } } as never))
      .toThrow(/produces an image, so it declares the action generate_image/);
  });
});

describe('the shipped image_generation workflow', () => {
  it('is a valid multi-step task: gather, confirm (presented when incomplete), generate (image), done, revise on reopen, failed', () => {
    expect(() => validateTaskStateMachine('image_generation', image)).not.toThrow();
    expect(image.initial).toBe('gather');
    expect(image.states.confirm.presented).toBe(true);
    expect(stepOutputOf(image.states.generate)).toBe('image');
    expect(image.states.generate.action).toEqual({ tool: GENERATE_IMAGE_ACTION, args: { prompt: 'requirement:what to draw' } });
    expect([image.states.generate.onSuccess, image.states.generate.onFailure]).toEqual(['done', 'failed']);
    expect(image.states.done.reopens).toEqual(['revise']);
    for (const s of ['gather', 'confirm', 'revise']) expect(stepOutputOf(image.states[s])).toBe('text');
    expect(DEFAULT_INTENT_PACK.intents.find((i) => i.key === 'image_generation')?.delivery).toBe('TASK_MULTI_STEP');
  });

  it('entering generate draws from the recorded brief, takes onSuccess, and records the image model and its cost', async () => {
    const task = {
      taskId: 't', channelArn: 'c', taskType: 'image_generation', taskState: 'generate',
      details: { collectedRequirements: { 'what to draw': { value: 'a lighthouse at dusk, watercolor', source: 'message', evidence: 'said so' } } },
    };
    const generateImage = jest.fn(async () => ({ ok: true, modelId: 'stability.stable-image-core-v1:1', imageCount: 1, estCostUsd: 0.04 }));
    const ctx = { task, machines: DEFAULT_TASK_STATE_MACHINES } as never;
    const runs = await runStepActions(ctx, { runTool: jest.fn(), toolAvailable: () => false, generateImage });
    expect(generateImage).toHaveBeenCalledWith('a lighthouse at dusk, watercolor', expect.objectContaining({ taskType: 'image_generation' }));
    expect(runs).toEqual([expect.objectContaining({ state: 'generate', tool: 'generate_image', ok: true, movedTo: 'done', modelId: 'stability.stable-image-core-v1:1' })]);
    expect(stepActionStep(runs[0])).toMatchObject({ modelId: 'stability.stable-image-core-v1:1', estCostUsd: 0.04, imageCount: 1 });
  });

  it('with no image model to draw on, the action fails and the task takes onFailure, naming why', async () => {
    const task = { taskId: 't', channelArn: 'c', taskType: 'image_generation', taskState: 'generate', details: { collectedRequirements: { 'what to draw': { value: 'x', source: 'message', evidence: 'x' } } } };
    const runs = await runStepActions({ task, machines: DEFAULT_TASK_STATE_MACHINES } as never, { runTool: jest.fn(), toolAvailable: () => false });
    expect(runs[0]).toMatchObject({ ok: false, refusal: 'image_model_unavailable', movedTo: 'failed' });
  });
});

describe('a route names its image model in its image part', () => {
  it('reads the image part, and a route with only an image part is no text route', () => {
    const models = { byIntent: { image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } } };
    expect(imageRouteFor(models, 'image_generation')).toEqual({ primary: 'stability_image_core', fallback: 'stability_image_ultra' });
    expect(textRoutesOf(models.byIntent as never)).toEqual({});
  });

  it('refuses an image model named as a route\'s text model, naming image.primary', () => {
    expect(routeKindError('image_generation', { primary: 'stability_image_core' })).toContain("models.byIntent['image_generation'].image.primary");
  });

  it('refuses the legacy models.image, naming the route\'s image part', () => {
    expect(validateDefinitionBody({ modelKey: 'haiku', models: { image: 'stability_image_core' } } as never))
      .toContain("models.image is retired; name the image model as models.byIntent['image_generation'].image.primary");
  });

  it('the seed writes the default image model as the image part', () => {
    expect(defaultImageRoute(undefined)).toEqual({ image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } });
  });
});
