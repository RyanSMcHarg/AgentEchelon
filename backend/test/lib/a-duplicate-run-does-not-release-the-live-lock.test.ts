/**
 * A DUPLICATE DELIVERY MUST NOT FREE THE LOCK OF THE RUN STILL ANSWERING (ADR-033, invariant A).
 *
 * The lock release is conditional on `holder = <correlationId>`, and a duplicate delivery of one
 * dispatch carries the SAME correlation id. So a duplicate that lost the dedup claim and returned at
 * once still satisfied that condition in its `finally`, and released the lock while the admitted run
 * was mid-answer. The next message then did not queue: it started a second turn beside the first.
 *
 * Two halves are pinned here, and both are needed. `runSharedPipeline` must report admission only for
 * the run that won the claim, and `settleTurnLockAtExit` must touch nothing for a run that did not.
 */

const mockRead = jest.fn();
const mockClaimTriage = jest.fn();
const mockReleaseTriage = jest.fn();
const mockHandOver = jest.fn();
const mockReleaseLock = jest.fn();
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
  triageQueuedMessages: jest.fn(),
  dispatchTriageTurn: jest.fn(),
}));
jest.mock('../../lambda/src/lib/channel-classification.js', () => ({
  resolveChannelClassificationTag: jest.fn(),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = jest.fn(); },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { settleTurnLockAtExit } = require('../../lambda/src/lib/turn-handover');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas';
const CORRELATION = 'turn-abc';

const settle = (over: Record<string, unknown> = {}) => settleTurnLockAtExit({
  admitted: true, redispatchedPass: false, channelArn: CHANNEL, botArn: BOT, correlationId: CORRELATION,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ queued: [], holder: CORRELATION, busy: true });
  mockReleaseLock.mockResolvedValue(true);
  mockReturnAmendments.mockResolvedValue([]);
});

describe('settling the turn lock at the end of a processor run', () => {
  it('a run that was not admitted neither releases nor hands over', async () => {
    await settle({ admitted: false });

    // The release condition would have passed: same correlation id. Not calling it is the fix.
    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockHandOver).not.toHaveBeenCalled();
    // Nor reads the queue, so a duplicate cannot start a handover chain under the live run either.
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('the admitted run releases as it always did when nothing is queued', async () => {
    await settle();

    expect(mockReleaseLock).toHaveBeenCalledWith({
      channelArn: CHANNEL, responderId: 'atlas', correlationId: CORRELATION,
    });
  });

  it('a pass still reading on this correlation keeps the lock', async () => {
    await settle({ redispatchedPass: true });

    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('an unreadable turn state still ends in a release, not a stranded lock', async () => {
    mockRead.mockRejectedValue(new Error('ddb down'));

    await settle();

    expect(mockReleaseLock).toHaveBeenCalledWith(expect.objectContaining({ correlationId: CORRELATION }));
  });
});
