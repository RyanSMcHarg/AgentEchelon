/**
 * A PROCESS AS A CHAIN OF WORKFLOWS AND THE HAND-OFFS BETWEEN THEM (SPEC-PROCESSES P1, P3), read from the workflows' own
 * definitions: nothing here is declared on the process, so what the wizard shows is what runs.
 *
 * Pure: every function reads the version's workflows a process may link (`linkableOf`: its event workflows, and its
 * request-started workflows, each keyed by the intent it runs on) and decides.
 *
 * What it guarantees:
 *  - A PHASE IS ONE WORKFLOW, in the conversation types it runs in, with its stages (its labeled steps), who answers each,
 *    and each deadline its tasks declare.
 *  - A HAND-OFF IS AN `open` STEP of one phase whose conversation type the next phase runs in: where it goes (that type),
 *    who leads it there (the open step's role), on what condition (the edges into the open step), whether the phase that
 *    opened it waits on it (a `wait` on the child) or runs alongside, and what is told across (a send `in: 'opened'` forward,
 *    a send `in: 'opener'` back).
 *  - A REQUEST-STARTED WORKFLOW IS A PHASE LIKE ANY OTHER: its stages are its labeled steps, and its `open` steps hand off to the
 *    workflows the conversations they open run.
 *  - THE CHAIN FOLLOWS THOSE OPEN STEPS from the starting workflow, so choosing what starts a process proposes the workflows it
 *    reaches; a workflow no open step reaches is added by hand.
 *  - PARALLEL WORK IS READ THE SAME WAY (`processLayout`): a phase that opens several phases is a fork, a phase its opener does
 *    not wait on runs alongside it, and a join (`wait: { join }`) names the parts it waits on, all of them or any one.
 */
import { INTENT_TRIGGER } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { stageResponsible } from './processStages';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The longest deadline that is a bound rather than a hold: thirty days is how long a task may stay open, not a target. */
const HOLD_MINUTES = 43_200;

export interface PhaseStage {
  step: string; label: string; description?: string;
  responsible: ReturnType<typeof stageResponsible>;
  /** The deadline its task declares, in minutes, where it is a target. */
  dueMinutes?: number;
}
export interface Phase { workflow: string; on: string; types: string[]; stages: PhaseStage[] }
export interface Handoff {
  from: string; to: string;
  /** The open step that hands off, and its label where it has one. */
  step: string; label?: string;
  /** The conversation type it opens. */
  type: string;
  /** Who leads the opened conversation, as the open step names the role. */
  ledBy?: string;
  /** The conditions on the edges into the open step: each a source and the value it must hold. */
  when: Array<{ source: string; value: string }>;
  /** Whether the phase that opened it waits for it to end; else it runs alongside. */
  waits: boolean;
  /** The templates the opener sends into it, and the ones it sends back. */
  toldForward: string[]; toldBack: string[];
}

/**
 * EVERY WORKFLOW A PROCESS MAY LINK, BY NAME, as the runner reads it: each request-started workflow (`intentWorkflows`, keyed by
 * its intent) on the intent trigger, and the event workflows, which win a shared name as they do on the server.
 */
export function linkableOf(version: { eventWorkflows?: unknown; intentWorkflows?: unknown }): Obj {
  const byRequest = Object.fromEntries(Object.entries(isObj(version.intentWorkflows) ? version.intentWorkflows : {})
    .map(([intent, wf]) => [intent, isObj(wf) ? { ...wf, on: INTENT_TRIGGER } : wf]));
  return { ...byRequest, ...(isObj(version.eventWorkflows) ? version.eventWorkflows : {}) };
}

/** Whether a linkable workflow is started by a request rather than an event. */
export const startedByRequest = (workflows: Obj, name: string): boolean => isObj(workflows[name]) && (workflows[name] as Obj).on === INTENT_TRIGGER;

type States = Record<string, Obj>;
const statesOf = (wf: unknown): States => (isObj(wf) && isObj(wf.states) ? (wf.states as States) : {});

/** One workflow as a phase. */
export function phaseOf(workflows: Obj, name: string): Phase {
  const wf = workflows[name];
  const types = isObj(wf) && Array.isArray(wf.types) ? wf.types.filter((t): t is string => typeof t === 'string') : [];
  const stages: PhaseStage[] = Object.entries(statesOf(wf)).flatMap(([step, def]) => {
    const label = str(def.label).trim();
    if (!label) return [];
    const minutes = Number(isObj(def.task) && isObj(def.task.deadline) ? def.task.deadline.afterMinutes : NaN);
    return [{
      step, label, ...(str(def.description).trim() ? { description: str(def.description).trim() } : {}),
      responsible: stageResponsible(def),
      ...(Number.isFinite(minutes) && minutes > 0 && minutes < HOLD_MINUTES ? { dueMinutes: minutes } : {}),
    }];
  });
  return { workflow: name, on: isObj(wf) ? str(wf.on) : '', types, stages };
}

