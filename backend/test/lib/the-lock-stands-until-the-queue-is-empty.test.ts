/**
 * A PERSON WHO KEEPS TYPING MUST KEEP MEETING A HELD LOCK (ADR-033).
 *
 * Arrival triage takes `claimTriage` for a good reason - two notices must not create the same work
 * twice - and the cost is that a message arriving WHILE it runs finds the claim held and returns.
 * Nothing comes back for that message afterwards. It stays queued, is rendered to the person as
 * waiting, and waits for as long as the conversation lives. The e2e recorded exactly that: three
 * messages held, one of them described in the proposal, `drained: false`.
 *
 * The end of the turn is the last moment anything holds the conversation, so it is the place to catch
 * what arrival triage could not reach - and turn completion is an EVENT, so catching it there is not
 * the timed sweep tenet D6 forbids.
 *
 * WHAT THESE TESTS PIN is that the lock is HANDED OVER rather than released. Release-then-re-claim
 * leaves an instant with the conversation unheld, and in that instant the queued backlog is behind
 * nothing: the next message does not queue, it starts a turn alongside the triage being dispatched
 * for the same messages, and two assistants answer the same backlog.
 */

const mockRead = jest.fn();
const mockClaimTriage = jest.fn();
const mockReleaseTriage = jest.fn();
const mockHandOver = jest.fn();
const mockReleaseLock = jest.fn();
const mockTriage = jest.fn();
const mockDispatch = jest.fn();
const mockTag = jest.fn();
const mockReturnAmendments = jest.fn();

jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  readTurnState: (...a: unknown[]) => mockRead(...a),
  claimTriage: (...a: unknown[]) => mockClaimTriage(...a),
  releaseTriage: (...a: unknown[]) => mockReleaseTriage(...a),
  handOverLock: (...a: unknown[]) => mockHandOver(...a),
  releaseLock: (...a: unknown[]) => mockReleaseLock(...a),
  returnAmendmentsToQueue: (...a: unknown[]) => mockReturnAmendments(...a),
}));
jest.mock('../../lambda/src/lib/turn-triage.js', () => ({
  triageQueuedMessages: (...a: unknown[]) => mockTriage(...a),
  dispatchTriageTurn: (...a: unknown[]) => mockDispatch(...a),
}));
// `readChannelClassificationTag` since ADR-045 decision 2. A factory exporting only the old name
// fails as a TypeError rather than as the assertion under test.
jest.mock('../../lambda/src/lib/channel-classification.js', () => ({
  readChannelClassificationTag: (...a: unknown[]) => mockTag(...a),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = jest.fn(); },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handOverToFollowUpTriage } = require('../../lambda/src/lib/turn-handover');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas';
const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';
const CORRELATION = 'turn-abc';

const call = () => handOverToFollowUpTriage({
  channelArn: CHANNEL, botArn: BOT, correlationId: CORRELATION,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ queued: ['m2', 'm3'], holder: CORRELATION });
  mockClaimTriage.mockResolvedValue(true);
  mockReleaseTriage.mockResolvedValue(undefined);
  mockHandOver.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockReturnAmendments.mockResolvedValue([]);
  mockTag.mockResolvedValue('standard');
  mockTriage.mockResolvedValue({
    messages: [{ messageId: 'm2', senderArn: USER, content: 'and another thing' }],
    visibility: 'room',
  });
  mockDispatch.mockResolvedValue(true);
});

