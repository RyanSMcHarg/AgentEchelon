/**
 * ADDRESS A MEMBER FROM OUTSIDE THE COMPOSER: a part of the window that lists the conversation's members (the meeting's
 * roster) asks the composer to put a member into the draft, and the composer does it with its own picker's tokens
 * (`MessageInput`), so the member reads as the same chip a pick from `@` makes and the send carries their id.
 *
 * - `mention`: `@Name` at the caret, addressed in public, and never in front of a leading private address.
 * - `private`: `.Name` at the front of the message (after any `/md` command), a message to that member alone (ADR-034),
 *   replacing a private address already there and nothing else, so a leading `.env` stays the person's words.
 *
 * One composer listens per window; a request with no composer listening changes nothing.
 */
import type { ChannelMember } from '@ae/shared';

export type ComposerAddressMode = 'mention' | 'private';

export interface ComposerAddressRequest {
  member: Pick<ChannelMember, 'userArn' | 'name' | 'isBot'>;
  mode: ComposerAddressMode;
}

type Listener = (request: ComposerAddressRequest) => void;

const listeners = new Set<Listener>();

/** Ask the composer to address a member. Answers whether a composer heard it. */
export function requestComposerAddress(request: ComposerAddressRequest): boolean {
  for (const listener of listeners) listener(request);
  return listeners.size > 0;
}

/** The composer hears requests to address a member. Answers the stop. */
export function onComposerAddressRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
