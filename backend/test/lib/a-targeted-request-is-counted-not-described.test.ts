/**
 * A TARGETED REQUEST IS COUNTED IN THE ROOM, NEVER DESCRIBED THERE.
 *
 * The proposal updates the turn placeholder, and `UpdateChannelMessage` carries no `Target` - so
 * every word of it is read by every member of the conversation. That makes the LABEL of a targeted
 * request a disclosure rather than a courtesy: a label is a short description of what somebody asked
 * for privately, and on the derived path it was the first 79 characters of their message verbatim.
 *
 * A security review found this: a member could occupy the turn, wait for somebody else to send the
 * assistant a targeted message, and read it in the proposal posted to the room. The targeting
 * machinery around it was all correct - per-message task visibility, private subjects, targeted
 * follow-ups - and the one thing a person actually reads was not.
 *
 * WHAT THE ROOM GETS IS A COUNT. That the queue held private requests is not itself private, since
 * the deferral notice already says how many messages are waiting. Whose, and about what, is.
 */

import { ownWords } from '../helpers/own-templates';
import {
  buildProposalMessage,
  publicProposalCount,
} from '../../lambda/src/lib/turn-triage-proposal';

const SECRET = 'draft my resignation letter to HR about Mallory';
const PUBLIC_LABEL = 'the Q3 headcount figure';

const proposal = {
  items: [
    { messageId: 'm1', intent: 'new' as const, priority: 'normal' as const, label: PUBLIC_LABEL },
    { messageId: 'm2', intent: 'new' as const, priority: 'high' as const, label: SECRET },
  ],
  inFlightAmbiguous: false,
};

describe('the room-visible proposal', () => {
  it('never contains a targeted request label', () => {
    const text = buildProposalMessage(proposal, [], { targetedIds: ['m2'] });

    // THE ASSERTION THE REVIEW ASKED FOR. A build that lists every item passes every other test in
    // the suite and publishes this string to everyone in the conversation.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('resignation');
  });

  it('still describes the requests the room could already read', () => {
    const text = buildProposalMessage(proposal, [], { targetedIds: ['m2'] });

    // Withholding everything would be its own failure: the untargeted request is the room's, and a
    // proposal that describes none of it is not a proposal anybody can correct.
    expect(text).toContain(PUBLIC_LABEL);
  });

  it('says how many were private, so the sender knows theirs arrived', () => {
    const text = buildProposalMessage(proposal, [], { targetedIds: ['m2'] });

    expect(text).toContain('Requests I will take up privately with whoever sent them: 1.');
  });

  it('counts them without naming a number of anything else', () => {
    const two = buildProposalMessage(
      { ...proposal, items: [...proposal.items, { messageId: 'm3', intent: 'new' as const, priority: 'low' as const, label: 'my expenses' }] },
      [],
      { targetedIds: ['m2', 'm3'] },
    );

    expect(two).toContain('whoever sent them: 2.');
    expect(two).not.toContain('my expenses');
  });

  it('describes everything when nothing was targeted', () => {
    // The ordinary case must not be made worse by the fix: with no targeting there is nothing to
    // withhold, and the proposal is the full list it always was.
    const text = buildProposalMessage(proposal, []);

    expect(text).toContain(PUBLIC_LABEL);
    expect(text).toContain(SECRET);
    expect(text).not.toMatch(/take up privately/i);
  });
});

describe('the model prose is refused when the batch was mixed', () => {
  /**
   * THE PART EASIEST TO GET WRONG. The reading is shown every queued message, targeted ones included,
   * and nothing in its contract tells it which the room may not see. So its paragraph is free to
   * narrate a private request into a message it has no way to know is public - and its voice is worth
   * a great deal, but not that.
   */
  const spoken = {
    ...proposal,
    spoken: `You asked about ${PUBLIC_LABEL}, and separately about ${SECRET}.`,
  };

  it('drops the paragraph and composes the list when something was targeted', () => {
    const text = buildProposalMessage(spoken, [], { targetedIds: ['m2'] });

    expect(text).not.toContain(SECRET);
    expect(text).toContain(PUBLIC_LABEL);
  });

  it('keeps the assistant own voice when nothing was targeted', () => {
    // The refusal is scoped to the case that needs it. A deployment's persona and the conversation's
    // language live in that paragraph, so discarding it whenever a queue exists would be a real loss.
    expect(buildProposalMessage(spoken, [])).toBe(spoken.spoken);
  });
});

describe('what a deployment may reword, and what it may not carry', () => {
  it('substitutes the count into deployment copy', () => {
    const copy = ownWords({ queuedPrivateCount: 'Also holding {count} private note(s) for their senders.' });

    expect(publicProposalCount(3, copy as never)).toBe('Also holding 3 private note(s) for their senders.');
  });

  it('falls back to the shipped line when a deployment says nothing', () => {
    expect(publicProposalCount(2)).toBe('Requests I will take up privately with whoever sent them: 2.');
  });
});

/**
 * AND THE SAME RULE ON THE PATH THAT ONLY RUNS WHEN SOMETHING WENT WRONG.
 *
 * A task write can fail, and what could not be recorded is named in the SAME room-visible message as
 * the proposal - so it is under the same rule. The itemised list was filtered and this was not, which
 * meant one throttled write put a private label in front of the whole room. A security review found
 * it; the fix above had left the hole.
 */
describe('what could not be recorded', () => {
  const lost = [proposal.items[1]];

  it('counts a private item it could not record, without naming it', () => {
    const text = buildProposalMessage(proposal, lost, { targetedIds: ['m2'] });

    expect(text).not.toContain(SECRET);
    expect(text).toContain('- Private requests among them: 1');
  });

  it('still names an untargeted item, because they cannot resend what they cannot identify', () => {
    const text = buildProposalMessage(proposal, [proposal.items[0]], { targetedIds: ['m2'] });

    expect(text).toContain(PUBLIC_LABEL);
  });

  it('names every lost item when nothing was targeted', () => {
    const text = buildProposalMessage(proposal, proposal.items, {});

    expect(text).toContain(PUBLIC_LABEL);
    expect(text).toContain(SECRET);
  });
});
