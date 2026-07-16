/**
 * Historical model/telemetry backfill from the out-of-band analytics store.
 *
 * The bot's model, token counts, and latencies are written OUT OF BAND to the
 * `MessageAnalyticsTable` DynamoDB table (ADR-016 / SPEC-MESSAGE-METADATA-CODEBOOK,
 * Technique B) rather than onto the size-capped Chime metadata, and archival
 * folds them onto the Aurora row from there. Rows archived before that fold was
 * reliable carry a NULL `messages.bedrock_model` (+ null tokens/latency), so
 * `model_usage` / `model_effectiveness` read a lone "unknown" bucket.
 *
 * The values are NOT lost — the DynamoDB table still holds them keyed by the
 * Chime MessageId, which IS the Aurora CREATE row's `message_id`. This module
 * scans that table and folds `bedrockModel` + token/latency telemetry onto the
 * canonical CREATE message rows. Every write is COALESCE-guarded (idempotent;
 * never clobbers a value already present).
 *
 * Runs inside the Kinesis archival Lambda — the one place that already has BOTH
 * DynamoDB read (grantReadData) and Aurora write, so no new IAM grant is needed.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { query } from './db-client.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));

export interface ModelBackfillResult {
  scanned: number;
  withModel: number;
  messagesPatched: number;
}

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * Fold `bedrockModel` + token/latency telemetry from the out-of-band DynamoDB
 * store onto the canonical CREATE message rows whose column is still NULL.
 */
export async function backfillModelFromAnalytics(): Promise<ModelBackfillResult> {
  const TABLE = process.env.MESSAGE_ANALYTICS_TABLE || '';
  if (!TABLE) {
    throw new Error('MESSAGE_ANALYTICS_TABLE is not set — cannot backfill model attribution.');
  }

  let scanned = 0;
  let withModel = 0;
  let messagesPatched = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey }),
    );
    const items = (res.Items || []) as Record<string, unknown>[];
    for (const it of items) {
      scanned++;
      const messageId = String(it.messageId || '').trim();
      const channelArn = String(it.channelArn || '').trim();
      const model = it.bedrockModel != null ? String(it.bedrockModel) : null;
      if (!messageId || !channelArn || !model) continue;
      withModel++;

      // COALESCE-guarded: only fills columns still NULL, so re-running converges.
      const upd = await query(
        `UPDATE messages
            SET bedrock_model = COALESCE(bedrock_model, $1),
                input_tokens  = COALESCE(input_tokens,  $2),
                output_tokens = COALESCE(output_tokens, $3),
                latency_ms    = COALESCE(latency_ms,    $4),
                total_ms      = COALESCE(total_ms,      $5),
                poll_ms       = COALESCE(poll_ms,       $6),
                agent_type    = COALESCE(agent_type,    $7)
          WHERE channel_arn = $8
            AND message_id = $9
            AND event_type = 'CREATE_CHANNEL_MESSAGE'
            AND bedrock_model IS NULL`,
        [
          model,
          toInt(it.inputTokens),
          toInt(it.outputTokens),
          toInt(it.latencyMs) ?? toInt(it.bedrockLatencyMs),
          toInt(it.totalMs),
          toInt(it.pollMs),
          it.agentType != null ? String(it.agentType) : null,
          channelArn,
          messageId,
        ],
      );
      messagesPatched += upd.rowCount ?? 0;
    }
    ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);

  return { scanned, withModel, messagesPatched };
}
