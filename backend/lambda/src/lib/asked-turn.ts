/**
 * A TURN ANOTHER ASSISTANT'S RUN ASKED FOR (WT118, DESIGN-WORKFLOWS-AND-TASKS section 1): a request naming one of this
 * assistant's single-turn intents. The turn is this assistant's own: its session, its version, the intent's own
 * instructions and tools, read here from its own pack. The asking run supplies only what it needs, as data, and is handed how
 * the turn went. A dispatch naming an intent this assistant does not declare as single-turn runs nothing.
 */
import type { EventWorkflow, WorkflowEvent } from './event-workflow.js';
import type { RunOrigin, RunTrigger } from './task-tracking.js';
import { appInstanceArnOf, isPersonOf } from './person-arn.js';

export interface AskedTurn {
  /** The intent asked for, one this assistant advertises. */
  intent: string;
  /** What the asking assistant said it needs, rendered from its own template. Data, never instructions. */
  ask: string;
  /** The asking run's assistant, which the turn's ending is handed back to. */
  askerBotArn: string;
  /** Who reads the answer: nobody named is the conversation; a private run names its requester. */
  to: string[];
  /**
   * THE PERSON THE REQUEST IS FOR, where the asking step names one (`for`): resolved by the asking run's router from that run's
   * own recorded holders (an incident's lead), and the one person a proposal card the turn makes may be addressed to.
   */
  for?: string;
  /** This assistant's own run for the intent, which the turn's message and its measures carry. */
  run: { runKey: string; origin?: RunOrigin; trigger: RunTrigger };
  /** The asking step delivers the answer as a file (`deliver: 'file'`), whatever the intent declares. */
  deliver?: 'file';
  /**
   * A REVISION OF A TASK'S DOCUMENT: the approval task and the version revised. Its file lands as that
   * task's next version, and it hands no run on (the run waits on the approval).
   */
  revisionOf?: { taskId: string; fileKey: string; name: string };
}

/** The prompt template an asked turn takes, which the owning team may reword. */
export const ASKED_TURN_PROMPT = 'asked-intent-turn';
/** How long the owner's turn may take, the bound a run's agent step has by default. */
const ASKED_TURN_DEADLINE_MS = 30_000;

/** The ending a turn hands the asking run, read as a task step's: its answer posted, or not. */
export const askedTurnOutcome = (outcome: string): string => (outcome === 'posted' ? 'task:success:answered' : 'task:failure:unanswered');

/** The step's claim for the turn's output, apart from the asking step's own claim, which the run already took. */
export const askedTurnClaimStep = (step: string): string => `${step}#asked`;

/**
 * THE ONE-STEP WORKFLOW AN ASKED TURN RUNS: an agent turn on this assistant's own intent, reading the room as any turn on that
 * intent does. Undefined where the version declares no such single-turn intent, so the turn runs nothing.
 */
export function askedTurnWorkflow(
  pack: { intents?: ReadonlyArray<{ key: string; delivery?: string; tools?: readonly string[] }> } | undefined,
  req: { workflow: string; step: string; event: WorkflowEvent; asked: AskedTurn },
): EventWorkflow | undefined {
  const intent = pack?.intents?.find((i) => i.key === req.asked.intent);
  if (!intent || intent.delivery === 'TASK_MULTI_STEP') return undefined;
  return {
    on: req.event, initial: req.step,
    states: {
      [req.step]: {
        agent: {
          prompt: ASKED_TURN_PROMPT, tools: [...(intent.tools ?? [])], reads: 'messages', to: 'room', deadlineMs: ASKED_TURN_DEADLINE_MS,
          fallback: { send: { to: 'room', template: ASKED_TURN_PROMPT } },
        },
      },
    },
  } as unknown as EventWorkflow;
}

/**
 * THE ONE PERSON A TURN'S PROPOSAL CARD MAY BE ADDRESSED TO (SPEC-ASSISTANT-MEETINGS FR42): on a person's turn, its sender; on a
 * turn another assistant's run asked for, the person that run's request is for (`AskedTurn.for`) and never anyone else, a
 * sender included. Anything but one person of the conversation's own app instance is nobody, and no card is offered.
 */
export function proposalAddresseeOf(turn: { channelArn: string; senderArn?: string; asked?: Pick<AskedTurn, 'for'> }): string | undefined {
  const person = turn.asked ? turn.asked.for : turn.senderArn;
  return person && isPersonOf(person, appInstanceArnOf(turn.channelArn)) ? person : undefined;
}
