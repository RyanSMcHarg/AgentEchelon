/**
 * ONE TURN AT A TIME (ADR-033), and the failure modes that matter more than the feature.
 *
 * The bar this is judged on is NOT "does it stop a duplicate turn". It is "does a conversation whose
 * worker died still answer the next message". A build that stops duplicates and strands one
 * conversation has made things worse: a duplicate answer is recoverable by the person, and silence is
 * not. So the release-by-fact and fail-open cases come first here, and the feature itself after.
 */

const mockSend = jest.fn();
const mockReadPlaceholderMapping = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/abuse-controls', () => ({
  readPlaceholderMapping: (...a: unknown[]) => mockReadPlaceholderMapping(...a),
}));

// Env must be set BEFORE the module is imported: both the table and the kill switch are read into
// module-level consts, which is what makes the switch a deploy-time decision rather than a per-call one.
process.env.TURN_STATE_TABLE = 'test-table';
process.env.TURN_QUEUE_ENABLED = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'assistant-premium';
const conditionalFailure = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
// Older than any turn can possibly be, and comfortably inside one. The bound is the processor's own
// Lambda timeout, so these are "impossible" and "ordinary" rather than two tuned numbers.
const LONG_DEAD = () => Date.now() - 10 * 60_000;
const JUST_STARTED = () => Date.now() - 2_000;

beforeEach(() => {
  mockSend.mockReset();
  mockReadPlaceholderMapping.mockReset();
  mockReadPlaceholderMapping.mockResolvedValue(null);
});

describe('a held lock means BUSY, and nothing here second-guesses it', () => {
  it('does NOT take over a holder that is still running', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. This used to assert against a mocked
    // `readPlaceholderMapping` returning null, which never happens for a running turn: the channel
    // flow writes that record when the PLACEHOLDER appears, seconds in. So the test passed while
    // production judged every live holder dead, displaced it, and queued nothing.
    mockSend
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { holder: 'corr-live', holderAt: JUST_STARTED() } });

    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-new' });

    expect(r.claimed).toBe(false);
    expect(r.heldBy).toBe('corr-live');
  });

  it('reports BUSY however long the holder has held it, and never displaces on age', async () => {
    // The tempting repair for the bug above is a bound: past some age, call the holder dead. That is
    // a clock, and it only moves the guess - too short answers a slow turn twice, too long strands
    // the conversation. A holder that has held for ten minutes is still reported as the holder here;
    // recovering it belongs to the failure destination, which is TOLD the invocation died.
    mockSend
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { holder: 'corr-ancient', holderAt: LONG_DEAD() } });

    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-new' });

    expect(r.claimed).toBe(false);
    expect(r.heldBy).toBe('corr-ancient');
    // Two writes would mean it displaced the holder: the failed claim, and nothing else.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('claims when the record names no holder', async () => {
    mockSend
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: {} });

    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-new' });

    expect(r.claimed).toBe(true);
  });
});
describe('it fails OPEN, so an outage never silences a conversation', () => {
  it('answers when the claim write errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB is having a day'));
    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'c' });
    expect(r.claimed).toBe(true);
  });

  it('answers when the holder read errors', async () => {
    mockSend
      .mockRejectedValueOnce(conditionalFailure())
      .mockRejectedValueOnce(new Error('read failed'));
    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'c' });
    expect(r.claimed).toBe(true);
  });

  it('answers when the record names no holder at all', async () => {
    mockSend
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: {} });
    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'c' });
    expect(r.claimed).toBe(true);
  });
});

describe('the record is read as the authority it claims to be', () => {
  it('reads the state STRONGLY CONSISTENT, because callers read it right after it changes', async () => {
    // The deferral notice is posted immediately after the enqueue and the client re-reads the moment
    // it sees that notice. An eventually consistent read can answer with the item as it was BEFORE
    // the enqueue: the client is told the queue is empty and, with one queued message, the notice
    // never changes again, so it never re-reads and the waiting message is never marked.
    mockSend.mockResolvedValueOnce({ Item: { holder: 'corr-live', queued: ['m1'] } });

    await lock.readTurnState({ channelArn: CHANNEL, responderId: BOT });

    const sent = mockSend.mock.calls[0][0];
    expect(sent.input.ConsistentRead).toBe(true);
  });
});

