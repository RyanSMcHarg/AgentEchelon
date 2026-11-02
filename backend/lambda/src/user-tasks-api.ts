/**
 * User work-item API — "what do I still owe?"
 *
 *   GET /tasks/mine   -> the active tasks THIS user owns, across every conversation
 *
 * WHY THIS EXISTS. A person accumulates open items from several assistants and several workflows at
 * once: a duel side that asked them something, a report chain waiting on scope, an extraction waiting
 * on a column mapping. Each is the same thing to them - something is blocked on me and I need to close
 * it out - and until now none of it was visible anywhere. `getActiveTasksForUser` already answered the
 * question server-side, but only to build a hint in the assistant's system prompt; the person it is
 * about had no way to see it.
 *
 * WHY AN ENDPOINT RATHER THAN DERIVING IT FROM MESSAGES. The requirement is explicitly
 * cross-conversation, and a client can only derive state from conversations it has loaded. Anything
 * message-derived is blind to the conversation the user is not looking at, which is precisely the item
 * they are most likely to have forgotten.
 *
 * AUTHORIZATION. Cognito-authenticated, and the owner is the caller's person id (`callerPersonId`, their
 * AppInstanceUser id), never the query string. There is no parameter by which one user can ask for another user's queue: the only
 * partition this reads is the caller's own. That is the whole access-control story for this endpoint,
 * which is why it can be a plain read with no membership check - a task the caller owns is a task the
 * caller is entitled to see, by definition of ownership (ADR-024).
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  ChimeSDKMessagingClient,
  DescribeChannelCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { principalIdFromArn, type UserTask } from './lib/task-tracking.js';
import { getActiveTasksForUser } from './lib/task-store.js';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { invokeTaskServiceOp } from './lib/task-service-op.js';
import { isTaskVisibility, readTaskVisibility } from './lib/task-visibility.js';
import { awaitedPartyOf, type TaskStateMachine } from './lib/task-state-machines.js';
import { taskStateMachines, parseIntentPack, DEFAULT_INTENT_PACK, resolvePackParameterValue } from './lib/intent-pack.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { userArnFor } from './lib/person-arn.js';
import { callerPersonId } from './lib/auth.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { readChannelTags } from './lib/channel-classification.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const chime = chimeMessagingClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });

type Machines = Record<string, TaskStateMachine>;

/** The platform machines, for a row no classification's assistant claims. */
const DEFAULT_MACHINES: Machines = taskStateMachines(DEFAULT_INTENT_PACK);

let machinesByAssistantCache: Map<string, Machines> | null = null;

/**
 * EACH ASSISTANT'S DECLARED MACHINES, keyed by its principal id (code review, 2026-09-11).
 *
 * `needsOf` read `taskStateMachines()` in a function that hydrates no intent pack, so every
 * deployment-defined machine fell back to the platform defaults here: a pack-declared state had no
 * `awaits` and no `requires`, and the item a person was blocked on said nothing about what it needed.
 *
 * NOT `hydrateIntentPackFromSsm`, which is the right call in a per-classification function and the
 * wrong one here. This endpoint lists one person's items across EVERY conversation, and each
 * classification declares its own pack, so a single hydrated pack would answer for all of them with
 * one classification's machines. Each row is read against the machines of the assistant whose work it
 * is (`assistantId`), which is the same pack that assistant's runtime advances the task on.
 *
 * Cached for the container's life ONLY when every read answered. A throttled read cached as "no pack"
 * would pin the defaults for that container's life on a correctly configured deployment, which is the
 * staleness this codebase has already recorded once for the admin alert target.
 */
