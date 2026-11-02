/**
 * A WORKFLOW AS THE CANVAS DRAWS IT (ADR-061 decision 7): its edges, where each step sits, and which of the server's
 * errors belong to which step.
 *
 * Where a step sits is its saved point when the version has one (`layout`, stored per version beside the persona), and
 * otherwise a computed one: steps in rows by how many steps the run takes to reach them from the first, each row left
 * to right in the order the run meets them, and a step no edge reaches in a row of its own below. The graph is drawn
 * from the workflow itself, so the canvas shows only what the runtime runs.
 */
import { edgeTargets, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import type { StepPosition, WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { layoutFor } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { orderedSteps, type EdgeName } from './workflowEdits';

export const NODE_W = 232;
export const NODE_H = 92;
export const GAP_X = 56;
export const GAP_Y = 72;
export const MARGIN = 32;
/** Room above the first step for the event that starts the run. */
export const TRIGGER_H = 64;
/** How far a key press moves a step, and with Shift. */
export const NUDGE = 8;
export const NUDGE_FAR = 40;
/** Points snap to this grid, so a drag lands where a key press would. */
export const GRID = 8;

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** One edge as drawn: which outcome it is, and on a conditioned edge, which alternative. */
export interface GraphEdge {
  from: string;
  to: string;
  edge: EdgeName;
  /** A conditioned edge's alternative: one with a `when`, or the last, taken otherwise. */
  alternative?: 'when' | 'otherwise';
}

/** Every edge of a workflow, a conditioned edge's alternatives each their own. An edge to a missing step is left out. */
export function edgesOf(wf: EventWorkflow): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const [from, def] of Object.entries(wf.states)) {
    for (const edge of ['onSuccess', 'onFailure', 'onDeadline'] as const) {
      const value = def[edge];
      if (value === undefined) continue;
      if (typeof value === 'string') {
        if (wf.states[value]) out.push({ from, to: value, edge });
        continue;
      }
      value.forEach((alt, i) => {
        if (wf.states[alt.to]) out.push({ from, to: alt.to, edge, alternative: i === value.length - 1 ? 'otherwise' : 'when' });
      });
    }
  }
  return out;
}

/** The computed point of every step: rows by distance from the first step, unreached steps in a row below. */
export function autoLayout(wf: EventWorkflow): Record<string, StepPosition> {
  const depth = new Map<string, number>();
  const rows: string[][] = [];
  const queue: string[] = wf.states[wf.initial] ? [wf.initial] : [];
  if (queue.length) depth.set(wf.initial, 0);
  while (queue.length) {
    const at = queue.shift()!;
    const d = depth.get(at)!;
    (rows[d] ??= []).push(at);
    const def = wf.states[at];
    for (const next of [def.onSuccess, def.onFailure, def.onDeadline].flatMap((e) => edgeTargets(e))) {
      if (wf.states[next] && !depth.has(next)) { depth.set(next, d + 1); queue.push(next); }
    }
  }
  const unreached = orderedSteps(wf).map(([k]) => k).filter((k) => !depth.has(k));
  if (unreached.length) rows.push(unreached);
  const out: Record<string, StepPosition> = {};
  rows.forEach((row, r) => row.forEach((key, c) => {
    out[key] = { x: MARGIN + c * (NODE_W + GAP_X), y: MARGIN + TRIGGER_H + GAP_Y / 2 + r * (NODE_H + GAP_Y) };
  }));
  return out;
}

/** Where each step is drawn: its saved point, else its computed one. */
export function positionsOf(wf: EventWorkflow, saved: Readonly<Record<string, StepPosition>> | undefined): Record<string, StepPosition> {
  const auto = autoLayout(wf);
  return Object.fromEntries(Object.keys(wf.states).map((k) => [k, saved?.[k] ?? auto[k]]));
}

/** The event's point: above the step the run starts at. */
export function triggerAt(wf: EventWorkflow, positions: Readonly<Record<string, StepPosition>>): StepPosition {
  const first = positions[wf.initial] ?? { x: MARGIN, y: MARGIN + TRIGGER_H + GAP_Y / 2 };
  return { x: first.x, y: Math.max(0, first.y - TRIGGER_H - GAP_Y / 2) };
}

/** The plane the canvas scrolls over: every step, with a margin, and never smaller than the view's minimum. */
export function planeSize(positions: Readonly<Record<string, StepPosition>>): { width: number; height: number } {
  const points = Object.values(positions);
  const width = Math.max(...points.map((p) => p.x + NODE_W), NODE_W) + MARGIN * 2;
  const height = Math.max(...points.map((p) => p.y + NODE_H), NODE_H + TRIGGER_H) + MARGIN * 2;
  return { width, height };
}

/** The path an edge is drawn on, from the bottom (success), right (failure) or left (deadline) of its step to the top of the next. */
export function edgePath(from: StepPosition, to: StepPosition, edge: EdgeName): { d: string; mid: StepPosition } {
  const start = edge === 'onSuccess' ? { x: from.x + NODE_W / 2, y: from.y + NODE_H }
    : edge === 'onFailure' ? { x: from.x + NODE_W, y: from.y + NODE_H / 2 }
      : { x: from.x, y: from.y + NODE_H / 2 };
  const end = { x: to.x + NODE_W / 2, y: to.y };
  const bend = Math.max(40, Math.abs(end.y - start.y) / 2);
  const c1 = edge === 'onSuccess' ? { x: start.x, y: start.y + bend } : { x: start.x + (edge === 'onFailure' ? bend : -bend), y: start.y };
  const c2 = { x: end.x, y: end.y - bend };
  return { d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
}

/**
 * THE SERVER'S ERRORS, ANCHORED (B2): an error naming `eventWorkflows.<name>.states.<step>` belongs to that step, one
 * naming the workflow otherwise belongs to the workflow, and one naming neither (another workflow, another field of the
 * version) is not this workflow's.
 */
export function anchoredErrors(errors: readonly string[], name: string, wf: EventWorkflow | undefined): { steps: Record<string, string[]>; workflow: string[] } {
  const steps: Record<string, string[]> = {};
  const workflow: string[] = [];
  const prefix = `eventWorkflows.${name}`;
  for (const e of errors) {
    const at = e.indexOf(prefix);
    if (at < 0) continue;
    const rest = e.slice(at + prefix.length);
    if (rest && !/^[.\s:,;)]/.test(rest)) continue;
    const m = /^\.states\.([a-z0-9][a-z0-9-]*)/.exec(rest);
    if (m && wf?.states[m[1]]) (steps[m[1]] ??= []).push(e);
    else workflow.push(e);
  }
  return { steps, workflow };
}

/** A version's layout with one workflow's points replaced, as it is saved: only declared steps, rounded (`layoutFor`). */
export function withWorkflowLayout(
  layout: WorkflowLayout | undefined, workflows: Readonly<Record<string, EventWorkflow>>, name: string, points: Record<string, StepPosition>,
): WorkflowLayout | null {
  return layoutFor({ ...(layout ?? {}), [name]: points }, workflows) ?? null;
}
