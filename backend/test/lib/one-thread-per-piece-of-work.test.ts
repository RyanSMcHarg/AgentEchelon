/**
 * One thread per piece of work: the runtime declines to start a second turn on a task it already owes,
 * and `/stop` is the way out.
 *
 * A person asked "is this task complete?" while a report task was open. The runtime started a turn,
 * re-entered report generation, and wrote the report again - a second thread on one piece of work,
 * with the finished document sitting in the conversation above it.
 *
 * The decision needs no lock and no clock, which is what makes it safe. Drift already establishes that
 * the message is about the work in hand (it runs first and does not fire), and the task already records
 * whose turn it is: a state that does not `await` the requester is one the ASSISTANT owes, once a turn
 * has been given the task. These pin that rule at the level it is decided, and the cancel it depends on.
 */
import {
  awaitedPartyOf,
  assistantOwesTheStep as owes,
  machineHasAssistantStep,
  taskHasBeenGivenATurn,
  type TaskTurnRecord,
} from '../../lambda/src/lib/task-state-machines';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

/** A task the router opened: the opening turn's correlation id is on the row, and that turn works it. */
const OPENED_BY_A_TURN: TaskTurnRecord = { correlationId: 'turn-1' };
/** A row no turn has touched: written straight to the table, with no correlation id and no history. */
const NEVER_GIVEN_A_TURN: TaskTurnRecord = {};

/** The predicate the router applies: the router calls this same function. */
function assistantOwesTheStep(taskType: string, taskState: string, record: TaskTurnRecord | null = OPENED_BY_A_TURN): boolean {
  return owes(DEFAULT_TASK_STATE_MACHINES, taskType, taskState, record);
}

describe('whose turn it is, read from the task rather than from a lock', () => {
  it('says the ASSISTANT owes a report that is generating - so a message then is not input', () => {
    // The live case. The task sat in `generating`, the person asked a question, and the runtime
    // treated the question as task input.
    expect(assistantOwesTheStep('report_generation', 'generating')).toBe(true);
  });

  it('says the PERSON owes an outline waiting for approval - so their answer must be processed', () => {
    // The half that must never be swallowed. `drafting_outline` awaits the requester; declining here
    // would refuse the very answer the task is blocked on, and the task could never move again.
    expect(assistantOwesTheStep('report_generation', 'drafting_outline')).toBe(false);
  });

  it('says the PERSON owes an extraction paused for review', () => {
    expect(assistantOwesTheStep('data_extraction', 'validating')).toBe(false);
  });

  it('says nothing about a state no machine declares, so an unknown task never blocks a reply', () => {
    // Fails toward ANSWERING. A task type a deployment declared, or a state renamed since the row was
    // written, must not make the assistant mute - the worst outcome of this whole change would be a
    // conversation that stops replying.
    expect(assistantOwesTheStep('report_generation', 'a_state_nobody_declared')).toBe(false);
    expect(assistantOwesTheStep('a_type_nobody_declared', 'generating')).toBe(false);
  });
});

describe('the collecting step is the person\'s, so early answers are never declined', () => {
  it('leaves every awaiting state answerable', () => {
    // Walked rather than listed: a machine that adds an awaiting state gets this guarantee for free,
    // and a machine that stops awaiting anywhere shows up here as a change rather than as a silent
    // conversation.
    for (const [type, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES)) {
      for (const [state, def] of Object.entries(machine.states)) {
        if (awaitedPartyOf(def)) {
          expect(assistantOwesTheStep(type, state)).toBe(false);
        }
      }
    }
  });
});

