/**
 * WHAT IS WAITING IS READ AS ONE THING, AND ANSWERED ONCE (DESIGN 2.6, `reviewing`).
 *
 * A person who sends three things in one breath is owed one reply covering all three. What they got
 * was two replies covering part each, neither mentioning the other, and an offer to separate subjects
 * that named only the ones that happened to share a batch.
 *
 * The cause is a boundary rather than a decision. A triage turn is dispatched with the ids that were
 * queued when the previous turn ENDED; anything landing in the seconds while that turn is being
 * invoked is in the queue but not in that list, so it was read later, separately, with its own
 * proposal. Observed live as `count: 2` and then `count: 1` for three messages sent together.
 *
 * These tests pin the fold: the reading covers what is waiting NOW, in the order it was sent, and a
 * failure to look degrades to the smaller reading rather than to no answer.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetCommand: jest.fn().mockImplementation((input) => ({ input })),
}), { virtual: true });

process.env.TURN_QUEUE_ENABLED = '1';
process.env.TURN_STATE_TABLE = 'turn-state';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const RESPONDER = 'assistant-premium';

/**
 * The fold, as the router performs it: read what is queued now, keep what the dispatch already named,
 * append what arrived since. Expressed here against the real `readTurnState` so the queue shape and
 * the ordering rule are the ones the router actually sees.
 */
const fold = async (dispatched: string[]): Promise<string[]> => {
  const state = await lock.readTurnState({ channelArn: CHANNEL, responderId: RESPONDER });
  const known = new Set(dispatched);
  return [...dispatched, ...state.queued.filter((id: string) => id && !known.has(id))];
};

beforeEach(() => mockSend.mockReset());

describe('the reading covers what is waiting, not what was waiting at dispatch', () => {
  it('folds in a message that arrived after the dispatch named its ids', async () => {
    mockSend.mockResolvedValue({ Item: { queued: ['m1', 'm2', 'm3'] } });

    // The turn was dispatched for two; a third landed while it was being invoked.
    expect(await fold(['m1', 'm2'])).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps arrival order, because the reading is owed in the order things were sent', async () => {
    mockSend.mockResolvedValue({ Item: { queued: ['m1', 'm2', 'm3', 'm4'] } });

    expect(await fold(['m1', 'm2'])).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('adds nothing when nothing arrived since', async () => {
    mockSend.mockResolvedValue({ Item: { queued: ['m1', 'm2'] } });

    expect(await fold(['m1', 'm2'])).toEqual(['m1', 'm2']);
  });

  it('never repeats an id the dispatch already named', async () => {
    // The queue still holds them: it is cleared at the END of the drain, not at dispatch. Reading one
    // twice would create the work twice, which is the doubling the whole design exists to prevent.
    mockSend.mockResolvedValue({ Item: { queued: ['m1', 'm2'] } });

    const folded = await fold(['m1', 'm2']);

    expect(folded).toHaveLength(new Set(folded).size);
  });

  it('degrades to the dispatched reading when the queue cannot be read', async () => {
    // Smaller reading, still a correct one, and the rest stay queued for the next pass. Failing the
    // turn here would cost the person their answer in order to keep the batch tidy.
    mockSend.mockRejectedValue(new Error('throttled'));

    expect(await fold(['m1', 'm2'])).toEqual(['m1', 'm2']);
  });
});
