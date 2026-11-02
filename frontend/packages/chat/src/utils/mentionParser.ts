import type { ChannelMember } from '@ae/shared';

/** Validation outcome surfaced to the UI when the user typed something the
 *  Chime SDK can't deliver. We don't silently drop mentions — the user must
 *  decide whether to remove the extras or use @all instead. */
export type MentionValidationError =
  /** More than one distinct human was @-mentioned. `Target` is fixed-1 by the
   *  Chime API (see reference_chime_target_fixed_one); reaching multiple
   *  people requires N separate sends, which we don't build until we have a
   *  use case. */
  | 'multiple_humans'
  /** Multiple distinct bots were @-mentioned. CHIME.mentions itself is
   *  multi-entry but the resulting Target ambiguity + the cost of fanning
   *  out N bot replies isn't worth it; pick one assistant. */
  | 'multiple_bots'
  /** `@all` was combined with one or more explicit `@<member>` mentions.
   *  Broadcast and single-target visibility are mutually exclusive at the
   *  SendChannelMessage layer — Chime won't deliver both. Pick one. */
  | 'all_with_member'
  /** `.member` combined with an `@` mention. The first says "only this member may read it", the
   *  second says "notify them, and everyone can read it". They cannot both hold. */
  | 'private_with_mention';

export interface MentionParseResult {
  /**
   * The ARN to set on SendChannelMessage Target, which is what makes the message readable ONLY by
   * the sender and that member.
   *
   * SET BY THE `.` PREFIX AND BY NOTHING ELSE (ADR-034). An `@` mention used to set it too, which
   * meant naming somebody also hid the message from the rest of the conversation - addressing and
   * privacy performed by one keystroke. They are now two acts: `@` addresses in public, `.` is
   * private. Privacy stays on `Target` because Amazon Chime SDK enforces it before delivery; a
   * client-side rule would be a disclosure rather than a weaker version of the same thing.
   */
  targetArn?: string;
  /** The member a `.` prefix addressed privately. Present exactly when `targetArn` is. */
  privateToArn?: string;
  /** What the composer decorates: the resolved member's name, for the "Private to Sam" chip. */
  privateToName?: string;
  /** The bot ARN to put in the CHIME.mentions message attribute, when the bot is mentioned. */
  mentionBotArn?: string;
  /** True if `@all` (or `@everyone`) appears — caller should bypass Target and let the channel-flow processor broadcast. */
  isAtAll: boolean;
  /** All ARNs the user mentioned, in text order. Used for UI display + the
   *  validation rules above; routing only ever uses `targetArn` /
   *  `mentionBotArn` derived from this list. */
  mentionedArns: string[];
  /** Set when the mention shape can't be delivered by Chime as-is. The
   *  caller (MessageInput) shows the message inline and blocks send. When
   *  `error` is set, `targetArn` and `mentionBotArn` are intentionally
   *  undefined — there's no safe fallback. */
  error?: MentionValidationError;
}

const AT_ALL_PATTERN = /(^|\s)@(all|everyone)\b/i;

/**
 * The private prefix: `.name ` at the START of the message (ADR-034).
 *
 * ANCHORED, and the anchor is load-bearing. Unanchored, a decimal, a file extension or an ellipsis
 * becomes an address - "call me at 5.sam" would make private a message meant for the room.
 * Over-matching here publishes nothing, but it hides a message somebody meant everyone to see, and
 * they find out when nobody answers.
 *
 * THE TRAILING SPACE IS PART OF THE TOKEN, because it is what makes the token COMPLETE - which is
 * the moment the composer may decorate it. A token that has not visibly become a pill has not been
 * applied, and that is the whole protection against sending publicly what was meant privately.
 *
 * A RENDERING COMMAND MAY COME FIRST. `/md` says how to display a message and `.name` says who may
 * read it - different questions that compose. Both grammars are anchored, so with the command in
 * front the address stopped being seen HERE while the send path still set the Target: privacy was
 * applied and invisible, with no chip and no picker, and a mistyped name then produced a public
 * message with no signal either way. The command is captured so it can be put back.
 */
const PRIVATE_PREFIX = /^\s*(\/md\s+)?\.(\S{1,128})\s/i;

