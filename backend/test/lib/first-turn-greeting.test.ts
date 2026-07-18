/**
 * first-turn greeting - the assistant greets the user by name on their FIRST message (name
 * personalization moved off the racy creation-time WelcomeIntent). Locks the directive shape and the
 * no-op cases so a normal turn, or an unresolved name, adds nothing to the system prompt.
 */
import { firstTurnGreetingDirective } from '../../lambda/src/lib/async-processor-core';

describe('firstTurnGreetingDirective', () => {
  it('instructs a one-time greeting by name when a real name is present', () => {
    const d = firstTurnGreetingDirective('Sam');
    expect(d).toContain('FIRST message');
    expect(d).toContain('Hi Sam,');
    expect(d).toContain('only in this opening greeting');
  });

  it('trims surrounding whitespace in the name', () => {
    expect(firstTurnGreetingDirective('  Sam  ')).toContain('Hi Sam,');
  });

  it('returns empty for the router\'s "there" fallback (no usable name)', () => {
    expect(firstTurnGreetingDirective('there')).toBe('');
  });

  it('returns empty for missing / blank names', () => {
    expect(firstTurnGreetingDirective()).toBe('');
    expect(firstTurnGreetingDirective('')).toBe('');
    expect(firstTurnGreetingDirective('   ')).toBe('');
  });
});
