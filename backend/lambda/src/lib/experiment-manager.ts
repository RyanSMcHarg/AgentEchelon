/**
 * Experiment Manager
 *
 * Runtime A/B testing framework for comparing Bedrock models per intent.
 * Experiments are stored in DynamoDB and cached in-memory for 60s.
 * Variant assignment is deterministic per conversation (channelArn hash)
 * so the same conversation always gets the same model variant.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import type { BackendModelDefinition, BackendModelKey, Classification } from '../../../lib/config/model-strategy.js';
import { bedrockInvokeId } from '../../../lib/config/model-strategy.js';
import { IMAGE_GEN_MODELS, type ImageGenModelKey } from './image-gen-models.js';
import { imagePrimaryForIntent } from './image-route.js';
import { imageRouteKeyOf } from './experiment-image-route.js';
import { modelFits } from '../../../lib/config/model-availability.js';
import { answersThroughGeneral, GENERAL_ROUTE_KEY, retiredRouteKeyError } from './model-resolver.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { SSMClient } from '@aws-sdk/client-ssm';
import { concreteProfileVersion, lookupProfileVersion, lookupProfileVersionModelKey } from './profile-version-lookup.js';
import type { ProfileDefinition } from './active-profile.js';
import { noticeLine } from './assistant-notice.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient, sessionDocumentClient } from './assistant-session.js';
import type { ConversationEnrollment } from './channel-context-client.js';
import { DUEL_ROLE, challengerOf, withoutLegacyBinding, type LegacyBattleBinding } from './alt-assignment.js';

// removeUndefinedValues: createExperiment persists the validated record
// directly, and validateAndSanitizeExperiment leaves optional fields
// undefined (blank systemPromptAddendum, text-only imageGenModelKey,
// absent endDate/description/boundBy). Same class of bug as the
// admin-experiments handler — this is the legacy/direct create path.
const ddb = sessionDocumentClient({ requestHandler: BOUNDED_REQUEST_HANDLER }, {
  marshallOptions: { removeUndefinedValues: true },
});
const EXPERIMENTS_TABLE = process.env.EXPERIMENTS_TABLE || '';
// SPEC-PORTABLE-PROFILES FR11: a profileRef variant resolves its model from the referenced
// profile version's SSM definition. Own client (like the ddb one above); read-only + fail-safe.
const ssmClient = sessionClient(SSMClient, { requestHandler: BOUNDED_REQUEST_HANDLER });
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
   * SPEC-PORTABLE-PROFILES FR11: run an ENTIRE profile version as the variant. The variant's
   * model (and, once the AssistantConfig unification lands, its prompt/pack/tools/guardrail) come from
   * that version's definition. Resolved at runtime via lookupProfileVersionModelKey. Mutually exclusive
   * with `modelKey`.
   */
  profileRef?: { profileName: string; version?: number };
  /**
   * THE TREATMENT'S CANDIDATE VERSION, on variants[1] (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5,
   * ADR-050). Derived when the experiment is armed: the control plus the experiment type's recipe,
   * published in the candidate history, the role's alt `alt-{role}-{classification}`. A conversation
   * enrolled in the treatment is served this version on every turn (`pinFor`), and a duel's treatment
   * side serves it from the alt identity. The persisted name predates its use outside battles.
   */
  altPin?: { profileName: string; version: number; configId?: string };
  /**
   * THE CONTROL'S VERSION, on variants[0] (§3.5): the live assistant's ACTIVE version, pinned by number
   * when the experiment is armed. A reference; nothing is published under the live name. A conversation
   * enrolled in the control is served it, and a duel's control side serves it from the live identity.
   * A `profile` experiment's control is its referenced version. A battle armed before experiments pinned
   * two versions holds a version derived under the live name here instead, and keeps reading it until it
   * is paused and resumed, which re-arms it.
   */
  controlPin?: { profileName: string; version: number; configId?: string };
  weight: number; // 0-100, all variants should sum to 100
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

/**
 * A metric that must NOT regress for a variant to be shippable (DESIGN §1.2).
 * Pre-registers the decision rule so the statistics can't be fished. Advisory
 * only — it frames the recommendation, never an automatic routing change.
 */
export interface ObjectiveGuardrail {
  metric: ExperimentObjectiveMetric;
  /** 'no_worse_than' bounds a regression; 'at_least' bounds an improvement floor. */
  direction: 'no_worse_than' | 'at_least';
  /** Percentage bound in [0, 100], same units as `target`. */
  bound: number;
}

export interface ExperimentObjective {
  // --- existing (unchanged; still the PRIMARY quantitative criterion) ---
  metric: ExperimentObjectiveMetric;
  /**
   * Target as a percentage in [0, 100]: a desired *decrease* for cost/latency,
   * or a desired *level* for accuracy/quality. Advisory only — it frames the
   * recommendation, never an automatic routing change.
   */
  target: number;

  // --- new, all optional (absent ⇒ today's behavior — INV-2) ---
  /** Prose: "the decision this test informs". Sanitized + capped at 500 chars. */
  statement?: string;
  /** Metrics that must NOT regress for a ship (≤3). Veto conditions, not a blend. */
  guardrails?: ObjectiveGuardrail[];
  /**
   * 0..1: how much the battle human-pick counts vs the metric (DESIGN §4.3).
   * Default absent ⇒ 0 ⇒ today's behavior (picks are dashboard-only). Never
   * blends the human pick into one number — it only raises confidence on
   * agreement and surfaces disagreement (INV-3/INV-4).
   */
  humanPickWeight?: number;
}

/**
 * The operator's recorded outcome when a test that RAN is completed (DESIGN §3.2.1).
 * Distinct from the computed advisory recommendation: this is the human's own
 * record of what they did, and `no_decision` is the default + always available so
 * an inconclusive test closes honestly (INV-1/INV-3). Recording it never routes.
 */
export interface ExperimentDecision {
  outcome: 'promoted_treatment' | 'kept_control' | 'no_decision';
  /** Optional prose, ≤500 chars (sanitized). */
  note?: string;
  /** Admin ARN from the token. */
  by: string;
  /** ISO timestamp. */
  at: string;
}

/**
 * One append-only lifecycle-audit entry (DESIGN §3.2 L7). Every status change and
 * guarded edit appends one, so the lifecycle is auditable (TENET P4). `from` may be
 * the pseudo-state 'create' for the record's first entry.
 */
export interface ExperimentTransition {
  from: Experiment['status'] | 'create';
  to: Experiment['status'];
  /** Actor ARN from the token (like `boundBy`). */
  by: string;
  /** ISO timestamp. */
  at: string;
  /** e.g. 'auto:endDate', 'conflict:paused', 'delete:soft'. */
  reason?: string;
}

/**
 * What model-selection point the experiment swaps.
 * Absent ⇒ 'intent', so every record with no type is an intent experiment and behavior
 * is unchanged. All three types resolve: 'intent' and 'base_model' via
 * `resolveExperimentModel` (an intent-specific experiment wins; 'base_model' applies to
 * any intent on the classification), and 'classification' via `resolveClassificationExperiment`
 * (it swaps the intent-classifier model).
 */
// 'profile' (SPEC-PORTABLE-PROFILES FR11, FR15) pits two whole assistant PROFILE versions against each
// other via profileRef variants. It swaps the assistant's base model across every intent, so it matches
// and conflicts exactly like 'base_model' — the difference is provenance (a versioned profile, not a bare
// model key), which the variant's profileRef carries.
export type ExperimentType = 'intent' | 'base_model' | 'classification' | 'profile';

export interface Experiment {
  experimentId: string;
  /**
   * Lifecycle state (DESIGN §3.2 / A.3). Widened additively: 'draft' (L3, never
   * resolves traffic) and 'deleted' (L8, terminal soft-delete tombstone) join the
   * original 'active'|'paused'|'completed'. Absent/omitted status still means
   * 'active' for legacy callers (INV-2). 'completed'/'deleted' are terminal.
   */
  status: 'draft' | 'active' | 'paused' | 'completed' | 'deleted';
  /** Defaults to 'intent' when absent. */
  experimentType?: ExperimentType;
  intent: string;
  /**
   * WHICH MODEL OF THE INTENT AN `intent` EXPERIMENT VARIES (ADR-064 decision 6): its text model (the default), its image
   * model (`kind: 'image'`, the route's image part, the variant's `modelKey` an image model), or one step's model
   * (`step`, the route's step override). The recipe changes only that model, so the one-variable rule holds.
   */
  target?: ExperimentTarget;
  tiers: Classification[];
  variants: ExperimentVariant[];
  /** BEHAVIOR (L5): now enforced at resolve time — an experiment isn't live before startDate. */
  startDate: string;
  /** BEHAVIOR (L5): auto-completes on expiry; already gates resolution. */
  endDate?: string;
  createdAt: string;
  description?: string;
  /** Advisory target. Never auto-acts. */
  objective?: ExperimentObjective;
  /** NEW (§3.2.1): the operator's recorded outcome, set when a test that RAN is completed. Advisory-adjacent; never routes. */
  decision?: ExperimentDecision;
  /** NEW (L7): append-only lifecycle audit. Every status change / guarded edit appends one entry. */
  transitions?: ExperimentTransition[];
  /** v0.2.0 (SPEC-BATTLE.md): when true, this experiment can power
   *  /battle. Requires exactly 2 variants and a challenger. */
  battleEnabled?: boolean;
  /**
   * The challenger the treatment variant runs as: the assistant id of its classification's alt,
   * `alt-{role}-{classification}` (ADR-050). One challenger per `(classification, role)` is structural (it
   * is the assignment record's key), so the id names it; its bot ARN is read from that record when needed,
   * never stored here. Rows written before this field are read through `challengerOf`.
   */
  challengerAssistant?: string;
  /** User ARN of the admin who last armed this experiment. Required when battleEnabled. */
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
  /**
   * SET WHEN THE EXPERIMENT IS ARMED WITH TWO PINNED VERSIONS (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5):
   * the control's `controlPin` (the live active version) and the treatment's `altPin` (the candidate). Such
   * an experiment enrolls conversations and serves each its assigned version whole. A row without it was
   * armed before; an `intent` or `base_model` one keeps resolving its variant's model per turn until it is
   * paused and resumed, which arms it this way.
   */
  servesVersions?: boolean;
  /** Set by the Promote action: the version a promotion activated in the live assistant (§3.6). */
  promotion?: { profileName: string; version: number; configId: string; at: string; by: string };
}