/**
 * The DELIMITED form, `.<Full Name>`, for a name the bare token cannot express.
 *
 * The bare token ends at the first space, so "Ryan McHarg" would resolve as `Ryan` - nobody - and a
 * message the person believed private would go to the room. What follows the dot has to BE a
 * member's name, so a grammar that cannot express some names cannot do its job.
 *
 * ANGLE BRACKETS FOLLOW THE CONVENTION every major client uses to delimit a mention target: Slack
 * `<@U123>`, Discord `<@123>`, Google Chat `<users/123>`, Microsoft Teams `<at>Name</at>` - the last
 * of which, like this, wraps the NAME rather than an id.
 *
 * They also survive our renderer, which is why the other precedent was rejected. A private prefix
 * only appears in a USER message, and user messages render as React-escaped plain text; bot messages
 * render through remark-gfm, where Zulip's `@**Name**` would come out bold with the delimiters gone.
 *
 * Mirrors `PRIVATE_PREFIX_DELIMITED` in `backend/lambda/src/lib/private-prefix.ts`. The two sides
 * must lex a name identically or they disagree about who was addressed.
 */
const PRIVATE_PREFIX_DELIMITED = /^\s*(\/md\s+)?\.<([^<>\n]{1,128})>(?:\s|$)/i;

/**
 * The token while it is still being TYPED - no trailing space yet, so nothing has resolved.
 *
 * Exported because the composer needs to know when to open the member picker, and the only correct
 * answer is "the same lexing the parser will apply a moment later". It was a literal regex at the
 * call site, and when the token widened here that copy stayed narrow: for a member named by email the
 * picker closed the instant `@` was typed, half way through their own name.
 */
export function privatePrefixDraft(textBefore: string): string | null {
  // Accepts a half-typed DELIMITED name too: ".<Ryan Mc" must keep the picker open, or a name with a
  // space closes the list at the very space the delimited form exists to handle.
  // A leading `/md` is skipped here too, so the picker opens for a formatted private message. Without
  // it the name had to be typed exactly, in the one case where nothing on screen said it was private.
  const delimited = /^\s*(?:\/md\s+)?\.<([^<>\n]*)$/i.exec(textBefore);
  if (delimited) return delimited[1];
  const m = /^\s*(?:\/md\s+)?\.(\S*)$/i.exec(textBefore);
  return m ? m[1] : null;
}

/**
 * The message with a completed private prefix removed.
 *
 * Also exported for one definition rather than a fourth hand-copied pattern - the composer's "clear"
 * control used its own, and after the widening it could not clear the very tokens the picker had just
 * inserted.
 */
export function stripPrivatePrefixFrom(text: string): string {
  // Delimited first, in the same order the token is resolved: stripping the bare pattern off a
  // delimited address would leave the closing bracket behind.
  // '$1' keeps a leading /md: only the ADDRESS is removed, never the rendering command.
  if (PRIVATE_PREFIX_DELIMITED.test(text)) return text.replace(PRIVATE_PREFIX_DELIMITED, '$1');
  return text.replace(PRIVATE_PREFIX, '$1');
}

/**
 * Characters that can appear INSIDE a name, so a following alphanumeric means the token continues.
 *
 * WHY A WORD-CHARACTER TEST IS NOT ENOUGH. The names a deployment uses are wider than `\w`: with
 * `\w` alone, `@alice@example.com`, `@alice-bob` and `@alice.smith` all counted as a mention of a
 * member called `alice`, because `@`, `-` and `.` are not word characters. Someone quoting an address
 * or naming a different person silently mentioned whoever held the shorter name.
 *
 * Punctuation is read by what FOLLOWS it: it continues a token when an alphanumeric comes next
 * (`@alice.smith`) and ends one when anything else does (`ask @alice.`, `@alice, can you`). Mirrors
 * `tokenContinues` in `backend/lambda/src/lib/flow-bypass.ts` - the two sides must agree on where a
 * mention ends or they disagree about who was addressed.
 */
const NAME_PUNCTUATION = new Set(['.', '@', '-', '_', '+']);

function tokenContinues(haystack: string, end: number): boolean {
  const after = haystack[end];
  if (!after) return false;
  if (/\w/.test(after)) return true;
  if (!NAME_PUNCTUATION.has(after)) return false;
  return /[a-z0-9]/i.test(haystack[end + 1] || '');
}

