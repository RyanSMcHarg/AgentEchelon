/**
 * WHAT A CONVERSATION'S DASHBOARD SHOWS (DESIGN-CONVERSATION-DASHBOARDS section 2), read as the assistant publishing it.
 *
 * The same reach `read_deployment_health` has, as series rather than totals: the alarm the conversation watches and the
 * metric it watches, against its threshold, the metrics published beside that metric (its namespace, with exactly its
 * dimensions), and this deployment's Lambda invocations, errors, throttles and average duration. The credentials are the assistant's own session; there is no fallback to the Lambda's role, so an assistant
 * without the grant reads nothing rather than borrowing one.
 */
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, ListMetricsCommand, type Dimension, type MetricDataQuery, type MetricDataResult } from '@aws-sdk/client-cloudwatch';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { isThisDeployments, readOneMetric, toReading } from './deployment-health.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

/** How far back the dashboard reads, and the width of one point. Three hours at five minutes is 36 points a series. */
export const DASHBOARD_WINDOW_MINUTES = 180;
export const DASHBOARD_PERIOD_SECONDS = 300;

/** At most this many metrics beside the watched one are drawn. */
export const RELATED_METRICS_MAX = 3;

/** One series: points oldest first, each an ISO time and a value. A missing bucket is absent, never zero. */
export interface DashboardSeries {
  key: 'invocations' | 'errors' | 'throttles' | 'durationMs' | 'alarmMetric' | 'related';
  /** The alarm's or a related series' metric, as `Namespace/MetricName`; every other series is named by the dashboard's labels. */
  metric?: string;
  points: Array<{ t: string; v: number }>;
}

export interface DashboardAlarm {
  name: string;
  state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  since: string | null;
  reason: string;
  /** What the alarm watches, as `Namespace/MetricName`, with its threshold and comparison when it declares one. */
  metric?: string;
  threshold?: number;
  comparison?: string;
}

export interface DashboardData {
  readAt: string;
  windowMinutes: number;
  alarm?: DashboardAlarm;
  /** Set when the alarm could not be read, so the dashboard says so rather than showing it clear. */
  alarmUnavailable?: boolean;
  series: DashboardSeries[];
  /** Set when the deployment's metrics could not be read. */
  metricsUnavailable?: boolean;
}

