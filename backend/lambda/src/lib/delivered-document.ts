/**
 * A DELIVERED DOCUMENT, AS THE TURN RECORDS IT (SPEC-EVALUATION FR22).
 *
 * When a turn delivers a file (a report, an extraction, code), the reply that archives as the exchange's
 * `response` is the chat text beside the file. The file is the deliverable, and it is what the person
 * asked for, so evaluation grades it as an artifact of its own. This module is the one shape every
 * component uses for it:
 *
 *  - the processor builds the reference when the document is uploaded and puts it on the turn's
 *    out-of-band analytics record (`deliveredDocument`), the record archival merges into the archived
 *    message;
 *  - archival copies the body into the archive under a key the archive owns
 *    (`analytics-aurora/delivered-document-archive.ts`) and adds `archiveKey` to the reference;
 *  - the evaluation runner reads the reference off the archived message, reads the body from the
 *    archive's copy, and grades it in an `evaluation_results` row of type `document`.
 *
 * WHAT IS RECORDED. The attachment's key, the SHA-256 of the bytes uploaded, size and content type, the
 * kind of document (the task type that produced it, else `document`), the intent the turn was routed to,
 * and for a task the task id, the state it was delivered from and the requirements the task recorded
 * before the delivery. The requirements are what the person agreed to, so they are the standard the
 * document is held to, fixed before the document was written.
 *
 * A PRIVATE TASK'S REQUIREMENTS ARE NOT COPIED. Task detail of a private task is stripped for every
 * reader that is not the requester, and the judge is not the requester (DESIGN-EVALUATION, "Private task
 * detail stays private"). The reference says `private: true`, the evaluator does not grade it, and the
 * archive still holds the document, because the archive holds what was said in the conversation.
 */
import { createHash } from 'crypto';

/** The archive key family delivered documents are copied into (tenet D15: the key names its owner). */
export const DELIVERED_DOCUMENTS_PREFIX = 'delivered-documents/';

/** At most this many requirements ride the reference; a task records a handful. */
const MAX_REQUIREMENTS = 20;
/** Each requirement's need and value, bounded so the reference stays a reference. */
const MAX_REQUIREMENT_CHARS = 500;

export interface DeliveredDocumentReference {
  /** The attachment object key in the attachments bucket (`generated-docs/<conversationId>/<file>`). */
  fileKey: string;
  /** Lowercase hex SHA-256 of the bytes uploaded. The archive's copy is verified against it. */
  sha256: string;
  size: number;
  contentType: string;
  name: string;
  /** What kind of document: the producing task type, or `document` for an ad-hoc file. */
  kind: string;
  intent?: string;
  taskId?: string;
  /** The task state the document was delivered from. */
  fromState?: string;
  /** need -> value, as the task recorded them before delivery. Absent on a private task. */
  requirements?: Record<string, string>;
  /** The producing task is private, so the document is archived and not graded. */
  private?: true;
  /** Set by archival once the archive holds its own copy. Absent means the copy was not made. */
  archiveKey?: string;
  /**
   * The document template the delivery was checked against (SPEC-DOCUMENT-TEMPLATES FR8), so evaluation
   * knows the format the document was held to, by name and content hash.
   */
  template?: DocumentTemplateRecord;
  /**
   * The requirements were not carried because the reference rode the size-capped inline Metadata
   * (`inlineDeliveredDocument`, Athena mode). Absent on the out-of-band reference, which carries them.
   */
  requirementsOmitted?: true;
}

/**
 * How a templated document fared (SPEC-DOCUMENT-TEMPLATES FR6, FR8): it matched the template's structure
 * as written, matched after the bounded correction, still did not and was posted inline rather than
 * attached, or was rendered by the platform from recorded data with no model call.
 */
export const TEMPLATE_CHECK_OUTCOMES = ['passed', 'passed_after_correction', 'posted_inline', 'filled_by_platform'] as const;
export type TemplateCheckOutcome = (typeof TEMPLATE_CHECK_OUTCOMES)[number];

