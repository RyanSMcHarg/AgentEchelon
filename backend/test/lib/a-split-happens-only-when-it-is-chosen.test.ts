/**
 * NOTHING MOVES UNLESS THE PERSON CHOSE IT, AND CHOSE WHICH (DESIGN 2.4.2).
 *
 * A person asked "shall I split this?" who answers "yes" has not said which parts they wanted apart.
 * An assistant acting on that yes has decided the exact thing it asked them to decide, and the cost
 * is not cosmetic: a subject moved out is a room they did not ask for, holding messages they did not
 * send there, and the conversation they were having is now missing part of itself.
 *
 * So the selection is DECLARED against the labels actually offered - the same rule the `TRIAGE:` lines
 * follow - and anything outside that closed set is refused rather than guessed.
 */

import {
  parseSplitSelection,
  selectionFromTheirWords,
  splitOfferDirective,
  stripSplitSelection,
} from '../../lambda/src/lib/turn-topic-split';

const OFFERED = [
  { label: 'billing', messageIds: ['m1', 'm3'] },
  { label: 'the failed deploy', messageIds: ['m2'] },
];

describe('reading which subjects the person chose', () => {
  it('takes the subjects they named, and only those', () => {
    expect(parseSplitSelection('SPLIT: billing\nSure, moving that one.', OFFERED)).toEqual({
      kind: 'selected',
      topics: [OFFERED[0]],
    });
  });

  it('takes several when several were named', () => {
    expect(parseSplitSelection('SPLIT: billing | the failed deploy', OFFERED)).toEqual({
      kind: 'selected',
      topics: [OFFERED[0], OFFERED[1]],
    });
  });

  it('hears no as a complete answer', () => {
    // Declining must be as easy to say as accepting, or the offer is a formality.
    expect(parseSplitSelection('SPLIT: none\nUnderstood, leaving it here.', OFFERED))
      .toEqual({ kind: 'declined' });
  });

  it('matches a label the model recapitalised', () => {
    // The label travels back through a model that may recase it, and a subject rejected over a
    // capital letter is one the person chose and did not get.
    expect(parseSplitSelection('SPLIT: Billing', OFFERED)).toEqual({
      kind: 'selected',
      topics: [OFFERED[0]],
    });
  });

  it('leaves the offer standing when the reply does not answer it', () => {
    // Silence is not refusal. Somebody who was asked and simply carried on talking has not declined,
    // and recording a no would dispose of a question they may still come back to.
    expect(parseSplitSelection('That deploy failed because the role was missing.', OFFERED)).toBeNull();
  });
});

describe('refusing what it cannot act on safely', () => {
  it('refuses a subject nobody offered, even alongside one that was', () => {
    // Acting on the half that parsed would split some of what they asked for and none of the rest,
    // and would open a conversation about a subject that was never on the table.
    expect(parseSplitSelection('SPLIT: billing | the pricing page', OFFERED)).toBeNull();
  });

  it('refuses an answer that both declines and selects', () => {
    expect(parseSplitSelection('SPLIT: none | billing', OFFERED)).toBeNull();
  });

  it('has nothing to select against when no offer is outstanding', () => {
    expect(parseSplitSelection('SPLIT: billing', [])).toBeNull();
  });

  it('does not read a selection out of a person quoting the contract back', () => {
    // The reply is the model's, but the person's words reach it, and a message that happens to
    // contain the marker must not be able to move their conversation. Only a line that STARTS with
    // it counts, so a quoted one contributes nothing to the decision.
    const selection = parseSplitSelection(
      [
        'SPLIT: billing',
        String.raw`You said "SPLIT: the failed deploy" earlier, which I did not.`,
      ].join(String.fromCharCode(10)),
      OFFERED,
    );

    expect(selection).toEqual({ kind: 'selected', topics: [OFFERED[0]] });
  });
});

describe('what the assistant is told while an offer is outstanding', () => {
  it('lists the subjects exactly as they were offered', () => {
    const directive = splitOfferDirective(OFFERED);

    expect(directive).toContain('  billing');
    expect(directive).toContain('  the failed deploy');
    expect(directive).toContain('SPLIT: none');
    // THE WORDS STAY THE MODEL'S (tenet D11): a machine line to declare what it heard, not a script
    // for the reply, which carries the deployment's persona and the conversation's language.
    expect(directive).toContain('reply to them normally, in your own voice');
  });

  it('says nothing at all when there is no offer outstanding', () => {
    expect(splitOfferDirective([])).toBe('');
  });

  it('keeps the machine line out of what the person reads', () => {
    expect(stripSplitSelection('SPLIT: billing\nMoving that one now.')).toBe('Moving that one now.');
  });
});

/**
 * ONE OF THREE, WHICH IS THE CASE THE RULE IS ACTUALLY ABOUT.
 *
 * A two-subject offer has only two interesting answers and both look like "yes" or "no". Three is
 * where per-subject choice stops being a distinction on paper: the person can take one and leave two,
 * and an implementation that treated any selection as "split it all" passes every two-subject test
 * while doing the one thing the design forbids.
 */
