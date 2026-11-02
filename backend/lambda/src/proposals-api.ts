/**
 * THE APPLY ENDPOINT OF A PROPOSAL (ADR-061 decision 8, rule 8; DESIGN-ASSISTANT-MEETINGS B.2): `POST /proposals/apply`.
 *
 * An agent step that proposes drafts its proposal and executes nothing; the processor records it in the token store
 * (`lib/proposals.ts`) and offers it to the one person it is addressed to as a confirmation card. That person applies
 * or declines it here, and this function performs the act, holding the grant the assistant does not.
 *
 * A person route on `PersonApi`, behind the edge authorizer. The body is `{ proposal, decision, address? }`: the card's
 * handle, `apply` or `decline`, and for a reminder the address the inviter types, used for that one email and stored
 * nowhere (K2). In this order, and nothing later runs when anything earlier refuses:
 *
 *  1. The caller is an ordinary signed-in person (`callerPerson`): a guest, a one-conversation session, a host
 *     assertion and an assistant's session resolve to nobody, so an assistant can never confirm its own proposal.
 *  2. The proposal is a `proposal` record, addressed to this caller (`personArn`), undecided and unexpired
 *     (`proposalRefusal`). Another member is refused here and again by the consuming update, whose condition names
 *     the addressee.
 *  3. The caller is still a member of the conversation: `DescribeChannel` bearing the caller, so the Amazon Chime SDK
 *     refuses a conversation they left. Not archived.
 *  4. The caller is still the person the step addressed them as: the holder of the participant role, read from the
 *     context row's holdings at apply time (`holdersByRole`, never Metadata), or the invitation's inviter, which the
 *     invitations function reads from the invitation's record before it sends anything.
 *  5. The proposal is claimed once (`redeemToken`, single-use, matched to the addressee, `decision: applying`), so a
 *     second apply, or an apply racing a decline, is refused by the store.
 *  6. The act: `send_nudge` asks the invitations function to remind the invitee, once (`nudgeOperation`);
 *     `open_conversation` asks the conversation's classification's typed creator to open the declared type for the
 *     caller, recording them as its creator (`confirmedBy`), who holds each `{ creator: true }` participant role.
 *  7. The outcome, as the act answered: `applied` once it was done; a refusal releases the claim, so the proposal is
 *     undecided and its addressee may apply it again; an act that did not answer is released where asking again cannot
 *     do it twice (a reminder) and recorded `failed` otherwise (an opening).
 *
 * A decline consumes the proposal the same way and does nothing else. Every decision is logged as an audit line with
 * the op, the conversation and who decided, never the draft or an address.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DescribeChannelCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { callerPerson } from './lib/auth.js';
import { responder, originsFrom, DEV_ORIGIN, type HttpResult } from './lib/http-response.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { CLASSIFICATION_TAG, readChannelTags } from './lib/channel-classification.js';
import { holdersByRole } from './lib/participant-roles.js';
import { userArnFor } from './lib/person-arn.js';
import { redeemToken } from './lib/tokens.js';
import { proposalRefusal, readProposal, releaseProposal, settleProposal, type ProposalRecord } from './lib/proposals.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

export const PROPOSAL_APPLY_ROUTE = '/proposals/apply';

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN) }, methods: 'POST,OPTIONS' });
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export interface ProposalsDeps {
  doc?: Sender;
  messaging?: Sender;
  lambda?: Sender;
  tokensTable?: string;
  contextTable?: string;
  appInstanceArn?: string;
  /** The invitations function, which sends a confirmed reminder (`nudge`). */
  invitationsFunction?: string;
  /** The typed creator of a classification, by its fixed name (`typedCreatorName`); empty where none is configured. */
  creatorOf?: (classification: string) => string;
  now?: () => number;
}

