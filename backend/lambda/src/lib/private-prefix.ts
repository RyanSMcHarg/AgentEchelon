/**
 * The private prefix, `.<member>`, resolved against the conversation's roster (ADR-034).
 *
 * WHAT THE RULE IS. A leading dot applies a `Target` only when it is followed by
 * the name of an ACTUAL member of this conversation, matched in FULL. The web client autocompletes
 * the name so a person picks a real one; the backend re-derives the same answer from the roster,
 * because a client is not the authority on who is in a room.
 *
 * Anything else is not a private prefix. ".env is missing" is a sentence about a file, and treating a
 * name-shaped token as an address - or refusing to send it - makes the feature cost more than it is
 * worth in any room where people discuss code.
 *
 * ── WHY THIS IS A SEPARATE MODULE FROM `flow-bypass.ts` ──
 *
 * The two grammars use two mechanisms and it matters that the code says so. An `@` token is routed by
 * AgentEchelon: the flow resolves it and invokes the destination, which is what `flow-bypass.ts`
 * decides. A `.` token is routed by Amazon Chime SDK from the `Target` the composer set, and the flow
 * must NOT claim that turn - the service is already delivering it. Putting the dot in the bypass
 * module would invite exactly that mistake.
 *
 * ── WHAT THE CHANNEL FLOW CAN AND CANNOT ENFORCE, stated because the limit is real ──
 *
 * The flow sees CONTENT, so it can decide what the text means and hold both sides to one definition.
 * It does NOT see `Target`: the channel-flow callback carries `Content`, `Persistence`, `Sender`,
 * `Type`, `MessageId`, `CreatedTimestamp`, `ChannelArn`, `PushNotification` and, when present,
 * `Metadata` - and no `Target` (measured 2026-08-14, ADR-029). So the flow cannot verify from its
 * callback that a message claiming to be private actually carries a `Target`, nor strip one that
 * should not be there.
 *
 * WHAT IT DOES INSTEAD, for the one direction that discloses: a message this module resolves to a
 * member is read back from storage, and one with no `Target` is dropped and its sender told
 * (`enforcePrivateAddressTarget` in `private-command.ts`, owner 2026-09-15). That check lives there
 * because it does I/O; this module stays the pure definition of what the text means.
 *
 * The enforcement of PRIVACY itself stays at the composer and at Amazon Chime SDK. A client that sets
 * a `Target` without a matching token still gets a private message - the service delivers what it was
 * told - and no backend rule objects. Said plainly rather than implied, because a reader could
 * otherwise take this module for a guarantee it is not able to make.
 *
 * Pure. No I/O.
 */

import type { BypassMember } from './flow-bypass.js';

/**
 * The token after a leading dot, or null.
 *
 * ANCHORED, and the anchor is load-bearing. Unanchored, a decimal, a file extension or an ellipsis
 * mid-sentence becomes an address - "call me at 5.sam" would make private a message meant for the
 * room.
 *
 * ── THE TOKEN IS EVERYTHING UP TO THE SPACE, NOT A CHARACTER CLASS ──
 *
 * This used to read `[A-Za-z0-9._-]`, which has no `@` in it. On a deployment where members are named
 * by their email address that excluded every human being: `.someone@example.com hello` matched
 * nothing, so the message was not private and went to the whole room. The class was doing safety work
 * it was never the right tool for.
 *
 * THE SAFETY COMES FROM THE ROSTER, and it always did. A token means something only when it equals a
 * member's name in full, so over-matching costs nothing: `.env is missing` extracts `env`, which
 * names nobody, and the message is ordinary text. Widening the token therefore cannot make a message
 * private by accident - it can only let a real name through that the class was rejecting.
 *
 * Bounded, so a pathological message cannot hand a large string to the roster comparison.
 *
 * The trailing space is required: `.Sam` alone is somebody still typing, and a token only means
 * something once it is finished. The same rule the composer decorates on.
 *
 * ── A RENDERING COMMAND MAY COME FIRST, and the address still has to be found behind it ──
 *
 * `/md` says how to display a message; `.name` says who may read it. They are different questions and
 * they compose - "format this, and send it to Sam alone" is an ordinary thing to want. But both
 * grammars are ANCHORED, so with the command in front the address stopped being seen: the composer
 * set the Target (it parses the command off first) while the chip and the picker, which read the raw
 * input, saw nothing. Privacy was applied and INVISIBLE - and the decoration is the entire mechanism
 * that lets somebody confirm it before they commit. A mistyped name then produced a public message
 * with no signal either way.
 *
 * So the command is consumed and KEPT: captured as group 1 and put back by `stripPrivatePrefix`,
 * because it is part of what the person wrote and only the address is lifted out for the model.
 */
const PRIVATE_PREFIX = /^\s*(\/md\s+)?\.(\S{1,128})\s/i;