describe('choosing some of several', () => {
  const THREE = [
    { label: 'billing', messageIds: ['m1', 'm4'] },
    { label: 'the failed deploy', messageIds: ['m2'] },
    { label: 'the pricing page copy', messageIds: ['m3'] },
  ];

  it('takes exactly the one they named and leaves the other two alone', () => {
    const selection = parseSplitSelection('SPLIT: the failed deploy\nMoving that one.', THREE);

    // The other two are not merely absent from a list - they are still part of this conversation,
    // which is what the person chose by not naming them.
    expect(selection).toEqual({ kind: 'selected', topics: [THREE[1]] });
  });

  it('takes two of three, in the order they were named', () => {
    const selection = parseSplitSelection('SPLIT: the pricing page copy | billing', THREE);

    expect(selection).toEqual({ kind: 'selected', topics: [THREE[2], THREE[0]] });
  });

  it('carries the whole subject, not just the message that prompted it', () => {
    // Billing covers two messages, one of them a follow-up to the other. Moving a subject has to
    // move the subject: leaving the follow-up behind splits the thread rather than the conversation.
    const selection = parseSplitSelection('SPLIT: billing', THREE);

    expect(selection).toEqual({ kind: 'selected', topics: [THREE[0]] });
    expect((selection as { topics: typeof THREE }).topics[0].messageIds).toEqual(['m1', 'm4']);
  });

  it('still hears no when three were offered', () => {
    expect(parseSplitSelection('SPLIT: none', THREE)).toEqual({ kind: 'declined' });
  });
});

/**
 * THE ANSWER IN THEIR OWN WORDS, when the model does not emit the machine line.
 *
 * Observed live on a deployed turn: the offer was in front of the model, the person had answered
 * unambiguously, and it wrote 2102 characters with no SPLIT line - so the offer stayed open and could
 * be put to them a second time. The labels are a closed set this system recorded and the person's
 * message is already in hand, so the answer is readable without the model.
 *
 * These pin the CONSERVATISM, which is the part that matters: the failure this must never have is
 * splitting a conversation nobody asked to split.
 */
describe('an answer given in the person own words', () => {
  const OFFERED = [
    { label: 'Q3 headcount', messageIds: ['m1'] },
    { label: 'Internal process tooling', messageIds: ['m2'] },
    { label: 'Pricing page accuracy', messageIds: ['m3'] },
  ];

  it('takes the subject they named, and only that one', () => {
    const s = selectionFromTheirWords('Just split out Q3 headcount please, leave the rest here.', OFFERED);
    expect(s?.kind).toBe('selected');
    expect((s as { topics: Array<{ label: string }> }).topics.map((t) => t.label)).toEqual(['Q3 headcount']);
  });

  it('takes two when they name two', () => {
    const s = selectionFromTheirWords('please move Q3 headcount and pricing page accuracy to their own conversation', OFFERED);
    expect((s as { topics: Array<{ label: string }> }).topics.map((t) => t.label))
      .toEqual(['Q3 headcount', 'Pricing page accuracy']);
  });

  it('hears a refusal', () => {
    expect(selectionFromTheirWords('no thanks, keep it all here', OFFERED)?.kind).toBe('declined');
  });

  it('does NOT split because a subject was mentioned in passing', () => {
    // The whole risk of reading their words instead of a machine line. This names a label and answers
    // nothing; acting on it would move a conversation nobody asked to move.
    expect(selectionFromTheirWords('what was our Q3 headcount again?', OFFERED)).toBeNull();
  });

  it('does NOT guess when the intent is there but no subject is nameable', () => {
    // Leaving it open asks again, which is recoverable. Splitting the wrong subject is not.
    expect(selectionFromTheirWords('yes please split that one out', OFFERED)).toBeNull();
  });

  it('says nothing about a turn that is not an answer at all', () => {
    expect(selectionFromTheirWords('thanks, that is helpful', OFFERED)).toBeNull();
  });
});

/**
 * A REFUSAL OUTRANKS A NAME (code review, 2026-09-04).
 *
 * `selectionFromTheirWords` computed `refuses` and then returned `{kind:'selected'}` on any named
 * label without ever consulting it - while the comment directly above claimed a refusal is checked
 * first. So "no, don't split the Q3 headcount question - keep it here" named a label, matched, and
 * SPLIT IT: the assistant did the exact thing the person had just said not to do, and cleared the
 * offer so they could not say it again.
 *
 * This is the fallback that runs whenever the model omits its `SPLIT:` line, which is the common
 * case, so it decides ordinary replies rather than edge ones.
 */
describe('what somebody says NO to is not what they asked for', () => {
  it('declines when they refuse and name the subject they are protecting', () => {
    // The exact sentence that used to split it.
    expect(selectionFromTheirWords("no, don't split the billing question - keep it here", OFFERED))
      .toEqual({ kind: 'declined' });
  });

  it('still declines a bare refusal that names nothing', () => {
    expect(selectionFromTheirWords('no thanks, leave them together', OFFERED))
      .toEqual({ kind: 'declined' });
  });

  it('declines rather than half-obeying a sentence that both refuses and asks to move', () => {
    // The rare genuine mix. Declining is the recoverable half: they can ask again for the part they
    // wanted, where moving a subject they were protecting cannot be undone. It is also unavoidable -
    // "don't split" contains "split", so the two patterns overlap on the commonest refusal there is.
    expect(selectionFromTheirWords(
      "don't split billing, but move the failed deploy to its own conversation", OFFERED,
    )).toEqual({ kind: 'declined' });
  });

  it('still selects when they only ask to move, with no refusal in the sentence', () => {
    // The fix must not swallow the ordinary case: this is what the offer exists to accept.
    expect(selectionFromTheirWords('please move billing to its own conversation', OFFERED))
      .toEqual({ kind: 'selected', topics: [OFFERED[0]] });
  });
});
