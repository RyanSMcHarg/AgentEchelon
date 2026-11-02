/**
 * THE ONE MESSAGE SEND: every message the platform posts into a conversation goes through here.
 *
 * Who a message is sent AS is the bearer, and the bearer is the caller's decision (an assistant session,
 * the admin assistant, the service admin); this does not choose it. What it owns is the request: a message is
 * STANDARD and PERSISTENT unless a caller says otherwise, and its Metadata is one JSON string. Twenty-two
 * hand-built requests each restated those defaults, so a change to what a platform message is (a header,
 * an attribution field) had twenty-two places to land.
 *
 * It also owns how a LONG message is posted: as one response in ordered parts (`sendInParts`), split by the one
 * splitter (`splitIntoChunks`) the answer path uses too, so a long message reads the same wherever it came from.
 *
 * `backend/test/single-entry-point.test.ts` refuses a `SendChannelMessageCommand` anywhere else.
 */
import {
  SendChannelMessageCommand,
  type SendChannelMessageCommandInput,
  type SendChannelMessageCommandOutput,
} from '@aws-sdk/client-chime-sdk-messaging';

type Sender = { send(command: SendChannelMessageCommand): Promise<SendChannelMessageCommandOutput> };

/** A message to post: the SDK's own input, with the defaults filled and Metadata given as JSON or an object. */
export type ChannelMessageInput = Omit<SendChannelMessageCommandInput, 'Type' | 'Persistence' | 'Metadata'> & {
  Type?: SendChannelMessageCommandInput['Type'];
  Persistence?: SendChannelMessageCommandInput['Persistence'];
  Metadata?: string | Record<string, unknown>;
};

/**
 * THE CONTENT BUDGET. The Amazon Chime SDK caps Content at 4096 characters of the ENCODED string and Metadata at 1024,
 * and every message in this app is sent `encodeURIComponent`-encoded, so a space or a newline costs three characters
 * and prose roughly doubles. A request over the cap is refused whole (`BadRequestException`). 3600 is the working
 * budget under the cap.
 */
export const CHIME_CONTENT_MAX = 4096;
export const CHIME_METADATA_MAX = 1024;
export const CHIME_CONTENT_SAFE = 3600;

const encodedLen = (s: string): number => encodeURIComponent(s).length;

// A prefix cut never falls BETWEEN a UTF-16 surrogate pair (an astral-plane character - an emoji, a math alphanumeric,
// some CJK extensions - is two code units). A lone surrogate makes `encodeURIComponent` throw `URIError`, so such an
// index is snapped back by one and the pair travels whole into the next part. ASCII boundaries (space, newline,
// period) never sit inside a pair.
function surrogateSafeCut(text: string, idx: number): number {
  if (idx <= 0 || idx >= text.length) return idx;
  const hi = text.charCodeAt(idx - 1);
  const lo = text.charCodeAt(idx);
  if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
    return idx - 1;
  }
  return idx;
}

/**
 * The largest raw cut index of `text` whose encoded length stays within `budget`, preferring a natural boundary
 * (paragraph, then sentence, then word) in the back half. Encoded length is monotonic in prefix length, so a binary
 * search on the raw index is exact. Always at least one character of progress, so a caller never loops forever.
 */
