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
 * ── AND THE THIRD ONE IS NOT A LITERAL (ADR-034) ──
 *
 * `@<member>` joined this set, and it is any `@` followed by a name that resolves to a member of THIS
 * channel - so the module is a resolver over the channel roster as well as a set of strings, and
 * `FLOW_BYPASS_TOKENS` covers only the part that stays enumerable. What did not change is the
 * property above: both sides still decide from one definition. A resolver that the flow consults and
 * the handler re-implements is the same drift this file exists to prevent, arriving in a shape the
 * completeness test cannot see.
 *
 * `flowOwnsTheTurn` is where that lands. It is asked by the flow to decide whether to act and by the
 * handler to decide whether to stand down, so the two are complements BY CONSTRUCTION - there is no
 * second implementation left to drift, which is stronger than two lists agreeing.
 *
 * FUNCTIONS, NOT EXPORTED REGEXES. A shared `/g` regex object carries `lastIndex` between callers,
 * so alternating `.test()` calls on one instance silently skip matches. The strip helpers need `g`
 * and the match helpers must not have it; exporting behavior instead of patterns removes the whole
 * class of bug from the seam whose entire purpose is that two callers behave identically.
 *
 * Pure. No I/O.
 */

// A value import from a module that imports only a TYPE back from here, so there is no runtime cycle.
import { resolvePrivateTarget } from './private-prefix.js';

/** The tokens that take a turn away from Lex. A closed set - see `FLOW_BYPASS_TOKENS`. */
export type FlowBypassToken = '@all' | '/battle' | '/stop';

/**
 * ── A COMMAND NOT ADDRESSED TO AN ASSISTANT GOES TO THE PRIMARY ONE ──────────
 *
 * That is the rule, and this registry is what keeps it a RULE rather than a habit. `/battle` and
 * `/stop` each had to be wired through this seam by hand, and each time the work was the same: match
 * the token, decide the size branch, decide the fail direction, update two completeness guards. A
 * third command written the same way would be a third chance to get one of those wrong, and the way
 * it goes wrong is silence - AUTO routes nothing unaddressed in a room, so a command nobody wired
 * reaches no assistant at all while looking, to the person who typed it, exactly like one that did.
 *
 * So a command declares its behavior here and both sides read it. Adding one is this entry and
 * nothing else.
 *
 * WHAT IS DELIBERATELY NOT HERE: any slash token at all. `/foo` is not a command, and neither is
 * "/tmp is full" or a pasted path - they stay ordinary text and start no turn. Treating every leading
 * slash as a command would route messages nobody addressed to an assistant, which is the over-match
 * `mightMentionSomeone` and `privatePrefixToken` both already refuse for the same reason.
 */
export interface ChatCommand {
  /** The literal a person types. */
  token: Extract<FlowBypassToken, `/${string}`>;
  /**
   * `prefix` - the command opens the message and the rest is its argument (`/battle compare these`).
   * `whole` - the command IS the message. Anything after it means something else and belongs on the
   * judged path, which is why `/stop the report and summarise it instead` is a redirect, not a stop.
   */
  match: 'prefix' | 'whole';
  /**
   * Does the flow stand aside in a 1:1?
   *
   * NO LONGER A STAND-ASIDE, and the field is kept for where it sits rather than for what it once
   * decided. Every assistant carries `StandardMessages: NONE`, so the Amazon Lex entry is invoked for
   * no untargeted message at any size and the flow owns a one-to-one unconditionally.
   *
   * What the flag still controls is ORDER: a `sizeBranched` command is evaluated BELOW the one-to-one
   * return, so it is claimed there by that return rather than by its own clause; a non-branched one
   * (`/battle`) returns ABOVE it and is owned at every size. `/battle` has to be, because it fans out
   * across assistants and below two of them falls back and answers anyway.
   */
  sizeBranched: boolean;
  /**
   * Where the flow sends it once it has claimed it.
   *
   * `primary` - to the conversation's primary assistant (`resolvePrimaryBotArn`), which is the rule
   * this registry exists for: a command not addressed to a specific assistant goes to the primary
   * one. A new command needs nothing in the flow to get this.
   * `own-handler` - the flow has a dedicated branch for it. `/battle` is the only one: it fans a duel
   * out across two assistants, which is not a turn the primary runs.
   */
  dispatch: 'primary' | 'own-handler';
  /**
   * When the roster cannot be read TWICE, does the router answer rather than stand down?
   *
   * The default is to stand down, preserving one-responder: a duplicate answer is worse than a
   * missing one, and the person can ask again. A command where that trade runs the other way says so
   * here. `/stop` is the one that does - it is the escape hatch, cannot usefully be asked again, and
   * `lib/stop-target.ts` already settles the identical question the same way on its own path.
   */
  answeredWhenRosterUnreadable: boolean;
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    token: '/battle',
    match: 'prefix',
    sizeBranched: false,
    dispatch: 'own-handler',
    answeredWhenRosterUnreadable: false,
  },
  {
    token: '/stop',
    match: 'whole',
    sizeBranched: true,
    dispatch: 'primary',
    answeredWhenRosterUnreadable: true,
  },
] as const;

