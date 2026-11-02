-- ============================================================================
-- `triaged_ms` REPORTED A READ THAT HAPPENED BEFORE THE ACKNOWLEDGEMENT IT FOLLOWED.
--
-- Migration 039 defined the moment a queue was read as:
--
--     MIN(occurred_at) FILTER (WHERE kind = 'notice_posted')  GROUP BY response_id
--
-- and called the result `settled_at`. It is not the settle. The notice is ONE message updated in
-- place - posted, updated for every queued send, updated again for every drain stage, and finally
-- settled - so all of those share a response id and a kind. MIN over them is the moment the notice
-- was CREATED.
--
-- Measured on the deployment, which is how it was found: rows where `triaged_ms` was SMALLER than
-- `ack_ms` (6225/3180, 2723/1190, 5078/3229). A queue cannot be read before the message waiting in
-- it was acknowledged, so the number was not merely imprecise, it was impossible - and it was
-- impossible in the direction that flatters, reporting a shorter wait than really happened.
--
-- MAX WOULD ALSO BE WRONG, just less obviously: for a queue still draining it returns the latest
-- STAGE, so an in-flight drain reports a read that has not happened. That is the same class of error
-- with a smaller error bar, which is worse, because nothing about it looks wrong.
--
-- So the stage is recorded rather than guessed. `turn_events.queue_status` carries what each notice
-- update was FOR, taken from the metadata the notice already published, and the read instant is the
-- update that said `settled`. A queue that has not settled has no read instant, and reports NULL -
-- which is the honest answer and distinguishes "still waiting" from "read quickly".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW.
-- ============================================================================

ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS queue_status VARCHAR(32);

COMMENT ON COLUMN turn_events.queue_status IS
    'On a notice_posted row only: the drain stage this update recorded (waiting, reviewing, '
    'clarifying, addressing_private, clearing, settled). The notice is one message updated in place, '
    'so without this the creation and the settle are indistinguishable - same id, same kind.';

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
    -- THE UPDATE THAT SAID SETTLED, not the first update and not the last. A queue still draining
    -- has no row here, and reports NULL rather than a read instant it has not reached.
    SELECT response_id       AS notice_id,
           channel_arn::text AS channel_arn,
           MIN(occurred_at)  AS settled_at
      FROM turn_events
     WHERE kind = 'notice_posted' AND queue_status = 'settled'
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
    --
    -- NULL while the queue is still draining, and the guard below keeps it NULL rather than negative
    -- if a settle is ever recorded before the send it followed - an impossible ordering is a data
    -- fault, and reporting it as a small positive number is how the previous definition hid one.
    CASE WHEN s.sent_at IS NOT NULL AND st.settled_at >= s.sent_at
         THEN (EXTRACT(EPOCH FROM (st.settled_at - s.sent_at)) * 1000)::integer END AS triaged_ms
  FROM acked a
  LEFT JOIN sent s     ON s.message_id = a.message_id AND s.channel_arn = a.channel_arn
  LEFT JOIN settled st ON st.notice_id = a.notice_id AND st.channel_arn = a.channel_arn;

COMMENT ON VIEW v_queue_acknowledgement IS
    'One row per QUEUED message: when the person sent it, when the deferral notice acknowledged it, '
    'and when the queue it was waiting in settled. ack_ms is time to first feedback for a message '
    'that was deferred rather than answered - the number ttff_ms cannot produce, because a queued '
    'message never gets a placeholder. triaged_ms is the wait until the queue was READ and is NULL '
    'until it settles; it is not the queue_ms of ADR-033, and deliberately not, because a queued '
    'message becomes a task in proposed awaiting the requester, so work beginning is on the '
    'task-resolution surface, joined there by the task''s userMessageId.';
