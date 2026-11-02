/**
 * WHAT A FINISHED DRAIN MUST NOT LEAVE ON THE RECORD.
 *
 * Three separate defects with one shape: the drain wrote something that outlived it. None was
 * survivable once the record's expiry was removed, because the expiry had been quietly cleaning up
 * after all of them.
 *
 *  - `queueStatus` was never removed, so the stage machine worked once per conversation and was
 *    inert forever after. The next drain's first advance is legal only from waiting-or-absent.
 *  - a split answer whose every subject failed to create left the offer standing, and the offer IS
 *    `awaitingPerson` - which no takeover frees, so the room was locked out permanently by our own
 *    failure rather than the person's.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/abuse-controls', () => ({ readPlaceholderMapping: jest.fn() }));

process.env.TURN_STATE_TABLE = 'test-table';
process.env.TURN_QUEUE_ENABLED = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'assistant-premium';

const updateInput = () =>
  mockSend.mock.calls.map((c) => c[0]).find((c) => c.__t === 'Update')?.input;

beforeEach(() => mockSend.mockReset());

describe('the stage a drain was showing does not outlive it', () => {
  it('clears queueStatus when the queue empties', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1'] } })
      .mockResolvedValueOnce({});

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });

    // Absent is the machine's START. Leaving 'clearing' behind makes the next drain's first advance
    // illegal, and every stage after it unreachable - progress that works exactly once.
    expect(updateInput().UpdateExpression).toContain('queueStatus');
  });

  it('clears queueStatus even when part of the queue still waits', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1', 'm2'] } })
      .mockResolvedValueOnce({});

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });

    const input = updateInput();
    expect(input.UpdateExpression).toContain('queueStatus');
    expect(input.ExpressionAttributeValues[':remainder']).toEqual(['m2']);
  });
});


describe('an answered offer is cleared however it turned out', () => {
  const SPLIT = path.resolve(ROOT, 'lambda/src/conversation-split.ts');

  it('does not make clearing conditional on the split having succeeded', () => {
    const src: string = fs.readFileSync(SPLIT, 'utf8');
    // The condition that was here - created.length || !refused.length - left `awaitingPerson` set
    // when every chosen subject failed, and nothing takes a lock from a holder that is waiting on
    // somebody. The person answered; that is what the record was waiting for.
    expect(src).not.toMatch(/if \(created\.length \|\| !refused\.length\)/);
    // The call is multi-line now: it also names the SPEAKER, so one person's answer settles their own
    // subjects and leaves anybody else's offer standing (ADR-033). The rule pinned here is unchanged -
    // the clear is unconditional on the split having succeeded.
    expect(src).toMatch(/await clearPendingSplit\(\{\s+channelArn: req\.channelArn/);
  });
});

/**
 * THE NOTICE MUST NOT CLAIM THE QUEUE WAS HANDLED WHILE PART OF IT WAITS.
 *
 * This is the defect the person actually reported, and it outlived a day of work on the machinery
 * around it. A drain that read two of three messages settled the notice anyway, so they were told
 * their queue was done while the third sat in `queued` - still rendered as waiting by the client,
 * because it still WAS waiting.
 *
 * What they saw: a settled notice, a message visibly waiting forever, and an assistant that looked
 * idle. The two halves of the interface contradicting each other, and the honest half - the waiting
 * styling - the one that never resolved. Recovery needed them to speak again, which nothing told them.
 *
 * Separate from whatever fails to come back for the remainder: claiming completion before it has is a
 * lie the interface tells on its own, and fixing the reading would not have fixed this.
 */
describe('a settled notice means the queue was handled', () => {
  const CORE = path.resolve(ROOT, 'lambda/src/lib/async-processor-core.ts');

  it('does not settle while something is still queued', () => {
    const src: string = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('if (noticeBeforeClear && !stillWaiting && !answerStillComing) {');
  });

  it('reads what is left AFTER the clear, not what it set out to read', () => {
    // `event.triage.ids` is what this turn was given; the remainder is whatever the clear could not
    // take. Only the record knows the second one.
    const src: string = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('await readTurnState({ channelArn: event.channelArn, responderId })');
  });

  it('and an unreadable record counts as still waiting, not as settled', () => {
    // The read can FAIL, and `readTurnState` returns `unreadable` for exactly that case. Collapsing it
    // to a length with a catch to zero made a throttle settle the notice and close the drain over a
    // queue that still had messages in it - and closing the drain removes the thing that would have
    // come back for them.
    const src: string = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('queueNow.unreadable ? 1 : queueNow.queued.length');
  });

  it('says so, because a queue left behind was untraceable', () => {
    const src: string = fs.readFileSync(CORE, 'utf8');
    expect(src).toContain('part of the queue was not read; the notice is NOT settled');
  });

  it('and the handover no longer exits in silence', () => {
    // "the queue was empty" and "the handover never ran" were indistinguishable, which cost several
    // rounds of guessing.
    const src: string = fs.readFileSync(path.resolve(ROOT, 'lambda/src/lib/turn-handover.ts'), 'utf8');
    expect(src).toContain('nothing queued behind this turn; releasing normally');
  });
});