/**
 * Every bypass token, for the guard that asserts this list is complete. DERIVED from the registry, so
 * a command cannot be added to one and forgotten in the other - which is the drift this whole module
 * exists to prevent, and which a hand-maintained second list would reintroduce at the top of the file
 * that fixes it. `@all` is listed separately because it is mention-shaped, not a command.
 */
export const FLOW_BYPASS_TOKENS: readonly FlowBypassToken[] = [
  '@all',
  ...CHAT_COMMANDS.map((c) => c.token),
] as const;

/** The declared behavior of a command token, or undefined when the token is not a command. */
export function commandFor(token: string | null | undefined): ChatCommand | undefined {
  return CHAT_COMMANDS.find((c) => c.token === token);
}

/**
 * The pattern for one command, built from its declared match shape.
 *
 * BUILT, NOT WRITTEN OUT. A hand-written regex per command is a second place the match shape lives,
 * and the shape is the thing most likely to be got wrong on a new entry. The token is escaped because
 * it contains a `/` and could contain other pattern characters - the same care `stripMentionOf` takes
 * with a member name, and for the same reason.
 *
 * NOT `g`. A shared global regex carries `lastIndex` between callers, so alternating `.test()` calls
 * on one instance silently skip matches - see this module's header.
 */
function patternFor(command: ChatCommand): RegExp {
  const literal = command.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\b` on a prefix keeps `/battlefield` out; `\s*$` on a whole match is what makes it the message.
  return command.match === 'whole'
    ? new RegExp(`^\\s*${literal}\\s*$`, 'i')
    : new RegExp(`^\\s*${literal}\\b`, 'i');
}

/** Which command this message invokes, or null. The one place a command is recognized. */
export function matchCommand(text: string): ChatCommand | null {
  return CHAT_COMMANDS.find((c) => patternFor(c).test(text || '')) || null;
}

/**
 * `@all` is MENTION-SHAPED: it addresses everyone and may appear anywhere in the message, so it is
 * matched unanchored. `\b` is what keeps `@allison` and a bare "all" out - over-matching silences a
 * real turn, which is worse than the duplicate this guard prevents.
 */
const AT_ALL = /@all\b/i;
const AT_ALL_GLOBAL = /@all\b/gi;

/**
 * A command is a SLASH COMMAND - a process invocation, parsed only at the start of the trimmed
 * message. Deliberately not mention syntax: `@`-tokens address a channel member, a command invokes
 * something. Anchoring is load-bearing on BOTH sides and for opposite reasons: unanchored, the flow
 * would fan out a duel because someone wrote "try /battle sometime", and the router would silence a
 * turn the flow never claimed - leaving nobody to answer, which is the worse direction.
 *
 * The patterns are built from `CHAT_COMMANDS` by `patternFor`, so the anchoring above is applied to
 * every command by construction rather than retyped per entry.
 */

/**
 * A member of this conversation, as both sides of the seam need to see them.
 *
 * Deliberately the smallest shape that answers the question, so the flow can pass what it already
 * read for the member count and the handler can pass what it already read for the same reason -
 * neither pays a second read to use this.
 */
export interface BypassMember {
  /** The member's Amazon Chime SDK ARN. */
  arn: string;
  /** The name a person types after `@`. */
  name: string;
  /** An `AppInstanceBot` rather than a person. */
  isBot: boolean;
}

/**
 * Could this text carry an `@` token at all?
 *
 * A PREFILTER, NOT A DECISION. Resolving a mention needs the channel roster, and reading the roster
 * is an Amazon Chime SDK call on the request path. Most messages contain no `@` whatsoever, and this
 * answers for them without one. It deliberately over-matches - a message that merely mentions an
 * email address says yes - because the only cost of a yes is a read that `resolveMentionedMember`
 * then resolves to nobody, while the cost of a wrongly-withheld read is a mention that silently
 * addresses no one.
 *
 * The boundary before `@` is what keeps "reach me at name@example.com" from being that common case:
 * an `@` mid-word is not a mention in any chat client, and requiring a space or the start of the
 * message before it matches how a person actually types one.
 *
 * ANY NON-SPACE CHARACTER AFTER THE `@`, NOT JUST AN ASCII ONE. This tested `[A-Za-z0-9]`, which said
 * no to `@Elise` spelled with an accent and to every name in a non-Latin script. A no here is not a
 * cheap miss: the roster is never read, `resolveMentionedMember` never runs, and the flow's "an `@`
 * token named nobody" warning is itself gated on this - so the member is ignored in front of the room
 * and no record anywhere says it happened. That is precisely the failure this function's own comment
 * says it over-matches to avoid, and the ASCII class quietly exempted most of the world's names from
 * the protection (tenet D11).
 *
 * NOT A REPLACEMENT FOR THE LITERAL TOKENS. `matchesAtAll` has no leading boundary, so `@all` matches
 * inside "hey@all" where this says no. Callers that gate a roster read on this must also test the
 * literals - see the call sites in the flow and the handler, which do.
 */
export function mightMentionSomeone(text: string): boolean {
  return /(^|\s)@[^\s@]/.test(text);
}

/**
 * WHICH MEMBER AN `@` TOKEN NAMES, or null when it names nobody here (ADR-034).
 *
 * ── WHY THIS IS A RESOLVER AND NOT A TOKEN ──
 *
 * `@all` and `/battle` are literals: a fixed set, and the completeness test above can assert it.
 * `@<member>` is not. It is any `@` followed by a name that resolves against THIS channel's roster,
 * so the set is per-conversation and cannot be enumerated in advance. What does not change is the
 * property the whole module exists for: the flow and the handler decide from ONE definition, or they
 * disagree about who owns a turn and it is answered twice or not at all.
 *
 * ── WHY A HUMAN MENTION RESOLVES AND STILL STARTS NO TURN ──
 *
 * It returns the member either way, and the CALLER decides what that means, because the two callers
 * want different things from the same fact: the flow notifies a person and dispatches to an
 * assistant, while the handler stands down for both. Returning null for a human would make "nobody
 * is named" and "a person is named" the same answer, and the handler would then run a turn for a
 * message addressed to somebody else.
 *
 * ── THE MATCH: THE EARLIEST TOKEN WINS, NOT THE LONGEST NAME ──
 *
 * This used to sort the roster by name length and return the first member found in that order, which
 * is the right rule for ONE position and the wrong rule across a message. "@Atlas and @Samantha,
 * thoughts?" resolved to Samantha because her name is longer - so the flow took the human branch and
 * started no turn, the handler stood down because a member WAS mentioned, and the assistant the
 * person explicitly named answered nothing at all. Resolution is therefore by POSITION: the first
 * `@` token that names somebody is the one the message addresses.
 *
 * Length is kept only to break a tie at the same position, which the boundary rules already make
 * unreachable for a prefix pair - `@Samantha` cannot match `Sam`, because the character after `Sam`
 * is a word character - so it costs nothing and removes the question.
 *
 * ── THE BOUNDARIES, AND THEY ARE ON BOTH SIDES ──
 *
 * Before the `@`: start of message or whitespace, the same rule `mightMentionSomeone` uses. Without
 * it "ops@atlas.com" resolved to the assistant Atlas and dispatched a turn, which also made the
 * prefilter's stated bargain false - a yes was supposed to cost only a read that then resolves to
 * nobody.
 *
 * After the name: the token must END there. A word character means it does not - that is what keeps
 * `@allison` out of `@all`. But a word character alone is too weak a test, because the characters a
 * NAME can contain are wider than `\w`: with it, `@alice@example.com`, `@alice-bob` and
 * `@alice.smith` all resolved to a member called `alice`, since `@`, `-` and `.` are not word
 * characters. Someone quoting an address or naming a different person was silently mentioning
 * whoever held the shorter name - and in a group that means the flow claims the turn and the handler
 * stands down for it.
 *
 * So punctuation is read by what FOLLOWS it. `.`, `@`, `-`, `_` and `+` continue a token when an
 * alphanumeric comes next (`@alice.smith`) and end one when anything else does (`ask @alice.`,
 * `@alice, can you`). That is the difference between a name and a sentence, and it is decidable
 * without knowing every name that exists.
 *
 * Case-insensitive, because a name is not a password.
 *
 * Pure. No I/O.
 */
/** Characters that can appear INSIDE a name, so a following alphanumeric means the token continues. */
const NAME_PUNCTUATION = new Set(['.', '@', '-', '_', '+']);

/** Does the text at `end` continue the token that just matched, rather than terminating it? */
function tokenContinues(haystack: string, end: number): boolean {
  const after = haystack[end];
  if (!after) return false;
  if (/\w/.test(after)) return true;
  if (!NAME_PUNCTUATION.has(after)) return false;
  // Punctuation only continues a token when something name-shaped follows it.
  return /[a-z0-9]/i.test(haystack[end + 1] || '');
}
/**
 * Every `@<Name|id>` token, and the text with those tokens BLANKED to equal-length spaces.
 *
 * MIRRORS `delimitedMentions` IN `mentionParser.ts`, and the two are separate copies for the same
 * reason the private-prefix grammar is: this runs in a Lambda and that runs in a browser bundle.
 * `one-mention-grammar.test.ts` is what keeps them one grammar.
 *
 * Blanked rather than removed so every index still matches the original - the scan below records the
 * position it matched at and prefers the EARLIEST, so a length-changing rewrite would change which
 * member an ambiguous message resolves to. And blanking is what lets the bare-name scan stay exactly
 * as it was: its boundary rules were learned from real misroutes and teaching it a second grammar
 * would mean re-deriving them.
 */
export function delimitedMentionTokens(
  text: string,
): { tokens: Array<{ name: string; id?: string; raw: string; at: number }>; blanked: string } {
  const tokens: Array<{ name: string; id?: string; raw: string; at: number }> = [];
  const pattern = /@<([^<>\n]{1,128})>/g;
  let blanked = text;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    const at = match.index ?? 0;
    // The LAST separator, so `A|B|sub-1` reads as the name `A|B`. `raw` is kept because the split is a
    // guess about a name.
    const cut = raw.lastIndexOf('|');
    if (cut > 0 && cut < raw.length - 1) {
      tokens.push({ name: raw.slice(0, cut), id: raw.slice(cut + 1), raw, at });
    } else {
      tokens.push({ name: raw, raw, at });
    }
    blanked = blanked.slice(0, at) + ' '.repeat(match[0].length) + blanked.slice(at + match[0].length);
  }
  return { tokens, blanked };
}

export function resolveMentionedMember(
  text: string,
  members: readonly BypassMember[],
): BypassMember | null {
  if (!text || members.length === 0) return null;

  // ── THE ID WINS, AND IT IS READ FROM THE TEXT BECAUSE NOTHING ELSE REACHES HERE ─────────────────
  //
  // The picker writes `@<Name|id>` so this resolution does not depend on matching a
  // display name, which is not unique: a name falls back to the email local part, so two members can
  // carry one. The resolved ARNs also ride in the `CHIME.mentions` ATTRIBUTE and that is the cleaner
  // carrier, but the channel-flow callback carries no attributes at all - and the one thing that does
  // reach the flow beside the words, `Metadata`, is member-WRITABLE, so an id there could be rewritten
  // by a different member to redirect somebody else's mention. The sender's own words are the honest
  // source of who the sender addressed.
  //
  // EARLIEST TOKEN WINS, the same rule the bare-name scan below applies, so "who is this addressed to"
  // has one answer however the two grammars are mixed.
  const { tokens: delimited, blanked } = delimitedMentionTokens(text);
  let byId: { member: BypassMember; at: number } | null = null;
  for (const token of delimited) {
    const found = (token.id
      ? members.find((m) => m.arn && m.arn.split('/').pop() === token.id)
      : undefined)
      // The name it carried, when the id names nobody here - a crafted or stale id resolves to
      // nobody rather than to a guess, and the name is what the sender saw when they picked.
      ?? members.find((m) => m.name
        && (m.name.toLowerCase() === token.name.toLowerCase()
          || m.name.toLowerCase() === token.raw.toLowerCase()));
    if (found && (!byId || token.at < byId.at)) byId = { member: found, at: token.at };
  }

  const haystack = blanked.toLowerCase();
  let best: { member: BypassMember; at: number } | null = byId;

  for (const member of members) {
    if (!member.name) continue;
    const needle = `@${member.name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? '' : haystack[at - 1];
      if ((!before || /\s/.test(before)) && !tokenContinues(haystack, at + needle.length)) {
        // The earliest valid token for THIS member; a later one cannot beat it.
        if (!best || at < best.at || (at === best.at && member.name.length > best.member.name.length)) {
          best = { member, at };
        }
        break;
      }
      from = at + 1;
    }
  }
  if (best) return best.member;
  return null;
}

