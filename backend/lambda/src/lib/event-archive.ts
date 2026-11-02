/**
 * THE EVENT ARCHIVE: where a client event, and an event the platform records about itself, is kept.
 *
 * One delivery for both. In Aurora mode the record goes to the `client_events` table through the data
 * plane (the `ingestClientEvents` op); otherwise it goes to the client-events Firehose, which lands it in
 * the conversation archive bucket under `client_events/event_type=<type>/`. The client-events handler
 * (`client-events.ts`) delivers what a browser sent; `appendServerEvent` delivers what the platform
 * itself records, such as one completed offboarding (`lib/offboarding.ts`), under a type the client
 * allow-list does not accept (`SERVER_EVENT_TYPES`).
 *
 * The data plane's ARN is read from SSM on first use (`AURORA_DATA_PLANE_ARN_PARAM`), because the stack
 * that publishes it deploys after every stack that writes here. Absent means Athena mode.
 */
import { FirehoseClient, PutRecordBatchCommand, type _Record } from '@aws-sdk/client-firehose';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { erasePersonProjection, hasDataPlane, ingestClientEvents } from './data-plane-client.js';
import type { ServerEventType } from './client-event-types.js';

/** One archived record, in the shape both stores read. */
export interface ArchiveRecord {
  record_type: 'event' | 'performance';
  event_type: string;
  /** The person the record is about or by, as their AppInstanceUser id. Never an address. */
  person_id: string;
  user_tier: string;
  session_id: string | null;
  timestamp: string;
  properties: Record<string, string | number | boolean> | null;
  perf_value: number | null;
}

/** Firehose's per-record cap is 1 MiB; anything near this is junk rather than an event. */
export const MAX_RECORD_BYTES = 100 * 1024;

const firehose = new FirehoseClient({});
const ssm = new SSMClient({});

let dataPlaneResolved = false;
/** Resolve the Aurora data plane's ARN from its SSM parameter, once; absent in Athena mode. */
export async function ensureDataPlaneArn(): Promise<void> {
  if (dataPlaneResolved || process.env.AURORA_DATA_PLANE_ARN) { dataPlaneResolved = true; return; }
  const paramName = process.env.AURORA_DATA_PLANE_ARN_PARAM;
  if (!paramName) { dataPlaneResolved = true; return; }
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: paramName }));
    if (r.Parameter?.Value) process.env.AURORA_DATA_PLANE_ARN = r.Parameter.Value;
  } catch { /* absent (Athena mode) -> Firehose */ }
  dataPlaneResolved = true;
}

async function deliverToFirehose(
  records: { partitionKey: string; payload: ArchiveRecord }[],
): Promise<{ delivered: number; dropped: number }> {
  if (records.length === 0) return { delivered: 0, dropped: 0 };
  const stream = process.env.CLIENT_EVENTS_DELIVERY_STREAM || '';
  if (!stream) throw new Error('CLIENT_EVENTS_DELIVERY_STREAM not configured');

  // Each record becomes one S3 line. The wrapper carries the partition key, so the Firehose
  // MetadataExtraction processor routes it to its prefix (event_type=... for events, performance).
  let dropped = 0;
  const safe: _Record[] = [];
  for (const { partitionKey, payload } of records) {
    const data = new TextEncoder().encode(JSON.stringify({ partitionKey, ...payload }) + '\n');
    if (data.byteLength > MAX_RECORD_BYTES) dropped++;
    else safe.push({ Data: data });
  }

  // PutRecordBatch caps at 500 records / 4 MiB.
  let delivered = 0;
  for (let i = 0; i < safe.length; i += 500) {
    const chunk = safe.slice(i, i + 500);
    const result = await firehose.send(new PutRecordBatchCommand({ DeliveryStreamName: stream, Records: chunk }));
    delivered += chunk.length - (result.FailedPutCount || 0);
    dropped += result.FailedPutCount || 0;
  }
  return { delivered, dropped };
}

/** Deliver records to the archive this deployment keeps. Throws when the store refuses the batch. */
export async function deliverToArchive(
  records: { partitionKey: string; payload: ArchiveRecord }[],
): Promise<{ delivered: number; dropped: number }> {
  await ensureDataPlaneArn();
  if (hasDataPlane()) {
    if (records.length === 0) return { delivered: 0, dropped: 0 };
    const { inserted } = await ingestClientEvents(records.map((r) => r.payload));
    return { delivered: inserted, dropped: 0 };
  }
  return deliverToFirehose(records);
}

/**
 * Append one event the platform records about itself. THROWS when it was not delivered, so the caller
 * decides what an unrecorded event means.
 */
export async function appendServerEvent(input: {
  eventType: ServerEventType;
  personId: string;
  properties: Record<string, string | number | boolean>;
  now?: Date;
}): Promise<void> {
  const payload: ArchiveRecord = {
    record_type: 'event',
    event_type: input.eventType,
    person_id: input.personId,
    user_tier: 'platform',
    session_id: null,
    timestamp: (input.now ?? new Date()).toISOString(),
    properties: input.properties,
    perf_value: null,
  };
  const { delivered } = await deliverToArchive([{ partitionKey: input.eventType, payload }]);
  if (delivered !== 1) throw new Error(`event-archive: the ${input.eventType} event was not delivered`);
}

/**
 * OFFBOARDING'S ERASURE OF A PERSON'S OWN ROWS IN THE AURORA PROJECTION (`erasePerson` on the data plane,
 * `analytics-aurora/person-erasure.ts`), beside the write path that fills it. Null where the deployment keeps
 * no projection (Athena mode, no data plane): there is nothing there to erase. Throws when the erasure failed.
 */
export async function eraseFromProjection(personId: string): Promise<number | null> {
  await ensureDataPlaneArn();
  if (!hasDataPlane()) return null;
  return (await erasePersonProjection(personId)).removed;
}

/** For tests: forget the resolved data plane. */
export function __resetEventArchiveForTests(): void {
  dataPlaneResolved = false;
}
