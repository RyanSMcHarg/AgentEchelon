/**
 * Client Events Lambda
 *
 * Receives batched client-side events from the frontend
 * `eventTrackingService.ts` and forwards them to Kinesis Firehose for
 * delivery to S3 (Athena-queryable). One Firehose record per accepted
 * event. Cognito-authed via API Gateway; the person is stamped from
 * the one resolver (`callerPersonId`) so the payload cannot impersonate.
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
 *   - Events all originate post-auth, so this Lambda hard-requires a resolved person: the person comes
 *     from `callerPersonId` (the one resolver), never from the authorizer claims, and the clearance from
 *     the verified token's groups.
 *   - Allow-list is the relevant event slice.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  VALID_EVENT_TYPES as VALID_EVENT_TYPE_LIST,
  VALID_PERF_METRICS as VALID_PERF_METRIC_LIST,
  PERF_METRIC_PROPERTIES,
  PERF_VALUE_MAX,
  type ClientPerfMetric,
} from './lib/client-event-types.js';
import { callerHolderToken, callerPersonId } from './lib/auth.js';
// Delivery: Aurora `client_events` through the data plane in Aurora mode, else the Firehose (lib/event-archive.ts).
import { deliverToArchive, MAX_RECORD_BYTES, type ArchiveRecord } from './lib/event-archive.js';
import { responder } from './lib/http-response.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

// Allow-list mirrors EventName in frontend/src/services/eventTrackingService.ts
// and the Glue projection enum in archive-stack.ts (single source of truth
// in lib/client-event-types.ts — audit M7). Anything outside is rejected per
// event so the event_type Glue partition key cannot be polluted by typos
// or a hostile client.
const VALID_EVENT_TYPES = new Set<string>(VALID_EVENT_TYPE_LIST);

// Performance metric names ARE allow-listed, from the same module. A timing's
// name becomes its row's event_type and the page-load panel's GROUP BY key, and
// `client_ttff_ms` is joined to the server's TTFF for the same turn - so a free
// -form name let any signed-in client mint rows under any name, or post TTFF
// rows of its choosing. Each metric also declares the properties it may carry
// (PERF_METRIC_PROPERTIES); anything else is dropped and counted.
const VALID_PERF_METRICS = new Set<string>(VALID_PERF_METRIC_LIST);

/**
 * Why a record was rejected or a property dropped. Counted per request and logged, so a client that
 * sends the wrong thing is visible as a reason rather than as a quietly smaller number.
 */
type RejectReason =
  | 'unknown_event_type'
  | 'unknown_perf_metric'
  | 'perf_value_not_finite'
  | 'perf_value_out_of_range'
  | 'perf_property_dropped';

// Per-batch caps. Firehose PutRecordBatch is hard-capped at 500 records and
// 4 MiB; we keep well below to leave room for the wrapper.
const MAX_EVENTS_PER_REQUEST = 200;
const MAX_PERF_PER_REQUEST = 200;

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
  /** Correlating context, e.g. the turn a client-side timing belongs to (G5). Same shape and same
   *  sanitising as an event's properties - a timing is not a different kind of untrusted input. */
  properties?: unknown;
}

const http = responder({ origin: { fixed: ALLOWED_ORIGIN }, methods: 'POST,OPTIONS' });

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return http.respond(statusCode, body);
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

interface CallerFacts {
  personId: string;
  clearance: string;
}

/**
 * THE CLEARANCE IS THE REGISTRY'S HOLDER TOKEN, and the group parsing is the shared one.
 *
 * This carried its own `['admins', 'premium', 'standard', 'basic']` and took the first entry the
 * caller's groups contained, a second copy of the list `lib/auth.ts` held. Both are gone: a
 * classification is a declared set of grants rather than a level (ADR-046), so the question is which
 * declared classification means exactly what this person holds, which is `resolveHolderToken`.
 *
 * THE PERSON AND THE CLASSIFICATION COME FROM THE EDGE AUTHORIZER'S CONTEXT (`callerHolderToken`), through
 * the caller's issuer's clearance source and the classifications it may grant, so an event from any issuer's person is keyed
 * by their AppInstanceUser and stamped with what their issuer clears them for.
 *
 * `unknown` survives as the recorded value for a person no declared classification covers, because it
 * is a persisted analytics dimension that existing rows and queries already use; it is written where
 * the resolver answers nothing, not chosen as a classification.
 */
async function callerFacts(event: APIGatewayProxyEvent): Promise<CallerFacts | null> {
  const personId = await callerPersonId(event);
  if (!personId) return null;
  return {
    personId,
    clearance: callerHolderToken(event) || 'unknown',
  };
}

