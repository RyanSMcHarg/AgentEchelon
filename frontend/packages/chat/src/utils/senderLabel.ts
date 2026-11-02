/**
 * WHAT TO CALL THE ASSISTANT THAT SENT A MESSAGE, decided in one place.
 *
 * The rule was an inline `||` chain repeated at four render sites, and they disagreed: the
 * per-message header ignored the sender's name entirely and printed a constant, while the battle
 * scorecard and the battle placeholder preferred it. So an assistant renamed through its profile
 * appeared under its new name in one part of the conversation and as "Assistant" in another.
 *
 * THE ORDER, most specific to least:
 *   1. The BATTLE VARIANT label (Atlas / Echo). During a duel the two sides must be distinguishable
 *      from each other, which is a stronger requirement than naming the assistant.
 *   2. The ASSISTANT'S OWN NAME, carried on the message's Amazon Chime SDK sender. This is what a
 *      profile rename changes (DESIGN-SEPARATE-ASSISTANTS 3.0), and skipping it is what made every
 *      assistant read as "Assistant" - harmless while a classification had exactly one, and wrong
 *      the moment it has two, because both then render as the same word.
 *   3. A TRANSLATED fallback, supplied by the caller. It stays a t() key rather than an English
 *      literal: the fallback is copy, only the name itself is data.
 *
 * Whitespace-only names are treated as absent - a name made of spaces is not a name, and it would
 * render as a blank where a label belongs.
 */
export function botMessageLabel(opts: {
  /** The resolved battle variant label, when this message is part of a duel. */
  battleVariantLabel?: string | null;
  /** The sender name carried on the message (Amazon Chime SDK `Sender.Name`). */
  senderName?: string | null;
  /** Translated label for a message whose sender carries no name. */
  fallback: string;
}): string {
  const battle = opts.battleVariantLabel?.trim();
  if (battle) return battle;
  const sender = opts.senderName?.trim();
  if (sender) return sender;
  return opts.fallback;
}
