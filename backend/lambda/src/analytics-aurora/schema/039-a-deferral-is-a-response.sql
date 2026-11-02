-- ============================================================================
-- A DEFERRAL IS A RESPONSE, AND IT WAS NOT MEASURED AT ALL.
--
-- When a message arrives while the assistant is busy it is queued, and the person gets a real,
-- visible, fast reply saying so (~20 to 50ms). That reply is their first feedback. Nothing measured
-- it:
--
--   * `ttff_ms` and `ack_ms` both anchor on `t2_placeholder_at`, which is
--     MIN(occurred_at) FILTER (WHERE kind = 'placeholder_posted').
--   * A queued message produces NO placeholder - it was queued rather than dispatched.
--   * So both metrics came back NULL for every queued turn.
--
-- The failure direction is what made it invisible: not a bad number, an ABSENT one. Queued turns
-- dropped out of the latency population entirely, so the averages stayed healthy and the wait the
-- platform deliberately imposes never appeared anywhere. ADR-033 states that the deferral
-- acknowledgement IS the first feedback and sets TTFF; that was a decision, and it was never built.
--
-- ── WHY THIS COULD NOT BE FIXED IN THE VIEW ALONE ───────────────────────────────────────────────
--
-- The obvious repair is to add `notice_posted` to that FILTER. It changes nothing, for two reasons:
--
--   1. NO KEY. A bot message becomes a response by carrying the correlation marker, and the notice
--      deliberately carries none, so its rows have a NULL `turn_id` and there is nothing to join to
--      the person's message.
--   2. ONE ROW, MANY SENDS. The notice is a single message UPDATED in place, so every queued send
--      shares its `response_id`. A MIN-per-response rule collapses a burst into one instant, and only
--      the first send could ever have a first-feedback time - which is exactly what ADR-033 forbids,
--      because a person who sent three messages waited three times.
--
-- So the acknowledged message id travels with the post that acknowledges it, and lands here.
--
-- ── WHERE THIS MEASUREMENT STOPS, AND WHY THAT IS NOT A GAP ────────────────────────────────────
--
-- ADR-033 asks for `queue_ms`: the person's send to the moment their message actually starts a turn.
-- That metric is the wrong shape for a queued message, and the reason is in the drain itself.
--
-- DRAINING THE QUEUE DOES NOT START THE WORK. A queued message becomes a `queued_request` task, and
-- that task is created in `proposed`, which AWAITS THE REQUESTER - "it was proposed, it awaits an
-- answer, and only then does any work happen". So the span from the send to work beginning is mostly
-- a person deciding, and ADR-033 already rules on that: triage MOVES the work onto a different
-- measurement surface, where `v_task_resolution` separates `agent_ms` from human think time and never
-- enters the latency query, because one number would either flatter the turn or damn the workflow.
--
-- So this view stops at the handoff and names it honestly. `triaged_ms` is the send to the moment the
-- queue was READ - the last instant the platform alone is accountable for - and the task the message
-- became is where the rest lives, joined by the task's own `userMessageId`, which the drain sets to
-- the queued message id for exactly this purpose.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW.
-- ============================================================================

ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS acknowledges VARCHAR(128);

COMMENT ON COLUMN turn_events.acknowledges IS
    'On a notice_posted row only: the queued message id this acknowledgement answers. It is the join '
    'key a deferral has instead of a turn id, because the notice carries no correlation marker and is '
    'updated in place for every queued send. NULL on every other kind.';

CREATE INDEX IF NOT EXISTS turn_events_acknowledges_idx
    ON turn_events (acknowledges) WHERE acknowledges IS NOT NULL;

-- ============================================================================
-- ONE ROW PER QUEUED MESSAGE: when it was sent, when it was acknowledged, when the queue was read.
--
-- Deliberately its own view rather than more columns on `v_turn_latency`. That view is one row per
-- RESPONSE, and a deferral is not one: several queued messages share a single notice, so folding them
-- in would either duplicate the notice row or collapse the messages. Tenet D7 - one source per
-- question - applies inside a store as much as between them.
-- ============================================================================

CREATE OR REPLACE VIEW v_queue_acknowledgement AS
WITH sent AS (
    SELECT source_message_id AS message_id,
           channel_arn::text AS channel_arn,
           MIN(occurred_at)  AS sent_at
      FROM turn_events
     WHERE kind = 'user_message'
     GROUP BY source_message_id, channel_arn
),
acked AS (
    -- MIN, so a notice re-updated by a later send does not move an earlier message's instant. The
    -- acknowledgement a person got is the first one that named their message.
    SELECT acknowledges       AS message_id,
           channel_arn::text  AS channel_arn,
           MIN(occurred_at)   AS acknowledged_at,
           MIN(response_id)   AS notice_id
      FROM turn_events
     WHERE kind = 'notice_posted' AND acknowledges IS NOT NULL
     GROUP BY acknowledges, channel_arn
),
settled AS (
    -- The queue this message was waiting in was read. Keyed on the NOTICE, because that is what the
    -- settle updates, and taken as the first settle at or after the acknowledgement.
    SELECT response_id      AS notice_id,
           channel_arn::text AS channel_arn,
           MIN(occurred_at) AS settled_at
      FROM turn_events
     WHERE kind = 'notice_posted'
     GROUP BY response_id, channel_arn
)
SELECT
    a.message_id,
    a.channel_arn,
    s.sent_at,
    a.acknowledged_at,
    a.notice_id,
    st.settled_at,

    -- TIME TO FIRST FEEDBACK FOR A DEFERRED MESSAGE. The same question `ttff_ms` answers for an
    -- answered one, against the reply this person actually received.
    CASE WHEN s.sent_at IS NOT NULL AND a.acknowledged_at >= s.sent_at
         THEN (EXTRACT(EPOCH FROM (a.acknowledged_at - s.sent_at)) * 1000)::integer END AS ack_ms,

    -- THE WAIT UNTIL THE QUEUE WAS READ, which is where this platform's accountability ends for a
    -- deferred message. It is NOT when the work started: the message became a task in `proposed`,
    -- awaiting the requester, and everything after that is the task-resolution surface.
    CASE WHEN s.sent_at IS NOT NULL AND st.settled_at >= s.sent_at
         THEN (EXTRACT(EPOCH FROM (st.settled_at - s.sent_at)) * 1000)::integer END AS triaged_ms
  FROM acked a
  LEFT JOIN sent s   ON s.message_id = a.message_id AND s.channel_arn = a.channel_arn
  LEFT JOIN settled st ON st.notice_id = a.notice_id AND st.channel_arn = a.channel_arn;

COMMENT ON VIEW v_queue_acknowledgement IS
    'One row per QUEUED message: when the person sent it, when the deferral notice acknowledged it, '
    'and when the queue it was waiting in was read. ack_ms is time to first feedback for a message '
    'that was deferred rather than answered - the number ttff_ms cannot produce, because a queued '
    'message never gets a placeholder. triaged_ms is the wait until the queue was READ, which is not the '
    'queue_ms of ADR-033, and deliberately not: a queued message becomes a task in proposed, awaiting '
    'the requester, so work beginning is on the task-resolution surface and is joined there by the '
    'task''s userMessageId.';
