/**
 * Read an S3 attachment object's bytes (Phase-3 vision-in: the user's
 * uploaded image on a `/battle` turn → Converse image block).
 *
 * The S3 client is passed in (structurally typed) so this is
 * unit-testable without standing up the SDK, and so the caller reuses
 * its already-constructed client.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { personIdFromArn } from './person-arn.js';

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
  const senderSub = personIdFromArn(senderArn) || '';
  if (!senderSub) return false;
  const parts = (fileKey || '').split('/');
  return parts[0] === 'attachments' && parts.length >= 4 && parts[2] === senderSub;
}

/**
 * Object-level authorization for an image re-read from conversation HISTORY (the round-2 rebuttal's
 * vision path). Every message in the window carries its own user-controlled Metadata, so the key on
 * each is checked against the message that carried it and the conversation being answered:
 *  - `attachments/<conversationId>/<senderSub>/...` - the message's sender uploaded it here;
 *  - `battle-images/<conversationId>/...` - generated for this conversation (persistImageGenOutput),
 *    so it belongs to the conversation rather than to one sender, as the presigned-url download allows.
 * A key naming another conversation, or another member's upload, is refused: without this a forged
 * history message got the rebuttal to describe an image from a conversation the asker cannot read.
 */
export function conversationHoldsHistoryImageKey(
  fileKey: string | undefined,
  channelArn: string | undefined,
  senderArn: string | undefined,
): boolean {
  const conversationId = (channelArn || '').split('/').pop() || '';
  if (!conversationId) return false;
  const parts = (fileKey || '').split('/');
  if (parts[1] !== conversationId) return false;
  if (parts[0] === 'battle-images') return parts.length >= 3;
  return senderOwnsAttachmentKey(fileKey, senderArn);
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