let defaultDoc: Sender | null = null;
let defaultMessaging: Sender | null = null;
let defaultLambda: Sender | null = null;
const docOf = (d: ProposalsDeps): Sender => d.doc ?? (defaultDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));
const messagingOf = (d: ProposalsDeps): Sender => d.messaging ?? (defaultMessaging ??= chimeMessagingClient({}));
const lambdaOf = (d: ProposalsDeps): Sender => d.lambda ?? (defaultLambda ??= new LambdaClient({}));
const env = (d: ProposalsDeps) => ({
  tokensTable: d.tokensTable ?? process.env.TOKENS_TABLE ?? '',
  contextTable: d.contextTable ?? process.env.CHANNEL_CONTEXT_TABLE ?? '',
  appInstanceArn: d.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '',
  invitationsFunction: d.invitationsFunction ?? process.env.INVITATIONS_FUNCTION ?? '',
  // THE TYPED CREATOR'S FIXED NAME, by its pattern (`typedCreatorName`): set by the stack, the classification filled here.
  creatorOf: d.creatorOf ?? ((classification: string) => (process.env.TYPED_CREATOR_NAME_PATTERN || '').replace('{classification}', classification)),
});
const refuse = (status: number, code: string, message: string): HttpResult => http.error(status, message, undefined, code);
const nameOf = (err: unknown): string => (err as { name?: string })?.name || '';

function bodyOf(event: any): Record<string, unknown> | null {
  try {
    const raw = typeof event?.body === 'string' ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : event?.body;
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Whether the caller is still the person the step addressed them as, read now (rule 8). Undefined when they are. */
async function addresseeRefusal(record: ProposalRecord, callerArn: string, d: ProposalsDeps): Promise<HttpResult | undefined> {
  if (!record.addressedAs.startsWith('participantRole:')) return undefined;
  const role = record.addressedAs.slice('participantRole:'.length);
  const { contextTable } = env(d);
  if (!contextTable) return refuse(503, 'PROPOSALS_UNAVAILABLE', 'the conversation\'s participant roles could not be read');
  const row = (await docOf(d).send(new GetCommand({
    TableName: contextTable, Key: { channelArn: record.channelArn }, ProjectionExpression: 'conversationType, participantRoles', ConsistentRead: true,
  })))?.Item;
  const holders = holdersByRole(row?.participantRoles, typeof row?.conversationType === 'string' ? row.conversationType : null, [callerArn]);
  if (!(holders[role] ?? []).includes(callerArn)) return refuse(403, 'ROLE_NOT_HELD', 'this proposal is for the holder of a participant role you no longer hold');
  return undefined;
}

/** Invoke a function synchronously and read its answer. */
async function invoke(d: ProposalsDeps, functionName: string, payload: unknown): Promise<Record<string, any>> {
  const res = await lambdaOf(d).send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(payload)) }));
  if (res.FunctionError) throw new Error(`the act failed: ${res.FunctionError}`);
  return JSON.parse(Buffer.from(res.Payload ?? []).toString() || '{}');
}

/**
 * WHETHER AN ACT MAY BE ASKED FOR AGAIN AFTER AN ANSWER THAT SAYS NOTHING OF ITS OUTCOME (an invoke that threw): a reminder
 * is sent at most once per invitation by the invitations function's own condition (`nudgedAt`), so asking again cannot
 * send a second; a conversation the creator was asked to open may already be open, so it is not asked for again.
 */
const ACT_REPEATABLE: Record<ProposalRecord['op'], boolean> = { send_nudge: true, open_conversation: false };

/**
 * Perform the act a proposal names, for the person who applied it. `done` is true only when the act was done; a refusal
 * from the function asked, or a missing configuration, is an act that did not happen.
 */
