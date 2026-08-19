export interface AnalyticsDateRange {
  start: string; // ISO date string
  end: string;
}

export type QueryType =
  | 'conversation_volumes'
  | 'model_usage'
  | 'evaluation_scores'
  | 'intent_distribution'
  | 'user_activity'
  // Aurora-mode queries
  | 'evaluation_exchanges'
  | 'evaluation_flows'
  | 'evaluation_flow_detail'
  | 'flagged_responses'
  | 'ground_truth'
  | 'task_metrics'
  | 'task_details'
  | 'conversation_summaries'
  | 'drift_events'
  | 'cross_conversation_context'
  | 'latency_metrics'
  // ONE TURN, AUDITED (LATENCY-TARGETS, row 50 step 8). `latency_metrics` aggregates; this returns the
  // calculation itself - one row per (turn_id, response_id) with its instants and its reconciliation
  // residuals - so an operator can check a number against the message stream instead of trusting it.
  // An aggregate cannot be audited, which is the reason the ledger exists at all.
  | 'turn_latency_audit'
  // Whole-task resolution, deliberately NOT latency: resolve_ms is mostly human think time, and
  // agent_ms is the part the deployment is accountable for. Mixing them reads as a latency regression.
  | 'task_resolution'
  | 'model_effectiveness'
  | 'experiment_results'
  | 'experiment_recommendation'
  // The evidence behind an experiment verdict (DESIGN-EXPERIMENTS-BATTLE §4.3). THREE queries,
  // because the verdict rests on three different populations and one drill-down filtered for the
  // metric averages would be the wrong set for the other two: exchanges (metric averages, split by
  // `axis` into probabilistic and battle turns), votes (the approval rate), picks (the human axis).
  | 'experiment_exchanges'
  | 'experiment_feedback'
  | 'experiment_picks'
  // The classification shadow gate (DESIGN-EXPERIMENTS-BATTLE §5): replay lifecycle, the gate
  // verdict, and the discordant-only adjudication queue.
  | 'classifier_replays'
  | 'classifier_replay'
  | 'classifier_replay_labels'
  | 'classifier_replay_start'
  | 'classifier_replay_adjudicate'
  // Client-events rollups
  | 'active_users_daily'
  | 'active_messaging_users_daily'
  | 'messages_per_user'
  | 'messages_per_tier_daily'
  | 'error_rate_daily'
  | 'signup_funnel_conversion'
  | 'signin_funnel_conversion'
  | 'page_load_metrics'
  | 'connection_health_daily'
  // Per-message step telemetry (SPEC-MESSAGE-METADATA-CODEBOOK.md / ADR-016) — Aurora.
  | 'execution_steps'
  // Effectiveness drill (SPEC-ADMIN-CONSOLE-EFFECTIVENESS) — Aurora. L0/L1 per-intent rollup,
  // L2 direct-exchange list, L3 per-task turn timeline (with L4 steps inline).
  | 'intent_effectiveness'
  | 'intent_exchanges'
  | 'task_timeline';

export interface AnalyticsResult {
  data: Record<string, string | number>[];
  columns: string[];
  /**
   * True when the queryType is known but cannot be served in the current
   * analytics mode (typically: Aurora-only feature, deployment is Athena).
   * The backend returns 200 with empty data + this flag instead of a 4xx
   * so the dashboard can render a "this view requires Aurora" banner
   * rather than the misleading "no data for this period".
   */
  unsupported?: boolean;
  /** Human-readable reason; pair with `unsupported`. */
  reason?: string;
  /**
   * Server-side pagination (paginated list queries only, e.g. intent_exchanges / task_details):
   * the TOTAL number of matching rows across all pages (from the query's COUNT(*) OVER()), so the
   * console can render "Page X of N" and drive Prev/Next without a second round-trip. `data` is the
   * current page; `limit`/`offset` echo the window served.
   */
  total?: number;
  limit?: number;
  offset?: number;
  /**
   * Aggregate counters a query returns alongside its rows (the dispatcher spreads the query's
   * response and only overwrites `data`, so any extra top-level key survives). Used by drift, whose
   * headline is the OUTCOME RATES rather than the row list. Postgres returns COUNT(*) as a string,
   * so values are widened to string | number and parsed at the point of use.
   */
  stats?: Record<string, string | number | null>;
  /**
   * experiment_results only: the battle-scoped effectiveness view (SPEC-BATTLE). Per-variant metrics
   * from a battle-enabled experiment's BATTLE turns ONLY, kept OUT of the probabilistic A/B `data`
   * rollup so a hand-picked battle prompt never biases the A/B averages. The ExperimentsTab renders
   * this as a separate "Battle results" section, additional to (never replacing) the A/B table.
   */
  battleEffectiveness?: { data: BattleEffectivenessRow[]; columns: string[] };
  /**
   * Drill-down queries only: which population the response actually served, echoed from the query
   * rather than assumed from the request. The view must be able to state what it is showing, and a
   * silently-defaulted axis would otherwise be labelled as the one that was asked for.
   */
  axis?: string;
  variantId?: string | null;
}

