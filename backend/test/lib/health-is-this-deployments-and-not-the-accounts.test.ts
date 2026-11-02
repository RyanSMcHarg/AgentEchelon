/**
 * "THE PLATFORM ERROR RATE" MEANS THIS DEPLOYMENT, NOT WHATEVER ELSE SHARES THE AWS ACCOUNT.
 *
 * ── THE DEFECT THESE PIN, measured on a live deployment 2026-09-30 ───────────────────────────────
 *
 * Asked "what is the platform error rate in the last hour", the operations assistant answered 44.2%,
 * called it critical, and recommended escalating to platform engineering. It had read CloudWatch
 * correctly - 42 errors, 95 invocations - and every one of those 42 errors belonged to other
 * applications sharing the account: two functions of one unrelated analytics stack contributed 36 and
 * 6, and two further unrelated stacks added invocations. This deployment had contributed no errors at
 * all. The foreign names are stood in for below rather than reproduced, because they identify other
 * deployments and this repo is not where they belong - what the test needs is only that they do NOT
 * carry this deployment's prefix.
 *
 * The query asked `AWS/Lambda` with no `Dimensions`, which is the account. Nothing in the reply could
 * have told a person the numbers were not theirs, and the tool's name said they were.
 *
 * ── WHY THE FILTER IS APPLIED TO LABELS RATHER THAN PUSHED INTO THE QUERY ────────────────────────
 *
 * Both of the obvious ways were refused by the API and are recorded here so neither is retried:
 * Metrics Insights rejects `LIKE` outright (`Invalid syntax near 'LIKE'`), and `GetMetricData` accepts
 * exactly ONE Metrics Insights expression per call (`Maximum number of queries (1) exceeded`). So each
 * metric is its own call, grouped per function by the service, and filtered by prefix here.
 */
const mockCwSend = jest.fn();

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCwSend })),
  GetMetricDataCommand: jest.fn((input: unknown) => ({ __type: 'GetMetricData', input })),
  DescribeAlarmsCommand: jest.fn((input: unknown) => ({ __type: 'DescribeAlarms', input })),
}), { virtual: true });

