/**
 * AN AMENDMENT IS NEVER LEFT WITH NOTHING TO REACH IT.
 *
 * A message arriving mid-turn can be judged as AMENDING the work in flight rather than starting new
 * work. That judgement is made by a READING turn running alongside the ANSWERING turn, and it is
 * recorded rather than acted on, because the fold belongs to the turn being amended.
 *
 * Which leaves one question nobody asked until it happened: what if the answering turn has already
 * finished?
 *
 * ── OBSERVED LIVE, 2026-09-09 ───────────────────────────────────────────────────────────────────
 *
 * Four messages in twelve seconds. The answer landed at 11:49:26 and the reading's proposal at
 * 11:49:32 - the answering turn finished FIRST - and the proposal told the person, in as many words,
 * that it would answer both follow-ups "now". Nothing followed. The record was left holding:
 *
 *     amendments: [447f15d0…, 1a824299…]   queued: (empty)   holder: (none)
 *
 * Two messages read, classified, described back to the person, and then reached by nothing: the fold
 * was the only thing that ever cleared that list and its turn was gone, the queue was empty so no
 * drain would look, and the lock was released so nothing would fold. Permanent.
 *
 * ── AND WHY THE OBVIOUS FIX IS WRONG ────────────────────────────────────────────────────────────
 *
 * "Rescue on every turn" was the original behavior and was removed on 2026-09-04 for a good reason:
 * the reading turn is SHORTER by design, so it normally finishes first and would return the very
 * amendment it had just recorded, leaving the answering turn to read an empty list and deliver
 * unamended - the feature defeated on its normal path, with a log line claiming a rescue.
 *
 * Both orders are real, so the discriminator cannot be "is this a reading turn". It is "is anything
 * ELSE still answering", and answering that needs the record to say WHICH turn holds the conversation:
 * `busy` is `!!holder`, and a reading handed the conversation by the turn it was reading alongside IS
 * the holder by then. Every direction is pinned here, because fixing any one alone re-breaks another.
 */

const mockReadTurnState = jest.fn();
const mockReturnAmendments = jest.fn();
const mockDispatchTriageTurn = jest.fn();
const mockClaimTriage = jest.fn();

