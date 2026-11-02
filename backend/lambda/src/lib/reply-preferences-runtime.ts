/**
 * Reply preferences at turn time (SPEC-USER-PROFILE-AND-ONBOARDING, preferences).
 *
 * Two directives, both rendered from the registry (`lib/config/reply-preferences.ts`), so neither can
 * carry words the deployment did not write:
 *
 * - `replyPreferencesDirective`: the person's saved preferences, applied to every reply.
 * - `preferenceTurnDirective`: this turn set, could not resolve, or listed a preference. The ROUTER did
 *   the storing (it owns the profile store's writes); the assistant only says what happened, in its own
 *   persona and the conversation's language.
 */
import { REPLY_PREFERENCES, preferenceInstructions } from '../../../lib/config/reply-preferences.js';

/**
 * What the router decided about preferences on this turn, attached to the dispatch.
 *
 * - `set`: one or more preferences were saved; `saved` maps each preference to its new value.
 * - `choose`: the person asked for a change the router could not resolve to a value.
 * - `show`: the person asked what is saved; `current` is what the store holds.
 * - `failed`: a resolved change could not be written.
 */
export type PreferenceTurn =
  | { action: 'set'; saved: Record<string, string> }
  | { action: 'choose' }
  | { action: 'show'; current: Record<string, string> }
  | { action: 'failed' };

/**
 * The block that makes a person's preferences shape this reply. Empty when they have none, so a turn
 * without preferences reads exactly as before. Per person, so it belongs in the dynamic (uncached)
 * suffix of the system prompt, beside the identity directive.
 */
export function replyPreferencesDirective(preferences: Record<string, string> | undefined): string {
  const lines = preferenceInstructions(preferences ?? {});
  if (!lines.length) return '';
  return '\n\n<reply_preferences>\n'
    + 'The person you are answering chose how they want replies. Follow these in every reply, unless '
    + 'their message asks for something different this time:\n'
    + `${lines.map((l) => `- ${l}`).join('\n')}\n</reply_preferences>`;
}

const label = (key: string, value: string) => REPLY_PREFERENCES[key]?.values[value]?.label;

function choicesLine(): string {
  return Object.values(REPLY_PREFERENCES)
    .map((p) => `${p.title}: ${Object.values(p.values).map((v) => `"${v.label}"`).join(', ')}`)
    .join('; ');
}

/** What to tell the person about this turn's preference action. '' when there was none. */
export function preferenceTurnDirective(turn: PreferenceTurn | undefined): string {
  if (!turn) return '';
  let body: string;
  if (turn.action === 'set') {
    const saved = Object.entries(turn.saved)
      .map(([k, v]) => `${REPLY_PREFERENCES[k]?.title ?? k}: ${label(k, v) ?? v}`)
      .join('; ');
    body = `This message saved the person's preference (${saved}). Confirm it in one short sentence: it applies `
      + 'to every conversation, and they can change it any time by asking. Then answer anything else their '
      + 'message asked, following the preference.';
  } else if (turn.action === 'choose') {
    body = 'This person asked to change how they are answered, but not to one of the available choices. Ask '
      + `which they want, naming the choices: ${choicesLine()}. Nothing has been saved yet.`;
  } else if (turn.action === 'show') {
    const lines = Object.values(REPLY_PREFERENCES).map((p) => {
      const v = turn.current[p.key];
      return `${p.title}: ${(v && label(p.key, v)) || 'not set'}`;
    });
    body = `This person asked what their saved preferences are. Tell them: ${lines.join('; ')}. Mention that `
      + `they can change any of them by asking, and the choices: ${choicesLine()}.`;
  } else {
    body = 'This person asked to change how they are answered, and the change could NOT be saved. Say so '
      + 'plainly and suggest trying again shortly. Do not say it was saved.';
  }
  return `\n\n<preference_update>\n${body}\n</preference_update>`;
}
