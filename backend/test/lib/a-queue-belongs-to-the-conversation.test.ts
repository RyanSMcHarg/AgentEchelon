/**
 * A QUEUE IS THE CONVERSATION'S, NOT ONE MEMBER'S (maintainer, 2026-09-05).
 *
 * The queue holds whatever arrived while the assistant was working, from whoever sent it, and the
 * subjects read out of it belong to all of them. The offer that follows was addressed to a single
 * person - the principal id of whoever happened to trigger the drain - and that dropped work two
 * different ways, neither of which produced an error.
 *
 *   1. THE WHOLE OFFER, when that one id could not be derived. `savePendingSplit` refused an offer
 *      with no `offeredTo`, so every subject belonging to everybody was discarded because one field
 *      about one person was empty. The person had already been TOLD about the offer by then.
 *
 *   2. EVERYBODY ELSE'S ANSWER. The recorded name is written to `awaitingPerson`, which is the lock
 *      BYPASS - the right to speak past a held conversation. With one name, only that person could
 *      reply without queueing, while the paragraph they had all just read said the decision was
 *      theirs. Their reply went into the queue instead of ending the question.
 *
 * The rest of the record was already plural and correct, which is what makes this worth pinning
 * rather than merely fixing: `readPendingSplit` shows a shared subject to anybody and a private one
 * only to its requester, and `clearPendingSplit` settles exactly what one speaker could see. Only the
 * addressing disagreed with them, so nothing looked inconsistent from any single call site.
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

// The flag is an exact '1', not any truthy string: set it wrong and every function here returns
// early, so all of this would pass or fail for a reason that has nothing to do with the offer.
process.env.TURN_QUEUE_ENABLED = '1';
process.env.TURN_STATE_TABLE = 'turn-state-test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { savePendingSplit, clearPendingSplit, claimTurn, readTurnState } =
  require('../../lambda/src/lib/turn-lock') as typeof import('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';
const BOT = 'ed31ac66-21f5-41d0-9fdf-faf1da43869c';
const ALICE = 'alice-sub';
const BOB = 'bob-sub';

const lastUpdate = () => mockSend.mock.calls
  .map(([c]) => c)
  .filter((c: any) => c?.__t === 'Update')
  .pop()?.input;

/** Who an offer was put to, read off the offer the way the runtime reads it. */
const offeredIn = (offer: any): string[] => Object.keys(offer?.offeredTo ?? {});

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('an offer is put to everyone it concerns', () => {
  it('records all of them, not just whoever triggered the drain', async () => {
    const ok = await savePendingSplit({
      channelArn: CHANNEL,
      responderId: BOT,
      offer: {
        topics: [
          { label: 'Q3 headcount', messageIds: ['m1'], private: true, requestorId: ALICE },
          { label: 'Pricing page', messageIds: ['m2'], private: true, requestorId: BOB },
        ],
        offeredTo: { [ALICE]: true, [BOB]: true },
        originatingMessageId: 'm2',
        offeredAt: Date.now(),
      },
    });

    expect(ok).toBe(true);
    const write = lastUpdate();
    // WHO IT WAS PUT TO TRAVELS INSIDE THE OFFER. Written beside it, the two could disagree; there
    // is nothing to keep in step here because there is only one of them.
    expect(offeredIn(write.ExpressionAttributeValues[':offer']).sort()).toEqual([ALICE, BOB].sort());
    // The single-id field goes in the same statement: a record carrying both would hold the
    // conversation for one named person while the offer says the question is everybody's.
    expect(write.UpdateExpression).toMatch(/REMOVE awaitingPerson/);
  });

  it('still records an offer nobody could be named for, because the subjects are the question', async () => {
    // This returned false and wrote NOTHING. A shared subject is answerable by anyone in the room, so
    // what is missing without a name is the lock bypass - a convenience - not the offer.
    const ok = await savePendingSplit({
      channelArn: CHANNEL,
      responderId: BOT,
      offer: {
        topics: [{ label: 'Q3 headcount', messageIds: ['m1'] }],
        offeredTo: {},
        originatingMessageId: 'm1',
        offeredAt: Date.now(),
      },
    });

    expect(ok).toBe(true);
    expect(lastUpdate().UpdateExpression).toMatch(/SET pendingSplit = :offer/);
  });

  it('refuses an offer with no subjects, which is nothing to ask about', async () => {
    const ok = await savePendingSplit({
      channelArn: CHANNEL,
      responderId: BOT,
      offer: {
        topics: [], offeredTo: { [ALICE]: true }, originatingMessageId: 'm1', offeredAt: Date.now(),
      },
    });

    expect(ok).toBe(false);
    expect(lastUpdate()).toBeUndefined();
  });
});