export async function machinesByAssistant(): Promise<Map<string, Machines>> {
  if (machinesByAssistantCache) return machinesByAssistantCache;
  const map = new Map<string, Machines>();
  let complete = true;
  const read = async (name: string): Promise<string | undefined> => {
    try {
      return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value?.trim() || undefined;
    } catch (err) {
      // Not found is an answer: no assistant published there, or no pack declared, so the defaults.
      if ((err as { name?: string })?.name !== 'ParameterNotFound') {
        complete = false;
        console.warn('[user-tasks-api] could not read', { name, error: (err as { name?: string })?.name });
      }
      return undefined;
    }
  };
  for (const classification of profiles.classificationValues()) {
    const botArn = await read(`${SSM_ROOT}/assistant/${classification}/bot-arn`);
    if (!botArn) continue;
    let raw: string | undefined;
    try {
      // A pointer is followed into that classification's own pack prefix (`classification-packs/`).
      raw = await resolvePackParameterValue(await read(`${SSM_ROOT}/assistant/${classification}/assistant-intent-pack`), classification);
    } catch (err) {
      // Unread is not "no pack": the defaults are served this once and the map is not cached.
      complete = false;
      console.warn('[user-tasks-api] could not read the intent-pack body', { classification, error: (err as Error)?.message });
    }
    map.set(principalIdFromArn(botArn), taskStateMachines(parseIntentPack(raw)));
  }
  if (complete) machinesByAssistantCache = map;
  return map;
}

/** Test seam. */
export function _resetMachinesCache(): void {
  machinesByAssistantCache = null;
}

/** Bounded so a user with a long tail of open work cannot make this an expensive read. */
const MAX_ITEMS = 25;

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,OPTIONS' });

const respond = http.respond;

/**
 * What the client renders. A deliberate subset of the mirror row: enough to name the item, say which
 * conversation it belongs to and take the user there, and no task internals.
 *
 * `details` is passed through because it carries the human-readable summary the assistant wrote, which
 * is what makes an item recognisable a day later. It is bounded by the task writer, not here.
 */
export interface OpenWorkItem {
  taskId: string;
  /** The reference a person types to answer this item, `#<taskRef>` (ADR-035). Absent on older rows. */
  taskRef?: number;
  taskType: string;
  channelArn: string;
  status: string;
  taskState?: string;
  title?: string;
  updatedAt?: string;
  dueBy?: string;
  /**
   * The assistant whose work this is, as a principal id (`Task.assistantId`), so the composer can
   * ADDRESS an answer to it (ADR-032).
   *
   * A PRINCIPAL ID AND NOT AN ARN, deliberately. The client resolves it against the members it can
   * already see in the conversation, so an item naming an assistant that is not a member addresses
   * nothing rather than producing an ARN for a bot the client cannot see - and the server never has
   * to state an ARN a client would then have to trust.
   *
   * Absent on a chain written before the ownership split, and on any task no assistant owns. The
   * composer sends normally in that case, which is exactly what it did before this field existed.
   */
  assistantId?: string;
  /**
   * WHO THIS ITEM IS FOR, so the composer can address an answer without narrowing who may read it.
   *
   * The client needs this to route: an answer about a CONVERSATION item belongs in the conversation,
   * addressed openly, because the people waiting on that work are entitled to see it change. An
   * answer about a PRIVATE item stays targeted, because it is nobody else's.
   *
   * Distinct from the `private` flag on the conversation read, which means "this row was REDACTED
   * for you". That flag is absent for the item's own requester, so it cannot answer this question:
   * to its owner a private item and a shared one looked identical, and a composer using it would
   * have published exactly the answers that must not be.
   *
   * Only ever sent to a caller who already owns the item, so it discloses nothing: this endpoint
   * returns a person their own work.
   */
  visibility?: 'conversation' | 'private';
  /**
   * WHAT THIS STEP STILL NEEDS FROM THE PERSON, in their own reading order.
   *
   * A queue row says which work is outstanding; it did not say what finishing it involves. The
   * machine already declares that - `report_generation.collecting_requirements` lists "what data to
   * pull", "where it comes from", "the output format" - and it reached the prompt and nothing else,
   * so the one party actually being waited on could not see it.
   *
   * Sent only for the state the task is IN, and only when that state awaits somebody. A list of
   * requirements for a step nobody is blocked on is not a request, and rendering it as one would ask
   * a person for something the assistant is busy doing itself.
   *
   * Absent means the step declares none, which is the right default for a confirmation or a single
   * choice: there, the step IS the answer.
   */
  needs?: string[];
}

