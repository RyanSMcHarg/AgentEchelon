/**
 * `LockTakeover` IS THE METRIC ADR-033 SAYS THIS DESIGN IS JUDGED BY, so it must count faults only.
 *
 * Two clauses of the claim displace a holder: a holder past any possible turn, and the PERSON the
 * drain is waiting on answering the question it asked. "The holder changed" was the whole test, so
 * the ordinary close of the split-offer loop was counted as a takeover and logged as a holder "past
 * any possible turn" - and the stranded-lock alarm watches that number, so it rose whenever the
 * feature worked.
 */
const mockSend = jest.fn();
const mockTakeover = jest.fn();
const mockAwaited = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/turn-queue-metrics', () => ({
  recordQueued: jest.fn(),
  recordOverflowDrop: jest.fn(),
  recordTakeover: (...a: unknown[]) => mockTakeover(...a),
  recordAwaitedAnswer: (...a: unknown[]) => mockAwaited(...a),
}));
jest.mock('../../lambda/src/lib/abuse-controls', () => ({ readPlaceholderMapping: jest.fn() }));

process.env.TURN_STATE_TABLE = 'test-table';
process.env.TURN_QUEUE_ENABLED = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'assistant-premium';
const ALICE = 'alice';
const LONG_DEAD = () => Date.now() - 10 * 60_000;

beforeEach(() => {
  [mockSend, mockTakeover, mockAwaited].forEach((m) => m.mockReset());
});

it('counts a TAKEOVER when the displaced holder was past any possible turn', async () => {
  mockSend.mockResolvedValue({ Attributes: { holder: 'corr-dead', holderAt: LONG_DEAD() } });

  await lock.claimTurn({
    channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-new',
  });

  expect(mockTakeover).toHaveBeenCalledTimes(1);
  expect(mockAwaited).not.toHaveBeenCalled();
});

it('does NOT count a takeover when the person the drain asked answered', async () => {
  // The healthy close of the split-offer loop. The holder changes, and nothing is wrong.
  mockSend.mockResolvedValue({
    Attributes: { holder: 'corr-drain', holderAt: Date.now() - 2_000, awaitingPerson: ALICE },
  });

  await lock.claimTurn({
    channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-answer', senderId: ALICE,
  });

  expect(mockTakeover).not.toHaveBeenCalled();
  expect(mockAwaited).toHaveBeenCalledTimes(1);
});

it('counts neither when the same turn reclaims its own lock', async () => {
  // A redelivery of the same message must not read as either event.
  mockSend.mockResolvedValue({ Attributes: { holder: 'corr-same', holderAt: Date.now() - 1_000 } });

  await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-same' });

  expect(mockTakeover).not.toHaveBeenCalled();
  expect(mockAwaited).not.toHaveBeenCalled();
});

it('counts neither on a first claim, where nothing was displaced', async () => {
  mockSend.mockResolvedValue({});

  await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-first' });

  expect(mockTakeover).not.toHaveBeenCalled();
  expect(mockAwaited).not.toHaveBeenCalled();
});