describe('the claim', () => {
  it('is granted when nothing holds the conversation', async () => {
    mockSend.mockResolvedValueOnce({});
    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'c' });
    expect(r.claimed).toBe(true);
    // One write on the common path. A second round trip here would be paid by every turn in the
    // deployment, on the hop the latency budget is tightest.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('is granted to a REDELIVERY of the turn that already holds it', async () => {
    // The condition admits `holder = :me`, so an at-least-once redelivery is not told it is queued
    // behind itself - which would deadlock the turn against its own claim.
    mockSend.mockResolvedValueOnce({});
    const r = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'corr-same' });
    expect(r.claimed).toBe(true);
    const cond = mockSend.mock.calls[0][0].input.ConditionExpression;
    expect(cond).toContain('attribute_not_exists(holder)');
    expect(cond).toContain('holder = :me');
  });
});

describe('the lock and the queue are released SEPARATELY', () => {
  // An earlier version did both in one write, arguing they were one fact. Freeing the lock when a
  // turn returns opens the conversation to a message that starts running ALONGSIDE the follow-up work
  // - the exact concurrency the lock exists to prevent, arriving through the mechanism meant to
  // prevent it. So: peek, triage, clear, release.

  it('peeks the queue without taking it, so a failed triage can be retried', async () => {
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1', 'm2'] } });
    const q = await lock.peekQueue({ channelArn: CHANNEL, responderId: BOT });
    expect(q).toEqual(['m1', 'm2']);
    // A READ. Taking the queue first and dying before the tasks exist would lose the messages.
    expect(mockSend.mock.calls[0][0].__t).toBe('Get');
  });

  it('clears the queue WITHOUT releasing the lock', async () => {
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1'] } }); // the read
    mockSend.mockResolvedValueOnce({}); // the write
    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });
    const expr = mockSend.mock.calls[1][0].input.UpdateExpression;
    expect(expr).toContain('queued');
    expect(expr).not.toContain('holder');
  });

  it('removes only what was triaged, and keeps what arrived during the reading', async () => {
    // The reading is a SUBSET of the queue by construction: a message that could not be read is
    // skipped, and one whose content is empty after markers are stripped is skipped as
    // accounted-for. A clear that demanded the whole list match would never fire, so the queue
    // would never empty and every later notice would re-triage the same messages.
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1', 'm2', 'm3'] } });
    mockSend.mockResolvedValueOnce({});

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1', 'm3'] });

    const input = mockSend.mock.calls[1][0].input;
    // m2 survives: it was never triaged, so the next notice reads it rather than losing it.
    expect(input.ExpressionAttributeValues[':remainder']).toEqual(['m2']);
    // Compare and swap: a message enqueued between the read and the write cannot be dropped.
    expect(input.ConditionExpression).toBe('queued = :current');
    expect(input.ExpressionAttributeValues[':current']).toEqual(['m1', 'm2', 'm3']);
    // The notice stays while something is still waiting - it is still true.
    expect(input.UpdateExpression).not.toContain('noticeId');
  });

  it('takes the notice with it only when nothing is left waiting', async () => {
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1'] } });
    mockSend.mockResolvedValueOnce({});

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });

    expect(mockSend.mock.calls[1][0].input.UpdateExpression).toContain('noticeId');
  });

  it('does nothing when the record holds no queue', async () => {
    mockSend.mockResolvedValueOnce({ Item: {} });

    await expect(lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] }))
      .resolves.toBe(true);
    // Read only: nothing to write, and a write here would create a row describing nothing.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('never depends on holding the lock, which its only caller never does', async () => {
    // THE DEFECT THIS PINS. The clear used to require `holder = :me`, and the only caller is the
    // triage turn, which deliberately never claims the lock. Every clear failed its condition, the
    // failure was swallowed as ordinary, and the queue could not be drained at all: measured live,
    // the record still held the message minutes after triage had created work for it.
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1'] } });
    mockSend.mockResolvedValueOnce({});

    await lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] });

    expect(JSON.stringify(mockSend.mock.calls[1][0].input)).not.toContain('holder');
  });

  it('re-reads and clears again when the queue moved under the write', async () => {
    // ── THE DEFECT THIS PINS (code review, 2026-09-09) ─────────────────────────────────────────
    //
    // The compare-and-swap had no retry, unlike `returnAmendmentsToQueue` which loops three times on
    // the identical failure. A message arriving between the consistent read and the conditional
    // update refused the write and NOTHING was removed - including the ids this reading had just
    // turned into tasks - so the next drain re-triaged an already-triaged queue: duplicate tasks,
    // and the person told a second time what was understood.
    //
    // A refusal here is not an error, it is the queue having moved, which is ordinary and is the
    // whole reason the read is consistent and the write conditional. The answer is to re-read.
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1'] } });      // read
    mockSend.mockRejectedValueOnce(conditionalFailure());              // the queue moved
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1', 'm2'] } }); // read again, as it is now
    mockSend.mockResolvedValueOnce({});                                // and the write lands

    await expect(
      lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] }),
    ).resolves.toBe(true);

    // The second write is computed from what the record said on the SECOND read: m2 arrived while
    // this was working and survives into the remainder rather than being clobbered or dropped.
    const input = mockSend.mock.calls[3][0].input;
    expect(input.ExpressionAttributeValues[':remainder']).toEqual(['m2']);
    expect(input.ExpressionAttributeValues[':current']).toEqual(['m1', 'm2']);
  });

  it('reports failure only after the queue has moved three times', async () => {
    // Three losses in a row is a queue changing faster than this can read it, which does not happen
    // on a real conversation. It reports failure rather than looping, and says so loudly, because
    // what is left behind is a triaged queue the next reading will read again.
    for (let i = 0; i < 3; i++) {
      mockSend.mockResolvedValueOnce({ Item: { queued: ['m1'] } });
      mockSend.mockRejectedValueOnce(conditionalFailure());
    }

    await expect(
      lock.clearQueue({ channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'] }),
    ).resolves.toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(6);
  });
  it('guards the amendment list it writes, not just the queue', async () => {
    // ── THE DEFECT THIS PINS (code review, 2026-09-09) ─────────────────────────────────────────
    //
    // `returnAmendmentsToQueue` writes BOTH lists in one statement - `SET queued = :q, amendments =
    // :rest`, or `REMOVE amendments` when nothing is left - but conditioned only on `queued`. The
    // reading turn appends to `amendments` concurrently (`recordAmendments`, a `list_append`), so a
    // GET that saw [A] while the reading appended B wrote the remainder of [A] over the top of
    // [A, B], or removed the attribute holding B outright. B was read, classified as amending and
    // described back to the person, and would then be in neither list.
    //
    // `clearAmendments` guards the identical write with `amendments = :current`; the guard was
    // simply absent here.
    mockSend.mockResolvedValueOnce({ Item: { queued: ['q1'], amendments: ['a1'] } });
    mockSend.mockResolvedValueOnce({});

    await lock.returnAmendmentsToQueue({ channelArn: CHANNEL, responderId: BOT });

    const input = mockSend.mock.calls[1][0].input;
    expect(input.ConditionExpression).toContain('queued = :current');
    expect(input.ConditionExpression).toContain('amendments = :currentAmendments');
    expect(input.ExpressionAttributeValues[':currentAmendments']).toEqual(['a1']);
  });

  it('distinguishes an absent amendment list from an empty one', async () => {
    // Absent is a real state and is not the same as empty: a list that never existed must not be
    // matched by a condition written for one that did - the same rule the queue guard beside it
    // already follows.
    mockSend.mockResolvedValueOnce({ Item: { queued: ['q1'] } });

    await lock.returnAmendmentsToQueue({ channelArn: CHANNEL, responderId: BOT });

    // Nothing to return, so nothing is written at all.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('releases the lock WITHOUT clearing the queue', async () => {
    // A queue that survives a release is one the next turn triages, which beats one this turn
    // discarded on its way out.
    mockSend.mockResolvedValueOnce({});
    await lock.releaseLock({ channelArn: CHANNEL, responderId: BOT, correlationId: 'c' });
    const expr = mockSend.mock.calls[0][0].input.UpdateExpression;
    expect(expr).toContain('REMOVE holder');
    expect(expr).not.toContain('queued');
  });

  it('does not release when this turn is not the holder', async () => {
    // A turn displaced as dead must not touch the state of the turn that displaced it. This still
    // holds for the RELEASE, which is done by the turn that claimed; the clear is conditional on the
    // queue it read instead, because the turn that clears never held the lock.
    mockSend.mockRejectedValueOnce(conditionalFailure());
    await expect(lock.releaseLock({ channelArn: CHANNEL, responderId: BOT, correlationId: 'gone' })).resolves.toBe(false);
  });

  it('does not throw when the release write fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('boom'));
    await expect(lock.releaseLock({ channelArn: CHANNEL, responderId: BOT, correlationId: 'c' })).resolves.toBe(false);
  });
});

