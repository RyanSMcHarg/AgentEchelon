/**
 * first-turn greeting - the assistant greets the user by name on their FIRST message (name
 * personalization moved off the racy creation-time WelcomeIntent). Locks the directive shape and the
 * no-op cases so a normal turn, or an unresolved name, adds nothing to the system prompt.
 *
 * The greeting claims no history (SPEC-WELCOME-AND-CONTEXT FR10): the model knows the name and nothing
 * about earlier visits, and it welcomed people "back" and "aboard" when nothing told it otherwise. The
 * directive says what the model does not know, in the language of an instruction rather than a list of
 * phrases (tenet D11), and carries no example greeting a model would copy into another language.
 */
import { firstTurnGreetingDirective } from '../../lambda/src/lib/async-processor-core';

describe('firstTurnGreetingDirective', () => {
  it('instructs a one-time greeting by name when a real name is present', () => {
    const d = firstTurnGreetingDirective('Sam');
    expect(d).toContain('FIRST message');
    expect(d).toContain('uses their name, Sam, exactly once');
    expect(d).toContain('only in this opening greeting');
  });

  it('says the model knows nothing of the person\'s history, so the greeting implies none', () => {
    const d = firstTurnGreetingDirective('Sam');
    expect(d).toContain('nothing else about their history');
    expect(d).toContain('must not state or imply');
  });

  it('greets in the language of the reply and gives no example to copy', () => {
    const d = firstTurnGreetingDirective('Sam');
    expect(d).toContain('in the language you are replying in');
    expect(d).not.toContain('Hi Sam');
  });

  it('trims surrounding whitespace in the name', () => {
    expect(firstTurnGreetingDirective('  Sam  ')).toContain('their name, Sam,');
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
