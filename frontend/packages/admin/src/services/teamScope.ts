/**
 * THE ASSISTANT A TEAM MEMBER'S CONSOLE IS SCOPED TO (SPEC-ADMIN-CONSOLE FR48).
 *
 * A team member's console session reaches only `.../assistants/{assistant}/...` routes, for the
 * assistants their team owns. This holds which of those the console is showing, and each service
 * composes that assistant's team route from it (`adminUrl` with the team path written out), so a service
 * makes the same call for an admin and for a team member and only the URL differs. Null for an admin,
 * whose routes are unscoped.
 *
 * Not an enforcement layer: IAM refuses a path the session does not name, and the handler re-checks
 * ownership, whatever a service composes.
 */
let active: string | null = null;

export function setTeamAssistant(assistant: string | null): void {
  active = assistant;
}

/** The assistant the console is scoped to, or null when it is not scoped (an admin). */
export function teamAssistant(): string | null {
  return active;
}


/**
 * THE ANALYTICS A TEAM'S ROUTE ANSWERS: the queries the backend binds to one assistant, by SQL filter
 * or by row (`ASSISTANT_FILTERED_QUERIES` and `ASSISTANT_ROW_QUERIES` in
 * `backend/lambda/src/analytics-aurora/analytics-query.ts`). Any other query is refused there, so the
 * console does not ask for it on a team's behalf. `teamScope.test.ts` keeps this list equal to that one.
 */
export const TEAM_QUERY_TYPES: ReadonlySet<string> = new Set([
  'intent_effectiveness',
  // One intent's step and model breakdown, over the same filters.
  'intent_steps',
  'latency_exchanges',
  'latency_metrics',
  // Attributed per turn through the exchange that assistant answered.
  'model_usage',
  'model_effectiveness',
  'turn_kinds',
  'drift_events',
  'workflow_trajectory',
  'safety_readings',
  'frustration',
  'retrieval_sources',
  'judge_calibration',
  'tool_outcomes',
  'template_outcomes',
  'message_flow',
  'welcome_flow',
  'flow_turns',
  'flow_turn',
  // Bound to the assistant in SQL, read with a stated reason (`ASSISTANT_BOUND_QUALITY`).
  'flagged_responses',
  'ground_truth',
  'label_queue',
  'golden_set',
]);

/** The team reads that return what was said, and so carry a stated reason (`ASSISTANT_BOUND_QUALITY`). */
export const TEAM_REASONED_QUERIES: ReadonlySet<string> = new Set(['flagged_responses', 'ground_truth', 'label_queue', 'golden_set']);

/** Whether the console may ask for this query: always for an admin, only an attributed one for a team. */
export function teamCanQuery(queryType: string): boolean {
  return !active || TEAM_QUERY_TYPES.has(queryType);
}