/**
 * Can this member be addressed with a dot at all?
 *
 * ONE THING DISQUALIFIES A NAME, AND IT IS WHITESPACE. The token runs from the dot to the first
 * space, so a name containing one cannot be expressed: `.Ryan McHarg hello` yields the token `Ryan`,
 * which names nobody, and the message goes to the room as ordinary text.
 *
 * IT USED TO DISQUALIFY FAR MORE. The token was a character class without `@` in it, so on a
 * deployment where members are named by email address NO human could be addressed privately. That
 * was the class doing safety work it was never the right tool for: the safety comes from requiring a
 * FULL match against the roster, which is why the token can now be any run of non-space characters.
 *
 * A picker that offered an unaddressable member would be offering an action the platform cannot
 * perform - the same fault as offering `all` in a list whose Target holds one member - so the picker
 * asks this first. `@` is unaffected either way: it matches inside a sentence and handles any name.
 */
export function canBeAddressedPrivately(name: string): boolean {
  // A space is no longer disqualifying - that is what the delimited form is for. What stays
  // unexpressible is a name carrying the delimiters themselves, or a newline.
  return name.trim().length > 0 && !/[<>\n]/.test(name) && name.length <= 128;
}

/**
 * How the picker writes this member.
 *
 * Delimited only when the bare token could not carry the name, so an ordinary address still reads as
 * `.Alice hello` in the message the recipient sees rather than `.<Alice> hello`. The person never
 * types the brackets; they are inserted with the name.
 */
export function privatePrefixFor(name: string, memberArn?: string): string {
  // ── THE PICKER WRITES THE ID, BECAUSE A DISPLAY NAME IS NOT UNIQUE ────────────────────────────
  //
  // A person's display name falls back to the email local part, so two members can carry one name,
  // and the backend has had to break the tie by preferring assistants - deterministic, but still a
  // guess, and it leaves a person who shares an assistant's name unaddressable.
  //
  // THIS COMPONENT ALREADY KNOWS WHICH MEMBER IT INSERTED. It sets `targetArn` on the send from the
  // same object. What it could not do is tell the CHANNEL FLOW, which sees no `Target` on its
  // callback - so the id goes where the flow can read it, in the text beside the name.
  //
  // Delimited whenever an id is written, because the bare form ends at whitespace and could not hold
  // the pair. The reader sees the name; the SPA renders the token and the id never reaches them.
  const id = memberArn ? memberArn.split('/').pop() : undefined;
  if (id) return `.<${name}|${id}> `;
  return /\s/.test(name) ? `.<${name}> ` : `.${name} `;
}

/**
 * The `@mention` token the picker writes: `@<Name|id>` when it knows the member, `@Name` otherwise.
 *
 * SAME REASON AS `privatePrefixFor`, AND THE SAME SHAPE, because it is the same problem: a display
 * name is not unique (it falls back to the email local part, so two members can carry one name), and
 * the CHANNEL FLOW cannot see who the client meant - its callback carries no `Target` and no
 * `MessageAttributes` at all, so the resolved ARNs in `CHIME.mentions` never reach it. The id
 * therefore goes where the flow can read it: in the text, beside the name.
 *
 * THE ATTRIBUTE IS NOT REPLACED, IT IS JOINED. `CHIME.mentions` still carries the
 * resolved ARNs and still drives notification and AUTO-routing, which read the message through APIs
 * that DO surface attributes. Two carriers for two consumers, neither redundant: the attribute is the
 * clean one and cannot reach the flow, the body one can.
 *
 * AND `Metadata` IS NOT AN OPTION, which is worth stating because it does reach the flow. It is
 * member-WRITABLE, so an id there could be rewritten by a different member to redirect somebody
 * else's mention - a routing decision sourced from a value any member can change. The sender's own
 * words are the honest source of who the sender addressed.
 */
export function mentionTokenFor(name: string, memberArn?: string): string {
  const id = memberArn ? memberArn.split('/').pop() : undefined;
  if (id) return `@<${name}|${id}> `;
  // No id to carry, so the bare form unless the name needs delimiting - the same fallback ladder the
  // private prefix uses, for the same reason: the bare token ends at whitespace.
  return /\s/.test(name) ? `@<${name}> ` : `@${name} `;
}

