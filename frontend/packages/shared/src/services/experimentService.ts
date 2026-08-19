import { apiCall } from '../api/apiCall';

/** Generation-out image models (mirrors backend
 *  image-gen-models.ts ImageGenModelKey — kept a local union per the
 *  frontend's self-contained-types convention, like MODEL_OPTIONS).
 *  Realigned to the full backend union: the earlier
 *  `'titan_image' | 'nova_canvas'` was stale, so the admin form's
 *  Stability/OpenAI/fal options had to be cast away
 *  (ExperimentsTab imageGenModelKey). */
export type ImageGenModelKey =
  | 'titan_image'
  | 'nova_canvas'
  | 'stability_image_core'
  | 'stability_image_ultra'
  | 'openai_gpt_image_1'
  | 'fal_flux_pro_1_1';

export interface ExperimentVariant {
  variantId: string;
  /** The model this variant runs. MUTUALLY EXCLUSIVE with `profileRef` (backend-validated). */
  modelKey?: string;
  /** SPEC-PORTABLE-PROFILES §6: run an ENTIRE assistant profile version as the variant (its
   *  model/prompt/tools/… come from that version's definition). Omit `version` to track the active one.
   *  Mutually exclusive with `modelKey`. */
  profileRef?: { profileName: string; version?: number };
  weight: number;
  /** v0.2.0 (/battle): per-variant display name shown to users + in rival prompts. Max 16 chars. */
  displayName?: string;
  /** v0.2.0 (/battle): variant-specific addendum layered onto the tier's base system prompt. Sanitized server-side. Max 500 chars. */
  systemPromptAddendum?: string;
  /** /battle generation-out: when set, this variant generates
   *  an IMAGE with this model instead of replying with text. A battle is
   *  generation-out iff BOTH variants set it (server-validated
   *  both-or-neither). */
  imageGenModelKey?: ImageGenModelKey;
}

/** Experiment type. Absent ⇒ 'intent' (the default). */
export type ExperimentType = 'intent' | 'base_model' | 'classification' | 'profile';

/** Advisory objective target. */
export type ExperimentObjectiveMetric = 'cost' | 'accuracy' | 'quality' | 'latency';

/** A metric that must NOT regress for a variant to ship (DESIGN-EXPERIMENTS-BATTLE §1.2).
 *  Mirrors backend `ObjectiveGuardrail`. Additive/advisory; never auto-acts. */
export interface ObjectiveGuardrail {
  metric: ExperimentObjectiveMetric;
  /** 'no_worse_than' bounds a regression; 'at_least' bounds an improvement floor. */
  direction: 'no_worse_than' | 'at_least';
  /** Percentage bound in [0, 100], same units as `target`. */
  bound: number;
}

/**
 * THE ACCURACY MARGIN: how much accuracy may fall before a change is refused. Percentage points.
 *
 * The default bound the create form pre-fills for a guardrail. A guardrail bound is a NON-INFERIORITY
 * margin, so a blank field asks an operator to invent a number they have no basis for; this is the
 * platform's stated answer, and it stays editable.
 *
 * MIRRORS `DEFAULT_ACCURACY_MARGIN_PCT` in `backend/lambda/src/lib/experiment-stats.ts`, which carries
 * the full rationale and is the source of truth. The two are pinned together by
 * `backend/test/lib/accuracy-margin-parity.test.ts` - a value duplicated across the stack drifts
 * unless something fails when it does.
 */
export const DEFAULT_ACCURACY_MARGIN_PCT = 2;

export interface ExperimentObjective {
  metric: ExperimentObjectiveMetric;
  /** Percentage in [0, 100]: a decrease for cost/latency, a target level for accuracy/quality. */
  target: number;
  /** NEW (§1.2): the written objective/hypothesis — "the decision this test informs".
   *  ≤500 chars, sanitized server-side. Required in the create form; the API only warns
   *  when absent (old/programmatic callers keep working — absent ⇒ today's behavior). */
  statement?: string;
  /** NEW (§1.2): pre-registered veto conditions (≤3) that must not regress for a ship. */
  guardrails?: ObjectiveGuardrail[];
  /** NEW (§4.3): 0..1 — how much the battle human-pick counts toward the verdict vs the
   *  metric. Absent ⇒ 0 (today's behavior: the pick is dashboard-only, never folded in). */
  humanPickWeight?: number;
}

/** The operator's own record of what they did when a test that RAN was closed
 *  (DESIGN-EXPERIMENTS-BATTLE §3.2.1). Advisory only — recording a decision is NOT the
 *  promotion itself (INV-1). Mirrors backend `ExperimentDecision`. */
export interface ExperimentDecision {
  /** 'no_decision' is the default and always available, so an inconclusive/abandoned
   *  test closes honestly rather than being dressed as a conclusion (INV-3). */
  outcome: 'promoted_treatment' | 'kept_control' | 'no_decision';
  /** Optional prose, ≤500 chars. */
  note?: string;
  /** Admin ARN from the caller token. */
  by: string;
  /** ISO timestamp. */
  at: string;
}

