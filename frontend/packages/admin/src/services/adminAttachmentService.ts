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
 * IAM-enforceable (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md), not a UI convention:
 *   - generated-docs/… → 'attachment-read'          the assistant's DELIVERABLES (archive grade)
 *   - attachments/…     → 'attachment-read-uploads'  USER-UPLOADED input, PII (moderation grade)
 * A key under neither prefix is not an admin-reviewable attachment and is rejected.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CREDENTIAL_EXCHANGE_API_URL, ensureFreshIdToken } from '@ae/shared';

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

interface S3VendResponse {
  credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration?: string };
  bucket: string;
  region: string;
  scopedTo?: string | null;
}

function exchangeUrl(): string {
  if (!CREDENTIAL_EXCHANGE_API_URL) {
    throw new Error('Attachment review requires VITE_CREDENTIAL_EXCHANGE_API_URL');
  }
  return `${CREDENTIAL_EXCHANGE_API_URL.replace(/\/$/, '')}/exchange-credentials`;
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
  if (!capability) throw new Error('Not an admin-reviewable attachment key');

  const idToken = await ensureFreshIdToken();
  if (!idToken) throw new Error('Not authenticated');

  const resp = await fetch(exchangeUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    // identity comes from the validated token, never the body (IDOR guard); the body only NARROWS.
    body: JSON.stringify({ identity: 'admin', channelArn, capabilities: [capability] }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({} as { error?: string }));
    throw new Error(err.error || `Attachment credential exchange failed: ${resp.status}`);
  }
  const data = (await resp.json()) as S3VendResponse;
  if (!data.bucket || !data.region || !data.credentials) {
    throw new Error('Attachment vend returned no S3 target');
  }

  const s3 = new S3Client({
    region: data.region,
    credentials: {
      accessKeyId: data.credentials.AccessKeyId,
      secretAccessKey: data.credentials.SecretAccessKey,
      sessionToken: data.credentials.SessionToken,
    },
  });
  // 5 minutes is ample to open/download; the vended creds themselves also expire well before their
  // moderation-grade TTL, so the URL cannot outlive the audited session by much.
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: data.bucket, Key: fileKey }), { expiresIn: 300 });
}
