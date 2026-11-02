/**
 * Who may answer a duel side that is waiting on the person (DESIGN-BATTLE, "A side parked on the person").
 *
 * A side parks on the person who ran `/battle`, and only that person's targeted reply resumes it: the
 * router reads the owner from the duel's own record and answers anyone else as ordinary conversation.
 * The client offers the "Reply to this side" control by the same rule, reading the owner the side's
 * `<!--battlewaiting-->` marker names. The marker is a display hint and the router stays the authority.
 */

/** The AppInstanceUser id at the end of a person's ARN (`.../user/<id>`), or null. */
export function personIdOfArn(arn: string | null | undefined): string | null {
  if (!arn) return null;
  const id = arn.split('/').pop();
  return id || null;
}

/**
 * Whether this viewer is offered the control for a waiting side.
 *
 * A marker that names no owner is offered to everyone: an unanswerable duel is worse than an
 * over-answerable one, and the router decides whose answer counts (`resolveActiveBattle`).
 */
export function mayAnswerSide(side: { ownerId?: string }, viewerArn: string | null | undefined): boolean {
  if (!side.ownerId) return true;
  return personIdOfArn(viewerArn) === side.ownerId;
}

/** A duel side waiting on the person, as its `<!--battlewaiting-->` marker states it. */
export interface WaitingSide {
  botArn: string;
  battleId: string;
  /** The AppInstanceUser id of the duel's owner; absent when the marker names none. */
  ownerId?: string;
}

/** A waiting side and the message it waits on. */
export interface LiveWaitingSide extends WaitingSide {
  /** The message carrying the side's live marker, where its control is drawn. */
  messageId: string;
}

/**
 * Every duel side in these messages that is waiting now, oldest first, with the message it waits on.
 *
 * A side waits while the latest message it parked on carries its marker. A later round message from the
 * same side means it moved on, which covers the moment between the resume and the marker coming down,
 * and a marker an earlier step left behind is superseded by the side's latest one.
 */
export function waitingSides(
  messages: ReadonlyArray<{ id: string; isBot?: boolean; sender?: { arn?: string }; battle?: unknown; battleWaiting?: WaitingSide }>,
): LiveWaitingSide[] {
  const byBot = new Map<string, LiveWaitingSide>();
  for (const m of messages) {
    if (m.battleWaiting) {
      byBot.delete(m.battleWaiting.botArn);
      byBot.set(m.battleWaiting.botArn, { ...m.battleWaiting, messageId: m.id });
    } else if (m.isBot && m.battle && m.sender?.arn) {
      byBot.delete(m.sender.arn);
    }
  }
  return Array.from(byBot.values());
}

/** The waiting sides this viewer is the one to answer (`mayAnswerSide`), oldest first. */
export function sidesWaitingOn(
  messages: Parameters<typeof waitingSides>[0],
  viewerArn: string | null | undefined,
): LiveWaitingSide[] {
  return waitingSides(messages).filter((side) => mayAnswerSide(side, viewerArn));
}