describe('the lock is HANDED OVER, never released and re-claimed', () => {
  it('moves the holder in one write, so the conversation is never unheld', async () => {
    // Release-then-claim leaves a gap in which an arriving message claims the lock and runs alongside
    // the follow-up work the finishing turn just dispatched.
    mockSend.mockResolvedValueOnce({});
    const ok = await lock.handOverLock({ channelArn: CHANNEL, responderId: BOT, from: 'corr-a', to: 'corr-b' });
    expect(ok).toBe(true);
    const input = mockSend.mock.calls[0][0].input;
    expect(input.ConditionExpression).toBe('holder = :from');
    expect(input.ExpressionAttributeValues[':to']).toBe('corr-b');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('refuses when the outgoing turn no longer holds it', async () => {
    // A turn displaced as dead cannot hand away a lock it does not own.
    mockSend.mockRejectedValueOnce(conditionalFailure());
    await expect(lock.handOverLock({ channelArn: CHANNEL, responderId: BOT, from: 'stale', to: 'corr-b' }))
      .resolves.toBe(false);
  });

  it('reports failure rather than clearing the lock behind the caller', async () => {
    mockSend.mockRejectedValueOnce(new Error('boom'));
    await expect(lock.handOverLock({ channelArn: CHANNEL, responderId: BOT, from: 'a', to: 'b' }))
      .resolves.toBe(false);
  });
});

describe('the queue is bounded, and says so', () => {
  it('reports the depth after each message', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { queued: ['m1', 'm2'] } });
    const r = await lock.enqueueMessage({ channelArn: CHANNEL, responderId: BOT, messageId: 'm2' });
    expect(r).toMatchObject({ depth: 2, overflowed: false });
  });

  it('drops the OLDEST on overflow, not the newest', async () => {
    // The newest is the person's latest intent and the one most likely to supersede the rest.
    const over = Array.from({ length: lock.TURN_QUEUE_MAX + 1 }, (_, i) => `m${i}`);
    mockSend
      .mockResolvedValueOnce({ Attributes: { queued: over } })
      .mockResolvedValueOnce({});
    const r = await lock.enqueueMessage({ channelArn: CHANNEL, responderId: BOT, messageId: 'last' });

    expect(r.overflowed).toBe(true);
    expect(r.depth).toBe(lock.TURN_QUEUE_MAX);
    const trimmed = mockSend.mock.calls[1][0].input.ExpressionAttributeValues[':q'];
    expect(trimmed[trimmed.length - 1]).toBe(over[over.length - 1]); // newest kept
    expect(trimmed).not.toContain(over[0]);                          // oldest dropped
  });

  it('reports the REAL depth when the trim was refused, not the one it computed', async () => {
    // A refused trim is the CORRECT outcome - the queue moved, so nothing was dropped - and
    // `overflowed` was already taught that. `depth` was not: it reported the length this invocation
    // COMPUTED rather than what the record still holds, so the notice told the person five were
    // waiting while six were, and `recordQueued` - the metric that judges this very bound -
    // under-reported at exactly the bound it watches.
    const over = Array.from({ length: lock.TURN_QUEUE_MAX + 1 }, (_, i) => `m${i}`);
    mockSend
      .mockResolvedValueOnce({ Attributes: { queued: over } })
      // The conditional write refuses: somebody enqueued between the read and the trim.
      .mockRejectedValueOnce(Object.assign(new Error('conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      }));

    const r = await lock.enqueueMessage({ channelArn: CHANNEL, responderId: BOT, messageId: 'last' });

    // Nothing was dropped, so nothing may be reported as dropped.
    expect(r.overflowed).toBe(false);
    // And the queue still holds everything the trim would have removed.
    expect(r.depth).toBe(over.length);
  });

  it('SAYS the enqueue failed, because the caller has already promised a queue', async () => {
    // This asserted `{depth: 0, overflowed: false}` under the belief that depth 0 tells the caller to
    // treat the message as an ordinary turn. That belief was false, and the test was pinning it: by
    // the time this runs, the only caller is inside the `!claimed` branch, has already posted "I am
    // holding this" and is about to return silently. A depth of 0 there is indistinguishable from an
    // empty queue, so the message was lost outright - never in `queued`, no drain to read it - after
    // the person was told in the conversation that it was waiting.
    //
    // `failed` is what lets the caller correct that promise instead of going quiet.
    mockSend.mockRejectedValueOnce(new Error('nope'));
    const r = await lock.enqueueMessage({ channelArn: CHANNEL, responderId: BOT, messageId: 'm' });
    expect(r).toEqual({ depth: 0, overflowed: false, failed: true });
  });

  it('does not report a drop when the overflow trim was refused', async () => {
    // The trim is conditional, so it can legitimately refuse when the queue moved underneath - and a
    // refusal means nothing was dropped. Reporting `overflowed` regardless told the person "I had to
    // drop the oldest one that was waiting - please send it again" about a message still in the queue,
    // and counted a data loss that never happened against the metric that judges this bound.
    const over = Array.from({ length: lock.TURN_QUEUE_MAX + 1 }, (_, i) => `m${i}`);
    mockSend.mockReset();
    // The enqueue write returns an over-long queue, and the trim that follows is refused.
    mockSend.mockResolvedValueOnce({ Attributes: { queued: over } });
    const refusal: Error & { name: string } = Object.assign(new Error('stale'), {
      name: 'ConditionalCheckFailedException',
    });
    mockSend.mockRejectedValueOnce(refusal);

    const r = await lock.enqueueMessage({ channelArn: CHANNEL, responderId: BOT, messageId: 'm' });
    expect(r.overflowed).toBe(false);
  });
});

describe('the kill switch', () => {
  it('makes every call a no-op that reports NOT BUSY', async () => {
    jest.resetModules();
    process.env.TURN_QUEUE_ENABLED = '0';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const off = require('../../lambda/src/lib/turn-lock');

    expect(off.turnQueueEnabled()).toBe(false);
    await expect(off.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'c' }))
      .resolves.toEqual({ claimed: true });
    await expect(off.readTurnState({ channelArn: CHANNEL, responderId: BOT }))
      .resolves.toEqual({ busy: false, queued: [] });
    // Nothing reached DynamoDB: the switch is off BEFORE the round trip, so a disabled deployment
    // pays nothing for the mechanism.
    expect(mockSend).not.toHaveBeenCalled();

    process.env.TURN_QUEUE_ENABLED = '1';
  });
});

