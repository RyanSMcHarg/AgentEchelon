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
 * whose turn it is: a state that does not `await` the requester is one the ASSISTANT owes. These pin
 * that rule at the level it is decided, and the cancel it depends on.
 */
import { awaitedPartyOf } from '../../lambda/src/lib/task-state-machines';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

/** The predicate the router applies, expressed exactly as the router expresses it. */
function assistantOwesTheStep(taskType: string, taskState: string): boolean {
  const def = DEFAULT_TASK_STATE_MACHINES[taskType]?.states?.[taskState];
  return Boolean(def) && !awaitedPartyOf(def);
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
