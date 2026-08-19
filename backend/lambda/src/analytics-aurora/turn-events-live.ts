/**
 * THE LEDGER'S LIVE WRITER (row 50 step 3).
 *
 * `turn_events` has existed since migration 019 and until now nothing wrote to it at RUNTIME - only
 * `turn-events-backfill.ts`, run by hand over history. A table with a shape and no contents is the
 * "inert mechanism" shape this repo keeps finding: `v_turn_latency` and `v_task_resolution` are built,
 * documented and empty, so every claim resting on them is unprovable.
 *
 * This emits one row per observed, timestamped fact, from the archival path that already sees every
 * Chime event and already holds the Aurora connection - no new Lambda, stream, bucket or IAM role.
 *
 * WHY IT RIDES ARCHIVAL'S BATCH. Same invocation, same transaction boundary, same failure semantics.
 * A ledger written by a second consumer could disagree with `messages` about what happened, and
 * reconciling two archives is the problem the ledger exists to remove.
 *
 * ------------------------------------------------------------------------------------------------
 * KIND IS DERIVED FROM THE DECLARED PHASE, AND FAILS CLOSED INTO "NOT FINAL".
 *
 * `respPhase` (ADR row 49) is stamped by the producer on every update. The mapping below is the whole
 * of the finality decision on this path, and an unrecognised phase becomes `progress_update` - never
 * `final_response`. That is the forward-looking guarantee: a phase invented later by a component that
 * has not been taught about latency cannot silently close a turn early.
 * ------------------------------------------------------------------------------------------------
 */

import { batchInsert } from './db-client.js';
import { TERMINAL_TASK_STATUS } from '../lib/task-tracking.js';
import { correlationMarkerOf } from '../lib/correlation.js';

/** The subset of the archival record this needs. Deliberately narrow: the ledger stores no content. */
export interface LedgerSourceRecord {
  event_type: string;
  message_id: string;
  channel_arn: string;
  sender_arn: string | null;
  is_bot: boolean;
  created_at: string;
  last_updated_at: string | null;
  resp_phase: string | null;
  /** What caused the turn, as the producer declared it. Absent ⇒ derived as before. */
  trigger_kind?: string | null;
  content: string | null;
  task_id: string | null;
  task_state: string | null;
  /** Lifecycle status after this turn ('completed' / 'failed' / ...). The product's own terminal signal. */
  task_status?: string | null;
  /** The declared-graph edge this turn applied, when it applied one (SPEC-TASK-STATE-TRANSITIONS). */
  task_transition?: { from: string; to: string } | null;
}

export interface TurnEventRow {
  kind: string;
  turn_id: string | null;
  response_id: string | null;
  turn_id_source: string | null;
  trigger_kind: string | null;
  actor: string | null;
  source_message_id: string;
  source_event_type: string;
  channel_arn: string;
  occurred_at: string;
  clock: string;
  auditable: boolean;
  task_id: string | null;
  task_state: string | null;
  /** Only on a `task_terminal` row: how the task ended. NULL everywhere else. */
  terminal_kind?: string | null;
}

/**
 * The turn id a message declares, or null. The marker IS what makes a message a placeholder.
 *
 * Reads through `correlationMarkerOf` - the lib reader every other consumer uses - rather than a
 * fourth hand-copied regex. The copy this replaces re-hardcoded the 64-character bound and omitted
 * the URL-decoded fallback, so archival content that arrived still percent-encoded (the archival
 * pre-decode skips content whose decode throws) filed real placeholders as ordinary bot messages
 * while the lib reader recognized them - the reader/writer disagreement the correlation module was
 * created to end. The SQL copies keep their literals (a SQL string cannot import), pinned by
 * correlation-id-is-readable.test.ts; a TypeScript reader has no such excuse.
 */
export function declaredTurnId(content: string | null): string | null {
  return correlationMarkerOf(content ?? '') ?? null;
}

/**
 * The ledger kind for an UPDATE, from the phase the producer declared.
 *
 * ONLY `final` MAY CLOSE A TURN. Everything else - including a phase this function has never heard of
 * - is a step along the way. `error` is deliberately NOT final: the person's wait ended, but no answer
 * was produced, and folding a failure's duration into time-to-answer would make a broken turn read as
 * a fast one.
 */
export function kindForPhase(phase: string | null): string {
  switch (phase) {
    case 'final': return 'final_response';
    case 'error': return 'error_response';
    case 'notice': return 'notice_posted';
    case 'placeholder': return 'placeholder_posted';
    case 'interim': return 'progress_update';
    default: return 'progress_update';
  }
}

/**
 * Ledger rows for one archival batch.
 *
 * PURE, so the mapping is testable without a database - which matters because the mapping IS the
 * finality decision, and a decision that can only be exercised through Postgres does not get exercised.
 */
