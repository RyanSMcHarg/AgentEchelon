/**
 * Experiment statistics (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §4, Appendix A.6).
 *
 * Pure, dependency-free statistics used to turn per-variant experiment metrics
 * into an HONEST, ADVISORY recommendation. Nothing here routes traffic or picks
 * a winner on its own (INV-1/INV-4): the functions compute confidence and a
 * pre-registered decision verdict; the operator still decides, and the human
 * battle pick is a DISTINCT axis that is never blended into one number (INV-3).
 *
 * Design choices:
 * - Proportions use a Wilson score interval (robust at small n) and a
 *   two-proportion z-test with a Fisher's-exact fallback when a cell is small.
 *   The CI on the difference uses Newcombe's hybrid-score method (pairs with
 *   Wilson, robust at small n).
 * - Continuous metrics use Welch's t-test (unequal variance) → p-value + CI.
 * - Power/MDE uses the standard z-based sample-size formula for ~80% power.
 *
 * All math (normal/t CDFs, incomplete beta, log-gamma) is implemented locally so
 * the analytics Lambda pulls in no numeric dependency.
 */

// ---------------------------------------------------------------------------
// Low-level special functions (local, no deps)
// ---------------------------------------------------------------------------

/** Complementary error function, |error| < 1.2e-7 (Numerical Recipes erfcc). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? ans : 2 - ans;
}

/** Standard normal CDF Φ(x). */
export function normalCdf(x: number): number {
  return 1 - 0.5 * erfc(x / Math.SQRT2);
}

/**
 * Two-sided standard-normal tail probability P(|Z| ≥ |z|) = erfc(|z|/√2).
 * This is the p-value for a z-statistic.
 */
export function normalTwoSidedP(z: number): number {
  return Math.min(1, Math.max(0, erfc(Math.abs(z) / Math.SQRT2)));
}

