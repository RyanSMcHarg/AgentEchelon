/**
 * THE ASSISTANT PICKS UP WHAT IT ASKED ABOUT, WHEN IT HAS NOTHING BETTER TO DO (maintainer, 2026-09-03).
 *
 * A clarification waits on a person. Left alone it waits forever: it sits in their list and nothing
 * raises it again unless they think to. The owner's rule closes that in two halves -
 *
 *   - work through them when there is no higher-priority or active work, because at that point the
 *     assistant has nothing better to do and the person gains a step for free;
 *   - and when priority is NOT clear, say so and OFFER, rather than deciding for them.
 *
 * WHY IT IS NOT A SCHEDULE. Tenet D6 forbids one, and it would be the wrong shape anyway: "nothing
 * more urgent is open" is a state, not a time, and the moment it becomes true is the moment the queue
 * clears. That is an event, the drain is already there, and it already has a message in front of the
 * person - so this needs no new trigger and no second message.
 *
 * THE DECISION IS PURE, WHICH IS THE POINT OF THE SPLIT. What to do is a rule about priorities across
 * live work; composing a sentence is not the place to be reading tasks, and a rule that can only be
 * exercised through a message is one nobody can test properly.
 */

import { decideClarificationFollowUp } from '../../lambda/src/lib/clarification-follow-up';
import { buildProposalMessage, type ProposedItem } from '../../lambda/src/lib/turn-triage-proposal';
import { ownWords } from '../helpers/own-templates';

const q = (priority?: 'high' | 'normal' | 'low') => ({ taskId: 't', ...(priority ? { priority } : {}) });

describe('whether to pick clarifications up', () => {
  it('says nothing when there is nothing outstanding', () => {
    expect(decideClarificationFollowUp([], [q()])).toEqual({ action: 'stay-quiet' });
  });

  it('works through them when nothing else is open at all', () => {
    // The owner's first case, and it needs no comparison: there is nothing to be outranked BY.
    expect(decideClarificationFollowUp([q(), q()], [])).toEqual({ action: 'work-through', count: 2 });
  });

  it('stays quiet while something more urgent is genuinely open', () => {
    // Raising a question that is not urgent, over work that is, would be the assistant deciding its
    // own housekeeping outranks the person's work.
    expect(decideClarificationFollowUp([q('low')], [q('high')])).toEqual({ action: 'stay-quiet' });
  });

  it('works through them when they outrank what is open', () => {
    expect(decideClarificationFollowUp([q('high')], [q('low')])).toEqual({ action: 'work-through', count: 1 });
  });

  it('OFFERS when the ranks are equal, because equal means nothing established an order', () => {
    // The subtle one, and the reason this is not a tie-break. Priority is recorded rather than
    // inferred and most work carries the default, so equal ranks mean nobody weighed these against
    // each other - not that somebody did and found them balanced. Choosing either way would be
    // inventing a decision that was never made.
    expect(decideClarificationFollowUp([q('normal')], [q('normal')])).toEqual({ action: 'offer', count: 1 });
  });

  it('treats an unset priority as normal rather than as urgent or ignorable', () => {
    expect(decideClarificationFollowUp([q()], [q()])).toEqual({ action: 'offer', count: 1 });
  });

  it('ranks each side by its most urgent member', () => {
    // One high-priority question among several ordinary ones is a reason to act, and one high
    // priority task among ordinary work is a reason to wait.
    expect(decideClarificationFollowUp([q('low'), q('high')], [q('normal')]))
      .toEqual({ action: 'work-through', count: 2 });
    expect(decideClarificationFollowUp([q('normal')], [q('low'), q('high')]))
      .toEqual({ action: 'stay-quiet' });
  });
});

