-- 030: bring an EXISTING cluster up to the step-latency columns that 001 now creates.
--
-- WHY THIS FILE EXISTS WHEN THE COLUMNS ARE ALREADY IN 001-initial.sql. The two are not redundant,
-- they serve the two cluster states:
--
--   fresh cluster    - 001 runs and creates the columns; this file then finds them present and does
--                      nothing. That is the normal path for this deployment, which is torn down and
--                      rebuilt regularly.
--   EXISTING cluster - 001 is already recorded in `_migrations` and is never re-read, so editing it
--                      adds nothing. Only a NEW numbered file is picked up by applyPendingMigrations.
--
-- Without this, the columns would be absent on the live cluster while the archival INSERT names them,
-- and every message insert would FAIL. That is not a missing metric, it is analytics stopping - so
-- the file is here to keep the running deployment writable, not to hedge on the schema.
--
-- Aurora is inside the VPC and no operator reaches it directly; a numbered schema file applied on
-- cold start IS how DDL runs against it. That is the mechanism, not a workaround for one.
--
-- Idempotent and order-independent: every statement is IF NOT EXISTS, so it converges whether it runs
-- before 001's columns exist, after them, or twice.

-- The latency of each step of the message path (LATENCY-TARGETS.md, "The message path, step by step").
-- These NEST rather than add: classifier_ms is inside router_ms; poll_ms is inside
-- placeholder_resolve_ms; model_ms and tool_ms are inside latency_ms.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS router_ms              INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classifier_ms          INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS guard_ms               INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS placeholder_resolve_ms INTEGER;

COMMENT ON COLUMN messages.router_ms IS
    'The router handler''s own compute, from entry to handing the turn off, in ms. Server wall-clock, '
    'one Lambda, skew-free. Sits in FRONT of the placeholder, so it is inside TTFF - the part of the '
    'pre-answer wait this codebase controls. Distinct from exchanges.inbound_ms, which is cross-clock '
    'and spans the channel flow, Lex and this handler together as a bound rather than a step.';

COMMENT ON COLUMN messages.classifier_ms IS
    'What intent classification cost, measured by the router, in ms. A SUB-STEP of router_ms, not a '
    'sibling. NULL means no model was asked - the pre-LLM fast paths and orchestrator-dispatched '
    'rebuttals - so AVG is the cost WHEN a model is asked and COUNT is how often that happens. '
    'Zero-filling the nulls would make the classifier read as cheaper the more often it is skipped.';

COMMENT ON COLUMN messages.guard_ms IS
    'Admission, in ms: the duplicate-delivery claim plus the task-status write (the latter only on '
    'task turns, which is why those read higher). Named so the worker leg reconciles - total_ms less '
    'guard_ms, placeholder_resolve_ms and latency_ms is the finalize/update/archival tail.';

COMMENT ON COLUMN messages.placeholder_resolve_ms IS
    'Cost of locating the placeholder to answer on, in ms: the correlation-mapping read plus the '
    'fallback scan when one was needed. Timed from the start of resolution, NOT from processor entry '
    '- the dedup claim and the task-status write before it are not part of locating anything. A '
    'superset of poll_ms by exactly the mapping read.';

COMMENT ON COLUMN messages.poll_ms IS
    'Cost of the fallback placeholder SCAN only, in ms, and NULL when no scan ran (never 0). COUNT of '
    'this column is how often the channel flow''s placeholder-id handoff did not supply a target; AVG '
    'of it is what a scan costs when it happens. Rows written before this migration hold a different '
    'span - processor entry to placeholder resolved, including the dedup claim and the task-status '
    'write - so a window crossing that changeover mixes two definitions.';