/**
 * THE RECORD HAS NO EXPIRY, AND ARRIVING TRAFFIC WRITES NONE.
 *
 * A stranded lock is recovered by an arriving message taking over a holder whose `holderAt` is past
 * `STALE_AFTER_MS`, counted as `LockTakeover`. An expiry written on enqueue or claim would delete a
 * queue somebody was told was waiting (maintainer, 2026-08-28).
 */
describe('the queue record expires on the turn, not on the traffic', () => {
  it('does not refresh the ttl when a message is queued', async () => {
    mockSend.mockResolvedValue({});

    await lock.enqueueMessage({ channelArn: CHANNEL, responderId: BOT, messageId: 'm1' });

    const update = mockSend.mock.calls[0][0].input.UpdateExpression as string;
    expect(update).toContain('list_append');
    expect(update).not.toContain('ttl');
  });

  it('writes no expiry when the lock is claimed', async () => {
    // The record holds a queue and, once a question has been asked, a person's unanswered turn. An
    // expiry on it deletes work somebody was told was waiting (maintainer, 2026-08-28).
    mockSend.mockReset().mockResolvedValue({});

    await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'turn-1' });

    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression as string).not.toContain('ttl');
    expect(JSON.stringify(input.ExpressionAttributeValues ?? {})).not.toContain('ttl');
  });

  it('takes a lock whose holder is past any possible turn, and counts it', async () => {
    // The recovery for a holder that died is the next message, not a timer. The condition is what
    // expresses that, so it is what this asserts.
    mockSend.mockReset().mockResolvedValue({ Attributes: { holder: 'a-turn-that-died' } });

    const claim = await lock.claimTurn({ channelArn: CHANNEL, responderId: BOT, correlationId: 'turn-2' });

    expect(claim.claimed).toBe(true);
    const cond = mockSend.mock.calls[0][0].input.ConditionExpression as string;
    expect(cond).toContain('holderAt < :stale');
    // AND A WAIT DOES NOT PROTECT IT. This asserted the opposite until 2026-08-31: a drain waiting
    // on a person was treated as progress that had to survive a takeover, so the record carrying an
    // outstanding question was the one record that could never be freed. Waiting holds no lock now
    // (ADR-033), and a stale holder is stale whether or not somebody was asked something.
    expect(cond).not.toContain('attribute_not_exists(awaitingPerson)');
  });

  it('reports that this message is the answer the drain was waiting for', async () => {
    // NOT COSMETIC, and not only a metric. The router routes on this: a person answering the
    // question they were asked must not have their reply absorbed into whatever task was open,
    // which is how an answer to a split offer drew a reply about a different subject entirely.
    // It was computed here and discarded, so the one place that knew told nobody.
    mockSend.mockReset().mockResolvedValue({ Attributes: { holder: 'the-drain', awaitingPerson: 'ada' } });

    const claim = await lock.claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'turn-2', senderId: 'ada',
    });

    expect(claim.answeredTheQuestion).toBe(true);
  });

  it("does not call somebody else's message the answer", async () => {
    // The offer is put to ONE person. Somebody else speaking is an ordinary turn, and treating it
    // as the answer would take a task off the turn that still needed it.
    mockSend.mockReset().mockResolvedValue({ Attributes: { holder: 'the-drain', awaitingPerson: 'ada' } });

    const claim = await lock.claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'turn-2', senderId: 'grace',
    });

    expect(claim.answeredTheQuestion).toBe(false);
  });
});

