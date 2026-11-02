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
  // How far each judge agrees with people per rubric and instance, and how far a judge's pairwise
  // preference agrees with people's battle picks (SPEC-EVALUATION Appendix C4). Aurora only.
  | 'judge_calibration'
  | 'pairwise_agreement'
  | 'task_metrics'
  | 'task_details'
  | 'conversation_summaries'
  | 'drift_events'
  | 'cross_conversation_context'
  | 'latency_metrics'
  // ONE TURN, AUDITED (LATENCY-TARGETS). `latency_metrics` aggregates; this returns the
  // calculation itself - one row per (turn_id, response_id) with its instants and its reconciliation
  // residuals - so an operator can check a number against the message stream instead of trusting it.
  // An aggregate cannot be audited, which is the reason the ledger exists at all.
  | 'turn_latency_audit'
  // The ledger and the derived path compared turn by turn. The Latency tab's TTFF and E2E come from
  // the ledger; this is what the retired derivation is still checked against, so a later divergence
  // shows up instead of being assumed away.
  | 'turn_latency_shadow_diff'
  | 'router_steps'
  // The same window split by what KIND of interaction each turn was: a person's wait, a
  // rebuttal and a repaired turn are three questions that one average answers for none of them.
  | 'latency_by_interaction'
  // One turn, both clocks: the browser's wait beside the server's, joined by correlation id (G5).
  | 'client_server_latency'
  // Which turns are in the answer population and which declared that they are not. A reading answers a burst rather than a message; a drift suggestion responds to a
  // message and deliberately does not do the work. Both are excluded from answering figures because
  // they SAY what they are, and this is where they are counted instead of being invisible.
  | 'turn_kinds'
  // Subjects the `general` and `off_topic` turns cluster around: candidates for new intents.
  | 'unserved_subjects'
  | 'handovers'
  // Whole-task resolution, deliberately NOT latency: resolve_ms is mostly human think time, and
  // agent_ms is the part the deployment is accountable for. Mixing them reads as a latency regression.
  | 'task_resolution'
  // How each workflow's tasks got where they are, from the path a task turn recorded (SPEC-EVALUATION
  // Appendix C2). Aurora only, deterministic.
  | 'workflow_trajectory'
  // Refusals, guardrail findings and rule breaches as counts (SPEC-EVALUATION Appendix C5). Aurora only.
  | 'safety_readings'
  // Whether a person had to work to be understood, per person per conversation (Appendix C6). Aurora only.
  | 'frustration'
  // Which context sources retrieval brings back and whether answers use them (Appendix C7). Aurora only.
  | 'retrieval_sources'
  // What each tool's calls came to and who fixes it (Appendix C3). Aurora only.
  | 'tool_outcomes'
  // How each document template's deliveries went (SPEC-DOCUMENT-TEMPLATES FR8). Aurora only.
  | 'template_outcomes'
  // Answers waiting for a person's label, and the golden set with its writes (SPEC-EVALUATION FR14, FR16).
  | 'label_queue'
  | 'golden_set'
  // The Performance view's flow: counts by path, intent and outcome, the turns behind a node, one turn.
  | 'message_flow'
  | 'welcome_flow'
  | 'flow_turns'
  | 'flow_turn'
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
  // FULL RESULTS, ONE ROW PER DUEL, with its sides nested. Its own query rather than another field
  // on `experiment_results`: that one is the per-variant rollup the Experiments tab loads on every
  // view, and this is paged, so folding it in would fetch a page of duels nobody asked for.
  | 'battle_results'
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
  // One intent's turns by the step they started in and the model that served them (ADR-064). Aurora only.
  | 'intent_steps'
  // A delivered document's own scores (SPEC-EVALUATION FR22): by intent and task type, or with a
  // `channelArn` the documents of one conversation. Both modes; Athena mode carries relevance only.
  | 'document_evaluation'
  | 'task_timeline'
  // The turns behind ONE latency breakdown row, carrying every dimension that row is grouped on
  // (`analytics-query.ts` dispatch map). The Latency tab's drill.
  | 'latency_exchanges'
  // The ratings themselves behind an intent's user-signal rate: which reply, which way, and anything
  // written with it. The Effectiveness drill.
  | 'user_ratings'
  // The COMPLETE archived event log for a channel, every event_type — authorized as `view-events`
  // rather than base analytics, so it posts to its own capability resource.
  | 'channel_events'
  // Moderation attribution. A WRITE, intercepted before query dispatch: the Lambda stamps the
  // server-verified admin identity and the client names only the target.
  | 'record_moderation';

