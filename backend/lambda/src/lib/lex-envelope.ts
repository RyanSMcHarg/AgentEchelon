/**
 * The Lex fulfillment envelope, recognised WITHOUT a ContentType.
 *
 * Amazon Chime SDK materialises a channel message from a bot's Lex fulfillment response and persists
 * it with the envelope intact:
 *
 *     {"Messages":[{"Content":"One moment... <!--corr:...-->","ContentType":"PlainText"}]}
 *
 * An EMPTY envelope (`{"Messages":[]}`) is how a handler says "fulfilled, show the user nothing"
 * (`formatLexSilentResponse`, ADR-022). Chime posts it anyway, so something lands in the channel that
 * is not a message. This module is the single BACKEND source of truth for recognising that shape.
 *
 * WHY THIS CANNOT REUSE THE CLIENT'S RULE. `frontend/packages/shared/src/utils/messageParser.ts`
 * gates on the ContentType `application/amz-chime-lex-msgs`, which is the precise discriminator and
 * is available to a client reading a persisted message. It is NOT available here: the channel-flow
 * invocation payload carries `MessageId` / `Content` / `Metadata` / `Sender` / `Target` and no
 * content type (the SDK's `ChannelMessage` has no `ContentType` field - only `ChannelMessageCallback`,
 * the shape we send BACK, does). `admin-conversations.ts` hit the identical wall reading the archive
 * ("the archived Payload carries no ContentType") and solved it structurally; that helper is now this
 * one, so the rule lives in one place instead of two.
 *
 * WHAT MAKES A STRUCTURAL TEST SAFE. Dropping a real answer is far worse than leaving an envelope, so
 * the shape is deliberately narrower than the client's: a top-level object whose ONLY key is
 * `Messages`. An assistant answer is prose, or prose plus a fenced code block - a fenced block does
 * not parse as JSON at all, and a bare `{"Messages":[]}` with nothing else is not a reply anyone
 * writes. The `Object.keys(...).length === 1` clause is what carries that guarantee; loosening it
 * would start eating user content.
 *
 * CONTENT MAY BE PERCENT-ENCODED. The channel flow sees Content in either form (see the `@all` /
 * `/battle` detection, which tests both for the same reason), so both are tested here.
 */

function decodeIfPossible(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse `content` as a bare Lex envelope, or return null if it is not one. */
function parseEnvelope(content: string): { Messages: unknown[] } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"Messages"')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.Messages) &&
      Object.keys(parsed).length === 1
    ) {
      return parsed as { Messages: unknown[] };
    }
  } catch {
    /* not an envelope */
  }
  return null;
}

/**
 * Is this a Lex envelope carrying NO messages - i.e. nothing a human should ever see?
 *
 * Tested against the raw and the percent-decoded form, because either can reach a reader.
 */
export function isEmptyLexEnvelope(content: string | null | undefined): boolean {
  if (!content) return false;
  for (const form of new Set([content, decodeIfPossible(content)])) {
    const envelope = parseEnvelope(form);
    if (envelope && envelope.Messages.length === 0) return true;
  }
  return false;
}

/**
 * Unwrap a Lex envelope to its human-readable text, or return the content unchanged.
 *
 * Read-side only, and it stays needed for as long as history is queried: envelopes already written to
 * a channel do not disappear when the writer stops producing new ones.
 */
export function unwrapLexEnvelope(content: string): string {
  const envelope = parseEnvelope(content);
  if (envelope && envelope.Messages.length > 0) {
    const first = envelope.Messages[0] as { Content?: unknown } | null;
    if (typeof first?.Content === 'string') return first.Content;
  }
  return content;
}

/**
 * The WRITE-side unwrap: the plain text a carrying envelope should have been stored as, or null when
 * this is not a carrying envelope and nothing should change.
 *
 * Returning null rather than the input is deliberate - the caller rewrites a channel message, so
 * "no change" and "changed to the same string" must not be confusable.
 *
 * ENCODING IS PRESERVED. Channel content reaches the flow percent-encoded or not, depending on which
 * component sent it, and the reader (`safeDecodeURIComponent`) copes with either. What it cannot cope
 * with is a change of convention mid-message, so an envelope that arrived encoded is rewritten
 * encoded, and one that arrived raw is rewritten raw.
 */
export function unwrapLexEnvelopeForChannel(content: string | null | undefined): string | null {
  if (!content) return null;

  const raw = parseEnvelope(content);
  if (raw) return carriedText(raw);

  const decoded = decodeIfPossible(content);
  if (decoded !== content) {
    const viaDecoded = parseEnvelope(decoded);
    if (viaDecoded) {
      const text = carriedText(viaDecoded);
      return text === null ? null : encodeURIComponent(text);
    }
  }
  return null;
}

/** The first message's text, or null when the envelope carries nothing usable. */
function carriedText(envelope: { Messages: unknown[] }): string | null {
  if (envelope.Messages.length === 0) return null; // empty: dropped, never rewritten
  const first = envelope.Messages[0] as { Content?: unknown } | null;
  return typeof first?.Content === 'string' ? first.Content : null;
}
