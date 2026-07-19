/**
 * Experiment Manager
 *
 * Runtime A/B testing framework for comparing Bedrock models per intent.
 * Experiments are stored in DynamoDB and cached in-memory for 60s.
 * Variant assignment is deterministic per conversation (channelArn hash)
 * so the same conversation always gets the same model variant.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import type { BackendModelDefinition, BackendModelKey, Classification } from '../../../lib/config/model-strategy.js';
import { bedrockInvokeId } from '../../../lib/config/model-strategy.js';
import { IMAGE_GEN_MODELS, type ImageGenModelKey } from './image-gen-models.js';
import { intentTypeToRouteKey } from './model-resolver.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';
import { SSMClient } from '@aws-sdk/client-ssm';
import { lookupProfileVersionModelKey } from './profile-version-lookup.js';

// removeUndefinedValues: createExperiment persists the validated record
// directly, and validateAndSanitizeExperiment leaves optional fields
// undefined (blank systemPromptAddendum, text-only imageGenModelKey,
// absent endDate/description/boundBy). Same class of bug as the
// admin-experiments handler — this is the legacy/direct create path.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const EXPERIMENTS_TABLE = process.env.EXPERIMENTS_TABLE || '';
// SPEC-PORTABLE-VERSIONED-PROFILES §6: a profileRef variant resolves its model from the referenced
// profile version's SSM definition. Own client (like the ddb one above); read-only + fail-safe.
const ssmClient = new SSMClient({});
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

// ============================================================
// Types
// ============================================================

export interface ExperimentVariant {
  variantId: string;
  /** The model this variant runs. MUTUALLY EXCLUSIVE with `profileRef` (validated) — a variant
   *  varies either a bare model (+ optional prompt-addendum) OR an entire profile version, not both. */
  modelKey?: BackendModelKey;
  /**
   * SPEC-PORTABLE-VERSIONED-PROFILES §6: run an ENTIRE profile version as the variant. The variant's
   * model (and, once the AssistantConfig unification lands, its prompt/pack/tools/guardrail) come from
   * that version's definition. Resolved at runtime via lookupProfileVersionModelKey. Mutually exclusive
   * with `modelKey`.
   */
  profileRef?: { profileName: string; version?: number };
  weight: number; // 0-100, all variants should sum to 100
  /** Display name surfaced to users + in the rival prompt during a battle. Required when the parent experiment.battleEnabled is true. Max ~16 chars. */
  displayName?: string;
  /** Variant-specific addendum to the system prompt. Sanitized server-side
   *  (length-cap, control-char strip, no closing-delimiter); the async
   *  processor wraps it in <persona_addendum>...</persona_addendum> tags
   *  during prompt assembly so battle-mode constraints still win. */
  systemPromptAddendum?: string;
  /**
   * Phase-4 generation-out: when set, this variant produces an IMAGE
   * (not text) using this image-gen model. A battle is generation-out
   * iff BOTH variants set it (validated both-or-neither). Locked #1's
   * recommended config is `titan_image` vs `nova_canvas` — a genuine
   * head-to-head. Kept off `modelKey` deliberately (locked #2: image
   * models are NOT `BackendModelKey`s — no resolver/classification/token ripple).
   */
  imageGenModelKey?: ImageGenModelKey;
}

/** Advisory objective metric. */
export type ExperimentObjectiveMetric = 'cost' | 'accuracy' | 'quality' | 'latency';

export interface ExperimentObjective {
  metric: ExperimentObjectiveMetric;
  /**
   * Target as a percentage in [0, 100]: a desired *decrease* for cost/latency,
   * or a desired *level* for accuracy/quality. Advisory only — it frames the
   * recommendation, never an automatic routing change.
   */
  target: number;
}

/**
 * What model-selection point the experiment swaps.
 * Absent ⇒ 'intent', so every record with no type is an intent experiment and behavior
 * is unchanged. All three types resolve: 'intent' and 'base_model' via
 * `resolveExperimentModel` (an intent-specific experiment wins; 'base_model' applies to
 * any intent on the classification), and 'classification' via `resolveClassificationExperiment`
 * (it swaps the intent-classifier model).
 */
export type ExperimentType = 'intent' | 'base_model' | 'classification';

