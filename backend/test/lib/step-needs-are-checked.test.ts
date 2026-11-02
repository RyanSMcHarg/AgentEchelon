/**
 * A STEP SAYS WHAT IT NEEDS, AND AN ANSWER IS CHECKED AGAINST IT (maintainer, 2026-08-14).
 *
 * The rule: review the person's message against what the step needs; everything there, move the
 * workflow on; something missing, ask for that and only that.
 *
 * WHAT IT REPLACES. `awaits` said the machine was blocked on someone but never what would unblock
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
  awaitedPartyOf,
  type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { handleAdvanceTaskStateTool, taskToolSpecsFor, REQUIREMENT_SOURCES } from '../../lambda/src/lib/task-tools';

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
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).toContain('THIS STEP NEEDS');
    for (const need of ['the subject', 'the audience', 'the length or format']) {
      expect(prompt).toContain(need);
    }
  });

  it('tells the model to advance ONLY when the list is satisfied', () => {
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'), DEFAULT_TASK_STATE_MACHINES);

    // Named by the constant, not a literal: a prompt that tells a model to call a tool by a name that
    // no longer exists is silent - the model simply never calls it, and the task never moves.
    expect(prompt).toContain(ADVANCE_TASK_STATE_TOOL_NAME);
    expect(prompt).toMatch(/Everything there/i);
  });

  it('tells the model to ask for ONLY the missing part, and not to advance', () => {
    const prompt = buildTaskContextForPrompt(taskIn('data_extraction', 'collecting_requirements'), DEFAULT_TASK_STATE_MACHINES);

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
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).toMatch(/tell you to choose/i);
    expect(prompt).toMatch(/Do not ask again/i);
  });

  it('says nothing for a step with no declared needs', () => {
    // A confirmation IS the step. Rendering an empty checklist there would invite the model to invent
    // one and hold up a workflow on questions nobody decided to ask.
    const prompt = buildTaskContextForPrompt(taskIn('place_item', 'confirming'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).not.toContain('THIS STEP NEEDS');
    // The rest of the task grounding is untouched: this rule adds a section, it does not replace one.
    expect(prompt).toContain('ACTIVE TASK');
  });

  it('says nothing for a step the workflow is getting on with by itself', () => {
    // `generating` awaits nobody. A list of things to chase on a step the person was never asked about
    // would have the assistant interrogating them mid-render.
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'generating'), DEFAULT_TASK_STATE_MACHINES);

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

/**
 * A CONFIRMATION STEP TELLS THE MODEL WHAT COUNTS AS AGREEMENT.
 *
 * `resolvedByOneResponse` used to let the RUNTIME advance the machine on any reply, which at
 * `place_item.confirming` moved a proposal to `placed` - a success terminal - on "actually, make it 45
 * minutes" and on "no, do not add it". Nothing structural separates those from a "yes", so the flag now
 * reaches the only reader that can tell them apart. These assert the prompt, for the same reason the
 * `requires` tests above do: the judgement is the model's, and what is testable is that the rule gets
 * to it.
 */
