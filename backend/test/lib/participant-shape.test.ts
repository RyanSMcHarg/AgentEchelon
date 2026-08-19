/**
 * Participant shape (SPEC-USER-PROFILE-AND-ONBOARDING §2).
 *
 * The property under test is that "nobody is in this conversation" and "one person is" are DIFFERENT
 * answers, and that neither can be produced by accident. The previous design read live channel membership at
 * `WelcomeIntent`, where it has not converged, so a miss was ambiguous between the two - and resolving it the
 * wrong way re-onboarded users who had already completed the intake, which is the exact defect the
 * once-per-user gate exists to prevent.
 *
 * `onboardingApplies` is the load-bearing predicate: onboarding needs ONE person to key on, so it must be
 * false for a group (no single subject) and false for an empty conversation (nobody), and those are decisions
 * rather than failures.
 */
import {
  participantContextFor,
  onboardingApplies,
  parseParticipantContext,
  derivedChannelArn,
} from '../../lambda/src/lib/participant-shape';

describe('participantContextFor', () => {
  it('classifies one human as a single focus, with that person as the subject', () => {
    expect(participantContextFor(['user-a'])).toEqual({
      focus: 'single', humans: ['user-a'], subject: 'user-a',
    });
  });

  it('classifies several humans as a group with NO subject', () => {
    // The empty subject is the point. A group's `humans[0]` is a person, and exposing it as the subject
    // would let a caller personalize to whoever happened to be listed first.
    expect(participantContextFor(['user-a', 'user-b'])).toEqual({
      focus: 'group', humans: ['user-a', 'user-b'], subject: '',
    });
  });

  it('classifies nobody as `none`, which is a real answer and not an error', () => {
    expect(participantContextFor([])).toEqual({ focus: 'none', humans: [], subject: '' });
  });

  it('collapses a duplicated member so a repeated id cannot fake a group', () => {
    // A roster naming the same person twice must stay `single`. Becoming a `group` would silently disable
    // onboarding for a 1:1 conversation, and the symptom (no intake) looks like a config problem.
    expect(participantContextFor(['user-a', 'user-a'])).toMatchObject({ focus: 'single', subject: 'user-a' });
  });

  it('drops blank and absent ids rather than counting them as members', () => {
    expect(participantContextFor(['user-a', '', '   ', undefined, null])).toMatchObject({
      focus: 'single', subject: 'user-a',
    });
    expect(participantContextFor(['', undefined])).toMatchObject({ focus: 'none' });
  });

  it('trims ids, so whitespace cannot split one person into two members', () => {
    expect(participantContextFor([' user-a ', 'user-a'])).toMatchObject({ focus: 'single' });
  });
});

describe('onboardingApplies', () => {
  it('applies only to a single-human conversation', () => {
    expect(onboardingApplies(participantContextFor(['user-a']))).toBe(true);
    expect(onboardingApplies(participantContextFor(['user-a', 'user-b']))).toBe(false);
    expect(onboardingApplies(participantContextFor([]))).toBe(false);
  });

  it('does not apply when nothing was resolved at all', () => {
    expect(onboardingApplies(null)).toBe(false);
    expect(onboardingApplies(undefined)).toBe(false);
  });

  it('does not apply to a single focus with an empty subject', () => {
    // Defends the gate against a hand-built or store-returned shape: `single` with no subject would
    // otherwise reach `hasOnboarded('')`.
    expect(onboardingApplies({ focus: 'single', humans: [], subject: '' })).toBe(false);
  });
});

describe('parseParticipantContext', () => {
  it('round-trips a written shape', () => {
    const written = participantContextFor(['user-a']);
    expect(parseParticipantContext(written)).toEqual(written);
  });

  it('returns null for anything that is not a recorded shape', () => {
    // Null means "nothing recorded, fall back to live membership", which is deliberately DIFFERENT from a
    // recorded `none` ("this conversation genuinely has no humans").
    for (const raw of [null, undefined, 'single', 42, [], {}, { focus: 'solo' }, { humans: ['a'] }]) {
      expect(parseParticipantContext(raw)).toBeNull();
    }
  });

  it('RE-DERIVES the focus rather than trusting an inconsistent stored triple', () => {
    // A row claiming `single` while carrying two humans must not key the gate on the claimed subject. This is
    // the case a pluggable profile/context store or an older writer could produce.
    expect(parseParticipantContext({ focus: 'single', humans: ['user-a', 'user-b'], subject: 'user-a' }))
      .toEqual({ focus: 'group', humans: ['user-a', 'user-b'], subject: '' });
  });

  it('ignores a stored subject that the member list does not support', () => {
    expect(parseParticipantContext({ focus: 'group', humans: ['user-a'], subject: 'user-z' }))
      .toEqual({ focus: 'single', humans: ['user-a'], subject: 'user-a' });
  });

  it('distinguishes a recorded `none` from nothing recorded', () => {
    expect(parseParticipantContext({ focus: 'none', humans: [], subject: '' }))
      .toEqual({ focus: 'none', humans: [], subject: '' });
    expect(parseParticipantContext(undefined)).toBeNull();
  });
});

describe('derivedChannelArn', () => {
  it('builds the ARN a channel WILL have, before it exists', () => {
    // This is what makes writing context ahead of creation possible: the caller supplies the channel id, so
    // the ARN is determined before CreateChannel is invoked.
    expect(derivedChannelArn('arn:aws:chime:us-east-1:1:app-instance/abc', 'conv-1-ff'))
      .toBe('arn:aws:chime:us-east-1:1:app-instance/abc/channel/conv-1-ff');
  });

  it('matches the shape Chime returns, so the derived key and the real ARN agree', () => {
    // If these ever diverge the context row is written under a key nothing reads, and the welcome silently
    // falls back forever. Pinning the format is the cheapest guard against that.
    const appInstance = 'arn:aws:chime:us-east-1:123456789012:app-instance/f66def4e';
    expect(derivedChannelArn(appInstance, 'conv-x')).toBe(`${appInstance}/channel/conv-x`);
  });
});
