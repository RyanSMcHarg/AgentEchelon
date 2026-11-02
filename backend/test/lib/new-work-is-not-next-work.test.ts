/**
 * NEW WORK IS NOT NEXT WORK (maintainer, 2026-09-01; DESIGN 2.3 step 5).
 *
 * "Prioritise them, so the order the queue is worked is a decision rather than arrival order." The
 * decision was being made against the batch alone: `buildProposalMessage` ranked the arriving
 * messages against each other and printed them as a fresh list starting at 1, and the reading was
 * never told that work was already recorded here. Both halves of the same defect - a list ranked
 * only against itself is, in effect, the list that goes first, and nothing in the message the person
 * reads said otherwise.
 *
 * The queue this matters most for is the one that could not be read in a single pass: a message that
 * arrives late, or is stranded and comes back as new work, lands against a conversation that already
 * has open items. It has to take its place among them rather than displace them.
 *
 * ── A PRIVATE ROW TAKES ITS PLACE AND SAYS SO ───────────────────────────────────────────────────
 *
 * Extending the 2026-08-23 rule that a private task's existence is conversation-visible while its
 * detail is not. Its POSITION is occupancy, not content. Omitting it from the order would move every
 * item below it up a place and misstate the order for everyone - the position leak pointing the
 * other way.
 */
import {
  buildProposalMessage,
  triageContractDirective,
  type TriageProposal,
} from '../../lambda/src/lib/turn-triage-proposal';

const proposalOf = (items: TriageProposal['items']): TriageProposal => ({
  items,
  inFlightAmbiguous: false,
} as TriageProposal);

const NEW_HIGH = { messageId: 'm1', intent: 'new' as const, priority: 'high' as const, label: 'Q3 headcount' };
const NEW_LOW = { messageId: 'm2', intent: 'new' as const, priority: 'low' as const, label: 'tidy the deck' };

/** The numbered lines only, so the assertions are about ORDER and not about surrounding prose. */
const numbered = (text: string): string[] => text
  .split('\n')
  .filter((l) => /^\d+\. /.test(l))
  .map((l) => l.replace(/^\d+\.\s*/, ''));

describe('the order shown is the whole order, not just the new part', () => {
  it('places new work against the work already open here', () => {
    const text = buildProposalMessage(proposalOf([NEW_HIGH, NEW_LOW]), [], {
      openWork: [{ taskType: 'report_generation', priority: 'normal' }],
    });

    // High before the open normal, low after it. The arrival did NOT simply go first.
    expect(numbered(text)).toEqual([
      'Q3 headcount (new)',
      'report_generation',
      'tidy the deck (new)',
    ]);
  });

  it('does not displace work of equal priority that was already recorded', () => {
    // THE STABILITY ASSERTION, and it is the one a person would notice. At a tie the item they have
    // already been shown keeps its place and the arrival falls in behind it; the other way round,
    // every new message quietly promotes itself past work of the same urgency.
    const text = buildProposalMessage(
      proposalOf([{ ...NEW_HIGH, priority: 'normal' }]),
      [],
      { openWork: [{ taskType: 'report_generation', priority: 'normal' }] },
    );

    expect(numbered(text)).toEqual(['report_generation', 'Q3 headcount (new)']);
  });

  it('gives a private task its position and names it as private', () => {
    const text = buildProposalMessage(proposalOf([NEW_LOW]), [], {
      openWork: [{ private: true, priority: 'high' }],
    });

    const lines = numbered(text);
    expect(lines).toHaveLength(2);
    // It is IN the order, ahead of the low-priority arrival, because its priority says so.
    expect(lines[0]).toContain('private');
    expect(lines[1]).toBe('tidy the deck (new)');
    // And nothing about WHAT it is leaked into the message the room reads.
    expect(text).not.toContain('report_generation');
  });

  it('falls back to listing the new work alone when nothing else is open', () => {
    // The behavior before any of this existed, unchanged: a conversation with no open work has
    // nothing to rank against, and a header promising a comparison would be describing an empty one.
    const text = buildProposalMessage(proposalOf([NEW_HIGH, NEW_LOW]), []);

    expect(numbered(text)).toEqual(['Q3 headcount', 'tidy the deck']);
    expect(text).toContain('New, which I would take in this order:');
  });
});

describe('the reading is told to rank against the open work, and only when there is some', () => {
  it('says so when this conversation already has open work', () => {
    const directive = triageContractDirective(['m1'], false, false, true);
    expect(directive).toContain('RELATIVE TO THE OPEN WORK IN THIS CONVERSATION');
    // The instruction that makes a private row rankable rather than something to rank around.
    expect(directive).toContain('still holds a position');
  });

  it('stays silent when there is none', () => {
    // NOT VACUOUS DECORATION: an instruction to rank against a list that was never appended teaches
    // the model to invent one, which is the same failure the another-pass option is gated for.
    const directive = triageContractDirective(['m1'], false, false, false);
    expect(directive).not.toContain('RELATIVE TO THE OPEN WORK');
  });
});