// THIS UNION IS THE CONTRACT, SO A MISSING MEMBER IS A DEFECT AND NOT A TYPING INCONVENIENCE.
//
// A caller that reaches for `as never` or `as QueryType` to send a name this union does not declare
// silences the one check that says the client and the dispatch map still agree. It compiles, it works
// in production, and the union quietly stops describing what the console sends — so a later reader
// cannot tell a real query from a typo, and a test that filters calls by name matches nothing while
// still reporting green.
//
// Add the member here instead. Every name above is served: the Aurora dispatch map in
// `backend/lambda/src/analytics-aurora/analytics-query.ts`, or an interception ahead of it for the
// write actions.

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
   * experiment_results only: each variant's sample in the unit its tests count (conversations) beside the
   * unit its means are taken over (exchanges). DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §4.2.
   */
  units?: { data: ExperimentUnitsRow[]; columns: string[] };
  /**
   * Drill-down queries only: which population the response actually served, echoed from the query
   * rather than assumed from the request. The view must be able to state what it is showing, and a
   * silently-defaulted axis would otherwise be labeled as the one that was asked for.
   */
  axis?: string;
  variantId?: string | null;
  /**
   * evaluation_scores (Aurora mode) only: the model that judged this window, and how many DISTINCT
   * models judged it.
   *
   * Tenet P3 makes a judge swap an expected event rather than an edge case, and every score
   * re-baselines when it happens: a fall in relevance is either a regression in the assistant or a
   * different judge, and the two are indistinguishable while the model is unreadable. `rubric_version`
   * already segregates rows scored under different prompt wording; this is the other axis.
   *
   * `evaluatorModelCount` above one means the average spans two instruments and is not one number.
   * Both are absent in Athena mode, whose runner scores relevance alone and records no judge, so a
   * surface reads them as "not known" rather than claiming a single judge.
   */
  evaluatorModel?: string | null;
  evaluatorModelCount?: number;
}

// Battle-scoped effectiveness: one row per (experiment, variant, room, assistant, role, version),
// from BATTLE turns only.
export interface BattleEffectivenessRow {
  experiment_id: string;
  variant_id: string;
  /** The ROOM the duel ran in. Null on history archived before the column existed. */
  conversation_classification: string | null;
  /** The ASSISTANT that answered — the identifier (`advisor`), not its display name. */
  assistant: string | null;
  /** The role it holds. Null on history, and never a defaulted `primary`. */
  assistant_role: string | null;
  /** Which version of that assistant's profile produced the turns. */
  profile_version: number | null;
  model_name: string;
  turn_count: number;
  /** DISTINCT duels behind those turns — a duel is several turns, so turn_count cannot say. */
  battle_count: number;
  /** Avg relevance/quality where scored; null when no battle turn is scored yet (honest "no signal"). */
  avg_score: number | null;
  /** Image-aware per-reply cost estimate; null when the model/usage can't be priced. */
  avg_cost_usd: number | null;
  /**
   * Head-to-head /battle picks this variant won, credited to THIS row's dimensions; null when none.
   *
   * A pick records only which side won, so it is traced through its own duel to the dimensions that
   * side ran under. A variant split across two rooms therefore has its wins split too, rather than
   * the same tally repeated on both rows — which would make the column sum to more battles than
   * were fought.
   */
  battle_wins: number | null;
}

/** One side of a duel, as `battle_results` nests it under the duel it was fought in. */
export interface BattleContender {
  variant_id: string;
  assistant: string | null;
  assistant_role: string | null;
  profile_version: number | null;
  model_name: string | null;
  turn_count: number;
  avg_score: number | null;
}

/**
 * FULL RESULTS: one row per DUEL, with its sides nested.
 *
 * Every other battle view is a per-variant average across a window, which answers "which arm is
 * better overall" and cannot answer "how did this battle go". The sides are nested rather than
 * returned as separate rows because a duel is one thing that happened, and splitting it would make
 * every consumer re-pair them — the pairing being exactly what was missing before `battle_id`
 * became a column.
 */
export interface BattleResultRow {
  battle_id: string;
  fought_at: string;
  /** When the person sent the /battle message that started the battle. `fought_at` when that message was not found. */
  started_at?: string;
  /** The /battle message's Amazon Chime SDK MessageId, the message the console's conversation viewer opens at. */
  start_message_id?: string | null;
  channel_arn: string | null;
  conversation_classification: string | null;
  experiment_id: string | null;
  /** Highest round reached. A duel that stalled in round 1 reads 1. */
  rounds: number;
  sides: number;
  turn_count: number;
  contenders: BattleContender[];
  /**
   * The variant the person picked, the literal `tie`, or NULL when nobody judged this duel.
   * Null is not a tie and must not render as one: one is an absent judgment, the other is a made one.
   */
  winner_variant_id: string | null;
  /**
   * How many people judged it. A duel can be judged by several, so the winner is the majority and
   * an equal top count is a `tie` — 2-1 and 1-0 are different confidences in the same word.
   */
  vote_count: number;
  decided_at: string | null;
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
  /** Percent compliant over ASSESSED exchanges, or null when none in this group were assessed.
   *  Never 0: the query divides by NULLIF(assessed, 0), and a rate over nothing is not a rate. */
  compliance_rate: number | null;
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
  /** One outcome per tool the iteration invoked; absent on a pure generation step. */
  tools?: ExecutionStepTool[];
}

