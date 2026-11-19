/**
 * Aurora ingest for meeting lifecycle events (SPEC-ASSISTANT-MEETINGS FR22, DESIGN C.5).
 *
 * The roster is a QUERY over these rows and is never stored, so this writer's only job is to get the
 * event sequence in faithfully. Everything the roster shows - who joined, who dropped rather than
 * left, how long each person was connected across reconnects, who presented - is a fold over what
 * lands here.
 *
 * ── UNLIKE `client-events-ingest`, THIS ONE CANNOT TOLERATE A DUPLICATE ─────────────────────────
 *
 * Client events are append-only telemetry where a rare duplicate from a client retry is acceptable,
 * because the figures read off them are `DISTINCT` counts. A roster is different: it SUMS INTERVALS.
 * A duplicated `AttendeeJoined` adds a second interval for one arrival, so connected time and the
 * participant count both drift upward - silently, and in the direction that reads as success.
 *
 * EventBridge delivery is at-least-once, so that duplicate is expected rather than hypothetical. The
 * insert is therefore `ON CONFLICT DO NOTHING` against the natural key the service already makes
 * unique (migration 069): one attendee record emits one event of a given type at one instant.
 *
 * `inserted` IS THEREFORE NOT `records.length`, and the difference is the useful number: it is how
 * many of this batch were redeliveries. Reported rather than discarded so a caller can log it.
 */

import { withWriterRole } from './classification-boundary.js';
import { MEETING_EVENT_COLUMNS, MEETING_EVENT_COLUMN_LIST, type MeetingEventRecord } from '../lib/meeting-event-shape.js';

export type { MeetingEventRecord };

/** The most expired rows one ingest deletes: more than one ingest files, so the expired rows never accumulate. */
export const EXPIRED_PER_INGEST = 500;

/** Column count per row, from the one column list, so the tuple builder cannot drift from it. */
const COLS = MEETING_EVENT_COLUMNS.length;

/**
 * Insert meeting lifecycle events, ignoring redeliveries.
 *
 * Returns the number of rows that were NEW. A batch of five whose events were all seen before
 * reports zero, which is correct and is not a failure.
 */
export async function ingestMeetingEvents(
  records: MeetingEventRecord[],
): Promise<{ inserted: number; duplicates: number }> {
  if (!Array.isArray(records) || records.length === 0) return { inserted: 0, duplicates: 0 };

  const values: unknown[] = [];
  const tuples: string[] = [];
  records.forEach((r, i) => {
    const b = i * COLS;
    tuples.push(`(${MEETING_EVENT_COLUMNS.map((c, j) => `$${b + j + 1}${c.name === 'detail' ? '::jsonb' : ''}`).join(', ')})`);
    for (const c of MEETING_EVENT_COLUMNS) {
      const v = r[c.name];
      values.push(c.name === 'detail' ? (v === null ? null : JSON.stringify(v)) : v);
    }
  });

  // AS THE WRITE ROLE. `meeting_events` is a bounded table under FORCE ROW LEVEL SECURITY, and its only
  // write policy admits `ae_writer`, so the login role's insert is refused outright.
  const res = await withWriterRole(async (client) => {
    const written = await client.query(
      `INSERT INTO meeting_events (${MEETING_EVENT_COLUMN_LIST})
     VALUES ${tuples.join(', ')}
     ON CONFLICT (meeting_id, COALESCE(attendee_id, ''), event_type, event_at) DO NOTHING`,
      values,
    );
    // THE TABLE'S EXPIRY IS ENFORCED BY ITS OWN WRITES (migration 105): each ingest deletes a bounded batch of rows past
    // `expires_at`, oldest first, so the expired rows go as fast as new ones arrive and no timer is needed.
    await client.query(
      `DELETE FROM meeting_events WHERE id IN (
         SELECT id FROM meeting_events WHERE expires_at < NOW() ORDER BY expires_at LIMIT ${EXPIRED_PER_INGEST})`,
    );
    return written;
  });
  const inserted = res.rowCount ?? 0;
  return { inserted, duplicates: records.length - inserted };
}
