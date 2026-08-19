/**
 * The in-VPC projection of a channel's classification, and the only way code inside the Aurora VPC
 * can learn one.
 *
 * WHY A PROJECTION AND NOT A LOOKUP. The authority is the immutable `classification` tag on the
 * Amazon Chime SDK channel. Nothing in this VPC can read it: the network is provisioned with
 * `natGateways: 0` and interface endpoints for Kinesis, S3, Secrets Manager, DynamoDB and Bedrock
 * Runtime only, so summary-updater, the data-plane and the archival pipeline have no route to the
 * Chime SDK at all. Adding one is explicitly not the answer here; the platform's rule is to add an op
 * to the data-plane seam and let the read happen where Chime is already reachable.
 *
 * THIS IS NEVER THE AUTHORITY FOR A LIVE DECISION (ADR-012). It is a copy, and a copy can be stale or
 * absent. It supplies a value at WRITE time - what classification to stamp on a row - and every caller
 * is required to choose its own fallback for "I don't know", because the safe fallback differs by
 * direction and getting it backwards is silent:
 *
 *   - Stamping CONTENT      -> fall back to `mostRestrictiveValue`. The row becomes readable only at
 *                              the top of the ladder. Withheld, never leaked.
 *   - Choosing a READER role -> fall back to `failClosedValue`, the LOWEST. A reader role sees its own
 *                              classification AND everything below, so defaulting a reader to the most
 *                              restrictive value would hand it the entire table. Same phrase,
 *                              opposite end of the ladder.
 *
 * So this module deliberately returns `null` rather than defaulting on the caller's behalf.
 */

import { query } from './db-client.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';

/** How a recorded classification was obtained. Provenance, so a reader can weigh it. */
export type ClassificationSource = 'router' | 'backfill';

/**
 * The recorded classification for a channel, or `null` when there is none (or it is not a value this
 * deployment declares - a renamed ladder leaves rows behind, and an unrecognized label is not a
 * classification just because it is written down).
 *
 * `channel_classification` is not a bounded table and needs no role: it holds labels, not content.
 */
export async function lookupChannelClassification(channelArn: string): Promise<string | null> {
  const result = await query<{ classification: string }>(
    'SELECT classification FROM channel_classification WHERE channel_arn = $1',
    [channelArn],
  );
  const value = result.rows[0]?.classification;
  if (!value || !profiles.isKnownClassification(value)) return null;
  return profiles.resolveClassification(value);
}

export interface ChannelClassificationRecord {
  channelArn: string;
  classification: string;
  source: ClassificationSource;
}

/**
 * Record what an out-of-VPC reader learned from Chime.
 *
 * LAST WRITE WINS, and that is correct precisely because the classification tag is IMMUTABLE: two
 * authoritative reads of the same channel cannot legitimately disagree, so a conflict means one of
 * them is wrong rather than that the value changed, and there is no ordering that saves it. What the
 * upsert does buy is that a `router` observation (live, from the turn being served) refreshes a
 * `backfill` one without needing to know which ran first.
 *
 * Rows with a classification this deployment does not declare are REJECTED rather than stored, so a
 * malformed payload cannot seed a label that `lookupChannelClassification` would then have to filter
 * out on every read.
 */
export async function recordChannelClassifications(
  records: ChannelClassificationRecord[],
): Promise<{ recorded: number; rejected: Array<{ channelArn: string; classification: string }> }> {
  const rejected: Array<{ channelArn: string; classification: string }> = [];
  const accepted = records.filter((r) => {
    const ok = !!r.channelArn && profiles.isKnownClassification(r.classification);
    if (!ok) rejected.push({ channelArn: r.channelArn, classification: r.classification });
    return ok;
  });

  let recorded = 0;
  for (const record of accepted) {
    const result = await query(
      `INSERT INTO channel_classification (channel_arn, classification, source)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_arn) DO UPDATE
         SET classification = EXCLUDED.classification,
             source = EXCLUDED.source,
             updated_at = NOW()`,
      [record.channelArn, profiles.resolveClassification(record.classification), record.source],
    );
    recorded += result.rowCount ?? 0;
  }

  if (rejected.length) {
    console.warn(
      `[channel-classification] rejected ${rejected.length} record(s) carrying a classification this `
      + 'deployment does not declare:',
      rejected.slice(0, 5),
    );
  }
  return { recorded, rejected };
}
