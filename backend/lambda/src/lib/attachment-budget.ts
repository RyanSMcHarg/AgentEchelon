/**
 * THE ONE PLACE THAT DECIDES WHETHER AN ATTACHMENT CAN BE SENT TO THE MODEL.
 *
 * Until this module existed, nothing measured an attachment anywhere on the path into Amazon Bedrock.
 * The presigned upload capped the file at 10 MiB, `fetchAttachmentBytes` read whatever was there, and
 * the bytes went straight into a Converse image or document block. Bedrock answered a
 * `ValidationException`, `classifyError` marked it 'fail', and the person got an error line and an
 * operator got an alert - for a file the platform had accepted and stored a moment earlier.
 *
 * It was worse than one bad turn. `resolveHistoryImageBlocks` re-attaches recent conversation images,
 * so a single oversize image poisoned every SUBSEQUENT turn in that conversation until it fell out of
 * the history window.
 *
 * ── THE NUMBERS, AND WHERE THEY COME FROM ───────────────────────────────────────────────────────
 *
 * Read from the vendor documentation on 2026-09-15, not inferred from a failure:
 *   https://platform.claude.com/docs/en/build-with-claude/vision        (Request limits)
 *   https://platform.claude.com/docs/en/build-with-claude/pdf-support   (PDF requirements)
 *
 * Re-check them there rather than trusting this comment.
 *
 * ── WHY THE BUDGET IS 3,000,000 BYTES: BEDROCK ENFORCES 4 MB, NOT THE DOCUMENTED 5 MB ────────────
 *
 * The documented per-image limit on Amazon Bedrock was read as 5 MB of BASE64-ENCODED image, and this
 * budget was 3,750,000 raw bytes from it. Bedrock refuses at 4 MB: measured 2026-10-15 on a premium
 * Claude turn, "ValidationException: The images in the request are too large. The maximum size allowed
 * per image is 4 MB", on a generated battle image that passed the old budget and failed every turn that
 * re-offered it. Base64 inflates by 4/3, so 4,000,000 encoded bytes carry 3,000,000 RAW bytes, which is
 * also under 4 MiB encoded if the limit is binary. This code holds the raw bytes it is
 * about to hand to the SDK, which encodes them on the way out, so the raw number is the one to check:
 * measuring the 5 MB against the unencoded buffer would admit a file a third over the real limit and
 * fail at Bedrock exactly as before.
 *
 * (The Claude API's direct limit is 10 MB base64. Amazon Bedrock's is lower, and Bedrock is the path
 * this code takes, so the lower number is the one enforced.)
 *
 * ── ONE BUDGET FOR IMAGES AND DOCUMENTS ─────────────────────────────────────────────────────────
 *
 * The documented figure is per IMAGE. It is applied to document blocks too: a document rides the same
 * request, the total request payload allowance on Amazon Bedrock is below the direct API's 32 MB, and
 * the vendor documentation read today states no larger per-document allowance. Sending a document over
 * this budget is therefore not demonstrably safe, and one threshold is the point of this module
 * (tenet D9: two features of the same kind are built the same way).
 *
 * ── THE PIXEL LIMIT IS ENFORCED TOO, FROM THE HEADER AND NOTHING MORE ───────────────────────────
 *
 * `MAX_IMAGE_DIMENSION_PX` is checked. Every format this platform sends states its pixel dimensions in
 * a fixed-position header a few dozen bytes long, so reading them needs no decoder and no dependency
 * (tenet D8: reuse before building). `readImageDimensions` parses those headers directly: PNG's IHDR
 * chunk, JPEG's SOFn marker reached by walking the segment chain, GIF's logical screen descriptor, and
 * each of WebP's three chunk layouts.
 *
 * WHAT IT DOES NOT DO IS GUESS. A header it cannot read returns UNKNOWN, and unknown is SENT. This
 * check exists to stop a Bedrock rejection the code can predict, not to become a new way to lose a
 * person's attachment: refusing a file because a parser did not recognize it would turn a working turn
 * into a degraded one for no evidence at all. So it fails TOWARD sending, which is the opposite of the
 * byte check, and deliberately - a byte length is always known, a pixel count is not.
 *
 * ── WHAT IS RECORDED HERE BUT NOT ENFORCED HERE, AND WHY ────────────────────────────────────────
 *
 * `MAX_PDF_PAGES_PER_REQUEST` is stated so the next reader has the whole picture in one place, and it
 * is not checked: a page count needs the PDF parsed, and a PDF parser is a dependency of a different
 * order from reading twenty bytes of an image header. A PDF that is inside the byte budget but over
 * 100 pages still fails at Bedrock the way it always did. That gap is stated in
 * `docs/guides/developer/MESSAGE-FLOW.md` section 14.5 rather than left for somebody to rediscover.
 *
 * `MAX_ATTACHMENT_BLOCKS_PER_REQUEST` is a LIMIT TO STAY UNDER, not a limit to enforce dynamically:
 * above 20 image-plus-document blocks a stricter per-image dimension limit applies to every block in
 * the request, and on Amazon Bedrock document blocks count toward that threshold. This code attaches
 * one current-turn attachment plus at most `resolveHistoryImageBlocks`'s cap, which is far below 20, so
 * the guard that matters is a test asserting the code cannot reach it.
 *
 * ── THE UPLOAD CAP AND THIS BUDGET DISAGREE, DELIBERATELY ───────────────────────────────────────
 *
 * The presigned upload still accepts 10 MiB (`backend/lambda/presigned-url/index.js`,
 * `frontend/packages/chat/src/services/attachmentService.ts`) while the model budget is 3.75 MB. That
 * is a choice, not an oversight: an attachment has uses beyond being read by a model. A 6 MB PDF
 * uploaded to a conversation is still stored, still downloadable by every member, and still the thing
 * the conversation is about. Lowering the upload cap to the model budget would refuse a file the
 * platform can perfectly well hold, to protect a single downstream consumer.
 *
 * So the file uploads and the turn DEGRADES at send time: the assistant answers without reading it and
 * says so, in configured copy. If a deployment ever decides the other way, the frontend cap, the
 * presigner cap and the upload-time copy all have to move together - the disagreement is only
 * survivable because the person is told at the point it bites.
 */
