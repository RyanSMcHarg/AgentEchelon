/**
 * THE COMPOSER'S DRAFT: what the person reads in the field, and the members it names beside it (ADR-040).
 *
 * The field shows a picked member as `@Name` (or `.Name` for a private address). The member's id rides beside the words,
 * as a range of the text and the token it stands for, and the draft is written as `@<Name|id>` / `.<Name|id>` only when
 * it is sent, which is the form the server and routing resolve.
 *
 * - An edit outside a mention keeps it, moved with the text around it.
 * - An edit inside a mention, or one that removes part of it, leaves its words as plain text: what remains is what the
 *   person typed, and it carries no id.
 */

import { ADDRESS_TOKEN, MENTION_TOKEN, splitAddressToken } from '@ae/shared/utils/addressTokens.ts';

/** A picked member in the draft: `text.slice(start, end)` is what the person reads, `token` what is sent. */
export interface DraftMention {
  start: number;
  end: number;
  token: string;
}

export interface ComposerDraft {
  text: string;
  mentions: DraftMention[];
}

export const EMPTY_DRAFT: ComposerDraft = { text: '', mentions: [] };

/** A character that carries a name on: a picked name followed by one is a longer word. */
const NAME_CONTINUES = /[\p{L}\p{N}_-]/u;

/**
 * The draft without the picked members a longer member's name now stands over: `@Advisor` followed by ` (alt)` reads as the
 * member named `Advisor (alt)`, so the shorter pick's id is let go and the words say who is meant. `names` are the
 * conversation's member names.
 */
export function withoutShadowedMentions(draft: ComposerDraft, names: readonly string[]): ComposerDraft {
  if (draft.mentions.length === 0) return draft;
  const lower = draft.text.toLowerCase();
  const kept = draft.mentions.filter((m) => {
    const shown = draft.text.slice(m.start + 1, m.end).toLowerCase();
    return !names.some((raw) => {
      const name = raw.trim().toLowerCase();
      if (name.length <= shown.length || !name.startsWith(shown)) return false;
      const end = m.start + 1 + name.length;
      return lower.slice(m.start + 1, end) === name && !NAME_CONTINUES.test(draft.text.charAt(end));
    });
  });
  return kept.length === draft.mentions.length ? draft : { text: draft.text, mentions: kept };
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * The draft after its text becomes `next`. `caret` is where the cursor stands after the edit, when known: the changed
 * span ends there, which places an insertion beside a mention correctly where the characters alone could not.
 */
export function editDraft(draft: ComposerDraft, next: string, caret?: number): ComposerDraft {
  const prev = draft.text;
  if (prev === next) return draft;
  if (draft.mentions.length === 0) return { text: next, mentions: [] };
  let suffix = commonSuffix(prev, next);
  if (typeof caret === 'number' && caret >= 0 && caret <= next.length) suffix = Math.min(suffix, next.length - caret);
  const prefix = Math.min(commonPrefix(prev, next), prev.length - suffix, next.length - suffix);
  const changedEnd = prev.length - suffix;
  const delta = next.length - prev.length;
  const mentions: DraftMention[] = [];
  for (const m of draft.mentions) {
    const shown = prev.slice(m.start, m.end);
    let moved: DraftMention | null = null;
    if (m.end <= prefix) moved = m;
    else if (m.start >= changedEnd) moved = { ...m, start: m.start + delta, end: m.end + delta };
    // THE NAME STILL ENDS WHERE IT ENDED: text typed straight onto a picked name makes a longer word (`@Sam` + `antha`),
    // which is the person's own typing and carries no id.
    if (moved && next.slice(moved.start, moved.end) === shown && !NAME_CONTINUES.test(next.charAt(moved.end))) mentions.push(moved);
  }
  return { text: next, mentions };
}

/**
 * The draft with `[from, to)` replaced by a picked member: `shown` in the text, followed by a space, with `token` beside
 * it. A `shown` equal to its token (a name with no id) is ordinary text.
 */
export function pickIntoDraft(draft: ComposerDraft, from: number, to: number, shown: string, token: string): ComposerDraft {
  const inserted = `${shown} `;
  const text = draft.text.slice(0, from) + inserted + draft.text.slice(to);
  const delta = inserted.length - (to - from);
  const kept = draft.mentions
    .filter((m) => m.end <= from || m.start >= to)
    .map((m) => (m.start >= to ? { ...m, start: m.start + delta, end: m.end + delta } : m));
  const mentions = shown === token ? kept : [...kept, { start: from, end: from + shown.length, token }];
  return { text, mentions: mentions.sort((a, b) => a.start - b.start) };
}

/** The draft as it is sent: each picked member written as its token. */
export function encodeDraft(draft: ComposerDraft): string {
  let out = draft.text;
  for (const m of [...draft.mentions].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, m.start) + m.token + out.slice(m.end);
  }
  return out;
}

// THE ONE TOKEN GRAMMAR (`@ae/shared/utils/addressTokens.ts`): every reader of a sent-form token in this app reads it
// through these, so the composer, the send check and the received-message check never disagree on where a token ends.
const ENCODED_ADDRESS = ADDRESS_TOKEN;
const ENCODED_MENTION = MENTION_TOKEN;