/**
 * THE ASSISTANT THIS MESSAGE NAMES, if it names one at all.
 *
 * WHY THIS IS SEPARATE FROM "the member it names". `resolveMentionedMember` answers with the EARLIEST
 * token, which is right for "who is this addressed to" and wrong for "does an assistant have to
 * answer". A message may legitimately name both - the composer explicitly allows one person and one
 * assistant together - and in that shape the two questions have different answers.
 *
 * THE FAILURE THIS REMOVES, and it is silent on both sides. "@Alice and @Atlas, thoughts?" resolved
 * to Alice, so the flow took the human branch and dispatched nothing; the handler meanwhile stood
 * down because `flowOwnsTheTurn` was true - a member WAS named. Lex is invoked for it (the composer
 * puts the assistant in `CHIME.mentions`) and then silenced, so the turn is answered by nobody and
 * nothing errors. The same message with the names the other way round worked, which is the kind of
 * difference nobody reproduces on purpose.
 *
 * So: if any named member is an assistant, that assistant answers, wherever in the sentence it sits.
 * Naming a colleague alongside it does not take the turn away.
 */
export function resolveMentionedAssistant(
  text: string,
  members: readonly BypassMember[],
): BypassMember | null {
  return resolveMentionedMember(text, members.filter((m) => m.isBot));
}

