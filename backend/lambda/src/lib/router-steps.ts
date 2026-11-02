/**
 * WHERE THE ROUTER'S TIME GOES, BEFORE THE FIRST FRAME.
 *
 * THE PROBLEM THIS SOLVES. `router_ms` is the router handler's own compute, and it sits IN FRONT of
 * the placeholder, so all of it is inside TTFF. It divides exactly once: `classifier_ms` is broken
 * out, and everything else is `avg_router_other_ms` - one derived residual covering the channel
 * reads, the SSM reads, the task lookup, the drift check, the ADR-033 claim and the grounding
 * fetch, all at once. When that residual moved by 865 ms there was no way to say which of them did
 * it, so the finest grain the data supported was "the router got slower".
 *
 * A fix measured against a number that cannot be decomposed cannot be shown to have worked, which
 * is why this lands BEFORE any optimization rather than after one.
 *
 * ── INSTANTS, NOT DURATIONS (LATENCY-TARGETS.md G12) ──
 *
 * Each step records WHEN it finished, not how long it took. The durations are derived at read, by
 * subtracting consecutive instants, exactly as `v_turn_latency` already does for the outer bracket.
 *
 * A stamped duration is a claim nobody can re-check: it cannot be recomputed, cannot be compared
 * against a neighboring span, and cannot be shown to be inconsistent - it can only be believed. Two
 * instants can disagree with each other, with `router_ms`, and with the ledger's own bracket, and a
 * disagreement is a finding. That is the whole difference, and it is why adding a column per step
 * was the wrong shape.
 *
 * These are SERVER-clock instants from one Lambda, so deltas between them are exact and skew-free,
 * and they are attested by this handler rather than provable against the message stream - the
 * ledger records them `clock='server'`, `auditable=false`, like `processor_entry` before them.
 *
 * ── A STEP IS A BOUNDARY THE PATH ACTUALLY HAS ──
 *
 * The test for a name here is whether it separates two things you would fix DIFFERENTLY. Splitting
 * further produces steps too small to act on; splitting less reproduces the residual this exists to
 * remove. Every name has a producer, and the guard is a test rather than a convention: a step nobody
 * marks renders as an always-absent row, which is the inert-mechanism shape a vocabulary invites.
 *
 * ── ABSENT MEANS DID NOT RUN ──
 *
 * The router branches: a fast-path turn never classifies, a triage turn never claims, and only a
 * task-shaped turn prepares a task. A step that did not run marks nothing, so its absence is the
 * fact - never a zero, which would report the step as free on exactly the turns that skipped it.
 * This is the same rule `classifier_ms` and `poll_ms` already follow.
 */

/**
 * The boundaries of the router's pre-placeholder path, in the order a turn that runs all of them
 * reaches them. Order is documentation only: durations are derived from the instants, so a branch
 * that reaches these in a different order still reconciles.
 */
export const ROUTER_STEPS = [
  /**
   * Handler entry. The one mark nothing "does" - it is stamped when the log is created, so the
   * first real step has something to be measured from.
   */
  'entry',
  /**
   * The conversation is known: its size, its classification tag, its metadata and its stored
   * context. Amazon Chime SDK reads plus DynamoDB, and the first thing on the path that leaves the
   * Lambda.
   */
  'channel_resolved',
  /**
   * The assistant that will answer is known: the intent pack, the active profile version and the
   * processor to hand to. Overwhelmingly SSM, and the step a cold container pays most for.
   */
  'profile_resolved',
  /**
   * The intent is decided. A model call on the paths that use one, and the step `classifier_ms`
   * already measures - kept here so the two numbers can be checked against each other rather than
   * only believed.
   */
  'classified',
  /** The conversation's live task is resolved, for the drift check and task continuation. */
  'task_resolved',
  /** Live drift detection has run, or declined to. */
  'drift_checked',
  /**
   * ADR-033 admission: the turn is claimed, and the notice is claimed when a notice is what
   * this turn posts. DynamoDB round trips, added to this path when the turn queue landed, and until
   * recently the only part of it with no timing at all.
   *
   * The holder record - what the running turn is answering - is NOT here. It needs a channel read to
   * recover the inbound id, and a drain does not read the value for seconds, so the router hands the
   * decision to the processor and the processor writes it.
   */
  'turn_claimed',
  /**
   * The task this turn answers against is created or continued, on the task-shaped paths only.
   * DynamoDB, plus the channel read that resolves which message opened it.
   *
   * GROUNDING IS NOT ON THIS LIST, and its absence is the point. Retrieval and the conversation
   * summary used to be fetched here, in front of the first frame; they are now fetched by the
   * processor, which holds everything they need and runs after the placeholder is already up
   * (`lib/turn-grounding.ts`). A name for work the router no longer does would render as an
   * always-absent row, which is what the absence convention reserves for a branch that skipped it.
   */
  'task_prepared',
  /** The turn has been handed to the processor. The end of the span `router_ms` reports. */
  'dispatched',
] as const;

export type RouterStep = (typeof ROUTER_STEPS)[number];

/** One boundary, and the wall-clock instant it was reached. */
export interface RouterStepMark {
  step: RouterStep;
  /** Epoch milliseconds, server clock. */
  at: number;
}

/**
 * The marks a turn collected, as they travel on the dispatch.
 *
 * A plain array rather than a map: a step CAN legitimately be reached twice on a branching path, and
 * a map would silently keep one of them. The ledger stores what happened.
 */
export type RouterStepLog = RouterStepMark[];

/** Whether a string is one of the declared steps (an unknown value is data, not a crash). */
export function isRouterStep(v: unknown): v is RouterStep {
  return typeof v === 'string' && (ROUTER_STEPS as readonly string[]).includes(v);
}

/**
 * Start a log, stamping `entry` so the first step has a predecessor.
 *
 * `entryAt` IS THE CALLER'S OWN START INSTANT, not one taken here. The router already stamps
 * `routerStart` for `router_ms`, and taking a second reading a line later would put the two spans
 * a millisecond or two apart - enough that "the steps sum to the leg" stops being exactly true and
 * starts being approximately true, which is precisely the property this exists to provide.
 *
 * `mark` accepts an instant for the same reason: the dispatch stamps the step and the length from
 * ONE reading of the clock.
 */
export function startRouterSteps(entryAt: number = Date.now()): {
  log: RouterStepLog;
  mark: (step: RouterStep, at?: number) => void;
} {
  const log: RouterStepLog = [{ step: 'entry', at: entryAt }];
  return {
    log,
    // NEVER THROWS, AND NEVER AWAITS. This runs on the path it measures, on every turn. A
    // measurement that can fail the turn it measures is worse than no measurement, and one that can
    // slow it down is measuring its own overhead.
    mark: (step: RouterStep, at: number = Date.now()) => { log.push({ step, at }); },
  };
}

/**
 * Read a log back off a payload that crossed a Lambda boundary, dropping anything malformed.
 *
 * Payload-shaped input is untrusted the same way any other cross-boundary field is: a step name this
 * build does not know, or an instant that is not a finite number, is DISCARDED rather than written
 * to the ledger, because a row nothing can interpret is worse in an append-only table than an
 * absence. Returns null when nothing survives, which reads downstream as "this turn recorded none".
 */
export function parseRouterSteps(v: unknown): RouterStepLog | null {
  if (!Array.isArray(v)) return null;
  const marks = v.filter((m): m is RouterStepMark =>
    !!m && typeof m === 'object'
    && isRouterStep((m as RouterStepMark).step)
    && Number.isFinite((m as RouterStepMark).at));
  return marks.length ? marks : null;
}
