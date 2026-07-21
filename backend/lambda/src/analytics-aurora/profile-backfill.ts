/**
 * One-off backfill: stamp portable-profile attribution (assistant/profile + version) onto HISTORICAL bot
 * messages (SPEC-ASSISTANT-CONFIG §4). Going forward the async processor stamps this at write time; this
 * fills the gap for rows archived before that landed.
 *
 * SAFE because it is currently 1:1:1 — each classification has exactly ONE primary assistant, ONE profile,
 * and ONE version — so a historical bot reply's assistant + version is fully determined by its classification
 * (the `agent_type` on the row). The caller resolves each classification's active `{profileConfigId, version}`
 * (from SSM) and passes them in, so this function stays pure SQL with no SSM/VPC coupling. Idempotent: only
 * rows that don't already carry `profileName` are touched, and it MERGES into the existing metadata JSONB
 * (steps/configId/etc. preserved). When multiple assistants can serve one classification this no longer holds
 * and attribution MUST come only from the write-time stamp — do not extend this heuristic past 1:1:1.
 */
import { query } from './db-client.js';

export interface ProfileBackfillInput {
  /** classification (basic|standard|premium) -> the ONE active profile version that served it. */
  attribution: Record<string, { profileName: string; profileConfigId: string; profileVersion?: number }>;
}

export interface ProfileBackfillResult {
  updated: Record<string, number>;
  totalUpdated: number;
}

export async function backfillProfileAttribution(input: ProfileBackfillInput): Promise<ProfileBackfillResult> {
  const updated: Record<string, number> = {};
  for (const [classification, a] of Object.entries(input.attribution || {})) {
    if (!a?.profileName || !a?.profileConfigId) continue;
    const hasVersion = a.profileVersion !== undefined && a.profileVersion !== null;
    const built = hasVersion
      ? `jsonb_build_object('profileName', $2::text, 'profileConfigId', $3::text, 'profileVersion', $4::int)`
      : `jsonb_build_object('profileName', $2::text, 'profileConfigId', $3::text)`;
    const params = hasVersion
      ? [classification, a.profileName, a.profileConfigId, a.profileVersion]
      : [classification, a.profileName, a.profileConfigId];
    // Only bot-reply rows (agent_type set = the responder's classification) missing attribution.
    const res = await query(
      `UPDATE messages
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${built}
        WHERE agent_type = $1
          AND (metadata->>'profileName') IS NULL`,
      params,
    );
    updated[classification] = res.rowCount ?? 0;
  }
  const totalUpdated = Object.values(updated).reduce((s, n) => s + n, 0);
  console.log('[profile-backfill] done', { updated, totalUpdated });
  return { updated, totalUpdated };
}
