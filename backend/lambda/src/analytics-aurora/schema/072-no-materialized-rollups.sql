-- NO MATERIALIZED ROLLUPS (SPEC-AURORA-VPC-MODE FR24, declined).
--
-- `daily_metrics` and `agent_performance` were materialized views that nothing refreshed and nothing
-- read. Every dashboard figure is a live query, and that query is the one definition of each number
-- (tenet D7). A rollup with its own definition of relevance, compliance and latency would disagree with
-- it: it pools rubric versions and evaluators, states no assessed population, and averages
-- `exchanges.response_latency_ms` where the console reads the turn ledger.
--
-- `drift_summary` is listed so a database that still holds it ends without it; migration 006 dropped it
-- with `drift_detection` (CASCADE).
--
-- Idempotent and transaction-safe: it applies at runtime on a cold start (`ensureSchema`).

DROP MATERIALIZED VIEW IF EXISTS daily_metrics;
DROP MATERIALIZED VIEW IF EXISTS agent_performance;
DROP MATERIALIZED VIEW IF EXISTS drift_summary;
