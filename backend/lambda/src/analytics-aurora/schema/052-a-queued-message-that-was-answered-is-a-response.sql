-- ============================================================================
-- 052: a queued message that was answered is a response, and its row says it waited.
--
-- THE DECISION. "Queued responses are still responses. They should be tracked as
-- responses for all messages being answered in the queue but clearly labeled as messages that were in
-- queue so they can be looked at separate from exchanges that are 1 to 1."
--
-- WHAT WAS MISSING. A person who writes again while the assistant is busy has their message queued.
-- The reading marks it `amends` and the answering turn folds it into the reply it is about to send,
-- so the person IS answered - and nothing recorded it. Neither pairer could: each picks one bot
-- message per user message, and during a burst the bot message nearest a queued send is a deferral
-- notice, a reading's proposal, or an answer to somebody else. Measured live on 2026-09-15: a person
-- waited 16.5 seconds on a queued turn and no row in this database says they were answered.
--
-- WHY THIS IS NOT THE MAPPING ADR-033 REFUSED. That record argues a queued message "stops waiting
-- when it has been TRIAGED", and that an affordance marking each queued message with the answer that
-- addressed it "has no correct behavior to implement: the mapping does not exist". That objection is
-- about INFERRING the mapping from adjacency or transcript ordering, and it stands for that. The
-- mapping written here is DECLARED: the reading produces one entry per queued message and labels it
-- `amends`, `new` or `unclear`, and the turn that folds the `amends` entries into its answer writes
-- down which ids it folded. Three messages folded into one reply produce three rows pointing at that
-- reply, because the reading said so and the fold recorded it.
--
-- AND WHAT STAYS WHERE IT IS. A queued message the reading marked `new` or `unclear` becomes a task
-- and is measured as TASK RESOLUTION - ADR-033's own handoff, which keeps a person's deciding time
-- out of `agent_ms` - so it gets no row here. A queued message's FIRST feedback stays
-- `v_queue_acknowledgement`, which reports `ack_ms` keyed on the acknowledged message because several
-- queued sends share one notice. This adds the other end only: the answer, which nothing held.
--
-- Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS, CREATE INDEX (no CONCURRENTLY), CREATE
-- OR REPLACE VIEW, applied at RUNTIME on a cold start inside one transaction (db-client
-- applyPendingMigrations). Additive: every row written before this has NULL in both new columns.
-- ============================================================================

-- ── WHICH QUEUED MESSAGES AN ANSWER ADDRESSES ──
--
-- A column rather than a read into the metadata blob, for the same reason migration 042 gave: the
-- pass that expands this is SQL and cannot reach into JSON, and a reader should not have to know
-- which carrier a turn happened to have. Folded at archival from the turn's declared `answeredQueued`.
--
-- NULL, NOT AN EMPTY ARRAY, on an ordinary answer. `{}` would be a claim - "this answer addressed no
-- queued messages" - and almost every answer has never been near a queue. Absence is the honest
-- record, and it is what every row written before this column existed already has.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS answered_queued TEXT[];

COMMENT ON COLUMN messages.answered_queued IS
    'The Amazon Chime SDK MessageIds of the queued messages this answer addresses, DECLARED by the '
    'turn that folded them in rather than inferred from ordering. Non-NULL only on an answer that '
    'rolled in messages the reading marked as amending the work in flight; one exchange is minted '
    'per id, labeled exchanges.queued_as = folded. NULL means this answer addressed no queued '
    'message, which is every ordinary answer and every row written before this column existed.';

-- ── AND THE LABEL THAT KEEPS THE TWO POPULATIONS READABLE APART ──
--
-- The point of the owner's decision is not that these rows exist; it is that an analyst can tell them
-- from a 1:1 turn. A queued exchange's `response_latency_ms` includes a wait the platform CHOSE to
-- impose, so averaging it beside an ordinary turn reports a deliberate decision as a regression -
-- which is the exact failure ADR-033's latency section exists to prevent.
--
-- A VALUE THAT SAYS HOW IT LEFT THE QUEUE, not a boolean. `folded` is the only value written today,
-- and the column exists in this shape so the day a `new` or `unclear` message is answered in its own
-- right it can say so without a second migration and without a reader having to guess what `true`
-- covered.
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS queued_as VARCHAR(16);

