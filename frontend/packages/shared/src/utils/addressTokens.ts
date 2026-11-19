/**
 * How a message's address tokens read to a person.
 *
 * The chat composer writes a mention as `@<Name|id>` and a private address as `.<Name|id>` at the
 * start of the message. The id is for the server, which resolves the member by it rather than by a
 * display name that two members can share. It stays in the stored message unchanged. A reader sees
 * the name only: never the id, the pipe or the angle brackets.
 *
 * Two forms, one grammar:
 *  - `encodeAddressTokens` replaces each token with a short placeholder and returns the tokens, for a
 *    renderer that draws each one as a styled chip (the chat app's message body).
 *  - `readableAddressText` returns plain text (`@Name`, `.Name`), for a surface that shows a string
 *    (a widget bubble, a console preview, a task title).
 *
 * The grammar mirrors `delimitedMentions` and `privatePrefixAddress` in the chat app's
 * `mentionParser.ts` and `parsePrivateAddress` on the backend: `[^<>\n]{1,128}` inside the brackets,
 * split on the LAST `|`, and the private address only at the start of the message after an optional
 * `/md` command.
 */

export interface AddressToken {
  /** `mention` is `@<Name|id>` anywhere in the text; `address` is the leading `.<Name|id>`. */
  kind: 'mention' | 'address';
  /** The name the sender saw when they picked the member. */
  name: string;
  /** The member id the token carries, when it carries one. */
  id?: string;
}

/** Resolves a member id to the member's current display name, or undefined when it is not known. */
export type MemberNameResolver = (id: string) => string | undefined;

/** Opens and closes a token's placeholder. Private-use code points, which no person types and markdown leaves alone. */
export const TOKEN_OPEN = '';
export const TOKEN_CLOSE = '';

/** A whole placeholder: the opener, the token's index, the closer. */
export const TOKEN_PLACEHOLDER = /(\d+)/g;

/**
 * THE DELIMITED TOKEN GRAMMAR, defined once for the client's readers: a mention `@<Name|id>` anywhere (group 1 is what
 * the brackets hold), and a private address `.<Name|id>` at the start of the message after an optional `/md` command
 * (group 1 is what comes before it, group 2 what the brackets hold). The chat app's composer and its target check read
 * these; `mentionParser.ts` keeps the copy the backend's grammar test reads.
 */
export const MENTION_TOKEN = /@<([^<>\n]{1,128})>/g;
export const ADDRESS_TOKEN = /^(\s*(?:\/md\s+)?)\.<([^<>\n]{1,128})>(?=\s|$)/i;
const MENTION = MENTION_TOKEN;
const ADDRESS = ADDRESS_TOKEN;

/** What a token's brackets hold, split on the LAST `|` into the name and the member id, when there is one. */
export function splitAddressToken(raw: string): { name: string; id?: string } {
  const cut = raw.lastIndexOf('|');
  if (cut > 0 && cut < raw.length - 1) return { name: raw.slice(0, cut), id: raw.slice(cut + 1) };
  return { name: raw };
}
const split = splitAddressToken;

/** The name a token shows: the member's current name when the id resolves, else the name it was written with. */
export function shownName(token: AddressToken, resolveName?: MemberNameResolver): string {
  const resolved = token.id && resolveName ? resolveName(token.id) : undefined;
  return resolved && resolved.trim() ? resolved : token.name;
}

/** The plain form a person reads: `@Name` for a mention, `.Name` for a private address. */
export function tokenText(token: AddressToken, resolveName?: MemberNameResolver): string {
  return `${token.kind === 'address' ? '.' : '@'}${shownName(token, resolveName)}`;
}

/** A conversation member as the bare-mention scan reads it: the ARN's last segment is its id. */
export interface AddressableMember {
  userArn: string;
  name?: string;
}

/** Characters that can appear inside a name, so a following alphanumeric means the token continues. */
const NAME_PUNCTUATION = new Set(['.', '@', '-', '_', '+']);

