/**
 * ROUTE A HANDOVER MESSAGE TO THE ASSISTANT IT IS FOR (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4).
 *
 * One function, two callers, so the bounds cannot drift between them:
 *  - the CHANNEL FLOW, for every released assistant-authored message carrying a handover marker. It
 *    finds the receiver from the address TOKEN, then confirms the stored `Target` names it.
 *  - POST-PROCESSING (`handover-backstop.ts`), which sees the `Target` on the stream record and delivers a
 *    handover the flow did not: one with no token, or whose token and `Target` disagree.
 *
 * Whichever dispatches first takes `deliveryClaimKey(person message, receiver)`; the other stops. The
 * receiving router then verifies the handover message again as its own bearer before it acts, so this
 * function is the router's FIRST check, not its only one.
 *
 * NOTHING HERE REPLIES TO ANYONE. Every refusal is logged and counted and ends quietly: the person was
 * answered by the handing-over assistant's acknowledgment, and a handover that cannot be delivered here
 * is the backstop's to deliver.
 */
import type { BypassMember } from './flow-bypass.js';
import { resolvePrivateTarget } from './private-prefix.js';
import { deliveryClaimKey, isAssistantArn, isPersonArn, parseHandover, type HandoverMarker } from './assistant-handover.js';

export interface StoredMessage {
  Sender?: { Arn?: string };
  Target?: Array<{ MemberArn?: string }> | null;
}

export interface HandoverDispatch {
  channelArn: string;
  receiverBotArn: string;
  handoverMessageId: string;
  marker: HandoverMarker;
  /** Whether the receiver's reply is addressed to the person alone. */
  privateToPerson: boolean;
}

export interface HandoverRoutingDeps {
  /** Read a message as `bearerArn`, retrying a read-after-write miss once. Null when unreadable. */
  readMessage(channelArn: string, messageId: string, bearerArn: string): Promise<StoredMessage | null>;
  /** The conversation's members, read live as `bearerArn`. Null when unreadable. */
  listMembers(channelArn: string, bearerArn: string): Promise<BypassMember[] | null>;
  claim(key: string): Promise<boolean>;
  dispatch(turn: HandoverDispatch): Promise<boolean>;
}

export type HandoverOutcome =
  | 'not-a-handover'
  | 'not-from-an-assistant'
  | 'no-token'
  | 'receiver-not-an-assistant-here'
  | 'target-mismatch'
  | 'target-unreadable'
  | 'references-a-non-person'
  | 'already-delivered'
  | 'dispatch-failed'
  | 'dispatched';

export async function routeHandover(input: {
  source: 'flow' | 'backstop';
  channelArn: string;
  handoverMessageId: string;
  senderArn: string;
  /** Decoded body. The flow routes from its token. */
  content: string;
  metadata: string | undefined;
  /** The stream record's `Target` (backstop only; the flow callback never carries it). */
  streamTarget?: Array<{ MemberArn?: string }> | null;
}, deps: HandoverRoutingDeps): Promise<HandoverOutcome> {
  const marker = parseHandover(input.metadata);
  if (!marker) return 'not-a-handover';
  const log = (outcome: HandoverOutcome, extra: Record<string, unknown> = {}): HandoverOutcome => {
    const line = { source: input.source, outcome, handoverMessageId: input.handoverMessageId, kind: marker.kind, ...extra };
    if (outcome === 'dispatched' || outcome === 'already-delivered') console.log('[Handover]', line);
    else console.warn('[Handover] not delivered', line);
    return outcome;
  };

  // Amazon Chime SDK stamps the sender, so a person cannot post a handover: a person's `.Ops` message is an
  // ordinary private address and never reaches here.
  if (!isAssistantArn(input.senderArn)) return log('not-from-an-assistant');

  const members = await deps.listMembers(input.channelArn, input.senderArn);
  const assistantsHere = (members || []).filter((m) => m.isBot && m.arn !== input.senderArn);

  let receiver: BypassMember | undefined;
  if (input.source === 'flow') {
    const named = resolvePrivateTarget(input.content, members || []);
    if (!named) return log('no-token');
    receiver = assistantsHere.find((m) => m.arn === named.arn);
    if (!receiver) return log('receiver-not-an-assistant-here', { named: named.arn.split('/').pop() });
    // THE TOKEN IS THE HINT, THE STORED TARGET IS THE FACT. Read back as the sender, which may always read
    // its own message.
    const stored = await deps.readMessage(input.channelArn, input.handoverMessageId, input.senderArn);
    if (!stored) return log('target-unreadable');
    if (!(stored.Target || []).some((t) => t.MemberArn === receiver!.arn)) return log('target-mismatch');
  } else {
    const targets = (input.streamTarget || []).map((t) => t.MemberArn || '').filter(Boolean);
    receiver = assistantsHere.find((m) => targets.includes(m.arn));
    if (!receiver) return log('receiver-not-an-assistant-here');
  }

  // ONE HOP, BY DATA. Only a message a PERSON sent may be handed over, and Amazon Chime SDK stamps who sent
  // it, so an assistant's own reply can never be handed on. Read as the sender, which received it.
  let privateToPerson = true;
  if (input.source === 'flow') {
    const person = await deps.readMessage(input.channelArn, marker.personMessageId, input.senderArn);
    if (!person || !isPersonArn(person.Sender?.Arn) || person.Sender?.Arn !== marker.personSenderArn) {
      return log('references-a-non-person');
    }
    privateToPerson = (person.Target || []).length > 0;
  }
  // The backstop answers privately: it runs only when something already went wrong, and over-privatizing
  // is the cheaper error (ADR-041 point 6). The receiving router still reads the person's message itself.

  if (!(await deps.claim(deliveryClaimKey(marker.personMessageId, receiver.arn)))) return log('already-delivered');

  const ok = await deps.dispatch({
    channelArn: input.channelArn,
    receiverBotArn: receiver.arn,
    handoverMessageId: input.handoverMessageId,
    marker,
    privateToPerson,
  });
  return log(ok ? 'dispatched' : 'dispatch-failed', { to: receiver.arn.split('/').pop() });
}
