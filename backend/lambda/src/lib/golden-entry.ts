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

// ── THE EXCHANGE A MULTI-STEP ENTRY CARRIES (ADR-066 decision 7, migration 096) ─────────────────────────────────────

/** A person's turn of the source task, from the de-identified copy. */
export interface WalkPersonTurn {
  kind: 'person';
  text: string;
}

/** A tool call of the source task, with its result, both de-identified. `step` is the state the turn started in. */
export interface WalkToolTurn {
  kind: 'tool';
  name: string;
  /** The call's arguments as JSON text, as recorded (`ToolCallRecord.args`), de-identified. */
  args: string;
  /** The tool's result as JSON text, as recorded (`ToolCallRecord.result`), de-identified. */
  result: string;
  ok: boolean;
  step: string | null;
}

export interface WalkExchange {
  version: 1;
  /** The type of the task the answer belonged to. */
  taskType: string | null;
  turns: Array<WalkPersonTurn | WalkToolTurn>;
}

/** The most turns an exchange keeps: a walk is bounded by its machine, and a task longer than this is not a test case. */
export const WALK_EXCHANGE_MAX_TURNS = 60;

/** One archived turn of the source task, oldest first, as nomination reads it. */
export interface WalkSourceRow {
  user_mid: string;
  task_step: string | null;
  agent_metadata: Record<string, unknown> | null;
}

/**
 * The exchange a multi-step entry carries: every person turn of the task from the de-identified copy (`cleanByMid`,
 * keyed by the person message's id), and every tool call with its result, whose arguments and result pass through
 * `deIdentify` in one call. Null when a person turn has no de-identified copy yet, so the entry is never made from
 * raw text. Pure apart from the detector it is handed.
 */
export async function walkExchangeOf(
  rows: WalkSourceRow[],
  cleanByMid: ReadonlyMap<string, string>,
  taskType: string | null,
  deIdentify: (texts: string[]) => Promise<string[]>,
): Promise<WalkExchange | null> {
  const turns: Array<WalkPersonTurn | WalkToolTurn> = [];
  for (const r of rows) {
    const text = cleanByMid.get(r.user_mid);
    if (text === undefined) return null;
    if (text.trim()) turns.push({ kind: 'person', text });
    const calls = Array.isArray(r.agent_metadata?.toolCalls) ? (r.agent_metadata!.toolCalls as Array<Record<string, unknown>>) : [];
    for (const c of calls) {
      if (!c || typeof c.name !== 'string' || !c.name) continue;
      turns.push({
        kind: 'tool',
        name: c.name,
        args: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? null),
        result: typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? null),
        ok: c.ok !== false,
        step: r.task_step ?? null,
      });
    }
  }
  const kept = turns.slice(0, WALK_EXCHANGE_MAX_TURNS);
  const tools = kept.filter((t): t is WalkToolTurn => t.kind === 'tool');
  const masked = await deIdentify(tools.flatMap((t) => [t.args, t.result]));
  if (masked.length !== tools.length * 2) throw new Error(`detector returned ${masked.length} texts for ${tools.length * 2}`);
  tools.forEach((t, i) => { t.args = masked[2 * i]; t.result = masked[2 * i + 1]; });
  return { version: 1, taskType, turns: kept };
}

/** A stored exchange read back, or null when the entry carries none or it is not one this version reads. */
export function storedWalkExchange(value: unknown): WalkExchange | null {
  const v = (typeof value === 'string' ? safeJson(value) : value) as Partial<WalkExchange> | null;
  if (!v || v.version !== 1 || !Array.isArray(v.turns)) return null;
  const turns = v.turns.filter((t): t is WalkPersonTurn | WalkToolTurn =>
    !!t && ((t.kind === 'person' && typeof (t as WalkPersonTurn).text === 'string')
      || (t.kind === 'tool' && typeof (t as WalkToolTurn).name === 'string' && typeof (t as WalkToolTurn).args === 'string'
        && typeof (t as WalkToolTurn).result === 'string')));
  if (!turns.some((t) => t.kind === 'person')) return null;
  return { version: 1, taskType: typeof v.taskType === 'string' ? v.taskType : null, turns };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