// Battle-scoped effectiveness: one row per (experiment, variant), from BATTLE turns only.
export interface BattleEffectivenessRow {
  experiment_id: string;
  variant_id: string;
  model_name: string;
  turn_count: number;
  /** Avg relevance/quality where scored; null when no battle turn is scored yet (honest "no signal"). */
  avg_score: number | null;
  /** Image-aware per-reply cost estimate; null when the model/usage can't be priced. */
  avg_cost_usd: number | null;
  /** Head-to-head /battle picks this variant won; null when none. */
  battle_wins: number | null;
}

// Overview metrics
export interface ConversationVolumeData {
  date: string;
  message_count: number;
  conversation_count: number;
}

export interface ModelUsageData {
  model_name: string;
  message_count: number;
  avg_latency_ms: number;
  total_tokens: number;
}

export interface ModelEffectivenessData {
  model_name: string;
  intent: string;
  exchange_count: number;
  avg_score: number;
  avg_total_ms: number;
  p95_total_ms: number;
  compliance_rate: number;
  excellent_count: number;
  poor_count: number;
}

// A/B experiment results (one row per variant x intent x tier)
// Per-message step telemetry (SPEC-MESSAGE-METADATA-CODEBOOK.md / ADR-016).
// One ConverseStep per Converse iteration of the self-hosted tool loop, persisted
// out-of-band and surfaced in the admin steps table.
export interface ExecutionStep {
  stepLabel: string;
  modelId: string;
  startedAt: string;
  endedAt: string;
  tokensIn?: number;
  tokensOut?: number;
  imageCount?: number;
  estCostUsd?: number | null;
}

export interface ExecutionStepRow {
  message_id: string;
  timestamp: string;
  intent: string | null;
  bedrock_model: string | null;
  total_ms: number | null;
  step_count: number;
  steps: ExecutionStep[];
}

export interface ExperimentResultRow {
  experiment_id: string;
  variant_id: string;
  model_name: string;
  intent: string;
  agent_type: string;
  exchange_count: number;
  /** Exchanges an evaluator actually scored. `exchange_count` is traffic, this is the evidence behind
   *  `avg_score`, and the two differ whenever scoring lags: an unscored exchange counts as 0 in the mean. */
  scored_count: number;
  avg_score: number;
  avg_total_ms: number;
  p95_total_ms: number;
  avg_tokens: number;
  avg_cost_usd: number | null;
  compliance_rate: number;
  fallback_count: number;
  fallback_rate: number;
  task_count: number;
  task_completion_rate: number | null;
  // Thumbs per-variant join — a human signal,
  // separate from the evaluator's avg_score. approval_rate is null when there
  // are no ratings yet.
  thumbs_up: number;
  thumbs_down: number;
  feedback_count: number;
  approval_rate: number | null;
  // /battle head-to-head picks this variant won; null when none.
  battle_wins: number | null;
  needs_more_data: boolean;
}

// LLM-generated recommendation from the test outcome (descriptive only).
export type ExperimentVerdict =
  | 'promote_control'
  | 'promote_treatment'
  | 'keep_running'
  | 'inconclusive';

export interface ExperimentRecommendationVariant {
  variant_id: string;
  model_name: string;
  exchange_count: number;
  avg_score: number;
  avg_total_ms: number;
  avg_cost_usd: number;
  compliance_rate: number;
  fallback_rate: number;
  task_completion_rate: number | null;
  thumbs_up: number;
  thumbs_down: number;
  feedback_count: number;
  approval_rate: number | null;
  battle_wins: number | null;
}

export interface ExperimentRecommendation {
  verdict: ExperimentVerdict;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  variants: ExperimentRecommendationVariant[];
  experimentId: string;
  /**
   * Exchanges per variant THIS deployment requires before a verdict is decision-grade.
   *
   * The backend already returns it (`analytics-query.ts`, `minSamplePerVariant`) precisely so the console
   * does not hardcode a threshold and then contradict the verdict rendered beside it. It was declared on
   * the sibling `ExperimentRecommendation` in `services/experimentService.ts` but not on this one, so a
   * consumer importing from here could not read a value the response already carried - which is how the
   * thin-data banner ended up derived from per-slice flags instead of the floor actually applied.
   */
  minSamplePerVariant?: number;
}

