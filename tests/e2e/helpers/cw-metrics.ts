/**
 * Read a CloudWatch metric a live turn emitted, for any AgentEchelon namespace.
 *
 * WHY ANY OF THIS EXISTS. `emitEmfMetric` wrote `Metrics: [{name, unit}]` where the EMF schema
 * requires `{Name, Unit}`. CloudWatch discards a malformed document SILENTLY - the log line is still
 * written, so every log looks healthy - and the result was that no metric in any AgentEchelon
 * namespace had ever materialised. `AgentEchelon/Drift` returned zero from `list-metrics` after
 * months of drift detection running on every turn, and an alarm over one of those metrics would have
 * sat in INSUFFICIENT_DATA forever instead of firing.
 *
 * Every unit test passed throughout, and they always would have: a unit test asserts the shape the
 * emitter produces, and the defect was that AWS parses a different shape. The schema is an external
 * contract, so only a test that READS THE METRIC BACK from CloudWatch can see it. That is this file.
 *
 * Shells out to the AWS CLI for the same reason `backend-errors.ts` does: the suite already has
 * credentials in the shape validate.mjs provides, and this keeps an SDK client out of the
 * browser-test process.
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const AWS_PROFILE = process.env.AWS_PROFILE || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * Why a metric assertion did not run, for `test.skip(!metricCheckEnabled(), METRIC_CHECK_DISABLED)`.
 * A bare `test.skip()` records no reason, so the run report cannot say what was missing.
 */
export const METRIC_CHECK_DISABLED =
  'No AWS credentials for the CloudWatch read (set AWS_PROFILE, or unset SKIP_BACKEND_ERROR_CHECK=1). '
  + 'The turn assertions still ran; only the metric cross-check was skipped.';

/** Same opt-out shape as the backend error guard: on when the run has credentials at all. */
export function metricCheckEnabled(): boolean {
  if (process.env.SKIP_BACKEND_ERROR_CHECK === '1') return false;
  return Boolean(AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
}

function profileFlag(): string {
  return AWS_PROFILE ? `--profile ${AWS_PROFILE}` : '';
}

export interface MetricQuery {
  namespace: string;
  metricName: string;
  /**
   * Dimension name -> value. Must name a COMPLETE dimension set the emitter declares: CloudWatch
   * creates one metric per declared set, and a partial match returns no datapoints rather than an
   * error. `emitDriftTiming` declares `['Stage']`, so `{ Stage: 'total' }` is the queryable set.
   */
  dimensions: Record<string, string>;
  sinceEpochMs: number;
}

/**
 * Sum of a metric since `sinceEpochMs`.
 *
 * Returns 0 when there is no data, which is a real answer - "the deployed path did not report this"
 * - not an error. The caller decides whether that is a pass or a failure.
 */
export async function sumMetric(q: MetricQuery): Promise<number> {
  const dims = Object.entries(q.dimensions)
    .map(([name, value]) => `Name=${name},Value=${value}`)
    .join(' ');

  // Round the window out to whole minutes: CloudWatch aligns datapoints to the period, so a start
  // time mid-period can exclude the very datapoint the turn produced.
  const start = new Date(Math.floor(q.sinceEpochMs / 60_000) * 60_000).toISOString();
  const end = new Date(Date.now() + 60_000).toISOString();

  const { stdout } = await execAsync(
    `aws cloudwatch get-metric-statistics --namespace ${q.namespace} `
    + `--metric-name ${q.metricName} --dimensions ${dims} --statistics Sum --period 60 `
    + `--start-time ${start} --end-time ${end} --region ${REGION} `
    + `--query "sum(Datapoints[].Sum)" --output text ${profileFlag()}`,
    { encoding: 'utf-8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  const raw = String(stdout).trim();
  if (!raw || raw === 'None' || raw === 'null') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Poll until a metric reports data, or give up and return 0.
 *
 * EMF metrics are extracted from the log stream asynchronously, so a datapoint is not visible the
 * instant the reply renders. Polling rather than one long sleep keeps a fast path fast and still
 * gives slow ingestion time to land.
 */
export async function waitForMetric(
  q: MetricQuery,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await sumMetric(q);
    if (last > 0) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Does this namespace have ANY metric at all?
 *
 * The blunt instrument that would have caught the EMF bug on day one: `list-metrics` on
 * `AgentEchelon/Drift` returned an empty list for months. Cheaper and far less flaky than a
 * datapoint assertion, because it does not depend on a specific turn having produced a specific
 * dimension - and it fails loudly on exactly the class of defect that hid here.
 */
export async function namespaceHasMetrics(namespace: string): Promise<string[]> {
  const { stdout } = await execAsync(
    `aws cloudwatch list-metrics --namespace ${namespace} --region ${REGION} `
    + `--query "Metrics[].MetricName" --output text ${profileFlag()}`,
    { encoding: 'utf-8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  const raw = String(stdout).trim();
  if (!raw || raw === 'None') return [];
  return Array.from(new Set(raw.split(/\s+/).filter(Boolean)));
}
