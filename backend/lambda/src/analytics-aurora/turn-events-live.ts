/**
 * THE LEDGER'S LIVE WRITER.
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
 * `respPhase` is stamped by the producer on every update. The mapping below is the whole
 * of the finality decision on this path, and an unrecognized phase becomes `progress_update` - never
 * `final_response`. That is the forward-looking guarantee: a phase invented later by a component that
 * has not been taught about latency cannot silently close a turn early.
 * ------------------------------------------------------------------------------------------------
 */

import { batchInsert } from './db-client.js';
import { TERMINAL_TASK_STATUS } from '../lib/task-tracking.js';
import { machineTerminalKind, type TerminalKind } from '../lib/task-state-machines.js';
import { correlationMarkerOf } from '../lib/correlation.js';
import { parseRouterSteps } from '../lib/router-steps.js';
import { baseMessageIdOf } from './update-events.js';

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
  /** For a deferral notice: the queued message this post acknowledges. */
  acknowledges?: string | null;
  /** For a deferral notice: the drain stage this update records. */
  queue_status?: string | null;
  /** What caused the turn, as the producer declared it. Absent ⇒ derived as before. */
  trigger_kind?: string | null;
  content: string | null;
  task_id: string | null;
  task_state: string | null;
  /** Lifecycle status after this turn ('completed' / 'failed' / ...). The product's own terminal signal. */
  task_status?: string | null;
  /** The task's type, which names the machine whose states `task_status` may hold. */
  task_type?: string | null;
  /**
   * The ending the turn's own runtime declared (`taskTerminal`), read against the deployment's pack-merged machines. The
   * archive holds no pack, so a machine only a pack declares is known here through this.
   */
  task_terminal?: string | null;
  /** The declared-graph edge this turn applied, when it applied one (SPEC-TASK-STATE-TRANSITIONS). */
  task_transition?: { from: string; to: string } | null;
  /**
   * The router's step instants, as the router stamped them (lib/router-steps.ts).
   *
   * Rides the out-of-band analytics blob like every other measurement field, so it arrives on BOTH
   * events of a bot message; the database arbitrates one instant per (message, step).
   */
  router_steps?: unknown;
  /** When the channel flow received the message this turn answers, epoch ms. Standard path only. */
  flow_received_at?: number | null;
  /**
   * WHICH ROUND OF A DUEL THIS MESSAGE IS, resolved onto the archive record from the placeholder's
   * own marker. Absent on every ordinary turn, which is what `turn_events.battle_round` already
   * means to everything that reads it.
   */
  battle_round?: number | null;
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
  /**
   * Only on a `notice_posted` row: the QUEUED MESSAGE this acknowledgement answers.
   *
   * It is what makes a deferral measurable. The notice declares no turn - it carries no correlation
   * marker - and it is one message updated in place, so without this every queued send in a burst
   * shares one instant and only the first could have a time to first feedback. ADR-033 requires each
   * of them to have their own.
   */
  acknowledges?: string | null;
  /**
   * Only on a `notice_posted` row: WHICH STAGE this update recorded.
   *
   * The notice is one message updated in place, so creation and settle are the same id and the same
   * kind. Without the stage, "when was the queue read" has to be guessed from MIN or MAX over every
   * update - and MIN produced a read instant EARLIER than the acknowledgement it followed.
   */
  queue_status?: string | null;
  /** Only on a `router_step` row: which boundary of the router leg this instant marks. */
  step_name?: string | null;
  /**
   * Only on a duel side's `placeholder_posted` row (and the self-close beside it): WHICH ROUND.
   *
   * `v_turn_latency` reads this column as `MIN(battle_round) FILTER (WHERE kind = 'placeholder_posted')`
   * and has done since migration 019, so the placeholder row is the one place the value can be put
   * without touching a view. NULL on every ordinary turn, and NULL is the reading - there is no
   * sentinel for "not a duel".
   */
  battle_round?: number | null;
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
 * `<!--battle:battleId=...,round=N,...-->`, as `lib/battle-turn.ts` composes it for both rounds.
 *
 * FOUR DIGITS, which is a bound rather than a limit: `turn_events.battle_round` is a SMALLINT, and a
 * marker claiming a wider number would fail the whole ledger insert - which `writeTurnEvents` then
 * swallows, costing the batch every measurement in it. The backfill's SQL carries the same bound so
 * the two writers read one shape.
 *
 * The trailing constraint is what makes that a refusal rather than a truncation: without it a
 * five-digit number matches its first four and a marker nobody can honor is recorded as a plausible
 * round. Postgres supports the same lookahead, so the SQL copy says it the same way.
 */
