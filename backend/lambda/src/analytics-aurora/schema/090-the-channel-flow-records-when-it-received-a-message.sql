-- 090: the hop in front of the router becomes divisible.
--
-- TTFF less the router's own span was one remainder: the message reaching the router, plus the
-- placeholder travelling back. The channel flow now records, on the server clock, when it received a
-- standard-path message, and the ledger keeps it as one `flow_received` row per response. With the
-- router's `entry` step that splits the remainder into the message reaching the flow, the flow
-- handing to the router, and what is left after.
--
-- SERVER CLOCK, ATTESTED, like the router's steps: `clock='server'`, `auditable=false`.
--
-- One instant per response, whichever event of the bot message carried it (the CREATE and its
-- updates all carry the analytics record), arbitrated by the database the way 041 arbitrates the
-- router's steps.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

CREATE UNIQUE INDEX IF NOT EXISTS uq_turn_events_flow_received_fact
    ON turn_events (source_message_id, kind)
    WHERE kind = 'flow_received';

COMMENT ON COLUMN turn_events.kind IS
    'What happened. WRITTEN TODAY - turn-scoped: user_message, placeholder_posted, progress_update, '
    'final_response, cancelled_response, error_response, notice_posted, continuation_chunk, '
    'content_redacted, message_deleted, router_step (server clock, one row per boundary of the '
    'router''s pre-placeholder path, named by step_name), flow_received (server clock, when the channel '
    'flow received the message a standard-path turn answers). WRITTEN TODAY - task-scoped: task_opened, '
    'task_transition, task_terminal (projected from the archive record task_transition/task_status '
    'by turn-events-live.ts). RESERVED, DECLARED BUT NOT WRITTEN BY ANY PRODUCER: processor_entry, '
    'content_edited - a query filtering on one of these returns nothing, which is a property of the '
    'writers rather than of the data. Only final_response may close a response; error_response and '
    'cancelled_response deliberately may NOT, because a turn whose wait ended without an answer must '
    'not be folded into time-to-answer. An unrecognised declared phase archives as progress_update, '
    'so a new update type is inert by default (fails closed into "not final").';
