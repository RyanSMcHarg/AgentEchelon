/**
 * A STEP SAYS WHAT IT NEEDS, AND AN ANSWER IS CHECKED AGAINST IT (owner, 2026-08-14).
 *
 * The rule: review the person's message against what the step needs; everything there, move the
 * workflow on; something missing, ask for that and only that.
 *
 * WHAT IT REPLACES. `awaitsUser` said the machine was blocked on someone but never what would unblock
 * it, so nothing could tell a complete answer from a partial one - and a step with a single exit moved
 * on whatever arrived first. A report was drafted with no audience and no format, to nobody, in no
 * particular shape. It did not error and it did not look broken; it looked like an assistant that was
 * not listening.
 *
 * WHERE THE CHECK LIVES, and why these tests assert a PROMPT rather than a decision. The judgement is
 * semantic - only the answer's content can say whether it named an audience - so it belongs to the
 * model, on the turn that has the text. `applyUserResponseToTask` is explicit that its own check is
 * structural and cannot read content. So the testable property here is that the step's needs and the
 * rule REACH the model, and that they do not reach it when there is nothing to check.
 */
import {
  buildTaskContextForPrompt,
  type Task,
} from '../../lambda/src/lib/task-tracking';
import {
  DEFAULT_TASK_STATE_MACHINES,
  validateTaskStateMachine,
  TaskMachineValidationError,
  ADVANCE_TASK_STATE_TOOL_NAME,
  type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';

const taskIn = (taskType: string, taskState: string): Task => ({
  taskId: 't-1',
  channelArn: 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1',
  taskType,
  taskState,
  status: 'in_progress',
  userMessage: 'write me a report on the monorepo question',
} as Task);

describe('the step a person is holding says what it needs', () => {
  it('renders the needs into the prompt for a step that awaits the person', () => {
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'));

    expect(prompt).toContain('THIS STEP NEEDS');
    for (const need of ['the subject', 'the audience', 'the length or format']) {
      expect(prompt).toContain(need);
    }
  });

  it('tells the model to advance ONLY when the list is satisfied', () => {
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'));

    // Named by the constant, not a literal: a prompt that tells a model to call a tool by a name that
    // no longer exists is silent - the model simply never calls it, and the task never moves.
    expect(prompt).toContain(ADVANCE_TASK_STATE_TOOL_NAME);
    expect(prompt).toMatch(/Everything there/i);
  });

  it('tells the model to ask for ONLY the missing part, and not to advance', () => {
    const prompt = buildTaskContextForPrompt(taskIn('data_extraction', 'collecting_requirements'));

    // Both halves. Re-asking the whole question is the same complaint as advancing without the answer,
    // arriving from the other side: the person already answered part of it.
    expect(prompt).toMatch(/only the missing part/i);
    expect(prompt).toMatch(/do not advance/i);
    expect(prompt).toMatch(/do not re-ask/i);
  });

  it('treats a refusal to specify as an ANSWER, not a gap to chase', () => {
    // Without this the rule becomes a loop: the person says "you pick", the model finds the item still
    // missing, asks again, and the workflow never moves. An assistant that will not take yes for an
    // answer is worse than one that advanced too early.
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'));

    expect(prompt).toMatch(/tell you to choose/i);
    expect(prompt).toMatch(/Do not ask again/i);
  });

  it('says nothing for a step with no declared needs', () => {
    // A confirmation IS the step. Rendering an empty checklist there would invite the model to invent
    // one and hold up a workflow on questions nobody decided to ask.
    const prompt = buildTaskContextForPrompt(taskIn('place_item', 'confirming'));

    expect(prompt).not.toContain('THIS STEP NEEDS');
    // The rest of the task grounding is untouched: this rule adds a section, it does not replace one.
    expect(prompt).toContain('ACTIVE TASK');
  });

  it('says nothing for a step the workflow is getting on with by itself', () => {
    // `generating` awaits nobody. A list of things to chase on a step the person was never asked about
    // would have the assistant interrogating them mid-render.
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'generating'));

    expect(prompt).not.toContain('THIS STEP NEEDS');
  });

  it('reads the needs from the machine it is GIVEN, not the deployment default', () => {
    // A profile declaring its own machine must have its own step grounded, or the prompt chases the
    // pack's checklist while `advance_task_state` authorizes against the profile's graph.
    const custom: Record<string, TaskStateMachine> = {
      report_generation: {
        initial: 'collecting_requirements',
        states: {
          collecting_requirements: {
            transitions: ['done'],
            awaitsUser: true,
            requires: ['the client name', 'the billing code'],
          },
          done: { transitions: [], terminal: 'success' },
        },
      },
    };

    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'), custom);

    expect(prompt).toContain('the client name');
    expect(prompt).not.toContain('the audience');
  });
});

describe('a machine cannot declare needs that could never be met', () => {
  const machineWith = (state: Record<string, unknown>): TaskStateMachine => ({
    initial: 'waiting',
    states: {
      waiting: { transitions: ['done'], ...state } as never,
      done: { transitions: [], terminal: 'success' },
    },
  });

  it('rejects needs on a step that awaits nobody', () => {
    // `requires` is what the PERSON still owes. On a step nobody was asked about, it renders into the
    // prompt as a list to chase that no one is holding.
    expect(() => validateTaskStateMachine('bad', machineWith({ requires: ['the audience'] })))
      .toThrow(TaskMachineValidationError);
  });

  it('rejects needs on a step one reply completes', () => {
    // The two flags contradict: advance on any answer, and withhold until the list is satisfied.
    // Whichever won would be arbitrary, and it would differ between the router and the model.
    expect(() => validateTaskStateMachine('bad', machineWith({
      awaitsUser: true,
      resolvedByOneResponse: true,
      requires: ['the audience'],
    }))).toThrow(TaskMachineValidationError);
  });

  it('accepts needs on a step that awaits the person', () => {
    expect(() => validateTaskStateMachine('good', machineWith({
      awaitsUser: true,
      requires: ['the audience'],
    }))).not.toThrow();
  });

  it('leaves every shipped machine valid', () => {
    // The declarations added with this rule are themselves subject to it.
    for (const [name, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES)) {
      expect(() => validateTaskStateMachine(name, machine)).not.toThrow();
    }
  });

  it('gives the requirements-gathering steps something to check', () => {
    // The steps the rule exists for. A `requires` that was never populated would leave every assertion
    // above passing against a feature that does nothing on the deployment.
    for (const type of ['report_generation', 'data_extraction', 'guided_troubleshooting']) {
      const machine = DEFAULT_TASK_STATE_MACHINES[type];
      const waiting = Object.values(machine.states).filter((s) => s.awaitsUser);
      expect(waiting.length).toBeGreaterThan(0);
      expect(waiting.some((s) => (s.requires?.length ?? 0) > 0)).toBe(true);
    }
  });
});