export interface Experiment {
  experimentId: string;
  status: 'active' | 'paused' | 'completed';
  /** Defaults to 'intent' when absent. */
  experimentType?: ExperimentType;
  intent: string;
  tiers: Classification[];
  variants: ExperimentVariant[];
  startDate: string;
  endDate?: string;
  createdAt: string;
  description?: string;
  /** Advisory target. Never auto-acts. */
  objective?: ExperimentObjective;
  /** v0.2.0 (SPEC-BATTLE.md): when true, this experiment can power
   *  /battle. Requires exactly 2 variants and a defined altBotSlotId. */
  battleEnabled?: boolean;
  /** Stable id of the alt-bot pool slot the treatment variant occupies, e.g. "slot-0". */
  altBotSlotId?: string;
  /** Denormalized slot ARN for fast async-processor lookup. Computed at admin-write time from altBotSlotId + the SSM roster. */
  altBotSlotArn?: string;
  /** User ARN of the admin who last bound this experiment to its slot. Required when battleEnabled. */
  boundBy?: string;
  /**
   * B: long-form battle behavior toggle.
   *  'one-shot' (default) - the model produces the COMPLETE deliverable
   *  in round-1; pairs with attachment delivery via D.
   *  'outline-first' - round-1 = a concise approach/outline only;
   *  the user reviews the two approaches side-by-side and steers
   *  before the full deliverable is produced (no attachment forced).
   *  Only meaningful for long-form (report_generation / document) battles.
   */
  longFormMode?: 'one-shot' | 'outline-first';
  /** ISO timestamp of the last binding write. */
  boundAt?: string;
}

export interface ExperimentResolution {
  experimentId: string;
  variantId: string;
  modelKey: BackendModelKey;
  bedrockModelId: string;
}

// ============================================================
// In-Memory Cache
// ============================================================

interface CachedExperiments {
  experiments: Experiment[];
  loadedAt: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
let experimentCache: CachedExperiments | null = null;

async function loadExperiments(): Promise<Experiment[]> {
  if (experimentCache && Date.now() - experimentCache.loadedAt < CACHE_TTL_MS) {
    return experimentCache.experiments;
  }

  if (!EXPERIMENTS_TABLE) {
    return [];
  }

  try {
    const result = await ddb.send(new ScanCommand({
      TableName: EXPERIMENTS_TABLE,
      FilterExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':active': 'active' },
    }));

    const experiments = (result.Items || []) as Experiment[];
    experimentCache = { experiments, loadedAt: Date.now() };
    return experiments;
  } catch (error) {
    console.error('[ExperimentManager] Failed to load experiments:', error);
    return experimentCache?.experiments || [];
  }
}

// ============================================================
// Variant Assignment
// ============================================================

/**
 * Deterministically assign a variant based on channelArn + experimentId.
 * Uses MD5 hash mod 100 to pick a bucket, then maps to variant by cumulative weight.
 * This ensures the same conversation always gets the same variant without
 * storing assignments in a separate table.
 */
export function assignVariant(experimentId: string, channelArn: string, variants: ExperimentVariant[]): ExperimentVariant {
  if (variants.length === 0) {
    throw new Error('Experiment has no variants');
  }
  if (variants.length === 1) {
    return variants[0];
  }

  const hash = createHash('md5').update(`${channelArn}:${experimentId}`).digest();
  const bucket = hash.readUInt32BE(0) % 100;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) {
      return variant;
    }
  }

  // Fallback to last variant (handles rounding)
  return variants[variants.length - 1];
}

// ============================================================
// Experiment Resolution
// ============================================================

/**
 * Find an active experiment matching this classification + intent, assign a variant,
 * and return the model to use. Returns null if no experiment applies.
 */
