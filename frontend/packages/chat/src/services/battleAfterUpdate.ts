import type { Message } from '@ae/shared';

/**
 * What a message's duel identity is after a live UPDATE lands on it.
 *
 * A duel side's placeholder carries the `<!--battle:-->` marker on its CREATE, and the answer UPDATE
 * that replaces its text carries none, so the identity is KEPT across the update and the side's
 * `<!--battlestats:-->` summary is merged onto it. That is what keeps the variant chip and the
 * scorecard rendering after the answer lands.
 *
 * A RECEIPT IS THE EXCEPTION. When a person answers a waiting duel side privately, the side's answer
 * is posted to the room as a new message and the private placeholder becomes the person's receipt
 * ("Thanks - picking that back up..."), declared `turnKind: 'receipt'` (`resumed-chain-delivery.ts`).
 * The receipt is no longer the side's answer and never receives a battlestats summary, so it carries
 * no duel identity. The history load agrees by construction: the stored receipt has no marker.
 */
export function battleAfterUpdate(
  previous: Message['battle'],
  update: Pick<Message, 'battle' | 'turnKind'>,
): Message['battle'] {
  if (update.turnKind === 'receipt') return undefined;
  return update.battle ? { ...(previous ?? {}), ...update.battle } : previous;
}
