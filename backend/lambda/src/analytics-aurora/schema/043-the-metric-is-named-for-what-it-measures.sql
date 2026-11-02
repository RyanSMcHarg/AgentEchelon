-- `triaged_ms` WAS NAMED FOR A MOMENT IT DOES NOT MEASURE.
--
-- Both 039 and 040 describe it as "the wait until the queue was READ", and AR2 asks for exactly that.
-- It is not what the column contains. `settled_at` is the `queue_status='settled'` update, and that
-- update is written AFTER the reading, the proposal, task creation, the private follow-ups, the queue
-- clear and a `readTurnState` round trip. So the number spans the whole drain, and disagrees with the
-- `QueueWaitMs` metric by roughly the duration of a model call.
--
-- ── WHY IT IS RENAMED RATHER THAN RE-ANCHORED ─────────────────────────────────
--
-- The `reviewing` row IS recorded and would give the read instant directly, so re-anchoring was
-- available and was NOT taken. Re-anchoring silently changes what every previously-reported figure
-- meant: the same column name would carry two different measurements either side of this migration,
-- and nothing in the data says which one a given row is. A number that quietly changes definition is
-- worse than one that was always named badly, because the second is discoverable by reading and the
-- first is not.
--
-- So the measurement stands and the NAME becomes true: `drained_ms`, the send to the moment the queue
-- finished draining. Anyone wanting the read instant can build it on the `reviewing` row - which is
-- still there, still unused, and now not mistaken for this.
--
-- ── AND A REFUSED NOTICE UPDATE LOSES THE ANCHOR ──────────────────────────────
--
-- The instant is keyed on the notice the acknowledgement landed on. `turn-queue-notice.ts` falls
-- through to posting a FRESH notice when an update is refused - "No operations allowed for messages in
-- processing", which `settleQueueNotice`'s own comment says happens reliably - so the settle lands on
-- a notice id no acknowledgement ever named, and the earliest, longest-waiting message of that episode
-- reports NULL forever.
--
-- Carrying the original instant onto the replacement was the alternative and was NOT taken: it would
-- attribute a read to a notice that never acknowledged anything, which is a fabricated join rather
-- than a missing one. The anchor is LOST, and that is now said here rather than discovered by somebody
-- wondering why the longest waits are missing from a distribution built on it.
--
-- WHAT THAT MEANS FOR A READER, and it is the part worth stating: the rows that go missing are not
-- random. They are the FIRST message of an episode, which is the one that waited longest, so the
-- reported distribution is biased SHORT. Treat it as a floor on the wait, never as the wait.
--
-- DROPPED AND RECREATED, NOT REPLACED. `CREATE OR REPLACE VIEW` may add columns but may not rename
-- one: Postgres refuses with "cannot change name of view column". Migrations run inside
-- `ensureSchema` on every cold start and rethrow, so a refused replace would fail schema init for
-- every Aurora Lambda on every cold start. Nothing else in the schema depends on this view, so the
-- drop takes nothing with it, and both statements run in the migration runner's one transaction, so
-- there is no instant at which the view is missing. Idempotent: `IF EXISTS` covers a fresh cluster.
--
-- The one reader outside the schema, `queueAcknowledgementSample` (turn-events-backfill.ts), selects
-- `drained_ms` in the same change.

DROP VIEW IF EXISTS v_queue_acknowledgement;

CREATE VIEW v_queue_acknowledgement AS
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
    -- has no row here, and reports NULL rather than an instant it has not reached.
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
    -- answered one, against the reply this person actually received. Unchanged.
    CASE WHEN s.sent_at IS NOT NULL AND a.acknowledged_at >= s.sent_at
         THEN (EXTRACT(EPOCH FROM (a.acknowledged_at - s.sent_at)) * 1000)::integer END AS ack_ms,

    -- THE SEND TO THE MOMENT THE QUEUE FINISHED DRAINING. Named for what it measures: the reading,
    -- the proposal, task creation, the follow-ups and the clear are all inside it.
    --
    -- It is NOT the moment the queue was read, and it is NOT when work started - the message became a
    -- task in `proposed` awaiting the requester, and everything after that is the task-resolution
    -- surface. NULL while the queue is still draining, and NULL rather than negative if a settle is
    -- somehow recorded before the send it followed, because an impossible ordering is a data fault
    -- and reporting it as a small positive number is how the previous definition hid one.
    CASE WHEN s.sent_at IS NOT NULL AND st.settled_at >= s.sent_at
         THEN (EXTRACT(EPOCH FROM (st.settled_at - s.sent_at)) * 1000)::integer END AS drained_ms
  FROM acked a
  LEFT JOIN sent s     ON s.message_id = a.message_id AND s.channel_arn = a.channel_arn
  LEFT JOIN settled st ON st.notice_id = a.notice_id AND st.channel_arn = a.channel_arn;

COMMENT ON VIEW v_queue_acknowledgement IS
    'One row per QUEUED message: when the person sent it, when the deferral notice acknowledged it, '
    'and when the queue it was waiting in finished draining. ack_ms is time to first feedback for a '
    'message that was deferred rather than answered - the number ttff_ms cannot produce, because a '
    'queued message never gets a placeholder. drained_ms is the send to the END OF THE DRAIN, not the '
    'moment the queue was read: it includes the reading, the proposal, task creation and the clear. '
    'It was called triaged_ms and described as the read instant, which it never was; the reviewing '
    'row carries the read instant for anyone who needs it. drained_ms is NULL while a queue is still '
    'draining, and ALSO NULL for the whole episode when a notice update was refused and a fresh '
    'notice was posted instead - the settle then lands on a notice id no acknowledgement named. Those '
    'missing rows are the FIRST message of an episode, which waited longest, so any distribution '
    'built on this is biased SHORT and is a floor on the wait rather than the wait.';
