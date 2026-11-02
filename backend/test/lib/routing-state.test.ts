/**
 * routing-state - the pending drift offer between the turn that makes it and the turn that answers it.
 *
 * ONE STORE: Aurora `conversation_creation_tasks`. The offer used to ride the Amazon Lex session first,
 * which a turn the channel flow answers does not have, so nothing here reads or writes a session.
 *
 * The durable row is tested against a mocked query: what matters at this layer is that the row carries
 * everything the answering turn needs, including the drift event its outcome is recorded on. The yes/no
 * reply classification is tested below.
 */

const mockQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import * as routingState from '../../lambda/src/lib/routing-state';
import {
  classifyConfirmDeclineReply,
  savePendingSuggestion,
  readPendingSuggestion,
} from '../../lambda/src/lib/routing-state';

describe('routing-state', () => {
  beforeEach(() => mockQuery.mockReset());

  describe('no Amazon Lex session state', () => {
    it('exports nothing that reads or writes a session', () => {
      // The session helpers and the declined-distance list are gone: an open offer is read from Aurora,
      // and a declined subject becomes a topic of the conversation (migration 044).
      expect(Object.keys(routingState)).not.toEqual(expect.arrayContaining(['readRoutingFromSession']));
      expect(Object.keys(routingState)).not.toEqual(expect.arrayContaining(['writeRoutingToSession']));
      expect(Object.keys(routingState)).not.toEqual(expect.arrayContaining(['recordDecline']));
    });
  });

  describe('the durable offer carries its drift event', () => {
    it('saves the drift event id on the row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ task_id: 't-1', created_at: '2026-09-12T00:00:00Z' }] });

      const saved = await savePendingSuggestion({
        channelArn: 'arn:chan', personId: 'u1', kind: 'confirm', originatingMessageId: 'msg-1',
        cosineDistance: 0.5, correlationId: 'corr-1', driftEventId: 'evt-1',
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).toContain('drift_event_id');
      expect(params).toContain('evt-1');
      expect(saved.driftEventId).toBe('evt-1');
    });

    it('reads it back, so the answering turn can record the outcome', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          task_id: 't-1', suggestion_kind: 'confirm', rival_conversation_arn: null, originating_message_id: 'msg-1',
          cosine_distance: '0.5000', correlation_id: 'corr-1', drift_event_id: 'evt-1', created_at: '2026-09-12T00:00:00Z',
        }],
      });

      const pending = await readPendingSuggestion({ personId: 'u1', channelArn: 'arn:chan' });

      expect(pending).toEqual(expect.objectContaining({
        taskId: 't-1', correlationId: 'corr-1', driftEventId: 'evt-1', originatingMessageId: 'msg-1',
      }));
    });

    it('an offer from before migration 044 simply has no drift event', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          task_id: 't-0', suggestion_kind: 'confirm', rival_conversation_arn: null, originating_message_id: 'msg-0',
          cosine_distance: null, correlation_id: 'corr-0', drift_event_id: null, created_at: '2026-09-01T00:00:00Z',
        }],
      });

      const pending = await readPendingSuggestion({ personId: 'u1', channelArn: 'arn:chan' });

      expect(pending).not.toHaveProperty('driftEventId');
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