jest.mock('../../lambda/src/lib/turn-lock', () => ({
  readTurnState: (...a: unknown[]) => mockReadTurnState(...a),
  returnAmendmentsToQueue: (...a: unknown[]) => mockReturnAmendments(...a),
  claimTriage: (...a: unknown[]) => mockClaimTriage(...a),
  // The rest of the seam, stubbed to succeed: this file is about which amendments are rescued, not
  // about the lock handover mechanics that have their own tests.
  releaseTriage: jest.fn().mockResolvedValue(undefined),
  handOverLock: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  clearQueue: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../lambda/src/lib/queue-drain-task', () => ({
  settleDrainTask: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lambda/src/lib/turn-triage', () => ({
  dispatchTriageTurn: (...a: unknown[]) => mockDispatchTriageTurn(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handOverToFollowUpTriage } = require('../../lambda/src/lib/turn-handover');

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const BOT = `${APP}/bot/assistant-premium`;
const AMEND_A = '447f15d02fa6e36add36dbf94e9fe290030e995d422dae2a9a0b3d56aca9b07e';
const AMEND_B = '1a824299b0ed16299a5529233bfa7b1f2854a4ea250ac556fc0b76236adaa58a';

const handOver = (triage?: unknown) => handOverToFollowUpTriage({
  channelArn: CHANNEL,
  botArn: BOT,
  correlationId: 'turn-1',
  classification: 'premium',
  ...(triage ? { triage } : {}),
});

beforeEach(() => {
  mockReadTurnState.mockReset();
  mockReturnAmendments.mockReset();
  mockDispatchTriageTurn.mockReset();
  mockClaimTriage.mockReset();
  mockReturnAmendments.mockResolvedValue([]);
  mockClaimTriage.mockResolvedValue(true);
  mockDispatchTriageTurn.mockResolvedValue(true);
});

describe('a reading turn ending after the work it read for', () => {
  it('returns the stranded amendments to the queue', async () => {
    // The exact live shape: nothing holds the conversation, the queue is empty, and the amendments
    // the reading just recorded have no turn left to fold them.
    mockReadTurnState.mockResolvedValue({ busy: false, queued: [] });
    mockReturnAmendments.mockResolvedValue([AMEND_A, AMEND_B]);

    await handOver({ pass: 1 });

    expect(mockReturnAmendments).toHaveBeenCalledWith(
      expect.objectContaining({ channelArn: CHANNEL }),
    );
  });

  it('puts them in the QUEUE, which is a state the system actually reads', async () => {
    // Returning them is only half of it: the branches below decide on state.queued, which is read
    // BEFORE the rescue, so without merging the returned ids the release-on-empty branch would
    // strand them a second time - by the very thing meant to catch them.
    //
    // The queue is where they belong. A reading deliberately does NOT chain another reading (that
    // consumed a queue piecemeal and stopped the split offer being made at all), so it releases and
    // the next arrival reads what is queued. That is the documented lifecycle; an amendment list
    // with no turn to fold it is not a state anything reads.
    mockReadTurnState.mockResolvedValue({ busy: false, queued: [] });
    mockReturnAmendments.mockResolvedValue([AMEND_A, AMEND_B]);

    await handOver({ pass: 1 });

    expect(mockReturnAmendments).toHaveBeenCalled();
  });

  it('rescues them even when a question is outstanding, which is how it was found', async () => {
    // The live case released HERE: a question was outstanding and the queue looked empty, so the
    // branch let the conversation go and took the amendments with it.
    mockReadTurnState.mockResolvedValue({ busy: false, queued: [], awaitingPeople: ['someone'] });
    mockReturnAmendments.mockResolvedValue([AMEND_A]);

    await handOver({ pass: 1 });

    expect(mockReturnAmendments).toHaveBeenCalled();
  });});

describe('a reading turn ending while the work it read for is still running', () => {
  it('leaves the amendments alone, so the fold can still reach them', async () => {
    // ── THE 2026-09-04 FIX, WHICH MUST NOT REGRESS ────────────────────────────────────────────
    //
    // This is the NORMAL order: the reading is shorter and finishes first. Returning the amendment
    // here removes it from the record, and the answering turn then reads an empty list and delivers
    // unamended - the feature silently defeated, with a log line claiming a rescue.
    // NAMED, because 'busy' alone cannot tell a stranger's hold from this turn's own - which is
    // exactly how this guard came to skip the rescue it was written for. See the describe below.
    mockReadTurnState.mockResolvedValue({ busy: true, holder: 'the-answering-turn', queued: [] });

    await handOver({ pass: 1 });

    expect(mockReturnAmendments).not.toHaveBeenCalled();
  });
});

describe('an ordinary answering turn', () => {
  it('still rescues its own orphaned amendments', async () => {
    // Unchanged behavior: this turn IS the work being amended, it is ending, so anything still
    // recorded was never folded.
    mockReadTurnState.mockResolvedValue({ busy: false, queued: [] });
    mockReturnAmendments.mockResolvedValue([AMEND_A]);

    await handOver();

    expect(mockReturnAmendments).toHaveBeenCalled();
  });
});

/**
 * ── AND "BUSY" INCLUDED THIS TURN'S OWN HOLD (live evidence, 2026-09-09) ─────────────────────────
 *
 * The discriminator above is right and the way it was read was wrong. The reasoning at the top of
 * this file says `busy` is `!!holder` and "a triage turn never claims the lock". That is true of a
 * reading dispatched ALONGSIDE a running turn, and false of the case the rescue exists for: when the
 * answering turn finishes first it HANDS the conversation to the reader (`handOverLock` sets
 * `holder = <reader>`), so by the time that reading runs its own handover it IS the holder.
 *
 * `busy` was therefore true because of the reading itself, the rescue declined, and the record was
 * left in the shape at the top of this file - amendments held, queue empty, holder gone - reached
 * through the guard written to prevent it. Seen on the turn-queue sweep 2026-09-09: three
 * conversations left holding amendment ids, and no rescue line in any log because the function was
 * never called.
 *
 * So the record now says WHICH turn holds it, and the question asked is "is somebody ELSE still
 * answering".
 */
describe('a reading turn that was handed the conversation', () => {
  it('rescues the amendments, because its own hold is not somebody else answering', async () => {
    // THE LIVE SHAPE, and the one the old reading of `busy` got wrong: the reading holds the lock
    // because the answering turn handed it over on its way out. Nothing else will ever fold these.
    mockReadTurnState.mockResolvedValue({ busy: true, holder: 'turn-1', queued: [] });
    mockReturnAmendments.mockResolvedValue([AMEND_A]);

    await handOver({ pass: 1 });

    expect(mockReturnAmendments).toHaveBeenCalledWith(
      expect.objectContaining({ channelArn: CHANNEL }),
    );
  });

  it('does not chain another reading, so the queue is what carries them on', async () => {
    // The documented lifecycle, and the reason the rescue writes to the QUEUE rather than handing
    // the ids to a turn of its own: a reading that chains a reading consumed the queue piecemeal and
    // stopped the split offer being made at all. It releases, and the next arrival reads what is
    // queued - so the rescue landing anywhere else would be a state nothing reads.
    mockReadTurnState.mockResolvedValue({ busy: true, holder: 'turn-1', queued: [] });
    mockReturnAmendments.mockResolvedValue([AMEND_A, AMEND_B]);

    await handOver({ pass: 1 });

    expect(mockReturnAmendments).toHaveBeenCalled();
    expect(mockDispatchTriageTurn).not.toHaveBeenCalled();
  });

  it('still leaves them for a hold that is NOT its own', async () => {
    // The 2026-09-04 fix, stated as the pair: a stranger's hold means the fold is still coming.
    mockReadTurnState.mockResolvedValue({ busy: true, holder: 'a-different-turn', queued: [] });

    await handOver({ pass: 1 });

    expect(mockReturnAmendments).not.toHaveBeenCalled();
  });
});