/**
 * The DELIMITED form, `.<Full Name>`, which is how a name containing a space is addressed.
 *
 * ── WHY A DELIMITER, AND WHY THIS ONE ──
 *
 * The bare token ends at the first space, so it cannot express "Ryan McHarg": the token would be
 * `Ryan`, which names nobody, and a message the person believed was private would go to the room.
 * Since what follows the dot must BE a member's name - that is the whole mechanism, name resolved to
 * an id - a grammar that cannot express some names is a grammar that cannot do its job.
 *
 * ANGLE BRACKETS ARE THE CONVENTION every major client already uses to delimit a mention target:
 * Slack `<@U123>`, Discord `<@123>`, Google Chat `<users/123>`, and Microsoft Teams `<at>Name</at>`,
 * which like this one puts the NAME inside rather than an id. Following it means the shape is already
 * familiar and there is no new idea to explain.
 *
 * SAFE IN OUR RENDERER, which is the reason the obvious alternatives were rejected. A private prefix
 * only ever appears in a USER message, and user messages render as React-escaped plain text, so the
 * brackets survive to the reader exactly as typed. Zulip's `@**Name**` would have been the other
 * precedent and is wrong here - bot messages DO render through remark-gfm, where `**` is bold and the
 * delimiters vanish.
 *
 * SELF-TERMINATING, so unlike the bare form it needs no trailing space to be finished: `>` ends the
 * name. The name may hold anything except the brackets themselves and a newline.
 */
const PRIVATE_PREFIX_DELIMITED = /^\s*(\/md\s+)?\.<([^<>\n]{1,128})>(?:\s|$)/i;

/**
 * The token after a leading dot, delimited or bare, or null.
 *
 * DELIMITED FIRST, because it is unambiguous: `.<a b> c` can only be an address, while the bare
 * pattern would read `<a` as a name. The bare form stays because it is what a person types for an
 * ordinary name and reads better in the message the recipient sees - `.Alice hello` rather than
 * `.<Alice> hello`. The picker inserts whichever the name requires.
 */
export function privatePrefixToken(text: string): string | null {
  const delimited = PRIVATE_PREFIX_DELIMITED.exec(text);
  if (delimited) return delimited[2];
  const m = PRIVATE_PREFIX.exec(text);
  return m ? m[2] : null;
}

/**
 * THE ADDRESS, SPLIT INTO WHAT A PERSON READS AND WHAT THE ROSTER IS SEARCHED BY.
 *
 * ── WHY AN ID AT ALL ────────────────────────────────────────────────────────────────────────────
 *
 * A display name is not unique. A person's falls back to the email local part
 * (`credential-exchange.ts`), so two members can genuinely carry one name, and `resolvePrivateTarget`
 * has had to break the tie by preferring assistants - a rule that is deterministic but is still a
 * guess about who was meant, and one that leaves a person sharing an assistant's name unaddressable.
 *
 * THE CLIENT ALREADY KNOWS. The composer's picker holds the member it inserted and sets `targetArn`
 * on the send; only the flow cannot see that, because a channel-flow callback carries no `Target`. So
 * the id travels where the flow CAN read it - in the text, next to the name.
 *
 * `.<Alice|sub-abc123>` is what the picker writes. The bare and undelimited forms are untouched, so
 * `.Alice` typed by hand, or arriving over SMS or email, resolves exactly as it always has.
 *
 * ── THE ID IS A SELECTOR INSIDE THE ROOM, NEVER A REACH OUTSIDE IT ──────────────────────────────
 *
 * The body is written by the sender, so a crafted id has to be assumed. It is resolved against THIS
 * channel's roster and nothing else, so the worst a forged one can do is name somebody already in the
 * conversation - which the sender could address by name anyway. It narrows a guess; it grants nothing.
 */
export interface PrivateAddress {
  /** What the person reads, and the fallback the roster is searched by. */
  name: string;
  /** The member id the picker wrote, when it wrote one. */
  id?: string;
  /**
   * The token exactly as written, before any split.
   *
   * KEPT BECAUSE THE SPLIT IS A GUESS ABOUT A NAME. A member genuinely called `A|B`, addressed by
   * hand, parses as the name `A` with the id `B` - and resolving that would address the wrong person,
   * which is the failure this whole change exists to remove. So the raw token stays available as the
   * last thing tried, and a name holding a separator keeps working rather than being banned from
   * private addressing the way `<` and `>` are.
   */
  raw: string;
}

export function parsePrivateAddress(text: string): PrivateAddress | null {
  const token = privatePrefixToken(text);
  if (!token) return null;
  // SPLIT ON THE LAST SEPARATOR, so `A|B|sub-123` reads as the name `A|B` with the id `sub-123`.
  const cut = token.lastIndexOf('|');
  if (cut <= 0 || cut === token.length - 1) return { name: token, raw: token };
  return { name: token.slice(0, cut), id: token.slice(cut + 1), raw: token };
}

/**
 * WHICH MEMBER A `.` PREFIX ADDRESSES PRIVATELY, or null when it addresses nobody.
 *
 * FULL MATCH, NOT A PREFIX MATCH, and the difference is the whole rule. `@` resolution uses word
 * boundaries because a mention sits inside a sentence; a private prefix IS the whole token, so
 * "`.Sam`" must equal a member's name and not merely begin one. `.Sam` in a room holding Samantha
 * and no Sam addresses nobody, and the message goes to the room - which is right, because the
 * composer showed no "Private to ..." decoration while it was being typed.
 *
 * Case-insensitive, because a name is not a password.
 */
