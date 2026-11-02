-- A CONVERSATION READ WITHOUT WHO SAID IT (SPEC-ADMIN-CONSOLE FR54, DESIGN-ADMIN-CONSOLE 5.3).
--
-- The de-identified copy: one timeline per conversation of messages and membership changes, each
-- person a pseudonym stable within that conversation, personal data replaced by a typed placeholder.
-- It is derived by the daily batch (`clean-copy-batch.ts`) and is never a record: the archive answers
-- what happened, and a removal in it is applied at READ time (`adminCleanConversation`) so a message
-- removed after the last run never shows its text, before the next run deletes it here.
--
-- NOT A COPY OF WHAT WAS SAID. Migration 068 removed the one verbatim copy outside the message, the
-- Aurora archive and S3. These rows hold text the detector has rewritten, keyed back to the original
-- by message id, which is the reference that migration asks for.
--
-- NOT A BOUNDED TABLE. It is read only on the admin plane, as `messages` is, and holds strictly less
-- than `messages` does. A turn's data plane never reads it.
--
-- Idempotent and transaction-safe: it applies at runtime on a cold start (`ensureSchema`).

CREATE TABLE IF NOT EXISTS clean_conversation_rows (
    channel_arn       VARCHAR(256) NOT NULL,
    seq               INTEGER      NOT NULL,
    kind              VARCHAR(16)  NOT NULL CHECK (kind IN ('message', 'membership')),
    -- The Amazon Chime SDK MessageId the row derives from, so a `-RED` or `-DEL` sibling can be
    -- joined at read time. NULL for a membership change.
    source_message_id VARCHAR(256),
    occurred_at       TIMESTAMPTZ  NOT NULL,
    -- `Person N`, or the assistant's name.
    actor             VARCHAR(128) NOT NULL,
    actor_kind        VARCHAR(16)  NOT NULL CHECK (actor_kind IN ('person', 'assistant')),
    -- Membership only: what changed, and for whom.
    action            VARCHAR(32),
    subject           VARCHAR(128),
    -- De-identified text. NULL for a removed message and for a membership change.
    text              TEXT,
    -- De-identified first version, when a person edited the message.
    original_text     TEXT,
    state             VARCHAR(16)  NOT NULL DEFAULT 'present' CHECK (state IN ('present', 'redacted', 'deleted')),
    PRIMARY KEY (channel_arn, seq)
);

-- One row per derived conversation: what the copy was derived from, so the batch can tell which
-- conversations changed since (any new archived row raises the count or the latest time).
CREATE TABLE IF NOT EXISTS clean_conversations (
    channel_arn     VARCHAR(256) PRIMARY KEY,
    classification  VARCHAR(32),
    source_rows     INTEGER      NOT NULL,
    source_latest   TIMESTAMPTZ,
    derived_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    detector        VARCHAR(128) NOT NULL
);

-- Every run, complete or not, so an operator can see when the copy was last brought up to date.
CREATE TABLE IF NOT EXISTS clean_copy_runs (
    run_id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at     TIMESTAMPTZ  NOT NULL,
    finished_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    outcome        VARCHAR(16)  NOT NULL CHECK (outcome IN ('complete', 'incomplete', 'failed')),
    conversations  INTEGER      NOT NULL DEFAULT 0,
    remaining      INTEGER,
    failure        TEXT
);

CREATE INDEX IF NOT EXISTS idx_clean_copy_runs_finished ON clean_copy_runs (finished_at DESC);