describe('the step where one answer is enough says so, and says what is not an answer', () => {
  it('tells the model to take a clear agreement and advance', () => {
    const prompt = buildTaskContextForPrompt(taskIn('place_item', 'confirming'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).toContain('ONE ANSWER COMPLETES THIS STEP');
    expect(prompt).toContain(ADVANCE_TASK_STATE_TOOL_NAME);
  });

  it('tells the model a correction is not agreement, and to put the change back to them', () => {
    // The reported failure. Advancing here records the proposal the person had just asked to change,
    // and closes the task that would have carried the change.
    const prompt = buildTaskContextForPrompt(taskIn('place_item', 'confirming'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).toMatch(/not agreement/i);
    expect(prompt).toMatch(/corrected version/i);
  });

  it('tells the model a decline advances nothing and is not reported as done', () => {
    const prompt = buildTaskContextForPrompt(taskIn('place_item', 'confirming'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).toMatch(/do not advance and do not tell them it/i);
  });

  it('says nothing of the kind on a step that is not a confirmation', () => {
    // Requirements gathering takes as many turns as it takes; telling the model one answer finishes it
    // is the exact instruction `requires` exists to prevent.
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'), DEFAULT_TASK_STATE_MACHINES);

    expect(prompt).not.toContain('ONE ANSWER COMPLETES THIS STEP');
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

  // THE RULE MOVED ONTO THE NORMALIZER, AND THESE ARE WHAT PROVE IT DID.
  //
  // Left keyed on `awaitsUser`, the rule stops seeing a machine authored in the declared form: the
  // valid one below is rejected, and the invalid one is accepted because nothing it looks at is set.
  // Both directions are asserted, because a rule that only ever throws is as broken as one that never
  // does - it would simply refuse every new-form machine instead of checking any of them.
  it('accepts needs on a step that declares who it awaits', () => {
    expect(() => validateTaskStateMachine('good', machineWith({
      awaits: { party: 'requester' },
      requires: ['the audience'],
    }))).not.toThrow();
  });

  it('rejects needs on a step that awaits nobody, in a machine authored in the declared form', () => {
    // The whole machine is written in the new form; only the step carrying `requires` omits the wait.
    // A rule reading the old boolean sees nothing set anywhere and lets this through.
    const authoredNewForm: TaskStateMachine = {
      initial: 'waiting',
      states: {
        waiting: { transitions: ['unattended'], awaits: { party: 'requester' } },
        unattended: { transitions: ['done'], requires: ['the audience'] },
        done: { transitions: [], terminal: 'success' },
      },
    };
    expect(() => validateTaskStateMachine('bad', authoredNewForm))
      .toThrow(/state "unattended" declares requires but awaits nobody/);
  });

  it('rejects a wait on a party nothing resolves', () => {
    // Only `requester` ships. A reference the runtime cannot resolve leaves the step with no owner and
    // no way to say so, so it is refused at the ingress rather than discovered at the boundary.
    expect(() => validateTaskStateMachine('bad', machineWith({ awaits: { party: 'manager-of-requester' } })))
      .toThrow(/awaits an unknown party/);
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
      // Through the normalizer: a filter on the deprecated boolean finds nothing in a shipped machine
      // and leaves every assertion here passing over an empty list.
      const waiting = Object.values(machine.states).filter((s) => awaitedPartyOf(s));
      expect(waiting.length).toBeGreaterThan(0);
      expect(waiting.some((s) => (s.requires?.length ?? 0) > 0)).toBe(true);
    }
  });
});

/**
 * A NEED IS RECORDED WITH WHERE IT CAME FROM, AND NEVER INVENTED.
 *
 * Measured live: an extraction "confirmed" all three of its needs on the first message, including a
 * data source the person had never named. `requires` declares what binds; the declaration is what makes
 * each need carry its source - the person's message, quoted, or a retrieved passage, named - and the
 * handler refuses an advance out of such a step when any need lacks one. There is no `assumed`.
 *
 * Structural: a closed enum and a present string. The evidence is never read for what it says.
 */
const mockAdvance = jest.fn();
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...args),
}));

