import { createContext, useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TOKEN_OPEN, encodeAddressTokens, type AddressableMember, type MemberNameResolver } from '@ae/shared/utils/addressTokens.ts';
import { remarkAddressChips, withAddressChips } from './addressChips';
import { hasMarkdownPrefix, withoutMarkdownPrefix } from '../utils/markdownPrefix';
import { meetingLinkConversation, meetingWindowRequest, openMeetingWindow } from '../utils/meetingWindow';
import { openConversationLinkInPlace } from '../hooks/useConversationDeepLink';
import { openTranscript, transcriptLinkTarget } from '../utils/transcriptLink';

/** An ended meeting card's hosts, by person id, and the reader's own id: its transcript and recording are the hosts'. */
export interface MeetingFiles { hosts: readonly string[]; viewerId: string }
const MeetingFilesContext = createContext<MeetingFiles | undefined>(undefined);

/**
 * A MEETING TRANSCRIPT'S OR RECORDING'S LINK (`?transcript=<key>`, `?recording=<key>`, `utils/transcriptLink.ts`): the server
 * signs it only for the meeting's hosts (SPEC-ASSISTANT-MEETINGS FR28, FR70). On a card that names its hosts, a host is offered
 * it to view and to download, and anyone else is told it is the hosts' instead of a link that would be refused. Either way
 * it says so in place when it could not be opened.
 */
function TranscriptAnchor({ transcript, children, ...props }: React.ComponentPropsWithoutRef<'a'> & { transcript: { key: string; conversationId: string } }) {
  const { t } = useTranslation();
  const files = useContext(MeetingFilesContext);
  const [failed, setFailed] = useState(false);
  // A CARD THAT NAMES NO HOST says nothing of who may have the file: the link is offered, and the server, which signs it for
  // a live moderator of the room in that case, decides; a refusal is said in place.
  if (files && files.hosts.length > 0 && !files.hosts.includes(files.viewerId)) {
    return <span className="ae-transcript-link-hosts-only">{children} <span className="ae-transcript-link-note">({t('meeting.transcriptLink.hostsOnly')})</span></span>;
  }
  const open = (download: boolean) => (e: React.MouseEvent) => {
    e.preventDefault();
    setFailed(false);
    void openTranscript(transcript, { download }).then((ok) => { if (!ok) setFailed(true); });
  };
  return (
    <>
      <a {...props} onClick={open(false)}>{children}</a>
      {files && (
        <> · <a href={props.href} className="ae-transcript-link-download" onClick={open(true)}>{t('meeting.transcriptLink.download')}</a></>
      )}
      {failed && <span className="ae-transcript-link-failed" role="alert"> {t('meeting.transcriptLink.failed')}</span>}
    </>
  );
}

