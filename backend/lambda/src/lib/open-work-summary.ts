/**
 * WHAT IS OPEN HERE, AND WHAT EACH ITEM STILL NEEDS (the `open_work_summary` tool).
 *
 * A person asks "what do you still need from me?" and the assistant could answer it for one item
 * only: the task the turn was on carries its step's needs in the prompt, while every other open item
 * arrived as a type, a state and who holds it. So the answer covered the item in front of the
 * assistant and was silent about the rest, which is exactly the list the person was asking for.
 *
 * This is the read behind that answer. It is built from rows the turn already read (the conversation's
 * open work and the turn's own task), so calling the tool costs no further read, and it is pure so
 * every rule below is testable without a store.
 *
 * WHAT IT WILL NOT SAY:
 *   - anything from another conversation: the reply is written into this one;
 *   - what a private item needs or is, even to its own requester: the reply can be visible to the
 *     room, and a need ("the customer's account number") says what the work is. A private item is
 *     listed by reference as existing, which the room may already see;
 *   - the person's own words: requests are described by the machine's declared needs, never quoted.
 */
import type { TaskStateMachine } from './task-state-machines.js';
import { awaitedPartyOf } from './task-state-machines.js';
import type { ConversationTask, Task } from './task-tracking.js';
import { isPrivateVisibility } from './task-visibility.js';

export const OPEN_WORK_SUMMARY_TOOL_NAME = 'open_work_summary';

/** One open item as the tool reports it. */
export interface OpenWorkSummaryItem {
  /** `#<n>`, the reference a person types to answer it (ADR-035). Absent on older rows. */
  reference?: string;
  /** The kind of work, in plain words. Absent on a private item. */
  kind?: string;
  /** The step it is on. Absent on a private item. */
  step?: string;
  /** Who has to move it next, relative to the person asking. */
  waitingOn: 'you' | 'another person' | 'an assistant' | 'nobody yet';
  /** What the step still needs, as the machine declares it, less anything already given. */
  stillNeeds?: string[];
  /** What was already given for this step, by requirement name only, never the value. */
  alreadyGiven?: string[];
  /** The item this turn is answering. */
  current?: true;
  /** A private item: listed so the person knows it exists, described no further. */
  private?: true;
}

function readable(key: string | undefined): string | undefined {
  return key ? key.replace(/[_-]+/g, ' ').trim() : undefined;
}

/**
 * Build the summary for the person asking.
 *
 * `viewerId` is their principal id; `active` is the turn's own task row, which is the only one whose
 * collected answers the turn holds, so only that item can say what is already given.
 */
export function buildOpenWorkSummary(
  tasks: ConversationTask[],
  args: {
    viewerId?: string;
    machines: Record<string, TaskStateMachine>;
    active?: Pick<Task, 'taskId' | 'taskType' | 'taskState' | 'details' | 'taskRef' | 'visibility'> | null;
  },
): OpenWorkSummaryItem[] {
  const rows = [...(tasks ?? [])];
  // The turn's own task is described by the conversation read too, unless it was just opened; either
  // way it is listed once, from the full row.
  if (args.active && !rows.some((t) => t.taskId === args.active!.taskId)) {
    rows.unshift({
      taskId: args.active.taskId,
      channelArn: '',
      status: 'in_progress',
      createdAt: '',
      updatedAt: '',
      ...(args.active.taskRef ? { taskRef: args.active.taskRef } : {}),
      ...(args.active.taskType ? { taskType: args.active.taskType } : {}),
      ...(args.active.taskState ? { taskState: args.active.taskState } : {}),
      ...(isPrivateVisibility(args.active.visibility) ? { privateItem: true as const } : {}),
    });
  }

  return rows
    .sort((a, b) => (a.taskRef ?? Number.MAX_SAFE_INTEGER) - (b.taskRef ?? Number.MAX_SAFE_INTEGER))
    .map((t): OpenWorkSummaryItem => {
      const waitingOn: OpenWorkSummaryItem['waitingOn'] = t.assigneeType === 'assistant'
        ? 'an assistant'
        : t.assigneeType === 'user'
          ? (args.viewerId && t.assigneeId === args.viewerId ? 'you' : 'another person')
          : 'nobody yet';
      const reference = t.taskRef ? `#${t.taskRef}` : undefined;
      const isCurrent = args.active?.taskId === t.taskId;
      const isPrivate = t.private || t.privateItem
        || (isCurrent && isPrivateVisibility(args.active?.visibility));
      if (isPrivate) {
        return {
          ...(reference ? { reference } : {}),
          waitingOn,
          private: true,
          ...(isCurrent ? { current: true as const } : {}),
        };
      }

      const state = t.taskType && t.taskState ? args.machines[t.taskType]?.states?.[t.taskState] : undefined;
      // Needs only for a step that waits on somebody: a step the assistant is getting on with has
      // nothing to ask anyone for.
      const declared = state && awaitedPartyOf(state) ? (state.requires ?? []) : [];
      const given = isCurrent
        ? Object.keys(((args.active?.details as { requirements?: Record<string, unknown> } | undefined)
          ?.requirements) ?? {})
        : [];
      const alreadyGiven = declared.filter((r) => given.includes(r));
      const stillNeeds = declared.filter((r) => !given.includes(r));
      return {
        ...(reference ? { reference } : {}),
        ...(readable(t.taskType) ? { kind: readable(t.taskType) } : {}),
        ...(readable(t.taskState) ? { step: readable(t.taskState) } : {}),
        waitingOn,
        ...(stillNeeds.length ? { stillNeeds } : {}),
        ...(alreadyGiven.length ? { alreadyGiven } : {}),
        ...(isCurrent ? { current: true as const } : {}),
      };
    });
}

/** The Converse tool spec. Takes no input: the summary is always of this conversation, for the speaker. */
export const OPEN_WORK_SUMMARY_TOOL_SPEC = {
  toolSpec: {
    name: OPEN_WORK_SUMMARY_TOOL_NAME,
    description:
      'List the open items in THIS conversation with what each one still needs: its reference (#n), '
      + 'the kind of work, the step it is on, who it is waiting on, and for a step waiting on someone, '
      + 'what that step still needs. Call it when the person asks what is outstanding, what you still '
      + 'need from them, or where their work stands. It reads only; it changes nothing. Name items by '
      + 'their reference so the person can reply starting with it. Say only that a private item exists, '
      + 'never what it is or needs.',
    inputSchema: { json: { type: 'object', properties: {}, required: [] } },
  },
};

/** The tool's result: the items, and how to use them. */
export function openWorkSummaryPayload(items: OpenWorkSummaryItem[]): Record<string, unknown> {
  return {
    items,
    guidance: items.length
      ? 'Summarize these for the person in your own words, most relevant first. Name each by its '
        + 'reference and tell them to start a reply with it to answer that item. For a private item, '
        + 'say only that it is open.'
      : 'Nothing is open in this conversation. Say so plainly.',
  };
}