/**
 * NO EXIT FROM THE HANDOVER IS SILENT.
 *
 * It is the last thing that can stop a queued message waiting forever, and it had TWO paths that said
 * nothing: a missing-argument guard, and a `.catch(() => false)` at the call site that swallowed a
 * throw whole. So "the handover declined", "the handover was never reached" and "the handover
 * exploded" were one observation, and the queue looked identical in all three.
 *
 * That ambiguity is the reason the remainder defect stayed open through several rounds of guessing:
 * absence of a log was read as absence of a call.
 */
describe('the handover always says what it did', () => {
  const HANDOVER = path.resolve(ROOT, 'lambda/src/lib/turn-handover.ts');
  const PROCESSOR = path.resolve(ROOT, 'lambda/src/assistant-async-processor.ts');

  it('logs the missing-argument exit', () => {
    expect(fs.readFileSync(HANDOVER, 'utf8'))
      .toContain('cannot look for a queue without the turn it followed');
  });

  it('logs a throw instead of swallowing it', () => {
    // The processor's exit settles the lock through `settleTurnLockAtExit`, so the handover call and
    // its catch live in turn-handover.ts now. Neither file may swallow the throw silently.
    const handover: string = fs.readFileSync(HANDOVER, 'utf8');
    expect(handover).toContain('the follow-up handover threw; the queue may be left unread');
    expect(handover).not.toContain('}).catch(() => false);');
    expect(fs.readFileSync(PROCESSOR, 'utf8')).toContain('await settleTurnLockAtExit({');
  });

  it('no longer claims a TTL recovers a stranded lock', () => {
    // The turn-state record has no expiry since 2026-08-29. A comment naming a recovery that does not
    // exist is how the next reader stops looking for a real one.
    const src: string = fs.readFileSync(PROCESSOR, 'utf8');
    expect(src).not.toMatch(/recovered by the table's TTL, and a turn the platform kills/);
  });
});

describe('the clear is conditional on the DRAIN claim, not on the turn lock', () => {
  /**
   * THE DOC SAID "conditional on still holding the lock" AND THAT WAS NEVER WHAT IT CHECKED - nor what
   * it could check. A reading runs BESIDE the answer and deliberately does not claim the turn, so a
   * lock condition here would fail on every drain there has ever been.
   *
   * What was missing is the DRAIN claim. `claimTriage` writes `triagedBy`, and without conditioning on
   * it a reading displaced as stale could return and remove `noticeId` and `drainTaskId` out from
   * under the reading that displaced it: the notice pointer is lost so the next notice posts fresh
   * instead of updating in place, and the drain row is left pending with nothing to close it.
   */
  it('requires the claimant to still hold the drain when clearing the whole queue', async () => {
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1'], triagedBy: 'reader-1' } })
      .mockResolvedValueOnce({});

    await lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'], claimedBy: 'reader-1',
    });

    const input = updateInput();
    expect(input.ConditionExpression).toContain('triagedBy = :claimant');
    expect(input.ExpressionAttributeValues[':claimant']).toBe('reader-1');
  });

  it('keeps the compare-and-swap on the queue contents as well', async () => {
    // The two guard different things: this one keeps a message that arrived since this reading read
    // from being cleared without ever being triaged.
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1'], triagedBy: 'reader-1' } })
      .mockResolvedValueOnce({});

    await lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'], claimedBy: 'reader-1',
    });

    expect(updateInput().ConditionExpression).toContain('queued = :current');
  });

  it('still clears for a caller that names no claimant, rather than silently failing', async () => {
    // Non-vacuity, and the compatibility rule: a caller not yet taught to pass the claim gets the
    // weaker of the two guards. Making the claim mandatory would have turned an unconverted caller
    // into a queue that never clears, which is the failure this whole file is about.
    mockSend
      .mockResolvedValueOnce({ Item: { queued: ['m1'] } })
      .mockResolvedValueOnce({});

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });

    const input = updateInput();
    expect(input.ConditionExpression).toBe('queued = :current');
    expect(input.ExpressionAttributeValues[':claimant']).toBeUndefined();
  });

  it('writes nothing, and says displaced, when the record already names another reader', async () => {
    // Every write would be refused on `triagedBy = :claimant` however often it re-read, so the three
    // attempts ended in "gave up clearing the queue" for what is the designed outcome. And the caller
    // must be told false, so it does not settle a notice and a drain that belong to its successor.
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1'], triagedBy: 'reader-2', noticeId: 'n1', drainTaskId: 'd1' } });

    await expect(lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'], claimedBy: 'reader-1',
    })).resolves.toBe(false);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('a notice that holds the answer stops being the notice', () => {
  it('removes the pointer only while it still names that message, whatever is queued', async () => {
    mockSend.mockResolvedValueOnce({});
    const forgot = await lock.forgetNoticeHoldingAnswer({ channelArn: CHANNEL, responderId: BOT, noticeId: 'ph-1' });
    expect(forgot).toBe(true);
    const input = updateInput();
    expect(input.UpdateExpression).toBe('REMOVE noticeId');
    // No empty-queue condition: the messages still queued get a fresh notice of their own.
    expect(input.ConditionExpression).toBe('noticeId = :n');
    expect(input.ExpressionAttributeValues).toEqual({ ':n': 'ph-1' });
  });

  it('leaves a pointer that already moved on alone', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('moved'), { name: 'ConditionalCheckFailedException' }));
    await expect(lock.forgetNoticeHoldingAnswer({ channelArn: CHANNEL, responderId: BOT, noticeId: 'ph-1' })).resolves.toBe(false);
  });
});
