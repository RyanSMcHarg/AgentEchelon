/**
 * Is this error the boundary speaking?
 *
 * ONE DEFINITION, because two components now have to agree about it and they answer different
 * questions with it. `classifyAccessError` (`lib/context-source-outcomes.ts`) turns it into a context
 * source's outcome vocabulary; `resolveChannelSize` (`lib/channel-size.ts`) turns it into a routing
 * decision about whether the turn continues at all. If those two drifted, an error shape added to one
 * and not the other would mean a denial that is reported as denied in the metrics and degraded around
 * in the router, which is the exact pair of behaviors ADR-045 exists to stop disagreeing.
 *
 * MATCHES ON NAME AND ON STATUS, because the SDKs are not consistent: S3 raises `AccessDenied`, most
 * others `AccessDeniedException`, Amazon Chime SDK raises `ForbiddenException`, and a KMS refusal on an
 * encrypted object arrives as `KMSAccessDeniedException`. Status 403 is the backstop for the refusal
 * shape nobody has seen yet, and it is why a novel authorization failure classifies as a denial rather
 * than as an unknown error.
 *
 * @see recordClassificationBoundaryRefusal below, for what a component does once it has one.
 *
 * DELIBERATELY WIDER THAN THE TWO NAMES ADR-045 SKETCHES. The record names `AccessDeniedException` and
 * `ForbiddenException`; matching only those would let `NotAuthorizedException` or a bare 403 read as a
 * throttle, and a throttle is the branch that CONTINUES the turn. When the two directions are "briefly
 * silent" and "briefly acting in the wrong classification", an unrecognized refusal has to fall on the
 * silent side.
 */
import { emitEmfMetric } from './emf-metrics.js';

export function isAccessDenial(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = String(e?.name || e?.Code || '');
  return /AccessDenied|Unauthorized|Forbidden|NotAuthorized/i.test(name)
    || e?.$metadata?.httpStatusCode === 403;
}

/**
 * The metric an operator alarms on, and the log line that names the assistant and the room.
 *
 * ONE NAME, `Assistant` AS THE DIMENSION, so an alarm is a filter rather than a new metric per
 * classification - the same shape `ContextSourceFailed` uses and for the same reason.
 *
 * A RECORDER RATHER THAN AN INLINE EMIT, because the emitters in this codebase are discovered from
 * source and each one must be exercisable on its own (`test/lib/emf-schema.test.ts`). A dimension
 * named in `dimensionSets` but absent from `properties` drops the metric silently, so the alarm would
 * be watching a series that never receives a point - which is worse than no alarm, because it reads
 * as "no refusals have happened".
 */
export const BOUNDARY_REFUSAL_NAMESPACE = 'AgentEchelon/ClassificationBoundary';
export const BOUNDARY_REFUSAL_METRIC = 'AssistantRefusedByChannelClassification';

export function recordClassificationBoundaryRefusal(args: {
  channelArn: string;
  assistant: string;
  refusedAt: string;
}): void {
  console.error('[Router][SecurityEvent] assistant refused by the channel classification boundary', {
    channelArn: args.channelArn,
    assistant: args.assistant,
    refusedAt: args.refusedAt,
  });
  emitEmfMetric({
    namespace: BOUNDARY_REFUSAL_NAMESPACE,
    metrics: [{ name: BOUNDARY_REFUSAL_METRIC, unit: 'Count' }],
    dimensionSets: [['Assistant']],
    properties: {
      Assistant: args.assistant || 'unknown',
      RefusedAt: args.refusedAt,
      [BOUNDARY_REFUSAL_METRIC]: 1,
    },
  });
}
