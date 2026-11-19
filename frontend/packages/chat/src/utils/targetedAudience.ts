/**
 * WHO CAN SEE A TARGETED MESSAGE: a message sent with a Chime `Target` reaches its sender and its target alone, and says
 * so in itself. The sender reads it as theirs and the recipients', the recipient as theirs and the sender's.
 */
import type { Message } from '@ae/shared';

export type TargetedAudience =
  /** The reader sent it: `names` are its recipients, as the conversation names them (empty where none is known). */
  | { side: 'sender'; names: string[] }
  /** The reader is its recipient: `name` is its sender's (empty where none is known). */
  | { side: 'recipient'; name: string };

/** The audience a targeted message shows its reader, or null for a message the room reads. */
export function targetedAudienceOf(
  message: Pick<Message, 'sender' | 'targetArns' | 'targetedToUser'>,
  readerArn: string | null | undefined,
  members: ReadonlyArray<{ userArn: string; name?: string }>,
): TargetedAudience | null {
  const nameOf = (arn: string) => members.find((m) => m.userArn === arn)?.name?.trim() || '';
  const mine = !!readerArn && message.sender?.arn === readerArn;
  const targets = (message.targetArns ?? []).filter((arn) => arn && arn !== readerArn);
  if (mine && targets.length > 0) return { side: 'sender', names: targets.map(nameOf).filter(Boolean) };
  if (!mine && message.targetedToUser) {
    return { side: 'recipient', name: message.sender?.name?.trim() || (message.sender?.arn ? nameOf(message.sender.arn) : '') };
  }
  return null;
}
