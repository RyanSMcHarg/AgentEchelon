/**
 * routing-state - whether a person's reply reads as a yes or a no.
 */

import * as routingState from '../../lambda/src/lib/routing-state';
import { classifyConfirmDeclineReply } from '../../lambda/src/lib/routing-state';

describe('routing-state', () => {
  describe('no Amazon Lex session state', () => {
    it('exports nothing that reads or writes a session', () => {
      expect(Object.keys(routingState)).not.toEqual(expect.arrayContaining(['readRoutingFromSession']));
      expect(Object.keys(routingState)).not.toEqual(expect.arrayContaining(['writeRoutingToSession']));
      expect(Object.keys(routingState)).not.toEqual(expect.arrayContaining(['recordDecline']));
    });
  });

  describe('classifyConfirmDeclineReply', () => {
    it.each([
      'yes',
      'YES',
      'yeah',
      'yep',
      'yup',
      'sure',
      'ok',
      'okay',
      'please do',
      'do it',
      'go ahead',
      'sounds good',
      "let's do it",
      'lets do it',
      'create it',
      'switch',
      'navigate',
      '  yes  ',
      'yes!',
      'yes.',
    ])('classifies %p as affirmative', (input) => {
      expect(classifyConfirmDeclineReply(input)).toBe('affirmative');
    });

    it.each([
      'no',
      'NO',
      'nope',
      'nah',
      'not now',
      "don't",
      'dont',
      'stay here',
      'keep going',
      'continue',
      'stay',
      'cancel',
      'nevermind',
      '  no  ',
      'no!',
    ])('classifies %p as negative', (input) => {
      expect(classifyConfirmDeclineReply(input)).toBe('negative');
    });

    it.each([
      'maybe',
      'I think so',
      'tell me more',
      'what would that look like',
      'depends',
      'yes please tell me about both',           // multi-clause — too ambiguous to auto-act on
      'no actually wait',                         // contradicts itself
      'switch to dark mode',                      // "switch" embedded in a request — not a confirmation
      '',
      '   ',
    ])('classifies %p as ambiguous', (input) => {
      expect(classifyConfirmDeclineReply(input)).toBe('ambiguous');
    });

    it('does not match a yes/no embedded inside a larger sentence', () => {
      // The classifier MUST be conservative — auto-acting on an embedded
      // "yes" would create channels the user didn't ask for. These should
      // all be 'ambiguous' so the live consumer asks for clarification.
      expect(classifyConfirmDeclineReply('I would say yes but...')).toBe('ambiguous');
      expect(classifyConfirmDeclineReply('no thanks though I appreciate it')).toBe('ambiguous');
    });

    describe('multi-word natural acks (leading yes-word + short tail)', () => {
      // A brief "yes please" is how people actually confirm; the old
      // $-anchored matcher dropped anything past a single token to ambiguous,
      // so "yes please" never created a channel. SPEC-DRIFT-CONVERGENCE.md
      // §Live-Suggestion Flow lists these as confirmations.
      it.each([
        'yes please',
        'yes, please do',
        'ok create it',
        'sure, go ahead',
        "yeah let's do it",
        'yes create it now',
        'yep sounds good',
      ])('classifies %p as affirmative', (input) => {
        expect(classifyConfirmDeclineReply(input)).toBe('affirmative');
      });

      it('still requires a SHORT tail — a multi-clause reply stays ambiguous', () => {
        // Guards against auto-acting on a question dressed as a yes.
        expect(classifyConfirmDeclineReply('yes please tell me about both')).toBe('ambiguous');
        expect(classifyConfirmDeclineReply('yes but only if it keeps this thread too')).toBe('ambiguous');
      });

      it('a trailing question mark disqualifies (a question is not a confirmation)', () => {
        expect(classifyConfirmDeclineReply('yes but what about the other thread?')).toBe('ambiguous');
      });

      it('only strong yes-words lead — a verb-y phrase token must be the whole reply', () => {
        // "switch"/"navigate" confirm only when bare; embedded in a request
        // they are NOT a confirmation.
        expect(classifyConfirmDeclineReply('switch to dark mode')).toBe('ambiguous');
        expect(classifyConfirmDeclineReply('navigate to the settings page')).toBe('ambiguous');
      });
    });
  });
});
