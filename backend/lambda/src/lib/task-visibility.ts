/**
 * HOW A TASK'S VISIBILITY IS READ: THE ONE RULE EVERY READER USES (ADR-033, owner 2026-09-15).
 *
 * `conversation` is ADR-024 D4: the task is visible to the conversation's current members whatever
 * the owner. `private` is the existence rule: the room may learn THAT the task
 * exists and which assistant it occupies, and only its owner, its requester and its assigned assistant
 * read what it is.
 *
 * ABSENT READS AS PRIVATE. Only the literal value `conversation` makes a task shared; anything else,
 * including no value, a null, or a value no writer produces, reads as private. A task can be written
 * before its targeting is known (the channel flow callback carries no `Target`, so the router cannot
 * always tell), and reading that absence as shared published a targeted request's existence and label
 * to the room for as long as the turn ran. Failing closed costs a shared item a targeted answer that
 * could have been public; failing open discloses a private request, and that cannot be taken back.
 *
 * ITS OWN MODULE, with no runtime imports, so a light module (a ranking, a prompt builder) can apply
 * the rule without an edge to the task store, and so no reader writes its own `?? 'conversation'`.
 * Every writer that means a task to be shared therefore records `conversation` explicitly.
 */

export type TaskVisibility = 'conversation' | 'private';

/** The visibility a stored value reads as. Absent or unrecognized is `private`. */
export function readTaskVisibility(value: unknown): TaskVisibility {
  return value === 'conversation' ? 'conversation' : 'private';
}

/** Whether a stored visibility value reads as private. See `readTaskVisibility`. */
export function isPrivateVisibility(value: unknown): boolean {
  return readTaskVisibility(value) === 'private';
}

/**
 * Whether a value a CALLER sent names a visibility, for a writer that records only what was asked.
 *
 * A validation, not a reading: an unrecognized value is left unrecorded and then reads as private
 * through `readTaskVisibility`, so this never decides what absence means.
 */
export function isTaskVisibility(value: unknown): value is TaskVisibility {
  return value === 'conversation' || value === 'private';
}

/**
 * A REQUEST OPENED MID-TASK IS AS PRIVATE AS THE MESSAGE THAT ASKED IT (WT106): the stored message's Target decides, read
 * once and only when a request opens. A message sent to the room gives `conversation`; a targeted message, a message with
 * no id, and one that cannot be read give `private` (ADR-033: failing open discloses a private request).
 */
export async function requestVisibility(
  client: import('@aws-sdk/client-chime-sdk-messaging').ChimeSDKMessagingClient, channelArn: string, messageId: string | undefined, botArn: string,
): Promise<'conversation' | 'private'> {
  if (!messageId) return 'private';
  const { inboundTarget } = await import('./private-command.js');
  const read = await inboundTarget(client, channelArn, messageId, botArn).catch(() => 'unreadable' as const);
  return read === 'public' ? 'conversation' : 'private';
}
