/**
 * Client Events Lambda
 *
 * Receives batched client-side events from the frontend
 * `eventTrackingService.ts` and forwards them to Kinesis Firehose for
 * delivery to S3 (Athena-queryable). One Firehose record per accepted
 * event. Cognito-authed via API Gateway; the user identity is stamped
 * from the authorizer claims so the payload cannot impersonate.
 *
 * Request shape (matches eventTrackingService.sendPayload):
 *   {
 *     events?: Array<{ name, properties, timestamp, sessionId }>,
 *     performance?: Array<{ metric, value, timestamp, sessionId }>
 *   }
 *
 * Response:
 *   200 { recorded: N, skipped: M, performance: P }
 *   400 { error }
 *   500 { error }   // generic message; details in CloudWatch
 *
 * Design notes:
 *   - Accepts a batched payload and puts to Firehose so it works in Athena mode (the default).
 *   - Events all originate post-auth, so this Lambda hard-requires Cognito claims
 *     (`event.requestContext.authorizer.claims`) and pulls userId / tier from there.
 *   - Allow-list is the relevant event slice.
 */

import {
  FirehoseClient,
  PutRecordBatchCommand,
  type _Record,
} from '@aws-sdk/client-firehose';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { VALID_EVENT_TYPES as VALID_EVENT_TYPE_LIST } from './lib/client-event-types.js';
// Aurora-mode delivery: in Aurora mode there is no client-events Firehose, so
// write straight to Aurora `client_events` via the VPC data-plane Lambda (#A).
import { hasDataPlane, ingestClientEvents } from './lib/data-plane-client.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const firehose = new FirehoseClient({});
const ssm = new SSMClient({});

const DELIVERY_STREAM = process.env.CLIENT_EVENTS_DELIVERY_STREAM || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

// Resolve the Aurora data-plane ARN once (cold start) from SSM — same decoupling
// as admin-conversations (a direct CDK prop would be circular). When present we
// deliver to Aurora; otherwise fall back to the Firehose (Athena mode).
let dataPlaneResolved = false;
async function ensureDataPlaneArn(): Promise<void> {
  if (dataPlaneResolved || process.env.AURORA_DATA_PLANE_ARN) { dataPlaneResolved = true; return; }
  const paramName = process.env.AURORA_DATA_PLANE_ARN_PARAM;
  if (!paramName) { dataPlaneResolved = true; return; }
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: paramName }));
    if (r.Parameter?.Value) process.env.AURORA_DATA_PLANE_ARN = r.Parameter.Value;
  } catch { /* absent (Athena mode) → Firehose path */ }
  dataPlaneResolved = true;
}

// Allow-list mirrors EventName in frontend/src/services/eventTrackingService.ts
// and the Glue projection enum in analytics-stack.ts (single source of truth
// in lib/client-event-types.ts — audit M7). Anything outside is rejected per
// event so the event_type Glue partition key cannot be polluted by typos
// or a hostile client.
const VALID_EVENT_TYPES = new Set<string>(VALID_EVENT_TYPE_LIST);

// Performance metric names are not allow-listed (web_vital_*, arbitrary timer
// labels). They land in a separate `client_perf` prefix and the metric column
// is stored as a free-form string.

// Per-batch caps. Firehose PutRecordBatch is hard-capped at 500 records and
// 4 MiB; we keep well below to leave room for the wrapper.
const MAX_EVENTS_PER_REQUEST = 200;
const MAX_PERF_PER_REQUEST = 200;
const MAX_RECORD_BYTES = 100 * 1024; // 100 KiB per record (well under Firehose's 1 MiB limit)

interface IncomingEvent {
  name?: unknown;
  properties?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
}

// session_id is body-supplied; a hostile client could stitch their events onto
// a victim's session by submitting
// the victim's session_id, polluting funnel + DAU analytics. The frontend
// generates session ids as `<unixMs>-<base36>` (see eventTrackingService);
// allow a tighter shape so a UUID, a Cognito sub, or arbitrary text can't
// pretend to be a session id.
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
function safeSessionId(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  return SESSION_ID_RE.test(s) ? s : null;
}

interface IncomingPerf {
  metric?: unknown;
  value?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
}

function corsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };
}

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

function isIsoTimestamp(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && s.length >= 10;
}

function partitionDateParts(iso: string): { year: string; month: string; day: string } {
  const d = new Date(iso);
  return {
    year: String(d.getUTCFullYear()),
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
    day: String(d.getUTCDate()).padStart(2, '0'),
  };
}

interface AuthorizedClaims {
  userId: string;
  email: string | null;
  tier: string;
}

function extractClaims(event: APIGatewayProxyEvent): AuthorizedClaims | null {
  const claims = event.requestContext?.authorizer?.claims as Record<string, string> | undefined;
  if (!claims) return null;
  const userId = claims.sub || claims['cognito:username'];
  if (!userId) return null;
  // Group claim shape varies: 'cognito:groups' is a comma-separated string in
  // the JWT or a JSON array when the authorizer rehydrates it. Pick the most
  // privileged tier the user holds; default to unknown.
  const rawGroups = claims['cognito:groups'];
  let groups: string[] = [];
  if (Array.isArray(rawGroups)) {
    groups = rawGroups as unknown as string[];
  } else if (typeof rawGroups === 'string') {
    groups = rawGroups.split(',').map((g) => g.trim()).filter(Boolean);
  }
  const tierOrder = ['admins', 'premium', 'standard', 'basic'];
  const tier = tierOrder.find((t) => groups.includes(t)) || 'unknown';
  return { userId, email: claims.email ?? null, tier };
}