/** The workflows that run when a conversation of `type` opens. */
function openedBy(workflows: Obj, type: string): string[] {
  return Object.entries(workflows)
    .filter(([, wf]) => isObj(wf) && wf.on === 'conversation-opened' && Array.isArray(wf.types) && wf.types.includes(type))
    .map(([name]) => name);
}

/** Every open step of a workflow, with the type it opens and the role that leads it there. */
function opensOf(workflows: Obj, name: string): Array<{ step: string; label?: string; type: string; ledBy?: string }> {
  return Object.entries(statesOf(workflows[name])).flatMap(([step, def]) => {
    const open = isObj(def.open) ? def.open : undefined;
    if (!open || !str(open.type)) return [];
    const forRole = isObj(open.for) ? str(open.for.typeRole) : '';
    return [{ step, ...(str(def.label) ? { label: str(def.label) } : {}), type: str(open.type), ...(forRole ? { ledBy: forRole } : {}) }];
  });
}

/**
 * WHAT A WORKFLOW HANDS ON TO NEXT: each workflow one of its own open steps starts, with the conversation type it opens there,
 * in the order its steps declare them. The next phases a process starting here gains, said before it is chosen.
 */
export function opensNext(workflows: Obj, name: string): Array<{ workflow: string; type: string }> {
  const out: Array<{ workflow: string; type: string }> = [];
  for (const o of opensOf(workflows, name)) {
    for (const next of openedBy(workflows, o.type)) if (next !== name && !out.some((x) => x.workflow === next)) out.push({ workflow: next, type: o.type });
  }
  return out;
}

/** The workflows a process reaches from its starting workflow, by following each open step to the workflow it starts. */
export function chainFrom(workflows: Obj, start: string): string[] {
  const out: string[] = [];
  const queue = [start];
  while (queue.length) {
    const wf = queue.shift()!;
    if (out.includes(wf) || !(wf in workflows)) continue;
    out.push(wf);
    for (const o of opensOf(workflows, wf)) for (const next of openedBy(workflows, o.type)) if (!out.includes(next)) queue.push(next);
  }
  return out;
}

/** The conditions on the edges that lead into `target`. */
function conditionsInto(states: Record<string, Obj>, target: string): Array<{ source: string; value: string }> {
  const seen = new Map<string, { source: string; value: string }>();
  for (const def of Object.values(states)) {
    for (const edge of ['onSuccess', 'onFailure']) {
      const e = def[edge];
      for (const branch of Array.isArray(e) ? e : []) {
        if (!isObj(branch) || branch.to !== target || !isObj(branch.when)) continue;
        for (const [source, value] of Object.entries(branch.when)) seen.set(`${source}=${String(value)}`, { source, value: String(value) });
      }
    }
  }
  return [...seen.values()];
}

/** Whether some edge reaches `target` with no condition: a step that goes on to it whatever happened. */
function reachedAlways(states: Record<string, Obj>, target: string): boolean {
  return Object.values(states).some((def) => ['onSuccess', 'onFailure'].some((edge) => {
    const e = def[edge];
    if (e === target) return true;
    return Array.isArray(e) && e.some((branch) => isObj(branch) && branch.to === target && !isObj(branch.when));
  }));
}

/** The hand-off from one phase to the next, or null where no open step of `from` starts `to`. */
export function handoffBetween(workflows: Obj, from: string, to: string): Handoff | null {
  const toTypes = phaseOf(workflows, to).types;
  // A PHASE MAY OPEN THE NEXT FROM MORE THAN ONE STEP (customer messaging opens at once where triage said so, or once the
  // affected accounts are named): the hand-off is one, reached on any of their conditions.
  const opens = opensOf(workflows, from).filter((o) => toTypes.includes(o.type));
  const open = opens[0];
  if (!open) return null;
  const fromStates = statesOf(workflows[from]);
  // A HAND-OFF SOME STEP REACHES WITH NO CONDITION HAS NONE: it happens whatever the conditions on its other edges say, so
  // naming them would read as a gate it does not have.
  const always = opens.some((o) => reachedAlways(fromStates, o.step));
  const when = always ? [] : [...new Map(opens.flatMap((o) => conditionsInto(fromStates, o.step)).map((c) => [`${c.source}=${c.value}`, c])).values()];
  const sendsIn = (states: Record<string, Obj>, where: string) => Object.values(states)
    .flatMap((d) => (isObj(d.send) && d.send.in === where && str(d.send.template) ? [str(d.send.template)] : []));
  // THE OPENER WAITS ON IT where it waits on its opened conversation (`wait: { child }`), or a join names one of these opens.
  const joined = joinsOf(workflows, from).some((j) => j.parts.some((p) => opens.some((o) => o.step === p.step)));
  return {
    from, to, step: open.step, ...(open.label ? { label: open.label } : {}), type: open.type, ...(open.ledBy ? { ledBy: open.ledBy } : {}),
    when,
    waits: joined || Object.values(fromStates).some((d) => isObj(d.wait) && d.wait.child !== undefined),
    toldForward: [...new Set(sendsIn(fromStates, 'opened'))],
    toldBack: [...new Set(sendsIn(statesOf(workflows[to]), 'opener'))],
  };
}

