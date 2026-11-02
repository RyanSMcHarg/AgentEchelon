/**
 * AN AMENDMENT FOLD IS NOT A REDELIVERY OF THE TURN IT AMENDS (owner-reported, 2026-09-05).
 *
 * This is `a-further-pass-is-not-a-redelivery` one re-dispatch path along, and it is the second time
 * the same shape has cost a live conversation.
 *
 * A turn keeps ONE correlation id for its whole chain, and that identity is load-bearing well past
 * delivery - arrival triage names its turn by the triage claim it holds, so a reading turn's
 * correlation id IS `triagedBy`. Giving a re-dispatch a fresh id would trade a stranded queue for a
 * dead conversation. So anything re-entering the router on that id has to be distinguishable in the
 * DELIVERY key, or the duplicate-fulfillment guard replays the first attempt's placeholder and
 * returns without dispatching.
 *
 * WHAT IT COST, traced through the deployment on `bd3444ecd844c285`:
 *
 *   14:33:24.374  [AsyncProcessor] an amendment arrived before this answer was sent; running it again
 *   14:33:26.038  [Router] duplicate fulfillment: replaying the same placeholder
 *   (that correlation id never appears in any log again)
 *
 * The person watched "One moment..." for the rest of the conversation. The lock stayed held until
 * the five-minute staleness takeover, so every other member was queued behind a turn that had
 * ended. And the amendment itself was gone: `clearAmendments` runs the moment the fold is
 * dispatched, on the reasoning that losing it to a failed invoke is the worse outcome - which is
 * right, and which made this failure silent, because the invoke had SUCCEEDED. It was the guard
 * that discarded the turn.
 *
 * The suffix is asserted rather than the handler, because the handler needs a Lex event, a channel
 * and a model to reach this line - and the defect is entirely in one string.
 */
import { deliveryAttemptSuffix } from '../../lambda/src/router-agent-handler';

/** The attribute names are the router's own; a test that guessed them would pass while broken. */
const TRIAGE = 'AE.triage.queued';
const FOLD = 'AE.turn.amendedFold';

/**
 * A triage context the router's own parser accepts.
 *
 * It refuses a payload with no ids and one whose visibility is not in the closed set, so a fixture
 * carrying only a pass number parses to undefined - and every assertion about the pass would then
 * pass or fail for the wrong reason.
 */
const triageAttr = (pass: number): string =>
  JSON.stringify({ ids: ['m1'], visibility: 'conversation', pass });

describe('the delivery key tells the attempts of one turn apart', () => {
  it('is empty for an ordinary turn, so nothing that worked is narrowed', () => {
    expect(deliveryAttemptSuffix(undefined)).toBe('');
    expect(deliveryAttemptSuffix({})).toBe('');
  });

  // ── THE ONE THAT STRANDED A PLACEHOLDER ──────────────────────────────────────────────────────
  it('separates an amendment fold from the turn it amends', () => {
    const first = deliveryAttemptSuffix({});
    const folded = deliveryAttemptSuffix({ [FOLD]: '1' });

    expect(folded).not.toBe(first);
    expect(folded).toBe('#f1');
  });

  it('separates the second fold from the first, because the bound allows two', () => {
    expect(deliveryAttemptSuffix({ [FOLD]: '2' })).toBe('#f2');
    expect(deliveryAttemptSuffix({ [FOLD]: '2' })).not.toBe(deliveryAttemptSuffix({ [FOLD]: '1' }));
  });

  it('still dedups a genuine retry of the SAME fold, which is what the guard is for', () => {
    // The property being kept, not merely a symmetry: two deliveries of one fold must collide, or
    // the guard stops protecting anything and a retried invoke answers twice.
    expect(deliveryAttemptSuffix({ [FOLD]: '1' })).toBe(deliveryAttemptSuffix({ [FOLD]: '1' }));
  });

  it('keeps the triage pass it already told apart', () => {
    expect(deliveryAttemptSuffix({ [TRIAGE]: triageAttr(2) })).toBe('#p2');
    // Pass 1 is the first attempt and carries no suffix, exactly as before.
    expect(deliveryAttemptSuffix({ [TRIAGE]: triageAttr(1) })).toBe('');
  });

  it('tells a folded second pass from either alone', () => {
    // Both can be true at once - a reading that re-read the queue can then fold an amendment - and
    // a key that carried only one of them would put two different deliveries on one claim.
    const both = deliveryAttemptSuffix({
      [TRIAGE]: triageAttr(2), [FOLD]: '1',
    });

    expect(both).toBe('#p2#f1');
    expect(both).not.toBe(deliveryAttemptSuffix({ [TRIAGE]: triageAttr(2) }));
    expect(both).not.toBe(deliveryAttemptSuffix({ [FOLD]: '1' }));
  });

  it('treats an unreadable fold count as no fold rather than as a key of its own', () => {
    // A key built from NaN would be a string nothing else ever produces, so a retry would never
    // dedup against it - the opposite failure, and a quieter one.
    for (const bad of ['', 'x', '0', '-1']) {
      expect(deliveryAttemptSuffix({ [FOLD]: bad })).toBe('');
    }
  });
});
