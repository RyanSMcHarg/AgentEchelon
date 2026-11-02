/**
 * PASSING NO EXCERPT IS NOT THE SAME AS STORING NONE (live evidence, 2026-09-03).
 *
 * `openDrainTask` deliberately passes no `requestExcerpt`, so that a targeted message's words never
 * land in a row the room can read. A unit test asserted exactly that - and it mocked `createTask`, so
 * it stopped one step short of the thing that mattered.
 *
 * `createTask` falls back to `event.inputTranscript` when no excerpt is given. That is right for every
 * ordinary caller on the Lex path and wrong for this one, and the router hands the drain the turn's
 * REAL Lex event. Measured on the deployment: nine drain rows out of nine carried the queued message's
 * text, while the test asserting they carried none stayed green.
 *
 * ── WHY THIS TEST GOES THROUGH THE REAL `createTask` ────────────────────────────────────────────
 *
 * Because the defect lives BETWEEN the two: in what the callee does with what the caller omitted.
 * Mocking either end hides it. This asserts on the row that would actually be written - the DynamoDB
 * put - which is the only place the question "what does this row hold" is really answered.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
  ScanCommand: jest.fn().mockImplementation((a) => ({ __t: 'Scan', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })),
  GetChannelMessageCommand: jest.fn(),
}), { virtual: true });

// The slot is the only thing stubbed: it is a conditional write on a different table, and letting it
// through is what makes this the CREATE path rather than a race test.
jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  claimDrainTask: jest.fn(async ({ taskId }: { taskId: string }) => ({ taskId, created: true })),
}));

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';
const PRIVATE_TEXT = 'the quarterly numbers before the board hears them';

process.env.TASKS_TABLE = 'tasks-test';
process.env.USER_TASKS_TABLE = 'user-tasks-test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openDrainTask } = require('../../lambda/src/lib/queue-drain-task') as
  typeof import('../../lambda/src/lib/queue-drain-task');

/** Everything written to the tasks tables this call, as one string. */
function whatWasWritten(): string {
  return JSON.stringify(mockSend.mock.calls.map((c) => c[0]?.input ?? {}));
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('what a drain row actually holds once written', () => {
  /** The turn's REAL Lex event, transcript and all - which is what the router hands it. */
  const lexEvent = {
    inputTranscript: encodeURIComponent(PRIVATE_TEXT),
    requestAttributes: {
      'CHIME.channel.arn': CHANNEL,
      'CHIME.sender.arn': 'arn:aws:chime:us-east-1:123456789012:app-instance/i/user/u1',
    },
  };

  it('does not write the message text, even though the event carries it', async () => {
    // The whole defect in one assertion. It failed against the shipped code while the mock-based test
    // beside it passed.
    await openDrainTask({
      event: lexEvent, channelArn: CHANNEL, responderId: 'assistant-premium', queuedMessageId: 'm1',
    });

    const written = whatWasWritten();
    expect(written).not.toContain(PRIVATE_TEXT);
    expect(written).not.toContain(encodeURIComponent(PRIVATE_TEXT));
  });

  it('still writes the row, with the channel and sender the attributes carry', async () => {
    // Stripping the transcript must not strip what `createTask` genuinely needs: the row has to exist,
    // in the right conversation, attributed to the right person.
    await openDrainTask({
      event: lexEvent, channelArn: CHANNEL, responderId: 'assistant-premium', queuedMessageId: 'm1',
    });

    const puts = mockSend.mock.calls.map((c) => c[0]).filter((c) => c?.__t === 'Put');
    expect(puts.length).toBeGreaterThan(0);
    const row = puts[0].input.Item;
    expect(row.taskType).toBe('queue_drain');
    expect(row.channelArn).toBe(CHANNEL);
    expect(row.userArn).toContain('/user/u1');
  });

  it('keeps the message ID, which is the whole point of not keeping the text', async () => {
    await openDrainTask({
      event: lexEvent, channelArn: CHANNEL, responderId: 'assistant-premium', queuedMessageId: 'm-42',
    });

    expect(whatWasWritten()).toContain('m-42');
  });

  it('writes an empty excerpt rather than omitting the decision', async () => {
    // `createTask` slices `opts.requestExcerpt ?? event.inputTranscript ?? ''`, so with no transcript
    // to fall back on the field lands empty - which is the honest record for a row that describes a
    // queue rather than any one message.
    await openDrainTask({
      event: lexEvent, channelArn: CHANNEL, responderId: 'assistant-premium',
    });

    const puts = mockSend.mock.calls.map((c) => c[0]).filter((c) => c?.__t === 'Put');
    expect(puts[0].input.Item.requestExcerpt).toBe('');
  });
});
