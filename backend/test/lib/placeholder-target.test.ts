/**
 * Which placeholder the answer lands on when a turn is delivered twice.
 *
 * The failure this prevents is silent on both sides: the channel flow denies one of the two
 * placeholders, the processor writes its answer onto the other, and nothing errors. The user sees
 * "One moment..." that never resolves, while a complete answer sits on a message that is no longer in
 * the channel. Neither half can detect it alone, which is why the tiebreak has to be a stated rule.
 */
import { resolvePlaceholderTarget } from '../../lambda/src/lib/placeholder-target';

describe('resolvePlaceholderTarget', () => {
  it('prefers the CLAIMED placeholder over the one this dispatch created', () => {
    // The claim is what the channel agrees with: it is the placeholder that survived the duplicate
    // guard, so it is the one the user is looking at.
    const t = resolvePlaceholderTarget('claimed-msg', 'my-own-msg');
    expect(t.messageId).toBe('claimed-msg');
    expect(t.overrodeHandedId).toBe(true);
  });

  it('keeps the handed id when nothing has claimed the correlation YET', () => {
    // The normal fast path: the processor is dispatched before the placeholder exists, so a miss
    // means "not yet", never "wrong id".
    expect(resolvePlaceholderTarget(null, 'my-own-msg')).toEqual({
      messageId: 'my-own-msg',
      overrodeHandedId: false,
    });
  });

  it('does not report an override when the claim IS the handed id', () => {
    // The common duplicate-free case: this dispatch created the placeholder and won the claim. It
    // must not log as a divergence, or the signal stops meaning anything.
    expect(resolvePlaceholderTarget('same-msg', 'same-msg')).toEqual({
      messageId: 'same-msg',
      overrodeHandedId: false,
    });
  });

  it('uses the claim when this dispatch has no placeholder of its own', () => {
    // The router path: it cannot know the id Amazon Chime SDK will mint from its Lex return, so the
    // claim is the only answer.
    expect(resolvePlaceholderTarget('claimed-msg', undefined)).toEqual({
      messageId: 'claimed-msg',
      overrodeHandedId: false,
    });
  });

  it('resolves to nothing when neither source knows a message', () => {
    // Not a failure: the caller carries on unresolved and finds the placeholder at answer time.
    expect(resolvePlaceholderTarget(null, undefined).messageId).toBeUndefined();
    expect(resolvePlaceholderTarget('  ', '  ').messageId).toBeUndefined();
  });
});