export async function resolveExperimentModel(
  classification: Classification,
  intent: string,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): Promise<ExperimentResolution | null> {
  const experiments = await loadExperiments();
  const now = new Date();
  const isLiveForClassification = (exp: Experiment): boolean =>
    exp.status === 'active' &&
    exp.tiers.includes(classification) &&
    (!exp.endDate || new Date(exp.endDate) > now);

  // Resolution order: an intent-specific experiment wins over a base-model
  // experiment when both apply. A base-model experiment swaps the classification default
  // for ANY intent (no intent match). Absent type ⇒ 'intent', so existing
  // behavior is unchanged when no
  // base-model experiments exist. Classification experiments resolve separately
  // (resolveClassificationExperiment) and never match here.
  //
  // Intent match normalizes the coarse classifier intent (e.g. 'general') to the
  // fine-grained RouteKey ('general_qa') the admin UI stores on the experiment —
  // the SAME mapping the model resolver applies — so an intent experiment matches
  // the route the turn actually resolves to. Comparing the raw classifier intent
  // here silently never matched (classifier vocabulary ≠ route-key vocabulary).
  const routeKey = intentTypeToRouteKey(intent);
  const experiment =
    experiments.find(
      (exp) => (exp.experimentType ?? 'intent') === 'intent' && exp.intent === routeKey && isLiveForClassification(exp),
    ) ??
    experiments.find((exp) => exp.experimentType === 'base_model' && isLiveForClassification(exp));

  if (!experiment) return null;

  return resolveVariantForProfile(experiment, classification, channelArn, catalog);
}

/**
 * Resolve a classification A/B experiment for this classification.
 * Classification experiments swap the intent-classifier model and are
 * intent-agnostic, so this matches on type + classification only. Returns the resolved
 * classifier model, or null when no classification experiment applies. Called
 * by the router BEFORE classifyIntent; the §11.1 mutual-exclusion rule
 * guarantees a classification experiment never coexists with another type on
 * the classification, so this resolution and resolveExperimentModel never both fire.
 */
export async function resolveClassificationExperiment(
  classification: Classification,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): Promise<ExperimentResolution | null> {
  const experiments = await loadExperiments();
  const now = new Date();
  const experiment = experiments.find(
    (exp) =>
      exp.experimentType === 'classification' &&
      exp.status === 'active' &&
      exp.tiers.includes(classification) &&
      (!exp.endDate || new Date(exp.endDate) > now),
  );
  if (!experiment) return null;
  return resolveVariantForProfile(experiment, classification, channelArn, catalog);
}

/**
 * Shared tail for experiment resolution: deterministically assign a variant,
 * look up its catalog model, enforce classification safety, and return the invoke id.
 * Returns null on an unknown model key or a classification-disallowed model.
 */
/**
 * The model a variant runs: its `modelKey`, or — for a profileRef variant (§6) — the referenced profile
 * version's modelKey, read from SSM at runtime. null when neither resolves (fail-safe: the caller skips).
 */
async function effectiveModelKeyOf(variant: ExperimentVariant): Promise<BackendModelKey | null> {
  if (variant.profileRef) {
    const mk = await lookupProfileVersionModelKey(ssmClient, SSM_ROOT, variant.profileRef);
    if (!mk) {
      console.warn(`[ExperimentManager] profileRef ${variant.profileRef.profileName}@${variant.profileRef.version ?? 'active'} unresolved`);
      return null;
    }
    return mk as BackendModelKey;
  }
  return variant.modelKey ?? null;
}

async function resolveVariantForProfile(
  experiment: Experiment,
  classification: Classification,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): Promise<ExperimentResolution | null> {
  const variant = assignVariant(experiment.experimentId, channelArn, experiment.variants);

  // §6: a profileRef variant runs an entire profile version — its model comes from that version's
  // definition. Fail-safe: an unresolvable variant skips the experiment (deterministic default holds).
  const effectiveModelKey = await effectiveModelKeyOf(variant);
  if (!effectiveModelKey) {
    console.error('[ExperimentManager] variant has neither modelKey nor a resolvable profileRef; skipping');
    return null;
  }

  const model = catalog[effectiveModelKey];
  if (!model) {
    console.error(`[ExperimentManager] Unknown model key in experiment: ${effectiveModelKey}`);
    return null;
  }

  // Classification ceiling still binds — a version can never exceed the channel's classification (§6, min-cap).
  if (!model.allowedClassifications.includes(classification)) {
    console.warn(`[ExperimentManager] Model ${effectiveModelKey} not allowed for classification ${classification}, skipping experiment`);
    return null;
  }

  return {
    experimentId: experiment.experimentId,
    variantId: variant.variantId,
    modelKey: effectiveModelKey,
    bedrockModelId: bedrockInvokeId(model),
  };
}

// ============================================================
// CRUD Operations (for admin API)
// ============================================================

