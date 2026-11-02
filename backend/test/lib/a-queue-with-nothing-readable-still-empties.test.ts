/**
 * INVARIANT B (ADR-033): every message that enters the queue leaves it.
 *
 * A queue whose messages were ALL redacted, or contained nothing but control markers, produced a
 * reading with no messages in it. Both readers returned at that point, and `clearQueue` runs only
 * inside a triage turn - so nothing ever cleared them. The person was shown "1 message waiting"
 * indefinitely, for a message with no content left to read, and every later notice re-entered triage
 * to produce nothing again.
 *
 * `emptiedIds` exists precisely to account for those. It could not reach the dispatch, because there
 * was nothing to dispatch.
 */
const path = require('path');

const readTurnState = jest.fn();
const releaseLock = jest.fn();
const claimTriage = jest.fn();
const releaseTriage = jest.fn();
const handOverLock = jest.fn();
const clearQueue = jest.fn();
// See the note in `a-question-outstanding-does-not-hold-the-conversation`: the handover returns
// unfolded amendments to the queue before reading it, so the mock must carry it. Empty by default,
// because these tests are about a queue with nothing READABLE, not about amendments.
const returnAmendmentsToQueue = jest.fn().mockResolvedValue([]);
const settleQueueNotice = jest.fn();
const dispatchTriageTurn = jest.fn();
const triageQueuedMessages = jest.fn();

