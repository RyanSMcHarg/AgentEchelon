/**
 * Drift Abandonment Detector Lambda
 *
 * Per SPEC-DRIFT-CONVERGENCE.md, runs on a 5-minute EventBridge schedule
 * and writes `outcome='abandoned'` to drift_events rows where:
 *
 *   - outcome IS NULL (not yet resolved)
 *   - new_channel_arn IS NOT NULL (the user accepted, a channel was created)
 *   - occurred_at < NOW() - 5 minutes (enough time has passed for the user
 *     to send a follow-up)
 *   - The new channel has ≤1 message (just the bot's WelcomeIntent, no
 *     user reply)
 *
 * This distinguishes "user accepted by reflex and never engaged" from
 * "drift was real and the user moved their conversation." The
 * `accepted` outcome is written synchronously when the user confirms;
 * we only retroactively switch it to `abandoned` when there's no
 * follow-up activity.
 *
 * Best-effort: this is a background reconciliation job. Failures are
 * logged; the next 5-minute run reprocesses the same rows.
 */

import { query } from './db-client.js';

const ABANDONMENT_WINDOW_MIN = Number(process.env.ABANDONMENT_WINDOW_MIN || '5');
const BATCH_LIMIT = Number(process.env.ABANDONMENT_BATCH_LIMIT || '100');

interface PendingRow {
  event_id: string;
  parent_channel_arn: string;
  new_channel_arn: string;
}

export async function handler(): Promise<{ checked: number; abandoned: number }> {
  const startedAt = Date.now();
  console.log('[abandonment-detector] run start');

  // Find candidate drift_events rows. The partial index
  // idx_drift_events_pending_abandon makes this cheap.
  const candidates = await query<PendingRow>(
    `SELECT event_id, parent_channel_arn, new_channel_arn
       FROM drift_events
      WHERE outcome IS NULL
        AND new_channel_arn IS NOT NULL
        AND occurred_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY occurred_at
      LIMIT $2`,
    [String(ABANDONMENT_WINDOW_MIN), BATCH_LIMIT],
  );

  let abandoned = 0;
  for (const row of candidates.rows) {
    try {
      const userMessageCount = await countNonBotMessages(row.new_channel_arn);
      if (userMessageCount === 0) {
        await query(
          `UPDATE drift_events
              SET outcome = 'abandoned'
            WHERE event_id = $1
              AND outcome IS NULL`,
          [row.event_id],
        );
        abandoned++;
      } else {
        // The user did engage. Mark as accepted; an earlier writer should
        // have done this synchronously but we're idempotent on the fix.
        await query(
          `UPDATE drift_events
              SET outcome = 'accepted'
            WHERE event_id = $1
              AND outcome IS NULL`,
          [row.event_id],
        );
      }
    } catch (err) {
      console.warn(`[abandonment-detector] failed to resolve ${row.event_id}:`, err);
    }
  }

  console.log('[abandonment-detector] run complete', {
    checked: candidates.rows.length,
    abandoned,
    durationMs: Date.now() - startedAt,
  });
  return { checked: candidates.rows.length, abandoned };
}

async function countNonBotMessages(channelArn: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM messages
      WHERE channel_arn = $1
        AND is_bot = FALSE`,
    [channelArn],
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}
