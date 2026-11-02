/**
 * ADR-064 DECISION G: A REQUEST THAT ALREADY CARRIES THE COMPLETE BRIEF IS DRAWN IN ITS OWN TURN.
 *
 * `image_generation.confirm` is presented `when-incomplete` with a declared `brief`. The model records the brief it was
 * given (each need with its source and evidence) and advances `gather -> generate`, past `confirm`; the runtime allows
 * that edge only from a step the task entered on this turn and only where every need of the brief is on the record, and
 * nothing reads what anybody wrote. Any other request gathers and confirms as before. `always`, the declared value or a
 * version's `confirmBrief`, takes the edge out of the graph. A drawn image finishes the task, so a duel side that drew
 * from a complete brief has finished its round and does not park on the person.
 */
const mockAdvance = jest.fn(async (args: { task: { taskState?: string }; toState: string }) => ({ ok: true, from: args.task.taskState, to: args.toState }));
jest.mock('../../lambda/src/lib/task-store', () => ({
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...(args as [never])),
  claimStateAction: jest.fn(async (task: { taskState?: string }) => ({ claimed: true, key: `${task.taskState}#1` })),
}));
import {
  DEFAULT_TASK_STATE_MACHINES, briefNeedsPastConfirm, confirmBriefErrors, confirmStepPassed, directEdgeRefusal, legalTransitionsFrom,
  validateTaskStateMachine, withConfirmBrief, type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { advanceTaskStateTo as storeAdvance, shouldMarkTaskCompleted, type Task } from '../../lambda/src/lib/task-tracking';
import { handleAdvanceTaskStateTool, taskToolSpecsFor } from '../../lambda/src/lib/task-tools';
import { runStepActions } from '../../lambda/src/lib/state-actions';
import { buildTaskSystemPrompt } from '../../lambda/src/lib/task-step-prompt';
import { validateDefinitionBody } from '../../lambda/src/lib/active-profile';
import { PROFILE_FIELD_DECISIONS } from '../../lambda/src/lib/profile-field-decisions';

const M = DEFAULT_TASK_STATE_MACHINES;
const image = M.image_generation;

const atGather = (details: Record<string, unknown> = {}): Task => ({
  taskId: 't1', channelArn: 'arn:c', taskType: 'image_generation', taskState: 'gather', status: 'in_progress', details,
} as unknown as Task);

const need = (n: string, value: string) => ({ need: n, value, source: 'message', evidence: value });
const FOX = 'a watercolor of a red fox in snow at dusk, square, no text';
const completeBrief = [
  need('what to draw', FOX), need('the subject', 'a red fox in snow at dusk'),
  need('the style', 'watercolor'), need('the composition', 'square, the fox centered, no text'),
];

describe('the image workflow declares when its brief is confirmed', () => {
  it('confirm is presented when-incomplete with a declared brief, gather reaches generate directly, and a drawn image finishes the task', () => {
    expect(() => validateTaskStateMachine('image_generation', image)).not.toThrow();
    expect(image.states.confirm).toMatchObject({ presented: true, confirm: 'when-incomplete', brief: ['the subject', 'the style', 'the composition'] });
    expect(image.states.gather.transitions).toEqual(['confirm', 'generate']);
    expect(confirmStepPassed(image, 'gather', 'generate')).toBe('confirm');
    expect(confirmStepPassed(image, 'gather', 'confirm')).toBeUndefined();
    expect(confirmStepPassed(image, 'confirm', 'generate')).toBeUndefined();
    expect(image.states.generate.onSuccess).toBe('done');
    expect(image.states.done.reopens).toEqual(['revise']);
  });

  it('the step prompt names the way past confirm and the brief it needs, read from the machine', () => {
    const prompt = buildTaskSystemPrompt('image_generation', 'gather', M);
    expect(prompt).toContain('**Going straight to `generate`.**');
    expect(prompt).toContain('"the subject", "the style", "the composition"');
  });
});

describe('a complete brief draws in one turn', () => {
  beforeEach(() => mockAdvance.mockClear());

  it('the opening turn records the whole brief and moves gather -> generate, and the platform draws and finishes', async () => {
    const task = atGather();
    const out = await handleAdvanceTaskStateTool({ task, input: { to_state: 'generate', collected: completeBrief }, machines: M, stateEnteredThisTurn: true });
    expect(out.result).toMatchObject({ ok: true, from: 'gather', to: 'generate' });
    expect(mockAdvance).toHaveBeenCalledWith(expect.objectContaining({ toState: 'generate' }));

    task.taskState = 'generate';
    task.details = out.details;
    const generateImage = jest.fn(async () => ({ ok: true, modelId: 'stability.stable-image-core-v1:1', imageCount: 1, estCostUsd: 0.04 }));
    const runs = await runStepActions({ task, machines: M } as never, { runTool: jest.fn(), toolAvailable: () => false, generateImage });
    expect(generateImage).toHaveBeenCalledWith(FOX, expect.objectContaining({ taskType: 'image_generation' }));
    expect(runs).toEqual([expect.objectContaining({ state: 'generate', ok: true, movedTo: 'done', modelId: 'stability.stable-image-core-v1:1' })]);
  });

  it('the tool at gather offers the brief\'s needs in its need enum, so a model that follows the schema can record them', () => {
    const [tool] = taskToolSpecsFor('image_generation', M, 'gather');
    const json = tool.toolSpec.inputSchema.json as unknown as {
      required: string[]; properties: { collected: { items: { properties: { need: { enum: string[] } } } } };
    };
    expect(json.properties.collected.items.properties.need.enum).toEqual(['what to draw', 'the subject', 'the style', 'the composition']);
    expect(json.required).toContain('collected');
    expect(tool.toolSpec.description).toContain('"the subject", "the style", "the composition"');
    expect(briefNeedsPastConfirm('image_generation', 'gather', M)).toEqual(['the subject', 'the style', 'the composition']);
  });

  it('a step with no move past a confirmed step, or one always confirmed, offers only its own needs', () => {
    const always = withConfirmBrief(M, { image_generation: 'always' });
    expect(briefNeedsPastConfirm('image_generation', 'gather', always)).toEqual([]);
    expect(briefNeedsPastConfirm('image_generation', 'confirm', M)).toEqual([]);
    const [tool] = taskToolSpecsFor('image_generation', always, 'gather');
    const json = tool.toolSpec.inputSchema.json as unknown as { properties: { collected: { items: { properties: { need: { enum: string[] } } } } } };
    expect(json.properties.collected.items.properties.need.enum).toEqual(['what to draw']);
  });

  it('a brief recorded on an earlier call of the same turn counts, since the check reads the record', () => {
    const recorded = { collectedRequirements: Object.fromEntries(completeBrief.map((c) => [c.need, { value: c.value, source: 'message', evidence: c.evidence }])) };
    expect(directEdgeRefusal(image, 'gather', 'generate', recorded, { enteredThisTurn: true })).toBeUndefined();
  });
});

describe('an incomplete request still gathers and confirms', () => {
  beforeEach(() => mockAdvance.mockClear());

  it('the code refuses the direct edge when a need of the brief is missing, naming it, and nothing moves', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: atGather(), input: { to_state: 'generate', collected: [need('what to draw', 'a red fox'), need('the subject', 'a red fox')] },
      machines: M, stateEnteredThisTurn: true,
    });
    expect(out.result).toMatchObject({ ok: false, error: 'brief_incomplete' });
    expect(out.payload).toMatchObject({ refusal: 'brief_incomplete', step: 'confirm', missing: ['the style', 'the composition'] });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('a brief completed over later turns is confirmed: the direct edge is refused from a gather entered earlier', async () => {
    const out = await handleAdvanceTaskStateTool({ task: atGather(), input: { to_state: 'generate', collected: completeBrief }, machines: M, stateEnteredThisTurn: false });
    expect(out.result).toMatchObject({ ok: false, error: 'brief_not_in_request' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('gather -> confirm is unchanged, and confirm is still put to the person before it is left', async () => {
    const toConfirm = await handleAdvanceTaskStateTool({ task: atGather(), input: { to_state: 'confirm', collected: [need('what to draw', 'a red fox')] }, machines: M, stateEnteredThisTurn: true });
    expect(toConfirm.result).toMatchObject({ ok: true, to: 'confirm' });
    const atConfirm = { ...atGather(toConfirm.details), taskState: 'confirm' } as Task;
    const early = await handleAdvanceTaskStateTool({ task: atConfirm, input: { to_state: 'generate' }, machines: M, stateEnteredThisTurn: true });
    expect(early.result).toMatchObject({ ok: false, error: 'opening_step_must_be_presented' });
    const confirmed = await handleAdvanceTaskStateTool({ task: atConfirm, input: { to_state: 'generate' }, machines: M, stateEnteredThisTurn: false });
    expect(confirmed.result).toMatchObject({ ok: true, to: 'generate' });
  });

  it('the task store refuses the direct edge on its own when the record lacks the brief (the second layer)', async () => {
    const out = await storeAdvance({ task: atGather({ collectedRequirements: { 'what to draw': { value: 'a fox', source: 'message', evidence: 'a fox' } } }), toState: 'generate', machines: M });
    expect(out).toMatchObject({ ok: false, error: 'brief_incomplete', from: 'gather' });
  });
});

describe('always confirms, even when the brief is complete', () => {
  beforeEach(() => mockAdvance.mockClear());
  const always = withConfirmBrief(M, { image_generation: 'always' });

  it('a version setting always takes the direct edge out of the graph, and the prompt does not offer it', () => {
    expect(always.image_generation.states.confirm.confirm).toBe('always');
    expect(M.image_generation.states.confirm.confirm).toBe('when-incomplete');
    expect(legalTransitionsFrom('image_generation', 'gather', always)).toEqual(['confirm']);
    expect(legalTransitionsFrom('image_generation', 'gather', M)).toEqual(['confirm', 'generate']);
    expect(buildTaskSystemPrompt('image_generation', 'gather', always)).not.toContain('Going straight to');
  });

  it('a complete brief on the opening turn is refused the direct edge and goes through confirm', async () => {
    const complete = { collectedRequirements: Object.fromEntries(completeBrief.map((c) => [c.need, { value: c.value, source: 'message', evidence: c.evidence }])) };
    // The store authorizes the move against the turn's machines, which carry the version's `always`.
    const out = await storeAdvance({ task: atGather(complete), toState: 'generate', machines: always });
    expect(out).toMatchObject({ ok: false, error: 'illegal_transition', legal: ['confirm'] });
    expect(await storeAdvance({ task: atGather(complete), toState: 'confirm', machines: always })).toMatchObject({ ok: true, to: 'confirm' });
  });

  it('a machine that declares always is held to it the same way', () => {
    const declared: TaskStateMachine = { ...image, states: { ...image.states, confirm: { ...image.states.confirm, confirm: 'always' } } };
    expect(() => validateTaskStateMachine('image_generation', declared)).not.toThrow();
    expect(legalTransitionsFrom('image_generation', 'gather', { image_generation: declared })).toEqual(['confirm']);
  });
});

describe('a duel side with a complete brief does not park', () => {
  beforeEach(() => mockAdvance.mockClear());

  it('the side that opened its task this turn draws, and its task is finished, so round 1 completes rather than waiting on the person', async () => {
    const task = atGather();
    const out = await handleAdvanceTaskStateTool({ task, input: { to_state: 'generate', collected: completeBrief }, machines: M, stateEnteredThisTurn: true });
    expect(out.result.ok).toBe(true);
    task.taskState = 'generate';
    task.details = out.details;
    const runs = await runStepActions({ task, machines: M } as never, {
      runTool: jest.fn(), toolAvailable: () => false,
      generateImage: async () => ({ ok: true, modelId: 'stability.stable-image-ultra-v1:1', imageCount: 1, estCostUsd: 0.08 }),
    });
    expect(task.taskState).toBe('done');
    expect(runs[0]).toMatchObject({ movedTo: 'done' });
    // The round-1 rule (`async-processor-core.ts`): a side whose task is not finished is marked WAITING_FOR_USER.
    expect(shouldMarkTaskCompleted('image_generation', task.taskState, M)).toBe(true);
    expect(shouldMarkTaskCompleted('image_generation', 'confirm', M)).toBe(false);
  });
});

describe('validation', () => {
  const base = image;
  const withConfirm = (patch: Record<string, unknown>): TaskStateMachine => ({ ...base, states: { ...base.states, confirm: { ...base.states.confirm, ...patch } as never } });

  it('refuses an unknown policy, confirm on a step that is not presented, when-incomplete with no brief, and a brief without confirm', () => {
    expect(() => validateTaskStateMachine('m', withConfirm({ confirm: 'sometimes' }))).toThrow(/declares confirm "sometimes"; it is one of always, when-incomplete/);
    expect(() => validateTaskStateMachine('m', withConfirm({ presented: undefined }))).toThrow(/declares confirm but is not presented/);
    expect(() => validateTaskStateMachine('m', withConfirm({ brief: undefined }))).toThrow(/confirmed when-incomplete, so it declares the brief/);
    expect(() => validateTaskStateMachine('m', withConfirm({ confirm: undefined }))).toThrow(/declares brief but no confirm/);
  });

  it('a version\'s confirmBrief names a workflow with a confirmed step and a known policy', () => {
    expect(confirmBriefErrors({ image_generation: 'always' }, M)).toEqual([]);
    expect(confirmBriefErrors({ report_generation: 'always' }, M)[0]).toMatch(/names no workflow with a step that declares confirm; workflows that declare one: image_generation/);
    expect(confirmBriefErrors({ image_generation: 'never' }, M)[0]).toMatch(/is "never"; it is one of always, when-incomplete/);
    const noBrief = { image_generation: { ...image, states: { ...image.states, confirm: { ...image.states.confirm, confirm: 'always' as const, brief: undefined } } } };
    expect(confirmBriefErrors({ image_generation: 'when-incomplete' }, noBrief)[0]).toMatch(/declares no brief to check/);
    expect(validateDefinitionBody({ modelKey: 'haiku', confirmBrief: { image_generation: 'maybe' } } as never)).toContain("confirmBrief['image_generation'] is \"maybe\"; it is one of always, when-incomplete");
  });

  it('the console places the field, edited as JSON with a draft patch', () => {
    expect(PROFILE_FIELD_DECISIONS.confirmBrief).toMatchObject({ kind: 'json', guide: 'globalWorkflows' });
  });
});
