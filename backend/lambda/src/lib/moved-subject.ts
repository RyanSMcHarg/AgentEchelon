/**
 * A SUBJECT MOVED TO ANOTHER CONVERSATION LEAVES THIS ONE'S CONTEXT.
 *
 * When a person accepts a drift offer, the subject goes to the conversation it moved to: a new one, or the
 * existing one the offer found. The messages that carried it stay in the original conversation, because they are
 * the record of what happened and every member can still read them. What leaves is the MODEL's view: the
 * history a turn is answered from and the running summary are built without them, so the next turn here is
 * answered on this conversation's own subject and the moved one does not drift back in (SPEC-DRIFT-CONVERGENCE,
 * "After a move").
 *
 * ── WHAT MOVED IS DECLARED, NEVER INFERRED ───────────────────────────────────────────────────────────────────
 *
 * The turn that acted on the person's yes declares the move on the reply it posts, `kind=drift;moves=<the
 * person's message>;answers=<their yes>`, and the link the original conversation receives declares the same
 * `moves`. The offer the person answered already declares `kind=drift;answers=<the person's message>`. So the
 * moved exchange is, exactly:
 *
 *   - the person's message the subject moved from (`moves`);
 *   - the assistant's offer about it (a drift declaration that `answers` it);
 *   - the person's yes (what the acting reply `answers`);
 *   - the acting reply and the link, each of which declares `moves`.
 *
 * A declaration is read only off an assistant's message, so a person typing one into the conversation moves
 * nothing (`turn-declaration.ts`, "why it cannot be forged"). A declined offer declares no `moves`, so it
 * removes nothing: a subject the person kept is a subject of this conversation.
 */
import { turnDeclarationOf } from './turn-declaration.js';

/** One message of a transcript, in whichever store it was read from. */
export interface TranscriptMessage {
  /** The Amazon Chime SDK `MessageId`. A message with none cannot be named by a declaration. */
  id?: string | null;
  /** Sent by an assistant. Only an assistant's message can declare anything. */
  fromAssistant: boolean;
  content?: string | null;
}

/**
 * The ids of every message that carried a subject moved out of this conversation, from the declarations in
 * the transcript. Empty when nothing moved.
 */
export function movedMessageIds(messages: readonly TranscriptMessage[]): Set<string> {
  const moved = new Set<string>();
  const declared = messages
    .filter((m) => m.fromAssistant)
    .map((m) => ({ id: m.id || undefined, d: turnDeclarationOf(m.content) }))
    .filter((m) => m.d.kind === 'drift');

  // The acting reply and the link: each names the message whose subject moved.
  for (const m of declared) {
    if (!m.d.moves) continue;
    moved.add(m.d.moves);
    if (m.id) moved.add(m.id);
    // The acting reply answers the person's yes.
    if (m.d.answers) moved.add(m.d.answers);
  }
  if (!moved.size) return moved;

  // The offer the person answered: a drift declaration answering a message whose subject moved.
  for (const m of declared) {
    if (m.id && m.d.answers && moved.has(m.d.answers)) moved.add(m.id);
  }
  return moved;
}