export function resolvePrivateTarget(
  text: string,
  members: readonly BypassMember[],
): BypassMember | null {
  const address = parsePrivateAddress(text);
  if (!address) return null;
  // ── THE ID WINS, WHEN THE PICKER WROTE ONE ──────────────────────────────────────────────────────
  //
  // Resolved against this channel's roster only (see `parsePrivateAddress`), so it selects among the
  // people already here rather than reaching past them. An id that names nobody in the room falls
  // through to the name, because a stale or mistyped id should address whoever the NAME says rather
  // than silently addressing nobody - the message still goes to the room either way, and the composer
  // showed the person what it had resolved while they typed.
  //
  // This is also where the assistants-win tie-break stops applying to picker-written addresses: the
  // client knew which member it meant, so there is nothing left to break a tie about. The rule below
  // still governs a hand-typed name, where the ambiguity is real.
  const id = address.id;
  if (id) {
    const byId = members.find((m) => m.arn && m.arn.split('/').pop() === id);
    if (byId) return byId;
  }
  // THE RAW TOKEN IS TRIED TOO, and after the split name rather than before it, so the ordinary case
  // is unaffected and only a name that actually contains a separator reaches it.
  const wanted = address.name.toLowerCase();
  const rawWanted = address.raw.toLowerCase();
  const named = (m: BypassMember) => !!m.name
    && (m.name.toLowerCase() === wanted || m.name.toLowerCase() === rawWanted);
  // AN ASSISTANT OF THAT NAME WINS OVER A PERSON OF THAT NAME, and the rule exists because the
  // alternative was ROSTER ORDER deciding it.
  //
  // This used to be a single `find` across every member, so `.Atlas` in a room holding an assistant
  // called Atlas and a person called Atlas resolved to whichever the membership page happened to list
  // first. That is not a defensible answer to "who did they mean", and it had a concrete consequence:
  // the private-address check compares this answer against the stored `Target`, so resolving to the
  // person while the composer had targeted the assistant reported the sender's correct message as
  // misdirected (`lib/private-command.ts`).
  //
  // ASSISTANTS WIN because their names are deployment-controlled and unique per assistant, while a
  // person's display name is not: it falls back to the email local part (`credential-exchange.ts`), so
  // two members can genuinely carry one name and nothing prevents one of them matching an assistant.
  // Deterministic and stated beats first-past-the-post.
  //
  // WHAT THIS DOES NOT FIX, said plainly: a person who shares a name with an assistant cannot be
  // addressed privately by that name at all now, where before they could be reached by accident of
  // ordering. Both are wrong; this one is at least predictable and explains itself. The real fix is in
  // the composer's picker, which renders only the name and so cannot show which one is being chosen -
  // a second line under each entry is where picking the wrong `atlas` actually stops.
  return members.find((m) => m.isBot && named(m))
    ?? members.find(named)
    ?? null;
}

/** Does this text even begin with something dot-shaped? A cheap gate, so an ordinary message never
 *  costs a roster read to answer a question its first character already settles. */
export function mightAddressPrivately(text: string): boolean {
  return PRIVATE_PREFIX.test(text) || PRIVATE_PREFIX_DELIMITED.test(text);
}

/**
 * The message with a RESOLVED private prefix removed, trimmed.
 *
 * WHY THE ADDRESS DOES NOT REACH THE MODEL. ".assistant draft me a reply" asks for a draft; handing
 * the assistant its own name as the first word of the request makes the address part of the question,
 * the same reason an `@` token is stripped before dispatch. The prefix is removed only when it
 * RESOLVED - an unresolved dot is ordinary text and the person meant to write it.
 */
export function stripPrivatePrefix(text: string, member: BypassMember): string {
  // COMPARED AGAINST THE PARSED ADDRESS, NOT THE RAW TOKEN. `.<Alice|sub-abc>` carries the id beside
  // the name, so a raw comparison against `member.name` fails and leaves the whole address sitting in
  // the question the model answers - which is the exact defect this function exists to prevent, moved
  // one form along. The id is accepted as evidence too, because it is what the picker resolved by.
  const address = parsePrivateAddress(text);
  if (!address) return text;
  const nameMatches = !!member.name && address.name.toLowerCase() === member.name.toLowerCase();
  const idMatches = !!address.id && !!member.arn && member.arn.split('/').pop() === address.id;
  if (!nameMatches && !idMatches) return text;
  // Strip whichever form actually matched, in the same order `privatePrefixToken` resolved it -
  // stripping the bare pattern off a delimited address would leave the closing bracket behind.
  // '$1' puts the rendering command back: only the ADDRESS is not part of the question.
  return PRIVATE_PREFIX_DELIMITED.test(text)
    ? text.replace(PRIVATE_PREFIX_DELIMITED, '$1').trim()
    : text.replace(PRIVATE_PREFIX, '$1').trim();
}
