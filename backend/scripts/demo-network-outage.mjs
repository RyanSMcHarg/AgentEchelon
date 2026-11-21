#!/usr/bin/env node
/**
 * A DEMO NETWORK OUTAGE, AS REAL CLOUDWATCH DATA: the alarm the incident room watches fires from data and recovers from
 * data, and the conversation dashboard graphs the dip and the recovery.
 *
 * Four metrics in `AgentEchelon/Demo`, dimensions Region and Service (default `us-east-1`, `customer-api`):
 *   SuccessRate (%), LatencyP95 (ms), PacketLoss (%), HealthyHosts (count).
 * The alarm `Customer-API-availability` watches SuccessRate < 90 for 2 of 2 one-minute periods. Its name, and so its
 * ARN, stays the same, so the ops-room trigger attached to it keeps working. It has no actions; setup keeps any it has.
 * The dashboard draws the alarm's metric and finds the other three beside it (same namespace and dimensions).
 *
 * Usage (from backend/, with the deployment's AWS profile):
 *   npm run demo:outage -- setup                     the alarm on SuccessRate, and a healthy baseline for the past 3 hours
 *   npm run demo:outage -- outage [--recover-on-call] [--delay=60] [--minutes=30]
 *                                                    the outage, live, one datapoint a minute; the alarm fires in about 2 minutes.
 *                                                    --recover-on-call: recover --delay seconds after the incident room's call
 *                                                    starts, read from the room's record when each minute is published
 *   npm run demo:outage -- recover                   the recovery: tells a running outage to ramp back, or ramps back itself
 *   npm run demo:outage -- status                    the alarm, the last minutes of each metric, and the room's call
 *   npm run demo:outage -- reset                     healthy data until the alarm is OK again
 * Options: --region=<dimension value> --service=<dimension value> --hours=<baseline hours, setup>
 *
 * A foreground loop, stopped with Ctrl+C, bounded by --minutes. Each minute prints one line.
 *
 * COST: 4 custom metrics at $0.30 per metric-month, prorated by the hour they are published (about $1.20 a month if
 * published all month; a demo day costs cents). One PutMetricData call a minute (all four values) at $0.01 per 1,000
 * calls, one DescribeAlarms, and with --recover-on-call up to three DynamoDB reads. The alarm already exists ($0.10 a month).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudWatchClient, DeleteAlarmsCommand, DescribeAlarmsCommand, GetMetricDataCommand, PutMetricAlarmCommand, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const require = createRequire(import.meta.url);
const o = require('./lib/network-outage.cjs');
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
const cw = new CloudWatchClient({ region: REGION });
const RUNNING = path.join(os.tmpdir(), 'ae-demo-network-outage.json');
const RECOVER = path.join(os.tmpdir(), 'ae-demo-network-outage.recover');

let opts;
try { opts = o.parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
const dims = o.dimensionsOf(opts);

async function readAlarm() {
  const r = await cw.send(new DescribeAlarmsCommand({ AlarmNames: [o.ALARM_NAME], AlarmTypes: ['MetricAlarm'] }));
  return r.MetricAlarms?.[0];
}

/** The minutes of the alarm metric already published in the window, so a backfill never doubles one. */
async function publishedMinutes(from, to) {
  const r = await cw.send(new GetMetricDataCommand({
    StartTime: new Date(from), EndTime: new Date(to + 60_000),
    MetricDataQueries: [{ Id: 's', MetricStat: { Metric: { Namespace: o.NAMESPACE, MetricName: o.ALARM_METRIC, Dimensions: dims }, Period: 60, Stat: 'SampleCount' } }],
  }));
  return r.MetricDataResults?.[0]?.Timestamps ?? [];
}

async function put(entries) {
  for (let i = 0; i < entries.length; i += 500) {
    await cw.send(new PutMetricDataCommand({ Namespace: o.NAMESPACE, MetricData: entries.slice(i, i + 500) }));
  }
}

/** A healthy line under every minute of the window not yet published, up to the minute before now. */
async function backfillBaseline(hours) {
  const now = Date.now();
  const from = now - hours * 3_600_000;
  const to = o.minuteOf(now) - 60_000;
  const minutes = o.missingMinutes(await publishedMinutes(from, to), from, to);
  await put(minutes.flatMap((m) => o.metricData(o.valuesFor('healthy'), m, dims)));
  return minutes.length;
}