/**
 * Whether the name token that would end at `end` continues past it.
 *
 * A word character continues it; `.`, `@`, `-`, `_` and `+` continue it when an alphanumeric follows
 * (`@alice.smith`) and end it otherwise (`ask @alice.`). The composer's `parseMentions` and the
 * channel flow's resolver apply the same rule, so a name drawn as a mention here is one they resolve.
 */
export function nameTokenContinues(haystack: string, end: number): boolean {
  const after = haystack[end];
  if (!after) return false;
  if (/\w/.test(after)) return true;
  if (!NAME_PUNCTUATION.has(after)) return false;
  return /[a-z0-9]/i.test(haystack[end + 1] || '');
}

/** A member the bare-mention scan can match: its name, the name lowercased, and its id. */
interface NamedMember {
  name: string;
  needle: string;
  id?: string;
}

/**
 * The members the bare-mention scan matches, longest name first. Built once per member list and kept while that list is
 * the same array, so the messages of one conversation share one sorted list rather than each sorting its own.
 */
const namedByMembers = new WeakMap<ReadonlyArray<AddressableMember>, NamedMember[]>();

function namedMembers(members: ReadonlyArray<AddressableMember>): NamedMember[] {
  const cached = namedByMembers.get(members);
  if (cached) return cached;
  const named = members
    .filter((m): m is AddressableMember & { name: string } => !!m.name && m.name.trim().length > 0)
    .map((m) => ({ name: m.name, needle: m.name.toLowerCase(), id: m.userArn.split('/').pop() || undefined }))
    .sort((a, b) => b.name.length - a.name.length);
  namedByMembers.set(members, named);
  return named;
}

/** An opening or closing code fence: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The spans of `text` that are code, each `[start, end)` and covering its delimiters: a fenced block (three or more
 * backticks or tildes, closed by a fence of the same character at least as long, or running to the end of the text) and
 * inline code (a run of backticks closed by the next run of the same length). Nothing inside one is read as a mention.
 */
export function codeSpans(text: string): Array<[number, number]> {
  if (!text.includes('`') && !text.includes('~~~')) return [];
  const fenced: Array<[number, number]> = [];
  let open: { char: string; length: number; start: number } | null = null;
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const fence = FENCE.exec(text.slice(lineStart, lineEnd));
    if (open) {
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length) {
        fenced.push([open.start, lineEnd]);
        open = null;
      }
    } else if (fence) {
      open = { char: fence[1][0], length: fence[1].length, start: lineStart };
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (open) fenced.push([open.start, text.length]);

  const inFence = (i: number) => fenced.some(([s, e]) => i >= s && i < e);
  const inline: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`' || inFence(i)) { i += 1; continue; }
    let run = 1;
    while (text[i + run] === '`') run += 1;
    let j = i + run;
    let closedAt = -1;
    while (j < text.length) {
      if (text[j] !== '`') { j += 1; continue; }
      let close = 1;
      while (text[j + close] === '`') close += 1;
      if (close === run) { closedAt = j + close; break; }
      j += close;
    }
    if (closedAt === -1) { i += run; continue; }
    inline.push([i, closedAt]);
    i = closedAt;
  }
  return [...fenced, ...inline].sort((a, b) => a[0] - b[0]);
}

/**
 * The text with each typed `@Name` that names a member replaced by a placeholder.
 *
 * A mention typed by hand is a bare `@Name`, and it addresses that member exactly as the picker's `@<Name|id>` does.
 * Every member is matched, people and assistants alike, case-insensitively, with the boundaries `parseMentions` uses:
 * the `@` starts the text or follows whitespace, and the name does not continue past its end. At one position the
 * longest name wins, so `@Advisor (alt)` is one mention and not `@Advisor`. Code (an inline span or a fenced block) is
 * left exactly as written.
 */
