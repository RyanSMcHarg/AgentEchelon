/**
 * WHETHER ACTIVATE PROCEEDS, FROM THE DRAFT'S LATEST RUN AGAINST THE GOLDEN SET (ADR-065 decision 3).
 *
 * A run is required when the assistant's set holds at least one live regression entry; it is for the draft's current
 * configId, so an edit after the run needs a new one, and it must have answered every live regression entry, so an entry
 * nominated after the run needs a new one too. Only a deterministic failure of a regression entry refuses
 * (`lib/promotion-gate.ts`); a judged difference never does. A run that could exercise no regression entry (every one
 * used a tool) refuses nothing and says it measured nothing: the outcome is `unmeasured`, never `passed`.
 *
 * NO GATE WHERE THERE IS NO SET TO READ. The set and the run live in Aurora; a deployment in Athena mode has neither, and
 * there Activate proceeds and says so. A rollback and an experiment's promotion do not pass this gate: a rolled-back
 * version already served, and a promoted candidate was measured by its experiment.
 *
 * The outcome carries a code and its values; the console words it from the locale file, and `error` is the API's own
 * sentence for a caller with no console. Pure, so the rule is pinned by unit tests.
 */
import type { GateResult } from './promotion-gate.js';

/** What the set holds for one intent of the draft's pack (`coverageOf` in `golden-run.ts`); the one definition. */
export interface IntentCoverage {
  intent: string;
  regression: number;
  capability: number;
  /** Of those, how many a deployment uploaded. */
  uploaded: number;
  /** Regression entries of this intent the draft's latest run answered (not set aside as using a tool). */
  exercised: number;
}

export interface GoldenGateRead {
  entries: number;
  regressionEntries: number;
  /** Per intent of the draft's pack (ADR-065 decision 6). Absent on a read that named no intents. */
  coverage?: IntentCoverage[];
  /** Live entries whose intent the draft's pack does not declare. */
  outsidePack?: Array<{ intent: string; entries: number }>;
  /**
   * The intents of the draft's pack and the active version's minimum, set by the caller from the versions, not by the run
   * function: the minimum is the active version's to declare, so a draft cannot lower it.
   */
  intents?: string[];
  minRegressionPerIntent?: number;
  /** The active version's minimum, where the set could not hold it across the draft's intents and it was held lower. */
  minDeclared?: number;
  /** The active version could not be read for its minimum (the console's view only; Activate refuses instead). */
  minUnread?: boolean;
  /** Live regression entries the latest run has no attempt for. Absent on a read from before it was counted. */
  uncoveredRegression?: number;
  run: {
    runId: string;
    draftConfigId: string;
    status: 'running' | 'complete' | 'failed';
    result: GateResult | null;
    error: string | null;
    entriesTotal: number;
    entriesDone: number;
  } | null;
}

export type GoldenRefusalCode = 'GOLDEN_SET_THIN' | 'GOLDEN_RUN_REQUIRED' | 'GOLDEN_RUN_OUTDATED' | 'GOLDEN_RUN_RUNNING' | 'GOLDEN_RUN_FAILED' | 'GOLDEN_SET_REFUSED';

export type GoldenGateOutcome =
  | {
    proceed: true;
    note: 'unavailable' | 'empty' | 'passed' | 'unmeasured';
    /**
     * Intents of the draft's pack the run exercised no regression entry for, so "passed" never stands for an intent the
     * set does not reach. Absent where coverage was not read.
     */
    unchecked?: string[];
  }
  | {
    proceed: false;
    code: GoldenRefusalCode;
    /** The values the console words the refusal with. */
    params: Record<string, string | number>;
    error: string;
    failures?: GateResult['failures'];
  };

/**
 * THE MINIMUM THE GATE APPLIES (ADR-065 decision 6): the active version's, held at the most a set of `capacity` entries can
 * give each of the draft's intents. A draft that adds intents would otherwise face a minimum no set could meet, and the
 * minimum is lowered only by activating a version, which that same gate would refuse.
 */
