/**
 * A STEP THAT HANDS OVER NOTHING SAYS SO (found live 2026-10-26).
 *
 * At a report's outline step the model wrote the report into its reply and said "Your Q2 ARR Executive
 * Summary is ready above", having delivered nothing. A step that delivers nothing, in a workflow that
 * delivers, now tells the model not to write the document there or claim it is ready, naming the steps
 * that do deliver. Read from the machine's `delivers` declarations, never from a task type's name.
 */
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { buildTaskSystemPrompt } from '../../lambda/src/lib/task-step-prompt';

const HANDS_OVER_NOTHING = 'This step hands over no document';

describe('a step that hands over nothing says so', () => {
  it('the report outline step says it, and names the delivering steps', () => {
    const prompt = buildTaskSystemPrompt('report_generation', 'drafting_outline', DEFAULT_TASK_STATE_MACHINES);
    expect(prompt).toContain(HANDS_OVER_NOTHING);
    expect(prompt).toMatch(/never tell the person it is ready, attached or above/);
    expect(prompt).toContain('`generating`');
  });

  it('so does a requirements step', () => {
    expect(buildTaskSystemPrompt('report_generation', 'collecting_requirements', DEFAULT_TASK_STATE_MACHINES))
      .toContain(HANDS_OVER_NOTHING);
    expect(buildTaskSystemPrompt('data_extraction', 'validating', DEFAULT_TASK_STATE_MACHINES))
      .toContain(HANDS_OVER_NOTHING);
  });

  it('a delivering step does not', () => {
    expect(buildTaskSystemPrompt('report_generation', 'generating', DEFAULT_TASK_STATE_MACHINES))
      .not.toContain(HANDS_OVER_NOTHING);
  });

  it('a workflow with no delivering step renders as before', () => {
    const machine: TaskStateMachine = {
      initial: 'asking',
      states: { asking: { transitions: ['done'], prompt: 'Ask.' }, done: { transitions: [], disposition: 'success' } },
    } as unknown as TaskStateMachine;
    expect(buildTaskSystemPrompt('custom_flow', 'asking', { custom_flow: machine })).not.toContain(HANDS_OVER_NOTHING);
  });

  it('a pack that declares its own delivering step names that step, whatever the task is called', () => {
    const machine = {
      initial: 'gathering',
      states: {
        gathering: { transitions: ['handing_over'], prompt: 'Gather.' },
        handing_over: { transitions: ['done'], produces: 'document' as const, prompt: 'Hand it over.' },
        done: { transitions: [], disposition: 'success' },
      },
    } as unknown as TaskStateMachine;
    expect(buildTaskSystemPrompt('anything_at_all', 'gathering', { anything_at_all: machine })).toContain('`handing_over`');
  });
});
