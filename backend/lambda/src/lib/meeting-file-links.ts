/**
 * AN ASSISTANT USES A MEETING'S CONTENT, AND NEVER HANDS OVER ITS FILES (SPEC-ASSISTANT-MEETINGS FR28, FR57, FR70).
 *
 * What was said in a meeting (its transcript, its summary) is context an assistant answers from for anyone in the
 * meeting's conversation. Its transcript and recording files are its hosts' alone, signed by the presigner for a host
 * and nobody else, and opened from the ended card. So nothing a model reads names one: the links the platform writes
 * onto a card (`?transcript=<key>`, `meeting-transcript.ts`; `?recording=<key>`, `meeting-recording.ts`) are held out of
 * every message a turn hands the model, which keeps the words and drops the link, and no tool of the processor answers
 * a meeting file's key or a signed URL (`an-assistant-never-hands-over-a-meetings-files.test.ts`). These are links the
 * platform itself writes, matched as the platform's own pattern (tenet D11).
 *
 * What the assistant says when asked for a file is its guidance, a prompt template a team can reword
 * (`MEETING_FILES_PROMPT`): a host downloads it from the ended card, and anyone else asks a host.
 */

/** The prompt template that tells an assistant how to answer a request for a meeting's transcript or recording. */
export const MEETING_FILES_PROMPT = 'meeting-files-guidance';

/** The app link families a meeting's files are opened by. */
const FILE_PARAMS = ['transcript', 'recording'] as const;

/** A Markdown link to a meeting file: its words are kept, the link is not. */
const MARKDOWN_LINK = new RegExp(`\\[([^\\]]*)\\]\\(\\s*[^)\\s]*\\?(?:${FILE_PARAMS.join('|')})=[^)]*\\)`, 'g');
/** A bare meeting file link anywhere else in the text, up to the next space or bracket. */
const BARE_LINK = new RegExp(`[^\\s()\\[\\]]*\\?(?:${FILE_PARAMS.join('|')})=[^\\s()\\[\\]]*`, 'g');

/** Text with every meeting file link held out, and whether one was. */
export function withoutMeetingFileLinks(text: string): { text: string; held: boolean } {
  if (typeof text !== 'string' || !/\?(?:transcript|recording)=/.test(text)) return { text, held: false };
  const out = text.replace(MARKDOWN_LINK, '$1').replace(BARE_LINK, '');
  return { text: out, held: out !== text };
}

/**
 * HOLD EVERY MEETING FILE LINK OUT OF THE MESSAGES A TURN HANDS THE MODEL, in place. Answers whether one was held, so
 * the turn knows a meeting's files were spoken of and carries the guidance for them.
 */
export function holdMeetingFileLinks(messages: Array<{ content: unknown }>): boolean {
  let held = false;
  for (const m of messages) {
    if (typeof m?.content !== 'string') continue;
    const out = withoutMeetingFileLinks(m.content);
    if (out.held) { m.content = out.text; held = true; }
  }
  return held;
}