jest.mock('../../lambda/src/lib/turn-lock', () => ({
  readTurnState: (...a: unknown[]) => readTurnState(...a),
  releaseLock: (...a: unknown[]) => releaseLock(...a),
  claimTriage: (...a: unknown[]) => claimTriage(...a),
  releaseTriage: (...a: unknown[]) => releaseTriage(...a),
  handOverLock: (...a: unknown[]) => handOverLock(...a),
  clearQueue: (...a: unknown[]) => clearQueue(...a),
  returnAmendmentsToQueue: (...a: unknown[]) => returnAmendmentsToQueue(...a),
}));
jest.mock('../../lambda/src/lib/turn-queue-notice', () => ({
  settleQueueNotice: (...a: unknown[]) => settleQueueNotice(...a),
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
  correlationId: 'the-turn',
  classification: 'premium',
};

describe('a queue with nothing readable in it still empties', () => {
  let handOver: any;

  beforeAll(() => {
    handOver = require('../../lambda/src/lib/turn-handover').handOverToFollowUpTriage;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    releaseLock.mockResolvedValue(undefined);
    releaseTriage.mockResolvedValue(undefined);
    handOverLock.mockResolvedValue(true);
    claimTriage.mockResolvedValue(true);
    clearQueue.mockResolvedValue(true);
    settleQueueNotice.mockResolvedValue(undefined);
    dispatchTriageTurn.mockResolvedValue(true);
  });

  it('clears the accounted ids and starts no turn to discover there is nothing to read', async () => {
    readTurnState.mockResolvedValue({
      busy: true,
      queued: [{ messageId: 'redacted-1', senderId: 'ada', content: '' }],
      noticeId: 'notice-1',
    });
    triageQueuedMessages.mockResolvedValue({
      messages: [], emptiedIds: ['redacted-1'], visibility: 'room',
    });

    await handOver(ARGS);

    expect(clearQueue).toHaveBeenCalledWith(
      expect.objectContaining({ triagedIds: ['redacted-1'] }),
    );
    // No model turn: there is nothing for one to read, and spending a turn to find that out is the
    // cost this avoids.
    expect(dispatchTriageTurn).not.toHaveBeenCalled();
  });

  it('stops the notice claiming somebody is waiting', async () => {
    // THE RECORD AS IT IS AFTER THE CLEAR, not as it was before (code review, 2026-09-04).
    //
    // Settling is a CLAIM that the queue was handled, so it is made from a RE-READ that follows the
    // clear rather than from the subset this pass accounted for. A single `mockResolvedValue` answers
    // both reads with the pre-clear queue, which is a state that cannot occur: the clear it asserts
    // happened is between them.
    readTurnState
      .mockResolvedValueOnce({
        busy: true,
        queued: [{ messageId: 'redacted-1', senderId: 'ada', content: '' }],
        noticeId: 'notice-1',
      })
      .mockResolvedValue({ busy: false, queued: [], noticeId: 'notice-1' });
    triageQueuedMessages.mockResolvedValue({
      messages: [], emptiedIds: ['redacted-1'], visibility: 'room',
    });

    await handOver(ARGS);

    // triaged: 0 is the case settleQueueNotice already names - emptied without producing anything.
    expect(settleQueueNotice).toHaveBeenCalledWith(
      expect.objectContaining({ noticeId: 'notice-1', triaged: 0 }),
    );
  });

  it('does NOT settle when a message is still waiting after the clear', async () => {
    // The other half, and the reason the re-read exists. A queue is accounted for in passes, so a
    // pass that emptied everything IT read can still leave messages behind - one that arrived while
    // this pass ran, or one a further pass owns. Settling from the subset told the person the
    // assistant had caught up, cleared the waiting styling, and closed the drain, while a message
    // they sent sat unread with nothing coming for it.
    readTurnState
      .mockResolvedValueOnce({
        busy: true,
        queued: [{ messageId: 'redacted-1', senderId: 'ada', content: '' }],
        noticeId: 'notice-1',
      })
      .mockResolvedValue({
        busy: true,
        queued: [{ messageId: 'arrived-late', senderId: 'ada', content: 'and one more thing' }],
        noticeId: 'notice-1',
      });
    triageQueuedMessages.mockResolvedValue({
      messages: [], emptiedIds: ['redacted-1'], visibility: 'room',
    });

    await handOver(ARGS);

    expect(settleQueueNotice).not.toHaveBeenCalled();
  });

  it('does NOT settle when the record cannot be read at all', async () => {
    // Unreadable is not empty. A failed re-read assumes something waits, because a late settle costs
    // a stale notice and a false one costs a lost message.
    //
    // ASSERTED ON THE FLAG, NOT A REJECTION. `readTurnState` catches its own failure and returns
    // `unreadable: true`; it never rejects. A test that made the mock throw was exercising a path the
    // real function cannot take, which is how the dead `.catch` in the code under it survived.
    readTurnState
      .mockResolvedValueOnce({
        busy: true,
        queued: [{ messageId: 'redacted-1', senderId: 'ada', content: '' }],
        noticeId: 'notice-1',
      })
      .mockResolvedValue({ busy: true, queued: [], noticeId: 'notice-1', unreadable: true });
    triageQueuedMessages.mockResolvedValue({
      messages: [], emptiedIds: ['redacted-1'], visibility: 'room',
    });

    await handOver(ARGS);

    expect(settleQueueNotice).not.toHaveBeenCalled();
  });

  it('clears under the claim it took, and settles nothing once displaced (queue review, 2026-09-12)', async () => {
    // `triage-on-arrival` passed its claim here and this path did not, so a reading displaced as stale
    // could strip `noticeId` and `drainTaskId` from the reading that displaced it. A refused clear
    // means the notice and the drain are that successor's to end, even though the re-read is empty.
    readTurnState
      .mockResolvedValueOnce({
        busy: true,
        queued: [{ messageId: 'redacted-1', senderId: 'ada', content: '' }],
        noticeId: 'notice-1',
        drainTaskId: 'drain-1',
      })
      .mockResolvedValue({ busy: false, queued: [], noticeId: 'notice-1' });
    triageQueuedMessages.mockResolvedValue({
      messages: [], emptiedIds: ['redacted-1'], visibility: 'room',
    });
    clearQueue.mockResolvedValue(false);

    await handOver(ARGS);

    const claim = claimTriage.mock.calls[0][0].by;
    expect(clearQueue).toHaveBeenCalledWith(expect.objectContaining({ claimedBy: claim }));
    expect(settleQueueNotice).not.toHaveBeenCalled();
  });

  it('leaves a queue alone when there was nothing to account for', async () => {
    // Not the same case: no reading and no emptied ids means the channel could not be read, and
    // clearing would lose the messages outright. That queue is for the next notice.
    readTurnState.mockResolvedValue({
      busy: true,
      queued: [{ messageId: 'm1', senderId: 'ada', content: 'still here' }],
      noticeId: 'notice-1',
    });
    triageQueuedMessages.mockResolvedValue({ messages: [], emptiedIds: [], visibility: 'room' });

    await handOver(ARGS);

    expect(clearQueue).not.toHaveBeenCalled();
  });
});

describe('the stage a drain was showing does not outlive the clear', () => {
  const fs = require('fs');
  const ROOT = path.resolve(__dirname, '../..');

  it('advances to clearing only when the clear will follow', () => {
    // It ran above the branch, and only clearQueue removes queueStatus - so a channel that could not
    // be read left the stage on 'clearing' permanently, and every later drain failed its first
    // advance because 'reviewing' is legal only from waiting-or-absent.
    const src: string = fs.readFileSync(
      path.resolve(ROOT, 'lambda/src/lib/async-processor-core.ts'), 'utf8',
    );
    const branch = src.indexOf('    if (proposal) {');
    const stage = src.indexOf("await showStage('clearing');");
    expect(branch).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(branch);
  });
});
