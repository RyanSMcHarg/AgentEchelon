-- Migration 013: the full latency set (LATENCY-TARGETS.md "The full latency set")
--
-- The dashboard previously exposed only latency_ms (Bedrock, which also wraps tool
-- I/O + guardrail), total_ms (server compute from processor entry, not the user's
-- wall-clock wait), poll_ms, and response_latency_ms (TTFF = user -> placeholder).
-- The one number operators actually want - user message -> FINAL answer - did not
-- exist, and "Bedrock" could not be split into model vs tool time.
--
-- This adds the whole intended set at once so the console is stable from launch and
-- no deployment migrates late:
--   messages.agent_final_at  - the instant the final answer replaced the placeholder,
--                              from the Chime UpdateChannelMessage LastUpdatedTimestamp
--                              (skew-free: same Chime clock as user_message_at).
--   exchanges.e2e_ms         - agent_final_at - user_message_at (user -> final answer).
--   messages.model_ms        - sum of the Converse-call deltas in the tool loop.
--   messages.tool_ms         - sum of in-loop tool execution (RAG / S3 context).
--   exchanges.inbound_ms     - user message -> async processor entry (routing / queue / cold
--                              start). CROSS-CLOCK (Chime start vs server-clock entry): clamped
--                              to >= 0 at derivation; approximate by design.
--
-- All latency telemetry rides the out-of-band DynamoDB analytics store, not the
-- size-capped Chime messaging metadata, so these columns cost nothing against the
-- 1024-char cap. All nullable: absent values are skipped by AVG/PERCENTILE and never
-- wrong-valued during first traffic. No backfill.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Same schema-init Update-path caveat as
-- migrations 010-012: applies on a fresh cluster Create; an already-bootstrapped
-- cluster must apply it out-of-band (or be re-stood-up).

ALTER TABLE messages   ADD COLUMN IF NOT EXISTS agent_final_at TIMESTAMPTZ;
ALTER TABLE messages   ADD COLUMN IF NOT EXISTS model_ms       INTEGER;
ALTER TABLE messages   ADD COLUMN IF NOT EXISTS tool_ms        INTEGER;
ALTER TABLE exchanges  ADD COLUMN IF NOT EXISTS e2e_ms         INTEGER;
ALTER TABLE exchanges  ADD COLUMN IF NOT EXISTS inbound_ms     INTEGER;

COMMENT ON COLUMN messages.agent_final_at IS
    'Chime UpdateChannelMessage LastUpdatedTimestamp of the final answer replacing the '
    'placeholder. Same Chime clock as the user message, so e2e_ms is skew-free. '
    'LATENCY-TARGETS.md.';
COMMENT ON COLUMN exchanges.e2e_ms IS
    'End-to-end user-perceived latency in ms: agent_final_at - user_message_at (user '
    'message to final answer). NULL until agent_final_at is present. LATENCY-TARGETS.md.';
COMMENT ON COLUMN messages.model_ms IS
    'Sum of Converse-call (model inference) deltas in the tool loop, in ms. With tool_ms '
    'and the guardrail it reconciles to latency_ms. LATENCY-TARGETS.md.';
COMMENT ON COLUMN messages.tool_ms IS
    'Sum of in-loop tool-execution (RAG / S3 company context) deltas in the tool loop, in ms. '
    'LATENCY-TARGETS.md.';
COMMENT ON COLUMN exchanges.inbound_ms IS
    'User message -> async processor entry (routing / queue / cold start), in ms. CROSS-CLOCK '
    '(Chime start vs server-clock processor entry); clamped to >= 0 and approximate by design. '
    'LATENCY-TARGETS.md.';