/** The name a private prefix addresses, or null. Exported so the composer decorates what it parsed. */
export function privatePrefixToken(content: string): string | null {
  // Delimited first, because it is unambiguous: `.<a b> c` can only be an address, while the bare
  // pattern would read `<a` as a name.
  const delimited = PRIVATE_PREFIX_DELIMITED.exec(content);
  if (delimited) return delimited[2];
  const m = PRIVATE_PREFIX.exec(content);
  return m ? m[2] : null;
}

/**
 * The NAME half of a private address, which is what a person reads and what every UI here shows.
 *
 * `privatePrefixToken` returns the raw token, and the picker now writes `Alice|sub-abc` into it. Every
 * surface that displays the address - the "Private to" chip, the decoration under the composer - wants
 * the name alone, so a caller that shows the raw token would put an id in front of the person.
 *
 * Mirrors `parsePrivateAddress` in `backend/lambda/src/lib/private-prefix.ts`. The two grammars are
 * separate copies and always have been; `mentionParser.test.ts` is what keeps them one grammar.
 */
export function privatePrefixAddress(
  content: string,
): { name: string; id?: string; raw: string } | null {
  const token = privatePrefixToken(content);
  if (!token) return null;
  // Split on the LAST separator, so `A|B|sub-123` reads as the name `A|B`. `raw` is kept because the
  // split is a guess about a name: a member genuinely called `A|B`, typed by hand, would otherwise
  // resolve as `A` and address the wrong person. Mirrors `parsePrivateAddress` on the backend.
  const cut = token.lastIndexOf('|');
  if (cut <= 0 || cut === token.length - 1) return { name: token, raw: token };
  return { name: token.slice(0, cut), id: token.slice(cut + 1), raw: token };
}

/** The NAME half alone, for the surfaces that show the address to a person. */
export function privatePrefixName(content: string): string | null {
  return privatePrefixAddress(content)?.name ?? null;
}

/**
 * Every delimited `@<Name|id>` token in the text, and the text with those tokens BLANKED.
 *
 * ── WHY BLANKED RATHER THAN REMOVED, AND WHY THAT MATTERS ────────────────────────────────────────
 *
 * Each token is replaced by exactly as many spaces as it occupied, so every index in the returned
 * string still matches the original. The mention scan records the index it matched at and sorts by it
 * to decide mention ORDER, so a length-changing rewrite would reorder mentions in a message with a
 * delimited token before a bare one.
 *
 * AND BLANKING IS WHAT LETS THE BARE-NAME SCAN STAY EXACTLY AS IT WAS. That scan carries boundary
 * logic learned from real misroutes - every occurrence tested rather than the first (so `@Samuel and
 * @Sam` finds both), both a leading and a trailing boundary (so `cc:@Sam` behaves identically here and
 * on the backend). Teaching it a second grammar would mean re-deriving all of that. Instead the
 * delimited tokens are resolved separately and removed from its view, so it sees only bare tokens and
 * its rules are unchanged.
 */
