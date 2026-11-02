/**
 * A TASK AN EVENT OPENS (ADR-061 decision 8, an `agent` step's `workflow:`).
 *
 * The runtime opens the task in the room before the step's turn, and the turn runs the task's first step: the first look
 * at an incident reads the deployment's health and says what it found, and the task then rests on its next step as the
 * room's work. Opening it is the runtime's act, never a tool the model calls, so a model's output never chooses to open
 * work and opens none of its own.
 *
 * What it guarantees:
 *  - ONLY A MACHINE AN EVENT MAY OPEN (`EVENT_TASK_MACHINES`): a platform machine whose first step awaits nobody, because
 *    a task an event opens has no requester to wait on.
 *  - ONE TASK PER STEP OF A RUN. Its id follows from the run's key and the step, so a turn the processor runs again for
 *    the same step opens the same task rather than a second one.
 *  - THE ASSISTANT'S WORK, IN THE ROOM. Owned by the assistant that runs the step and visible to the conversation, opened
 *    through the task service under that assistant's own grant, as any task is.
 *  - NEVER THROWS. A task that could not be opened leaves the turn to run as a plain agent step, and is logged.
 */
import { createHash } from 'crypto';
import { createTask } from './task-store.js';
import { DeliveryOption } from './delivery-options.js';
import { DEFAULT_TASK_STATE_MACHINES } from './task-state-machines.js';
import { isEventTaskMachine } from './event-workflow.js';
import { principalIdFromArn } from './person-arn.js';
import type { Task } from './task-tracking.js';

/** The task's id for one step of one run: the same on every turn the processor runs for that step. */
export function eventTaskId(runKey: string, step: string): string {
  return `evt-${createHash('sha256').update(`${runKey}#${step}`).digest('hex').slice(0, 24)}`;
}

export interface OpenedEventTask {
  task: Task;
  /** The first step's instructions, which the turn runs after the agent step's own prompt. */
  stepPrompt?: string;
  /** The first step's one declared transition, which the runtime takes once the turn posted. */
  next?: string;
}

export async function openEventTask(
  args: { machine: string; channelArn: string; runKey: string; step: string; botArn: string; excerpt?: string },
  deps: { create?: typeof createTask } = {},
): Promise<OpenedEventTask | undefined> {
  const machine = isEventTaskMachine(args.machine) ? DEFAULT_TASK_STATE_MACHINES[args.machine] : undefined;
  if (!machine) {
    console.warn('[event-task] the step names no task machine an event may open; it runs as a plain agent step', { machine: args.machine });
    return undefined;
  }
  const first = machine.states[machine.initial];
  const assistant = principalIdFromArn(args.botArn);
  try {
    const task = await (deps.create ?? createTask)(
      { requestAttributes: { 'CHIME.channel.arn': args.channelArn } },
      DeliveryOption.TASK_MULTI_STEP,
      args.machine,
      undefined,
      {
        taskId: eventTaskId(args.runKey, args.step),
        machines: { [args.machine]: machine },
        ...(assistant ? { owner: { id: assistant, type: 'assistant' as const }, assistantId: assistant } : {}),
        visibility: 'conversation',
        requestExcerpt: (args.excerpt ?? '').slice(0, 200),
      },
    );
    return {
      task,
      ...(first?.prompt ? { stepPrompt: first.prompt } : {}),
      ...(first && first.transitions.length === 1 ? { next: first.transitions[0] } : {}),
    };
  } catch (err) {
    console.warn('[event-task] the task could not be opened; the step runs as a plain agent step', { machine: args.machine, err: (err as Error)?.message });
    return undefined;
  }
}
