/**
 * The reference a person types to say which open item a message answers (ADR-035): `#<n>` at the
 * start of the message, after any `@` mentions and an optional `re`.
 *
 * THE SAME GRAMMAR THE ROUTER READS (`backend/lambda/src/lib/task-reference.ts`). The web client only
 * RECOGNIZES one; it does not write one. A person who types `#2` is answering item 2 and the composer
 * says so, and the decision is still made from the text on the server, the same way it is for a reply
 * sent by SMS or email. When the person picks an item with its Answer action instead, the client sends
 * the item's id in the message Metadata and the text stays theirs.
 */

const REFERENCE_AT_START = /^\s*(?:@\S+\s+)*(?:re:?\s+)?#(\d{1,6})(?![\w#])[\s:,.-]*/i;

/** The reference at the start of `text`, or null. */
export function taskReferenceOf(text: string | undefined): number | null {
  if (!text) return null;
  const match = REFERENCE_AT_START.exec(text);
  if (!match) return null;
  const ref = Number(match[1]);
  return Number.isInteger(ref) && ref > 0 ? ref : null;
}

/**
 * `text` without a leading reference, for the dismiss action on a reference the person TYPED.
 *
 * Its counterpart, which wrote a reference INTO the composer for them, is gone: choosing an item now
 * travels as `{ task: { id } }` in the message Metadata instead of as words in the message, so the
 * client no longer writes routing syntax into what the room reads. Reading a typed one still matters,
 * because a reply arriving by SMS or email carries nothing else.
 */
export function withoutTaskReference(text: string): string {
  const match = /^\s*(?:re:?\s+)?#\d{1,6}(?![\w#])[\s:,.-]*/i.exec(text);
  return match ? text.slice(match[0].length) : text;
}