/**
 * Does this text carry an `@` token that names somebody in this conversation?
 *
 * The question the HANDLER asks, where it needs to know only whether the flow owns this turn. Kept
 * beside the resolver rather than derived at each call site, so the two sides cannot drift into
 * asking it differently.
 */
export function mentionsAMember(text: string, members: readonly BypassMember[]): boolean {
  return resolveMentionedMember(text, members) !== null;
}

/**
 * DOES THE CHANNEL FLOW OWN THIS TURN? One function, asked by both sides (ADR-034).
 *
 * The flow acts when this is true; the agent handler stands down when this is true. They are
 * therefore complements BY CONSTRUCTION rather than by two implementations agreeing - which is the
 * stronger form of the property this module already exists to protect, because there is no second
 * implementation to drift.
 *
 * ── THE 1:1 IS THE FLOW'S TURN, AND THE EXCEPTION THAT USED TO LIVE HERE IS GONE ──
 *
 * Every assistant carries `StandardMessages: NONE`, so Amazon Chime SDK turns no untargeted message
 * into an Amazon Lex turn at any conversation size. The flow is the only thing that can start one, so
 * a 1:1 returns true unconditionally: standing down there would answer NOBODY, silently, with the
 * person left talking to a room that looks exactly like one where the assistant is thinking.
 *
 * WHAT USED TO BE HERE, because the hazard is real wherever a second entry exists. Under
 * `StandardMessages: AUTO` this size invoked the handler through Amazon Lex on EVERY message whatever
 * the flow did. If the flow also dispatched, two entries ran one turn under two correlation ids - the
 * flow declares the inbound `MessageId`, the Lex path provably has none - so the duplicate-placeholder
 * claim saw two identities rather than one and denied nothing. Measured 2026-08-12: two placeholders
 * 558ms apart, one stranded at "One moment..." permanently. That configuration was removed on
 * 2026-09-17 along with the per-profile field that selected it, so the premise is simply false now.
 *
 * ── WHICH IS WHY THE PRIVATE CHECK MOVED ABOVE THE SIZE CHECK ──
 *
 * `StandardMessages: NONE` narrows ONE axis. `TargetedMessages` stays `ALL`, because Amazon Chime SDK
 * refuses an `InvokedBy` whose members are both `NONE` (measured 2026-09-16; ADR-041). So a `.`
 * address still reaches Amazon Lex at EVERY size, including a 1:1 - and if the flow also claimed it
 * there, the two-entry duplicate would come straight back in the one place this function was written
 * to keep it out of. Ordering the private check first answers that for both configurations at once.
 *
 * The reorder was behavior-preserving when it was made: under the old hybrid a 1:1 returned false at
 * the size check and now returns false at the private check, and a 1:1 with no private target fell
 * through to the same size check either way. It is load-bearing now rather than merely tidy, because
 * the size check below it returns TRUE unconditionally.
 *
 * ── WHY `/battle` IS NOT HERE ──
 *
 * It is, via `matchesBattleCommand`, and it is NOT member-count-gated: a duel needs two assistants,
 * so it cannot arise in a 1:1 at all, and the flow gates and fans it out at every size it can occur.
 * Keeping it in the same answer is what stops a caller remembering one token and forgetting another.
 */
