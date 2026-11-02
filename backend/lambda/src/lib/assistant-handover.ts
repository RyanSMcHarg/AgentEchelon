/**
 * AN ASSISTANT HANDS A PERSON'S MESSAGE TO ANOTHER ASSISTANT WITH A MESSAGE, NOT AN INVOKE.
 *
 * DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4. The handing-over assistant posts a message TARGETED at
 * the receiving assistant, led by the receiver's address token (`.<Name|id>`), carrying a reference to the
 * person's message in its `Metadata`. The channel flow routes it (`channel-flow-processor.ts`, the
 * assistant branch), post-processing routes one the flow could not (`handover-backstop.ts`), and the
 * receiving router accepts a handed-over turn only after reading that message back and verifying it
 * (`verifyHandoverMessage`).
 *
 * WHY A MESSAGE. It is a stored conversation message under the same controls as every other one: the
 * sender's bearer is pinned to its own bot identity, Amazon Chime SDK lets only the sender and the `Target` read
 * it, and the receiver acts on what it reads rather than on a payload field. An assistant can no longer
 * start another assistant's turn by invoking the router with a different bot named in the payload: a
 * handed-over turn without a verifiable handover message in the conversation is refused.
 *
 * THE LOOP AND COST BOUNDS live here so the three components cannot disagree about them:
 *  - ONE HOP, BY DATA. A handover may only reference a message a PERSON sent (`Sender` is stamped by
 *    Amazon Chime SDK, not by the sender), so an assistant's own reply can never be handed on.
 *  - ONE TURN PER (person message, receiver). `deliveryClaimKey` is claimed by whichever of the flow and
 *    post-processing dispatches first; the other stops. It is separate from the sender's own
 *    `delegate-` / `handover-` keys, so the sender's dedup never blocks the delivery.
 *  - A MARKER AND A TOKEN, never a token alone. Model text that happens to start with `.Ops` carries no
 *    marker and is never routed.
 */

/** The `Metadata` key that marks a message as a handover. Written only by `handoverMetadata`. */
export const HANDOVER_METADATA_KEY = 'aeHandover';

export type HandoverKind = 'capability' | 'task';

export interface HandoverMarker {
  /** The PERSON's message being handed over. Must resolve to a message whose `Sender` is a person. */
  personMessageId: string;
  /** Who sent it. Checked against the message itself by the flow; carried so the backstop can address the reply. */
  personSenderArn: string;
  /** The person's message was addressed privately, so the receiver's answer is private to them too. */
  personWasPrivate?: boolean;
  /** `capability`: a question the receiver advertises. `task`: an answer to work the receiver owns. */
  kind: HandoverKind;
  /** The receiver's own advertised intent key, for a capability handover (see `TurnRequest.handedOverIntent`). */
  intent?: string;
  /** The task the person's message answers, for a task handover. */
  taskId?: string;
}

export function handoverMetadata(marker: HandoverMarker, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, [HANDOVER_METADATA_KEY]: marker });
}

/** The marker on a message's `Metadata`, or null when it is not a well-formed handover. */
export function parseHandover(metadata: string | undefined | null): HandoverMarker | null {
  if (!metadata) return null;
  try {
    const raw = (JSON.parse(metadata) as Record<string, unknown>)?.[HANDOVER_METADATA_KEY] as Partial<HandoverMarker> | undefined;
    if (!raw || typeof raw.personMessageId !== 'string' || !raw.personMessageId) return null;
    if (typeof raw.personSenderArn !== 'string' || !raw.personSenderArn.includes('/user/')) return null;
    if (raw.kind !== 'capability' && raw.kind !== 'task') return null;
    return {
      personMessageId: raw.personMessageId,
      personSenderArn: raw.personSenderArn,
      ...(raw.personWasPrivate === true ? { personWasPrivate: true } : {}),
      kind: raw.kind,
      ...(typeof raw.intent === 'string' && raw.intent ? { intent: raw.intent } : {}),
      ...(typeof raw.taskId === 'string' && raw.taskId ? { taskId: raw.taskId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The handover's body: the receiver's DELIMITED address token, which resolves by id (`private-prefix.ts`),
 * so the name a person sees and the name that resolves cannot disagree here.
 *
 * For a task handover the person's own words follow, because their answer may have been addressed
 * privately to the handing-over assistant, which the receiver cannot read. The handover is readable only by
 * its sender and its `Target`, so this reaches exactly the receiver, which is what the payload carried
 * before. A capability handover carries the reference only, and the receiver reads the person's message
 * itself (§3.4).
 *
 * Not person-facing copy: nobody but the two assistants can read it.
 */
export function handoverContent(receiver: { name: string; botArn: string }, personText?: string): string {
  const id = receiver.botArn.split('/').pop() || '';
  const token = `.<${receiver.name.replace(/[<>|\n]/g, ' ').trim()}|${id}>`;
  return personText ? `${token} ${personText}` : `${token} handover`;
}

/** The person's words carried on a task handover, with the address token removed. */
export function handoverCarriedText(content: string): string {
  const m = /^\s*\.<[^<>\n]{1,128}>\s?([\s\S]*)$/.exec(content || '');
  const rest = (m ? m[1] : '').trim();
  return rest === 'handover' ? '' : rest;
}

/** One delivery per (person message, receiver), shared by the flow and post-processing. */
export function deliveryClaimKey(personMessageId: string, receiverBotArn: string): string {
  return `deliver-${personMessageId}-${receiverBotArn.split('/').pop() || ''}`;
}

/** The kind tests live with the one ARN helper; re-exported for this module's existing importers. */
export { isAssistantArn, isPersonArn } from './person-arn.js';