export function effectiveMinimum(declared: number | undefined, intents: number, capacity: number): number | undefined {
  if (!declared) return undefined;
  if (!intents) return declared;
  return Math.min(declared, Math.max(1, Math.floor(capacity / intents)));
}

/** `gate` is null where this deployment has no golden run to read (Athena mode, or the function is not deployed). */
export function goldenGateOutcome(gate: GoldenGateRead | null, draftConfigId: string): GoldenGateOutcome {
  if (!gate) return { proceed: true, note: 'unavailable' };
  // A SET TOO THIN TO MEASURE THE DRAFT, against the active version's minimum (ADR-065 decision 6). First, because no run
  // cures it: entries must be added, which a run then has to answer anyway. An intent with no counts read is counted as
  // none, so a read that could not count refuses rather than passes.
  const min = gate.minRegressionPerIntent ?? 0;
  if (min > 0 && gate.intents?.length) {
    const held = new Map((gate.coverage ?? []).map((c) => [c.intent, c.regression]));
    const thin = gate.intents.filter((i) => (held.get(i) ?? 0) < min);
    if (thin.length) {
      return {
        proceed: false, code: 'GOLDEN_SET_THIN', params: { count: thin.length, min, intents: thin.join(', ') },
        error: `The golden set holds fewer than ${min} regression entr${min === 1 ? 'y' : 'ies'} for ${thin.length} intent${thin.length === 1 ? '' : 's'} of the draft (${thin.join(', ')}); add entries before activating`,
      };
    }
  }
  const unchecked = gate.coverage ? { unchecked: gate.coverage.filter((c) => c.exercised === 0).map((c) => c.intent) } : {};
  if (gate.regressionEntries === 0) return { proceed: true, note: 'empty', ...unchecked };
  const run = gate.run && gate.run.draftConfigId === draftConfigId ? gate.run : null;
  if (!run) {
    return {
      proceed: false, code: 'GOLDEN_RUN_REQUIRED', params: { count: gate.regressionEntries },
      error: `This assistant's golden set holds ${gate.regressionEntries} regression entr${gate.regressionEntries === 1 ? 'y' : 'ies'}; run the draft against it before activating`,
    };
  }
  if (run.status === 'running') {
    return {
      proceed: false, code: 'GOLDEN_RUN_RUNNING', params: { done: run.entriesDone, total: run.entriesTotal },
      error: `The draft's golden run is still running (${run.entriesDone} of ${run.entriesTotal} entries)`,
    };
  }
  if (run.status === 'failed' || !run.result) {
    return {
      proceed: false, code: 'GOLDEN_RUN_FAILED', params: { error: run.error ?? '' },
      error: `The draft's golden run did not finish${run.error ? `: ${run.error}` : ''}; run it again`,
    };
  }
  if (run.result.refused) {
    const n = new Set(run.result.failures.map((f) => f.entryId)).size;
    return {
      proceed: false, code: 'GOLDEN_SET_REFUSED', params: { count: n },
      error: `The draft failed ${n} regression entr${n === 1 ? 'y' : 'ies'} of the golden set`,
      failures: run.result.failures,
    };
  }
  if ((gate.uncoveredRegression ?? 0) > 0) {
    const n = gate.uncoveredRegression!;
    return {
      proceed: false, code: 'GOLDEN_RUN_OUTDATED', params: { count: n },
      error: `${n} regression entr${n === 1 ? 'y was' : 'ies were'} added to the golden set after the draft's run; run it again`,
    };
  }
  return { proceed: true, note: run.result.regressionExercised === 0 ? 'unmeasured' : 'passed', ...unchecked };
}

/** The shortest and longest reason an administrator gives for activating past the gate. */
export const PAST_GATE_REASON_MIN = 10;
export const PAST_GATE_REASON_MAX = 500;