/** One part a join waits on, in words: the workflows its opened conversation runs, or the alongside task's stage label. */
export interface JoinPart { step: string; kind: 'open' | 'alongside'; words: string }
/** A join one phase declares (`wait: { join }`): the stage that waits, whether it waits for all of its parts or any one, and the parts. */
export interface PhaseJoin { step: string; label?: string; when: 'all' | 'any'; parts: JoinPart[] }

/** The joins a phase's own steps declare, each part said in words. */
export function joinsOf(workflows: Obj, name: string): PhaseJoin[] {
  const states = statesOf(workflows[name]);
  return Object.entries(states).flatMap(([step, def]) => {
    const join = isObj(def.wait) && isObj(def.wait.join) ? def.wait.join : undefined;
    if (!join || !Array.isArray(join.of)) return [];
    const parts: JoinPart[] = join.of.filter((p): p is string => typeof p === 'string').flatMap((p): JoinPart[] => {
      const part = states[p];
      if (part && isObj(part.open) && str(part.open.type)) {
        const runs = openedBy(workflows, str(part.open.type));
        return [{ step: p, kind: 'open' as const, words: runs.length ? runs.join(', ') : str(part.open.type) }];
      }
      if (part && isObj(part.task)) return [{ step: p, kind: 'alongside' as const, words: str(part.label).trim() || p }];
      return [];
    });
    return [{ step, ...(str(def.label).trim() ? { label: str(def.label).trim() } : {}), when: join.when === 'any' ? 'any' as const : 'all' as const, parts }];
  });
}

/** Where one phase sits in a process: who opened it and how, which phases run beside it, and the joins it declares. */
export interface PhasePlace {
  workflow: string;
  /** The earlier phase whose open step starts this one, and that hand-off; absent where none does (a phase added by hand). */
  openedBy?: string; handoff?: Handoff;
  /** The phase that opened it and does not wait for it: this one runs alongside it. */
  alongsideOf?: string;
  /** The other phases in its step, which run in parallel with it. */
  beside: string[];
  joins: PhaseJoin[];
}
/** One step of a process: the phases that run in it, in parallel where more than one, and each fork that starts several of them. */
export interface ChainStep { phases: string[]; forks: Array<{ from: string; to: string[] }> }

/**
 * A PROCESS IN ORDERED STEPS, read from its phases' own definitions:
 *  - a phase the phase before it waits on (a `wait: { child }`, or a join naming the open step) starts the next step;
 *  - a phase its opener does not wait on runs alongside it, in the same step: it does not hold its opener;
 *  - a phase that opens several phases is a fork, and those phases run in parallel;
 *  - a phase no earlier phase opens follows the last step, as it was added.
 */
export function processLayout(workflows: Obj, order: readonly string[]): { steps: ChainStep[]; places: Record<string, PhasePlace> } {
  const stepOf = new Map<string, number>();
  const places: Record<string, PhasePlace> = {};
  let last = -1;
  for (const wf of order) {
    const opener = order.slice(0, order.indexOf(wf)).map((from) => ({ from, h: handoffBetween(workflows, from, wf) })).find((x) => x.h);
    const at = !opener ? last + 1 : opener.h!.waits ? (stepOf.get(opener.from) ?? 0) + 1 : (stepOf.get(opener.from) ?? 0);
    stepOf.set(wf, at);
    last = Math.max(last, at);
    places[wf] = {
      workflow: wf, ...(opener ? { openedBy: opener.from, handoff: opener.h! } : {}),
      ...(opener && !opener.h!.waits ? { alongsideOf: opener.from } : {}),
      beside: [], joins: joinsOf(workflows, wf),
    };
  }
  const steps: ChainStep[] = [];
  for (const wf of order) {
    const at = stepOf.get(wf)!;
    while (steps.length <= at) steps.push({ phases: [], forks: [] });
    steps[at].phases.push(wf);
  }
  for (const s of steps) for (const wf of s.phases) places[wf].beside = s.phases.filter((x) => x !== wf);
  // A FORK: one phase opening several, shown at the step its first opened phase starts.
  for (const from of order) {
    const to = order.filter((wf) => places[wf].openedBy === from);
    if (to.length < 2) continue;
    steps[stepOf.get(to[0])!].forks.push({ from, to });
  }
  return { steps: steps.filter((s) => s.phases.length), places };
}