/** One append-only lifecycle audit entry (DESIGN-EXPERIMENTS-BATTLE L7).
 *  Mirrors backend `ExperimentTransition`. */
export interface ExperimentTransition {
  from: Experiment['status'] | 'create';
  to: Experiment['status'];
  by: string;
  at: string;
  /** e.g. 'auto:endDate', 'conflict:paused', 'delete:soft'. */
  reason?: string;
}

export interface Experiment {
  experimentId: string;
  /** Widened (DESIGN-EXPERIMENTS-BATTLE L3/L8): + 'draft' (never-started) and
   *  'deleted' (soft-delete tombstone). Both are excluded from active resolution
   *  and the console's default list; existing rows are only active|paused|completed. */
  status: 'draft' | 'active' | 'paused' | 'completed' | 'deleted';
  /** Defaults to 'intent' when absent. */
  experimentType?: ExperimentType;
  intent: string;
  tiers: string[];
  variants: ExperimentVariant[];
  startDate: string;
  endDate?: string;
  createdAt: string;
  description?: string;
  /** Advisory; never auto-acts. */
  objective?: ExperimentObjective;
  /** NEW (§3.2.1): set when a test that RAN is completed — the operator's recorded
   *  outcome (default 'no_decision'). Advisory; distinct from any computed verdict. */
  decision?: ExperimentDecision;
  /** NEW (L7): append-only lifecycle audit (who paused/edited/completed, and when). */
  transitions?: ExperimentTransition[];
  /** v0.2.0 (/battle): when true, this experiment powers /battle. Requires exactly 2 variants + displayName on each + altBotSlotId. */
  battleEnabled?: boolean;
  altBotSlotId?: string;
  altBotSlotArn?: string;
  boundBy?: string;
  boundAt?: string;
}

/** Advisory recommendation carrying the COMPUTED statistics, not an LLM's self-assessed
 *  confidence (DESIGN-EXPERIMENTS-BATTLE §4, A.6). Never auto-applied (INV-1); the metric
 *  verdict and the human-pick axis are surfaced SEPARATELY and disagreement is shown
 *  explicitly, never blended into one number (INV-3/INV-4). Mirrors the backend contract. */
export interface ExperimentRecommendation {
  verdict: 'promote_treatment' | 'keep_control' | 'keep_running' | 'equivalent' | 'inconclusive';
  /** Derived from the statistic (§4.2-E), not the LLM. */
  confidence: 'low' | 'medium' | 'high';
  /** Prose narration of the computed numbers only — it no longer sources the confidence. */
  rationale: string;
  primary: {
    metric: ExperimentObjectiveMetric;
    deltaPct: number;
    ci: [number, number];
    pValue: number;
    significant: boolean;
    powered: boolean;
  };
  guardrails: Array<{
    metric: ExperimentObjectiveMetric;
    deltaPct: number;
    bound: number;
    held: boolean;
  }>;
  /** The battle human-preference axis, when battle picks exist — a distinct signal, never
   *  merged into `primary` (§4.3). */
  human?: {
    picks: number;
    winRate: number;
    ci: [number, number];
    significant: boolean;
  };
  /** Computed recommendation vs the operator's recorded decision — a cheap meta-signal on
   *  how much the stats are trusted; the two may differ (§4.4). */
  recommendedVsChosen?: {
    recommended: string;
    chosen?: ExperimentDecision['outcome'];
  };
  /** Exchanges per variant this deployment requires before a verdict is decision-grade. Configurable
   *  (minSamplePerVariant), so a caller must read it rather than hardcode a threshold. */
  minSamplePerVariant?: number;
}

function getApiUrl(): string {
  // Dedicated endpoint (CDK output AgentEchelonExperiments.ExperimentsApiUrl).
  // It lives on the experiments API, NOT the admin-conversations API:
  // the experiments table is owned by the AgentEchelonExperiments stack, which is
  // downstream of the cognito-auth stack that hosts admin-conversations,
  // so the API must be co-located with its table (no stack cycle).
  const url = import.meta.env.VITE_EXPERIMENTS_API_URL;
  if (!url) throw new Error('VITE_EXPERIMENTS_API_URL not configured');
  return url; // already .../admin/experiments
}

export async function listExperiments(): Promise<Experiment[]> {
  const result = await apiCall<{ experiments?: Experiment[] }>(getApiUrl());
  return result.experiments || [];
}

export async function createExperiment(experiment: Omit<Experiment, 'createdAt'>): Promise<Experiment> {
  return apiCall<Experiment>(getApiUrl(), '', {
    method: 'POST',
    body: experiment,
  });
}

export async function updateExperimentStatus(experimentId: string, status: Experiment['status']): Promise<void> {
  await apiCall(getApiUrl(), `/${experimentId}/status`, {
    method: 'POST',
    body: { status },
  });
}
