-- Migration 009: drift_events reasoning-decision columns (ADR-013)
--
-- ADR-013 moves the drift DECISION from a cosine-distance threshold to an LLM
-- reasoning verdict over the conversation's purpose. The decision therefore no
-- longer produces a `cosine_distance` (that column already allows NULL — see
-- migration 006 — and is now NULL for reasoning-decision rows, just as it was
-- for explicit-intent fires). What the decision DOES produce is a verdict and a
-- human-auditable rationale, which is what makes drift effectiveness
-- *inspectable* in the admin console (a deployer can read WHY drift fired, which
-- a cosine bucket never told them).
--
-- Cosine similarity is retained only for RETRIEVAL — picking which existing
-- conversation a confirmed drift redirects to (`rival_conversation_arn`). That
-- value lands in `retrieval_similarity`, clearly scoped to retrieval, never the
-- decision.
--
-- Purely additive + idempotent (ADD COLUMN IF NOT EXISTS). Existing rows keep
-- their cosine decision data; `decision_method` defaults to 'cosine' so historic
-- rows are correctly labelled as the pre-ADR-013 mechanism.

ALTER TABLE drift_events
    ADD COLUMN IF NOT EXISTS verdict VARCHAR(8)
        CHECK (verdict IN ('drift', 'stay'));

ALTER TABLE drift_events
    ADD COLUMN IF NOT EXISTS rationale TEXT;

ALTER TABLE drift_events
    ADD COLUMN IF NOT EXISTS decision_method VARCHAR(16) NOT NULL DEFAULT 'cosine'
        CHECK (decision_method IN ('reasoning', 'cosine', 'explicit'));

ALTER TABLE drift_events
    ADD COLUMN IF NOT EXISTS retrieval_similarity NUMERIC(6, 4);

COMMENT ON COLUMN drift_events.verdict IS
    'The reasoning gate''s decision: drift (suggest a separate conversation) or '
    'stay (relevant tangent, belongs here). NULL for pre-ADR-013 cosine rows.';

COMMENT ON COLUMN drift_events.rationale IS
    'The reasoning gate''s one-sentence reason for the verdict — the '
    'human-auditable signal the admin console surfaces for effectiveness '
    'spot-checks. By-reference principle (see table comment): this is a '
    'TOPIC-LEVEL judgment, not the message body, and must not quote user '
    'content; it is nulled alongside originating_message_id on PII erasure.';

COMMENT ON COLUMN drift_events.decision_method IS
    'How the fire was decided: reasoning (ADR-013 LLM judgment), cosine '
    '(pre-ADR-013 embedding threshold), or explicit (user routing fast-path).';

COMMENT ON COLUMN drift_events.retrieval_similarity IS
    'Cosine similarity of the chosen redirect target (rival_conversation_arn) '
    'from pgvector retrieval. Scoped to RETRIEVAL only — never the decision. '
    'NULL when the suggestion was a new conversation (no redirect target).';
