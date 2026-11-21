/**
 * THE TASK SERVICE: one place that decides who may see and change a task.
 *
 * Task access is the last conversation-scoped store whose rules live spread across its callers. This
 * function is where they move to, so they can be read, tested and audited in one place, and so IAM
 * has something it can actually guard.
 *
 * ── WHY NOT JUST TIGHTEN THE IAM ON THE TABLE ────────────────────────────────────────────────────
 *
 * Because the rules that matter are not expressible there at any granularity DynamoDB offers:
 * private to the requester and the owning assistant, visible to this conversation's CURRENT members,
 * a requester that is fixed while the owner changes hands at every `awaits` boundary.
 * `aws:ResourceTag` on DynamoDB is table-level and `dynamodb:LeadingKeys` reaches a partition key and
 * nothing else. Splitting the table per classification would buy a coarser boundary than this gives
 * for free, at the cost of a migration.
 *
 * ── HOW THE CALLER IS ATTESTED, WHICH IS THE WHOLE POINT ─────────────────────────────────────────
 *
 * A service that trusts a `channelArn` from its payload is the same application-code enforcement
 * with a hop added. And a direct Lambda invoke attests NOTHING about its caller: `clientContext` is
 * set by the caller, and `requestContext.identity` is an API Gateway construct a direct invoke never
 * populates. So the classification is not read from the request at all.
 *
 * IT IS THE FUNCTION'S OWN. One service function per classification, and each classification's
 * processor and handler role holds `lambda:InvokeFunction` on its own service and no other. A
 * classification cannot ask the wrong service, because the invoke is DENIED AT IAM rather than
 * refused in here - which makes the boundary expressible in IAM, assertable in `cdk-synth`, and
 * impossible for a caller to influence. `SERVICE_CLASSIFICATION` below is that fact.
 *
 * The user and operator entry points arrive through API Gateway instead, where the authorizer is
 * what verifies the identity. They are not inside a turn, so they can afford the hop that buys it.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────────────
 *
 * It does not re-implement the task store. `task-tracking.ts` stays the one writer; this decides
 * whether a call is allowed and then makes it. A second implementation of task semantics beside the
 * first is the divergence this codebase already removed once.
 *
 * See DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.
 */

import { hydrateIntentPackFromSsm } from './lib/intent-pack.js';
import {
  getTask,
  getOpenTasksForConversation,
  getActiveTasksForUser,
  createTask,
  updateTaskStatus,
  advanceTaskStateTo,
  claimStateAction,
  principalIdFromArn,
  // The router's reads, fronted here so the tables keep one holder. See the ops near the dispatch.
  getAssigneeChannelTasks,
  getConversationTasksForAssistant,
  findAnswerableTaskByRef,
  findAnswerableTaskById,
  getTasksOwnedBy,
  reassignTaskOwner,
  getActiveTask,
  selectStoppableTasks,
  cancelStoppedTasks,
  endDuelTasks,
  applyUserResponseToTask,
  recordNoTransitionTurn,
  markTaskPrivate,
  recordTaskDelivery,
  eventRunTable,
  type Task,
  type ActionClaim,
  type ConversationTask,
  type UserTask,
  type TaskStatus,
  type AdvanceResult,
  type LexEventForTask,
  type TaskCreateOptions,
  ACTIVE_TASK_STATUSES,
  attachRequestRun,
  takeReopenedTask,
  openTasksOpenedFrom as storeOpenTasksOpenedFrom,
  openWorkflowTasksIn,
  releaseAskedBy,
} from './lib/task-tracking.js';
import { isPrivateVisibility } from './lib/task-visibility.js';
import type { DeliveryOption } from './lib/delivery-options.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { ChimeSDKMessagingClient, ListTagsForResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { readChannelTags } from './lib/channel-classification.js';
import { memoizedTagReader } from './lib/conversation-primary.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { taskStateMachines as packTaskStateMachines } from './lib/intent-pack.js';
import { machineHashOf, machinesOfTask } from './lib/version-machines.js';
import { putRunEndedFact, putTaskSettledFact, type RunEndedFact, type TaskSettledFact } from './lib/archive-facts.js';
import { PROCESS_ID } from './lib/event-workflow.js';
import { formAnswersOf, pressTarget } from './lib/task-step.js';
import { alongsideEndWaitId } from './lib/held-run.js';
import { APPROVED_DOCUMENT_VALUE, MAX_REVISION_INSTRUCTIONS, MAX_TASK_DOCUMENTS, documentsOf, draftingOf, isAssistantDocumentKey, isOwnMarkdownUpload, latestDocument, revisionPending, type TaskDocument, type TaskRevisionRequest } from './lib/task-documents.js';
import { appendTaskDocument, clearTaskRevision, setTaskRevision, setTaskRunValue } from './lib/task-tracking.js';
import { PLATFORM_TASK_MACHINE_KEYS, isPlatformMachineKey, requesterMovesOf, validateTaskStateMachine, type TaskStateMachine } from './lib/task-state-machines.js';
import { personIdFromArn } from './lib/person-arn.js';
import { versionDeclaredMachines } from './lib/version-machines.js';
import { liveAssistantsForClassification } from './lib/default-agents.js';
import { nameTaskThroughRouter } from './lib/say-through-router.js';
import {
  TASK_ARCHIVE_ENDING, TASK_DEADLINE_ENDING, TASK_RUN_ENDED_ENDING, assigneeAdvanceRefusal, orderForPickup, pickupReadiness, requestAwaitingRun, settlementOutcome,
  type AssigneeAdvanceRefusal,
} from './lib/workflow-task.js';
import { DeliveryOption as TaskDelivery } from './lib/delivery-options.js';
import type { TaskAssignee, WorkflowRunRef } from './lib/task-tracking.js';
import { claimEventRun as storeClaimEventRun, claimEventStep as storeClaimEventStep, holdRunWait as storeHoldRunWait, readRunWait as storeReadRunWait, readEventSteps as storeReadEventSteps, recordEventGreeting as storeRecordEventGreeting, wasGreetedByEventRun as storeWasGreeted, type EventRunClaim } from './lib/event-run-store.js';

/**
 * An event run's records live in the task table, which `task-tracking.ts` alone names: the run's claims are written
 * through the client and the name it hands over, so no second module reads the table's name.
 */
const eventRunDeps = eventRunTable;

/** A person a run greeted by name, recorded in a conversation this service's classification serves only. */
async function recordEventGreetingOp(input: { channelArn: string; personArn: string }): Promise<EventRunClaim> {
  if (!input?.channelArn || !input?.personArn?.includes('/user/') || await refusesChannel(input.channelArn)) return { claimed: false, reason: 'failed' };
  return storeRecordEventGreeting(input, eventRunDeps());
}

/** Whether a run greeted this person by name in this conversation. */
async function wasGreetedByEventRunOp(input: { channelArn: string; personArn: string }): Promise<boolean> {
  if (!input?.channelArn || !input?.personArn || await refusesChannel(input.channelArn)) return false;
  return storeWasGreeted(input, eventRunTable());
}

/** A run's wait and the continuation it holds (WT20), in a conversation this service's classification serves only. */
async function holdRunWaitOp(input: { waitId: string; channelArn: string; continuation: Record<string, unknown> }): Promise<EventRunClaim> {
  if (!input?.waitId || !input?.channelArn || !input?.continuation || typeof input.continuation !== 'object' || await refusesChannel(input.channelArn)) {
    return { claimed: false, reason: 'failed' };
  }
  return storeHoldRunWait(input, eventRunDeps());
}

/** The continuation a run's wait holds, read when its schedule fires. */
async function readRunWaitOp(input: { waitId: string; channelArn: string }): Promise<Record<string, unknown> | null> {
  if (!input?.waitId || !input?.channelArn || await refusesChannel(input.channelArn)) return null;
  return storeReadRunWait(input, eventRunTable());
}

/** Which of a run's step claims are held, with their outcomes, in a conversation this service's classification serves only. */
async function readEventStepsOp(input: { runKey: string; channelArn: string; steps: string[] }): Promise<Record<string, string> | null> {
  if (!input?.runKey || !input?.channelArn || !Array.isArray(input.steps) || input.steps.some((s) => typeof s !== 'string') || await refusesChannel(input.channelArn)) return null;
  return storeReadEventSteps(input, eventRunTable());
}

/**
 * WHETHER THE RUN A TASK WENT ON ALONGSIDE HAS REACHED ITS END, from the run's own records: its end held on this task (the
 * record names the run's continuation), or its end already claimed. A read that fails answers that it has not, so a press
 * is confirmed rather than taken unasked.
 */
async function runReachedItsEnd(task: Task): Promise<boolean> {
  const run = task.workflowRun;
  if (!run?.holdsEnd) return true;
  const [held, claims] = await Promise.all([
    storeReadRunWait({ waitId: alongsideEndWaitId(task.taskId), channelArn: task.channelArn }, eventRunTable()).catch(() => null),
    storeReadEventSteps({ runKey: run.runKey, channelArn: task.channelArn, steps: ['end'] }, eventRunTable()).catch(() => null),
  ]);
  return (typeof held?.runKey === 'string' && typeof held?.step === 'string') || claims?.end !== undefined;
}

/** An event run's claim, in a conversation this service's classification serves only. */
async function claimEventRunOp(input: { runKey: string; channelArn: string; workflow: string }): Promise<EventRunClaim> {
  if (!input?.runKey || !input?.channelArn || !input?.workflow || await refusesChannel(input.channelArn)) return { claimed: false, reason: 'failed' };
  return storeClaimEventRun(input, eventRunDeps());
}

/** One step's claim and outcome, in a conversation this service's classification serves only. */
async function claimEventStepOp(input: { runKey: string; channelArn: string; step: string; outcome: string }): Promise<EventRunClaim> {
  if (!input?.runKey || !input?.channelArn || !input?.step || !input?.outcome || await refusesChannel(input.channelArn)) {
    return { claimed: false, reason: 'failed' };
  }
  return storeClaimEventStep(input, eventRunDeps());
}

const chimeClient = chimeMessagingClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * WHICH CLASSIFICATION THIS INSTANCE SERVES, from its own environment.
 *
 * Never from the request. The caller proved its classification by being permitted to invoke this
 * function at all; asking it to also state one would reintroduce exactly the declared value the
 * invoke grant exists to replace.
 */
const SERVICE_CLASSIFICATION = process.env.SERVICE_CLASSIFICATION || '';

/**
 * What a classification may serve: the set it grants (`grantsFor`), and nothing outside it.
 *
 * FROM THE REGISTRY, not a literal. This was a hardcoded `{ basic, standard, premium }` - exactly the
 * `CLASSIFICATION_RANK` the registry exists to replace, missed when the rest moved. A deployment that
 * configures a fourth classification would have had every conversation of it refused by this service,
 * because an unranked tag reads as unknown. Fail-closed, so it degrades safely rather than leaking,
 * but a whole profile would have had no task access and nothing here would have said why.
 */
// `rankOf` IS GONE. It existed for `theirs > mine`, a person-ladder rule left on
// an assistant component after ADR-042 moved assistants to exactly-own. What this service may serve
// is `channelsActableBy(SERVICE_CLASSIFICATION)`, which for an assistant is its own classification
// and nothing else - the same set its IAM grant is generated from.