import { shippedLineText, templateLine } from './message-lines.js';
import { emitEmfMetric } from './emf-metrics.js';
import type { AssistantCopy } from './active-profile.js';

/** Namespace for attachment-path measurements. */
export const ATTACHMENT_METRIC_NAMESPACE = 'AgentEchelon/Attachments';

/**
 * The per-attachment RAW byte budget: 4,000,000 base64 bytes / (4/3). See the header for why this is
 * the enforced 4 MB rather than the documented 5 MB, and why it is measured before encoding.
 */
export const MAX_ATTACHMENT_BYTES_FOR_MODEL = 3_000_000;

/** The per-image limit Bedrock enforces, in ENCODED bytes. Kept beside the raw budget so the 4/3 is visible. */
export const MAX_ATTACHMENT_BASE64_BYTES_FOR_MODEL = 4_000_000;

/**
 * Documented maximum image edge, in pixels. Enforced, from the file header (see `readImageDimensions`).
 *
 * A LIMIT TO RESPECT, NOT A SECOND THRESHOLD TO COMPUTE. Above `MAX_ATTACHMENT_BLOCKS_PER_REQUEST`
 * image-plus-document blocks in one request, a STRICTER per-image dimension limit applies to every
 * block in that request. This code attaches one current-turn attachment plus the history cap, which is
 * far below 20, so the stricter rule never applies and the number below is the one that governs. If a
 * future change raises the block count, this constant stops being sufficient - which is why the block
 * limit is asserted by test rather than left as prose.
 */