export function cutIndexByEncoded(text: string, budget: number): number {
  if (encodedLen(text) <= budget) return text.length;
  let lo = 1;
  let hi = text.length;
  let fit = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // Measured on a surrogate-safe prefix, so the measure itself never throws on a mid-pair slice.
    if (encodeURIComponent(text.slice(0, surrogateSafeCut(text, mid))).length <= budget) {
      fit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const window = text.slice(0, fit);
  let para = window.lastIndexOf('\n\n');
  // A PART NEVER ENDS ON A HEADING. A part ending on "Who created it?" with nothing under it reads as a broken answer,
  // so the cut backs up to the boundary before the heading, and the heading travels with its content.
  while (para > 0) {
    const lineStart = window.lastIndexOf('\n', para - 1) + 1;
    const lastLine = window.slice(lineStart, para);
    if (!/^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/.test(lastLine)) break;
    para = window.lastIndexOf('\n\n', lineStart - 1);
  }
  if (para > fit * 0.5) return para;
  const sentence = window.lastIndexOf('. ');
  if (sentence > fit * 0.5) return sentence + 1;
  const word = window.lastIndexOf(' ');
  if (word > fit * 0.5) return word;
  // A single leading astral character under a tiny budget is taken whole, so the cut still makes progress.
  const safe = surrogateSafeCut(text, fit);
  return safe > 0 ? safe : Math.min(2, text.length);
}

/**
 * THE ONE SPLITTER: a message longer than one send becomes ordered parts, each within its ENCODED Content budget.
 *
 * Every post of model-written or template text splits through here (`sendInParts`, and the answer path's
 * `handleLongResponse`), so a long message reads the same wherever it came from. The first part may take a smaller
 * budget (the answer path appends a marker to it after the split); the parts after it take `restBudget`. Trimming
 * removes only whitespace, so a trimmed part is still within its budget.
 */
export function splitIntoChunks(
  response: string,
  firstBudget: number = CHIME_CONTENT_SAFE,
  restBudget: number = firstBudget,
): string[] {
  if (encodedLen(response) <= firstBudget) return [response];

  const chunks: string[] = [];
  let pos = 0;
  let budget = firstBudget;
  while (pos < response.length) {
    const rest = response.slice(pos);
    if (encodedLen(rest) <= budget) {
      const tail = rest.trim();
      if (tail.length > 0) chunks.push(tail);
      break;
    }
    const cut = cutIndexByEncoded(rest, budget);
    const safeCut = cut > 0 ? cut : 1;
    const piece = rest.slice(0, safeCut).trim();
    if (piece.length > 0) chunks.push(piece);
    pos += safeCut;
    budget = restBudget;
  }

  return chunks;
}

/** A prefix length that keeps a UTF-16 surrogate pair whole, so the prefix always encodes. */
function wholeCodePoints(text: string, n: number): number {
  const c = text.charCodeAt(n - 1);
  return n > 0 && c >= 0xd800 && c <= 0xdbff ? n - 1 : n;
}

/**
 * Fit `text` to an ENCODED budget as ONE value: the text itself when it fits, else its longest prefix that fits with
 * `suffix`, ended on a word boundary when one is near. A binary search rather than a ratio guess, because the inflation
 * depends on the characters present.
 *
 * For a value the medium holds exactly once, never for a message a person reads: an email subject inside Metadata (one
 * header line), or a reply with no conversation to post further parts into. A message is split (`sendInParts`).
 */
export function fitEncoded(text: string, budget: number = CHIME_CONTENT_SAFE, suffix = '…'): string {
  if (encodedLen(text) <= budget) return text;
  const room = budget - encodedLen(suffix);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = wholeCodePoints(text, Math.ceil((lo + hi) / 2));
    if (mid <= lo) { hi = lo; break; }
    if (encodedLen(text.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
  }
  lo = wholeCodePoints(text, lo);
  const boundary = Math.max(text.lastIndexOf(' ', lo), text.lastIndexOf('\n', lo));
  const cut = boundary > lo * 0.8 && boundary <= lo ? boundary : lo;
  return text.slice(0, cut).trimEnd() + suffix;
}

/** Post one message as `input.ChimeBearer`, on `client`. Throws what the Amazon Chime SDK throws. */
export function sendChannelMessage(client: Sender, input: ChannelMessageInput): Promise<SendChannelMessageCommandOutput> {
  const { Metadata, ...rest } = input;
  return client.send(new SendChannelMessageCommand({
    Type: 'STANDARD',
    Persistence: 'PERSISTENT',
    ...rest,
    ...(Metadata === undefined ? {} : { Metadata: typeof Metadata === 'string' ? Metadata : JSON.stringify(Metadata) }),
  } as SendChannelMessageCommandInput));
}

/** The id that groups one response's parts. */
export function newResponseGroup(): string {
  return `rg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * A continuation part's Metadata: which part it is, of how many, in which response, continuing which message. The chat
 * app shows a part directly after the message it continues, without a header of its own (`continuationOrder.ts`,
 * `ConversationInterface.tsx`). Slim by design, so it stays far under the Metadata cap whatever the first part carries.
 */
export function continuationMetadata(args: {
  parentMessageId?: string;
  responseGroup: string;
  part: number;
  totalParts: number;
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    ...(args.extra ?? {}),
    ...(args.parentMessageId ? { parentMessageId: args.parentMessageId } : {}),
    responseGroup: args.responseGroup,
    continuation: true,
    part: args.part,
    totalParts: args.totalParts,
  });
}

/** A continuation part the Amazon Chime SDK refused. The parts before it are posted; it and the parts after it are not. */
export class PartRefused extends Error {
  constructor(readonly part: number, readonly totalParts: number, readonly refusal: unknown) {
    super(`part ${part} of ${totalParts} was refused: ${(refusal as Error)?.name ?? 'Error'}: ${(refusal as Error)?.message ?? String(refusal)}`);
    this.name = 'PartRefused';
  }
}

/**
 * Post parts 2..N of a response after the message that holds part 1, in order, each to the same `Target` as part 1, so
 * a targeted response reaches exactly its audience in every part. Throws `PartRefused` at the first part refused.
 */
export async function sendContinuations(client: Sender, args: {
  ChannelArn: string;
  ChimeBearer: string;
  Target?: SendChannelMessageCommandInput['Target'];
  Type?: SendChannelMessageCommandInput['Type'];
  Persistence?: SendChannelMessageCommandInput['Persistence'];
  parentMessageId?: string;
  responseGroup: string;
  /** Every part of the response, the first included; the first is already posted. */
  parts: string[];
  /** Fields every continuation carries besides its grouping, kept small (an admin notice's `analytics`). */
  extra?: Record<string, unknown>;
}): Promise<void> {
  for (let i = 1; i < args.parts.length; i++) {
    try {
      await sendChannelMessage(client, {
        ChannelArn: args.ChannelArn,
        ChimeBearer: args.ChimeBearer,
        Content: encodeURIComponent(args.parts[i]),
        ...(args.Type ? { Type: args.Type } : {}),
        ...(args.Persistence ? { Persistence: args.Persistence } : {}),
        ...(args.Target?.length ? { Target: args.Target } : {}),
        Metadata: continuationMetadata({
          parentMessageId: args.parentMessageId,
          responseGroup: args.responseGroup,
          part: i + 1,
          totalParts: args.parts.length,
          extra: args.extra,
        }),
      });
    } catch (err) {
      throw new PartRefused(i + 1, args.parts.length, err);
    }
  }
}

/** The platform's hidden markers (`<!--corr:-->`, `<!--turn:-->`, ...), which declare things about a whole message. */
const HIDDEN_MARKER = /<!--[\s\S]*?-->/g;

/**
 * The parts a response is posted in. THE MARKERS RIDE THE FIRST PART: a marker declares something about the response
 * (its correlation, its kind, its phase), and every reader looks for it on the message that starts the response, so a
 * long text's markers are lifted out before the split and appended to part 1, with room reserved for them.
 */
export function responseParts(text: string): string[] {
  if (encodedLen(text) <= CHIME_CONTENT_SAFE) return [text];
  const markers = (text.match(HIDDEN_MARKER) ?? []).join('');
  if (!markers) return splitIntoChunks(text);
  const parts = splitIntoChunks(text.replace(HIDDEN_MARKER, ''), CHIME_CONTENT_SAFE - encodedLen(markers), CHIME_CONTENT_SAFE);
  parts[0] = `${parts[0]}${markers}`;
  return parts;
}

/** A response posted in parts: the first part's send, and how many parts the response took. */
export type SentInParts = SendChannelMessageCommandOutput & { totalParts: number; responseGroup?: string };

/**
 * POST ONE RESPONSE, IN AS MANY PARTS AS IT NEEDS. `text` is the plain text; this encodes it. The first part carries the
 * caller's Metadata, and a longer text continues in ordered parts carrying the continuation Metadata, every part to the
 * same `Target`. Throws what the first send throws, or `PartRefused` for a later part, so a caller that records one
 * outcome for the response records it posted only when every part was.
 */
export async function sendInParts(
  client: Sender,
  input: Omit<ChannelMessageInput, 'Content'> & { text: string; continuationExtra?: Record<string, unknown> },
): Promise<SentInParts> {
  const { text, continuationExtra, ...message } = input;
  const parts = responseParts(text);
  const first = await sendChannelMessage(client, { ...message, Content: encodeURIComponent(parts[0]) });
  if (parts.length === 1) return { ...first, totalParts: 1 };
  const responseGroup = newResponseGroup();
  await sendContinuations(client, {
    ChannelArn: message.ChannelArn as string,
    ChimeBearer: message.ChimeBearer as string,
    Target: message.Target,
    Type: message.Type,
    Persistence: message.Persistence,
    parentMessageId: first.MessageId,
    responseGroup,
    parts,
    extra: continuationExtra,
  });
  return { ...first, totalParts: parts.length, responseGroup };
}
