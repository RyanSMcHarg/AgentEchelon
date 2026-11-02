/**
 * Backfill `turn_events` from the `messages` rows already in Aurora.
 *
 * WHY THIS RUNS FIRST. It proves the ledger's SHAPE against real historical traffic before any
 * producer or archival change ships. If `v_turn_latency` cannot reproduce the existing
 * `exchanges.e2e_ms` from backfilled events, the event model is wrong and that is worth learning
 * here, at zero risk, rather than after the write path has been altered.
 *
 * WHAT THIS DOES AND DOES NOT PROVE - worth being exact, because it is easy to overclaim. The final
 * answer's instant is read from `messages.agent_final_at`, which is the SAME value the legacy
 * derivation uses. So agreement on `e2e_ms` is NOT independent evidence that finality was decided
 * correctly; it validates the ledger's grain, its joins, the fan-out handling and the view
 * arithmetic. Independent evidence only arrives in the dual-write phase, when archival writes
 * `final_response` from the producer's DECLARED phase instead of from an inference.
 *
 * Historical rows carry no declared phase, so this derives kinds from what history does hold:
 *   - a bot CREATE whose content has the `<!--corr:{id}-->` marker IS a placeholder, by definition
 *     (lib/correlation.ts) - so `turn_id` is genuinely declared for those rows, not guessed;
 *   - a user CREATE paired to that placeholder through `exchanges` is the turn's anchor, and its
 *     `turn_id` is therefore PAIRED, which the row records rather than implying it was declared;
 *   - `agent_final_at` on the canonical row is the final answer's Chime instant;
 *   - a duel side's placeholder carries `<!--battle:...round=N...-->`, so the round is a declared
 *     fact about that row too, and NULL on every message that is not a duel side.
 *
 * Deliberately NOT backfilled: `processor_entry`. Only `exchanges.inbound_ms` survives for history,
 * which is a duration, not an instant; reconstructing a timestamp from it would put a computed value
 * in a table whose whole purpose is observed facts.
 *
 * Runs inside the VPC-attached data-plane Lambda (the only place Aurora is reachable). Idempotent:
 * every insert is `ON CONFLICT DO NOTHING` against the ledger's natural event key, so re-running
 * converges instead of duplicating.
 */

import { query } from './db-client.js';

export interface TurnEventsBackfillOptions {
  /** Window to backfill, in days. Defaults to 90 - the S3 archive lifecycle, past which an event
   *  can no longer be proven against the stream and so is worth less in this table. */
  days?: number;
}

export interface TurnEventsBackfillResult {
  placeholders: number;
  userMessages: number;
  finalResponses: number;
  moderations: number;
}

/** Bot CREATE rows carrying a correlation marker: these ARE placeholders, and the marker is the turn id. */
const CORR_MARKER = '<!--corr:';

