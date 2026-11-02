/**
 * A TRIAGE CLAIM LASTS THE DRAIN, NOT THE DISPATCH.
 *
 * `claimTriage` is the only exclusion triage has, and it was correct as a mutex. What was wrong was
 * how long it was held. Both dispatchers released it in a `finally` the moment `dispatchTriageTurn`
 * returned - but that call only STARTS a turn. The queue is not cleared until that turn finishes
 * reading, tens of seconds later, so anything firing in between saw a full queue and a free claim and
 * read the same messages a second time.
 *
 * Observed live (2026-08-29, premium): one queue drained twice, 33 milliseconds apart.
 *
 *     21:52:40.491Z  triage-arrival-9d003b9a...   items: 2, tasksCreated: 2
 *     21:52:40.524Z  triage-handover-cbb0adc6...  items: 3, tasksCreated: 3
 *
 * Five tasks for three messages, and two proposals posted into the room - the person told twice what
 * was understood, differently each time. Duplicate work items have to be closed by hand, which is the
 * cost `claimTriage` exists to avoid and was not avoiding.
 *
 * The claim now ends where the drain ends: in the same write that clears the queue. That needs no
 * claim id, and it cannot disagree with the clear because it IS the clear.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/abuse-controls', () => ({ readPlaceholderMapping: jest.fn() }));

process.env.TURN_STATE_TABLE = 'test-table';
process.env.TURN_QUEUE_ENABLED = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'assistant-premium';

/** The update the call made, after the consistent read of the current queue. */
const updateInput = () => {
  const call = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__t === 'Update');
  return call?.input;
};

beforeEach(() => {
  mockSend.mockReset();
});

describe('the claim ends with the queue it guarded', () => {
  it('releases the claim in the same write that empties the queue', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1', 'm2'] } })  // the consistent read
      .mockResolvedValueOnce({});                                  // the clear

    const ok = await lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1', 'm2'],
    });

    expect(ok).toBe(true);
    const input = updateInput();
    // The claim goes with the queue and the notice, in ONE statement. Two writes could leave a claim
    // standing over a queue that no longer exists, which blocks the next reading for its whole expiry.
    expect(input.UpdateExpression).toContain('triagedBy');
    expect(input.UpdateExpression).toContain('triageAt');
    expect(input.UpdateExpression).toContain('queued');
    expect(input.UpdateExpression).toContain('noticeId');
  });

  it('releases the claim even when part of the queue still waits', async () => {
    // A remainder is a queue somebody still has to read. Holding the claim past this point would block
    // the very next reading it needs - the stall version of the same bug.
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1', 'm2', 'm3'] } })
      .mockResolvedValueOnce({});

    const ok = await lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'],
    });

    expect(ok).toBe(true);
    const input = updateInput();
    expect(input.UpdateExpression).toContain('triagedBy');
    expect(input.UpdateExpression).toContain('triageAt');
    // ...and the remainder is still written, so the two clauses coexist rather than one replacing it.
    expect(input.ExpressionAttributeValues[':remainder']).toEqual(['m2', 'm3']);
  });
});
