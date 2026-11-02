/**
 * WHAT AN ASSISTANT SAYS IT DOES, assembled from what it actually recognizes.
 *
 * WHY THIS IS DERIVED. An assistant's capabilities were authored twice: once as the intent pack, which
 * decides what it recognizes, and once as prose in the onboarding greeting, which tells a person what
 * it covers. Two statements of one fact, maintained by hand, on the same profile - so editing the pack
 * left the greeting lying, and nothing failed. One source per question (tenet D7) says the sentence a
 * person reads is assembled from the taxonomy that actually decides.
 *
 * WHY HALF OF IT IS STILL AUTHORED. Absence is not a phrase. A pack says what an assistant recognizes
 * and says nothing about what it does not, so "I cannot see customer accounts" cannot be derived from
 * it at all - and in a conversation holding several assistants that sentence is the one that tells
 * somebody to ask a different one. It is `boundary` on the profile, written once, next to everything
 * else about the assistant.
 *
 * WHY THE FRAME IS CONFIGURATION. Every word here reaches a person, so it carries the assistant's
 * persona and the conversation's language or it is the platform speaking over them (tenets P5 and D11).
 * The connective tissue - how a list is introduced, how the boundary is joined to it - is `copy`, with
 * shipped English as the fallback per key, exactly as every other platform-spoken line works. A
 * hardcoded "I can help with:" would be the same defect this module exists to remove, in a new place.
 *
 * WHAT THIS IS NOT. Not a router and not an advertisement to other assistants. It answers "what does
 * this assistant do" for a PERSON. A primary reading its roommates' capabilities in order to delegate
 * is a different consumer with a different shape, and it is not built.
 */
import {
  advertisedIntents,
  MAX_ADVERTISED_IN_INTRODUCTION,
  type IntentPack,
} from './intent-pack.js';

/** The pieces a caller needs to say what an assistant does. Assembled, never concatenated here: the
 *  joining words are the deployment's, so this returns parts rather than a sentence. */
export interface CapabilityStatement {
  /** Advertised intents, in declaration order, capped for an introduction when `forIntroduction`. */
  does: string[];
  /** The authored limit line, when the profile carries one. */
  boundary?: string;
  /** True when `does` was truncated, so a caller can offer the rest rather than pretending that is all. */
  truncated: boolean;
}

export interface CapabilityInput {
  pack?: IntentPack;
  boundary?: string;
  /**
   * An INTRODUCTION is capped; an answer to "what can you do" is not.
   *
   * The same content serves both and they fail differently. An introduction competes with a person's
   * patience on first contact, so four items is already generous. Somebody who ASKED has opted into a
   * longer answer, and truncating it there would be withholding the thing they asked for.
   */
  forIntroduction?: boolean;
}

/**
 * Assemble what this assistant says it does.
 *
 * Returns empty `does` when the pack advertises nothing, which is the shipped default: `summary` is
 * optional and absent means recognized-but-not-advertised. A caller with nothing to say must say
 * nothing rather than emit an empty list, and that is the caller's decision because only the caller
 * knows what it was going to wrap the list in.
 */
export function capabilityStatement(input: CapabilityInput): CapabilityStatement {
  const all = advertisedIntents(input.pack).map((a) => a.summary);
  const cap = input.forIntroduction ? MAX_ADVERTISED_IN_INTRODUCTION : all.length;
  const boundary = input.boundary?.trim() || undefined;
  return {
    does: all.slice(0, cap),
    ...(boundary ? { boundary } : {}),
    truncated: all.length > cap,
  };
}

/** True when there is nothing to say - no advertised intent and no authored boundary. Callers use this
 *  rather than checking `does.length`, because a boundary with no capabilities is still worth saying. */
export function isEmptyStatement(s: CapabilityStatement): boolean {
  return s.does.length === 0 && !s.boundary;
}