const BATTLE_ROUND_MARKER = /<!--battle:[^>]*?round=(\d{1,4})(?!\d)/;

/**
 * The duel round a placeholder declares, or null.
 *
 * WHY THE MARKER RATHER THAN `analytics.battleContext.round`. Both facts exist; only one of them is
 * on the event the round has to be recorded against. `v_turn_latency` takes `battle_round` from the
 * `placeholder_posted` row, and that row is derived from the placeholder's CREATE - where a duel
 * carries no metadata at all on either round. Round 1's placeholder is materialized by Amazon Chime
 * SDK from the Lex fulfillment return, which carries messages and session attributes and no message
 * metadata (the same fact `kinesis-archival.ts` records for every other declared field on that path);
 * the orchestrator's round-2 placeholder is a bare `SendChannelMessage` with no `Metadata` either.
 * `battleContext` reaches archival only through the out-of-band analytics record the WORKER writes
 * when it finishes, which is after the CREATE it would have to ride. Sourcing the round there would
 * stamp it on the update rows and leave the one row the view reads NULL - the state this change
 * exists to end.
 *
 * The marker, by contrast, is in the placeholder's content the instant it is posted, written by the
 * single builder both rounds share (`lambda/src/lib/battle-turn.ts`, `battlePlaceholderContent`).
 * Reading it adds no new KIND of parsing: this path already resolves `<!--corr:-->` here and
 * `<!--turn:-->` in archival off the same string, and matching text the platform itself wrote is the
 * pattern work tenet D11 keeps rather than the language judgement it refuses.
 *
 * A round of zero is not a round. `round=0` reads as no declaration rather than as a duel, because a
 * zero in this column would be a claim about a turn nobody made.
 */
