/**
 * A QUESTION THE DRAIN ASKED KEEPS THE CONVERSATION HELD (DESIGN 2.6, ADR-033 correction).
 *
 * `clarifying` is declared `awaits: { party: 'requester' }`. That is not decoration: the drain has
 * read the queue, put something to the person, and is waiting on them, so it is UNFINISHED. Releasing
 * at that point opens the conversation in the middle of a drain, and a new turn can start alongside
 * work the person is still being asked about.
 *
 * The implementation released there for a long time, because the hold condition asked "is anything
 * still queued" - and by then triage had emptied the queue. The queue being empty is exactly the state
 * an outstanding question leaves behind, so the one signal it checked was the one that could not see it.
 */
const mockSend = jest.fn();
const mockDispatch = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetCommand: jest.fn().mockImplementation((input) => ({ input })),
}), { virtual: true });

jest.mock('../../lambda/src/lib/turn-triage', () => ({
  dispatchTriageTurn: (...a: unknown[]) => mockDispatch(...a),
  // Also stubbed: the module is replaced wholesale, and an undefined export here would throw inside
  // the handover and be caught as an ordinary failure, which reads as 'did not hand over'.
  triageQueuedMessages: async () => ({ messages: [], allTriaged: true, visibility: 'conversation' }),
}));

// The queued branch reaches the classification tag, which would otherwise be a real Chime call
// resolving after the test ends - an unhandled rejection that fails the suite while every case passes.
jest.mock('../../lambda/src/lib/channel-classification', () => ({
  resolveChannelClassificationTag: async () => 'premium',
}));

process.env.TURN_QUEUE_ENABLED = '1';
process.env.TURN_STATE_TABLE = 'turn-state';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handover = require('../../lambda/src/lib/turn-handover');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const RESPONDER = 'assistant-premium';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/' + RESPONDER;
const ARGS = { channelArn: CHANNEL, botArn: BOT, correlationId: 'turn-1' };

/** What `readTurnState` reads: one strongly consistent Get of the record. */
const record = (item: Record<string, unknown>) => mockSend.mockResolvedValue({ Item: item });

beforeEach(() => {
  mockSend.mockReset();
  mockDispatch.mockReset().mockResolvedValue(true);
});

/**
 * The lock is NOT kept while waiting on a person - see ADR-033, "waiting on a person is not holding
 * the conversation", and `a-question-outstanding-does-not-hold-the-conversation.test.ts`, which
 * asserts the release. The test that pinned the opposite lived here and is gone with the rule.
 *
 * What remains is the part that did not change: a question outstanding must not SUSPEND the drain.
 */
describe('an outstanding question does not suspend the drain', () => {
  it('dispatches nothing while it waits, because there is nothing to read', async () => {
    // The next thing that happens is a person typing. Handing to a triage turn here would spend a
    // model call reading an empty queue and post a second question over the first.
    record({ holder: 'turn-1', awaitingPerson: 'user-a', queued: [] });

    await handover.handOverToFollowUpTriage(ARGS);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('releases when there is no question outstanding and nothing queued', async () => {
    // The ordinary end of a drain. Holding here would strand the conversation for nothing.
    record({ holder: 'turn-1', queued: [] });

    expect(await handover.handOverToFollowUpTriage(ARGS)).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not short-circuit the queued path when a question is also outstanding', async () => {
    // A question outstanding must not suspend the drain: messages that arrived while it was asked are
    // still read, under the same unbroken lock. This asserts only that the new branch does NOT claim
    // the turn early - whether the hand-over then dispatches is the existing behavior, covered by
    // the-lock-stands-until-the-queue-is-empty.test.ts, and re-proving it here would mean mocking
    // the whole dispatch chain to watch it agree with itself.
    record({ holder: 'turn-1', awaitingPerson: 'user-a', queued: ['m1'] });

    await handover.handOverToFollowUpTriage(ARGS);

    // The waiting branch returns before any write. Reaching one means the queued path was taken.
    expect(mockSend.mock.calls.length).toBeGreaterThan(1);
  });
});
