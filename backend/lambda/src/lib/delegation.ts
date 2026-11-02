/**
 * WHETHER THIS TURN BELONGS TO A ROOMMATE, decided from what roommates advertise.
 *
 * The decision only - no transport, no message, no model client. It takes the message, the roommates
 * and a classify function, and returns one of three answers. Kept separate from the router because a
 * routing rule mixed into a 5000-line handler is a rule nobody can test, and this one has to be
 * testable: it decides when a person's question goes to somebody else.
 *
 * ── IT IS ONLY ASKED ON A FALL-THROUGH ───────────────────────────────────────────────────────────
 *
 * The caller asks this after its own classifier has landed on a universal intent - `general` in
 * practice - which is the taxonomy's own way of saying "I did not recognize this as my work". An
 * assistant that recognized the work answers it and never gets here. That ordering is what keeps the
 * cost off every ordinary turn, and it is the caller's to enforce.
 *
 * ── THE SPECIALIST'S OWN LINES ARE THE CATEGORIES ────────────────────────────────────────────────
 *
 * The advertisement publishes `(key, person-facing summary)` and deliberately NOT the `description` a
 * classifier is normally shown, because a description is written to separate one intent from its
 * neighbors inside one pack and is nobody else's business. So the summaries become the categories: a
 * synthesized pack whose `description` is the roommate's own advertised line. One classifier call for
 * the whole room rather than one per roommate, and the model is choosing between sentences a person
 * could have read, which is the same basis a person uses when they pick who to ask.
 *
 * ── AMBIGUITY ASKS RATHER THAN PICKS ─────────────────────────────────────────────────────────────
 *
 * Two roommates advertising one key returns `ask`. Choosing silently would make the answer depend on
 * which assistant happened to be listed first, which is an order nobody can see and nothing records.
 */
import type { IntentPack } from './intent-pack.js';
import { UNIVERSAL_INTENT_KEYS } from './intent-pack.js';
import { roommateForKey, type Roommate } from './assistant-advertisement.js';

/** What the caller should do with this turn. */
export type DelegationDecision =
  /** Nobody advertises it, or the classifier did not place it. This assistant answers. */
  | { kind: 'keep'; reason: 'no-roommate-advertises-it' | 'not-placed' | 'no-roommates' | 'mine' }
  /** One roommate owns it. Hand the turn over and stand down. */
  | { kind: 'handover'; roommate: Roommate; key: string }
  /** More than one owns it. Name them and let the person choose. */
  | { kind: 'ask'; roommates: Roommate[]; key: string };

/**
 * A pack whose categories are the roommates' advertised lines.
 *
 * EXPORTED SO THE PROMPT IS TESTABLE. What the classifier is shown decides where a person's question
 * goes, so "the summaries are the categories" is an assertion rather than a comment.
 *
 * Keys are prefixed, because two roommates may advertise the same key and the classifier must be able
 * to name one of them. The prefix is stripped on the way back.
 */
export function withRoommateCategories(ownPack: IntentPack | undefined, roommates: Roommate[]): IntentPack {
  return {
    ...(ownPack ?? { intents: [] }),
    intents: [
      // THE ASSISTANT'S OWN INTENTS KEEP THEIR REAL KEYS AND THEIR REAL DESCRIPTIONS. A `description` is
      // written to separate one intent from its neighbors for exactly this classifier, so it is a better
      // discriminator than the person-facing summary - and keeping the key means a turn the assistant
      // keeps flows on untouched, with its own delivery option and model route.
      ...(ownPack?.intents ?? []),
      // THE ROOMMATES' ADVERTISED LINES JOIN AS CATEGORIES, keyed so that choosing one is unambiguously a
      // routing answer rather than a claim. They carry the SUMMARY as their description, because the
      // summary is all a peer publishes - a specialist's own `description` is written for its own pack
      // and is nobody else's business.
      ...roommates.flatMap((r) => r.advertisement.intents.map((i) => ({
        key: delegationKey(r.assistant, i.key),
        description: i.summary,
      }))),
    ],
  } as IntentPack;
}