export function flowOwnsTheTurn(args: {
  /** The message text, already decoded. */
  text: string;
  /** This conversation's members, as the caller already read them. */
  members: readonly BypassMember[];
  /** Exactly one OTHER non-hidden member, from this bot's perspective (`lib/channel-size.ts`). */
  isOneToOne: boolean;
}): boolean {
  const { text, members, isOneToOne } = args;
  const command = matchCommand(text);
  // A COMMAND THE FLOW OWNS AT EVERY SIZE, decided by the command rather than by naming one here.
  // `/battle` is the case: it fans out above two assistants and falls back and answers below that, so
  // no size exists at which the Lex entry should answer as well.
  if (command && !command.sizeBranched) return true;
  // A PRIVATE MESSAGE IS NEVER THE FLOW'S TURN, whatever `@` it also carries. Privacy rides on the
  // `Target` the ingress set, and a flow-dispatched turn answers UNTARGETED: `.Atlas @Atlas ...` or
  // `.Alice @Atlas ...` would put the answer to a message only two people can read in front of the
  // whole room. The web composer refuses that combination, but the flow is not allowed to rely on one
  // client. Amazon Chime SDK routes the message from its `Target` instead, and the reply inherits it.
  //
  // ABOVE THE SIZE CHECK, deliberately: `TargetedMessages: ALL` holds under every reachable entry
  // configuration, so a targeted message reaches Amazon Lex at every size and the flow must not claim
  // it at any size. See the header.
  if (resolvePrivateTarget(text, members)) return false;
  // A ONE-TO-ONE IS THE FLOW'S TURN, unconditionally, because nothing else is invoked for it.
  //
  // THIS USED TO DEPEND ON A PER-PROFILE `turnEntry`, and that was unsound as well as complicated.
  // Every assistant carries `StandardMessages: NONE` (`assistant-profile-stack`), so Amazon Chime SDK
  // turns no untargeted message into an Amazon Lex turn at any size. Standing down here would answer
  // NOBODY, silently, with the person left talking to a room that looks exactly like one where the
  // assistant is thinking.
  //
  // The unsoundness is worth stating because it is why the option went rather than merely being
  // unused: the entry is provisioned at deploy time onto the bot, and it was re-derived per message at
  // runtime from the same config. Those two can disagree - a bot provisioned `AUTO` while the runtime
  // reads `'flow'` gives two responders, and the reverse gives none - and nothing downstream could
  // catch either. One invariant, asserted in one place, cannot disagree with itself.
  if (isOneToOne) return true;
  // A SIZE-BRANCHED COMMAND SITS HERE, BELOW THE 1:1 RETURN AND BELOW THE PRIVATE CHECK, and both
  // placements are load-bearing. Below the 1:1 return because that return is now unconditional.
  // Below the private check because a privately sent command is the sender's, not the room's -
  // a private `/stop` is REFUSED by the router rather than claimed here, and
  // claiming it would route it into a broadcast turn in front of a room that never saw the request.
  //
  // THIS IS THE RULE, STATED ONCE: a command not addressed to a specific assistant goes to the
  // primary one. `command !== null` is that sentence - an addressed command is claimed by
  // `mentionsAMember` on the same line and dispatched to the assistant it names instead.
  return matchesAtAll(text) || command !== null || mentionsAMember(text, members);
}

