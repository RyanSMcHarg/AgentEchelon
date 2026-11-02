-- A TOOL CALL IS JUDGED BY WHAT IT DID (SPEC-EVALUATION Appendix C3, FR11).
--
-- A turn recorded which tools ran and whether each failed, and nothing about whether the right tool was
-- called with the right arguments, whether its result was usable, or whether the reply said something
-- the result does not support. One row here per call, plus one per tool the turn held and did not call
-- where the judge found it covered the request, so every finding names one outcome and one owner:
--
--   used_correctly    nothing to fix
--   not_called        the assistant's team (its instructions)
--   wrong_arguments   the assistant's team
--   errored           the tool's owner (decided from the recorded error, no judge)
--   empty             the tool's owner, or the context source behind it
--   contradicted      the assistant's team
--
-- `decided_by` says how: `deterministic` (an error the turn recorded), `effect` (a tool the registry
-- marks as changing state, scored from the platform's own record of the change), or `judge`. A judged
-- row names the evaluator model and the rubric version, as every other verdict here does (FR10).
--
-- `call_index` is the call's position in the turn's record, and -1 on a not-called row, so a call and a
-- not-called finding for the same tool never collide.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe.
CREATE TABLE IF NOT EXISTS tool_call_verdicts (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exchange_id                 UUID NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    call_index                  SMALLINT NOT NULL,
    tool_name                   VARCHAR(64) NOT NULL,
    outcome                     VARCHAR(24) NOT NULL CHECK (outcome IN
                                  ('used_correctly', 'not_called', 'wrong_arguments', 'errored', 'empty', 'contradicted')),
    owner                       VARCHAR(128) NOT NULL,
    decided_by                  VARCHAR(16) NOT NULL CHECK (decided_by IN ('deterministic', 'effect', 'judge')),
    reasoning                   TEXT,
    assistant                   VARCHAR(64),
    conversation_classification VARCHAR(32),
    intent                      VARCHAR(64),
    evaluator_model             VARCHAR(128),
    rubric_version              VARCHAR(64),
    run_id                      VARCHAR(64),
    evaluated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One verdict per call (or per not-called tool) per exchange: a second run is a no-op, not a second vote.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_call_verdicts_call
    ON tool_call_verdicts (exchange_id, call_index, tool_name);

CREATE INDEX IF NOT EXISTS idx_tool_call_verdicts_tool
    ON tool_call_verdicts (tool_name, evaluated_at DESC);

COMMENT ON TABLE tool_call_verdicts IS
    'One verdict per tool call, and per covering tool the turn held and did not call (SPEC-EVALUATION '
    'Appendix C3). outcome names what happened and owner who fixes it; decided_by says whether it came '
    'from a recorded error, the recorded effect of a state-changing tool, or the tool judge.';
