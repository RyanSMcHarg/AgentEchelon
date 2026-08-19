/**
 * Context source OUTCOMES: the vocabulary, the typed failure, and the CloudWatch signal.
 *
 * Why this module exists. Context sources degrade silently by design (INV-CTX-CAT-4: one bad source
 * costs its own section, never the turn). That is correct for the user and useless for an operator:
 * "the assistant answered without the HR policy" looks exactly like "the assistant had nothing to say
 * about HR". Worse, the two failures an admin most needs to tell apart - "IAM refused the read" and
 * "the object is not there" - both arrived as the same `null`.
 *
 * So a failure is CLASSIFIED at the point it happens and emitted as a metric with the reason as a
 * dimension. `denied` is the one that means a boundary was tested; the others are configuration or
 * latency. An alarm on undifferentiated failure would be noise, and noise gets muted.
 *
 * Metric names are deliberately few. One name per disposition, with `Outcome` as the dimension, so an
 * alarm is a filter rather than a new metric per reason:
 *
 *   ContextSourceResolved   Outcome=resolved                        the value reached the prompt
 *   ContextSourceFailed     Outcome=denied|absent|timeout|error     it was selected and did not
 *   ContextSourceSkipped    Outcome=not-in-catalog|unavailable      it was never attempted
 *
 * `resolved` carries an Outcome dimension too, which is redundant on its own but keeps every metric in
 * this namespace the same shape - an operator writes one alarm expression, not three.
 */
import { emitEmfMetric } from './emf-metrics.js';

export const CONTEXT_SOURCE_NAMESPACE = 'AgentEchelon/ContextSources';

/**
 * A source was selected and attempted, and did not produce a value.
 *
 * `denied`  authorisation refused. The grant is missing, wrong, or the boundary was probed.
 * `absent`  the resource, record or attribute is not there. A configuration or content gap.
 * `timeout` still outstanding at the resolution deadline (INV-CTX-CAT-5). A latency problem.
 * `error`   anything else, including a malformed catalog entry or an unwired client.
 */
export type ContextSourceFailure = 'denied' | 'absent' | 'timeout' | 'error';

/**
 * A source was never attempted.
 *
 * `not-in-catalog` the profile names a key this classification does not publish. Expected during a
 *                  removal, a standing defect otherwise - it recurs on EVERY turn.
 * `unavailable`    `availability` is unmet at this call site. Normal, and the reason it is measured is
 *                  that a source unavailable on every turn is a mislabelled source.
 */
export type ContextSourceSkip = 'not-in-catalog' | 'unavailable';

export type ContextSourceOutcome = 'resolved' | ContextSourceFailure | ContextSourceSkip;

/**
 * A metric for one FIELD that failed inside a source that still resolved.
 *
 * Deliberately not `ContextSourceFailed`. An `s3-prefix` source reads one object per field, and a
 * non-refusal failure on one of them (a throttle, a malformed body) is worth counting but must not
 * enter the failure RATE: the same source would then contribute to both the numerator and the
 * denominator of failed/(failed+resolved), and the percentage an operator reads would no longer mean
 * "sources that failed over sources attempted". Its own metric keeps the rate honest and the partial
 * read visible.
 */
export const FIELD_FAILURE_METRIC = 'ContextSourceFieldFailed';

const METRIC_BY_OUTCOME: Record<ContextSourceOutcome, string> = {
  resolved: 'ContextSourceResolved',
  denied: 'ContextSourceFailed',
  absent: 'ContextSourceFailed',
  timeout: 'ContextSourceFailed',
  error: 'ContextSourceFailed',
  'not-in-catalog': 'ContextSourceSkipped',
  unavailable: 'ContextSourceSkipped',
};

/**
 * A reader's failure, carrying WHY. Readers throw this instead of returning null when they know the
 * reason, which is the only way `denied` ever reaches a metric - an SDK error caught and discarded is
 * indistinguishable from an empty result by the time the resolver sees it.
 */
