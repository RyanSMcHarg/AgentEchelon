import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Assistant replies longer than this get a "Show more" collapse. */
export const MESSAGE_COLLAPSE_THRESHOLD = 1200;

/**
 * Message body renderer.
 *
 * Assistant messages render Markdown (GFM: headings, lists, tables, code,
 * links). react-markdown escapes/ignores raw HTML by default, so this is
 * XSS-safe without a separate sanitizer. User messages stay plain text — they
 * do not author Markdown, and rendering their input as Markdown could mangle it
 * (and widen the injection surface); plain text sits in `.message-text`, whose
 * `white-space: pre-wrap` preserves their line breaks.
 *
 * Long assistant messages collapse to a preview truncated at a sentence/word
 * boundary, with a Show more / Show less toggle.
 */
export function CollapsibleText({ content, isBot }: { content: string; isBot: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const collapsible = isBot && content.length > MESSAGE_COLLAPSE_THRESHOLD;
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

  const body = isBot ? (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown}</ReactMarkdown>
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