async function performAct(record: ProposalRecord, callerArn: string, address: string, d: ProposalsDeps): Promise<{ result: HttpResult; done: boolean }> {
  const notDone = (result: HttpResult) => ({ result, done: false });
  const e = env(d);
  if (record.op === 'send_nudge') {
    if (!e.invitationsFunction || !record.invitationId) return notDone(refuse(503, 'PROPOSALS_UNAVAILABLE', 'reminders are not configured'));
    const out = await invoke(d, e.invitationsFunction, {
      op: 'nudge', channelArn: record.channelArn, invitationId: record.invitationId, confirmedBy: callerArn, address, note: record.draft,
    });
    if (out.ok !== true) {
      const body = (out.body ?? {}) as { code?: string; error?: string };
      return notDone(refuse(typeof out.status === 'number' ? out.status : 502, body.code || 'NUDGE_REFUSED', body.error || 'the reminder was not sent'));
    }
    return { result: http.respond(200, { applied: true, op: record.op, sent: (out.body as { sent?: boolean })?.sent === true }), done: true };
  }
  if (!record.conversationType) return notDone(refuse(400, 'PROPOSAL_INVALID', 'the proposal names no conversation type'));
  const creator = e.creatorOf(record.classification);
  if (!creator) return notDone(refuse(503, 'PROPOSALS_UNAVAILABLE', 'no creator is configured to open the conversation'));
  const out = await invoke(d, creator, {
    detail: {
      conversationType: record.conversationType,
      concernedChannelArn: record.channelArn,
      forUserArn: callerArn,
      confirmedBy: callerArn,
      // THE DRAFT IS THE ROOM'S SUBJECT; without one the creator names the room from the type and its default (conversation-name.ts).
      ...(record.draft ? { topicLabel: record.draft } : {}),
    },
  });
  if (out.ok !== true || typeof out.channelArn !== 'string') return notDone(refuse(502, 'OPEN_REFUSED', 'the conversation could not be opened'));
  return { result: http.respond(200, { applied: true, op: record.op, channelArn: out.channelArn }), done: true };
}

