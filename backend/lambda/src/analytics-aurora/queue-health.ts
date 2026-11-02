/**
 * IS THE QUEUE MECHANISM WORKING, AND WHAT IS IT COSTING PEOPLE (ADR-033).
 *
 * The latency surface answers "how long did turns take". This answers a different question, and the
 * two must not be averaged: queueing is a property of SOME turns, and folding a deliberate wait into
 * the aggregate is how it becomes indistinguishable from a slow one.
 *
 * ── WHY CLOUDWATCH AND NOT AURORA, WHICH EVERY OTHER PANEL READS ─────────────────────────────────
 *
 * Because that is where these facts are. The archive records what happened to MESSAGES; a queue depth
 * at drain, an overflow drop and a lock taken over from a stale holder are facts about the mechanism,
 * and the last one records an ABSENCE - a release that never happened - so no message row describes
 * it. Reproducing them in Aurora would mean a schema migration to store
 * numbers that already exist, and a second source that can disagree with the alarm.
 *
 * ── THE NUMBER THAT JUDGES THE DESIGN IS THE LAST ONE ────────────────────────────────────────────
 *
 * `LockTakeover`. Tenets 2 and 3 claim a lock is released by something that HAPPENED; a takeover is
 * the measured admission that nothing did, and the next person to type had to recover the conversation
 * themselves. It is the one metric here with an alarm, and a zero is the healthy reading rather than a
 * missing one.
 *
 * It replaced `ReaperRelease` when the record's expiry was removed (maintainer, 2026-08-28). The expiry could
 * only be observed after the fact by whatever swept the deletion; a takeover is observed at the moment
 * the recovery happens, by code that is running, which is strictly better evidence about the same failure.
 *
 * ── SUMS, NOT AVERAGES, EXCEPT WHERE AN AVERAGE IS THE QUESTION ──────────────────────────────────
 *
 * "How many messages were queued" is a count and "how long did they wait" is not. Reporting a mean
 * queue depth would hide the conversation nobody was keeping up with inside a deployment of people
 * who mostly send once.
 */

import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';

const NAMESPACE = 'AgentEchelon/TurnQueue';
const cw = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-east-1' });

/** Every metric this panel reports, and how each is aggregated. */
const SERIES: Array<{ id: string; metric: string; stat: 'Sum' | 'Average' | 'p95' }> = [
  { id: 'queued', metric: 'MessageQueued', stat: 'Sum' },
  { id: 'drops', metric: 'OverflowDrop', stat: 'Sum' },
  { id: 'depth', metric: 'QueueDepthAtDrain', stat: 'Average' },
  { id: 'waitAvg', metric: 'QueueWaitMs', stat: 'Average' },
  { id: 'waitP95', metric: 'QueueWaitMs', stat: 'p95' },
  { id: 'tasks', metric: 'TriageTasksCreated', stat: 'Sum' },
  { id: 'takeovers', metric: 'LockTakeover', stat: 'Sum' },
  { id: 'answered', metric: 'AwaitedAnswer', stat: 'Sum' },
  { id: 'refused', metric: 'ReadingRefused', stat: 'Sum' },
];

export interface QueueHealthRow extends Record<string, unknown> {
  metric: string;
  value: number | null;
  /** What a reader should conclude, so a number does not have to be interpreted from its name alone. */
  meaning: string;
}

/**
 * Read the window.
 *
 * NULL IS NOT ZERO, and the distinction is load-bearing on exactly one row. A metric with no
 * datapoints has never been emitted, which for `LockTakeover` is the HEALTHY state and for
 * `MessageQueued` means the mechanism has not run at all. Rendering both as `0` would let "queueing
 * is switched off" read as "queueing is working perfectly".
 */