function nameOf(raw: string): string {
  return splitAddressToken(raw).name;
}

/** The private address sent-form text opens with (`.<Name|id>`, after an optional `/md`): its name and member id. */
export function encodedPrivateAddress(text: string): { name: string; id?: string } | undefined {
  const m = ENCODED_ADDRESS.exec(text);
  return m ? splitAddressToken(m[2]) : undefined;
}

/** A draft read from sent-form text: each `@<Name|id>` and the leading `.<Name|id>` shown by its name. */
export function draftFromEncoded(encoded: string): ComposerDraft {
  const found: Array<{ at: number; length: number; shown: string; token: string }> = [];
  const address = ENCODED_ADDRESS.exec(encoded);
  if (address) {
    const at = address[1].length;
    const token = address[0].slice(at);
    found.push({ at, length: token.length, shown: `.${nameOf(address[2])}`, token });
  }
  for (const m of encoded.matchAll(ENCODED_MENTION)) {
    found.push({ at: m.index ?? 0, length: m[0].length, shown: `@${nameOf(m[1])}`, token: m[0] });
  }
  found.sort((a, b) => a.at - b.at);
  let text = '';
  let cursor = 0;
  const mentions: DraftMention[] = [];
  for (const f of found) {
    if (f.at < cursor) continue;
    text += encoded.slice(cursor, f.at);
    mentions.push({ start: text.length, end: text.length + f.shown.length, token: f.token });
    text += f.shown;
    cursor = f.at + f.length;
  }
  text += encoded.slice(cursor);
  return { text, mentions };
}

/** Whether a picked member's text starts at `index`, so a picker opened there would complete what is already picked. */
export function mentionStartsAt(draft: ComposerDraft, index: number): boolean {
  return draft.mentions.some((m) => m.start === index);
}

/** Where the message itself starts: after any leading space and an optional `/md` command, which stay in front. */
export function messageStart(text: string): number {
  return /^\s*(?:\/md\s+)?/i.exec(text)?.[0].length ?? 0;
}


/**
 * The private address the draft opens with, as `[start, end)` of its text, or null: a picked `.Name`, a delimited
 * `.<Name>` typed by hand, or a `.` followed by a member's whole name (the longest that fits). A leading dot-word that
 * names no member (`.env`) is the person's words and is no address. `names` are the conversation's member names.
 */
export function leadingPrivateAddress(draft: ComposerDraft, names: readonly string[]): { start: number; end: number } | null {
  const at = messageStart(draft.text);
  const picked = draft.mentions.find((m) => m.start === at && m.token.startsWith('.'));
  if (picked) return { start: picked.start, end: picked.end };
  if (draft.text[at] !== '.') return null;
  // A private address typed in its delimited form, `.<Name>` or `.<Name|id>`, read by the one grammar.
  const delimited = ENCODED_ADDRESS.exec(draft.text);
  if (delimited && delimited[1].length === at) return { start: at, end: delimited[0].length };
  const rest = draft.text.slice(at + 1).toLowerCase();
  let longest = 0;
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name || name.length <= longest || !rest.startsWith(name) || NAME_CONTINUES.test(rest.charAt(name.length))) continue;
    longest = name.length;
  }
  return longest ? { start: at, end: at + 1 + longest } : null;
}

/**
 * The draft addressed privately to a member: `shown` (`.Name`) with `token` beside it, at the front of the message after
 * any `/md` command, in place of the private address already there and of nothing else. Answers the caret after it.
 */
export function addressPrivatelyInDraft(
  draft: ComposerDraft, shown: string, token: string, names: readonly string[],
): { draft: ComposerDraft; caret: number } {
  const lead = leadingPrivateAddress(draft, names);
  const from = lead ? lead.start : messageStart(draft.text);
  // The space after a replaced address is the one the pick writes, so it is taken with the address.
  const to = lead ? lead.end + (draft.text[lead.end] === ' ' ? 1 : 0) : from;
  return { draft: pickIntoDraft(draft, from, to, shown, token), caret: from + shown.length + 1 };
}

/**
 * The draft with a member mentioned at `caret`: `shown` (`@Name`) with `token` beside it. A mention never goes in front
 * of the `/md` command or of a leading private address, which mean something only at the front, so a caret there places
 * it just after them. A space goes before it where the text runs right up to it. Answers the caret after it.
 */
export function mentionInDraft(
  draft: ComposerDraft, caret: number, shown: string, token: string, names: readonly string[],
): { draft: ComposerDraft; caret: number } {
  const lead = leadingPrivateAddress(draft, names);
  const floor = lead ? lead.end + (draft.text[lead.end] === ' ' ? 1 : 0) : messageStart(draft.text);
  let at = Math.max(Math.min(caret, draft.text.length), floor);
  let d = draft;
  if (at > 0 && !/\s/.test(d.text[at - 1])) {
    d = editDraft(d, `${d.text.slice(0, at)} ${d.text.slice(at)}`, at + 1);
    at += 1;
  }
  return { draft: pickIntoDraft(d, at, at, shown, token), caret: at + shown.length + 1 };
}