/** Does this text carry `@all`? */
export function matchesAtAll(text: string): boolean {
  return AT_ALL.test(text);
}

/** Does this text invoke the `/battle` command? A named shorthand over the registry. */
export function matchesBattleCommand(text: string): boolean {
  return matchCommand(text)?.token === '/battle';
}

/**
 * `/stop` is a SLASH COMMAND like `/battle`, anchored for the same reasons, and the flow owns a bare
 * `/stop` at every size. The two differ only in where `flowOwnsTheTurn` claims them and where the
 * flow sends them.
 *
 * WHERE IT IS CLAIMED. `/stop` is `sizeBranched`, so it is evaluated below the private check and the
 * `isOneToOne` return: in a 1:1 that return claims it, and in a group `command !== null` does. A
 * privately addressed stop is never the flow's turn; Amazon Chime SDK routes it from its `Target`, and
 * the router refuses it in a group and lets it proceed in a 1:1. `StandardMessages: NONE` invokes Lex
 * for no untargeted message, so the flow's claim is the only way an unaddressed `/stop` reaches an
 * assistant at any size.
 *
 * WHERE IT GOES. `dispatch: 'primary'`: the flow hands it, unstripped and broadcast, to the
 * conversation's primary assistant, and the router's `parseStopCommand` / `resolveStopTarget`
 * (`lib/stop-target.ts`) decide what it stops. When the roster cannot be read the router answers it
 * anyway (`answeredWhenRosterUnreadable`), because the escape hatch cannot usefully be asked again.
 *
 * The rule stays in the one function both sides ask. A second size branch in either caller is the
 * drift this module exists to prevent.
 *
 * ANCHORED AT BOTH ENDS, which is narrower than `/battle` and deliberately so. `parseStopCommand`
 * already draws this line for the router - "stop the report and summarise it instead" is a redirect,
 * not the escape hatch - and the two must agree: a text this claimed but that parser then declined
 * would be a turn the flow took and nobody answered. An ADDRESSED stop is not this shape and does not
 * need to be: `@Atlas /stop` is routed by its mention, and `mentionsAMember` claims it.
 */
