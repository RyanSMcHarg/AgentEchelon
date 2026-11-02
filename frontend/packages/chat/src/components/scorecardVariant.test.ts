/**
 * WHAT THE SCORECARD CALLS EACH SIDE OF A DUEL.
 *
 * The scorecard is the one view whose entire job is the comparison, so the label it puts at the top
 * of each column has to be the thing that distinguishes the two sides. It was built from the bot's
 * Amazon Chime SDK sender name alone, which made the columns read "Advisor" against "Alt-premium" -
 * the live assistant's identity against the alt's - while the message bubbles directly above them read
 * the two variant names the person actually asked to compare.
 *
 * The alt's identity cannot be renamed toward the variant either: the rename applier is scoped to a
 * single ARN (`RenameOwnIdentityOnly`) and the alt is not it. So the fix is for the scorecard to
 * prefer the same battle label the bubbles resolve, through the same `botMessageLabel` rule - not for
 * the identity to move.
 *
 * The mapper is exported for this file. It is pure, and the alternative is asserting a column header
 * through a full conversation render, which would test the shell rather than the decision.
 */
import { describe, it, expect } from 'vitest';
import { toScorecardVariant } from './ConversationInterface';
import type { Message } from '@ae/shared';

const FALLBACK = 'Assistant';

/** Only the fields the mapper reads; the rest of a Message is irrelevant here. */
const msg = (over: Partial<Message>): Message => ({ ...(over as Message) });

describe('what the scorecard calls each side of a duel', () => {
  it('leads with the VARIANT, so the two sides are tellable apart', () => {
    const side = toScorecardVariant(
      msg({ sender: { name: 'Alt-premium' }, battle: { label: 'Echo' } } as Partial<Message>),
      FALLBACK,
    );
    expect(side.label).toBe('Echo');
  });

  it('keeps the assistant principal, moved to the subtitle rather than dropped', () => {
    // WHO answered is still a real question - the config and per-step expanders are about it - so the
    // fix swaps the two facts round rather than discarding one.
    const side = toScorecardVariant(
      msg({ sender: { name: 'Alt-premium' }, battle: { label: 'Echo' } } as Partial<Message>),
      FALLBACK,
    );
    expect(side.persona).toBe('Alt-premium');
  });

  it('gives the two sides DIFFERENT headers where the identities alone would not', () => {
    // THE REGRESSION, STATED AS THE THING A READER SEES. Both sides carry an identity name, and those
    // names differ - so an assertion that the headers merely differ would have passed on the broken
    // build. What was wrong is that they named the wrong axis: the assistant, not the arm. This pins
    // both halves at once.
    const control = toScorecardVariant(
      msg({ sender: { name: 'Advisor' }, battle: { label: 'Atlas' } } as Partial<Message>),
      FALLBACK,
    );
    const treatment = toScorecardVariant(
      msg({ sender: { name: 'Alt-premium' }, battle: { label: 'Echo' } } as Partial<Message>),
      FALLBACK,
    );
    expect([control.label, treatment.label]).toEqual(['Atlas', 'Echo']);
  });

  it('falls back to the bot’s own name when the duel carried no variant label', () => {
    const side = toScorecardVariant(msg({ sender: { name: 'Advisor' } } as Partial<Message>), FALLBACK);
    expect(side.label).toBe('Advisor');
  });

  it('falls back to the TRANSLATED label when there is no name at all', () => {
    // The fallback stays a passed-in t() value; an English literal here would be the one part of the
    // header nobody could localize.
    const side = toScorecardVariant(msg({} as Partial<Message>), FALLBACK);
    expect(side.label).toBe(FALLBACK);
  });
});
