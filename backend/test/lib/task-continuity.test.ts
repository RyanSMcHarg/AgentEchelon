/**
 * THE CONTINUE-HERE DECISION, pinned as a decision rather than as a boolean expression.
 *
 * `resolveTaskContinuity` is one named seam with one caller, and it exists because the RULE inside it
 * is going to change: today "a task is live" is treated as the answer; the target asks whether the
 * message is unrelated to the TASK, and only then whether it is also unrelated to the CONVERSATION.
 * These tests describe the interim honestly - including the case it deliberately gets wrong - so the
 * change that replaces the body has something to fail against rather than a blank sheet.
 */
import {
  resolveTaskContinuity,
  type TaskContinuityInput,
} from '../../lambda/src/lib/task-continuity';

const decide = (over: Partial<TaskContinuityInput> = {}) =>
  resolveTaskContinuity({ liveTaskInChannel: false, recentlyEndedTaskInChannel: false, ...over });

describe('resolveTaskContinuity', () => {
  it('continues here while work is running in this conversation', () => {
    // The reported failure: a reply to the assistant's own outline question was offered a new
    // conversation because the task was owned by the assistant rather than the person.
    expect(decide({ liveTaskInChannel: true })).toEqual({ continueHere: true, signal: 'live' });
  });

  it('continues here just after work finished, so a question about the deliverable lands here', () => {
    expect(decide({ recentlyEndedTaskInChannel: true }))
      .toEqual({ continueHere: true, signal: 'recently_ended' });
  });

  it('does NOT continue when the conversation has no work at all', () => {
    // The other direction, and it is what keeps this from being drift switched off: a conversation
    // that never ran a task, or whose task ended long ago, is evaluated normally.
    expect(decide()).toEqual({ continueHere: false });
  });

  it('describes a conversation by what is RUNNING, not by what finished before it', () => {
    // Both true is an ordinary state - a task ended and another opened - and the counter should say
    // which one the operator is looking at.
    expect(decide({ liveTaskInChannel: true, recentlyEndedTaskInChannel: true }))
      .toEqual({ continueHere: true, signal: 'live' });
  });

  it('reports no signal when it is not the reason the turn continued', () => {
    // `signal` selects a skip counter. Emitting one on a turn that was never suppressed would count a
    // decision that was not made.
    expect(decide().signal).toBeUndefined();
  });

  it('INTERIM: a genuinely new subject during a live task is not offered its own conversation', () => {
    // Not a bug report - the accepted cost of erring toward continuity, written down so the two-axis
    // change has an assertion that must be revisited rather than a silent behaviour to rediscover.
    // When task-relatedness gains a signal, this case becomes `continueHere: false` and this test is
    // the one that should fail.
    expect(decide({ liveTaskInChannel: true }).continueHere).toBe(true);
  });

  it('is pure: the same inputs decide the same way, with nothing read', () => {
    // It takes only what the router already resolved. A decision that went looking for its own inputs
    // would put a read on every turn to answer a question most turns do not ask.
    const input: TaskContinuityInput = { liveTaskInChannel: false, recentlyEndedTaskInChannel: true };
    expect(resolveTaskContinuity(input)).toEqual(resolveTaskContinuity(input));
  });
});
