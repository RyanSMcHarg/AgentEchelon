-- 096: A GOLDEN RUN WALKS A MULTI-STEP TASK IN A SANDBOX (ADR-066 decision 7, SPEC-EVALUATION FR17).
--
-- THE ENTRY CARRIES THE EXCHANGE ITS SOURCE TASK HELD, so a run can walk the draft's machine with nothing live:
--
--   walk_exchange     `{ "version": 1, "taskType": <the task's type>, "turns": [...] }`, the task's turns in order:
--                     `{ "kind": "person", "text" }` from the conversation's de-identified copy, and
--                     `{ "kind": "tool", "name", "args", "result", "ok", "step" }` from each answer's recorded tool calls
--                     (`toolCalls`, SPEC-EVALUATION Appendix C3), with `args` and `result` passed through the same
--                     detector the de-identified copy is made with. Copied at nomination, as `used_tools` is (094), so
--                     the entry stands when the exchange is deleted. NULL on an entry whose answer belongs to no task,
--                     and on every entry nominated before this migration, which stays a text entry.
--
-- WHAT ONE WALK RECORDED, beside the attempt it was:
--
--   walk              on `golden_run_attempts`: `{ "outcome": "passed"|"failed"|"not-exercised", "reason", "step",
--                     "tool", "endState", "path" }`. `not_exercised` carries `step` or `tool` where a walk could not
--                     go on (no recorded answer for the step, no recorded result for the call). NULL on a text attempt.
--
-- Both tables are already bounded by classification (089, 094); a new column changes no policy.
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and transaction-safe.

ALTER TABLE golden_set_entries ADD COLUMN IF NOT EXISTS walk_exchange JSONB;
ALTER TABLE golden_run_attempts ADD COLUMN IF NOT EXISTS walk JSONB;

COMMENT ON COLUMN golden_set_entries.walk_exchange IS
    'The de-identified exchange of the task the entry''s answer belonged to: person turns and tool calls with their '
    'results, in order (ADR-066 decision 7). NULL on a text entry.';
COMMENT ON COLUMN golden_run_attempts.walk IS
    'How a walk of a multi-step entry ended: outcome, reason, the step or tool named, the end state and the path '
    '(ADR-066 decision 7). NULL on a text attempt.';