COMMENT ON COLUMN exchanges.queued_as IS
    'How this exchange''s user message left the turn queue, when it was queued at all. folded - it '
    'arrived while the assistant was busy, the reading marked it as amending the work in flight, and '
    'the answering turn rolled it into the reply this row points at. NULL means the message was never '
    'queued: an ordinary 1 to 1 exchange, and every row written before this column existed. A queued '
    'message the reading marked new or unclear becomes a task and is measured by v_task_resolution, '
    'so it has no row here; its first feedback is v_queue_acknowledgement either way. '
    'response_latency_ms on a labeled row INCLUDES the queue wait and is not a time to first '
    'feedback - read the two populations apart before averaging them.';

-- The expansion pass joins an answer to the messages it named, per channel, over a 24-hour window.
-- Partial, because the overwhelming majority of answers carry NULL and a query asking for those asks
-- for every message in the archive.
CREATE INDEX IF NOT EXISTS idx_messages_answered_queued
    ON messages (channel_arn, created_at)
    WHERE answered_queued IS NOT NULL;

-- And the two populations are read apart by the label, so the label is what is indexed.
CREATE INDEX IF NOT EXISTS idx_exchanges_queued_as
    ON exchanges (channel_arn, queued_as, created_at)
    WHERE queued_as IS NOT NULL;

