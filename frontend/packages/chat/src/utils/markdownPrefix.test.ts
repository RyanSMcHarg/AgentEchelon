import { describe, it, expect } from 'vitest';
import { hasMarkdownPrefix, withoutMarkdownPrefix } from './markdownPrefix';

/**
 * `/md` - the per-message request to render what follows as Markdown.
 *
 * A person's message is plain text by default, which is the right default: what they typed is what
 * they meant. What was missing was any way to say otherwise, on the recorded assumption that users
 * "do not author Markdown" - untrue of people who paste code and write lists.
 *
 * A leading slash is how chat clients have taken per-message instructions since IRC's `/me`, and how
 * Matrix and Element spell this exact pair (`/html`, `/plain`). It is also already this product's own
 * grammar: `/battle` is a slash command parsed at the start of the trimmed message.
 */
describe('the /md command', () => {
  it('is recognised at the start of a message', () => {
    expect(hasMarkdownPrefix('/md **bold** and `code`')).toBe(true);
  });

  it('tolerates leading whitespace, as the other slash command does', () => {
    expect(hasMarkdownPrefix('   /md a list')).toBe(true);
  });

  it('is case-insensitive, because a command is not a password', () => {
    expect(hasMarkdownPrefix('/MD **bold**')).toBe(true);
    expect(hasMarkdownPrefix('/Md **bold**')).toBe(true);
  });

  it('is ANCHORED, so it is an instruction only when it leads', () => {
    // Otherwise any message that happened to discuss the command would format itself.
    expect(hasMarkdownPrefix('use /md to format')).toBe(false);
    expect(hasMarkdownPrefix('the flag is --md')).toBe(false);
  });

  it('needs a boundary, so a longer word starting with md is not the command', () => {
    // The same rule `/battle` uses, and for the same reason: over-matching silences what somebody
    // actually typed.
    expect(hasMarkdownPrefix('/mdx is a format')).toBe(false);
    expect(hasMarkdownPrefix('/mdown please')).toBe(false);
  });

  it('formats nothing when there is nothing after it', () => {
    // `/md` alone has no message to format, so it is not an instruction.
    expect(hasMarkdownPrefix('/md')).toBe(false);
  });

  it('does not collide with the other slash command', () => {
    expect(hasMarkdownPrefix('/battle tabs or spaces')).toBe(false);
  });

  it('strips the command and leaves the message exactly as written', () => {
    expect(withoutMarkdownPrefix('/md **bold**')).toBe('**bold**');
    expect(withoutMarkdownPrefix('  /MD # Heading')).toBe('# Heading');
  });

  it('leaves an ordinary message untouched', () => {
    // Including one that merely mentions the command, which must not be edited on its author.
    expect(withoutMarkdownPrefix('use /md to format')).toBe('use /md to format');
    expect(withoutMarkdownPrefix('**bold**')).toBe('**bold**');
  });

  it('strips only the LEADING command, not a later occurrence', () => {
    expect(withoutMarkdownPrefix('/md see /md in the docs')).toBe('see /md in the docs');
  });
});
