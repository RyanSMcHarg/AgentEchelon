-- A DECLINED DRIFT TOPIC BECOMES A TOPIC OF THE CONVERSATION.
--
-- "Once drift is declined the topic determined as drift becomes a topic of the conversation, so
-- therefore should no longer be considered drift." Declining an offer to split a subject out is the
-- person saying that subject belongs HERE. So the next message about it is not a pivot, however far it
-- sits from the conversation's averaged summary.
--
-- WHAT THIS REPLACES. Declines were a list of cosine DISTANCES kept in the Amazon Lex session: a new
-- message was suppressed when its distance from the summary landed within 0.05 of a declined one. That
-- was wrong twice. It matched a NUMBER, not a subject, so an unrelated topic that happened to sit at the
-- same distance was suppressed and the declined topic itself fired again once its distance moved. And
-- it lived in the Lex session, which only exists when Lex is the entry, is dropped after five idle
-- minutes, and is discarded entirely when the channel flow answers the turn.
--
-- THE TABLE IS THE ONE SPEC-DRIFT-CONVERGENCE ALREADY DESIGNS for its known-topic check (algorithm step
-- 6b): one row per topic per conversation, compared by cosine against the message before a drift offer
-- is made. A declined drift topic is the first writer of that table. The summariser's per-topic rows
-- the spec also describes are not built, and `origin` is what keeps the two apart when they are: a
-- summary rewrite replaces its own rows and must never delete a topic a person chose to keep.
--
-- HOW A ROW GETS HERE. When a live drift offer fires, the data plane already holds the message
-- embedding it compared, so it stores that embedding as an `offered` row keyed by the offer's
-- correlation id. A decline promotes the row to `adopted`. Only `adopted` rows are topics. This keeps
-- the by-reference rule (no message text is stored, here or anywhere on the drift path) and needs
-- neither a second embedding call nor a read of the message back from Amazon Chime SDK.
--
-- CLASSIFICATION-BOUNDED (ADR-028). It holds conversation-derived vectors, exactly as
-- `summary_embeddings` does, so it carries a `classification` column and joins BOUNDED_TABLES: reads
-- run as the channel's reader role and writes as the writer role, with FORCE ROW LEVEL SECURITY
-- generated from the deployment's registry (`classification-boundary-sql.ts`), never hardcoded here.
--
-- IDEMPOTENT + TRANSACTION-SAFE: applied at Lambda cold start inside the shared migration transaction.

CREATE TABLE IF NOT EXISTS conversation_topic_embeddings (
    channel_arn VARCHAR(256) NOT NULL,
    -- `drift:<correlationId>` for a drift offer. The summariser's rows would use their own prefix.
    topic_key VARCHAR(256) NOT NULL,
    origin VARCHAR(32) NOT NULL CHECK (origin IN ('drift_offer')),
    status VARCHAR(16) NOT NULL CHECK (status IN ('offered', 'adopted')),
    embedding vector(1024) NOT NULL,
    classification TEXT,
    model_id VARCHAR(128) NOT NULL DEFAULT 'amazon.titan-embed-text-v2:0',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    adopted_at TIMESTAMPTZ,
    PRIMARY KEY (channel_arn, topic_key)
);

-- The known-topic check reads a channel's adopted topics on every over-threshold turn.
CREATE INDEX IF NOT EXISTS idx_topic_embeddings_adopted
    ON conversation_topic_embeddings (channel_arn)
    WHERE status = 'adopted';

CREATE INDEX IF NOT EXISTS idx_topic_embeddings_classification
    ON conversation_topic_embeddings (classification);

COMMENT ON TABLE conversation_topic_embeddings IS
    'One row per topic per conversation (SPEC-DRIFT-CONVERGENCE step 6b). A drift offer stores the '
    'message embedding as offered; a decline adopts it, and adopted rows are the conversation''s own '
    'topics, so a message near one is not drift. No message text is stored. Classification-bounded '
    '(ADR-028).';

-- THE PENDING OFFER CARRIES ITS DRIFT EVENT, so the durable record is complete on its own.
--
-- The Lex session copy held `driftEventId`; this table did not, so an offer resumed from here could not
-- record its outcome and the drift_events row stayed NULL until the abandonment detector mislabelled it.
-- With the session gone this record is the only one, so it has to carry the id.
ALTER TABLE conversation_creation_tasks ADD COLUMN IF NOT EXISTS drift_event_id TEXT;

COMMENT ON TABLE conversation_creation_tasks IS
    'The pending drift offer for (user, channel), read at the start of every drift turn. The only '
    'record of an open offer: it does not ride the Amazon Lex session.';
