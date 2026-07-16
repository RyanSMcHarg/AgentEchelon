/**
 * Out-of-band per-message analytics store (SPEC-MESSAGE-METADATA-CODEBOOK.md
 * Technique B / Phase 1; ADR-016).
 *
 * The bot message's Chime `Metadata` is capped at 1024 encoded chars and is the
 * single source for BOTH the frontend and the Aurora archival pipeline. The
 * heavy analytics-only fields (token counts, latencies, the config-identity
 * fingerprint, intent confidence, fallback detail) are read by exactly one
 * consumer — archival — so they do not need to ride the size-capped messaging
 * metadata at all.
 *
 * This module writes the FULL analytics record to a dedicated DynamoDB table
 * keyed by the message's own Chime `MessageId` (no new id is minted), and lets
 * archival read it back by that id. The Chime `Metadata` is then slimmed to the
 * small fields the frontend actually renders (see `pickFrontendMetadata` in
 * `analytics-metadata.ts`), freeing the budget and making analytics robust
 * against the cap.
 *
 * Both calls are env-gated (`MESSAGE_ANALYTICS_TABLE`) and FAIL OPEN: if the
 * table is not provisioned (e.g. Athena mode, which has no archival consumer for
 * these fields) or DynamoDB rejects the call, the caller proceeds — the write is
 * skipped and the read returns null. Coupling the producer's slim decision to
 * this same env var leaves Athena mode unchanged.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MESSAGE_ANALYTICS_TABLE = process.env.MESSAGE_ANALYTICS_TABLE || '';

// Rows are consumed by archival within seconds; the TTL is a generous safety
// margin for replay/backfill, not a retention policy (Aurora is the durable store).
const MESSAGE_ANALYTICS_TTL_DAYS = 7;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

/** True when the out-of-band store is provisioned in this deployment. */
export function messageAnalyticsEnabled(): boolean {
  return !!MESSAGE_ANALYTICS_TABLE;
}

/**
 * Write the full analytics record for a message, keyed by its Chime MessageId.
 * Fail-open: unset table or a DynamoDB error is swallowed (logged), so analytics
 * persistence never blocks or fails the reply post.
 */
export async function writeMessageAnalytics(args: {
  messageId: string;
  channelArn: string;
  analytics: Record<string, unknown>;
}): Promise<void> {
  const messageId = (args.messageId || '').trim();
  if (!MESSAGE_ANALYTICS_TABLE || !messageId) return;
  try {
    await ddb.send(
      new PutCommand({
        TableName: MESSAGE_ANALYTICS_TABLE,
        Item: {
          ...args.analytics,
          messageId,
          channelArn: args.channelArn,
          ttl: Math.floor(Date.now() / 1000) + MESSAGE_ANALYTICS_TTL_DAYS * 24 * 60 * 60,
        },
      }),
    );
  } catch (err) {
    console.warn('[message-analytics] write failed (failing open):', err);
  }
}

/**
 * Read the out-of-band analytics record for a Chime MessageId, or null when
 * absent / unavailable. The returned object carries the same field names the
 * analytics metadata uses (bedrockModel, inputTokens, …) plus the bookkeeping
 * keys (messageId/channelArn/ttl), which downstream column derivation ignores.
 */
export async function readMessageAnalytics(
  messageId: string,
): Promise<Record<string, unknown> | null> {
  const id = (messageId || '').trim();
  if (!MESSAGE_ANALYTICS_TABLE || !id) return null;
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: MESSAGE_ANALYTICS_TABLE, Key: { messageId: id } }),
    );
    return (res.Item as Record<string, unknown> | undefined) ?? null;
  } catch (err) {
    console.warn('[message-analytics] read failed (failing open):', err);
    return null;
  }
}
