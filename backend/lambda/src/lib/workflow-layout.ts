/**
 * WHERE EACH STEP SITS ON THE CONSOLE'S WORKFLOW CANVAS (ADR-061 decision 7).
 *
 * A version's layout is a map of workflow name to step name to a point on the canvas. It is the console's, never the
 * runtime's: no handler that runs a workflow reads it, validation never checks it against what a workflow does, and it
 * is not hashed into `configId`, so moving a step on the canvas changes neither what the assistant does nor how its
 * turns are attributed.
 *
 * It rides the version as an offloaded body beside the persona (`profile-bodies.ts`, `layoutKey`), never inline in the
 * SSM definition, so a large workflow's positions take nothing from the definition's 4096-character budget. It is
 * versioned with the draft, kept by activation, restored by a rollback (the rolled-to version carries its own pointer),
 * and carried inline by an export and landed by an import.
 *
 * AN INTENT'S MACHINE IS PLACED THE SAME WAY, under `machine:<intent>` (`machineLayoutKey`), from the builder's
 * task-machine mode. An event workflow's name is lowercase letters, digits and hyphens, so no workflow name can be one
 * of these, and a point for a machine the version's pack no longer declares, or a state it no longer has, is dropped.
 *
 * A step with no saved point is placed by the console's automatic layout, and a point for a step or a workflow the
 * version no longer declares is dropped wherever a layout is written (`layoutFor`), so a layout never outlives the
 * step it places.
 */
import type { EventWorkflow } from './event-workflow.js';
import type { TaskStateMachine } from './task-state-machines.js';

export interface StepPosition { x: number; y: number }

/** Workflow name, then step name, then the step's point on the canvas. */
export type WorkflowLayout = Record<string, Record<string, StepPosition>>;

/** How far from the canvas origin a point may sit, in canvas pixels. */
export const MAX_LAYOUT_COORDINATE = 20_000;
/** Workflows and steps a layout may place: the version's own caps (`MAX_VERSION_EVENT_WORKFLOWS`, one step over `MAX_EVENT_WORKFLOW_STEPS`). */
export const MAX_LAYOUT_WORKFLOWS = 8;
export const MAX_LAYOUT_STEPS = 17;
/** Machines a layout may place, and states per machine: well past what any shipped machine declares. */
export const MAX_LAYOUT_MACHINES = 16;
export const MAX_LAYOUT_MACHINE_STEPS = 40;

/** The prefix a machine's entry is keyed under. */
const MACHINE_PREFIX = 'machine:';
/** The layout key an intent's machine is placed under. */
export const machineLayoutKey = (intent: string): string => `${MACHINE_PREFIX}${intent}`;
const isMachineKey = (name: string): boolean => name.startsWith(MACHINE_PREFIX);
/** Where an intent's workflow's steps sit, keyed apart from the event workflows' (ADR-067 stage 1, `intent:<intent>`). */
const INTENT_PREFIX = 'intent:';
export const intentLayoutKey = (intent: string): string => `${INTENT_PREFIX}${intent}`;
const isIntentKey = (name: string): boolean => name.startsWith(INTENT_PREFIX);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCoordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_LAYOUT_COORDINATE;

/** Why a layout is refused as written, or nothing. Checked where a layout is written: a draft edit and an import. */
export function workflowLayoutErrors(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!isObject(raw)) return ['layout maps a workflow name to its steps\' positions'];
  const errs: string[] = [];
  const names = Object.keys(raw);
  if (names.filter((n) => !isMachineKey(n) && !isIntentKey(n)).length > MAX_LAYOUT_WORKFLOWS) errs.push(`layout places at most ${MAX_LAYOUT_WORKFLOWS} workflows`);
  if (names.filter(isIntentKey).length > MAX_LAYOUT_MACHINES) errs.push(`layout places at most ${MAX_LAYOUT_MACHINES} intent workflows`);
  if (names.filter(isMachineKey).length > MAX_LAYOUT_MACHINES) errs.push(`layout places at most ${MAX_LAYOUT_MACHINES} machines`);
  for (const name of names) {
    const steps = raw[name];
    if (!isObject(steps)) { errs.push(`layout.${name} maps a step name to a position`); continue; }
    const cap = isMachineKey(name) ? MAX_LAYOUT_MACHINE_STEPS : MAX_LAYOUT_STEPS;
    if (Object.keys(steps).length > cap) errs.push(`layout.${name} places at most ${cap} steps`);
    for (const [step, at] of Object.entries(steps)) {
      if (!isObject(at) || !isCoordinate(at.x) || !isCoordinate(at.y) || Object.keys(at).some((k) => k !== 'x' && k !== 'y')) {
        errs.push(`layout.${name}.${step} is { x, y }, each a number from -${MAX_LAYOUT_COORDINATE} to ${MAX_LAYOUT_COORDINATE}`);
      }
    }
  }
  return errs;
}

/**
 * THE LAYOUT AS IT IS STORED FOR A VERSION: only the points of steps its workflows and its pack's machines declare, each
 * rounded to a whole pixel. Undefined when nothing is left to place, so a version with no positions stores no body.
 */
export function layoutFor(
  layout: WorkflowLayout | null | undefined,
  eventWorkflows: Readonly<Record<string, Pick<EventWorkflow, 'states'>>> | null | undefined,
  machines?: Readonly<Record<string, Pick<TaskStateMachine, 'states'>>> | null,
  /** The version's intent workflows, whose points are keyed `intent:<intent>`. Undefined, they pass through untouched. */
  intentWorkflows?: Readonly<Record<string, Pick<EventWorkflow, 'states'>>> | null,
): WorkflowLayout | undefined {
  if (!layout) return undefined;
  const out: WorkflowLayout = {};
  for (const [name, steps] of Object.entries(layout)) {
    // A CALLER THAT DOES NOT PASS THE MACHINES (the event workflow builder) keeps their points as they are: they are not
    // its to judge. Every write path on the server passes the pack's machines, or null for none, so a stale point is
    // dropped there.
    const passThrough = ((isMachineKey(name) && machines === undefined) || (isIntentKey(name) && intentWorkflows === undefined)) && isObject(steps);
    const wf = passThrough ? { states: steps }
      : isMachineKey(name) ? machines?.[name.slice(MACHINE_PREFIX.length)]
        : isIntentKey(name) ? intentWorkflows?.[name.slice(INTENT_PREFIX.length)] : eventWorkflows?.[name];
    if (!wf || !isObject(wf.states) || !isObject(steps)) continue;
    const kept = Object.entries(steps)
      .filter(([step, at]) => Object.prototype.hasOwnProperty.call(wf.states, step) && isObject(at) && isCoordinate(at.x) && isCoordinate(at.y))
      .map(([step, at]) => [step, { x: Math.round(at.x), y: Math.round(at.y) }] as const);
    if (kept.length) out[name] = Object.fromEntries(kept);
  }
  return Object.keys(out).length ? out : undefined;
}
