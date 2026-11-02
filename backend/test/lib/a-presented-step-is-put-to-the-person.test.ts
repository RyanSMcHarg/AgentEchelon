/**
 * A STEP THE WORKFLOW DECLARES `presented` IS PUT TO THE PERSON BEFORE THE TASK LEAVES IT.
 *
 * Measured live: a premium extraction's first message ("Extract our enterprise customer accounts
 * currently flagged as churn risk... Give it to me as a downloadable table.") was answered by ONE model
 * call that advanced `collecting_requirements -> extracting`, claimed all three needs were met, invented
 * where the data came from, and wrote the table beside the call. The person never saw the terms the
 * extraction was run on.
 *
 * THE WORKFLOW DECIDES, NOT THE PLATFORM. `presented` is a declaration on a state, like `awaits`,
 * `requires` and `delivers`, and it is read from the machine the turn resolved for the task's intent -
 * a shipped machine or one a deployment's pack declares. A machine that omits it leaves the step to
 * the model's judgement. These tests drive the handler with each, so the rule is shown to follow the
 * declaration rather than a list of intents.
 *
 * The signal is structural: `stateEnteredThisTurn`, which the loop derives from the task row (the
 * turn that opened it) and its own transitions, never from anything a person or model wrote.
 */
const mockAdvance = jest.fn();
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...args),
}));

import { handleAdvanceTaskStateTool } from '../../lambda/src/lib/task-tools';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import type { Task } from '../../lambda/src/lib/task-tracking';

const taskAt = (taskType: string, taskState: string): Task => ({
  taskId: 't-1',
  channelArn: 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c',
  taskType,
  taskState,
  status: 'in_progress',
  userMessage: 'Extract our enterprise customer accounts currently flagged as churn risk.',
  details: {},
} as unknown as Task);

/** Every need of the extraction's opening step, each with a source and evidence. */
const SOURCED = [
  { need: 'what data to pull', value: 'enterprise accounts flagged as churn risk', source: 'message', evidence: 'enterprise customer accounts currently flagged as churn risk' },
  { need: 'where it comes from', value: 'the CRM accounts export', source: 'context', evidence: 'crm/accounts-export.json' },
  { need: 'the output format', value: 'a table', source: 'message', evidence: 'as a downloadable table' },
];

beforeEach(() => {
  mockAdvance.mockReset();
  mockAdvance.mockImplementation(async (a: { task: Task; toState: string }) => ({ ok: true, from: a.task.taskState, to: a.toState }));
});

describe('the opening step always runs', () => {
  it('refuses to leave a presented step on the turn the task was opened, and changes nothing', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('data_extraction', 'collecting_requirements'),
      input: { to_state: 'extracting', reason: 'all three requirements are met', collected: SOURCED },
      machines: DEFAULT_TASK_STATE_MACHINES,
      stateEnteredThisTurn: true,
    });

    expect(out.result).toEqual({ ok: false, error: 'opening_step_must_be_presented', from: 'collecting_requirements' });
    expect(out.payload).toMatchObject({ ok: false, error: 'opening_step_must_be_presented' });
    // The message tells the model what to do instead: present the step and let the reply move it on.
    expect(String(out.payload.message)).toMatch(/present the step/i);
    expect(String(out.payload.message)).toMatch(/confirm or correct/i);
    expect(mockAdvance).not.toHaveBeenCalled();
    expect(out.details).toBeUndefined();
  });

  it('lets the person\'s reply move it on, on a later turn', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('data_extraction', 'collecting_requirements'),
      input: { to_state: 'extracting', reason: 'they confirmed the requirements', collected: SOURCED },
      machines: DEFAULT_TASK_STATE_MACHINES,
      stateEnteredThisTurn: false,
    });

    expect(out.result.ok).toBe(true);
    expect(mockAdvance).toHaveBeenCalledTimes(1);
  });

  it('holds every shipped opening requirements step the same way', async () => {
    for (const type of ['report_generation', 'code_delivery', 'technical_design', 'guided_troubleshooting']) {
      const machine = DEFAULT_TASK_STATE_MACHINES[type];
      const out = await handleAdvanceTaskStateTool({
        task: taskAt(type, machine.initial),
        input: { to_state: machine.states[machine.initial].transitions[0], reason: 'have it all' },
        machines: DEFAULT_TASK_STATE_MACHINES,
        stateEnteredThisTurn: true,
      });
      expect({ type, error: (out.result as { error?: string }).error }).toEqual({ type, error: 'opening_step_must_be_presented' });
    }
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('holds a presented step entered earlier in the same turn, so validating is shown before formatting', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('data_extraction', 'validating'),
      input: { to_state: 'formatting', reason: 'records look right', document: '# Churn risk\n\n| a |\n|---|\n| 1 |' },
      machines: DEFAULT_TASK_STATE_MACHINES,
      stateEnteredThisTurn: true,
    });
    expect((out.result as { error?: string }).error).toBe('opening_step_must_be_presented');
    expect(mockAdvance).not.toHaveBeenCalled();
  });
});

/**
 * THE INTENT'S DECLARED WORKFLOW BINDS, WHEREVER IT WAS DECLARED. A pack-declared intent whose machine
 * declares `presented` gets it enforced; one whose machine omits it is answered on the model's judgement.
 * Hydrated through the intent pack, the same path a deployment's machines take into a turn.
 */
describe('the rule follows the declaration on the intent\'s machine, not a list of intents', () => {
  const packWith = (presented: boolean) => JSON.stringify({
    intents: [{ key: 'vendor_review', description: 'review a vendor', keywords: ['vendor'], delivery: 'TASK_MULTI_STEP' }],
    machines: {
      vendor_review: {
        initial: 'scoping',
        states: {
          scoping: {
            transitions: ['reviewing'],
            awaits: { party: 'requester' },
            ...(presented ? { presented: true } : {}),
          },
          reviewing: { transitions: ['done'] },
          done: { transitions: [], terminal: 'success' },
        },
      },
    },
  });

  async function machinesFrom(pack: string): Promise<Record<string, TaskStateMachine>> {
    process.env.ASSISTANT_INTENT_PACK = pack;
    const { taskStateMachines, _resetIntentPackCache } = await import('../../lambda/src/lib/intent-pack');
    _resetIntentPackCache();
    const machines = taskStateMachines();
    delete process.env.ASSISTANT_INTENT_PACK;
    _resetIntentPackCache();
    return machines;
  }

  it('enforces `presented` on a pack-declared machine that declares it', async () => {
    const machines = await machinesFrom(packWith(true));
    expect(machines.vendor_review.states.scoping.presented).toBe(true);

    const out = await handleAdvanceTaskStateTool({
      task: taskAt('vendor_review', 'scoping'),
      input: { to_state: 'reviewing', reason: 'scope is clear' },
      machines,
      stateEnteredThisTurn: true,
    });
    expect((out.result as { error?: string }).error).toBe('opening_step_must_be_presented');
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('leaves a pack-declared machine that omits it to the model\'s judgement', async () => {
    const machines = await machinesFrom(packWith(false));
    expect(machines.vendor_review.states.scoping.presented).toBeUndefined();

    const out = await handleAdvanceTaskStateTool({
      task: taskAt('vendor_review', 'scoping'),
      input: { to_state: 'reviewing', reason: 'scope is clear' },
      machines,
      stateEnteredThisTurn: true,
    });
    expect(out.result.ok).toBe(true);
    expect(mockAdvance).toHaveBeenCalledTimes(1);
  });
});