export function battleRoundOf(content: string | null): number | null {
  const match = BATTLE_ROUND_MARKER.exec(content ?? '');
  if (!match) return null;
  const round = Number(match[1]);
  return Number.isInteger(round) && round >= 1 ? round : null;
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
    // A THIRD OUTCOME, not a success and not a fault (ADR-033). The person stopped the work while it
    // ran, so the turn resolved exactly as asked. Counting it `final` would fold a discarded answer
    // into the completion average; counting it `error` would report a fault where somebody changed
    // their mind. Leaving it to the default would make it a `progress_update` and therefore an
    // unclosed turn, which is the measurement gap the ADR says it must not become.
    case 'cancelled': return 'cancelled_response';
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
//
// AND A MACHINE'S OWN ENDING. A task turn records the state its task ended in (`task_status`), and a machine names its
// own endings: an image task succeeds in `done`, a work item in `placed`. Read in order: the lifecycle status, then
// the ending the turn's runtime declared from the deployment's pack-merged machines, then the platform machine for the
// task's type (`machineTerminalKind`, the one rule the experiment rollup and the task metrics read too).
const TERMINAL_KINDS: readonly string[] = ['success', 'failure', 'handoff'] satisfies TerminalKind[];
export function terminalKindFor(
  status: string | null | undefined,
  taskType?: string | null,
  declared?: string | null,
): string | null {
  const lifecycle = status && TERMINAL_TASK_STATUS[status as keyof typeof TERMINAL_TASK_STATUS];
  if (lifecycle) return lifecycle;
  if (declared && TERMINAL_KINDS.includes(declared)) return declared;
  return machineTerminalKind(taskType, status);
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
  const terminal = terminalKindFor(r.task_status, r.task_type, r.task_terminal);
  if (terminal) out.push({ ...common, kind: 'task_terminal', terminal_kind: terminal });
  return out;
}

export function ledgerRowsFor(records: LedgerSourceRecord[]): TurnEventRow[] {
  const rows: TurnEventRow[] = [];

  for (const r of records) {
    const base = {
      channel_arn: r.channel_arn,
      source_message_id: baseMessageIdOf(r.message_id),
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
      // ── A NOTICE IS A NOTICE ON ITS FIRST POST, NOT ONLY ON ITS UPDATES (code review, 2026-09-11) ──
      //
      // The deferral notice is ONE message updated in place, so it was read here as a placeholder on
      // the way in and as a notice only on the way out. But the FIRST notice of every queue episode
      // is a fresh send: `turn-queue-notice.ts` posts one when there is no `noticeId` to update, and
      // `turn-lock.ts` clears `noticeId` on each drain, so every episode starts without one.
      //
      // WHAT THAT COST. A queue that formed and cleared with a single message produced exactly one
      // notice, created and never updated, so `v_queue_acknowledgement` had no row for it at all -
      // and `queueAcknowledgementSample` reporting `rows: 0` is indistinguishable from the whole
      // acknowledgement mechanism never having run. The shortest queue episode is also the most
      // common one, so the measurement was blind to its own base case.
      //
      // The producer already declares everything needed: the send stamps `respPhase: notice` with
      // `acknowledges` and the depth, exactly as the update does. This reads the declaration on both
      // events rather than only on one.
      if (r.is_bot && r.resp_phase === 'notice') {
        rows.push({
          ...createdBase,
          kind: 'notice_posted',
          // The notice belongs to the QUEUE, not to a turn: it acknowledges somebody whose message is
          // waiting on work that is not theirs. `turn_id` stays null for the same reason the notice is
          // excluded from the exchange population - it answers nobody.
          turn_id: null,
          response_id: r.message_id,
          turn_id_source: null,
          trigger_kind: null,
          ...(r.acknowledges ? { acknowledges: r.acknowledges } : {}),
          ...(r.queue_status ? { queue_status: r.queue_status } : {}),
        });
        continue;
      }
      if (r.is_bot && turnId) {
        // A bot message carrying the marker IS the placeholder, and it declares its own turn id.
        //
        // `trigger_kind` is left NULL rather than guessed. The backfill derives it from whether an
        // exchange paired - a join this path cannot do, because the pairing has not happened yet when
        // the placeholder is archived. A guess here would be a second, disagreeing source for the one
        // fact that decides whether a TTFF is meaningful.
        // THE DECLARED CAUSE, when the producer gave one. This was null and left for the backfill to
        // infer from whether an exchange paired - a join this path cannot do, because pairing has not
        // happened yet when the placeholder is archived. A DECLARED value is not an inference, so it
        // is preferred over one; absent, the behavior is exactly as before.
        //
        // AND WHICH ROUND OF A DUEL IT IS, WHEN IT IS ONE. The column has been declared since
        // migration 019, selected by every revision of `v_turn_latency` and returned by the turn
        // audit query, and no producer ever wrote it - so a round-1 duel side was indistinguishable
        // from production traffic in every latency population, with no field to filter on. NULL here
        // is an ordinary turn, which is what the column already means to every reader of it.
        rows.push({ ...createdBase, kind: 'placeholder_posted', turn_id: turnId, response_id: r.message_id,
          turn_id_source: 'declared', trigger_kind: r.trigger_kind ?? null,
          battle_round: r.battle_round ?? null });
        // ── A TURN THAT WAS ALREADY FINISHED WHEN IT POSTED CLOSES ITSELF ────────────────────────
        //
        // A `DIRECT` answer is returned by the handler and posted once: there is no update to come,
        // so nothing else will ever close this response. The row above is still right - that instant
        // IS when the person first saw something - but on its own it would leave the fastest turn in
        // the system permanently `unresolved`, with no `e2e_ms` and a place in every unclosed-turn
        // count. Two rows at one instant say what happened: first feedback and the answer were the
        // same event, so `ttff_ms` and `e2e_ms` are equal and `answer_ms` is zero.
        //
        // DECLARED, NEVER INFERRED FROM THE DELIVERY OPTION. `deliveryOption` is stamped from the
        // intent on every turn, so a turn whose intent maps to DIRECT but which fell through to the
        // processor carries `DIRECT` as well; closing on that would forge a finish for a turn still
        // running. Only the phase the producer declared closes anything, here as everywhere else.
        if (r.resp_phase === 'final') {
          // Same message, same instant, so the same round: the two rows describe one event and an
          // asymmetry between them would read as a fact about the close rather than about the turn.
          rows.push({ ...createdBase, kind: 'final_response', turn_id: turnId, response_id: r.message_id,
            turn_id_source: 'declared', trigger_kind: r.trigger_kind ?? null,
            battle_round: r.battle_round ?? null });
        }
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
        // ONLY A NOTICE CARRIES ONE, and only a notice should: every other phase already declares a
        // turn, so an acknowledged-message id on one of those would be a second, disagreeing key.
        ...(r.resp_phase === 'notice' && r.acknowledges ? { acknowledges: r.acknowledges } : {}),
        ...(r.resp_phase === 'notice' && r.queue_status ? { queue_status: r.queue_status } : {}),
        turn_id: declaredTurnId(r.content),
        response_id: base.source_message_id,
        turn_id_source: null,
        // DECLARED, and no longer discarded. This was null because the trigger was not knowable when
        // the placeholder was CREATED, so nulling it was reasonable - and it meant the one row that
        // could ever carry the value threw it away. The processor now stamps the declared trigger onto
        // the placeholder update, so this record has it, and v_turn_latency takes the turn's trigger
        // from whichever of its rows declared one (migration 038).
        //
        // Still declared rather than inferred: absent stays absent, and nothing here guesses from
        // whether an exchange paired.
        trigger_kind: r.trigger_kind ?? null,
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

  // ── TASK KINDS ───────────────────────────────────────────────────────────────────────
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
      source_message_id: baseMessageIdOf(r.message_id),
      source_event_type: r.event_type,
      actor: r.sender_arn,
      clock: 'chime',
      auditable: true,
      task_id: r.task_id,
      task_state: r.task_state,
    }));
  }

  // ── THE ROUTER'S STEP INSTANTS ───────────────────────────────────────────────────────
  // One row per boundary of the pre-placeholder path, so `router_ms` divides into the parts a fix
  // would target. SERVER clock: these instants were taken inside the router and never appeared in the
  // message stream, so they are attested rather than provable, and say so on every row.
  //
  // A THIRD PASS, for the same reason the task kinds are a second one: the boundaries all precede the
  // placeholder they are attached to, and a ledger that lists them after the message event they
  // describe reads in the order the archive saw things rather than in a fabricated one.
  // ONLY WHERE THIS RECORD ALSO ESTABLISHES THE RESPONSE, and that condition is load-bearing.
  //
  // `v_turn_latency` and the unclosed split both build their populations the same way:
  // `FROM turn_events WHERE response_id IS NOT NULL GROUP BY response_id`. So a response_id that has
  // ONLY router_step rows becomes a GROUP - a turn with no placeholder, no final and no progress
  // update, which lands as `status = 'unresolved'` in the view and in the `ELSE 'silent'` bucket of
  // the split: the one bucket that means an answer went missing. A measurement inflating the
  // population it exists to explain is worse than no measurement.
  //
  // IT IS REACHABLE, NOT THEORETICAL. The analytics record is keyed on `deliveryMessageId`, and on a
  // broadcast resume that is a message the processor posts itself with the content '...' - no
  // correlation marker, so its CREATE archives as a `continuation_chunk` with a NULL response_id
  // while the step rows would have carried one. The condition below is exactly the one
  // `placeholder_posted` uses, so the steps can only attach to a response that exists: on that path
  // they ride the UPDATE instead, which always emits a phase row for the same id.
  //
  // BOTH EVENTS ARE STILL ADMITTED where both qualify, because which archives first is a race this
  // writer does not get to decide - the analytics record is written when the PROCESSOR finishes, so
  // the CREATE may well be archived before it exists. First arrival wins and the database arbitrates,
  // the same conclusion migration 025 reached for the task kinds.
  //
  // A redaction or a deletion never qualifies: it measured nothing, its content is stripped so it
  // declares no turn, and letting it be the first arrival would file a turn's whole breakdown under a
  // null turn id and lock the real rows out.
  for (const r of records) {
    const steps = parseRouterSteps(r.router_steps);
    const responseId = baseMessageIdOf(r.message_id);
    const turnId = declaredTurnId(r.content);
    const establishesResponse = r.event_type === 'UPDATE_CHANNEL_MESSAGE'
      || (r.event_type === 'CREATE_CHANNEL_MESSAGE' && !!turnId);
    if (!r.is_bot || !establishesResponse) continue;
    // THE CHANNEL FLOW'S RECEIPT, one row beside the router's steps and under the same condition. Its
    // own kind rather than a router step: v_router_steps derives each step from the one before it, and
    // the router's span is first-to-last of its own marks.
    if (typeof r.flow_received_at === 'number' && Number.isFinite(r.flow_received_at)) {
      rows.push({
        kind: 'flow_received',
        step_name: null,
        turn_id: turnId,
        response_id: responseId,
        turn_id_source: turnId ? 'declared' : null,
        trigger_kind: null,
        actor: r.sender_arn,
        source_message_id: responseId,
        source_event_type: r.event_type,
        channel_arn: r.channel_arn,
        occurred_at: new Date(r.flow_received_at).toISOString(),
        clock: 'server',
        auditable: false,
        task_id: null,
        task_state: null,
      });
    }
    if (!steps) continue;
    for (const mark of steps) {
      rows.push({
        kind: 'router_step',
        step_name: mark.step,
        // The response these boundaries were spent getting to. Shared with `placeholder_posted`, which
        // is what lets the steps be read against the same turn's TTFF.
        turn_id: turnId,
        response_id: responseId,
        turn_id_source: turnId ? 'declared' : null,
        trigger_kind: null,
        actor: r.sender_arn,
        source_message_id: responseId,
        source_event_type: r.event_type,
        channel_arn: r.channel_arn,
        occurred_at: new Date(mark.at).toISOString(),
        clock: 'server',
        auditable: false,
        task_id: null,
        task_state: null,
      });
    }
  }

  // A row with no instant is not a measurement. Dropped rather than written with a placeholder time,
  // because a wrong timestamp in a ledger whose whole purpose is timing is worse than a missing row.
  return rows.filter((row) => !!row.occurred_at);
}

