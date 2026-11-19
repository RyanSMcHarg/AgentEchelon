/**
 * A GUARDRAIL THAT COULD NOT BE APPLIED IS A REFUSAL, NEVER A PASS.
 *
 * The guardrail is the check between a model's words and a person, and on the way in it is the only
 * thing that scores a prompt attack. When it cannot run, nothing has been checked, so the turn
 * withholds what it would have sent: an input it could not score never reaches the model, and an output
 * it could not score never reaches the person. A person whose turn is withheld this way is told the
 * check could not be made and to try again, never that their message was refused, because nothing
 * about what they wrote was judged.
 *
 * Every occurrence is counted, by classification and by which side of the model it was on, so an
 * alarm reads a guardrail that is down or miswired (an AccessDenied on the deployment default is the
 * case seen on dev) as soon as turns start being withheld for it.
 */
import { emitEmfMetric } from './emf-metrics.js';

export const GUARDRAIL_NAMESPACE = 'AgentEchelon/Guardrail';
export const GUARDRAIL_UNAVAILABLE_METRIC = 'GuardrailUnavailable';

export function recordGuardrailUnavailable(args: {
  source: 'INPUT' | 'OUTPUT';
  classification: string;
  guardrailId: string;
  error: unknown;
}): void {
  const name = String((args.error as { name?: string })?.name || 'Error');
  console.error(`[AsyncProcessor] ${args.source} guardrail could not be applied (${name}); withholding the turn`, {
    guardrailId: args.guardrailId,
    message: (args.error as Error)?.message,
  });
  emitEmfMetric({
    namespace: GUARDRAIL_NAMESPACE,
    metrics: [{ name: GUARDRAIL_UNAVAILABLE_METRIC, unit: 'Count' }],
    dimensionSets: [['Classification'], ['Classification', 'Source']],
    properties: {
      Classification: args.classification || 'unknown',
      Source: args.source,
      ErrorName: name,
      [GUARDRAIL_UNAVAILABLE_METRIC]: 1,
    },
  });
}