describe('a notice claimed and not posted is released', () => {
  it('removes the pending marker, and only its own', async () => {
    // Nothing released this claim before, so one failed post left `pending:<corr>` in place for good.
    // readTurnState correctly refuses to report a pending marker as a real notice id, so every later
    // queued message found no notice, lost the claim it tried to take, waited three seconds for an id
    // that could never appear, and returned silence - with no notice in the room either.
    mockSend.mockReset().mockResolvedValue({});

    await lock.releaseNoticeClaim({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'turn-1',
    });

    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('REMOVE noticeId');
    // Conditional, so a notice somebody else has since claimed, or a real id that landed late, stands.
    expect(input.ConditionExpression).toContain('noticeId = :mine');
    expect(input.ExpressionAttributeValues[':mine']).toBe('pending:turn-1');
  });
});

describe('could not look is not nothing is waiting', () => {
  it('marks a failed state read as unreadable', async () => {
    // The read fails open for the lock, which is right: a conversation must not become unanswerable
    // because one GetItem was throttled. It is wrong for a caller that REPORTS the state to a person.
    // The turn-state API has always had a 500 branch for exactly this and it was unreachable, so a
    // throttle answered 200 "nothing is waiting" and the client cleared the styling on messages that
    // were still queued.
    mockSend.mockReset().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

    const state = await lock.readTurnState({ channelArn: CHANNEL, responderId: BOT });

    expect(state.unreadable).toBe(true);
    // Still fail-open in shape, so every lock path behaves exactly as before.
    expect(state.busy).toBe(false);
    expect(state.queued).toEqual([]);
  });

  it('does not mark an ordinary empty state', async () => {
    mockSend.mockReset().mockResolvedValue({});

    const state = await lock.readTurnState({ channelArn: CHANNEL, responderId: BOT });

    expect(state.unreadable).toBeUndefined();
  });
});