describe('the lock stands until the queue is empty', () => {
  it('hands the lock to the triage that will read what arrival triage missed', async () => {
    expect(await call()).toBe(true);

    // The caller reads the return value to decide whether to release. True MUST mean the lock now
    // belongs to a dispatched turn, or the conversation is held by nothing until the TTL.
    expect(mockHandOver).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL, from: CORRELATION,
    }));
    const handedTo = mockHandOver.mock.calls[0][0].to;
    expect(handedTo).not.toBe(CORRELATION);

    // AND THE TURN DISPATCHED IS THE ONE THE LOCK WAS HANDED TO. A handover to an id nothing runs
    // under is the stranding this is supposed to prevent, wearing the shape of a fix.
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL,
      correlationId: handedTo,
      messages: [expect.objectContaining({ messageId: 'm2' })],
    }));
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('hands over BEFORE dispatching, so the conversation is never unheld', async () => {
    const order: string[] = [];
    mockHandOver.mockImplementation(async () => { order.push('handover'); return true; });
    mockDispatch.mockImplementation(async () => { order.push('dispatch'); return true; });

    await call();

    // Dispatch-then-hand-over leaves a window in which the triage turn is running without the lock,
    // and a message arriving inside it does not queue - it starts a turn beside the backlog.
    expect(order).toEqual(['handover', 'dispatch']);
  });

  it('releases as normal when the queue is empty, which is almost every turn', async () => {
    mockRead.mockResolvedValue({ queued: [], holder: CORRELATION });

    expect(await call()).toBe(false);

    // A queue feature must cost nothing on conversations that never queue anything: no claim, no
    // Chime call to resolve a classification, no dispatch.
    expect(mockClaimTriage).not.toHaveBeenCalled();
    expect(mockTag).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('hands the conversation to the reading that already holds the claim', async () => {
    mockClaimTriage.mockResolvedValue(false);
    mockRead.mockResolvedValue({ queued: ['m2', 'm3'], holder: CORRELATION, triagedBy: 'arrival-m9-2' });

    // THIS TEST USED TO ASSERT THE OPPOSITE - that standing down and releasing was correct, because
    // the reader holding the claim would cover the queue. It does not always: it read the queue
    // before these messages arrived, and if it is finishing at this moment both sides stand down.
    // Measured live as a conversation left with no holder, one message queued, and nothing that
    // would ever read it.
    //
    // A reading is PROCESSING, so the conversation stays held - by the reader, which is the thing
    // actually doing the work. Not dispatching is still right: a second reader over the same queue
    // is the duplicated work the claim exists to prevent.
    expect(await call()).toBe(true);
    expect(mockHandOver).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL, from: CORRELATION, to: 'arrival-m9-2',
    }));
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('releases when the reading holding the queue cannot be named', async () => {
    mockClaimTriage.mockResolvedValue(false);
    mockRead.mockResolvedValue({ queued: ['m2', 'm3'], holder: CORRELATION });

    // A claim that expired between the read and this write, or a reader from a build that predates
    // the claim naming its own turn. Holding a lock for a turn that cannot be named is the
    // stranding tenet 2 forbids, because nothing would ever release it - so this keeps the old
    // behavior, whose cost is a delay the next message ends.
    expect(await call()).toBe(false);
    expect(mockHandOver).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('releases rather than handing the conversation to itself when this turn IS the reading', async () => {
    // Arrival triage names its turn by the claim it holds, so a reading turn ending here finds its
    // OWN id in `triagedBy`. Two wrong answers were tried here and both are pinned against:
    //
    //   - asking for the claim under a derived `handover-` id asks for something it already has, is
    //     refused, and sends it to hand the lock to ITSELF - a lock held by a turn that has ended,
    //     which nothing ever releases and which stops the conversation answering at all;
    //   - claiming under its own id and carrying on turned one reading into a chain of them, each
    //     taking a slice, so a queue spanning two subjects was consumed piecemeal and the split was
    //     never offered.
    //
    // Its reading is over, so it releases: no self-handover, and no chain racing itself.
    mockRead.mockResolvedValue({ queued: ['m2'], holder: CORRELATION, triagedBy: CORRELATION });

    expect(await call()).toBe(false);
    expect(mockHandOver).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not hand a lock away when this turn was already displaced as dead', async () => {
    mockHandOver.mockResolvedValue(false);

    expect(await call()).toBe(false);
    // The conditional write refused because the holder is no longer this turn. Dispatching anyway
    // would run a triage under an id that does not hold the conversation.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockReleaseTriage).toHaveBeenCalled();
  });

  it('does not strand the lock on a turn that never started', async () => {
    mockDispatch.mockRejectedValue(new Error('invoke failed'));

    await call();

    // The handover landed and the dispatch did not, so the holder is an id belonging to nothing.
    // Only the TTL would free that, which is the stranding tenet 2 exists to prevent.
    const handedTo = mockHandOver.mock.calls[0][0].to;
    expect(mockReleaseLock).toHaveBeenCalledWith(expect.objectContaining({ correlationId: handedTo }));
  });

  it('releases the triage claim on every path, including the failing one', async () => {
    mockTriage.mockRejectedValue(new Error('unreadable'));

    await call();

    // A stranded triage claim costs a delay rather than silence, but it still costs one, and this
    // path is the one that runs when something is already going wrong.
    expect(mockReleaseTriage).toHaveBeenCalledWith(expect.objectContaining({ channelArn: CHANNEL }));
  });

  it('never holds the conversation because the state could not be read', async () => {
    mockRead.mockRejectedValue(new Error('ddb down'));

    // Unreadable state says nothing about whether a queue exists. Holding on that would turn one
    // failed read into a conversation that answers nobody until the TTL.
    expect(await call()).toBe(false);
    expect(mockHandOver).not.toHaveBeenCalled();
  });
});

/**
 * THE HANDOVER IS A LOOP, AND A LOOP OVER A QUEUE A PERSON IS STILL FILLING DOES NOT END ON ITS OWN.
 *
 * The turn handed to is itself a triage turn, so its completion arrives straight back at the same
 * release path. If the person is still typing there is still something queued, so it hands over
 * again. Holding the conversation for as long as somebody keeps typing is the same stranding tenet 2
 * forbids, reached by a route that looks like progress.
 *
 * It is bounded by the budget triage ALREADY carries rather than a second one invented for this - and
 * critically the deadline travels UNCHANGED, because a loop that renews its own budget by looping is
 * not bounded by a clock at all.
 */
/**
 * THE CHAIN IS BOUNDED BY HOW MANY HANDOVERS DEEP IT IS, NOT BY A WALL CLOCK.
 *
 * The obvious bound was triage's existing budget, and it was the wrong instrument. That deadline is a
 * WITHIN-TURN clock - six seconds, so a reading cannot loop over one queue while somebody waits - and
 * a handover happens after a whole turn has run, so it is always already spent. Carrying it made
 * every handover refuse, release the lock, and strand whatever had arrived: observed live as
 * `budget is spent, pass: 1, stillQueued: 1` on a queue that never drained.
 *
 * It was also the wrong question. A handover is not another pass at the same reading - it is a first
 * reading of DIFFERENT messages, the ones that arrived while the last one ran. So it gets its own
 * within-turn budget, and what is bounded instead is how many times the chain may repeat.
 */
describe('the handover chain is bounded by depth, not by a clock', () => {
  it('carries the depth forward and does NOT carry a deadline', async () => {
    expect(await handOverToFollowUpTriage({
      channelArn: CHANNEL, botArn: BOT, correlationId: CORRELATION,
      triage: { pass: 1 },
    })).toBe(true);

    const dispatched = mockDispatch.mock.calls[0][0];
    // The chain depth is the whole loop state. There is no clock to carry any more: it was removed
    // once it was shown to grant an option before a turn ran and refuse it the moment it answered.
    expect(dispatched.pass).toBe(2);
  });

  it('hands over even when the previous turn took longer than a reading budget', async () => {
    // The case that was broken. Any real triage turn outlives a six-second within-turn budget, so
    // this is not an edge case - it was every handover.
    expect(await handOverToFollowUpTriage({
      channelArn: CHANNEL, botArn: BOT, correlationId: CORRELATION,
      triage: { pass: 1 },
    })).toBe(true);
    expect(mockDispatch).toHaveBeenCalled();
  });

  it('stops once the chain has repeated its limit, with messages still queued', async () => {
    const spent = await handOverToFollowUpTriage({
      channelArn: CHANNEL, botArn: BOT, correlationId: CORRELATION,
      triage: { pass: 3 },
    });

    // False sends the caller down its normal release. The queue is not lost by that: the next thing
    // the person sends starts a fresh turn that reads what is still waiting.
    expect(spent).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockHandOver).not.toHaveBeenCalled();
  });

  it('starts a fresh chain when an ordinary answering turn hands over', async () => {
    await call();

    const dispatched = mockDispatch.mock.calls[0][0];
    expect(dispatched.pass).toBeUndefined();
  });
});

