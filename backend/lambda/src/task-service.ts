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
} from './lib/task-tracking.js';
import { isPrivateVisibility } from './lib/task-visibility.js';
import type { DeliveryOption } from './lib/delivery-options.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { ChimeSDKMessagingClient, ListTagsForResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { readChannelTags } from './lib/channel-classification.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { taskStateMachines as packTaskStateMachines } from './lib/intent-pack.js';
import { PLATFORM_TASK_MACHINE_KEYS, type TaskStateMachine } from './lib/task-state-machines.js';
import { liveAssistantsForClassification } from './lib/default-agents.js';
import { nameTaskThroughRouter } from './lib/say-through-router.js';
import {
  TASK_DEADLINE_ENDING, assigneeAdvanceRefusal, orderForPickup, pickupReadiness, settlementOutcome,
  type AssigneeAdvanceRefusal,
} from './lib/workflow-task.js';
import { DeliveryOption as TaskDelivery } from './lib/delivery-options.js';
import type { TaskAssignee, WorkflowRunRef } from './lib/task-tracking.js';
import { claimEventRun as storeClaimEventRun, claimEventStep as storeClaimEventStep, recordEventGreeting as storeRecordEventGreeting, wasGreetedByEventRun as storeWasGreeted, type EventRunClaim } from './lib/event-run-store.js';

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
  /** A workflow's task step opens its task (ADR-063 decision 1). See `openWorkflowTask`. */
  | 'openWorkflowTask'
  /** A person takes a choice on their task's card (ADR-063 decision 2). See `advanceAsAssignee`. */
  | 'advanceAsAssignee'
  /** A task step's deadline ends its task (ADR-063 decision 4). See `cancelForDeadline`. */
  | 'cancelForDeadline'
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
 * again; only the first turn per conversation per container pays. A negative result is NOT cached: an
 * untagged conversation may be tagged moments later, and caching the refusal would outlive the fix.
 */
const tagCache = new Map<string, string>();

/**
 * The conversation's classification, or the fact that it could not be read.
 *
 * SEPARATED, because they are not the same claim. An absent tag is a statement about the
 * conversation; a failed API call is a statement about Chime. Both collapsed to the empty string,
 * so a throttle was indistinguishable from an untagged channel and was treated as one.
 */
type ChannelTag = { tag: string } | { unreadable: true };