export async function applyProposal(event: any, d: ProposalsDeps = {}): Promise<HttpResult> {
  const caller = await callerPerson(event);
  if (!caller || caller.source !== 'edge') return refuse(401, 'UNAUTHENTICATED', 'a proposal is decided by the signed-in person it is addressed to');
  const e = env(d);
  if (!e.tokensTable || !e.appInstanceArn) return refuse(500, 'SERVER_MISCONFIG', 'proposals are not configured');
  const callerArn = caller.personArn ?? userArnFor(e.appInstanceArn, caller.personId);
  const body = bodyOf(event);
  if (!body) return refuse(400, 'PROPOSAL_INVALID', 'the body is not JSON');
  const handle = typeof body.proposal === 'string' && body.proposal.length <= 128 ? body.proposal : '';
  if (!handle) return refuse(400, 'PROPOSAL_INVALID', 'proposal is the handle the confirmation card carries');
  if (body.decision !== 'apply' && body.decision !== 'decline') return refuse(400, 'PROPOSAL_INVALID', 'decision is apply or decline');
  const now = Math.floor((d.now ?? Date.now)() / 1000);

  const record = await readProposal(docOf(d), e.tokensTable, handle);
  const refusal = proposalRefusal(record, callerArn, now);
  if (refusal) {
    if (refusal === 'not-addressee' || refusal === 'assistant') {
      console.warn('[Proposals][SecurityEvent] a proposal was decided by someone it is not addressed to; refused', { refusal, op: record?.op });
    }
    const status = { unknown: 404, assistant: 403, 'not-addressee': 403, decided: 409, expired: 410 }[refusal];
    const code = { unknown: 'PROPOSAL_UNKNOWN', assistant: 'NOT_A_PERSON', 'not-addressee': 'NOT_ADDRESSEE', decided: 'PROPOSAL_DECIDED', expired: 'PROPOSAL_EXPIRED' }[refusal];
    return refuse(status, code, `the proposal cannot be decided: ${refusal}`);
  }
  const proposal = record!;
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (body.decision === 'apply' && proposal.op === 'send_nudge' && !ADDRESS.test(address)) {
    return refuse(400, 'ADDRESS_INVALID', 'a reminder is sent to the email address you enter');
  }

  // STILL A MEMBER, as the Amazon Chime SDK answers for the caller, and the conversation not archived.
  try {
    await messagingOf(d).send(new DescribeChannelCommand({ ChannelArn: proposal.channelArn, ChimeBearer: callerArn }));
    const tags = await readChannelTags(messagingOf(d) as never, proposal.channelArn);
    if (tags[CLASSIFICATION_TAG] !== proposal.classification) return refuse(403, 'UNCLASSIFIED', 'the conversation is not at the proposal\'s classification');
    if (String(tags.archived) === 'true') return refuse(409, 'ARCHIVED', 'the conversation is archived');
  } catch (err) {
    const n = nameOf(err);
    if (n === 'ForbiddenException' || n === 'NotFoundException' || n === 'BadRequestException') return refuse(403, 'NOT_A_MEMBER', 'only a member of the conversation decides its proposals');
    console.error('[Proposals] the conversation could not be read', { err: n });
    return refuse(503, 'PROPOSALS_UNAVAILABLE', 'the conversation could not be read');
  }
  const stillAddressed = await addresseeRefusal(proposal, callerArn, d).catch((err) => {
    console.error('[Proposals] the participant roles could not be read', { err: nameOf(err) });
    return refuse(503, 'PROPOSALS_UNAVAILABLE', 'the conversation\'s participant roles could not be read');
  });
  if (stillAddressed) return stillAddressed;

  // ONCE: the consuming update names the addressee, so only this person's decision is recorded, and only the first. An
  // apply is CLAIMED (`applying`) before its act runs, so a second apply is refused while it runs, and its outcome is
  // recorded only once the act answers.
  const decision = body.decision === 'apply' ? 'applying' : 'declined';
  const consumed = await redeemToken(docOf(d), e.tokensTable, 'proposal', handle, {
    now, channelArn: proposal.channelArn, match: { personArn: callerArn }, extra: { decision },
  });
  if (!consumed.ok) {
    const code = consumed.reason === 'consumed' ? 'PROPOSAL_DECIDED' : consumed.reason === 'expired' ? 'PROPOSAL_EXPIRED' : 'NOT_ADDRESSEE';
    return refuse(consumed.reason === 'expired' ? 410 : consumed.reason === 'consumed' ? 409 : 403, code, `the proposal cannot be decided: ${consumed.reason}`);
  }
  const audit = (outcome: string) => console.log(JSON.stringify({ _auditEvent: 'proposal_decided', decision: outcome, op: proposal.op, channelArn: proposal.channelArn, decidedBy: callerArn, workflow: proposal.workflow, step: proposal.step }));
  if (decision === 'declined') {
    audit('declined');
    return http.respond(200, { declined: true, op: proposal.op });
  }
  // THE ACT, THEN ITS OUTCOME, TRUTHFULLY: `applied` once it was done; an act refused outright is released, so the person
  // may apply again; an act whose answer says nothing of its outcome is released only where asking again cannot do it
  // twice, and is otherwise recorded `failed`. The audit line says which.
  let act: { result: HttpResult; done: boolean } | undefined;
  try {
    act = await performAct(proposal, callerArn, address, d);
  } catch (err) {
    console.error('[Proposals] an applied proposal\'s act did not answer', { op: proposal.op, err: nameOf(err) });
  }
  const outcome = act?.done ? 'applied' : act || ACT_REPEATABLE[proposal.op] ? 'released' : 'failed';
  try {
    if (outcome === 'released') await releaseProposal(docOf(d), e.tokensTable, handle, callerArn);
    else await settleProposal(docOf(d), e.tokensTable, handle, callerArn, outcome);
  } catch (err) {
    // The claim stands: nothing is applied twice, and the audit line records what the act came to.
    console.error('[Proposals] the proposal\'s outcome could not be recorded; its claim stands', { op: proposal.op, outcome, err: nameOf(err) });
  }
  audit(outcome);
  if (act) return act.result;
  return outcome === 'released'
    ? refuse(502, 'APPLY_FAILED', 'the proposal could not be applied just now; it is still yours to apply')
    : refuse(502, 'APPLY_FAILED', 'the proposal\'s act did not answer, so it may have been done; it is not tried again');
}

export const handler = async (event: any): Promise<HttpResult> => {
  await loadProfileRegistry();
  if (event?.httpMethod === 'OPTIONS') return http.empty(204);
  const route = String(event?.resource || event?.path || event?.rawPath || '');
  const method = String(event?.httpMethod || event?.requestContext?.http?.method || '');
  if (route.endsWith(PROPOSAL_APPLY_ROUTE) && method === 'POST') return applyProposal(event);
  return refuse(404, 'NOT_FOUND', 'no such route');
};