export const MAX_IMAGE_DIMENSION_PX = 8000;

/** Documented PDF pages per request under a 1M-token context window. Recorded, not enforced. */
export const MAX_PDF_PAGES_PER_REQUEST = 100;

/** Documented limit on image-plus-document blocks in one request. A limit to stay under. */
export const MAX_ATTACHMENT_BLOCKS_PER_REQUEST = 20;

/**
 * Whether a length is inside the byte budget. The ONLY place that threshold is compared.
 *
 * The module's own building block, not a sender's entry point: every path that sends attachment bytes
 * calls `attachmentFitsModelLimits`, which applies this and the pixel edge together. A sender that
 * called this directly would pick up the byte limit and quietly skip the other one.
 *
 * FAILS CLOSED on a length it cannot read, which is the opposite of the dimension check and correct
 * for both: a byte length is always knowable, so an unreadable one means something is wrong.
 */
export function attachmentFitsModelBudget(byteLength: number | undefined): boolean {
  return typeof byteLength === 'number' && byteLength >= 0
    && byteLength <= MAX_ATTACHMENT_BYTES_FOR_MODEL;
}

/** A parsed image's pixel dimensions. Absent everywhere a header could not be read. */
export interface ImageDimensions {
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];
const le16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const be32 = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const le24 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
/** ASCII tag comparison, for the four-character codes these container formats are built from. */
const tagAt = (b: Uint8Array, at: number, tag: string): boolean => {
  for (let i = 0; i < tag.length; i++) if (b[at + i] !== tag.charCodeAt(i)) return false;
  return true;
};

/**
 * How far into a JPEG the segment walk will go before giving up. A JPEG's SOFn sits within a few
 * kilobytes in every file this platform will see; a color profile or a large EXIF thumbnail can push
 * it further, so the bound is generous. It exists so a corrupt or adversarial length field cannot turn
 * this into a long loop on the turn path, not because a real file needs it.
 */
const JPEG_MAX_SEGMENTS_SCANNED = 512;

/**
 * Read an image's pixel dimensions out of its own header, with NO decoder and no dependency.
 *
 * WHY A PARSER AND NOT A LIBRARY. Every format the Converse image block accepts
 * (`imageFormatFromContentType`: png, jpeg, gif, webp) writes its width and height into a fixed
 * structure in the first few dozen bytes. Reading them is twenty lines per format. Pulling in an
 * image library to learn two integers would add a standing dependency and a standing failure mode to
 * the turn path for work the file already hands over (tenet D8).
 *
 * THE FORMAT IS SNIFFED, NOT TRUSTED. The dispatch is on the file's own magic bytes rather than on the
 * attachment's `contentType`, because the content type rides user-controlled message metadata while
 * the signature is in the bytes that are actually about to be sent.
 *
 * RETURNS UNDEFINED FOR ANYTHING IT CANNOT READ - an unrecognized signature, a truncated header, a
 * JPEG whose segment chain ends before an SOFn, a zero dimension. `undefined` means UNKNOWN, and every
 * caller must treat unknown as sendable. See the header: this check predicts a Bedrock rejection, and
 * a guess is not a prediction.
 */
export function readImageDimensions(bytes: Uint8Array | undefined): ImageDimensions | undefined {
  if (!bytes || bytes.length < 10) return undefined;
  const dims = readImageDimensionsBySignature(bytes);
  // A zero or negative edge is a header that parsed into nonsense. Treated as unknown rather than as a
  // tiny image, so a malformed file is sent and answered for by Bedrock rather than dropped here.
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) return undefined;
  return dims;
}

