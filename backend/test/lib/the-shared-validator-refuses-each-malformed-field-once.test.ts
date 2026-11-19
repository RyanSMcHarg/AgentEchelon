/**
 * THE SHARED VALIDATOR REFUSES EACH MALFORMED FIELD ONCE (ADR-067 stage 4, "One step schema").
 *
 * What it proves: a tool list is checked by one function at both levels of a workflow, so each malformed list (not a list,
 * a tool named twice, an unregistered tool, a state-changing tool where the step may only read) is refused once, in the
 * same words, whether it sits on an agent step, a prompt step, a task state's `tools` or its `requiresTool`; and both
 * validators read it from that one place rather than keeping a copy.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { toolListErrors } from '../../lambda/src/lib/step-fields';
import { eventWorkflowErrors, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { validateTaskStateMachine, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

const READ = 'load_platform_info';
const WRITE = 'advance_task_state';

const runWith = (tools: unknown): EventWorkflow => ({
  on: 'conversation-opened', types: ['ops'], initial: 'hello',
  states: {
    hello: { send: { to: 'room', template: 'ops-room-opening' }, onSuccess: 'look', onFailure: 'look' },
    look: {
      agent: { prompt: 'ops-first-look', to: 'room', deadlineMs: 20_000, tools, fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' } } },
      onSuccess: 'done', onFailure: 'done',
    },
    done: { disposition: 'success' },
  },
} as unknown as EventWorkflow);
const machineWith = (field: 'tools' | 'requiresTool', tools: unknown): TaskStateMachine => ({
  initial: 'work',
  states: {
    work: { transitions: ['done'], ...(field === 'requiresTool' ? { tools: [READ] } : {}), [field]: tools },
    done: { transitions: [], terminal: 'success' },
  },
} as unknown as TaskStateMachine);
const machineError = (m: TaskStateMachine): string => {
  try { validateTaskStateMachine('m', m); return ''; } catch (err) { return (err as Error).message; }
};

describe('a tool list, checked once at either level', () => {
  it.each([
    ['not a list', 'load_platform_info', /is a list of tool names/],
    ['a tool named twice', [READ, READ], /names the same tool twice/],
    ['an unregistered tool', ['no_such_tool'], /names "no_such_tool", which is not a registered tool/],
  ])('%s is refused once, in the same words, on a run step and on a task state', (_label, tools, message) => {
    const run = eventWorkflowErrors('ops', runWith(tools)).filter((e) => message.test(e));
    expect(run).toHaveLength(1);
    expect(run[0]).toMatch(/^eventWorkflows\.ops\.states\.look\.agent\.tools /);
    expect(machineError(machineWith('tools', tools))).toMatch(message);
    expect(machineError(machineWith('tools', tools))).toMatch(/state "work" tools /);
  });

  it('a state-changing tool is refused where the step may only read, and allowed on a task state', () => {
    const run = eventWorkflowErrors('ops', runWith([WRITE])).filter((e) => /changes state/.test(e));
    expect(run).toEqual(['eventWorkflows.ops.states.look.agent.tools names "advance_task_state", which changes state; an agent step executes read tools only, and proposes a consequential act with propose']);
    expect(toolListErrors([WRITE], 'state "work" tools')).toEqual([]);
  });

  it('a required tool is held to the same list rule', () => {
    expect(machineError(machineWith('requiresTool', ['no_such_tool']))).toMatch(/requiresTool names "no_such_tool", which is not a registered tool/);
    expect(machineError(machineWith('requiresTool', 'x'))).toMatch(/requiresTool is a list of tool names/);
  });

  it('both validators read the check from one place', () => {
    const run = readFileSync(resolve(__dirname, '../../lambda/src/lib/event-workflow.ts'), 'utf8');
    const machine = readFileSync(resolve(__dirname, '../../lambda/src/lib/task-state-machines.ts'), 'utf8');
    for (const src of [run, machine]) {
      expect(src).toContain("import { toolListErrors } from './step-fields.js';");
      expect(src).not.toMatch(/which is not a registered tool`/);
    }
  });
});
