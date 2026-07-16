-- ============================================================================
-- Agent Interface Analytics - Initial Schema
-- Aurora PostgreSQL 15 Serverless v2
--
-- Run via schema-init custom resource Lambda on first deploy.
-- All statements are idempotent (IF NOT EXISTS).
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CONVERSATIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_arn VARCHAR(256) NOT NULL UNIQUE,
    summary TEXT,
    status VARCHAR(32) DEFAULT 'active',
    user_type VARCHAR(32),
    agent_type VARCHAR(32),
    user_id VARCHAR(256),
    message_count INTEGER DEFAULT 0,
    user_message_count INTEGER DEFAULT 0,
    bot_message_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    first_message_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ,
    last_evaluated_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_arn);
CREATE INDEX IF NOT EXISTS idx_conversations_user_type ON conversations(user_type);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

-- ============================================================================
-- MESSAGES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(64) NOT NULL DEFAULT 'CREATE_CHANNEL_MESSAGE',
    message_id VARCHAR(128) NOT NULL,
    channel_arn VARCHAR(256) NOT NULL,
    content TEXT,
    sender_arn VARCHAR(256),
    sender_name VARCHAR(128),
    target_arn VARCHAR(256),
    is_bot BOOLEAN NOT NULL DEFAULT FALSE,
    user_type VARCHAR(32),
    agent_type VARCHAR(32),
    bedrock_model VARCHAR(128),
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms INTEGER,
    total_ms INTEGER,
    poll_ms INTEGER,
    persistence VARCHAR(32) DEFAULT 'PERSISTENT',
    task_id VARCHAR(64),
    task_status VARCHAR(32),
    updated_content TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (message_id, channel_arn)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_arn, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_type_created ON messages(user_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_is_bot ON messages(is_bot);
CREATE INDEX IF NOT EXISTS idx_messages_event_type ON messages(event_type);
CREATE INDEX IF NOT EXISTS idx_messages_task_id ON messages(task_id);
CREATE INDEX IF NOT EXISTS idx_messages_metadata ON messages USING GIN (metadata);

-- ============================================================================
-- EXCHANGES TABLE - User message + Agent response pairs
-- ============================================================================
CREATE TABLE IF NOT EXISTS exchanges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id),
    user_message_id UUID REFERENCES messages(id),
    agent_message_id UUID REFERENCES messages(id),
    channel_arn VARCHAR(256) NOT NULL,
    user_type VARCHAR(32) NOT NULL DEFAULT 'unknown',
    agent_type VARCHAR(32),
    response_latency_ms INTEGER,
    user_message_at TIMESTAMPTZ NOT NULL,
    agent_response_at TIMESTAMPTZ NOT NULL,
    intent VARCHAR(32),
    intent_confidence VARCHAR(16),
    original_intent VARCHAR(32),
    was_rerouted BOOLEAN DEFAULT FALSE,
    delivery_option VARCHAR(32),
    task_id VARCHAR(64),
    task_status VARCHAR(32),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exchanges_conversation ON exchanges(conversation_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_channel ON exchanges(channel_arn);
CREATE INDEX IF NOT EXISTS idx_exchanges_user_type_created ON exchanges(user_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_agent_type ON exchanges(agent_type);
CREATE INDEX IF NOT EXISTS idx_exchanges_created_at ON exchanges(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_intent ON exchanges(intent);
CREATE INDEX IF NOT EXISTS idx_exchanges_task_id ON exchanges(task_id);

-- ============================================================================
-- EVALUATION_RESULTS TABLE - LLM-based evaluation scores
-- ============================================================================
CREATE TABLE IF NOT EXISTS evaluation_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exchange_id UUID NOT NULL REFERENCES exchanges(id),
    run_id VARCHAR(64) NOT NULL,
    evaluator_model VARCHAR(128),
    relevance_score INTEGER CHECK (relevance_score >= 0 AND relevance_score <= 100),
    classification VARCHAR(32),
    reasoning TEXT,
    is_compliant BOOLEAN,
    compliance_categories JSONB,
    flags VARCHAR(64)[],
    issues TEXT[],
    violations JSONB,
    agent_type VARCHAR(32),
    intent VARCHAR(32),
    evaluation_type VARCHAR(16) DEFAULT 'exchange',
    flow_id UUID,
    outcome_score INTEGER CHECK (outcome_score >= 0 AND outcome_score <= 100),
    efficiency_score INTEGER CHECK (efficiency_score >= 0 AND efficiency_score <= 100),
    context_retention_score INTEGER CHECK (context_retention_score >= 0 AND context_retention_score <= 100),
    information_collection_score INTEGER CHECK (information_collection_score >= 0 AND information_collection_score <= 100),
    user_experience_score INTEGER CHECK (user_experience_score >= 0 AND user_experience_score <= 100),
    eval_input_tokens INTEGER,
    eval_output_tokens INTEGER,
    evaluated_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '90 days'
);

CREATE INDEX IF NOT EXISTS idx_evaluation_run ON evaluation_results(run_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_exchange ON evaluation_results(exchange_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_flags ON evaluation_results USING GIN(flags);
CREATE INDEX IF NOT EXISTS idx_evaluation_score ON evaluation_results(relevance_score);
CREATE INDEX IF NOT EXISTS idx_evaluation_date ON evaluation_results(evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_classification ON evaluation_results(classification);

-- ============================================================================
-- INTENT_FLOWS TABLE - Groups multi-turn exchanges into evaluable flows
-- ============================================================================
CREATE TABLE IF NOT EXISTS intent_flows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id VARCHAR(64) UNIQUE NOT NULL,
    channel_arn VARCHAR(256) NOT NULL,
    intent VARCHAR(32) NOT NULL,
    user_type VARCHAR(32),
    agent_type VARCHAR(32),
    status VARCHAR(32),
    exchanges JSONB DEFAULT '[]',
    exchange_count INTEGER DEFAULT 0,
    turn_count INTEGER DEFAULT 0,
    first_exchange_at TIMESTAMPTZ,
    last_exchange_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    outcome VARCHAR(64),
    outcome_score INTEGER CHECK (outcome_score >= 0 AND outcome_score <= 100),
    efficiency_score INTEGER CHECK (efficiency_score >= 0 AND efficiency_score <= 100),
    context_retention_score INTEGER CHECK (context_retention_score >= 0 AND context_retention_score <= 100),
    ux_score INTEGER CHECK (ux_score >= 0 AND ux_score <= 100),
    information_score INTEGER CHECK (information_score >= 0 AND information_score <= 100),
    outcome_details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intent_flows_intent ON intent_flows(intent);
CREATE INDEX IF NOT EXISTS idx_intent_flows_agent_type ON intent_flows(agent_type);
CREATE INDEX IF NOT EXISTS idx_intent_flows_created ON intent_flows(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intent_flows_status ON intent_flows(status);
CREATE INDEX IF NOT EXISTS idx_intent_flows_task ON intent_flows(task_id);

-- ============================================================================
-- AGENT_SCORES TABLE - Daily composite scores per agent type
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_type VARCHAR(32) NOT NULL,
    date DATE NOT NULL,
    composite_score INTEGER NOT NULL CHECK (composite_score >= 0 AND composite_score <= 100),
    exchange_count INTEGER DEFAULT 0,
    flow_count INTEGER DEFAULT 0,
    violation_count INTEGER DEFAULT 0,
    intent_scores JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_type, date)
);

CREATE INDEX IF NOT EXISTS idx_agent_scores_date ON agent_scores(date);
CREATE INDEX IF NOT EXISTS idx_agent_scores_agent ON agent_scores(agent_type, date);

-- ============================================================================
-- CONVERSATION_SUMMARIES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversation_summaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_arn VARCHAR(256) NOT NULL,
    name VARCHAR(256),
    purpose VARCHAR(64),
    summary TEXT,
    topics TEXT[],
    key_points TEXT[],
    message_count INTEGER DEFAULT 0,
    participant_count INTEGER DEFAULT 0,
    version INTEGER DEFAULT 1,
    generated_by VARCHAR(64),
    model_used VARCHAR(128),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(channel_arn, version)
);

CREATE INDEX IF NOT EXISTS idx_summaries_channel ON conversation_summaries(channel_arn);
CREATE INDEX IF NOT EXISTS idx_summaries_purpose ON conversation_summaries(purpose);
CREATE INDEX IF NOT EXISTS idx_summaries_updated ON conversation_summaries(updated_at DESC);

-- ============================================================================
-- GROUND_TRUTH_SCORES TABLE - Human-labeled evaluation scores
-- ============================================================================
CREATE TABLE IF NOT EXISTS ground_truth_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exchange_id UUID REFERENCES exchanges(id),
    human_score INTEGER CHECK (human_score >= 0 AND human_score <= 100),
    classification VARCHAR(32),
    reasoning TEXT,
    scorer_id VARCHAR(256),
    scored_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ground_truth_exchange ON ground_truth_scores(exchange_id);
CREATE INDEX IF NOT EXISTS idx_ground_truth_scorer ON ground_truth_scores(scorer_id);
CREATE INDEX IF NOT EXISTS idx_ground_truth_scored ON ground_truth_scores(scored_at DESC);

-- ============================================================================
-- CLIENT_EVENTS TABLE - Frontend analytics events
-- ============================================================================
CREATE TABLE IF NOT EXISTS client_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(64) NOT NULL,
    session_id VARCHAR(128),
    user_sub VARCHAR(256),
    event_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_events_type ON client_events(event_type);
CREATE INDEX IF NOT EXISTS idx_client_events_session ON client_events(session_id);
CREATE INDEX IF NOT EXISTS idx_client_events_user ON client_events(user_sub);
CREATE INDEX IF NOT EXISTS idx_client_events_created ON client_events(created_at DESC);

-- ============================================================================
-- DRIFT_DETECTION TABLE - Topic drift tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS drift_detection (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_arn VARCHAR(256) NOT NULL,
    original_topic VARCHAR(512),
    current_topic VARCHAR(512),
    drift_score DECIMAL(3, 2) CHECK (drift_score >= 0 AND drift_score <= 1),
    detected_at TIMESTAMPTZ DEFAULT NOW(),
    resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_drift_channel ON drift_detection(channel_arn);
CREATE INDEX IF NOT EXISTS idx_drift_detected ON drift_detection(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_unresolved ON drift_detection(resolved) WHERE resolved = FALSE;

-- ============================================================================
-- CROSS_CONVERSATION_CONTEXT TABLE - Per-user conversation context
-- ============================================================================
CREATE TABLE IF NOT EXISTS cross_conversation_context (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_sub VARCHAR(256) NOT NULL,
    channel_arn VARCHAR(256) NOT NULL,
    topic VARCHAR(512),
    summary TEXT,
    relevance_score DECIMAL(3, 2) DEFAULT 1.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_sub, channel_arn)
);

CREATE INDEX IF NOT EXISTS idx_cross_context_user ON cross_conversation_context(user_sub);
CREATE INDEX IF NOT EXISTS idx_cross_context_channel ON cross_conversation_context(channel_arn);
CREATE INDEX IF NOT EXISTS idx_cross_context_created ON cross_conversation_context(created_at DESC);

-- ============================================================================
-- CHANNEL_MEMBERSHIP TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS channel_membership (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_arn VARCHAR(256) NOT NULL,
    user_sub VARCHAR(256) NOT NULL,
    membership_role VARCHAR(32) DEFAULT 'member',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(channel_arn, user_sub)
);

CREATE INDEX IF NOT EXISTS idx_membership_channel ON channel_membership(channel_arn);
CREATE INDEX IF NOT EXISTS idx_membership_user ON channel_membership(user_sub);

-- ============================================================================
-- CHANNEL_REGISTRY TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS channel_registry (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_arn VARCHAR(256) NOT NULL UNIQUE,
    channel_type VARCHAR(32) NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    channel_name VARCHAR(256),
    created_via VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_registry_type ON channel_registry(channel_type);

-- ============================================================================
-- TRIGGER: Update conversation stats on message insert
-- ============================================================================
CREATE OR REPLACE FUNCTION update_conversation_stats()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations SET
        message_count = message_count + 1,
        user_message_count = user_message_count + CASE WHEN NEW.is_bot = FALSE THEN 1 ELSE 0 END,
        bot_message_count = bot_message_count + CASE WHEN NEW.is_bot = TRUE THEN 1 ELSE 0 END,
        total_tokens = total_tokens + COALESCE(NEW.input_tokens, 0) + COALESCE(NEW.output_tokens, 0),
        last_message_at = GREATEST(last_message_at, NEW.created_at),
        first_message_at = LEAST(first_message_at, NEW.created_at),
        updated_at = NOW()
    WHERE channel_arn = NEW.channel_arn;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_conversation_stats ON messages;
CREATE TRIGGER trigger_update_conversation_stats
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION update_conversation_stats();
