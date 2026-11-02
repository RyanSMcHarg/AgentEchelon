/**
 * INVARIANT A: a lock is held only while compute is running.
 *
 * ADR-033, "waiting on a person is not holding the conversation". A drain that has read its queue,
 * put a question to somebody and has nothing left to read is NOT executing. Holding the conversation
 * across that wait is not mutual exclusion, because there is no contended resource: it is a
 * stranding, and it was reachable by one reply the parse did not recognize.
 *
 * What it cost, before this: awaitingPerson is removed only by an answer, the record has no expiry,
 * and the claim's takeover clause refused any record carrying it. So every OTHER member's messages
 * queued behind a turn that had already finished, for good, and only the person who had been asked
 * could free it - which nothing told them.
 *
 * The queue being EMPTY is what makes releasing safe here, and it is asserted rather than assumed:
 * with nothing unread there is no work a second turn could race for.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const readTurnState = jest.fn();
const releaseLock = jest.fn();
const claimTriage = jest.fn();
const releaseTriage = jest.fn();
const handOverLock = jest.fn();
// The handover sweeps unfolded amendments back onto the queue before it reads the queue at all, so
// this module mock has to carry it or every path through `handOverToFollowUpTriage` throws before
// reaching the behavior under test. Defaults to "nothing was orphaned", which is the ordinary case
// and keeps these tests about the question-outstanding rule rather than about amendments.
const returnAmendmentsToQueue = jest.fn().mockResolvedValue([]);
const dispatchTriageTurn = jest.fn();
const triageQueuedMessages = jest.fn();

jest.mock('../../lambda/src/lib/turn-lock', () => ({
  readTurnState: (...a: unknown[]) => readTurnState(...a),
  releaseLock: (...a: unknown[]) => releaseLock(...a),
  claimTriage: (...a: unknown[]) => claimTriage(...a),
  releaseTriage: (...a: unknown[]) => releaseTriage(...a),
  handOverLock: (...a: unknown[]) => handOverLock(...a),
  returnAmendmentsToQueue: (...a: unknown[]) => returnAmendmentsToQueue(...a),
}));
jest.mock('../../lambda/src/lib/turn-triage', () => ({
  triageQueuedMessages: (...a: unknown[]) => triageQueuedMessages(...a),
  dispatchTriageTurn: (...a: unknown[]) => dispatchTriageTurn(...a),
}));
jest.mock('../../lambda/src/lib/channel-classification', () => ({
  resolveChannelClassificationTag: jest.fn().mockResolvedValue('premium'),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })),
}));

const ARGS = {
  channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
  botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/bot',
  correlationId: 'the-turn-that-asked',
  classification: 'premium',
};

describe('a question outstanding does not hold the conversation', () => {
  let handOver: any;

  beforeAll(() => {
    handOver = require('../../lambda/src/lib/turn-handover').handOverToFollowUpTriage;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Every one of these is awaited or .catch()ed by the code under test, so an undefined return is
    // a TypeError rather than a fair test of the branch.
    releaseLock.mockResolvedValue(undefined);
    releaseTriage.mockResolvedValue(undefined);
    handOverLock.mockResolvedValue(true);
    claimTriage.mockResolvedValue(true);
    triageQueuedMessages.mockResolvedValue({ messages: [{ messageId: 'm1' }], emptiedIds: [] });
    dispatchTriageTurn.mockResolvedValue(true);
  });

  it('hands over nothing and holds nothing when it is waiting on a person', async () => {
    readTurnState.mockResolvedValue({ busy: true, queued: [], awaitingPerson: 'ada' });

    const handedOver = await handOver(ARGS);

    // FALSE MEANS THE CALLER RELEASES. It returned true here until 2026-08-31, which is the whole
    // defect: "nothing was handed over" and "the conversation stays locked" were the same answer.
    expect(handedOver).toBe(false);
    expect(dispatchTriageTurn).not.toHaveBeenCalled();
  });

  it('still hands over when something is actually queued behind the question', async () => {
    // The release above is safe BECAUSE the queue is empty. With unread messages there is work a
    // second turn could race for, so this path must keep handing over rather than open the door.
    readTurnState.mockResolvedValue({
      busy: true,
      queued: [{ messageId: 'm1', senderId: 'ada', content: 'and one more thing' }],
      awaitingPerson: 'ada',
    });
    claimTriage.mockResolvedValue(true);
    dispatchTriageTurn.mockResolvedValue(true);

    await handOver(ARGS);

    expect(dispatchTriageTurn).toHaveBeenCalled();
  });

  it('names the source of the rule where somebody changing it will look', () => {
    const fs = require('fs');
    const src: string = fs.readFileSync(
      path.resolve(ROOT, 'lambda/src/lib/turn-handover.ts'), 'utf8',
    );
    expect(src).toContain('waiting on a person is not holding the');
    expect(src).not.toContain('holding the conversation for an answer this drain asked for');
  });
});

/**
 * INVARIANT A, the other direction: released too early is the same failure as held too long.
 *
 * The "another pass" exit dispatches a triage turn that REUSES this turn's correlation id and then
 * returns. That pass takes no lock of its own, so the turn that dispatched it must not release the
 * one it is running under. While the finalizer returned void, "this turn is finished" and "this turn
 * handed off to itself" were the same answer, and the caller released - letting the next arriving
 * message answer alongside a pass that was still reading.
 */