/**
 * How a task ended, from the lifecycle status the product already writes.
 *
 * `cancelled` and `abandoned` are both endings and they are NOT the same ending: one is a decision, the
 * other is a task nobody came back to. Folding them together would make "how do tasks end here" a
 * question the ledger cannot answer, which is the class of loss this whole row exists to fix.
 */
// THE PRODUCT'S OWN MAP, imported rather than copied. The hand-written copy this replaces had
// already diverged: it mapped abandoned -> 'expired' while task-tracking deliberately keeps
// 'abandoned' out of its terminal set ("the person may come back") - so the ledger recorded an
// ending for a task the product still treats as resumable, and every future terminal status added
// to one copy and not the other would surface as an analytics-vs-truth investigation instead of a
// compile error. 'expired' stays a legal kind in the schema for the day the product itself makes
// abandonment terminal; nothing emits it until then.
export function terminalKindFor(status: string | null | undefined): string | null {
  return (status && TERMINAL_TASK_STATUS[status as keyof typeof TERMINAL_TASK_STATUS]) || null;
}

/**
 * The task-shaped ledger rows a single archived record implies, if any.
 *
 * Returns [] for every record without a task, which is most of them - so this is inert on a deployment
 * that runs no task workflows, and byte-identical to the previous ledger for those turns.
 */
export function taskLedgerRows(
  r: LedgerSourceRecord,
  base: Omit<TurnEventRow, 'kind' | 'turn_id' | 'response_id' | 'turn_id_source' | 'trigger_kind' | 'occurred_at'>,
): TurnEventRow[] {
  if (!r.task_id) return [];
  // An UPDATE dates its events to the update instant; a CREATE to its own. Same rule the response
  // kinds already follow, and it matters here because resolve_ms is measured between these two.
  const occurred_at = r.event_type === 'UPDATE_CHANNEL_MESSAGE'
    ? (r.last_updated_at ?? r.created_at)
    : r.created_at;
  const common = { ...base, occurred_at, turn_id: declaredTurnId(r.content), response_id: null,
    turn_id_source: null, trigger_kind: null };

  const out: TurnEventRow[] = [];
  const edge = r.task_transition;
  if (edge) {
    // No `from` means nothing preceded this state: the task is being opened, not moved.
    if (!edge.from) out.push({ ...common, kind: 'task_opened' });
    else out.push({ ...common, kind: 'task_transition' });
  }
  const terminal = terminalKindFor(r.task_status);
  if (terminal) out.push({ ...common, kind: 'task_terminal', terminal_kind: terminal });
  return out;
}