describe('each of them can answer, and answering spends only their own right', () => {
  it('lets anybody the offer was put to speak past a held conversation', async () => {
    mockSend.mockResolvedValue({ Attributes: {} });

    await claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'c-1', senderId: BOB,
    } as Parameters<typeof claimTurn>[0]);

    const write = lastUpdate();
    // The offer's own `offeredTo` is what a current record carries; the single id is what one
    // written earlier has. Both are accepted, so a live conversation is not stranded across the
    // deploy that changed the shape.
    expect(write.ConditionExpression).toMatch(/attribute_exists\(pendingSplit\.offeredTo\.#sender\)/);
    expect(write.ConditionExpression).toMatch(/awaitingPerson = :sender/);
    // A NAME, never the raw id: a principal id is somebody else's string in a document path.
    expect(write.ExpressionAttributeNames['#sender']).toBe(BOB);
  });

  it('does not reach into the offer from the claim, which refuses the whole write', async () => {
    mockSend.mockResolvedValue({ Attributes: {} });

    await claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'c-1', senderId: BOB,
    } as Parameters<typeof claimTurn>[0]);

    const write = lastUpdate();
    // ── THE CLAIM MUST NOT TOUCH A PATH IT CANNOT PROVE EXISTS (2026-09-05) ────────────────────
    //
    // This used to spend the bypass in the claim itself, with a nested
    // `REMOVE pendingSplit.offeredTo.#sender`. That is NOT a no-op when the parent is absent:
    // DynamoDB validates the whole document path and refuses the ENTIRE update, so on every
    // ordinary turn - nearly all of them - the claim failed. It fails open by design, so nothing
    // broke loudly: the turn ran, no lock was taken, and the queue was inert across the deployment
    // until a `[turn-lock] claim failed (fail-open)` line in the router log gave it away.
    expect(write.UpdateExpression).not.toMatch(/pendingSplit/);
    // The CONDITION may name the path. A condition that does not hold simply refuses the claim,
    // which is the branch working - unlike an update expression, it is not an invalid request.
    expect(write.ConditionExpression).toMatch(/attribute_exists\(pendingSplit\.offeredTo\.#sender\)/);
    expect(write.ExpressionAttributeNames['#sender']).toBe(BOB);
  });

  it('counts an answer from anybody it was put to as the answer it was waiting for', async () => {
    // `answeredTheQuestion` decides whether the router treats the message as an answer rather than
    // as the continuation of open work, and it compared against the single id - so for everybody but
    // the named person their answer was read as new work.
    mockSend.mockResolvedValue({
      Attributes: { pendingSplit: { offeredTo: { [ALICE]: true, [BOB]: true } } },
    });

    const claim = await claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'c-1', senderId: BOB,
    } as Parameters<typeof claimTurn>[0]);

    expect(claim.answeredTheQuestion).toBe(true);
  });

  it('still recognises the single-id shape a record written earlier carries', async () => {
    mockSend.mockResolvedValue({ Attributes: { awaitingPerson: ALICE } });

    const claim = await claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'c-1', senderId: ALICE,
    } as Parameters<typeof claimTurn>[0]);

    expect(claim.answeredTheQuestion).toBe(true);
  });
});

describe('settling one person leaves the rest still owed', () => {
  it('narrows the offer to whoever still holds a subject', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd?.__t === 'Get') {
        return Promise.resolve({
          Item: {
            pendingSplit: {
              topics: [
                { label: 'Q3 headcount', messageIds: ['m1'], private: true, requestorId: ALICE },
                { label: 'Pricing page', messageIds: ['m2'], private: true, requestorId: BOB },
              ],
              offeredTo: { [ALICE]: true, [BOB]: true },
              originatingMessageId: 'm2',
              offeredAt: 1,
            },
          },
        });
      }
      return Promise.resolve({});
    });

    await clearPendingSplit({ channelArn: CHANNEL, responderId: BOT, speakerId: ALICE });

    const write = lastUpdate();
    // Bob's subject survives, and so does Bob's right to answer it. This statement removed the wait
    // outright while keeping the topics, so after the first answer nobody could give the second.
    expect(write.ExpressionAttributeValues[':rest'].topics).toHaveLength(1);
    expect(write.ExpressionAttributeValues[':rest'].topics[0].requestorId).toBe(BOB);
    expect(offeredIn(write.ExpressionAttributeValues[':rest'])).toEqual([BOB]);
  });

  it('ends the wait in both shapes when nothing is left', async () => {
    mockSend.mockResolvedValue({});

    await clearPendingSplit({ channelArn: CHANNEL, responderId: BOT });

    expect(lastUpdate().UpdateExpression).toBe('REMOVE pendingSplit, awaitingPerson');
  });
});

describe('the read path surfaces the question whichever shape it is in', () => {
  it('reports everyone the offer is outstanding on', async () => {
    mockSend.mockResolvedValue({
      Item: { pendingSplit: { offeredTo: { [ALICE]: true, [BOB]: true } } },
    });

    const state = await readTurnState({ channelArn: CHANNEL, responderId: BOT });

    expect(state.awaitingPeople?.sort()).toEqual([ALICE, BOB].sort());
  });

  it('reports a single id as well, so a paused drain is never read as idle', async () => {
    mockSend.mockResolvedValue({ Item: { awaitingPerson: ALICE } });

    const state = await readTurnState({ channelArn: CHANNEL, responderId: BOT });

    expect(state.awaitingPerson).toBe(ALICE);
  });
});
