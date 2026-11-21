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

/** `platform`, or the connector or context source that serves a tool. */
export type ToolOwner = 'platform' | `connector:${string}` | `context:${string}`;

export interface ToolDescriptor {
  /** Must match the Converse `toolSpec.name` the loop dispatches on. */
  name: string;
  category: ToolCategory;
  /**
   * TRUE when running this tool CHANGES something.
   *
   * It exists so a turn can say what it did without guessing. When a model ends on a tool block with
   * no text, the reply the person gets depends entirely on this: if only reading happened, nothing
   * changed and they need to know to ask again; if something was advanced or written, telling them
   * "nothing was changed" is false, and "please try again" invites them to redo work that already
   * ran. Both were shipped, in that order.
   *
   * It lives HERE rather than as a list in the one consumer that needed it first, because the next
   * tool added is added here, and a list somewhere else is a list that will not be updated.
   *
   * A PROPOSAL IS NOT A CHANGE. Every work-item tool is proposal-and-confirm and is never applied in
   * the loop, so all of them are FALSE: the person still has to confirm, and telling them their plan
   * was edited when it was only suggested is the same over-claim pointing the other way.
   * `advance_task_state` is the one that persists in-loop, and it is the only TRUE here today.
   */
  changesState: boolean;
  /**
   * WHO FIXES THIS TOOL WHEN IT ERRS OR RETURNS NOTHING USABLE (SPEC-EVALUATION Appendix C3): `platform`,
   * or the connector or context source that serves it, as `connector:<name>` or `context:<name>`. A tool
   * finding names this owner, so it reaches one team instead of being argued between the assistant's
   * team and whoever runs the tool. Required: an entry without one does not compile.
   */
  owner: ToolOwner;
  /** One-line "how it functions" for the admin console + operators. */
  description: string;
  /** The RUNTIME precondition that must ALSO hold for the tool to be offered, even when a profile allows
   *  it — documented so the console can explain "enabled, but only active when X". */
  requires: string;
  /**
   * The assistant roles the tool is offered to, where its runtime precondition is a role: the loop offers it only to
   * a turn acting in one of them (`toolOfferedToRole`), and the console disables it for an assistant in any other.
   * The acting role's IAM grant is the enforcement; this keeps the model from being offered a tool its role is
   * refused. Absent: every role.
   */
  roles?: readonly string[];
  /**
   * WHAT A STATE-CHANGING TOOL MAY WRITE, where that is its own conversation's dashboard alone (DESIGN-CONVERSATION-DASHBOARDS
   * section 5): the key comes from the turn, never the input, and the session's edge reaches its classification's prefix only.
   * An agent step may list such a tool beside its read tools; every other write stays refused there.
   */
  writes?: 'conversation-dashboard';
}

