/**
 * One-time historical backfill for the placeholder->final capture gap.
 *
 * Going forward, `kinesis-archival.backfillFromUpdateEvents` folds each
 * placeholder->final edit onto the canonical CREATE row + its exchange at
 * archival time. Rows archived BEFORE that shipped still carry the placeholder
 * ("One moment...") as the bot content, a null `bedrock_model`, and a null
 * exchange `intent` — so eval scored placeholders and model/intent read
 * "unknown". This module reconciles that existing data from the update rows,
 * which already hold the final content + model + intent (no re-ingestion needed).
 *
 * Each message's LATEST update is the source (migration 084: every update is its own row, and the
 * latest holds the text the message ends with). A pre-084 message has one update row, which is its
 * latest.
 *
 * Runs inside the VPC-attached data-plane Lambda (the only place Aurora is
 * reachable). Idempotent: every write is COALESCE-guarded, so re-running never
 * clobbers a value already present and converges to the same state.
 */

import { query } from './db-client.js';
import { latestUpdateOrderSql } from './update-events.js';

/**
 * One row per message: its latest update, by the event's own instant (update-events.ts). An UPDATE ...
 * FROM over every update row would take an arbitrary one of a message's several.
 */
const LATEST_UPDATES_SQL = `(
       SELECT DISTINCT ON (ux.channel_arn, ux.base_message_id) ux.*
         FROM messages ux
        WHERE ux.event_type = 'UPDATE_CHANNEL_MESSAGE'
          AND ux.base_message_id IS NOT NULL
        ORDER BY ux.channel_arn, ux.base_message_id, ${latestUpdateOrderSql('ux')}
     )`;

export interface BackfillOptions {
  /**
   * Also clear exchange-type evaluation_results so the eval runner re-scores
   * against the corrected (real-answer) content. Destructive + triggers Bedrock
   * re-eval cost, so it is opt-in. Off by default.
   */
  resetExchangeEvaluations?: boolean;
}

export interface BackfillResult {
  messagesPatched: number;
  exchangesPatched: number;
  evaluationsCleared: number;
}

export async function backfillPlaceholders(
  opts: BackfillOptions = {}
): Promise<BackfillResult> {
  // 1. Fold the final content + model/telemetry from each message's latest update
  //    onto its canonical CREATE message row.
  const messages = await query(
    `UPDATE messages c
        SET updated_content = COALESCE(c.updated_content, u.content),
            bedrock_model   = COALESCE(c.bedrock_model, u.bedrock_model),
            assistant      = COALESCE(c.assistant, u.assistant),
            input_tokens    = COALESCE(c.input_tokens, u.input_tokens),
            output_tokens   = COALESCE(c.output_tokens, u.output_tokens),
            latency_ms      = COALESCE(c.latency_ms, u.latency_ms),
            total_ms        = COALESCE(c.total_ms, u.total_ms),
            poll_ms         = COALESCE(c.poll_ms, u.poll_ms),
            experiment_id   = COALESCE(c.experiment_id, u.experiment_id),
            variant_id      = COALESCE(c.variant_id, u.variant_id),
            was_fallback    = COALESCE(c.was_fallback, FALSE) OR COALESCE(u.was_fallback, FALSE)
       FROM ${LATEST_UPDATES_SQL} u
      WHERE u.channel_arn = c.channel_arn
        AND u.base_message_id = c.message_id
        AND c.event_type = 'CREATE_CHANNEL_MESSAGE'`
  );

  // 2. Fold intent/routing/task attribution from the latest update onto the
  //    exchange paired to the CREATE row. Intent lives only on exchanges and
  //    lands on the update, so an exchange paired from the placeholder otherwise
  //    keeps NULL intent -> "unknown". Intent rides the update row's metadata.
  const exchanges = await query(
    `UPDATE exchanges ex
        SET intent            = COALESCE(ex.intent, u.metadata->>'intent'),
            intent_confidence = COALESCE(ex.intent_confidence, u.metadata->>'intentConfidence'),
            delivery_option   = COALESCE(ex.delivery_option, u.metadata->>'deliveryOption'),
            assistant        = COALESCE(ex.assistant, u.assistant),
            task_id           = COALESCE(ex.task_id, u.task_id),
            task_status       = COALESCE(ex.task_status, u.task_status),
            task_type         = COALESCE(ex.task_type, u.task_type),
            task_step         = COALESCE(ex.task_step, u.task_step),
            model_kind        = COALESCE(ex.model_kind, u.model_kind),
            model_from        = COALESCE(ex.model_from, u.model_from),
            experiment_id     = COALESCE(ex.experiment_id, u.experiment_id),
            variant_id        = COALESCE(ex.variant_id, u.variant_id),
            was_fallback      = COALESCE(ex.was_fallback, FALSE) OR COALESCE(u.was_fallback, FALSE)
       FROM messages c
       JOIN ${LATEST_UPDATES_SQL} u
         ON u.channel_arn = c.channel_arn
        AND u.base_message_id = c.message_id
      WHERE ex.agent_message_id = c.id
        AND c.event_type = 'CREATE_CHANNEL_MESSAGE'`
  );

  let evaluationsCleared = 0;
  if (opts.resetExchangeEvaluations) {
    const cleared = await query(
      `DELETE FROM evaluation_results WHERE evaluation_type = 'exchange'`
    );
    evaluationsCleared = cleared.rowCount ?? 0;
  }

  return {
    messagesPatched: messages.rowCount ?? 0,
    exchangesPatched: exchanges.rowCount ?? 0,
    evaluationsCleared,
  };
}