const COLUMNS = [
  'kind', 'turn_id', 'response_id', 'turn_id_source', 'trigger_kind', 'actor', 'terminal_kind',
  'source_message_id', 'source_event_type', 'channel_arn', 'occurred_at', 'clock', 'auditable',
  'task_id', 'task_state', 'acknowledges', 'queue_status', 'step_name', 'battle_round',
];

/**
 * Write the batch's ledger rows.
 *
 * BEST-EFFORT BY CONTRACT. The ledger is a measurement, and losing a measurement must never cost an
 * archive record - so a failure here is logged and swallowed rather than failing the batch that
 * carries the messages themselves.
 *
 * Idempotent on `(source_message_id, source_event_type, occurred_at, kind, COALESCE(step_name, ''))`
 * (migration 024, widened by 041 - `kind` is in the key because one archived event can carry both a response kind and a task kind at the same instant): an updated message re-invokes
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
      // whichever archived event carried it - the CREATE and each of its updates all merge the same
      // out-of-band task blob, and each used to write its own copy of every task row). A named
      // conflict target covers only one arbiter; bare DO NOTHING covers both.
      'ON CONFLICT DO NOTHING');
  } catch (err) {
    console.warn('[turn-events] ledger write failed (archival is unaffected):', err);
    return 0;
  }
}
