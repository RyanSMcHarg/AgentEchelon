/**
 * What a message bubble shows, from the raw Amazon Chime SDK Content.
 *
 * Decode (`decodeMessageText`), unwrap a bare Lex envelope, then strip the platform's markers with the
 * same parser the chat app uses (`parseMessageContent`), so the widget never shows a marker the
 * platform wrote. Matching those markers is matching what the platform wrote, never what a person or a
 * model said (tenet D11).
 */
import { decodeMessageText, parseMessageContent } from '@ae/shared/utils/messageParser.ts';
import { readableAddressText, shownAssistantText } from '@ae/shared/utils/addressTokens.ts';

/**
 * Structurally unwrap a Lex fulfillment envelope (`{"Messages":[{"Content":...}]}`): only an object whose
 * only key is a non-empty `Messages` array of `{Content}` is unwrapped, so a prose answer that happens to
 * contain JSON is untouched. History reads do not carry the Lex ContentType the chat app gates on.
 */
export function unwrapLexStructural(s: string): string {
  if (!s.startsWith('{') || !s.includes('"Messages"')) return s;
  try {
    const p = JSON.parse(s) as { Messages?: Array<{ Content?: string }> };
    if (p && Array.isArray(p.Messages) && p.Messages.length > 0 && typeof p.Messages[0]?.Content === 'string' && Object.keys(p).length === 1) {
      return p.Messages.map((m) => m.Content ?? '').join('\n');
    }
  } catch {
    /* not an envelope */
  }
  return s;
}

/**
 * The text a bubble shows: decoded, unwrapped, markers stripped (and any remaining HTML comment), mentions by name. On a
 * message an assistant sent, the `@humans` address at its front is not shown, as in the chat app (`shownAssistantText`).
 */
export function displayText(rawContent: string | undefined, fromAssistant = false): string {
  const unwrapped = unwrapLexStructural(decodeMessageText(rawContent ?? ''));
  const content = parseMessageContent(unwrapped).content.replace(/<!--[\s\S]*?-->/g, '');
  return readableAddressText(fromAssistant ? shownAssistantText(content) : content).trim();
}
