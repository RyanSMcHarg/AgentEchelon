/**
 * A SERVICE NAMES A NOTICE AND THE ROUTER SAYS IT.
 *
 * The battle administration API, conversation management, federated member add, the proactive briefing
 * and the typed-conversation creator each have a line to put in a conversation as its assistant. None of
 * them speaks: each names a notice kind, the assistant it concerns and its variables, and the router of
 * the conversation's classification says it (`sayNotice`). The router validates the kind, the conversation
 * and the assistant, checks every variable, resolves the line from that assistant's own copy, builds the
 * kind's metadata, and posts on a speak session. So the caller holds no assistant session, no vend, and no
 * routing-table write, and cannot make an assistant say text of its own.
 *
 * RequestResponse and awaited, so a caller that must order the notice (the archive posts it before the
 * `archived` tag, which would refuse it after) can.
 */
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { resolveRouterArn } from './router-arn.js';
import type { NoticeRequest, NoticeOutcome } from './assistant-notice.js';

let lambda: LambdaClient | null = null;

export async function sayThroughRouter(classification: string, notice: NoticeRequest): Promise<NoticeOutcome> {
  const routerArn = await resolveRouterArn(classification);
  if (!routerArn) return { posted: false, reason: `no router wired for ${classification}` };
  try {
    lambda = lambda ?? new LambdaClient({});
    const res = await lambda.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({ aeNotice: notice })),
    }));
    if (res.FunctionError) return { posted: false, reason: `router error: ${res.FunctionError}` };
    const outcome = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString() || '{}') as NoticeOutcome : { posted: false };
    if (!outcome.posted) {
      console.warn('[say-through-router] the router did not say the notice', { kind: notice.kind, reason: outcome.reason });
    }
    return outcome;
  } catch (err) {
    console.warn('[say-through-router] could not reach the router', { kind: notice.kind, message: (err as Error)?.message });
    return { posted: false, reason: 'invoke-failed' };
  }
}

/** `conversation-opened`, named by the canonical creator once the people its type admits are in the room. */
export interface ConversationOpenedNaming { event: 'conversation-opened'; channelArn: string; personArn: string; label?: string }

/**
 * `person-joined`, named by each path that adds a person (the creator, the share and the add-member path) once the
 * membership exists. One naming carries every person one add admitted, at most {@link MAX_PEOPLE_JOINED}, so a
 * creation asks the router once; each person is verified and run on their own.
 */
export interface PersonJoinedNaming { event: 'person-joined'; channelArn: string; personArns: string[] }

/** The most people one `person-joined` naming carries: the most one creation welcomes (`MAX_WELCOMED`). */
export const MAX_PEOPLE_JOINED = 40;

/**
 * `invitation-sent`, named by the invitations function once the invitation's `Tokens` record is written. Ids only: the
 * conversation and the invitation's id. The router reads the invitee, the inviter and the reason from the record
 * itself, so the payload can name no person and carries no address and no token.
 */
/** `invitationKey`: the record's key (`invitation#<token hash>`), which the router reads strongly consistent; never a token. */
export interface InvitationSentNaming { event: 'invitation-sent'; channelArn: string; invitationId: string; invitationKey?: string }

/**
 * A DECLARED SOURCE NAMES AN EVENT TO THE ROUTER (ADR-061 decision 1), through the same seam: the router of the
 * conversation's classification verifies the event against its record and runs the workflow the room's assistant
 * declares for it. Returns whether a run started and, for `person-joined`, the people whose welcome a run owns, so
 * the source sends no welcome of its own to them. Any failure reports no run, and the source welcomes as before.
 */
export async function nameEventThroughRouter(
  classification: string,
  event: ConversationOpenedNaming | PersonJoinedNaming,
): Promise<{ ran: boolean; reason?: string; people?: string[]; recapped?: string[] }> {
  const routerArn = await resolveRouterArn(classification);
  if (!routerArn) return { ran: false, reason: `no router wired for ${classification}` };
  try {
    lambda = lambda ?? new LambdaClient({});
    const res = await lambda.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({ aeEvent: event })),
    }));
    if (res.FunctionError) return { ran: false, reason: `router error: ${res.FunctionError}` };
    const out = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString() || '{}') as { ran?: boolean; reason?: string; people?: unknown; recapped?: unknown } : {};
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : undefined);
    const people = strings(out.people);
    const recapped = strings(out.recapped);
    return { ran: out.ran === true, ...(out.reason ? { reason: out.reason } : {}), ...(people ? { people } : {}), ...(recapped ? { recapped } : {}) };
  } catch (err) {
    console.warn('[say-through-router] could not name the event to the router', { event: event.event, message: (err as Error)?.message });
    return { ran: false, reason: 'invoke-failed' };
  }
}