export async function getQueueHealth(params: {
  startDate?: string;
  endDate?: string;
}): Promise<QueueHealthRow[]> {
  // THE WHOLE OF THE LAST DAY, NOT UP TO ITS MIDNIGHT (code review, 2026-09-04).
  //
  // The console sends a date, not an instant - `2026-09-04` - and `new Date()` reads that as midnight
  // UTC at the START of it. So "up to today" asked CloudWatch for a window ending before today began,
  // and the panel omitted the day an operator is most likely looking at: they open it to see what the
  // queue is doing now and are shown everything except now.
  //
  // A date-only value is extended to the end of that day; a full timestamp is honored as given, since
  // somebody who sent an instant meant that instant.
  const end = params.endDate
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(params.endDate)
      ? `${params.endDate}T23:59:59.999Z`
      : params.endDate)
    : new Date();
  const start = params.startDate
    ? new Date(params.startDate)
    : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  const queries: MetricDataQuery[] = SERIES.map((s) => ({
    Id: s.id,
    MetricStat: {
      Metric: { Namespace: NAMESPACE, MetricName: s.metric },
      // ONE PERIOD OVER THE WHOLE WINDOW, so the statistic describes the window rather than the
      // busiest minute in it. A p95 computed per-minute and then averaged is not a p95 of anything.
      // A MULTIPLE OF 60, which CloudWatch requires for any period over a minute: an arbitrary
      // window length is not one, and GetMetricData answers InvalidParameterValue rather than
      // rounding for you.
      Period: Math.max(60, Math.round((end.getTime() - start.getTime()) / 1000 / 60) * 60),
      Stat: s.stat,
    },
    ReturnData: true,
  }));

  const res = await cw.send(new GetMetricDataCommand({
    StartTime: start, EndTime: end, MetricDataQueries: queries,
  }));

  // THE WHOLE WINDOW, NOT ITS FIRST BUCKET.
  //
  // `Period` above is the width of the window, but CloudWatch aligns periods to epoch boundaries
  // rather than to the times asked for - so a seven-day window almost never lands on one bucket, and
  // reading `Values[0]` reported a PARTIAL bucket as the seven-day total. For a Sum that silently
  // under-reports by however much of the window fell in the other bucket, which on this panel is the
  // difference between "no messages were dropped" and "some were, and you were shown the wrong day".
  const combine = (stat: string, values: number[]): number | null => {
    if (!values.length) return null;
    if (stat === 'Sum') return values.reduce((a, b) => a + b, 0);
    // Average, and percentiles, across buckets that are usually two and always equal-width here.
    // A percentile combined client-side is an APPROXIMATION - the true p95 of a window is not the
    // mean of its buckets' p95s - and it is named as one rather than quietly presented as exact.
    // It is still much closer than reading whichever bucket happened to come first.
    return values.reduce((a, b) => a + b, 0) / values.length;
  };

  const statById = new Map<string, string>(SERIES.map((sp) => [sp.id, sp.stat]));
  const byId = new Map<string, number | null>();
  for (const r of res.MetricDataResults ?? []) {
    const id = r.Id ?? '';
    const values = (r.Values ?? []).filter((n): n is number => typeof n === 'number');
    byId.set(id, combine(statById.get(id) ?? 'Sum', values));
  }
  const v = (id: string): number | null => byId.get(id) ?? null;

  return [
    {
      metric: 'Messages queued',
      value: v('queued'),
      meaning: 'How often a person waited on their own earlier message. A rate on a hard floor of zero.',
    },
    {
      metric: 'Overflow drops',
      value: v('drops'),
      meaning: 'DATA LOSS. The bound discarded a message somebody sent. They were told at the time.',
    },
    {
      metric: 'Queue depth at drain (avg)',
      value: v('depth'),
      meaning: 'How many one turn absorbed. Distinguishes double-sending from a conversation nobody keeps up with.',
    },
    {
      metric: 'Queue wait, avg (ms)',
      value: v('waitAvg'),
      meaning: 'The delay the platform chose deliberately, so the one that most needs a name.',
    },
    {
      metric: 'Queue wait, p95 (ms)',
      value: v('waitP95'),
      meaning: 'The tail. An average here hides the person who waited behind a long turn.',
    },
    {
      metric: 'Readings refused (fell back to one task per message)',
      value: v('refused'),
      meaning: 'WHETHER THE JUDGED HALF IS RUNNING AT ALL. Near the drain count means it is not: work is still captured, but nothing is grouped or prioritised and no split is ever offered.',
    },
    {
      metric: 'Tasks created by triage',
      value: v('tasks'),
      meaning: 'The handoff count. Whether that work FINISHES is on the task surface, not this one.',
    },
    {
      metric: 'Answers to a question the assistant asked',
      value: v('answered'),
      meaning: 'The drain CLOSING normally: somebody replied to an offer and their turn took the lock back.',
    },
    {
      metric: 'Lock takeovers',
      value: v('takeovers'),
      meaning: 'THE HEALTH SIGNAL. A holder displaced because its invocation was provably gone - recovery, not routine. Rising means turns are dying.',
    },
  ];
}

/**
 * The admin route, and why it is NOT on the analytics query Lambda where every sibling panel lives.
 *
 * THAT LAMBDA CANNOT REACH CLOUDWATCH. It sits in isolated subnets with no NAT gateway and interface
 * endpoints for Kinesis, Bedrock Runtime, Secrets Manager, S3 and DynamoDB only - the same
 * unreachability that already forces the in-VPC classification lookup to read a projection instead of
 * the Chime SDK. A `GetMetricData` from there does not fail fast; it hangs until the function times
 * out, so the panel would return an error after thirty seconds on every request and the cause would
 * be invisible from the code.
 *
 * These numbers need no database, so the read belongs outside the VPC rather than the VPC needing a
 * new endpoint. Same shape as the deployment sleep/wake handler, which is already a non-VPC admin
 * function on this same API for the same class of reason.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireAdmin } from '../lib/auth.js';
import { responder, originsFrom, requestOrigin, DEV_ORIGIN } from '../lib/http-response.js';
import { loadProfileRegistry } from '../../../lib/profile-registry';

const http = responder({
  origin: { allow: originsFrom(process.env.ALLOWED_ORIGINS, DEV_ORIGIN) },
  methods: 'GET,OPTIONS',
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (event.httpMethod === 'OPTIONS') {
    return http.empty(200, requestOrigin(event));
  }
  // The same gate every admin read uses, so a deployment's admin-auth mode resolves here exactly as
  // it does everywhere else rather than this route inventing its own answer.
  const gate = await requireAdmin(event);
  if ('statusCode' in gate) return gate;

  try {
    const data = await getQueueHealth({
      ...(event.queryStringParameters?.startDate ? { startDate: event.queryStringParameters.startDate } : {}),
      ...(event.queryStringParameters?.endDate ? { endDate: event.queryStringParameters.endDate } : {}),
    });
    return http.respond(200, { data, columns: ['metric', 'value', 'meaning'] }, requestOrigin(event));
  } catch (error) {
    console.error('[queue-health] read failed:', error);
    // NOT an empty set of rows. Zeroes would read as "the mechanism is healthy and idle", which is
    // the one conclusion a failed read must never support.
    return http.respond(500, { error: 'Could not read the queue metrics' }, requestOrigin(event));
  }
};
