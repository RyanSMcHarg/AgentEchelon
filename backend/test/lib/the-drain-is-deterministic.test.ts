/**
 * THE DRAIN IS DETERMINISTIC, THE READING IS JUDGED, AND BOTH ALWAYS RUN (ADR-033, DESIGN 2.3.1).
 *
 * The judged reading decides WHAT the queued messages become. It does not decide WHETHER they leave
 * the queue. This file is the half of that rule that refuses.
 *
 * It is written because the opposite was built, and because the reasoning behind it was good. The
 * drain cleared the queue only when a reading parsed, on the grounds that a queue cleared with no
 * proposal behind it is a set of requests that silently never happened. Measured against the
 * deployment, the triage turn runs with the profile's persona and answers in PROSE: no `TRIAGE:`
 * lines, no `PROPOSAL:` marker, not even the `ANOTHER_PASS:` escape hatch. So the reading was refused
 * every time, the queue was never cleared, and the queued question was never answered at all. The
 * rule written to prevent silent loss produced it.
 *
 * A reading that fails must therefore degrade the QUALITY of the triage, never its completeness.
 */
import {
  deriveTriageProposal,
  parseTriageProposal,
} from '../../lambda/src/lib/turn-triage-proposal';

const PROSE = 'Sure - those two messages look like follow-ups, so I will fold them into what I am '
  + 'already writing and come back to you shortly.';

describe('a reading the model refused to give still drains the queue', () => {
  it('parses to nothing, which is what makes the derived reading necessary', () => {
    // The precondition for everything below, and the measured production case.
    expect(parseTriageProposal(PROSE, ['m1', 'm2'])).toBeNull();
  });

  it('derives one piece of work per queued message', () => {
    const derived = deriveTriageProposal([
      { messageId: 'm1', content: 'Also, what was our Q3 headcount?' },
      { messageId: 'm2', content: 'And can you list the three tools that process touches?' },
    ]);

    expect(derived).not.toBeNull();
    expect(derived!.items).toHaveLength(2);
    expect(derived!.items.map((i) => i.messageId)).toEqual(['m1', 'm2']);
    // Marked, because the copy has to say what it is rather than present a floor as a plan.
    expect(derived!.derived).toBe(true);
  });

  it('claims NOTHING it cannot know: never amends, never a priority', () => {
    // The judgement that just failed is exactly the judgement not to make here. Folding a message
    // into work in flight changes what that work produces, and a priority ordering asserts a
    // comparison nobody made. Being boring is what makes this safe to run unconditionally.
    const derived = deriveTriageProposal([
      { messageId: 'm1', content: 'Actually, keep it to one page.' },
    ]);

    // NOT `new` EITHER, which is what this asserted (maintainer, 2026-09-03).
    //
    // The rule in this test's own title is the reason: `new` is a claim about what the work IS, made
    // by a floor that understood nothing about the message. It opened a `queued_request` in
    // `proposed` - 'here is the work I propose to do' - so a reading that understood nothing produced
    // the most confident output this path can emit, and the person had to notice and correct it.
    //
    // `unclear` is the honest answer, and it moves: it opens a clarification the person can settle,
    // rather than a proposal they have to catch.
    expect(derived!.items[0].intent).toBe('unclear');
    expect(derived!.items[0].intent).not.toBe('amends');
    expect(derived!.items[0].priority).toBe('normal');
    expect(derived!.inFlightAmbiguous).toBe(false);
  });

  it('labels the work from the message, so a task list is recognisable', () => {
    const derived = deriveTriageProposal([
      { messageId: 'm1', content: '  Also,   what was our\n Q3 headcount?  ' },
    ]);

    // Whitespace flattened, because the label is a handle and not a transcript.
    expect(derived!.items[0].label).toBe('Also, what was our Q3 headcount?');
  });

  it('keeps a label a label, not a copy of the message', () => {
    // The task row is not where a person's words are stored: the queue refuses to hold content for
    // the same reason. A long message is truncated rather than copied whole.
    const long = 'x'.repeat(400);
    const derived = deriveTriageProposal([{ messageId: 'm1', content: long }]);

    expect(derived!.items[0].label.length).toBeLessThanOrEqual(80);
  });

  it('still produces a reading for a message with no readable text', () => {
    // An attachment-only message has no content to label with. It is still a request that arrived
    // while the assistant was busy, and dropping it here would be the silent loss all of this exists
    // to prevent.
    const derived = deriveTriageProposal([{ messageId: 'm1', content: '   ' }]);

    expect(derived!.items).toHaveLength(1);
    expect(derived!.items[0].label.trim().length).toBeGreaterThan(0);
  });

  it('returns nothing when there is nothing to derive from', () => {
    // NOT the model failing - the channel could not be read, so nothing has been captured and the
    // caller must leave the queue. Returning an empty reading here would let it clear a queue whose
    // messages became no work at all, which is the one case where holding them is correct.
    expect(deriveTriageProposal([])).toBeNull();
  });
});
