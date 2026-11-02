/**
 * AN EVENT WORKFLOW'S `agent` STEP, AS THE PROCESSOR RUNS IT (ADR-061 decision 8, slice 1).
 *
 * One turn of the assistant on its own vended session, from the step's prompt template with the event's fields
 * passed as delimited data, and only the step's read tools. The step ends in exactly one message: the turn's
 * output, or the step's fallback, a platform-filled message template. Which one is decided by ONE conditional
 * write on the step's claim (decision 5): whichever wins it posts, and the other is discarded and logged with the
 * step, never with its text. So a reply that arrives after the fallback posted is suppressed, and the room holds
 * one message for the step.
 *
 * The fallback is posted past the deadline, on a model error, on a guardrail intervention, on an empty reply, on a
 * draft that may not reach the person it is for (`vet`, outcome `fallback:bounds`), on a template that cannot be read,
 * and on a refused meter (`machineWritten`, against the global budget only). Each
 * outcome rides the posted message's Metadata (`eventStep.outcome`), which is how it reaches the archive: no metric
 * is emitted beside it (tenet D7).
 *
 * The model call, the claim, the posts and the meter are injected, so each outcome is a unit test.
 */
import type { ParsedTemplate } from './document-template.js';
import { renderPromptTemplate } from './message-template.js';
import { stripMessageMarkers } from './message-markers.js';

export type AgentStepFallback = 'deadline' | 'model_error' | 'guardrail' | 'meter' | 'empty' | 'template' | 'bounds';
/**
 * `skipped`: a join recap found nothing a person said in the room to recount (`nothingToRead`), and posted nothing.
 * `post_failed`: the output won the claim and the Amazon Chime SDK refused its post, or any one part of it when a long
 * output is posted as one response in parts (`sendInParts`), so nobody was told all of it. It is not a delivery: the run hands it back,
 * and the router says the step's fallback and takes `onFailure` (`continueAfter`).
 */
export type AgentStepOutcome = 'posted' | 'skipped' | 'post_failed' | `fallback:${AgentStepFallback}`;

export interface AgentStepModelResult {
  response: string;
  inputGuardBlocked?: boolean;
  guardrailFindings?: string[];
}

export interface AgentStepDeps {
  meter: () => Promise<boolean>;
  invoke: (prompt: string) => Promise<AgentStepModelResult>;
  /** The step's one conditional write, recording the outcome. False when the other side already won. */
  claim: (outcome: AgentStepOutcome) => Promise<boolean>;
  /** Post the turn's output, declared as an `event_step` turn carrying its outcome. */
  postOutput: (content: string) => Promise<void>;
  /** Post the step's fallback template, carrying the fallback's outcome. */
  postFallback: (outcome: AgentStepOutcome) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
  /** A post the Amazon Chime SDK refused, said at warning level so an operator and the e2e watchdog see it. */
  warn?: (entry: Record<string, unknown>) => void;
  /** A reply the model loop substitutes for an empty one, which is not output. */
  emptyReplies?: string[];
  /**
   * Whether the output may be sent on, for a step whose draft reaches a person not reading the room (ADR-061 decision 8,
   * rule 6): false posts the fallback, outcome `fallback:bounds`.
   */
  vet?: (text: string) => boolean;
}

class Deadline extends Error {}

/**
 * Run the step. Resolves with the outcome that won the claim (or the one that lost, when neither posted), whether
 * this invocation won it (`won`: only the winner hands the run on), and a `settled` promise that resolves once a model reply that outlived the deadline has been discarded.
 */
export async function runAgentStep(
  args: {
    template: ParsedTemplate | undefined; values: Record<string, string>; deadlineMs: number;
    /**
     * A join recap that found nothing a person wrote in the room (`nothingToRecap`): nothing is there to catch anyone up
     * on, so it calls no model, posts nothing and records `skipped`, which goes on as a success.
     */
    nothingToRead?: boolean;
  },
  deps: AgentStepDeps,
): Promise<{ outcome: AgentStepOutcome; posted: boolean; won: boolean; settled: Promise<void> }> {
  const log = deps.log ?? (() => undefined);
  const warn = deps.warn ?? log;
  const failure = (err: unknown) => ({ postFailed: (err as Error)?.name, error: (err as Error)?.message });
  const fallback = async (reason: AgentStepFallback) => {
    const outcome: AgentStepOutcome = `fallback:${reason}`;
    if (!(await deps.claim(outcome).catch(() => false))) {
      log({ outcome, suppressed: true });
      return { outcome, posted: false, won: false };
    }
    try {
      await deps.postFallback(outcome);
      return { outcome, posted: true, won: true };
    } catch (err) {
      // The fallback already takes the failure edge, so the run claims no delivery either way.
      warn({ outcome, posted: false, ...failure(err) });
      return { outcome, posted: false, won: true };
    }
  };
  const done = Promise.resolve();
  if (args.nothingToRead) {
    const won = await deps.claim('skipped').catch(() => false);
    log({ outcome: 'skipped', ...(won ? {} : { suppressed: true }) });
    return { outcome: 'skipped', posted: false, won, settled: done };
  }
  if (!args.template || args.template.kind !== 'prompt') return { ...(await fallback('template')), settled: done };
  const rendered = renderPromptTemplate(args.template, args.values);
  if (!rendered.ok) return { ...(await fallback('template')), settled: done };
  if (!(await deps.meter().catch(() => false))) return { ...(await fallback('meter')), settled: done };

  const call = deps.invoke(rendered.prompt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: AgentStepModelResult;
  try {
    result = await Promise.race([
      call,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Deadline()), args.deadlineMs); }),
    ]);
  } catch (err) {
    if (err instanceof Deadline) {
      const won = await fallback('deadline');
      // THE LATE REPLY LOSES THE CLAIM. It is still awaited, so it is discarded and logged rather than abandoned
      // mid-flight, and it never posts.
      const settled = call.then(async (late) => {
        const text = stripMessageMarkers(late?.response ?? '').trim();
        if (!text || !(await deps.claim('posted').catch(() => false))) {
          log({ outcome: 'posted', suppressed: true, late: true });
          return;
        }
        await deps.postOutput(text).catch((err) => warn({ outcome: 'post_failed', posted: false, late: true, ...failure(err) }));
      }, () => undefined);
      return { ...won, settled };
    }
    return { ...(await fallback('model_error')), settled: done };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result.inputGuardBlocked || (result.guardrailFindings ?? []).some((f) => f.startsWith('guardrail.output.'))) {
    return { ...(await fallback('guardrail')), settled: done };
  }
  const text = stripMessageMarkers(result.response ?? '').trim();
  if (!text || (deps.emptyReplies ?? []).includes(text)) return { ...(await fallback('empty')), settled: done };
  if (deps.vet && !deps.vet(text)) return { ...(await fallback('bounds')), settled: done };
  if (!(await deps.claim('posted').catch(() => false))) {
    log({ outcome: 'posted', suppressed: true });
    return { outcome: 'posted', posted: false, won: false, settled: done };
  }
  try {
    await deps.postOutput(text);
    return { outcome: 'posted', posted: true, won: true, settled: done };
  } catch (err) {
    warn({ outcome: 'post_failed', posted: false, ...failure(err) });
    return { outcome: 'post_failed', posted: false, won: true, settled: done };
  }
}
