/**
 * THE NETWORK OUTAGE A DEMO INCIDENT TELLS, as numbers: what `scripts/demo-network-outage.mjs` publishes each minute,
 * and when it decides the outage is over. No AWS call is made here, so every curve and decision is tested as data.
 *
 * Four metrics, one story, on one dimension set (Region, Service): packet loss climbs, p95 latency spikes, the request
 * success rate falls to near zero, and the healthy hosts behind the load balancer drop out. Recovery ramps each back.
 */

const { GetCommand } = require('@aws-sdk/lib-dynamodb');

const NAMESPACE = 'AgentEchelon/Demo';
const ALARM_NAME = 'AgentEchelon-demo-incident';

/** The alarmed metric first; the others are found beside it by the conversation dashboard (same namespace and dimensions). */
const METRICS = {
  SuccessRate: { unit: 'Percent' },
  LatencyP95: { unit: 'Milliseconds' },
  PacketLoss: { unit: 'Percent' },
  HealthyHosts: { unit: 'Count' },
};
const ALARM_METRIC = 'SuccessRate';

/** The alarm: success rate under this, for 2 of 2 one-minute periods. */
const ALARM_THRESHOLD = 90;
const ALARM_PERIOD_SECONDS = 60;
const ALARM_EVALUATION_PERIODS = 2;

const HOSTS = 12;
const HEALTHY = { SuccessRate: 99.9, LatencyP95: 118, PacketLoss: 0.05, HealthyHosts: HOSTS };

/** The outage's first minutes, then held at the last. Two minutes under the threshold fire the alarm. */
const OUTAGE = [
  { SuccessRate: 61, LatencyP95: 1450, PacketLoss: 22, HealthyHosts: 8 },
  { SuccessRate: 9, LatencyP95: 6200, PacketLoss: 78, HealthyHosts: 2 },
  { SuccessRate: 0.4, LatencyP95: 9800, PacketLoss: 97, HealthyHosts: 0 },
];

