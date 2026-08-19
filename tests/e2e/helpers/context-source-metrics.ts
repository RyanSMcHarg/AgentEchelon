/**
 * Read the context source outcome metrics a live turn emitted.
 *
 * Why this exists. A context source's whole visible effect is that the assistant's answer is better
 * grounded - which a UI assertion cannot distinguish from RAG, from the company-context tool, or from
 * the model simply knowing the answer. Three different mechanisms feed the same prompt, so asserting
 * on the reply text proves "something grounded it", never "the catalog ran".
 *
 * `AgentEchelon/ContextSources` is the discriminator: it is emitted by the resolver and by nothing
 * else, so a datapoint for a source key is proof that the deployed path executed for this turn.
 *
 * The CloudWatch mechanics live in `cw-metrics.ts`, which every namespace shares; this module is the
 * context-source vocabulary on top of it (which dimension set the resolver declares, which outcome
 * names are legal).
 */
import { sumMetric, waitForMetric } from './cw-metrics';

export { metricCheckEnabled, METRIC_CHECK_DISABLED } from './cw-metrics';

export const CONTEXT_SOURCE_NAMESPACE = 'AgentEchelon/ContextSources';

export interface OutcomeQuery {
  classification: string;
  outcome: string;
  /** Omit to read the whole classification rather than one source. */
  sourceKey?: string;
  metricName: 'ContextSourceResolved' | 'ContextSourceFailed' | 'ContextSourceSkipped' | 'ContextSourceFieldFailed';
  sinceEpochMs: number;
}

/** The dimension set the resolver declares, in the order CloudWatch stores it. */
function dimensionsFor(q: OutcomeQuery): Record<string, string> {
  return {
    Classification: q.classification,
    Outcome: q.outcome,
    ...(q.sourceKey ? { SourceKey: q.sourceKey } : {}),
  };
}

/**
 * Sum of one outcome metric since `sinceEpochMs`.
 *
 * Returns 0 when there is no data, which is a real answer: "the resolver did not report this
 * outcome". The caller decides whether that is a pass or a failure.
 */
export async function sumOutcome(q: OutcomeQuery): Promise<number> {
  return sumMetric({
    namespace: CONTEXT_SOURCE_NAMESPACE,
    metricName: q.metricName,
    dimensions: dimensionsFor(q),
    sinceEpochMs: q.sinceEpochMs,
  });
}

/**
 * Poll until an outcome is reported, or give up.
 *
 * EMF metrics are extracted from the log stream asynchronously, so a turn's datapoint is not visible
 * the instant the reply renders. Polling rather than one sleep keeps a fast path fast and still gives
 * a slow ingestion time to land.
 */
export async function waitForOutcome(
  q: OutcomeQuery,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  return waitForMetric(
    {
      namespace: CONTEXT_SOURCE_NAMESPACE,
      metricName: q.metricName,
      dimensions: dimensionsFor(q),
      sinceEpochMs: q.sinceEpochMs,
    },
    opts,
  );
}
