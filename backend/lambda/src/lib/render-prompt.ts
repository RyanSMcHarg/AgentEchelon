/**
 * Fill a `{{placeholder}}` prompt template, once per placeholder, with nothing re-scanned.
 *
 * ── WHY THIS EXISTS, AND IT IS NOT TIDINESS ──────────────────────────────────────────────────────
 *
 * Chaining `.replace('{{field}}', value)` to build a prompt has two defects, and both are reachable
 * by anyone who can type a message into a conversation. Neither is an access break: what they corrupt
 * is the VERDICT, which every quality rate, the blocking-breach alert and any future calibration are
 * computed from. A measurement an ordinary member can steer is not a measurement.
 *
 * **1. `$` IS SPECIAL IN THE REPLACEMENT, NOT JUST IN THE PATTERN.** `String.prototype.replace` with a
 * string replacement expands `$&` (the match), `` $` `` (everything BEFORE the match), `$'`
 * (everything after) and `$$`. So a message containing `` $` `` splices the entire preceding rubric
 * into the middle of the evidence, and one containing `$'` splices what follows. A person does not
 * have to be attacking to trigger it - a shell snippet or a price list does it by accident - and the
 * judge then scores a prompt nobody wrote.
 *
 * **2. SUBSTITUTION IS ORDER-DEPENDENT, AND EACH CALL TAKES THE FIRST MATCH.** The transcript is
 * substituted before the turn's own fields, so a prior message containing the literal `{{userMessage}}`
 * receives the real user message, and the "Current Exchange" field two sections lower is left holding
 * a bare placeholder. The evidence is relocated to a position of the writer's choosing and the field
 * the rubric tells the judge to score is empty.
 *
 * ── HOW THIS FIXES BOTH AT ONCE ──────────────────────────────────────────────────────────────────
 *
 * One global pass with a REPLACER FUNCTION. A function's return value is used literally, so `$`
 * sequences are inert, and a single pass never re-scans what it just inserted, so a value containing
 * `{{anything}}` is text rather than a placeholder. The two defects have one cause - a value being
 * treated as pattern - and one fix.
 *
 * An unknown placeholder is LEFT AS-IS rather than blanked. A typo in a template should be visible in
 * the prompt a reader inspects, not silently become an empty section that reads as missing evidence.
 *
 * This does NOT make content safe to obey. It guarantees only that a value lands where the template
 * put it, intact. Whether a judge should treat enclosed text as evidence rather than instruction is a
 * separate question, answered by the rubric wording, not here.
 */

/** Values for a template's placeholders, keyed WITHOUT the braces. */
export type PromptFields = Record<string, string | null | undefined>;

/**
 * Render `template`, replacing each `{{key}}` with `fields[key]`.
 *
 * Null and undefined render as the empty string, so a caller can pass an absent optional field
 * without composing a conditional at every site.
 */
export function renderPrompt(template: string, fields: PromptFields): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return whole;
    const value = fields[key];
    return value == null ? '' : String(value);
  });
}
