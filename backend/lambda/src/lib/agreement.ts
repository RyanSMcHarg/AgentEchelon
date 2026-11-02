/**
 * HOW FAR A JUDGE AGREES WITH PEOPLE, PER RUBRIC (SPEC-EVALUATION Appendix C4, FR15).
 *
 * A 2x2 of verdicts, with "positive" meaning the failure the rubric exists to catch (a poor answer, a
 * breach, an unsupported claim). Raw agreement flatters a judge on a population where failures are rare,
 * because saying "fine" to everything agrees almost always; so the agreement is reported as Cohen's
 * kappa, which removes the agreement chance alone would produce, beside the two rates that say which way
 * the judge errs:
 *
 *   tpr  of the failures people found, the share the judge also found (it catches what matters)
 *   tnr  of what people passed, the share the judge also passed (it does not cry wolf)
 *
 * Every figure is null where its denominator is zero: an unmeasured judge has no agreement, not 100%.
 *
 * Pure, so the arithmetic is pinned by unit tests rather than trusted inside a query.
 */
export interface AgreementCounts {
  /** Both said failure. */
  tp: number;
  /** The judge said failure, the person said pass. */
  fp: number;
  /** The judge said pass, the person said failure. */
  fn: number;
  /** Both said pass. */
  tn: number;
}

export interface Agreement extends AgreementCounts {
  n: number;
  kappa: number | null;
  tpr: number | null;
  tnr: number | null;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export function agreementOf(c: AgreementCounts): Agreement {
  const tp = Math.max(0, Number(c.tp) || 0);
  const fp = Math.max(0, Number(c.fp) || 0);
  const fn = Math.max(0, Number(c.fn) || 0);
  const tn = Math.max(0, Number(c.tn) || 0);
  const n = tp + fp + fn + tn;
  let kappa: number | null = null;
  if (n > 0) {
    const po = (tp + tn) / n;
    const pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n);
    // Both raters said the same single class for every item: agreement is total and chance explains all
    // of it, so kappa is undefined rather than 1 or 0. Reported as null, with n beside it.
    kappa = pe === 1 ? null : round3((po - pe) / (1 - pe));
  }
  return {
    tp, fp, fn, tn, n,
    kappa,
    tpr: tp + fn > 0 ? round3(tp / (tp + fn)) : null,
    tnr: tn + fp > 0 ? round3(tn / (tn + fp)) : null,
  };
}

/**
 * A model id without its cross-region inference prefix, so `us.anthropic.claude-x` and
 * `anthropic.claude-x` compare equal. Used to report a judge that is the model it is judging.
 */
export function baseModelId(id: string | null | undefined): string {
  return String(id ?? '').replace(/^(us|eu|apac|global|us-gov)\./, '');
}
