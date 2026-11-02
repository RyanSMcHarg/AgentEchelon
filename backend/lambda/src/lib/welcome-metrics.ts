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

/**
 * THE CONFIG DEFECTS ONE WELCOME RECORDS, decided from what was read and what was posted.
 *
 * Each defect describes the source the posted copy came from. The orientation's own parse issues are reported
 * whichever source carried them (the deployment parameter or the version's fields). The clause assembly's
 * shortfalls (the generic copy, a deployment field left out) are reported only when the assembly is what the room
 * read: where the assistant's own welcome template rendered, the template is the copy, the parameter was not read,
 * and the assembly describes text nobody saw.
 */
export function welcomeConfigDefects(args: {
  classification: string;
  /** The deployment parameter's name, for the detail. */
  param: string | undefined;
  /** What `loadWelcomeFor` read. */
  loaded: { orientation: unknown; expected: boolean; issues: string[] };
  /** True when the assistant's own welcome template rendered and is the text posted. */
  usedTemplate: boolean;
  /** The clause assembly. */
  composition: { variant: string; missingFields: readonly string[]; usedGenericFallback: boolean };
}): Array<Parameters<typeof recordWelcomeConfigDefect>[0]> {
  const { classification, param, loaded, usedTemplate, composition } = args;
  const defects: Array<Parameters<typeof recordWelcomeConfigDefect>[0]> = [];
  if (loaded.expected && loaded.issues.length > 0) {
    defects.push({ classification, reason: loaded.orientation || usedTemplate ? 'incomplete' : 'unusable', detail: loaded.issues });
  } else if (loaded.expected && !usedTemplate && composition.usedGenericFallback) {
    // The parameter is declared and read cleanly, yet nothing usable came back.
    defects.push({ classification, reason: 'unusable', detail: [`${param} yielded no orientation, so the generic welcome was served`] });
  }
  if (!usedTemplate && composition.variant === 'oriented' && composition.missingFields.length > 0) {
    defects.push({
      classification,
      reason: 'incomplete',
      detail: [`orientation omitted these fields from the welcome: ${composition.missingFields.join(', ')}`],
    });
  }
  return defects;
}

/**
 * A `prompt` welcome's outcome (SPEC-WELCOME-AND-CONTEXT FR24): `posted`, or `fallback:<reason>` when the structured
 * opening stood alone. Every outcome is logged. A posted greeting is a message the archive records with its turn kind
 * (`turnKind: 'welcome'`), so only a fallback, which posts nothing and so reaches no archive, is counted here, by
 * reason (tenet D7: no metric counts what the ledger already counts).
 */
export function recordWelcomePromptOutcome(outcome: string, detail: Record<string, unknown> = {}): void {
  // A greeting the Amazon Chime SDK refused is said at warning level: nobody was greeted, and an operator should see it.
  (outcome === 'fallback:post-failed' ? console.warn : console.log)('[WelcomePrompt] outcome', JSON.stringify({ outcome, ...detail }));
  if (!outcome.startsWith('fallback:')) return;
  emitEmfMetric({
    namespace: WELCOME_METRIC_NAMESPACE,
    metrics: [{ name: 'welcome_prompt_fallback', unit: 'Count' }],
    dimensionSets: [['Reason']],
    properties: { Reason: outcome.slice('fallback:'.length) || 'unknown', welcome_prompt_fallback: 1 },
  });
}