// Basic evaluation (Athena mode)
export interface EvaluationScoreData {
  date: string;
  agent_type: string;
  intent_type: string;
  avg_relevance_score: number;
  count: number;
}

// Multi-dimensional evaluation (Aurora mode)
export interface EvaluationExchange {
  id: string;
  conversation_id: string;
  channel_arn: string;
  user_message: string;
  agent_response: string;
  intent: string;
  agent_type: string;
  delivery_option: string;
  task_id?: string;
  latency_ms: number;
  // Evaluation results
  relevance_score: number;
  classification: 'excellent' | 'good' | 'acceptable' | 'poor' | 'appropriate_refusal' | 'error_response';
  flags: string[];
  reasoning: string;
  is_compliant: boolean;
  compliance_categories: string[];
  // Multi-dimensional scores (Aurora mode)
  outcome_score?: number;
  efficiency_score?: number;
  context_retention_score?: number;
  direct_relevance_score?: number;
  context_awareness_score?: number;
  completeness_score?: number;
  focus_score?: number;
  evaluated_at: string;
  // Human review
  review_status?: 'pending' | 'reviewed' | 'approved' | 'rejected';
  reviewer_id?: string;
  review_notes?: string;
}

// Intent flow (multi-turn evaluation)
export interface IntentFlow {
  id: string;
  task_id: string;
  agent_type: string;
  intent_type: string;
  exchange_count: number;
  status: 'in_progress' | 'completed' | 'abandoned' | 'failed';
  // Flow-level scores (5 weighted dimensions)
  outcome_score: number;        // 30% weight
  information_score: number;    // 25% weight
  efficiency_score: number;     // 15% weight
  context_retention_score: number; // 15% weight
  ux_score: number;             // 15% weight
  composite_score: number;
  abandonment_reason?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface IntentFlowDetail extends IntentFlow {
  exchanges: EvaluationExchange[];
}

// Flagged responses
export interface FlaggedResponse {
  exchange_id: string;
  channel_arn: string;
  user_message: string;
  agent_response: string;
  intent: string;
  agent_type: string;
  relevance_score: number;
  classification: string;
  flags: string[];
  reasoning: string;
  compliance_categories: string[];
  review_status: 'pending' | 'reviewed' | 'approved' | 'rejected';
  reviewer_id?: string;
  review_notes?: string;
  flagged_at: string;
}

// Ground truth / human evaluation
export interface GroundTruthEntry {
  exchange_id: string;
  human_score: number;
  automated_score: number;
  classification: string;
  reasoning: string;
  scorer_id: string;
  scored_at: string;
  score_delta: number; // human - automated
}

// Task tracking
export interface TaskMetrics {
  date: string;
  task_type: string;
  total: number;
  completed: number;
  failed: number;
  abandoned: number;
  avg_duration_ms: number;
  completion_rate: number;
}

export interface TaskDetail {
  task_id: string;
  task_type: string;
  user_sub: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  channel_arn: string;
  created_at: string;
  completed_at?: string;
  duration_ms?: number;
  exchange_count: number;
}

// Conversation summaries
export interface ConversationSummary {
  channel_arn: string;
  purpose: string;
  name: string;
  topics: string[];
  key_points: string[];
  message_count: number;
  exchange_count: number;
  participant_count: number;
  version: number;
  last_activity: string;
  updated_at: string;
}

// Drift detection
// By-reference drift event (Aurora drift_events, migration 006). No message
// body or topic strings are stored; a drift is a reference plus its outcome.
export interface DriftEvent {
  id: string;
  channel_arn: string;
  new_channel_arn: string | null;
  rival_conversation_arn: string | null;
  drift_score: number; // cosine distance, 0..1
  outcome: 'declined' | 'rejected_in_new_channel' | 'abandoned' | 'accepted' | null;
  intent: string | null;
  confidence: 'low' | 'medium' | 'high' | null;
  detected_at: string; // occurred_at
  user_sub: string | null;
  originating_message_id: string | null;
  signal_disagreement: boolean;
  created_via_explicit_intent: boolean;
}

// Cross-conversation context
export interface CrossConversationContext {
  user_sub: string;
  channel_arn: string;
  topic: string;
  summary: string;
  relevance_score: number;
  last_activity: string;
}

export interface UserActivityData {
  user_id: string;
  message_count: number;
  conversation_count: number;
  last_active: string;
}

export interface OverviewMetrics {
  totalMessages: number;
  activeConversations: number;
  activeUsers: number;
  avgResponseTime: number;
}

// Agent scores (daily aggregates)
export interface AgentScore {
  agent_type: string;
  date: string;
  composite_score: number;
  exchange_count: number;
  violation_count: number;
  intent_scores: Record<string, number>;
}
