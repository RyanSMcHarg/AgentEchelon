/**
 * Welcome-path config defects, as an alertable signal.
 *
 * The welcome path CANNOT fail loudly on its own: the welcome still lands (that invariant is the
 * point), so a missing company name, an unparseable parameter or a denied `ssm:GetParameter` produces
 * no error, no retry and no user complaint - only worse copy. Silence here is therefore
 * indistinguishable from health. Logging at ERROR plus an EMF counter is what makes it findable, and
 * puts it in reach of the same alerting as every other alertable condition
 * (SPEC-WELCOME-AND-CONTEXT, "A degraded welcome is recorded as an error").
 *
 * It lives in its own module rather than inside the router so the emitter is DRIVEABLE by
 * `test/lib/emf-schema.test.ts`, which asserts every `emitEmfMetric` caller produces a document
 * CloudWatch will actually parse. The router is not import-safe in a unit test (module-level clients,
 * required env), so an emitter buried in it can only be covered by duplicating its shape in the test -
 * and a duplicated shape drifts, leaving the test validating its own copy. That is the exact failure
 * mode the EMF suite exists to catch: `Metrics: [{name, unit}]` passed every unit test while
 * CloudWatch silently discarded the document, because the schema requires `{Name, Unit}`.
 */
import { emitEmfMetric } from './emf-metrics.js';

export const WELCOME_METRIC_NAMESPACE = 'AgentEchelon/Welcome';

export function recordWelcomeConfigDefect(args: {
  classification: string;
  reason: 'unusable' | 'incomplete';
  detail: string[];
}): void {
  const { classification, reason, detail } = args;
  console.error('[Router][WelcomeIntent][ConfigDefect]', JSON.stringify({ classification, reason, detail }));
  const metricName = reason === 'unusable' ? 'welcome_orientation_unusable' : 'welcome_orientation_incomplete';
  emitEmfMetric({
    namespace: WELCOME_METRIC_NAMESPACE,
    metrics: [{ name: metricName, unit: 'Count' }],
    dimensionSets: [['Classification']],
    // A metric's VALUE is a root property keyed by the metric's own NAME. This previously carried a
    // literal `Count: 1`, so `welcome_orientation_incomplete` resolved to undefined and CloudWatch
    // dropped the datapoint: the namespace looked healthy while recording nothing, which is the same
    // silent-discard failure as the lowercase Name/Unit bug.
    //
    // `Classification` is named in the dimension set above, so it must be present for the same reason.
    properties: { Classification: classification || 'unknown', [metricName]: 1, detail: detail.join('; ') },
  });
}
