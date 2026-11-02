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
  /** The model this variant runs. MUTUALLY EXCLUSIVE with `profileRef` (backend-validated). The control of an
   *  intent, base_model or classification experiment may omit it: it is the live assistant's active version. */
  modelKey?: string;
  /** SPEC-PORTABLE-PROFILES §6: run an ENTIRE assistant profile version as the variant (its
   *  model/prompt/tools/… come from that version's definition). Omit `version` to track the active one.
   *  Mutually exclusive with `modelKey`. */
  profileRef?: { profileName: string; version?: number };
  /** The treatment's candidate version (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5), in the alt's history
   *  `alt-{role}-{classification}`. Derived by the server when the experiment is armed; never sent by the console. */
  altPin?: { profileName: string; version: number; configId?: string };
  /** The control's version: the live assistant's active version, pinned by number when the experiment is armed. */
  controlPin?: { profileName: string; version: number; configId?: string };
  weight: number;
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
  /** The one model of the intent an `intent` experiment varies (ADR-064 decision 6): text (default), image, or one step. */
  target?: { kind?: 'text' | 'image'; step?: string };
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
  /** v0.2.0 (/battle): when true, this experiment powers /battle. Requires exactly 2 variants + a challenger. Each duel side is named from its profile. */
  battleEnabled?: boolean;
  /** The challenger's assistant id, `alt-{role}-{classification}`, from `listChallengers`. */
  challengerAssistant?: string;
  boundBy?: string;
  boundAt?: string;
  /** Set by the server when the experiment is armed with two pinned versions (§3.5); only such an experiment can be promoted. */
  servesVersions?: boolean;
  /**
   * Read-only, on a battle-enabled experiment: the name the duel gives each side, from its pinned version
   * (the backend's `battleSidesOf`). A side whose name does not resolve is absent. Never sent back.
   */
  sideNames?: { control?: string; treatment?: string };
  /** Set by the Promote action: the version a promotion activated in the live assistant (§3.6). */
  promotion?: { profileName: string; version: number; configId: string; at: string; by: string };
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
    /** Decisive picks. */
    picks: number;
    /** Duels those picks judged: the unit the interval is computed in. */
    duels?: number;
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
  /** Conversations per variant this deployment requires before a verdict is decision-grade. Configurable
   *  (minSamplePerVariant), so a caller must read it rather than hardcode a threshold. */
  minSamplePerVariant?: number;
  /** The unit of analysis (§4.2): every test, guardrail and the floor count conversations. */
  unit?: 'conversation';
}

/**
 * Whether a duel may run in a classification, as TWO facts rather than one.
 *
 * `capable` is what the deployment wired and no operator can change it from here; `enabled` is the
 * setting they can. Both are returned so the console can show a classification its deployment never
 * wired as UNAVAILABLE rather than as merely off - the difference between "you may turn this on" and
 * "this deployment does not build it", which one boolean cannot say.
 */
export interface BattleSetting {
  classification: string;
  capable: boolean;
  enabled: boolean;
}

/**
 * A challenger a battle can name: one classification's alt, by assistant id, as its assignment record
 * provisions it (`GET /admin/experiments/challengers`). `inUseBy` is the experiment holding it now.
 */
export interface BattleChallenger {
  assistant: string;
  classification: string;
  role: string;
  inUseBy: string | null;
}
