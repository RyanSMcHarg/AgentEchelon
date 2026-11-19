/**
 * A CONVERSATION'S DASHBOARD DRAWS THE METRICS PUBLISHED BESIDE THE WATCHED ONE (DESIGN-CONVERSATION-DASHBOARDS section 2).
 *
 * They are found from the alarm itself: its namespace, with exactly its dimensions, recently published, by name, at most
 * three. A listing that fails leaves the watched metric's chart as it is.
 */
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { readDashboardData, relatedMetricNames, RELATED_METRICS_MAX } from '../../lambda/src/lib/dashboard-data';
import { metricWords, renderDashboardFragment } from '../../lambda/src/lib/dashboard-render';
import { dashboardLabels } from '../../lambda/src/lib/dashboard-tool';

const DIMS = [{ Name: 'Region', Value: 'r-1' }, { Name: 'Service', Value: 'svc' }];
const ALARM = { Namespace: 'Team/App', MetricName: 'SuccessRate', Dimensions: DIMS };
const creds = { accessKeyId: 'a', secretAccessKey: 'b' };
const T = (m: number) => new Date(Date.UTC(2026, 10, 13, 12, m));

const labels = {
  title: 'Dashboard', updated: 'Updated', stateAlarm: 'In alarm', stateOk: 'OK', stateInsufficient: 'Insufficient data', stateUnread: 'Unread',
  threshold: 'Threshold', invocations: 'Invocations', errors: 'Errors', throttles: 'Throttles', durationMs: 'Duration', related: 'Beside it',
  noData: 'No data', unavailable: 'Unavailable', values: 'Values', time: 'Time',
};

function fakeClient(opts: { listed?: Array<{ MetricName: string; Dimensions: typeof DIMS }>; listFails?: boolean }) {
  const sent: unknown[] = [];
  const send = jest.fn(async (cmd: unknown) => {
    sent.push(cmd);
    if (cmd instanceof ListMetricsCommand) {
      if (opts.listFails) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      return { Metrics: opts.listed ?? [] };
    }
    if (cmd instanceof DescribeAlarmsCommand) {
      return { MetricAlarms: [{ AlarmName: 'team-alarm', StateValue: 'ALARM', ...ALARM, Period: 60, Statistic: 'Average', Threshold: 90, ComparisonOperator: 'LessThanThreshold' }] };
    }
    if (cmd instanceof GetMetricDataCommand) {
      return {
        MetricDataResults: (cmd.input.MetricDataQueries ?? []).map((q, i) => ({ Id: q.Id, Timestamps: [T(1), T(2)], Values: [100 - i, 1 + i] })),
      };
    }
    return {};
  });
  return { send, sent };
}

describe('the metrics beside the watched one', () => {
  it('are the alarm namespace\'s metrics with exactly its dimensions, other than its own, by name, at most three', async () => {
    const { send, sent } = fakeClient({
      listed: [
        { MetricName: 'SuccessRate', Dimensions: DIMS },
        { MetricName: 'PacketLoss', Dimensions: [...DIMS].reverse() },
        { MetricName: 'Zeta', Dimensions: DIMS },
        { MetricName: 'Latency', Dimensions: DIMS },
        { MetricName: 'Hosts', Dimensions: DIMS },
        { MetricName: 'Extra', Dimensions: [...DIMS, { Name: 'Host', Value: 'h1' }] },
        { MetricName: 'Fewer', Dimensions: [DIMS[0]] },
      ],
    });
    const names = await relatedMetricNames({ send } as never, ALARM);
    expect(names).toEqual(['Hosts', 'Latency', 'PacketLoss']);
    expect(names.length).toBeLessThanOrEqual(RELATED_METRICS_MAX);
    const list = sent[0] as ListMetricsCommand;
    expect(list.input).toEqual({ Namespace: 'Team/App', Dimensions: DIMS, RecentlyActive: 'PT3H' });
  });

  it('a listing that fails names none and is logged as a warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { send } = fakeClient({ listFails: true });
    await expect(relatedMetricNames({ send } as never, ALARM)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be listed'), { err: 'AccessDenied' });
    warn.mockRestore();
  });
});

