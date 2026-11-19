/**
 * WHAT A TURN AMAZON LEX ENTERED READS BACK FROM ITS OWN MESSAGE (ADR-036, ADR-035).
 *
 * Amazon Lex is handed the text and three request attributes, never the message's Metadata or its attachment, so a private
 * item answered by id (the client's `task.id` on a targeted message) and a file sent with it would be lost on that entry. The
 * router already reads the message back from Amazon Chime SDK to find it (`resolveOriginatingMessage`); the listing that finds
 * it carries its Metadata, and this reads the two facts from there, exactly as the channel flow reads them from the message it
 * is handed.
 *
 * What it guarantees:
 *  - THE SAME READERS THE FLOW USES (`extractTaskAnswerHint`, `extractAttachment`), so the two entries cannot disagree about
 *    what a message named.
 *  - AN ID IS HONORED ONLY WHERE THE TASK SERVICE SAYS ITS SENDER MAY ANSWER THAT ITEM (`answerableTaskById`), as the flow
 *    honors it, and the router intersects it with the rows the person holds or owns here, as it does a flow's declared id.
 *    A message with no sender, an id the service does not confirm, or a check that fails names no item.
 *  - MALFORMED METADATA IS AN ORDINARY MESSAGE: nothing is named and nothing is attached.
 */
import { extractTaskAnswerHint } from './task-answer-metadata.js';
import { extractAttachment, type MessageAttachment } from './battle-attachment.js';
import { personIdFromArn } from './person-arn.js';

export interface LexEnteredFacts {
  /** The open item the message answers, confirmed answerable by its sender. */
  answersTaskId?: string;
  /** The file the message carries. */
  attachment?: MessageAttachment;
}

export async function lexEnteredFacts(
  message: { metadata?: string } | undefined,
  turn: { channelArn: string; senderArn: string },
  answerable: (input: { channelArn: string; taskId: string; senderSub: string }) => Promise<{ taskId: string } | null>,
): Promise<LexEnteredFacts> {
  const metadata = message?.metadata;
  if (!metadata) return {};
  const attachment = extractAttachment(metadata);
  const named = extractTaskAnswerHint(metadata)?.taskId;
  const senderSub = personIdFromArn(turn.senderArn) || '';
  const confirmed = named && senderSub && turn.channelArn
    ? await answerable({ channelArn: turn.channelArn, taskId: named, senderSub }).catch(() => null)
    : null;
  return {
    ...(confirmed && confirmed.taskId === named ? { answersTaskId: named } : {}),
    ...(attachment ? { attachment } : {}),
  };
}
