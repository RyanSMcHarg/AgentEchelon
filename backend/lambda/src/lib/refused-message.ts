/**
 * A MESSAGE THE INPUT GUARDRAIL REFUSED STAYS OUT OF THE MODEL'S CONTEXT.
 *
 * The input guardrail scores the text of the turn it guards, so what it refused must never reach a model by another
 * road. The message stays in the conversation, because it is the record of what was said and every member can still
 * read it. What leaves is the MODEL's view: the history a turn is answered from and the running summary are built
 * without the refused message and the refusal that answered it, so a follow-up is scored and answered on its own.
 *
 * WHAT WAS REFUSED IS DECLARED, NEVER INFERRED. The turn the guardrail stopped declares `blocks=<the person's message>`, once for each message folded into it,
 * on the refusal it posts, and a declaration is read only off an assistant's message, so a person typing one into the
 * conversation refuses nothing (`turn-declaration.ts`, "why it cannot be forged"). A deployment's own refusal wording
 * reads the same, because nothing here looks at the words.
 */
import type { TranscriptMessage } from './moved-subject.js';
import { isPlaceholderMessage, turnDeclarationOf } from './turn-declaration.js';

/** The ids of every refused message and of the refusal that declares it. Empty when nothing was refused. */
export function refusedMessageIds(messages: readonly TranscriptMessage[]): Set<string> {
  const refused = new Set<string>();
  for (const m of messages) {
    if (!m.fromAssistant) continue;
    const { blocks } = turnDeclarationOf(m.content);
    if (!blocks?.length) continue;
    for (const id of blocks) refused.add(id);
    if (m.id) refused.add(m.id);
  }
  return refused;
}

/**
 * THE PEOPLE'S MESSAGES A TURN IS STILL DECIDING: while a turn is open (a placeholder newer than the last finished assistant
 * message), every person's message since that finished message. Whether the guardrail refuses one is known only when its
 * turn answers, so a record built for a model before then, the running summary, leaves them out and reads them on its
 * next build, when the refusal that answers them declares what it refused. Oldest first. Empty when no turn is open, so a
 * room where people talk among themselves is summarized in full.
 */
export function undecidedMessageIds(messages: readonly TranscriptMessage[]): Set<string> {
  let finished = -1;
  let open = -1;
  messages.forEach((m, i) => {
    if (!m.fromAssistant) return;
    if (isPlaceholderMessage(m.content)) open = i;
    else finished = i;
  });
  if (open <= finished) return new Set();
  return new Set(messages.slice(finished + 1).filter((m) => !m.fromAssistant && m.id).map((m) => m.id as string));
}