/** The synthetic category key for one roommate's advertised intent. */
export function delegationKey(assistant: string, intentKey: string): string {
  return `delegate__${assistant}__${intentKey}`;
}

/** Split a synthetic key back into the assistant and the intent it named. */
export function parseDelegationKey(key: string): { assistant: string; intentKey: string } | null {
  if (!key.startsWith('delegate__')) return null;
  const rest = key.slice('delegate__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  return { assistant: rest.slice(0, sep), intentKey: rest.slice(sep + 2) };
}

/**
 * Decide where this turn goes.
 *
 * `classify` is injected rather than imported so this is testable without a model, and so the caller
 * keeps control of which model classifies - a routing decision should not quietly pick a different
 * model from the one the deployment configured for classification.
 *
 * FAILS TOWARD KEEPING THE TURN. A classify that throws, returns nothing, or returns a key this
 * function did not offer means the assistant answers as it would have anyway. That is tenet D5: this is
 * a best-effort side path on the reply path, and a routing improvement must never cost a person their
 * answer.
 */
export function decideDelegation(input: {
  /** The key this turn's ONE classification produced, over the merged pack. */
  classifiedIntent: string;
  roommates: Roommate[];
}): DelegationDecision {
  if (input.roommates.length === 0) return { kind: 'keep', reason: 'no-roommates' };
  const placed = input.classifiedIntent;
  // A universal intent is the classifier declining to place the message among the offered categories.
  if (!placed || (UNIVERSAL_INTENT_KEYS as readonly string[]).includes(placed.toLowerCase())) {
    return { kind: 'keep', reason: 'not-placed' };
  }
  // NOT A DELEGATION KEY MEANS IT IS ONE OF THIS ASSISTANT'S OWN, which is the common answer and needs no
  // special case: the turn continues with the intent it was classified as, carrying that intent's own
  // delivery option and model route. This is the whole saving of one pass - a question the assistant
  // serves is decided by the same call that would have classified it anyway.
  const parsed = parseDelegationKey(placed);
  if (!parsed) return { kind: 'keep', reason: 'mine' };

  const owner = roommateForKey(input.roommates, parsed.intentKey);
  if (owner.kind === 'none') return { kind: 'keep', reason: 'no-roommate-advertises-it' };
  // AMBIGUITY ASKS EVEN THOUGH THE KEY NAMES ONE ASSISTANT. Two roommates advertising one key produce two
  // categories with the SAME description, so which of them a model picks is a coin flip - and a coin flip
  // is exactly what "refuse to choose and ask" exists to stop being mistaken for a decision.
  if (owner.kind === 'ambiguous') return { kind: 'ask', roommates: owner.roommates, key: parsed.intentKey };
  // The prefix carries the model's choice; the ownership lookup is the authority. A disagreement means the
  // model named a roommate that does not advertise the key it picked, so the turn stays here.
  if (owner.roommate.assistant !== parsed.assistant) return { kind: 'keep', reason: 'not-placed' };
  return { kind: 'handover', roommate: owner.roommate, key: parsed.intentKey };
}

/**
 * THE INTENT A TURN KEEPS WHEN IT WAS NOT HANDED OVER.
 *
 * A roommate's key is a routing answer, not an intent: it exists only so the classifier can name
 * another assistant's work. When the turn stays here (no handover was posted, or delegation does not
 * apply to it), carrying the synthetic key on would name a delivery option, a model route and an
 * archived intent after a category this assistant does not have. Measured live: two resumed duel turns
 * archived as `delegate__advisor__report_generation`, never paired, and fell out of every breakdown.
 *
 * So the key is read back into this assistant's own taxonomy: the intent it named when this assistant
 * declares it too, otherwise `general`, the universal fall-through. Any other intent is returned as is.
 */
export function intentKeptHere(intent: string, ownPack: Pick<IntentPack, 'intents'> | undefined): string {
  const parsed = parseDelegationKey(intent);
  if (!parsed) return intent;
  return (ownPack?.intents ?? []).some((i) => i.key === parsed.intentKey) ? parsed.intentKey : 'general';
}