/** A placeholder cut before it closed: its opener and any of its digits, at the end of a preview. */
const PARTIAL_PLACEHOLDER = new RegExp(`${TOKEN_OPEN}\\d*$`);

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
 * The link shape this app navigates to in place: its own conversation deep link (and its meeting link, below).
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
  a: ({ children, node: _node, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
    // THIS APP'S MEETING LINK (`?meeting=<conversation id>`, `utils/meetingWindow.ts`) opens the conversation's meeting
    // window beside the app. The same shape test as a conversation link: a relative query naming an id, so it names no
    // other origin, and joining checks membership on the server. An href that does not decode is an ordinary link.
    const transcript = transcriptLinkTarget(props.href);
    if (transcript) return <TranscriptAnchor {...props} transcript={transcript}>{children}</TranscriptAnchor>;
    const meetingFor = meetingLinkConversation(props.href);
    return meetingFor
      ? (
        <a
          {...props}
          onClick={(e) => {
            e.preventDefault();
            openMeetingWindow(meetingFor);
          }}
        >
          {children}
        </a>
      )
      : isInternalConversationLink(props.href) && meetingWindowRequest() !== null
      // IN A MEETING WINDOW, A NEW TAB: the window is its one meeting, so the conversation opens beside it as the app, and
      // the meeting this window holds goes on. `noopener` gives the tab its own session, so it is the app, not this meeting.
      ? <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
      : isInternalConversationLink(props.href)
      // IN PLACE, and no `rel` needed: the app selects the conversation and focuses the message by the
      // deep link's own rule (`useConversationDeepLink.ts`), with no page load, so the app and its
      // messaging session stay as they are. A click that asks for another tab or window (a modifier key,
      // a middle click) is the browser's, and an app not ready to open it follows the address in this
      // tab, which the deep link opens on load.
      ? (
        <a
          {...props}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            if (props.href && openConversationLinkInPlace(props.href)) e.preventDefault();
          }}
        >
          {children}
        </a>
      )
      : <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
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
export function CollapsibleText({
  content,
  isBot,
  resolveName,
  members,
  meetingFiles,
}: {
  content: string;
  isBot: boolean;
  /** The conversation's members by id, so a mention shows the member's current name. */
  resolveName?: MemberNameResolver;
  /** The conversation's members, people and assistants alike, so a typed `@Name` of any of them is a chip. */
  members?: ReadonlyArray<AddressableMember>;
  /** On an ended meeting card: its hosts and the reader, so its transcript and recording are offered to the hosts alone. */
  meetingFiles?: MeetingFiles;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  // EVERY MENTION AND PRIVATE ADDRESS IS A CHIP, IN EVERY MESSAGE. The stored text carries
  // `@<Name|id>` and `.<Name|id>` for the server, and a typed `@Name` of any member reads the same;
  // each becomes a placeholder here, before the collapse and before markdown, so a cut never splits a
  // token and markdown never reads a name.
  const encoded = useMemo(() => encodeAddressTokens(content, members), [content, members]);
  const source = encoded.text;

  const collapsible = source.length > MESSAGE_COLLAPSE_THRESHOLD;
  // The string actually shown: full content, or a truncated preview when
  // collapsed. Truncate at the last sentence/space inside the preview window so
  // we never cut mid-word; if no good boundary in the back half, hard-cut.
  let shown = source;
  if (collapsible && !expanded) {
    let cutAt = MESSAGE_COLLAPSE_THRESHOLD;
    const lastSentence = source.lastIndexOf('. ', MESSAGE_COLLAPSE_THRESHOLD);
    const lastSpace = source.lastIndexOf(' ', MESSAGE_COLLAPSE_THRESHOLD);
    if (lastSentence > MESSAGE_COLLAPSE_THRESHOLD * 0.6) cutAt = lastSentence + 1;
    else if (lastSpace > MESSAGE_COLLAPSE_THRESHOLD * 0.6) cutAt = lastSpace;
    // A hard cut inside a placeholder drops the partial placeholder, so its digits never show; every other cut keeps the
    // text as written, a number at the cut included.
    shown = source.slice(0, cutAt).replace(PARTIAL_PLACEHOLDER, '').trim() + '…';
  }

  const labels = useMemo(
    () => ({ privateTitle: (name: string) => t('message.privateAddressTitle', { name }) }),
    [t],
  );
  const chipPlugin = useMemo(
    () => remarkAddressChips(encoded.tokens, labels, resolveName),
    [encoded.tokens, labels, resolveName],
  );

  // An assistant always formats; a person formats when they asked to. The command itself is removed
  // so a reader sees its effect and never the instruction.
  const asMarkdown = isBot || hasMarkdownPrefix(content);
  const body = asMarkdown ? (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, chipPlugin]} components={MARKDOWN_COMPONENTS}>
        {isBot ? shown : withoutMarkdownPrefix(shown)}
      </ReactMarkdown>
    </div>
  ) : (
    withAddressChips(shown, encoded.tokens, labels, resolveName)
  );

  return (
    <div className={`message-text${collapsible ? ' message-text--collapsible' : ''}`}>
      <MeetingFilesContext.Provider value={meetingFiles}>{body}</MeetingFilesContext.Provider>
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