function readImageDimensionsBySignature(b: Uint8Array): ImageDimensions | undefined {
  // PNG: an 8-byte signature, then the first chunk MUST be IHDR (length at 8, type at 12), whose
  // payload opens with width and height as big-endian uint32.
  if (b.length >= 24 && tagAt(b, 0, '\x89PNG\r\n\x1a\n') && tagAt(b, 12, 'IHDR')) {
    return { width: be32(b, 16), height: be32(b, 20) };
  }
  // GIF: 'GIF87a' or 'GIF89a', then the logical screen descriptor - width and height as little-endian
  // uint16. This is the CANVAS, which is what a Converse image block is measured as.
  if (b.length >= 10 && tagAt(b, 0, 'GIF8') && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return { width: le16(b, 6), height: le16(b, 8) };
  }
  // JPEG: SOI, then a chain of marker segments. The dimensions live in an SOFn, whose position is NOT
  // fixed - EXIF, JFIF and color-profile segments come first and vary in size - so the chain is
  // walked rather than an offset assumed.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return readJpegDimensions(b);
  // WebP: a RIFF container whose first chunk says which of three encodings this is.
  if (b.length >= 20 && tagAt(b, 0, 'RIFF') && tagAt(b, 8, 'WEBP')) return readWebpDimensions(b);
  return undefined;
}

function readJpegDimensions(b: Uint8Array): ImageDimensions | undefined {
  let p = 2; // past SOI
  for (let seen = 0; seen < JPEG_MAX_SEGMENTS_SCANNED && p + 1 < b.length; seen++) {
    // Markers may be preceded by any number of 0xFF fill bytes.
    if (b[p] !== 0xff) return undefined;
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) return undefined;
    const marker = b[p];
    p++;
    // Standalone markers carry no length: SOI, EOI, TEM and the eight restart markers.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    // SOS: entropy-coded scan data follows and is not a segment chain. If no SOFn came first there is
    // nothing more to read, so this is UNKNOWN rather than an error.
    if (marker === 0xda) return undefined;
    if (p + 1 >= b.length) return undefined;
    const length = be16(b, p); // includes its own two bytes
    if (length < 2) return undefined;
    // SOFn, the frame header: 0xC0-0xCF except DHT (0xC4), JPG (0xC8) and DAC (0xCC). Baseline (SOF0)
    // and progressive (SOF2) are what a camera or an export produces, and the rest are the same shape:
    // precision (1 byte), height (2), width (2).
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (p + 6 >= b.length) return undefined;
      return { width: be16(b, p + 5), height: be16(b, p + 3) };
    }
    p += length;
  }
  return undefined;
}