export interface ExperimentResolution {
  experimentId: string;
  variantId: string;
  modelKey: BackendModelKey;
  bedrockModelId: string;
  /**
   * The assigned variant's IMAGE-generation model (`imageGenModelKey`), when set. Lets the NORMAL
   * (non-battle) flow serve a variant's image model on an `image_generation` turn - so an image
   * experiment A/Bs its variants' image models exactly like a text experiment A/Bs their text models,
   * and battle is just the extra UI+scoring on top. Undefined for a text-only variant.
   */
  imageGenModelKey?: ImageGenModelKey;
  /**
   * The variant's FULL profile definition, for a `profileRef` variant (SPEC-PORTABLE-PROFILES FR11). A variant is
   * not a model: persona, tools, classifier mode, guardrail selection, task machines and context sources
   * all ride the version, which is what lets profile-vs-profile answer "do these tools earn their place"
   * — two versions that differ ONLY in `tools`. Serving just `modelKey` makes that experiment resolve to
   * two identical variants and report no difference, for a reason unrelated to the tools.
   *
   * Undefined for a lightweight `modelKey` variant, which stays exactly as it was.
   *
   * The classification boundary needs no widening to carry this, because every dimension is ALREADY
   * bounded per classification, and none of them by this resolution: the model by
   * the classification's selection (checked below), tools by the serving Lambda's own IAM (a tool reads only
   * what that classification's role can read), the guardrail by the per-classification ApplyGuardrail
   * grant (an unprovisioned selection AccessDenies and falls back loudly, never fails open), and context
   * sources by the published per-classification catalog (a source outside it is skipped, not served).
   */
  variantProfile?: ProfileDefinition;
  /**
   * THE NUMBER OF THE VERSION `variantProfile` IS: the parameter version its reference pins, so a turn it
   * serves is attributed to that number as an ordinary turn is to the active one. Undefined when the
   * reference names no concrete version; the attribution then leaves the number out rather than guess it.
   */
  variantVersion?: number;
  /** The variant version's attribution key, so analytics slices by the version that actually served. */
  configId?: string;
  /** The experiment's type, so the router attributes a turn by the type's rule (an `intent` experiment counts its intent's turns). */
  experimentType?: ExperimentType;
  /** An `intent` experiment's intent (and a `base_model` row's stored value), for that rule. */
  intent?: string;
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

// `forceRefresh` bypasses the 60s cache for correctness-critical WRITE-PATH reads (the
// create/activate conflict gate): a blocker created moments earlier must be visible or the
// type-exclusion check silently passes and two conflicting experiments both go active. Hot
// read paths (routing, drift, battle resolution) keep the cache.
async function loadExperiments(forceRefresh = false): Promise<Experiment[]> {
  if (!forceRefresh && experimentCache && Date.now() - experimentCache.loadedAt < CACHE_TTL_MS) {
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

/**
 * HOW STALE A "NOTHING IS LIVE" ANSWER MAY BE before the cache is re-read once. Much shorter than
 * `CACHE_TTL_MS` because a classification holds one live experiment at a time (DESIGN §3.2.1): the
 * minute the cache can lag is the minute a newly started experiment receives no traffic.
 */
const NOTHING_LIVE_RECHECK_MS = 10_000;

/**
 * WHETHER AN EXPERIMENT IS HELD FOR A CONVERSATION'S LIFE (ADR-050).
 *
 * An experiment that serves versions swaps what a person is served between turns and splits one
 * conversation's turns across two `configId`s, so it applies only to conversations enrolled in it, and an
 * enrolled conversation keeps its variant. That is every experiment armed with two pinned versions
 * (`servesVersions`, §3.5), any with a pinned version (a battle armed before that), a `profile`
 * experiment, and any with a `profileRef` variant. Only an `intent` or `base_model` row armed before
 * versions were pinned still resolves per turn.
 */
export function isConversationScoped(exp: Experiment): boolean {
  return exp.servesVersions === true
    || exp.experimentType === 'profile'
    || exp.variants.some((v) => !!v.profileRef || !!v.altPin || !!v.controlPin);
}

let enrollableCache: CachedExperiments | null = null;

/**
 * Every conversation-scoped experiment that could have been live at some instant: active, paused or
 * completed. Completed ones are included because a conversation created while an experiment ran is
 * enrolled in it even when its first turn arrives after the experiment ends. Draft and deleted never
 * enrolled anyone.
 *
 * `coveringInstant` is the instant the caller decides about (a conversation's `createdAt`). A cache
 * loaded BEFORE that instant cannot hold an experiment armed between the load and the instant, so it is
 * reloaded, with a consistent read: otherwise a conversation created just after an arm is decided
 * unenrolled on its first turn and enrolled on a later one, the mid-conversation swap enrollment exists
 * to prevent.
 */
/**
 * THE ENROLLABLE EXPERIMENTS THIS CONTAINER ALREADY HOLDS, with no read: the list `listEnrollableExperiments` cached,
 * while it is fresh. Undefined when this container has not read it, or its copy has expired.
 */
export function cachedEnrollableExperiments(): Experiment[] | undefined {
  return enrollableCache && Date.now() - enrollableCache.loadedAt < CACHE_TTL_MS ? enrollableCache.experiments : undefined;
}

/** Seed the container's cached list. For tests. */
export function __setEnrollableExperimentsForTests(experiments: Experiment[] | null): void {
  enrollableCache = experiments ? { experiments, loadedAt: Date.now() } : null;
}

export async function listEnrollableExperiments(coveringInstant?: string): Promise<Experiment[]> {
  const covering = coveringInstant ? Date.parse(coveringInstant) : NaN;
  const covers = !enrollableCache || !Number.isFinite(covering) || enrollableCache.loadedAt > covering;
  if (enrollableCache && covers && Date.now() - enrollableCache.loadedAt < CACHE_TTL_MS) return enrollableCache.experiments;
  if (!EXPERIMENTS_TABLE) return [];
  try {
    const items: Experiment[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: EXPERIMENTS_TABLE,
        FilterExpression: '#s IN (:active, :paused, :completed)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':paused': 'paused', ':completed': 'completed' },
        ExclusiveStartKey,
        ConsistentRead: true,
      }));
      items.push(...((page.Items || []) as Experiment[]));
      ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
    const experiments = items.filter(isConversationScoped);
    enrollableCache = { experiments, loadedAt: Date.now() };
    return experiments;
  } catch (error) {
    console.error('[ExperimentManager] Failed to load enrollable experiments:', error);
    return enrollableCache?.experiments || [];
  }
}

/**
 * The pin for a variant: what it serves NOW, frozen. A ref that tracks the `active` label is resolved to
 * the version the label points at, so the conversation keeps serving that version. Null when the ref
 * names no active version, which leaves the conversation unenrolled rather than pinned to nothing.
 */
export async function pinFor(experiment: Experiment, variant: ExperimentVariant): Promise<ConversationEnrollment | null> {
  // A PINNED VERSION IS WHAT THE VARIANT SERVES, whole (§3.5): the control's live active version or the
  // treatment's candidate. Its image model is the version's `models.image`, so nothing rides beside it.
  const versionPin = variant.altPin ?? variant.controlPin;
  if (versionPin) {
    return { experimentId: experiment.experimentId, variantId: variant.variantId, profileRef: { profileName: versionPin.profileName, version: versionPin.version } };
  }
  const base = {
    experimentId: experiment.experimentId,
    variantId: variant.variantId,
    ...(variant.imageGenModelKey ? { imageGenModelKey: variant.imageGenModelKey } : {}),
  };
  if (variant.profileRef) {
    const version = await concreteProfileVersion(ssmClient, SSM_ROOT, variant.profileRef);
    if (version === null) {
      console.warn('[ExperimentManager] variant profile has no active version; not enrolling', base);
      return null;
    }
    return { ...base, profileRef: { profileName: variant.profileRef.profileName, version } };
  }
  return variant.modelKey ? { ...base, modelKey: variant.modelKey } : null;
}

const pinnedExperimentCache = new Map<string, { exp: Experiment | null; loadedAt: number }>();

/** One experiment by id for a pinned conversation, cached per container for the usual minute. */
async function readPinnedExperiment(experimentId: string): Promise<Experiment | null> {
  const hit = pinnedExperimentCache.get(experimentId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.exp;
  const exp = await readExperimentFresh(experimentId);
  pinnedExperimentCache.set(experimentId, { exp, loadedAt: Date.now() });
  return exp;
}

/**
 * WHETHER AN ENROLLMENT STILL HOLDS (ADR-050 as amended).
 *
 * Only an ACTIVE experiment holds a conversation to its arm. The experiment must be `active` and inside its
 * window now, and must not have left `active` at any point since the conversation was enrolled: a pause
 * releases every enrolled conversation for good, so a resume enrolls only conversations created after it.
 * A released conversation is served the live assistant's active version from its next turn, which after a
 * promotion is the winner and otherwise the control. A record with no transitions (it predates the audit)
 * is judged by its status and window alone.
 */
export function enrollmentHolds(
  exp: Experiment,
  classification: Classification,
  enrolledAt?: string,
  now: Date = new Date(),
): boolean {
  if (!isLiveForClassification(exp, classification, now)) return false;
  if (!enrolledAt) return true;
  const since = Date.parse(enrolledAt);
  if (Number.isNaN(since)) return true;
  return !(exp.transitions ?? []).some((t) => Date.parse(t.at) > since && t.to !== 'active');
}

/**
 * The variant a pinned conversation serves, or null when the pin no longer resolves or no longer holds:
 * the experiment was deleted, does not cover this classification, no longer has the variant, or is not
 * active (`enrollmentHolds`). The experiment is read through the per-container cache, so a pause or an end
 * reaches a conversation within `CACHE_TTL_MS` (one minute) of the write.
 */
async function resolveEnrolledVariant(
  enrollment: ConversationEnrollment,
  classification: Classification,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): Promise<ExperimentResolution | null> {
  let exp: Experiment | null;
  try {
    exp = await readPinnedExperiment(enrollment.experimentId);
  } catch (error) {
    console.warn('[ExperimentManager] pinned experiment unreadable; serving no experiment this turn', {
      experimentId: enrollment.experimentId, err: (error as Error)?.message,
    });
    return null;
  }
  if (!exp || exp.status === 'deleted' || !exp.tiers.includes(classification)) {
    console.warn('[ExperimentManager] enrollment no longer resolves', { ...enrollment, status: exp?.status ?? 'missing' });
    return null;
  }
  if (!enrollmentHolds(exp, classification, enrollment.enrolledAt)) {
    console.log('[ExperimentManager] enrollment released: the experiment is not active, or left active after enrollment', {
      experimentId: enrollment.experimentId, variantId: enrollment.variantId, status: exp.status, endDate: exp.endDate,
    });
    return null;
  }
  // THE PIN, NOT THE EXPERIMENT'S CURRENT VARIANT: an edit to the experiment after enrollment does not
  // reach a conversation already running on it.
  const pinned: ExperimentVariant = {
    variantId: enrollment.variantId,
    weight: 100,
    ...(enrollment.profileRef ? { profileRef: enrollment.profileRef } : { modelKey: enrollment.modelKey as BackendModelKey }),
    ...(enrollment.imageGenModelKey ? { imageGenModelKey: enrollment.imageGenModelKey as ImageGenModelKey } : {}),
  };
  if (!pinned.profileRef && !pinned.modelKey) return null;
  return resolveVariantForProfile(exp, classification, channelArn, catalog, pinned);
}

/**
 * WHETHER A TURN SERVED BY AN EXPERIMENT'S VERSION COUNTS TOWARD THE EXPERIMENT (§3.5, "What an experiment
 * counts"). Every turn of an enrolled conversation is served its arm's version, and each type keeps the
 * meaning its attribution had when it was assigned per turn:
 *  - `intent`: only turns of its intent, matched as the resolver serves it (the intent's own route, or `general`
 *    for an intent that answers through it). Other turns are served the same route in both arms.
 *  - `classification`: only turns the version's classifier labeled (not the fast-path greeting).
 *  - `base_model`: every turn but the fast-path greeting and acknowledgment.
 *  - `profile`, or an alt's own turn: every turn.
 */
/** The one model of an intent an `intent` experiment varies (ADR-064 decision 6). */
export interface ExperimentTarget {
  kind?: 'text' | 'image';
  step?: string;
}

/** Why an experiment's target is refused as written, or null. */
export function experimentTargetError(target: unknown, experimentType: string | undefined): string | null {
  if (target === undefined) return null;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return 'target must be { kind?, step? }';
  if ((experimentType ?? 'intent') !== 'intent') return 'target names one model of an intent, so only an intent experiment carries it';
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) if (k !== 'kind' && k !== 'step') return `target.${k} is not a target field; a target is { kind?, step? }`;
  if (t.kind !== undefined && t.kind !== 'text' && t.kind !== 'image') return "target.kind is 'text' or 'image'";
  if (t.step !== undefined && (typeof t.step !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(t.step))) return 'target.step names a state of the intent\'s workflow';
  return null;
}

/**
 * THE ARM A TASK WAS OPENED UNDER (ADR-064 decision J), recorded on the task by the router (`Task.experimentArm`, a
 * field only the platform writes, mirrored on the task's copy). Null when the task records none.
 */
export function experimentArmOf(task: { experimentArm?: unknown } | null | undefined): { experimentId: string; variantId: string; configId?: string } | null {
  const arm = task?.experimentArm as Record<string, unknown> | undefined;
  return arm && typeof arm.experimentId === 'string' && arm.experimentId && typeof arm.variantId === 'string' && arm.variantId
    ? { experimentId: arm.experimentId, variantId: arm.variantId, ...(typeof arm.configId === 'string' ? { configId: arm.configId } : {}) }
    : null;
}

/**
 * WHETHER A TASK'S ARM IS STILL SERVED (ADR-064 decision J): while its experiment runs, a task stays on the arm it was
 * opened under. The experiment runs when it is `active`, covers the classification, is inside its window, still holds
 * the arm, and has not left `active` since the task opened (the rule an enrollment follows, `enrollmentHolds`). Once it
 * stops, the losing version is no longer served, so the task carries on with the live version; where the task's arm is
 * the version that became live, that is the version it was already on.
 */
export function taskArmServes(
  exp: Experiment | null | undefined,
  classification: Classification,
  arm: { experimentId: string; variantId: string },
  openedAt: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!exp || exp.experimentId !== arm.experimentId || exp.status === 'deleted') return false;
  if (!exp.variants.some((v) => v.variantId === arm.variantId)) return false;
  return enrollmentHolds(exp, classification, openedAt, now);
}

