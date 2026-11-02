/**
 * ADR-064 DECISION 3: A STEP MAY REQUIRE A TOOL BEFORE THE TASK LEAVES IT.
 *
 * `requiresTool: [name]` on a state: `advance_task_state` out of it is refused with `required_tool_not_run`, naming the
 * tool, until each listed tool returned success since the task last entered the state. The refusal is a workflow
 * refusal, so the tool-error rate does not count it. A success is recorded once per entry by the same conditional write
 * that claims a step action, under `tool:<name>:`. Validation refuses a required tool the step does not offer, one that
 * is not registered, and one on a step that declares an action; a version whose tools omit a required tool is refused.
 */
const mockAdvance = jest.fn(async (args: { task: { taskState?: string }; toState: string }) => ({ ok: true, from: args.task.taskState, to: args.toState }));
jest.mock('../../lambda/src/lib/task-store', () => ({
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...(args as [never])),
}));
import * as fs from 'fs';
import * as path from 'path';
import { validateTaskStateMachine, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { claimStateAction, requiredToolsNotRun, type Task } from '../../lambda/src/lib/task-tracking';
import { handleAdvanceTaskStateTool } from '../../lambda/src/lib/task-tools';

const lookup: TaskStateMachine = {
  initial: 'searching',
  states: {
    searching: { transitions: ['answering'], tools: ['search_corporate_travel'], requiresTool: ['search_corporate_travel'] },
    answering: { transitions: [], terminal: 'success' },
  },
};
const machines = { lookup };
const taskAt = (actionRuns: string[] = []): Task => ({
  taskId: 't1', channelArn: 'arn:c', taskType: 'lookup', taskState: 'searching', status: 'in_progress',
  stateHistory: [{ from: '', to: 'searching', at: '2026-10-29T00:00:00Z', by: 'tool' }], actionRuns,
} as unknown as Task);

describe('a step may require a tool before the task leaves it', () => {
  beforeEach(() => mockAdvance.mockClear());

  it('refuses the advance with required_tool_not_run, naming the tool, as a workflow refusal', async () => {
    const out = await handleAdvanceTaskStateTool({ task: taskAt(), input: { to_state: 'answering', reason: 'done' }, machines });
    expect(out.result).toMatchObject({ ok: false, error: 'required_tool_not_run' });
    expect(out.payload).toMatchObject({ ok: false, refusal: 'required_tool_not_run', tool: 'search_corporate_travel' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('records a success once per entry, and the advance then moves', async () => {
    const task = taskAt();
    const first = await claimStateAction({ task, state: 'searching', toolRun: 'search_corporate_travel' });
    expect(first).toMatchObject({ claimed: true, key: expect.stringMatching(/^tool:search_corporate_travel:searching#/) });
    expect(requiredToolsNotRun(task, 'searching', ['search_corporate_travel'])).toEqual([]);
    const out = await handleAdvanceTaskStateTool({ task, input: { to_state: 'answering', reason: 'found it' }, machines });
    expect(out.result.ok).toBe(true);
  });

  it('a success on an earlier entry does not count for the next one', () => {
    const task = taskAt(['tool:search_corporate_travel:searching#1']);
    (task as unknown as { stateHistory: unknown[] }).stateHistory.push({ from: 'searching', to: 'answering', at: 'x', by: 'tool' }, { from: 'answering', to: 'searching', at: 'y', by: 'tool' });
    expect(requiredToolsNotRun(task, 'searching', ['search_corporate_travel'])).toEqual(['search_corporate_travel']);
  });

  it('is a workflow refusal, so the tool-error rate does not count it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/task-tools.ts'), 'utf8');
    const set = src.slice(src.indexOf('const WORKFLOW_REFUSALS'), src.indexOf(']);', src.indexOf('const WORKFLOW_REFUSALS')));
    expect(set).toContain("'required_tool_not_run'");
  });
});

describe('validation holds requiresTool to what the step offers', () => {
  const machine = (def: Record<string, unknown>) => ({ initial: 'a', states: { a: { transitions: ['b'], ...def }, b: { transitions: [], terminal: 'success' } } }) as never;
  it('refuses a tool the step does not offer, naming both', () => {
    expect(() => validateTaskStateMachine('m', machine({ tools: ['load_platform_info'], requiresTool: ['search_corporate_travel'] })))
      .toThrow(/requiresTool names `search_corporate_travel`, which `a` does not offer/);
  });
  it('refuses an unregistered tool and a step that also declares an action', () => {
    expect(() => validateTaskStateMachine('m', machine({ requiresTool: ['no_such_tool'] }))).toThrow(/not a registered tool/);
    expect(() => validateTaskStateMachine('m', machine({ requiresTool: ['search_corporate_travel'], action: { tool: 'search_corporate_travel' }, onSuccess: 'b' })))
      .toThrow(/both an action and requiresTool/);
  });
  it('accepts a required tool the step offers', () => {
    expect(() => validateTaskStateMachine('lookup', lookup)).not.toThrow();
  });
  it('the loop records a required tool\'s success, and a version omitting it is refused at validate and activate', () => {
    const core = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
    expect(core).toMatch(/required\?\.includes\(toolUse\.name[\s\S]{0,120}await recordToolRun\(taskContext\.task, stepState/);
    const lc = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/profile-lifecycle.ts'), 'utf8');
    // Validate reads the structured refusals once (`requiredToolErrorDetails`) and activate the flat list.
    expect(lc.match(/await requiredToolError(s|Details)\(body, ssm, ssmRoot, profileName\)/g)?.length).toBe(3);
    expect(lc).toMatch(/\.\.\.toolDetails\.map\(\(e\) => e\.message\)/);
  });
});
