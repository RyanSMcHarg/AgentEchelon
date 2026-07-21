/**
 * Admin-console mirror of the backend Converse tool registry (`backend/lambda/src/lib/tool-registry.ts`).
 * Kept in sync by hand — the tool set is small and stable. Used by the Profiles config view to explain
 * what each per-profile tool does ("how it functions") and to group them by category. If these drift,
 * the backend is authoritative (it validates a profile's `tools` against ITS registry).
 */
export interface ToolInfo {
  category: 'context' | 'connector' | 'work-item' | 'task';
  description: string;
  requires: string;
}

export const TOOL_INFO: Record<string, ToolInfo> = {
  load_company_context: {
    category: 'context',
    description: 'Fetches the deployment’s company/tenant context so the assistant grounds answers in real facts (classification-scoped by IAM). Runs in-loop.',
    requires: 'a configured context bucket + company-context enabled',
  },
  load_platform_info: {
    category: 'context',
    description: 'Loads platform/product info so the assistant can answer questions about the system itself.',
    requires: 'a configured context bucket + company-context enabled',
  },
  search_corporate_travel: {
    category: 'connector',
    description: 'Mock corporate-travel search — the reference example of an external-action connector tool.',
    requires: 'ENABLE_TRAVEL_TOOL=true on the deployment',
  },
  add_item: {
    category: 'work-item',
    description: 'Proposes ADDING an item to the shared plan/work-item widget (user confirms; never auto-applied).',
    requires: 'edit tools enabled for the conversation',
  },
  update_item: {
    category: 'work-item',
    description: 'Proposes UPDATING a work item. Proposal-and-confirm.',
    requires: 'edit tools enabled for the conversation',
  },
  remove_item: {
    category: 'work-item',
    description: 'Proposes REMOVING a work item. Proposal-and-confirm.',
    requires: 'edit tools enabled for the conversation',
  },
  reorder_items: {
    category: 'work-item',
    description: 'Proposes REORDERING the work items. Proposal-and-confirm.',
    requires: 'edit tools enabled for the conversation',
  },
  assign_item: {
    category: 'work-item',
    description: 'Proposes ASSIGNING a work item to someone. Proposal-and-confirm.',
    requires: 'edit tools enabled for the conversation',
  },
  advance_task_state: {
    category: 'task',
    description: 'Advances a machine-backed task to a legal next state — the only thing that mutates task state.',
    requires: 'an active machine-backed task on the conversation',
  },
};

export function toolInfo(name: string): ToolInfo | undefined {
  return TOOL_INFO[name];
}