export type TaskServiceOp =
  /** Everything a turn needs to know about tasks, in ONE call. See `tasksForTurn`. */
  | 'tasksForTurn'
  | 'getTask'
  | 'createTask'
  | 'updateTaskStatus'
  | 'advanceTaskState'
  /** An operator reading a conversation's live tasks. See `adminListTasks`. */
  | 'adminListTasks'
  /** Everything ONE PERSON OWNS, across conversations. See `adminListTasksOwnedBy`. */
  | 'adminListTasksOwnedBy'
  /** Hand a task to a different owner. See `reassignOwner`. */
  | 'reassignTaskOwner'
  /** An operator reading everything ONE PRINCIPAL IS ASSIGNED, across conversations. */
  | 'adminListAssigneeTasks'
  /** An operator cancelling one. See `adminCancelTask`. */
  | 'adminCancelTask'
  /** The router's reads, fronted so the tables keep one holder. See the ops near the dispatch. */
  | 'ownerChannelTasks'
  /** The open work in one conversation belonging to one person and one assistant. See `referentCandidates`. */
  | 'referentCandidates'
  /** The open item a `#<n>` names, if its sender may answer it (ADR-035). Asked by the channel flow. */
  | 'answerableTaskByRef'
  /** The open item an id names, if its sender may answer it. Asked by the channel flow. */
  | 'answerableTaskById'
  | 'activeTaskByType'
  | 'stoppableTasks'
  | 'applyUserResponse'
  | 'noTransitionTurn'
  /** Claim one entry's declared step action before it runs (FR29). See `claimAction`. */
  | 'claimStateAction'
  /** An event workflow's run and each of its steps, claimed once (ADR-061 decision 5). See `event-run-store.ts`. */
  | 'claimEventRun'
  | 'claimEventStep'
  | 'recordEventGreeting'
  | 'wasGreetedByEventRun'
  | 'markTaskPrivate'
  | 'recordTaskDelivery'
  /** Discard the work a stop named, once the person has answered. See `cancelStoppedTasks`. */
  | 'cancelStoppedTasks'
  /** Close the work an ended duel's sides opened. See `endDuelTasks`. */
  | 'endDuelTasks'
  /** A workflow's task step opens its task (ADR-063 decision 1). See `openWorkflowTask`. */
  | 'openWorkflowTask'
  /** A person takes a choice on their task's card (ADR-063 decision 2). See `advanceAsAssignee`. */
  | 'advanceAsAssignee'
  /** The versions of the document a task approves. See `taskDocuments`. */
  | 'taskDocuments'
  /** Its approver attaches an edited version. See `addTaskDocument`. */
  | 'addTaskDocument'
  /** Its approver asks the drafting assistant to revise it. See `requestRevision`. */
  | 'requestRevision'
  /** The drafting assistant's revision lands as the task's next version (stage 2). See `addRevisedDocument`. */
  | 'addRevisedDocument'
  /** A revision that will not land is cleared, so another may be asked. See `abandonRevision`. */
  | 'abandonRevision'
  /** A task step's deadline ends its task (ADR-063 decision 4). See `cancelForDeadline`. */
  | 'cancelForDeadline'
  /** Archiving a conversation settles its open workflow tasks (ADR-017). See `settleArchivedTasks`. */
  | 'settleArchivedTasks'
  /** A run a settlement ended mid-way cancels its open work. See `endRunTasks`. */
  | 'endRunTasks'
  /** Which of a run's step claims are held. See `readEventStepsOp`. */
  | 'readEventSteps'
  /** The open tasks of one machine in every conversation a conversation's workflow opened (WT122). See `openTasksOpenedFrom`. */
  | 'openTasksOpenedFrom'
  | 'recordRunEnded'
  | 'adminCancelRun'
  | 'holdRunWait'
  /** The task a requester may move while another person holds it (WT114). See `requesterMovableTask`. */
  | 'requesterMovableTask'
  /** A request whose task no router turn opened takes its intent's run (WT115, WT106). See `attachRequestRunOp`. */
  | 'attachRequestRun'
  /** A reopen run's step takes the reopened task (`takes: 'reopened'`). See `takeReopenedTaskOp`. */
  | 'takeReopenedTask'
  | 'readRunWait'
  /** An assistant's ready work in one conversation, in the order it takes it up (ADR-063 decision 5). See `readyTasks`. */
  | 'readyTasks'
  /** Take up one entry of a task's state, once (ADR-063 decision 5). See `claimPickup`. */
  | 'claimPickup';

export interface TaskServiceRequest {
  op: TaskServiceOp;
  input: Record<string, unknown>;
}

/**
 * What a turn is told about tasks.
 *
 * COMPOSITE ON PURPOSE, and this is a latency decision rather than a tidiness one. Three separate
 * reads run today before the model call. Behind a service they would be three invokes, ~60 to 180ms
 * warm against a 1s time-to-first-feedback budget, which is not affordable. Asked as one question it
 * is one invoke and close to a wash.
 *
 * The rule that follows: a future read that a turn needs goes INTO this shape, not beside it.
 */
export interface TasksForTurn {
  /** The task this turn is continuing, when it names one. */
  current: Task | null;
  /** Open work in this conversation, already filtered to what the viewer may see. */
  here: ConversationTask[];
  /** The speaker's own open work elsewhere. Empty when no speaker resolved. */
  elsewhere: UserTask[];
}

/**
 * The conversation's classification tag, or empty when there is not one this deployment declares.
 *
 * ── WHY THE RAW TAG AND NOT THE SHARED RESOLVER ──────────────────────────────────────────────────
 *
 * The shared resolver USED TO SUBSTITUTE the narrowest classification for a missing or unreadable
 * tag. It was deleted in ADR-045 decision 2 for the reason this comment already gave, so the
 * paragraph below is now the general rule rather than this file's exception.
 * `analytics-aurora/channel-classification.ts` already writes down why the safe fallback differs by
 * direction: stamping content falls back to the MOST restrictive so a row is withheld rather than
 * leaked, while choosing a reader role falls back to the LEAST so a reader is not handed the whole
 * ladder. Both substitute, because both must still produce a value.
 *
 * THIS IS A THIRD DIRECTION AND IT MUST NOT SUBSTITUTE AT ALL. The question here is whether a reader
 * may serve a conversation, and substituting the lowest turns every untagged conversation into one
 * that EVERY instance may serve. That converts "unknown" into "permitted", which is the one
 * conversion an authorization decision cannot make.
 *
 * So an absent or unrecognized tag is a refusal by every instance. The cost is that an untagged
 * conversation gets no task context from anyone, which is a degradation and is loud; the alternative
 * is a tagging gap silently granting access, which Layer 1 already refuses to allow for channels.
 *
 * ── CACHED PER CONTAINER, BECAUSE THE TAG IS IMMUTABLE ───────────────────────────────────────────
 *
 * This read sits inside a person's wait, and the router has already made the same call earlier in the
 * same turn. The tag cannot change for a conversation, so a container that has seen one does not ask
 * again; only the first turn per conversation per container pays. It is read through the container's one
 * tag memo (`memoizedTagReader`), which keeps only a recognized classification: a negative result is NOT
 * kept, because an untagged conversation may be tagged moments later and caching the refusal would
 * outlive the fix.
 */
const tagReader = memoizedTagReader(chimeClient);

/**
 * The conversation's classification, or the fact that it could not be read.
 *
 * SEPARATED, because they are not the same claim. An absent tag is a statement about the
 * conversation; a failed API call is a statement about Chime. Both collapsed to the empty string,
 * so a throttle was indistinguishable from an untagged channel and was treated as one.
 */
type ChannelTag = { tag: string } | { unreadable: true };

async function classificationOf(channelArn: string): Promise<ChannelTag> {
  try {
    const tag = (await readChannelTags(tagReader, channelArn)).classification || '';
    return { tag };
  } catch (err) {
    // AN OUTAGE, SAID AS ONE. What the caller does with it is decided in `refusesChannel`, which is
    // where the standing of this check is decided rather than here.
    console.error('[task-service] the classification tag could not be READ', {
      channelArn, err: (err as Error)?.message,
    });
    return { unreadable: true };
  }
}

/**
 * A conversation this service instance may not serve.
 *
 * One outside the set its classification grants. A premium service answering a basic conversation narrows context and
 * cannot leak; the reverse is the leak this exists to prevent.
 */
/**
 * WHICH LEG IS ASKING, named in the security log so an operator can tell the two apart (ADR-045).
 *
 * `here`      the conversation the caller named and IAM already authorized them for. This check is
 *             the second enforcement layer on that call.
 * `elsewhere` a row belonging to some OTHER conversation, reached by scanning. This per-row check is
 *             the gate for that conversation.
 *
 * Both legs answer an unreadable tag the same way: refused.
 */
type AdmissionLeg = 'here' | 'elsewhere';

async function refusesChannel(channelArn: string, leg: AdmissionLeg = 'here'): Promise<boolean> {
  if (!SERVICE_CLASSIFICATION) {
    console.error('[task-service] SERVICE_CLASSIFICATION unset; refusing every conversation');
    return true;
  }
  const found = await classificationOf(channelArn);

  // WHAT THIS CHECK IS, STATED WITHOUT OVERCLAIMING.
  //
  // Access to CHANNELS is IAM: `classificationChannelScopedAllow` is applied to the
  // per-classification Cognito user roles AND the assistant roles, tag-gated and fail-closed. The
  // TASKS TABLE is not - the grant carries no condition and DynamoDB has no per-item tag condition
  // to carry, which is what the header of this file says. So for a MISROUTED call, one where the
  // wrong classification's service was handed this conversation, this check is the only guard, and
  // it stays.
  //
  // It is not, however, the thing that decides who may be in this conversation or send into it.
  // Both of those are settled before anything reaches here, which is why a refusal below means an
  // upstream fault rather than routine policy, and is logged as one.
  //
  // AN UNREADABLE TAG REFUSES, ON EVERY LEG. This check is one of the two enforcement layers on a
  // task operation, and it holds only when it can establish the conversation's classification. A
  // conversation whose classification cannot be read is not served; the refusal is logged as a
  // security event naming the leg, and the caller sees an ordinary refusal it can retry. The tag is
  // cached per container once read, so only the first read for a conversation depends on Chime.
  if ('unreadable' in found) {
    console.error('[task-service][SecurityEvent] the classification tag could not be read; refusing', {
      channelArn, leg, serving: SERVICE_CLASSIFICATION,
    });
    return true;
  }

  const tag = found.tag;
  if (!profiles.isKnownClassification(tag) || !profiles.isKnownClassification(SERVICE_CLASSIFICATION)) {
    console.warn('[task-service][SecurityEvent] no usable classification on the conversation; refusing', {
      channelArn, tag, serving: SERVICE_CLASSIFICATION,
    });
    return true;
  }
  // THE DECLARED SET, NOT A RANK COMPARISON - AND NOT A NARROWING EITHER.
  //
  // This was `theirs > mine`, which needs an ordering that no longer exists: `finance` is neither
  // greater nor less than `legal`. What replaces it is this service's own `grants`, so on a ladder
  // deployment the behavior is exactly what it was - a standard service still serves a basic
  // conversation, which the test beside this file calls the direction the model already permits.
  //
  // DELIBERATELY NOT `channelsActableBy`, which would narrow this to exactly-own. That narrowing is
  // ADR-045 decision 3, the owner has HELD it pending its enforcement-migration note, and removing
  // the ladder is not a licence to ship it early. Changing the shape of the question and changing its
  // answer are two changes, and only the first is this row's.
  const refused = !profiles.grantsFor(SERVICE_CLASSIFICATION).includes(tag);
  // LOUDER THAN THE MISSING-TAG CASE, not quieter. A missing tag is a configuration gap; THIS is a
  // turn reaching for a conversation of a classification it does not grant, which is the event the boundary
  // exists for and the one an operator would want to see. It was silent when first deployed, so a
  // real refusal and an ordinary empty answer looked identical in the logs, and the only way to tell
  // them apart was to already know the conversation had tasks.
  if (refused) {
    // ERROR, because this should be unreachable. IAM authorized the caller for this channel and
    // this service is not the one that channel belongs to, so the two disagree - a routing bug or a
    // tagging gap. The refusal is correct AND something upstream is wrong; a warning reads as
    // routine policy and this is not routine.
    console.error('[task-service][SecurityEvent] a conversation above this classification reached this '
      + 'service and was refused; IAM should have prevented the call', {
      channelArn, conversation: tag, serving: SERVICE_CLASSIFICATION,
    });
  }
  return refused;
}

/**
 * Read everything a turn needs about tasks.
 *
 * THE VIEWER IS PASSED THROUGH, not inferred. `getOpenTasksForConversation` returns a private task
 * only to its requester or its owning assistant, and it fails toward silence when nobody says who is
 * asking, so passing the speaker widens disclosure to exactly them and to nobody else.
 */
