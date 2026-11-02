/**
 * WHETHER A DRAFT VERSION MAY BE ACTIVATED, FROM ITS RUN AGAINST THE GOLDEN SET (SPEC-EVALUATION FR17,
 * Appendix C1).
 *
 * Two kinds of evidence, and only one of them blocks:
 *
 *   BLOCKS     a regression entry the draft failed on any of its k attempts (pass^k). An attempt fails on
 *              a deterministic fact: the run errored, the answer was empty, the guardrail blocked it, or
 *              it breached a rule the platform checks without a judge. A regression entry is a case the
 *              active version passes, so the draft failing it once in k is a regression, not noise.
 *   INFORMS    the judged quality of the draft against the active version on the same entries, as the
 *              mean paired difference with a confidence interval over entries (each entry is one
 *              cluster: its k attempts are not independent). A judged average moves with the judge, the
 *              sample and the run, so a gate that blocked on it would be flaky by construction; it is
 *              shown, with the smallest difference this set can detect, and the person activating
 *              decides (Non-Goals: automated promotion).
 *
 * A capability entry the draft passes on every attempt is reported as ready to promote to regression.
 *
 * An entry the run could not exercise (its source answer used a tool and the run has none, ADR-065) is counted and
 * named, and never passes, fails or enters the paired difference: the result never claims more than it measured.
 *
 * Pure, so the rule is pinned by unit tests.
 */
import { studentTCritical, minimumDetectableDifference } from './experiment-stats.js';

/** One attempt at one entry, by one side, as the run recorded it. */
export interface GateAttempt {
  /** The run produced an answer at all. */
  ok: boolean;
  /** The answer text was empty. */
  empty: boolean;
  /** The guardrail blocked the answer. */
  blocked: boolean;
  /** Rule ids the answer breached that the platform checks without a judge. */
  breaches: string[];
  /** The judge's relevance score for the answer, when it was judged. */
  score?: number | null;
}

export interface GateEntry {
  entryId: string;
  purpose: 'regression' | 'capability';
  candidate: GateAttempt[];
  baseline: GateAttempt[];
  /** Why the run could not exercise this entry; absent when it did. */
  notExercised?: 'tools';
}

export interface GateResult {
  /** True when activation is refused: at least one regression entry failed pass^k. */
  refused: boolean;
  /** The regression entries that failed, and why, by attempt. */
  failures: Array<{ entryId: string; attempt: number; reason: 'error' | 'empty' | 'blocked' | 'breach'; rules?: string[] }>;
  /** Capability entries the draft passed on every attempt. */
  readyToPromote: string[];
  /** Mean judged difference, draft minus active, over entries both sides were judged on. */
  pairedDifference: { mean: number; ci: [number, number]; entries: number } | null;
  /** The smallest difference this set can detect at 80% power; Infinity with fewer than two entries. */
  minimumDetectable: number;
  /** Entries the run could not exercise, by id, with why. */
  notExercised: Array<{ entryId: string; reason: 'tools' }>;
  /** Regression entries the run exercised: with none, a result that refuses nothing measured nothing. */
  regressionExercised: number;
  /** Entries in the run and attempts per entry, so the result states what it was taken over. */
  entries: number;
  k: number;
}

export function attemptFailure(a: GateAttempt): GateResult['failures'][number]['reason'] | null {
  if (!a.ok) return 'error';
  if (a.empty) return 'empty';
  if (a.blocked) return 'blocked';
  if (a.breaches.length) return 'breach';
  return null;
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const judged = (as: GateAttempt[]): number[] =>
  as.map((a) => a.score).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));

export function gateResult(all: GateEntry[]): GateResult {
  const notExercised = all.flatMap((e) => (e.notExercised ? [{ entryId: e.entryId, reason: e.notExercised }] : []));
  const entries = all.filter((e) => !e.notExercised);
  const failures: GateResult['failures'] = [];
  const readyToPromote: string[] = [];
  let k = 0;
  for (const e of entries) {
    k = Math.max(k, e.candidate.length);
    if (e.purpose === 'regression') {
      e.candidate.forEach((a, i) => {
        const reason = attemptFailure(a);
        if (reason) failures.push({ entryId: e.entryId, attempt: i + 1, reason, ...(reason === 'breach' ? { rules: a.breaches } : {}) });
      });
    } else if (e.candidate.length > 0 && e.candidate.every((a) => attemptFailure(a) === null)) {
      readyToPromote.push(e.entryId);
    }
  }

  // One paired difference per entry, from the mean of each side's judged attempts.
  const diffs: number[] = [];
  for (const e of entries) {
    const c = judged(e.candidate);
    const b = judged(e.baseline);
    if (c.length && b.length) diffs.push(mean(c) - mean(b));
  }
  let pairedDifference: GateResult['pairedDifference'] = null;
  let minimumDetectable = Infinity;
  if (diffs.length >= 2) {
    const m = mean(diffs);
    const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (diffs.length - 1));
    const half = studentTCritical(diffs.length - 1, 0.05) * sd / Math.sqrt(diffs.length);
    const r = (x: number) => Math.round(x * 10) / 10;
    pairedDifference = { mean: r(m), ci: [r(m - half), r(m + half)], entries: diffs.length };
    minimumDetectable = r(minimumDetectableDifference(sd, diffs.length));
  } else if (diffs.length === 1) {
    pairedDifference = { mean: Math.round(diffs[0] * 10) / 10, ci: [-Infinity, Infinity], entries: 1 };
  }

  return {
    refused: failures.length > 0,
    failures,
    readyToPromote,
    pairedDifference,
    minimumDetectable,
    notExercised,
    regressionExercised: entries.filter((e) => e.purpose === 'regression').length,
    entries: all.length,
    k,
  };
}