describe('a pass still reading keeps the lock it runs under', () => {
  const fs = require('fs');
  const CORE = path.resolve(ROOT, 'lambda/src/lib/async-processor-core.ts');
  const PROCESSOR = path.resolve(ROOT, 'lambda/src/assistant-async-processor.ts');

  it('the finalizer reports whether something still runs on this correlation', () => {
    const src: string = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('}): Promise<{ redispatched: boolean }> {');
    // The re-dispatch exit is the one that must say true.
    expect(src).toContain('return { redispatched: true };');
  });

  it('the caller does not hand over or release while that pass runs', () => {
    const src: string = fs.readFileSync(PROCESSOR, 'utf8');
    // The decision lives in `settleTurnLockAtExit`, whose behavior is pinned in
    // `a-duplicate-run-does-not-release-the-live-lock.test.ts`; this pins that the processor hands it
    // the flag. Skipping the handover is the point: with the queue still populated and the triage
    // claim expired, calling it would dispatch a SECOND reader for the same messages.
    expect(src).toContain('await settleTurnLockAtExit({');
    expect(src).toContain('      redispatchedPass,');
    expect(src).toContain('let redispatchedPass = false;');
  });
});

/**
 * INVARIANT A, the last two holds: a claim nothing releases, and a claim held across a drain that
 * never happens.
 */
describe('nothing holds a claim it will not release', () => {
  const fs = require('fs');
  const ROUTER = path.resolve(ROOT, 'lambda/src/router-agent-handler.ts');
  const LOCK = path.resolve(ROOT, 'lambda/src/lib/turn-lock.ts');

  it('releases the notice claim when nothing was posted', () => {
    const lock: string = fs.readFileSync(LOCK, 'utf8');
    const router: string = fs.readFileSync(ROUTER, 'utf8');
    expect(lock).toContain('export async function releaseNoticeClaim');
    // Only when THIS turn claimed it: mayPost is also true when a notice already exists, and that
    // id belongs to another turn.
    expect(router).toContain('if (mayPost && !noticeId && !queued.noticeId) {');
  });

  it('does not read a triage turn as somebody changing the subject', () => {
    // Drift RETURNS before the claim and the dispatch, so a triage turn that tripped it left the
    // reading undelivered, the queue uncleared, and the triage claim held for a drain that would
    // never happen - while the person watched their messages sit there as waiting.
    const router: string = fs.readFileSync(ROUTER, 'utf8');
    expect(router).toContain(
      // WIDENED to every machine-written turn, not only triage. A stop evaluation has the same shape -
      // a machine-written `userMessage` with a real person as sender - and was excluded from nothing,
      // so it hit drift the same way. The rule this pins is unchanged: a turn the assistant wrote to
      // itself is never somebody changing the subject.
      'const driftResponse = isMachineWrittenTurn(event) || isAmendmentFold(event) || battleCtx || willRefuse ? null : await runLiveDriftFlow({',
    );
  });
});
