-- Migration 007: conversation_creation_tasks
--
-- Backs the RoutingState helper in lib/routing-state.ts. Stores pending
-- drift-suggestion state so the user's next-turn confirm/decline survives
-- Lex session resets.
--
-- Primary state lives in Lex sessionAttributes for the in-flight turn;
-- this table is a backup read on session-reset paths.

CREATE TABLE IF NOT EXISTS conversation_creation_tasks (
    task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub VARCHAR(128) NOT NULL,
    channel_arn VARCHAR(256) NOT NULL,
    suggestion_kind VARCHAR(16) CHECK (suggestion_kind IN ('confirm', 'redirect')),
    rival_conversation_arn VARCHAR(256),
    originating_message_id VARCHAR(256) NOT NULL,
    cosine_distance NUMERIC(6, 4),
    correlation_id UUID,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes')
);

CREATE INDEX IF NOT EXISTS idx_creation_tasks_user_channel
    ON conversation_creation_tasks (user_sub, channel_arn);

-- For finding pending tasks for a user (the read path on next turn):
CREATE INDEX IF NOT EXISTS idx_creation_tasks_pending
    ON conversation_creation_tasks (user_sub, channel_arn, status)
    WHERE status = 'pending';

-- For the periodic expiry sweep (mark stale pending rows as 'expired'):
CREATE INDEX IF NOT EXISTS idx_creation_tasks_expiry
    ON conversation_creation_tasks (expires_at)
    WHERE status = 'pending';

COMMENT ON TABLE conversation_creation_tasks IS
    'Pending drift-suggestion state, backing lib/routing-state.ts. Primary '
    'state is in Lex sessionAttributes; this table is the backup read path '
    'on session reset. Rows expire after 30 minutes via the periodic sweep.';

COMMENT ON COLUMN conversation_creation_tasks.suggestion_kind IS
    'confirm: bot offered to create a new conversation (no related channel matched). '
    'redirect: bot offered to switch to an existing related channel (rival_conversation_arn set).';

COMMENT ON COLUMN conversation_creation_tasks.cosine_distance IS
    'The cosine distance at which drift fired. Stored so decline-suppression '
    'can suppress re-fires within ±0.05 for the next 3 turns.';