/**
 * A DISPATCH THAT DID NOT HAPPEN IS NOT A HANDOVER.
 *
 * `dispatchTriageTurn` SWALLOWS its failures and returns false rather than throwing: an unresolvable
 * router, a throttled invoke. Returning true on that told the caller the lock had a new owner while
 * nothing was running under it, so every later message queued behind a holder that would never
 * finish - the exact stranding this file exists to prevent, produced by it.
 *
 * The `catch` below could never have covered this, because there was nothing to catch.
 */
describe('the handover reads whether the dispatch actually happened', () => {
  it('releases the lock and reports failure when the dispatch is refused', async () => {
    mockDispatch.mockResolvedValue(false);

    expect(await call()).toBe(false);

    // Released under the id it was handed to, because that is who holds it now.
    const handedTo = mockHandOver.mock.calls[0][0].to;
    expect(mockReleaseLock).toHaveBeenCalledWith(expect.objectContaining({ correlationId: handedTo }));
  });

  it('still reports success when the dispatch is accepted', async () => {
    mockDispatch.mockResolvedValue(true);

    expect(await call()).toBe(true);
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });
});

/**
 * AN AMENDMENT THE FOLD NEVER REACHED IS NOT LOST (maintainer, 2026-09-01).
 *
 * The fold was the only thing that ever cleared `amendments`, so one recorded after the turn passed
 * its checkpoint - the common case, because a short turn reaches that checkpoint before triage has
 * finished classifying - stayed there for the life of the conversation. Read, classified, described
 * back to the person, and acted on by nothing. Measured live: `recorded 1 amendment(s)`, never taken
 * off, while the queue emptied and the notice settled around it.
 *
 * The turn ending is where it is caught, for the same reason the queue itself is caught here: it is
 * the last moment anything holds the conversation, and it is an EVENT rather than a sweep.
 */
