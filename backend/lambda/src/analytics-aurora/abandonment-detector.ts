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
 * A SECOND SWEEP CLOSES THE OFFERS NOBODY ANSWERED AT ALL. Those create no channel, so the gate
 * above - `new_channel_arn IS NOT NULL` - could never match them and they stayed `outcome IS NULL`
 * forever: present in the table, absent from every outcome rate computed over it, which flatters
 * each of those rates. After `UNANSWERED_OFFER_WINDOW_HOURS` with no answer they are `abandoned`
 * too, so every offer reaches a terminal state and the denominator is the whole population.
 *
 * Best-effort: this is a background reconciliation job. Failures are
 * logged; the next 5-minute run reprocesses the same rows.
 */

import { query, ensureSchema } from './db-client.js';
import { loadProfileRegistry } from '../../../lib/profile-registry';

const ABANDONMENT_WINDOW_MIN = Number(process.env.ABANDONMENT_WINDOW_MIN || '5');
const BATCH_LIMIT = Number(process.env.ABANDONMENT_BATCH_LIMIT || '100');

/**
 * How long an offer may sit with no answer at all before it is called abandoned.
 *
 * THE OTHER CLASS OF ROW THAT COULD NEVER TERMINATE. The sweep above gates on
 * `new_channel_arn IS NOT NULL`, which is right for what it does - it asks whether a person who
 * ACCEPTED then engaged. But an offer nobody ever answered creates no channel, so it never matched
 * that gate, kept `outcome IS NULL` forever, and was counted in no outcome at all. The drift accuracy
 * surface therefore reported on accepted and declined offers while the unanswered ones were simply
 * missing from the denominator, which flatters every rate computed from it.
 *
 * MUCH LONGER THAN THE FIVE MINUTES ABOVE, because the two windows measure different things. That
 * one asks "did the person follow up in the conversation they just opened", which is a question about
 * the next few moments. This one asks "is this suggestion still live", and a person may reasonably
 * come back to a conversation the next morning and answer it. 24 hours is past that and short of a
 * row sitting open for a week.
 */
const UNANSWERED_OFFER_WINDOW_HOURS = Number(process.env.UNANSWERED_OFFER_WINDOW_HOURS || '24');

interface PendingRow {
  event_id: string;
  parent_channel_arn: string;
  new_channel_arn: string;
  /** When the move was decided; engagement is counted from here, not from the destination's whole history. */
  moved_at: string;
}

export async function handler(): Promise<{ checked: number; abandoned: number }> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const startedAt = Date.now();
  console.log('[abandonment-detector] run start');

  // Apply any pending migration first - see `summary-updater.ts` for why bundling the schema is not
  // enough. Memoized per instance; pinned by `db-lambdas-apply-migrations.test.ts`.
  await ensureSchema();

  // Find candidate drift_events rows. The partial index
  // idx_drift_events_pending_abandon makes this cheap.
  const candidates = await query<PendingRow>(
    // UNSETTLED MOVES, not empty outcomes (migration 077): an accepted offer is written `accepted` at once,
    // so reading only empty outcomes never saw a move, and an unused new conversation was never recorded.
    `SELECT event_id, parent_channel_arn, new_channel_arn, COALESCE(outcome_at, occurred_at)::text AS moved_at
       FROM drift_events
      WHERE engagement_settled = FALSE
        AND (outcome IS NULL OR outcome = 'accepted')
        AND new_channel_arn IS NOT NULL
        AND occurred_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY occurred_at
      LIMIT $2`,
    [String(ABANDONMENT_WINDOW_MIN), BATCH_LIMIT],
  );

  let abandoned = 0;
  for (const row of candidates.rows) {
    try {
      const userMessageCount = await countNonBotMessages(row.new_channel_arn, row.moved_at);
      if (userMessageCount === 0) {
        await query(
          `UPDATE drift_events
              SET outcome = 'abandoned', outcome_at = NOW(), engagement_settled = TRUE
            WHERE event_id = $1
              AND engagement_settled = FALSE`,
          [row.event_id],
        );
        abandoned++;
      } else {
        // The user did engage. Mark as accepted; an earlier writer should
        // have done this synchronously but we're idempotent on the fix.
        await query(
          `UPDATE drift_events
              SET outcome = 'accepted', outcome_at = COALESCE(outcome_at, NOW()), engagement_settled = TRUE
            WHERE event_id = $1
              AND engagement_settled = FALSE`,
          [row.event_id],
        );
      }
    } catch (err) {
      console.warn(`[abandonment-detector] failed to resolve ${row.event_id}:`, err);
    }
  }

  // THE OFFERS NOBODY EVER ANSWERED. No channel was created, so the sweep above could not see them
  // and they stayed NULL indefinitely - present in the table and absent from every outcome rate
  // computed over it. Bounded and idempotent like the loop above: the `outcome IS NULL` guard means a
  // person who answers between the SELECT and this UPDATE keeps their own answer.
  let unansweredClosed = 0;
  try {
    const unanswered = await query<{ event_id: string }>(
      `UPDATE drift_events
          SET outcome = 'abandoned', outcome_at = NOW(), engagement_settled = TRUE
        WHERE event_id IN (
          SELECT event_id FROM drift_events
           WHERE outcome IS NULL
             AND new_channel_arn IS NULL
             -- LIVE OFFERS ONLY: an archival score was never shown to anybody, so it has no answer to wait for.
             AND COALESCE(source, 'live') = 'live'
             AND occurred_at < NOW() - ($1 || ' hours')::interval
           ORDER BY occurred_at
           LIMIT $2
        )
          AND outcome IS NULL
        RETURNING event_id`,
      [String(UNANSWERED_OFFER_WINDOW_HOURS), BATCH_LIMIT],
    );
    unansweredClosed = unanswered?.rows?.length ?? 0;
  } catch (err) {
    // Best-effort, like the rest of this job: the next run reprocesses the same rows.
    console.warn('[abandonment-detector] unanswered-offer sweep failed:', err);
  }

  console.log('[abandonment-detector] run complete', {
    checked: candidates.rows.length,
    abandoned,
    unansweredClosed,
    durationMs: Date.now() - startedAt,
  });
  return { checked: candidates.rows.length, abandoned: abandoned + unansweredClosed };
}

// MESSAGES ONLY. The `messages` table also holds channel and membership events, attributed to whoever the
// service names: a conversation the service admin created carries CREATE_CHANNEL and membership rows "sent"
// by that admin, which is not an assistant, so `is_bot` is false on them. Counting every row made each such
// conversation look used before anybody spoke, and an ignored drift conversation was recorded accepted.
// SINCE THE MOVE: a redirect lands in an existing conversation, whose earlier messages say nothing about whether
// the person used it after moving there, so counting its whole history settled every redirect `accepted`.
async function countNonBotMessages(channelArn: string, since?: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM messages
      WHERE channel_arn = $1
        AND event_type = 'CREATE_CHANNEL_MESSAGE'
        AND is_bot = FALSE
        AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
    [channelArn, since ?? null],
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}