async function classificationOf(channelArn: string): Promise<ChannelTag> {
  const cached = tagCache.get(channelArn);
  if (cached) return { tag: cached };
  try {
    const tag = (await readChannelTags(chimeClient, channelArn)).classification || '';
    if (profiles.isKnownClassification(tag)) tagCache.set(channelArn, tag);
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
 * WHICH LEG IS ASKING, because an unreadable tag means different things on the two (ADR-045).
 *
 * `here`      the conversation the caller named and IAM already authorized them for. The tag read is
 *             a second opinion on a call that has already passed the enforced boundary.
 * `elsewhere` a row belonging to some OTHER conversation, reached by scanning. Nothing upstream
 *             authorized this conversation, so this per-row check is the ONLY gate, and an
 *             unreadable tag there converts "unknown" into "permitted".
 */
type AdmissionLeg = 'here' | 'elsewhere';

async function refusesChannel(channelArn: string, leg: AdmissionLeg = 'here'): Promise<boolean> {
  if (!SERVICE_CLASSIFICATION) {
    console.error('[task-service] SERVICE_CLASSIFICATION unset; refusing every conversation');
    return true;
  }
  const found = await classificationOf(channelArn);

  // WHAT THIS CHECK IS, STATED WITHOUT OVERCLAIMING (maintainer, 2026-08-31).
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
  // AN UNREADABLE TAG NO LONGER REFUSES, and the trade is stated rather than implied. A failed tag
  // read is not evidence of a violation; it is evidence that this check cannot run. Refusing on it
  // let a Chime throttle impersonate a policy decision and silently drop legitimate work - a task
  // status write that nothing retries, leaving the row in_progress in somebody's list for its full
  // 24h TTL.
  //
  // The cost of proceeding is real and bounded: a misrouted call arriving DURING a tag-read outage
  // is served. That is a compound failure of two independent things. The cost of refusing was
  // certain and routine: every cold-container task operation broken by any throttle, silently. The
  // tag is cached per container once read, so only the first read for a conversation is exposed.
  // THE REASONING ABOVE HOLDS FOR THE `here` LEG ONLY, AND ADR-045 SPLITS THEM. "IAM has already
  // authorised this call" is the whole argument for proceeding, and it is simply untrue of a row
  // reached by scanning: nobody authorized THAT conversation, so this check is not a second opinion
  // there, it is the only one. Proceeding on an unreadable tag put a premium task hint into a basic
  // prompt, which is the leak commit c7cd138 closed by another route.
  //
  // This reverses ADR-042 decision 3a for the cross-conversation legs, and the cost that decision
  // was protecting is real: a fire-and-forget status write on one of those legs is now DROPPED on a
  // tag-read throttle rather than admitted. Rare, logged, and the alternative was serving content
  // from a conversation whose classification nobody could establish.
  if ('unreadable' in found) {
    if (leg === 'elsewhere') {
      console.error('[task-service][SecurityEvent] the classification tag could not be read on a '
        + 'cross-conversation row; REFUSING, because nothing upstream authorised this conversation', {
        channelArn, serving: SERVICE_CLASSIFICATION,
      });
      return true;
    }
    console.error('[task-service][SecurityEvent] the classification tag could not be read; PROCEEDING, '
      + 'because IAM has already authorised this call and this check cannot run without the tag', {
      channelArn, serving: SERVICE_CLASSIFICATION,
    });
    return false;
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
}): Promise<Task | null> {
  const { taskId, channelArn } = input;
  if (!taskId || !channelArn) return null;
  if (await refusesChannel(channelArn)) return null;
  return getTask(taskId, channelArn).catch(() => null);
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
  return createTask(event, deliveryOption, taskType, correlationId, opts);
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
}): Promise<AdvanceResult> {
  const { taskId, channelArn, ...rest } = input;
  if (!taskId || !channelArn) return { ok: false, error: 'no_active_task' };
  if (await refusesChannel(channelArn)) return { ok: false, error: 'no_active_task' };

  const task = await getTask(taskId, channelArn).catch(() => null);
  if (!task) return { ok: false, error: 'no_active_task' };
  const result = await advanceTaskStateTo({ task, ...rest });
  if (result.ok) await nameWhatChanged(task.taskId, channelArn, rest.machines);
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
    const all = { ...packTaskStateMachines(), ...(machines ?? {}) };
    if (task.workflowRun && settlementOutcome(task, all)) {
      await nameTaskThroughRouter(SERVICE_CLASSIFICATION, { kind: 'settled', channelArn, taskId });
      return;
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
  requesterArn?: string;
  worker: TaskAssignee;
  assistantId: string;
  visibility?: 'conversation' | 'private';
  priority?: 'high' | 'normal' | 'low';
  workflowRun: WorkflowRunRef;
}): Promise<Task | null> {
  const { channelArn, taskId, machine } = input ?? ({} as typeof input);
  if (!channelArn || !taskId || !machine || !input.workflowRun?.runKey || await refusesChannel(channelArn)) return null;
  if ((PLATFORM_TASK_MACHINE_KEYS as readonly string[]).includes(machine)) {
    console.warn('[task-service][workflow-task] a step may not open one of the queue\'s own machines', { machine });
    return null;
  }
  const machines = { ...packTaskStateMachines(), ...(input.machineDef ? { [machine]: input.machineDef } : {}) };
  if (!machines[machine]) return null;
  // ONLY THIS CLASSIFICATION'S ASSISTANTS DO OR OWN ITS WORK. The router chose them from its own live list; this is the
  // second layer, against the same assignment records, before anything is written.
  for (const id of new Set([input.assistantId, ...(input.worker?.type === 'assistant' ? [input.worker.id] : [])])) {
    if (!(await isOwnAssistant(id))) {
      console.error('[task-service][SecurityEvent] a workflow task names an assistant that is not this classification\'s; refusing', { channelArn, serving: SERVICE_CLASSIFICATION });
      return null;
    }
  }
  if (input.worker?.type !== 'user' && input.worker?.type !== 'assistant') return null;
  const existing = await getTask(taskId, channelArn).catch(() => null);
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  // THE ROW OUTLIVES ITS DEADLINE by a day, so the deadline's firing and the settlement always find it.
  const ttlSeconds = Math.max(60, (input.workflowRun.deadlineAt ?? now) - now) + 24 * 3600;
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
      ttlSeconds,
      requestExcerpt: '',
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
}): Promise<{ ok: true; to: string } | { ok: false; error: AssigneeAdvanceRefusal | 'REFUSED' }> {
  if (!input?.taskId || !input?.channelArn || await refusesChannel(input.channelArn)) return { ok: false, error: 'NOT_FOUND' };
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  const machines = packTaskStateMachines();
  const refusal = assigneeAdvanceRefusal(task, machines, input);
  if (refusal || !task) return { ok: false, error: refusal ?? 'NOT_FOUND' };
  // THE PERSON'S CHOICE, RELAYED THROUGH THE ONE ADVANCE (`advanceTask`): the state it leaves awaits that person, and the
  // edge is one the state declares as a choice, so the move is theirs and the runtime decides nothing.
  const result = await advanceTask({
    taskId: task.taskId, channelArn: task.channelArn, toState: input.choice, by: 'system', reason: 'chosen by its assignee on the task card', machines,
    ...(task.assistantId ? { assistantId: task.assistantId } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error === 'state_changed' ? 'STATE_MOVED' : 'REFUSED' };
  // The advance named the settlement already: an ending is read from the terminal state, whatever the lifecycle says.
  if (result.terminal) await updateTaskStatus(task.taskId, task.channelArn, result.terminal === 'success' ? 'completed' : 'failed');
  return { ok: true, to: result.to };
}

/**
 * A TASK STEP'S DEADLINE ENDS ITS TASK (ADR-063 decision 4): the router checked the firing, and this cancels a task that is
 * still open and still names a run, recording the ending as the deadline's, then names the settlement. A task already
 * settled is left as it is.
 */
async function cancelForDeadline(input: { taskId: string; channelArn: string }): Promise<{ cancelled: boolean }> {
  if (!input?.taskId || !input?.channelArn || await refusesChannel(input.channelArn)) return { cancelled: false };
  const task = await getTask(input.taskId, input.channelArn).catch(() => null);
  if (!task?.workflowRun || settlementOutcome(task, packTaskStateMachines())) return { cancelled: false };
  await updateTaskStatus(task.taskId, task.channelArn, 'cancelled', undefined, TASK_DEADLINE_ENDING);
  await nameWhatChanged(task.taskId, task.channelArn);
  return { cancelled: true };
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
  return orderForPickup(rows.filter((t): t is Task => !!t && pickupReadiness(t, machines, input.assistantId).ready));
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
    case 'cancelForDeadline':
      return cancelForDeadline(input as never);
    case 'readyTasks':
      return readyTasks(input as never);
    case 'claimPickup':
      return claimPickup(input as never);
    default:
      throw new Error(`[task-service] unknown op: ${String(op)}`);
  }
};