/** Each bucket's value, summed over this deployment's functions, keyed by timestamp. */
function sumByTime(results: MetricDataResult[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of results ?? []) {
    if (!isThisDeployments(r.Label)) continue;
    (r.Timestamps ?? []).forEach((ts, i) => {
      const v = r.Values?.[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      const k = new Date(ts).getTime();
      out.set(k, (out.get(k) ?? 0) + v);
    });
  }
  return out;
}

const toPoints = (m: Map<number, number>): DashboardSeries['points'] =>
  [...m.entries()].sort(([a], [b]) => a - b).map(([t, v]) => ({ t: new Date(t).toISOString(), v }));

/** One of the health read's own Metrics Insights queries, at the dashboard's resolution. */
const insights = (client: CloudWatchClient, now: number, metric: string) => readOneMetric(client, now, DASHBOARD_WINDOW_MINUTES, metric, DASHBOARD_PERIOD_SECONDS);

/** Two dimension sets are the same set: the same names with the same values, in any order. */
function sameDimensions(a: Dimension[] | undefined, b: Dimension[] | undefined): boolean {
  const key = (d: Dimension[] | undefined) => (d ?? []).map((x) => JSON.stringify([x.Name, x.Value])).sort().join(',');
  return key(a) === key(b);
}

/**
 * THE METRICS PUBLISHED BESIDE THE WATCHED ONE: the alarm's namespace with exactly the alarm's dimensions, published in
 * the last three hours, by name, at most `RELATED_METRICS_MAX`. Best-effort: a listing that fails leaves the watched
 * metric's chart as it is, and is logged.
 */
export async function relatedMetricNames(
  client: Pick<CloudWatchClient, 'send'>,
  alarm: { Namespace: string; MetricName: string; Dimensions?: Dimension[] },
): Promise<string[]> {
  try {
    const res = await client.send(new ListMetricsCommand({
      Namespace: alarm.Namespace,
      Dimensions: (alarm.Dimensions ?? []).map((d) => ({ Name: d.Name, Value: d.Value })),
      RecentlyActive: 'PT3H',
    }));
    const names = new Set<string>();
    for (const m of res.Metrics ?? []) {
      // A FILTER ON DIMENSIONS ALSO MATCHES METRICS THAT CARRY MORE; only the alarm's exact set is the same resource.
      if (m.MetricName && m.MetricName !== alarm.MetricName && sameDimensions(m.Dimensions, alarm.Dimensions)) names.add(m.MetricName);
    }
    return [...names].sort().slice(0, RELATED_METRICS_MAX);
  } catch (err) {
    console.warn('[dashboard] the metrics beside the watched one could not be listed', { err: (err as Error)?.name });
    return [];
  }
}

/** One result's finite points, oldest first. */
function pointsOf(r: MetricDataResult | undefined): DashboardSeries['points'] {
  const points = new Map<number, number>();
  (r?.Timestamps ?? []).forEach((ts, i) => {
    const v = r?.Values?.[i];
    if (typeof v === 'number' && Number.isFinite(v)) points.set(new Date(ts).getTime(), v);
  });
  return toPoints(points);
}

/** The watched alarm, its metric's series and the series beside it. Never throws: an alarm that cannot be read is said to be unavailable. */
async function readAlarm(client: CloudWatchClient, now: number, name: string): Promise<{ alarm?: DashboardAlarm; series?: DashboardSeries[]; unavailable?: boolean }> {
  try {
    const res = await client.send(new DescribeAlarmsCommand({ AlarmNames: [name], AlarmTypes: ['MetricAlarm'], MaxRecords: 1 }));
    const a = res.MetricAlarms?.[0];
    if (!a) return { unavailable: true };
    // THE HEALTH READ'S OWN CLEANING of an alarm's untrusted reason and its time, so the two never disagree about an alarm.
    const reading = toReading(a);
    const alarm: DashboardAlarm = {
      name: a.AlarmName ?? name,
      state: a.StateValue === 'ALARM' || a.StateValue === 'OK' ? a.StateValue : 'INSUFFICIENT_DATA',
      since: reading.since,
      reason: reading.reason,
      ...(a.Namespace && a.MetricName ? { metric: `${a.Namespace}/${a.MetricName}` } : {}),
      ...(typeof a.Threshold === 'number' ? { threshold: a.Threshold } : {}),
      ...(a.ComparisonOperator ? { comparison: a.ComparisonOperator } : {}),
    };
    const series = await alarmSeries(client, now, a);
    return series ? { alarm, series } : { alarm };
  } catch {
    return { unavailable: true };
  }
}

/**
 * THE SERIES OF AN ALARM ALREADY DESCRIBED: its metric and the metrics beside it, over the dashboard's window. The health read
 * uses the same series for the figures the first look reads customer experience from, so the dashboard and the assistant's
 * words read one population. Undefined for an alarm that watches no single metric.
 */
export async function alarmSeries(
  client: Pick<CloudWatchClient, 'send'>,
  now: number,
  a: { Namespace?: string; MetricName?: string; Dimensions?: Dimension[]; Period?: number; Statistic?: string; ExtendedStatistic?: string },
): Promise<DashboardSeries[] | undefined> {
  if (!a.Namespace || !a.MetricName) return undefined;
  const namespace = a.Namespace;
  const period = Math.max(a.Period ?? DASHBOARD_PERIOD_SECONDS, 60);
  const related = await relatedMetricNames(client, { Namespace: namespace, MetricName: a.MetricName, Dimensions: a.Dimensions });
  // THE WATCHED METRIC AT THE ALARM'S OWN STATISTIC, those beside it at their average (the alarm's statistic is chosen
  // for its metric alone), every series at the alarm's period so they line up point for point. One read for all.
  const queries: MetricDataQuery[] = [
    { Id: 'a', MetricStat: { Metric: { Namespace: namespace, MetricName: a.MetricName, Dimensions: a.Dimensions }, Period: period, Stat: a.Statistic ?? a.ExtendedStatistic ?? 'Average' } },
    ...related.map((m, i) => ({ Id: `r${i}`, MetricStat: { Metric: { Namespace: namespace, MetricName: m, Dimensions: a.Dimensions }, Period: period, Stat: 'Average' } })),
  ];
  const data = await client.send(new GetMetricDataCommand({
    StartTime: new Date(now - DASHBOARD_WINDOW_MINUTES * 60_000),
    EndTime: new Date(now),
    MetricDataQueries: queries,
  })).catch(() => undefined);
  const byId = new Map((data?.MetricDataResults ?? []).map((r) => [r.Id, r]));
  return [
    { key: 'alarmMetric', metric: `${namespace}/${a.MetricName}`, points: pointsOf(byId.get('a')) },
    ...related.map((m, i): DashboardSeries => ({ key: 'related', metric: `${namespace}/${m}`, points: pointsOf(byId.get(`r${i}`)) })),
  ];
}

/** Read the dashboard's data as the assistant. Null credentials read nothing. */
export async function readDashboardData(
  credentials: AwsCredentialIdentity | null,
  opts: { watchedAlarm?: string; now?: () => number } = {},
): Promise<DashboardData | null> {
  if (!credentials) return null;
  const now = opts.now?.() ?? Date.now();
  const client = new CloudWatchClient({ region: AWS_REGION, credentials });
  const watched = opts.watchedAlarm?.trim();
  const alarmRead = watched ? readAlarm(client, now, watched) : Promise.resolve(undefined);
  const series: DashboardSeries[] = [];
  const scoped = !!(process.env.DEPLOYMENT_FUNCTION_PREFIX || '').trim();
  let metricsUnavailable = !scoped;
  if (scoped) {
    try {
      const [inv, err, thr, dur] = await Promise.all(['Invocations', 'Errors', 'Throttles', 'Duration'].map((m) => insights(client, now, m)));
      const invocations = sumByTime(inv.MetricDataResults);
      const durationSum = sumByTime(dur.MetricDataResults);
      // THE MEAN OF THE INVOCATIONS, not of the functions: each bucket's total duration over its invocations.
      const durationMs = new Map<number, number>();
      for (const [t, total] of durationSum) { const n = invocations.get(t); if (n) durationMs.set(t, total / n); }
      series.push(
        { key: 'invocations', points: toPoints(invocations) },
        { key: 'errors', points: toPoints(sumByTime(err.MetricDataResults)) },
        { key: 'throttles', points: toPoints(sumByTime(thr.MetricDataResults)) },
        { key: 'durationMs', points: toPoints(durationMs) },
      );
    } catch {
      metricsUnavailable = true;
    }
  }
  const alarmOut = await alarmRead;
  if (alarmOut?.series) series.unshift(...alarmOut.series);
  return {
    readAt: new Date(now).toISOString(),
    windowMinutes: DASHBOARD_WINDOW_MINUTES,
    ...(alarmOut?.alarm ? { alarm: alarmOut.alarm } : {}),
    ...(alarmOut?.unavailable ? { alarmUnavailable: true } : {}),
    series,
    ...(metricsUnavailable ? { metricsUnavailable: true } : {}),
  };
}
