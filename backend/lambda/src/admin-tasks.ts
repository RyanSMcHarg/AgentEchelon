/**
 * WHAT AN OPERATOR CAN DO ABOUT A STALLED TASK.
 *
 *   GET  /admin/tasks/channel/{channelId}         - what work is open in this conversation
 *   POST /admin/tasks/channel/{channelId}/cancel  - stop one that is stuck
 *   GET  /admin/tasks/assignee/{assigneeId}       - everything one principal is ASSIGNED
 *   GET  /admin/tasks/owned-by/{ownerPersonId}         - everything one person OWNS
 *   POST /admin/tasks/channel/{channelId}/owner   - hand a task to a different owner
 *
 * The identifiers are in the PATH rather than a query string or a body, because that is what a
 * vended session policy can pin to a single conversation or principal (see the note further down).
 *
 * ── WHY THIS HAD TO EXIST ────────────────────────────────────────────────────────────────────────
 *
 * The console could already SEE a stalled task: the Aurora projection carries task metrics and a
 * per-task drill. What it could not do was anything about it - no path reached the live store at all.
 *
 * That gap is not neutral. The rows are right there and already admin-readable, so the tempting fix is
 * to act on them, and acting on them breaks the rule this platform holds everywhere else: an archived
 * copy is never the authority for a live decision, because it lags exactly when something has just
 * changed. Building the path is what removes the temptation.
 *
 * ── IT GOES THROUGH THE SERVICE, LIKE EVERY OTHER TASK CALLER ────────────────────────────────────
 *
 * Not the table. The service role is the only holder, and a second holder appearing for the admin
 * plane would reopen the bypass the migration just closed - the boundary is only a boundary while
 * nothing goes around it.
 *
 * ── AND THE CLASSIFICATION BOUNDARY DOES NOT APPLY HERE ───────────────────────────────────────────
 *
 * That check answers "may this ASSISTANT serve this conversation". An operator is not an assistant:
 * they already read across conversations they are not a member of, which is what the admin plane is
 * for. Applying it would make a premium conversation's stalled task invisible in the one place it can
 * be unblocked.
 *
 * What gates this instead is the capability the caller had to hold to reach the route - vended short
 * and audited by the credential exchange, never held by a standing role. The boundary is at the door.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { invokeTaskServiceOp } from './lib/task-service-op.js';
import { requireAdmin } from './lib/auth.js';
import { resolveTaskServiceArn } from './lib/classification-env.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { responder, originsFrom, requestOrigin, DEV_ORIGIN } from './lib/http-response.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGINS, DEV_ORIGIN);
const lambda = new LambdaClient({ region: AWS_REGION });

/**
 * Which task services this operator route may ask.
 *
 * ONE PER CLASSIFICATION, because that is how the services are deployed, and the operator plane is
 * the only caller that legitimately spans them. An assistant may invoke its own and no other; this
 * route holds every one precisely because the question "what is stuck in this conversation" is not
 * answerable from inside one classification. The set is the classifications this deployment declares.
 */
async function serviceArns(): Promise<string[]> {
  const arns = await Promise.all(profiles.classificationValues().map((c) => resolveTaskServiceArn(c)));
  return arns.filter((a): a is string => !!a);
}

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,POST,OPTIONS' });

const respond = (event: APIGatewayProxyEvent, statusCode: number, body: unknown): APIGatewayProxyResult =>
  http.respond(statusCode, body, requestOrigin(event));