describe('what the person reads', () => {
  const item: ProposedItem = { messageId: 'm1', intent: 'new', label: 'the Q3 headcount', priority: 'normal' };
  const proposal = { items: [item], inFlightAmbiguous: false } as never;

  it('offers rather than announces when the order is not established', () => {
    const message = buildProposalMessage(proposal, [], { followUp: { action: 'offer', count: 2 } });

    expect(message).toMatch(/would you like me to work through them/i);
  });

  it('announces, but still leaves them able to decline, when nothing else is open', () => {
    // They may know something the ordering does not.
    const message = buildProposalMessage(proposal, [], { followUp: { action: 'work-through', count: 1 } });

    expect(message).toMatch(/unless you would rather I did not/i);
  });

  it('says a COUNT and never what any of them asked', () => {
    // Several people may be waiting on questions of their own, and this message is posted to the
    // room. That clarifications are outstanding is not private; what any of them says is - the same
    // discipline the private-request count already follows.
    const message = buildProposalMessage(proposal, [], { followUp: { action: 'offer', count: 3 } });

    expect(message).toContain('3');
    expect(message).not.toMatch(/the usual|headcount\?/);
  });

  it('reads correctly for exactly one', () => {
    // One template, worded so it reads for any count: no grammar is built here in one language
    // (tenets P5 and D11), so the count stands alone after a label rather than inside a phrase.
    const message = buildProposalMessage(proposal, [], { followUp: { action: 'offer', count: 1 } });

    expect(message).toContain('Earlier questions still waiting on an answer: 1.');
    expect(message).not.toMatch(/1 things/);
  });

  it('says nothing at all when the decision was to stay quiet', () => {
    const message = buildProposalMessage(proposal, [], { followUp: { action: 'stay-quiet' } });

    expect(message).not.toMatch(/still waiting on an answer/i);
  });

  it('lets a deployment word both halves, with the count substituted', () => {
    const offer = buildProposalMessage(proposal, [], {
      followUp: { action: 'offer', count: 2 },
      copy: ownWords({ clarificationsOffer: 'Noch {count} offene Fragen. Soll ich?' }) as never,
    });
    const working = buildProposalMessage(proposal, [], {
      followUp: { action: 'work-through', count: 2 },
      copy: ownWords({ clarificationsWorkingThrough: 'Ich nehme die {count} Fragen jetzt.' }) as never,
    });

    expect(offer).toContain('Noch 2 offene Fragen. Soll ich?');
    expect(working).toContain('Ich nehme die 2 Fragen jetzt.');
  });
});

/**
 * AND ANSWERING ONE HAS TO MOVE IT FORWARD (maintainer, 2026-09-03).
 *
 * A clarification stores the message's ID and none of its words, which is what keeps a targeted
 * request out of a row the room can read. Kept only that far the rule is half a rule: the row is safe
 * and the assistant is helpless. The person answers "I meant the Q3 one" against a task that
 * deliberately says nothing about what was asked, so their answer has nothing to attach to and the
 * question can never be closed.
 *
 * The other half is recovering the message at the one moment it is needed, for the one person
 * entitled to it - the clarification awaits its own requester, so the only turn that reaches this is
 * that person explaining their own message.
 */
describe('recalling the message a clarification is about', () => {
  const send = jest.fn();
  jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
    ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => send(...a) })),
    GetChannelMessageCommand: jest.fn().mockImplementation((i) => ({ input: i })),
  }));

  it('decodes what comes back, because the wire form is percent-encoded', async () => {
    // Handing the model `Produce%20a%20report` is the same defect as storing it that way, in the one
    // place where the assistant is trying to understand what somebody meant.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recallClarifiedMessage } = require('../../lambda/src/lib/queue-drain-task');
    send.mockResolvedValue({ ChannelMessage: { Content: 'the%20usual%20please' } });

    await expect(recallClarifiedMessage({
      channelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1',
      messageId: 'm1',
      botArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/bot/b1',
    })).resolves.toBe('the usual please');
  });

  it('returns nothing when the message is gone, rather than failing the turn', async () => {
    // Deleted or redacted since it was read. The assistant then has the answer and not the question,
    // which is worse than having both and far better than losing the turn.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recallClarifiedMessage } = require('../../lambda/src/lib/queue-drain-task');
    send.mockRejectedValue(new Error('NotFound'));

    await expect(recallClarifiedMessage({
      channelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1',
      messageId: 'gone',
      botArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/bot/b1',
    })).resolves.toBe('');
  });

  it('asks for nothing when it has no id to ask about', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recallClarifiedMessage } = require('../../lambda/src/lib/queue-drain-task');
    send.mockClear();

    await expect(recallClarifiedMessage({ channelArn: 'c', messageId: '', botArn: 'b' })).resolves.toBe('');
    expect(send).not.toHaveBeenCalled();
  });
});
