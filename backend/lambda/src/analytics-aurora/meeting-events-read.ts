/**
 * READ MEETING EVENTS FROM THE AURORA PROJECTION, for the meeting figures (`lib/meeting-figures.ts`).
 *
 * `meeting_events` is a bounded table under forced row-level security, so it is read one classification at a time, each
 * as that classification's reader role: the database, not this query, decides which rows a read may see. A
 * classification whose read fails is NAMED in the answer rather than leaving the figures quietly smaller (FR23), and a
 * read that reaches the cap says so, rather than returning the first page as if it were everything.
 *
 * THE ANSWER FITS ITS RETURN TRIP. It travels back through a synchronous data-plane invoke, so the rows are capped by
 * count and by bytes (`capMeetingEvents`), in time order across every classification, and the cut is reported as
 * `truncated`. Each classification's read is served by the `(classification, event_at)` index (migration 104).
 */
import { withReaderRole } from './classification-boundary.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import {
  CONNECTIVITY_SAMPLE_EVENT, MAX_MEETING_EVENT_ROWS, MEETING_EVENT_COLUMN_LIST, capMeetingEvents, type MeetingEventRecord,
} from '../lib/meeting-event-shape.js';

export { MAX_MEETING_EVENT_ROWS };

export interface MeetingEventsQuery {
  fromIso: string;
  toIso: string;
  /** One meeting, for its detail; absent, every meeting in the window. */
  meetingId?: string | null;
  /** Whether one meeting's read keeps its connectivity samples (its detail does; its figures do not). Default true. */
  samples?: boolean;
}

export interface MeetingEventsAnswer {
  rows: MeetingEventRecord[];
  truncated: boolean;
  /** Classifications whose rows could not be read, so the answer is incomplete for them. */
  unread: string[];
}

/** One projected row as the fold reads it. */
export function rowFromAurora(r: Record<string, unknown>): MeetingEventRecord {
  return {
    meeting_id: String(r.meeting_id),
    channel_arn: String(r.channel_arn),
    classification: String(r.classification),
    event_type: String(r.event_type),
    source: (r.source as MeetingEventRecord['source']) ?? 'server',
    attendee_id: (r.attendee_id as string | null) ?? null,
    person_key: (r.person_key as string | null) ?? null,
    is_content: Boolean(r.is_content),
    network_transport: (r.network_transport as string | null) ?? null,
    event_at: r.event_at instanceof Date ? r.event_at.toISOString() : String(r.event_at),
    detail: (r.detail as Record<string, unknown> | null) ?? null,
  };
}

export async function readMeetingEvents(q: MeetingEventsQuery): Promise<MeetingEventsAnswer> {
  const params: unknown[] = [q.fromIso, q.toIso];
  let where = 'classification = $3 AND event_at >= $1 AND event_at < $2';
  // One meeting's detail keeps its connectivity samples; its figures, and a window's read of every meeting, leave them out.
  if (q.meetingId) { params.push(q.meetingId); where += ' AND meeting_id = $4'; }
  if (!q.meetingId || q.samples === false) where += ` AND event_type <> '${CONNECTIVITY_SAMPLE_EVENT}'`;
  const sql = `SELECT ${MEETING_EVENT_COLUMN_LIST}
                 FROM meeting_events
                WHERE ${where}
                ORDER BY event_at
                LIMIT ${MAX_MEETING_EVENT_ROWS + 1}`;
  const unread: string[] = [];
  const perClassification = await Promise.all(defaultProfileRegistry.classificationValues().map(async (classification) => {
    try {
      // Each read names its own classification, so a reader whose ladder spans several does not return a row twice.
      const p = [...params];
      p.splice(2, 0, classification);
      const r = await withReaderRole(classification, (client) => client.query<Record<string, unknown>>(sql, p));
      return r.rows;
    } catch (err) {
      console.warn('[meeting-events-read] could not read as one classification', { classification, err: (err as { name?: string })?.name });
      unread.push(classification);
      return [] as Record<string, unknown>[];
    }
  }));
  const moreThanRead = perClassification.some((rows) => rows.length > MAX_MEETING_EVENT_ROWS);
  const { rows, truncated } = capMeetingEvents(perClassification.flat().map(rowFromAurora), moreThanRead);
  return { rows, truncated, unread };
}
