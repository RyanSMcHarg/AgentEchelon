-- ============================================================================
-- `cancelled_response` JOINS THE DECLARED VOCABULARY.
--
-- `turn-events-live.ts` has emitted it since `/stop` learned to suppress a running answer
-- (`kindForPhase`, case 'cancelled'), and the column comment in force still listed the vocabulary
-- without it. A reader auditing the ledger from its own schema would have concluded that a stopped
-- turn was not recorded as its own outcome at all - which is exactly the drift migration 024 was
-- written to correct for `error_response` and `notice_posted`, recurring one kind later.
--
-- WHY IT IS ITS OWN OUTCOME, restated here because the schema is where a query author reads it:
-- the person stopped the work while it ran, so the turn resolved exactly as asked. Counting it
-- `final` would fold a discarded answer into the completion average; counting it `error` would
-- report a fault where somebody changed their mind; leaving it to the default would make it a
-- `progress_update` and therefore an unclosed turn, which is the measurement gap ADR-033 says it
-- must not become.
--
-- LIKE `error_response`, IT DOES NOT CLOSE A RESPONSE. A turn whose wait ended without an answer
-- must not be folded into time-to-answer, and a cancelled turn produced no answer by construction.
--
-- Idempotent: a comment is declarative and re-applying it is a no-op.
-- ============================================================================
COMMENT ON COLUMN turn_events.kind IS
    'What happened. WRITTEN TODAY - turn-scoped: user_message, placeholder_posted, progress_update, '
    'final_response, cancelled_response, error_response, notice_posted, continuation_chunk, '
    'content_redacted, message_deleted. WRITTEN TODAY - task-scoped: task_opened, task_transition, '
    'task_terminal (projected from the archive record task_transition/task_status by '
    'turn-events-live.ts). RESERVED, DECLARED BUT NOT WRITTEN BY ANY PRODUCER: processor_entry, '
    'content_edited - a query filtering on one of these returns nothing, which is a property of the '
    'writers rather than of the data. Only final_response may close a response; error_response and '
    'cancelled_response deliberately may NOT, because a turn whose wait ended without an answer must '
    'not be folded into time-to-answer. An unrecognised declared phase archives as progress_update, '
    'so a new update type is inert by default (fails closed into "not final").';
