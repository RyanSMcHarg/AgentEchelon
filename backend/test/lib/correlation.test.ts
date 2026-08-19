/**
 * @all mention dedup-key derivation (SPEC-ABUSE-CONTROLS, F2). The processor dedups a turn by claiming
 * its correlationId, so for a cross-container at-least-once REDELIVERY of the same @all to collapse to
 * one Bedrock call, the id must be STABLE and derivable from the inbound Chime message id - not fresh
 * random per delivery. Pins that property against a regression back to a random-per-call id.
 */
import { mentionCorrelationId } from '../../lambda/src/lib/correlation';

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
