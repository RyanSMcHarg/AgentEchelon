/**
 * Scoped Channel ARNs (Security + Privacy)
 *
 * Per SPEC-DRIFT-CONVERGENCE.md "Scoping (Security + Privacy)":
 *
 * The related-conversation cosine-NN query is the highest-risk surface in
 * drift detection. A bug here leaks one user's conversation summaries to
 * another via nearest-neighbor lookup. Two non-optional requirements:
 *
 * 1. **Cross-user scoping (security):** `channel_arn IN (:scopedChannelArns)`
 *    is enforced **inside** the WHERE clause of the vector search, never as
 *    a post-filter. Without this, user A's drift query can return user B's
 *    semantically-close summaries.
 *
 * 2. **Multi-member intersection scoping (privacy, per ADR-012):** in
 *    multi-member channels, the scope is the intersection of all human
 *    channel members' memberships. A related conversation can only be
 *    suggested if EVERY current human member already has access to it.
 *    Bot/assistant memberships are excluded from the intersection set.
 *
 * This module produces the scoped set; the caller passes it into the SQL
 * query. The detection logic and the scoping logic stay separable so the
 * security guarantee is independently testable.
 */

import { query } from '../analytics-aurora/db-client.js';

/**
 * Return the channel ARNs the drift query is allowed to look in, given a
 * `currentChannelArn`. The set is the intersection of all human channel
 * members' memberships; bot ARNs (whose ARN segment contains '/bot/') are
 * excluded from the intersection.
 *
 * Behavior:
 * - 1:1 channel (1 human + bot): scope = sender's memberships.
 * - 1:1 channel (1 human only, somehow): scope = sender's memberships.
 * - Multi-member channel (2+ humans + bot): scope = intersection of all
 *   humans' memberships, with bots excluded from the intersection seed.
 * - Edge case: 0 humans (all-bot channel) → returns []. drift shouldn't run.
 *
 * Returns a Set for cheap membership checks at the call site; convert to
 * an array when building the SQL `IN (...)` clause.
 */
export async function getScopedChannelArns(
  currentChannelArn: string,
): Promise<string[]> {
  // Step 1: who is in the current channel?
  const memberRows = await query<{ user_sub: string }>(
    `SELECT DISTINCT user_sub FROM channel_membership WHERE channel_arn = $1`,
    [currentChannelArn],
  );

  // Filter out bots. Bots' ARN segment contains '/bot/'; in the
  // channel_membership table the user_sub column may store the full ARN or
  // a sub depending on the upstream writer. Defensive: filter on either.
  const humanSubs = memberRows.rows
    .map((r) => r.user_sub)
    .filter((s) => !!s && !isBotArn(s));

  if (humanSubs.length === 0) {
    return [];
  }

  // Step 2: pull memberships for each human in parallel, then intersect.
  const memberships = await Promise.all(
    humanSubs.map(async (sub) => {
      const rows = await query<{ channel_arn: string }>(
        `SELECT channel_arn FROM channel_membership WHERE user_sub = $1`,
        [sub],
      );
      return new Set(rows.rows.map((r) => r.channel_arn));
    }),
  );

  if (memberships.length === 0) return [];

  // Step 3: compute the intersection. Start with the smallest set for speed.
  memberships.sort((a, b) => a.size - b.size);
  const seed = memberships[0];
  const intersection: string[] = [];
  for (const arn of seed) {
    let inAll = true;
    for (let i = 1; i < memberships.length; i++) {
      if (!memberships[i].has(arn)) {
        inAll = false;
        break;
      }
    }
    if (inAll) intersection.push(arn);
  }

  return intersection;
}

function isBotArn(s: string): boolean {
  return s.includes('/bot/');
}
