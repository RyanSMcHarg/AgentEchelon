/**
 * THE FIELD CHECKS BOTH LEVELS OF A WORKFLOW SHARE (ADR-067 stage 4, "One step schema").
 *
 * A run's steps (`eventWorkflowErrors`, event-workflow.ts) and a task's steps (`validateTaskStateMachine`,
 * task-state-machines.ts) declare some of the same fields. Each such field is checked here, once, with one wording, so a
 * malformed field is refused the same way at either level and a rule changed for one changes for both. Each level keeps
 * what is its own: which fields a step may carry, and whether a refusal is collected (a run) or thrown (a machine).
 *
 * Pure: no AWS call.
 */
import { isKnownTool, toolChangesState, toolWritesOnlyItsDashboard } from './tool-registry.js';

/**
 * WHY A STEP'S TOOL LIST IS REFUSED, or nothing: a list of tool names, each named once, each a registered tool, and, where
 * the step may only read (`readOnly`, the reason it gives), none that changes state. `at` names the field, as each level
 * names its steps (`eventWorkflows.<name>.states.<step>.agent.tools`, `state "<step>" tools`).
 */
export function toolListErrors(tools: unknown, at: string, opts: { readOnly?: string; dashboardWrites?: boolean } = {}): string[] {
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || !t.trim())) return [`${at} is a list of tool names`];
  const errs: string[] = [];
  if (new Set(tools).size !== tools.length) errs.push(`${at} names the same tool twice`);
  for (const t of tools as string[]) {
    if (!isKnownTool(t)) errs.push(`${at} names "${t}", which is not a registered tool`);
    // A TOOL THAT WRITES ONLY ITS OWN CONVERSATION'S DASHBOARD is admitted beside read tools (DESIGN-CONVERSATION-DASHBOARDS section 5).
    else if (opts.readOnly && toolChangesState(t) && !(opts.dashboardWrites && toolWritesOnlyItsDashboard(t))) errs.push(`${at} names "${t}", which changes state; ${opts.readOnly}`);
  }
  return errs;
}