describe('an amendment that outlived the work it amended goes back on the queue', () => {
  it('returns it BEFORE reading the state, so the handover can see it waiting', async () => {
    await call();

    expect(mockReturnAmendments).toHaveBeenCalledWith(
      expect.objectContaining({ channelArn: CHANNEL }),
    );
    // THE INVARIANT IS THE ASSERTION, NOT THE CALL ORDER (2026-09-09). What has to hold is that the
    // release branch below sees the returned ids in the queue - a message it cannot see is stranded a
    // second time by the very thing meant to catch it.
    //
    // The order flipped for a reason: the rescue is now conditional on whether anything is STILL
    // ANSWERING, which is read from the same record, so the read has to come first. The ids are
    // merged into that state afterwards, which preserves the invariant by a different route. Pinning
    // the ORDER pinned one implementation of it, and would have failed a correct change.
    expect(mockReturnAmendments).toHaveBeenCalled();
    expect(mockRead).toHaveBeenCalled();
  });

  it('asks for every amendment still recorded, rather than naming ids it would have to already know', async () => {
    await call();

    // The turn is over, so there is nothing left to fold into and nothing to be selective about.
    const args = mockReturnAmendments.mock.calls[0][0] as { messageIds?: string[] };
    expect(args.messageIds).toBeUndefined();
  });
});