/**
 * The item's human-facing title. Prefers what the assistant recorded, then THE PERSON'S OWN WORDS,
 * and falls back to the task type only when there is nothing better. Never empty - an unnamed row in
 * a to-do queue is worse than a generically named one, because the user cannot tell what they are
 * being asked to finish.
 *
 * ── THE PERSON'S OWN WORDS ARE THE FALLBACK, NOT THE TYPE (maintainer, 2026-09-03) ────────────────────
 *
 * `details` is where an assistant may record a title, and `createTask` initializes it EMPTY. Nothing
 * on the queued-request or report paths writes one, so every row fell through to the type and a
 * person looking at their own work saw a column of identical lines - "Queued request" fifty times,
 * none of them saying which request. That is a queue you cannot act on: the point of the list is
 * choosing what to finish, and every row read the same.
 *
 * `requestExcerpt` is what they actually asked, it is already stored on the task, and it is already
 * truncated at creation for exactly this kind of use (ADR-024 D5). Measured on the deployment: rows
 * whose `details` was `{}` carried excerpts like "Q3 headcount lookup" and "Identify three tools the
 * onboarding process touches" - the difference between a list and a wall.
 *
 * The type stays as the last resort, because a row must still be nameable when a task carries neither.
 */
export function titleOf(task: UserTask): string {
  const details = (task.details ?? {}) as Record<string, unknown>;
  for (const key of ['title', 'summary', 'description']) {
    const value = details[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  if (typeof task.requestExcerpt === 'string' && task.requestExcerpt.trim()) {
    return task.requestExcerpt.trim().slice(0, 200);
  }
  const type = (task.taskType || 'general').replace(/_/g, ' ');
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * What the task's CURRENT state still needs from the person, or undefined.
 *
 * Read from the same declared machines the runtime advances on, so a deployment that ships its own
 * machine gets its own wording with no second place to update. Gated on `awaits`, because a
 * requirements list for a step the ASSISTANT owes is not something to ask anybody for.
 */
export function needsOf(task: UserTask, machines: Machines = DEFAULT_MACHINES): string[] | undefined {
  if (!task.taskType || !task.taskState) return undefined;
  const state = machines[task.taskType]?.states?.[task.taskState];
  if (!state || !awaitedPartyOf(state)) return undefined;
  const needs = state.requires?.filter((r) => typeof r === 'string' && r.trim());
  return needs && needs.length ? needs : undefined;
}

export function toOpenWorkItem(task: UserTask, machines: Machines = DEFAULT_MACHINES): OpenWorkItem {
  const needs = needsOf(task, machines);
  return {
    taskId: task.taskId,
    ...(task.taskRef ? { taskRef: task.taskRef } : {}),
    taskType: task.taskType || 'general',
    channelArn: task.channelArn,
    status: task.status,
    ...(task.taskState ? { taskState: task.taskState } : {}),
    title: titleOf(task),
    ...(needs ? { needs } : {}),
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    ...(task.dueBy ? { dueBy: task.dueBy } : {}),
    ...(task.assistantId ? { assistantId: task.assistantId } : {}),
    // ALWAYS SENT, AS READ: the server applies the one visibility rule (absent reads as private), so
    // the client never has to decide what a missing value means.
    visibility: readTaskVisibility(task.visibility),
  };
}


/**
 * ── POST /tasks: A PERSON OPENS A WORK ITEM ─────────────────────────────────────────────────────
 *
 * WHY A ROUTE AND NOT A NEW SUBSYSTEM. `createTask` is already a task-service operation and no route
 * called it, so work could be listed, reassigned and cancelled from outside a turn and opened only
 * from inside one. A person could ask an assistant to track something and could not simply record it.
 *
 * WHY IT LIVES IN THIS FUNCTION. Tenet D8: this handler already owns the `/tasks` resource and already
 * takes its caller from the validated token. A second Lambda for the write half would be a second
 * place to keep both of those right.
 *
 * THE SERVICE REMAINS THE ENFORCEMENT LAYER. Task access carries two layers because one of them used
 * to be a `channelArn` a caller supplied in a query (tenet D3). This route adds no authority of its
 * own: it supplies identity from the token and the conversation through the request attributes the
 * service already keys the row on, and the service re-derives the rest - including its own refusal of
 * a conversation it may not serve, which is what stops a row landing where it does not belong.
 *
 * ONE TAG READ ANSWERS BOTH GATE QUESTIONS. `ListTagsForResource` returns the conversation's
 * `classification` and its `archived` state together, and both are the AUTHORITATIVE values: the
 * `archived` copy mirrored into channel Metadata is explicitly non-authoritative, and a live refusal
 * may not rest on an archived copy.
 *
 * THE TASK SERVICE IS PER CLASSIFICATION, SO A WRITE TARGETS EXACTLY ONE. The operator console holds
 * all three ARNs and asks each in turn, because "what is stuck in this conversation" is not answerable
 * from inside one classification. A WRITE is the opposite: fanning out would put the row in the wrong
 * service or in three of them, so this resolves the conversation's classification first and invokes
 * that service alone.
 *
 * THE ARN IS READ AT RUNTIME, AND THAT IS NOT A STYLE CHOICE. The classification stacks publish it to
 * SSM and they deploy AFTER this stack, which owns this function - so a deploy-time
 * `valueForStringParameter` here would fail a first install outright, which
 * `agent-classification-common.ts` already records the cost of on a different key. Reaching back from
 * the classification stack to add the ARN as an env var is not available either: this function's
 * construct lives in the foundations tree and that stack already depends on it, so the reference
 * would be a cycle. Read by name, cached per container, and absent means refused.
 *
 * WHAT THE ROUTE CHECKS ITSELF, because the service cannot:
 *
 *   1. MEMBERSHIP, AS THE CALLER. `DescribeChannel` with `ChimeBearer` set to the caller's own
 *      AppInstanceUser ARN - the pattern `turn-state-api` uses. Amazon Chime SDK authorizes against
 *      the bearer as well as this function's role, so a channel the caller is not on cannot be
 *      described and a token alone is not enough to put work in a room. This bounds the classification
 *      transitively: Layer 1 denies joining a channel above the caller's reach, so a member of a
 *      channel is by construction someone who reaches its classification.
 *   2. NOT ARCHIVED. Archive is terminal (ADR-017): the channel is read-only and every moderator is
 *      stripped, so an item opened there could never be worked.
 *   3. A DECLARED `taskType`. A task whose state machine does not exist can never advance, so an
 *      unknown type is refused with the declared set named rather than stored to rot.
 *
 * WHAT A CALLER MAY NOT SUPPLY. `owner` comes from the token: an owner on the body is a caller
 * assigning their work to someone else, or taking someone else's. `taskRef` and `taskId` are the
 * server's, because a caller-chosen reference would collide with the items the room already counts.
 * ASSIGNEE IS NOT ACCEPTED AT ALL, because `TaskCreateOptions` has no field for one - passing it would
 * be a field silently dropped, which is the defect class this codebase keeps paying for. Reassignment
 * has its own authorized path.
 *
 * VISIBILITY HAS NO DEFAULT HERE, DELIBERATELY. `readTaskVisibility` rules that an absent or
 * unrecognized value reads as `private`, which is the fail-closed direction for an item a person may
 * have filled with their own words. Inventing `conversation` would quietly publish it to the room. A
 * private item is still room-visible as EXISTENCE through `taskRef`, which is what lets a shared
 * conversation refer to item `#3`.
 */

interface ChannelGate {
  classification: string;
  archived: boolean;
  expirationDays?: number;
}

const serviceArnCache = new Map<string, string>();

/** Test hook: clear the warm cache so a case can exercise both the published and absent paths. */
export function __clearTaskServiceArnCache(): void {
  serviceArnCache.clear();
}

/**
 * The classification's task service, by name.
 *
 * CACHED PER CONTAINER FOR A SUCCESS AND FOR A TERMINAL ABSENCE, AND NOT FOR A TRANSIENT FAILURE.
 * `ParameterNotFound` and `AccessDenied` are deployment facts that cannot change under a warm
 * container, so caching them is right and costs one read. A throttle or a timeout is neither, and
 * caching one would refuse every work item this container went on to see - silently, because only the
 * first failure logs. The same distinction is written down on `service-admin-bearer`, which paid for
 * getting it wrong in the other direction.
 */
async function taskServiceArnFor(classification: string): Promise<string> {
  const hit = serviceArnCache.get(classification);
  if (hit !== undefined) return hit;
  try {
    const res = await ssm.send(new GetParameterCommand({
      Name: `${SSM_ROOT}/assistant/${classification}/task-service-arn`,
    }));
    const arn = res.Parameter?.Value || '';
    serviceArnCache.set(classification, arn);
    return arn;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    const terminal = name === 'ParameterNotFound'
      || name === 'AccessDeniedException'
      || name === 'ValidationException';
    console.warn('[user-tasks-api] could not resolve a task service for this classification', {
      classification, name, terminal, message: (err as Error)?.message,
    });
    if (terminal) serviceArnCache.set(classification, '');
    return '';
  }
}

async function openWorkItem(event: APIGatewayProxyEvent, origin?: string): Promise<APIGatewayProxyResult> {
  const personId = await callerPersonId(event);
  if (!personId) return respond(401, { error: 'Unauthorized: this sign-in names no person' }, origin);
  if (!APP_INSTANCE_ARN) {
    return respond(500, { error: 'APP_INSTANCE_ARN is not configured', code: 'SERVER_MISCONFIG' }, origin);
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') {
    return respond(400, { error: 'a JSON body is required', code: 'MALFORMED_BODY' }, origin);
  }

  const { channelArn, taskType, requestExcerpt, visibility, priority, dueBy, details } = body;

  if (typeof channelArn !== 'string' || !channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) {
    return respond(400, {
      error: 'channelArn is required and must name a conversation in this deployment',
      code: 'INVALID_CHANNEL',
    }, origin);
  }
  if (typeof taskType !== 'string' || !taskType) {
    return respond(400, { error: 'taskType is required', code: 'MISSING_TASK_TYPE' }, origin);
  }
  if (!DEFAULT_MACHINES[taskType]) {
    return respond(400, {
      error: `taskType '${taskType}' is not declared by this deployment`,
      code: 'UNKNOWN_TASK_TYPE',
      declared: Object.keys(DEFAULT_MACHINES).sort(),
    }, origin);
  }

  const callerArn = userArnFor(APP_INSTANCE_ARN, personId);

  // 1. MEMBERSHIP, as the caller. The same call yields the expiration the TTL limit comes from.
  let expirationDays: number | undefined;
  try {
    const described = await chime.send(new DescribeChannelCommand({
      ChannelArn: channelArn, ChimeBearer: callerArn,
    }));
    expirationDays = described.Channel?.ExpirationSettings?.ExpirationDays;
  } catch {
    return respond(403, { error: 'Not a member of this conversation', code: 'NOT_A_MEMBER' }, origin);
  }

  // 2 and 3. The authoritative tags. A failure to READ them is a refusal rather than a pass: an item
  //    opened in an archived or unserved conversation can never be worked, so "could not tell" must
  //    not mean "go ahead".
  let gate: ChannelGate;
  try {
    const tags = await readChannelTags(chime, channelArn);
    gate = {
      classification: tags.classification || '',
      archived: String(tags.archived) === 'true',
      expirationDays,
    };
  } catch (err) {
    console.error('[user-tasks-api] could not read the conversation tags; refusing rather than guessing', {
      channelArn, message: (err as Error)?.message,
    });
    return respond(503, {
      error: 'Could not confirm this conversation is open for new work',
      code: 'CHANNEL_STATE_UNREADABLE',
    }, origin);
  }

  if (gate.archived) {
    return respond(409, {
      error: 'This conversation is archived and is read-only',
      code: 'CONVERSATION_ARCHIVED',
    }, origin);
  }
  if (!gate.classification) {
    // An untagged conversation is refused by the task service anyway, so an item opened here would be
    // invisible to every turn that followed. Fail closed and loudly.
    return respond(409, {
      error: 'This conversation carries no classification and cannot hold work items',
      code: 'CONVERSATION_UNCLASSIFIED',
    }, origin);
  }

  const serviceArn = await taskServiceArnFor(gate.classification);
  if (!serviceArn) {
    return respond(503, {
      error: 'No task service is published for this conversation',
      code: 'TASK_SERVICE_UNAVAILABLE',
    }, origin);
  }

  const excerpt = typeof requestExcerpt === 'string' ? requestExcerpt.slice(0, 600) : '';
  // A CHILD MAY NOT OUTLIVE ITS PARENT. `ExpirationDays` is a window rather than an instant, and on
  // `LAST_MESSAGE_TIMESTAMP` it restarts with every message, so "days from now" is the honest limit
  // under either criterion. No expiration means the conversation does not expire, and the task keeps
  // the service's own default.
  const ttlSeconds = expirationDays && expirationDays > 0 ? expirationDays * 24 * 60 * 60 : undefined;

  try {
    const created = await invokeTaskService(serviceArn, 'createTask', {
      // The service keys the row on the channel it reads HERE, deliberately, rather than on a second
      // field that could disagree with it.
      event: {
        inputTranscript: excerpt,
        requestAttributes: {
          'CHIME.channel.arn': channelArn,
          'CHIME.sender.arn': callerArn,
        },
      },
      deliveryOption: 'TASK_MULTI_STEP',
      taskType,
      opts: {
        owner: { id: principalIdFromArn(callerArn), type: 'user' },
        ...(excerpt ? { requestExcerpt: excerpt } : {}),
        ...(isTaskVisibility(visibility) ? { visibility } : {}),
        ...(priority === 'high' || priority === 'normal' || priority === 'low' ? { priority } : {}),
        ...(typeof dueBy === 'string' ? { dueBy } : {}),
        ...(details && typeof details === 'object' ? { details } : {}),
        ...(ttlSeconds ? { ttlSeconds } : {}),
      },
    });
    if (!created?.taskId) {
      // Null is the service's own boundary saying no, which is distinct from a transport failure.
      return respond(403, {
        error: 'This conversation cannot hold work items',
        code: 'CONVERSATION_NOT_SERVED',
      }, origin);
    }
    return respond(201, {
      task: {
        taskId: created.taskId,
        channelArn,
        taskType,
        ...(created.taskRef !== undefined ? { taskRef: created.taskRef } : {}),
        status: created.status,
        visibility: readTaskVisibility(created.visibility),
      },
    }, origin);
  } catch (error) {
    console.error('[user-tasks-api] could not open the work item:', error);
    return respond(500, { error: 'Could not open the work item', code: 'TASK_CREATE_FAILED' }, origin);
  }
}

/** How the task service's refusal of a card press is answered, by its reason. */
const CARD_REFUSALS: Record<string, { status: number; error: string }> = {
  NOT_FOUND: { status: 404, error: 'There is no such task in this conversation' },
  NOT_ASSIGNEE: { status: 403, error: 'This task is not yours to answer' },
  SETTLED: { status: 409, error: 'This task is already finished' },
  STATE_MOVED: { status: 409, error: 'This task has moved on since the card was shown' },
  NOT_A_CHOICE: { status: 400, error: 'That is not a choice this step offers' },
  REFUSED: { status: 409, error: 'That choice could not be taken now' },
};

/**
 * POST /tasks/advance: A PERSON TAKES A CHOICE ON THEIR TASK'S CARD (ADR-063 decision 2, the FR17 submission advance).
 *
 * The caller is the person the request's authorizer resolved (tenet D14), never a field of the body. They must be a
 * member, checked as them; the conversation must be tagged with a classification and not archived; then the
 * conversation's own task service decides the rest against the row it reads now: the caller is the task's current
 * assignee, the task is still in the state the card showed, and the choice is one that state declares. No new grant:
 * this function already reads tags, checks membership as the caller and invokes a task service by name.
 */
async function advanceOnCard(event: APIGatewayProxyEvent, origin?: string): Promise<APIGatewayProxyResult> {
  const personId = await callerPersonId(event);
  if (!personId) return respond(401, { error: 'Unauthorized: this sign-in names no person' }, origin);
  if (!APP_INSTANCE_ARN) return respond(500, { error: 'APP_INSTANCE_ARN is not configured', code: 'SERVER_MISCONFIG' }, origin);
  let body: Record<string, unknown> | null = null;
  try {
    body = (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const str = (v: unknown, max = 128) => (typeof v === 'string' && v.length <= max ? v : '');
  const channelArn = str(body?.channelArn, 512);
  const taskId = str(body?.taskId);
  const state = str(body?.state, 64);
  const choice = str(body?.choice, 64);
  if (!channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`) || !taskId || !state || !choice) {
    return respond(400, { error: 'channelArn, taskId, state and choice are required', code: 'MALFORMED_BODY' }, origin);
  }
  const callerArn = userArnFor(APP_INSTANCE_ARN, personId);
  try {
    await chime.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: callerArn }));
  } catch {
    return respond(403, { error: 'Not a member of this conversation', code: 'NOT_A_MEMBER' }, origin);
  }
  let classification = '';
  try {
    const tags = await readChannelTags(chime, channelArn);
    if (String(tags.archived) === 'true') return respond(409, { error: 'This conversation is archived and is read-only', code: 'CONVERSATION_ARCHIVED' }, origin);
    classification = tags.classification || '';
  } catch {
    return respond(503, { error: 'Could not confirm this conversation is open', code: 'CHANNEL_STATE_UNREADABLE' }, origin);
  }
  const serviceArn = classification ? await taskServiceArnFor(classification) : '';
  if (!serviceArn) return respond(503, { error: 'No task service is published for this conversation', code: 'TASK_SERVICE_UNAVAILABLE' }, origin);
  try {
    const out = await invokeTaskServiceOp<{ ok: boolean; to?: string; error?: string }>(lambdaClient, serviceArn, 'advanceAsAssignee', {
      taskId, channelArn, callerPersonId: personId, state, choice,
    });
    if (out?.ok) return respond(200, { taskId, state: out.to }, origin);
    const refusal = CARD_REFUSALS[out?.error ?? 'REFUSED'] ?? CARD_REFUSALS.REFUSED;
    return respond(refusal.status, { error: refusal.error, code: out?.error ?? 'REFUSED' }, origin);
  } catch (error) {
    console.error('[user-tasks-api] the card press could not be taken:', (error as Error)?.message);
    return respond(500, { error: 'Could not take that choice', code: 'TASK_ADVANCE_FAILED' }, origin);
  }
}

/**
 * Invoke one classification's task service, through the one task-service invoke (`lib/task-service-op.ts`).
 *
 * NOT `lib/task-service-client`, which resolves a single ARN from `TASK_SERVICE_ARN` because every
 * other caller is inside one classification and has exactly one service to talk to. This route is
 * outside them all and must name the service it means.
 */
async function invokeTaskService(
  arn: string,
  op: string,
  input: unknown,
): Promise<{ taskId?: string; taskRef?: number; status?: string; visibility?: string } | null> {
  return invokeTaskServiceOp(lambdaClient, arn, op, input);
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') return respond(200, {}, origin);
  // POST /tasks opens a work item; GET /tasks/mine lists what the caller owns. One function owns the
  // resource, so the method is the only thing that distinguishes them.
  if (event.httpMethod === 'POST' && /\/tasks\/advance\/?$/.test(event.path || event.resource || '')) return advanceOnCard(event, origin);
  if (event.httpMethod === 'POST') return openWorkItem(event, origin);
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: `${event.httpMethod} not supported` }, origin);
  }

  const personId = await callerPersonId(event);
  if (!personId) {
    return respond(401, { error: 'Unauthorized: this sign-in names no person' }, origin);
  }

  try {
    const rows = await getActiveTasksForUser(personId, { limit: MAX_ITEMS });
    // OWNED, not merely mentioned. `getActiveTasksForUser` queries the mirror partition keyed on the
    // owner, which since ADR-024 is written by one writer under one field - so a task an assistant
    // still owns cannot appear here, and one handed to this user cannot fail to.
    const declared = await machinesByAssistant();
    const items = rows.map((task) => toOpenWorkItem(
      task,
      (task.assistantId && declared.get(task.assistantId)) || DEFAULT_MACHINES,
    ));
    return respond(200, { items, count: items.length }, origin);
  } catch (error) {
    console.error('[user-tasks-api] read failed:', error);
    // A queue that cannot be read must not look like a queue that is empty: an empty list would tell
    // the user they owe nothing, which is a worse lie than an error.
    return respond(500, { error: 'Could not read your open items' }, origin);
  }
};
