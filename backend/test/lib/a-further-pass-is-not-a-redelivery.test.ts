/**
 * A FURTHER TRIAGE PASS IS NOT A REDELIVERY OF THE ONE THAT SPAWNED IT (maintainer, 2026-09-02).
 *
 * The re-read in DESIGN 2.3.3 fired correctly on the deployment and was then thrown away every
 * single time, because the pass it dispatched was indistinguishable from a duplicate delivery of the
 * pass that dispatched it. The processor's dedup guard claimed the turn's correlation id, the second
 * pass arrived carrying that same id, the claim was already held, and the invocation returned null
 * before doing anything. Nothing then cleared the queue, and the drain released the conversation
 * still holding it.
 *
 * Measured live, one conversation, three log lines in sequence:
 *   [triage] the queue moved under the reading; reading it again   pass: 2, read: 1, arrived: 2
 *   [AsyncProcessor] Duplicate invocation, skipping correlationId: arrival-6324a20c...-1
 *   [turn-handover] this turn was the reading; releasing now that it is done   stillQueued: 3
 *
 * ── WHY THE FIX IS HERE AND NOT AT THE DISPATCH ─────────────────────────────────────────────────
 *
 * The obvious repair is to give the re-dispatched pass a fresh correlation id. That trades a
 * stranded queue for a dead conversation. Arrival triage names its turn by the triage claim it
 * holds, so a reading turn's correlation id IS `triagedBy`; `turn-handover.ts` recognizes "this turn
 * was the reading" by comparing them. A pass carrying a fresh id fails that comparison, falls into
 * the branch below it, and hands the conversation to a turn that has already ended - which nothing
 * ever releases. The comment at that branch records it as having been observed as a conversation
 * that stopped answering entirely.
 *
 * So the two identities are separated instead. The turn keeps one correlation id for its whole
 * chain, and only the DELIVERY key carries the pass.
 */
import {
  deliveryCorrelationId,
  arrivalTriageCorrelationId,
  isReadableCorrelationId,
  handoverCorrelationId,
  CORRELATION_ID_MAX_LENGTH,
} from '../../lambda/src/lib/correlation';

/**
 * The id as the deployment actually produced it, taken verbatim from the live logs.
 *
 * PRE-FIX BY CONSTRUCTION: 74 characters, which is what `arrivalTriageCorrelationId` now prevents.
 * It is kept as the fixture for the delivery-key tests precisely because it is the string the defect
 * was observed on, and because those tests must hold for an input of any length.
 */
const READING = 'arrival-6324a20c3bd8624860058b74a34024bae2cd2a8c577aa29d51e13f37596de942-1';

