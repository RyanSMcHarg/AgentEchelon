/**
 * Aurora ingest for client-side events (cluster A / BUG #6-#10, #15, #20, #42).
 *
 * In Aurora mode the client-events Firehose→S3→Glue pipeline (analytics-stack.ts,
 * Athena) is NOT deployed, so nothing populates the Aurora `client_events` table
 * and every session/user/WebSocket rollup reads empty. Instead of standing up a
 * second Firehose+loader, the `/events` handler writes straight to Aurora through
 * the VPC data-plane Lambda (ADR-018) — this function does the insert.
 *
 * The normalized record shape mirrors client-events.ts `NormalizedEvent`; the
 * analytics-only fields fold into `event_data` (the query functions read exactly
 * these keys), and `user_id`→`user_sub`, `timestamp`→`created_at`.
 */

import { query } from './db-client.js';

export interface ClientEventRecord {
  record_type: 'event' | 'performance';
  event_type: string;
  user_id: string;
  user_email: string | null;
  user_tier: string;
  session_id: string | null;
  timestamp: string;
  properties: Record<string, string | number | boolean> | null;
  perf_value: number | null;
}

/** Bulk-insert normalized client events into Aurora `client_events`. Idempotent
 *  enough for at-least-once delivery (rows are append-only telemetry; a rare dupe
 *  from a client retry is acceptable and does not skew DAU, which is DISTINCT). */
export async function ingestClientEvents(records: ClientEventRecord[]): Promise<{ inserted: number }> {
  if (!Array.isArray(records) || records.length === 0) return { inserted: 0 };

  // Parameterized multi-row INSERT. 5 columns per row.
  const cols = 5;
  const values: unknown[] = [];
  const tuples: string[] = [];
  records.forEach((r, i) => {
    const b = i * cols;
    tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5})`);
    values.push(
      r.event_type,
      r.session_id,
      r.user_id,
      JSON.stringify({
        record_type: r.record_type,
        user_email: r.user_email,
        user_tier: r.user_tier,
        perf_value: r.perf_value,
        properties: r.properties ?? {},
      }),
      r.timestamp,
    );
  });

  const res = await query(
    `INSERT INTO client_events (event_type, session_id, user_sub, event_data, created_at)
     VALUES ${tuples.join(', ')}`,
    values,
  );
  return { inserted: res.rowCount ?? records.length };
}