/**
 * What an administrator confirms when they activate past the gate: the draft they saw, the refusal shown (its code, the
 * values it was worded with, and the run it was read from), and why.
 */
export interface PastGateConfirmation {
  configId?: unknown;
  code?: unknown;
  params?: unknown;
  /** The run the refusal was read from; absent where none ran for the draft. */
  runId?: unknown;
  reason?: unknown;
}

/** The same values, whatever order their keys were sent in. */
function sameParams(shown: unknown, current: Record<string, string | number>): boolean {
  if (!shown || typeof shown !== 'object' || Array.isArray(shown)) return false;
  const a = Object.entries(shown as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y));
  const b = Object.entries(current).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What the activated version records about the refusal it went live past (ADR-065 decision 5). */
export interface ActivatedPastGate {
  code: GoldenRefusalCode;
  params: Record<string, string | number>;
  reason: string;
  actor: string;
  at: string;
  /** The run the refusal was read from, when one exists for the draft. */
  runId?: string;
}

export type PastGateDecision =
  | { allow: true; refusal: Extract<GoldenGateOutcome, { proceed: false }>; reason: string }
  | { allow: false; status: 400 | 409; code: string; error: string; current?: { code: GoldenRefusalCode; params: Record<string, string | number> } };

/**
 * WHETHER AN ADMINISTRATOR'S CONFIRMATION STANDS (ADR-065 decision 5). The confirmation names the draft and the refusal the
 * caller was shown, and both are read again here: a draft saved since, or a refusal that has changed (a run finished, an
 * entry added), is refused with the refusal that stands now, so what the administrator confirmed is what is passed. A gate
 * that no longer refuses has nothing to pass: Activate is the route for it. Only the golden gate is passed; every other
 * check of an activation still applies, in the caller.
 */
export function pastGateDecision(gate: GoldenGateRead | null, draftConfigId: string, confirm: PastGateConfirmation): PastGateDecision {
  // ONE LINE: the reason is said inside the admin channel's notice and the version list, so a line break in it could
  // read as a line of the notice itself.
  const reason = typeof confirm.reason === 'string' ? confirm.reason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length < PAST_GATE_REASON_MIN || reason.length > PAST_GATE_REASON_MAX) {
    return {
      allow: false, status: 400, code: 'REASON_REQUIRED',
      error: `Activating past the golden gate needs a reason of ${PAST_GATE_REASON_MIN} to ${PAST_GATE_REASON_MAX} characters`,
    };
  }
  if (typeof confirm.configId !== 'string' || !confirm.configId || typeof confirm.code !== 'string' || !confirm.code) {
    return { allow: false, status: 400, code: 'CONFIRMATION_REQUIRED', error: 'Name the draft\'s configId and the refusal code being passed' };
  }
  const outcome = goldenGateOutcome(gate, draftConfigId);
  if (outcome.proceed) {
    return { allow: false, status: 409, code: 'GATE_NOT_REFUSING', error: 'The golden gate no longer refuses this draft; activate it' };
  }
  const current = { code: outcome.code, params: outcome.params };
  if (confirm.configId !== draftConfigId) {
    return { allow: false, status: 409, code: 'GATE_CHANGED', error: 'The draft was saved again since its refusal was shown; review the refusal that stands', current };
  }
  // THE SAME REFUSAL, NOT ONLY THE SAME CODE: more entries failed, or more were added, reads differently from what was
  // confirmed, and so does a new run of the same draft.
  const runId = gate?.run && gate.run.draftConfigId === draftConfigId ? gate.run.runId : undefined;
  if (confirm.code !== outcome.code || !sameParams(confirm.params, outcome.params) || (confirm.runId ?? undefined) !== runId) {
    return { allow: false, status: 409, code: 'GATE_CHANGED', error: `The refusal changed to ${outcome.code} since it was shown; review the refusal that stands`, current };
  }
  return { allow: true, refusal: outcome, reason };
}
