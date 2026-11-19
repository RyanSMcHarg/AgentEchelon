/**
 * MEETING EVENTS ARE FILED IN THE CONVERSATION ARCHIVE FIRST, THEN PROJECTED (SPEC-ASSISTANT-MEETINGS FR22, tenet D7).
 *
 * The archive is the system of record in every deployment, so each event goes to the Meetings stack's delivery stream
 * (`meeting_events/` in the archive bucket, read by Athena as `meeting_events`) before anything else. Where the
 * deployment keeps an Aurora projection, the same events are then inserted there for the roster's fast reads; that copy
 * is never the only place an event lives, and an insert that failed is retried until it lands or is kept to replay.
 *
 * ONE WRITER FOR EVERY SOURCE: the service's lifecycle (`server`), a participant's app (`client`) and what the platform
 * does around a meeting, such as a ring (`platform`).
 *
 * A FAILURE THROWS, at either step, so the caller's retry files the event again. Delivery to the archive is
 * at-least-once, so a reader folds the family on its natural key (meeting, attendee, type, time), the same key the
 * projection's unique index enforces.
 */
import { ensureDataPlaneArn, putArchiveLines } from './event-archive.js';
import { hasDataPlane, ingestMeetingEvents } from './data-plane-client.js';
import type { MeetingEventRecord } from './meeting-event-shape.js';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';

export type { MeetingEventRecord };

/** One archive line: the record, its remaining detail kept as JSON text so a new field needs no schema change. */
export function archiveLine(r: MeetingEventRecord): Record<string, unknown> {
  return { ...r, detail: r.detail === null ? null : JSON.stringify(r.detail) };
}

export interface MeetingEventSinks {
  archive: (lines: object[]) => Promise<{ delivered: number; dropped: number }>;
  projection: ((records: MeetingEventRecord[]) => Promise<{ inserted: number; duplicates: number }>) | null;
  /** Hand records a best-effort writer could not project to be projected and retried elsewhere; true once accepted. */
  handOn?: (records: MeetingEventRecord[]) => Promise<boolean>;
}

/**
 * The deployment's own sinks: the Meetings stack's stream, and the Aurora data plane where one is wired. The data plane
 * is resolved here (`ensureDataPlaneArn`), so a writer never has to remember to, and a resolution that failed throws
 * before anything is filed.
 */
export async function deploymentSinks(): Promise<MeetingEventSinks> {
  await ensureDataPlaneArn();
  const stream = process.env.MEETING_EVENTS_DELIVERY_STREAM || '';
  return {
    archive: (lines) => {
      if (!stream) throw new Error('MEETING_EVENTS_DELIVERY_STREAM is not configured');
      return putArchiveLines(stream, lines);
    },
    projection: hasDataPlane() ? ingestMeetingEvents : null,
    handOn: handToTheEventsFunction,
  };
}

/**
 * File meeting events: the archive, then the projection. Throws when the archive did not take every one.
 *
 * A projection that fails throws too, for a caller that retries (the service's lifecycle, through EventBridge). A caller
 * that cannot retry passes `projection: 'best-effort'`: once the archive, the system of record, holds the events they
 * are filed, and a projection that failed is HANDED ON (`handOn`) to the meeting-events function, whose asynchronous
 * invoke projects them, retries a failure and keeps one that keeps failing in its dead-letter queue to replay. Answered
 * `projectionFailed` only where it could not be handed on either, which is logged as an error.
 */
export async function fileMeetingEvents(
  records: MeetingEventRecord[],
  given?: MeetingEventSinks,
  opts: { projection?: 'required' | 'best-effort' } = {},
): Promise<{ archived: number; projected: number | null; duplicates: number; projectionFailed?: boolean; projectionHandedOn?: boolean }> {
  if (records.length === 0) return { archived: 0, projected: null, duplicates: 0 };
  const sinks = given ?? await deploymentSinks();
  const { delivered } = await sinks.archive(records.map(archiveLine));
  if (delivered !== records.length) throw new Error(`meeting-event-archive: ${records.length - delivered} of ${records.length} events were not archived`);
  if (!sinks.projection) return { archived: delivered, projected: null, duplicates: 0 };
  try {
    const { inserted, duplicates } = await sinks.projection(records);
    return { archived: delivered, projected: inserted, duplicates };
  } catch (err) {
    if (opts.projection !== 'best-effort') throw err;
    const handed = sinks.handOn ? await sinks.handOn(records).catch(() => false) : false;
    if (handed) {
      console.warn('[meeting-event-archive] archived; the projection failed and is handed on to be retried', { events: records.length, err: (err as Error)?.name });
      return { archived: delivered, projected: null, duplicates: 0, projectionHandedOn: true };
    }
    console.error('[meeting-event-archive] archived, but the projection failed and could not be handed on', {
      events: records.length, err: (err as Error)?.name,
    });
    return { archived: delivered, projected: null, duplicates: 0, projectionFailed: true };
  }
}

/** The payload the meeting-events function projects (`meeting-events.ts`): records a best-effort writer could not project. */
export const PROJECT_MEETING_EVENTS = 'aeProjectMeetingEvents';

let lambdaClient: Pick<LambdaClient, 'send'> | undefined;
/** Hand records to the meeting-events function (`MEETING_EVENTS_FUNCTION`) to project; true once the invoke was accepted. */
async function handToTheEventsFunction(records: MeetingEventRecord[]): Promise<boolean> {
  const fn = process.env.MEETING_EVENTS_FUNCTION || '';
  if (!fn) return false;
  lambdaClient ??= new LambdaClient({ requestHandler: BOUNDED_REQUEST_HANDLER });
  await lambdaClient.send(new InvokeCommand({
    FunctionName: fn, InvocationType: InvocationType.Event,
    Payload: Buffer.from(JSON.stringify({ [PROJECT_MEETING_EVENTS]: records })),
  }));
  return true;
}
