/**
 * A classification experiment must be ATTRIBUTED to the turns it changed (DESIGN §5.4).
 *
 * This is a pure test of the fallback rule the router applies, kept separate from the router's own
 * suite because the rule is the whole reason the type is measurable at all. Before it existed the
 * router resolved the classification experiment, logged it, and threw it away: no `experiment_id`
 * reached the exchange, `experiment_results` returned zero rows for the type, and §5.4's online
 * confirm - which reads exactly those rows - had nothing to measure. A gap that produces an EMPTY
 * view rather than a wrong number is the kind nobody reports, so it is pinned here.
 */

/**
 * The router's attribution rule, mirrored (`router-agent-handler.ts`, after both resolutions).
 *
 * Response-model attribution WINS. The mutual-exclusion rule guarantees the two never coexist on a
 * classification, so the order is only a safety net - but it is the right way round: if that
 * invariant ever breaks, A/B traffic keeps its own attribution and the classifier fallback goes
 * inert, rather than silently relabelling an A/B experiment's exchanges.
 */
function attribute(input: {
  responseExperimentId?: string;
  responseVariantId?: string;
  classifierExperimentId?: string;
  classifierVariantId?: string;
  /** Set only when the LLM classifier actually ran (absent on the greeting/ack fast paths). */
  classifierModelId?: string;
}): { experimentId?: string; variantId?: string } {
  let experimentId = input.responseExperimentId;
  let variantId = input.responseVariantId;
  if (!experimentId && input.classifierExperimentId && input.classifierModelId) {
    experimentId = input.classifierExperimentId;
    variantId = input.classifierVariantId;
  }
  return { experimentId, variantId };
}

describe('classification experiment attribution', () => {
  it('stamps the CLASSIFIER experiment when no response-model experiment applies', () => {
    // The case that was broken: a classification experiment is the only one live, and the turn
    // carried no attribution at all.
    expect(
      attribute({ classifierExperimentId: 'exp-classifier', classifierVariantId: 'treatment', classifierModelId: 'anthropic.claude-3-haiku' }),
    ).toEqual({ experimentId: 'exp-classifier', variantId: 'treatment' });
  });

  it('leaves an ordinary A/B turn untouched', () => {
    expect(
      attribute({ responseExperimentId: 'exp-ab', responseVariantId: 'control' }),
    ).toEqual({ experimentId: 'exp-ab', variantId: 'control' });
  });

  it('prefers the RESPONSE-MODEL attribution if both somehow resolve', () => {
    // Mutual exclusion should make this unreachable. If it becomes reachable, the A/B experiment -
    // the one whose variants actually differ in the model that answered - keeps its rows.
    expect(
      attribute({
        responseExperimentId: 'exp-ab',
        responseVariantId: 'control',
        classifierExperimentId: 'exp-classifier',
        classifierVariantId: 'treatment',
        classifierModelId: 'anthropic.claude-3-haiku',
      }),
    ).toEqual({ experimentId: 'exp-ab', variantId: 'control' });
  });

  it('attributes nothing when neither resolves', () => {
    // Ordinary traffic must not be swept into an experiment it was never assigned to.
    expect(attribute({})).toEqual({ experimentId: undefined, variantId: undefined });
  });

  it('does NOT attribute a turn the classifier never ran on', () => {
    // A greeting or acknowledgement is answered by the fast path without asking any model, so the
    // variant did nothing on that turn. Counting it would pad the experiment with exchanges it never
    // touched — the same "wrong set" error the drill-down exists to prevent, one layer earlier where
    // no reconciliation can catch it, because both the aggregate and the drill-down would agree on
    // the same inflated set.
    expect(
      attribute({ classifierExperimentId: 'exp-classifier', classifierVariantId: 'treatment' }),
    ).toEqual({ experimentId: undefined, variantId: undefined });
  });

  it('carries the variant even when it is the only thing that differs', () => {
    // Both arms of a classification experiment answer with the SAME response model, so `variant_id`
    // is the only column distinguishing them. Dropping it would collapse the two arms into one row
    // and make the experiment unreadable while still looking populated.
    const control = attribute({ classifierExperimentId: 'exp-c', classifierVariantId: 'control', classifierModelId: 'm' });
    const treatment = attribute({ classifierExperimentId: 'exp-c', classifierVariantId: 'treatment', classifierModelId: 'm' });
    expect(control.experimentId).toBe(treatment.experimentId);
    expect(control.variantId).not.toBe(treatment.variantId);
  });
});
