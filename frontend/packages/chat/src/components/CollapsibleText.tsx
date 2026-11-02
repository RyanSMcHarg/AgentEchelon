import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hasMarkdownPrefix, withoutMarkdownPrefix } from '../utils/markdownPrefix';

/** Messages longer than this get a "Show more" collapse. */
export const MESSAGE_COLLAPSE_THRESHOLD = 1200;

/**
 * A link opens away from the app and cannot reach back into it.
 *
 * `noopener` denies the opened page a handle on this window; `noreferrer` keeps the conversation's
 * URL out of the referrer. Applied to EVERY rendered message rather than only to a person's: the
 * exposure belongs to the renderer, and assistant output is the input a prompt injection reaches.
 */
/**
 * The ONE link shape this app navigates to in place: its own conversation deep link.
 *
 * WHY AN EXCEPTION EXISTS AT ALL. A drift-spawned conversation's welcome links back to the message
 * that spawned it - `[the conversation it came from](?conversation=<arn>#message=<id>)`, composed by
 * the platform in `channel-creation.ts`, not by a model. Opening that in a new tab means the link
 * does not take you back: the tab you are reading stays on the child. Measured live
 * (`drift-detection.spec.ts:376`): the header still read the child's title after the click, 33
 * resolutions over 30 seconds.
 *
 * WHY IT IS A SHAPE TEST AND NOT A TRUST DECISION. Nothing here knows who wrote the message, and an
 * injected one can spell this href just as well. It does not need to be trusted: the pattern admits
 * only a RELATIVE query string beginning `?conversation=`, so it cannot name another origin, and
 * following it runs `selectConversation`, which is authorized server-side - a conversation the person
 * is not a member of does not open because the link asked nicely. The worst an injected copy achieves
 * is moving someone between their own conversations, which is a nuisance and not a disclosure.
 *
 * That is strictly less reach than the `_blank` it replaces for this one shape: no window handle, no
 * referrer leaving the origin, no external page at all.
 */
const INTERNAL_CONVERSATION_LINK = /^\?conversation=[^/\\]*$/;

function isInternalConversationLink(href: string | undefined): boolean {
  if (!href) return false;
  // The hash carries `#message=<id>` and is not part of the origin question, so it is set aside
  // before the shape is judged.
  const [query] = href.split('#');
  return INTERNAL_CONVERSATION_LINK.test(query);
}

const MARKDOWN_COMPONENTS = {
  // `node` IS DROPPED, NOT SPREAD. react-markdown hands every custom component the mdast node, and
  // forwarding it to a DOM element makes React log "unknown prop" as an ERROR - which the e2e suite's
  // `guardConsoleErrors` treats as a failure, so a link in any rendered message would have failed
  // runs that have nothing to do with links.
  a: ({ children, node: _node, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) => (
    isInternalConversationLink(props.href)
      // SAME TAB, and no `rel` needed: this is a same-origin navigation to this app. The browser
      // loads `?conversation=...#message=...` and `App.tsx`'s existing deep-link effect selects the
      // conversation and focuses the message - the same path a shared link already uses, rather than
      // a second navigation mechanism beside it.
      ? <a {...props}>{children}</a>
      : <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

/**
 * Message body renderer.
 *
 * An assistant message renders Markdown (GFM: headings, lists, tables, code,
 * links). A person's message renders Markdown when they ASK for it, with the
 * `/md` command; otherwise it stays plain text.
 *
 * ── WHY OPT-IN, AND WHY A SLASH COMMAND ──
 *
 * Plain-by-default is right for a person: what they typed is what they meant,
 * and a literal `**` or a stray underscore should survive being sent. But it
 * was previously the only option, on the recorded grounds that users "do not
 * author Markdown" - which is not true of people who paste code and write
 * lists, in a product whose own rooms discuss code. So the fix is a way to say
 * "this one is formatted", not a change of default.
 *
 * `/md` FOLLOWS THE CONVENTION rather than inventing one. A leading slash is
 * how chat clients have taken per-message instructions since IRC's `/me`, and
 * it is how Matrix and Element spell this exact pair (`/html`, `/plain`). It is
 * also already the grammar of THIS product: `/battle` is a slash command parsed
 * at the start of the trimmed message, deliberately distinct from the `@` and
 * `.` tokens that ADDRESS somebody. `/md` is a rendering instruction, so a
 * command is the right shape - it says what to DO with the message, not who it
 * is for.
 *
 * IT IS CONTENT-CARRIED, and stripped here at display. That needs no metadata
 * field and no codebook entry, and every client reaches the same answer from
 * the message alone - the same reason a turn declaration rides the content on a
 * path that has no metadata channel.
 *
 * SAFETY IS UNCHANGED BY WHO WROTE IT. react-markdown drops raw HTML with no
 * sanitizer (pinned by the test beside this file) and sanitizes dangerous URL
 * protocols itself. What opt-in markdown does widen is SPOOFING - a link whose
 * text disagrees with its href - so links carry `noopener noreferrer` below,
 * which is a property of the renderer and improves assistant links too.
 *
 * THE COLLAPSE WAS A SEPARATE ASYMMETRY hiding in the same branch: `isBot`
 * gated it, so a pasted 5,000 character log rendered in full forever while a
 * model's reply of the same length got a Show more. Length is length, whoever
 * wrote it.
 */
export function CollapsibleText({ content, isBot }: { content: string; isBot: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const collapsible = content.length > MESSAGE_COLLAPSE_THRESHOLD;
  // The string actually shown: full content, or a truncated preview when
  // collapsed. Truncate at the last sentence/space inside the preview window so
  // we never cut mid-word; if no good boundary in the back half, hard-cut.
  let shown = content;
  if (collapsible && !expanded) {
    let cutAt = MESSAGE_COLLAPSE_THRESHOLD;
    const lastSentence = content.lastIndexOf('. ', MESSAGE_COLLAPSE_THRESHOLD);
    const lastSpace = content.lastIndexOf(' ', MESSAGE_COLLAPSE_THRESHOLD);
    if (lastSentence > MESSAGE_COLLAPSE_THRESHOLD * 0.6) cutAt = lastSentence + 1;
    else if (lastSpace > MESSAGE_COLLAPSE_THRESHOLD * 0.6) cutAt = lastSpace;
    shown = content.slice(0, cutAt).trim() + '…';
  }

  // An assistant always formats; a person formats when they asked to. The command itself is removed
  // so a reader sees its effect and never the instruction.
  const asMarkdown = isBot || hasMarkdownPrefix(content);
  const body = asMarkdown ? (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {isBot ? shown : withoutMarkdownPrefix(shown)}
      </ReactMarkdown>
    </div>
  ) : (
    shown
  );

  return (
    <div className={`message-text${collapsible ? ' message-text--collapsible' : ''}`}>
      {body}
      {collapsible && (
        <button
          type="button"
          className="message-text-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export default CollapsibleText;
