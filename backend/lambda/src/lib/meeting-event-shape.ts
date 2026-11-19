/**
 * THE ONE SHAPE OF A MEETING EVENT (SPEC-ASSISTANT-MEETINGS FR22): the record every writer files, the row every reader
 * returns, and the columns each store keeps it in, declared once.
 *
 * Pure: no client, no driver. The writers (`meeting-event-archive.ts`, `analytics-aurora/meeting-events-ingest.ts`), the
 * readers (`meeting-event-reader.ts`, `analytics-aurora/meeting-events-read.ts`), the fold (`meeting-figures.ts`) and the
 * Glue table (`meetings-stack.ts`) all take their columns from here, so a column added here reaches every SELECT, the
 * INSERT and the table together, and both stores answer the same rows.
 */

/** A meeting event as it is filed and as either store returns it. */
export interface MeetingEventRecord {
  meeting_id: string;
  channel_arn: string;
  classification: string;
  event_type: string;
  /** Who recorded it: the service (`server`), a participant's app (`client`), or the platform (`platform`). */
  source: 'server' | 'client' | 'platform';
  attendee_id: string | null;
  person_key: string | null;
  is_content: boolean;
  network_transport: string | null;
  event_at: string;
  detail: Record<string, unknown> | null;
}

/**
 * THE COLUMNS, in the order every SELECT names them, with the type the archive's Glue table declares. `detail` is the
 * JSON text of the event's remaining fields in the archive (and `jsonb` in Aurora), so a fact the service or the app adds
 * later is kept without a schema change.
 */
export const MEETING_EVENT_COLUMNS = [
  { name: 'meeting_id', type: 'string' },
  { name: 'channel_arn', type: 'string' },
  { name: 'classification', type: 'string' },
  { name: 'event_type', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'attendee_id', type: 'string' },
  { name: 'person_key', type: 'string' },
  { name: 'is_content', type: 'boolean' },
  { name: 'network_transport', type: 'string' },
  { name: 'event_at', type: 'string' },
  { name: 'detail', type: 'string' },
] as const satisfies ReadonlyArray<{ name: keyof MeetingEventRecord; type: string }>;

/** The column names, comma separated, for a SELECT or an INSERT. */
export const MEETING_EVENT_COLUMN_LIST = MEETING_EVENT_COLUMNS.map((c) => c.name).join(', ');

/**
 * THE APP'S PERIODIC CONNECTIVITY READING (`meeting-client-events.ts`): one per attendee per sampling interval. It is the
 * one event that grows with a meeting's length rather than with what happened in it, so a read across a window of many
 * meetings leaves it out and a read of one meeting keeps it: no figure across meetings is folded from it, and the
 * roster's rows stay inside the read's cap however long the meetings ran.
 */
/**
 * AT MOST `max` UTF-16 UNITS OF A STRING, WELL FORMED: cut between code points, never inside a surrogate pair, and any lone
 * surrogate the input carried replaced, so the text a record keeps is one every store accepts (PostgreSQL's `jsonb`
 * refuses a lone `\ud83d`) and one every length check after it reads the same.
 */
export function wellFormedPrefix(s: string, max: number): string {
  const whole = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  if (whole.length <= max) return whole;
  let out = '';
  for (const point of whole) {
    if (out.length + point.length > max) break;
    out += point;
  }
  return out;
}

export const CONNECTIVITY_SAMPLE_EVENT = 'connectivitySample';

/** The most rows one read returns, from either store. A window that holds more is answered as truncated. */
export const MAX_MEETING_EVENT_ROWS = 20_000;

/**
 * The most bytes of rows one read returns. An Aurora read comes back through a synchronous Lambda invoke, whose answer is
 * at most 6 MB, so the rows stop well inside it and the answer says it is truncated.
 */
export const MAX_MEETING_EVENT_BYTES = 4 * 1024 * 1024;

/** A row's size as it travels, in bytes. */
export function meetingEventBytes(row: MeetingEventRecord): number {
  return Buffer.byteLength(JSON.stringify(row), 'utf8');
}

/**
 * The rows that fit one answer, in time order: at most {@link MAX_MEETING_EVENT_ROWS} and {@link MAX_MEETING_EVENT_BYTES}.
 * `truncated` is true when any row was left out, including when the caller already knows its read held more.
 */
export function capMeetingEvents(
  rows: MeetingEventRecord[],
  moreThanRead = false,
  limits: { rows: number; bytes: number } = { rows: MAX_MEETING_EVENT_ROWS, bytes: MAX_MEETING_EVENT_BYTES },
): { rows: MeetingEventRecord[]; truncated: boolean } {
  const sorted = [...rows].sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  const out: MeetingEventRecord[] = [];
  let bytes = 0;
  for (const r of sorted) {
    const size = meetingEventBytes(r);
    if (out.length >= limits.rows || bytes + size > limits.bytes) return { rows: out, truncated: true };
    out.push(r);
    bytes += size;
  }
  return { rows: out, truncated: moreThanRead };
}
