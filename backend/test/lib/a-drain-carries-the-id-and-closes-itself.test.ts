/**
 * A DRAIN CARRIES THE MESSAGE'S ID, AND IT CLOSES ITSELF (maintainer, 2026-09-03).
 *
 * Two rules, both found by review of the change that made a drain a task, and both invisible until
 * something else went wrong.
 *
 * ── THE ID, NOT THE MESSAGE ────────────────────────────────────────────────────────────────────
 *
 * The first version stored the queued message's decoded text as the task's excerpt. A queued message
 * may be TARGETED - addressed privately to the assistant - and the task is a row the room can see, so
 * that published the words of a private request into a conversation-visible record. It is exactly
 * what the queue itself already avoids by holding ids and resolving content AS THE CALLER at read
 * time, which is the rule the owner restated here.
 *
 * It was wrong on accuracy too, privacy aside: a drain covers a whole queue, from possibly several
 * people, so there is no single message whose text it could honestly carry.
 *
 * ── AND THE CLOSE ──────────────────────────────────────────────────────────────────────────────
 *
 * `clearQueue` removed the drain's id from the turn record and nothing ever closed the ROW, which
 * then lived to its 24-hour TTL. An open drain is not inert:
 *
 *   - it is the NEWEST live task the assistant owns in that channel, and the router reads the newest
 *     (`router-agent-handler.ts`), so it MASKED a real chain that was blocked on a person - their
 *     reply stopped resuming their own work;
 *   - it held `liveTaskInChannel` true, which suppresses drift for the conversation;
 *   - it would eventually trip stall supervision on work nobody was doing.
 *
 * The subtle half is that reaching a terminal STATE does not close a row. Every query that decides
 * what is live filters on `status`, so a drain sitting in `settled` with `status: pending` is still
 * live work to every reader that matters. Both are written, and the test asserts the status, because
 * the status is the half that does the work.
 */

const mockCreateTask = jest.fn();
const mockGetTask = jest.fn();
const mockAdvance = jest.fn();
const mockUpdateStatus = jest.fn();
const mockClaimDrainTask = jest.fn();

jest.mock('../../lambda/src/lib/task-store.js', () => ({
  createTask: (...a: unknown[]) => mockCreateTask(...a),
  getTask: (...a: unknown[]) => mockGetTask(...a),
  advanceTaskStateTo: (...a: unknown[]) => mockAdvance(...a),
  updateTaskStatus: (...a: unknown[]) => mockUpdateStatus(...a),
}));
jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  claimDrainTask: (...a: unknown[]) => mockClaimDrainTask(...a),
}));

import { openDrainTask, settleDrainTask, drainStageRecorder, openInFlightQuestion } from '../../lambda/src/lib/queue-drain-task';

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';
const BOT = 'assistant-premium';
const MESSAGE = 'e6b1c0d2-0000-4000-8000-00000000abcd';
const WINNER = 'd1f0c2a4-0000-4000-8000-000000000001';
const PRIVATE_TEXT = 'the quarterly numbers before the board hears them';

/** A Lex event whose transcript is the private request, so a leak would have something to leak. */
const event = {
  inputTranscript: encodeURIComponent(PRIVATE_TEXT),
  requestAttributes: {
    'CHIME.channel.arn': CHANNEL,
    'CHIME.sender.arn': 'arn:aws:chime:us-east-1:123456789012:app-instance/i/user/u1',
  },
};

/** The options the create was called with. */
const createdWith = () => (mockCreateTask.mock.calls[0]?.[4] ?? {}) as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  mockClaimDrainTask.mockResolvedValue({ taskId: WINNER, created: true });
  mockCreateTask.mockResolvedValue({ taskId: WINNER });
  mockAdvance.mockResolvedValue({ ok: true, from: 'waiting', to: 'settled' });
  mockUpdateStatus.mockResolvedValue(undefined);
});