export async function tasksForTurn(input: {
  channelArn: string;
  taskId?: string;
  senderArn?: string;
}): Promise<TasksForTurn> {
  const { channelArn, taskId, senderArn } = input;
  const empty: TasksForTurn = { current: null, here: [], elsewhere: [] };
  if (!channelArn || await refusesChannel(channelArn)) return empty;

  const viewerId = senderArn ? principalIdFromArn(senderArn) : '';

  // CONCURRENT, because they are independent questions and this sits inside a person's wait. Three
  // sequential awaits is what the composite exists to remove; running them in series here would keep
  // the cost and only move it.
  const [current, here, elsewhere] = await Promise.all([
    taskId ? getTask(taskId, channelArn).catch(() => null) : Promise.resolve(null),
    getOpenTasksForConversation(channelArn, { ...(viewerId ? { viewerId } : {}) }).catch(() => []),
    // ── EVERY ROW IS GATED, BECAUSE "ELSEWHERE" MEANS ANOTHER CONVERSATION ──────────────────
    //
    // `refusesChannel` above gates THIS conversation. These rows are by definition from others,
    // each with its own classification, and the tasks table carries no per-item condition for IAM
    // to apply - the header of this file says so. So a row from a premium conversation reached a
    // basic service unchecked, and `buildCrossChannelTasksHint` put its count and type into that
    // assistant's system prompt.
    //
    // `adminListAssigneeTasks` already does exactly this, per row, on the same call. This is that
    // gate, not a new one: the sibling read was right and the turn read was missing it.
    //
    // Concurrent, and cheap: the classification tag is cached per container once read, so a viewer
    // with work in three conversations pays at most three reads on a cold container and none after.
    viewerId
      ? getActiveTasksForUser(viewerId)
        .then(async (rows) => {
          const serveable = await Promise.all(
            rows.map(async (r) => ((await refusesChannel(r.channelArn, 'elsewhere')) ? null : r)),
          );
          return serveable.filter((r): r is (typeof rows)[number] => r !== null);
        })
        .catch(() => [])
      : Promise.resolve([]),
  ]);

  return { current, here, elsewhere };
}

/**
 * One task, when the caller already holds its id.
 *
 * THE CHANNEL IS CHECKED EVEN THOUGH THE ID IS ENOUGH TO FETCH. A task id names a row; it does not
 * say the caller is entitled to it. Refusing on the conversation's classification is what makes an
 * id from somewhere else useless rather than sufficient.
 */
export async function readTask(input: {
  taskId: string;
  channelArn: string;
  consistent?: boolean;
}): Promise<Task | null> {
  const { taskId, channelArn, consistent } = input;
  if (!taskId || !channelArn) return null;
  if (await refusesChannel(channelArn)) return null;
  return getTask(taskId, channelArn, consistent ? { consistent: true } : {}).catch(() => null);
}

/**
 * Open a task in a conversation this instance may serve.
 *
 * THE SAME REFUSAL AS EVERY READ, and for a sharper reason: a write that lands in a conversation this
 * instance may not serve puts a row somewhere it does not belong, where a refused read merely returns
 * nothing. The channel comes from the request attributes `createTask` already reads, so it is checked
 * from the same place the row will be keyed on rather than from a second field that could disagree.
 */
export async function openTask(input: {
  event: LexEventForTask;
  deliveryOption: DeliveryOption;
  taskType?: string;
  correlationId?: string;
  opts?: TaskCreateOptions;
}): Promise<Task | null> {
  const { event, deliveryOption, taskType, correlationId, opts } = input;
  const channelArn =
    event?.requestAttributes?.['x-amz-lex:channel-arn']
    || event?.requestAttributes?.['CHIME.channel.arn']
    || '';
  if (!channelArn || await refusesChannel(channelArn)) {
    console.warn('[task-service] refusing to open a task in this conversation', { channelArn });
    return null;
  }
  // A MACHINE A CALLER SENDS IS A VERSION'S OWN (ADR-066 decision 2): a platform key is resolved only from the platform
  // set, so one sent here is dropped and the task opens on the platform's machine.
  const sent = opts?.machines ? versionDeclaredMachines({ machines: opts.machines }) : undefined;
  const withMachines = opts?.machines
    ? { ...opts, machines: sent ? { ...packTaskStateMachines(), ...sent } : undefined }
    : opts;
  // THE MACHINE A TASK CARRIES IS HELD TO THE SAME RULE (ADR-067 stage 2): never under a platform key, and only one that
  // validates; anything else is dropped and the task opens on the machine its type resolves to.
  const origin = withMachines?.originMachine;
  const originOk = !!origin && !!taskType && !isPlatformMachineKey(taskType) && (() => {
    try { validateTaskStateMachine(taskType, origin); return true; } catch { return false; }
  })();
  const safeOpts = withMachines && origin && !originOk ? (({ originMachine: _dropped, ...rest }) => rest)(withMachines) : withMachines;
  const task = await createTask(event, deliveryOption, taskType, correlationId, safeOpts);
  // A REQUEST OPENED MID-TASK (WT106) is named to the router, which starts its intent's workflow on it, once.
  if (task && requestAwaitingRun(task)) {
    await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'request', channelArn, taskId: task.taskId }).catch(() => undefined);
  }
  return task;
}

/**
 * Record a status, for a caller that reads nothing back.
 *
 * `updateTaskStatus` returns void and no call site uses its result, which is what lets the seam
 * dispatch this one fire-and-forget and keep it off a person's wait entirely. The refusal still
 * happens here, on the service side, so an asynchronous call is not an unchecked one.
 */
export async function setTaskStatus(input: {
  taskId: string;
  channelArn: string;
  status: TaskStatus;
  result?: string;
  error?: string;
}): Promise<void> {
  const { taskId, channelArn, status, result, error } = input;
  if (!taskId || !channelArn) return;
  // A DROPPED WRITE IS SAID OUT LOUD (invariant E). This call is dispatched fire-and-forget, so
  // nothing is waiting on it and nothing retries it, and the record simply keeps whatever status it
  // had: a task left `in_progress` sits in the person's /tasks/mine for its full 24h TTL, looking
  // like work that is still running.
  //
  // A refusal now means a genuine cross-classification call, since an unreadable tag proceeds
  // rather than refusing - so this line and the SecurityEvent beside it describe the same upstream
  // fault from two directions, and neither of them is an outage any more.
  if (await refusesChannel(channelArn)) {
    console.error('[task-service] a task status write was refused and is not retried anywhere', {
      taskId, channelArn, status,
    });
    return;
  }
  await updateTaskStatus(taskId, channelArn, status, result, error);
}

/**
 * Move a task to a new state.
 *
 * THE TASK IS RE-READ HERE RATHER THAN TAKEN FROM THE CALLER. A caller-supplied task row would be a
 * snapshot, and the optimistic guard inside `advanceTaskStateTo` compares against the row it was
 * given: handing it a stale copy across a network hop would widen the very race the guard exists to
 * lose loudly. Reading it on this side keeps the guard comparing against something fresh.
 *
 * THE MACHINES DO travel, because they are the caller's PROFILE's and this service cannot resolve
 * them without re-implementing profile resolution. They are configuration rather than state, so a
 * copy of them cannot be stale in the way a task row can.
 */
export async function advanceTask(input: {
  taskId: string;
  channelArn: string;
  toState: string;
  by?: 'tool' | 'system';
  reason?: string;
  messageId?: string;
  details?: Record<string, unknown>;
  machines?: Parameters<typeof advanceTaskStateTo>[0]['machines'];
  assistantId?: string;
  action?: Parameters<typeof advanceTaskStateTo>[0]['action'];
  conditionValues?: Parameters<typeof advanceTaskStateTo>[0]['conditionValues'];
  /** The caller goes on with the run itself, in the turn it is in, so nothing else may. */
  continuedByCaller?: boolean;
  /** A reopen pressed by a decider, whom `advanceAsAssignee` checked. */
  reopenByDecider?: boolean;
  /** A quiet step's move (`isQuietStep`): no turn's message carries it, so its settlement is closed and recorded here. */
  quiet?: true;
}): Promise<AdvanceResult> {
  const { taskId, channelArn, continuedByCaller, quiet, ...rest } = input;
  if (!taskId || !channelArn) return { ok: false, error: 'no_active_task' };
  if (await refusesChannel(channelArn)) return { ok: false, error: 'no_active_task' };

  const task = await getTask(taskId, channelArn).catch(() => null);
  if (!task) return { ok: false, error: 'no_active_task' };
  const result = await advanceTaskStateTo({ task, ...rest });
  if (result.ok) {
    // A QUIET STEP'S SETTLEMENT (section 8.1 of DESIGN-CONVERSATION-DASHBOARDS): no turn closes the task or archives the move,
    // so this does, before the settlement is named. The fact carries the action the step ran and how it went.
    if (quiet && result.terminal) {
      await updateTaskStatus(task.taskId, channelArn, result.terminal === 'success' ? 'completed' : 'failed').catch(() => undefined);
      await putTaskSettledFact(settledFact(task, 'platform-step', {
        fromState: result.from, toState: result.to, terminal: result.terminal, ...(rest.action ? { action: rest.action } : {}),
      }));
    }
    if (!continuedByCaller) await nameWhatChanged(task.taskId, channelArn, rest.machines);
    // A FINISHED TASK TAKEN BACK (WT104): from an ending into a state with a way on, which is a reopen, named once per move.
    const machine = machinesOfTask(task, { ...packTaskStateMachines(), ...(rest.machines ?? {}) })[task.taskType ?? ''];
    const wasEnding = !!task.taskState && machine?.states[task.taskState]?.transitions.length === 0;
    const nowOpen = (machine?.states[input.toState]?.transitions.length ?? 0) > 0;
    if (wasEnding && nowOpen) {
      await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'reopened', channelArn, taskId: task.taskId }).catch(() => undefined);
    }
  }
  return result;
}

// ── A WORKFLOW'S TASKS (ADR-063) ───────────────────────────────────────────────────────────────────────────

/**
 * WHAT THIS SERVICE NAMES TO ITS OWN ROUTER, AND ONLY TO IT (decision E1): a task a run waits on that settled, so the run
 * continues; and a task that is now an assistant's to take up, so an idle assistant takes it up. Ids only. Read back from
 * the row after the write that changed it, so whatever path moved the task, the naming says what the row now holds. Never
 * throws, and never holds up the write it follows: a naming that is lost is the case decision 6 states.
 */
async function nameWhatChanged(taskId: string, channelArn: string, machines?: Record<string, TaskStateMachine>): Promise<void> {
  try {
    const task = await getTask(taskId, channelArn);
    if (!task) return;
    const all = machinesOfTask(task, { ...packTaskStateMachines(), ...(machines ?? {}) });
    // A STATE THAT SAYS A NOTICE ON ENTRY (WT23) is named to the router, which says it once per entry.
    if (task.taskType && task.taskState && all[task.taskType]?.states[task.taskState]?.notice) {
      await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'notice', channelArn, taskId }).catch(() => undefined);
    }
    if (task.workflowRun && settlementOutcome(task, all)) {
      await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'settled', channelArn, taskId });
      return;
    }
    // AN ACCEPTED QUEUED REQUEST (WT115): the person accepted it, so the router starts its intent's workflow, once.
    if (task.taskType === 'queued_request' && task.taskState === 'accepted' && requestAwaitingRun(task)) {
      await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'request', channelArn, taskId });
      return;
    }
    // A RUN THAT GOES ON ONCE ITS TASK OPENS (WT18) is named when the task is in any state but the one it opened in. The
    // router's continuation claim takes it once, so a task that returns there and leaves again continues nothing twice.
    const initial = task.taskType ? all[task.taskType]?.initial : undefined;
    if ((task.workflowRun?.continueOn === 'entered' || task.askedBy?.continueOn === 'entered') && initial && task.taskState && task.taskState !== initial) {
      await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'entered', channelArn, taskId });
    }
    if (task.assigneeType === 'assistant' && task.assigneeId && pickupReadiness(task, all, task.assigneeId).ready) {
      await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'ready', channelArn, taskId });
    }
  } catch (err) {
    console.warn('[task-service][workflow-task] could not name a changed task to the router', { taskId, err: (err as Error)?.message });
  }
}

/** Whether a principal id is a live assistant of this service's own classification (tenet D3, the second layer). */
async function isOwnAssistant(id: string): Promise<boolean> {
  if (!id) return false;
  const live = await liveAssistantsForClassification(SERVICE_CLASSIFICATION);
  return live.some((a) => principalIdFromArn(a.botArn) === id);
}

/** The largest opening details a task may carry, as JSON. */
export const MAX_OPENING_DETAILS_CHARS = 24_000;

/** Opening details as written: undefined where none were given, null where they are not top-level text within the bound. */
export function openingDetails(given: unknown): Record<string, string> | undefined | null {
  if (given === undefined) return undefined;
  if (!given || typeof given !== 'object' || Array.isArray(given)) return null;
  const entries = Object.entries(given as Record<string, unknown>);
  if (!entries.every(([k, v]) => /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(k) && typeof v === 'string')) return null;
  const out = Object.fromEntries(entries) as Record<string, string>;
  return JSON.stringify(out).length <= MAX_OPENING_DETAILS_CHARS ? out : null;
}

/**
 * OPEN A WORKFLOW STEP'S TASK (ADR-063 decision 1). The router resolved the references; this service decides whether the
 * write may happen and makes it. Refused, and nothing written, when the conversation is not this classification's, when
 * the machine is one of the turn queue's own, or when an assistant it names (the worker, the task's assistant) is not a
 * live assistant of this classification. Opened once: a task of that id already here is returned as it is.
 */