export async function createExperiment(experiment: Omit<Experiment, 'createdAt'>): Promise<Experiment> {
  // Sanitize + validate before persistence. Throws ExperimentValidationError
  // on rule breaks (admin API surfaces these as 4xx). Battle-mode rules
  // (variant count, displayName, slot binding) are enforced here.
  const sanitized = validateAndSanitizeExperiment({
    ...experiment,
    createdAt: new Date().toISOString(),
  } as Experiment);

  const record: Experiment = {
    ...sanitized,
    // Stamp boundAt server-side when battle binding is being set.
    ...(sanitized.battleEnabled && !sanitized.boundAt && { boundAt: new Date().toISOString() }),
  };

  await ddb.send(new PutCommand({
    TableName: EXPERIMENTS_TABLE,
    Item: record,
  }));

  // Invalidate cache
  experimentCache = null;

  return record;
}

export async function updateExperimentStatus(experimentId: string, status: Experiment['status']): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: EXPERIMENTS_TABLE,
    Key: { experimentId },
    UpdateExpression: 'SET #s = :status',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': status },
  }));

  // Invalidate cache
  experimentCache = null;
}

export async function listExperiments(): Promise<Experiment[]> {
  if (!EXPERIMENTS_TABLE) return [];

  const result = await ddb.send(new ScanCommand({
    TableName: EXPERIMENTS_TABLE,
  }));

  return (result.Items || []) as Experiment[];
}

// ============================================================
// Battle support (SPEC-BATTLE.md)
// ============================================================

/**
 * Maximum length for systemPromptAddendum after whitespace normalization.
 * Spec: "Length cap: maximum 500 characters after whitespace normalization."
 */
export const MAX_PROMPT_ADDENDUM_LENGTH = 500;

/** Maximum length for displayName. Spec: max ~16 chars. */
export const MAX_DISPLAY_NAME_LENGTH = 16;

/**
 * Hard cap on total active experiments.
 * The runtime resolver does a DynamoDB Scan with FilterExpression and a
 * JS-side `.find()` — fine at small N, but with unbounded growth the
 * Scan + filter walk becomes a per-message latency tax. The admin write
 * path now refuses to create/activate beyond this cap; admins can either
 * complete an existing experiment or raise the cap. 50 is well above
 * any plausible legitimate A/B-test concurrency for a single deployment.
 */
export const MAX_ACTIVE_EXPERIMENTS = 50;

/**
 * The closing delimiter we use during prompt assembly. Addenda containing
 * this literal sequence (case-insensitive) are rejected so an addendum
 * cannot break out of its <persona_addendum>...</persona_addendum> wrapper.
 */
export const PERSONA_ADDENDUM_CLOSER = '</persona_addendum>';

export class ExperimentValidationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ExperimentValidationError';
  }
}

/**
 * Sanitize a variant.systemPromptAddendum value per the spec.
 *
 * Steps (in order):
 *   1. Strip ASCII control characters that have no legitimate use in a
 *      system prompt (\x00-\x08, \x0B-\x0C, \x0E-\x1F, \x7F).
 *   2. Collapse runs of whitespace to single space; trim ends.
 *   3. Length-cap at MAX_PROMPT_ADDENDUM_LENGTH chars.
 *   4. Reject (throw) if the result contains PERSONA_ADDENDUM_CLOSER
 *      (case-insensitive) — defense against admin-side breakout attempts.
 */
export function sanitizePromptAddendum(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ExperimentValidationError(
      'systemPromptAddendum must be a string',
      'ADDENDUM_TYPE',
    );
  }
  // Step 1: strip control characters.
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  // Step 2: normalize whitespace.
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return undefined;
  // Step 3: length cap.
  if (normalized.length > MAX_PROMPT_ADDENDUM_LENGTH) {
    throw new ExperimentValidationError(
      `systemPromptAddendum exceeds ${MAX_PROMPT_ADDENDUM_LENGTH} chars (got ${normalized.length})`,
      'ADDENDUM_TOO_LONG',
    );
  }
  // Step 4: reject closing-delimiter (case-insensitive).
  if (normalized.toLowerCase().includes(PERSONA_ADDENDUM_CLOSER.toLowerCase())) {
    throw new ExperimentValidationError(
      `systemPromptAddendum may not contain "${PERSONA_ADDENDUM_CLOSER}"`,
      'ADDENDUM_CLOSER',
    );
  }
  return normalized;
}