-- ============================================================================
-- v_turn_latency: a queued message's exchange must not become another turn's anchor.
--
-- THE 051 DEFINITION, UNCHANGED EXCEPT FOR ONE PREDICATE. That migration established that a notice is
-- not a turn; this keeps the companion true - a queued exchange is not the turn's own pairing.
--
-- WHY IT MATTERS. The LATERAL below takes the FIRST exchange on the answering message and reads
-- `user_message_at` from it, which is what `anchor_source = 'exchange'` means. A folded answer now
-- carries one exchange per queued message it rolled in, all of them on that same message, so without
-- the predicate the turn's anchor would become whichever queued send sorted first - and its TTFF and
-- E2E would be measured from a message that is not the one the turn was answering.
--
-- The turn's own exchange is unaffected: it is minted against the acknowledgment the turn closes out,
-- carries no `queued_as`, and is the row this join is meant to find.
-- ============================================================================
CREATE OR REPLACE VIEW v_turn_latency AS
WITH
anchor AS (
    SELECT turn_id,
           MIN(occurred_at) FILTER (WHERE kind = 'user_message') AS t0_user_at,
           MIN(turn_id_source) FILTER (WHERE kind = 'user_message') AS turn_id_source
      FROM turn_events
     WHERE turn_id IS NOT NULL
     GROUP BY turn_id
),
resp AS (
    SELECT MAX(turn_id)::VARCHAR(64) AS turn_id,
           response_id,
           channel_arn::text AS channel_arn,
           MIN(occurred_at) FILTER (WHERE kind = 'placeholder_posted')     AS t2_placeholder_at,
           MIN(occurred_at) FILTER (WHERE kind = 'final_response')         AS t3_final_at,
           MIN(occurred_at) FILTER (WHERE kind = 'processor_entry')        AS entry_at,
           COUNT(*)         FILTER (WHERE kind = 'progress_update')        AS progress_update_count,
           MIN(occurred_at) FILTER (WHERE kind IN ('content_edited','content_redacted','message_deleted'))
                                                                           AS superseded_at,
           -- FROM WHICHEVER ROW DECLARES ONE, not only the placeholder. See 038.
           MIN(trigger_kind) FILTER (WHERE trigger_kind IS NOT NULL)        AS trigger_kind,
           MIN(battle_round) FILTER (WHERE kind = 'placeholder_posted')    AS battle_round,
           MIN(actor)       FILTER (WHERE kind = 'placeholder_posted')     AS responder
      FROM turn_events
     WHERE response_id IS NOT NULL
     GROUP BY response_id, channel_arn
    -- A RESPONSE MADE ONLY OF NOTICES IS NOT A RESPONSE (051). `kind` is NOT NULL, so `bool_or` over
    -- a group is TRUE exactly when at least one row is something other than the deferral
    -- acknowledgement. A turn that recorded a notice alongside a placeholder keeps every row it has.
    HAVING bool_or(kind <> 'notice_posted')
)
SELECT
    r.turn_id,
    r.response_id,
    r.channel_arn,
    a.turn_id_source,
    r.trigger_kind,
    r.battle_round,
    r.responder,
    m.agent_type,
    e.delivery_option,
    e.task_id,

    COALESCE(a.t0_user_at, e.user_message_at)              AS t0_user_at,
    r.t2_placeholder_at,
    r.t3_final_at,
    r.entry_at,                                            -- SERVER clock

    CASE WHEN COALESCE(r.trigger_kind, 'user') IN ('user','handover','repair','recovery')
              AND COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END AS ttff_ms,
    CASE WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t3_final_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END       AS e2e_ms,
    CASE WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
              AND r.t3_final_at >= r.t2_placeholder_at
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - r.t2_placeholder_at)) * 1000)::integer END AS answer_ms,

    m.total_ms, m.latency_ms, m.model_ms, m.tool_ms, m.poll_ms,
    e.inbound_ms,

    (CASE WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL AND r.t3_final_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END
     - COALESCE(e.inbound_ms, 0) - COALESCE(m.total_ms, 0))                  AS unattributed_ms,
    (m.total_ms - COALESCE(m.latency_ms, 0) - COALESCE(m.poll_ms, 0))        AS overhead_ms,
    (m.latency_ms - COALESCE(m.model_ms, 0) - COALESCE(m.tool_ms, 0))        AS loop_residual_ms,

    CASE
        WHEN r.t2_placeholder_at IS NOT NULL AND COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
             AND r.t2_placeholder_at < COALESCE(a.t0_user_at, e.user_message_at)  THEN 'anomalous'
        WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
             AND r.t3_final_at < r.t2_placeholder_at                       THEN 'anomalous'
        WHEN r.t3_final_at IS NOT NULL                                     THEN 'complete'
        WHEN r.progress_update_count > 0                                   THEN 'awaiting_user'
        ELSE 'unresolved'
    END                                                                     AS status,
    r.progress_update_count,
    r.superseded_at,
    (r.t2_placeholder_at > NOW() - INTERVAL '90 days')                      AS in_stream_window,

    CASE WHEN a.t0_user_at      IS NOT NULL THEN 'ledger'
         WHEN e.user_message_at IS NOT NULL THEN 'exchange'
    END                                                                     AS anchor_source,

    -- THE CAUSE INSTANT, declared first and derived only as a fallback (034).
    COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at) AS trigger_at,
    CASE WHEN COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at
                                   - COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at))) * 1000)::integer
    END                                                                     AS ack_ms,
    -- Provenance, and it now has three states rather than two. 'declared' covers both a producer's own
    -- instant and a real user message - in both cases the anchor was OBSERVED rather than reconstructed
    -- - while 'derived' marks the 033 rule, which is a reconstruction and must never read as one.
    CASE WHEN m.trigger_at IS NOT NULL                             THEN 'declared'
         WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL THEN 'declared'
         WHEN trg.trigger_at IS NOT NULL                            THEN 'derived'
    END                                                                     AS ack_source
  FROM resp r
  LEFT JOIN anchor   a ON a.turn_id = r.turn_id
  LEFT JOIN messages m ON m.message_id = r.response_id AND m.channel_arn = r.channel_arn
                      AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
  LEFT JOIN LATERAL (
      SELECT ex.delivery_option, ex.task_id, ex.inbound_ms, ex.user_message_at
        FROM exchanges ex
       WHERE ex.agent_message_id = m.id
         -- A QUEUED EXCHANGE IS NOT THIS TURN'S PAIRING (052). A folded answer carries one exchange
         -- per queued message it rolled in, on this same message; taking one as the anchor would
         -- measure the turn from a message it was not answering. The turn's own exchange is minted
         -- against the acknowledgment it closes out and carries no label.
         AND ex.queued_as IS NULL
       ORDER BY ex.created_at
       LIMIT 1
  ) e ON TRUE
  -- The 033 derived rule, now a FALLBACK for rows written before the producers declared their own
  -- instant. Kept rather than dropped: history does not get re-dispatched, so removing it would blank
  -- the only measurement those turns will ever have.
  LEFT JOIN LATERAL (
      SELECT MAX(te.occurred_at) AS trigger_at
        FROM turn_events te
       WHERE r.trigger_kind IS NOT NULL
         AND r.trigger_kind <> 'user'
         AND m.trigger_at IS NULL
         AND te.channel_arn = r.channel_arn
         AND te.kind = 'final_response'
         AND te.occurred_at < r.t2_placeholder_at
         AND te.occurred_at > r.t2_placeholder_at - INTERVAL '10 minutes'
         AND (te.actor IS DISTINCT FROM r.responder)
  ) trg ON TRUE;