describe('the delivery key separates a further pass from a redelivery', () => {
  it('pass 2 does not collide with the pass that dispatched it (THE defect)', () => {
    expect(deliveryCorrelationId(READING, 2)).not.toBe(deliveryCorrelationId(READING, 1));
  });

  it('every pass in the bounded chain is distinct, so none is swallowed as a duplicate', () => {
    const keys = [1, 2, 3].map((pass) => deliveryCorrelationId(READING, pass));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a REDELIVERY of a given pass still collapses, which is what the guard is for', () => {
    // Same pass arriving twice is the at-least-once case the dedup guard exists to catch, and it
    // must keep catching it. Losing this is how one queued message becomes two Bedrock calls.
    expect(deliveryCorrelationId(READING, 2)).toBe(deliveryCorrelationId(READING, 2));
    expect(deliveryCorrelationId(READING, 1)).toBe(deliveryCorrelationId(READING, 1));
  });

  it('pass 1 keys on the BARE id, so no existing turn changes what it claims', () => {
    // The whole platform outside triage has no pass at all. If this stopped returning the bare id,
    // every turn would claim a new key and the dedup guard would silently stop deduping anything.
    expect(deliveryCorrelationId(READING, 1)).toBe(READING);
    expect(deliveryCorrelationId(READING, undefined)).toBe(READING);
    expect(deliveryCorrelationId(READING, 0)).toBe(READING);
    expect(deliveryCorrelationId('turn-abc')).toBe('turn-abc');
  });

  it('the suffix stays inside the correlation-id character class', () => {
    // A delivery key does not travel in a placeholder marker, so it is not bound by
    // CORRELATION_ID_MAX_LENGTH. The character class is the invariant worth holding: an id shape
    // that is legal everywhere cannot trap the next caller who does put one somewhere that parses.
    expect(deliveryCorrelationId('turn-abc', 3)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(deliveryCorrelationId(READING, 2)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('passes an over-long input through unchanged rather than silently fitting it', () => {
    // Stated rather than assumed. This function does not bound its output, and must not: the key it
    // returns is claimed in DynamoDB and never travels in a marker, so fitting it here would only
    // create a second, silent way for two different turns to collide on one key.
    //
    // Keeping the id READABLE is the caller's job, and `arrivalTriageCorrelationId` below is where
    // that is now enforced for the path that was breaking it.
    expect(READING.length).toBeGreaterThan(CORRELATION_ID_MAX_LENGTH);
    expect(deliveryCorrelationId(READING, 2)).toBe(`${READING}.p2`);

    // ── THE FOLD AND THE RECOVERY ARE DELIVERIES TOO (code review, 2026-09-09) ─────────────────
    //
    // Each of these re-enters the processor carrying the ORIGINAL correlation id - the fold so the
    // placeholder and lock carry over to the answer that replaces them, the recovery so the retry
    // still holds the conversation. Keyed on the bare id every one of them was dropped as a
    // duplicate of the turn that had already claimed it: the amended answer was never produced, the
    // retry budget was inert, and the apology that exists to succeed where the turn failed was
    // skipped, so the person was told nothing at all.
    expect(deliveryCorrelationId(READING, undefined, 1)).toBe(`${READING}.f1`);
    expect(deliveryCorrelationId(READING, undefined, 1))
      .not.toBe(deliveryCorrelationId(READING, undefined, 2));
    expect(deliveryCorrelationId(READING, undefined, undefined, { turnAttempt: 2 })).toBe(`${READING}.a2`);
    expect(deliveryCorrelationId(READING, undefined, undefined, { announceFailure: true }))
      .toBe(`${READING}.fail`);
    // The announcement is its own delivery, not attempt n+1 of the turn.
    expect(deliveryCorrelationId(READING, undefined, undefined, { turnAttempt: 4 }))
      .not.toBe(deliveryCorrelationId(READING, undefined, undefined, { announceFailure: true }));

    // AND THE ORDINARY TURN IS UNTOUCHED. Attempt 1, no fold, no announcement: the bare id, exactly
    // as every deployment has always claimed it.
    expect(deliveryCorrelationId(READING, 1, 0, { turnAttempt: 1, announceFailure: false }))
      .toBe(READING);
    // A malformed discriminator leaves the key it would have qualified alone rather than appending
    // a NaN nothing can derive again.
    expect(deliveryCorrelationId(READING, undefined, Number('x') as number)).toBe(READING);
  });

  it('a fractional pass cannot mint an unbounded key', () => {
    expect(deliveryCorrelationId('turn-abc', 2.7)).toBe('turn-abc.p2');
  });
});

/**
 * THE CALL SITE, pinned as a source guard.
 *
 * `runSharedPipeline` takes a live event and is not invocable from a unit test, which is why the
 * neighbouring queue rules are pinned this way too. What a source guard can still hold is the part
 * that was wrong: that the guard claims the DELIVERY key rather than the turn's own id, and that the
 * dispatch does NOT rewrite the correlation id.
 */
describe('the processor claims the delivery key, and the re-dispatch keeps the turn id', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const core: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/lib/async-processor-core.ts'),
    'utf8',
  );

  it('the dedup guard claims the derived delivery key', () => {
    // EVERY RE-ENTRY ON ONE CORRELATION IS PASSED, not just the triage pass. The fold and the two
    // recovery re-dispatches all arrive on the turn's own id by design, so a key that ignores them
    // reads them as duplicates of the turn they follow.
    expect(core).toContain('deliveryCorrelationId(correlationId, event.triage?.pass, event.amendedFold, {');
    expect(core).toContain('turnAttempt: event.turnAttempt,');
    expect(core).toContain('announceFailure: event.announceFailure,');
    expect(core).toContain('await claimCorrelation(deliveryId)');
    // The bare id must not be what is claimed, or the defect is back.
    expect(core).not.toContain('await claimCorrelation(correlationId)');
  });

  it('the re-read still dispatches under the TURN\'s correlation id, never a fresh one', () => {
    // This is the half that must NOT change. If a future edit gives the re-dispatch its own id, the
    // handover stops recognizing the reading and hands the conversation to a turn that has ended.
    const recheck = core.indexOf('const arrivedSinceRead = queuedNow.filter(');
    const parse = core.indexOf('const judged = parseTriageProposal(');
    expect(recheck).toBeGreaterThan(-1);
    expect(core.slice(recheck, parse)).toContain('correlationId: event.correlationId');
  });
});

/**
 * THE ARRIVAL ID MUST FIT WHAT A READER ACCEPTS (maintainer, 2026-09-02).
 *
 * Built by interpolation this ran to 74 characters against a 64-character bound, so the marker never
 * matched, the placeholder mapping was never written, and every triage turn polled ~7s for a mapping
 * that could not arrive before falling back to a billed channel scan. Measured live: invoked
 * 15:15:47.955, gave up 15:15:54.830, on a path section 7.4 budgets at 1.5 to 4 seconds.
 *
 * The same defect `mentionCorrelationId` and `battleCorrelationId` were already fixed for.
 */
describe('the arrival triage id fits the marker bound', () => {
  const CHIME_MESSAGE_ID = '6324a20c3bd8624860058b74a34024bae2cd2a8c577aa29d51e13f37596de942';
  const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/fe15ac2c/channel/conv-1788361653540-d4306e9416c1';

  it('a real 64-character Chime message id yields a READABLE id (the defect)', () => {
    const id = arrivalTriageCorrelationId({ messageId: CHIME_MESSAGE_ID, channelArn: CHANNEL, depth: 1 });
    expect(id.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
    expect(isReadableCorrelationId(id)).toBe(true);
  });

  it('the no-message-id fallback fits too, and an ARN is longer than the id it replaces', () => {
    const id = arrivalTriageCorrelationId({ channelArn: CHANNEL, depth: 2 });
    expect(id.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
    expect(isReadableCorrelationId(id)).toBe(true);
  });

  it('a two-digit depth still fits, because the depth takes its budget first', () => {
    const id = arrivalTriageCorrelationId({ messageId: CHIME_MESSAGE_ID, channelArn: CHANNEL, depth: 12 });
    expect(id.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
    expect(id.endsWith('-12')).toBe(true);
  });

  it('the DEPTH is never truncated, because it is what separates one notice from the next', () => {
    const a = arrivalTriageCorrelationId({ messageId: CHIME_MESSAGE_ID, channelArn: CHANNEL, depth: 1 });
    const b = arrivalTriageCorrelationId({ messageId: CHIME_MESSAGE_ID, channelArn: CHANNEL, depth: 2 });
    expect(a).not.toBe(b);
  });

  it('is STABLE for the same message and depth, so a redelivery stays idempotent', () => {
    expect(arrivalTriageCorrelationId({ messageId: CHIME_MESSAGE_ID, channelArn: CHANNEL, depth: 1 }))
      .toBe(arrivalTriageCorrelationId({ messageId: CHIME_MESSAGE_ID, channelArn: CHANNEL, depth: 1 }));
  });

  it('two different messages at the same depth do not collide', () => {
    const a = arrivalTriageCorrelationId({ messageId: 'a'.repeat(64), channelArn: CHANNEL, depth: 1 });
    const b = arrivalTriageCorrelationId({ messageId: 'b'.repeat(64), channelArn: CHANNEL, depth: 1 });
    expect(a).not.toBe(b);
  });

  it('the delivery key for a further pass is still derived from it without breaking the claim', () => {
    // The delivery key MAY exceed the marker bound - it never travels in a marker - but the id it is
    // derived from must not, which is what the assertions above hold.
    const id = arrivalTriageCorrelationId({ messageId: CHIME_MESSAGE_ID, channelArn: CHANNEL, depth: 1 });
    expect(deliveryCorrelationId(id, 2)).toBe(`${id}.p2`);
    expect(deliveryCorrelationId(id, 1)).toBe(id);
  });
});

/**
 * AND THE HANDOVER ID, WHICH HAD THE SAME DEFECT AND COMPOUNDED IT (maintainer, 2026-09-02).
 *
 * `triage-handover-${correlationId}` re-prefixed the id it was handed, so a handover from an arrival
 * reading ran to roughly 90 characters and a chain grew by 16 per link. Every one was unreadable as a
 * marker, so every handover reading also paid the mapping poll and the billed scan. Observed live as
 * `triage-handover-arrival-b13ea666...-1` logging `No placeholder mapping yet`.
 *
 * Fixed alongside the arrival id rather than after it, because a bound enforced at one of two call
 * sites is a bound the other one keeps breaking.
 */
describe('the handover id fits, stays distinct, and does not stack', () => {
  const ARRIVAL = arrivalTriageCorrelationId({
    messageId: '6324a20c3bd8624860058b74a34024bae2cd2a8c577aa29d51e13f37596de942',
    channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
    depth: 1,
  });

  it('a handover from an arrival reading is READABLE (the defect)', () => {
    const handed = handoverCorrelationId(ARRIVAL, 2);
    expect(handed.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
    expect(isReadableCorrelationId(handed)).toBe(true);
  });

  it('a CHAIN does not grow, which is what the old prefix stacking did', () => {
    const link2 = handoverCorrelationId(ARRIVAL, 2);
    const link3 = handoverCorrelationId(link2, 3);
    expect(link3.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
    expect(isReadableCorrelationId(link3)).toBe(true);
  });

  it('differs from the id it is derived from, or handOverLock hands a lock to itself', () => {
    // from -> to with from === to is a lock nothing ever releases.
    expect(handoverCorrelationId(ARRIVAL, 2)).not.toBe(ARRIVAL);
  });

  it('each link of the chain is distinct, so two readings never share one id', () => {
    const ids = [1, 2, 3].map((pass) => handoverCorrelationId(ARRIVAL, pass));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is STABLE for a given turn and pass, so a re-run does not mint a second reader', () => {
    expect(handoverCorrelationId(ARRIVAL, 2)).toBe(handoverCorrelationId(ARRIVAL, 2));
  });

  it('two different turns handing over at the same pass do not collide', () => {
    const a = arrivalTriageCorrelationId({ messageId: 'a'.repeat(64), channelArn: 'c', depth: 1 });
    const b = arrivalTriageCorrelationId({ messageId: 'b'.repeat(64), channelArn: 'c', depth: 1 });
    expect(handoverCorrelationId(a, 2)).not.toBe(handoverCorrelationId(b, 2));
  });
});