/**
 * Sanitize a variant.displayName value.
 * Strips control chars + normalizes whitespace + caps length.
 */
export function sanitizeDisplayName(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ExperimentValidationError('displayName must be a string', 'DISPLAY_NAME_TYPE');
  }
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ExperimentValidationError(
      `displayName exceeds ${MAX_DISPLAY_NAME_LENGTH} chars (got ${normalized.length})`,
      'DISPLAY_NAME_TOO_LONG',
    );
  }
  return normalized;
}

/**
 * Validate + sanitize an Experiment record before persistence. Throws
 * ExperimentValidationError on any rule break so admin-API callers can
 * convert to 4xx responses.
 *
 * Battle-mode rules (per spec):
 *   - battleEnabled=true requires exactly 2 variants.
 *   - Both variants must have a non-empty displayName.
 *   - altBotSlotId must be defined.
 *   - boundBy must be set so we can attribute the binding.
 *
 * Returns a new Experiment with sanitized addendum + displayName fields.
 */
export function validateAndSanitizeExperiment(input: Experiment): Experiment {
  const variants = input.variants.map((v) => ({
    ...v,
    displayName: sanitizeDisplayName(v.displayName),
    systemPromptAddendum: sanitizePromptAddendum(v.systemPromptAddendum),
  }));

  // Each variant runs EITHER a bare model OR an entire profile version (SPEC-PORTABLE-VERSIONED-PROFILES
  // §6) — exactly one of modelKey / profileRef, never both, never neither. A bare modelKey is a catalog
  // key ('haiku'/'sonnet'); a profileRef {profileName, version?} runs that version's definition. Reject a
  // mis-specified variant at create time (400) instead of producing a mystery 0-row result.
  variants.forEach((v, i) => {
    const hasModel = typeof v.modelKey === 'string' && v.modelKey.trim().length > 0;
    const hasRef = !!v.profileRef && typeof v.profileRef.profileName === 'string' && v.profileRef.profileName.trim().length > 0;
    if (hasModel === hasRef) {
      throw new ExperimentValidationError(
        `variant index ${i} requires EXACTLY ONE of modelKey (a catalog key like 'haiku'/'sonnet') or profileRef {profileName, version?} — not both, not neither`,
        'VARIANT_MODEL_KEY_REQUIRED',
      );
    }
    if (hasRef && v.profileRef!.version !== undefined && (!Number.isInteger(v.profileRef!.version) || v.profileRef!.version < 1)) {
      throw new ExperimentValidationError(`variant index ${i} profileRef.version must be a positive integer (omit for the active version)`, 'VARIANT_PROFILE_REF_VERSION');
    }
  });

  // Experiment type. Absent ⇒ 'intent'.
  const experimentType: ExperimentType = input.experimentType ?? 'intent';
  if (!EXPERIMENT_TYPES.includes(experimentType)) {
    throw new ExperimentValidationError(
      `experimentType must be one of ${EXPERIMENT_TYPES.join(', ')} (got "${input.experimentType}")`,
      'EXPERIMENT_TYPE_INVALID',
    );
  }
  // An 'intent' experiment must name the intent it scopes to. 'base_model'
  // and 'classification' apply across intents, so intent is not required for
  // them (any value is ignored by resolution).
  if (experimentType === 'intent' && !input.intent?.trim()) {
    throw new ExperimentValidationError(
      "intent experiments require a non-empty intent",
      'EXPERIMENT_INTENT_REQUIRED',
    );
  }

  // Objective — advisory; validate shape only.
  const objective = validateObjective(input.objective, experimentType);

  if (input.battleEnabled) {
    // A battle runs head-to-head in ONE channel, so it must target exactly one classification — never a
    // mixed set (structural). But `battleEligible` is now a HINT, not a gate (SPEC-PORTABLE-VERSIONED-
    // PROFILES §1/§6): an OPERATOR-driven comparison may battle any profile/version at any classification.
    // The classification CEILING still binds — resolveVariantForProfile rejects a model not allowed for
    // the channel's classification (min-cap) — so allowing a non-"battleEligible" target never escalates.
    // (Error code kept as BATTLE_TIER_PREMIUM_ONLY for the API/UI contract.)
    const tiers = input.tiers || [];
    if (tiers.length !== 1) {
      throw new ExperimentValidationError(
        `battleEnabled experiments must target exactly one classification (got [${tiers.join(', ')}])`,
        'BATTLE_TIER_PREMIUM_ONLY',
      );
    }
    if (!profiles.profileFor(tiers[0]).battleEligible) {
      console.log('[ExperimentManager] operator-driven battle on a non-battleEligible classification (battleEligible is now a hint):', tiers[0]);
    }
    if (variants.length !== 2) {
      throw new ExperimentValidationError(
        `battleEnabled experiments require exactly 2 variants (got ${variants.length})`,
        'BATTLE_VARIANT_COUNT',
      );
    }
    if (!input.altBotSlotId) {
      throw new ExperimentValidationError(
        'battleEnabled experiments require altBotSlotId',
        'BATTLE_SLOT_REQUIRED',
      );
    }
    if (!input.boundBy) {
      throw new ExperimentValidationError(
        'battleEnabled experiments require boundBy (ARN of the admin)',
        'BATTLE_BOUND_BY',
      );
    }
    for (const [i, v] of variants.entries()) {
      if (!v.displayName) {
        throw new ExperimentValidationError(
          `battleEnabled experiments require displayName on every variant (variant index ${i} missing)`,
          'BATTLE_DISPLAY_NAME',
        );
      }
    }
    // Phase-4 generation-out: it's a gen-out battle iff BOTH variants
    // name a registered image model. Half-configured (one variant only)
    // is a misconfig — fail fast at write time, never silently produce
    // a text-vs-image battle (honesty > silent degradation).
    const imgKeys = variants.map((v) => v.imageGenModelKey);
    const withImg = imgKeys.filter(Boolean) as ImageGenModelKey[];
    if (withImg.length === 1) {
      throw new ExperimentValidationError(
        'battleEnabled generation-out requires imageGenModelKey on BOTH variants or neither',
        'BATTLE_IMAGE_GEN_PAIR',
      );
    }
    for (const k of withImg) {
      if (!(k in IMAGE_GEN_MODELS)) {
        throw new ExperimentValidationError(
          `unknown imageGenModelKey "${k}" (expected one of ${Object.keys(IMAGE_GEN_MODELS).join(', ')})`,
          'BATTLE_IMAGE_GEN_PAIR',
        );
      }
    }
  }

  return { ...input, experimentType, objective, variants };
}

