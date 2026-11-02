/**
 * AN ANSWER THAT IS READY WAITS FOR THE READING BESIDE IT, AND FOLLOW-UPS ARE KEPT ACROSS PASSES
 * (ADR-033, owner 2026-09-14).
 *
 * Measured live: the reading's first pass finished at 20:45:42.5 and was discarded because more
 * messages had arrived; the answer was ready at 48.3 with nothing recorded to fold; the second pass
 * recorded the follow-ups at 56.6, eight seconds after the answer went out without them.
 *
 * Two changes, pinned here:
 *  1. a pass records what it found to be follow-ups BEFORE it re-reads, and a follow-up is recorded
 *     only while it is still queued and not yet recorded (so the next pass cannot record it twice,
 *     and one the answer has already folded cannot come back);
 *  2. an answer ready while a reading still holds the claim PARKS: its finalize inputs go on the
 *     record and the conversation goes to the reader in one conditional write, and the reader resumes
 *     it once it has recorded what it found. The resumed run folds or delivers through the same path.
 */

const mockSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: (...a: unknown[]) => mockLambdaSend(...a) })),
  InvokeCommand: class { __t = 'Invoke'; constructor(public input: any) {} },
  InvocationType: { Event: 'Event' },
}));
jest.mock('../../lambda/src/lib/abuse-controls', () => ({ readPlaceholderMapping: jest.fn() }));

process.env.TURN_STATE_TABLE = 'test-table';
process.env.TURN_QUEUE_ENABLED = '1';
process.env.AWS_LAMBDA_FUNCTION_NAME = 'premium-processor';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resumeParkedTurnIfAny, isResumeParkedEvent } = require('../../lambda/src/lib/parked-turn');

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT_ARN = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/assistant-premium';
const BOT = 'assistant-premium';
const conditionalFailure = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  mockSend.mockReset();
  mockLambdaSend.mockReset();
});

describe('recording a follow-up', () => {
  it('records only ids still queued and not already recorded', async () => {
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m2', 'm3'], amendments: ['m2'] } });
    mockSend.mockResolvedValueOnce({});

    const recorded = await lock.recordAmendments({
      channelArn: CHANNEL, responderId: BOT, messageIds: ['m2', 'm3', 'm-folded'],
    });

    expect(recorded).toEqual(['m3']);
    const write = mockSend.mock.calls[1][0].input;
    expect(write.ExpressionAttributeValues[':ids']).toEqual(['m3']);
    expect(write.ConditionExpression).toBe('queued = :queued');
  });

  it('writes nothing when every id was already folded or recorded', async () => {
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m4'], amendments: [] } });
    expect(await lock.recordAmendments({ channelArn: CHANNEL, responderId: BOT, messageIds: ['m2'] })).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('re-reads and retries when the queue moved', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m2'] } })
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { queued: ['m2', 'm5'] } })
      .mockResolvedValueOnce({});
    expect(await lock.recordAmendments({ channelArn: CHANNEL, responderId: BOT, messageIds: ['m2'] })).toEqual(['m2']);
  });
});

describe('a folded message leaves the queue', () => {
  it('removes exactly the folded ids, conditionally', async () => {
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m2', 'm3', 'm4'] } });
    mockSend.mockResolvedValueOnce({});

    await lock.takeFoldedOffQueue({ channelArn: CHANNEL, responderId: BOT, messageIds: ['m2', 'm3'] });

    const write = mockSend.mock.calls[1][0].input;
    expect(write.ExpressionAttributeValues[':rest']).toEqual(['m4']);
    expect(write.ConditionExpression).toBe('queued = :current');
  });
});

