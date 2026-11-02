/**
 * `/md` - the per-message request to render what follows as Markdown.
 *
 * WHY IT EXISTS. A person's message is plain text by default, which is the right default: what they
 * typed is what they meant, and a literal `**` or a stray underscore should survive being sent. What
 * was missing was any way to say otherwise, on the recorded assumption that users "do not author
 * Markdown" - untrue of people who paste code and write lists.
 *
 * WHY A SLASH COMMAND. A leading slash is how chat clients have taken per-message instructions since
 * IRC's `/me`, and it is how Matrix and Element spell this exact pair (`/html`, `/plain`). It is also
 * already this product's own grammar: `/battle` is a slash command parsed at the start of the trimmed
 * message, deliberately distinct from `@` and `.`, which ADDRESS somebody. `/md` says what to do with
 * the message rather than who it is for, so a command is the right shape.
 *
 * WHY IT IS NOT AN ADDRESSING TOKEN. It changes nothing about routing, delivery or who may read the
 * message. Callers that ask "is this a command?" for ROUTING purposes must therefore look past it -
 * see `withoutMarkdownPrefix`, which the composer applies before those checks so that answering a
 * work item in Markdown still answers the work item.
 *
 * Pure. No I/O.
 */

/**
 * Anchored, and case-insensitive because a command is not a password.
 *
 * The trailing whitespace requirement keeps `/mdx is a format` from being an instruction, the same
 * boundary rule `/battle` uses. A message that is ONLY `/md` formats nothing, because there is
 * nothing after it to format.
 */
const MARKDOWN_PREFIX = /^\s*\/md\s/i;

/** Did the author ask for this message to be rendered as Markdown? */
export function hasMarkdownPrefix(text: string): boolean {
  return MARKDOWN_PREFIX.test(text);
}

/**
 * The message without its `/md` command.
 *
 * Used at DISPLAY, so a reader never sees the instruction - only its effect. Also used by the
 * composer before any check that treats a leading slash as a command, so a formatted message is
 * still an ordinary message everywhere except the renderer.
 */
export function withoutMarkdownPrefix(text: string): string {
  return text.replace(MARKDOWN_PREFIX, '');
}
