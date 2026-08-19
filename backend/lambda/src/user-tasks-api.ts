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
 * AUTHORIZATION. Cognito-authenticated, and the owner is taken from the token's `sub`, never from the
 * query string. There is no parameter by which one user can ask for another user's queue: the only
 * partition this reads is the caller's own. That is the whole access-control story for this endpoint,
 * which is why it can be a plain read with no membership check - a task the caller owns is a task the
 * caller is entitled to see, by definition of ownership (ADR-024).
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getActiveTasksForUser, type UserTask } from './lib/task-tracking.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173').split(',');

/** Bounded so a user with a long tail of open work cannot make this an expensive read. */
const MAX_ITEMS = 25;

function corsHeaders(origin?: string): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Vary': 'Origin',
  };
}

function respond(statusCode: number, body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

function getCallerSub(event: APIGatewayProxyEvent): string | null {
  const claims = (event.requestContext.authorizer?.claims || {}) as Record<string, string>;
  return claims.sub || null;
}

/**
 * What the client renders. A deliberate subset of the mirror row: enough to name the item, say which
 * conversation it belongs to and take the user there, and no task internals.
 *
 * `details` is passed through because it carries the human-readable summary the assistant wrote, which
 * is what makes an item recognisable a day later. It is bounded by the task writer, not here.
 */
export interface OpenWorkItem {
  taskId: string;
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
}

/**
 * The item's human-facing title. Prefers what the assistant recorded, falls back to the task type
 * rendered readably, and never returns an empty string - an unnamed row in a to-do queue is worse than
 * a generically named one, because the user cannot tell what they are being asked to finish.
 */
export function titleOf(task: UserTask): string {
  const details = (task.details ?? {}) as Record<string, unknown>;
  for (const key of ['title', 'summary', 'description']) {
    const value = details[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  const type = (task.taskType || 'general').replace(/_/g, ' ');
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function toOpenWorkItem(task: UserTask): OpenWorkItem {
  return {
    taskId: task.taskId,
    taskType: task.taskType || 'general',
    channelArn: task.channelArn,
    status: task.status,
    ...(task.taskState ? { taskState: task.taskState } : {}),
    title: titleOf(task),
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    ...(task.dueBy ? { dueBy: task.dueBy } : {}),
    ...(task.assistantId ? { assistantId: task.assistantId } : {}),
  };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') return respond(200, {}, origin);
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: `${event.httpMethod} not supported` }, origin);
  }

  const callerSub = getCallerSub(event);
  if (!callerSub) {
    return respond(401, { error: 'Unauthorized — no Cognito sub on the request' }, origin);
  }

  try {
    const rows = await getActiveTasksForUser(callerSub, { limit: MAX_ITEMS });
    // OWNED, not merely mentioned. `getActiveTasksForUser` queries the mirror partition keyed on the
    // owner, which since ADR-024 is written by one writer under one field - so a task an assistant
    // still owns cannot appear here, and one handed to this user cannot fail to.
    const items = rows.map(toOpenWorkItem);
    return respond(200, { items, count: items.length }, origin);
  } catch (error) {
    console.error('[user-tasks-api] read failed:', error);
    // A queue that cannot be read must not look like a queue that is empty: an empty list would tell
    // the user they owe nothing, which is a worse lie than an error.
    return respond(500, { error: 'Could not read your open items' }, origin);
  }
};
