-- ============================================================================
-- 063: the classifier call is spend too, and it was measured and thrown away.
--
-- THE DECISION. "We also need to make sure we are actually calculating cost based
-- on what actually runs for the full flow. It is OK if it is only model spend for now, we just need to
-- say so."
--
-- WHAT WAS MISSING. Most turns ask a model to classify the intent before anything answers. That is a
-- real Bedrock call with real tokens, and `intent-classifier.ts` already captures both - it puts
-- `classifierTokensIn` and `classifierTokensOut` on its result. The router reads them and writes them
-- to a `console.log`. Nothing else. No column, no analytics record, no archive.
--
-- So the cost column on the Effectiveness surface covered the ANSWER and nothing else, and could not
-- have covered more: the numbers existed for the length of one log line. An operator comparing the
-- cost of two intents was comparing their answers while the cheaper-to-answer one might be paying more
-- to route.
--
-- WHY THE MODEL TOO, NOT JUST THE TOKENS. `classifier_ms` has been stored since 001 and says nothing
-- about price, because the classifier is per-PROFILE configurable (`models.byIntent`, and a profile
-- may pin its own classifier) - so two deployments with identical token counts can pay ten times
-- differently. A token count with no model beside it is not a cost, it is an input to one.
--
-- THREE COLUMNS AND NOT A JSONB BLOB. These are read by a SQL aggregate that sums per model, exactly
-- like `input_tokens` and `bedrock_model` are, and a reader should not have to reach into JSON to add
-- up spend. The same argument migration 042 made for `answers_message_id`.
--
-- NULL MEANS THE TURN NEVER ASKED A MODEL, which is a real and common case rather than a gap: the
-- pre-LLM fast paths settle greetings and acknowledgments without one, and an orchestrator-dispatched
-- rebuttal never classifies. Recording 0 would make the classifier look CHEAPER the more often it is
-- skipped, which is the same defect `classifier_ms` documents and avoids by staying NULL. Every row
-- written before this migration is also NULL, and the two are indistinguishable on purpose - a reader
-- segregates on the window, not on the column.
--
-- Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS, no CONCURRENTLY, COMMENT ON converges.
-- Applied at RUNTIME on a cold start inside one transaction (db-client applyPendingMigrations).
-- ============================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS classifier_tokens_in INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classifier_tokens_out INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classifier_model VARCHAR(256);

COMMENT ON COLUMN messages.classifier_tokens_in IS
    'Input tokens the intent classifier consumed for this turn. NULL when no model was asked - the '
    'pre-LLM fast paths and orchestrator-dispatched turns never classify - never 0, because averaging '
    'a zero in would report a cheaper classifier rather than a rarer one.';

COMMENT ON COLUMN messages.classifier_tokens_out IS
    'Output tokens the intent classifier produced for this turn. NULL on the same turns as '
    'classifier_tokens_in, and for the same reason.';

COMMENT ON COLUMN messages.classifier_model IS
    'The Bedrock model that classified this turn, as the invoke id or inference-profile ARN. Stored '
    'beside the tokens because the classifier is per-profile configurable, so a token count without '
    'the model that consumed it cannot be priced. NULL when no model was asked.';

-- The cost read sums these per model over a window, the same shape as the answer-token read it sits
-- beside. Partial: the overwhelming majority of rows are not classifier-bearing on a deployment with
-- healthy fast-path coverage, and a partial index keeps that skew out of the tree.
CREATE INDEX IF NOT EXISTS idx_messages_classifier_model
    ON messages (classifier_model, created_at DESC)
    WHERE classifier_model IS NOT NULL;
