/**
 * Admin conversation attachment review.
 *
 * Downloading a conversation's attachments is a privileged, plane:'admin' action — the same
 * model as every other cross-channel admin read here. This service does NOT hold or proxy any
 * standing S3 access: it asks the Credential Exchange to vend SHORT-LIVED, CHANNEL-SCOPED,
 * AUDITED STS creds whose session policy permits `s3:GetObject` on ONLY the named channel's
 * attachment keys, then presigns the GetObject client-side with those creds. The presigned URL
 * opens as a top-level navigation (no S3 CORS needed) and expires quickly.
 *
 * Two capabilities, split by object-key prefix so the data-sensitivity boundary is
 * IAM-enforceable (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md), not a UI convention:
 *   - generated-docs/… → 'attachment-read'          the assistant's DELIVERABLES (archive grade)
 *   - attachments/…     → 'attachment-read-uploads'  USER-UPLOADED input, PII (moderation grade)
 * A key under neither prefix is not an admin-reviewable attachment and is rejected.
 */
import i18n from '@ae/shared/i18n';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAdminApi, vendAdminCapability } from './sigv4Fetch';
import { reasonFor } from './adminReason';

/** Which exchange capability a given attachment key requires, or null if it is not reviewable. */
export function attachmentCapabilityForKey(
  fileKey: string,
): 'attachment-read' | 'attachment-read-uploads' | null {
  if (fileKey.startsWith('generated-docs/')) return 'attachment-read';
  if (fileKey.startsWith('attachments/')) return 'attachment-read-uploads';
  return null;
}

/** True when the key is a user-uploaded file (moderation-grade, PII) rather than an assistant deliverable. */
export function isUserUploadedAttachment(fileKey: string): boolean {
  return attachmentCapabilityForKey(fileKey) === 'attachment-read-uploads';
}

/**
 * Vend channel-scoped S3 creds for `fileKey` in `channelArn` and return a short-lived presigned
 * GET URL the caller can open. Throws if the key is not an admin-reviewable attachment, the
 * caller lacks the capability (exchange 403), or the vend is misconfigured.
 */
export async function getAdminAttachmentDownloadUrl(
  channelArn: string,
  fileKey: string,
): Promise<string> {
  const capability = attachmentCapabilityForKey(fileKey);
  if (!capability) throw new Error(i18n.t('admin.adminAttachmentService.notAnAdminReviewableAttachment'));

  // The capability's own IAM-authorized route, with the reason the conversation was opened for. Opening
  // an attachment is part of reading the conversation, so it reuses that reason.
  requireAdminApi(i18n.t('admin.adminAttachmentService.attachmentReviewRequiresVite_credential_exchange_api_url'));
  const reason = await reasonFor({ capability, channelArn, kind: 'read' });
  const data = await vendAdminCapability(capability, { channelArn, reason });
  if (!data.bucket || !data.region || !data.credentials) {
    throw new Error(i18n.t('admin.adminAttachmentService.attachmentVendReturnedNoS3'));
  }

  const s3 = new S3Client({ region: data.region, credentials: data.credentials });
  // 5 minutes is ample to open/download; the vended creds themselves also expire well before their
  // moderation-grade TTL, so the URL cannot outlive the audited session by much.
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: data.bucket, Key: fileKey }), { expiresIn: 300 });
}