interface NormalizedEvent {
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

interface NormalizeResult {
  records: { partitionKey: string; payload: NormalizedEvent }[];
  rejected: number;
}

function normalize(
  body: { events?: unknown; performance?: unknown },
  claims: AuthorizedClaims,
): NormalizeResult {
  const records: { partitionKey: string; payload: NormalizedEvent }[] = [];
  let rejected = 0;

  const rawEvents = Array.isArray(body.events)
    ? (body.events as IncomingEvent[]).slice(0, MAX_EVENTS_PER_REQUEST)
    : [];
  for (const e of rawEvents) {
    if (typeof e?.name !== 'string' || !VALID_EVENT_TYPES.has(e.name)) {
      rejected++;
      continue;
    }
    const ts = isIsoTimestamp(e.timestamp) ? e.timestamp : new Date().toISOString();
    const props =
      e.properties && typeof e.properties === 'object' && !Array.isArray(e.properties)
        ? (e.properties as Record<string, string | number | boolean>)
        : null;
    records.push({
      partitionKey: e.name,
      payload: {
        record_type: 'event',
        event_type: e.name,
        user_id: claims.userId,
        user_email: claims.email,
        user_tier: claims.tier,
        session_id: safeSessionId(e.sessionId),
        timestamp: ts,
        properties: props,
        perf_value: null,
      },
    });
  }

  const rawPerf = Array.isArray(body.performance)
    ? (body.performance as IncomingPerf[]).slice(0, MAX_PERF_PER_REQUEST)
    : [];
  for (const p of rawPerf) {
    if (typeof p?.metric !== 'string' || !p.metric) {
      rejected++;
      continue;
    }
    if (typeof p?.value !== 'number' || !Number.isFinite(p.value)) {
      rejected++;
      continue;
    }
    const ts = isIsoTimestamp(p.timestamp) ? p.timestamp : new Date().toISOString();
    records.push({
      partitionKey: 'performance',
      payload: {
        record_type: 'performance',
        event_type: p.metric,
        user_id: claims.userId,
        user_email: claims.email,
        user_tier: claims.tier,
        session_id: safeSessionId(p.sessionId),
        timestamp: ts,
        properties: null,
        perf_value: p.value,
      },
    });
  }

  return { records, rejected };
}

async function deliverToFirehose(
  records: { partitionKey: string; payload: NormalizedEvent }[],
): Promise<{ delivered: number; dropped: number }> {
  if (records.length === 0) return { delivered: 0, dropped: 0 };
  if (!DELIVERY_STREAM) throw new Error('CLIENT_EVENTS_DELIVERY_STREAM not configured');

  // Build Firehose records. Each becomes one S3 line. The wrapper carries
  // the partition key so the Firehose MetadataExtraction processor can route
  // it to the right S3 prefix (event_type=… for events, performance for perf).
  const firehoseRecords: _Record[] = records.map(({ partitionKey, payload }) => {
    const wire = JSON.stringify({ partitionKey, ...payload }) + '\n';
    return { Data: new TextEncoder().encode(wire) };
  });

  // Drop oversized records defensively (Firehose's per-record cap is 1 MiB
  // but anything over MAX_RECORD_BYTES is almost certainly junk).
  let dropped = 0;
  const safe = firehoseRecords.filter((r) => {
    const size = r.Data?.byteLength || 0;
    if (size > MAX_RECORD_BYTES) {
      dropped++;
      return false;
    }
    return true;
  });
  if (safe.length === 0) return { delivered: 0, dropped };

  // PutRecordBatch caps at 500 records / 4 MiB. We already limited inputs;
  // chunking guard is here for forward-compat if caps are raised.
  let delivered = 0;
  for (let i = 0; i < safe.length; i += 500) {
    const chunk = safe.slice(i, i + 500);
    const result = await firehose.send(
      new PutRecordBatchCommand({ DeliveryStreamName: DELIVERY_STREAM, Records: chunk }),
    );
    delivered += chunk.length - (result.FailedPutCount || 0);
    dropped += result.FailedPutCount || 0;
  }

  return { delivered, dropped };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('[ClientEvents]', event.httpMethod, event.path);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  try {
    const claims = extractClaims(event);
    if (!claims) {
      // Should not happen — API Gateway Cognito authorizer blocks unauth'd
      // requests upstream. Guard exists for defense in depth + local testing.
      return respond(401, { error: 'Unauthorized' });
    }

    let body: { events?: unknown; performance?: unknown };
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON body' });
    }

    const { records, rejected } = normalize(body, claims);
    const eventCount = records.filter((r) => r.payload.record_type === 'event').length;
    const perfCount = records.filter((r) => r.payload.record_type === 'performance').length;

    // Aurora mode → write to Aurora `client_events` via the data-plane; else Firehose.
    await ensureDataPlaneArn();
    let delivered = 0;
    let dropped = 0;
    if (hasDataPlane()) {
      const { inserted } = await ingestClientEvents(records.map((r) => r.payload));
      delivered = inserted;
    } else {
      ({ delivered, dropped } = await deliverToFirehose(records));
    }

    return respond(200, {
      recorded: eventCount,
      performance: perfCount,
      delivered,
      dropped,
      skipped: rejected,
    });
  } catch (err) {
    console.error('[ClientEvents] Error:', err);
    return respond(500, { error: 'Failed to record client events' });
  }
};

// Exported for unit tests only.
export const __testing = {
  VALID_EVENT_TYPES,
  MAX_EVENTS_PER_REQUEST,
  MAX_PERF_PER_REQUEST,
  MAX_RECORD_BYTES,
  extractClaims,
  normalize,
  partitionDateParts,
  isIsoTimestamp,
};
