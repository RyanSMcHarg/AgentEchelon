/**
 * THE PERSONA'S DECLARED SECTIONS, AND MOVING A TESTED INSTRUCTION INTO ONE.
 *
 * A persona is an assistant's full system prompt, and how the assistant answers in general belongs in it, under
 * the platform's "How to answer:" section. A version's `systemPromptAddendum` is something else: the instruction an
 * experiment tests on top of the persona (`personaAddendumBlock` in `active-profile.ts`). Once a duel's winner is
 * promoted, the instruction it carried is part of how the assistant answers, so the console offers to move it into
 * the persona (`movedIntoPersona`), and the person reviews the draft and activates it as usual.
 *
 * Everything here is PURE: it takes strings and returns a value, so the console and any import or CLI path share one
 * rule, and each case is unit-testable on real personas.
 *
 * THE HEADING IS THE PLATFORM'S OWN MARKER (tenet D11). `HOW_TO_ANSWER_HEADING` is the line the shipped personas
 * (`backend/demo/personas.ts`) open that section with, so finding it is matching what the platform wrote, the same
 * kind of match as a `<!--corr:-->` marker. Nothing here reads what a person wrote to decide anything: a persona that
 * names its section in other words, or in another language, keeps every word it has, and the moved instruction lands
 * at its end under the platform's heading, where the person sees it in the draft before activating.
 */

/** The line that opens a persona's general answer-style section: the platform's declared section marker. */
export const HOW_TO_ANSWER_HEADING = 'How to answer:';

/** The bullet a moved instruction takes when the section has none of its own to match. */
const DEFAULT_BULLET = '- ';

/** A list item's leading marker: indentation, then `-`, `*`, `+`, `•`, or a number with `.` or `)`, then a space. */
const BULLET = /^(\s*)(?:([-*+•])|(\d+)([.)]))(\s+)/;

export type MoveIntoPersona =
  | { ok: true; persona: string }
  /** The version has no persona of its own, so it answers from the deployment's; writing one here would replace it. */
  | { ok: false; reason: 'no-persona' }
  /** The version carries no instruction to move. */
  | { ok: false; reason: 'no-addendum' }
  /** The persona with the instruction moved in would exceed `max`. */
  | { ok: false; reason: 'too-long'; length: number; max: number };

/** The marker the next item of a list takes, matching the item it follows: the same bullet, or the next number. */
function nextMarker(line: string): string {
  const m = BULLET.exec(line);
  if (!m) return DEFAULT_BULLET;
  const [, indent, bullet, num, close, space] = m;
  return bullet ? `${indent}${bullet}${space}` : `${indent}${Number(num) + 1}${close}${space}`;
}

/**
 * THE PERSONA WITH THE TESTED INSTRUCTION MOVED INTO ITS "How to answer:" SECTION, as one new list item after the
 * section's last item, in that item's style. Without the section, the persona gains it at its end, holding the one
 * item. The instruction is joined onto one line, so it reads as one item.
 *
 * The section runs from its heading to the first paragraph that is not part of a list: a non-blank line after a blank
 * line that is not a list item. A line directly under an item, with no blank line between, continues that item.
 *
 * Refused, with the reason, when the version has no persona or no instruction, or when the result would be longer
 * than `max` (the write path's `MAX_PERSONA_LENGTH`).
 */
export function movedIntoPersona(persona: string | undefined, addendum: string | undefined, max: number): MoveIntoPersona {
  const instruction = (addendum ?? '').split(/\s*\r?\n\s*/).map((s) => s.trim()).filter(Boolean).join(' ');
  if (!instruction) return { ok: false, reason: 'no-addendum' };
  if (!persona || !persona.trim()) return { ok: false, reason: 'no-persona' };

  const eol = persona.includes('\r\n') ? '\r\n' : '\n';
  const lines = persona.split(/\r?\n/);
  const heading = lines.findIndex((l) => l.trim() === HOW_TO_ANSWER_HEADING);

  let result: string;
  if (heading === -1) {
    result = `${persona.replace(/\s+$/, '')}${eol}${eol}${HOW_TO_ANSWER_HEADING}${eol}${DEFAULT_BULLET}${instruction}`;
  } else {
    // The section's last line, and the last list item in it, which the new item follows and matches.
    let last = heading;
    let lastItem = -1;
    for (let i = heading + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const item = BULLET.test(line);
      if (!item && !lines[i - 1].trim() && i > heading + 1) break;
      last = i;
      if (item) lastItem = i;
    }
    const marker = lastItem === -1 ? DEFAULT_BULLET : nextMarker(lines[lastItem]);
    lines.splice(last + 1, 0, `${marker}${instruction}`);
    result = lines.join(eol);
  }
  if (result.length > max) return { ok: false, reason: 'too-long', length: result.length, max };
  return { ok: true, persona: result };
}
