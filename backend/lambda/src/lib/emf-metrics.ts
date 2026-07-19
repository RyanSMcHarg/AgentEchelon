/**
 * EMF (Embedded Metric Format) Metrics for CloudWatch
 *
 * Emits metrics that CloudWatch automatically parses into queryable
 * metrics for dashboards and alarms.
 *
 * See: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 *
 * Scoped to AE's needs. The
 * generic emit() helper accepts any namespace + dimensions; the drift helpers
 * wrap it for the SPEC-DRIFT-CONVERGENCE.md observability requirements.
 */

const DRIFT_NAMESPACE = 'AgentEchelon/Drift';

type DriftStage =
  | 'summary_fetch'
  | 'message_embed'
  | 'comparison'
  | 'related_conv_lookup'
  | 'suggestion_emit'
  | 'total';

type DriftCounter =
  | 'drift_fired'
  | 'drift_skipped_unavailable'
  | 'drift_skipped_declined_neighborhood'
  | 'drift_skipped_intent'
  | 'drift_skipped_no_summary'
  | 'drift_fastpath_explicit_intent'
  | 'drift_summary_embedding_lazy_compute'
  | 'drift_signal_disagreement';

interface DriftEmitOpts {
  /** Clearance of the requesting user; adds a UserClearance dimension when set */
  userClearance?: 'basic' | 'standard' | 'premium';
  /** Classified intent at fire time; adds an Intent dimension when set */
  intent?: string;
}

/**
 * Generic EMF emitter. Most callers should use the higher-level helpers below.
 * dimensionSets is the EMF "Dimensions" array — each inner array names a set
 * of dimension keys present in `properties`. CloudWatch creates one metric
 * per dimension set.
 */
export function emitEmfMetric(args: {
  namespace: string;
  metrics: Array<{ name: string; unit: 'Count' | 'Milliseconds' | 'Seconds' | 'None' }>;
  dimensionSets: string[][];
  properties: Record<string, string | number>;
}): void {
  const { namespace, metrics, dimensionSets, properties } = args;

  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: dimensionSets,
            Metrics: metrics,
          },
        ],
      },
      ...properties,
    })
  );
}

/**
 * Emit a per-stage timing metric for drift detection.
 *
 * Stage dimension matches SPEC-DRIFT-CONVERGENCE.md "Per-Stage Observability"
 * section. CorrelationId is a top-level property (not a dimension — too
 * high-cardinality) so it can be stitched with log lines and message
 * metadata for tracing a single user message end-to-end.
 */
export function emitDriftTiming(
  stage: DriftStage,
  latencyMs: number,
  correlationId: string,
  opts: DriftEmitOpts = {}
): void {
  const dimensionSets: string[][] = [['Stage']];
  if (opts.userClearance) dimensionSets.push(['Stage', 'UserClearance']);
  if (opts.intent) dimensionSets.push(['Stage', 'Intent']);

  const properties: Record<string, string | number> = {
    Stage: stage,
    DriftStageLatency: latencyMs,
    CorrelationId: correlationId,
  };
  if (opts.userClearance) properties.UserClearance = opts.userClearance;
  if (opts.intent) properties.Intent = opts.intent;

  emitEmfMetric({
    namespace: DRIFT_NAMESPACE,
    metrics: [{ name: 'DriftStageLatency', unit: 'Milliseconds' }],
    dimensionSets,
    properties,
  });
}

/**
 * Emit a drift-related counter (e.g., drift_fired, drift_skipped_unavailable).
 *
 * Counters fire once per occurrence with value 1; CloudWatch aggregates the
 * sum over time windows.
 */
export function emitDriftCounter(
  counter: DriftCounter,
  correlationId: string,
  opts: DriftEmitOpts = {}
): void {
  const dimensionSets: string[][] = [['Counter']];
  if (opts.userClearance) dimensionSets.push(['Counter', 'UserClearance']);
  if (opts.intent) dimensionSets.push(['Counter', 'Intent']);

  const properties: Record<string, string | number> = {
    Counter: counter,
    [counter]: 1,
    CorrelationId: correlationId,
  };
  if (opts.userClearance) properties.UserClearance = opts.userClearance;
  if (opts.intent) properties.Intent = opts.intent;

  emitEmfMetric({
    namespace: DRIFT_NAMESPACE,
    metrics: [{ name: counter, unit: 'Count' }],
    dimensionSets,
    properties,
  });
}

/**
 * Generate a UUIDv7 (time-ordered) correlation id. UUIDv7 is time-sortable
 * which makes it useful for stitching logs and metrics chronologically.
 *
 * Node 20 doesn't have crypto.randomUUID v7 yet, so we hand-roll the spec
 * shape: 48-bit Unix-ms timestamp + 12 random bits + version (7) + variant
 * + 62 random bits.
 */
export function newCorrelationId(): string {
  const now = Date.now();
  const rand = new Uint8Array(10);
  // Use globalThis.crypto when available (Node 20+), fall back to Math.random
  // — only the timestamp bits need to be precise for sort order, the random
  // bits are for uniqueness.
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < rand.length; i++) rand[i] = Math.floor(Math.random() * 256);
  }

  // 48-bit Unix-ms timestamp → first 12 hex chars
  const tsHex = now.toString(16).padStart(12, '0');
  // version 7 → high nibble of 7th byte
  const verRand = ((rand[0] & 0x0f) | 0x70).toString(16).padStart(2, '0');
  // variant bits 10xx → high two bits of 9th byte
  const varRand = ((rand[2] & 0x3f) | 0x80).toString(16).padStart(2, '0');

  const a = tsHex.slice(0, 8);
  const b = tsHex.slice(8, 12);
  const c = `${verRand}${rand[1].toString(16).padStart(2, '0')}`;
  const d = `${varRand}${rand[3].toString(16).padStart(2, '0')}`;
  const e = Array.from(rand.slice(4)).map((n) => n.toString(16).padStart(2, '0')).join('');

  return `${a}-${b}-${c}-${d}-${e}`;
}
