/**
 * The Lex-bypass tokens, defined ONCE for both sides of the decision.
 *
 * WHY THIS MODULE EXISTS. Two components have to agree, exactly, on what counts as a bypass:
 *
 *  - the **channel flow** matches a token and takes responsibility for the turn;
 *  - the **router** matches the same token on the LEX entry and stands down, so the turn is not
 *    answered twice in a channel where Chime `AUTO` routes every message.
 *
 * They used to declare their own copies, and they drifted the moment a second token appeared: the
 * flow got `/battle`, the router's guard kept testing `@all` alone, and a `/battle` in a 2-member
 * channel was answered by both entries. Nothing errored - two plausible answers arrived. The guard's
 * own comment already stated the rule it was failing to apply ("in a 1:1 AUTO routes EVERY message
 * regardless of mentions, so this handler IS invoked, and without this guard the turn is answered
 * twice"); it simply named one token.
 *
 * So the tokens live here and both sides import them. A third bypass token is then a change to one
 * file that both halves pick up, rather than a change to one half that reads as complete.
 *
 * FUNCTIONS, NOT EXPORTED REGEXES. A shared `/g` regex object carries `lastIndex` between callers,
 * so alternating `.test()` calls on one instance silently skip matches. The strip helpers need `g`
 * and the match helpers must not have it; exporting behaviour instead of patterns removes the whole
 * class of bug from the seam whose entire purpose is that two callers behave identically.
 *
 * Pure. No I/O.
 */

/** The tokens that take a turn away from Lex. A closed set - see `FLOW_BYPASS_TOKENS`. */
export type FlowBypassToken = '@all' | '/battle';

/**
 * Every bypass token, for the guard that asserts this list is complete. A fourth entry shape must be
 * a deliberate addition here, not a silent omission on one side of the seam.
 */
export const FLOW_BYPASS_TOKENS: readonly FlowBypassToken[] = ['@all', '/battle'] as const;

/**
 * `@all` is MENTION-SHAPED: it addresses everyone and may appear anywhere in the message, so it is
 * matched unanchored. `\b` is what keeps `@allison` and a bare "all" out - over-matching silences a
 * real turn, which is worse than the duplicate this guard prevents.
 */
const AT_ALL = /@all\b/i;
const AT_ALL_GLOBAL = /@all\b/gi;

/**
 * `/battle` is a SLASH COMMAND - a process invocation, parsed only at the start of the trimmed
 * message. Deliberately not mention syntax: `@`-tokens address a channel member, `/battle` triggers
 * the fan-out. Anchoring is load-bearing on BOTH sides and for opposite reasons: unanchored, the flow
 * would fan out a duel because someone wrote "try /battle sometime", and the router would silence a
 * turn the flow never claimed - leaving nobody to answer, which is the worse direction.
 */
const BATTLE_COMMAND = /^\s*\/battle\b/i;

/** Does this text carry `@all`? */
export function matchesAtAll(text: string): boolean {
  return AT_ALL.test(text);
}

/** Does this text invoke the `/battle` command? */
export function matchesBattleCommand(text: string): boolean {
  return BATTLE_COMMAND.test(text);
}

/** The message with every `@all` token removed, trimmed. */
export function stripAtAll(text: string): string {
  return text.replace(AT_ALL_GLOBAL, '').trim();
}

/** The message with a leading `/battle` command removed, trimmed. */
export function stripBattleCommand(text: string): string {
  return text.replace(BATTLE_COMMAND, '').trim();
}

/**
 * Which bypass token this message carries, or null.
 *
 * BOTH FORMS ARE TESTED because the caller cannot know which one carries the token: an unencoded
 * message matches the raw form, an encoded one matches the decoded form.
 *
 * WHAT THIS CANNOT DO, stated plainly because the older comments implied otherwise. When a malformed
 * `%` elsewhere in the message makes `decodeURIComponent` throw, the caller falls back to the raw
 * string - and `%40all` is not `@all`, so the token is unmatchable. Testing the raw form does not
 * rescue that case; nothing can. What matters is that BOTH sides fail identically: the flow does not
 * claim the turn and the router does not stand down, so an ordinary Lex turn answers it. Still one
 * responder, just not the bypass. Pinned by a test, so neither side gets "fixed" into disagreeing.
 *
 * `/battle` is checked FIRST. If a message somehow carries both, the command wins, matching the
 * flow's own precedence (a slash command is a process invocation; a mention is addressing).
 */
export function flowBypassToken(rawText: string, decodedText?: string): FlowBypassToken | null {
  const forms = decodedText !== undefined && decodedText !== rawText
    ? [decodedText, rawText]
    : [rawText];
  if (forms.some(matchesBattleCommand)) return '/battle';
  if (forms.some(matchesAtAll)) return '@all';
  return null;
}