export const TOOL_REGISTRY: ToolDescriptor[] = [
  {
    name: 'load_company_context',
    category: 'context',
    changesState: false,
    owner: 'context:company-context',
    description:
      'Fetches the deployment\'s company/tenant context document so the assistant grounds answers in real facts (classification-scoped by the Lambda\'s S3 IAM). Executed in-loop.',
    requires: 'a configured context bucket (CONTEXT_BUCKET) + company-context enabled for the turn',
  },
  {
    name: 'load_platform_info',
    category: 'context',
    changesState: false,
    owner: 'platform',
    description:
      'Loads platform/product information so the assistant can answer questions about the system itself - including its authorship, licence and source repository - rather than guessing. Executed in-loop.',
    requires: 'a configured context bucket (CONTEXT_BUCKET) + company-context enabled for the turn',
  },
  {
    name: 'read_deployment_health',
    category: 'context',
    changesState: false,
    owner: 'platform',
    description:
      'Reads this deployment\'s own Amazon CloudWatch metrics (Lambda invocations, errors, throttles and average duration) for a bounded window, and its own CloudWatch alarms in ALARM or INSUFFICIENT_DATA (name, state, reason, since when; capped), and the alarm the conversation watches by name, in any state, which may be any alarm in the account (SPEC-WORKFLOWS-AND-TASKS WT120), so an operations assistant answers from telemetry rather than from guesswork. Runs under the assistant\'s own assumed role, so only a role whose boundary grants observability reads can use it; an assistant without that grant is told the figure is unavailable rather than shown an error. Executed in-loop.',
    requires: 'a turn acting as an assistant whose role boundary grants CloudWatch reads (the `ops` role)',
    // The roles the acting role conditions its telemetry grant on (`observabilityRoles` reads this list).
    roles: ['ops'],
  },
  {
    name: 'publish_dashboard',
    category: 'context',
    changesState: true,
    owner: 'platform',
    description:
      'Publishes this conversation\'s dashboard for its members to open in the chat app: the alarm the conversation watches against its threshold, and this deployment\'s Lambda invocations, errors, throttles and average duration over three hours, drawn by the platform. Reads the telemetry as the assistant, writes only its own conversation\'s dashboard, and keeps one dashboard message in the conversation, updated in place. Each member reads it with their own credential (DESIGN-CONVERSATION-DASHBOARDS). Executed in-loop, or as a workflow step\'s declared action.',
    requires: 'a turn acting as an assistant whose role may publish dashboards and read telemetry (the `ops` role), in a conversation',
    roles: ['ops'],
    writes: 'conversation-dashboard',
  },
  {
    name: 'publish_dashboard_page',
    category: 'context',
    changesState: true,
    owner: 'platform',
    description:
      'Publishes this conversation\'s dashboard as a self-contained page, opened from the conversation on a short-lived signed link that is issued to members only, for viewing outside the chat app. The same figures and drawing as publish_dashboard; the page runs no script (DESIGN-CONVERSATION-DASHBOARDS). Executed in-loop, or as a workflow step\'s declared action.',
    requires: 'a turn acting as an assistant whose role may publish dashboards and read telemetry (the `ops` role), in a conversation, on a deployment with the dashboard distribution',
    roles: ['ops'],
    writes: 'conversation-dashboard',
  },
  {
    name: 'propose_meeting_invites',
    category: 'work-item',
    changesState: false,
    owner: 'platform',
    description:
      "Proposes adding people a record names (such as each affected account's team, by the person id the record gives) to this conversation's running meeting, to the meeting and its chat only, each with a brief said privately when they join. Never executed in-loop: it records an add_to_meeting proposal and posts the person who asked a card, which only the meeting's host or a moderator can confirm (SPEC-ASSISTANT-MEETINGS FR42).",
    requires: "a person's turn in a conversation whose meeting is running and takes people from outside it",
  },
  {
    name: 'search_corporate_travel',
    category: 'connector',
    changesState: false,
    owner: 'connector:corporate-travel',
    description:
      'Mock corporate-travel search — the reference example of an external-action connector tool (kept off by default so the platform stays domain-neutral).',
    requires: 'ENABLE_TRAVEL_TOOL=true on the deployment',
  },
  {
    name: 'add_item',
    category: 'work-item',
    changesState: false,
    owner: 'platform',
    description:
      'Proposes ADDING an item to the shared work-item/plan widget. Never executed in-loop — emitted as a proposal the user confirms.',
    requires: 'edit tools enabled for the conversation (a plan/work-item widget is present)',
  },
  {
    name: 'update_item',
    category: 'work-item',
    changesState: false,
    owner: 'platform',
    description: 'Proposes UPDATING a work item (title/status/…). Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'remove_item',
    category: 'work-item',
    changesState: false,
    owner: 'platform',
    description: 'Proposes REMOVING a work item. Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'reorder_items',
    category: 'work-item',
    changesState: false,
    owner: 'platform',
    description: 'Proposes REORDERING the work items. Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'assign_item',
    category: 'work-item',
    changesState: false,
    owner: 'platform',
    description: 'Proposes ASSIGNING a work item to someone. Proposal-and-confirm, never auto-applied.',
    requires: 'edit tools enabled for the conversation',
  },
  {
    name: 'open_work_summary',
    category: 'task',
    changesState: false,
    owner: 'platform',
    description:
      'Lists the open items in this conversation by reference, with the step each is on, who it waits on, and what a waiting step still needs, so the assistant can answer "what do you still need from me?" for every item rather than only the one the turn is on. Read-only; private items are listed as existing and described no further. Executed in-loop from rows the turn already read.',
    requires: 'an ordinary turn in a conversation (not a queue reading or a battle side)',
  },
  {
    name: 'advance_task_state',
    category: 'task',
    changesState: true,
    owner: 'platform',
    description:
      'Advances a machine-backed task to a legal next state — the ONLY thing that mutates task state (authorized against the task\'s state graph and persisted in-loop). SPEC-TASK-STATE-TRANSITIONS §3.',
    requires: 'an active machine-backed task on the conversation',
  },
  {
    // A NEW REQUEST MID-TASK (ADR-067 G15, WT106): opens the person's message as its own task, and moves nothing.
    name: 'open_new_request',
    category: 'task',
    changesState: true,
    owner: 'platform',
    description:
      'Opens the person\'s message as a separate request of another multi-step intent the version declares, as its own task, while the task the turn is on keeps waiting. Once per turn. Granted with advance_task_state.',
    requires: 'an active machine-backed task and a multi-step intent other than its own',
  },
  {
    // A DECLARATION THAT SHIPS SOMETHING. The document it declares is packaged and delivered by the
    // turn, so a turn that ended on this call and no text did change something for the person.
    name: 'deliver_document',
    category: 'task',
    changesState: true,
    owner: 'platform',
    description:
      'Declares the complete deliverable while a task stays in a delivering step: the document of a step that writes its own document on its own model (ADR-064 decision B), or an in-state revision. The platform packages exactly that document as the file and posts the reply as chat. Granted with advance_task_state. SPEC-TASK-STATE-TRANSITIONS §4.',
    requires: 'an active machine-backed task whose current step delivers, or whose next step writes its own document',
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

/**
 * Did any of these tools CHANGE something, as opposed to reading or proposing?
 *
 * Asked by a turn that has to describe what it did without guessing. An unknown name answers false:
 * a tool this registry does not know about has not been shown to change anything, and claiming a
 * change on the strength of a name nobody declared is the over-claim this exists to prevent.
 */
/** The owner a tool finding is routed to. An unknown tool is the platform's: nothing else declared it. */
export function toolOwnerOf(name: string): ToolOwner {
  return TOOL_REGISTRY.find((t) => t.name === name)?.owner ?? 'platform';
}

/** Whether a tool writes only its own conversation's dashboard (`writes`). */
export function toolWritesOnlyItsDashboard(name: string): boolean {
  return TOOL_REGISTRY.find((t) => t.name === name)?.writes === 'conversation-dashboard';
}

/** Whether a tool is declared to change something (the tool judge scores such a call by its effect). */
export function toolChangesState(name: string): boolean {
  return TOOL_REGISTRY.find((t) => t.name === name)?.changesState === true;
}

export function anyToolChangedState(toolNames: readonly string[]): boolean {
  return toolNames.some((n) => TOOL_REGISTRY.find((t) => t.name === n)?.changesState === true);
}

/**
 * Whether a tool may be offered to a turn acting in `role`: true for a tool with no role precondition, and for one
 * whose `roles` names it. An unknown tool name, or an empty role (no assistant identity held), is offered nothing
 * a role precondition guards.
 */
/** The roles a tool names as its precondition, or undefined when it names none (offered to every role). */
export function toolRolesOf(name: string): readonly string[] | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)?.roles;
}

export function toolOfferedToRole(name: string, role: string): boolean {
  const roles = TOOL_REGISTRY.find((t) => t.name === name)?.roles;
  return !roles || (!!role && roles.includes(role));
}
