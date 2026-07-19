/**
 * Read an S3 attachment object's bytes (Phase-3 vision-in: the user's
 * uploaded image on a `/battle` turn → Converse image block).
 *
 * The S3 client is passed in (structurally typed) so this is
 * unit-testable without standing up the SDK, and so the caller reuses
 * its already-constructed client.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * Object-level authorization for attachment-in reads. The fileKey arrives on user-controlled
 * message Metadata, so a caller MUST gate the S3 GetObject on this before reading — otherwise a
 * crafted key could read another user's uploaded file (the classification's `s3:GetObject` grant spans the
 * whole `attachments/*` prefix). Uploads are keyed `attachments/<conversationId>/<senderSub>/...`
 * (see presigned-url), so we require the key's 3rd segment to equal the sender's own sub. S3 keys
 * are not path-normalized, so a literal '..' cannot traverse out of the sender's segment. Mirrors
 * the ownership check the presigned-url download path enforces.
 */
export function senderOwnsAttachmentKey(
  fileKey: string | undefined,
  senderArn: string | undefined,
): boolean {
  const senderSub = senderArn?.split('/user/').pop() || '';
  if (!senderSub) return false;
  const parts = (fileKey || '').split('/');
  return parts[0] === 'attachments' && parts.length >= 4 && parts[2] === senderSub;
}

export interface S3GetClient {
  send(command: unknown): Promise<{
    Body?: { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  }>;
}

export async function fetchAttachmentBytes(
  s3: S3GetClient,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  if (!bucket || !key) {
    throw new Error('fetchAttachmentBytes: bucket and key are required');
  }
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  if (!body || typeof body.transformToByteArray !== 'function') {
    throw new Error(`fetchAttachmentBytes: object ${key} has no readable body`);
  }
  return body.transformToByteArray();
}