/**
 * THE VERSION A TASK'S TURN IS SERVED, from the arm the task was opened under (decision J), or null when that arm is no
 * longer served (`taskArmServes`) and the turn takes the live version. Read through the per-container experiment cache,
 * so an experiment that stops reaches a task within the minute it reaches a conversation.
 */
export async function resolveTaskArm(
  arm: { experimentId: string; variantId: string },
  openedAt: string | undefined,
  classification: Classification,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): Promise<ExperimentResolution | null> {
  let exp: Experiment | null;
  try {
    exp = await readPinnedExperiment(arm.experimentId);
  } catch (error) {
    console.warn("[ExperimentManager] the task's experiment is unreadable; the task takes the live version this turn", {
      experimentId: arm.experimentId, err: (error as Error)?.message,
    });
    return null;
  }
  if (!taskArmServes(exp, classification, arm, openedAt)) return null;
  const variant = exp!.variants.find((v) => v.variantId === arm.variantId)!;
  const pin = await pinFor(exp!, variant);
  return pin ? resolveEnrolledVariant({ ...pin, ...(openedAt ? { enrolledAt: openedAt } : {}) }, classification, channelArn, catalog) : null;
}

/**
 * Whether an `intent` experiment on `experimentIntent` covers a turn classified `turnIntent`: the same intent, or
 * the `general` route's experiment for an intent that answers through `general` (ADR-064 decision A), so it
 * covers the turns that route serves. A version that routes such an intent on its own still counts it here: the
 * experiment's arms differ only on the route it names.
 */
export function experimentIntentMatches(experimentIntent: string, turnIntent: string | undefined): boolean {
  if (!turnIntent) return false;
  return experimentIntent === turnIntent || (experimentIntent === GENERAL_ROUTE_KEY && answersThroughGeneral(turnIntent));
}

export function countsTowardExperiment(
  served: Pick<ExperimentResolution, 'experimentType' | 'intent'>,
  turnIntent: string,
  classifierRan: boolean,
  /** The type of the task the turn is bound to: a task's turns count by its type, whatever each message was (ADR-064 decision 6). */
  taskType?: string,
): boolean {
  switch (served.experimentType) {
    case 'intent':
      return !!served.intent && (experimentIntentMatches(served.intent, turnIntent) || (!!taskType && served.intent === taskType));
    case 'classification':
      return classifierRan;
    case 'base_model':
      return turnIntent !== 'greeting' && turnIntent !== 'acknowledgment';
    default:
      return true;
  }
}

/**
 * WHAT AN ENROLLED CONVERSATION IS SERVED, resolved before the turn is classified (§3.5). The router reads
 * it first so the version's classifier, intent pack and workflow selection decide the turn, exactly as a
 * duel side's version does. Null when the pin no longer resolves.
 */
export async function resolveEnrollment(
  enrollment: ConversationEnrollment,
  classification: Classification,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
): Promise<ExperimentResolution | null> {
  return resolveEnrolledVariant(enrollment, classification, channelArn, catalog);
}

/** The one experiment, read past the cache. Consistent, because a status change must be seen at once. */
async function readExperimentFresh(experimentId: string): Promise<Experiment | null> {
  if (!EXPERIMENTS_TABLE) return null;
  const res = await ddb.send(new GetCommand({
    TableName: EXPERIMENTS_TABLE,
    Key: { experimentId },
    ConsistentRead: true,
  }));
  return (res.Item as Experiment | undefined) ?? null;
}

/**
 * PICK AN EXPERIMENT FROM THE CACHE, BUT NEVER ONE THAT HAS ENDED.
 *
 * The cache is per container and the write happens in another Lambda, so nothing can clear it at the
 * moment an operator ends a test. Measured live 2026-10-05: an experiment completed before its
 * successor was created kept receiving turns for 25 s, and the successor received none - with one
 * live experiment per classification, every handover lost its first minute to the test that was closed.
 *
 * So the cache is checked where it is USED, which is the only point the turn can afford a read:
 *  - a turn about to be assigned re-reads THAT experiment (one consistent GetItem). If it is no longer
 *    live, the cache reloads and the pick runs again - which is how the successor is found;
 *  - a turn that finds NOTHING live reloads once when the cache is older than NOTHING_LIVE_RECHECK_MS,
 *    so a newly started experiment begins taking traffic within seconds rather than a minute.
 *
 * A FAILED CHECK KEEPS THE CACHED PICK. The read is a freshness check on an answer the cache already
 * gave, so an unreadable table leaves the turn exactly where the cache put it rather than dropping
 * experiment attribution for every turn while the table is unavailable.
 */