/**
 * NAME `person-joined` FOR THE PEOPLE ONE ADD ADMITTED, and return those whose welcome an event run owns. Never throws:
 * a naming that fails owns nobody, so every person is welcomed by the source as before.
 */
export async function personJoinedThroughRouter(classification: string, channelArn: string, personArns: string[]): Promise<JoinedRun> {
  const people = [...new Set(personArns.filter((p) => typeof p === 'string' && p.includes('/user/')))].slice(0, MAX_PEOPLE_JOINED);
  if (!people.length) return Object.assign(new Set<string>(), { recapped: new Set<string>() });
  const out = await nameEventThroughRouter(classification, { event: 'person-joined', channelArn, personArns: people })
    .catch(() => ({ ran: false, people: [] as string[], recapped: [] as string[] }));
  const recapped = out.recapped;
  console.log('[say-through-router] person-joined', { ran: out.ran, owned: out.people?.length ?? 0, named: people.length });
  return Object.assign(new Set((out.people ?? []).filter((p) => people.includes(p))), {
    recapped: new Set((Array.isArray(recapped) ? recapped : []).filter((p): p is string => typeof p === 'string' && people.includes(p))),
  });
}

/**
 * What a `person-joined` naming answered: the people whose welcome the room's run owns (the set itself), and, as
 * `recapped`, every person whose run carries the join recap, for whom no source asks a recap of its own. A naming that
 * failed owns and recaps nobody, and each source welcomes and recaps as before.
 */
export type JoinedRun = Set<string> & { recapped: ReadonlySet<string> };

/**
 * NAME `invitation-sent` TO THE ROUTER OF THE CONVERSATION'S CLASSIFICATION, asynchronously: the inviter is answered
 * without waiting on a workflow, and nothing about the invitation depends on whether one runs, because the invitation's
 * own email is sent by the invitations function either way (`workflowSendEmailKind`). An asynchronous invoke the router
 * fails is retried by Lambda, and the run's claim makes a retry start nothing twice. Never throws.
 */
export async function invitationSentThroughRouter(classification: string, channelArn: string, invitationId: string, invitationKey?: string): Promise<boolean> {
  const routerArn = await resolveRouterArn(classification).catch(() => undefined);
  if (!routerArn) {
    console.warn('[say-through-router] invitation-sent not named: no router wired', { classification });
    return false;
  }
  try {
    lambda = lambda ?? new LambdaClient({});
    const naming: InvitationSentNaming = { event: 'invitation-sent', channelArn, invitationId, ...(invitationKey ? { invitationKey } : {}) };
    await lambda.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeEvent: naming })),
    }));
    return true;
  } catch (err) {
    console.warn('[say-through-router] could not name invitation-sent to the router', { message: (err as Error)?.message });
    return false;
  }
}

/**
 * ASK THE ROUTER OF A CLASSIFICATION TO DELETE THE DEADLINE SCHEDULES A RESOLVED THING NO LONGER NEEDS (ADR-061 decision
 * 1, tenet D15): one invitation's, when it is revoked, or every invitation's of a conversation, when it is archived.
 * Redemption and offboarding call nothing here, by decision: their schedule fires, finds the invitation redeemed or gone,
 * and deletes itself. Ids only, asynchronously: the path that resolved it waits on nothing, and the
 * router deletes within its own schedule group, which is all its grant reaches. A schedule left behind is harmless,
 * because the router checks the record when it fires. Never throws.
 */
export async function cancelDeadlinesThroughRouter(classification: string, cancel: { channelArn: string; invitationId?: string }): Promise<boolean> {
  const routerArn = await resolveRouterArn(classification).catch(() => undefined);
  if (!routerArn) return false;
  try {
    lambda = lambda ?? new LambdaClient({});
    await lambda.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeDeadlineCancel: { channelArn: cancel.channelArn, ...(cancel.invitationId ? { invitationId: cancel.invitationId } : {}) } })),
    }));
    return true;
  } catch (err) {
    console.warn('[say-through-router] could not ask the router to delete a deadline; it is checked when it fires', { message: (err as Error)?.message });
    return false;
  }
}

