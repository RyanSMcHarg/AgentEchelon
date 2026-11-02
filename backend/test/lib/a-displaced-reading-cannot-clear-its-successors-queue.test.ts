/**
 * A READING DISPLACED AS STALE CANNOT CLEAR THE QUEUE OF THE READING THAT REPLACED IT.
 *
 * The processor clears the queue at the end of a triage turn. It did so without naming the drain
 * claim, so a reading that outlived its claim could return and remove `noticeId` and `drainTaskId`
 * out from under its successor: the next notice posts fresh instead of updating in place, and the
 * drain row is left pending with nothing to close it. Both dispatcher-side clears already named it.
 *
 * The claim the processor names is its own correlation id. That is safe only because every producer
 * of a triage turn dispatches it under the id it claimed, so this file pins that chain as well as the
 * guard itself.
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'lambda', 'src', 'lib');
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'assistant-premium';

/** The argument object of the first `await <fn>({` call at or after `from`, braces balanced. */
function callArgs(src: string, fn: string, from = 0): string {
  const start = src.indexOf(`await ${fn}({`, from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

beforeEach(() => mockSend.mockReset());

describe('the processor clear names the drain claim', () => {
  it('passes its own correlation id as the claim', () => {
    const args = callArgs(read('async-processor-core.ts'), 'clearQueue');
    expect(args).not.toBe('');
    expect(args).toMatch(/claimedBy:\s*event\.correlationId/);
  });

  it('writes nothing when the record names the reading that displaced it', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { queued: ['m1'], triagedBy: 'arrival-successor', noticeId: 'n1', drainTaskId: 'd1' },
    });

    await expect(lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'], claimedBy: 'arrival-displaced',
    })).resolves.toBe(false);

    // One consistent read and no write: the successor's notice pointer and drain id stay.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].__t).toBe('Get');
  });

  it('writes nothing on an already-empty queue held by another reading either', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { triagedBy: 'arrival-successor', noticeId: 'n1', drainTaskId: 'd1', queueStatus: 'reviewing' },
    });

    await expect(lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'], claimedBy: 'arrival-displaced',
    })).resolves.toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('still clears, conditioned on the claim, for the reading that holds it', async () => {
    // Non-vacuity: the guard refuses the displaced reading, not every reading.
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1'], triagedBy: 'arrival-holder', noticeId: 'n1', drainTaskId: 'd1' } })
      .mockResolvedValueOnce({});

    await expect(lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'], claimedBy: 'arrival-holder',
    })).resolves.toBe(true);

    const update = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__t === 'Update')?.input;
    expect(update.UpdateExpression).toContain('noticeId');
    expect(update.UpdateExpression).toContain('drainTaskId');
    expect(update.ConditionExpression).toContain('triagedBy = :claimant');
    expect(update.ExpressionAttributeValues[':claimant']).toBe('arrival-holder');
  });
});

describe('a triage turn runs under the id its dispatcher claimed', () => {
  it('arrival triage claims and dispatches under the same id', () => {
    const src = read('triage-on-arrival.ts');
    expect(callArgs(src, 'claimTriage')).toMatch(/by:\s*claim\b/);
    expect(callArgs(src, 'dispatchTriageTurn')).toMatch(/correlationId:\s*claim\b/);
  });

  it('the handover claims the id it hands the lock to and dispatches under', () => {
    const src = read('turn-handover.ts');
    expect(callArgs(src, 'claimTriage')).toMatch(/by:\s*claim\b/);
    expect(src).toMatch(/const handedTo = claim;/);
    expect(callArgs(src, 'dispatchTriageTurn')).toMatch(/correlationId:\s*handedTo\b/);
  });

  it('a further pass from the processor keeps the correlation id it was dispatched under', () => {
    const src = read('async-processor-core.ts');
    const calls: string[] = [];
    for (let at = src.indexOf('await dispatchTriageTurn({'); at >= 0; at = src.indexOf('await dispatchTriageTurn({', at + 1)) {
      calls.push(callArgs(src, 'dispatchTriageTurn', at));
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toMatch(/correlationId:\s*event\.correlationId\b/);
  });
});
