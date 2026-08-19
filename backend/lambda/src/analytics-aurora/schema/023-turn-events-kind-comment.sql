-- 023-turn-events-kind-comment.sql
--
-- Correct the `turn_events.kind` column comment to enumerate what the writers ACTUALLY emit, and to
-- say plainly which declared kinds nothing writes yet.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT TO 019. Migrations apply once. `019-turn-audit.sql` is
-- already applied on every existing cluster, so editing its text changes nothing on a deployment that
-- has run it, and would only make a fresh cluster disagree with an established one. A comment is
-- schema, and schema changes forward.
--
-- WHAT WAS WRONG. 019's comment listed `user_message, placeholder_posted, progress_update,
-- final_response, continuation_chunk, processor_entry, content_edited/content_redacted/
-- message_deleted` plus the task kinds. It omitted **`error_response`** and **`notice_posted`**, both
-- of which `turn-events-live.ts` `kindForPhase` emits today. `error_response` is the one that matters:
-- it is the kind that distinguishes a turn that correctly did not close from an answer that was lost,
-- which is the entire question the unclosed-turn split exists to answer. A reader auditing the ledger
-- from its own schema would have concluded that distinction was not recorded.
--
-- AND WHAT THE CORRECTION EXPOSED. Four of the kinds 019 declared have NO WRITER anywhere:
-- `task_opened`, `task_terminal`, `processor_entry`, and `task_transition` as a ledger kind (the
-- identifier does appear in `kinesis-archival.ts`, but as a COLUMN on the message record, not as a
-- `turn_events.kind`). The comment below marks them RESERVED rather than quietly dropping them,
-- because a reader needs to know they are declared-but-unwritten, and because `v_task_resolution`
-- is built entirely on three of them. See the note on that view below.

COMMENT ON COLUMN turn_events.kind IS
    'What happened. WRITTEN TODAY - turn-scoped: user_message, placeholder_posted, progress_update, '
    'final_response, error_response, notice_posted, continuation_chunk, content_redacted, '
    'message_deleted. RESERVED, DECLARED BUT NOT WRITTEN BY ANY PRODUCER: processor_entry, '
    'content_edited, task_opened, task_transition, task_terminal - a query filtering on one of these '
    'returns nothing, which is a property of the writers rather than of the data. Only final_response '
    'may close a response; error_response deliberately may NOT, because a turn whose wait ended '
    'without an answer must not be folded into time-to-answer. An unrecognised declared phase '
    'archives as progress_update, so a new update type is inert by default (fails closed into "not '
    'final").';

-- ============================================================================
-- v_task_resolution: INERT until a producer emits the task kinds.
--
-- The view aggregates `task_opened`, `task_terminal` and `task_transition` out of `turn_events`, and
-- nothing writes any of them, so every task row it could produce is absent rather than incomplete.
-- Measured on a live deployment over a 47-day window with substantial task traffic: it returns ZERO
-- rows.
--
-- The view is deliberately LEFT IN PLACE and its definition is unchanged. It is correct SQL over an
-- unwritten input, so the fix belongs at the producer, and dropping the view would only hide that the
-- measurement was promised. This comment is what stops it being read as a working measurement whose
-- emptiness means "no tasks were resolved".
-- ============================================================================
COMMENT ON VIEW v_task_resolution IS
    'Whole-task resolution, one row per task_id. INERT AS OF THIS MIGRATION: it reads the turn_events '
    'kinds task_opened / task_terminal / task_transition, and NO producer emits any of them, so the '
    'view returns no rows on any deployment. An empty result means the events are not written, NOT '
    'that no task resolved. resolve_ms is wall clock and is mostly HUMAN think time; agent_ms is the '
    'summed per-turn e2e, the only part the system is accountable for. This is not a latency metric '
    'and must never enter getLatencyMetrics or computeAlerts.';