/** Is this text a bare `/stop` - the command and nothing else? A named shorthand over the registry. */
export function matchesStopCommand(text: string): boolean {
  return matchCommand(text)?.token === '/stop';
}

/** The message with every `@all` token removed, trimmed. */
export function stripAtAll(text: string): string {
  return text.replace(AT_ALL_GLOBAL, '').trim();
}

/**
 * The message with every `@` token naming this member removed, trimmed.
 *
 * WHY THE TOKEN GOES AND THE SENTENCE STAYS. A mention is address, not content: "@Atlas what is the
 * deploy order" asks about the deploy order, and leaving the token in makes the assistant's own name
 * part of the question it is answering. The rest of the sentence is untouched, including a mention of
 * somebody ELSE - "@Atlas could you ask @Alice about it" keeps `@Alice`, because that clause is the
 * request, not the address.
 *
 * The name is escaped before it becomes a pattern. A member name is user-controlled text and arrives
 * here from the channel roster; an unescaped `.` or `+` in it would build a pattern that strips text
 * the person actually wrote.
 *
 * THE SAME BOUNDARIES THE RESOLVER USED, and they have to be the same or this strips something other
 * than what was matched. `\b` was wrong on both sides. After the name it asks for a word character on
 * ONE side of the position, so a name ending in punctuation - "Dr." - produced `@Dr\.\b`, which needs
 * a word character after the dot and therefore stripped nothing: the resolver matched, the stripper
 * did not, and the address reached the model as content, which is the one thing this function exists
 * to prevent. `(?!\w)` asks the question the resolver actually asks. Before the `@` there was no test
 * at all, so "ops@atlas.com" was mangled into "ops.com" in the text handed to the turn.
 */