describe('the dashboard reads and draws them', () => {
  const restore: Array<() => void> = [];
  afterEach(() => { restore.splice(0).forEach((r) => r()); });
  const stubClient = (fake: ReturnType<typeof fakeClient>) => {
    const spy = jest.spyOn(CloudWatchClient.prototype, 'send').mockImplementation(fake.send as never);
    restore.push(() => spy.mockRestore());
  };

  it('reads them in the watched metric\'s one read, at the alarm\'s period, and draws each under the heading and in the table', async () => {
    const fake = fakeClient({ listed: [{ MetricName: 'Latency', Dimensions: DIMS }, { MetricName: 'PacketLoss', Dimensions: DIMS }] });
    stubClient(fake);
    const data = await readDashboardData(creds, { watchedAlarm: 'team-alarm', now: () => T(5).getTime() });
    const reads = fake.sent.filter((c) => c instanceof GetMetricDataCommand) as GetMetricDataCommand[];
    expect(reads).toHaveLength(1);
    const queries = reads[0].input.MetricDataQueries ?? [];
    expect(queries.map((q) => q.MetricStat?.Metric?.MetricName)).toEqual(['SuccessRate', 'Latency', 'PacketLoss']);
    expect(queries.every((q) => q.MetricStat?.Period === 60)).toBe(true);
    expect(queries.every((q) => q.MetricStat?.Metric?.Dimensions === DIMS)).toBe(true);

    expect(data?.series.map((s) => [s.key, s.metric])).toEqual([
      ['alarmMetric', undefined], ['related', 'Team/App/Latency'], ['related', 'Team/App/PacketLoss'],
    ]);
    expect(data?.series[1].points).toEqual([{ t: T(1).toISOString(), v: 99 }, { t: T(2).toISOString(), v: 2 }]);

    const html = renderDashboardFragment(data!, labels);
    expect(html).toContain('<h2>Beside it</h2>');
    expect(html).toContain('<figcaption>Latency</figcaption>');
    expect(html).toContain('<th>Packet loss</th>');
  });

  it('a listing that fails leaves the watched metric\'s chart as it is, with no heading', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    restore.push(() => warn.mockRestore());
    const fake = fakeClient({ listFails: true });
    stubClient(fake);
    const data = await readDashboardData(creds, { watchedAlarm: 'team-alarm', now: () => T(5).getTime() });
    expect(data?.alarm?.state).toBe('ALARM');
    expect(data?.series.map((s) => s.key)).toEqual(['alarmMetric']);
    expect(data?.series[0].points).toHaveLength(2);
    const html = renderDashboardFragment(data!, labels);
    expect(html).toContain('<figcaption>Success rate</figcaption>');
    expect(html).not.toContain('<h2>');
  });
});

describe('the dashboard says what it shows', () => {
  it('names a metric in words, without its namespace', () => {
    expect(metricWords('AgentEchelon/Demo/SuccessRate')).toBe('Success rate');
    expect(metricWords('AgentEchelon/Demo/LatencyP95')).toBe('Latency P95');
    expect(metricWords('HealthyHosts')).toBe('Healthy hosts');
  });

  it('is titled for its conversation, says what it shows, and heads the deployment\'s own health', () => {
    const labels = dashboardLabels(undefined, '21:05', 'AgentEchelon Demo Incident');
    expect(labels.title).toBe('Dashboard: AgentEchelon Demo Incident');
    expect(dashboardLabels(undefined, '21:05').title).toBe('Conversation dashboard');
    expect(labels.about).toMatch(/^The alarm this conversation watches/);
    expect(labels.deployment).toBe("This deployment's assistants (AWS Lambda)");
  });
});
