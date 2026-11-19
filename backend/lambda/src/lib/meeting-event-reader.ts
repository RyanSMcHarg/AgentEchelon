/**
 * MEETING EVENTS FOR A WINDOW, from whichever store the deployment keeps: the Aurora projection through the data plane,
 * or the conversation archive's `meeting_events` family through Athena. Both answer the same rows, which the figures
 * fold (`meeting-figures.ts`), so the store never changes a number. Each says what the answer is missing: rows past the
 * cap (`truncated`), and in Aurora a classification whose rows could not be read (`unread`).
 *
 * EVERY ROW IS THIS DEPLOYMENT'S. A service event is filed only when this deployment's own conversation record names its
 * meeting (`meeting-events.ts`), and the app's and the platform's events only by this deployment's meeting API, so a read
 * needs no filter to leave out another deployment's or another application's meetings.
 */
import { ensureDataPlaneArn } from './event-archive.js';
import { hasDataPlane, readMeetingEvents } from './data-plane-client.js';
import { ArchiveQueryTimeout, runArchiveQuery } from './archive-reader.js';
import type { MeetingEventRow } from './meeting-figures.js';
import { isMeetingId } from './meeting-lifecycle.js';
import { CONNECTIVITY_SAMPLE_EVENT, MAX_MEETING_EVENT_ROWS, MEETING_EVENT_COLUMN_LIST, capMeetingEvents } from './meeting-event-shape.js';

/** The longest window a read covers, in days. */
export const MAX_WINDOW_DAYS = 31;

export interface MeetingEventsRead {
  rows: MeetingEventRow[];
  truncated: boolean;
  unread: string[];
  store: 'aurora' | 'athena';
}

/**
 * The archive's date partitions a window can fall in. Firehose files an event under the day it arrived, which is the
 * day it happened or the next, so the window is widened by a day each side and the rows are then held to it exactly.
 */
export function partitionsFor(fromMs: number, toMs: number): Array<{ year: string; month: string; day: string }> {
  const out: Array<{ year: string; month: string; day: string }> = [];
  const day = 86_400_000;
  for (let t = Math.floor(fromMs / day) * day - day; t <= toMs + day; t += day) {
    const d = new Date(t).toISOString();
    out.push({ year: d.slice(0, 4), month: d.slice(5, 7), day: d.slice(8, 10) });
  }
  return out;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** The Athena query over the window, its partitions named so nothing else is scanned. */
export function athenaQueryFor(fromIso: string, toIso: string, meetingId: string | null, samples = true): string {
  if (meetingId !== null && !isMeetingId(meetingId)) throw new Error('meeting id is not well formed');
  if (!ISO_INSTANT.test(fromIso) || !ISO_INSTANT.test(toIso)) throw new Error('the window is not two instants');
  const parts = partitionsFor(Date.parse(fromIso), Date.parse(toIso))
    .map((p) => `(year = '${p.year}' AND month = '${p.month}' AND day = '${p.day}')`).join(' OR ');
  // One meeting's detail keeps its connectivity samples; its figures, and a window's read of every meeting, leave them out.
  const scope = (meetingId ? `\n             AND meeting_id = '${meetingId}'` : '')
    + (!meetingId || !samples ? `\n             AND event_type <> '${CONNECTIVITY_SAMPLE_EVENT}'` : '');
  return `SELECT ${MEETING_EVENT_COLUMN_LIST}
            FROM meeting_events
           WHERE (${parts})
             AND event_at >= '${fromIso}' AND event_at < '${toIso}'${scope}
           ORDER BY event_at`;
}

/** One Athena row as the fold reads it. */
export function rowFromAthena(columns: string[], values: string[]): MeetingEventRow {
  const v = (name: string): string | null => { const i = columns.indexOf(name); const x = i >= 0 ? values[i] : ''; return x === '' ? null : x; };
  let detail: Record<string, unknown> | null = null;
  try { const d = v('detail'); detail = d ? JSON.parse(d) as Record<string, unknown> : null; } catch { detail = null; }
  const source = v('source');
  return {
    meeting_id: v('meeting_id') ?? '',
    channel_arn: v('channel_arn') ?? '',
    classification: v('classification') ?? '',
    event_type: v('event_type') ?? '',
    source: source === 'client' || source === 'platform' ? source : 'server',
    attendee_id: v('attendee_id'),
    person_key: v('person_key'),
    is_content: v('is_content') === 'true',
    network_transport: v('network_transport'),
    event_at: v('event_at') ?? '',
    detail,
  };
}

/**
 * The window's events. `fromIso` and `toIso` are checked by the caller to be at most {@link MAX_WINDOW_DAYS} apart.
 *
 * ANSWERED BY `deadlineAt` (epoch milliseconds), the caller's own limit less its margin. An archive query still running
 * then is stopped and the answer is the designed incomplete one: no rows, `truncated`, which the console words as a
 * window too large to read and a summary refuses as `INCOMPLETE`. Either store's rows are capped by count and bytes.
 */
export async function meetingEventsIn(
  fromIso: string, toIso: string, meetingId: string | null = null, opts: { deadlineAt?: number; samples?: boolean } = {},
): Promise<MeetingEventsRead> {
  await ensureDataPlaneArn();
  const samples = opts.samples ?? true;
  if (hasDataPlane()) {
    const r = await readMeetingEvents({ fromIso, toIso, meetingId, ...(samples ? {} : { samples: false }) });
    return { ...r, store: 'aurora' };
  }
  try {
    const r = await runArchiveQuery(athenaQueryFor(fromIso, toIso, meetingId, samples), { maxRows: MAX_MEETING_EVENT_ROWS, deadlineAt: opts.deadlineAt });
    const capped = capMeetingEvents(r.rows.map((row) => rowFromAthena(r.columns, row)), r.truncated);
    return { rows: capped.rows, truncated: capped.truncated, unread: [], store: 'athena' };
  } catch (err) {
    if (!(err instanceof ArchiveQueryTimeout)) throw err;
    console.warn('[meeting-event-reader] the archive query passed its deadline; answering incomplete', { fromIso, toIso });
    return { rows: [], truncated: true, unread: [], store: 'athena' };
  }
}
