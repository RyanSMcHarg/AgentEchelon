/**
 * A STEP RUNS THE ACTION ITS WORKFLOW DECLARES, AND THE RUNTIME TAKES THE DECLARED EDGE ON ITS OUTCOME
 * (SPEC-TASK-STATE-TRANSITIONS FR17, FR29).
 *
 * The platform runs what the workflow declares. A state that declares `action: { tool, args }` is entered,
 * the tool runs with its arguments bound to what the task recorded, the outcome is recorded on the task,
 * and the runtime takes `onSuccess` or `onFailure` as a runtime-driven edge carrying the action. What the
 * cases below hold the runner to:
 *  - validation refuses an action a turn could never run, and outcome edges that are not transitions;
 *  - a move into the state is refused by name while an argument has nothing recorded;
 *  - the tool runs only where the turn's allowlist permits it, and never on a gap;
 *  - one entry runs once, however often the turn is retried;
 *  - a cycle of action states stops at the turn's bound;
 *  - the outcome is a platform step, kept out of the model's tool-error rate.
 */
const mockAdvance = jest.fn();
jest.mock('../../lambda/src/lib/task-store', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-store');
  return {
    ...actual,
    // Observed, then authorized by the real (in-memory) store: no table is configured in a unit run.
    advanceTaskStateTo: (...args: unknown[]) => { mockAdvance(...args); return actual.advanceTaskStateTo(...args); },
  };
});