describe('a need carries its source, or the step does not advance', () => {
  beforeEach(() => {
    mockAdvance.mockReset();
    mockAdvance.mockImplementation(async (a: { task: Task; toState: string }) => ({ ok: true, from: a.task.taskState, to: a.toState }));
  });

  const advance = (collected: unknown) => handleAdvanceTaskStateTool({
    task: { ...taskIn('data_extraction', 'collecting_requirements'), details: {} } as Task,
    input: { to_state: 'extracting', reason: 'they confirmed', collected },
    machines: DEFAULT_TASK_STATE_MACHINES,
  });

  const sourced = [
    { need: 'what data to pull', value: 'churn-risk accounts', source: 'message', evidence: 'flagged as churn risk' },
    { need: 'where it comes from', value: 'the CRM export', source: 'context', evidence: 'crm/accounts.json' },
    { need: 'the output format', value: 'a table', source: 'message', evidence: 'as a table' },
  ];

  it('advances when every need has a source and evidence, and records them', async () => {
    const out = await advance(sourced);
    expect(out.result.ok).toBe(true);
    expect(out.details?.collectedRequirements).toEqual({
      'what data to pull': { value: 'churn-risk accounts', source: 'message', evidence: 'flagged as churn risk' },
      'where it comes from': { value: 'the CRM export', source: 'context', evidence: 'crm/accounts.json' },
      'the output format': { value: 'a table', source: 'message', evidence: 'as a table' },
    });
  });

  it.each([
    ['a need with no source', sourced.map((e, i) => (i === 1 ? { ...e, source: undefined } : e))],
    ['a need with blank evidence', sourced.map((e, i) => (i === 1 ? { ...e, evidence: '   ' } : e))],
    ['a need the model assumed', sourced.map((e, i) => (i === 1 ? { ...e, source: 'assumed', evidence: 'a guess' } : e))],
    ['a need left out', sourced.slice(0, 2)],
    ['the old shape, with no sources at all', sourced.map(({ need, value }) => ({ requirement: need, value }))],
  ])('refuses %s, names what is missing, and changes nothing', async (_label: string, collected: unknown) => {
    const out = await advance(collected);
    expect(out.result).toEqual({ ok: false, error: 'requirement_unsourced', from: 'collecting_requirements' });
    expect((out.payload.missing as string[]).length).toBeGreaterThan(0);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('offers no way to say a need was assumed', () => {
    expect([...REQUIREMENT_SOURCES]).toEqual(['message', 'context']);
    const [spec] = taskToolSpecsFor('data_extraction', DEFAULT_TASK_STATE_MACHINES, 'collecting_requirements');
    const items = (spec.toolSpec.inputSchema.json as unknown as {
      properties: { collected: { items: { properties: Record<string, { enum?: string[] }> } } };
    }).properties.collected.items;
    expect(items.properties.source.enum).toEqual(['message', 'context']);
    // The need is chosen from the step's declared list, so matching it is a lookup, not a reading.
    expect(items.properties.need.enum).toEqual(['what data to pull', 'where it comes from', 'the output format']);
  });

  it('asks nothing of a step that declares no needs', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: { ...taskIn('data_extraction', 'extracting'), details: {} } as Task,
      input: { to_state: 'validating', reason: 'records pulled' },
      machines: DEFAULT_TASK_STATE_MACHINES,
    });
    expect(out.result.ok).toBe(true);
  });
});

describe('a presented requirements step says what it is taking before it moves on', () => {
  it('tells the model to list each need with where it came from, and ask for confirmation', () => {
    const prompt = buildTaskContextForPrompt(taskIn('data_extraction', 'collecting_requirements'), DEFAULT_TASK_STATE_MACHINES);
    expect(prompt).toMatch(/where it came from/i);
    expect(prompt).toMatch(/confirm or correct/i);
    expect(prompt).toMatch(/Do not advance on this turn/i);
    expect(prompt).toMatch(/Never fill a need from nothing/i);
  });

  it('keeps the model\'s judgement on a requirements step that is not declared presented', () => {
    const custom: Record<string, TaskStateMachine> = {
      report_generation: {
        initial: 'collecting_requirements',
        states: {
          collecting_requirements: { transitions: ['done'], awaits: { party: 'requester' }, requires: ['the subject'] },
          done: { transitions: [], terminal: 'success' },
        },
      },
    };
    const prompt = buildTaskContextForPrompt(taskIn('report_generation', 'collecting_requirements'), custom);
    expect(prompt).toMatch(/Everything there ⇒ move on/);
    expect(prompt).not.toMatch(/Do not advance on this turn/);
  });
});
