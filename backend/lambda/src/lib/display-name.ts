/**
 * WHAT AN ASSISTANT MAY BE CALLED, decided once (DESIGN-SEPARATE-ASSISTANTS section 3.0).
 *
 * A display name is checked in TWO places that cannot see each other: `validateBody` refuses a bad
 * one before a version is published, and the applier refuses it again before it reaches the identity.
 * They are separate processes with separate deploys, so the rules live here rather than in either -
 * a name that passed the first and failed the second would leave a version active and the bot wearing
 * the old name, which is the split-brain the rename work exists to remove.
 *
 * THE BOUNDS ARE THE SERVICE'S, not a preference. Amazon Chime SDK caps an `AppInstanceBot` `Name` at
 * 100 characters and refuses control characters, so a longer or stranger name is not a policy choice
 * this platform is making - it is a call that would be rejected at the identity.
 */

/** The service's cap on an `AppInstanceBot` `Name`. */
export const MAX_DISPLAY_NAME_LENGTH = 100;

/**
 * Errors for a display name, empty when it is acceptable.
 *
 * ABSENT IS NOT BLANK, and the distinction is load-bearing. `undefined` means "inherit the configured
 * default" and is valid; a blank or whitespace-only string is a name nobody can address and is not.
 * Callers that must have a name pass `{ required: true }`.
 */
export function displayNameErrors(value: unknown, opts?: { required?: boolean }): string[] {
  if (value === undefined) {
    return opts?.required ? ['displayName is required'] : [];
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return ['displayName must be a non-empty string, or absent to inherit the profile default'];
  }
  if (value.length > MAX_DISPLAY_NAME_LENGTH) {
    return [`displayName is ${value.length} characters; the identity it is set on caps at ${MAX_DISPLAY_NAME_LENGTH}`];
  }
  // Control characters, matched by CODE POINT rather than by a literal range in a regex. The first
  // version of this check embedded the raw characters, which made every file containing it read as
  // binary to `grep` and to any tool that samples for NUL - the rule became unreadable in review.
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return ['displayName contains a control character'];
  }
  return [];
}