/**
 * THE PERSON WHO WAS ASKED MAY SPEAK - BUT NOT OVER A TURN THAT IS RUNNING (code review, 2026-09-04).
 *
 * `awaitingPerson = :sender` stood alone in the claim condition, so it granted the lock against a
 * LIVE holder. Paired with an offer that failed to clear (three paths reach `requestConversationSplit`
 * without the split Lambda running), one person carried a stale `awaitingPerson` and displaced every
 * running turn in that conversation, indefinitely - two assistants answering at once, recorded as
 * answering the question rather than as a takeover, so invisible in the metrics.
 *
 * The pairing is what the clause was always for. A drain that asks a question RELEASES the
 * conversation (ADR-033: waiting on a person is not holding it), so the flow it serves has no holder
 * and loses nothing by requiring none.
 */
describe('being awaited is not a licence to interrupt', () => {
  it('lets the asked person claim when nothing is executing', async () => {
    mockSend.mockResolvedValueOnce({});

    expect((await lock.claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'c1', senderId: 'ana',
    })).claimed).toBe(true);
  });

  it('requires the absence of a holder in the same clause, not merely somewhere in the condition', async () => {
    mockSend.mockResolvedValueOnce({});
    await lock.claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'c1', senderId: 'ana',
    });

    const cond = String(mockSend.mock.calls[0][0].input.ConditionExpression);
    // Parenthesised and ANDed: a bare `awaitingPerson = :sender` ORed into the list is exactly the
    // bug, and reads almost identically.
    expect(cond).toContain('(awaitingPerson = :sender AND attribute_not_exists(holder))');
    expect(cond).not.toMatch(/OR\s+awaitingPerson = :sender\s*(OR|$)/);
  });

  it('still lets a genuinely dead holder be taken over, by the staleness clause', async () => {
    // Removing the displacement must not strand a conversation whose worker died: that is what the
    // TTL-free takeover exists for, and it is a different clause.
    mockSend.mockResolvedValueOnce({});
    await lock.claimTurn({
      channelArn: CHANNEL, responderId: BOT, correlationId: 'c1', senderId: 'ana',
    });

    expect(String(mockSend.mock.calls[0][0].input.ConditionExpression)).toContain('holderAt < :stale');
  });
});