export class ContextSourceAccessError extends Error {
  constructor(
    readonly reason: ContextSourceFailure,
    readonly sourceKey: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ContextSourceAccessError';
  }
}

/**
 * Classify an AWS SDK error into an outcome.
 *
 * Matches on the error NAME and on the HTTP status, because the SDKs are not consistent: S3 raises
 * `AccessDenied`, most others `AccessDeniedException`, and a KMS refusal on an encrypted object
 * arrives as `KMSAccessDeniedException`. Status is the backstop for anything not named here.
 *
 * Unknown errors classify as `error`, never as `absent`. Guessing "absent" would silently reclassify a
 * novel authorisation failure as a content gap, which is the exact fail-open this module exists to
 * close.
 */
export function classifyAccessError(err: unknown): ContextSourceFailure {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = String(e?.name || e?.Code || '');
  const status = e?.$metadata?.httpStatusCode;

  if (/AccessDenied|Unauthorized|Forbidden|NotAuthorized/i.test(name) || status === 403) return 'denied';
  if (/NoSuchKey|NoSuchBucket|NotFound|ParameterNotFound|ResourceNotFound/i.test(name) || status === 404) {
    return 'absent';
  }
  if (status === 408 || /TimeoutError|RequestTimeout/i.test(name)) return 'timeout';
  return 'error';
}

/**
 * Emit one outcome for one source.
 *
 * THREE dimension sets, and the first one is what makes a rate alarm possible:
 *
 *   [Classification]                    every failure, whatever the reason. The alarm divides this
 *                                       by resolved+failed to get a failure PERCENTAGE
 *   [Classification, Outcome]           why it is failing, once you are looking
 *   [Classification, Outcome, SourceKey] which source, once you are paged
 *
 * Without the first, "all failures for this classification" is a metric-math SUM over one series per
 * outcome - clumsy, and silently wrong the day an outcome is added and the expression is not updated.
 * The un-dimensioned rollup costs nothing to emit and cannot go stale.
 *
 * Source keys are operator-authored and bounded (16 per profile), so the cardinality is safe.
 */
export function emitContextSourceOutcome(args: {
  classification: string;
  sourceKey: string;
  outcome: ContextSourceOutcome;
}): void {
  const { classification, sourceKey, outcome } = args;
  const metricName = METRIC_BY_OUTCOME[outcome];
  if (!metricName) return;

  emitEmfMetric({
    namespace: CONTEXT_SOURCE_NAMESPACE,
    metrics: [{ name: metricName, unit: 'Count' }],
    dimensionSets: [
      ['Classification'],
      ['Classification', 'Outcome'],
      ['Classification', 'Outcome', 'SourceKey'],
    ],
    properties: {
      Classification: classification,
      Outcome: outcome,
      SourceKey: sourceKey,
      [metricName]: 1,
    },
  });
}

/**
 * Count one field that failed inside a source that may still resolve. See {@link FIELD_FAILURE_METRIC}
 * for why this is a separate metric rather than another `ContextSourceFailed`.
 */
export function emitContextSourceFieldFailure(args: {
  classification: string;
  sourceKey: string;
  field: string;
  reason: ContextSourceFailure;
}): void {
  const { classification, sourceKey, field, reason } = args;
  emitEmfMetric({
    namespace: CONTEXT_SOURCE_NAMESPACE,
    metrics: [{ name: FIELD_FAILURE_METRIC, unit: 'Count' }],
    dimensionSets: [
      ['Classification'],
      ['Classification', 'Outcome'],
      ['Classification', 'Outcome', 'SourceKey'],
    ],
    properties: {
      Classification: classification,
      Outcome: reason,
      SourceKey: sourceKey,
      // Not a dimension: field names are per-source and would multiply cardinality for a value that
      // is only useful once you are already reading the log line.
      Field: field,
      [FIELD_FAILURE_METRIC]: 1,
    },
  });
}
