/**
 * "DOES THIS AMEND THE WORK IN PROGRESS?" IS UNANSWERABLE IF NOBODY SAYS WHAT THE WORK IS.
 *
 * The reading is asked, per queued message, whether it AMENDS the turn it is waiting behind. It was
 * told that turn was `the work already in progress` - a literal phrase, byte-identical for every turn
 * in the deployment - so the model was asked whether "Actually, keep it to one page." changes
 * something it had been given no description of.
 *
 * It cannot, and it did not: the amendment came back classified as NEW work, so the person's
 * correction became a second item answered AFTER the thing it was meant to change. That is FR6
 * failing, and `turn-queue.spec.ts` has asserted it against the deployment for as long as it has
 * existed.
 *
 * ── THE ID, NOT THE TEXT ────────────────────────────────────────────────────────────────────────
 *
 * The record names the MESSAGE the running turn is answering, and the drain resolves it when it needs
 * it - the same discipline the queue itself follows, and the reason none of this stores anybody's
 * words in shared state.
 *
 * ── AND IT IS WRITTEN AFTER THE CLAIM, NOT AS PART OF IT ────────────────────────────────────────
 *
 * Resolving the id needs a Chime read, and the claim is on the critical path of every turn in the
 * deployment. The drain reads the record seconds later, once a queue has formed, so a write landing
 * just after the claim is in time - and one that never lands costs a description, not a turn.
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

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';
const BOT = 'assistant-premium';
const CORR = 'corr-1';
const conditionalFailure = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => { mockSend.mockReset(); mockSend.mockResolvedValue({}); });

describe('the record names what the running turn is answering', () => {
  it('writes the message id, and nothing of what it said', async () => {
    await lock.rememberHolderMessage({
      channelArn: CHANNEL, responderId: BOT, correlationId: CORR, messageId: 'm-1',
    });

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.UpdateExpression).toContain('holderMessageId');
    expect(JSON.stringify(cmd.input.ExpressionAttributeValues)).toContain('m-1');
  });

  it('only while this turn is still the holder', async () => {
    // A turn displaced as stale must not label its successor's work with its own.
    const cmd = await lock.rememberHolderMessage({
      channelArn: CHANNEL, responderId: BOT, correlationId: CORR, messageId: 'm-1',
    }).then(() => mockSend.mock.calls[0][0]);

    expect(cmd.input.ConditionExpression).toBe('holder = :me');
  });

  it('is quiet when it loses that condition, because losing it is ordinary', async () => {
    mockSend.mockRejectedValue(conditionalFailure());

    await expect(lock.rememberHolderMessage({
      channelArn: CHANNEL, responderId: BOT, correlationId: CORR, messageId: 'm-1',
    })).resolves.toBeUndefined();
  });

  it('writes nothing at all without an id to write', async () => {
    await lock.rememberHolderMessage({
      channelArn: CHANNEL, responderId: BOT, correlationId: CORR, messageId: '',
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('hands the id to whoever reads the state', async () => {
    mockSend.mockResolvedValue({ Item: { queued: ['m2'], holder: CORR, holderMessageId: 'm-1' } });

    const state = await lock.readTurnState({ channelArn: CHANNEL, responderId: BOT });

    expect(state.holderMessageId).toBe('m-1');
  });

  it('says nothing when no id was recorded, so the reading can fall back', async () => {
    mockSend.mockResolvedValue({ Item: { queued: ['m2'], holder: CORR } });

    expect(await lock.readTurnState({ channelArn: CHANNEL, responderId: BOT }))
      .not.toHaveProperty('holderMessageId');
  });

  it('a fresh claim carries no id from the turn before it', async () => {
    // The record outlives a turn, so a claim that left the previous holder's message id in place
    // would describe the OLD work to the next queue's reading - which is worse than the bare phrase,
    // because it is confidently wrong rather than merely vague.
    await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-2' });

    const claim = mockSend.mock.calls.map((c) => c[0]).find((c) => c?.__t === 'Update');
    expect(String(claim.input.UpdateExpression)).toContain('REMOVE holderMessageId');
  });
});

/**
 * AND THE DESCRIPTION IS THE MESSAGE, NOT A MANGLED COPY OF IT (code review, 2026-09-04).
 *
 * `inFlightDescription` collapsed whitespace with `/s+/g` - no backslash - which deletes every letter
 * "s". "Please summarise the Q3 sales report" reached the model as "Plea e ummari e the Q3 ale
 * report", and the reading then judged amendments against that. It shipped, and the instrument beside
 * it reported `described: true, chars: 303`, so the fix looked verified while doing the opposite of
 * its job.
 *
 * A LENGTH IS NOT A WITNESS, which is the lesson worth keeping. The log said how many characters
 * arrived and never what they were, so a description that had been shredded looked exactly like one
 * that had not. These assert the TEXT.
 */
describe('what the reading is actually told the work is', () => {
  // THE REAL FUNCTION, and the first version of this file did not call it: it defined a local copy of
  // the transform and asserted against that, which passes whatever the deployed code does. Written
  // while fixing a bug that shipped because a log reported a LENGTH and never the text - the same
  // mistake twice in one file, so the function is exported and called here.
  const recall = jest.fn();
  jest.mock('../../lambda/src/lib/queue-drain-task.js', () => ({
    recallClarifiedMessage: (...a: unknown[]) => recall(...a),
    settleDrainTask: jest.fn(),
  }));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { inFlightDescription } = require('../../lambda/src/lib/triage-on-arrival');

  it('hands over the message intact, including every letter the bug ate', async () => {
    const said = 'Please summarise the Q3 sales report';
    recall.mockResolvedValue(said);

    await expect(inFlightDescription('m-1', CHANNEL, 'bot')).resolves.toBe(said);
  });

  it('collapses runs of whitespace, which is all it was ever meant to do', async () => {
    recall.mockResolvedValue('a  \n\t b');

    await expect(inFlightDescription('m-1', CHANNEL, 'bot')).resolves.toBe('a b');
  });

  it('falls back to the bare phrase rather than an empty description', async () => {
    // A message that is only whitespace, or one that could not be read, leaves the reading with the
    // same statement it had before the id existed - vague, and true.
    recall.mockResolvedValue('   \n  ');
    await expect(inFlightDescription('m-1', CHANNEL, 'bot')).resolves.toBe('the work already in progress');

    recall.mockRejectedValue(new Error('gone'));
    await expect(inFlightDescription('m-1', CHANNEL, 'bot')).resolves.toBe('the work already in progress');
  });

  it('asks for nothing when the record named no message', async () => {
    recall.mockClear();

    await expect(inFlightDescription(undefined, CHANNEL, 'bot')).resolves.toBe('the work already in progress');
    expect(recall).not.toHaveBeenCalled();
  });

  it('trims a long prompt to a label, because this is for comparing against', async () => {
    // A fifteen-paragraph prompt reproduced whole would crowd out the queue it is meant to help
    // classify.
    recall.mockResolvedValue('x'.repeat(500));

    const out = await inFlightDescription('m-1', CHANNEL, 'bot');
    expect(out).toHaveLength(303);
    expect(out.endsWith('...')).toBe(true);
  });
});
