/**
 * THE CORRELATION ID OF A TURN AN EVENT RUN HANDS TO THE PROCESSOR (ADR-061 decision 5): an agent step, or a `voice` send
 * (ADR-062 decision 4). The router records the turn's routing under this id before it invokes the processor, and the
 * processor vends its session from that record, so two turns that share an id share one record.
 *
 * The id is built from every part that tells two turns apart: the event, its natural key, the step, the assistant's bot
 * and, for a send fanned out to several groups of people, the group. Two events that share a natural key (an invitation's
 * `invitation-sent` and `invitation-unredeemed`, or a room's `assistant-joined` and `conversation-opened`) are two ids,
 * and so are two template groups of one send. It reads as its parts joined, within the routing table's 120 characters,
 * and always closes with a digest of the parts as a list, so neither a cut nor a hyphen inside a part merges two ids.
 */
import { createHash } from 'crypto';

export const EVENT_DISPATCH_ID_MAX = 120;
const DIGEST_LENGTH = 16;

export function eventDispatchId(kind: 'event' | 'voice', parts: ReadonlyArray<string | null | undefined>): string {
  const listed = parts.map((p) => (typeof p === 'string' ? p : ''));
  const digest = createHash('sha256').update(JSON.stringify([kind, ...listed])).digest('hex').slice(0, DIGEST_LENGTH);
  const readable = [kind, ...listed.filter(Boolean)].join('-').replace(/#/g, '-');
  return `${readable.slice(0, EVENT_DISPATCH_ID_MAX - DIGEST_LENGTH - 1)}-${digest}`;
}
