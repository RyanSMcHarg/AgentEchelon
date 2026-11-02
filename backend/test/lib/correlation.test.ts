/**
 * @all mention dedup-key derivation (SPEC-ABUSE-CONTROLS, F2). The processor dedups a turn by claiming
 * its correlationId, so for a cross-container at-least-once REDELIVERY of the same @all to collapse to
 * one Bedrock call, the id must be STABLE and derivable from the inbound Chime message id - not fresh
 * random per delivery. Pins that property against a regression back to a random-per-call id.
 */
import { mentionCorrelationId, stopEvaluationCorrelationId, handoverCorrelationId, arrivalTriageCorrelationId, isReadableCorrelationId } from '../../lambda/src/lib/correlation';

describe('mentionCorrelationId (F2 dedup key)', () => {
  it('is stable + deterministic for a given message id (a redelivery reuses it → claim collapses it)', () => {
    expect(mentionCorrelationId('chime-msg-123')).toBe('mention-chime-msg-123');
    // Same message id → same key, so the processor's claimCorrelation dedups the second delivery.
    expect(mentionCorrelationId('chime-msg-123')).toBe(mentionCorrelationId('chime-msg-123'));
  });

  it('distinct message ids get distinct keys (different messages never wrongly collapse)', () => {
    expect(mentionCorrelationId('msg-a')).not.toBe(mentionCorrelationId('msg-b'));
  });

  it('falls back to a UNIQUE id when no message id is present (synthetic/test events)', () => {
    const a = mentionCorrelationId();
    const b = mentionCorrelationId();
    expect(a.startsWith('mention-')).toBe(true);
    expect(a).not.toBe(b); // random fallback must not collide two different turns
  });

  it('an empty-string message id is treated as absent (random), never the constant "mention-"', () => {
    expect(mentionCorrelationId('')).not.toBe('mention-');
    expect(mentionCorrelationId('').startsWith('mention-')).toBe(true);
  });
});

/**
 * THE QUESTION A `/stop` ASKS BACK, AND WHY ITS ID HAS A BOUND (code review, 2026-09-04).
 *
 * Written inline at the call site as `${correlationId}-stopeval`, this was the last correlation id in
 * the codebase built by interpolation. It inherited whatever it was handed and added nine characters,
 * and what it is handed is itself derived: a stop aimed at an arrival reading, or at any handover of
 * one, starts from an id that has already spent most of the budget.
 *
 * Past the bound the marker is unreadable, so the placeholder that question posts can never be
 * matched - and on THIS path that means a person who just typed `/stop` is asked which work to stop
 * and never sees the reply resolve. The two sibling builders were fixed for the same defect; this
 * pins that all three now hold, including under the composition that produced the longest ids.
 */
describe('stopEvaluationCorrelationId', () => {
  const LIMIT = 64;

  it('stays readable when the id it derives from is already long', () => {
    const arrival = arrivalTriageCorrelationId({
      messageId: 'a'.repeat(80),
      channelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1',
      depth: 1,
    });
    const id = stopEvaluationCorrelationId(arrival);
    expect(id.length).toBeLessThanOrEqual(LIMIT);
    expect(isReadableCorrelationId(id)).toBe(true);
  });

  it('holds through the composition that produced the longest ids in the wild', () => {
    // A stop against a handover of an arrival reading - each link derived from the last, which is how
    // the sibling defect compounded to roughly ninety characters before it was found.
    let id = arrivalTriageCorrelationId({
      messageId: 'b'.repeat(60),
      channelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1',
      depth: 2,
    });
    for (let pass = 1; pass <= 3; pass += 1) id = handoverCorrelationId(id, pass);
    const stop = stopEvaluationCorrelationId(id);
    expect(stop.length).toBeLessThanOrEqual(LIMIT);
    expect(isReadableCorrelationId(stop)).toBe(true);
  });

  it('differs from the id it names, so the question is not the stopped turn', () => {
    // The whole reason a new correlation is minted: reusing the stopped turn's would attach this
    // question to the answer that was just suppressed.
    const base = 'turn-abc';
    expect(stopEvaluationCorrelationId(base)).not.toBe(base);
  });

  it('keeps the discriminating tail when it has to trim', () => {
    // Two turns differing only near the END must not collapse to one id - which is what trimming the
    // tail instead of the head would do.
    const long = (suffix: string) => stopEvaluationCorrelationId('x'.repeat(70) + suffix);
    expect(long('one')).not.toBe(long('two'));
  });
});