export function delimitedMentions(
  content: string,
): { tokens: Array<{ name: string; id?: string; raw: string; at: number }>; blanked: string } {
  const tokens: Array<{ name: string; id?: string; raw: string; at: number }> = [];
  // `[^<>\n]` mirrors the private prefix's delimited class: no nesting, no newline, bounded length.
  const pattern = /@<([^<>\n]{1,128})>/g;
  let blanked = content;
  for (const match of content.matchAll(pattern)) {
    const raw = match[1];
    const at = match.index ?? 0;
    // Split on the LAST separator, so `A|B|sub-1` reads as the name `A|B`. `raw` is kept because the
    // split is a guess about a name - the same reason `privatePrefixAddress` keeps it.
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

/**
 * The message with every `@<Name|id>` shown as `@Name`, for what a person reads.
 *
 * The id is for the channel flow, which cannot see `CHIME.mentions` and so has to read it out of the
 * text. It is not for the reader, and leaving it in puts a raw identifier in the middle of a sentence.
 * A name carrying whitespace keeps its brackets, because the bare form ends at the first space.
 */
export function withMentionNamesDisplayed(content: string): string {
  return content.replace(/@<([^<>\n]{1,128})>/g, (_m, raw: string) => {
    const cut = raw.lastIndexOf('|');
    const name = cut > 0 && cut < raw.length - 1 ? raw.slice(0, cut) : raw;
    return /\s/.test(name) ? `@<${name}>` : `@${name}`;
  });
}

/**
 * The message as a PERSON should read it: the address shown by name, with the id taken back out.
 *
 * THE ID IS FOR THE SERVER, NOT FOR THE READER. The composer writes `.<Name|id>` so the backend can
 * resolve the addressee by id rather than by matching a display name, which is what makes a private
 * address land on the member the picker actually selected. Nothing was undoing it at display, so a
 * recipient of `.<Alice|4f3c-...> can you check this` read the literal `Name|id` token - the id, the
 * pipe and the angle brackets included. The comment on `privatePrefixToken` asserted the opposite
 * ("the SPA renders the token and the id never reaches them") and no code did it.
 *
 * ONLY THE ID IS REMOVED. The address itself stays visible, because it is information the reader
 * needs: a message addressed to one person reads differently from one addressed to the room, and
 * stripping it entirely would make a private note look like an open one. So `.<Alice|id> text` renders
 * as `.Alice text`, and the bare `.Alice text` form is already what it should be and is returned
 * unchanged.
 *
 * Content with no private address is returned unchanged, so a caller can apply this to every message.
 */
export function withPrivateAddressDisplayed(content: string): string {
  const address = privatePrefixAddress(content);
  // No address, or a bare token that never carried an id: nothing to take out.
  if (!address || !address.id) return content;
  // Rebuild from the NAME half, keeping the delimited form only when the name needs it. A name with
  // no whitespace reads better bare, which is also the form somebody typing by hand would produce.
  const shown = /\s/.test(address.name) ? `.<${address.name}>` : `.${address.name}`;
  // `$1` preserves a leading `/md`, exactly as `stripPrivatePrefixFrom` does: the rendering command is
  // not part of the address.
  return content.replace(PRIVATE_PREFIX_DELIMITED, (_m, md: string | undefined) => `${md || ''}${shown} `);
}

/**
 * Parse `@<member>` mentions out of message text and decide what should
 * become the SendChannelMessage Target and CHIME.mentions attribute.
 *
 * Rules (single-target, enforced):
 *  - `@all` / `@everyone` → no Target, no CHIME.mentions. The channel flow
 *    sees the broadcast intent and hands the turn to the agent handler.
 *  - `@all` combined with any `@<member>` → `error: 'all_with_member'`.
 *  - At most one human and at most one bot may be mentioned. The Chime
 *    SDK `SendChannelMessage.Target` field is fixed at 1 item by the AWS
 *    API (TS type is `Target[]` but the API enforces "Array Members:
 *    Fixed number of 1 item.") — see `reference_chime_target_fixed_one`.
 *  - More than one distinct human → `error: 'multiple_humans'`.
 *  - More than one distinct bot → `error: 'multiple_bots'`.
 *  - `@<member>` sets NO Target (ADR-034): addressing is not privacy. The
 *    mentioned members ride CHIME.mentions, and the channel flow routes an
 *    `@<assistant>` in a group. The reply is broadcast.
 *  - `.<member>` is the private form: Target = that member, no mentions.
 */
export function parseMentions(
  content: string,
  members: ChannelMember[],
  currentUserArn: string,
): MentionParseResult {
  const candidates = members.filter((m) => m.userArn !== currentUserArn && m.name);
  // ── THE DELIMITED MENTIONS ARE RESOLVED SEPARATELY, AND HIDDEN FROM THE BARE-NAME SCAN ──────────
  //
  // `@<Name|id>` is what the picker writes, so the flow can resolve the member by
  // id rather than by matching a display name two people can share. Blanking keeps every index aligned
  // with the original, so mention ORDER is unchanged, and it leaves the bare-name scan below looking
  // at exactly the tokens it was written for.
  const { tokens: delimited, blanked } = delimitedMentions(content);
  const lower = blanked.toLowerCase();

  /** The member a delimited token names: BY ID FIRST, falling back to the name it carried. */
  const memberForToken = (token: { name: string; id?: string; raw: string }): ChannelMember | undefined =>
    (token.id ? candidates.find((m) => m.userArn?.split('/').pop() === token.id) : undefined)
    ?? candidates.find((m) => m.name.toLowerCase() === token.name.toLowerCase()
      || m.name.toLowerCase() === token.raw.toLowerCase());

  /** Every delimited mention that resolved, with the position it was written at. */
  const delimitedMatches = delimited
    .map((t) => ({ member: memberForToken(t), index: t.at }))
    .filter((m): m is { member: ChannelMember; index: number } => !!m.member);

  // ── THE PRIVATE PREFIX, RESOLVED FIRST (ADR-034) ──
  //
  // It is the only thing that sets a Target, so it is settled before anything else can claim one.
  //
  // A DOT FOLLOWED BY A REAL MEMBER'S NAME, OR IT IS NOT A PRIVATE PREFIX AT ALL.
  // The token must match a member of THIS conversation in full - not a prefix of one, not something
  // name-shaped - and when it matches nobody the message is ordinary text that happens to begin with
  // a dot.
  //
  // THIS USED TO REFUSE THE SEND, and the refusal was worse than the thing it guarded. The regex
  // matches far more than names: ".env is missing", ".gitignore needs a line", "...ok then" and
  // ".5s is fine" all produce a token, none resolve, and the composer told the person "That name is
  // not in this conversation" and would not send. In a room where people discuss code those are
  // everyday sentences, and the feature made them unsendable.
  //
  // WHAT STILL PROTECTS THE EXPENSIVE MISTAKE. Privacy is never inferred from a near miss, so there
  // is no guess to get wrong; and the composer decorates the token the instant it resolves, so a
  // person typing `.Sam` when Sam is not here sees no "Private to Sam" chip before they commit. The
  // signal is the presence of the decoration rather than the refusal of the send - which is the
  // mechanism this feature was asked for with.
  // BY ID FIRST (see `privatePrefixAddress`): this is what decides the Chime `Target`, so resolving
  // it by a name two members can share is the one place the ambiguity actually costs privacy.
  const privateAddress = privatePrefixAddress(content);
  const privateToken = privateAddress?.name ?? null;
  const privateMember = privateAddress
    ? (privateAddress.id
        ? candidates.find((m) => m.userArn?.split("/").pop() === privateAddress.id)
        : undefined)
      ?? candidates.find((m) => m.name.toLowerCase() === privateAddress.name.toLowerCase()
         || m.name.toLowerCase() === privateAddress.raw.toLowerCase())
    : undefined;
  if (privateToken && privateMember) {
    const member = privateMember;
    // A mention alongside it is a contradiction, not a combination: one says only this member may
    // read the message, the other says notify them and let everyone read it.
    // A DELIMITED MENTION COUNTS TOO. It is blanked out of `lower`, so the scan below cannot see it -
    // without this, `.Carol @<Sam|sub-1> hi` would pass the contradiction check and go out privately
    // to Carol carrying a live mention of Sam, which is the exact failure the loop below records for
    // the bare form.
    if (AT_ALL_PATTERN.test(content) || delimitedMatches.length > 0 || candidates.some((m) => {
      const needle = `@${m.name.toLowerCase()}`;
      // EVERY OCCURRENCE, NOT THE FIRST. `indexOf` returns one index, and if that occurrence failed
      // the boundary test the scan stopped and declared no mention - so ".Carol @Samuel and @Sam hi"
      // passed the contradiction check and went out privately to Carol with a live `@Sam` in its
      // text: one member reads a message that names, and appears to address, another. The backend
      // resolver loops; this is the same rule, so it loops too.
      for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
        // BOTH boundaries, the same two the mention scan below applies and the backend resolver
        // requires. The end test used to stand alone (and, for a while, carried a `[w]` typo that
        // tested for the literal letter "w"), so `cc:@Sam` counted as a mention here and not there -
        // and `.Carol cc:@Sam later` was refused as a private message with a mention in it while the
        // backend would have sent it as an ordinary private message.
        const before = i === 0 ? '' : lower[i - 1];
        if (before && !/\s/.test(before)) continue;
        if (!tokenContinues(lower, i + needle.length)) return true;
      }
      return false;
    })) {
      return { isAtAll: false, mentionedArns: [member.userArn], error: 'private_with_mention' };
    }
    return {
      isAtAll: false,
      targetArn: member.userArn,
      privateToArn: member.userArn,
      privateToName: member.name,
      mentionedArns: [member.userArn],
    };
  }

  const matched: Array<{ member: ChannelMember; index: number }> = [];
  for (const member of candidates) {
    const needle = `@${member.name.toLowerCase()}`;
    // EVERY OCCURRENCE, AND BOTH BOUNDARIES - the same scan the backend resolver runs.
    //
    // It tested ONE `indexOf` and gave up if that occurrence failed the end test. With Sam and Samuel
    // both in the room, "@Samuel and @Sam please review" found Sam only inside `@samuel`, dropped
    // him, and sent with no mention attribute for him: no notification, and the multiple-humans guard
    // never fired either. The contradiction check twenty lines above already loops for this reason.
    //
    // The LEADING boundary was missing entirely, and the backend requires it. `cc:@Sam` was a mention
    // to this side and not to that one - and `.Carol cc:@Sam later` was refused here as a private
    // message carrying a mention while the backend would have sent it as an ordinary private message.
    for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, index + 1)) {
      const before = index === 0 ? '' : lower[index - 1];
      if (before && !/\s/.test(before)) continue;
      if (tokenContinues(lower, index + needle.length)) continue;
      matched.push({ member, index });
      break;
    }
  }

  // The delimited matches join the bare ones, deduplicated by member: a message may name somebody
  // once with an id and once without, and that is one mention of one person.
  // THE LONGER NAME WINS AT ONE POSITION, the rule the channel flow's resolver applies
  // (`flow-bypass.ts`). `@Advisor (alt)` also contains `@Advisor`, and counting both read one address as
  // two assistants and refused the send as `multiple_bots`, while the backend would have resolved it.
  for (let i = matched.length - 1; i >= 0; i--) {
    const m = matched[i];
    if (matched.some((o) => o !== m && o.index === m.index && o.member.name.length > m.member.name.length)) {
      matched.splice(i, 1);
    }
  }

  for (const d of delimitedMatches) {
    if (!matched.some((m) => m.member.userArn === d.member.userArn)) matched.push(d);
  }

  matched.sort((a, b) => a.index - b.index);
  const mentionedArns = matched.map((m) => m.member.userArn);

  const isAtAll = AT_ALL_PATTERN.test(content);

  if (isAtAll && matched.length > 0) {
    return { isAtAll: true, mentionedArns, error: 'all_with_member' };
  }

  if (isAtAll) {
    return { isAtAll: true, mentionedArns: [] };
  }

  const humans = matched.filter((m) => !m.member.isBot);
  const bots = matched.filter((m) => m.member.isBot);

  if (humans.length > 1) {
    return { isAtAll: false, mentionedArns, error: 'multiple_humans' };
  }
  if (bots.length > 1) {
    return { isAtAll: false, mentionedArns, error: 'multiple_bots' };
  }

  if (matched.length === 0) {
    return { isAtAll: false, mentionedArns: [] };
  }

  const humanMatch = humans[0];
  const botMatch = bots[0];

  // NO `targetArn` ON EITHER BRANCH (ADR-034). An `@` mention notifies the member it names and
  // leaves the message readable by the conversation. Setting a Target here is what used to make
  // "ask Sam a question in front of the group" impossible to express.
  if (humanMatch) {
    return {
      isAtAll: false,
      mentionBotArn: botMatch?.member.userArn,
      mentionedArns,
    };
  }

  return {
    isAtAll: false,
    mentionBotArn: botMatch!.member.userArn,
    mentionedArns,
  };
}

/** Human-readable copy for a validation error. Kept here so other surfaces
 *  (composer hint, error toast, etc.) render the same wording. */
export function mentionValidationMessage(error: MentionValidationError): string {
  switch (error) {
    case 'multiple_humans':
      return "Pick one person — direct messages can only target one member at a time. Use @all to address everyone.";
    case 'multiple_bots':
      return "Pick one assistant — only one can be mentioned per message.";
    case 'all_with_member':
      return "Use either @all or specific @-mentions, not both.";
    case 'private_with_mention':
      return "A private message goes to one member only. Remove the @-mention, or remove the dot to send it to everyone.";
  }
}