import {
  validateTaskStateMachine,
  entrySequenceOf,
  actionEdgesOf,
  type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { handleAdvanceTaskStateTool, bindActionArgs, toolsForStep, toolAllowedInStep, type TaskLoopContext } from '../../lambda/src/lib/task-tools';
import {
  runStepActions,
  stepActionStep,
  MAX_RUNTIME_MOVES_PER_TURN,
  type StepActionEnv,
} from '../../lambda/src/lib/state-actions';
import { claimStateAction, type Task } from '../../lambda/src/lib/task-tracking';
import { TRAVEL_QUOTE, TRAVEL_QUOTE_TEMPLATES, TRAVEL_QUOTE_COLLECTED } from './deterministic-workflow.fixture';

const sourced = (value: string) => ({ value, source: 'message', evidence: value });
const RECORDED = {
  collectedRequirements: { origin: sourced('SEA'), destination: sourced('JFK'), 'departure date': sourced('2026-11-03') },
};

const taskAt = (state: string, details: Record<string, unknown> = RECORDED, extra: Partial<Task> = {}): Task => ({
  taskId: 't1', channelArn: 'arn:c', userArn: 'arn:u', taskType: 'travel_quote', taskState: state,
  status: 'in_progress', details, stateHistory: [], createdAt: 'now', updatedAt: 'now', ...extra,
} as unknown as Task);

const ctxFor = (task: Task, machines: Record<string, TaskStateMachine> = { travel_quote: TRAVEL_QUOTE }): TaskLoopContext => ({
  task, machines, transitions: [], templates: TRAVEL_QUOTE_TEMPLATES,
});

const envWith = (payload: Record<string, unknown> | Error, allowed = true) => {
  const runTool = jest.fn(async () => {
    if (payload instanceof Error) throw payload;
    return payload;
  });
  const env: StepActionEnv = { runTool, toolAvailable: () => allowed };
  return { env, runTool };
};

const SEARCH_RESULT = {
  options: [{ id: 'f1', type: 'flight', summary: 'SEA to JFK, nonstop', priceUsd: 412, inPolicy: true, bookingUrl: 'https://x' }],
  policyNote: 'Economy is within policy.',
  portalUrl: 'https://travel.example',
};

beforeEach(() => mockAdvance.mockReset());

describe('validation refuses an action a turn could never run (FR29)', () => {
  const base = (searching: Record<string, unknown>): TaskStateMachine => ({
    ...TRAVEL_QUOTE,
    states: { ...TRAVEL_QUOTE.states, searching: { transitions: ['quoting', 'failed'], ...searching } as never },
  });

  it('accepts the deterministic workflow fixture', () => {
    expect(() => validateTaskStateMachine('travel_quote', TRAVEL_QUOTE)).not.toThrow();
  });

  it.each([
    ['an unregistered tool', { action: { tool: 'book_flight' }, onSuccess: 'quoting', onFailure: 'failed' }, /not a registered tool/],
    ['a proposal tool', { action: { tool: 'add_item' }, onSuccess: 'quoting', onFailure: 'failed' }, /not a registered tool/],
    ['the advance itself', { action: { tool: 'advance_task_state' }, onSuccess: 'quoting', onFailure: 'failed' }, /not a registered tool/],
    ['deliver_document off a delivering step', { action: { tool: 'deliver_document' }, onSuccess: 'quoting', onFailure: 'failed' }, /does not deliver/],
    ['an arg bound to nothing a binding names', { action: { tool: 'search_corporate_travel', args: { origin: 'SEA' } }, onSuccess: 'quoting', onFailure: 'failed' }, /a binding is/],
    ['an arg bound to a need no step requires', { action: { tool: 'search_corporate_travel', args: { origin: 'requirement:the airport' } }, onSuccess: 'quoting', onFailure: 'failed' }, /no state of this workflow requires/],
    ['an arg bound to a result no action records', { action: { tool: 'search_corporate_travel', args: { origin: 'tool:collecting.x' } }, onSuccess: 'quoting', onFailure: 'failed' }, /declares no action/],
    // ADR-060 slice 1d: a step action reads a variable source the platform publishes, and refuses one it does not.
    ['an arg bound to a variable source nobody publishes', { action: { tool: 'search_corporate_travel', args: { origin: 'person:nickname' } }, onSuccess: 'quoting', onFailure: 'failed' }, /"person:nickname", which is not a variable source the platform publishes/],
    ['no onSuccess', { action: { tool: 'search_corporate_travel' }, onFailure: 'failed' }, /no onSuccess/],
    ['an onSuccess that is not a transition', { action: { tool: 'search_corporate_travel' }, onSuccess: 'completed', onFailure: 'failed' }, /not one of its transitions/],
    ['an onFailure that is not a transition', { action: { tool: 'search_corporate_travel' }, onSuccess: 'quoting', onFailure: 'completed' }, /not one of its transitions/],
    ['outcome edges with no action', { onSuccess: 'quoting' }, /no action/],
    ['an action on a step that awaits somebody', { action: { tool: 'search_corporate_travel' }, onSuccess: 'quoting', onFailure: 'failed', awaits: { party: 'requester' } }, /awaits somebody/],
  ])('refuses %s', (_label, searching, message) => {
    expect(() => validateTaskStateMachine('travel_quote', base(searching))).toThrow(message);
  });

  it('takes a transition into a terminal failure state as the onFailure fallback, and refuses a step with neither', () => {
    const fallback = base({ action: { tool: 'search_corporate_travel' }, onSuccess: 'quoting' });
    expect(() => validateTaskStateMachine('travel_quote', fallback)).not.toThrow();
    expect(actionEdgesOf(fallback, 'searching')).toEqual({ onSuccess: 'quoting', onFailure: 'failed' });

    const noFailure: TaskStateMachine = {
      initial: 'a',
      states: {
        a: { transitions: ['b'], action: { tool: 'load_platform_info' }, onSuccess: 'b' },
        b: { transitions: [], terminal: 'success' },
      },
    };
    expect(() => validateTaskStateMachine('m', noFailure)).toThrow(/no onFailure and no transition into a terminal failure state/);
  });
});

describe('a move into an action step is refused while an argument has nothing recorded (action_unbound_arg)', () => {
  it('refuses by name and moves nothing, as a workflow refusal', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('collecting', {}), machines: { travel_quote: TRAVEL_QUOTE },
      input: { to_state: 'searching', reason: 'ready', collected: TRAVEL_QUOTE_COLLECTED },
      templates: TRAVEL_QUOTE_TEMPLATES,
    });
    // Every argument binds to a need this move records, so the move is taken.
    expect(out.result.ok).toBe(true);

    const machine: TaskStateMachine = {
      ...TRAVEL_QUOTE,
      states: {
        ...TRAVEL_QUOTE.states,
        searching: { ...TRAVEL_QUOTE.states.searching, action: { tool: 'search_corporate_travel', args: { origin: 'detail:originCode' } } },
      },
    };
    mockAdvance.mockReset();
    const refused = await handleAdvanceTaskStateTool({
      task: taskAt('collecting', {}), machines: { travel_quote: machine },
      input: { to_state: 'searching', reason: 'ready', collected: TRAVEL_QUOTE_COLLECTED },
    });
    expect(refused.result).toMatchObject({ ok: false, error: 'action_unbound_arg' });
    expect(refused.payload).toMatchObject({ refusal: 'action_unbound_arg', arg: 'origin', binding: 'detail:originCode' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('binds numbers and booleans as written and literals as their text', () => {
    expect(bindActionArgs({ tool: 't', args: { a: 3, b: false, c: 'literal:economy', d: 'requirement:origin' } }, RECORDED))
      .toEqual({ ok: true, args: { a: 3, b: false, c: 'economy', d: 'SEA' } });
  });
});

describe('entering the step runs the action and takes the declared edge (FR29)', () => {
  it('runs the tool with bound args, records the result, and takes onSuccess as a runtime-driven edge', async () => {
    const task = taskAt('searching');
    const ctx = ctxFor(task, { travel_quote: { ...TRAVEL_QUOTE, states: { ...TRAVEL_QUOTE.states, quoting: { ...TRAVEL_QUOTE.states.quoting, action: undefined, onSuccess: undefined, onFailure: undefined } } } });
    const { env, runTool } = envWith(SEARCH_RESULT);

    const runs = await runStepActions(ctx, env);

    expect(runTool).toHaveBeenCalledWith('search_corporate_travel', { origin: 'SEA', destination: 'JFK', departDate: '2026-11-03', cabin: 'economy' });
    expect(runs).toEqual([expect.objectContaining({ state: 'searching', tool: 'search_corporate_travel', ok: true, movedTo: 'quoting' })]);
    expect(task.taskState).toBe('quoting');
    expect((task.details?.actions as Record<string, { ok: boolean; result: unknown; key: string }>).searching)
      .toMatchObject({ tool: 'search_corporate_travel', ok: true, key: 'searching#0', result: SEARCH_RESULT });
    expect(mockAdvance).toHaveBeenCalledWith(expect.objectContaining({
      toState: 'quoting', by: 'system', action: { tool: 'search_corporate_travel', outcome: 'success' },
    }));
    expect(ctx.transitions).toEqual([{ from: 'searching', to: 'quoting' }]);
  });

  it('takes onFailure, recording the bounded class and no result, when the tool fails', async () => {
    const task = taskAt('searching');
    const { env } = envWith(new Error('upstream timed out'));
    const runs = await runStepActions(ctxFor(task), env);
    expect(runs[0]).toMatchObject({ ok: false, errorClass: 'timeout', movedTo: 'failed' });
    expect(task.taskState).toBe('failed');
    const recorded = (task.details?.actions as Record<string, Record<string, unknown>>).searching;
    expect(recorded).toMatchObject({ ok: false, errorClass: 'timeout' });
    expect(recorded.result).toBeUndefined();
    expect(mockAdvance).toHaveBeenCalledWith(expect.objectContaining({ toState: 'failed', action: { tool: 'search_corporate_travel', outcome: 'failure' } }));
  });

  it('does not run a tool the turn may not use, and records the refusal', async () => {
    const task = taskAt('searching');
    const { env, runTool } = envWith(SEARCH_RESULT, false);
    const runs = await runStepActions(ctxFor(task), env);
    expect(runTool).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ ok: false, errorClass: 'workflow_refusal', refusal: 'action_tool_not_allowed', movedTo: 'failed' });
  });

  it('does not run on a gap: an argument nothing recorded is refused and onFailure taken', async () => {
    const task = taskAt('searching', {});
    const { env, runTool } = envWith(SEARCH_RESULT);
    const runs = await runStepActions(ctxFor(task), env);
    expect(runTool).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ refusal: 'action_unbound_arg', movedTo: 'failed' });
  });

  it('is a no-op in a state that declares no action', async () => {
    const { env, runTool } = envWith(SEARCH_RESULT);
    expect(await runStepActions(ctxFor(taskAt('collecting')), env)).toEqual([]);
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe('one entry runs once (idempotent on retries and redelivery)', () => {
  it('keys the claim on the state and how many times the task entered it', async () => {
    const task = taskAt('searching', RECORDED, {
      stateHistory: [{ from: 'collecting', to: 'searching', at: 'a', by: 'tool' }, { from: 'searching', to: 'collecting', at: 'b', by: 'tool' }, { from: 'collecting', to: 'searching', at: 'c', by: 'tool' }],
    } as Partial<Task>);
    expect(entrySequenceOf(task.stateHistory, 'searching')).toBe(2);
    expect(await claimStateAction({ task, state: 'searching' })).toEqual({ claimed: true, key: 'searching#2' });
    // The same entry again, as a retried turn would ask: refused, and nothing runs.
    expect(await claimStateAction({ task, state: 'searching' })).toEqual({ claimed: false, key: 'searching#2', reason: 'already_claimed' });
  });

  it('does not run the tool a second time for an entry already claimed', async () => {
    const task = taskAt('searching', RECORDED, { actionRuns: ['searching#0'] } as Partial<Task>);
    const { env, runTool } = envWith(SEARCH_RESULT);
    const runs = await runStepActions(ctxFor(task), env);
    expect(runTool).not.toHaveBeenCalled();
    expect(runs).toEqual([expect.objectContaining({ ok: false, refusal: 'action_already_claimed' })]);
    // The task rests in the state; its outcome edges remain ordinary transitions the model can take.
    expect(task.taskState).toBe('searching');
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('runs again on a NEW entry into the same state', async () => {
    const task = taskAt('searching', RECORDED, {
      actionRuns: ['searching#0'],
      stateHistory: [{ from: 'collecting', to: 'searching', at: 'a', by: 'tool' }],
    } as Partial<Task>);
    const { env, runTool } = envWith(SEARCH_RESULT);
    await runStepActions(ctxFor(task, { travel_quote: { ...TRAVEL_QUOTE, states: { ...TRAVEL_QUOTE.states, quoting: { transitions: ['completed', 'failed'], produces: 'document' as const } } } }), env);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(task.actionRuns).toEqual(['searching#0', 'searching#1']);
  });
});

describe('a chain of action states stops at the turn\'s bound', () => {
  it('stops a cycle after MAX_RUNTIME_MOVES_PER_TURN runtime moves, recorded as a refusal', async () => {
    const loop: TaskStateMachine = {
      initial: 'a',
      states: {
        a: { transitions: ['b', 'failed'], action: { tool: 'load_platform_info' }, onSuccess: 'b', onFailure: 'failed' },
        b: { transitions: ['a', 'failed'], action: { tool: 'load_platform_info' }, onSuccess: 'a', onFailure: 'failed' },
        failed: { transitions: [], terminal: 'failure' },
      },
    };
    expect(() => validateTaskStateMachine('loop', loop)).not.toThrow();
    const task = { ...taskAt('a', {}), taskType: 'loop' } as Task;
    const ctx: TaskLoopContext = { task, machines: { loop }, transitions: [] };
    const { env, runTool } = envWith({ documents: [] });

    const runs = await runStepActions(ctx, env);

    expect(runTool).toHaveBeenCalledTimes(MAX_RUNTIME_MOVES_PER_TURN);
    expect(ctx.runtimeMoves).toBe(MAX_RUNTIME_MOVES_PER_TURN);
    expect(runs[runs.length - 1]).toMatchObject({ ok: false, refusal: 'runtime_move_bound' });
    // Counted across the turn: a second call in the same turn runs nothing more.
    expect(await runStepActions(ctx, env)).toEqual([expect.objectContaining({ refusal: 'runtime_move_bound' })]);
    expect(runTool).toHaveBeenCalledTimes(MAX_RUNTIME_MOVES_PER_TURN);
  });
});

describe('the whole deterministic path, at unit level', () => {
  it('runs the search, fills the template from its result, declares the document and finishes', async () => {
    const task = taskAt('searching');
    const ctx = ctxFor(task);
    const { env } = envWith(SEARCH_RESULT);

    const runs = await runStepActions(ctx, env);

    expect(runs.map((r) => [r.state, r.tool, r.ok, r.movedTo])).toEqual([
      ['searching', 'search_corporate_travel', true, 'quoting'],
      ['quoting', 'deliver_document', true, 'completed'],
    ]);
    expect(task.taskState).toBe('completed');
    expect(ctx.declaredTemplate).toMatchObject({ filled: true, state: 'quoting' });
    expect(ctx.declaredDocument).toContain('| SEA | JFK | 2026-11-03 |');
    expect(ctx.declaredDocument).toContain('SEA to JFK, nonstop, 412 USD.');
    expect(ctx.declaredDocument).toContain('Economy is within policy.');
    expect(ctx.transitions).toEqual([{ from: 'searching', to: 'quoting' }, { from: 'quoting', to: 'completed' }]);
  });

  it('takes onFailure from the delivering step when the search failed, delivering nothing', async () => {
    const task = taskAt('quoting', { ...RECORDED, actions: { searching: { tool: 'search_corporate_travel', ok: false, errorClass: 'timeout' } } });
    const ctx = ctxFor(task);
    const runs = await runStepActions(ctx, envWith(SEARCH_RESULT).env);
    expect(runs[0]).toMatchObject({ tool: 'deliver_document', ok: false, refusal: 'template_unbound_field', movedTo: 'failed' });
    expect(ctx.declaredDocument).toBeUndefined();
  });
});

describe('an action is a platform step, not a model tool call', () => {
  it('records its outcome under `action`, with no `tools`, no model and no model cost', () => {
    const step = stepActionStep({ state: 'searching', tool: 'search_corporate_travel', ok: false, errorClass: 'timeout', startedAt: 'a', endedAt: 'b' });
    expect(step).toEqual({
      stepLabel: 'platform-action:search_corporate_travel', modelId: 'platform', startedAt: 'a', endedAt: 'b',
      action: { state: 'searching', tool: 'search_corporate_travel', ok: false, errorClass: 'timeout' },
      estCostUsd: 0,
    });
    // The tool lens (intent_effectiveness tool_agg) reads steps[].tools[] only, so this is never a tool error.
    expect(step.tools).toBeUndefined();
  });
});

describe('a step declares the tools its turn may use, which narrows and never widens (FR28)', () => {
  const def = (tools?: string[]) => ({ transitions: ['x'], ...(tools ? { tools } : {}) });

  it('intersects the turn\'s allowlist with the step\'s, keeping the task tools', () => {
    expect(toolsForStep(['load_company_context', 'search_corporate_travel', 'advance_task_state'], def(['load_company_context'])))
      .toEqual(['load_company_context', 'advance_task_state']);
  });

  it('never grants a tool the turn does not allow', () => {
    expect(toolsForStep(['load_company_context', 'advance_task_state'], def(['search_corporate_travel']))).toEqual(['advance_task_state']);
  });

  it('takes the step\'s own list where the profile allows every registered tool', () => {
    expect(toolsForStep(undefined, def(['load_platform_info']))).toEqual(['load_platform_info', 'advance_task_state', 'deliver_document']);
  });

  it('changes nothing for a step that declares no tools', () => {
    expect(toolsForStep(['load_company_context'], def())).toEqual(['load_company_context']);
    expect(toolsForStep(undefined, def())).toBeUndefined();
  });

  it('refuses a call outside the current step\'s tools, and never a task tool', () => {
    expect(toolAllowedInStep('load_company_context', def(['load_platform_info']))).toBe(false);
    expect(toolAllowedInStep('advance_task_state', def([]))).toBe(true);
    expect(toolAllowedInStep('load_company_context', def())).toBe(true);
  });

  it('refuses an unregistered or repeated tool name at validation', () => {
    const m = (tools: unknown): TaskStateMachine => ({
      initial: 'a', states: { a: { transitions: ['b'], tools: tools as string[] }, b: { transitions: [], terminal: 'success' } },
    });
    expect(() => validateTaskStateMachine('m', m(['load_company_context']))).not.toThrow();
    expect(() => validateTaskStateMachine('m', m(['crm_write']))).toThrow(/unknown tool/);
    expect(() => validateTaskStateMachine('m', m(['load_company_context', 'load_company_context']))).toThrow(/twice/);
    expect(() => validateTaskStateMachine('m', m('load_company_context'))).toThrow(/not a list/);
  });
});