COMMENT ON VIEW v_turn_latency IS
    'THE latency calculation: one row per response with every instant, the metric derived from it, '
    'and residuals that must be >= 0. A response whose only ledger rows are deferral notices is not a '
    'response and is excluded; a queued message''s first feedback is v_queue_acknowledgement, which '
    'keys on the acknowledged message because several queued sends share one notice. An exchange '
    'labeled queued_as is skipped when anchoring a turn - it pairs a message that WAITED with the '
    'answer that folded it in, and v_queued_exchange is where that population is read. The turn '
    'anchor is the ledger''s own user_message when it has one and the exchange pairing otherwise '
    '(anchor_source says which). ttff_ms is the USER-TRIGGERED subset, kept comparable to the Nielsen '
    'SLO, and it is what the admin console''s Latency tab reads; ack_ms is the general '
    'trigger-to-first-signal metric and covers proactive responses too, anchored on the producer''s '
    'DECLARED instant where there is one and a bounded derivation otherwise (ack_source says which). '
    'Task turns appear here as individual TURNS; whole-task resolve time is v_task_resolution and is '
    'a different measurement.';

-- ============================================================================
-- v_queued_exchange: the queued population, beside the wait it already had measured.
--
-- ONE PLACE TO ASK "what did queueing cost this person", built from the two facts that already exist
-- rather than a third measurement: the exchange says when they were ANSWERED, and
-- v_queue_acknowledgement says when they were first TOLD. Neither is recomputed here.
--
-- It is a view and not a table because nothing new is being recorded. The label is on the exchange;
-- this is the join an analyst would otherwise write by hand, written once so two people asking the
-- same question read the same numbers (tenet D7).
-- ============================================================================
CREATE OR REPLACE VIEW v_queued_exchange AS
SELECT
    ex.id                        AS exchange_id,
    ex.channel_arn,
    ex.conversation_id,
    ex.queued_as,
    um.message_id                AS queued_message_id,
    am.message_id                AS answer_message_id,
    ex.user_message_at           AS queued_at,
    ex.agent_response_at         AS answered_at,
    ex.response_latency_ms       AS waited_ms,
    ex.e2e_ms,
    ex.intent,
    ex.delivery_option,
    ex.task_id,
    ex.agent_type,
    ex.conversation_classification,
    -- WHAT THEY WERE TOLD, AND WHEN, from the view that already owns that question. LEFT, because a
    -- queue episode whose notice could not be posted still answered the person - and a row that
    -- vanished for want of an acknowledgement would under-report exactly the failure worth seeing.
    -- NOT RECOMPUTED HERE (tenet D7): one source per question, and this one is 039/043's.
    qa.ack_ms,
    qa.drained_ms,
    -- HOW MANY MESSAGES THIS ONE REPLY ADDRESSED. One is a person who wrote twice; three is a reply
    -- carrying three follow-ups, which is a different thing to read and the reason the count is here
    -- rather than left to be derived per query.
    COUNT(*) OVER (PARTITION BY ex.agent_message_id) AS answered_together
  FROM exchanges ex
  JOIN messages um ON um.id = ex.user_message_id
  JOIN messages am ON am.id = ex.agent_message_id
  LEFT JOIN v_queue_acknowledgement qa
         ON qa.channel_arn = ex.channel_arn
        AND qa.message_id = um.message_id
 WHERE ex.queued_as IS NOT NULL;

COMMENT ON VIEW v_queued_exchange IS
    'Every exchange whose user message WAITED IN A QUEUE, which is the population v_turn_latency '
    'deliberately anchors away from. One row per queued message that was answered, naming the answer '
    'that addressed it - several rows may name the same answer, because one reply can fold in several '
    'follow-ups and answered_together says how many. waited_ms is the person''s whole wait INCLUDING '
    'the queue and must never be averaged with a 1 to 1 turn''s time to first feedback; ack_ms is '
    'their first feedback and comes from v_queue_acknowledgement rather than being recomputed here. '
    'A queued message that became a task instead of being folded is absent: it is measured by '
    'v_task_resolution, which is ADR-033''s deliberate handoff.';