export async function backfillTurnEvents(
  opts: TurnEventsBackfillOptions = {},
): Promise<TurnEventsBackfillResult> {
  const days = Math.min(Math.max(opts.days ?? 90, 1), 365);

  // 1. placeholder_posted - the response anchor. `turn_id` is DECLARED here: the correlation marker
  //    in the content is what defines a placeholder in the first place.
  //    trigger_kind: 'user' when an exchange pairs this response to a user message, otherwise
  //    'system' - a welcome, briefing or drift notice has no user turn to measure from, and that
  //    distinction is what keeps a meaningless TTFF out of the average.
  const placeholders = await query(
    `INSERT INTO turn_events (
        kind, turn_id, response_id, turn_id_source, trigger_kind, actor,
        source_message_id, source_event_type, channel_arn, occurred_at, clock, auditable,
        battle_round)
     SELECT 'placeholder_posted',
            substring(c.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->'),
            c.message_id,
            'declared',
            CASE WHEN ex.id IS NULL THEN 'system' ELSE 'user' END,
            c.sender_arn,
            c.message_id,
            'CREATE_CHANNEL_MESSAGE',
            c.channel_arn,
            c.created_at,
            'chime',
            TRUE,
            -- THE DUEL ROUND, FROM THE SAME MARKER THE LIVE WRITER READS. History holds the
            -- placeholder's own content on the CREATE row, so the marker survives here even though
            -- the answer update overwrote what the person sees. NULL on every ordinary turn, which
            -- is what the column means to every reader of it.
            --
            -- Four digits and a trailing constraint, matching battleRoundOf in turn-events-live.ts:
            -- the column is a SMALLINT and a wider number would fail the statement, so a marker
            -- claiming one is refused rather than truncated to its first four digits. Sourced from
            -- content rather than from metadata for the reason stated on that function.
            substring(c.content from '<!--battle:[^>]*?round=([0-9]{1,4})(?![0-9])')::smallint
       FROM messages c
       LEFT JOIN LATERAL (
            SELECT e.id FROM exchanges e WHERE e.agent_message_id = c.id ORDER BY e.created_at LIMIT 1
       ) ex ON TRUE
      WHERE c.event_type = 'CREATE_CHANNEL_MESSAGE'
        AND c.is_bot = TRUE
        AND c.content LIKE '%' || $2 || '%'
        AND c.created_at >= NOW() - INTERVAL '1 day' * $1
        AND substring(c.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->') IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [days, CORR_MARKER],
  );

  // 2. user_message - the turn anchor, reached through the exchange pairing. `turn_id_source` is
  //    'paired' because the processor is never handed the user's Chime MessageId, so this binding is
  //    derived at archival. The row states that rather than passing a derived key off as declared.
  const userMessages = await query(
    `INSERT INTO turn_events (
        kind, turn_id, response_id, turn_id_source, trigger_kind, actor,
        source_message_id, source_event_type, channel_arn, occurred_at, clock, auditable)
     SELECT DISTINCT ON (um.message_id, um.channel_arn)
            'user_message',
            substring(c.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->'),
            NULL,
            'paired',
            'user',
            um.sender_arn,
            um.message_id,
            'CREATE_CHANNEL_MESSAGE',
            um.channel_arn,
            um.created_at,
            'chime',
            TRUE
       FROM exchanges e
       JOIN messages c  ON c.id = e.agent_message_id
       JOIN messages um ON um.id = e.user_message_id
      WHERE c.event_type = 'CREATE_CHANNEL_MESSAGE'
        AND um.created_at >= NOW() - INTERVAL '1 day' * $1
        AND substring(c.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->') IS NOT NULL
        -- A REBUTTAL IS NEVER BOUND TO THE PERSON'S MESSAGE, the rule migration 064 applies to the
        -- view's anchor lateral and 071 keeps, applied here to the ledger's own rows. Its exchange carries the
        -- message the duel began from, and binding that message to the round-2 turn would give the
        -- ledger a person anchor two rounds early. Round two anchors on its declared trigger instead.
        AND COALESCE(e.battle_round, 1) <= 1
      ORDER BY um.message_id, um.channel_arn, e.created_at
     -- (No backticks in this SQL: the statement is a JS template literal, so one ends the string
     --  mid-query. The same note guards the SQL in analytics-query.ts, for the same reason.)
     -- THE ARBITER AS IT NOW IS (code review, 2026-09-11). This named 024's four-column key, which
     -- migration 041 DROPPED and replaced with an expression index carrying COALESCE(step_name, '').
     -- A conflict target that matches no unique index is not a no-op: Postgres raises 42P10 and the
     -- whole statement fails, so this pass errored on every run and no live-archived user_message row
     -- was ever bound to its turn. Since the migrations apply on cold start, shipping 041 broke this
     -- silently in the same deploy.
     --
     -- The bare DO NOTHING that writeTurnEvents uses is not available here: this pass has to DO
     -- UPDATE to bind a turn_id onto the row the live writer already laid down, and DO UPDATE
     -- requires a target. So it names the new index exactly, expression included.
     ON CONFLICT (source_message_id, source_event_type, occurred_at, kind, COALESCE(step_name, ''))
     DO UPDATE SET turn_id = EXCLUDED.turn_id
      WHERE turn_events.turn_id IS NULL`,
    [days],
  );
  // DO UPDATE, not DO NOTHING, and it is the whole point of this pass now: the LIVE writer archives
  // the person's message the moment it arrives, honestly recording turn_id NULL (pairing has not
  // happened yet) - and that row holds the exact natural key this insert derives. DO NOTHING made
  // the live row WIN and the binding lose, so t0 stayed NULL for every live-archived turn and the
  // ledger's own ttff/e2e could never compute. The pairing pass now BINDS the existing anchor
  // in place, and only where the binding is still missing - a turn_id once written is never moved.

  // 3. final_response - the instant the answer replaced the placeholder. Read from agent_final_at,
  //    which is the same source the legacy derivation uses (see the module note: this validates the
  //    shape, not the finality decision). The event's provenance still points at the UPDATE, which
  //    is what an auditor greps for in S3.
  const finalResponses = await query(
    `INSERT INTO turn_events (
        kind, turn_id, response_id, turn_id_source, actor,
        source_message_id, source_event_type, channel_arn, occurred_at, clock, auditable,
        battle_round)
     SELECT 'final_response',
            substring(c.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->'),
            c.message_id,
            'declared',
            c.sender_arn,
            c.message_id,
            'UPDATE_CHANNEL_MESSAGE',
            c.channel_arn,
            c.agent_final_at,
            'chime',
            TRUE,
            -- The same round on the close as on the placeholder, which is the pairing the live
            -- writer makes for a turn that closes itself: one event, one round, and an asymmetry
            -- between the two rows would read as a fact about the close rather than about the turn.
            -- Read from c.content, the CREATE row's own text, for the same reason.
            substring(c.content from '<!--battle:[^>]*?round=([0-9]{1,4})(?![0-9])')::smallint
       FROM messages c
      WHERE c.event_type = 'CREATE_CHANNEL_MESSAGE'
        AND c.is_bot = TRUE
        AND c.agent_final_at IS NOT NULL
        AND c.created_at >= NOW() - INTERVAL '1 day' * $1
        AND substring(c.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->') IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [days],
  );

  // 4. Moderation events. They never move a latency number, but recording them is what lets the view
  //    SHOW that an answer was edited or removed after the fact instead of hiding it - the auditor
  //    sees both that it changed and that the measurement deliberately did not.
  const moderations = await query(
    `INSERT INTO turn_events (
        kind, turn_id, response_id, source_message_id, source_event_type,
        channel_arn, occurred_at, clock, auditable)
     SELECT CASE WHEN r.event_type = 'REDACT_CHANNEL_MESSAGE' THEN 'content_redacted'
                 ELSE 'message_deleted' END,
            substring(c.content from '<!--corr:([A-Za-z0-9._-]{1,64})-->'),
            c.message_id,
            c.message_id,
            r.event_type,
            r.channel_arn,
            r.created_at,
            'chime',
            TRUE
       FROM messages r
       JOIN messages c
         ON c.channel_arn = r.channel_arn
        AND c.message_id = regexp_replace(r.message_id, '-(RED|DEL)$', '')
        AND c.event_type = 'CREATE_CHANNEL_MESSAGE'
      WHERE r.event_type IN ('REDACT_CHANNEL_MESSAGE', 'DELETE_CHANNEL_MESSAGE')
        AND r.created_at >= NOW() - INTERVAL '1 day' * $1
     ON CONFLICT DO NOTHING`,
    [days],
  );

  return {
    placeholders: placeholders.rowCount ?? 0,
    userMessages: userMessages.rowCount ?? 0,
    finalResponses: finalResponses.rowCount ?? 0,
    moderations: moderations.rowCount ?? 0,
  };
}

/**
 * Compare the ledger's derivation against the legacy one, per turn, over the same window.
 *
 * This is the go/no-go the rollout depends on, and it is deliberately a QUERY an operator runs and
 * reads - not a silent background job that decides for itself. A disagreement here means the two
 * models of a turn differ, which is exactly what has to be understood before anything repoints.
 */
export async function compareLatencyDerivations(days = 7): Promise<{
  compared: number;
  agreed: number;
  disagreed: Array<{ response_id: string; ledger_e2e_ms: number | null; legacy_e2e_ms: number | null }>;
}> {
  const res = await query(
    `SELECT v.response_id,
            v.e2e_ms                                   AS ledger_e2e_ms,
            e.e2e_ms                                   AS legacy_e2e_ms
       FROM v_turn_latency v
       JOIN messages m  ON m.message_id = v.response_id AND m.channel_arn = v.channel_arn
                       AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
       JOIN exchanges e ON e.agent_message_id = m.id
      WHERE v.t2_placeholder_at >= NOW() - INTERVAL '1 day' * $1`,
    [days],
  );
  const rows = res.rows as Array<{ response_id: string; ledger_e2e_ms: number | null; legacy_e2e_ms: number | null }>;
  const disagreed = rows.filter((r) => (r.ledger_e2e_ms ?? null) !== (r.legacy_e2e_ms ?? null));
  return { compared: rows.length, agreed: rows.length - disagreed.length, disagreed: disagreed.slice(0, 50) };
}

/**
 * WHAT THE DEFERRAL MEASUREMENT ACTUALLY RECORDED, read back so it can be believed.
 *
 * `v_queue_acknowledgement` was created by migration 039 and nothing could read it: there is no
 * generic query op, and the admin surfaces do not know about it. A view nobody can select from is
 * indistinguishable from a view that returns nothing, which is precisely the state the whole
 * deferral-measurement change was fixing - a number that is absent rather than wrong.
 *
 * Read-only and bounded. It answers one question: for recently queued messages, was the
 * acknowledgement recorded, and how long did the person wait for it.
 */
export async function queueAcknowledgementSample(limit = 20): Promise<{
  rows: number;
  withAck: number;
  sample: Array<{
    message_id: string;
    ack_ms: number | null;
    drained_ms: number | null;
    acknowledged_at: string | null;
  }>;
}> {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const res = await query(
    `SELECT message_id, ack_ms, drained_ms, acknowledged_at
       FROM v_queue_acknowledgement
      ORDER BY acknowledged_at DESC NULLS LAST
      LIMIT $1`,
    [capped],
  );
  const sample = (res.rows ?? []) as Array<{
    message_id: string; ack_ms: number | null; drained_ms: number | null; acknowledged_at: string | null;
  }>;
  return {
    rows: sample.length,
    // A row with a NULL ack_ms means the acknowledgement was recorded but the SEND was not matched -
    // worth separating, because it is a different failure from no rows at all.
    withAck: sample.filter((r) => r.ack_ms !== null).length,
    sample,
  };
}