/** The template a delivery was checked against and the result, as every record of the delivery carries it. */
export interface DocumentTemplateRecord {
  name: string;
  /** SHA-256 of the template body: which version. */
  contentHash: string;
  outcome: TemplateCheckOutcome;
  /** The person chose this template from the formats the workflow offers (FR3a). */
  chosen?: true;
  /**
   * Shadow metric only (tenet D11): the share of the document's matched headings whose text equals the
   * template's. A translated document scores low and passes; nothing reads this to decide.
   */
  headingTextAgreement?: number;
}

/** Lowercase hex SHA-256 of a document's bytes. */
export function documentSha256(body: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(typeof body === 'string' ? Buffer.from(body, 'utf-8') : body).digest('hex');
}

/** need -> value from a task's recorded requirements, bounded. Reads `collectedRequirements`, else `requirements`. */
export function requirementsOf(details: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!details) return undefined;
  const out: Record<string, string> = {};
  const collected = details.collectedRequirements;
  if (collected && typeof collected === 'object') {
    for (const [need, entry] of Object.entries(collected as Record<string, unknown>)) {
      const value = entry && typeof entry === 'object' ? (entry as { value?: unknown }).value : undefined;
      if (typeof value === 'string' && value.trim()) out[need.slice(0, MAX_REQUIREMENT_CHARS)] = value.slice(0, MAX_REQUIREMENT_CHARS);
      if (Object.keys(out).length >= MAX_REQUIREMENTS) break;
    }
  }
  // A task written before needs carried their source has only the plain map.
  const plain = details.requirements;
  if (plain && typeof plain === 'object') {
    for (const [need, value] of Object.entries(plain as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_REQUIREMENTS) break;
      const key = need.slice(0, MAX_REQUIREMENT_CHARS);
      if (key in out) continue;
      if (typeof value === 'string' && value.trim()) out[key] = value.slice(0, MAX_REQUIREMENT_CHARS);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The reference for a document this turn uploaded, or undefined when the attachment is not a document
 * the turn generated (a generated image carries no hash and is graded by the image judge instead).
 */
export function deliveredDocumentReference(args: {
  attachment: { fileKey: string; name: string; size: number; type: string; sha256?: string } | undefined;
  intent?: string;
  taskId?: string;
  taskType?: string;
  fromState?: string;
  taskDetails?: Record<string, unknown>;
  taskPrivate?: boolean;
  template?: DocumentTemplateRecord;
}): DeliveredDocumentReference | undefined {
  const a = args.attachment;
  if (!a?.sha256 || !a.fileKey) return undefined;
  const requirements = args.taskPrivate ? undefined : requirementsOf(args.taskDetails);
  return {
    fileKey: a.fileKey,
    sha256: a.sha256,
    size: a.size,
    contentType: a.type,
    name: a.name,
    kind: args.taskType || 'document',
    ...(args.intent ? { intent: args.intent } : {}),
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(args.fromState ? { fromState: args.fromState } : {}),
    ...(requirements ? { requirements } : {}),
    ...(args.taskPrivate ? { private: true as const } : {}),
    ...(args.template ? { template: args.template } : {}),
  };
}

/**
 * THE REFERENCE AS IT RIDES THE INLINE MESSAGE METADATA, for a deployment with no out-of-band store
 * (Athena mode). The Chime Metadata is capped at 1024 encoded characters, so this keeps what grading
 * needs and leaves out what the attachment beside it already carries (the name): the key, the hash,
 * size and content type, the kind, the task id and the private flag. The requirements do not fit and
 * are left out, and the reference says so (`requirementsOmitted`), so the judge is told they were not
 * recorded rather than that there were none. The private flag is kept because without it a private
 * task's document would be graded.
 */
export function inlineDeliveredDocument(ref: DeliveredDocumentReference): DeliveredDocumentReference {
  return {
    fileKey: ref.fileKey,
    sha256: ref.sha256,
    size: ref.size,
    contentType: ref.contentType,
    name: '',
    kind: ref.kind,
    ...(ref.taskId ? { taskId: ref.taskId } : {}),
    ...(ref.private ? { private: true as const } : { requirementsOmitted: true as const }),
  };
}

/**
 * WHAT THE JUDGE IS TOLD WHEN THE RESPONSE IT READS IS A DELIVERED DOCUMENT. One copy, read by both
 * evaluation runners (Aurora and Athena mode), so a document is framed the same way in either mode.
 *
 * It says three things: the response is the file the assistant delivered for the request, the chat reply
 * beside it is scored separately, and these are the requirements the task recorded before the document
 * was written. The requirements are the standard the person agreed to, fixed before the document existed
 * (FR13), and they come from the person's own messages, so they are evidence rather than a conclusion of
 * the turn (DESIGN-EVALUATION, "The admissibility test").
 *
 * NOT TOLD: the intent the turn was routed to, nor the kind of task. Both are the classifier's
 * conclusions, and FR6 keeps a judge from being anchored by the label it would be checking.
 */
export const DOCUMENT_FRAMING = `
Delivered document: the CURRENT response below is the document the assistant delivered as a file for this request, not its chat reply (the reply is scored separately). Judge the document as the deliverable: whether it is what the person asked for and meets what they agreed to.
Requirements the task recorded before the document was written:
{{requirements}}
`;

/** The `{{requirements}}` value for `DOCUMENT_FRAMING`: one line per need, or a line saying why there are none. */
export function documentRequirementsText(doc: DeliveredDocumentReference): string {
  const lines = Object.entries(doc.requirements ?? {})
    .map(([need, value]) => `- ${need}: ${value}`)
    .join('\n');
  if (lines) return lines;
  return doc.requirementsOmitted ? '(not recorded where this document was archived)' : '(none recorded)';
}

/**
 * Why a delivered document was not graded.
 *
 * A TERMINAL reason gives the same answer however often the runner tries, so it is recorded once and the
 * document is not read again. `unreadable` is not terminal: an archive read can fail for a moment, so it
 * counts as a failed attempt and is retried within the runner's bound.
 */
export type DocumentSkip = 'private' | 'not-archived' | 'unreadable' | 'hash-mismatch' | 'too-long' | 'empty';
export const TERMINAL_DOCUMENT_SKIPS: ReadonlySet<DocumentSkip> = new Set<DocumentSkip>([
  'private', 'not-archived', 'hash-mismatch', 'too-long', 'empty',
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The reference off an archived message's metadata, or undefined when there is none or it is malformed.
 * Tolerates the JSONB object and the raw string forms the projection holds.
 */
export function deliveredDocumentOf(metadata: unknown): DeliveredDocumentReference | undefined {
  if (!metadata) return undefined;
  let obj: unknown;
  try {
    obj = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  } catch {
    return undefined;
  }
  const raw = (obj as { deliveredDocument?: unknown } | null)?.deliveredDocument;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.fileKey !== 'string' || typeof r.sha256 !== 'string' || !SHA256_HEX.test(r.sha256)) return undefined;
  return r as unknown as DeliveredDocumentReference;
}

/**
 * The archive key a delivered document is copied to:
 * `delivered-documents/<classification>/<conversationId>/<sha256>`.
 *
 * The classification is in the key so a grant on one classification's documents is nameable in IAM
 * (tenet D13), the conversation so the copy is found from the conversation it was delivered in, and the
 * content hash so a second delivery of the same bytes is the same object. Each segment is checked, so a
 * value carried on a record cannot place an object outside the family. Null when one is not usable.
 */
export function deliveredDocumentArchiveKey(classification: string | undefined, channelArn: string, sha256: string): string | null {
  const c = (classification || 'unknown').trim();
  const conversationId = (channelArn || '').split('/').pop() || '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c)) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return null;
  if (!SHA256_HEX.test(sha256)) return null;
  return `${DELIVERED_DOCUMENTS_PREFIX}${c}/${conversationId}/${sha256}`;
}