/** What the processor hands back to the router once it has completed an agent step (ADR-061 decision 5). */
export interface EventContinuation {
  runKey: string;
  workflow: string;
  step: string;
  /** The outcome that won the step's claim: `posted`, `skipped` (a join recap with nothing to recount), a `fallback:` outcome, or `refused` (a turn the processor would not take, whose fallback the router says). */
  outcome: string;
  event: import('./event-workflow.js').WorkflowEvent;
  channelArn: string;
  botArn: string;
  eventPerson?: string;
  /** An invitation's events only: the invitation, which the router reads again before it continues the run. */
  invitationId?: string;
  /** `alarm-state-changed` only: the alarm change the run is for, whose watch the router reads again before it continues. */
  alarm?: import('./event-workflow.js').AlarmChange;
  subject?: string;
  values: Record<string, string>;
  transitions?: Array<{ step: string; outcome: string }>;
}

/**
 * HAND A RUN BACK TO THE ROUTER after its agent step (ADR-061 decision 5), through the same seam a source names an
 * event by: the processor's own classification's router, asynchronously. The router claims the continuation once
 * and runs the steps that follow.
 */
export async function continueEventRunThroughRouter(routerArn: string, continuation: EventContinuation): Promise<boolean> {
  if (!routerArn) return false;
  try {
    lambda = lambda ?? new LambdaClient({});
    await lambda.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeEventContinue: continuation })),
    }));
    return true;
  } catch (err) {
    console.warn('[say-through-router] could not hand the run back to the router', { step: continuation.step, message: (err as Error)?.message });
    return false;
  }
}

/**
 * WHAT A TASK SERVICE NAMES TO ITS OWN CLASSIFICATION'S ROUTER (ADR-063 decisions 3 and 5): a task a workflow run waits on
 * that settled, or a task that became an assistant's to take up. Ids only; the router reads the task back before it acts.
 */
export interface TaskNaming { kind: 'settled' | 'ready'; channelArn: string; taskId: string }

/** Name a task's change to the router, asynchronously. Never throws; false when it could not be handed over. */
export async function nameTaskThroughRouter(classification: string, naming: TaskNaming): Promise<boolean> {
  const routerArn = await resolveRouterArn(classification).catch(() => undefined);
  if (!routerArn) return false;
  try {
    lambda = lambda ?? new LambdaClient({});
    await lambda.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTask: { kind: naming.kind, channelArn: naming.channelArn, taskId: naming.taskId } })),
    }));
    return true;
  } catch (err) {
    console.warn('[say-through-router] could not name a task to the router', { kind: naming.kind, message: (err as Error)?.message });
    return false;
  }
}

/**
 * A TURN'S EXIT GAVE THE LOCK TO A PICKUP TURN (ADR-063 decision 5): name it to the classification's own router, which
 * alone dispatches its turns, asynchronously. Ids only. False when it could not be handed over, and the caller releases.
 *
 * `resolve` is how the caller finds that router. The caller is the processor, which holds its own classification's
 * router parameter (`ROUTER_ARN_PARAM`) and no by-name root, so it passes the resolver that reads it
 * (`resolveRouterArn` in `turn-triage.ts`); the by-name default serves a function carrying `ROUTER_ARN_PARAM_ROOT`.
 */
export async function pickupThroughRouter(
  classification: string,
  req: import('./workflow-task.js').TaskPickupRequest,
  resolve: (classification: string) => Promise<string | undefined> = resolveRouterArn,
): Promise<boolean> {
  const routerArn = await resolve(classification).catch(() => undefined);
  if (!routerArn) return false;
  try {
    lambda = lambda ?? new LambdaClient({});
    await lambda.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTaskPickup: { channelArn: req.channelArn, botArn: req.botArn, taskId: req.taskId, correlationId: req.correlationId } })),
    }));
    return true;
  } catch (err) {
    console.warn('[say-through-router] could not hand a pickup to the router', { message: (err as Error)?.message });
    return false;
  }
}
