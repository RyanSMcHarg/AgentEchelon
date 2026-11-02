/**
 * A PROPOSAL IS A CONSEQUENTIAL ACT A PERSON CONFIRMS (ADR-061 decision 8, rules 7 and 8; DESIGN-ASSISTANT-MEETINGS
 * B.2, PROPOSE-AND-CONFIRM).
 *
 * An agent step that declares `propose` drafts its proposal: the turn's whole output is the draft, and nothing it says
 * executes. The processor records the proposal in the token store as a `proposal` record and offers it to the one
 * person the step addresses, as a targeted message carrying a confirmation card (`proposal` on its Metadata). The
 * person applies or declines it at the apply endpoint (`proposals-api.ts`), which performs the act holding the grant
 * the assistant does not.
 *
 * WHO MAY APPLY IT. The record names its addressee's AppInstanceUser (`personArn`), and the apply endpoint:
 *  - authorizes the caller the edge resolved (`callerPerson`) against that id, in the conditional update that consumes
 *    the record, so another member is refused at the store and not only in the handler;
 *  - refuses an assistant's session, which is never a person's;
 *  - re-checks, at apply time, that the caller is still a member and still the person the step addressed them as
 *    (the invitation's inviter, read from its record, or the holder of a participant role, read from the context row);
 *  - consumes it once (`redeemToken`), so a second apply is refused, and refuses it past `expiresAt`.
 *
 * WHAT IT HOLDS. Ids and the draft: the op, the conversation, the addressee, the run and step that drafted it, the
 * invitation (`send_nudge`) or the conversation type (`open_conversation`). Never an address: the inviter types the
 * invitee's address when they confirm a reminder, and it is used for that one email and stored nowhere (K2).
 *
 * THE DRAFT IS DATA. It passed the output guardrail and the marker strip in the turn; here it is held to the rule for
 * anything that reaches a person not reading the room (rule 6): no link, no `@` handle and no address, so room
 * content and an inviter's words cannot steer what an outsider receives. A draft that carries one is refused, and the
 * step posts its fallback instead.
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HANDLE, LINK } from './voice-fill.js';
import { isProposalOp, type ProposalOp } from './event-workflow.js';
import { newPlatformToken, putToken, tokenKey, tokenRecordOf, type TokenRecord } from './tokens.js';

type Sender = { send(command: unknown): Promise<any> };

/** How long a proposal may be applied: three days, the window an inviter or an organizer reads it in. */
export const PROPOSAL_TTL_SECONDS = 3 * 24 * 3600;
/** The longest draft a proposal carries. */
export const PROPOSAL_DRAFT_MAX = 1000;
/** The longest label an `open_conversation` draft gives the new conversation. */
export const PROPOSAL_LABEL_MAX = 80;

/** How the step addressed the person a proposal is for, which the apply endpoint checks again. */
export type ProposalAddressee = 'invitation:inviter' | 'joined' | 'subject' | 'event:person' | `participantRole:${string}`;

/** What a proposal record carries beside the fields every token record does. */
export interface ProposalFields {
  op: ProposalOp;
  /** The classification of the conversation the step ran in, read from its immutable tag by the router. */
  classification: string;
  addressedAs: ProposalAddressee;
  workflow: string;
  step: string;
  runKey: string;
  /** The draft the turn wrote, held to `proposalDraftRefusal`. */
  draft: string;
  /** `send_nudge`: the invitation it reminds the invitee of. */
  invitationId?: string;
  /** `open_conversation`: the declared conversation type the step opens. */
  conversationType?: string;
  /**
   * Set by the apply endpoint. `declined` at once; for an apply, `applying` while its act runs (the claim, so a second
   * apply is refused), then `applied` when the act was done, or `failed` when it may have been done in part and so is
   * not tried again. An act refused outright releases the claim, and the proposal is undecided again.
   */
  decision?: 'applying' | 'applied' | 'declined' | 'failed';
}

export type ProposalRecord = TokenRecord & ProposalFields;

/** What a confirmation card carries on its message's Metadata: the proposal's handle, never its record. */
export interface ProposalCard {
  /** The single-use handle the apply endpoint is called with. Only the addressee receives the message carrying it. */
  id: string;
  op: ProposalOp;
  /** Epoch seconds. */
  expiresAt: number;
}

/**
 * WHY A DRAFT IS NOT SENT ON (decision 8, rule 6), or undefined: empty, or carrying a link, an `@` handle or an address
 * or an email address. The platform adds the only link a proposal's act sends.
 */
export function proposalDraftRefusal(draft: string): 'empty' | 'link' | 'handle' | 'address' | undefined {
  const text = draft.trim();
  if (!text) return 'empty';
  if (new RegExp(LINK.source, 'i').test(text) || /\bwww\.[^\s]+\.[a-z]{2,}/i.test(text)) return 'link';
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return 'address';
  if (new RegExp(HANDLE.source).test(text)) return 'handle';
  return undefined;
}

