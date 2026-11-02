/**
 * The Lex fulfillment envelope, recognized WITHOUT a ContentType.
 *
 * Amazon Chime SDK materializes a channel message from a bot's Lex fulfillment response and persists
 * it with the envelope intact:
 *
 *     {"Messages":[{"Content":"One moment... <!--corr:...-->","ContentType":"PlainText"}]}
 *
 * An EMPTY envelope (`{"Messages":[]}`) is how a handler says "fulfilled, show the user nothing"
 * (`formatLexSilentResponse`, ADR-022). Chime posts it anyway, so something lands in the channel that
 * is not a message. This module is the single BACKEND source of truth for recognizing that shape.
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
 * Amazon Chime SDK's own STATUS ARTIFACT, which is not a message either.
 *
 *     {"Code":500}   {"Code":429}
 *
 * A DIFFERENT SHAPE FROM AN EMPTY ENVELOPE, and that is why it needs its own test. An empty envelope
 * is a handler saying "fulfilled, show nothing"; this is Amazon Chime SDK reporting that the Lex
 * invocation itself did not yield a message, and it carries no `Messages` key at all, so
 * `parseEnvelope` rejects it and the empty-envelope guard never sees it. Measured shapes: `500` when a
 * fulfillment closes with no message (what a silent WelcomeIntent produces, recorded for the Battle stack's former alt bots
 * in `battle-stack.ts`), `429` when the invocation times out (the VPC-attach breakage, where a
 * handler that could not reach its control plane made every turn read as an upstream throttle).
 *
 * IT IS DROPPED FROM THE CHANNEL, NEVER FROM THE LOG. These codes are the only outward sign of two
 * real defects, so recognizing one is not the same as excusing it: the caller denies the message so a
 * person never sees a status code where an answer belongs, AND logs it at a level that fails a run.
 * A guard that silently swallowed these would have hidden both defects that produced them.
 *
 * THE SAME STRUCTURAL NARROWNESS as the envelope test, for the same reason: a top-level object whose
 * ONLY key is `Code`, holding a number. Prose does not parse as JSON, and nobody writes a bare
 * `{"Code":500}` as a reply, but a message that merely CONTAINS one stays untouched.
 */
export function chimeStatusArtifactCode(content: string | null | undefined): number | null {
  if (!content) return null;
  for (const form of new Set([content, decodeIfPossible(content)])) {
    const trimmed = form.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"Code"')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof parsed.Code === 'number' &&
        Object.keys(parsed).length === 1
      ) {
        return parsed.Code;
      }
    } catch {
      /* not an artifact */
    }
  }
  return null;
}

/**
 * WHAT A `WelcomeIntent` RETURNS WHEN THE JOIN POSTS NOTHING (ADR-061 decision 5: a room a `conversation-opened` run
 * owns, or one whose `assistant-joined` run has already posted its own sends).
 *
 * A `WelcomeIntent` cannot close with no message. Amazon Chime SDK then posts `{"Code":500}` as the assistant, and that
 * message does not pass through the channel flow, so `chimeStatusArtifactCode` never sees it and a person reads it.
 * Measured on dev 2026-10-29: the primary's `WelcomeIntent` in an event-opened `ops` room closed with `messages: []`
 * in 131 ms, the room held `{"Code":500}` from the primary, and the channel flow logged no invocation for it.
 *
 * So the join returns this one message instead, and the channel flow denies it (`isNothingToPost`), which no member
 * ever reads: the flow is attached before the assistant becomes a member, so it sees the message Amazon Chime SDK
 * materializes from this return. An HTML comment, so a reader that somehow received it strips it to nothing.
 */
export const NOTHING_TO_POST = '<!--nothing-to-post-->';

/**
 * Whether a message is `NOTHING_TO_POST` and nothing else: raw, percent-decoded, or carried by a Lex envelope. Exact,
 * so a message that merely contains the marker is untouched.
 */
export function isNothingToPost(content: string | null | undefined): boolean {
  if (!content) return false;
  for (const form of new Set([content, decodeIfPossible(content)])) {
    const envelope = parseEnvelope(form);
    const text = envelope ? carriedText(envelope) : form;
    if (text !== null && text.trim() === NOTHING_TO_POST) return true;
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
 * component sent it, and the reader (`decodeContent`) copes with either. What it cannot cope
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
