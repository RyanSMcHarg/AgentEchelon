/**
 * The canonical registry of Converse tools an assistant profile may enable (SPEC-ASSISTANT-CONFIG §4).
 *
 * Tools are now PER-PROFILE: a profile version's `tools` allowlist names which of these the self-hosted
 * Converse loop (`async-processor-core.ts`) may offer, INTERSECTED with each tool's runtime availability
 * (`requires`). This module is the single source of truth for the tool NAMES + human descriptions used to
 * (a) seed a profile's default tool set, (b) validate a profile's `tools` at the write path (reject an
 * unknown tool), and (c) render the admin console's per-tool "what it does / how it functions" surface.
 *
 * It is pure metadata — the loop keeps the executable `toolSpec`s next to their handlers; this only mirrors
 * their names + intent so the config layer and the loop agree on one vocabulary.
 */
export type ToolCategory = 'context' | 'connector' | 'work-item' | 'task';

export interface ToolDescriptor {
  /** Must match the Converse `toolSpec.name` the loop dispatches on. */
  name: string;
  category: ToolCategory;
  /** One-line "how it functions" for the admin console + operators. */
  description: string;
  /** The RUNTIME precondition that must ALSO hold for the tool to be offered, even when a profile allows
   *  it — documented so the console can explain "enabled, but only active when X". */
  requires: string;
}

export const TOOL_REGISTRY: ToolDescriptor[] = [
  {
    name: 'load_company_context',
    category: 'context',
    description:
      'Fetches the deployment\'s company/tenant context document so the assistant grounds answers in real facts (classification-scoped by the Lambda\'s S3 IAM). Executed in-loop.',
    requires: 'a configured context bucket (CONTEXT_BUCKET) + company-context enabled for the turn',
  },
  {
    name: 'load_platform_info',
    category: 'context',
    description:
      'Loads platform/product information so the assistant can answer questions about the system itself rather than guessing. Executed in-loop.',
    requires: 'a configured context bucket (CONTEXT_BUCKET) + company-context enabled for the turn',
  },
  {
    name: 'search_corporate_travel',
    category: 'connector',
    description:
      'Mock corporate-travel search — the reference example of an external-action connector tool (kept off by default so the platform stays domain-neutral).',
    requires: 'ENABLE_TRAVEL_TOOL=true on the deployment',
  },
  {
    name: 'add_item',
    category: 'work-item',
    description:
      'Proposes ADDING an item to the shared work-item/plan widget. Never executed in-loop — emitted as a proposal the user confirms.',
    requires: 'edit tools enabled for the conversation (a plan/work-item widget is present)',
  },
  {
    name: 'update_item',
    category: 'work-item',
    description: 'Proposes UPDATING a work item (title/status/…). Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'remove_item',
    category: 'work-item',
    description: 'Proposes REMOVING a work item. Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'reorder_items',
    category: 'work-item',
    description: 'Proposes REORDERING the work items. Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'assign_item',
    category: 'work-item',
    description: 'Proposes ASSIGNING a work item to someone. Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'advance_task_state',
    category: 'task',
    description:
      'Advances a machine-backed task to a legal next state — the ONLY thing that mutates task state (authorized against the task\'s state graph and persisted in-loop). SPEC-TASK-STATE-TRANSITIONS §3.',
    requires: 'an active machine-backed task on the conversation',
  },
];

export const ALL_TOOL_NAMES: string[] = TOOL_REGISTRY.map((t) => t.name);
const TOOL_NAME_SET = new Set(ALL_TOOL_NAMES);

export function isKnownTool(name: string): boolean {
  return TOOL_NAME_SET.has(name);
}

/** The unknown tool names in a profile's `tools` (empty ⇒ all valid). */
export function unknownTools(tools: string[]): string[] {
  return tools.filter((t) => !isKnownTool(t));
}