export async function openWorkflowTask(input: {
  channelArn: string;
  taskId: string;
  machine: string;
  /** The version's own machine of that name, when it carries one; else the pack's. */
  machineDef?: TaskStateMachine;
  /** The version the run's step opened the task from (`Task.originConfigId`). */
  originConfigId?: string;
  /** A `due` deadline (WT21): when the task is due, shown on it, which ends nothing. */
  dueBy?: string;
  /** How long the row is kept where no timeout bounds it (a due or remind deadline), in seconds. */
  keepForSeconds?: number;
  requesterArn?: string;
  worker: TaskAssignee;
  assistantId: string;
  visibility?: 'conversation' | 'private';
  priority?: 'high' | 'normal' | 'low';
  workflowRun: WorkflowRunRef;
  /** The run that asked for this work (WT118): continued on its ending, handed nothing it recorded. */
  askedBy?: WorkflowRunRef;
  /** What the asking assistant said it needs (WT118), the request the owning assistant's turn reads. */
  requestExcerpt?: string;
  /** The conversation whose workflow opened this task's conversation (`Task.openedFrom`), as the router read it from its row. */
  openedFrom?: string;
  /**
   * What the task starts out recording, read by its steps' bindings (`detail:<key>`): a run's runbook drawn on its
   * dashboards carries the progress here. Top-level text values only, at most `MAX_OPENING_DETAILS_CHARS` as JSON.
   */
  details?: Record<string, string>;
}): Promise<Task | null> {
  const { channelArn, taskId, machine } = input ?? ({} as typeof input);
  if (!channelArn || !taskId || !machine || !input.workflowRun?.runKey || await refusesChannel(channelArn)) return null;
  if ((PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(machine)) {
    console.warn('[task-service][workflow-task] a step may not open one of the queue\'s own machines', { machine });
    return null;
  }
  const machines = { ...packTaskStateMachines(), ...(input.machineDef ? { [machine]: input.machineDef } : {}) };
  if (!machines[machine]) return null;
  const details = openingDetails(input.details);
  if (details === null) {
    console.warn('[task-service][workflow-task] the opening details of a task are not top-level text within their bound; refusing', { machine });
    return null;
  }
  // ONLY THIS CLASSIFICATION'S ASSISTANTS DO OR OWN ITS WORK. The router chose them from its own live list; this is the
  // second layer, against the same assignment records, before anything is written.
  for (const id of new Set([input.assistantId, ...(input.worker?.type === 'assistant' ? [input.worker.id] : [])])) {
    if (!(await isOwnAssistant(id))) {
      console.error('[task-service][SecurityEvent] a workflow task names an assistant that is not this classification\'s; refusing', { channelArn, serving: SERVICE_CLASSIFICATION });
      return null;
    }
  }
  if (input.worker?.type !== 'user' && input.worker?.type !== 'assistant') return null;
  // THE OPENER IS A CONVERSATION THIS SERVICE SERVES, of the same app instance, never the task's own: one it may not serve
  // is no opener, and the task opens without it.
  const opener = typeof input.openedFrom === 'string' && input.openedFrom !== channelArn
    && input.openedFrom.startsWith(`${channelArn.split('/channel/')[0]}/channel/`) && !(await refusesChannel(input.openedFrom)) ? input.openedFrom : undefined;
  const existing = await getTask(taskId, channelArn).catch(() => null);
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  // THE ROW OUTLIVES ITS DEADLINE by a day, so the deadline's firing and the settlement always find it.
  // A TASK NO TIMEOUT ENDS (a due or remind deadline, or none, where the run goes on once it opens or another assistant's
  // run waits on it) is kept for a run's own lifetime, at most 45 days (WT26), so its settlement always finds it.
  const ttlSeconds = !input.workflowRun.deadlineAt
    ? Math.min(Math.max(60, input.keepForSeconds ?? 45 * 24 * 3600), 45 * 24 * 3600)
    : Math.max(60, input.workflowRun.deadlineAt - now) + 24 * 3600;
  const requester = input.requesterArn && input.requesterArn.includes('/user/') ? input.requesterArn : '';
  const task = await createTask(
    { requestAttributes: { 'CHIME.channel.arn': channelArn, ...(requester ? { 'CHIME.sender.arn': requester } : {}) } },
    TaskDelivery.TASK_MULTI_STEP,
    machine,
    undefined,
    {
      taskId, machines, worker: input.worker, assistantId: input.assistantId,
      // A TASK FOR NOBODY is held by whoever does the work until its machine hands it on.
      ...(requester ? {} : { owner: input.worker }),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      workflowRun: input.workflowRun,
      // THE VERSION'S MACHINE RIDES THE TASK (ADR-067 stage 2), with the version and its hash, so every reader moves it on
      // the steps it opened on whatever the version serves next.
      ...(input.machineDef ? { originMachine: input.machineDef, originMachineHash: machineHashOf(input.machineDef) } : {}),
      ...(input.originConfigId ? { originConfigId: input.originConfigId } : {}),
      ...(input.dueBy ? { dueBy: input.dueBy } : {}),
      ttlSeconds,
      ...(input.askedBy?.runKey ? { askedBy: input.askedBy } : {}),
      ...(opener ? { openedFrom: opener } : {}),
      requestExcerpt: typeof input.requestExcerpt === 'string' ? input.requestExcerpt : '',
      ...(details ? { details } : {}),
      throwOnWriteFailure: true,
    },
  ).catch((err) => {
    console.error('[task-service][workflow-task] the task could not be written', { taskId, err: (err as Error)?.message });
    return null;
  });
  if (task) await nameWhatChanged(task.taskId, channelArn, machines);
  return task;
}

/**
 * A PERSON TAKES A CHOICE ON THEIR TASK'S CARD (ADR-063 decision 2, the FR17 submission advance). The caller's person id
 * comes from the user-tasks function, which resolved it from the request's authorizer and checked their membership as
 * them; this service checks the rest against the row it reads now (`assigneeAdvanceRefusal`), then advances through the
 * one writer. The choice's edge conditions are checked by the advance with no values held, so a conditioned choice is
 * refused rather than guessed.
 */
export async function advanceAsAssignee(input: {
  taskId: string; channelArn: string; callerPersonId: string; state: string; choice: string;
  /** A form's answers (WT50), held to its fields; taken only with the form's success choice. */
  answers?: Record<string, unknown>;
  /** The message the person answered in, where they wrote their choice (a drift offer's reply), recorded on the move. */
  messageId?: string;
  /** The router goes on with the run in the turn that relayed this, so the settlement is not named a second time. */
  continuedByCaller?: boolean;
  /** The version the card showed as the one approved, by its key. */
  document?: string;
  /**
   * The participant roles the caller holds in this conversation, read by the user-tasks function from the conversation's own
   * record (never from the request): a holder of a role the step names as deciding it may press as its assignee may.
   */
  callerRoles?: string[];
  /** The person confirmed the choice where they pressed it, so a choice that ends the run mid-way is not asked again. */
  confirmed?: boolean;
}): Promise<{ ok: true; to: string } | { ok: false; error: AssigneeAdvanceRefusal | 'REFUSED' }> {
  if (!input?.taskId || !input?.channelArn || await refusesChannel(input.channelArn)) return { ok: false, error: 'NOT_FOUND' };
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  // THE TASK'S OWN STEPS (ADR-067 stage 2): a state only its version declares is a card a person can press.
  const machines = machinesOfTask(task, packTaskStateMachines());
  const refusal = assigneeAdvanceRefusal(task, machines, input);
  if (refusal || !task) return { ok: false, error: refusal ?? 'NOT_FOUND' };
  // A REOPEN (a decider's press on a finished task, into a state its ending declares): through the one advance, recorded as a
  // reopen, and named to the router, which runs what the version declares on `task-reopened`.
  const ending = task.taskType ? machines[task.taskType]?.states[task.taskState ?? ''] : undefined;
  if (ending && !ending.transitions.length) {
    const reopened = await advanceTask({
      taskId: task.taskId, channelArn: task.channelArn, toState: input.choice, by: 'system', reason: 'reopened by a holder of a role that decides it', machines,
      reopenByDecider: true, ...(task.assistantId ? { assistantId: task.assistantId } : {}),
    });
    if (!reopened.ok) return { ok: false, error: reopened.error === 'state_changed' ? 'STATE_MOVED' : 'REFUSED' };
    await putTaskSettledFact(settledFact(task, 'card', { fromState: input.state, toState: reopened.to, personId: input.callerPersonId }));
    return { ok: true, to: reopened.to };
  }
  // AN APPROVAL OF A DOCUMENT APPROVES THE VERSION THE CARD SHOWED, and only while it is the latest: a version
  // attached since is refused, so nobody approves a file they did not see. The approved version's name rides the run on.
  const latest = latestDocument(task as Task & { documents?: unknown });
  if (latest && input.choice === 'approved') {
    // A PRESS THAT NAMES NO VERSION came from a card that could not read them: it is asked to read them, not told one moved.
    if (!input.document) return { ok: false, error: 'DOCUMENT_REQUIRED' };
    if (input.document !== latest.fileKey) return { ok: false, error: 'DOCUMENT_MOVED' };
    await setTaskRunValue(task.taskId, task.channelArn, APPROVED_DOCUMENT_VALUE, latest.name);
  }
  // A FORM'S ANSWERS (WT50) are held to its fields before anything moves, and kept on the task as the person wrote them.
  const fields = task.workflowRun?.fields;
  const answers = fields?.length && input.choice === 'answered' ? formAnswersOf(fields, input.answers) : undefined;
  if (fields?.length && input.choice === 'answered' && !answers) return { ok: false, error: 'REFUSED' };
  // A PRESS THAT WOULD END A RUN MID-WAY IS CONFIRMED FIRST: where the task's settlement ends its
  // run (`confirmEnd`) and the run has not reached its end, the press moves the task to the state that asks, an edge the
  // machine declares, and the person's confirmation there settles it.
  const machine = task.taskType ? machines[task.taskType] : undefined;
  // CONFIRMED WHERE IT WAS PRESSED (the pinned band asks before it sends), so the person is not asked twice.
  const confirmable = !input.confirmed && !!task.workflowRun?.confirmEnd && pressTarget(machine, task.taskState ?? '', input.choice, task.workflowRun, false) !== input.choice;
  const toState = confirmable ? pressTarget(machine, task.taskState ?? '', input.choice, task.workflowRun, await runReachedItsEnd(task)) : input.choice;
  // THE PERSON'S CHOICE, RELAYED THROUGH THE ONE ADVANCE (`advanceTask`): the state it leaves awaits that person, and the
  // edge is one the state declares as a choice, so the move is theirs and the runtime decides nothing.
  const result = await advanceTask({
    taskId: task.taskId, channelArn: task.channelArn, toState, by: 'system', reason: toState !== input.choice ? 'its assignee asked to settle it while its run has steps open'
      : task.assigneeId === input.callerPersonId ? 'chosen by its assignee on the task card' : 'chosen by a holder of a role that decides it', machines,
    ...(task.assistantId ? { assistantId: task.assistantId } : {}),
    ...(answers ? { details: { form: answers } } : {}),
    ...(typeof input.messageId === 'string' && input.messageId ? { messageId: input.messageId.slice(0, 128) } : {}),
    ...(input.continuedByCaller ? { continuedByCaller: true } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error === 'state_changed' ? 'STATE_MOVED' : 'REFUSED' };
  // The advance named the settlement already: an ending is read from the terminal state, whatever the lifecycle says.
  if (result.terminal) await updateTaskStatus(task.taskId, task.channelArn, result.terminal === 'success' ? 'completed' : 'failed');
  // THE PRESS IS A FACT NO TURN RECORDS (WT61): one archive record of the move it made, ids and states only.
  await putTaskSettledFact(settledFact(task, 'card', { fromState: input.state, toState: result.to, ...(result.terminal ? { terminal: result.terminal } : {}), personId: input.callerPersonId }));
  return { ok: true, to: result.to };
}

/** The task's assignee, a person, or nothing: the one who may read and attach its versions. */
async function assignedTo(input: { taskId?: unknown; channelArn?: unknown; callerPersonId?: unknown }): Promise<Task | null> {
  if (typeof input?.taskId !== 'string' || typeof input?.channelArn !== 'string' || typeof input?.callerPersonId !== 'string') return null;
  if (await refusesChannel(input.channelArn)) return null;
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  return task && task.assigneeType === 'user' && task.assigneeId === input.callerPersonId ? task : null;
}

/** THE VERSIONS OF THE DOCUMENT A TASK APPROVES, oldest first, for its assignee. */
async function taskDocuments(input: { taskId: string; channelArn: string; callerPersonId: string }): Promise<{ ok: true; documents: TaskDocument[] } | { ok: false; error: 'NOT_FOUND' }> {
  const task = await assignedTo(input);
  return task ? { ok: true, documents: documentsOf(task as Task & { documents?: unknown }) } : { ok: false, error: 'NOT_FOUND' };
}

/**
 * ITS APPROVER ATTACHES AN EDITED VERSION: the task's assignee, while it is open, a Markdown file they uploaded
 * to this conversation themselves (`isOwnMarkdownUpload`), recorded as the task's newest version.
 */
async function addTaskDocument(input: { taskId: string; channelArn: string; callerPersonId: string; fileKey: string; name: string }): Promise<{ ok: true; documents: TaskDocument[] } | { ok: false; error: 'NOT_FOUND' | 'SETTLED' | 'NOT_YOURS' | 'FULL' }> {
  const task = await assignedTo(input);
  if (!task || !task.workflowRun) return { ok: false, error: 'NOT_FOUND' };
  if (settlementOutcome(task, machinesOfTask(task, packTaskStateMachines()))) return { ok: false, error: 'SETTLED' };
  const conversationId = task.channelArn.split('/').pop() ?? '';
  if (!isOwnMarkdownUpload(input.fileKey, conversationId, input.callerPersonId)) return { ok: false, error: 'NOT_YOURS' };
  const doc: TaskDocument = { fileKey: input.fileKey, name: String(input.name || input.fileKey.split('/').pop()).slice(0, 120), by: input.callerPersonId, at: new Date().toISOString() };
  if (!(await appendTaskDocument(task.taskId, task.channelArn, doc, MAX_TASK_DOCUMENTS))) return { ok: false, error: 'FULL' };
  const now = await getTask(task.taskId, task.channelArn).catch(() => null);
  return { ok: true, documents: documentsOf((now ?? task) as Task & { documents?: unknown }) };
}

/**
 * ITS APPROVER ASKS THE DRAFTING ASSISTANT TO REVISE IT: the task's assignee, while it is open and its
 * versions start from an assistant's draft, with their instructions. The request is recorded on the task, then named to the
 * router, which asks the same assistant for the same intent; its revised file lands as this task's next version
 * (`addRevisedDocument`). One revision at a time: one that failed is cleared where its failure is seen (`abandonRevision`), and one
 * past `REVISION_PENDING_MS` holds nothing back, so a revision whose turn ended unseen never blocks the next.
 */
async function requestRevision(input: { taskId: string; channelArn: string; callerPersonId: string; instructions: string }): Promise<{ ok: true } | { ok: false; error: 'NOT_FOUND' | 'SETTLED' | 'NO_DRAFT' | 'PENDING' | 'REFUSED' }> {
  const task = await assignedTo(input) as (Task & { documents?: unknown; revision?: TaskRevisionRequest }) | null;
  if (!task || !task.workflowRun) return { ok: false, error: 'NOT_FOUND' };
  if (settlementOutcome(task, machinesOfTask(task, packTaskStateMachines()))) return { ok: false, error: 'SETTLED' };
  if (!draftingOf(task)) return { ok: false, error: 'NO_DRAFT' };
  if (revisionPending(task.revision)) return { ok: false, error: 'PENDING' };
  const instructions = String(input.instructions ?? '').trim().slice(0, MAX_REVISION_INSTRUCTIONS);
  if (!instructions) return { ok: false, error: 'REFUSED' };
  const n = documentsOf(task).length + 1;
  if (!(await setTaskRevision(task.taskId, task.channelArn, { instructions, by: input.callerPersonId, at: new Date().toISOString(), n }))) return { ok: false, error: 'REFUSED' };
  if (!(await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'revise', channelArn: task.channelArn, taskId: task.taskId }))) {
    await setTaskRevision(task.taskId, task.channelArn, null);
    return { ok: false, error: 'REFUSED' };
  }
  return { ok: true };
}

/**
 * A REVISION THAT WILL NOT LAND IS CLEARED (`clearTaskRevision`): named by the router where no assistant holds the drafting role or
 * the turn could not be dispatched, and by the drafting turn where it ended without a file. Only that revision, by its number.
 */
async function abandonRevision(input: { taskId: string; channelArn: string; n: number }): Promise<{ cleared: boolean }> {
  if (typeof input?.taskId !== 'string' || typeof input?.channelArn !== 'string' || !Number.isInteger(input?.n) || await refusesChannel(input.channelArn)) return { cleared: false };
  return { cleared: await clearTaskRevision(input.taskId, input.channelArn, input.n) };
}

/**
 * THE DRAFTING ASSISTANT'S REVISION LANDS AS THE TASK'S NEXT VERSION (stage 2): only while a revision is asked for and the task
 * is open, and only a file an assistant delivered in this conversation. The request is cleared, so another may be asked.
 */
async function addRevisedDocument(input: { taskId: string; channelArn: string; fileKey: string; name: string; by: string }): Promise<{ ok: boolean; error?: string }> {
  if (typeof input?.taskId !== 'string' || typeof input?.channelArn !== 'string' || await refusesChannel(input.channelArn)) return { ok: false, error: 'NOT_FOUND' };
  const task = await getTask(input.taskId, input.channelArn).catch(() => null) as (Task & { revision?: TaskRevisionRequest }) | null;
  if (!task?.revision) return { ok: false, error: 'NOT_ASKED' };
  if (settlementOutcome(task, machinesOfTask(task, packTaskStateMachines()))) return { ok: false, error: 'SETTLED' };
  if (!isAssistantDocumentKey(input.fileKey, task.channelArn.split('/').pop() ?? '') || typeof input.by !== 'string' || !input.by.startsWith('assistant:')) return { ok: false, error: 'NOT_YOURS' };
  const doc: TaskDocument = { fileKey: input.fileKey, name: String(input.name || '').slice(0, 120) || input.fileKey.split('/').pop()!, by: input.by.slice(0, 60), at: new Date().toISOString() };
  const added = await appendTaskDocument(task.taskId, task.channelArn, doc, MAX_TASK_DOCUMENTS);
  await setTaskRevision(task.taskId, task.channelArn, null);
  return added ? { ok: true } : { ok: false, error: 'FULL' };
}

/**
 * A RUN REACHED ITS END (WT62): the router names it, and this service, which alone may put to the archive's stream, writes
 * the one fact, for a conversation of its own classification only.
 */
async function recordRunEnded(input: Omit<RunEndedFact, 'factId' | 'classification' | 'at'>): Promise<{ recorded: boolean }> {
  if (!input?.channelArn || !input?.runKey || !input?.workflow || await refusesChannel(input.channelArn)) return { recorded: false };
  if (input.disposition !== 'success' && input.disposition !== 'failure') return { recorded: false };
  const steps = Array.isArray(input.steps)
    ? input.steps.filter((x) => x && typeof x.step === 'string' && typeof x.outcome === 'string').slice(0, 32).map((x) => ({ step: x.step, outcome: x.outcome }))
    : undefined;
  const recorded = await putRunEndedFact({
    factId: `${input.runKey}#end`, channelArn: input.channelArn, runKey: input.runKey, workflow: input.workflow, trigger: String(input.trigger ?? ''),
    disposition: input.disposition, classification: SERVICE_CLASSIFICATION,
    ...(steps ? { steps } : {}),
    ...(typeof input.originConfigId === 'string' ? { originConfigId: input.originConfigId } : {}),
    ...(typeof input.personId === 'string' ? { personId: input.personId } : {}),
    // THE RUN'S PROCESS (SPEC-PROCESSES P8), kept only where every part has its shape.
    ...processFieldsOf(input),
    at: new Date().toISOString(),
  });
  return { recorded };
}

/** A run end's process fields, each only where it has its shape: an id and an edition are hashes, a team a team name. */
function processFieldsOf(input: Pick<RunEndedFact, 'processId' | 'process' | 'processEdition' | 'ownerTeam'>): Pick<RunEndedFact, 'processId' | 'process' | 'processEdition' | 'ownerTeam'> {
  if (typeof input.processId !== 'string' || !PROCESS_ID.test(input.processId)) return {};
  return {
    processId: input.processId,
    ...(typeof input.process === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(input.process) ? { process: input.process } : {}),
    ...(typeof input.processEdition === 'string' && PROCESS_ID.test(input.processEdition) ? { processEdition: input.processEdition } : {}),
    ...(typeof input.ownerTeam === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(input.ownerTeam) ? { ownerTeam: input.ownerTeam } : {}),
  };
}

/** The archive record of a settlement no turn records (WT61): the task's references, never its content. */
function settledFact(task: Task, cause: TaskSettledFact['cause'], move: Pick<TaskSettledFact, 'fromState' | 'toState' | 'terminal' | 'personId' | 'action'>): TaskSettledFact {
  const at = new Date().toISOString();
  return {
    // Fixed when the fact is made, so a stream redelivery of the record lands on the row it already wrote; a task that
    // loops through the same press twice makes two facts.
    factId: [task.taskId, cause, move.toState ?? move.terminal ?? '', at].join('#'),
    channelArn: task.channelArn, taskId: task.taskId, cause, classification: SERVICE_CLASSIFICATION,
    ...(task.taskType ? { taskType: task.taskType } : {}), ...move,
    ...(task.originConfigId ? { originConfigId: task.originConfigId } : {}), ...(task.originMachineHash ? { originMachineHash: task.originMachineHash } : {}),
    ...(task.workflowRun ? { runKey: task.workflowRun.runKey, workflow: task.workflowRun.workflow } : {}),
    ...(task.workflowRun?.process && PROCESS_ID.test(task.workflowRun.process.id) ? { processId: task.workflowRun.process.id } : {}),
    at,
  };
}

/**
 * A TASK STEP'S DEADLINE ENDS ITS TASK (ADR-063 decision 4): the router checked the firing, and this cancels a task that is
 * still open and still names a run, recording the ending as the deadline's, then names the settlement. A task already
 * settled is left as it is.
 */
async function cancelForDeadline(input: { taskId: string; channelArn: string }): Promise<{ cancelled: boolean }> {
  if (!input?.taskId || !input?.channelArn || await refusesChannel(input.channelArn)) return { cancelled: false };
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  if (!task?.workflowRun || settlementOutcome(task, machinesOfTask(task, packTaskStateMachines()))) return { cancelled: false };
  await updateTaskStatus(task.taskId, task.channelArn, 'cancelled', undefined, TASK_DEADLINE_ENDING);
  // THE DEADLINE'S ENDING IS A FACT NO TURN RECORDS (WT61).
  await putTaskSettledFact(settledFact(task, 'deadline', { ...(task.taskState ? { fromState: task.taskState } : {}), terminal: 'deadline' }));
  await nameWhatChanged(task.taskId, task.channelArn);
  return { cancelled: true };
}

/**
 * ARCHIVING A CONVERSATION SETTLES ITS OPEN WORKFLOW TASKS (ADR-017, WT122): the conversation management function archived
 * it and named it to its router, which asks here. Each task a workflow step opened that is still open is cancelled, its
 * ending recorded as the archive's, and its settlement named, so the run waiting on it goes on as its failure would take it
 * (an incident's run ends, and the conversation that opened it is told). Only in an archived conversation of this
 * service's classification: the tag is read again here, so a caller cannot end the work of a live one. Every page is read;
 * a read that fails settles nothing and says so.
 */
export async function settleArchivedTasks(input: { channelArn: string }): Promise<{ settled: string[] } | { failed: true }> {
  if (!input?.channelArn || await refusesChannel(input.channelArn)) return { failed: true };
  const tags = await readChannelTags(chimeClient, input.channelArn).catch(() => null);
  if (tags?.archived !== 'true') {
    console.warn('[task-service] settling an archived conversation\'s tasks was asked for a conversation that is not archived; nothing is settled');
    return { failed: true };
  }
  const open = await openWorkflowTasksIn(input.channelArn);
  if (!open) return { failed: true };
  const settled: string[] = [];
  for (const task of open) {
    if (!task.workflowRun || settlementOutcome(task, machinesOfTask(task, packTaskStateMachines()))) continue;
    await updateTaskStatus(task.taskId, task.channelArn, 'cancelled', undefined, TASK_ARCHIVE_ENDING);
    await putTaskSettledFact(settledFact(task, 'archive', { ...(task.taskState ? { fromState: task.taskState } : {}), terminal: TASK_ARCHIVE_ENDING }));
    await nameWhatChanged(task.taskId, task.channelArn);
    settled.push(task.taskId);
  }
  return { settled };
}

/**
 * A RUN THAT ENDED MID-WAY CANCELS ITS OPEN WORK (`endsRun`): the router ended the run because the
 * task it went on alongside settled, and asks here. Each open task the run's steps opened, and each request it made of
 * another assistant, is cancelled with the run's end recorded as its reason, and its settlement named, so nothing is left
 * pending. The run's end is already claimed, so no settlement named here continues it. The task that ended the run is
 * settled and is not touched. Only in a conversation of this service's classification; a read that fails cancels nothing
 * and says so.
 */
export async function endRunTasks(input: { channelArn: string; runKey: string; keepAlongside?: boolean; keepTaskId?: string }): Promise<{ cancelled: string[] } | { failed: true }> {
  if (!input?.channelArn || !input?.runKey || await refusesChannel(input.channelArn)) return { failed: true };
  const open = await openWorkflowTasksIn(input.channelArn);
  if (!open) return { failed: true };
  const cancelled: string[] = [];
  for (const task of open) {
    if (task.workflowRun?.runKey !== input.runKey && task.askedBy?.runKey !== input.runKey) continue;
    // A RUN MOVED ON (O15) KEEPS WHAT IT WENT ON ALONGSIDE: an investigation outlives the resolve.
    if (input.keepAlongside && task.workflowRun?.holdsEnd) continue;
    // A REOPEN KEEPS THE TASK IT REOPENED, which the reopen's own run takes next.
    if (input.keepTaskId && task.taskId === input.keepTaskId) continue;
    if (settlementOutcome(task, machinesOfTask(task, packTaskStateMachines()))) continue;
    await updateTaskStatus(task.taskId, task.channelArn, 'cancelled', undefined, TASK_RUN_ENDED_ENDING);
    await putTaskSettledFact(settledFact(task, 'run-ended', { ...(task.taskState ? { fromState: task.taskState } : {}), terminal: TASK_RUN_ENDED_ENDING }));
    await nameWhatChanged(task.taskId, task.channelArn);
    cancelled.push(task.taskId);
  }
  return { cancelled };
}

/**
 * THE OPEN TASKS OF ONE MACHINE IN EVERY CONVERSATION A CONVERSATION'S WORKFLOW OPENED (WT122): one query on the index the
 * tasks table keeps by `openedFrom`, asked for an opener of this service's classification. Null on any failed read, never a
 * short list. A task held in a conversation this service does not serve is not this opener's, and is left out.
 */
export async function openTasksOpenedFrom(input: { openedFrom: string; taskType: string }): Promise<Task[] | null> {
  if (!input?.openedFrom || !input?.taskType || await refusesChannel(input.openedFrom)) return null;
  const tasks = await storeOpenTasksOpenedFrom(input.openedFrom, input.taskType);
  if (!tasks) return null;
  const served = await Promise.all(tasks.map(async (t) => (t.openedFrom === input.openedFrom && !(await refusesChannel(t.channelArn)) ? t : null)));
  return served.filter((t): t is Task => !!t);
}

/**
 * AN ASSISTANT'S READY WORK IN ONE CONVERSATION, IN THE ORDER IT TAKES IT UP (ADR-063 decision 5): its assignee partition,
 * filtered to the conversation, each row read whole and held to `pickupReadiness`. A task the turn that is ending worked
 * and did not move is held by its own turn count; one it moved into a new step is a new entry, ready like any other. A
 * keyed read, never a scan.
 */
async function readyTasks(input: { channelArn: string; assistantId: string; machines?: Record<string, TaskStateMachine> }): Promise<Task[]> {
  if (!input?.channelArn || !input?.assistantId || await refusesChannel(input.channelArn)) return [];
  const machines = { ...packTaskStateMachines(), ...(input.machines ?? {}) };
  const { live } = await getAssigneeChannelTasks(input.assistantId, input.channelArn, {});
  const rows = await Promise.all(live.map((t) => getTask(t.taskId, input.channelArn).catch(() => null)));
  return orderForPickup(rows.filter((t): t is Task => !!t && pickupReadiness(t, machinesOfTask(t, machines), input.assistantId).ready));
}

/** Take up one entry of a task's state, once (decision 5): the per-entry claim, keyed `pickup:<state>#<entry>`. */
async function claimPickup(input: { taskId: string; channelArn: string; state: string }): Promise<ActionClaim> {
  const key = `pickup:${input?.state ?? ''}#?`;
  if (!input?.taskId || !input?.channelArn || !input?.state || await refusesChannel(input.channelArn)) return { claimed: false, key, reason: 'failed' };
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  if (!task) return { claimed: false, key, reason: 'failed' };
  return claimStateAction({ task, state: input.state, pickup: true });
}

/**
 * WHAT AN OPERATOR SEES, AND WHY IT GOES THROUGH `refusesChannel` AFTER ALL.
 *
 * These two ops used to skip it, reasoning that an operator is not an assistant and that a premium
 * conversation's stalled task would otherwise be invisible to the console that exists to unblock it.
 * The first half is true. The second was not, and skipping it opened the boundary the file header
 * claims is impossible for a caller to influence.
 *
 * The boundary is expressible in IAM only ACROSS services: each classification's roles hold invoke on
 * their own task service and no other. It is `refusesChannel` that bounds what a service will answer
 * about, and IAM cannot condition on an `op` string - so a role with invoke on its own service could
 * reach any conversation's tasks by choosing an op that skipped the check, and all three services
 * share one table, so the row was there to be read. `viewerId` comes off the same payload, which is
 * the key that unstrips a private task.
 *
 * Applying it costs the operator nothing, which is the part the original reasoning missed:
 * `admin-tasks` ASKS EVERY CLASSIFICATION because it does not know which one owns the conversation.
 * The owning service still answers exactly as before; the two that do not own it now decline instead
 * of reading a table they have no business in. Same merged answer, one fewer way to reach it.
 *
 * The capability at the door - vended short and audited by the credential exchange - is still what
 * lets an operator ask at all. It is now the outer of two bounds rather than the only one.
 *
 * AND A PRIVATE TASK IS STILL COUNTED, AND STILL SHOWN. "Private" means private from other MEMBERS,
 * not from the platform's own accounting: a task that vanished from an operator's view would make the
 * queue look like it was losing work. What does NOT travel is the CONTENT - this returns the same
 * field-by-field shape the conversation read does, which cannot carry message text by construction.
 */
export async function adminListTasks(input: {
  channelArn: string;
  viewerId?: string;
}): Promise<ConversationTask[]> {
  const { channelArn, viewerId } = input;
  if (!channelArn || await refusesChannel(channelArn)) return [];
  return getOpenTasksForConversation(channelArn, { ...(viewerId ? { viewerId } : {}) })
    .catch(() => []);
}

/**
 * Everything ONE owner has open, across every conversation.
 *
 * The question a conversation-scoped read cannot answer: "what is this person still waiting on",
 * which does not stop at a channel boundary. Answering it per-conversation is how the stalled one
 * in a room nobody thought to look in stays stalled.
 *
 * ONE ROUTE FOR A PERSON OR AN ASSISTANT, because the mirror table is keyed on the CURRENT OWNER
 * rather than on a human (ADR-024 D2: `personId` holds the owner's principal id, whichever it is).
 * An owner id is therefore all this needs, and the `principalId-taskType-index` GSI already spans
 * channels - no new index, and no scan.
 *
 * THE CLASSIFICATION BOUNDARY IS APPLIED PER ROW, not once at the door. A conversation-scoped read
 * can refuse up front because it names one channel; an owner spans several, and any of them may
 * belong to a classification this service may not serve. So each row is checked against the same
 * `refusesChannel` gate, and one it may not serve is dropped rather than answered. The console asks
 * all three services and merges, so the operator still sees the whole picture.
 *
 * CONTENT DOES NOT TRAVEL, exactly as it does not for the conversation read: `details` is dropped
 * on the way out. A private task is still COUNTED and still shown - private means private from other
 * members, not from the platform's own accounting - but what it says is not an operator's to read
 * from here.
 */
/**
 * WHAT ONE PERSON OWNS, ACROSS CONVERSATIONS (ADR-024 D8).
 *
 * The sibling below answers what a principal is ASSIGNED, which is what they owe next. This answers
 * what they OWN, and the two return different sets: work in flight is assigned to the assistant and
 * still owned by the person who asked for it, so it appears here and not there. An operator asking
 * "what is this person's" wants this one.
 *
 * EACH ROW IS GATED, not the question, for the reason the assignee read gives: an owner spans
 * conversations and any of them may belong to a classification this service does not answer for, so
 * the boundary is applied to the answer.
 *
 * CONTENT DOES NOT TRAVEL. Same rule as every admin read here: a private task is counted and shown,
 * and what it says is not an operator's to read from this surface.
 */
/**
 * THE TASK A REQUESTER MAY MOVE WHILE ANOTHER PERSON HOLDS IT (ADR-067 G8, WT114): in this conversation, live, for this
 * person, held by someone else (a person worker, or a role's holder), in a step that declares `requesterMoves`. The newest
 * such task, read back whole, with the moves its step allows, or null. Refused for a conversation this service does not
 * serve. Read through the owner index the person's own work is listed by, so nothing is scanned.
 */
export async function requesterMovableTask(input: {
  channelArn: string;
  personId: string;
  machines?: Record<string, TaskStateMachine>;
}): Promise<{ task: Task; moves: string[] } | null> {
  const { channelArn, personId } = input ?? ({} as typeof input);
  if (!channelArn || !personId || await refusesChannel(channelArn)) return null;
  const known = { ...packTaskStateMachines(), ...(input.machines ?? {}) };
  const rows = (await getTasksOwnedBy(personId).catch(() => []))
    .filter((r) => r.channelArn === channelArn && r.principalId !== personId)
    // A ROW WHOSE STEP OFFERS THE REQUESTER A MOVE IS READ FIRST, newest first, so other tasks never crowd it out of the ten
    // read. The shared machines only rank: a task on its version's own machine is still read, and its own machine decides.
    .map((r) => ({ r, offers: !!r.taskType && requesterMovesOf(known[r.taskType], r.taskState).length > 0 }))
    .sort((a, b) => Number(b.offers) - Number(a.offers) || String(b.r.updatedAt ?? '').localeCompare(String(a.r.updatedAt ?? '')))
    .slice(0, 10)
    .map(({ r }) => r);
  // READ TOGETHER, so the look-up is one round trip on the turn's path, then checked in the order ranked above.
  const read = await Promise.all(rows.map((row) => getTask(row.taskId, channelArn).catch(() => null)));
  for (const task of read) {
    if (!task || !ACTIVE_TASK_STATUSES.includes(task.status) || personIdFromArn(task.userArn) !== personId) continue;
    if (task.assigneeId === personId) continue;
    const machine = machinesOfTask(task, { ...packTaskStateMachines(), ...(input.machines ?? {}) })[task.taskType ?? ''];
    const moves = requesterMovesOf(machine, task.taskState);
    if (moves.length) return { task, moves };
  }
  return null;
}

export async function adminListTasksOwnedBy(input: {
  ownerPersonId: string;
}): Promise<ConversationTask[]> {
  const ownerPersonId = input?.ownerPersonId || '';
  if (!ownerPersonId) return [];
  const rows = await getTasksOwnedBy(ownerPersonId).catch(() => []);
  const serveable = (await Promise.all(
    rows.map(async (r) => ((await refusesChannel(r.channelArn, 'elsewhere')) ? null : r)),
  )).filter((r): r is (typeof rows)[number] => r !== null);
  return serveable.map((r) => ({
    taskId: r.taskId,
    channelArn: r.channelArn,
    taskType: r.taskType,
    taskState: r.taskState,
    status: r.status,
    assigneeId: r.principalId,
    assigneeType: r.assigneeType ?? r.ownerType,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(isPrivateVisibility(r.visibility)
      ? { private: true as const }
      : (r.dueBy ? { dueBy: r.dueBy } : {})),
  }));
}

/**
 * HAND A TASK TO A DIFFERENT PERSON (ADR-024 D8).
 *
 * CHANNEL-SCOPED ON PURPOSE. A task is keyed by (taskId, channelArn), so the conversation is needed
 * to name the row at all - and naming it means this write sits behind the same channel-scoped
 * capability and the same classification refusal as every other task write, rather than needing a
 * boundary of its own.
 */
async function reassignOwner(input: {
  taskId: string;
  channelArn: string;
  ownerPersonId: string;
}): Promise<{ ok: boolean }> {
  if (!input?.taskId || !input?.channelArn || !input?.ownerPersonId) return { ok: false };
  if (await refusesChannel(input.channelArn)) return { ok: false };
  return { ok: await reassignTaskOwner(input.taskId, input.channelArn, input.ownerPersonId) };
}

export async function adminListAssigneeTasks(input: {
  /** The principal whose queue this is. Accepts the pre-D8 key so a caller mid-deploy still works. */
  assigneeId?: string;
  ownerId?: string;
}): Promise<ConversationTask[]> {
  const assigneeId = input?.assigneeId || input?.ownerId || '';
  if (!assigneeId) return [];
  const rows = await getActiveTasksForUser(assigneeId, { limit: 25 }).catch(() => []);
  const serveable = await Promise.all(
    rows.map(async (r) => ((await refusesChannel(r.channelArn, 'elsewhere')) ? null : r)),
  );
  return serveable
    .filter((r): r is (typeof rows)[number] => r !== null)
    .map((r) => ({
      taskId: r.taskId,
      channelArn: r.channelArn,
      taskType: r.taskType,
      taskState: r.taskState,
      status: r.status,
      // The partition key IS the assignee (`principalId`, ADR-024 D2).
      assigneeId: r.principalId,
      assigneeType: r.assigneeType ?? r.ownerType,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      // ── A PRIVATE ROW SAYS SO, AND CARRIES LESS (code review, 2026-09-04) ──────────────────────
      //
      // The sibling conversation read marks a private row `private: true` and withholds `dueBy` from
      // a caller who may not read its details. This one did neither, so a private task arrived here
      // looking exactly like an ordinary one: an operator could not tell which rows to treat
      // carefully, and the console had nothing to render a marker from.
      //
      // The comment above already states the rule this now keeps - a private task is counted and
      // shown, and what it says is not an operator's to read from here. `dueBy` is part of what it
      // says: when somebody's private request is due is a fact about that request.
      ...(isPrivateVisibility(r.visibility)
        ? { private: true as const }
        : (r.dueBy ? { dueBy: r.dueBy } : {})),
    }));
}

/**
 * Cancel a task an operator has decided is stuck.
 *
 * THE AUTHORITY, NEVER THE PROJECTION. The console can already SEE a stalled task in the Aurora copy,
 * and acting on that copy would break the rule that an archived copy is never the authority for a
 * live decision - it lags exactly when something has just changed. This writes to the store the
 * assistants read.
 *
 * `cancelled` rather than `failed`: an operator deciding work should stop is a decision, and
 * recording it as a fault would put one in the record where there was none.
 */
export async function adminCancelTask(input: {
  taskId: string;
  channelArn: string;
  by: string;
}): Promise<boolean> {
  const { taskId, channelArn, by } = input;
  if (!taskId || !channelArn || await refusesChannel(channelArn)) return false;
  try {
    // READ FIRST, because `updateTaskStatus` catches its own errors and returns void: the catch
    // below could never fire, so this reported success for a task id that does not exist and the
    // route's 404 was unreachable. An operator was told they had cancelled something they had not.
    const existing = await getTask(taskId, channelArn);
    if (!existing) {
      console.warn('[task-service][admin] cancel asked for a task that does not exist', { taskId, channelArn });
      return false;
    }
    await updateTaskStatus(taskId, channelArn, 'cancelled', undefined, `cancelled by ${by || 'an operator'}`);
    console.log('[task-service][admin] task cancelled by an operator', { taskId, channelArn, by });
    // A RUN WAITING ON IT GOES ON, on its failure edge (ADR-063 decision 3).
    await nameWhatChanged(taskId, channelArn);
    return true;
  } catch (err) {
    console.error('[task-service][admin] cancel failed', { taskId, err: (err as Error)?.message });
    return false;
  }
}

/**
 * AN OPERATOR CANCELS A RUN (ADR-067 WT27, decision OPEN 13): every live task the run opened in the conversation is
 * cancelled through the operator's own cancel (`adminCancelTask`), so each settles on its own edge and the run goes on as
 * each step's failure would take it, once per step under its continuation claim. The operator names one task of the run;
 * its run is read from that task's row, so no run key leaves the platform and a private run is cancelled as a shared one is,
 * in a conversation of this service's classification only. Undoing what a run sent to an outside tool is the connectors
 * pass. Returns how many tasks it cancelled.
 */
export async function adminCancelRun(input: { taskId: string; channelArn: string; by: string }): Promise<{ cancelled: number }> {
  const { taskId: named, channelArn, by } = input ?? ({} as typeof input);
  if (!named || !channelArn || await refusesChannel(channelArn)) return { cancelled: 0 };
  const runKey = (await getTask(named, channelArn).catch(() => null))?.workflowRun?.runKey;
  if (!runKey) return { cancelled: 0 };
  let cancelled = 0;
  // READ TOGETHER, in batches, so a busy conversation's run is cancelled in a few round trips rather than one per task.
  const ids = (await adminListTasks({ channelArn })).map((t) => t.taskId);
  for (let i = 0; i < ids.length; i += 25) {
    const batch = await Promise.all(ids.slice(i, i + 25).map((taskId) => getTask(taskId, channelArn).catch(() => null)));
    for (const task of batch) {
      // A REQUEST THIS RUN MADE OF ANOTHER ASSISTANT is that assistant's work (WT118), so it is not cancelled here; the run
      // is released from it, and its ending continues nothing.
      if (task?.askedBy?.runKey === runKey) { await releaseAskedBy(task.taskId, channelArn, runKey); continue; }
      if (!task || task.workflowRun?.runKey !== runKey || !(ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) continue;
      if (await adminCancelTask({ taskId: task.taskId, channelArn, by: `${by || 'an operator'} (the run)` })) cancelled += 1;
    }
  }
  console.log('[task-service][admin] operator cancelled a run', { channelArn, cancelled, by });
  return { cancelled };
}

/**
 * The owner's work in one conversation, live and recently ended.
 *
 * REFUSAL IS AN EMPTY ANSWER, matching every other read here: the caller cannot tell a refusal from
 * "nothing open", and that is the point - a refusal must not be distinguishable enough to probe with.
 */
async function ownerChannelTasks(input: {
  ownerId: string;
  channelArn: string;
  opts?: { endedWithinMs?: number };
}): Promise<{ live: UserTask[]; recentlyEnded: UserTask[] }> {
  const empty = { live: [], recentlyEnded: [] };
  if (!input?.channelArn || await refusesChannel(input.channelArn)) return empty;
  return getAssigneeChannelTasks(input.ownerId, input.channelArn, input.opts ?? {});
}

/**
 * WHICH OF THIS PERSON'S WORK IN THIS CONVERSATION IS THIS ASSISTANT'S (ADR-024 D8).
 *
 * The read behind "which open item is this message about". Two things make it safe, and neither is
 * the index it runs over (tenet P4: enforced before the request runs, two layers, deny-tested):
 *
 *  1. IAM decides who may invoke this service at all. A person cannot reach it; only the roles that
 *     run turns for this classification can.
 *  2. This service answers for ONE classification, taken from its own environment, and refuses a
 *     conversation tagged with a classification it does not grant - before any read happens. A caller cannot claim a classification;
 *     the sibling reads are tested for exactly that.
 *
 * The owner is carried from the message sender, which Amazon Chime SDK stamps, so an actor is only
 * ever asked about as itself. It is required rather than defaulted: an absent owner that fell back to
 * "everything in the conversation" would answer a different, much wider question than the one asked.
 */
async function referentCandidates(input: {
  channelArn: string;
  assistantId: string;
  ownerPersonId: string;
}): Promise<UserTask[]> {
  if (!input?.channelArn || !input?.assistantId || !input?.ownerPersonId) return [];
  if (await refusesChannel(input.channelArn)) return [];
  return getConversationTasksForAssistant(input.channelArn, input.assistantId, input.ownerPersonId);
}

/**
 * The open item a reference names, when its sender may answer it (ADR-035).
 *
 * The channel flow's one question of this service, asked before it routes a bare `#<n>` in a group.
 * Refusal is null like every other read here, so a refused conversation and a reference to nothing
 * look the same to the caller.
 */
async function answerableTaskByRef(input: {
  channelArn: string;
  taskRef: number;
  senderSub: string;
}): Promise<{ taskId: string; assistantId?: string; private?: true } | null> {
  if (!input?.channelArn || !input?.senderSub || await refusesChannel(input.channelArn)) return null;
  return findAnswerableTaskByRef(input.channelArn, Number(input.taskRef), input.senderSub);
}

/**
 * The open item an id names, when its sender may answer it.
 *
 * The same question {@link answerableTaskByRef} answers, asked with the identifier a client already
 * holds for the item it is showing. Two ops rather than one taking either selector, so neither name
 * lies about what it takes; the permission behind both is one function (`answerableBy`).
 *
 * Refusal is null exactly as above, so a refused conversation and an id naming nothing look the same.
 */
async function answerableTaskById(input: {
  channelArn: string;
  taskId: string;
  senderSub: string;
}): Promise<{ taskId: string; assistantId?: string; private?: true } | null> {
  if (!input?.channelArn || !input?.senderSub || !input?.taskId) return null;
  if (await refusesChannel(input.channelArn)) return null;
  return findAnswerableTaskById(input.channelArn, String(input.taskId), input.senderSub);
}

/** One active task of a given type for a person, optionally scoped to a conversation. */
async function activeTaskByType(input: {
  personId: string;
  taskType: string;
  channelArn?: string;
}): Promise<UserTask | null> {
  // SCOPED READS ARE REFUSABLE, UNSCOPED ONES ARE NOT ASKED. Without a conversation there is no tag
  // to decide on, and this service answers for one classification - so a cross-conversation read is
  // refused rather than answered from a boundary that cannot apply.
  // ── AN UNSCOPED READ IS GATED ON THE ROW IT FINDS (code review, 2026-09-04) ──────────────────
  //
  // The reasoning above is right about the boundary and wrong about what follows from it. Returning
  // `null` did not decline the read - it answered "there is no such task", to a caller that then acts
  // on that answer: the router's channel-less fallback opens a FRESH task beside the live one, so a
  // person's continuation started a second chain of the same work. It also cost a Lambda invoke per
  // candidate machine type, about a dozen a turn, each guaranteed to answer nothing.
  //
  // `adminListAssigneeTasks` has the same problem and already solved it: a principal spans conversations,
  // any of which may belong to a classification this service may not serve, so it checks each ROW
  // against `refusesChannel` instead of refusing up front. A row carries its own `channelArn`, which
  // is the tag this service needs - the boundary is applied to the answer rather than to the question.
  if (input?.channelArn) {
    if (await refusesChannel(input.channelArn)) return null;
    return getActiveTask(input.personId, input.taskType, { channelArn: input.channelArn });
  }
  const found = await getActiveTask(input.personId, input.taskType);
  if (!found) return null;
  // `elsewhere`: the caller named no conversation, so this row's channel was found by lookup and
  // nothing upstream authorized it. An unreadable tag here is refused rather than admitted.
  return (await refusesChannel(found.channelArn, 'elsewhere')) ? null : found;
}

/** The work a `/stop` from this person, aimed at this assistant, would be about (ADR-033). */
/**
 * Discard the work a stop named, now that the person has answered.
 *
 * THE PROCESSOR CANNOT DO THIS ITSELF, and the attempt is what found this: the processor role holds
 * no direct write on the task tables, so calling the discard from there returned
 * `[cancelTasksForStop] query/cancel failed: AccessDenied` and the work stayed open. The refusal is
 * the design working - the service is where the classification boundary is applied before any write.
 *
 * REFUSAL IS ZERO, matching every other op here: the caller cannot tell a refused channel from work
 * that was already gone.
 */
/** Close the work an ended duel's sides opened, in a conversation this classification serves. */
async function closeDuelTasks(input: { channelArn: string; battleId: string }): Promise<{ closed: Array<{ taskId: string; assistantId?: string }> }> {
  const { channelArn, battleId } = input;
  if (!channelArn || !battleId || await refusesChannel(channelArn)) return { closed: [] };
  const closed = await endDuelTasks(channelArn, battleId);
  // A RUN WAITING ON A CLOSED TASK GOES ON, on its failure edge, as after a stop.
  for (const { taskId } of closed.slice(0, 20)) await nameWhatChanged(taskId, channelArn);
  console.log('[task-service][duel] closed the work an ended duel opened', { channelArn, battleId, closed: closed.length });
  return { closed };
}

async function discardStoppedTasks(input: {
  channelArn: string;
  taskIds: string[];
}): Promise<{ cancelled: number }> {
  const { channelArn, taskIds } = input;
  if (!channelArn || !taskIds?.length || await refusesChannel(channelArn)) return { cancelled: 0 };
  const cancelled = await cancelStoppedTasks(channelArn, taskIds);
  // A RUN WAITING ON A STOPPED TASK GOES ON, on its failure edge (ADR-063 decision 3).
  for (const id of taskIds.slice(0, 20)) await nameWhatChanged(id, channelArn);
  console.log('[task-service][stop] discarded the work a stop held', {
    channelArn, asked: taskIds.length, cancelled,
  });
  return { cancelled };
}

async function stoppableTasks(input: {
  channelArn: string;
  requesterPersonId: string;
  assistantId?: string;
}): Promise<Array<{ summary: ConversationTask; full: Task }>> {
  if (!input?.channelArn || await refusesChannel(input.channelArn)) return [];
  return selectStoppableTasks(input.channelArn, input.requesterPersonId, input.assistantId);
}

/** Hand a task back to the assistant when the person it awaited has replied. */
async function applyUserResponse(input: {
  taskId: string;
  channelArn: string;
  assistantId: string;
  messageId?: string;
  /**
   * THE MACHINES THIS TURN RESOLVED, and they are declared because they already travel.
   *
   * The router sends them (`machines: taskStateMachines()`) and the service spreads its input into
   * `applyUserResponseToTask`, so a pack-declared awaiting state hands back correctly today - by
   * accident of both sides passing an object through untouched. Neither type said so, so any
   * ordinary edit that names the fields it forwards would have dropped them, and the symptom is
   * silence: a deployment's own task type simply stops being handed back to the person it awaits.
   *
   * Absent, `applyUserResponseToTask` falls back to the platform defaults, which is the right
   * behavior for a caller that has none to offer.
   */
  // Typed from the callee, the way `advanceTask` above is: it arrives as JSON off the wire, and
  // the shape it must satisfy is the one the transition actually reads.
  machines?: Parameters<typeof applyUserResponseToTask>[0]['machines'];
}): Promise<{ applied: boolean; reason?: string; from?: string; to?: string }> {
  if (!input?.channelArn || await refusesChannel(input.channelArn)) {
    return { applied: false, reason: 'not_awaiting' };
  }
  return applyUserResponseToTask(input);
}

/**
 * Count a turn that advanced no state.
 *
 * A WRITE THE CALLER READS BACK, so it is invoked synchronously rather than fire-and-forget: the
 * returned count is what the stall signal is emitted from, and an acknowledgement would make every
 * turn look like the first.
 */
async function recordTaskDeliveryOp(input: {
  taskId: string; channelArn: string; delivery: never;
}): Promise<void> {
  if (!input?.taskId || !input?.channelArn || await refusesChannel(input.channelArn)) return;
  await recordTaskDelivery(input.taskId, input.channelArn, input.delivery);
}

/**
 * A REQUEST'S RUN, WHERE NO ROUTER TURN OPENED ITS TASK (WT115, WT106): the router started the request's intent workflow,
 * and its own task step takes this task. Refused where the conversation is not this classification's, and where the task
 * is not a request awaiting its run (`requestAwaitingRun`).
 */
/**
 * A REOPEN RUN TAKES THE REOPENED TASK (`takes: 'reopened'`): refused where the conversation is not this classification's, where
 * the task is not open again (a reopen leaves it in a state with a way on), and where it no longer names the run it was reopened
 * from.
 */
export async function takeReopenedTaskOp(input: { taskId: string; channelArn: string; fromRunKey: string; workflowRun: WorkflowRunRef; ttlSeconds?: number }): Promise<Task | null> {
  if (!input?.taskId || !input?.channelArn || !input?.fromRunKey || !input?.workflowRun?.runKey || await refusesChannel(input.channelArn)) return null;
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  if (!task?.workflowRun || task.workflowRun.runKey !== input.fromRunKey) return null;
  const machine = machinesOfTask(task, packTaskStateMachines())[task.taskType ?? ''];
  if (!machine?.states[task.taskState ?? '']?.transitions.length) return null;
  return takeReopenedTask(input.taskId, input.channelArn, input.fromRunKey, input.workflowRun,
    typeof input.ttlSeconds === 'number' && Number.isFinite(input.ttlSeconds) ? { ttlSeconds: input.ttlSeconds } : {});
}

export async function attachRequestRunOp(input: { taskId: string; channelArn: string; workflowRun: WorkflowRunRef; dueBy?: string; ttlSeconds?: number }): Promise<Task | null> {
  if (!input?.taskId || !input?.channelArn || !input?.workflowRun?.runKey || await refusesChannel(input.channelArn)) return null;
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  if (!task || !requestAwaitingRun(task)) return null;
  return attachRequestRun(input.taskId, input.channelArn, input.workflowRun, {
    ...(typeof input.dueBy === 'string' && Number.isFinite(Date.parse(input.dueBy)) ? { dueBy: input.dueBy } : {}),
    ...(typeof input.ttlSeconds === 'number' && Number.isFinite(input.ttlSeconds) ? { ttlSeconds: input.ttlSeconds } : {}),
  });
}

async function markTaskPrivateOp(input: { taskId: string; channelArn: string }): Promise<void> {
  if (!input?.taskId || !input?.channelArn || await refusesChannel(input.channelArn)) return;
  await markTaskPrivate(input.taskId, input.channelArn);
}

/**
 * Claim one entry's declared step action before it runs (SPEC-TASK-STATE-TRANSITIONS FR29).
 *
 * THE ROW IS RE-READ HERE, for the reason `advanceTask` re-reads it: the entry sequence the claim is
 * keyed on comes from the transition log, and the caller's copy predates the advance that just entered
 * the state.
 */
async function claimAction(input: { taskId: string; channelArn: string; state: string; toolRun?: string }): Promise<ActionClaim> {
  const key = `${input?.state ?? ''}#?`;
  if (!input?.taskId || !input?.channelArn || !input?.state || await refusesChannel(input.channelArn)) {
    return { claimed: false, key, reason: 'failed' };
  }
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  if (!task) return { claimed: false, key, reason: 'failed' };
  // A required tool's name is a registered tool's snake_case name or nothing (ADR-064 decision 3).
  const toolRun = typeof input.toolRun === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(input.toolRun) ? input.toolRun : undefined;
  return claimStateAction({ task, state: input.state, ...(toolRun ? { toolRun } : {}) });
}

async function noTransitionTurn(input: { task: Task }): Promise<number> {
  if (!input?.task?.channelArn || await refusesChannel(input.task.channelArn)) {
    return input?.task?.turnsInState ?? 0;
  }
  return recordNoTransitionTurn(input.task);
}

/**
 * The dispatch.
 *
 * AN UNKNOWN OP IS AN ERROR, not a default. A service that answers something for a request it does
 * not understand is how a typo becomes a silent read of the wrong thing.
 */
export const handler = async (event: TaskServiceRequest): Promise<unknown> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  // ── THE PACK IS HYDRATED HERE TOO, BECAUSE THE MACHINES MOVED HERE (code review, 2026-09-09) ───
  //
  // `task-tracking` reads the deployment's declared state machines in two places this service now
  // owns: the initial state `createTask` opens a task in, and the `awaits` boundary that decides
  // whether a completed step hands the work back to a person. Both were the ROUTER's code when they
  // were written, and the router hydrates the pack on every invoke - so both silently fell back to
  // the platform defaults the moment they started running in here.
  //
  // A pack-defined state then yielded no awaited party, no hand-back was recorded, and the task
  // stayed assistant-owned: the deployment's own taxonomy was accepted, stored, and ignored.
  //
  // Once per container, no-op when `ASSISTANT_INTENT_PACK_PARAM` is unset, and a fetch failure
  // leaves the defaults intact rather than failing the call - the same contract the router relies on.
  await hydrateIntentPackFromSsm();
  const { op, input } = event ?? ({} as TaskServiceRequest);
  switch (op) {
    case 'tasksForTurn':
      return tasksForTurn(input as never);
    case 'getTask':
      return readTask(input as never);
    case 'createTask':
      return openTask(input as never);
    case 'updateTaskStatus':
      return setTaskStatus(input as never);
    case 'cancelStoppedTasks':
      return discardStoppedTasks(input as never);
    case 'endDuelTasks':
      return closeDuelTasks(input as never);
    case 'advanceTaskState':
      return advanceTask(input as never);
    case 'adminListTasks':
      return adminListTasks(input as never);
    case 'adminListTasksOwnedBy':
      return adminListTasksOwnedBy(input as never);
    case 'reassignTaskOwner':
      return reassignOwner(input as never);
    // ONE NAME, WHICH MEANS WHAT IT SAYS. The pre-D8 op named the ASSIGNEE read "owner" and is gone
    // rather than kept as an alias: an alias is the confusion preserved, and this op is called by one
    // function whose deploy order we control (task-service before admin-tasks).
    case 'adminListAssigneeTasks':
      return adminListAssigneeTasks(input as never);
    case 'adminCancelTask':
      return adminCancelTask(input as never);
    // ── THE ROUTER'S READS (ADR-033) ───────────────────────────────────────────────────────────
    //
    // These finish a migration that had been declared over while half of it was outstanding. The
    // PROCESSOR was moved onto `tasksForTurn`; the ROUTER never was, and kept reading the tables
    // directly - while the grants were removed from both roles as though neither did. Unit tests
    // mock DynamoDB and the boundary test only forbids importing the FRONTED four, so nothing
    // failed until a deployed router asked a real table and was denied.
    //
    // They are separate ops rather than folded into `tasksForTurn` because the router asks
    // different questions at different moments in a turn, and a composite that answered all of them
    // would read more than any one caller needs on a path inside a person's wait.
    case 'ownerChannelTasks':
      return ownerChannelTasks(input as never);
    case 'referentCandidates':
      return referentCandidates(input as never);
    case 'answerableTaskByRef':
      return answerableTaskByRef(input as never);
    case 'answerableTaskById':
      return answerableTaskById(input as never);
    case 'activeTaskByType':
      return activeTaskByType(input as never);
    case 'stoppableTasks':
      return stoppableTasks(input as never);
    case 'applyUserResponse':
      return applyUserResponse(input as never);
    case 'recordTaskDelivery':
      return recordTaskDeliveryOp(input as never) as never;
    case 'markTaskPrivate':
      return markTaskPrivateOp(input as never) as never;
    case 'noTransitionTurn':
      return noTransitionTurn(input as never);
    case 'claimStateAction':
      return claimAction(input as never);
    case 'claimEventRun':
      return claimEventRunOp(input as never);
    case 'claimEventStep':
      return claimEventStepOp(input as never);
    case 'recordEventGreeting':
      return recordEventGreetingOp(input as never);
    case 'wasGreetedByEventRun':
      return wasGreetedByEventRunOp(input as never);
    case 'openWorkflowTask':
      return openWorkflowTask(input as never);
    case 'advanceAsAssignee':
      return advanceAsAssignee(input as never);
    case 'taskDocuments':
      return taskDocuments(input as never);
    case 'addTaskDocument':
      return addTaskDocument(input as never);
    case 'requestRevision':
      return requestRevision(input as never);
    case 'addRevisedDocument':
      return addRevisedDocument(input as never);
    case 'abandonRevision':
      return abandonRevision(input as never);
    case 'cancelForDeadline':
      return cancelForDeadline(input as never);
    case 'settleArchivedTasks':
      return settleArchivedTasks(input as never);
    case 'endRunTasks':
      return endRunTasks(input as never);
    case 'readEventSteps':
      return readEventStepsOp(input as never);
    case 'openTasksOpenedFrom':
      return openTasksOpenedFrom(input as never);
    case 'recordRunEnded':
      return recordRunEnded(input as never);
    case 'adminCancelRun':
      return adminCancelRun(input as never);
    case 'attachRequestRun':
      return attachRequestRunOp(input as never) as never;
    case 'takeReopenedTask':
      return takeReopenedTaskOp(input as never) as never;
    case 'requesterMovableTask':
      return requesterMovableTask(input as never) as never;
    case 'holdRunWait':
      return holdRunWaitOp(input as never);
    case 'readRunWait':
      return readRunWaitOp(input as never);
    case 'readyTasks':
      return readyTasks(input as never);
    case 'claimPickup':
      return claimPickup(input as never);
    default:
      throw new Error(`[task-service] unknown op: ${String(op)}`);
  }
};
