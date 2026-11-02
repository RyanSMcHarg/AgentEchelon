/**
 * REPLY PREFERENCES: what a person asked for about HOW they are answered, applied to every reply.
 *
 * SPEC-USER-PROFILE-AND-ONBOARDING separates `preferences` (what the person asked for) from `facts`
 * (what they told us) and from identity (what the provider asserts). A preference here is a CHOICE
 * among values this registry declares, never free text:
 *
 * - THE STORED VALUE IS A KEY, NOT THE PERSON'S WORDS. An onboarding answer or a tool call resolves to
 *   one of the declared value keys, and only that key is written to the profile. Anything that does not
 *   resolve is re-asked or refused.
 * - THE PROMPT TEXT IS THE PLATFORM'S. Each value carries its own instruction, written here, and that is
 *   what reaches the model. No text the person typed is ever replayed into a later prompt, so a
 *   preference cannot carry an instruction the deployment did not write.
 * - IT DESCRIBES THE PERSON, so it applies in every conversation and with every assistant, which is why
 *   asking once is enough.
 *
 * Tracked platform config, read by the router (intake and per-turn read), the processor (prompt and the
 * update tool) and tests. Adding a preference or a value is a reviewed change, like a new tool.
 */

export interface ReplyPreferenceValue {
  /** How the value is shown to the person: in the intake summary and the tool's confirmation. */
  label: string;
  /** What a person may type to choose this value, matched as whole words after normalization. */
  aliases: string[];
  /** The instruction this value adds to every reply. Platform text, never the person's. */
  instruction: string;
}

export interface ReplyPreference {
  key: string;
  /** Shown in the prompt block and the tool description. */
  title: string;
  values: Record<string, ReplyPreferenceValue>;
}

export const REPLY_PREFERENCES: Record<string, ReplyPreference> = {
  answerStyle: {
    key: 'answerStyle',
    title: 'Answer style',
    values: {
      brief: {
        label: 'just the figure',
        aliases: ['just the figure', 'the figure', 'figure', 'just the number', 'the number', 'number', 'brief', 'short', 'concise', 'just the answer'],
        instruction: 'Lead with the answer itself - the figure, name or decision - in one or two sentences, and stop. '
          + 'Add the comparison, trend or risk only when this person asks for it.',
      },
      explained: {
        label: 'the figure with what it means',
        aliases: ['the figure with what it means', 'with what it means', 'what it means', 'explained', 'explain', 'context', 'detail', 'detailed', 'more detail', 'full'],
        instruction: 'Give the answer first, then the comparison, trend or risk that makes it useful, in a short paragraph '
          + 'or a few bullets.',
      },
      // A REAL ANSWER, NOT AN ABSENCE. Choosing it completes onboarding like any other
      // value, so nobody is re-offered forever, and it adds no instruction: the assistant answers as its
      // configuration says. It stays changeable through the `set_preference` intent.
      none: {
        label: 'no preference',
        aliases: ['no preference', 'none', 'either', 'either is fine', 'either way', 'no thanks', 'doesn t matter', 'does not matter', 'whatever'],
        instruction: '',
      },
    },
  },
};

/**
 * Words a person adds around an answer without changing it ("just the figure, please"). Removed only for
 * the STRICT match below, which has to tell an answer from a request.
 */
const FILLER = new Set(['please', 'thanks', 'thank', 'you', 'i', 'id', 'd', 'like', 'prefer', 'want', 'would', 'go', 'with', 'ok', 'okay', 'sure', 'yes', 'yeah']);

function normalize(text: string): string {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * The value key a person's answer chooses for `preferenceKey`, or null when it chooses none or more
 * than one. Longest alias wins, so "the figure with what it means" chooses `explained` even though it
 * also contains "the figure".
 */
export function resolvePreferenceValue(preferenceKey: string, answer: string): string | null {
  const pref = REPLY_PREFERENCES[preferenceKey];
  if (!pref) return null;
  const text = normalize(answer);
  let best: { value: string; length: number } | null = null;
  let tie = false;
  for (const [value, def] of Object.entries(pref.values)) {
    for (const alias of [def.label, ...def.aliases]) {
      const a = normalize(alias);
      if (!text.includes(a)) continue;
      const length = a.length;
      if (!best || length > best.length) {
        best = { value, length };
        tie = false;
      } else if (length === best.length && best.value !== value) {
        tie = true;
      }
    }
  }
  return best && !tie ? best.value : null;
}

/**
 * The value a reply to an OFFER chooses, or null. Strict: the whole message, less filler words, must be
 * one of the value's phrases. An offer stays pending across a conversation, so every later message is
 * checked against it, and "what's our ARR, and what it means?" must stay a question rather than be read
 * as choosing `explained`. The `set_preference` intent uses the looser `resolvePreferenceValue`, because
 * there the classifier has already decided the person is asking for a change.
 */
export function resolvePreferenceAnswer(preferenceKey: string, answer: string): string | null {
  const pref = REPLY_PREFERENCES[preferenceKey];
  if (!pref) return null;
  const strip = (s: string) => normalize(s).trim().split(' ').filter((w) => w && !FILLER.has(w)).join(' ');
  const said = strip(answer);
  if (!said) return null;
  for (const [value, def] of Object.entries(pref.values)) {
    for (const phrase of [def.label, ...def.aliases]) {
      const p = strip(phrase);
      if (p && p === said) return value;
    }
  }
  return null;
}

/** True when `value` is a declared value key of `preferenceKey`. */
export function isPreferenceValue(preferenceKey: string, value: unknown): value is string {
  return typeof value === 'string' && !!REPLY_PREFERENCES[preferenceKey]?.values[value];
}

/** "just the figure, or the figure with what it means", for a re-ask. */
export function preferenceChoices(preferenceKey: string): string {
  const labels = Object.values(REPLY_PREFERENCES[preferenceKey]?.values ?? {}).map((v) => v.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}` : labels.join('');
}

/**
 * Only the declared preferences with declared values, from whatever the store returned. A key or value
 * this registry does not declare is dropped, so a record written by an older registry, or by hand,
 * cannot reach the prompt.
 */
export function knownPreferences(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isPreferenceValue(key, value)) out[key] = value;
  }
  return out;
}

/** The platform instructions for a person's preferences, one line per preference, in registry order. */
export function preferenceInstructions(preferences: Record<string, string>): string[] {
  const known = knownPreferences(preferences);
  return Object.values(REPLY_PREFERENCES)
    // A value with no instruction ("no preference") adds nothing to the prompt.
    .filter((p) => known[p.key] && p.values[known[p.key]].instruction)
    .map((p) => `${p.title}: ${p.values[known[p.key]].instruction}`);
}