/**
 * Inverse standard-normal CDF (quantile). Acklam's rational approximation,
 * |error| < 1.15e-9. Used to turn a target power / significance into a z-score.
 */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Log-gamma via Lanczos approximation. */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Log of the binomial coefficient C(n, k). */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Regularized incomplete beta I_x(a, b) via the Numerical Recipes continued fraction. */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  const betacf = (aa: number, bb: number, xx: number): number => {
    const MAXIT = 200;
    const EPS = 3e-12;
    const FPMIN = 1e-300;
    const qab = aa + bb;
    const qap = aa + 1;
    const qam = aa - 1;
    let cc = 1;
    let d = 1 - (qab * xx) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aaa = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
      d = 1 + aaa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      cc = 1 + aaa / cc;
      if (Math.abs(cc) < FPMIN) cc = FPMIN;
      d = 1 / d;
      h *= d * cc;
      aaa = (-(aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
      d = 1 + aaa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      cc = 1 + aaa / cc;
      if (Math.abs(cc) < FPMIN) cc = FPMIN;
      d = 1 / d;
      const del = d * cc;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  };
  // Use the symmetry-optimized branch for convergence.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Student's-t two-sided tail probability P(|T| ≥ |t|) with df degrees of freedom. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!(df > 0) || !Number.isFinite(t)) return 1;
  const x = df / (df + t * t);
  return Math.min(1, Math.max(0, incompleteBeta(df / 2, 0.5, x)));
}

/** Student's-t CDF (used to invert for a critical value). */
function studentTCdf(t: number, df: number): number {
  const tail = studentTTwoSidedP(t, df); // = P(|T| >= |t|)
  return t >= 0 ? 1 - tail / 2 : tail / 2;
}

/** Two-sided Student's-t critical value t* such that P(-t* < T < t*) = 1 - alpha. */
export function studentTCritical(df: number, alpha: number): number {
  const target = 1 - alpha / 2; // upper-tail quantile
  // Bisection on the monotone CDF.
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Proportions: Wilson interval, two-proportion test, Newcombe difference CI
// ---------------------------------------------------------------------------

export interface ProportionInterval {
  /** Observed proportion successes / n (0 when n = 0). */
  point: number;
  lower: number;
  upper: number;
  n: number;
}

/**
 * Wilson score interval on a proportion. Robust at small n (unlike the normal
 * approximation, which can leave [0,1]). `z` is the standard-normal critical
 * value (default 1.96 ≈ 95%).
 */
export function wilsonInterval(successes: number, n: number, z = 1.959963985): ProportionInterval {
  if (n <= 0) return { point: 0, lower: 0, upper: 0, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    n,
  };
}

export interface TwoProportionResult {
  /** pA − pB (the caller orients A vs B). */
  delta: number;
  /** Newcombe hybrid-score CI on the difference. */
  ci: [number, number];
  pValue: number;
  /** 'z' for the two-proportion z-test; 'fisher' when a cell was small. */
  method: 'z' | 'fisher';
  pA: number;
  pB: number;
}

/**
 * Fisher's exact two-sided p-value for a 2×2 table. Sums hypergeometric
 * probabilities of all tables (same margins) no more likely than the observed.
 */
function fisherExactTwoSided(xA: number, nA: number, xB: number, nB: number): number {
  const N = nA + nB;
  const k = xA + xB; // total successes
  const logHyper = (a: number): number => logChoose(nA, a) + logChoose(nB, k - a) - logChoose(N, k);
  const pObs = logHyper(xA);
  const lo = Math.max(0, k - nB);
  const hi = Math.min(k, nA);
  let sum = 0;
  const EPS = 1e-7;
  for (let a = lo; a <= hi; a++) {
    const lp = logHyper(a);
    if (lp <= pObs + EPS) sum += Math.exp(lp);
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * Compare two proportions. Uses a two-proportion z-test (pooled SE) for the
 * p-value, or Fisher's exact when any cell count is small (< 5). The CI on the
 * difference always uses Newcombe's hybrid-score method (pairs with Wilson,
 * robust at small n). delta = pA − pB.
 */
export function twoProportionTest(
  xA: number,
  nA: number,
  xB: number,
  nB: number,
  z = 1.959963985,
): TwoProportionResult {
  const pA = nA > 0 ? xA / nA : 0;
  const pB = nB > 0 ? xB / nB : 0;
  const delta = pA - pB;

  // Newcombe (method 10) CI on the difference, from the two Wilson intervals.
  const wa = wilsonInterval(xA, nA, z);
  const wb = wilsonInterval(xB, nB, z);
  const lower = delta - Math.sqrt((pA - wa.lower) ** 2 + (wb.upper - pB) ** 2);
  const upper = delta + Math.sqrt((wa.upper - pA) ** 2 + (pB - wb.lower) ** 2);
  const ci: [number, number] = [Math.max(-1, lower), Math.min(1, upper)];

  // Small-cell guard → Fisher's exact for the p-value.
  const cells = [xA, nA - xA, xB, nB - xB];
  const smallCell = nA === 0 || nB === 0 || cells.some((c) => c < 5);
  if (smallCell) {
    return { delta, ci, pValue: fisherExactTwoSided(xA, nA, xB, nB), method: 'fisher', pA, pB };
  }

  const pooled = (xA + xB) / (nA + nB);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  const zStat = sePooled > 0 ? delta / sePooled : 0;
  return { delta, ci, pValue: normalTwoSidedP(zStat), method: 'z', pA, pB };
}

// ---------------------------------------------------------------------------
// Continuous metrics: Welch's t-test
// ---------------------------------------------------------------------------

export interface WelchResult {
  /** meanA − meanB. */
  delta: number;
  ci: [number, number];
  pValue: number;
  t: number;
  df: number;
}

/**
 * Welch's t-test for two independent samples with unequal variance, from
 * summary stats (mean, sample SD, n) for each side. Returns the mean difference
 * (A − B), its two-sided p-value, and a CI on the difference. `alpha` sets the
 * CI level (default 0.05 ⇒ 95%).
 */
export function welchTTest(
  meanA: number,
  sdA: number,
  nA: number,
  meanB: number,
  sdB: number,
  nB: number,
  alpha = 0.05,
): WelchResult {
  const delta = meanA - meanB;
  const vA = (sdA * sdA) / Math.max(1, nA);
  const vB = (sdB * sdB) / Math.max(1, nB);
  const se = Math.sqrt(vA + vB);
  if (!(se > 0) || nA < 2 || nB < 2) {
    // Degenerate (no variance / too few samples) — report no significance honestly.
    return { delta, ci: [delta, delta], pValue: 1, t: 0, df: Math.max(1, nA + nB - 2) };
  }
  const t = delta / se;
  const df = (vA + vB) ** 2 / (vA ** 2 / (nA - 1) + vB ** 2 / (nB - 1));
  const pValue = studentTTwoSidedP(t, df);
  const tCrit = studentTCritical(df, alpha);
  const ci: [number, number] = [delta - tCrit * se, delta + tCrit * se];
  return { delta, ci, pValue, t, df };
}

/**
 * Pool per-subgroup (mean, sd, n) into one combined (mean, sd, n) — used to roll
 * per-intent variant rows up to a single variant-level continuous stat before a
 * Welch test. Uses the exact between/within decomposition of the sum of squares.
 */
export interface GroupStat {
  n: number;
  mean: number;
  sd: number;
}

export function poolGroups(groups: GroupStat[]): GroupStat {
  const valid = groups.filter((g) => g.n > 0 && Number.isFinite(g.mean));
  const N = valid.reduce((s, g) => s + g.n, 0);
  if (N <= 0) return { n: 0, mean: 0, sd: 0 };
  const grandMean = valid.reduce((s, g) => s + g.mean * g.n, 0) / N;
  if (N === 1) return { n: 1, mean: grandMean, sd: 0 };
  let ss = 0;
  for (const g of valid) {
    const sd = Number.isFinite(g.sd) ? g.sd : 0;
    ss += (g.n - 1) * sd * sd + g.n * (g.mean - grandMean) ** 2;
  }
  return { n: N, mean: grandMean, sd: Math.sqrt(Math.max(0, ss / (N - 1))) };
}

// ---------------------------------------------------------------------------
// Power / minimum detectable effect
// ---------------------------------------------------------------------------

export interface PowerResult {
  /** Sample size per variant needed for the target power at the given MDE. */
  requiredN: number;
  /** Effect size the requirement was computed for (metric's own units). */
  mde: number;
  /** currentN ≥ requiredN. */
  powered: boolean;
  currentN: number;
  /** max(0, requiredN − currentN). */
  additionalNeeded: number;
}

function powerZ(power: number, alpha: number): number {
  return normalInv(1 - alpha / 2) + normalInv(power);
}

/**
 * Sample size per variant for ~`power` (default 0.8) to detect an absolute
 * proportion difference `mde` off `baseline`, at two-sided `alpha` (default 0.05).
 */
export function requiredSampleForProportion(
  baseline: number,
  mde: number,
  currentN: number,
  opts: { power?: number; alpha?: number } = {},
): PowerResult {
  const power = opts.power ?? 0.8;
  const alpha = opts.alpha ?? 0.05;
  const absMde = Math.abs(mde);
  if (absMde <= 0) {
    return { requiredN: Infinity, mde: absMde, powered: false, currentN, additionalNeeded: Infinity };
  }
  const p1 = Math.min(1, Math.max(0, baseline));
  const p2 = Math.min(1, Math.max(0, baseline + mde));
  const zSum = powerZ(power, alpha);
  const requiredN = Math.ceil((zSum * zSum * (p1 * (1 - p1) + p2 * (1 - p2))) / (absMde * absMde));
  return {
    requiredN,
    mde: absMde,
    powered: currentN >= requiredN,
    currentN,
    additionalNeeded: Math.max(0, requiredN - currentN),
  };
}

/**
 * Sample size per variant for ~`power` (default 0.8) to detect a mean difference
 * `mde` given the metric's SD `sd`, at two-sided `alpha` (default 0.05).
 */
export function requiredSampleForMean(
  sd: number,
  mde: number,
  currentN: number,
  opts: { power?: number; alpha?: number } = {},
): PowerResult {
  const power = opts.power ?? 0.8;
  const alpha = opts.alpha ?? 0.05;
  const absMde = Math.abs(mde);
  if (absMde <= 0 || !(sd > 0)) {
    // No detectable effect defined, or no variance to fight — cannot claim power.
    const requiredN = absMde <= 0 ? Infinity : 2;
    return { requiredN, mde: absMde, powered: currentN >= requiredN, currentN, additionalNeeded: Math.max(0, requiredN - currentN) };
  }
  const zSum = powerZ(power, alpha);
  const requiredN = Math.ceil((zSum * zSum * 2 * sd * sd) / (absMde * absMde));
  return {
    requiredN,
    mde: absMde,
    powered: currentN >= requiredN,
    currentN,
    additionalNeeded: Math.max(0, requiredN - currentN),
  };
}

// ---------------------------------------------------------------------------
// Significance-aware winner labeling + confidence mapping (§4.2-C/E)
// ---------------------------------------------------------------------------

export type WinnerLabel = 'no difference' | 'leads (not significant)' | 'leads (p<0.05)' | 'leads (p<0.01)';

/**
 * Honest per-metric label (§4.2-C). A point lead on thin data reads
 * "leads (not significant)"; a CI that straddles 0 with a negligible point
 * estimate reads "no difference". `epsilon` (metric units) sets what counts as
 * "no difference" when not significant.
 */
export function winnerLabel(delta: number, ci: [number, number], pValue: number, epsilon = 0): WinnerLabel {
  if (pValue < 0.01) return 'leads (p<0.01)';
  if (pValue < 0.05) return 'leads (p<0.05)';
  const crossesZero = ci[0] <= 0 && ci[1] >= 0;
  if (Math.abs(delta) <= epsilon && crossesZero) return 'no difference';
  return 'leads (not significant)';
}

export type Confidence = 'low' | 'medium' | 'high';

/**
 * Confidence tied to the STATISTIC (§4.2-E), not an LLM opinion:
 *  high   = primary significant at p<0.01 AND powered AND all guardrails held
 *  medium = significant at p<0.05 AND guardrails held
 *  low    = not significant, underpowered, or a guardrail regressed
 */
export function mapConfidence(input: { primaryPValue: number; powered: boolean; guardrailsHeld: boolean }): Confidence {
  const { primaryPValue, powered, guardrailsHeld } = input;
  if (primaryPValue < 0.01 && powered && guardrailsHeld) return 'high';
  if (primaryPValue < 0.05 && guardrailsHeld) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Human battle-pick binomial (§4.3)
// ---------------------------------------------------------------------------

export interface HumanPickResult {
  /** Total decisive picks (ties excluded by the caller). */
  picks: number;
  /** Wins for side A (the treatment, by convention). */
  wins: number;
  /** wins / picks (0 when picks = 0). */
  winRate: number;
  /** Wilson CI on the win rate. */
  ci: [number, number];
  /** True when the Wilson CI excludes 50% — a real human preference. */
  significant: boolean;
  /** Two-sided exact binomial p-value against 50%. */
  pValue: number;
  /** Which side the humans favor ('a' = treatment, 'b' = control, 'none' = tie). */
  favors: 'a' | 'b' | 'none';
}

/** Two-sided exact binomial p-value for `wins` of `n` against p₀ = 0.5. */
function binomialTwoSidedP(wins: number, n: number): number {
  if (n <= 0) return 1;
  const logP = (k: number): number => logChoose(n, k) + n * Math.log(0.5);
  const pObs = logP(wins);
  const EPS = 1e-7;
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    if (logP(k) <= pObs + EPS) sum += Math.exp(logP(k));
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * The human battle-pick signal as a binomial preference test (§4.3): a distinct
 * axis, never blended into the metric verdict. `wins` = decisive picks for side
 * A (treatment); `decisive` = total decisive picks (ties excluded, or counted
 * as ½ by the caller before calling).
 */
export function humanPickTest(wins: number, decisive: number, z = 1.959963985): HumanPickResult {
  if (decisive <= 0) {
    return { picks: 0, wins: 0, winRate: 0, ci: [0, 0], significant: false, pValue: 1, favors: 'none' };
  }
  const wilson = wilsonInterval(wins, decisive, z);
  const winRate = wins / decisive;
  const significant = wilson.lower > 0.5 || wilson.upper < 0.5;
  const favors: 'a' | 'b' | 'none' = winRate > 0.5 ? 'a' : winRate < 0.5 ? 'b' : 'none';
  return {
    picks: decisive,
    wins,
    winRate,
    ci: [wilson.lower, wilson.upper],
    significant,
    pValue: binomialTwoSidedP(wins, decisive),
    favors,
  };
}

/**
 * THE ACCURACY MARGIN: how much classifier accuracy may fall before a change is refused.
 *
 * Two percentage points, expressed as a non-inferiority margin. It is the default bound for an
 * `accuracy` guardrail, and the gate's ship criterion for a classification experiment: a challenger
 * classifier is acceptable when the confidence interval on the accuracy difference sits entirely
 * within this margin (see {@link evaluateOutcomeGuardrail}), NOT merely when the point estimate does.
 *
 * WHY TWO POINTS. Intent accuracy converts directly into routing: a point of accuracy is roughly a
 * point of traffic sent to the wrong specialist, and that error is not recovered downstream. Two
 * points is tight enough that a real regression cannot hide inside it, and loose enough that a
 * materially cheaper or faster classifier is not blocked by noise-level differences.
 *
 * IT IS A DEFAULT, NOT A LAW. An experiment may set its own bound on the guardrail, and that always
 * wins - this is what the console pre-fills and what applies when nothing is stated. A deployment
 * where misrouting is expensive should tighten it; one exploring a much cheaper model may loosen it
 * deliberately, in writing, before seeing the result (§1.2 pre-registration).
 *
 * MAKING IT DEPLOYMENT-ADJUSTABLE LATER is the same one-line change `MIN_SAMPLE_PER_VARIANT` already
 * models: read `process.env.ACCURACY_MARGIN_PCT` here, and add an `accuracyMarginPct` context key on
 * the analytics stack that sets it. Deliberately NOT done yet: a second tunable is only worth its
 * configuration surface once a real deployment has asked for a different number, and a default nobody
 * has questioned is better left in one obvious place than spread across a context key, a stack and a
 * doc.
 */
export const DEFAULT_ACCURACY_MARGIN_PCT = 2;

/**
 * McNemar's exact test, for PAIRED binary outcomes (DESIGN §5.3).
 *
 * Two classifiers label the same message. Once adjudicated each message falls into one of four cells:
 * both right, both wrong, or exactly one right. **Only the discordant cells carry information about
 * which model is better** - where both agree, the pair cannot favour either, whatever the truth. So the
 * agreements are dropped and the question becomes: among the messages where exactly one was right, did
 * the challenger win more often than chance?
 *
 * Deliberately a separate function rather than an alias of {@link humanPickTest}, even though the
 * arithmetic is identical (a two-sided exact binomial against p=0.5, plus a Wilson interval). The two
 * make different CLAIMS: a battle pick is a human PREFERENCE between two answers, a discordant pair is
 * a CORRECTNESS judgement against a label. Sharing a name would invite reading one as the other, and
 * they need their own tests for the same reason.
 *
 * @param challengerOnlyRight discordant pairs the challenger got right and the incumbent wrong
 * @param incumbentOnlyRight  discordant pairs the incumbent got right and the challenger wrong
 * @returns null when there are NO discordant pairs - the models are indistinguishable on this corpus,
 *          which is a real finding ("do not bother splitting traffic") and not a 50/50 result
 */
export function mcnemarTest(
  challengerOnlyRight: number,
  incumbentOnlyRight: number,
): HumanPickResult | null {
  const discordant = challengerOnlyRight + incumbentOnlyRight;
  if (discordant <= 0) return null;
  return humanPickTest(challengerOnlyRight, discordant);
}

// ---------------------------------------------------------------------------
// Combined verdict decision rule (§4.4)
// ---------------------------------------------------------------------------

export type Verdict = 'promote_treatment' | 'keep_control' | 'keep_running' | 'equivalent' | 'inconclusive';

/** Primary-metric evaluation, direction already resolved into `favors`. */
export interface PrimaryEval {
  metric: string;
  deltaPct: number;
  ci: [number, number];
  pValue: number;
  significant: boolean;
  powered: boolean;
  /** Which side the primary metric favors, with the metric's own good-direction applied. */
  favors: 'treatment' | 'control' | 'none';
}

/**
 * One guardrail evaluation.
 *
 * A `no_worse_than` guardrail is a NON-INFERIORITY claim ("this did not get meaningfully worse"), and
 * a point estimate cannot support one. On thin data a noisy estimate lands inside the bound by chance,
 * and treating that as "held" ships a regression on ignorance: absence of evidence of harm is not
 * evidence of no harm. So `held` requires the confidence interval on the difference to lie ENTIRELY
 * within the margin - the worst case still consistent with the data is acceptable.
 *
 * The three states are distinct and all three are worth showing:
 *  - `held`      - proven within the margin. A ship may proceed.
 *  - `breached`  - proven past the margin. A ship is vetoed.
 *  - neither     - `indeterminate`: the data cannot support either claim. A ship must NOT proceed,
 *                  and the honest reason is "not enough evidence", not "the guardrail passed".
 *
 * `held` and `breached` are the two ends of the SAME comparison, the confidence interval against the
 * bound, so they are mutually exclusive and everything between them is indeterminate.
 */
export interface GuardrailEval {
  metric: string;
  deltaPct: number;
  bound: number;
  /** NON-INFERIORITY: the CI on the difference lies entirely within the margin. Required to ship. */
  held: boolean;
  /** Proven past the margin: the CI on the difference lies entirely beyond the bound. Vetoes a ship. */
  breached: boolean;
  /** The guardrail's own direction, carried so a caller can narrate a breach as what it is: a
   *  `no_worse_than` breach is a regression past a ceiling, an `at_least` breach is a miss of a floor. */
  direction?: 'no_worse_than' | 'at_least';
  /** The point estimate alone is within bound. DISPLAY ONLY - never sufficient to ship. */
  pointWithinBound: boolean;
  /** Neither proven within the margin nor proven past it: too little evidence to claim either. */
  indeterminate: boolean;
}

export interface VerdictInput {
  primary: PrimaryEval;
  guardrails: GuardrailEval[];
  /** The primary objective metric (drives the equivalent-case tiebreak). */
  objectiveMetric?: 'cost' | 'accuracy' | 'quality' | 'latency';
  /** The human battle-pick axis, when picks exist. */
  human?: { favors: 'treatment' | 'control' | 'none'; significant: boolean };
  /** 0..1; the human axis only enters the rule when > 0 (§4.3). */
  humanPickWeight?: number;
}

export interface VerdictResult {
  verdict: Verdict;
  confidence: Confidence;
  /** True when a weighted, significant human axis agrees with the primary metric. */
  humanAgrees: boolean;
  /** True when a weighted, significant human axis CONTRADICTS the primary — surfaced, never averaged (INV-3). */
  humanConflicts: boolean;
}

/**
 * The pre-registered decision rule (§4.4), evaluated in order. Advisory only
 * (INV-1): it recommends, never routes. The human pick is a distinct axis — it
 * can raise agreement confidence or be surfaced as a conflict, but is NEVER
 * blended into one number (INV-3/INV-4).
 *
 * Order:
 *  1. Underpowered (not enough data) → keep_running, regardless of point estimate.
 *  2. Guardrail breach (the CI on the difference lies entirely past the bound) vetoes a ship → keep_control.
 *  3. Primary significant + treatment favored + guardrails held → promote_treatment.
 *  4. Primary significant + control favored → keep_control.
 *  5. Enough data, no significant primary difference → equivalent.
 */
export function decideVerdict(input: VerdictInput): VerdictResult {
  const { primary, guardrails } = input;
  const guardrailsHeld = guardrails.every((g) => g.held);
  const anyBreach = guardrails.some((g) => g.breached);
  const weight = input.humanPickWeight ?? 0;
  const human = input.human;
  const humanActive = weight > 0 && !!human && human.significant && human.favors !== 'none';

  // Human agreement/conflict is computed against the primary's favored side, and
  // is only meaningful once the primary itself is significant with a favored side.
  const primaryFavored = primary.favors;
  const humanAgrees = humanActive && primary.significant && primaryFavored !== 'none' && human!.favors === primaryFavored;
  const humanConflicts = humanActive && primary.significant && primaryFavored !== 'none' && human!.favors !== primaryFavored;

  const confidence = mapConfidence({ primaryPValue: primary.pValue, powered: primary.powered, guardrailsHeld });

  // 1. Not enough data / underpowered → keep running.
  if (!primary.powered) {
    return { verdict: 'keep_running', confidence: 'low', humanAgrees: false, humanConflicts: false };
  }

  // 2. Guardrail breach vetoes a ship.
  if (anyBreach) {
    return { verdict: 'keep_control', confidence, humanAgrees, humanConflicts };
  }

  // 2b. A guardrail that cannot be CLAIMED also blocks a ship, it just is not a veto.
  //
  // `breached` proves harm; `held` proves the absence of harm. Between them sits `indeterminate`:
  // the point estimate is inside the bound but the interval is too wide to claim it. Checking only
  // `breached` shipped on that state, which is the failure mode the guardrail exists to prevent, and
  // it shipped hardest exactly when data was thinnest.
  //
  // The honest verdict is `keep_running`, not `keep_control`: the challenger has not lost, the
  // guardrail simply is not yet answerable. The action is more data, and the rationale names which
  // guardrail is unresolved. With NO guardrails configured, `every` is vacuously true and nothing
  // changes.
  if (primary.significant && primary.favors === 'treatment' && !guardrailsHeld) {
    return { verdict: 'keep_running', confidence: 'low', humanAgrees, humanConflicts };
  }

  // 3/4. Primary significant.
  if (primary.significant && primary.favors === 'treatment') {
    return { verdict: 'promote_treatment', confidence, humanAgrees, humanConflicts };
  }
  if (primary.significant && primary.favors === 'control') {
    return { verdict: 'keep_control', confidence, humanAgrees, humanConflicts };
  }

  // 5. Enough data, no significant primary difference → equivalent (a real answer).
  return { verdict: 'equivalent', confidence, humanAgrees, humanConflicts };
}

// ---------------------------------------------------------------------------
// Objective-DRIVEN outcome evaluation (§4.2-4.4)
// ---------------------------------------------------------------------------
//
// The end-to-end evaluation that turns an experiment's pre-registered OBJECTIVE
// (which primary metric, its target, its guardrails, the human-pick weight) plus
// the two variants' pooled stats into a verdict. This is the piece that makes the
// recommendation HONOR THE GOALS OF THE TEST: a cost objective reads cost (lower is
// better), a quality objective reads score (higher is better), the target sets the
// MDE the power check must clear, and each guardrail can veto a ship. Pure — no I/O,
// no narration — so the objective→verdict mapping is fully unit-testable. The
// analytics Lambda calls this, then only NARRATES the result (§4.2-E).

export type ObjectiveMetric = 'cost' | 'accuracy' | 'quality' | 'latency';

export interface OutcomeGuardrail {
  metric: ObjectiveMetric;
  /** 'no_worse_than' bounds a regression; 'at_least' bounds an improvement floor. */
  direction: 'no_worse_than' | 'at_least';
  /** Percentage bound. */
  bound: number;
}

export interface OutcomeObjective {
  /** The PRIMARY quantitative criterion. Absent ⇒ 'quality'. */
  metric?: ObjectiveMetric;
  /** Target as a percent; sets the MDE the power check must clear (0/absent ⇒ N-floor powered). */
  target?: number;
  guardrails?: OutcomeGuardrail[];
  /** 0..1; the human battle-pick axis only enters the rule when > 0. */
  humanPickWeight?: number;
}

/** The four continuous per-variant metric stats. `score` backs both quality and accuracy. */
export interface VariantStats {
  score: GroupStat;
  latency: GroupStat;
  cost: GroupStat;
  tokens: GroupStat;
  /**
   * How many of the variant's exchanges an evaluator actually SCORED.
   *
   * Distinct from `score.n`, which counts exchanges: an unscored exchange enters the score sample as a
   * placeholder zero, so `score.n` measures traffic while this measures evidence. A score-backed
   * objective is sufficiency-gated on this (see {@link evaluateExperimentOutcome}).
   *
   * Optional because a caller that cannot report scoring coverage must not have one inferred for it;
   * absent leaves the gate off. The analytics read supplies it for every variant.
   */
  scoredCount?: number;
}

/**
 * The fields of {@link VariantStats} that carry a pooled measurement, derived rather than listed.
 *
 * A metric axis indexes a variant to get something with `mean`/`sd`/`n`, so it must never be able to
 * name a field that holds anything else. `keyof VariantStats` was that type until `scoredCount` was
 * added, at which point every axis read widened to `GroupStat | number | undefined` and the whole
 * module stopped compiling. Deriving the key set means the next scalar added here cannot reintroduce
 * that: a non-`GroupStat` field maps to `never` and drops out.
 */
export type MetricStatKey = { [K in keyof VariantStats]-?: VariantStats[K] extends GroupStat ? K : never }[keyof VariantStats];

/** Which pooled stat a metric reads, and whether higher is better (its good-direction). */
export function metricAxis(metric: ObjectiveMetric): { key: MetricStatKey; higherIsBetter: boolean; label: string } {
  switch (metric) {
    case 'latency':
      return { key: 'latency', higherIsBetter: false, label: 'latency' };
    case 'cost':
      return { key: 'cost', higherIsBetter: false, label: 'cost/reply' };
    case 'accuracy':
      return { key: 'score', higherIsBetter: true, label: 'accuracy' };
    case 'quality':
    default:
      return { key: 'score', higherIsBetter: true, label: 'quality' };
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Evaluate one guardrail against the two variants (§4.2-A/B).
 *
 * BOTH claims are made against the BOUND, using the confidence interval on the difference:
 * `held` when the whole interval sits on the acceptable side of the margin, `breached` when the whole
 * interval sits beyond it. `pointWithinBound` is the point estimate, kept for display only.
 *
 * A guardrail states a MARGIN, so the significance that matters is significance against that margin,
 * never against zero. Testing the p-value against zero answers a different question and answers it
 * wrongly in both directions: a treatment proven to improve 3% against an `at_least 5` floor is a
 * significant difference from zero and was reported as a breach, while a cost 12% over a 10% bound
 * with an interval of +1% to +23% is significantly different from zero yet entirely consistent with
 * sitting inside the bound, and was reported as proven past it.
 */
export function evaluateOutcomeGuardrail(
  g: OutcomeGuardrail,
  control: VariantStats,
  treatment: VariantStats,
): GuardrailEval {
  const axis = metricAxis(g.metric);
  const c = control[axis.key];
  const t = treatment[axis.key];
  const welch = welchTTest(t.mean, t.sd, t.n, c.mean, c.sd, c.n);
  const base = Math.abs(c.mean);
  const deltaPct = base !== 0 ? (welch.delta / base) * 100 : 0;

  // The point-estimate check. DISPLAY ONLY: it neither establishes the guardrail nor breaks it.
  let pointWithinBound: boolean;
  if (g.direction === 'no_worse_than') {
    pointWithinBound = axis.higherIsBetter ? deltaPct >= -g.bound : deltaPct <= g.bound;
  } else {
    pointWithinBound = axis.higherIsBetter ? deltaPct >= g.bound : deltaPct <= -g.bound;
  }

  // NON-INFERIORITY. Take the WORST case still consistent with the data and require even that to sit
  // within the margin. Which end is "worst" depends on the metric's good-direction: for a
  // higher-is-better metric the damaging end is the LOW bound; for cost or latency it is the HIGH one.
  //
  // Without this a guardrail "held" whenever a noisy point estimate happened to land inside the bound,
  // so a cheaper-and-worse model shipped precisely when there was too little data to catch it. That is
  // backwards: thin data should block a ship, not wave it through.
  const ciPctLo = base !== 0 ? (welch.ci[0] / base) * 100 : Number.NaN;
  const ciPctHi = base !== 0 ? (welch.ci[1] / base) * 100 : Number.NaN;
  const usableCi = Number.isFinite(ciPctLo) && Number.isFinite(ciPctHi);
  let held: boolean;
  if (!usableCi) {
    // No usable baseline to express a percentage against, so no non-inferiority claim is possible.
    held = false;
  } else if (g.direction === 'no_worse_than') {
    held = axis.higherIsBetter ? ciPctLo >= -g.bound : ciPctHi <= g.bound;
  } else {
    held = axis.higherIsBetter ? ciPctLo >= g.bound : ciPctHi <= -g.bound;
  }

  // THE BREACH IS THE MIRROR OF `held`, AGAINST THE SAME BOUND: the whole interval on the failing side
  // of the margin, so the BEST case still consistent with the data already fails the guardrail. An
  // interval that straddles the bound proves neither claim and falls through to `indeterminate`, which
  // blocks a ship without pretending a regression was demonstrated.
  //
  // The failing side follows the guardrail's own direction. For `no_worse_than` it is the damaging
  // end running past the margin; for `at_least` it is the whole interval short of the floor, which is
  // a MISS of a required improvement rather than a regression, and is narrated as such.
  let breached: boolean;
  if (!usableCi) {
    breached = false;
  } else if (g.direction === 'no_worse_than') {
    breached = axis.higherIsBetter ? ciPctHi < -g.bound : ciPctLo > g.bound;
  } else {
    breached = axis.higherIsBetter ? ciPctHi < g.bound : ciPctLo > -g.bound;
  }

  return {
    metric: axis.label,
    deltaPct: round1(deltaPct),
    bound: g.bound,
    held,
    breached,
    direction: g.direction,
    pointWithinBound,
    indeterminate: !held && !breached,
  };
}

export interface OutcomeEvaluation {
  primary: PrimaryEval;
  guardrails: GuardrailEval[];
  human: HumanPickResult | null;
  humanPickWeight: number;
  verdict: Verdict;
  confidence: Confidence;
  humanAgrees: boolean;
  humanConflicts: boolean;
}

/**
 * The pure, objective-DRIVEN outcome evaluation (§4.2-4.4). Reads the primary metric
 * + its good-direction from the objective, runs Welch's t on THAT metric, ties the
 * power check to `objective.target`, evaluates each guardrail, folds the (weighted)
 * human battle pick as a DISTINCT axis (never blended — INV-3/4), and applies the
 * pre-registered decision rule. Change the objective's metric/target/guardrails and
 * the verdict changes accordingly; that is the contract the recommendation upholds.
 */
export function evaluateExperimentOutcome(input: {
  control: VariantStats;
  treatment: VariantStats;
  objective?: OutcomeObjective;
  /** Head-to-head /battle picks per side (the human axis). */
  battleWins?: { treatment: number; control: number };
}): OutcomeEvaluation {
  const { control, treatment, objective } = input;
  const primaryMetric: ObjectiveMetric = objective?.metric ?? 'quality';
  const axis = metricAxis(primaryMetric);
  const c = control[axis.key];
  const t = treatment[axis.key];

  // Primary test: Welch on the objective's metric (treatment − control).
  const welch = welchTTest(t.mean, t.sd, t.n, c.mean, c.sd, c.n);
  const significant = welch.pValue < 0.05;
  const deltaPct = c.mean !== 0 ? (welch.delta / Math.abs(c.mean)) * 100 : 0;
  const favors: 'treatment' | 'control' | 'none' = !significant
    ? 'none'
    : axis.higherIsBetter
      ? welch.delta > 0 ? 'treatment' : 'control'
      : welch.delta < 0 ? 'treatment' : 'control';

  // Power: MDE tied to objective.target (§4.2-D). Absent/zero target ⇒ N-floor powered.
  const minN = Math.min(c.n, t.n);
  let powered = true;
  if (objective && Number.isFinite(objective.target) && objective.target !== 0) {
    const mdeAbs = (Math.abs(objective.target as number) / 100) * Math.abs(c.mean);
    powered = requiredSampleForMean(c.sd, mdeAbs, minN).powered;
  }

  // SUFFICIENCY, ON THE MEASUREMENT RATHER THAN ON THE TRAFFIC.
  //
  // A score-backed objective (quality, accuracy) reads the evaluator score, and an exchange nobody
  // scored enters that sample as a placeholder zero. A variant with nothing scored therefore reports
  // mean 0 and sd 0 on both sides: Welch takes its degenerate branch, p reads 1, nothing is
  // significant, and with no target the power check is the N floor, which counts EXCHANGES and is
  // satisfied by traffic alone. The rule then reaches its last step and calls two entirely unmeasured
  // variants "equivalent on quality" - a verdict computed from zero observations of the metric.
  //
  // Scoring coverage is the evidence here, so a comparison needs at least one scored exchange on EACH
  // side; with none, no power claim is possible and the honest state is not powered, which the
  // decision rule reports as keep_running (not enough evidence yet) rather than as an answer.
  if (axis.key === 'score' && control.scoredCount != null && treatment.scoredCount != null) {
    if (Math.min(control.scoredCount, treatment.scoredCount) <= 0) powered = false;
  }

  const primary: PrimaryEval = {
    metric: axis.label,
    deltaPct: round1(deltaPct),
    ci: [round4(welch.ci[0]), round4(welch.ci[1])],
    pValue: round4(welch.pValue),
    significant,
    powered,
    favors,
  };

  const guardrails = (objective?.guardrails ?? []).map((g) => evaluateOutcomeGuardrail(g, control, treatment));

  const tWins = input.battleWins?.treatment ?? 0;
  const cWins = input.battleWins?.control ?? 0;
  const decisive = tWins + cWins;
  const human = decisive > 0 ? humanPickTest(tWins, decisive) : null;
  const humanPickWeight = objective?.humanPickWeight ?? 0;

  const v = decideVerdict({
    primary,
    guardrails,
    objectiveMetric: primaryMetric,
    human: human
      ? { favors: human.favors === 'a' ? 'treatment' : human.favors === 'b' ? 'control' : 'none', significant: human.significant }
      : undefined,
    humanPickWeight,
  });

  return {
    primary,
    guardrails,
    human,
    humanPickWeight,
    verdict: v.verdict,
    confidence: v.confidence,
    humanAgrees: v.humanAgrees,
    humanConflicts: v.humanConflicts,
  };
}