function readWebpDimensions(b: Uint8Array): ImageDimensions | undefined {
  // The three WebP encodings write their canvas size in three different places, so each is read on its
  // own terms. A file whose first chunk is none of them is unknown.
  const chunk = 12; // past 'RIFF', the file size, and 'WEBP'
  const payload = chunk + 8; // past the four-character code and the chunk size

  // VP8X, the extended format (animation, alpha, ICC): flags (1) + reserved (3), then the canvas
  // width and height each MINUS ONE as 24-bit little-endian.
  if (tagAt(b, chunk, 'VP8X')) {
    if (b.length < payload + 10) return undefined;
    return { width: le24(b, payload + 4) + 1, height: le24(b, payload + 7) + 1 };
  }
  // VP8L, lossless: a 0x2F signature byte, then width-1 and height-1 as 14-bit fields packed into the
  // next four bytes, little-endian, width first.
  if (tagAt(b, chunk, 'VP8L')) {
    if (b.length < payload + 5 || b[payload] !== 0x2f) return undefined;
    const bits = (b[payload + 1] | (b[payload + 2] << 8) | (b[payload + 3] << 16)
      | (b[payload + 4] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  // 'VP8 ' (the space is part of the code), lossy: a 3-byte frame tag, the 3-byte start code
  // 0x9D 0x01 0x2A, then width and height as little-endian uint16 whose top two bits are a scale
  // factor rather than size, hence the 14-bit mask.
  if (tagAt(b, chunk, 'VP8 ')) {
    if (b.length < payload + 10) return undefined;
    if (!(b[payload + 3] === 0x9d && b[payload + 4] === 0x01 && b[payload + 5] === 0x2a)) {
      return undefined;
    }
    return { width: le16(b, payload + 6) & 0x3fff, height: le16(b, payload + 8) & 0x3fff };
  }
  return undefined;
}

/** Why the model was not given an attachment. `bytes` is the size budget, `dimensions` the pixel edge. */
export type AttachmentRefusalReason = 'bytes' | 'dimensions';

/** What `attachmentFitsModelLimits` decided, and what it decided it from. */
export interface AttachmentFitVerdict {
  /** Whether these bytes may be sent to the model. */
  fits: boolean;
  /** Which limit refused it. Absent when it fits. */
  reason?: AttachmentRefusalReason;
  /** The dimensions read from the header, where they could be read. Absent means UNKNOWN, which SENDS. */
  dimensions?: ImageDimensions;
}

/**
 * THE ONE PLACE EVERY LIMIT IS COMPARED. Every path that hands attachment bytes to a model calls this,
 * so there is no second copy of a threshold and no second copy of the degrade decision.
 *
 * Byte budget first, then pixel edges. The byte check is the one that can always be made (a length is
 * always known) and it fails CLOSED; the dimension check runs only on a header this code could read
 * and fails OPEN. A file whose dimensions are unknown comes back `fits: true` with no `dimensions`,
 * which is the deliberate outcome, not a hole: see the module header.
 *
 * A document (PDF, spreadsheet, text) has no image header, so it is measured on bytes alone. The page
 * count that `MAX_PDF_PAGES_PER_REQUEST` records is still unenforced and still documented as a gap.
 */
export function attachmentFitsModelLimits(bytes: Uint8Array | undefined): AttachmentFitVerdict {
  if (!attachmentFitsModelBudget(bytes?.byteLength)) return { fits: false, reason: 'bytes' };
  const dimensions = readImageDimensions(bytes);
  if (!dimensions) return { fits: true };
  if (dimensions.width > MAX_IMAGE_DIMENSION_PX || dimensions.height > MAX_IMAGE_DIMENSION_PX) {
    return { fits: false, reason: 'dimensions', dimensions };
  }
  return { fits: true, dimensions };
}

/**
 * Where an over-budget attachment was refused. The person is told only on `current-turn`: `history` is
 * the same file re-offered on a later turn, and `evaluation` is the offline relevance judge, where
 * there is no person in the conversation to tell.
 */
export type AttachmentBudgetPath = 'current-turn' | 'history' | 'evaluation';

/**
 * Count an attachment the model was not given, so an operator can see how often this fires.
 *
 * A NEW COUNTER RATHER THAN A LEDGER FIELD, on purpose (tenet D7). The archive already records the
 * turn, and the turn SUCCEEDS here: it is answered, delivered and archived like any other. What the
 * ledger does not hold is that a person's file went unread, and that is a different question from
 * "what happened on this turn" - so it is counted once, in one place, rather than inferred from a
 * turn record that looks healthy.
 *
 * Emitted from this module rather than from the processors so `test/lib/emf-schema.test.ts` can drive
 * it for real: a caller declares its own dimension sets, and a dimension named in a set but absent
 * from the properties drops the metric silently.
 *
 * ONE COUNTER FOR BOTH LIMITS, with `Reason` saying which (tenet D7: one source per question). The
 * question an operator asks is "how often does a person's file go unread", and that is one question
 * whether the file was too heavy or too wide. A second metric would have to be summed with this one to
 * answer it, and the two would drift apart the first time only one of them was wired to an alarm. The
 * `Reason` dimension set is ADDITIVE: the dimensionless, `Classification` and `Classification`+`Path`
 * streams keep publishing exactly what they published before, so an existing alarm is untouched.
 */
export function recordAttachmentOverBudget(args: {
  path: AttachmentBudgetPath;
  byteLength: number;
  contentType?: string;
  /** Which limit refused it. Defaults to `bytes`, the limit that existed before dimensions did. */
  reason?: AttachmentRefusalReason;
  /** The pixel size read from the header, on a dimension refusal. A log field, never a dimension. */
  dimensions?: ImageDimensions;
  /** The serving classification. Defaults to the processor's env so the dimension is never empty. */
  classification?: string;
}): void {
  const { path, byteLength, contentType, dimensions } = args;
  const reason: AttachmentRefusalReason = args.reason || 'bytes';
  const classification = args.classification || process.env.CLASSIFICATION || 'unknown';
  console.warn('[AttachmentBudget] attachment exceeds what the model can take; not sending it', {
    path,
    reason,
    byteLength,
    budget: MAX_ATTACHMENT_BYTES_FOR_MODEL,
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    maxDimensionPx: MAX_IMAGE_DIMENSION_PX,
    contentType,
    classification,
  });
  emitEmfMetric({
    namespace: ATTACHMENT_METRIC_NAMESPACE,
    metrics: [{ name: 'attachment_over_budget', unit: 'Count' }],
    // The DIMENSIONLESS set is what an alarm watches; the others say which path, which assistant and
    // which limit, which is what an operator needs to act on it.
    dimensionSets: [[], ['Classification'], ['Classification', 'Path'], ['Classification', 'Reason']],
    properties: {
      Classification: classification,
      Path: path,
      Reason: reason,
      ContentType: contentType || 'unknown',
      // How far over, as log fields rather than metrics: the emitter's unit vocabulary has no Bytes
      // and no Pixels, and a size published under a Count unit is a number an operator would read
      // wrong. Zero on a dimension refusal would be a lie, so the edges are simply absent instead.
      ByteLength: byteLength,
      ...(dimensions ? { ImageWidth: dimensions.width, ImageHeight: dimensions.height } : {}),
      attachment_over_budget: 1,
    },
  });
}

/**
 * The shipped English for `attachmentTooLargeToRead`. A deployment overrides it through the active
 * profile's copy; absent leaves this, which is what every deployment that has not set it already had.
 *
 * It must say three things and a deployment's replacement must keep all three: the file ARRIVED, it
 * was NOT read, and the answer that follows was written without it. A line that only apologizes leaves
 * the person unable to tell whether the reply accounted for their file.
 */
export const ATTACHMENT_TOO_LARGE_DEFAULT = shippedLineText('attachment-too-large-to-read');

/**
 * The line the person sees when their attachment was over budget. `{name}` is the file's name, where
 * one is known; a deployment that omits `{name}` simply gets no name.
 */
/**
 * A FILENAME IS SOMEBODY ELSE'S STRING, and this one is about to become part of a message the
 * platform authors AS the assistant.
 *
 * `attachment.name` comes from member-writable Amazon Chime SDK message Metadata and is taken
 * verbatim. Bot-authored content is exactly where this platform carries its control markers
 * (`<!--corr:`, `<!--turn:`, `<!--ACTIVE_TASK:`, `<!--battle:`), and `stripMessageMarkers` is an
 * INBOUND defense that never runs over composed output - so a file named `<!--ACTIVE_TASK:{...}-->`
 * would have rendered as a forged task chip in the client, or collided with correlation matching.
 *
 * ANGLE BRACKETS AND BRACES, not a full allowlist. The sibling document path uses one, but that
 * exists to satisfy Bedrock's document-name rules and drops the extension, which is wrong for
 * something a person reads. What has to go is the marker syntax itself and the guardrail mask token's
 * braces; everything else about the name is the person's own and is kept. Bounded, because the length
 * is theirs to choose too.
 */
function displayableAttachmentName(name: string): string {
  return name
    .replace(/[<>{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function attachmentTooLargeLine(args: { name?: string; copy?: AssistantCopy }): string {
  return templateLine('attachment-too-large-to-read', { copy: args.copy }, { values: { name: displayableAttachmentName(args.name || '') } });
}