describe('a queue a fold already emptied still ends its drain (live 2026-09-15)', () => {
  it('removes the claim, the stage and the drain even though nothing is queued', async () => {
    // The resumed answer's fold took every queued id first. Returning early here left the reading's
    // claim held, the answering exit skipped settling the notice, and it read "clearing" for good.
    mockSend
      .mockResolvedValueOnce({ Item: { triagedBy: 'arrival-x-1', queueStatus: 'clearing', drainTaskId: 'd1', noticeId: 'n1' } })
      .mockResolvedValueOnce({});
    await expect(lock.clearQueue({
      channelArn: CHANNEL, responderId: BOT, triagedIds: ['m1'], claimedBy: 'arrival-x-1', keepNotice: true,
    })).resolves.toBe(true);
    const write = mockSend.mock.calls[1][0].input;
    expect(write.UpdateExpression).toBe('REMOVE triagedBy, triageAt, queueStatus, drainTaskId');
    expect(write.ConditionExpression).toContain('attribute_not_exists(queued)');
    expect(write.ConditionExpression).toContain('triagedBy = :claimant');
  });
});

describe('one answer to a split offer never restores a subject another answer settled', () => {
  const topic = (id: string, requestorId: string) => ({ id, label: id, private: true, requestorId });

  it('conditions the settlement on the offer it read, and re-settles against what the other answer left', async () => {
    // Ana and Ben both hold a subject. Ben's answer lands between Ana's read and Ana's write. Written
    // unconditionally, Ana's write put Ben's settled subject back, and Ben's spent bypass with it.
    const whole = { topics: [topic('t-ana', 'ana'), topic('t-ben', 'ben')], offeredTo: { ana: true, ben: true } };
    const afterBen = { topics: [topic('t-ana', 'ana')], offeredTo: { ana: true } };
    mockSend
      .mockResolvedValueOnce({ Item: { pendingSplit: whole } })
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { pendingSplit: afterBen } })
      .mockResolvedValueOnce({});

    await lock.clearPendingSplit({ channelArn: CHANNEL, responderId: BOT, speakerId: 'ana' });

    const stale = mockSend.mock.calls[1][0].input;
    expect(stale.ConditionExpression).toBe('pendingSplit = :seen');
    expect(stale.ExpressionAttributeValues[':seen']).toEqual(whole);

    // The retry sees Ben's subject gone and removes only the offer it now read. Nothing re-adds Ben.
    const settled = mockSend.mock.calls[3][0].input;
    expect(settled.UpdateExpression).toBe('REMOVE pendingSplit, awaitingPerson');
    expect(settled.ConditionExpression).toBe('pendingSplit = :seen');
    expect(settled.ExpressionAttributeValues[':seen']).toEqual(afterBen);
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('does not wipe an offer a later drain recorded after the speaker read none', async () => {
    mockSend.mockResolvedValueOnce({ Item: {} }).mockResolvedValueOnce({});

    await lock.clearPendingSplit({ channelArn: CHANNEL, responderId: BOT, speakerId: 'ana' });

    expect(mockSend.mock.calls[1][0].input.ConditionExpression).toBe('attribute_not_exists(pendingSplit)');
  });

  it('gives up leaving the record as found, never with an unconditional write', async () => {
    const whole = { topics: [topic('t-ana', 'ana'), topic('t-ben', 'ben')], offeredTo: { ana: true, ben: true } };
    for (let i = 0; i < 3; i++) {
      mockSend.mockResolvedValueOnce({ Item: { pendingSplit: whole } }).mockRejectedValueOnce(conditionalFailure());
    }

    await expect(lock.clearPendingSplit({ channelArn: CHANNEL, responderId: BOT, speakerId: 'ana' })).resolves.toBeUndefined();

    const writes = mockSend.mock.calls.map((c) => c[0]).filter((c) => c.__t === 'Update');
    expect(writes).toHaveLength(3);
    for (const w of writes) expect(w.input.ConditionExpression).toBeTruthy();
  });
});
