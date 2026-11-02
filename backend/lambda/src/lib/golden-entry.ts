/**
 * WHAT A GOLDEN ENTRY CARRIES FROM THE ANSWER IT WAS NOMINATED FROM (ADR-065, migration 094).
 *
 * Pure, so the nomination's copy and the run's reading of it are pinned by unit tests.
 */
import { REPLY_PREFERENCES } from '../../../lib/config/reply-preferences.js';

/** How many turns before the request an entry keeps, so a follow-up question carries what it refers to. */
export const GOLDEN_PRECEDING_TURNS = 6;

export interface PrecedingTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The tools the answer called and the reply-preference keys it was answered under, from the answer's archived metadata.
 * Only keys and values the preference registry declares are kept, so nothing a person typed is copied.
 */
export function goldenSourceOf(metadata: Record<string, unknown> | null | undefined): {
  usedTools: string[];
  replyPreferences: Record<string, string> | null;
} {
  const calls = Array.isArray(metadata?.toolCalls) ? (metadata!.toolCalls as Array<{ name?: unknown }>) : [];
  const usedTools = [...new Set(calls.map((c) => c?.name).filter((n): n is string => typeof n === 'string' && !!n))].sort();
  const raw = metadata?.replyPreferences;
  const prefs: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && REPLY_PREFERENCES[k]?.values[v]) prefs[k] = v;
    }
  }
  return { usedTools, replyPreferences: Object.keys(prefs).length ? prefs : null };
}

/** The de-identified rows before the request, newest first as read, as the entry stores them: oldest first, text only. */
export function precedingTurnsOf(rowsNewestFirst: Array<{ actor_kind: string; text: string | null }>): PrecedingTurn[] {
  return [...rowsNewestFirst].reverse()
    .filter((r) => (r.text ?? '').trim())
    .map((r) => ({ role: r.actor_kind === 'assistant' ? 'assistant' : 'user', text: r.text as string }));
}

/**
 * The stored turns as the model's message list, ending on the request. Consecutive turns of one role are joined, because
 * the Converse API refuses two messages in a row from the same role, and a leading assistant turn is dropped for the same
 * reason (a conversation opens on the user's side).
 */
export function runMessages(preceding: unknown, request: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return joined([...storedTurns(preceding), { role: 'user', text: request }]);
}

function storedTurns(preceding: unknown): PrecedingTurn[] {
  return Array.isArray(preceding)
    ? (preceding as Array<Partial<PrecedingTurn>>).filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && t.text.trim())
      .map((t) => ({ role: t.role as PrecedingTurn['role'], text: t.text as string }))
    : [];
}

function joined(turns: PrecedingTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.text}`;
    else if (out.length || t.role === 'user') out.push({ role: t.role, content: t.text });
  }
  return out;
}

/** The transcript the judge reads, as the relevance rubric expects it. */
export function judgeTranscript(preceding: unknown): string {
  const msgs = joined(storedTurns(preceding));
  if (!msgs.length) return '(none — this is the first turn of the conversation)';
  return msgs.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n');
}