async function ask<T>(arn: string, op: string, input: unknown): Promise<T | null> {
  try {
    return await invokeTaskServiceOp<T>(lambda, arn, op, input);
  } catch (err) {
    console.warn('[admin-tasks] service call failed', { arn, op, err: (err as Error)?.message });
    return null;
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (event.httpMethod === 'OPTIONS') return http.empty(200, requestOrigin(event));

  // The same gate every admin handler uses, so a deployment's admin-auth mode resolves here exactly as
  // it does elsewhere rather than this route inventing its own answer.
  const gate = await requireAdmin(event);
  if ('statusCode' in gate) return gate;
  const actor = gate.claims.actor || 'operator';

  const arns = await serviceArns();
  if (!arns.length) {
    // NOT an empty list. "No tasks" is a claim, and an operator who believed it would conclude the
    // conversation was clear when the truth is that nothing was asked.
    return respond(event, 503, { error: 'No task service is wired for this deployment' });
  }

  // WHAT IS BEING ASKED ABOUT TRAVELS IN THE PATH, NOT THE QUERY STRING (maintainer, 2026-08-31).
  //
  // An API Gateway resource ARN is api/stage/METHOD/path, and a query string is no part of it - so
  // while the channel arrived as `?channelArn=`, `execute-api:Invoke` could not be conditioned on
  // it. The exchange REQUIRED a channelArn to vend and audited it, but the credential it handed
  // back could read any channel: the scope was declared and recorded, never enforced. In the path
  // the identifier is part of the resource, so the session policy narrows to it the same way the S3
  // attachment plane narrows to one key prefix.
  //
  // TWO SHAPES, because they are two different questions with two different scopes:
  //   /admin/tasks/channel/{channelId} - everything open in ONE conversation
  //   /admin/tasks/assignee/{id}       - everything a principal is ASSIGNED, across channels
  //   /admin/tasks/owned-by/{id}       - everything a person OWNS, across channels
  //
  // ── TWO PRINCIPAL ROUTES, BECAUSE A TASK HAS TWO PRINCIPAL ROLES (ADR-024 D8) ──────────────────
  //
  // `/assignee/{assigneeId}` answers what a principal is ASSIGNED, which is what they owe next.
  // `/owned-by/{ownerPersonId}` answers what a person OWNS. They return different sets: work in flight is
  // assigned to the assistant while still owned by whoever asked for it.
  //
  // `/owner/` IS GONE. It served the assignee read under the wrong word, and keeping the path while
  // changing what it returns would leave one route naming two different facts either side of a
  // deploy - including in every audit line already written against it. Retired rather than reused,
  // so a stale caller fails loudly instead of quietly reading something else.
  // The owner id is a principal id, which is what `personId` holds on the mirror table (ADR-024 D2:
  // the CURRENT OWNER, user or assistant), so one route answers for both without a second index.
  //
  // The ID rather than the whole ARN: a path segment cannot carry the unencoded slashes an ARN has,
  // and encoded ones are matched inconsistently between the gateway and IAM. The id is the part that
  // identifies, so it is the part that scopes; the ARN is rebuilt here from APP_INSTANCE_ARN.
  const channelId = event.pathParameters?.channelId || '';
  const assigneeId = event.pathParameters?.assigneeId || '';
  const ownerPersonId = event.pathParameters?.ownerPersonId || '';

  if (event.httpMethod === 'GET' && assigneeId) {
    // WHAT THIS PRINCIPAL OWES, across conversations - the read this route used to serve under the
    // `/owner/` path, now under the name of the role it actually answers for.
    const answers = await Promise.all(
      arns.map((arn) => ask<unknown[]>(arn, 'adminListAssigneeTasks', { assigneeId })),
    );
    const answered = answers.filter((a): a is unknown[] => Array.isArray(a));
    const seen = new Set<string>();
    const data = answered.flat().filter((row) => {
      const id = (row as { taskId?: unknown })?.taskId;
      if (typeof id !== 'string' || !id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    console.log('[AdminTasks] assignee task read', { actor, assigneeId, returned: data.length });
    return respond(event, 200, { data, servicesAsked: arns.length, servicesAnswered: answered.length });
  }

  if (event.httpMethod === 'GET' && ownerPersonId) {
    // ACROSS CHANNELS, deliberately. The question "what is this person still waiting on" does not
    // stop at a conversation boundary, and answering it per-channel is how an operator misses the
    // one that is stalled somewhere they did not think to look.
    const answers = await Promise.all(
      arns.map((arn) => ask<unknown[]>(arn, 'adminListTasksOwnedBy', { ownerPersonId })),
    );
    const answered = answers.filter((a): a is unknown[] => Array.isArray(a));
    const seenOwner = new Set<string>();
    const data = answered.flat().filter((row) => {
      const id = (row as { taskId?: unknown })?.taskId;
      if (typeof id !== 'string' || !id) return true;
      if (seenOwner.has(id)) return false;
      seenOwner.add(id);
      return true;
    });
    console.log('[AdminTasks] owned-by task read', { actor, ownerPersonId, returned: data.length });
    return respond(event, 200, { data, servicesAsked: arns.length, servicesAnswered: answered.length });
  }

  if (event.httpMethod === 'GET') {
    if (!channelId) return respond(event, 400, { error: 'a channelId path segment is required' });
    if (!APP_INSTANCE_ARN) {
      // Same reasoning as the unwired-service answer above: a claim of "no tasks" that is really a
      // misconfiguration is the one answer an operator must never be given.
      console.error('[AdminTasks] APP_INSTANCE_ARN is unset; cannot resolve a channel id');
      return respond(event, 503, { error: 'This deployment cannot resolve a conversation id' });
    }
    const channelArn = `${APP_INSTANCE_ARN}/channel/${channelId}`;

    // ASKED OF EVERY CLASSIFICATION, because the operator does not know which one owns the
    // conversation and should not have to. Concurrent: they are independent questions.
    const answers = await Promise.all(
      arns.map((arn) => ask<unknown[]>(arn, 'adminListTasks', { channelArn })),
    );
    // A service that failed contributes nothing rather than an empty answer, and the response says how
    // many answered - an operator reading a short list needs to know whether it is short because the
    // conversation is quiet or because a service did not reply.
    const answered = answers.filter((a): a is unknown[] => Array.isArray(a));

    // DEDUPED BY TASK ID, because the three services share one table.
    //
    // Each answers about the same `agent-tasks` table and `adminListTasks` filters on channelArn
    // alone, so all three return the SAME rows - concatenating them showed an operator two open
    // items as six, with `servicesAnswered: 3` reassuring them nothing had been missed. The fan-out
    // is still right (nobody knows which classification owns a conversation), the flattening was not.
    const seen = new Set<string>();
    const data = answered.flat().filter((row) => {
      const id = (row as { taskId?: unknown })?.taskId;
      if (typeof id !== 'string' || !id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return respond(event, 200, { data, servicesAsked: arns.length, servicesAnswered: answered.length });
  }

  // HANDING A TASK TO A DIFFERENT OWNER (ADR-024 D8).
  //
  // Distinguished from the cancel POST by the path, not by the body: two writes that differ only in a
  // body field are two writes one typo apart, and this one moves work between people.
  //
  // IT DOES NOT TOUCH THE ASSIGNEE, which is the whole of D8: who owns the work and who owes its next
  // step are separate axes, and handing a report to a colleague does not decide whether the assistant
  // or a person acts next.
  if (event.httpMethod === 'POST' && event.resource?.endsWith('/owner')) {
    let body: { taskId?: string; ownerPersonId?: string } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* handled below */ }
    const { taskId, ownerPersonId } = body;
    if (!taskId) return respond(event, 400, { error: 'taskId is required' });
    if (!ownerPersonId) return respond(event, 400, { error: 'ownerPersonId is required' });
    if (!channelId) return respond(event, 400, { error: 'a channelId path segment is required' });
    if (!APP_INSTANCE_ARN) {
      console.error('[AdminTasks] APP_INSTANCE_ARN is unset; cannot resolve a channel id');
      return respond(event, 503, { error: 'This deployment cannot resolve a conversation id' });
    }
    const channelArn = `${APP_INSTANCE_ARN}/channel/${channelId}`;

    for (const arn of arns) {
      const out = await ask<{ ok?: boolean }>(arn, 'reassignTaskOwner', { taskId, channelArn, ownerPersonId });
      if (out?.ok) {
        // AUDITED, like the cancel beside it. Moving work between people is a fact somebody may need
        // to reconstruct later, and the operator who did it is part of that fact.
        console.log('[admin-tasks][audit] operator handed a task to a new owner', {
          taskId, channelArn, ownerPersonId, actor,
        });
        return respond(event, 200, { reassigned: true });
      }
    }
    // NOT a 200 carrying reassigned:false. An operator who believes they handed work over and did not
    // is the one failure this must never present as success.
    return respond(event, 404, { error: 'No service owns that task, or the conversation is not serveable' });
  }

  if (event.httpMethod === 'POST') {
    // The conversation comes from the PATH for the same reason the read does - it is what the
    // session policy is scoped to. Only the task id is body content now.
    let body: { taskId?: string } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* handled below */ }
    const { taskId } = body;
    if (!taskId) return respond(event, 400, { error: 'taskId is required' });
    if (!channelId) return respond(event, 400, { error: 'a channelId path segment is required' });
    if (!APP_INSTANCE_ARN) {
      console.error('[AdminTasks] APP_INSTANCE_ARN is unset; cannot resolve a channel id');
      return respond(event, 503, { error: 'This deployment cannot resolve a conversation id' });
    }
    const channelArn = `${APP_INSTANCE_ARN}/channel/${channelId}`;

    // The first service that owns it wins. A task lives in exactly one, and asking the others costs a
    // refusal rather than a wrong answer.
    for (const arn of arns) {
      const ok = await ask<boolean>(arn, 'adminCancelTask', { taskId, channelArn, by: actor });
      if (ok) {
        console.log('[admin-tasks][audit] operator cancelled a task', { taskId, channelArn, actor });
        return respond(event, 200, { cancelled: true });
      }
    }
    // NOT a 200 with cancelled:false hidden in the body. An operator who thinks they stopped something
    // that is still running is worse served than one told plainly that it did not work.
    return respond(event, 404, { error: 'No task with that id in that conversation' });
  }

  return respond(event, 405, { error: `${event.httpMethod} not supported` });
};
