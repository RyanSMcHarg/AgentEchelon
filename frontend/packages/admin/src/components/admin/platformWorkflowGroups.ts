/**
 * THE PLATFORM'S WORKFLOWS, GROUPED BY WHAT THEY ARE FOR, each group explained once on the assistant's page. A platform
 * workflow no group names is listed under `other`, so a new one is shown even before it is given a place.
 */
export const PLATFORM_WORKFLOW_GROUPS = [
  { id: 'queue', keys: ['queue_drain', 'queued_request', 'queued_clarification', 'queued_combination', 'work_still_wanted'] },
  { id: 'tasks', keys: ['action_item', 'place_item', 'approval', 'acknowledgement', 'form', 'meeting_action_item'] },
  { id: 'conversation', keys: ['drift_offer', 'meeting_offer', 'incident_ownership', 'dashboard_refresh', 'customer_impact', 'customer_updates', 'final_notice'] },
] as const;

export type PlatformWorkflowGroupId = (typeof PLATFORM_WORKFLOW_GROUPS)[number]['id'] | 'other';

/** The groups that have a workflow to show, in order, each holding its workflows in the group's own order. */
export function groupPlatformWorkflows<W extends { key: string }>(
  workflows: readonly W[],
): Array<{ id: PlatformWorkflowGroupId; workflows: W[] }> {
  const named = new Set<string>(PLATFORM_WORKFLOW_GROUPS.flatMap((g) => [...g.keys]));
  const groups: Array<{ id: PlatformWorkflowGroupId; workflows: W[] }> = PLATFORM_WORKFLOW_GROUPS.map((g) => ({
    id: g.id,
    workflows: g.keys.flatMap((k) => workflows.filter((w) => w.key === k)),
  }));
  groups.push({ id: 'other', workflows: workflows.filter((w) => !named.has(w.key)) });
  return groups.filter((g) => g.workflows.length > 0);
}