function encodeBareMentions(
  text: string,
  members: ReadonlyArray<AddressableMember>,
  placeholder: (token: AddressToken) => string,
): string {
  if (!text.includes('@')) return text;
  const named = namedMembers(members);
  if (named.length === 0) return text;
  const code = codeSpans(text);

  let out = '';
  let i = 0;
  let span = 0;
  while (i < text.length) {
    while (span < code.length && code[span][1] <= i) span += 1;
    if (span < code.length && code[span][0] <= i) {
      out += text.slice(i, code[span][1]);
      i = code[span][1];
      continue;
    }
    if (text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
      const hit = named.find((m) =>
        text.slice(i + 1, i + 1 + m.name.length).toLowerCase() === m.needle
        && !nameTokenContinues(text, i + 1 + m.name.length));
      if (hit) {
        out += placeholder({ kind: 'mention', name: hit.name, ...(hit.id ? { id: hit.id } : {}) });
        i += 1 + hit.name.length;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/**
 * The text with each address token replaced by a placeholder, and the tokens in placeholder order.
 *
 * The placeholder holds no character markdown reads, so a renderer can parse the text as markdown
 * and then swap each placeholder for its chip, whatever the name contains.
 *
 * Given the conversation's members, a typed `@Name` that names one of them is a mention token too, so
 * every member a message mentions reads as a chip however the mention was written.
 */
export function encodeAddressTokens(
  content: string,
  members?: ReadonlyArray<AddressableMember>,
): { text: string; tokens: AddressToken[] } {
  const tokens: AddressToken[] = [];
  const placeholder = (token: AddressToken) => {
    tokens.push(token);
    return `${TOKEN_OPEN}${tokens.length - 1}${TOKEN_CLOSE}`;
  };
  // The address first: it sits at the start, and `.<` never begins a mention.
  let text = content.replace(ADDRESS, (_m, lead: string, raw: string) => `${lead}${placeholder({ kind: 'address', ...split(raw) })}`);
  text = text.replace(MENTION, (_m, raw: string) => placeholder({ kind: 'mention', ...split(raw) }));
  if (members) text = encodeBareMentions(text, members, placeholder);
  return { text, tokens };
}

/** Text with every placeholder replaced by its token's plain form. A placeholder naming no token is removed. */
export function decodeToPlainText(text: string, tokens: AddressToken[], resolveName?: MemberNameResolver): string {
  return text.replace(TOKEN_PLACEHOLDER, (_m, i: string) => {
    const token = tokens[Number(i)];
    return token ? tokenText(token, resolveName) : '';
  });
}

/** The message as plain text a person reads: `@Name` and `.Name`, with no id, pipe or brackets. */
export function readableAddressText(content: string, resolveName?: MemberNameResolver): string {
  const { text, tokens } = encodeAddressTokens(content);
  return tokens.length ? decodeToPlainText(text, tokens, resolveName) : content;
}

/**
 * A resolver over a member list, matching a token's id to the last segment of the member's ARN.
 *
 * The composer writes that segment as the id (`mentionTokenFor`, `privatePrefixFor`), for a person
 * and an assistant alike.
 */
export function memberNameResolver(members: ReadonlyArray<{ userArn: string; name?: string }>): MemberNameResolver {
  const byId = new Map<string, string>();
  for (const m of members) {
    const id = m.userArn.split('/').pop();
    if (id && m.name) byId.set(id, m.name);
  }
  return (id) => byId.get(id);
}

/**
 * `@humans` at the front of an assistant's message: the notification bridge's address to the conversation's people. It
 * ends where a name could not go on, so `@humans-team` is a different word and stays.
 */
const LEADING_HUMANS = /^\s*@humans(?![\p{L}\p{N}_-])[,:]?\s*/iu;

/**
 * An assistant's message as a reader sees it: the `@humans` address at its front is how the notification bridge reaches
 * the conversation's people, never words for them, so it is not shown. Only for a message an assistant sent; a person's
 * own `@humans` is their words.
 */
export function shownAssistantText(content: string): string {
  return content.replace(LEADING_HUMANS, '');
}

/**
 * Whether `index` falls inside code in `text`, counting code still being typed: a code span or block that covers it, or
 * a backtick before it that nothing has closed yet. The composer opens no mention picker there.
 */
export function insideCode(text: string, index: number): boolean {
  const spans = codeSpans(text);
  const covered = (i: number) => spans.some(([s, e]) => i >= s && i < e);
  if (covered(index)) return true;
  for (let i = 0; i < index; i++) {
    if (text[i] === '`' && !covered(i)) return true;
  }
  return false;
}