/**
 * A tool call's recorded outcome (backend `ToolStepOutcome`). `workflow_refusal` is a call the task
 * workflow refused by one of its declared rules, with the rule's code in `refusal`: not a failure, and
 * not in `tool_error_rate`.
 */
export interface ExecutionStepTool {
  name: string;
  ok: boolean;
  errorClass?: 'timeout' | 'not_found' | 'unauthorized' | 'bad_input' | 'error' | 'workflow_refusal';
  refusal?: string;
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

/** One variant's sample in both units (experiment_results `units`). */
export interface ExperimentUnitsRow {
  experiment_id: string;
  variant_id: string;
  unit: 'conversation';
  conversation_count: number;
  exchange_count: number;
  /** Conversations with at least one scored exchange: the unit a quality test counts. */
  scored_conversation_count: number;
  scored_count: number;
}

export interface ExperimentResultRow {
  experiment_id: string;
  variant_id: string;
  model_name: string;
  intent: string;
  assistant: string;
  exchange_count: number;
  /** Exchanges an evaluator actually scored. `exchange_count` is traffic, this is the evidence behind
   *  `avg_score`, and the two differ whenever scoring lags: an unscored exchange counts as 0 in the mean. */
  scored_count: number;
  /** Conversations behind this row. Summing across rows overcounts a conversation spanning two intents;
   *  the per-variant figure is `units`. */
  conversation_count?: number;
  avg_score: number;
  avg_total_ms: number;
  p95_total_ms: number;
  avg_tokens: number;
  avg_cost_usd: number | null;
  /** Percent compliant over ASSESSED exchanges, null when none were. See ModelEffectivenessData. */
  compliance_rate: number | null;
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
  /** The unit every test counts (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §4.2). */
  unit?: 'conversation';
  conversation_count?: number;
  exchange_count: number;
  avg_score: number;
  avg_total_ms: number;
  avg_cost_usd: number;
  /** Percent compliant over ASSESSED exchanges, null when none were. Weighted across the variant's
   *  intent groups by the exchanges each group actually assessed, so an unassessed group neither
   *  contributes a 0% nor drags the weight. */
  compliance_rate: number | null;
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
   * Conversations per variant THIS deployment requires before a verdict is decision-grade.
   *
   * The backend already returns it (`analytics-query.ts`, `minSamplePerVariant`) precisely so the console
   * does not hardcode a threshold and then contradict the verdict rendered beside it. It was declared on
   * the sibling `ExperimentRecommendation` in `services/experimentService.ts` but not on this one, so a
   * consumer importing from here could not read a value the response already carried - which is how the
   * thin-data banner ended up derived from per-slice flags instead of the floor actually applied.
   */
  minSamplePerVariant?: number;
  /** The unit of analysis: every metric test, guardrail and the sample floor count conversations. */
  unit?: 'conversation';
}

// Basic evaluation (Athena mode)
export interface EvaluationScoreData {
  date: string;
  assistant: string;
  intent_type: string;
  avg_relevance_score: number;
  count: number;
  /** Exchanges in this group with a recorded `false` compliance verdict. Aurora mode only. */
  violation_count?: number;
  /** Of those, the ones breaching a rule the rule set declares `blocking` - "somebody needs to know
   *  today". Reported separately because a minor tone finding and a disclosed card number are not the
   *  same event, and one rate cannot say which happened. Aurora mode only. */
  blocking_violation_count?: number;
  /** Exchanges in this group that carry a compliance verdict at all. The denominator of any rate over
   *  this group; without it a rate cannot be told apart from "nothing was looked at". Aurora only. */
  compliance_assessed_count?: number;
}

// Multi-dimensional evaluation (Aurora mode)
export interface EvaluationExchange {
  id: string;
  conversation_id: string;
  channel_arn: string;
  user_message: string;
  agent_response: string;
  intent: string;
  assistant: string;
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
  assistant: string;
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
  assistant: string;
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
  person_id: string;
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
  person_id: string | null;
  originating_message_id: string | null;
  signal_disagreement: boolean;
  created_via_explicit_intent: boolean;
}

// Cross-conversation context
export interface CrossConversationContext {
  person_id: string;
  channel_arn: string;
  topic: string;
  summary: string;
  relevance_score: number;
  last_activity: string;
}

export interface UserActivityData {
  person_id: string;
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
  assistant: string;
  date: string;
  composite_score: number;
  exchange_count: number;
  violation_count: number;
  intent_scores: Record<string, number>;
}