async function pickFresh(
  pick: (experiments: Experiment[]) => Experiment | undefined,
  classification: Classification,
): Promise<Experiment | undefined> {
  const cached = pick(await loadExperiments());
  if (!cached) {
    const age = experimentCache ? Date.now() - experimentCache.loadedAt : Infinity;
    return age > NOTHING_LIVE_RECHECK_MS ? pick(await loadExperiments(true)) : undefined;
  }
  let current: Experiment | null;
  try {
    current = await readExperimentFresh(cached.experimentId);
  } catch (error) {
    console.warn('[ExperimentManager] freshness check failed; keeping the cached experiment', {
      experimentId: cached.experimentId, err: (error as Error)?.message,
    });
    return cached;
  }
  if (current && isLiveForClassification(current, classification)) return cached;
  console.log('[ExperimentManager] cached experiment is no longer live; reloading', {
    experimentId: cached.experimentId, status: current?.status ?? 'deleted',
  });
  return pick(await loadExperiments(true));
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
 * Whether an experiment is live for a classification right now (DESIGN §3.2 L5).
 * Requires `active` status (so draft/paused/completed/deleted never resolve traffic),
 * the classification in scope, and — new in L5 — the window honored on BOTH ends:
 * `startDate ≤ now` (an experiment isn't live before it starts) and, as before,
 * `endDate > now` (expired experiments stop resolving). Absent `startDate` ⇒ live
 * immediately (INV-2). Pure; exported so the resolver, sweeper, and admin read share it.
 */
export function isLiveForClassification(
  exp: Experiment,
  classification: Classification,
  now: Date = new Date(),
): boolean {
  return (
    exp.status === 'active' &&
    exp.tiers.includes(classification) &&
    (!exp.startDate || new Date(exp.startDate) <= now) &&
    (!exp.endDate || new Date(exp.endDate) > now)
  );
}

/**
 * Find an active experiment matching this classification + intent, assign a variant,
 * and return the model to use. Returns null if no experiment applies.
 */
export async function resolveExperimentModel(
  classification: Classification,
  intent: string,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  enrollment?: ConversationEnrollment | null,
): Promise<ExperimentResolution | null> {
  // AN ENROLLED CONVERSATION SERVES ITS PIN FIRST (ADR-050), ahead of anything armed since, because a
  // conversation's profile does not change under the person in it.
  if (enrollment) {
    const pinned = await resolveEnrolledVariant(enrollment, classification, channelArn, catalog);
    if (pinned) return pinned;
  }
  const now = new Date();
  // A conversation-scoped experiment reaches a turn only through the pin above, never by being live.
  const isLive = (exp: Experiment): boolean =>
    isLiveForClassification(exp, classification, now) && !isConversationScoped(exp);

  // Resolution order: an intent-specific experiment wins over a base-model
  // experiment when both apply. A base-model experiment swaps the classification default
  // for ANY intent (no intent match). Absent type ⇒ 'intent', so existing
  // behavior is unchanged when no
  // base-model experiments exist. Classification experiments resolve separately
  // (resolveClassificationExperiment) and never match here.
  //
  // The write path admits one live experiment per classification (findClassificationConflicts), so
  // this order only decides between rows that predate that rule.
  //
  // AN INTENT EXPERIMENT MATCHES THE ROUTE THE TURN IS SERVED ON: the turn's own intent, or `general` for an
  // intent that answers through it (ADR-064 decision A). Routes are keyed by intent, so there is one vocabulary.
  const experiment = await pickFresh((experiments) =>
    experiments.find(
      (exp) =>
        (exp.experimentType ?? 'intent') === 'intent' &&
        typeof exp.intent === 'string' && experimentIntentMatches(exp.intent, intent) &&
        isLive(exp),
    ) ??
    experiments.find(
      (exp) =>
        (exp.experimentType === 'base_model' || exp.experimentType === 'profile') &&
        isLive(exp),
    ), classification);

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
  const now = new Date();
  const experiment = await pickFresh((experiments) => experiments.find(
    (exp) =>
      exp.experimentType === 'classification' &&
      // An experiment that serves versions classifies with its version's classifier, reached through the
      // conversation's enrollment; only a row armed before then swaps the classifier per turn here.
      !isConversationScoped(exp) &&
      isLiveForClassification(exp, classification, now),
  ), classification);
  if (!experiment) return null;
  return resolveVariantForProfile(experiment, classification, channelArn, catalog);
}

/**
 * Shared tail for experiment resolution: deterministically assign a variant,
 * look up its catalog model, enforce classification safety, and return the invoke id.
 * Returns null on an unknown model key or a classification-disallowed model.
 */
/**
 * The model a variant runs: its `modelKey`, or — for a profileRef variant (SPEC-PORTABLE-PROFILES FR11) — the referenced profile
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

/**
 * A variant's DEFINITION: the whole profile version for a `profileRef` variant, or null for a
 * lightweight `modelKey` variant (which has no version behind it, by design — the two are mutually
 * exclusive and validated as such).
 *
 * Resolves in ONE read, unlike calling `effectiveModelKeyOf` and then re-reading for the rest, so a
 * variant can never be served a model from one version and a tool set from another.
 */
async function variantDefinitionOf(variant: ExperimentVariant): Promise<ProfileDefinition | null> {
  if (!variant.profileRef) return null;
  const def = await lookupProfileVersion(ssmClient, SSM_ROOT, variant.profileRef);
  if (!def) {
    console.warn(`[ExperimentManager] profileRef ${variant.profileRef.profileName}@${variant.profileRef.version ?? 'active'} unresolved`);
    return null;
  }
  return def;
}

async function resolveVariantForProfile(
  experiment: Experiment,
  classification: Classification,
  channelArn: string,
  catalog: Record<BackendModelKey, BackendModelDefinition>,
  fixedVariant?: ExperimentVariant,
): Promise<ExperimentResolution | null> {
  const variant = fixedVariant ?? assignVariant(experiment.experimentId, channelArn, experiment.variants);

  // A VERSION IS SERVED WHOLE (SPEC-PORTABLE-PROFILES FR11): model routes, persona, tools, guardrail
  // selection, workflows and context sources, not just a model. Read once, so the served model and the
  // served tool set can never come from different versions. A pinned version reaches this only through a
  // conversation's enrollment (`pinFor`), which hands it over as `profileRef`; no version is chosen per
  // turn here. Fail-safe: an unresolvable variant skips the experiment (deterministic default holds).
  const variantProfile = await variantDefinitionOf(variant);
  if (variant.profileRef && !variantProfile) return null; // already logged by variantDefinitionOf
  // A VERSION'S BASE MODEL, for attribution and the routing record only: the turn answers through the
  // version's own routes. The `'default'` sentinel tracks the classification default.
  const effectiveModelKey = (variantProfile
    ? (concreteKey(variantProfile.models?.default) ?? concreteKey(variantProfile.modelKey) ?? profiles.defaultModelOf(classification))
    : variant.modelKey) as BackendModelKey | undefined;
  if (!effectiveModelKey) {
    console.error('[ExperimentManager] variant has neither modelKey nor a resolvable profileRef; skipping');
    return null;
  }

  const model = catalog[effectiveModelKey];
  if (!model) {
    console.error(`[ExperimentManager] Unknown model key in experiment: ${effectiveModelKey}`);
    return null;
  }

  // THE CLASSIFICATION'S SELECTION STILL BINDS: a version uses only what the channel's classification selects.
  if (!profiles.selectsModel(classification, effectiveModelKey)) {
    console.warn(`[ExperimentManager] Model ${effectiveModelKey} is not selected by classification ${classification}, skipping experiment`);
    return null;
  }

  return {
    experimentId: experiment.experimentId,
    variantId: variant.variantId,
    experimentType: experiment.experimentType ?? 'intent',
    ...(experiment.experimentType !== 'profile' && experiment.intent ? { intent: experiment.intent } : {}),
    modelKey: effectiveModelKey,
    bedrockModelId: bedrockInvokeId(model),
    // A variant with no version behind it (a row armed before versions were pinned) carries its image model
    // per turn, only when it is an image model this classification allows (`modelFits`). A served version's
    // own `models.image` reaches the turn with the version itself (`variantProfile`).
    ...(!variantProfile && variant.imageGenModelKey && modelFits(variant.imageGenModelKey, classification, 'image') === null
      ? { imageGenModelKey: variant.imageGenModelKey }
      : {}),
    // SPEC-PORTABLE-PROFILES FR11: the whole definition rides the resolution, plus the version's attribution key.
    ...(variantProfile ? { variantProfile, configId: variantProfile.configId } : {}),
    ...(variantProfile && pinnedVersionOf(variant.profileRef) !== undefined ? { variantVersion: pinnedVersionOf(variant.profileRef) } : {}),
  };
}

/** The concrete version a reference pins, or undefined for one that follows a label. */
function pinnedVersionOf(ref: { version?: unknown } | undefined): number | undefined {
  const v = ref?.version;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

// ============================================================
// CRUD Operations (for admin API)
// ============================================================

// `createExperiment` and `updateExperimentStatus` USED TO LIVE HERE, and are deleted.
//
// Neither had a caller anywhere in the repo. The live admin path (admin-experiments.ts) imports the
// guards from this file - validateAndSanitizeExperiment, isAllowedTransition, appendTransition,
// findClassificationConflicts - and issues its own Put/Get/Delete, so these two were a second way in
// that nothing used.
//
// They are removed rather than left dead because the names are a trap: the frontend service exports
// functions called exactly this (frontend/packages/shared/src/services/experimentService.ts), which
// ARE live, so a reader finds callers and concludes these are the same path. And the pair was weaker
// than the path it looked like: updateExperimentStatus wrote any status with no isAllowedTransition
// check at all, and createExperiment validated but skipped the conflict and active-count rules the
// admin handler applies.
//
// If a non-admin writer is ever needed, add it THROUGH those guards rather than beside them.

export async function listExperiments(): Promise<Experiment[]> {
  if (!EXPERIMENTS_TABLE) return [];

  const result = await ddb.send(new ScanCommand({
    TableName: EXPERIMENTS_TABLE,
  }));

  return (result.Items || []) as Experiment[];
}

/**
 * How long a container may answer "which experiments are live" from what it already read.
 *
 * THE SAME 60 s `lib/battle-state.ts` gives the channel battle config, and deliberately the same
 * number rather than a second one that happens to be similar (tenet D9). The only caller pairs the two
 * reads in one decision - is this channel's BOUND experiment still active - so a shorter window here
 * would buy freshness the other half of the pair does not have, and a longer one would make the pair
 * disagree about how stale it is willing to be.
 */
const EXPERIMENTS_CACHE_TTL_MS = 60_000;
let experimentsCache: { experiments: Experiment[]; expires: number } | null = null;

/**
 * Every experiment, from a per-container memo refreshed at most once a minute.
 *
 * WHY THIS EXISTS. `listExperiments` is an unfiltered DynamoDB `Scan`, and the channel flow ran one on
 * every `/battle` inside a gate chain that is otherwise ordered cheapest-first: a cached `GetItem` came
 * before it and a `Query` after it. A duel is the most expensive dispatch in the system, so a scan is
 * not what makes it expensive - but it is the one read in that chain whose cost grows with the
 * deployment's history rather than with the duel, and it was answering a question whose other half was
 * already being read from a 60 s cache.
 *
 * WHAT ONE MINUTE OF STALENESS CAN COST, stated rather than assumed, because the rule this feeds is
 * "ending an experiment stops the duels". For up to a minute after an operator ends one, a channel
 * bound to it can still start a duel. That window already existed and is not widened here: the bound
 * id comes from `loadChannelBattleConfig`, cached for the same 60 s, so the decision could never have
 * been fresher than a minute on both halves at once. A duel that starts inside the window records its
 * outcome against the ended experiment, which is the defect `battleIsRunnable` exists for - bounded to
 * one minute, per container, rather than forever.
 *
 * NOT FOR A WRITER. Anything that must read its own write (the admin API issues its own Get after a
 * Put) calls `listExperiments` directly. This is the read for a gate, and a gate is exactly the caller
 * that can afford to be a minute behind.
 *
 * A FAILED SCAN CACHES NOTHING and throws to the caller, unchanged: an empty list is not the same
 * answer as an unreadable table, and pinning one for a minute would let a transient outage read as
 * "no experiment is active" for every duel in that window.
 */
export async function listExperimentsCached(): Promise<Experiment[]> {
  if (experimentsCache && experimentsCache.expires > Date.now()) return experimentsCache.experiments;
  const experiments = await listExperiments();
  experimentsCache = { experiments, expires: Date.now() + EXPERIMENTS_CACHE_TTL_MS };
  return experiments;
}

/** Drop the memo. For a test, and for a writer that needs the next read to see its own write. */
export function invalidateExperimentsCache(): void {
  experimentsCache = null;
}

// ============================================================
// Battle support (SPEC-BATTLE.md)
// ============================================================

/**
 * Maximum length for systemPromptAddendum after whitespace normalization.
 * Spec: "Length cap: maximum 500 characters after whitespace normalization."
 */
export const MAX_PROMPT_ADDENDUM_LENGTH = 500;

/** Maximum length for objective.statement and ExperimentDecision.note (DESIGN §1.2 / §3.2.1). */
export const MAX_OBJECTIVE_STATEMENT_LENGTH = 500;

/** Maximum number of pre-registered guardrails on an objective (DESIGN §1.2). */
export const MAX_GUARDRAILS = 3;

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
 * Sanitize free-prose objective/decision text (DESIGN §1.2 / §3.2.1): strip ASCII
 * control chars, collapse whitespace, trim, and length-cap at
 * MAX_OBJECTIVE_STATEMENT_LENGTH. Returns undefined for absent/blank input so the
 * field simply stays absent (INV-2). Exported so the status handler can reuse it for
 * ExperimentDecision.note (same 500-cap prose rule) instead of duplicating the logic.
 */
export function sanitizeObjectiveStatement(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ExperimentValidationError('statement must be a string', 'STATEMENT_TYPE');
  }
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > MAX_OBJECTIVE_STATEMENT_LENGTH) {
    throw new ExperimentValidationError(
      `statement exceeds ${MAX_OBJECTIVE_STATEMENT_LENGTH} chars (got ${normalized.length})`,
      'STATEMENT_TOO_LONG',
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
 *   - the challenger must be this classification's alt (`challengerAssistant`, `alt-{role}-{classification}`).
 *   - boundBy must be set so we can attribute the binding.
 *
 * Returns a new Experiment with sanitized addendum fields.
 */
export function validateAndSanitizeExperiment(
  input: Experiment,
  /**
   * The deployment's model-catalog keys. When supplied, a variant's `modelKey` must be one of them.
   *
   * OPTIONAL so the ~40 existing call sites that test unrelated rules keep working, and so a caller with
   * no catalog to hand degrades to the previous behavior rather than being unable to validate anything.
   * The WRITE path supplies it (`createExperiment`, and the admin update handler), which is where an
   * unknown key would otherwise be persisted.
   */
  validModelKeys?: ReadonlySet<string>,
): Experiment {
  // A RETIRED ROUTE KEY is refused, naming the intent that keys the route now (ADR-064 decision 1).
  const retired = typeof input.intent === 'string' ? retiredRouteKeyError(input.intent, 'intent') : null;
  if (retired) throw new ExperimentValidationError(retired, 'INTENT_RETIRED_ROUTE_KEY');
  const targetWhy = experimentTargetError((input as { target?: unknown }).target, input.experimentType);
  if (targetWhy) throw new ExperimentValidationError(targetWhy, 'TARGET_INVALID');
  // AN IMAGE TARGET'S VARIANTS NAME IMAGE MODELS IN `modelKey`, so the image model is varied one way (tenet D9).
  const imageTarget = input.target?.kind === 'image';
  // A VARIANT CARRIES NO NAME: a duel side is named from its profile
  // (`battleSideNames`). A request that still sends a variant `displayName` (an older console or e2e
  // helper) is accepted and the field is DROPPED here, never stored, so nothing persists a name that
  // would then be ignored.
  const variants = input.variants.map((raw) => {
    const { displayName: _dropped, ...v } = raw as ExperimentVariant & { displayName?: unknown };
    return { ...v, systemPromptAddendum: sanitizePromptAddendum(v.systemPromptAddendum) };
  });

  // Each variant runs EITHER a bare model OR an entire profile version (SPEC-PORTABLE-PROFILES
  // FR11) — exactly one of modelKey / profileRef, never both, never neither. A bare modelKey is a catalog
  // key ('haiku'/'sonnet'); a profileRef {profileName, version?} runs that version's definition. Reject a
  // mis-specified variant at create time (400) instead of producing a mystery 0-row result.
  variants.forEach((v, i) => {
    const hasModel = typeof v.modelKey === 'string' && v.modelKey.trim().length > 0;
    const hasRef = !!v.profileRef && typeof v.profileRef.profileName === 'string' && v.profileRef.profileName.trim().length > 0;
    // THE CONTROL OF A MODEL EXPERIMENT IS THE LIVE ACTIVE VERSION (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP
    // §3.5), so it may leave its model unnamed; one it names must be the live one, which arming checks.
    const controlIsLive = i === 0 && (input.experimentType ?? 'intent') !== 'profile' && !hasModel && !hasRef;
    if (hasModel === hasRef && !controlIsLive) {
      throw new ExperimentValidationError(
        `variant index ${i} requires EXACTLY ONE of modelKey (a catalog key like 'haiku'/'sonnet') or profileRef {profileName, version?} — not both, not neither`,
        'VARIANT_MODEL_KEY_REQUIRED',
      );
    }
    // THE KEY MUST BE IN THE CATALOG (maintainer, 2026-08-10).
    //
    // Presence was checked and membership was not, and the failure is silent in the worst possible way.
    // At resolution `catalog[modelKey]` returns undefined for an unknown key, so no variant model is
    // resolved and the turn falls back to the profile's default - which means BOTH ARMS RUN THE SAME
    // MODEL and the experiment reports `indistinguishable`. A typo produces a clean, confident,
    // meaningless verdict, and the console shows nothing wrong because nothing errored.
    //
    // Same rule the profile write path already applies to `modelKey` (`validateBody` against the model
    // catalog): confirm at the selection point, reject with a 400, never discover it as a mystery result.
    //
    // The KEY is what is stored, not a resolved Bedrock id - a version and a variant must both stay
    // instance-agnostic (SPEC-PORTABLE §5), and the id is resolved per-deployment at runtime.
    if (hasModel && !imageTarget && validModelKeys && !validModelKeys.has(v.modelKey!.trim())) {
      const offered = [...validModelKeys].sort().map((k) => `'${k}'`).join(', ');
      throw new ExperimentValidationError(
        `variant index ${i} modelKey '${v.modelKey}' is not in this deployment's model catalog; one of: ${offered}`,
        'VARIANT_MODEL_KEY_UNKNOWN',
      );
    }
    // EVERY MODEL A VARIANT NAMES IS ONE EACH OF ITS CLASSIFICATIONS ALLOWS, FIT FOR ITS USE (`modelFits`):
    // the `modelKey` is a text model (the base model, or the classifier on a `classification` experiment)
    // and the `imageGenModelKey` an image model. Refused here rather than skipped at resolution, where a
    // disallowed variant silently ran both arms on the same model and reported "no difference".
    const variantTiers = Array.isArray(input.tiers) ? (input.tiers as string[]) : [];
    for (const tier of variantTiers) {
      const textWhy = hasModel ? modelFits(v.modelKey!.trim(), tier, imageTarget ? 'image' : 'text') : null;
      if (textWhy && (!validModelKeys || validModelKeys.has(v.modelKey!.trim()))) {
        throw new ExperimentValidationError(`variant index ${i} modelKey ${textWhy}`, 'VARIANT_MODEL_NOT_ALLOWED');
      }
      const imageWhy = v.imageGenModelKey ? modelFits(v.imageGenModelKey, tier, 'image') : null;
      if (imageWhy) {
        throw new ExperimentValidationError(`variant index ${i} imageGenModelKey ${imageWhy}`, 'VARIANT_IMAGE_MODEL_NOT_ALLOWED');
      }
    }
    if (hasRef && v.profileRef!.version !== undefined && (!Number.isInteger(v.profileRef!.version) || v.profileRef!.version < 1)) {
      throw new ExperimentValidationError(`variant index ${i} profileRef.version must be a positive integer (omit for the active version)`, 'VARIANT_PROFILE_REF_VERSION');
    }
    // A VARIANT SERVES A VERSION OF AN ASSISTANT OF THE EXPERIMENT'S OWN CLASSIFICATION (ADR-042). A
    // version selects that classification's guardrails, tools and context sources, so a premium turn
    // served another classification's version was refused its guardrail by IAM and fell back to the
    // default, quietly comparing something other than what was armed (measured live 2026-10-13). IAM is the
    // second layer; this is the first. A name the registry does not place (a runtime assistant) is left
    // to that second layer rather than guessed at.
    if (hasRef) {
      const served = profiles.classificationOfAssistant(v.profileRef!.profileName);
      const tiers = Array.isArray(input.tiers) ? (input.tiers as string[]) : [];
      if (served && tiers.length && !tiers.every((t) => t === served)) {
        throw new ExperimentValidationError(
          `variant index ${i} profileRef '${v.profileRef!.profileName}' is an assistant of ${served}; this experiment runs in ${tiers.join(', ')}`,
          'VARIANT_PROFILE_REF_CLASSIFICATION',
        );
      }
    }
    // THE ALT PIN BELONGS TO THE TREATMENT AND NOTHING ELSE (ADR-050), and names an alt and a concrete
    // version. Arming derives it; whether that version was derived for this experiment is checked there.
    if (v.altPin !== undefined) {
      const pin = v.altPin as { profileName?: unknown; version?: unknown };
      if (i !== 1) {
        throw new ExperimentValidationError(`variant index ${i} altPin is the treatment's (variants[1]) only`, 'VARIANT_ALT_PIN_PLACEMENT');
      }
      if (typeof pin.profileName !== 'string' || !pin.profileName.startsWith('alt-')
        || !Number.isInteger(pin.version) || (pin.version as number) < 1) {
        throw new ExperimentValidationError(`variant index ${i} altPin names an alt and a version (>=1)`, 'VARIANT_ALT_PIN_INVALID');
      }
    }
    // THE CONTROL PIN BELONGS TO THE CONTROL AND NOTHING ELSE, and names the live assistant (never an alt)
    // and a concrete version. Arming sets it to the live active version.
    if (v.controlPin !== undefined) {
      const pin = v.controlPin as { profileName?: unknown; version?: unknown };
      if (i !== 0) {
        throw new ExperimentValidationError(`variant index ${i} controlPin is the control's (variants[0]) only`, 'VARIANT_CONTROL_PIN_PLACEMENT');
      }
      if (typeof pin.profileName !== 'string' || !pin.profileName || pin.profileName.startsWith('alt-')
        || !Number.isInteger(pin.version) || (pin.version as number) < 1) {
        throw new ExperimentValidationError(`variant index ${i} controlPin names the live assistant and a version (>=1)`, 'VARIANT_CONTROL_PIN_INVALID');
      }
    }
  });

  // L4 (DESIGN §3.2): weights must be non-negative integers summing to 100.
  // Without this an assignVariant mis-split is silent (the cumulative-weight
  // walk falls through to the last variant). Rejected at write time (400).
  let weightSum = 0;
  variants.forEach((v, i) => {
    if (typeof v.weight !== 'number' || !Number.isFinite(v.weight) || !Number.isInteger(v.weight) || v.weight < 0) {
      throw new ExperimentValidationError(
        `variant index ${i} weight must be a non-negative integer (got ${v.weight})`,
        'VARIANT_WEIGHT_INVALID',
      );
    }
    weightSum += v.weight;
  });
  if (weightSum !== 100) {
    throw new ExperimentValidationError(
      `variant weights must sum to 100 (got ${weightSum})`,
      'VARIANT_WEIGHT_SUM',
    );
  }

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
  // A REFERENCED PROFILE IS NEVER AN INTENT EXPERIMENT'S VARIANT (ADR-050, as amended). An intent experiment
  // DOES serve a whole version to every turn of an enrolled conversation: its candidate, which differs from
  // the live version in one route only (`models.byIntent[<intent>].primary`), so no person sees the
  // assistant change and the turns of other intents answer exactly as the control's. A referenced version
  // may differ in anything, which is a `profile` experiment, not an intent one.
  if (experimentType === 'intent' && (input.variants || []).some((v) => v?.profileRef)) {
    throw new ExperimentValidationError(
      'an intent experiment cannot run a profileRef variant: its candidate differs from the live version in one route; comparing whole versions is a profile experiment',
      'PROFILE_REF_ON_INTENT_EXPERIMENT',
    );
  }

  // L5: startDate/endDate are load-bearing at resolve time (isLiveForClassification). A non-empty but
  // UNPARSEABLE date makes `new Date(x) <= now` a NaN compare (false), silently stranding the experiment -
  // stored `active`, resolves nothing, no error anywhere. Reject an unparseable date at write time (400).
  for (const [field, val] of [['startDate', input.startDate], ['endDate', input.endDate]] as const) {
    if (val !== undefined && val !== null && String(val).trim() !== '' && Number.isNaN(Date.parse(String(val)))) {
      throw new ExperimentValidationError(`${field} is not a valid date: "${val}"`, 'EXPERIMENT_DATE_INVALID');
    }
  }

  // Objective — advisory; validate shape only.
  const objective = validateObjective(input.objective, experimentType);

  if (input.battleEnabled) {
    // A battle runs head-to-head in ONE channel, so it must target exactly one classification — never a
    // mixed set (structural).
    //
    // CAPABILITY IS A GATE; POLICY IS NOT CHECKED HERE (ADR-049). This block used to say eligibility was
    // "a HINT, not a gate", on the reasoning that an operator-driven comparison may battle any
    // profile at any classification. That reasoning survives for the POLICY half, which is why nothing
    // here asks whether battle is switched on: an operator may arm a comparison before turning it on,
    // and the turn path reads the setting fresh. It does NOT survive for capability, which is a fact
    // about what the deployment built and cannot be changed by arming anything.
    // The classification boundary still binds — resolveVariantForProfile rejects a model not allowed for
    // the channel's classification (min-cap) — so this never escalates either way.
    // (Error code kept as BATTLE_TIER_PREMIUM_ONLY for the API/UI contract.)
    const tiers = input.tiers || [];
    if (tiers.length !== 1) {
      throw new ExperimentValidationError(
        `battleEnabled experiments must target exactly one classification (got [${tiers.join(', ')}])`,
        'BATTLE_TIER_PREMIUM_ONLY',
      );
    }
    // CAPABILITY IS A GATE, NOT A HINT (ADR-049). This logged and proceeded, on the reasoning that an
    // operator-driven comparison may battle any profile at any classification. That reasoning holds
    // for POLICY and not for capability: arming a battle on a classification whose deployment wires no
    // battle plumbing produces an experiment that can never run a duel, and the operator finds out
    // from a permissions error rather than from this refusal. Whether battle is turned ON is checked
    // on the turn path, where an operator can change the answer without re-arming.
    if (!profiles.isBattleCapable(tiers[0])) {
      throw new ExperimentValidationError(
        `battleEnabled experiments require a classification whose deployment wires battle; '${tiers[0]}' does not`,
        'BATTLE_TIER_PREMIUM_ONLY',
      );
    }
    if (variants.length !== 2) {
      throw new ExperimentValidationError(
        `battleEnabled experiments require exactly 2 variants (got ${variants.length})`,
        'BATTLE_VARIANT_COUNT',
      );
    }
    // THE CHALLENGER IS THIS CLASSIFICATION'S ALT, BY ID. One challenger per (classification, role) is the
    // assignment record's key, so the only id a battle in this classification may name is the one the
    // registry composes for it; any other is a typo or another classification's assistant.
    const challenger = challengerOf(input);
    if (!challenger) {
      throw new ExperimentValidationError(
        'battleEnabled experiments require challengerAssistant',
        'BATTLE_CHALLENGER_REQUIRED',
      );
    }
    const expected = profiles.altAssistantName(tiers[0], DUEL_ROLE);
    if (challenger !== expected) {
      throw new ExperimentValidationError(
        `the challenger of a ${tiers[0]} battle is ${expected ?? 'not declared'}, not ${challenger}`,
        'BATTLE_CHALLENGER_MISMATCH',
      );
    }
    if (!input.boundBy) {
      throw new ExperimentValidationError(
        'battleEnabled experiments require boundBy (ARN of the admin)',
        'BATTLE_BOUND_BY',
      );
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

  // THE ROW IS WRITTEN IN THE CURRENT SHAPE: the challenger by id, and none of the attributes the re-key
  // retires, so an edit of an old row migrates it.
  const challengerAssistant = input.battleEnabled ? challengerOf(input) : input.challengerAssistant;
  // `sideNames` is what the console's read derives from the profiles (`battleSidesOf`); a request that sends
  // it back is not naming anything, so it is dropped rather than stored.
  const { sideNames: _derived, ...stored } = input as Experiment & { sideNames?: unknown };
  return {
    ...withoutLegacyBinding(stored as Experiment & LegacyBattleBinding),
    ...(challengerAssistant && { challengerAssistant }),
    experimentType,
    objective,
    variants,
  };
}

/** Canonical experiment types. */
export const EXPERIMENT_TYPES: ExperimentType[] = ['intent', 'base_model', 'classification', 'profile'];

const OBJECTIVE_METRICS: ExperimentObjectiveMetric[] = ['cost', 'accuracy', 'quality', 'latency'];

// ============================================================
// Lifecycle: status enum + transition guard + audit append (DESIGN §3.2 / A.3)
// ============================================================

/** Canonical experiment statuses (DESIGN A.3). */
export const EXPERIMENT_STATUSES: Experiment['status'][] = ['draft', 'active', 'paused', 'completed', 'deleted'];

/**
 * Server-enforced legal lifecycle transitions (DESIGN §3.2 / A.3):
 *   draft   → active | deleted
 *   active  → paused | completed | deleted
 *   paused  → active | completed | deleted
 *   completed → deleted            (terminal except for a soft-delete tombstone)
 *   deleted → (none)               (terminal)
 * `completed` and `deleted` are terminal; a never-started draft is hard-deleted by the
 * handler (record removed) rather than transitioned, but draft→deleted is legal for the
 * soft path. Auto-expiry (endDate) is the same active|paused→completed edge, tagged in
 * the transition's `reason`.
 */
const ALLOWED_TRANSITIONS: Record<Experiment['status'], readonly Experiment['status'][]> = {
  draft: ['active', 'deleted'],
  active: ['paused', 'completed', 'deleted'],
  paused: ['active', 'completed', 'deleted'],
  completed: ['deleted'],
  deleted: [],
};

/**
 * Whether a `from → to` status change is legal (DESIGN §3.2 / A.3). Pure; the admin
 * status handler calls it to reject an illegal transition (e.g. out of a terminal
 * `completed`/`deleted`) with a 409 before writing. A no-op `from === to` is not a
 * transition and returns false.
 */
export function isAllowedTransition(from: Experiment['status'], to: Experiment['status']): boolean {
  if (from === to) return false;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Append one entry to an experiment's append-only lifecycle audit (DESIGN §3.2 L7).
 * Pure: returns a NEW array (never mutates the input), so callers can persist it
 * directly. `at` defaults to now (ISO). `from` may be the pseudo-state 'create' for
 * the record's first entry.
 */
export function appendTransition(
  existing: ExperimentTransition[] | undefined,
  entry: {
    from: ExperimentTransition['from'];
    to: Experiment['status'];
    by: string;
    at?: string;
    reason?: string;
  },
): ExperimentTransition[] {
  const record: ExperimentTransition = {
    from: entry.from,
    to: entry.to,
    by: entry.by,
    at: entry.at ?? new Date().toISOString(),
    ...(entry.reason !== undefined && { reason: entry.reason }),
  };
  return [...(existing ?? []), record];
}

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

  // --- new, all optional (absent ⇒ today's behavior — INV-2) ---
  // statement: sanitized prose (DESIGN §1.2). API only warns on absence (it does not 400),
  // so programmatic/legacy callers are unaffected; the create FORM makes it required.
  const statement = sanitizeObjectiveStatement(objective.statement);

  // guardrails: veto conditions, each a known metric with a bound in [0, 100]; at most MAX_GUARDRAILS.
  let guardrails: ObjectiveGuardrail[] | undefined;
  if (objective.guardrails !== undefined && objective.guardrails !== null) {
    if (!Array.isArray(objective.guardrails)) {
      throw new ExperimentValidationError('objective.guardrails must be an array', 'OBJECTIVE_GUARDRAILS_TYPE');
    }
    if (objective.guardrails.length > MAX_GUARDRAILS) {
      throw new ExperimentValidationError(
        `objective.guardrails allows at most ${MAX_GUARDRAILS} (got ${objective.guardrails.length})`,
        'OBJECTIVE_GUARDRAILS_TOO_MANY',
      );
    }
    const validated = objective.guardrails.map((g, i) => validateGuardrail(g, i));
    guardrails = validated.length > 0 ? validated : undefined;
  }

  // humanPickWeight: 0..1 (DESIGN §4.3). Absent ⇒ 0 ⇒ today's behavior; never materialized to 0.
  let humanPickWeight: number | undefined;
  if (objective.humanPickWeight !== undefined && objective.humanPickWeight !== null) {
    if (typeof objective.humanPickWeight !== 'number' || !Number.isFinite(objective.humanPickWeight)
        || objective.humanPickWeight < 0 || objective.humanPickWeight > 1) {
      throw new ExperimentValidationError(
        `objective.humanPickWeight must be a number in [0, 1] (got ${objective.humanPickWeight})`,
        'OBJECTIVE_HUMAN_PICK_WEIGHT_RANGE',
      );
    }
    humanPickWeight = objective.humanPickWeight;
  }

  return {
    metric: objective.metric,
    target: objective.target,
    ...(statement !== undefined && { statement }),
    ...(guardrails !== undefined && { guardrails }),
    ...(humanPickWeight !== undefined && { humanPickWeight }),
  };
}

/**
 * Validate one ObjectiveGuardrail (DESIGN §1.2): known metric, a valid direction,
 * and a bound in [0, 100]. Returns a clean copy (drops any extra fields). Throws on
 * any malformed guardrail so the admin API can surface a 400.
 */
function validateGuardrail(g: ObjectiveGuardrail | undefined, index: number): ObjectiveGuardrail {
  if (!g || typeof g !== 'object') {
    throw new ExperimentValidationError(`objective.guardrails[${index}] must be an object`, 'GUARDRAIL_TYPE');
  }
  if (!OBJECTIVE_METRICS.includes(g.metric)) {
    throw new ExperimentValidationError(
      `objective.guardrails[${index}].metric must be one of ${OBJECTIVE_METRICS.join(', ')} (got "${g.metric}")`,
      'GUARDRAIL_METRIC_INVALID',
    );
  }
  if (g.direction !== 'no_worse_than' && g.direction !== 'at_least') {
    throw new ExperimentValidationError(
      `objective.guardrails[${index}].direction must be 'no_worse_than' or 'at_least' (got "${g.direction}")`,
      'GUARDRAIL_DIRECTION_INVALID',
    );
  }
  if (typeof g.bound !== 'number' || !Number.isFinite(g.bound) || g.bound < 0 || g.bound > 100) {
    throw new ExperimentValidationError(
      `objective.guardrails[${index}].bound must be a percentage in [0, 100] (got ${g.bound})`,
      'GUARDRAIL_BOUND_RANGE',
    );
  }
  return { metric: g.metric, direction: g.direction, bound: g.bound };
}

/**
 * One live experiment per classification (DESIGN §3.2.1): returns the live experiments that
 * share any classification with the candidate, whatever either one's type (empty ⇒ no conflict).
 * DB-backed (mirrors findChallengerConflicts); the admin write path calls it and converts a
 * non-empty result to 409.
 *
 * Type does not matter because the resolver can only measure one. `resolveExperimentModel` takes
 * the first live match from a table scan, so a second live experiment on the classification was
 * accepted and then received no traffic at all, and which of the two won was scan order. That was
 * measured live: three base_model experiments created beside a stale one each
 * collected zero result rows. A classification experiment was already exclusive for its own
 * reason (changing the classifier shifts routing for every intent); this widens that to every type.
 */
export async function findClassificationConflicts(args: {
  tiers: Classification[];
  excludeExperimentId?: string;
}): Promise<Experiment[]> {
  const tiers = new Set(args.tiers || []);
  // Fresh read (bypass the 60s cache): this is the write-path conflict gate, so a blocker
  // created seconds ago must be seen or two conflicting experiments both activate.
  const experiments = await loadExperiments(true);
  const now = new Date();
  return experiments.filter((e) => {
    // An expired or not-yet-started experiment resolves NO traffic (isLiveForClassification), so it no
    // longer occupies the classification and must not block a replacement. Match the resolver's liveness
    // window (active + startDate<=now<endDate), not just the raw `active` status, or a dead experiment
    // holds the classification until an operator manually ends it.
    if (e.status !== 'active') return false;
    if (e.startDate && new Date(e.startDate) > now) return false;
    if (e.endDate && new Date(e.endDate) <= now) return false;
    if (e.experimentId === args.excludeExperimentId) return false;
    return (e.tiers || []).some((t) => tiers.has(t));
  });
}

/**
 * ONE SIDE OF A DUEL, AS ITS PINNED VERSION (DESIGN-SEPARATE-ASSISTANTS §3.7, ADR-050).
 *
 * Both sides of a battle are pinned when the experiment is armed (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP
 * §3.5): the control is the live assistant's active version (`controlPin`), served from the live identity,
 * and the treatment the candidate in the alt's history (`altPin`), served from the alt identity. A side's
 * turn serves that one version, its routes included, like any assistant serves its version.
 *
 * `modelKey` and `imageGenModelKey` are read from the version: projections the router records so the vend
 * narrows the side's session to what the version serves. `displayName` is the side's name as its profile
 * gives it (`battleSideNames`): it names the side in the room, its placeholder, the rival's prompt and the
 * scorecard.
 */
export interface BattleSide {
  experimentId: string;
  variantId: string;
  /** The version's base model (`models.default`, else `modelKey`). */
  modelKey: BackendModelKey;
  /**
   * THE SIDE'S NAME IS ITS PROFILE'S, never an alias on the experiment row: the pinned
   * version's `displayName`, else its assistant's configured one. A runtime rename of the version reaches
   * the duel. The challenger's version is usually a copy of the live one, so when the two names match the
   * challenger's carries the `battleAltName` marker, and the scorecard's columns differ.
   */
  displayName?: string;
  /** The primary of the version's image route for the experiment's image intent (`imageRouteKeyOf`), when it names one. */
  imageGenModelKey?: ImageGenModelKey;
  longFormMode?: 'one-shot' | 'outline-first';
  /** The pinned version this side serves. */
  variantProfile: ProfileDefinition;
  /** Its number, from the side's pin, so the side's turns are attributed to it (`ExperimentResolution.variantVersion`). */
  variantVersion?: number;
}

/** Which pin a side reads: the control's (`variants[0].controlPin`) or the treatment's (`variants[1].altPin`). */
type DuelSideName = 'control' | 'treatment';

/**
 * Whether `e` is the LIVE battle whose challenger is `challengerAssistant`: battle-enabled, `active`, and
 * inside its window. An end date that has passed ends the experiment as surely as a status change,
 * so a duel never serves a side of an experiment that has ended or paused.
 */
function isLiveBattleOf(e: Experiment, challengerAssistant: string, now = new Date()): boolean {
  return e.status === 'active' && e.battleEnabled === true && challengerOf(e) === challengerAssistant
    && (!e.startDate || new Date(e.startDate) <= now)
    && (!e.endDate || new Date(e.endDate) > now);
}

/**
 * The battle experiment whose challenger is `challengerAssistant` (`alt-{role}-{classification}`), READ
 * ONCE AND FRESH. Null when no live battle names the challenger.
 *
 * BY ID WHEN THE CALLER KNOWS IT: the channel's battle config binds the experiment at enable, so a duel turn
 * reads that one row with a consistent GetItem rather than scanning the table. Without an id (a config
 * written before the binding, or a caller with no conversation) it reads one scan of the active rows.
 * Never the 60s cache: this decides WHAT THE DUEL IS, and a read that still saw an experiment the operator
 * had just replaced on the same alt would duel the wrong one, with nothing in any log to say why.
 *
 * A BOUND ROW THAT IS NOT LIVE IS CONFIRMED BY THE SCAN before it ends a duel. The id comes from a config
 * the caller may hold cached, so a conversation re-bound to a new experiment a moment ago could still name
 * the old one; ending its duel on that would be a false answer. Refusals are rare, so the scan costs a
 * read only on that path, the same asymmetry `battleIsRunnableConfirmed` applies.
 */
async function battleChallengedBy(challengerAssistant: string, experimentId?: string): Promise<Experiment | null> {
  if (!challengerAssistant) return null;
  if (experimentId) {
    const exp = await readExperimentFresh(experimentId);
    if (exp && isLiveBattleOf(exp, challengerAssistant)) return exp;
  }
  const experiments = await loadExperiments(true);
  return experiments.find((e) => isLiveBattleOf(e, challengerAssistant)) ?? null;
}

/**
 * One side of the battle `exp` as its pinned version.
 *
 * NULL WHEN THE SIDE HAS NO PIN, OR ITS PIN DOES NOT RESOLVE, and the arm path refuses a battle without
 * both pins (`battleArmRefusal`), so this is reached only by a battle armed before the control was
 * pinned or by a version that has since become unreadable. The caller then serves the side's assistant
 * as it is, which the vend refuses for an alt with no pinned version.
 */
async function battleSideOf(exp: Experiment, side: DuelSideName): Promise<BattleSide | null> {
  // variants[0] = control (the live assistant); variants[1] = treatment (the alt).
  const variant = exp.variants[side === 'control' ? 0 : 1];
  if (!variant) return null;
  const pin = side === 'control' ? variant.controlPin : variant.altPin;
  if (!pin) {
    console.warn('[ExperimentManager] battle side has no pinned version; re-arm the experiment to derive one', {
      experimentId: exp.experimentId, side, variantId: variant.variantId,
    });
    return null;
  }
  const version = await variantDefinitionOf({ ...variant, profileRef: pin });
  if (!version) return null; // already logged by variantDefinitionOf
  const modelKey = (concreteKey(version.models?.default) ?? concreteKey(version.modelKey)) as BackendModelKey | undefined;
  if (!modelKey) return null;
  // The primary of the image route the experiment's variant writes (`imageRouteKeyOf`), else the
  // `image_generation` route's, the legacy `models.image` included.
  const image = imagePrimaryForIntent(version.models, imageRouteKeyOf(exp)) as ImageGenModelKey | undefined;
  return {
    experimentId: exp.experimentId,
    variantId: variant.variantId,
    modelKey,
    // The version's own name, or its assistant's configured one; the challenger's is settled against the
    // control's in `battleSideNames`, because only both together say whether the two would read the same.
    ...(side === 'control'
      ? { displayName: profiles.displayNameFor(pin.profileName, version.displayName) }
      : version.displayName?.trim() ? { displayName: version.displayName.trim() } : {}),
    ...(image && image in IMAGE_GEN_MODELS ? { imageGenModelKey: image } : {}),
    longFormMode: exp.longFormMode,
    variantProfile: version,
    ...(pinnedVersionOf(pin) !== undefined ? { variantVersion: pinnedVersionOf(pin) } : {}),
  };
}

/** A model key, unless it is blank or the `'default'` sentinel a version uses to track the platform default. */
function concreteKey(key: string | undefined): string | undefined {
  return key && key !== 'default' ? key : undefined;
}

/**
 * BOTH SIDES OF A BATTLE, AND WHETHER IT IS STILL ACTIVE, FROM ONE READ OF ITS EXPERIMENT.
 *
 * `active` is false once the experiment is paused, completed, deleted or past its end date: an unjudged or
 * decided treatment must not keep answering in a duel, so a duel turn that reads it
 * false ends the duel. Each side is null when its pin is absent or does not resolve, and a side that fails
 * to resolve does not take the other with it. Throws only when the experiment itself cannot be read, which
 * the caller treats as "serve both sides as they are", never as an ended experiment.
 */
export interface BattleSides {
  active: boolean;
  control: BattleSide | null;
  treatment: BattleSide | null;
}

export async function resolveBattleSides(
  challengerAssistant: string,
  opts: { experimentId?: string } = {},
): Promise<BattleSides> {
  const exp = await battleChallengedBy(challengerAssistant, opts.experimentId);
  if (!exp) return { active: false, control: null, treatment: null };
  return { active: true, ...(await battleSidesOf(exp)) };
}

/**
 * BOTH SIDES OF THE BATTLE `exp`, FROM THE EXPERIMENT IN HAND, named as the duel names them
 * (`battleSideNames`). For a caller that already holds the row: enabling Battle Mode in a room, naming the
 * alt's identity when an experiment is armed (its start date may still be ahead), and the console's read of
 * an experiment. It neither re-reads the experiment nor asks whether it is live: the caller holds the row
 * and has answered that already. Each side is null when its pin is absent or does not resolve, and a side
 * that fails to resolve is logged and does not take the other with it.
 */
export async function battleSidesOf(exp: Experiment): Promise<{ control: BattleSide | null; treatment: BattleSide | null }> {
  const sideOf = (side: DuelSideName): Promise<BattleSide | null> => battleSideOf(exp, side).catch((err) => {
    console.warn('[ExperimentManager] a battle side did not resolve; it serves its assistant as it is', {
      experimentId: exp.experimentId, side, err: (err as Error)?.message,
    });
    return null;
  });
  const [control, treatment] = await Promise.all([sideOf('control'), sideOf('treatment')]);
  return battleSideNames(control, treatment);
}

/**
 * THE TWO SIDES' NAMES, SETTLED TOGETHER. The challenger takes its version's name, else the control's; when
 * the two read the same (case aside) the challenger's is marked with the `battle-alt-name` template,
 * so a person can tell which is the challenger without an alias. Exported for the tests.
 */
export function battleSideNames(
  control: BattleSide | null,
  treatment: BattleSide | null,
): { control: BattleSide | null; treatment: BattleSide | null } {
  if (!treatment) return { control, treatment };
  const controlName = control?.displayName?.trim();
  const own = treatment.displayName?.trim() || controlName;
  if (!own) return { control, treatment };
  const name = controlName && own.toLowerCase() === controlName.toLowerCase()
    ? noticeLine(undefined, 'battleAltName', { name: own })
    : own;
  return { control, treatment: { ...treatment, displayName: name } };
}

/**
 * The TREATMENT side (variants[1], the alt) of the battle whose challenger is `challengerAssistant`: its
 * `altPin` version. Also how a caller asks "is this alt armed": null when no battle-enabled experiment
 * names it. A duel turn reads both sides at once (`resolveBattleSides`); this serves a turn the alt
 * answers outside a duel.
 */
export async function resolveBattleTreatment(challengerAssistant: string): Promise<BattleSide | null> {
  const exp = await battleChallengedBy(challengerAssistant);
  if (!exp) return null;
  // Both sides, because the challenger's name is settled against the control's (`battleSideNames`).
  const [control, treatment] = await Promise.all([
    battleSideOf(exp, 'control').catch(() => null),
    battleSideOf(exp, 'treatment'),
  ]);
  return battleSideNames(control, treatment).treatment;
}

/**
 * Resolve the single active, battle-enabled experiment for a classification.
 *
 * The system holds at most one active experiment per classification (the
 * §11.1 type-exclusion rule), so a channel of a given classification has
 * exactly one battle to turn on. This lets the channel-battle enable path
 * auto-resolve that experiment instead of making the user pick it.
 *
 * Reads from the 60s-cached, active-only experiments scan (loadExperiments).
 * Returns null when no active battle-enabled experiment targets the
 * classification. If more than one somehow matches (should not happen given
 * the exclusion rule), returns the first and warns.
 */
export async function resolveActiveBattleExperimentForClassification(
  classification: string,
): Promise<Experiment | null> {
  // forceRefresh, for the same reason the create/activate conflict gate uses it (see loadExperiments):
  // this read BINDS A CHALLENGER, so it is correctness-critical, not a hot-path lookup.
  //
  // The caller (`channel-battle.ts`) resolves an experiment HERE and then validates it with a direct,
  // uncached `GetCommand`. With the 60s cache those two reads disagree for up to a minute after any
  // status change: this one hands back an experiment that was just paused, the fresh read rejects it,
  // and the operator sees "Experiment is not active" naming an experiment they can see is active in
  // the console. Two views of one row inside a single request is the defect; the second read was
  // already correct, so this one moves to match it.
  const experiments = await loadExperiments(true);
  // Share the resolver's liveness window rather than re-deriving it from raw `status`. Gating on
  // `active` alone auto-selected an EXPIRED (past-endDate) or not-yet-started experiment when an
  // operator enabled /battle on a channel - one that resolves no traffic, so the battle would arm
  // against an experiment the resolver ignores. `findClassificationConflicts` was updated to the
  // window and this was not, which also made the two disagree about which experiments are occupying
  // a classification.
  const matches = experiments.filter(
    (e) =>
      e.battleEnabled === true
      && isLiveForClassification(e, classification as Classification),
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(
      `[ExperimentManager] multiple active battle-enabled experiments for classification ${classification}; using ${matches[0].experimentId} (${matches.map((m) => m.experimentId).join(', ')})`,
    );
  }
  return matches[0];
}

/**
 * Find any other battle-enabled experiments that name the same challenger. Used to enforce "one
 * experiment per challenger" (returns conflicts as 409).
 */
export async function findChallengerConflicts(args: {
  challengerAssistant: string;
  excludeExperimentId?: string;
}): Promise<Experiment[]> {
  const experiments = await loadExperiments();
  return experiments.filter(
    (e) =>
      e.battleEnabled === true
      && challengerOf(e) === args.challengerAssistant
      && e.experimentId !== args.excludeExperimentId,
  );
}
