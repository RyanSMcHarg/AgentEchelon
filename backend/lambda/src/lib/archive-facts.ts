/**
 * A FACT THE PLATFORM RECORDS IN THE CONVERSATION ARCHIVE WHERE NO MESSAGE CARRIES IT (ADR-067 decision 6, WT61).
 *
 * A task an assistant's turn settles reaches the archive on that turn's message (`task_terminal`, `task_transition`). A
 * task a person settles on its card, or a deadline ends, posts no message, so the settlement had no record. The task
 * service puts one record per such settlement into the stream the archive already reads (`chime-messaging-*`), of the
 * platform's own event type: the Firehose copies it into the S3 archive with every message event, and the archival
 * consumer projects it into Aurora in the batch it writes messages in. One archive, one consumer, no counter (tenet D7).
 *
 * WHAT IT CARRIES IS REFERENCES: the conversation, the task, the AppInstanceUser id of whoever pressed the card, the
 * states, the cause and the edition hashes. Never message text, never a requirement's value. So it follows the archive's
 * erasure path with the person's id, as every archived event does.
 *
 * BEST-EFFORT AND LOUD. A record that cannot be put is logged and the settlement stands: the task's own row is the
 * authority on its state, and analytics missing one settlement is the cheaper failure than a card press that fails.
 */
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';

/** The event types the platform puts beside the Amazon Chime SDK's own. */
export const PLATFORM_FACT_EVENT_TYPES = ['AE_TASK_SETTLED', 'AE_RUN_ENDED'] as const;
export type PlatformFactEventType = typeof PLATFORM_FACT_EVENT_TYPES[number];

/** Why a task settled with no message of its own: a card, a deadline, an archive, a run's end, or a quiet step the platform ran. */
export type SettlementCause = 'card' | 'deadline' | 'archive' | 'run-ended' | 'platform-step';

export interface TaskSettledFact {
  /** Fixed when the fact is made, so a redelivered record lands on the row it already wrote: `<taskId>#<cause>#<toState or ending>#<at>`. */
  factId: string;
  channelArn: string;
  taskId: string;
  taskType?: string;
  fromState?: string;
  toState?: string;
  /** The terminal kind the task ended in, where it ended. */
  terminal?: string;
  /** The declared action a quiet step ran, and how it went (`platform-step`). */
  action?: { tool: string; outcome: 'success' | 'failure' };
  cause: SettlementCause;
  /** Whoever pressed the card, as an AppInstanceUser id. Absent for a deadline. */
  personId?: string;
  classification: string;
  originConfigId?: string;
  originMachineHash?: string;
  /** The run the task belongs to, by its key, where a workflow step opened it. */
  runKey?: string;
  workflow?: string;
  /** The process the run belongs to (SPEC-PROCESSES P8), where the run carries one. */
  processId?: string;
  at: string;
}

/**
 * A RUN'S END (ADR-067 decision 6, WT62): one record when a workflow's run reaches an end step, so a run is measured by
 * what it started on and how it ended, whatever its steps were. References only: the run key, the workflow, the
 * trigger, the ending, the version and the person who asked (an intent's run), never a message.
 */
export interface RunEndedFact {
  /** `<runKey>#end`: one per run, so a redelivered end lands on the row it already wrote. */
  factId: string;
  channelArn: string;
  runKey: string;
  workflow: string;
  /** The event, or `intent`. */
  trigger: string;
  disposition: 'success' | 'failure';
  classification: string;
  /** The steps the run took, by name and outcome, in order: no values. */
  steps?: Array<{ step: string; outcome: string }>;
  originConfigId?: string;
  /** The person who asked, as an AppInstanceUser id, on an intent's run. */
  personId?: string;
  /** The process the run belongs to, its edition, and the team that owned the run's assistant (SPEC-PROCESSES P8). */
  processId?: string;
  /** The process's name, which the process view groups by. */
  process?: string;
  processEdition?: string;
  ownerTeam?: string;
  at: string;
}

let client: KinesisClient | undefined;
const kinesis = () => (client ??= new KinesisClient({ region: process.env.AWS_REGION || 'us-east-1' }));

/** The stream the archive reads, named by the deployment (`FACT_STREAM_NAME`). Absent: no fact is put. */
export const factStreamName = (): string | undefined => process.env.FACT_STREAM_NAME || undefined;

/** The stream record for a fact: the shape the archive's records already have (`EventType`, `Payload`). */
export function factRecord(fact: TaskSettledFact): { EventType: PlatformFactEventType; Payload: TaskSettledFact } {
  return { EventType: 'AE_TASK_SETTLED', Payload: fact };
}

/** Put one run-end fact. Never throws. */
export async function putRunEndedFact(fact: RunEndedFact, deps: { send?: (cmd: PutRecordCommand) => Promise<unknown> } = {}): Promise<boolean> {
  return putRecord('AE_RUN_ENDED', fact, deps);
}

async function putRecord(type: PlatformFactEventType, fact: TaskSettledFact | RunEndedFact, deps: { send?: (cmd: PutRecordCommand) => Promise<unknown> }): Promise<boolean> {
  const stream = factStreamName();
  if (!stream) return false;
  try {
    const cmd = new PutRecordCommand({
      StreamName: stream,
      // By conversation, so one conversation's events and facts keep their order on one shard.
      PartitionKey: fact.channelArn,
      Data: Buffer.from(JSON.stringify({ EventType: type, Payload: fact }), 'utf8'),
    });
    await (deps.send ? deps.send(cmd) : kinesis().send(cmd));
    return true;
  } catch (err) {
    console.error('[archive-facts] a fact could not be put; what it records stands', { type, errName: (err as Error)?.name });
    return false;
  }
}

/** Put one settlement fact. Never throws. */
export async function putTaskSettledFact(fact: TaskSettledFact, deps: { send?: (cmd: PutRecordCommand) => Promise<unknown> } = {}): Promise<boolean> {
  return putRecord('AE_TASK_SETTLED', fact, deps);
}