describe('what a drain task carries', () => {
  it('stores the message ID', async () => {
    await openDrainTask({ event, channelArn: CHANNEL, responderId: BOT, queuedMessageId: MESSAGE });

    expect(createdWith().userMessageId).toBe(MESSAGE);
  });

  it('passes no message text to createTask, in any field', async () => {
    // ── AND THIS IS NOT THE PRIVACY GUARANTEE. IT ONCE PRETENDED TO BE. ─────────────────────────
    //
    // `createTask` is mocked here, so this can only see what the CALLER hands over - and the leak was
    // in what the CALLEE did with what the caller omitted: `createTask` falls back to
    // `event.inputTranscript` when no excerpt is passed. Nine drain rows out of nine carried the
    // queued message's text on the deployment while this test was green.
    //
    // The real guarantee is asserted on the written ROW, in
    // `a-drain-row-never-holds-the-message.test.ts`, which runs the actual `createTask`. This one is
    // kept because the caller's half is still worth pinning - but do not read it as more than that.
    //
    // The assertion is over the whole payload rather than one named field, because the leak is the
    // content appearing anywhere - an excerpt, a title, a detail - not one property being set.
    await openDrainTask({ event, channelArn: CHANNEL, responderId: BOT, queuedMessageId: MESSAGE });

    const serialised = JSON.stringify(mockCreateTask.mock.calls[0]?.slice(1));
    expect(serialised).not.toContain(PRIVATE_TEXT);
    expect(serialised).not.toContain(encodeURIComponent(PRIVATE_TEXT));
    expect(createdWith()).not.toHaveProperty('requestExcerpt');
  });

  it('records its visibility rather than leaving it absent', async () => {
    // Absence is reserved to mean "written before visibility existed". A new write that omits it turns
    // a migration reading into a default nobody chose.
    await openDrainTask({ event, channelArn: CHANNEL, responderId: BOT });

    expect(createdWith().visibility).toBe('conversation');
  });

  it('belongs to the assistant that is reading', async () => {
    await openDrainTask({ event, channelArn: CHANNEL, responderId: BOT });

    expect(createdWith().owner).toEqual({ id: BOT, type: 'assistant' });
  });

  it('creates nothing when another reading already opened one', async () => {
    // The loser is told the winner's id and must not write a second row for one queue.
    mockClaimDrainTask.mockResolvedValue({ taskId: WINNER, created: false });

    expect(await openDrainTask({ event, channelArn: CHANNEL, responderId: BOT })).toBe(WINNER);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('lets the drain run untracked when the row cannot be written', async () => {
    // The queue is the work; the task is how the work is seen.
    mockCreateTask.mockRejectedValue(new Error('throttled'));

    expect(await openDrainTask({ event, channelArn: CHANNEL, responderId: BOT })).toBe('');
  });
});

describe('closing the drain when the queue is empty', () => {
  const openDrain = { taskId: WINNER, channelArn: CHANNEL, taskType: 'queue_drain', taskState: 'waiting' };

  it('closes the ROW, not only the state - the status is what stops it counting', async () => {
    // The defect this exists for. A drain in `settled` with `status: pending` is still live work to
    // every query that decides what the assistant is holding.
    mockGetTask.mockResolvedValue(openDrain);

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockUpdateStatus).toHaveBeenCalledWith(WINNER, CHANNEL, 'completed');
  });

  it('records the ending on the machine as well, because that is the honest history', async () => {
    mockGetTask.mockResolvedValue(openDrain);

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockAdvance).toHaveBeenCalledWith(expect.objectContaining({ toState: 'settled' }));
  });

  it('still closes the row when the machine refuses the move', async () => {
    // The status is the half that prevents the leak, so it must not be conditional on the state
    // write. A drain left open because its transition was illegal is the exact bug, reintroduced.
    mockGetTask.mockResolvedValue({ ...openDrain, taskState: 'reviewing' });
    mockAdvance.mockResolvedValue({ ok: false, error: 'illegal_transition' });

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockUpdateStatus).toHaveBeenCalledWith(WINNER, CHANNEL, 'completed');
  });

  it('leaves a drain that already ended alone', async () => {
    // Two readings can both observe an empty queue. Closing a closed task would rewrite the ending's
    // timestamp, which is the number the resolution view reads.
    mockGetTask.mockResolvedValue({ ...openDrain, taskState: 'settled' });

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('finishes the ROW when an earlier settle reached the end state and died before the status write', async () => {
    // `advanceTaskStateTo` never writes status. Returning on the terminal state alone left this row
    // `pending` to its TTL, counted as live work by every reader that filters on status.
    mockGetTask.mockResolvedValue({ ...openDrain, taskState: 'settled', status: 'pending' });

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockUpdateStatus).toHaveBeenCalledWith(WINNER, CHANNEL, 'completed');
  });

  it('does not rewrite a drain that ended in a status other than completed', async () => {
    mockGetTask.mockResolvedValue({ ...openDrain, taskState: 'settled', status: 'cancelled' });

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('does not fail the turn when the close fails', async () => {
    // This runs after the person already has their answer.
    mockGetTask.mockRejectedValue(new Error('throttled'));

    await expect(settleDrainTask({ taskId: WINNER, channelArn: CHANNEL })).resolves.toBeUndefined();
  });
});

/**
 * THE STAGE AND THE TASK STATE ARE ONE FACT (step 3, owner 2026-09-03).
 *
 * A person read the stage off the notice while the task carried a `taskState` that nothing moved, so
 * it sat in `waiting` for the drain's whole life. Two vocabularies for one drain is what adopting the
 * task row was meant to end, and a frozen one is worse than none: the operator view and the
 * resolution timing both read the state, and a state that never moves reports every drain as never
 * having started.
 */
describe('the drain records the stage it is showing', () => {
  const drain = { taskId: WINNER, channelArn: CHANNEL, taskType: 'queue_drain', taskState: 'waiting' };

  it('moves the task with the stage', async () => {
    mockGetTask.mockResolvedValue(drain);
    const record = drainStageRecorder({ taskId: WINNER, channelArn: CHANNEL });

    await record('reviewing');

    expect(mockAdvance).toHaveBeenCalledWith(expect.objectContaining({ toState: 'reviewing' }));
  });

  it('reads the task ONCE for the whole drain, not once per stage', async () => {
    // A drain is on the path somebody is waiting on. The record has already settled the ordering, so
    // re-reading before each stage buys nothing and costs the wait.
    mockGetTask.mockResolvedValue(drain);
    mockAdvance
      .mockResolvedValueOnce({ ok: true, from: 'waiting', to: 'reviewing' })
      .mockResolvedValueOnce({ ok: true, from: 'reviewing', to: 'clearing' });
    const record = drainStageRecorder({ taskId: WINNER, channelArn: CHANNEL });

    await record('reviewing');
    await record('clearing');

    expect(mockGetTask).toHaveBeenCalledTimes(1);
    // And it carried the state forward locally rather than re-reading it: the second advance was
    // asked from `reviewing`, which only the local copy knew.
    expect(mockAdvance.mock.calls[1][0].task.taskState).toBe('reviewing');
  });

  it('carries on when one stage fails to write', async () => {
    // Refusing to advance because one write failed would strand the state at exactly the stage that
    // failed, which is the worst place to stop.
    mockGetTask.mockResolvedValue(drain);
    mockAdvance
      .mockResolvedValueOnce({ ok: false, error: 'throttled' })
      .mockResolvedValueOnce({ ok: true, from: 'waiting', to: 'clearing' });
    const record = drainStageRecorder({ taskId: WINNER, channelArn: CHANNEL });

    await record('reviewing');
    await record('clearing');

    expect(mockAdvance).toHaveBeenCalledTimes(2);
  });

  it('does nothing at all when no task is tracking this drain', async () => {
    // A drain can run untracked, and every stage must stay free in that case.
    const record = drainStageRecorder({ taskId: '', channelArn: CHANNEL });

    await record('reviewing');

    expect(mockGetTask).not.toHaveBeenCalled();
    expect(mockAdvance).not.toHaveBeenCalled();
  });
});

/**
 * A DRAIN THAT ASKED SOMETHING STILL REACHES A TERMINAL STATE (live evidence, 2026-09-03).
 *
 * Measured on the deployment: of 18 drains, 6 closed with `status: completed` while their state was
 * still `clarifying`. The row closing is what stops it masking other work, and that half worked - but
 * a task closed in a NON-TERMINAL state has no ending, and `v_task_resolution` reads the terminal
 * entry, so those drains had no resolution at all. That measurement is the reason the task row was
 * adopted.
 *
 * The cause is honest and the fix is not a force: `settled` is reachable from `clearing` and from
 * `waiting`, and a drain that asked something is in `clarifying`. It walks the declared edges to the
 * end instead - `clearing` is reachable from every state a live drain can be in when the queue
 * empties, and it is TRUE at that moment, because the queue is being cleared.
 */
describe('a drain that asked something still ends properly', () => {
  it('walks clarifying -> clearing -> settled rather than stopping at a refusal', async () => {
    mockGetTask.mockResolvedValue({
      taskId: WINNER, channelArn: CHANNEL, taskType: 'queue_drain', taskState: 'clarifying',
    });
    mockAdvance
      .mockResolvedValueOnce({ ok: false, error: 'illegal_transition' })   // clarifying -> settled
      .mockResolvedValueOnce({ ok: true, from: 'clarifying', to: 'clearing' })
      .mockResolvedValueOnce({ ok: true, from: 'clearing', to: 'settled' });

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockAdvance.mock.calls.map((c) => c[0].toState)).toEqual(['settled', 'clearing', 'settled']);
    // The second `settled` must be asked FROM `clearing`, or it is the same refused move again.
    expect(mockAdvance.mock.calls[2][0].task.taskState).toBe('clearing');
    expect(mockUpdateStatus).toHaveBeenCalledWith(WINNER, CHANNEL, 'completed');
  });

  it('does not invent an edge when the machine still refuses', async () => {
    // A drain somewhere genuinely unexpected must say so rather than be forced to an ending.
    mockGetTask.mockResolvedValue({
      taskId: WINNER, channelArn: CHANNEL, taskType: 'queue_drain', taskState: 'clarifying',
    });
    mockAdvance.mockResolvedValue({ ok: false, error: 'illegal_transition' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be settled on its machine'), expect.any(Object),
    );
    // And the row still closes, because that is the half that stops it masking other work.
    expect(mockUpdateStatus).toHaveBeenCalledWith(WINNER, CHANNEL, 'completed');
    warn.mockRestore();
  });

  it('takes the direct edge when it is legal, without the detour', async () => {
    mockGetTask.mockResolvedValue({
      taskId: WINNER, channelArn: CHANNEL, taskType: 'queue_drain', taskState: 'clearing',
    });
    mockAdvance.mockResolvedValue({ ok: true, from: 'clearing', to: 'settled' });

    await settleDrainTask({ taskId: WINNER, channelArn: CHANNEL });

    expect(mockAdvance).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE QUESTION NOTHING WAS HOLDING (maintainer, 2026-09-03).
 *
 * When the reading cannot tell whether the work already running is still wanted, it asks. That
 * question used to be a stage on the notice, a sentence in the proposal, and a log field - and
 * nothing else. Nothing owned it and nothing outlived the message.
 *
 * It was survivable while the drain waited at `clarifying` and was itself the holder. Once a drain
 * stopped waiting, the question was left held by nothing at all: asked once, forgotten the moment the
 * queue cleared, with the fate of the running work undecided permanently. That is the failure this
 * design exists to prevent - a proposal describing something nothing holds.
 *
 * It cannot attach to the in-flight work, which is why it is a row of its own: the running turn is
 * identified only by holding the lock, and an ordinary answer has no task at all.
 */
describe('the question about work already running is recorded', () => {
  const evt = {
    requestAttributes: {
      'CHIME.channel.arn': CHANNEL,
      'CHIME.sender.arn': 'arn:aws:chime:us-east-1:123456789012:app-instance/i/user/u1',
    },
  };

  it('opens a task of its own, not a queued_request', async () => {
    // A queued request is work that ARRIVED while the assistant was busy. This is the opposite - the
    // work that was already running - so filing it as one would claim a message was queued when none
    // was, and make every count of queued work wrong.
    mockGetTask.mockResolvedValue(null);

    await openInFlightQuestion({ event: evt, channelArn: CHANNEL, responderId: BOT, drainTaskId: WINNER });

    expect(mockCreateTask.mock.calls[0][2]).toBe('work_still_wanted');
  });

  it('is keyed to the drain, so a chain of passes asks once', async () => {
    // A handover chain re-reads the same queue and can keep finding the same ambiguity. Re-asking
    // would put a second identical row in somebody's list, and could overwrite an answer they had
    // already given.
    mockGetTask.mockResolvedValue({ taskId: `${WINNER}-still-wanted`, taskState: 'asked' });

    const id = await openInFlightQuestion({
      event: evt, channelArn: CHANNEL, responderId: BOT, drainTaskId: WINNER,
    });

    expect(id).toBe(`${WINNER}-still-wanted`);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('still records the question when the drain itself is untracked', async () => {
    // An untracked drain is already the case where the record is incomplete. Losing the question too
    // would make it worse for no gain.
    mockGetTask.mockResolvedValue(null);

    const id = await openInFlightQuestion({ event: evt, channelArn: CHANNEL, responderId: BOT });

    expect(id).toBeTruthy();
    expect(mockCreateTask).toHaveBeenCalled();
  });

  it('quotes nothing - it carries ids only, like the drain', async () => {
    mockGetTask.mockResolvedValue(null);

    await openInFlightQuestion({
      event: evt, channelArn: CHANNEL, responderId: BOT, drainTaskId: WINNER, correlationId: 'corr-1',
    });

    const opts = mockCreateTask.mock.calls[0][4];
    expect(opts).not.toHaveProperty('requestExcerpt');
    expect(opts.visibility).toBe('conversation');
  });

  it('joins the reading by correlation id and never passes it off as a message id', async () => {
    // `userMessageId` is a RESOLVABLE Chime message id or absent (ADR-024 D5). A correlation id in it
    // is the substitution that made the old `messageId` field misleading.
    mockGetTask.mockResolvedValue(null);

    await openInFlightQuestion({
      event: evt, channelArn: CHANNEL, responderId: BOT, drainTaskId: WINNER, correlationId: 'corr-1',
    });

    expect(mockCreateTask.mock.calls[0][3]).toBe('corr-1');
    expect(mockCreateTask.mock.calls[0][4]).not.toHaveProperty('userMessageId');
  });

  it('leaves the proposal as the only record when the row cannot be written', async () => {
    // Best effort, like everything else on this path: the person still has the question in front of
    // them, and failing the turn over the row would cost them the answer as well.
    mockGetTask.mockResolvedValue(null);
    mockCreateTask.mockRejectedValue(new Error('throttled'));

    await expect(openInFlightQuestion({ event: evt, channelArn: CHANNEL, responderId: BOT }))
      .resolves.toBe('');
  });

  it('is born held by the person, because its first state awaits them', () => {
    // Asserted on the MACHINE rather than on a passed owner: `createTask` decides ownership from the
    // initial state and ignores a caller's owner when that state awaits somebody, which is right.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_TASK_STATE_MACHINES } = require('../../lambda/src/lib/task-state-machines');
    const m = DEFAULT_TASK_STATE_MACHINES.work_still_wanted;

    expect(m.states[m.initial].awaits).toEqual({ party: 'requester' });
    // And both endings are real endings: "drop it" is a decision, not a failure.
    expect(m.states.kept.terminal).toBe('success');
    expect(m.states.dropped.terminal).toBe('handoff');
  });
});
