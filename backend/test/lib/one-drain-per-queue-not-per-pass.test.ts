/**
 * ONE DRAIN PER QUEUE, NOT PER PASS (maintainer, 2026-09-03).
 *
 * Working a queue is a task - states, legal moves between them, a step that awaits a person, and a
 * point at which it is over - and it was always declared in that shape while declining the task ROW.
 * What it needed before it could take one is an IDENTITY that survives a handover, because a chain of
 * readings is ONE reading that took more than one turn.
 *
 * A correlation id cannot be that identity. It changes per link BY DESIGN, so that a re-read is not
 * swallowed as a duplicate delivery - the defect that made the whole re-read loop inert. So the
 * identity is carried on the record the chain shares.
 *
 * TWO THINGS DECIDE WHETHER THIS IS ONE DRAIN OR SEVERAL, and both are pinned here:
 *
 *   - The claim TELLS A LOSER THE WINNER'S ID rather than refusing it. Every message that queues runs
 *     the open path, so a burst of three would otherwise open three drains for one queue - the same
 *     doubling the notice claim exists to prevent, in a place where it costs work items a person has
 *     to close by hand.
 *   - The id ends with the QUEUE, not with the pass. A pass ends at either branch of the clear: the
 *     claim and the stage reset at both, because the next pass is a new reading. A remainder is the
 *     same queue still being worked, so the drain carries across it.
 *
 * The second is the one an ordinary refactor breaks, because the two branches sit next to each other
 * and differ by a single attribute.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/abuse-controls', () => ({ readPlaceholderMapping: jest.fn() }));

// Before the require: both are read into module-level consts, which is what makes the switch a
// deploy-time decision rather than a per-call one.
process.env.TURN_STATE_TABLE = 'test-table';
process.env.TURN_QUEUE_ENABLED = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';
const BOT = 'assistant-premium';
const WINNER = 'd1f0c2a4-0000-4000-8000-000000000001';
const LOSER = 'd1f0c2a4-0000-4000-8000-000000000002';

const refusal = (item?: Record<string, unknown>) => Object.assign(
  new Error('conditional'),
  { name: 'ConditionalCheckFailedException', ...(item ? { Item: item } : {}) },
);

/** The update expressions this call wrote, in order. */
const wrote = (): string[] => mockSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__t === 'Update')
  .map((c) => String(c.input?.UpdateExpression));

beforeEach(() => { mockSend.mockReset(); });

describe('the drain gets one identity, and it belongs to the queue', () => {
  it('the first reading opens it, and claims the drain before the row exists', async () => {
    mockSend.mockResolvedValue({});

    const claim = await lock.claimDrainTask({ channelArn: CHANNEL, responderId: BOT, taskId: WINNER });

    expect(claim).toEqual({ taskId: WINNER, created: true });
    // CONDITIONAL, which is what makes it a claim rather than a write. Without the condition the last
    // caller in a burst wins, and the earlier ones have already created their rows.
    const [cmd] = mockSend.mock.calls[0];
    expect(cmd.input.ConditionExpression).toContain('attribute_not_exists(drainTaskId)');
  });

  it('tells a loser WHICH drain is open rather than refusing it', async () => {
    // The distinction the design turns on. A loser told only "no" either opens a second task or works
    // a drain that nothing records, and both are what this exists to prevent.
    mockSend.mockRejectedValue(refusal({ drainTaskId: WINNER }));

    const claim = await lock.claimDrainTask({ channelArn: CHANNEL, responderId: BOT, taskId: LOSER });

    expect(claim).toEqual({ taskId: WINNER, created: false });
  });

  it('reads the winner out of the refusal, in the same round trip', async () => {
    // Reading it afterwards would be a second race: a clear between the refusal and the read removes
    // the id, and the caller would then open a task for a drain that is already over.
    mockSend.mockRejectedValue(refusal({ drainTaskId: WINNER }));

    await lock.claimDrainTask({ channelArn: CHANNEL, responderId: BOT, taskId: LOSER });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  it('does not invent an id when the refusal carries none', async () => {
    // Handing back the caller's own id here would be the worst answer available: two readings would
    // each believe they own the drain, under different ids, against one row.
    mockSend.mockRejectedValue(refusal());

    expect(await lock.claimDrainTask({ channelArn: CHANNEL, responderId: BOT, taskId: LOSER }))
      .toEqual({ taskId: '', created: false });
  });

  it('lets the drain run untracked when the claim cannot be written at all', async () => {
    // The queue is the work; the task is how the work is seen. Failing the drain over its record
    // would trade a visible drain for no drain.
    mockSend.mockRejectedValue(new Error('throttled'));

    expect(await lock.claimDrainTask({ channelArn: CHANNEL, responderId: BOT, taskId: WINNER }))
      .toEqual({ taskId: '', created: false });
  });

  it('hands the open drain to every later pass that reads the state', async () => {
    // This is how a handover chain advances ONE task instead of opening one per link.
    mockSend.mockResolvedValue({ Item: { queued: ['m1'], drainTaskId: WINNER } });

    const state = await lock.readTurnState({ channelArn: CHANNEL, responderId: BOT });

    expect(state.drainTaskId).toBe(WINNER);
  });

  it('says nothing about a drain when no task is tracking one', async () => {
    // Absent has to stay absent: a caller reads it as "carry on without one", and an empty string
    // would be an id that nothing can resolve.
    mockSend.mockResolvedValue({ Item: { queued: ['m1'] } });

    expect(await lock.readTurnState({ channelArn: CHANNEL, responderId: BOT }))
      .not.toHaveProperty('drainTaskId');
  });

  it('ends the drain when the queue empties, because that is when the work is done', async () => {
    mockSend.mockImplementation((cmd: { __t?: string }) => (cmd?.__t === 'Get'
      ? Promise.resolve({ Item: { queued: ['m1'] } })
      : Promise.resolve({})));

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });

    expect(wrote()[0]).toContain('drainTaskId');
  });

  it('KEEPS it across a remainder, which is the same queue on its next pass', async () => {
    // The rule, in the one place it can be broken silently. The claim and the stage reset here - a
    // remainder needs a new reading - but the drain is not over: those messages are the queue it was
    // opened for. Clearing the id here would open a second task on the very next pass, and put two
    // rows in front of a person for one wait.
    mockSend.mockImplementation((cmd: { __t?: string }) => (cmd?.__t === 'Get'
      ? Promise.resolve({ Item: { queued: ['m1', 'm2'] } })
      : Promise.resolve({})));

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });

    const expr = wrote()[0];
    expect(expr).not.toContain('drainTaskId');
    // And it IS the remainder branch: the pass really did end, so this is not passing by taking some
    // third path that happens to write nothing.
    expect(expr).toContain('triagedBy');
    expect(expr).toContain('queueStatus');
  });
});
