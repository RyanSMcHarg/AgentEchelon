/**
 * routing-state — manages the pending drift-suggestion state across
 * Lex turns (in-flight in sessionAttributes, durable in Aurora).
 *
 * The Aurora-backed paths (`savePendingSuggestion`, `readPendingSuggestion`,
 * `resolvePendingSuggestion`) require a live database — they're covered
 * by the e2e drift flow integration test, not unit-tested here.
 *
 * The pure paths (session serialization, decline-suppression bookkeeping,
 * yes/no reply classification) are tested below. These are the bits that
 * a Lex Lambda boundary failure would silently break, so a unit gate
 * matters even though they look trivial.
 */

import {
  readRoutingFromSession,
  writeRoutingToSession,
  recordDecline,
  classifyConfirmDeclineReply,
  type PendingSuggestion,
  type RoutingSessionAttributes,
} from '../../lambda/src/lib/routing-state';

describe('routing-state', () => {
  describe('readRoutingFromSession', () => {
    it('returns empty when sessionAttributes is undefined', () => {
      expect(readRoutingFromSession(undefined)).toEqual({});
    });

    it('returns empty when the routing key is absent', () => {
      expect(readRoutingFromSession({ someOtherKey: 'foo' })).toEqual({});
    });

    it('round-trips a pendingDriftSuggestion through write→read', () => {
      const pending: PendingSuggestion = {
        taskId: 't-1',
        channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
        userSub: 'sub-1',
        kind: 'confirm',
        originatingMessageId: 'msg-1',
        cosineDistance: 0.42,
        correlationId: 'corr-1',
        createdAt: '2026-05-22T00:00:00Z',
      };
      const written = writeRoutingToSession({}, { pendingDriftSuggestion: pending });
      const read = readRoutingFromSession(written);
      expect(read.pendingDriftSuggestion).toEqual(pending);
    });

    it('returns empty when the routing payload is malformed JSON', () => {
      // Lex sessionAttributes is mutable across handlers — a buggy
      // upstream could write a non-JSON value. Treat as missing.
      const result = readRoutingFromSession({ agentEchelonRouting: '{broken' });
      expect(result).toEqual({});
    });

    it('returns empty when the routing payload parses to a non-object', () => {
      expect(readRoutingFromSession({ agentEchelonRouting: 'null' })).toEqual({});
      expect(readRoutingFromSession({ agentEchelonRouting: '42' })).toEqual({});
      expect(readRoutingFromSession({ agentEchelonRouting: '"oops"' })).toEqual({});
    });
  });

  describe('writeRoutingToSession', () => {
    it('preserves any non-routing keys in sessionAttributes', () => {
      const result = writeRoutingToSession(
        { foo: 'bar', baz: 'qux' },
        { declinedDistances: [0.4] },
      );
      expect(result.foo).toBe('bar');
      expect(result.baz).toBe('qux');
      expect(result.agentEchelonRouting).toBeDefined();
    });

    it('overwrites a previous routing payload', () => {
      const first = writeRoutingToSession({}, { declinedDistances: [0.1] });
      const second = writeRoutingToSession(first, { declinedDistances: [0.9] });
      const read = readRoutingFromSession(second);
      expect(read.declinedDistances).toEqual([0.9]);
    });
  });

  describe('recordDecline', () => {
    it('prepends the new distance + clears any pendingDriftSuggestion', () => {
      const before: RoutingSessionAttributes = {
        pendingDriftSuggestion: { taskId: 't', channelArn: 'a', userSub: 's', kind: 'confirm', originatingMessageId: 'm', correlationId: 'c', createdAt: 'now' },
        declinedDistances: [0.5],
      };
      const after = recordDecline(before, 0.4);
      expect(after.declinedDistances).toEqual([0.4, 0.5]);
      expect(after.pendingDriftSuggestion).toBeUndefined();
    });

    it('caps the declined list at 3 entries (oldest evicted)', () => {
      let routing: RoutingSessionAttributes = {};
      routing = recordDecline(routing, 0.10);
      routing = recordDecline(routing, 0.20);
      routing = recordDecline(routing, 0.30);
      routing = recordDecline(routing, 0.40);
      expect(routing.declinedDistances).toEqual([0.40, 0.30, 0.20]);
    });

    it('initialises declinedDistances when previously absent', () => {
      const after = recordDecline({}, 0.42);
      expect(after.declinedDistances).toEqual([0.42]);
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