/** The recovery's minutes, then healthy. The alarm returns to OK once two minutes in a row are over the threshold. */
const RECOVERY = [
  { SuccessRate: 34, LatencyP95: 2600, PacketLoss: 41, HealthyHosts: 4 },
  { SuccessRate: 81, LatencyP95: 640, PacketLoss: 9, HealthyHosts: 9 },
  { SuccessRate: 97.5, LatencyP95: 210, PacketLoss: 1.2, HealthyHosts: 12 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, digits) => { const f = 10 ** digits; return Math.round(v * f) / f; };

/** Small jitter in proportion to the value, kept inside each metric's real range. */
function jitter(values, rng) {
  const j = (v, spread) => v + (rng() * 2 - 1) * spread;
  return {
    SuccessRate: round(clamp(j(values.SuccessRate, values.SuccessRate > 99 ? 0.08 : Math.min(1.5, Math.max(0.3, values.SuccessRate * 0.04))), 0, 100), 2),
    LatencyP95: Math.round(clamp(j(values.LatencyP95, values.LatencyP95 * 0.06), 1, 60_000)),
    PacketLoss: round(clamp(j(values.PacketLoss, Math.max(0.03, values.PacketLoss * 0.05)), 0, 100), 2),
    HealthyHosts: values.HealthyHosts,
  };
}

/** One minute's values for a phase: `healthy`, `outage` (minute n of it) or `recovery` (minute n of it). */
function valuesFor(phase, minute = 0, rng = Math.random) {
  if (phase === 'outage') return jitter(OUTAGE[Math.min(minute, OUTAGE.length - 1)], rng);
  if (phase === 'recovery' && minute < RECOVERY.length) return jitter(RECOVERY[minute], rng);
  return jitter(HEALTHY, rng);
}

/** The dimensions every metric carries. */
const dimensionsOf = ({ region, service }) => [{ Name: 'Region', Value: region }, { Name: 'Service', Value: service }];

/** One minute as PutMetricData entries: four datapoints, one call. */
function metricData(values, at, dims) {
  return Object.entries(METRICS).map(([name, { unit }]) => ({
    MetricName: name, Dimensions: dims, Timestamp: new Date(at), Value: values[name], Unit: unit, StorageResolution: 60,
  }));
}

/** The minute `t` falls in, as epoch milliseconds. */
const minuteOf = (t) => Math.floor(t / 60_000) * 60_000;

/** Every minute in [from, to] with no datapoint yet, oldest first, so a backfill never doubles a minute already published. */
function missingMinutes(published, from, to) {
  const have = new Set([...published].map((t) => minuteOf(new Date(t).getTime())));
  const out = [];
  for (let m = minuteOf(from); m <= minuteOf(to); m += 60_000) if (!have.has(m)) out.push(m);
  return out;
}

/** PutMetricAlarm's input: the alarm on the success rate, keeping the name (so its ARN) and whatever actions it has. */
function alarmInput(existing, dims) {
  return {
    AlarmName: ALARM_NAME,
    AlarmDescription: 'Demo: request success rate in the region, from the network outage generator (scripts/demo-network-outage.mjs)',
    Namespace: NAMESPACE,
    MetricName: ALARM_METRIC,
    Dimensions: dims,
    Statistic: 'Average',
    Period: ALARM_PERIOD_SECONDS,
    EvaluationPeriods: ALARM_EVALUATION_PERIODS,
    DatapointsToAlarm: ALARM_EVALUATION_PERIODS,
    Threshold: ALARM_THRESHOLD,
    ComparisonOperator: 'LessThanThreshold',
    // A STOPPED GENERATOR CHANGES NOTHING: missing minutes keep the state, so the room is not told of a gap.
    TreatMissingData: 'ignore',
    ActionsEnabled: existing?.ActionsEnabled ?? true,
    AlarmActions: existing?.AlarmActions ?? [],
    OKActions: existing?.OKActions ?? [],
    InsufficientDataActions: existing?.InsufficientDataActions ?? [],
  };
}

/**
 * WHEN THE INCIDENT CALL STARTED, from the platform's own record: the watched room's running meeting, or that of the
 * meeting conversation it opened. Only a meeting started after the outage began counts, so an earlier take's call
 * never ends this one. Null when no such call is running.
 */
function callStartedAt(roomRow, meetingRow, outageStartedAt) {
  for (const row of [roomRow, meetingRow]) {
    const at = Date.parse(row?.activeMeeting?.createdAt ?? '');
    if (Number.isFinite(at) && at >= outageStartedAt) return at;
  }
  return null;
}

/**
 * THE ROWS THE CALL IS READ FROM, read-only and consistent: the alarm's watch record names the incident room, whose row
 * holds its running meeting or names the meeting conversation it opened, whose row holds that one.
 */
async function readCallRows(client, table, alarmName) {
  const get = async (key, projection) => {
    if (!table || !key) return undefined;
    const r = await client.send(new GetCommand({ TableName: table, Key: { channelArn: key }, ConsistentRead: true, ProjectionExpression: projection }));
    return r.Item;
  };
  const watch = await get(`watch#alarm#${alarmName}`, 'room');
  const room = await get(watch?.room, 'activeMeeting, meetingConversation');
  const meeting = await get(room?.meetingConversation?.channelArn, 'activeMeeting');
  return { roomArn: watch?.room, room, meeting };
}

/**
 * WHAT THIS MINUTE IS: the outage holds until the operator asks for recovery, or, with `recoverOnCall`, until the call
 * has run `delayMs`. Recovery, once begun, runs its ramp to healthy.
 */
function nextPhase(state, { now, callAt, recoverRequested, recoverOnCall, delayMs }) {
  if (state.phase !== 'outage') return state.phase;
  if (recoverRequested) return 'recovery';
  if (recoverOnCall && callAt != null && now >= callAt + delayMs) return 'recovery';
  return 'outage';
}

/** One printed line for a minute. */
function line(at, phase, v, note = '') {
  const hhmm = new Date(at).toISOString().slice(11, 16);
  return `${hhmm}Z ${phase.padEnd(8)} success ${String(v.SuccessRate).padStart(5)}%  p95 ${String(v.LatencyP95).padStart(5)} ms  loss ${String(v.PacketLoss).padStart(5)}%  hosts ${String(v.HealthyHosts).padStart(2)}/${HOSTS}${note ? `  ${note}` : ''}`;
}

/** The command line. */
function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const opts = { command, minutes: 30, recoverOnCall: false, delaySeconds: 60, region: 'us-east-1', service: 'customer-api', hours: 3 };
  for (const arg of rest) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'minutes') opts.minutes = Math.max(1, Math.min(240, Number(v) || 30));
    else if (k === 'recover-on-call') opts.recoverOnCall = true;
    else if (k === 'delay') opts.delaySeconds = Math.max(0, Number(v) || 0);
    else if (k === 'region') opts.region = v;
    else if (k === 'service') opts.service = v;
    else if (k === 'hours') opts.hours = Math.max(1, Math.min(24, Number(v) || 3));
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

module.exports = {
  NAMESPACE, ALARM_NAME, ALARM_METRIC, ALARM_THRESHOLD, METRICS, HEALTHY, OUTAGE, RECOVERY, HOSTS,
  valuesFor, dimensionsOf, metricData, minuteOf, missingMinutes, alarmInput, readCallRows, callStartedAt, nextPhase, line, parseArgs,
};
