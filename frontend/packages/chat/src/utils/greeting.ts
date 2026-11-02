/** The welcome copy shown as the empty-state of a new conversation. This is rendered by the frontend only:
 *  it is NOT sent as a Chime message. Earlier versions of AE posted this string into the channel via the
 *  user's identity on every channel create, which (a) showed up as a message authored by the user, (b)
 *  triggered an unwanted bot response, and (c) re-appeared at the top of every conversation instead of just
 *  the empty one. Keeping it client-side fixes all three. */
import type { UserTier } from '@ae/shared';

type Translate = (key: string, options?: { defaultValue?: string }) => string;

/**
 * The classification's welcome, from the locale (`newConversation.class.<value>.greeting`), or null for a
 * classification whose copy declares none: a deployment's own classification is welcomed in its own words, and
 * the empty state says nothing about a model or a capability it cannot know.
 */
export function getModelGreeting(tier: UserTier, t: Translate): string | null {
  if (!tier) return null;
  return t(`newConversation.class.${tier}.greeting`, { defaultValue: '' }) || null;
}