/** Canonical experiment types. */
export const EXPERIMENT_TYPES: ExperimentType[] = ['intent', 'base_model', 'classification'];

const OBJECTIVE_METRICS: ExperimentObjectiveMetric[] = ['cost', 'accuracy', 'quality', 'latency'];

/**
 * Validate an optional objective. Returns the
 * objective unchanged when valid, or undefined when absent. Throws on a
 * malformed objective. The metric/type pairing follows the guide: 'accuracy'
 * is the classification quality metric; 'quality' is for base_model/intent;
 * 'cost' and 'latency' apply to any type.
 */
export function validateObjective(
  objective: ExperimentObjective | undefined,
  experimentType: ExperimentType,
): ExperimentObjective | undefined {
  if (objective === undefined || objective === null) return undefined;
  if (typeof objective !== 'object') {
    throw new ExperimentValidationError('objective must be an object', 'OBJECTIVE_TYPE');
  }
  if (!OBJECTIVE_METRICS.includes(objective.metric)) {
    throw new ExperimentValidationError(
      `objective.metric must be one of ${OBJECTIVE_METRICS.join(', ')} (got "${objective.metric}")`,
      'OBJECTIVE_METRIC_INVALID',
    );
  }
  if (typeof objective.target !== 'number' || !Number.isFinite(objective.target)
      || objective.target < 0 || objective.target > 100) {
    throw new ExperimentValidationError(
      `objective.target must be a percentage in [0, 100] (got ${objective.target})`,
      'OBJECTIVE_TARGET_RANGE',
    );
  }
  if (objective.metric === 'accuracy' && experimentType !== 'classification') {
    throw new ExperimentValidationError(
      "objective.metric 'accuracy' applies only to a classification experiment",
      'OBJECTIVE_METRIC_TYPE_MISMATCH',
    );
  }
  if (objective.metric === 'quality' && experimentType === 'classification') {
    throw new ExperimentValidationError(
      "a classification experiment measures 'accuracy', not 'quality'",
      'OBJECTIVE_METRIC_TYPE_MISMATCH',
    );
  }
  return { metric: objective.metric, target: objective.target };
}