export function ledgerRowsFor(records: LedgerSourceRecord[]): TurnEventRow[] {
  const rows: TurnEventRow[] = [];

  for (const r of records) {
    const base = {
      channel_arn: r.channel_arn,
      source_message_id: r.message_id.replace(/-(UPD|DEL|RED)$/, ''),
      source_event_type: r.event_type,
      actor: r.sender_arn,
      clock: 'chime',
      auditable: true,
      task_id: r.task_id,
      task_state: r.task_state,
    };

    const createdBase = { ...base, occurred_at: r.created_at };


    if (r.event_type === 'CREATE_CHANNEL_MESSAGE') {
      const turnId = declaredTurnId(r.content);
      if (r.is_bot && turnId) {
        // A bot message carrying the marker IS the placeholder, and it declares its own turn id.
        //
        // `trigger_kind` is left NULL rather than guessed. The backfill derives it from whether an
        // exchange paired - a join this path cannot do, because the pairing has not happened yet when
        // the placeholder is archived. A guess here would be a second, disagreeing source for the one
        // fact that decides whether a TTFF is meaningful (row 50).
        // THE DECLARED CAUSE, when the producer gave one. This was null and left for the backfill to
        // infer from whether an exchange paired - a join this path cannot do, because pairing has not
        // happened yet when the placeholder is archived. A DECLARED value is not an inference, so it
        // is preferred over one; absent, the behaviour is exactly as before.
        rows.push({ ...createdBase, kind: 'placeholder_posted', turn_id: turnId, response_id: r.message_id,
          turn_id_source: 'declared', trigger_kind: r.trigger_kind ?? null });
      } else if (r.is_bot) {
        // A bot message with no marker: a continuation chunk, or a message the assistant volunteered.
        // Recorded so the event exists, and NOT as a response - it has no placeholder of its own, and
        // counting it as one is the "counted MESSAGES where it meant RESPONSES" mistake this file's
        // own header records costing a drift investigation.
        rows.push({ ...createdBase, kind: 'continuation_chunk', turn_id: null, response_id: null,
          turn_id_source: null, trigger_kind: null });
      } else {
        // The person's message: the turn anchor. `turn_id` is NOT resolvable here - the processor is
        // never handed the user's Chime MessageId, so the binding is made later by pairing. Recording
        // it as `paired` with a null id states that honestly rather than inventing a key.
        rows.push({ ...createdBase, kind: 'user_message', turn_id: null, response_id: null,
          turn_id_source: 'paired', trigger_kind: 'user' });
      }
      continue;
    }

    if (r.event_type === 'UPDATE_CHANNEL_MESSAGE') {
      // THE ONE THAT CAN CLOSE A TURN, and only when the producer said so - and only when the
      // producer is a BOT. A person editing their own message is not a response event: without this
      // gate the edit fabricated a progress_update row whose response_id was the user's message id,
      // which surfaced as a spurious response in the turn audit and the unclosed-split populations.
      if (!r.is_bot) continue;
      rows.push({
        ...base,
        kind: kindForPhase(r.resp_phase),
        turn_id: declaredTurnId(r.content),
        response_id: base.source_message_id,
        turn_id_source: null,
        trigger_kind: null,
        // The UPDATE's own instant, which is what `agent_final_at` is derived from. `created_at`
        // prefers the ORIGINAL CreatedTimestamp and would date the close to when the placeholder was
        // posted - reporting every turn as instantaneous.
        occurred_at: r.last_updated_at || r.created_at,
      } as TurnEventRow);
      continue;
    }

    if (r.event_type === 'REDACT_CHANNEL_MESSAGE' || r.event_type === 'DELETE_CHANNEL_MESSAGE') {
      // Same is_bot rule: moderating a PERSON's message is real and archived, but it is not a
      // response event, and a response-shaped row for it would pollute the same populations.
      if (!r.is_bot) continue;
      rows.push({
        ...base,
        kind: r.event_type === 'REDACT_CHANNEL_MESSAGE' ? 'content_redacted' : 'message_deleted',
        turn_id: null,
        response_id: base.source_message_id,
        turn_id_source: null,
        trigger_kind: null,
        occurred_at: r.last_updated_at || r.created_at,
      } as TurnEventRow);
    }
  }

  // ── TASK KINDS (row 104) ───────────────────────────────────────────────────────────────────────
  // `v_task_resolution` aggregates `task_opened`, `task_transition` and `task_terminal`, and until now
  // NO producer emitted any of them: the deployed query returned zero rows over a 47-day window with
  // real task traffic, which reads as "no task resolved" when the truth is "this was never measured".
  //
  // The events already existed one layer up - the archive record carries `task_transition` and
  // `task_status` per turn - so this is a PROJECTION of what the product already declares, not a new
  // measurement. Each kind is derived from the product's own signal rather than from a copy of the
  // state-machine table, which would then have to be kept in step with the machines it describes.
  //
  // A SECOND PASS, so a task row always follows the message event that caused it: an event that opens
  // a task also posts a placeholder, and a ledger that lists the consequence before the cause is
  // harder to read than one extra loop is to maintain.
  for (const r of records) {
    rows.push(...taskLedgerRows(r, {
      channel_arn: r.channel_arn,
      source_message_id: r.message_id.replace(/-(UPD|DEL|RED)$/, ''),
      source_event_type: r.event_type,
      actor: r.sender_arn,
      clock: 'chime',
      auditable: true,
      task_id: r.task_id,
      task_state: r.task_state,
    }));
  }

  // A row with no instant is not a measurement. Dropped rather than written with a placeholder time,
  // because a wrong timestamp in a ledger whose whole purpose is timing is worse than a missing row.
  return rows.filter((row) => !!row.occurred_at);
}

const COLUMNS = [
  'kind', 'turn_id', 'response_id', 'turn_id_source', 'trigger_kind', 'actor', 'terminal_kind',
  'source_message_id', 'source_event_type', 'channel_arn', 'occurred_at', 'clock', 'auditable',
  'task_id', 'task_state',
];

/**
 * Write the batch's ledger rows.
 *
 * BEST-EFFORT BY CONTRACT. The ledger is a measurement, and losing a measurement must never cost an
 * archive record - so a failure here is logged and swallowed rather than failing the batch that
 * carries the messages themselves.
 *
 * Idempotent on `(source_message_id, source_event_type, occurred_at, kind)` (migration 024 - `kind` is in the key because one archived event can carry both a response kind and a task kind at the same instant): an updated message re-invokes
 * the flow (ADR-022), so the same event is legitimately seen more than once, and a Kinesis redelivery
 * must not double the ledger.
 */
export async function writeTurnEvents(records: LedgerSourceRecord[]): Promise<number> {
  const rows = ledgerRowsFor(records);
  if (rows.length === 0) return 0;
  try {
    return await batchInsert('turn_events', COLUMNS, rows,
      // Bare DO NOTHING, deliberately: the 024 natural key arbitrates event rows, and migration
      // 025's PARTIAL unique index arbitrates task-kind rows (one task fact per message+kind,
      // whichever archived event carried it - the CREATE and the -UPD sibling both merge the same
      // out-of-band task blob, and each used to write its own copy of every task row). A named
      // conflict target covers only one arbiter; bare DO NOTHING covers both.
      'ON CONFLICT DO NOTHING');
  } catch (err) {
    console.warn('[turn-events] ledger write failed (archival is unaffected):', err);
    return 0;
  }
}