/** The draft as a record holds it: one block of text, trimmed and capped. */
export function proposalDraft(text: string, op: ProposalOp): string {
  const max = op === 'open_conversation' ? PROPOSAL_LABEL_MAX : PROPOSAL_DRAFT_MAX;
  const one = op === 'open_conversation' ? text.replace(/\s+/g, ' ').trim() : text.trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** A new proposal's record and the handle its card carries. Pure, so the shape is testable without a table. */
export function proposalRecordOf(args: {
  channelArn: string;
  addresseeArn: string;
  fields: ProposalFields;
  now: number;
  /** Epoch seconds; a proposal never outlives what it acts on. */
  notAfter?: number;
  token?: string;
}): { token: string; record: ProposalRecord; card: ProposalCard } {
  const token = args.token ?? newPlatformToken();
  const expiresAt = Math.min(args.now + PROPOSAL_TTL_SECONDS, args.notAfter ?? Number.POSITIVE_INFINITY);
  const record = tokenRecordOf('proposal', token, {
    ...args.fields,
    channelArn: args.channelArn,
    personArn: args.addresseeArn,
    issuer: 'platform',
    expiresAt,
    createdAt: new Date(args.now * 1000).toISOString(),
  }) as ProposalRecord;
  return { token, record, card: { id: token, op: args.fields.op, expiresAt } };
}

/** Write a proposal once. Its key is the hash of a fresh 256-bit handle, so it never collides. */
export async function writeProposal(doc: Sender, table: string, record: ProposalRecord): Promise<void> {
  await putToken(doc, table, record);
}

/**
 * RECORD WHAT AN APPLIED PROPOSAL'S ACT CAME TO: `applied` once it was done, `failed` when it may have been done in part.
 * Only the addressee's own claim (`applying`) is settled, once.
 */
export async function settleProposal(doc: Sender, table: string, handle: string, addresseeArn: string, outcome: 'applied' | 'failed'): Promise<void> {
  await doc.send(new UpdateCommand({
    TableName: table, Key: { pk: tokenKey('proposal', handle) },
    UpdateExpression: 'SET #d = :d',
    ConditionExpression: '#d = :applying AND personArn = :p',
    ExpressionAttributeNames: { '#d': 'decision' },
    ExpressionAttributeValues: { ':d': outcome, ':applying': 'applying', ':p': addresseeArn },
  }));
}

/**
 * RELEASE AN APPLY WHOSE ACT WAS REFUSED OUTRIGHT, so nothing happened: the claim is taken off and the proposal is
 * undecided again, for its addressee to apply again before it expires. Only the addressee's own claim is released.
 */
export async function releaseProposal(doc: Sender, table: string, handle: string, addresseeArn: string): Promise<void> {
  await doc.send(new UpdateCommand({
    TableName: table, Key: { pk: tokenKey('proposal', handle) },
    UpdateExpression: 'REMOVE consumedAt, #d',
    ConditionExpression: '#d = :applying AND personArn = :p',
    ExpressionAttributeNames: { '#d': 'decision' },
    ExpressionAttributeValues: { ':applying': 'applying', ':p': addresseeArn },
  }));
}

/** A proposal record as the apply endpoint reads it, or null for anything else. */
export function isProposalRecord(r: TokenRecord | null | undefined): r is ProposalRecord {
  return !!r && r.kind === 'proposal' && isProposalOp(r.op) && typeof r.classification === 'string' && typeof r.addressedAs === 'string';
}

/** Read a proposal by the handle a card carries, consistently. */
export async function readProposal(doc: Sender, table: string, handle: string): Promise<ProposalRecord | null> {
  if (!handle) return null;
  const item = (await doc.send(new GetCommand({ TableName: table, Key: { pk: tokenKey('proposal', handle) }, ConsistentRead: true })))?.Item as TokenRecord | undefined;
  return isProposalRecord(item) ? item : null;
}

/** Why a caller may not decide a proposal, before anything is consumed. */
export type ProposalRefusal = 'unknown' | 'assistant' | 'not-addressee' | 'decided' | 'expired';

/**
 * WHETHER THIS CALLER MAY DECIDE THIS PROPOSAL NOW (rule 8): a person's session, the addressee's, before it was decided
 * and before it expires. Pure; the consuming update holds the same conditions, so a race is refused at the store.
 */
export function proposalRefusal(record: ProposalRecord | null, callerArn: string, now: number): ProposalRefusal | undefined {
  if (!record) return 'unknown';
  if (!callerArn.includes('/user/') || callerArn.includes('/bot/')) return 'assistant';
  if (record.personArn !== callerArn) return 'not-addressee';
  if (record.consumedAt !== undefined || record.decision !== undefined) return 'decided';
  if (!(record.expiresAt > now)) return 'expired';
  return undefined;
}
