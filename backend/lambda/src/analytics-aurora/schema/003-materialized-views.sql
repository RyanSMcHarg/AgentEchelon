-- ============================================================================
-- Materialized Views for Dashboard Analytics
-- Refresh via pg_cron or scheduled Lambda
-- ============================================================================

-- ============================================================================
-- DAILY METRICS VIEW
-- Exchanges per day with average scores and agent type breakdown
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'daily_metrics'
    ) THEN
        EXECUTE '
            CREATE MATERIALIZED VIEW daily_metrics AS
            SELECT
                DATE(er.evaluated_at) AS date,
                e.user_type,
                e.agent_type,
                COUNT(*) AS exchange_count,
                AVG(er.relevance_score) AS avg_relevance_score,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY er.relevance_score) AS median_relevance_score,
                COUNT(*) FILTER (WHERE er.classification = ''excellent'') AS excellent_count,
                COUNT(*) FILTER (WHERE er.classification = ''good'') AS good_count,
                COUNT(*) FILTER (WHERE er.classification = ''partial'') AS partial_count,
                COUNT(*) FILTER (WHERE er.classification IN (''poor'', ''irrelevant'')) AS poor_count,
                COUNT(*) FILTER (WHERE NOT er.is_compliant) AS violation_count,
                AVG(e.response_latency_ms) AS avg_latency_ms
            FROM evaluation_results er
            JOIN exchanges e ON er.exchange_id = e.id
            GROUP BY DATE(er.evaluated_at), e.user_type, e.agent_type
        ';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_metrics_pk
    ON daily_metrics(date, user_type, agent_type);

-- ============================================================================
-- AGENT PERFORMANCE VIEW
-- Per-agent composite scores and trends
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'agent_performance'
    ) THEN
        EXECUTE '
            CREATE MATERIALIZED VIEW agent_performance AS
            SELECT
                DATE(er.evaluated_at) AS date,
                e.agent_type,
                e.intent,
                COUNT(*) AS exchange_count,
                AVG(er.relevance_score) AS avg_score,
                COUNT(*) FILTER (WHERE er.classification = ''excellent'') AS excellent_count,
                COUNT(*) FILTER (WHERE er.classification IN (''poor'', ''irrelevant'')) AS poor_count,
                COUNT(*) FILTER (WHERE NOT er.is_compliant) AS violation_count,
                COUNT(*) FILTER (WHERE array_length(er.flags, 1) > 0) AS flagged_count
            FROM evaluation_results er
            JOIN exchanges e ON er.exchange_id = e.id
            WHERE e.agent_type IS NOT NULL
            GROUP BY DATE(er.evaluated_at), e.agent_type, e.intent
        ';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_performance_pk
    ON agent_performance(date, agent_type, intent);

-- ============================================================================
-- DRIFT DETECTION SUMMARY VIEW
-- Aggregated drift events per channel
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'drift_summary'
    ) THEN
        EXECUTE '
            CREATE MATERIALIZED VIEW drift_summary AS
            SELECT
                channel_arn,
                COUNT(*) AS drift_event_count,
                AVG(drift_score) AS avg_drift_score,
                MAX(drift_score) AS max_drift_score,
                COUNT(*) FILTER (WHERE NOT resolved) AS unresolved_count,
                MIN(detected_at) AS first_drift_at,
                MAX(detected_at) AS last_drift_at
            FROM drift_detection
            GROUP BY channel_arn
        ';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_drift_summary_pk
    ON drift_summary(channel_arn);

-- ============================================================================
-- Refresh instructions:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY daily_metrics;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY agent_performance;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY drift_summary;
-- ============================================================================
