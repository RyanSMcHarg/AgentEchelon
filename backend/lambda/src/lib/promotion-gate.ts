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
 * An entry the run could not exercise (a text entry whose source answer used a tool, ADR-065; a walk whose step the
 * recorded turns could not answer, or whose call had no recorded result, ADR-066 decision 7) is counted and named, and
 * never passes, fails or enters the paired difference: the result never claims more than it measured. A walk's
 * deterministic failure (it ended off a success terminal, left a step before a required tool, called a tool outside the
 * step) is a breach (`walk.<reason>`), so it refuses as any other breach does.
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
  /** How the walk ended, on an attempt that walked a multi-step entry (ADR-066 decision 7). */
  walk?: GateWalkNote;
}

/** How one walk of a multi-step entry ended: its outcome, and the step or tool that decided it. */
export interface GateWalkNote {
  outcome: 'passed' | 'failed' | 'not-exercised';
  /** The run-level steps of the intent's workflow the walk does not simulate, by name (ADR-067); absent where there are none. */
  runSteps?: string[];
  /** The walk's failure (`non-success-terminal`, `left-before-required-tool`, ...) or why it could not go on (`step`, `tool`). */
  reason?: string;
  step?: string;
  tool?: string;
}

/**
 * Why the run could not exercise an entry: a text entry whose answer used a tool (`tools`), or a walk the recorded turns
 * could not answer a step of (`step`) or had no recorded result for a call in (`tool`).
 */
export type GateNotExercised = 'tools' | 'step' | 'tool';

export interface GateEntry {
  entryId: string;
  purpose: 'regression' | 'capability';
  candidate: GateAttempt[];
  baseline: GateAttempt[];
  /** Why the run could not exercise this entry; absent when it did. */
  notExercised?: GateNotExercised;
  /** The step or tool a walk stopped at, where `notExercised` is `step` or `tool`. */
  notExercisedAt?: { step?: string; tool?: string };
  /** Present when the entry was walked as a multi-step task, with the intent it was walked under. */
  walked?: { intent: string };
}

/** What the walks of a run came to (ADR-066 decision 7): per entry, and per intent. */
export interface GateWalks {
  walked: number;
  passed: number;
  failed: number;
  notExercised: number;
  entries: Array<{
    entryId: string;
    intent: string;
    outcome: 'passed' | 'failed' | 'not-exercised';
    /** The run-level steps of the intent's workflow this walk did not exercise (ADR-067). */
    runSteps?: string[];
    reason?: string;
    step?: string;
    tool?: string;
  }>;
  byIntent: Array<{ intent: string; walked: number; passed: number; failed: number; notExercised: number }>;
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
  /** Entries the run could not exercise, by id, with why, and the step or tool a walk stopped at. */
  notExercised: Array<{ entryId: string; reason: GateNotExercised; step?: string; tool?: string }>;
  /** The walks of multi-step entries; absent when the run walked none. */
  walks?: GateWalks;
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
  const notExercised = all.flatMap((e) => (e.notExercised ? [{ entryId: e.entryId, reason: e.notExercised, ...(e.notExercisedAt ?? {}) }] : []));
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

  const walks = walksOf(all);
  return {
    refused: failures.length > 0,
    failures,
    readyToPromote,
    pairedDifference,
    minimumDetectable,
    notExercised,
    ...(walks ? { walks } : {}),
    regressionExercised: entries.filter((e) => e.purpose === 'regression').length,
    entries: all.length,
    k,
  };
}

/**
 * Each walked entry's outcome from the draft's attempts: not exercised as the gate set it aside, failed on the first
 * draft attempt that failed (the walk's reason, or the attempt's deterministic failure), passed when every attempt did.
 * Null when no entry was walked.
 */
export function walksOf(all: GateEntry[]): GateWalks | null {
  const walked = all.filter((e) => e.walked);
  if (!walked.length) return null;
  const entries: GateWalks['entries'] = walked.map((e) => {
    const intent = e.walked!.intent;
    const runSteps = e.candidate.find((a) => a.walk?.runSteps?.length)?.walk?.runSteps;
    return { ...walkEntryOf(e, intent), ...(runSteps ? { runSteps } : {}) };
  });
  return summarizeWalks(entries);
}

/** One walked entry's outcome, before the run-level steps it did not exercise are added. */
function walkEntryOf(e: GateEntry, intent: string): GateWalks['entries'][number] {
  if (e.notExercised) return { entryId: e.entryId, intent, outcome: 'not-exercised' as const, reason: e.notExercised, ...(e.notExercisedAt ?? {}) };
  const failed = e.candidate.find((a) => attemptFailure(a) !== null);
  if (!failed) return { entryId: e.entryId, intent, outcome: 'passed' as const };
  const w = failed.walk;
  const reason = w?.outcome === 'failed' && w.reason ? w.reason : attemptFailure(failed)!;
  return {
    entryId: e.entryId, intent, outcome: 'failed' as const, reason,
    ...(w?.step ? { step: w.step } : {}), ...(w?.tool ? { tool: w.tool } : {}),
  };
}

/** The walks' totals and their rows by intent. */
function summarizeWalks(entries: GateWalks['entries']): GateWalks {
  const byIntent = new Map<string, GateWalks['byIntent'][number]>();
  for (const e of entries) {
    const row = byIntent.get(e.intent) ?? { intent: e.intent, walked: 0, passed: 0, failed: 0, notExercised: 0 };
    row.walked++;
    if (e.outcome === 'passed') row.passed++;
    else if (e.outcome === 'failed') row.failed++;
    else row.notExercised++;
    byIntent.set(e.intent, row);
  }
  return {
    walked: entries.length,
    passed: entries.filter((e) => e.outcome === 'passed').length,
    failed: entries.filter((e) => e.outcome === 'failed').length,
    notExercised: entries.filter((e) => e.outcome === 'not-exercised').length,
    entries,
    byIntent: [...byIntent.values()].sort((a, b) => a.intent.localeCompare(b.intent)),
  };
}