export function stripMentionOf(text: string, member: BypassMember): string {
  // THE DELIMITED FORM GOES TOO: the `@<Name|id>` the picker writes, matched to this member by id first and by
  // the name it carried otherwise, as `resolveMentionedMember` matched it. Removed right to left so each
  // recorded position still holds, with the same single-space seam the bare scan below closes. A token naming
  // somebody else stays, as a bare one does.
  const id = member.arn ? member.arn.split('/').pop() : undefined;
  for (const t of [...delimitedMentionTokens(text).tokens].reverse()) {
    const names = !!member.name && (t.name.toLowerCase() === member.name.toLowerCase()
      || t.raw.toLowerCase() === member.name.toLowerCase());
    if (!((t.id && t.id === id) || names)) continue;
    const end = t.at + t.raw.length + 3;
    text = text.slice(0, t.at) + text.slice(end + (t.at > 0 && text[end] === ' ' ? 1 : 0));
  }
  if (!member.name) return text.trim();
  const needle = `@${member.name.toLowerCase()}`;
  const haystack = text.toLowerCase();
  let out = '';
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const before = at === 0 ? '' : haystack[at - 1];
    const end = at + needle.length;
    // THE SAME TWO BOUNDARY TESTS THE RESOLVER APPLIES, and they have to be the same or this strips
    // something other than what was matched. Built by scanning rather than by a regex so there is one
    // definition of "the token ends here" (`tokenContinues`) instead of a pattern that re-states it.
    if ((!before || /\s/.test(before)) && !tokenContinues(haystack, end)) {
      // Keep the whitespace that satisfied the leading boundary, so removing a mid-sentence token
      // does not fuse the words either side of it; the collapse below tidies what is left.
      out += text.slice(from, at);
      // CLOSE THE GAP AT THE SEAM, rather than tidying the whole message afterwards. Removing a
      // mid-sentence token leaves the space in front of it and the space behind it, so one of them
      // goes here. A single space and never a newline, and only when something preceded the token -
      // so a leading `@Name ` simply disappears and the text that follows keeps its own shape.
      from = end + (before && text[end] === ' ' ? 1 : 0);
    } else {
      out += text.slice(from, at + 1);
      from = at + 1;
    }
  }
  out += text.slice(from);
  // NO GLOBAL COLLAPSE. A blanket `\s{2,} -> ' '` flattened the whole message: a pasted code block
  // came out as one line with its indentation gone, so the text the model answered was not the text
  // that was sent. Narrowing it to horizontal whitespace was not enough either - indentation IS
  // horizontal whitespace. The gap is closed where it is made, above.
  return out.trim();
}

/** The message with a leading `/battle` command removed, trimmed. */
export function stripBattleCommand(text: string): string {
  const battle = commandFor('/battle');
  return battle ? text.replace(patternFor(battle), '').trim() : text.trim();
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
  // A COMMAND FIRST, WHATEVER IT IS. If a message somehow carries both a command and `@all`, the
  // command wins, matching the flow's own precedence: a slash command is a process invocation, a
  // mention is addressing. Reading this off the registry is what keeps the precedence from having to
  // be restated - and re-ordered correctly - each time a command is added.
  for (const form of forms) {
    const command = matchCommand(form);
    if (command) return command.token;
  }
  if (forms.some(matchesAtAll)) return '@all';
  return null;
}