describe('parking an answer for the reading', () => {
  it('moves the conversation to the reader only while it still reads a non-empty queue', async () => {
    mockSend.mockResolvedValueOnce({});

    const parked = await lock.parkTurnForReading({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'answer', reader: 'reading', params: '{}',
    });

    expect(parked).toBe(true);
    const write = mockSend.mock.calls[0][0].input;
    expect(write.UpdateExpression).toContain('holder = :reader');
    expect(write.UpdateExpression).toContain('parkedTurn = :parked');
    expect(write.ConditionExpression).toContain('holder = :me');
    expect(write.ConditionExpression).toContain('triagedBy = :reader');
    expect(write.ConditionExpression).toContain('size(queued) > :zero');
    expect(write.ConditionExpression).toContain('attribute_not_exists(parkedTurn)');
  });

  it('declines when the reading has already finished, so the caller delivers', async () => {
    mockSend.mockRejectedValueOnce(conditionalFailure());
    expect(await lock.parkTurnForReading({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'answer', reader: 'reading', params: '{}',
    })).toBe(false);
  });

  it('never parks behind itself', async () => {
    expect(await lock.parkTurnForReading({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'same', reader: 'same', params: '{}',
    })).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('resuming a parked answer', () => {
  it('hands the conversation back and invokes this processor with the key only', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { parkedTurn: { correlationId: 'answer', params: 'big' } } })
      .mockResolvedValueOnce({});
    mockLambdaSend.mockResolvedValueOnce({});

    expect(await resumeParkedTurnIfAny({ channelArn: CHANNEL, botArn: BOT_ARN, readerCorrelationId: 'reading' })).toBe(true);

    const handBack = mockSend.mock.calls[1][0].input;
    expect(handBack.UpdateExpression).toContain('holder = :parked');
    expect(handBack.ConditionExpression).toContain('attribute_not_exists(parkedTurn.resumedBy)');
    const invoke = mockLambdaSend.mock.calls[0][0].input;
    expect(invoke.FunctionName).toBe('premium-processor');
    const payload = JSON.parse(Buffer.from(invoke.Payload).toString());
    expect(isResumeParkedEvent(payload)).toBe(true);
    // The failure destination reads the lock identity from the top level.
    expect(payload).toMatchObject({ channelArn: CHANNEL, botArn: BOT_ARN, correlationId: 'answer' });
    expect(JSON.stringify(payload)).not.toContain('big');
  });

  it('does nothing when nothing is parked, or it was already resumed', async () => {
    mockSend.mockResolvedValueOnce({ Item: {} });
    expect(await resumeParkedTurnIfAny({ channelArn: CHANNEL, botArn: BOT_ARN, readerCorrelationId: 'reading' })).toBe(false);
    mockSend.mockResolvedValueOnce({ Item: { parkedTurn: { correlationId: 'answer', resumedBy: 'reading' } } });
    expect(await resumeParkedTurnIfAny({ channelArn: CHANNEL, botArn: BOT_ARN, readerCorrelationId: 'reading' })).toBe(false);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('gives the conversation back to the reader when the invoke fails', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { parkedTurn: { correlationId: 'answer' } } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mockLambdaSend.mockRejectedValueOnce(new Error('throttled'));

    expect(await resumeParkedTurnIfAny({ channelArn: CHANNEL, botArn: BOT_ARN, readerCorrelationId: 'reading' })).toBe(false);
    const revert = mockSend.mock.calls[2][0].input;
    expect(revert.UpdateExpression).toContain('holder = :reader');
    expect(revert.UpdateExpression).toContain('REMOVE parkedTurn.resumedBy');
  });

  it('the resumed run takes its inputs exactly once', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { parkedTurn: { params: '{"x":1}' } } });
    expect(await lock.takeParkedTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'answer' })).toBe('{"x":1}');
    const take = mockSend.mock.calls[0][0].input;
    expect(take.UpdateExpression).toBe('REMOVE parkedTurn');
    expect(take.ReturnValues).toBe('ALL_OLD');
    mockSend.mockRejectedValueOnce(conditionalFailure());
    expect(await lock.takeParkedTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'answer' })).toBeUndefined();
  });
});

describe('where it is wired', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');
  const processor = read('lambda/src/assistant-async-processor.ts');
  const handover = read('lambda/src/lib/turn-handover.ts');
  const stack = read('lib/stacks/assistant-profile-stack.ts');

  it('the answer parks at the fold checkpoint, before folding or delivering', () => {
    const park = core.indexOf('await parkTurnForReading({');
    const fold = core.indexOf('await dispatchAmendedTurn({');
    expect(park).toBeGreaterThan(-1);
    expect(park).toBeLessThan(fold);
    const guard = core.slice(park - 900, park);
    expect(guard).toContain('!event.parkedOnce && !event.stopEvaluation && !event.battleContext');
    expect(guard).toContain("event: { ...event, parkedOnce: true }");
    expect(guard).toContain('MAX_PARKED_PARAMS_BYTES');
  });

  it('a pass records its follow-ups before it re-reads a queue that moved', () => {
    const keep = core.indexOf('follow-ups before reading again');
    const reread = core.indexOf('const movedReread = await triageQueuedMessages({');
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(reread);
  });

  it('the reading resumes the parked answer once its follow-ups are recorded, and a parked answer counts as in flight', () => {
    const recordAt = core.indexOf('if (amending.length && workStillInFlight) {');
    const resumeAt = core.indexOf('await resumeParkedTurnIfAny({');
    expect(resumeAt).toBeGreaterThan(recordAt);
    expect(core).toContain('&& !live.parkedTurn) {');
  });

  it('every reading exit resumes whatever is still parked', () => {
    expect(handover).toMatch(/if \(triage\) \{\s*await resumeParkedTurnIfAny\(/);
  });

  it('the processor routes a resume before anything else', () => {
    expect(processor).toContain('if (isResumeParkedEvent(event)) return resumeParkedTurn(event);');
    expect(processor).toContain('await takeParkedTurn({ channelArn, responderId, correlationId })');
  });

  it('a fold takes what it folded off the queue', () => {
    const clearAt = core.indexOf('await clearAmendments({');
    expect(core.slice(clearAt, clearAt + 900)).toContain('await takeFoldedOffQueue({');
  });

  it('the processor may invoke itself', () => {
    const policy = stack.slice(stack.indexOf("new iam.Policy(this, 'ProcessorTriageDispatch'"));
    expect(policy.slice(0, 1400)).toContain('resources: [asyncProcessor.functionArn]');
  });
});