/**
 * Mutual-exclusion rule: a classification
 * experiment cannot be active on a classification while any other type is active on that
 * classification, and vice versa — changing the classifier shifts routing for every
 * intent and confounds the other tests. Returns the active experiments that
 * conflict with the candidate over any shared classification (empty ⇒ no conflict).
 * DB-backed (mirrors findBattleSlotConflicts); the admin write path calls it
 * and converts a non-empty result to 409.
 */
export async function findTypeExclusionConflicts(args: {
  experimentType: ExperimentType;
  tiers: Classification[];
  excludeExperimentId?: string;
}): Promise<Experiment[]> {
  const candidateType = args.experimentType ?? 'intent';
  const tiers = new Set(args.tiers || []);
  const experiments = await loadExperiments();
  return experiments.filter((e) => {
    if (e.status !== 'active') return false;
    if (e.experimentId === args.excludeExperimentId) return false;
    const otherType = e.experimentType ?? 'intent';
    const sharesClassification = (e.tiers || []).some((t) => tiers.has(t));
    if (!sharesClassification) return false;
    // Conflict iff exactly one side is a classification experiment.
    return (candidateType === 'classification') !== (otherType === 'classification');
  });
}

/**
 * Resolve a battle-bound alt-bot slot ARN to its variant config — the
 * hot path the async processor calls on every alt-bot invocation. Reads
 * from the existing 60s-cached experiments scan so this is effectively
 * free after a warm hit.
 *
 * Returns null when no active battle-enabled experiment claims the slot.
 */
export async function resolveBattleVariantBySlotArn(
  slotArn: string,
): Promise<{
  experimentId: string;
  variantId: string;
  modelKey: BackendModelKey;
  displayName: string;
  systemPromptAddendum?: string;
  longFormMode?: 'one-shot' | 'outline-first';
} | null> {
  if (!slotArn) return null;
  const experiments = await loadExperiments();
  const exp = experiments.find(
    (e) => e.battleEnabled === true && e.altBotSlotArn === slotArn,
  );
  if (!exp) return null;
  // variants[0] = control (default bot); variants[1] = treatment (alt slot).
  const treatment = exp.variants[1];
  if (!treatment) return null;
  const treatmentModelKey = await effectiveModelKeyOf(treatment); // §6: resolves a profileRef variant
  if (!treatmentModelKey) return null;
  return {
    experimentId: exp.experimentId,
    variantId: treatment.variantId,
    modelKey: treatmentModelKey,
    displayName: treatment.displayName ?? treatment.variantId,
    systemPromptAddendum: treatment.systemPromptAddendum,
    longFormMode: exp.longFormMode,
  };
}

/**
 * Resolve the CONTROL side (variants[0]) of the battle bound to
 * `altSlotArn`. The default bot IS the control side; from its
 * invocation `battleContext.rivalBotArn` is the alt-slot ARN, so the
 * async processor resolves the experiment by the rival's ARN here.
 *
 * Honoring the experiment's configured control variant (model +
 * displayName + addendum) makes `/battle` a faithful head-to-head of
 * the two configured variants — the Design Anchor in SPEC-BATTLE.md.
 * This generalizes the older SPEC-BATTLE §413 ("control = normal
 * classification+intent resolution"): callers fall back to classification+intent resolution
 * only when there is no bound experiment or it pins no control modelKey
 * (treated as `null` here → caller keeps its existing default).
 *
 * Same 60s-cached scan as resolveBattleVariantBySlotArn — free after a
 * warm hit. Returns null when no active battle-enabled experiment
 * claims the slot.
 */