describe('a task no turn has been given is not owed, whatever state it is in', () => {
  // 2026-10-16: a task written at `place_item.collecting` (which awaits nobody, because a turn passes
  // through it) declined every message with "I'm still working on that" before any turn had run.
  it('a row no turn has touched starts the work on the next message', () => {
    expect(DEFAULT_TASK_STATE_MACHINES.place_item.initial).toBe('collecting');
    expect(assistantOwesTheStep('place_item', 'collecting', NEVER_GIVEN_A_TURN)).toBe(false);
  });

  it('the opening turn still running at the INITIAL state holds the rule, so a follow-up is not a second turn', () => {
    // The review finding: exempting the initial state let a follow-up start a second turn beside the
    // opening turn of an `action_item` still working at `gathering`.
    expect(DEFAULT_TASK_STATE_MACHINES.action_item.initial).toBe('gathering');
    expect(assistantOwesTheStep('action_item', 'gathering', OPENED_BY_A_TURN)).toBe(true);
    expect(assistantOwesTheStep('place_item', 'collecting', OPENED_BY_A_TURN)).toBe(true);
  });

  it('a task that re-entered its initial state holds the rule: the edge log says a turn moved it', () => {
    const reentered: TaskTurnRecord = { stateHistory: [{ from: 'confirming', to: 'collecting' }] };
    expect(assistantOwesTheStep('place_item', 'collecting', reentered)).toBe(true);
  });

  it('a turn that ran without moving the task counts, through the stall counter', () => {
    expect(taskHasBeenGivenATurn({ turnsInState: 1 })).toBe(true);
    expect(taskHasBeenGivenATurn({ turnsInState: 0, stateHistory: [] })).toBe(false);
  });

  it('a row that could not be read holds the rule rather than risk the work twice', () => {
    expect(assistantOwesTheStep('place_item', 'collecting', null)).toBe(true);
  });

  it('the same machine past its start still holds the rule', () => {
    expect(assistantOwesTheStep('report_generation', 'generating')).toBe(true);
  });

  it('the platform machines keep the rule whatever the row says: a waiting drain holds the room', () => {
    expect(DEFAULT_TASK_STATE_MACHINES.queue_drain.initial).toBe('waiting');
    expect(assistantOwesTheStep('queue_drain', 'waiting', NEVER_GIVEN_A_TURN)).toBe(true);
    expect(assistantOwesTheStep('queue_drain', 'waiting', null)).toBe(true);
  });
});

/**
 * A REPLY TO WHAT THE TASK WAS WAITING FOR IS NEVER DECLINED (2026-10-16).
 *
 * Measured live: a `place_item` confirmation was applied at `confirming`, then declined against the
 * person's mirror row, which still read `collecting`. The task never reached `placed`. The router is
 * not invocable from a unit test, so what is held here is the decision's two inputs.
 */
describe('the router declines only a message that is not the awaited input, on the row\'s own state', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const router: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'),
    'utf8',
  );
  const block = router.slice(
    router.indexOf('const declineMachines = taskStateMachines();'),
    router.indexOf("a turn is already owed on this task; declining to start a second"),
  );

  it('a message that resumed waiting work is the awaited input, so it is never declined', () => {
    expect(block).toContain('!resumedWaitingWork');
  });

  it('the state that decides is the task row\'s, not the mirror\'s', () => {
    expect(block).toContain('const declineState = declineRow?.taskState || activeTask?.taskState;');
    expect(block).toContain('assistantOwesTheStep(declineMachines, activeTask.taskType, declineState, declineRow)');
  });

  it("the row is read whenever there is an active task, not only when the mirror's state would decline", () => {
    // A mirror lagging at an awaits state must not wave a second turn through.
    expect(block).not.toContain('stepIsTheAssistants(declineMachines, activeTask.taskType, activeTask.taskState)');
    expect(block).toContain('const declineRow = !resumedWaitingWork && activeTask?.taskType && !declinePlatform');
  });

  it('the row is not read for a machine with no state the assistant moves, whose answer the row cannot change', () => {
    expect(block).toContain('&& machineHasAssistantStep(declineMachines, activeTask.taskType)');
  });

  it('the pre-check is equivalent to the read: a machine it skips is owed at no state, by any row', () => {
    const machines = {
      ...DEFAULT_TASK_STATE_MACHINES,
      // Every state awaits the person or is terminal: nothing is ever the assistant's to move.
      survey: {
        initial: 'asking',
        states: {
          asking: { awaits: { party: 'requester' }, transitions: ['done'] },
          done: { transitions: [] },
        },
      },
    } as unknown as typeof DEFAULT_TASK_STATE_MACHINES;
    expect(machineHasAssistantStep(machines, 'survey')).toBe(false);
    expect(machineHasAssistantStep(machines, 'no_such_machine')).toBe(false);
    for (const state of ['asking', 'done', 'unknown']) {
      for (const record of [OPENED_BY_A_TURN, NEVER_GIVEN_A_TURN, null]) {
        expect(owes(machines, 'survey', state, record)).toBe(false);
      }
    }
    // A machine that has such a state is read, as before.
    expect(machineHasAssistantStep(DEFAULT_TASK_STATE_MACHINES, 'report_generation')).toBe(true);
  });

  it('the state the confirmation lands in is the person\'s, so the row\'s state does not decline it', () => {
    expect(assistantOwesTheStep('place_item', 'confirming')).toBe(false);
  });
});