type NormalizedEvent = ArchiveRecord;

interface NormalizeResult {
  records: { partitionKey: string; payload: NormalizedEvent }[];
  /** Records refused outright. A dropped property does not count here: its timing was kept. */
  rejected: number;
  /** Every refusal and every dropped property, by reason. */
  reasons: Partial<Record<RejectReason, number>>;
}

/**
 * The declared properties of one timing, and only those.
 *
 * A key the metric does not declare, or a value that fails its rule, is dropped and counted; the timing
 * itself is kept, because a real measurement with a malformed tag is still a real measurement. Returns
 * null when nothing survives, so a record never carries an empty object that reads as "correlated".
 */
function sanitizePerfProperties(
  metric: ClientPerfMetric,
  raw: unknown,
  count: (reason: RejectReason) => void,
): Record<string, string> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    count('perf_property_dropped');
    return null;
  }
  const rules = PERF_METRIC_PROPERTIES[metric];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rule = Object.prototype.hasOwnProperty.call(rules, key) ? rules[key] : undefined;
    if (!rule || typeof value !== rule.type || !rule.pattern.test(value as string)) {
      count('perf_property_dropped');
      continue;
    }
    out[key] = value as string;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalize(
  body: { events?: unknown; performance?: unknown },
  caller: CallerFacts,
): NormalizeResult {
  const records: { partitionKey: string; payload: NormalizedEvent }[] = [];
  let rejected = 0;
  const reasons: NormalizeResult['reasons'] = {};
  const count = (reason: RejectReason) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const reject = (reason: RejectReason) => { rejected++; count(reason); };

  const rawEvents = Array.isArray(body.events)
    ? (body.events as IncomingEvent[]).slice(0, MAX_EVENTS_PER_REQUEST)
    : [];
  for (const e of rawEvents) {
    if (typeof e?.name !== 'string' || !VALID_EVENT_TYPES.has(e.name)) {
      reject('unknown_event_type');
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
        person_id: caller.personId,
        user_tier: caller.clearance,
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
    if (typeof p?.metric !== 'string' || !VALID_PERF_METRICS.has(p.metric)) {
      reject('unknown_perf_metric');
      continue;
    }
    const metric = p.metric as ClientPerfMetric;
    if (typeof p?.value !== 'number' || !Number.isFinite(p.value)) {
      reject('perf_value_not_finite');
      continue;
    }
    // BOUNDED, because one absurd value moves every average it lands in and no real wait is negative.
    if (p.value < 0 || p.value > PERF_VALUE_MAX) {
      reject('perf_value_out_of_range');
      continue;
    }
    const ts = isIsoTimestamp(p.timestamp) ? p.timestamp : new Date().toISOString();
    // A timing can carry the turn it belongs to (G5), which is what lets a browser-measured wait be
    // joined to the server's own numbers for the SAME turn rather than only compared in aggregate.
    // Only the properties its metric DECLARES, each matching its rule: this is client-supplied, and
    // the join trusts `correlationId` enough to pair it with a server row.
    const perfProps = sanitizePerfProperties(metric, p.properties, count);
    records.push({
      partitionKey: 'performance',
      payload: {
        record_type: 'performance',
        event_type: metric,
        person_id: caller.personId,
        user_tier: caller.clearance,
        session_id: safeSessionId(p.sessionId),
        timestamp: ts,
        properties: perfProps,
        perf_value: p.value,
      },
    });
  }

  return { records, rejected, reasons };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  console.log('[ClientEvents]', event.httpMethod, event.path);

  if (event.httpMethod === 'OPTIONS') {
    return http.empty(200);
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  try {
    const caller = await callerFacts(event);
    if (!caller) {
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

    const { records, rejected, reasons } = normalize(body, caller);
    // NAMED BY REASON, and never by content: what was refused is client-supplied and is not echoed.
    if (Object.keys(reasons).length > 0) {
      console.warn('[ClientEvents] refused or trimmed client input', { personId: caller.personId, reasons });
    }
    const eventCount = records.filter((r) => r.payload.record_type === 'event').length;
    const perfCount = records.filter((r) => r.payload.record_type === 'performance').length;

    const { delivered, dropped } = await deliverToArchive(records);

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
  VALID_PERF_METRICS,
  MAX_EVENTS_PER_REQUEST,
  MAX_PERF_PER_REQUEST,
  MAX_RECORD_BYTES,
  callerFacts,
  normalize,
  partitionDateParts,
  isIsoTimestamp,
};
