/**
 * THE ARCHIVE KEEPS ITS OWN COPY OF EVERY DELIVERED DOCUMENT (SPEC-EVALUATION FR22).
 *
 * A delivered document is uploaded to the attachments bucket under `generated-docs/`, a key family the
 * conversation owns, whose lifecycle rule expires it and whose write scope is the processor's. The
 * archive is the system of record for what a turn produced and for every evaluation input (tenet D7),
 * so it does not borrow that object: archival copies the bytes into the archive bucket under
 * `delivered-documents/<classification>/<conversationId>/<sha256>`, a family the archive owns and that
 * follows the archive's lifecycle (tenet D15). The evaluator then reads the archive's copy and nothing
 * in the attachments bucket.
 *
 * COPIED, NOT REFERENCED, because the two stores answer to different owners. A reference into the
 * attachments bucket would make the archive's record of the deliverable depend on a rule written for
 * member uploads and conversation files, and the evaluator would need a read on a bucket it has no
 * other reason to reach.
 *
 * VERIFIED. The bytes read are hashed and compared with the SHA-256 the processor recorded when it
 * uploaded them. A mismatch means the object is not the one the turn delivered, and nothing is copied.
 *
 * FAILS OPEN. A copy that cannot be made is logged and leaves the reference without `archiveKey`, which
 * the evaluator reads as "not assessed". It never fails the archival batch: a message that archives
 * without its document is a recoverable gap, and a batch that throws re-delivers every message in it.
 */
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { fetchAttachmentBytes } from '../lib/attachment-bytes.js';
import {
  deliveredDocumentArchiveKey,
  documentSha256,
  type DeliveredDocumentReference,
} from '../lib/delivered-document.js';

/** The S3 client shape this module needs, structurally typed so a test can stand one in. */
export interface S3SendClient {
  send(command: unknown): Promise<{ Body?: { transformToByteArray?: () => Promise<Uint8Array> } | undefined }>;
}

/**
 * Copy the delivered document into the archive and return the reference with `archiveKey` set, or the
 * reference unchanged when the copy was not made.
 *
 * Only a document generated for THIS conversation is copied: the key must sit under
 * `generated-docs/<conversationId>/`, the family the processor writes, for the conversation the message
 * was archived from. A reference naming another conversation's file is refused rather than copied.
 */
/**
 * THE DOCUMENTS THIS CONTAINER HAS ALREADY COPIED, by archive key. The key is content-addressed, so a second copy
 * would write the same bytes to the same key; remembering it saves the fetch and the write when a message's later
 * events, or a redelivered batch, name the same document. Bounded, because a warm container lives for hours.
 */
const copied = new Set<string>();
const COPIED_LIMIT = 1000;

/** Forget what this container copied. For tests. */
export function forgetCopiedDocuments(): void {
  copied.clear();
}

export async function archiveDeliveredDocument(args: {
  s3: S3SendClient;
  attachmentsBucket: string;
  archiveBucket: string;
  channelArn: string;
  classification: string | undefined;
  reference: DeliveredDocumentReference;
}): Promise<DeliveredDocumentReference> {
  const { s3, attachmentsBucket, archiveBucket, channelArn, classification, reference } = args;
  if (!attachmentsBucket || !archiveBucket) return reference;
  const conversationId = (channelArn || '').split('/').pop() || '';
  if (!conversationId || !reference.fileKey.startsWith(`generated-docs/${conversationId}/`)) {
    console.warn('[delivered-document-archive] the reference names a file outside this conversation\'s documents; not copied', {
      fileKey: reference.fileKey,
    });
    return reference;
  }
  const archiveKey = deliveredDocumentArchiveKey(classification, channelArn, reference.sha256);
  if (!archiveKey) {
    console.warn('[delivered-document-archive] no usable archive key for the document; not copied', { fileKey: reference.fileKey });
    return reference;
  }
  if (copied.has(archiveKey)) return { ...reference, archiveKey };
  try {
    const bytes = await fetchAttachmentBytes(s3, attachmentsBucket, reference.fileKey);
    const hash = documentSha256(bytes);
    if (hash !== reference.sha256) {
      console.warn('[delivered-document-archive] the stored file does not match the hash the turn recorded; not copied', {
        fileKey: reference.fileKey,
      });
      return reference;
    }
    await s3.send(new PutObjectCommand({
      Bucket: archiveBucket,
      Key: archiveKey,
      Body: bytes,
      ContentType: reference.contentType || 'application/octet-stream',
      // The bucket's default encryption is the archive's own key; nothing here overrides it.
      Metadata: { sourcekey: reference.fileKey, sha256: reference.sha256 },
    }));
    if (copied.size >= COPIED_LIMIT) copied.clear();
    copied.add(archiveKey);
    return { ...reference, archiveKey };
  } catch (err) {
    console.warn('[delivered-document-archive] copying the delivered document into the archive failed (archived without it):', {
      fileKey: reference.fileKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return reference;
  }
}