export async function resolveBattleControlVariantByAltSlotArn(
  altSlotArn: string,
): Promise<{
  experimentId: string;
  variantId: string;
  modelKey: BackendModelKey;
  displayName: string;
  systemPromptAddendum?: string;
  longFormMode?: 'one-shot' | 'outline-first';
} | null> {
  if (!altSlotArn) return null;
  const experiments = await loadExperiments();
  const exp = experiments.find(
    (e) => e.battleEnabled === true && e.altBotSlotArn === altSlotArn,
  );
  if (!exp) return null;
  // variants[0] = control (default bot); variants[1] = treatment (alt slot).
  const control = exp.variants[0];
  if (!control) return null;
  const controlModelKey = await effectiveModelKeyOf(control); // §6: resolves a profileRef variant
  if (!controlModelKey) return null;
  return {
    experimentId: exp.experimentId,
    variantId: control.variantId,
    modelKey: controlModelKey,
    displayName: control.displayName ?? control.variantId,
    systemPromptAddendum: control.systemPromptAddendum,
    longFormMode: exp.longFormMode,
  };
}

/**
 * Phase-4 generation-out: resolve the battle bound to `altSlotArn` to
 * its per-side Bedrock image-gen model ids — the hot path the `/battle`
 * fan-out calls once to populate each bot's
 * `battleContext.imageGenModelId`. `control` = `variants[0]` (the
 * default bot), `treatment` = `variants[1]` (the alt slot). Returns
 * `null` when the slot isn't battle-bound OR the bound experiment is a
 * text battle (no `imageGenModelKey`) — the fan-out then leaves
 * `imageGenModelId` unset and the processor runs a normal text battle
 * (honest fall-through, validated both-or-neither at write time so a
 * single side never carries it). Same 60s-cached scan as
 * resolveBattleVariantBySlotArn — effectively free after a warm hit.
 */
export async function resolveBattleImageGenPair(
  altSlotArn: string,
): Promise<{ controlModelId: string; treatmentModelId: string } | null> {
  if (!altSlotArn) return null;
  const experiments = await loadExperiments();
  const exp = experiments.find(
    (e) => e.battleEnabled === true && e.altBotSlotArn === altSlotArn,
  );
  if (!exp) return null;
  const controlKey = exp.variants[0]?.imageGenModelKey;
  const treatmentKey = exp.variants[1]?.imageGenModelKey;
  if (!controlKey || !treatmentKey) return null; // text battle
  const control = IMAGE_GEN_MODELS[controlKey];
  const treatment = IMAGE_GEN_MODELS[treatmentKey];
  if (!control || !treatment) return null; // unknown key — honest skip
  return {
    controlModelId: control.bedrockModelId,
    treatmentModelId: treatment.bedrockModelId,
  };
}

/**
 * Find any other active battle-enabled experiments bound to the same
 * altBotSlotId. Used by the admin-API enable path to enforce the "one
 * experiment per slot" rule (returns conflicts as 409).
 */
export async function findBattleSlotConflicts(args: {
  altBotSlotId: string;
  excludeExperimentId?: string;
}): Promise<Experiment[]> {
  const experiments = await loadExperiments();
  return experiments.filter(
    (e) =>
      e.battleEnabled === true
      && e.altBotSlotId === args.altBotSlotId
      && e.experimentId !== args.excludeExperimentId,
  );
}

/**
 * Look up the resolved display name for a bot ARN within a battle
 * context. For the alt-slot bot: the treatment variant's displayName.
 * For the default bot: the control variant's displayName (resolved via
 * `altSlotArn`, since the experiment is keyed by the alt-slot ARN) —
 * NOT the generic "the default assistant" anymore, so the rival name
 * woven into the round-1/round-2 system prompt and the scorecard match
 * what the user sees (e.g. "Atlas"). Falls back gracefully when the
 * battle/variant can't be resolved.
 */
export async function resolveBotDisplayName(args: {
  thisBotArn: string;
  defaultBotArn: string;
  /** The battle's alt-slot ARN — the experiment is keyed by it, so the
   *  control side needs it to resolve variants[0].displayName. */
  altSlotArn: string;
}): Promise<string> {
  if (args.thisBotArn === args.defaultBotArn) {
    const control = await resolveBattleControlVariantByAltSlotArn(args.altSlotArn);
    return control?.displayName ?? 'the default assistant';
  }
  const variant = await resolveBattleVariantBySlotArn(args.thisBotArn);
  return variant?.displayName ?? 'the other assistant';
}