const CREDS = { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' };

/** The nine series this account actually returns for an hour, four of them this deployment's. */
const SERIES = {
  Invocations: [
    { Label: 'AgentEchelonAssistants-pre-AgentHandler-x', Values: [11] },
    { Label: 'AgentEchelonAssistants-p-AsyncProcessor-y', Values: [6] },
    { Label: 'AgentEchelonChannelFlow-ChannelFlowProcessor-z', Values: [3] },
    { Label: 'OtherAnalyticsStack-DetectorFn-a', Values: [36] },
    { Label: 'SecondUnrelatedStack-Api-UserFn-b', Values: [3] },
    { Label: 'ThirdUnrelatedStack-ServerFn-c', Values: [1] },
  ],
  Errors: [
    { Label: 'OtherAnalyticsStack-DetectorFn-a', Values: [36] },
    { Label: 'OtherAnalyticsStack-SummaryFn-d', Values: [6] },
  ],
  Throttles: [] as Array<{ Label: string; Values: number[] }>,
  Duration: [
    { Label: 'AgentEchelonAssistants-pre-AgentHandler-x', Values: [4000] },
    { Label: 'AgentEchelonAssistants-p-AsyncProcessor-y', Values: [16000] },
    { Label: 'AgentEchelonChannelFlow-ChannelFlowProcessor-z', Values: [0] },
    { Label: 'OtherAnalyticsStack-DetectorFn-a', Values: [900000] },
  ],
};

/** Answer each of the four calls with the series for the metric its expression names. */
function respondPerMetric() {
  mockCwSend.mockImplementation((cmd: { __type: string; input: { MetricDataQueries: Array<{ Expression: string }> } }) => {
    // The alarm read beside the metrics has its own file; here it finds no alarm.
    if (cmd.__type === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
    const expr = cmd.input.MetricDataQueries[0].Expression;
    const metric = (Object.keys(SERIES) as Array<keyof typeof SERIES>)
      .find((m) => expr.includes(`SUM(${m})`));
    return Promise.resolve({ MetricDataResults: metric ? SERIES[metric] : [] });
  });
}

/** Load the module under a given prefix; it reads the env at import time. */
function load(prefix: string | undefined) {
  jest.resetModules();
  if (prefix === undefined) delete process.env.DEPLOYMENT_FUNCTION_PREFIX;
  else process.env.DEPLOYMENT_FUNCTION_PREFIX = prefix;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../lambda/src/lib/deployment-health') as
    typeof import('../../lambda/src/lib/deployment-health');
}

beforeEach(() => {
  jest.clearAllMocks();
  respondPerMetric();
});

describe('the figures cover this deployment only', () => {
  it('counts this deployment\'s invocations and ignores the other applications\'', async () => {
    const { readDeploymentHealth } = load('AgentEchelon');
    const health = await readDeploymentHealth(CREDS);
    // 11 + 6 + 3. The account total is 60; the account answer is the defect.
    expect(health.invocations).toBe(20);
  });

  it('reports ZERO errors when every error in the account belongs to somebody else', async () => {
    // THE CASE THAT MATTERS MOST. Account-wide this reads 42 errors on 60 invocations - 70%, "critical".
    // Scoped, this deployment had none, and the two answers are not variations of each other.
    const { readDeploymentHealth } = load('AgentEchelon');
    const health = await readDeploymentHealth(CREDS);
    expect(health.errors).toBeNull();
    expect(health.errorRatePercent).toBeNull();
  });

  it('weights the average duration by invocations rather than averaging the functions', async () => {
    // 4000 + 16000 + 0 = 20000 ms over 20 invocations = 1000 ms. Averaging the three functions'
    // own averages would answer something else entirely, and the slow neighbour's 900s is excluded.
    const { readDeploymentHealth } = load('AgentEchelon');
    const health = await readDeploymentHealth(CREDS);
    expect(health.averageDurationMs).toBe(1000);
  });

  it('says what it measured, so a reply cannot imply more than it read', async () => {
    const { readDeploymentHealth } = load('AgentEchelon');
    const health = await readDeploymentHealth(CREDS);
    expect(health.scope).toContain('AgentEchelon');
    expect(health.scope).toContain('this deployment');
  });

  it('asks per function, because the API refuses both of the alternatives', async () => {
    // Grouped per function and filtered here: `LIKE` is rejected by Metrics Insights, and only one
    // Insights expression is allowed per call - hence four calls rather than one.
    const { readDeploymentHealth } = load('AgentEchelon');
    await readDeploymentHealth(CREDS);
    const metricCalls = mockCwSend.mock.calls.filter((c) => c[0].__type === 'GetMetricData');
    expect(metricCalls).toHaveLength(4);
    for (const call of metricCalls) {
      const expr = call[0].input.MetricDataQueries[0].Expression as string;
      expect(expr).toContain('GROUP BY FunctionName');
      expect(expr).not.toContain('LIKE');
    }
  });

  it('refuses to answer at all when it was not told which functions are its own', async () => {
    // FAIL CLOSED. The only query available without a prefix is the account's, and answering that
    // silently is the whole defect. The message names the missing variable so it is diagnosable.
    const { readDeploymentHealth } = load(undefined);
    const health = await readDeploymentHealth(CREDS);
    expect(health.unavailable).toMatch(/DEPLOYMENT_FUNCTION_PREFIX/);
    expect(health.invocations).toBeNull();
    expect(mockCwSend).not.toHaveBeenCalled();
  });

  it('still reports an entitlement refusal as an answer rather than an error', async () => {
    // Unchanged behavior, asserted because the scoping rewrote the call path it sits on: only the
    // ops boundary grants these reads, so another role reaching here is the boundary working.
    const { readDeploymentHealth } = load('AgentEchelon');
    mockCwSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'AccessDeniedException' }));
    const health = await readDeploymentHealth(CREDS);
    expect(health.unavailable).toMatch(/not entitled/);
  });
});