function loopRunning() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(RUNNING, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

/** The incident room the alarm's watch names, and the table its record lives in. */
let table;
async function contextTable() {
  if (table !== undefined) return table;
  table = process.env.CHANNEL_CONTEXT_TABLE || '';
  if (!table) {
    const cf = new CloudFormationClient({ region: REGION });
    const s = await cf.send(new DescribeStacksCommand({ StackName: `${resolveStackPrefix()}Conversations` }));
    table = s.Stacks?.[0]?.Outputs?.find((x) => x.OutputKey === 'ChannelContextTableName')?.OutputValue || '';
  }
  return table;
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
/** The watched room's row and its meeting conversation's row, read-only. */
const callRows = async () => o.readCallRows(ddb, await contextTable(), o.ALARM_NAME);

const nextTick = () => new Promise((resolve) => { const t = setTimeout(resolve, o.minuteOf(Date.now()) + 62_000 - Date.now()); stop.timer = t; });
const stop = { timer: null };

/**
 * THE LOOP: one datapoint a minute, a line printed for each, for at most --minutes. `phase` starts at outage, recovery or
 * healthy; `until` ends it early (recover and reset end once the alarm is OK).
 */
async function run(phase, { until } = {}) {
  fs.writeFileSync(RUNNING, JSON.stringify({ pid: process.pid, phase, startedAt: new Date().toISOString() }));
  try { fs.unlinkSync(RECOVER); } catch { /* none asked */ }
  const startedAt = Date.now();
  const state = { phase, minute: 0 };
  let callAt = null;
  process.on('SIGINT', () => {
    clearTimeout(stop.timer);
    try { fs.unlinkSync(RUNNING); } catch { /* gone */ }
    console.log(`\nStopped in ${state.phase}. Missing minutes leave the alarm as it is; \`reset\` returns it to OK.`);
    process.exit(0);
  });
  for (let i = 0; i < opts.minutes; i++) {
    if (i) await nextTick();
    const now = Date.now();
    const at = o.minuteOf(now);
    const recoverRequested = fs.existsSync(RECOVER);
    if (state.phase === 'outage' && opts.recoverOnCall && callAt == null) {
      callAt = await callRows().then((r) => o.callStartedAt(r.room, r.meeting, startedAt)).catch((err) => {
        console.warn(`  (the room's record could not be read: ${err.name})`);
        return null;
      });
    }
    const next = o.nextPhase(state, { now, callAt, recoverRequested, recoverOnCall: opts.recoverOnCall, delayMs: opts.delaySeconds * 1000 });
    if (next !== state.phase) { state.phase = next; state.minute = 0; try { fs.unlinkSync(RECOVER); } catch { /* none */ } }
    if (state.phase === 'recovery' && state.minute >= o.RECOVERY.length) { state.phase = 'healthy'; state.minute = 0; }
    const values = o.valuesFor(state.phase, state.minute, Math.random);
    await put(o.metricData(values, at, dims));
    const alarm = await readAlarm().catch(() => undefined);
    const call = callAt != null ? `call ${new Date(callAt).toISOString().slice(11, 16)}Z` : '';
    console.log(o.line(at, state.phase, values, [`alarm ${alarm?.StateValue ?? '?'}`, call].filter(Boolean).join('  ')));
    state.minute += 1;
    if (until?.(state, alarm)) break;
  }
  try { fs.unlinkSync(RUNNING); } catch { /* gone */ }
  if (state.phase === 'outage') console.log('Ended at --minutes still in outage; run `recover` (or `reset`).');
}

async function setup() {
  const before = await readAlarm();
  const filled = await backfillBaseline(opts.hours);
  console.log(`Baseline: ${filled} healthy minutes written over the past ${opts.hours} h (${o.NAMESPACE}, Region=${opts.region}, Service=${opts.service}).`);
  await cw.send(new PutMetricAlarmCommand(o.alarmInput(before, dims)));
  const after = await readAlarm();
  console.log(`Alarm: ${after.AlarmName} on ${after.MetricName} < ${after.Threshold} for 2 of 2 minutes, state ${after.StateValue}.`);
  console.log(`ARN:   ${after.AlarmArn}${before && before.AlarmArn !== after.AlarmArn ? '  (CHANGED: re-attach the trigger)' : before ? '  (unchanged)' : '  (new: attach the trigger)'}`);
  // THE ALARM THIS DEMO USED TO CREATE watches the same metric, so left in place it would open a second incident beside this one.
  const legacy = (await cw.send(new DescribeAlarmsCommand({ AlarmNames: [LEGACY_ALARM_NAME], AlarmTypes: ['MetricAlarm'] }))).MetricAlarms?.[0];
  if (legacy) {
    await cw.send(new DeleteAlarmsCommand({ AlarmNames: [LEGACY_ALARM_NAME] }));
    console.log(`Removed the demo's earlier alarm ${LEGACY_ALARM_NAME}, which watched the same metric. Detach its trigger in the console if one is attached.`);
  }
}

/** The name this demo's alarm had before it was named for its service. */
const LEGACY_ALARM_NAME = 'AgentEchelon-demo-incident';

async function status() {
  const a = await readAlarm();
  console.log(a ? `Alarm ${a.AlarmName}: ${a.StateValue} since ${a.StateUpdatedTimestamp?.toISOString?.() ?? a.StateUpdatedTimestamp}; ${a.Namespace} ${a.MetricName} ${JSON.stringify(a.Dimensions)}` : 'No alarm yet: run setup.');
  const now = Date.now();
  const r = await cw.send(new GetMetricDataCommand({
    StartTime: new Date(now - 10 * 60_000), EndTime: new Date(now),
    MetricDataQueries: Object.keys(o.METRICS).map((m, i) => ({ Id: `m${i}`, Label: m, MetricStat: { Metric: { Namespace: o.NAMESPACE, MetricName: m, Dimensions: dims }, Period: 60, Stat: 'Average' } })),
  }));
  for (const s of r.MetricDataResults ?? []) console.log(`  ${s.Label.padEnd(13)} ${(s.Values ?? []).slice(0, 6).reverse().join('  ') || '(no data in 10 minutes)'}`);
  const pid = loopRunning();
  console.log(pid ? `A loop is running (pid ${pid}).` : 'No loop is running.');
  const rows = await callRows().catch(() => null);
  if (rows?.roomArn) console.log(`Watched room: ${rows.roomArn.split('/').pop()}; call ${rows.room?.activeMeeting || rows.meeting?.activeMeeting ? `running since ${(rows.room?.activeMeeting ?? rows.meeting.activeMeeting).createdAt}` : 'not running'}.`);
}

const okAgain = (state, alarm) => state.phase === 'healthy' && alarm?.StateValue === 'OK';

switch (opts.command) {
  case 'setup': await setup(); break;
  case 'outage': {
    if (loopRunning()) { console.error('A loop is already running; stop it with Ctrl+C first.'); process.exit(1); }
    // AN INCIDENT OPENS ON THE ALARM'S CHANGE INTO ALARM: an alarm already there never changes, so the outage would open nothing.
    const before = await readAlarm();
    if (before?.StateValue === 'ALARM') { console.error('The alarm is already in ALARM, so an outage would open no incident. Run `reset` until it is OK, then start the outage.'); process.exit(1); }
    const filled = await backfillBaseline(3);
    if (filled) console.log(`Filled ${filled} healthy minutes before the outage.`);
    console.log(`Outage on Region=${opts.region} Service=${opts.service}, ${opts.minutes} minutes at most${opts.recoverOnCall ? `, recovering ${opts.delaySeconds}s after the room's call starts` : '; `recover` ends it'}. Ctrl+C stops.`);
    await run('outage');
    break;
  }
  case 'recover': {
    const pid = loopRunning();
    if (pid) { fs.writeFileSync(RECOVER, new Date().toISOString()); console.log(`Recovery asked of the running outage (pid ${pid}); it ramps back from its next minute.`); break; }
    await run('recovery', { until: okAgain });
    break;
  }
  case 'reset': {
    if (loopRunning()) { console.error('A loop is running; stop it with Ctrl+C first.'); process.exit(1); }
    const a = await readAlarm();
    if (a?.StateValue === 'OK') { console.log('The alarm is OK.'); break; }
    await run('healthy', { until: okAgain });
    break;
  }
  case 'status': await status(); break;
  default:
    console.log('Usage: demo-network-outage.mjs setup | outage [--recover-on-call] [--delay=60] [--minutes=30] | recover | status | reset');
}
