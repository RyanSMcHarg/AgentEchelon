-- 106: EVERY MODEL TURN IS AN EXCHANGE, WHOEVER STARTED IT.
--
-- A turn the platform starts (a workflow step, an event, a task step, a meeting's summary, a request another assistant
-- made) answers no person's message, so it has no user message to pair with, and the exchange ledger that Performance
-- reads held none of them. Archival now records one exchange for each such answer that a model served
-- (`createPlatformExchanges`): `user_message_id` is NULL, `user_message_at` is when the platform dispatched the turn, and
-- `paired_by = 'platform'`. Its entry (`messages.turn_entry = 'platform'`) is a dimension every view breaks down by, never
-- a filter that hides it (SPEC-ADMIN-CONSOLE-EFFECTIVENESS FR43).
--
-- ONE EXCHANGE PER ANSWER: the person-message pairs are unique on (user, agent) (migration 017), which a NULL user never
-- collides on, so a platform answer is unique on its agent message alone. A re-delivered batch inserts nothing twice.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

CREATE UNIQUE INDEX IF NOT EXISTS exchanges_platform_agent_message_uniq
  ON exchanges (agent_message_id)
  WHERE user_message_id IS NULL;

COMMENT ON COLUMN exchanges.paired_by IS
    'How this pair was made. declared - the answer named the message it answers. in_batch - inferred from order within one '
    'Kinesis batch. mention - the answer carried the message''s mention correlation. swept - reconstructed by the '
    'cross-batch reconciliation pass, whose response_latency_ms must not vote in a time-to-first-feedback average. '
    'platform - a turn the platform started (a workflow or event step, a task step, a meeting summary, a request another '
    'assistant made): it answers no person message, user_message_id is NULL, and user_message_at is when it was dispatched.';
