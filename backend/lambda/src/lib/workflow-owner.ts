/**
 * WHOSE EVENT WORKFLOWS RUN IN A ROOM (ADR-061 decision 2, DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8).
 *
 * The room's primary ORCHESTRATES: it takes every turn nobody addressed, answers `@all` and says the room's notices
 * (`primaryAssistantOf`). An event's workflow is OWNED: it runs from the owning assistant's served version, on that
 * assistant's session, and everything it posts is said as that assistant. The owner is, in order:
 *
 *  1. THE ASSISTANT A TRIGGER WAS ATTACHED FOR. An `event-received` trigger is attached from one assistant's version in the
 *     console, and the attach records that assistant on the rule (`attachedBy`), so its event runs that version's workflow.
 *  2. THE ROLE THE ROOM'S TYPE NAMES (`workflowOwner: { assistantRole }`, `lib/config/conversation-types.ts`): the
 *     classification's declared live assistant holding that role. An operations room's events run the ops assistant's
 *     workflows, whoever the room's primary is.
 *  3. THE ROOM'S PRIMARY, for a type that names no owner, or names a role no declared assistant of the classification holds:
 *     every ordinary room runs its primary's workflows, and so does a type's room where the deployment declares no owner.
 *
 * RESOLVED HERE AND ONLY HERE, as data: a handle or a role read from the assignment records, never a name matched in
 * code, and every event handler asks this one function. An owner that is not the primary must be a member of the room,
 * read live; a run whose owner is absent, unresolvable or not a member is REFUSED with a reason, and never runs as the
 * primary instead, because a workflow speaks only as the assistant that owns it.
 */
import { liveAssistantsByHandleOrThrow, type ResolvedAgent } from './default-agents.js';
import { primaryAssistantOf, type RoomPrimary } from './conversation-primary.js';
import type { TagReader } from './channel-classification.js';
import { CONVERSATION_TYPES } from '../../../lib/config/conversation-types';
import { ASSISTANT_HANDLE } from './event-triggers.js';


export interface WorkflowOwner {
  /** The owning assistant's handle, as the assignment records name it. */
  assistant: string;
  botArn: string;
  classification: string;
  /** Why it owns the run: the trigger was attached for it, the room's type names its role, or it is the room's primary. */
  source: 'trigger' | 'type' | 'primary';
}

export interface WorkflowOwnerRefused {
  refused: string;
}

export interface WorkflowOwnerDeps {
  /** The bot ARNs that are members of the room now, read as `bearerArn` (the primary, a member by creation). Null when unreadable. */
  botsInRoom: (channelArn: string, bearerArn: string) => Promise<readonly string[] | null>;
  primaryOf?: (channelArn: string) => Promise<RoomPrimary>;
  assistantsOf?: (classification: string) => Promise<Map<string, ResolvedAgent>>;
}

/** The assistant role a conversation type names as the owner of its event workflows, or undefined. */
export function workflowOwnerRoleOf(conversationType: string | undefined): string | undefined {
  return conversationType ? CONVERSATION_TYPES[conversationType]?.workflowOwner?.assistantRole : undefined;
}

/**
 * THE DECLARED ASSISTANT HOLDING A ROLE in one classification: the deployment's own assistant for it, never a console-created
 * one (whose record carries a runtime seed), the same rule the classification's primary is read by (`primaryAssignmentOf`).
 * `ambiguous` where more than one declared assistant holds it, so nothing is picked by the order of a map.
 */
export function declaredHolderOfRole(assistants: ReadonlyMap<string, ResolvedAgent>, role: string): ResolvedAgent | 'ambiguous' | undefined {
  const holders = [...assistants.values()].filter((a) => a.role === role && !a.runtimeSeed && a.botArn);
  if (holders.length > 1) return 'ambiguous';
  return holders[0];
}

/**
 * THE ASSISTANT WHOSE WORKFLOW AN EVENT IN THIS ROOM RUNS, or why none may run. `conversationType` is the room's type from its
 * server-side row (or the type a binding names); `attachedBy` is the assistant a trigger's rule records, when it records one.
 */
export async function workflowOwnerOf(
  channelArn: string,
  chime: TagReader,
  args: { conversationType?: string; attachedBy?: string; logPrefix?: string },
  deps: WorkflowOwnerDeps,
): Promise<WorkflowOwner | WorkflowOwnerRefused> {
  const logPrefix = args.logPrefix ?? '[workflow-owner]';
  const primary = await (deps.primaryOf ?? ((arn: string) => primaryAssistantOf(arn, chime, logPrefix)))(channelArn);
  const { classification } = primary;
  let owner: WorkflowOwner;
  if (args.attachedBy !== undefined) {
    if (!ASSISTANT_HANDLE.test(args.attachedBy)) return { refused: 'the trigger names no assistant' };
    const named = (await (deps.assistantsOf ?? liveAssistantsByHandleOrThrow)(classification)).get(args.attachedBy);
    if (!named?.botArn) return { refused: 'the assistant the trigger was attached for is not a live assistant of this classification' };
    owner = { assistant: named.handle, botArn: named.botArn, classification, source: 'trigger' };
  } else {
    const role = workflowOwnerRoleOf(args.conversationType);
    if (!role) return { assistant: primary.assistant, botArn: primary.botArn, classification, source: 'primary' };
    const holder = declaredHolderOfRole(await (deps.assistantsOf ?? liveAssistantsByHandleOrThrow)(classification), role);
    if (holder === 'ambiguous') return { refused: `more than one assistant holds the ${role} role that owns this type's workflows` };
    // A DEPLOYMENT THAT DECLARES NO ASSISTANT IN THE ROLE runs the room's primary's workflows, as a type naming no owner does:
    // the role is the owner where it is declared, and a room of the type still works where it is not.
    if (!holder) return { assistant: primary.assistant, botArn: primary.botArn, classification, source: 'primary' };
    owner = { assistant: holder.handle, botArn: holder.botArn, classification, source: 'type' };
  }
  // THE PRIMARY IS A MEMBER BY CREATION; ANY OTHER OWNER IS READ LIVE, so a workflow never speaks in a room its owner is not in.
  if (owner.botArn === primary.botArn) return owner;
  const bots = await deps.botsInRoom(channelArn, primary.botArn).catch(() => null);
  if (!bots) return { refused: 'the room\'s members could not be read' };
  if (!bots.includes(owner.botArn)) {
    console.warn(`${logPrefix} the assistant that owns the event's workflow is not a member of the room; nothing runs`, {
      channelArn, owner: owner.assistant, source: owner.source,
    });
    return { refused: 'the assistant that owns the workflow is not a member of the room' };
  }
  return owner;
}
