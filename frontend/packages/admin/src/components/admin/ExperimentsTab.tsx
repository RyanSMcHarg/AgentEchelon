import React, { useEffect, useMemo, useState } from 'react';
import DataTable from './DataTable';
import UnsupportedAnalyticsBanner from './UnsupportedAnalyticsBanner';
import { InfoTooltip } from './AdminHelp';
import { listProfiles, type ProfileListing } from '../../services/profileService';
import {
  listExperiments,
  createExperiment,
  updateExperimentStatus,
  modelDisplayName,
  MODEL_STRATEGY_MODELS,
  apiCall,
  ApiError,
  DEFAULT_ACCURACY_MARGIN_PCT,
  type Experiment,
  type ExperimentVariant,
  type ExperimentObjective,
  type ImageGenModelKey,
} from '@ae/shared';
import { queryAnalytics, getExperimentRecommendation } from '../../services/analyticsService';
import ExperimentDrillDown, { AXES, type DrillAxis, type DrillTarget, type DrillAggregate } from './ExperimentDrillDown';
import type {
  AnalyticsDateRange,
  AnalyticsResult,
  BattleEffectivenessRow,
  ExperimentRecommendation,
  ExperimentResultRow,
} from '@ae/shared';

// ── Local contract mirrors (DESIGN-EXPERIMENTS-BATTLE §1.2 / §3.2.1) ──────────
// Kept local (not imported) so this file compiles independently of the shared-type
// widening; structural typing makes them assignable to the shared shapes when the
// payloads are handed to createExperiment / apiCall. All fields are additive (INV-2).
type ObjectiveMetric = 'cost' | 'accuracy' | 'quality' | 'latency';
interface ObjectiveGuardrail {
  metric: ObjectiveMetric;
  direction: 'no_worse_than' | 'at_least';
  bound: number; // percent in [0, 100]
}
type DecisionOutcome = 'promoted_treatment' | 'kept_control' | 'no_decision';

// The experiments API base. Read directly (like experimentService) so the lifecycle
// calls that carry extra payload — the decision on End, and the DELETE route — can be
// issued without widening the shared service signatures (§3.2.1 / A.7).
const EXPERIMENTS_API_URL = import.meta.env.VITE_EXPERIMENTS_API_URL as string | undefined;

/** End a test, optionally recording the operator's decision (§3.2.1). The decision's
 *  `by`/`at` are stamped server-side from the token; the client sends outcome + note. */
async function endExperiment(experimentId: string, decision?: { outcome: DecisionOutcome; note?: string }): Promise<void> {
  await apiCall(EXPERIMENTS_API_URL, `/${experimentId}/status`, {
    method: 'POST',
    body: { status: 'completed', ...(decision ? { decision } : {}) },
    label: 'End experiment',
  });
}

/** Delete a test (L8): hard-delete a never-started draft, else soft-delete tombstone.
 *  The hard/soft choice is server-side; this frees the classification + alt-bot slot. */
async function deleteExperiment(experimentId: string): Promise<void> {
  await apiCall(EXPERIMENTS_API_URL, `/${experimentId}`, { method: 'DELETE', label: 'Delete experiment' });
}

/** Experiments that hold a classification the pending create needs — the type-exclusion conflict
 *  (§3.2.1). This MIRRORS the backend gate `findTypeExclusionConflicts`; the two must agree, because
 *  this list decides whether the held create is auto-retried after a resolution. Over-reporting here
 *  is not cosmetic: any extra row keeps `remaining.length !== 0`, so the create is never retried and
 *  the panel keeps demanding End/Pause/Delete on experiments that do not actually block anything.
 *
 *  Three conditions, all from the backend rule:
 *   - LIVE, not merely `active`: the resolver's window is active + startDate<=now<endDate, so an
 *     expired or not-yet-started experiment resolves no traffic and does not occupy the classification.
 *   - shares a targeted classification.
 *   - conflicts iff EXACTLY ONE side is a `classification`-type experiment; two intent experiments (or
 *     two classification ones) on the same tier do not exclude each other. */
function computeConflicts(
  tiers: string[],
  selfId: string,
  all: Experiment[],
  experimentType?: string,
): Experiment[] {
  const candidateType = experimentType ?? 'intent';
  const now = Date.now();
  return all.filter((e) => {
    if (e.experimentId === selfId) return false;
    if (e.status !== 'active') return false;
    if (e.startDate && new Date(e.startDate).getTime() > now) return false;
    if (e.endDate && new Date(e.endDate).getTime() <= now) return false;
    if (!Array.isArray(e.tiers) || !e.tiers.some((t) => tiers.includes(t))) return false;
    const otherType = e.experimentType ?? 'intent';
    return (candidateType === 'classification') !== (otherType === 'classification');
  });
}

/** Is this blocker still something the operator can resolve?
 *
 *  A 409 body names the experiments the SERVER believes hold the classification, and that belief is
 *  read from an eventually-consistent scan. Right after an End/Pause/Delete the freed row can still
 *  come back in a conflict body, so a retried create can be told it is blocked by an experiment that
 *  has already completed. Presenting that row asks the operator to resolve something already
 *  resolved, and its End/Pause buttons act on a terminal experiment.
 *
 *  The rule is the live half of `computeConflicts`: only an `active` experiment inside its own window
 *  occupies a classification. Anything else is stale and is dropped rather than shown. */
export function isResolvableBlocker(e: Experiment, now: number): boolean {
  if (e.status !== 'active') return false;
  if (e.startDate && new Date(e.startDate).getTime() > now) return false;
  if (e.endDate && new Date(e.endDate).getTime() <= now) return false;
  return true;
}

/** The subset of a 409's named blockers that is genuinely outstanding work for the operator.
 *
 *  Two ways a candidate is already dealt with, and both produce the same defect if presented: the
 *  panel demands an End/Pause/Delete on an experiment that has already completed, and the operator is
 *  told to resolve something they just resolved.
 *
 *   - `alreadyResolved` holds the ids this conflict flow has freed. The auto-retry re-checks
 *     server-side against an eventually-consistent read, so a freed row can be named again.
 *   - `isResolvableBlocker` drops a candidate the body itself reports as terminal, paused, expired or
 *     not yet started; none of those occupy a classification. */
export function presentableBlockers(
  candidates: Experiment[],
  alreadyResolved: string[],
  now: number,
): Experiment[] {
  return candidates.filter(
    (c) => !alreadyResolved.includes(c.experimentId) && isResolvableBlocker(c, now),
  );
}

/** Consequence copy for a confirmed lifecycle action (§3.2.1, verbatim from the design's table). */
function confirmCopy(kind: 'end' | 'pause' | 'delete', id: string): string {
  switch (kind) {
    case 'end':
      return `End "${id}"? It stops collecting data and can't be resumed. Its results stay in the dashboard.`;
    case 'pause':
      return `Pause "${id}"? New conversations stop being assigned to it; data collected so far is preserved and you can Resume it later.`;
    case 'delete':
      return `Delete "${id}"? It's removed from your experiments and its alt-bot slot is freed. Historical analytics keep their labels; this can't be undone.`;
  }
}

interface ExperimentsTabProps {
  resultsData: AnalyticsResult | null;
  isLoading: boolean;
  /** Register a "close the results detail first" handler so global/browser Back steps out of a focused
   *  experiment's results before walking tab history. */
  registerBack?: (close: (() => void) | null) => void;
  /** Open a conversation's transcript (AdminDashboard.openConversation). The drill-down's link from a
   *  scored exchange to the reply that produced it - the admin-plane read that already exists, not a
   *  second path to conversation content. */
  onOpenConversation?: (channelArn: string) => void;
}

const INTENT_OPTIONS = [
  { value: 'general_qa', label: 'General Q&A' },
  { value: 'code_generation', label: 'Code Generation' },
  { value: 'code_review', label: 'Code Review' },
  { value: 'document_extraction', label: 'Document Extraction' },
  { value: 'report_generation', label: 'Report Generation' },
  { value: 'image_generation', label: 'Image Generation' },
  { value: 'strategic_analysis', label: 'Strategic Analysis' },
  { value: 'workflow_actions', label: 'Workflow Actions' },
];

// DERIVED from the shared model-strategy mirror, never hand-listed. This was a third hardcoded copy of
// the catalog and it had already drifted: `deepseek_v3` shipped in the backend catalog (the model behind
// CN geography routing) and was absent here, so an operator simply could not select it for an
// experiment. A hardcoded list fails silently in exactly that direction - it never errors, it just
// omits. `model-catalog-mirror.test.ts` holds the mirror to the backend catalog.
const MODEL_OPTIONS = MODEL_STRATEGY_MODELS.map((m) => ({ value: m.key, label: m.displayName }));

// /battle generation-out: per-variant image-gen model. Empty
// value = none (a normal text battle). Set on BOTH variants to make the
// battle generation-out (server validates both-or-neither). These are the
// ACTIVE models (image-gen-models.ts); the annotations flag what each one
// needs. Amazon Titan/Nova are intentionally omitted — AWS legacy-locks
// them ("not used in 30 days → upgrade to an active model"), so offering
// them would let an operator bind a model that fails on first use.
const IMAGE_GEN_MODEL_OPTIONS = [
  { value: 'openai_gpt_image_1', label: 'OpenAI gpt-image-1 (key)' },
  { value: 'fal_flux_pro_1_1', label: 'FLUX 1.1 Pro via FAL (key)' },
  { value: 'stability_image_core', label: 'Stability Image Core (Bedrock · us-west-2)' },
  { value: 'stability_image_ultra', label: 'Stability Image Ultra (Bedrock · us-west-2)' },
];

const TIER_OPTIONS = ['basic', 'standard', 'premium'] as const;

// Per-variant image-gen model selection applies ONLY to an intent experiment whose intent is
// `image_generation` - there each variant is a DIFFERENT image model, which is the real comparison, and
// the normal (non-battle) flow serves the assigned variant's image model. Base-model and classification
// experiments vary a text model, so an image prompt would run the SAME image model on both sides
// (same-vs-same, useless). Profile-vs-Profile carries each side's image model via its profile's
// models.image, so it needs no explicit selector here. Battle is just extra UI + scoring on top - it
// does not change WHERE image models are relevant.
function isImageIntentExperiment(experimentType: string, intent: string): boolean {
  return experimentType === 'intent' && intent === 'image_generation';
}

const ExperimentsTab: React.FC<ExperimentsTabProps> = ({ resultsData, isLoading: _isLoading, registerBack, onOpenConversation }) => {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // #8 drill-down: null = show every experiment's comparison; an id = focus that
  // one experiment's results (with a "← All experiments" control to clear it).
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  /**
   * Which lifecycle states the list shows.
   *
   * The table used to render EVERY non-deleted experiment in DynamoDB scan order, which is arbitrary.
   * On a deployment with ~95 rows that made the one question an operator actually needs answered -
   * "what is live right now?" - unanswerable without sorting by a column header, and those headers do
   * not exist below 640px. An `active` experiment silently splits production traffic, so it must be
   * one tap away, not a scroll away.
   */
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused' | 'draft' | 'completed'>('all');
  // Available assistant profiles + versions, for profile-vs-profile experiments (SPEC-PORTABLE §6).
  const [profileOptions, setProfileOptions] = useState<ProfileListing[]>([]);
  useEffect(() => { listProfiles().then(setProfileOptions).catch(() => setProfileOptions([])); }, []);

  // Create form state
  const [newExperiment, setNewExperiment] = useState({
    experimentId: '',
    // 'intent'/'base_model'/'classification' vary a MODEL; 'profile' pits two whole assistant PROFILE
    // versions against each other (SPEC-PORTABLE-PROFILES §6 — profileRef variants).
    experimentType: 'intent' as 'intent' | 'base_model' | 'classification' | 'profile',
    intent: 'general_qa',
    tiers: ['standard'] as string[],
    controlModel: 'sonnet',
    treatmentModel: 'gpt_oss_20b',
    // Profile-vs-profile variants (experimentType === 'profile'): name + optional version (blank ⇒ active).
    controlProfile: '',
    controlProfileVersion: '',
    treatmentProfile: '',
    treatmentProfileVersion: '',
    controlWeight: 50,
    // Objective is now first-class (§1.4): a REQUIRED written statement (the decision this test
    // informs), the metric+target as the PRIMARY criterion, and optional guardrails. `description`
    // is no longer edited directly — it is populated from the statement as a legacy alias on create
    // (kept for one release so old readers don't break).
    objectiveStatement: '',
    guardrails: [] as { metric: '' | ObjectiveMetric; direction: 'no_worse_than' | 'at_least'; bound: string }[],
    // endDate optional; startDate is auto-stamped today.
    endDate: '',
    objectiveMetric: 'quality' as ObjectiveMetric,
    objectiveTarget: '',
    // /battle (SPEC-BATTLE.md): when enabled, the experiment can
    // power Battle Mode. Requires displayName on each variant + a slot id.
    battleEnabled: false,
    altBotSlotId: 'slot-0',
    controlDisplayName: 'Atlas',
    treatmentDisplayName: 'Echo',
    controlAddendum: '',
    treatmentAddendum: '',
    // Generation-out: '' = text battle; set BOTH for an image battle.
    controlImageGenModelKey: '',
    treatmentImageGenModelKey: '',
  });

  // Conflict-resolution flow (§3.2.1): when a create/activate is blocked (409) by an experiment
  // already holding a targeted classification, we hold the pending payload, list the blocker(s), and
  // offer End / Pause / Delete — each behind a confirm dialog — then auto-retry the create.
  const [pendingCreate, setPendingCreate] = useState<Omit<Experiment, 'createdAt'> | null>(null);
  const [conflicts, setConflicts] = useState<Experiment[] | null>(null);
  // The blockers this flow has already freed. The auto-retry re-checks server-side against an
  // eventually-consistent read, so a just-ended experiment can come back in the next 409 body; it is
  // filtered out here rather than re-presented as work the operator still owes. Cleared when the flow
  // ends (create succeeds, or the panel is cancelled).
  const [resolvedBlockerIds, setResolvedBlockerIds] = useState<string[]>([]);
  // Confirm dialog for a single destructive/lifecycle action (from the conflict panel OR the table).
  const [confirm, setConfirm] = useState<
    | { kind: 'end' | 'pause' | 'delete'; exp: Experiment; ran: boolean; decision: DecisionOutcome; note: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);

  async function loadExperiments() {
    setIsRefreshing(true);
    try {
      setActionError(null);
      const results = await listExperiments();
      setExperiments(results);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to load experiments');
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    loadExperiments();
  }, []);

  // Let global/browser Back close the focused-experiment results detail before walking tab history.
  useEffect(() => {
    registerBack?.(selectedExperimentId ? () => setSelectedExperimentId(null) : null);
    return () => registerBack?.(null);
  }, [selectedExperimentId, registerBack]);

  /**
   * Why a classification experiment cannot be started right now, or null when it can (DESIGN §5.4).
   *
   * Resolved from the shadow gate: a COMPLETE replay comparing this experiment's two models whose
   * verdict authorises a split. Anything less and the split would change routing for real users while
   * the only evidence about the change is the evaluator's opinion of the answers downstream.
   */
  const [classifierGateBlock, setClassifierGateBlock] = useState<string | null>(
    'Run the classifier accuracy gate for these two models first (Quality > Ground Truth).',
  );
  const gateModels = `${newExperiment.controlModel}|${newExperiment.treatmentModel}`;
  // The gate's own window. A replay is looked up by the models it compared, not by date, so this is
  // only the range the query is issued over.
  const gateRange: AnalyticsDateRange = useMemo(() => {
    const end = new Date();
    return { start: new Date(end.getTime() - 180 * 86_400_000).toISOString(), end: end.toISOString() };
  }, []);
  useEffect(() => {
    if (newExperiment.experimentType !== 'classification') {
      setClassifierGateBlock(null);
      return;
    }
    let cancelled = false;
    const [control, treatment] = gateModels.split('|');
    // BLOCK WHILE THE ANSWER IS UNKNOWN (CR-11). This left `classifierGateBlock` at its previous value
    // across the round-trip, and that value is `null` whenever the operator has just switched Type to
    // Classification (the early return above cleared it) or changed only one model on a pair that had
    // previously passed. Clicking Create & Activate inside that window created an UNGATED live
    // classification split - the one thing the gate exists to prevent. Fail closed until a run is found.
    setClassifierGateBlock('Checking for a completed classifier accuracy gate for these two models…');
    (async () => {
      try {
        const res = await queryAnalytics('classifier_replays', gateRange, {});
        const runs = ((res.data as unknown) as Array<Record<string, string>>) ?? [];
        // Same pair, either way round: which side is called incumbent is the replay's framing, not
        // the experiment's.
        //
        // MATCHED ON EITHER FORM, and that is a transition accommodation rather than looseness. The gate
        // now records catalog KEYS ('sonnet'), the same vocabulary this form holds, which is what makes
        // this comparison possible at all - it used to compare a key against the raw Bedrock id the old
        // free-text field produced, so it could never match and EVERY classification experiment was
        // refused. Rows written before that change still hold ids, and refusing to recognise them would
        // invalidate gate runs that were performed correctly. `importManifest` makes the same
        // accommodation for guardrail keys versus resolved ids, for the same reason.
        const sameModel = (recorded: string, selectedKey: string): boolean => {
          if (recorded === selectedKey) return true; // both keys: the path all new runs take
          const def = MODEL_STRATEGY_MODELS.find((m) => m.key === selectedKey);
          return !!def && recorded === def.bedrockModelId; // a legacy row recorded the resolved id
        };
        const matching = runs.filter(
          (r) =>
            r.status === 'complete' &&
            ((sameModel(r.incumbentModel, control) && sameModel(r.challengerModel, treatment)) ||
              (sameModel(r.incumbentModel, treatment) && sameModel(r.challengerModel, control))),
        );
        if (!matching.length) {
          if (!cancelled) {
            setClassifierGateBlock(
              `No completed classifier gate compares ${control} with ${treatment}. Run one under Quality > Ground Truth before splitting live traffic.`,
            );
          }
          return;
        }
        for (const r of matching) {
          const detail = (await queryAnalytics('classifier_replay', gateRange, { runId: r.runId })) as unknown as {
            gate?: { verdict?: string; rationale?: string };
          };
          const verdict = detail?.gate?.verdict;
          if (verdict === 'challenger_better' || verdict === 'non_inferior') {
            if (!cancelled) setClassifierGateBlock(null);
            return;
          }
        }
        if (!cancelled) {
          setClassifierGateBlock(
            'The classifier gate for these two models does not authorise a split yet. Finish the adjudication queue, or accept its verdict.',
          );
        }
      } catch {
        // A gate that cannot be READ is not a gate that passed.
        if (!cancelled) {
          setClassifierGateBlock('Could not read the classifier gate, so a classification split cannot be authorised.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [newExperiment.experimentType, gateModels, gateRange]);

  async function handleCreate() {
    if (!newExperiment.experimentId.trim()) {
      setActionError('Experiment ID is required');
      return;
    }
    // Per-variant image models apply only to an image_generation intent experiment; for any other
    // experiment they are hidden, so drop any stale key rather than shipping "OpenAI for code generation".
    const isImageIntent = isImageIntentExperiment(newExperiment.experimentType, newExperiment.intent);
    const controlImageGenModelKey = isImageIntent ? newExperiment.controlImageGenModelKey : '';
    const treatmentImageGenModelKey = isImageIntent ? newExperiment.treatmentImageGenModelKey : '';

    // An image_generation experiment compares the two variants' image models, so BOTH are required
    // (the image model IS the variant here, battle or not). Fail fast locally with a clear message.
    if (isImageIntent && (!controlImageGenModelKey || !treatmentImageGenModelKey)) {
      setActionError('Image experiment: pick an image-gen model for BOTH variants.');
      return;
    }

    // THE CLASSIFICATION GATE (DESIGN §5.4). A classification experiment changes which model LABELS
    // a message, for real users, and the online split measures the answer rather than the labelling.
    // The gate answers the actual question first, on archived traffic, exposing nobody — so it is a
    // precondition for the split rather than a report on it: "the gate does not replace the split; it
    // earns it". Blocked here rather than server-side because the experiments API is DynamoDB-only
    // and the gate's evidence lives in Aurora; the remaining hole is recorded in the tracker.
    if (newExperiment.experimentType === 'classification') {
      const reason = classifierGateBlock;
      if (reason) {
        setActionError(reason);
        return;
      }
    }

    // A variant runs either a MODEL (modelKey) or a whole PROFILE version (profileRef) — mutually
    // exclusive (backend-validated). SPEC-PORTABLE-PROFILES §6.
    const isProfileExp = newExperiment.experimentType === 'profile';
    if (isProfileExp && (!newExperiment.controlProfile || !newExperiment.treatmentProfile)) {
      setActionError('Profile experiment: pick a profile for both the control and treatment variants.');
      return;
    }
    // For an image_generation experiment the compared model is the IMAGE model; the text modelKey is only
    // the base/rebuttal model (a battle round-2 rebuttal is text). The variant's text dropdown is hidden,
    // so pin it to a universally tier-allowed model ('haiku') - otherwise a default like sonnet would fail
    // the tier-safety check on basic and silently drop the whole image experiment.
    const textModelFor = (m: string) => (isImageIntent ? 'haiku' : m);
    const runFor = (model: string, profile: string, version: string) =>
      isProfileExp
        ? { profileRef: { profileName: profile, ...(version ? { version: Number(version) } : {}) } }
        : { modelKey: textModelFor(model) };

    const variants: ExperimentVariant[] = [
      {
        variantId: 'control',
        ...runFor(newExperiment.controlModel, newExperiment.controlProfile, newExperiment.controlProfileVersion),
        weight: newExperiment.controlWeight,
        // Image model is a NORMAL variant property (served in the non-battle flow too), not battle-only.
        ...(controlImageGenModelKey && {
          imageGenModelKey: controlImageGenModelKey as ImageGenModelKey,
        }),
        ...(newExperiment.battleEnabled && {
          displayName: newExperiment.controlDisplayName,
          systemPromptAddendum: newExperiment.controlAddendum || undefined,
        }),
      },
      {
        variantId: 'treatment',
        ...runFor(newExperiment.treatmentModel, newExperiment.treatmentProfile, newExperiment.treatmentProfileVersion),
        weight: 100 - newExperiment.controlWeight,
        ...(treatmentImageGenModelKey && {
          imageGenModelKey: treatmentImageGenModelKey as ImageGenModelKey,
        }),
        ...(newExperiment.battleEnabled && {
          displayName: newExperiment.treatmentDisplayName,
          systemPromptAddendum: newExperiment.treatmentAddendum || undefined,
        }),
      },
    ];

    // Objective (§1.4). The written statement is REQUIRED; the metric+target is the primary
    // quantitative criterion (target ∈ [0, 100]); guardrails are optional veto conditions.
    const statement = newExperiment.objectiveStatement.trim();
    if (!statement) {
      setActionError('Objective: state the decision this test will inform.');
      return;
    }
    // A BLANK TARGET IS NOT A TARGET OF ZERO (CR-13).
    //
    // `objectiveTarget` defaults to `''` and `Number('')` is `0`, which sails through the range check
    // below. The stored objective then carries `target: 0` - and `experiment-stats.ts` documents `0` as
    // meaning ABSENT ("0/absent ⇒ N-floor powered"), so it skips the target-tied power check entirely and
    // `ObjectiveBanner` reads "On track" from the first exchange. The operator believes they set a
    // quantitative criterion and set none, with the UI having accepted the field.
    //
    // Checked before `Number()` because that conversion is exactly what erases the distinction.
    if (!newExperiment.objectiveTarget.trim()) {
      setActionError('Objective target is required: state the percentage improvement this test must show.');
      return;
    }
    const target = Number(newExperiment.objectiveTarget);
    if (!Number.isFinite(target) || target < 0 || target > 100) {
      setActionError('Objective target must be a percentage between 0 and 100.');
      return;
    }
    // Only fully-specified guardrails (metric chosen + valid bound) are sent; ≤3.
    const guardrails: ObjectiveGuardrail[] = [];
    for (const gr of newExperiment.guardrails) {
      if (!gr.metric) continue;
      const bound = Number(gr.bound);
      if (!Number.isFinite(bound) || bound < 0 || bound > 100) {
        setActionError('Guardrail bound must be a percentage between 0 and 100.');
        return;
      }
      guardrails.push({ metric: gr.metric, direction: gr.direction, bound });
    }
    const objective: ExperimentObjective = {
      metric: newExperiment.objectiveMetric,
      target,
      statement,
      ...(guardrails.length ? { guardrails } : {}),
    };

    const payload: Omit<Experiment, 'createdAt'> = {
      experimentId: newExperiment.experimentId,
      status: 'active',
      experimentType: newExperiment.experimentType,
      // base_model / classification apply across intents; send the selected
      // intent only for an intent-scoped experiment.
      intent: newExperiment.experimentType === 'intent' ? newExperiment.intent : '',
      tiers: newExperiment.tiers,
      variants,
      startDate: new Date().toISOString(),
      ...(newExperiment.endDate && { endDate: new Date(newExperiment.endDate).toISOString() }),
      // `description` is kept as a populated alias of the statement for one release (§1.4).
      description: statement,
      objective,
      ...(newExperiment.battleEnabled && {
        battleEnabled: true,
        altBotSlotId: newExperiment.altBotSlotId,
      }),
    };

    await submitCreate(payload);
  }

  function resetCreateForm() {
    setNewExperiment({
      experimentId: '',
      experimentType: 'intent',
      intent: 'general_qa',
      tiers: ['standard'],
      controlModel: 'sonnet',
      treatmentModel: 'gpt_oss_20b',
      controlProfile: '',
      controlProfileVersion: '',
      treatmentProfile: '',
      treatmentProfileVersion: '',
      controlWeight: 50,
      objectiveStatement: '',
      guardrails: [],
      endDate: '',
      objectiveMetric: 'quality',
      objectiveTarget: '',
      battleEnabled: false,
      altBotSlotId: 'slot-0',
      controlDisplayName: 'Atlas',
      treatmentDisplayName: 'Echo',
      controlAddendum: '',
      treatmentAddendum: '',
      controlImageGenModelKey: '',
      treatmentImageGenModelKey: '',
    });
  }

  // Create, handling the type-exclusion 409 (§3.2.1): on conflict we surface the blocker(s) and hold
  // the payload so a resolution auto-retries it. apiCall exposes only the 409's error string, so the
  // blockers are derived from the already-loaded list by tier overlap (computeConflicts).
  //
  // `alreadyResolved` is passed EXPLICITLY by the auto-retry rather than read from state: the retry
  // runs in the same tick as the `setResolvedBlockerIds` that recorded the resolution, so the closure
  // still holds the pre-resolution array and the just-ended blocker would be re-presented.
  async function submitCreate(
    payload: Omit<Experiment, 'createdAt'>,
    alreadyResolved: string[] = resolvedBlockerIds,
  ) {
    try {
      setActionError(null);
      await createExperiment(payload);
      setShowCreate(false);
      setPendingCreate(null);
      setConflicts(null);
      setResolvedBlockerIds([]);
      resetCreateForm();
      await loadExperiments();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Prefer the server's own `conflicts` body (deterministic) over re-deriving from the
        // loaded list, which races the list-load right after the blocker was created. The 409
        // conflicts are the active blockers, so stamp status:'active' (the panel needs it for
        // the End/Pause "ran" decision) only where the body says nothing. Fall back to the list
        // derivation if the body is absent.
        const serverConflicts = Array.isArray((error.body as { conflicts?: unknown[] } | undefined)?.conflicts)
          ? ((error.body as { conflicts: Array<Partial<Experiment>> }).conflicts).map(
              (c) => ({ status: 'active', tiers: [], variants: [], ...c }) as Experiment,
            )
          : [];
        const candidates = serverConflicts.length > 0
          ? serverConflicts
          : computeConflicts(payload.tiers, payload.experimentId, experiments, payload.experimentType);
        // A candidate the operator has already freed, or one the body itself reports as terminal or
        // outside its window, is a stale read, not outstanding work. Dropping it is what keeps the
        // panel from demanding an End on a completed experiment.
        const blockers = presentableBlockers(candidates, alreadyResolved, Date.now());
        if (blockers.length > 0) {
          setPendingCreate(payload);
          setConflicts(blockers);
          setActionError(null);
          // Close the create form so the conflict-resolution panel + its confirm dialog
          // are the only surfaces on screen — leaving the form open renders it behind the
          // panel/dialog, which overlaps their controls. The payload is held in
          // pendingCreate and auto-retried on resolution, so nothing is lost.
          setShowCreate(false);
          return;
        }
        if (candidates.length > 0) {
          // Every named blocker is already resolved: the classification is free and the server's read
          // has not caught up. Say that, and put the create form back with the operator's values
          // still in it, so the retry is one click rather than a hunt for a conflict that is gone.
          setConflicts(null);
          setPendingCreate(null);
          // AND FORGET WHAT WAS RESOLVED, because this exit ends the episode. `resolvedBlockerIds`
          // exists to suppress a blocker the operator just freed from a stale server read; carrying
          // it past this point makes it suppress that same experiment after it has been re-activated.
          // The loop that produces: pause E, land here, re-activate E, retry - the 409 names E,
          // `presentableBlockers` drops it as already-resolved, and the operator is told again that
          // the blocker is resolved, with no panel and no End/Pause control, against a classification
          // that is genuinely held. Cleared on the create and on Cancel for the same reason; this was
          // the third exit and the only one that forgot.
          setResolvedBlockerIds([]);
          setShowCreate(true);
          setActionError(
            'The blocking experiment is already resolved. The classification frees within a few seconds; create again.',
          );
          return;
        }
      }
      setActionError(error instanceof Error ? error.message : 'Failed to create experiment');
    }
  }

  // Run a confirmed lifecycle action on a blocker (or table row), then — if it unblocks a pending
  // create — auto-retry that create; otherwise refresh the remaining conflict list (§3.2.1).
  async function runConfirmedAction() {
    if (!confirm) return;
    const { kind, exp, ran, decision, note } = confirm;
    setBusy(true);
    try {
      setActionError(null);
      if (kind === 'end') {
        // A test that RAN records the operator's decision (default no_decision); a draft has none.
        try {
          await endExperiment(exp.experimentId, ran ? { outcome: decision, ...(note.trim() ? { note: note.trim() } : {}) } : undefined);
        } catch (e) {
          // Idempotent resolution: if the blocker is already terminal (a concurrent End, or a
          // stale row in the panel), the classification is already freed — treat an
          // INVALID_TRANSITION 409 as resolved rather than surfacing "completed → completed".
          if (!(e instanceof ApiError && e.status === 409)) throw e;
        }
      } else if (kind === 'pause') {
        await updateExperimentStatus(exp.experimentId, 'paused');
      } else {
        await deleteExperiment(exp.experimentId);
      }
      setConfirm(null);
      // Remembered for the auto-retry below: this experiment no longer holds the classification, so a
      // 409 body that still names it is a lagging read and must not be presented as work to do.
      const resolvedIds = resolvedBlockerIds.includes(exp.experimentId)
        ? resolvedBlockerIds
        : [...resolvedBlockerIds, exp.experimentId];
      setResolvedBlockerIds(resolvedIds);
      const fresh = await listExperiments();
      setExperiments(fresh);
      if (pendingCreate) {
        // Exclude EVERY experiment this flow has resolved, not just the last one: the list read is an
        // eventually-consistent scan that may still show any of them active for a moment, but
        // End/Pause/Delete freed the classification, so the auto-retry must not race that lag and
        // spuriously re-show the panel.
        const remaining = computeConflicts(
          pendingCreate.tiers,
          pendingCreate.experimentId,
          fresh.filter((e) => !resolvedIds.includes(e.experimentId)),
          pendingCreate.experimentType,
        );
        if (remaining.length === 0) {
          const retry = pendingCreate;
          setConflicts(null);
          // classification is free: auto-retry the original create, telling it what is already freed
          await submitCreate(retry, resolvedIds);
        } else {
          setConflicts(remaining);
        }
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(experimentId: string, status: Experiment['status']) {
    try {
      setActionError(null);
      await updateExperimentStatus(experimentId, status);
      await loadExperiments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update experiment');
    }
  }

  function toggleTier(tier: string) {
    setNewExperiment((prev) => ({
      ...prev,
      tiers: prev.tiers.includes(tier)
        ? prev.tiers.filter((t) => t !== tier)
        : [...prev.tiers, tier],
    }));
  }

  // Detail view: a focused experiment's results open as their own PAGE within the tab (not an inline
  // scroll below the list), with a Back control; global/browser Back steps out of it too (B8/D2).
  if (selectedExperimentId) {
    return (
      <div className="admin-tab">
        <div className="admin-tab-header">
          <nav className="admin-breadcrumb" aria-label="Experiment path">
            <button className="admin-link-btn" onClick={() => setSelectedExperimentId(null)}>← All experiments</button>
            <span> / </span>
            <span>{selectedExperimentId}</span>
          </nav>
        </div>
        {resultsData?.unsupported ? (
          <UnsupportedAnalyticsBanner result={resultsData} />
        ) : (
          <ExperimentResults
            resultsData={resultsData}
            experiments={experiments}
            selectedExperimentId={selectedExperimentId}
            onClearSelection={() => setSelectedExperimentId(null)}
          />
        )}
      </div>
    );
  }

  // Per-variant image-gen model is a NORMAL variant control, shown only for an image_generation intent
  // experiment (each variant is a different image model). It lives with the variant models, NOT inside
  // the battle card, because the normal flow serves it too - battle just adds scoring on top.
  const showImageGenModels = isImageIntentExperiment(newExperiment.experimentType, newExperiment.intent);

  // Everything the operator may act on. `deleted` is a tombstone, not a state to browse, so it is
  // excluded here once rather than at each call site — the counts on the filter chips and the rows in
  // the table are then guaranteed to describe the same set.
  //
  // NEWEST FIRST, deliberately. The list arrives in DynamoDB Scan order, which is neither stable nor
  // meaningful, and the table paginates at 25 — so without a sort, the experiment the operator just
  // created lands on an arbitrary page and "where did my test go?" is the first experience of the
  // feature. Recency is the one default every operator task here shares: the test just created, just
  // paused, or just completed is the one being acted on. Rows without createdAt (pre-field records)
  // sort last rather than throwing.
  const visibleExperiments = experiments
    .filter((e) => e.status !== 'deleted')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>A/B Experiments</h3>
        <div className="admin-filter-group">
          <button className="admin-inline-btn" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? 'Cancel' : 'New Experiment'}
          </button>
          <button className="admin-filter-btn" onClick={() => loadExperiments()}>
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {actionError && (
        <div className="admin-error">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      {/* Conflict-resolution panel (§3.2.1): a blocked create lists the experiment(s) holding the
          classification and offers three confirmed ways to free it, then auto-retries. */}
      {conflicts && conflicts.length > 0 && (
        <div className="admin-section experiment-conflict-panel" data-testid="experiment-conflict">
          <h4>Classification already in use</h4>
          <p className="admin-tab-description">
            {pendingCreate ? `"${pendingCreate.experimentId}" can't start` : "This test can't start"} —{' '}
            {conflicts.length === 1 ? 'another experiment is' : `${conflicts.length} experiments are`} active on{' '}
            {(pendingCreate?.tiers ?? []).join(', ') || 'the targeted tier(s)'}. Free the classification and the
            create retries automatically.
          </p>
          {conflicts.map((c) => (
            <div
              className="experiment-conflict-row"
              key={c.experimentId}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', padding: '6px 0' }}
            >
              <div className="experiment-conflict-id">
                <span className="exp-compare-id">{c.experimentId}</span>
                <span className="exp-compare-meta">
                  {c.status} · {c.experimentType || 'intent'} · {Array.isArray(c.tiers) ? c.tiers.join(', ') : ''}
                </span>
              </div>
              <div className="admin-inline-actions">
                <button
                  className="admin-inline-btn"
                  onClick={() => setConfirm({ kind: 'end', exp: c, ran: c.status !== 'draft', decision: 'no_decision', note: '' })}
                >
                  End
                </button>
                <button
                  className="admin-inline-btn"
                  onClick={() => setConfirm({ kind: 'pause', exp: c, ran: c.status !== 'draft', decision: 'no_decision', note: '' })}
                >
                  Pause
                </button>
                <button
                  className="admin-inline-btn danger"
                  onClick={() => setConfirm({ kind: 'delete', exp: c, ran: c.status !== 'draft', decision: 'no_decision', note: '' })}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          <button
            className="admin-inline-btn"
            onClick={() => { setConflicts(null); setPendingCreate(null); setResolvedBlockerIds([]); }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Confirm dialog (§3.2.1): every End / Pause / Delete states its consequence; ending a test
          that RAN prompts a decision with "No decision" as the default and always-available option. */}
      {confirm && (
        <div
          className="admin-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm ${confirm.kind}`}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '16px',
          }}
        >
          <div
            className="admin-modal experiment-confirm admin-section"
            style={{ maxWidth: '520px', width: '100%', margin: 0 }}
          >
            <h4>
              {confirm.kind === 'end' ? 'End experiment' : confirm.kind === 'pause' ? 'Pause experiment' : 'Delete experiment'}
            </h4>
            <p>{confirmCopy(confirm.kind, confirm.exp.experimentId)}</p>
            {confirm.kind === 'end' && confirm.ran && (
              <div className="experiment-decision-picker">
                <label>
                  Record the outcome
                  <select
                    value={confirm.decision}
                    onChange={(e) => setConfirm((c) => (c ? { ...c, decision: e.target.value as DecisionOutcome } : c))}
                  >
                    <option value="no_decision">No decision (default)</option>
                    <option value="promoted_treatment">Promoted treatment</option>
                    <option value="kept_control">Kept control</option>
                  </select>
                </label>
                <label>
                  Note (optional)
                  <textarea
                    className="textarea input"
                    value={confirm.note}
                    maxLength={500}
                    rows={2}
                    placeholder="Optional. e.g. why this outcome, what you changed."
                    onChange={(e) => setConfirm((c) => (c ? { ...c, note: e.target.value } : c))}
                  />
                </label>
                <p className="admin-field-hint">
                  You're never forced to declare a winner. "No decision" closes an inconclusive test honestly.
                </p>
              </div>
            )}
            <div className="admin-inline-actions">
              <button className="admin-inline-btn" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </button>
              <button
                className={`admin-inline-btn ${confirm.kind === 'pause' ? '' : 'danger'}`}
                onClick={runConfirmedAction}
                disabled={busy}
              >
                {busy ? 'Working…' : confirm.kind === 'end' ? 'End' : confirm.kind === 'pause' ? 'Pause' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="admin-section admin-conversation-panel">
          <h4>Create Experiment</h4>
          <div className="admin-form-grid">
            <label>
              Experiment ID
              <input
                type="text"
                value={newExperiment.experimentId}
                onChange={(e) => setNewExperiment((p) => ({ ...p, experimentId: e.target.value }))}
                placeholder="e.g. exp-code-gen-sonnet-vs-gpt"
              />
            </label>
            <label>
              Type
              <InfoTooltip
                label="About experiment type"
                // The Classification wording no longer claims to measure labelling. It does not: the
                // `accuracy` objective maps to the same evaluator score that backs `quality`, so a
                // classification experiment is scored on the ANSWER, a downstream proxy for the
                // routing change. Saying otherwise told an operator they were measuring something the
                // platform does not measure. See DESIGN §5 for the shadow gate that would.
                content="Intent tests which model best serves a specific detected intent (objective: quality). Classification swaps the intent-classifier model and is scored INDIRECTLY, on answer quality under the new routing — label correctness itself is not measured today. Base Model compares default base models across all intents."
              />
              <select
                value={newExperiment.experimentType}
                onChange={(e) => setNewExperiment((p) => {
                  const experimentType = e.target.value as 'intent' | 'base_model' | 'classification' | 'profile';
                  // Keep the primary objective metric valid for the new type: accuracy is
                  // classification-only; quality is base_model/intent-only.
                  let objectiveMetric = p.objectiveMetric;
                  if (experimentType === 'classification' && objectiveMetric === 'quality') objectiveMetric = 'accuracy';
                  if (experimentType !== 'classification' && objectiveMetric === 'accuracy') objectiveMetric = 'quality';
                  return { ...p, experimentType, objectiveMetric };
                })}
              >
                <option value="intent">Intent (shipped)</option>
                <option value="base_model">Base Model (shipped)</option>
                <option value="classification">Classification (shipped)</option>
                <option value="profile">Profile vs Profile (shipped)</option>
              </select>
            </label>
            {newExperiment.experimentType === 'intent' && (
              <label>
                Intent
                <select
                  value={newExperiment.intent}
                  onChange={(e) => setNewExperiment((p) => ({ ...p, intent: e.target.value }))}
                >
                  {INTENT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            )}
            {newExperiment.experimentType === 'profile' ? (
              <>
                {(() => {
                  const ctrl = profileOptions.find((p) => p.profileName === newExperiment.controlProfile);
                  const trt = profileOptions.find((p) => p.profileName === newExperiment.treatmentProfile);
                  return (
                    <>
                      <label>
                        Control Profile
                        <select value={newExperiment.controlProfile} onChange={(e) => setNewExperiment((p) => ({ ...p, controlProfile: e.target.value, controlProfileVersion: '' }))}>
                          <option value="">Select a profile…</option>
                          {profileOptions.map((p) => <option key={p.profileName} value={p.profileName}>{p.profileName}</option>)}
                        </select>
                        <select value={newExperiment.controlProfileVersion} onChange={(e) => setNewExperiment((p) => ({ ...p, controlProfileVersion: e.target.value }))} style={{ marginTop: 'var(--space-1)' }}>
                          <option value="">Active version{ctrl?.activeVersion != null ? ` (v${ctrl.activeVersion})` : ''}</option>
                          {(ctrl?.versions ?? []).map((v) => <option key={v.version} value={String(v.version)}>v{v.version}{v.active ? ' (active)' : ''}</option>)}
                        </select>
                      </label>
                      <label>
                        Treatment Profile
                        <select value={newExperiment.treatmentProfile} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentProfile: e.target.value, treatmentProfileVersion: '' }))}>
                          <option value="">Select a profile…</option>
                          {profileOptions.map((p) => <option key={p.profileName} value={p.profileName}>{p.profileName}</option>)}
                        </select>
                        <select value={newExperiment.treatmentProfileVersion} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentProfileVersion: e.target.value }))} style={{ marginTop: 'var(--space-1)' }}>
                          <option value="">Active version{trt?.activeVersion != null ? ` (v${trt.activeVersion})` : ''}</option>
                          {(trt?.versions ?? []).map((v) => <option key={v.version} value={String(v.version)}>v{v.version}{v.active ? ' (active)' : ''}</option>)}
                        </select>
                      </label>
                    </>
                  );
                })()}
              </>
            ) : (
              <>
                <label>
                  Control {showImageGenModels ? 'Image Model' : 'Model'}
                  {showImageGenModels ? (
                    <select value={newExperiment.controlImageGenModelKey} onChange={(e) => setNewExperiment((p) => ({ ...p, controlImageGenModelKey: e.target.value }))}>
                      <option value="">Select an image model…</option>
                      {IMAGE_GEN_MODEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  ) : (
                    <select value={newExperiment.controlModel} onChange={(e) => setNewExperiment((p) => ({ ...p, controlModel: e.target.value }))}>
                      {MODEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  )}
                </label>
                <label>
                  Treatment {showImageGenModels ? 'Image Model' : 'Model'}
                  {showImageGenModels ? (
                    <select value={newExperiment.treatmentImageGenModelKey} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentImageGenModelKey: e.target.value }))}>
                      <option value="">Select an image model…</option>
                      {IMAGE_GEN_MODEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  ) : (
                    <select value={newExperiment.treatmentModel} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentModel: e.target.value }))}>
                      {MODEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  )}
                </label>
                {showImageGenModels && (
                  <p className="admin-field-hint" style={{ gridColumn: '1 / -1' }}>
                    Each variant is a different image model; normal traffic serves the assigned variant's
                    image model, and a battle runs both and scores them. Text turns and any battle rebuttal
                    use the profile's normal model.
                  </p>
                )}
              </>
            )}
            <label>
              Traffic Split (Control %)
              <input
                type="range"
                min="10"
                max="90"
                step="10"
                value={newExperiment.controlWeight}
                onChange={(e) => setNewExperiment((p) => ({ ...p, controlWeight: Number(e.target.value) }))}
              />
              <span>{newExperiment.controlWeight}% / {100 - newExperiment.controlWeight}%</span>
            </label>
            <div>
              <span>Tiers</span>
              <div className="admin-filter-group">
                {TIER_OPTIONS.map((tier) => (
                  <button
                    key={tier}
                    className={`admin-filter-btn ${newExperiment.tiers.includes(tier) ? 'active' : ''}`}
                    onClick={() => toggleTier(tier)}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            </div>
            <label>
              End Date
              <input
                type="date"
                value={newExperiment.endDate}
                onChange={(e) => setNewExperiment((p) => ({ ...p, endDate: e.target.value }))}
              />
              <span className="admin-field-hint">Optional. Starts today; defaults to open-ended.</span>
            </label>
          </div>

          {/* Objective block (§1.4): the written decision this test informs is REQUIRED; the
              metric+target is the primary quantitative criterion; guardrails pre-register the
              ship rule. The objective is advisory — it frames the decision, never auto-acts. */}
          <fieldset className="admin-section experiment-objective-block" style={{ marginTop: '12px' }}>
            <legend>
              Objective
              <InfoTooltip
                label="About the objective"
                content="State the decision this test will inform (required). The primary metric + target is the quantitative bar to ship; guardrails are metrics that must not regress. All advisory — nothing auto-promotes."
              />
            </legend>
            <label style={{ display: 'block' }}>
              What decision will this test inform? <span aria-hidden="true">*</span>
              <textarea
                className="textarea input"
                value={newExperiment.objectiveStatement}
                onChange={(e) => setNewExperiment((p) => ({ ...p, objectiveStatement: e.target.value }))}
                placeholder="e.g. Decide whether premium code-gen should move to Opus. Ship Opus only if it clearly improves code quality without blowing up cost."
                maxLength={500}
                rows={3}
                required
              />
              <span className="admin-field-hint">Required. The hypothesis / ship-criteria in prose (max 500 chars).</span>
            </label>
            <div className="admin-form-grid">
              <label>
                Primary metric
                <select
                  value={newExperiment.objectiveMetric}
                  onChange={(e) => setNewExperiment((p) => ({ ...p, objectiveMetric: e.target.value as ObjectiveMetric }))}
                >
                  <option value="cost">Cost (% decrease)</option>
                  {newExperiment.experimentType === 'classification'
                    ? <option value="accuracy">Accuracy (% target)</option>
                    : <option value="quality">Quality (% target)</option>}
                  <option value="latency">Latency (% decrease)</option>
                </select>
              </label>
              <label>
                Target (%)
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={newExperiment.objectiveTarget}
                  onChange={(e) => setNewExperiment((p) => ({ ...p, objectiveTarget: e.target.value }))}
                  placeholder="e.g. 8"
                />
              </label>
            </div>

            {/* Guardrails repeater (optional, ≤3): metrics that must NOT regress for a ship. */}
            <div className="experiment-guardrails">
              <div className="experiment-guardrails-head">
                <span>Guardrails <span className="admin-field-hint">(optional — metrics that must not regress)</span></span>
                {newExperiment.guardrails.length < 3 && (
                  <button
                    type="button"
                    className="admin-inline-btn"
                    // Pre-fill the accuracy margin. A guardrail's bound is a NON-INFERIORITY margin
                    // ("no worse than this"), and an operator asked to invent one from a blank field
                    // has no basis for a number. DEFAULT_ACCURACY_MARGIN_PCT is the platform's stated
                    // answer; it stays editable, and whatever is submitted is what applies.
                    onClick={() => setNewExperiment((p) => ({
                      ...p,
                      guardrails: [
                        ...p.guardrails,
                        { metric: '', direction: 'no_worse_than', bound: String(DEFAULT_ACCURACY_MARGIN_PCT) },
                      ],
                    }))}
                  >
                    + Add guardrail
                  </button>
                )}
              </div>
              {newExperiment.guardrails.map((gr, i) => (
                <div className="experiment-guardrail-row admin-form-grid" key={i}>
                  <label>
                    Metric
                    <select
                      value={gr.metric}
                      onChange={(e) => setNewExperiment((p) => {
                        const guardrails = [...p.guardrails];
                        guardrails[i] = { ...guardrails[i], metric: e.target.value as '' | ObjectiveMetric };
                        return { ...p, guardrails };
                      })}
                    >
                      <option value="">Select…</option>
                      <option value="cost">Cost</option>
                      <option value="latency">Latency</option>
                      <option value="quality">Quality</option>
                      <option value="accuracy">Accuracy</option>
                    </select>
                  </label>
                  <label>
                    Rule
                    <select
                      value={gr.direction}
                      onChange={(e) => setNewExperiment((p) => {
                        const guardrails = [...p.guardrails];
                        guardrails[i] = { ...guardrails[i], direction: e.target.value as 'no_worse_than' | 'at_least' };
                        return { ...p, guardrails };
                      })}
                    >
                      <option value="no_worse_than">No worse than (regression cap)</option>
                      <option value="at_least">At least (improvement floor)</option>
                    </select>
                  </label>
                  <label>
                    Bound (%)
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={gr.bound}
                      placeholder="e.g. 25"
                      onChange={(e) => setNewExperiment((p) => {
                        const guardrails = [...p.guardrails];
                        guardrails[i] = { ...guardrails[i], bound: e.target.value };
                        return { ...p, guardrails };
                      })}
                    />
                  </label>
                  <button
                    type="button"
                    className="admin-inline-btn danger"
                    style={{ alignSelf: 'end' }}
                    onClick={() => setNewExperiment((p) => ({ ...p, guardrails: p.guardrails.filter((_, j) => j !== i) }))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </fieldset>

          {/* /battle (SPEC-BATTLE.md): Battle Mode controls.
              When enabled, this experiment can power /battle. The
              variant-pair "VS" card is the visual that sells the
              feature — two persona chips with a monospace amber
              VS between them. */}
          <div className="experiment-battle-toggle">
            <label className="experiment-battle-toggle-row">
              <input
                type="checkbox"
                checked={newExperiment.battleEnabled}
                onChange={(e) => setNewExperiment((p) => ({ ...p, battleEnabled: e.target.checked }))}
              />
              <span className="experiment-battle-toggle-label">
                Enable for <strong>/battle</strong>
              </span>
              <span className="status-badge">premium-only</span>
            </label>
            <p className="experiment-battle-toggle-help">
              Battle is an engagement option on this A/B experiment, not a separate path: both variants
              answer every /battle prompt through the same request engine users hit (same intents, profile
              models, and tools) instead of the experiment probabilistically serving one. Round 1 races both
              answers at once; in round 2 each variant posts a short rebuttal on the other's answer, and an
              inline scorecard closes each battle. Battle stays on until an admin or the experiment owner turns
              it off, and channel moderators opt a channel in.
            </p>
          </div>

          {newExperiment.battleEnabled && (
            <div className="experiment-battle-card">
              <div className="experiment-battle-header">
                <span className="status-badge status-badge--live">Battle Mode</span>
                <span className="experiment-battle-header-title">Side-by-side variant duel</span>
              </div>

              <div className="experiment-battle-variants">
                <div className="experiment-battle-variant">
                  <span className="experiment-battle-variant-label">A · CONTROL</span>
                  <input
                    type="text"
                    className="input experiment-battle-variant-name"
                    value={newExperiment.controlDisplayName}
                    onChange={(e) => setNewExperiment((p) => ({ ...p, controlDisplayName: e.target.value }))}
                    placeholder="Display name (e.g. Atlas)"
                    maxLength={16}
                  />
                  <span className="experiment-battle-variant-model">
                    {showImageGenModels ? (newExperiment.controlImageGenModelKey || 'no image model') : newExperiment.controlModel}
                  </span>
                  <textarea
                    className="textarea input experiment-battle-variant-addendum"
                    value={newExperiment.controlAddendum}
                    onChange={(e) => setNewExperiment((p) => ({ ...p, controlAddendum: e.target.value }))}
                    placeholder="System prompt addendum (style, persona — optional, max 500 chars)"
                    maxLength={500}
                    rows={3}
                  />
                </div>

                <div className="experiment-battle-vs" aria-hidden="true">VS</div>

                <div className="experiment-battle-variant">
                  <span className="experiment-battle-variant-label">B · TREATMENT</span>
                  <input
                    type="text"
                    className="input experiment-battle-variant-name"
                    value={newExperiment.treatmentDisplayName}
                    onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentDisplayName: e.target.value }))}
                    placeholder="Display name (e.g. Echo)"
                    maxLength={16}
                  />
                  <span className="experiment-battle-variant-model">
                    {showImageGenModels ? (newExperiment.treatmentImageGenModelKey || 'no image model') : newExperiment.treatmentModel}
                  </span>
                  <textarea
                    className="textarea input experiment-battle-variant-addendum"
                    value={newExperiment.treatmentAddendum}
                    onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentAddendum: e.target.value }))}
                    placeholder="System prompt addendum (style, persona — optional, max 500 chars)"
                    maxLength={500}
                    rows={3}
                  />
                </div>
              </div>

              {showImageGenModels && (
                <p className="experiment-battle-toggle-help">
                  Image battle: this experiment's two image models (set above) run head to head - each
                  generates an image in round 1, then critiques the rival's image in the round-2 rebuttal.
                </p>
              )}

              <div className="experiment-battle-slot">
                <label className="label" htmlFor="alt-bot-slot-select">Alt-bot slot</label>
                <select
                  id="alt-bot-slot-select"
                  className="select input"
                  value={newExperiment.altBotSlotId}
                  onChange={(e) => setNewExperiment((p) => ({ ...p, altBotSlotId: e.target.value }))}
                >
                  <option value="slot-0">slot-0</option>
                  <option value="slot-1">slot-1</option>
                </select>
                <p className="experiment-battle-slot-help">
                  Pre-provisioned alt-bot principal that will join battle-enabled channels as a member.
                  Each slot can be bound to at most one active battle experiment at a time.
                </p>
              </div>
            </div>
          )}

          <button className="admin-inline-btn" onClick={handleCreate} style={{ marginTop: '12px' }}>
            Create & Activate
          </button>
        </div>
      )}

      <div className="admin-section">
        {/* "Experiments", not "Active Experiments": this table lists every non-deleted experiment
            regardless of state, and the old heading asserted otherwise on a list that is mostly
            completed rows. The ACTIVE count now says the live number, and it is a filter. */}
        <h4>Experiments</h4>
        <div className="admin-filter-group experiments-status-filter">
          {(['all', 'active', 'paused', 'draft', 'completed'] as const).map((s) => {
            const n = s === 'all' ? visibleExperiments.length : visibleExperiments.filter((e) => e.status === s).length;
            return (
              <button
                key={s}
                type="button"
                className={`admin-filter-btn${statusFilter === s ? ' active' : ''}${s === 'active' && n > 0 ? ' is-live' : ''}`}
                aria-pressed={statusFilter === s}
                onClick={() => setStatusFilter(s)}
              >
                {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
                <span className="admin-filter-count">{n}</span>
              </button>
            );
          })}
        </div>
        <DataTable
          columns={[
            { key: 'experimentId', label: 'Experiment' },
            { key: 'experimentType', label: 'Type', render: (v) => (v ? String(v) : 'intent') },
            { key: 'intent', label: 'Intent', render: (v) => (v ? String(v) : '—') },
            { key: 'status', label: 'Status' },
            { key: 'tiers', label: 'Tiers', render: (v) => Array.isArray(v) ? (v as string[]).join(', ') : String(v) },
            {
              key: 'variants',
              label: 'Variants',
              render: (v) => {
                const variants = v as ExperimentVariant[];
                return Array.isArray(variants)
                  ? variants.map((vt) => `${vt.variantId}: ${vt.modelKey} (${vt.weight}%)`).join(' | ')
                  : '';
              },
            },
            { key: 'startDate', label: 'Started', render: (v) => v ? new Date(String(v)).toLocaleDateString() : '--' },
            {
              key: 'actions',
              label: 'Actions',
              sortable: false,
              render: (_v, row) => {
                const exp = row as Experiment;
                return (
                  <div className="admin-inline-actions">
                    <button
                      className="admin-inline-btn"
                      title="Open this experiment's results"
                      onClick={() => setSelectedExperimentId(exp.experimentId)}
                    >
                      View results
                    </button>
                    {exp.status === 'active' && (
                      <button className="admin-inline-btn" onClick={() => handleStatusChange(exp.experimentId, 'paused')}>
                        Pause
                      </button>
                    )}
                    {exp.status === 'paused' && (
                      <button className="admin-inline-btn" onClick={() => handleStatusChange(exp.experimentId, 'active')}>
                        Resume
                      </button>
                    )}
                    {(exp.status === 'active' || exp.status === 'paused') && (
                      // End (not a bare Complete): a test that ran prompts a decision on close (§3.2.1).
                      <button
                        className="admin-inline-btn danger"
                        onClick={() => setConfirm({ kind: 'end', exp, ran: exp.status !== 'draft', decision: 'no_decision', note: '' })}
                      >
                        End
                      </button>
                    )}
                    {exp.status !== 'deleted' && (
                      <button
                        className="admin-inline-btn danger"
                        onClick={() => setConfirm({ kind: 'delete', exp, ran: exp.status !== 'draft', decision: 'no_decision', note: '' })}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                );
              },
            },
          ]}
          data={statusFilter === 'all' ? visibleExperiments : visibleExperiments.filter((e) => e.status === statusFilter)}
          emptyMessage={
            statusFilter === 'all'
              ? 'No experiments configured. Create one to start comparing models.'
              : `No ${statusFilter} experiments. Clear the filter to see all ${visibleExperiments.length}.`
          }
        />
      </div>

      {/*
        Honest-empty banner: in Athena mode `experiment_results` returns
        unsupported, so the comparison view would be permanently empty
        without explanation. Render the banner so the user sees WHY.
      */}
      {resultsData?.unsupported ? (
        <UnsupportedAnalyticsBanner result={resultsData} />
      ) : (
        <ExperimentResults
          resultsData={resultsData}
          experiments={experiments}
          selectedExperimentId={selectedExperimentId}
          onClearSelection={() => setSelectedExperimentId(null)}
          onOpenConversation={onOpenConversation}
        />
      )}
    </div>
  );
};

// ============================================================
// Results comparison view (decision-oriented)
// ============================================================

// Last-resort floor, used ONLY when the backend has not reported its own. The floor is a deployment
// setting (minSamplePerVariant, default 5), so a hardcoded number here eventually contradicts the
// verdict rendered beside it: bannering "below 30 exchanges - directional, not decisive" while the
// backend has already returned a real verdict, or prescribing "need ~N more" against a threshold it
// does not apply. Prefer the floor the recommendation reports wherever one is in hand.
const MIN_SAMPLE_FALLBACK = 30;

interface VariantAgg {
  variant_id: string;
  model_name: string;
  exchange_count: number;
  /** Exchanges an evaluator scored. Shown beside the sample because avg_score counts an unscored
   *  exchange as zero, so the two numbers together say how much of the mean is quality and how much
   *  is scoring coverage. */
  scored_count: number;
  task_count: number;
  avg_score: number | null;
  avg_total_ms: number | null;
  avg_cost_usd: number | null;
  compliance_rate: number | null;
  fallback_rate: number | null;
  task_completion_rate: number | null;
  // Thumbs join: variant total counts +
  // approval %. Separate from avg_score; approval_rate null = no ratings yet.
  feedback_count: number;
  approval_rate: number | null;
  // /battle wins for this variant; null = no picks yet.
  battle_wins: number | null;
  /** Backend's verdict on whether this variant is below the deployment's configured sample floor. */
  needs_more_data: boolean;
}

interface ExperimentGroup {
  experimentId: string;
  intent: string;
  tier: string;
  control?: VariantAgg;
  treatment?: VariantAgg;
  others: VariantAgg[];
}

/** Weighted aggregate of a variant's rows (by exchange_count), null-aware. */
function aggregateVariant(rows: ExperimentResultRow[]): VariantAgg {
  let wScore = 0, wLat = 0, wCost = 0, wComp = 0, wFb = 0, wTask = 0;
  let exch = 0, scored = 0, taskCount = 0;
  let scoreN = 0, latN = 0, costN = 0, compN = 0, fbN = 0, taskN = 0;
  // Thumbs + battle wins are raw counts at the (variant,intent) row grain — sum
  // straight to the variant total, then derive approval % from the totals.
  let thumbsUp = 0, fbCount = 0, battleWins = 0;
  for (const r of rows) {
    const n = Number(r.exchange_count) || 0;
    exch += n;
    // A count of scored exchanges, so it sums straight across the rows and is never weighted.
    scored += Number(r.scored_count) || 0;
    taskCount += Number(r.task_count) || 0;
    thumbsUp += Number(r.thumbs_up) || 0;
    fbCount += Number(r.feedback_count) || 0;
    battleWins += Number(r.battle_wins) || 0;
    const acc = (val: number | null, sum: number, wn: number): [number, number] =>
      val == null ? [sum, wn] : [sum + val * n, wn + n];
    [wScore, scoreN] = acc(r.avg_score, wScore, scoreN);
    [wLat, latN] = acc(r.avg_total_ms, wLat, latN);
    [wCost, costN] = acc(r.avg_cost_usd, wCost, costN);
    [wComp, compN] = acc(r.compliance_rate, wComp, compN);
    [wFb, fbN] = acc(r.fallback_rate, wFb, fbN);
    [wTask, taskN] = acc(r.task_completion_rate, wTask, taskN);
  }
  const avg = (sum: number, wn: number, dp = 1): number | null =>
    wn === 0 ? null : Math.round((sum / wn) * 10 ** dp) / 10 ** dp;
  return {
    variant_id: rows[0]?.variant_id ?? 'unknown',
    model_name: rows[0]?.model_name ?? 'unknown',
    exchange_count: exch,
    scored_count: scored,
    task_count: taskCount,
    avg_score: avg(wScore, scoreN),
    avg_total_ms: avg(wLat, latN, 0),
    avg_cost_usd: avg(wCost, costN, 6),
    compliance_rate: avg(wComp, compN),
    fallback_rate: avg(wFb, fbN),
    task_completion_rate: avg(wTask, taskN),
    feedback_count: fbCount,
    approval_rate: fbCount > 0 ? Math.round((thumbsUp / fbCount) * 1000) / 10 : null,
    battle_wins: battleWins > 0 ? battleWins : null,
    // THE BACKEND'S FLAG, RE-AGGREGATED AT THE SAME GRAIN AS THE COUNT (CR-14).
    //
    // `needs_more_data` is computed per (variant, intent, tier) ROW - `n < MIN_SAMPLE_PER_VARIANT` on
    // that slice - while this function SUMS `exchange_count` across those rows, and the backend's own
    // verdict gates on the summed total. OR-ing the per-slice flags therefore contradicted the verdict
    // rendered beside it: a variant with 4 intents x 4 exchanges is 16 against a floor of 5, which the
    // recommendation calls sufficient, while every individual row was under the floor and the banner
    // said "below this deployment's sample floor - directional, not decisive". Exactly the
    // console-vs-backend contradiction the flag was carried through to prevent, inverted.
    //
    // `every` rather than `some`: the variant is thin only when NO slice reached the floor, which is the
    // closest statement about the whole that per-slice flags can support. It cannot be derived exactly
    // without the floor itself, and this function is pure and floor-less by design - the consumer that
    // holds `minSamplePerVariant` is where an exact comparison belongs.
    needs_more_data: rows.length > 0 && rows.every((r) => r.needs_more_data),
  };
}

function groupExperiments(rows: ExperimentResultRow[]): ExperimentGroup[] {
  const byExp = new Map<string, ExperimentResultRow[]>();
  for (const r of rows) {
    const arr = byExp.get(r.experiment_id) || [];
    arr.push(r);
    byExp.set(r.experiment_id, arr);
  }
  return Array.from(byExp.entries()).map(([experimentId, expRows]) => {
    const byVariant = new Map<string, ExperimentResultRow[]>();
    for (const r of expRows) {
      const arr = byVariant.get(r.variant_id) || [];
      arr.push(r);
      byVariant.set(r.variant_id, arr);
    }
    const aggs = Array.from(byVariant.values()).map(aggregateVariant);
    return {
      experimentId,
      intent: expRows[0]?.intent ?? 'unknown',
      tier: expRows[0]?.agent_type ?? '',
      control: aggs.find((a) => a.variant_id === 'control'),
      treatment: aggs.find((a) => a.variant_id === 'treatment'),
      others: aggs.filter((a) => a.variant_id !== 'control' && a.variant_id !== 'treatment'),
    };
  });
}

type MetricKey = keyof Pick<
  VariantAgg,
  'task_completion_rate' | 'avg_score' | 'approval_rate' | 'battle_wins' | 'avg_total_ms' | 'avg_cost_usd' | 'compliance_rate' | 'fallback_rate'
>;

const METRICS: { key: MetricKey; label: string; higherIsBetter: boolean; headline?: boolean; fmt: (v: number | null) => string }[] = [
  { key: 'task_completion_rate', label: 'Task completion', higherIsBetter: true, headline: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
  { key: 'avg_score', label: 'Quality', higherIsBetter: true, headline: true, fmt: (v) => (v == null ? '—' : `${v}`) },
  // Human signal, separate from the evaluator's Quality. '—' when no ratings yet.
  { key: 'approval_rate', label: 'User approval', higherIsBetter: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
  // /battle head-to-head wins — the fast human-preference signal. '—' when no battles ran.
  { key: 'battle_wins', label: 'Battle wins', higherIsBetter: true, fmt: (v) => (v == null ? '—' : `${v}`) },
  { key: 'avg_total_ms', label: 'Latency', higherIsBetter: false, fmt: (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()} ms`) },
  { key: 'avg_cost_usd', label: 'Est. cost / reply', higherIsBetter: false, fmt: (v) => (v == null ? '—' : `$${v.toFixed(4)}`) },
  { key: 'compliance_rate', label: 'Compliance', higherIsBetter: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
  { key: 'fallback_rate', label: 'Fallback', higherIsBetter: false, fmt: (v) => (v == null ? '—' : `${v}%`) },
];

/** -1 control better, 1 treatment better, 0 tie/unknown. */
function winner(a: number | null, b: number | null, higherIsBetter: boolean): -1 | 0 | 1 {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a === b) return 0;
  const aBetter = higherIsBetter ? a > b : a < b;
  return aBetter ? -1 : 1;
}

// Verdict labels (§4.4). String-keyed + a tolerant getter so the widened union
// ('keep_control', 'equivalent', …) renders without pinning to an exact enum shape.
const VERDICT_META: Record<string, { label: string; tone: string }> = {
  promote_treatment: { label: 'Promote treatment', tone: 'win' },
  keep_control: { label: 'Keep control', tone: 'hold' },
  promote_control: { label: 'Keep control', tone: 'hold' }, // legacy alias
  keep_running: { label: 'Keep running', tone: 'wait' },
  equivalent: { label: 'Equivalent (no winner)', tone: 'wait' },
  inconclusive: { label: 'Inconclusive', tone: 'wait' },
};
function verdictMeta(verdict: string): { label: string; tone: string } {
  return VERDICT_META[verdict] ?? { label: verdict, tone: 'wait' };
}

function ExperimentResults({
  resultsData,
  experiments,
  selectedExperimentId,
  onClearSelection,
  onOpenConversation,
}: {
  resultsData: AnalyticsResult | null;
  experiments: Experiment[];
  selectedExperimentId?: string | null;
  onClearSelection?: () => void;
  onOpenConversation?: (channelArn: string) => void;
}) {
  const [includeBattle, setIncludeBattle] = useState(false);
  const [overrideRows, setOverrideRows] = useState<ExperimentResultRow[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [recos, setRecos] = useState<Record<string, { loading: boolean; data?: ExperimentRecommendation; error?: string }>>({});

  // Objective lives on the Experiment record; the per-variant metrics
  // come from the analytics rows. Join them by id so the comparison can show
  // progress toward the advisory target.
  const objectivesById = useMemo(
    () => new Map(experiments.map((e) => [e.experimentId, e.objective])),
    [experiments],
  );

  // The comparison view needs a date range for on-demand calls; mirror the
  // 30-day default the dashboard uses. (Last 30 days, computed at mount.)
  const dateRange: AnalyticsDateRange = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, []);

  const baseRows = (resultsData?.data as unknown as ExperimentResultRow[]) ?? [];
  const rows = overrideRows ?? baseRows;
  const allGroups = useMemo(() => groupExperiments(rows), [rows]);
  // #8: when an experiment is selected from the table, focus its comparison only.
  const groups = selectedExperimentId
    ? allGroups.filter((g) => g.experimentId === selectedExperimentId)
    : allGroups;

  // Battle-scoped effectiveness (SPEC-BATTLE): the backend returns per-variant metrics from the
  // BATTLE turns ONLY, alongside (and kept out of) the probabilistic A/B `data` rollup. Bucket
  // them by experiment so each comparison can render its own "Battle results" section. Always read
  // from the base response (independent of the include-battle A/B toggle, which only re-fetches `data`).
  const battleByExp = useMemo(() => {
    const rowsIn = resultsData?.battleEffectiveness?.data ?? [];
    const m = new Map<string, BattleEffectivenessRow[]>();
    for (const r of rowsIn) {
      const arr = m.get(r.experiment_id) || [];
      arr.push(r);
      m.set(r.experiment_id, arr);
    }
    return m;
  }, [resultsData]);
  const expById = useMemo(() => new Map(experiments.map((e) => [e.experimentId, e])), [experiments]);
  // A battle-only experiment (battle turns, no probabilistic traffic yet) has no A/B group, so its
  // battle metrics would otherwise never render; surface those as standalone battle blocks too.
  const orphanBattleIds = Array.from(battleByExp.keys())
    .filter((id) => !allGroups.some((g) => g.experimentId === id))
    .filter((id) => !selectedExperimentId || id === selectedExperimentId);

  async function toggleBattle(next: boolean) {
    setIncludeBattle(next);
    if (!next) {
      setOverrideRows(null);
      return;
    }
    setFetching(true);
    try {
      const res = await queryAnalytics('experiment_results', dateRange, { includeBattle: 'true' });
      setOverrideRows((res.data as unknown as ExperimentResultRow[]) ?? []);
    } catch {
      setOverrideRows([]);
    } finally {
      setFetching(false);
    }
  }

  async function loadReco(experimentId: string) {
    setRecos((p) => ({ ...p, [experimentId]: { loading: true } }));
    try {
      // Send the experiment's OWN objective + recorded decision. The backend reads both from the
      // request (it never re-reads the record), so omitting them silently evaluated every experiment
      // against a quality-primary default with no guardrails and no power check.
      const exp = expById.get(experimentId);
      const data = await getExperimentRecommendation(experimentId, dateRange, {
        objective: exp?.objective,
        decision: exp?.decision,
      });
      setRecos((p) => ({ ...p, [experimentId]: { loading: false, data } }));
    } catch (e) {
      setRecos((p) => ({ ...p, [experimentId]: { loading: false, error: e instanceof Error ? e.message : 'Failed to load recommendation' } }));
    }
  }

  return (
    <div className="admin-section exp-results">
      <div className="exp-results-head">
        <div>
          <h4>
            {selectedExperimentId ? `Experiment Results — ${selectedExperimentId}` : 'Experiment Results'}
          </h4>
          <p className="admin-tab-description">
            {selectedExperimentId
              ? 'Focused on one experiment. '
              : 'Which variant should ship — quality, task completion, latency, and cost, side by side.'}
            {selectedExperimentId && onClearSelection && (
              <button className="admin-inline-btn" onClick={onClearSelection}>
                ← All experiments
              </button>
            )}
          </p>
        </div>
        {/* This toggle MERGES battle turns into the probabilistic metric averages. That is a
            statistical trade, not a display preference: a battle variant is CHOSEN by the operator
            rather than randomly assigned, so folding those turns into the A/B comparison biases it.
            Off by default for that reason, and the label now says the consequence — the old copy
            ("Include battle traffic", tooltip "excluded by default") stated the behaviour without the
            reason, which reads as an arbitrary default worth flipping.
            Human picks do NOT need this: they render alongside as their own axis regardless. */}
        <label
          className="exp-results-toggle"
          title={
            'Off (default): battle turns are excluded, so the A/B metric comparison only measures randomly '
            + 'assigned traffic. On: battle turns are folded into the metric averages — a battle variant is '
            + 'chosen, not randomly assigned, so this BIASES the comparison. Human picks are reported '
            + 'separately either way.'
          }
        >
          <input type="checkbox" checked={includeBattle} onChange={(e) => toggleBattle(e.target.checked)} />
          <span>Merge battle turns into metrics (biases the A/B read)</span>
        </label>
      </div>

      {fetching && <p className="admin-tab-description">Loading…</p>}

      {!fetching && groups.length === 0 && (
        <p className="admin-tab-description">
          {selectedExperimentId
            ? 'No results yet for this experiment. Data appears once conversations flow through it (Aurora mode).'
            : 'No experiment data yet. Results appear once conversations flow through an active experiment (Aurora mode).'}
        </p>
      )}

      {groups.map((g) => (
        <ExperimentComparison
          key={g.experimentId}
          group={g}
          objective={objectivesById.get(g.experimentId) ?? undefined}
          reco={recos[g.experimentId]}
          onRecommend={() => loadReco(g.experimentId)}
          battleRows={battleByExp.get(g.experimentId) ?? []}
          experiment={expById.get(g.experimentId)}
          dateRange={dateRange}
          includeBattle={includeBattle}
          onOpenConversation={onOpenConversation}
        />
      ))}

      {/* Battle-only experiments (no probabilistic A/B group yet) still get their battle scorecard. */}
      {orphanBattleIds.map((id) => (
        <div className="exp-compare" key={`battle-${id}`}>
          <div className="exp-compare-head">
            <div className="exp-compare-title">
              <span className="exp-compare-id">{id}</span>
              <span className="exp-compare-meta">battle turns only · no probabilistic traffic yet</span>
            </div>
          </div>
          <BattleResults rows={battleByExp.get(id) ?? []} experiment={expById.get(id)} />
        </div>
      ))}
    </div>
  );
}

// ── Advisory objective progress ──────────────
// Treatment-vs-control against the target. Advisory only: it frames the
// decision, never auto-acts. 'pending' when the signal isn't available yet
// (cost/latency need both estimates; quality needs evaluator scores; accuracy
// needs the classifier-accuracy eval, which isn't built — always pending here).

type ObjectiveStatus = 'met' | 'not_met' | 'pending';

interface ObjectiveProgress {
  label: string;
  currentText: string;
  status: ObjectiveStatus;
  note?: string;
}

export function evaluateObjective(
  objective: ExperimentObjective,
  control: VariantAgg,
  treatment: VariantAgg,
): ObjectiveProgress {
  const { metric, target } = objective;

  if (metric === 'cost' || metric === 'latency') {
    const key = metric === 'cost' ? 'avg_cost_usd' : 'avg_total_ms';
    const label = `${metric === 'cost' ? 'Cost' : 'Latency'} −${target}% target`;
    const c = control[key];
    const t = treatment[key];
    if (c == null || t == null || c === 0) {
      return { label, currentText: '—', status: 'pending', note: 'awaiting enough data' };
    }
    const pctDecrease = ((c - t) / c) * 100; // positive ⇒ treatment cheaper/faster
    const sign = pctDecrease >= 0 ? '−' : '+';
    return {
      label,
      currentText: `${sign}${Math.abs(pctDecrease).toFixed(0)}% vs control`,
      status: pctDecrease >= target ? 'met' : 'not_met',
    };
  }

  if (metric === 'quality') {
    const label = `Quality ≥${target}% target`;
    const t = treatment.avg_score;
    if (t == null) {
      return { label, currentText: '—', status: 'pending', note: 'awaiting evaluator scores' };
    }
    return { label, currentText: `${t} (treatment score)`, status: t >= target ? 'met' : 'not_met' };
  }

  // accuracy — the classifier-accuracy eval (judge agreement + thumbs) isn't built yet.
  return {
    label: `Accuracy ≥${target}% target`,
    currentText: '—',
    status: 'pending',
    note: 'classifier-accuracy measurement pending',
  };
}

// Guardrail progress (§1.4/§4.2): a directional, advisory pass/fail from the current aggregates —
// held (treatment within the pre-registered bound), breached (regressed past it), or pending (no
// signal yet). Significance is NOT asserted here; the recommendation card is where the stat-gated
// verdict lives. Mirrors evaluateObjective's null/pending discipline (INV-3).
type GuardrailStatus = 'held' | 'breached' | 'pending';
interface GuardrailProgress {
  label: string;
  currentText: string;
  status: GuardrailStatus;
}

function evaluateGuardrail(
  guardrail: ObjectiveGuardrail,
  control: VariantAgg,
  treatment: VariantAgg,
): GuardrailProgress {
  const { metric, direction, bound } = guardrail;
  const metricName = metric.charAt(0).toUpperCase() + metric.slice(1);
  const label =
    direction === 'no_worse_than' ? `${metricName} no worse than ${bound}%` : `${metricName} at least +${bound}%`;

  if (metric === 'accuracy') {
    return { label, currentText: '—', status: 'pending' };
  }
  const higherIsBetter = metric === 'quality';
  const key = metric === 'cost' ? 'avg_cost_usd' : metric === 'latency' ? 'avg_total_ms' : 'avg_score';
  const c = control[key];
  const t = treatment[key];
  if (c == null || t == null || c === 0) {
    return { label, currentText: '—', status: 'pending' };
  }
  // improvementPct > 0 ⇒ treatment is better on this metric (cheaper/faster, or higher quality).
  const improvementPct = higherIsBetter ? ((t - c) / c) * 100 : ((c - t) / c) * 100;
  const held = direction === 'no_worse_than' ? -improvementPct <= bound : improvementPct >= bound;
  return {
    label,
    currentText: `${improvementPct >= 0 ? '+' : ''}${improvementPct.toFixed(0)}% vs control`,
    status: held ? 'held' : 'breached',
  };
}

function ObjectiveBanner({
  objective,
  control,
  treatment,
}: {
  objective: ExperimentObjective;
  control: VariantAgg;
  treatment: VariantAgg;
}) {
  const p = evaluateObjective(objective, control, treatment);
  const badge = p.status === 'met' ? 'On track' : p.status === 'not_met' ? 'Off target' : 'Pending';
  const guardrails = objective.guardrails ?? [];
  return (
    <div className="exp-objective" data-status={p.status}>
      {objective.statement && <p className="exp-objective-statement">{objective.statement}</p>}
      <div className="exp-objective-primary">
        <span className="exp-objective-label">Objective · {p.label}</span>
        <span className="exp-objective-current">{p.currentText}</span>
        <span className="exp-objective-badge">{badge}</span>
        {guardrails.map((gr, i) => {
          const g = evaluateGuardrail(gr, control, treatment);
          return (
            <span className="exp-objective-guardrail" data-status={g.status} key={i} title={g.currentText}>
              {g.label}: {g.status === 'held' ? 'held' : g.status === 'breached' ? 'breached' : 'pending'}
            </span>
          );
        })}
        <span className="exp-objective-tag">advisory · not auto-applied{p.note ? ` · ${p.note}` : ''}</span>
      </div>
    </div>
  );
}

/**
 * The "show the N this number came from" affordance, beside one aggregate.
 *
 * MODULE SCOPE, deliberately. Defined inside `ExperimentComparison` it was a NEW component type on
 * every render, so React unmounted and remounted all six buttons on each poll refresh - losing focus
 * mid-interaction - and `react-hooks/static-components` failed the build as an error rather than a
 * warning. `drill` and `onOpen` are props for that reason: they are the only two things it needed
 * from the closure, and passing them is what lets the type be stable.
 */
function DrillButton({ axis, variantId, n, drill, onOpen }: {
  axis: DrillAxis;
  variantId: string;
  n: number | null;
  drill: DrillTarget | null;
  onOpen: (axis: DrillAxis, variantId: string) => void;
}) {
  if (!n) return null; // nothing recorded on this axis for this variant — a link would lead nowhere
  const open = drill?.axis === axis && drill?.variantId === variantId;
  return (
    <button
      className="admin-link-btn exp-drill-btn"
      aria-expanded={open}
      onClick={() => onOpen(axis, variantId)}
      title={`Show the ${AXES[axis].countLabel.toLowerCase()} this number is computed from`}
    >
      {open ? 'hide' : 'show'} {AXES[axis].countLabel.toLowerCase()}
    </button>
  );
}

function ExperimentComparison({
  group,
  objective,
  reco,
  onRecommend,
  battleRows,
  experiment,
  dateRange,
  includeBattle,
  onOpenConversation,
}: {
  group: ExperimentGroup;
  objective?: ExperimentObjective;
  reco?: { loading: boolean; data?: ExperimentRecommendation; error?: string };
  onRecommend: () => void;
  battleRows?: BattleEffectivenessRow[];
  experiment?: Experiment;
  dateRange: AnalyticsDateRange;
  /** Whether battle turns are folded into the figures below, so a drill-down reconciles against the
   *  SAME population the aggregate was computed from (CR-12). */
  includeBattle: boolean;
  onOpenConversation?: (channelArn: string) => void;
}) {
  const { control, treatment } = group;
  // ONE open drill at a time, holding the axis AND the variant. Both are needed: the aggregate a
  // drill-down checks itself against is a per-variant number, so an axis alone has nothing on screen
  // to reconcile with.
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const openDrill = (axis: DrillAxis, variantId: string) =>
    setDrill((d) =>
      d && d.axis === axis && d.variantId === variantId
        ? null
        : { experimentId: group.experimentId, axis, variantId },
    );

  /** What the console displays for this (axis, variant) — the figures the drill-down must reproduce. */
  const aggregateFor = (axis: DrillAxis, variantId: string): DrillAggregate => {
    const v = variantId === 'control' ? control : treatment;
    if (axis === 'approval') return { count: v?.feedback_count ?? null, mean: v?.approval_rate ?? null };
    if (axis === 'picks') return { count: v?.battle_wins ?? null, mean: null };
    if (axis === 'battle') {
      const b = (battleRows ?? []).find((r) => r.variant_id === variantId);
      return { count: b?.turn_count ?? null, mean: b?.avg_score ?? null };
    }
    return { count: v?.exchange_count ?? null, mean: v?.avg_score ?? null };
  };

  /** The per-variant "show me the evidence" control, rendered inside the metric cell it explains. */
  const totalN = (control?.exchange_count ?? 0) + (treatment?.exchange_count ?? 0);
  // The BACKEND's below-the-floor flag, not a local count against a hardcoded number. Comparing
  // locally produced a banner calling a verdict "directional, not decisive" while the backend had
  // judged the same data sufficient under the floor it actually applies. No hardcoded-count fallback
  // here on purpose: falling back would let a local number override a backend "sufficient" and restore
  // the contradiction this is fixing.
  //
  // WHEN THE RECOMMENDATION IS IN HAND, IT WINS OUTRIGHT. It reports the floor this deployment applies
  // (`minSamplePerVariant`) and has already judged the summed data against it, so an exact comparison is
  // available and the re-aggregated per-slice flag is only an approximation of it (see
  // `aggregateVariant`). Using the reco where it exists is what stops the banner and the verdict beside
  // it ever disagreeing.
  const recoFloor = reco?.data?.minSamplePerVariant;
  const thin = recoFloor != null
    ? Math.min(control?.exchange_count ?? 0, treatment?.exchange_count ?? 0) < recoFloor
    : Boolean(control?.needs_more_data && treatment?.needs_more_data);

  return (
    <div className="exp-compare">
      <div className="exp-compare-head">
        <div className="exp-compare-title">
          <span className="exp-compare-id">{group.experimentId}</span>
          <span className="exp-compare-meta">
            {group.intent}{group.tier ? ` · ${group.tier}` : ''} · {totalN.toLocaleString()} exchanges
          </span>
        </div>
        <button className="admin-inline-btn" onClick={onRecommend} disabled={reco?.loading}>
          {reco?.loading ? 'Analyzing…' : reco?.data ? 'Refresh recommendation' : 'Get recommendation'}
        </button>
      </div>

      {thin && (
        <div className="exp-thin-banner">
          A variant is below this deployment&rsquo;s sample floor — treat these numbers as directional, not decisive.
        </div>
      )}

      {objective && control && treatment && (
        <ObjectiveBanner objective={objective} control={control} treatment={treatment} />
      )}

      {control && treatment ? (
        <>
          <div className="exp-variant-row exp-variant-row--header">
            <VariantHeader variant={control} side="A" />
            <span className="exp-vs" aria-hidden="true">VS</span>
            <VariantHeader variant={treatment} side="B" />
          </div>

          {METRICS.map((m) => {
            const a = control[m.key];
            const b = treatment[m.key];
            const w = winner(a, b, m.higherIsBetter);
            return (
              <div className={`exp-metric-row${m.headline ? ' exp-metric-row--headline' : ''}`} key={m.key}>
                <span className={`exp-metric-val${w === -1 ? ' is-winner' : ''}`}>
                  {m.fmt(a)}
                  {m.key === 'avg_cost_usd' && a == null && <em className="exp-hint">no estimate</em>}
                  {m.key === 'approval_rate' && control.feedback_count > 0 && (
                    <em className="exp-hint">{control.feedback_count} rating{control.feedback_count === 1 ? '' : 's'}</em>
                  )}
                  {m.key === 'approval_rate' && <DrillButton drill={drill} onOpen={openDrill} axis="approval" variantId="control" n={control.feedback_count} />}
                  {m.key === 'battle_wins' && <DrillButton drill={drill} onOpen={openDrill} axis="picks" variantId="control" n={control.battle_wins} />}
                </span>
                <span className="exp-metric-label">{m.label}</span>
                <span className={`exp-metric-val${w === 1 ? ' is-winner' : ''}`}>
                  {m.fmt(b)}
                  {m.key === 'avg_cost_usd' && b == null && <em className="exp-hint">no estimate</em>}
                  {m.key === 'approval_rate' && treatment.feedback_count > 0 && (
                    <em className="exp-hint">{treatment.feedback_count} rating{treatment.feedback_count === 1 ? '' : 's'}</em>
                  )}
                  {m.key === 'approval_rate' && <DrillButton drill={drill} onOpen={openDrill} axis="approval" variantId="treatment" n={treatment.feedback_count} />}
                  {m.key === 'battle_wins' && <DrillButton drill={drill} onOpen={openDrill} axis="picks" variantId="treatment" n={treatment.battle_wins} />}
                </span>
              </div>
            );
          })}

          <div className="exp-metric-row exp-metric-row--sample">
            <span className="exp-metric-val">
              {control.exchange_count.toLocaleString()}
              <DrillButton drill={drill} onOpen={openDrill} axis="metrics" variantId="control" n={control.exchange_count} />
            </span>
            <span className="exp-metric-label">Sample (exchanges)</span>
            <span className="exp-metric-val">
              {treatment.exchange_count.toLocaleString()}
              <DrillButton drill={drill} onOpen={openDrill} axis="metrics" variantId="treatment" n={treatment.exchange_count} />
            </span>
          </div>

          {/* Traffic and evidence are different numbers. The quality mean counts an unscored exchange
              as zero, so a sample of 40 with 3 scored is mostly scoring coverage, and a quality
              verdict over nothing scored is no verdict at all. Stated rather than left to be inferred
              from a mean that looks low. */}
          <div className="exp-metric-row exp-metric-row--sample">
            <span className="exp-metric-val">{control.scored_count.toLocaleString()}</span>
            <span className="exp-metric-label">Scored by the evaluator</span>
            <span className="exp-metric-val">{treatment.scored_count.toLocaleString()}</span>
          </div>
        </>
      ) : (
        <p className="admin-tab-description">
          Waiting for both variants to record traffic before a head-to-head is possible.
        </p>
      )}

      {reco?.error && <div className="admin-error"><span>{reco.error}</span></div>}
      {reco?.data && (
        <RecommendationCard reco={reco.data as unknown as RecommendationView} decision={experiment?.decision} />
      )}

      {/* Battle-scoped effectiveness: /battle turns only, kept separate from the A/B table above. */}
      <BattleResults
        rows={battleRows ?? []}
        experiment={experiment}
        onDrill={(variantId) => openDrill('battle', variantId)}
        openVariant={drill?.axis === 'battle' ? drill.variantId : null}
      />

      {/* The evidence behind whichever number was clicked. One panel, because the operator is
          checking one figure at a time and stacking four would obscure which set is on screen. */}
      {drill && (
        <ExperimentDrillDown
          target={drill}
          aggregate={aggregateFor(drill.axis, drill.variantId)}
          dateRange={dateRange}
          includeBattle={includeBattle}
          onClose={() => setDrill(null)}
          onOpenConversation={onOpenConversation}
        />
      )}
    </div>
  );
}

/**
 * Battle-scoped effectiveness (SPEC-BATTLE): a variant-by-variant scorecard computed from the
 * experiment's BATTLE turns ONLY. Deliberately separate from, and additional to, the probabilistic
 * A/B comparison, so a hand-picked battle prompt never biases the A/B averages. Renders nothing when
 * the experiment has no battle turns.
 */
function BattleResults({
  rows,
  experiment,
  onDrill,
  openVariant,
}: {
  rows: BattleEffectivenessRow[];
  experiment?: Experiment;
  /** Open the battle TURNS behind a variant's scorecard row. Distinct from the picks drill on the
   *  A/B table: turns are what the models produced, picks are what people chose between them. */
  onDrill?: (variantId: string) => void;
  openVariant?: string | null;
}) {
  // HONEST EMPTY, not absent. Returning null for an experiment that HAS battles enabled made "no
  // picks recorded yet" indistinguishable from "battles are not part of this evaluation" — the
  // operator saw the same blank either way and had no reason to think a human signal was coming.
  // Battle picks are part of the evaluation, so a battle-enabled experiment always says where it is.
  if (!rows.length) {
    if (!experiment?.battleEnabled) return null;
    return (
      <div className="exp-battle">
        <h5 className="exp-battle-title">Human picks</h5>
        <p className="admin-tab-description">
          Battle mode is on for this experiment, but no head-to-head pick has been recorded yet. Run
          <code> /battle </code> in a conversation bound to it — picks are reported here as their own
          axis, separate from the metric verdict.
        </p>
      </div>
    );
  }
  const nameFor = (variantId: string) =>
    experiment?.variants.find((v) => v.variantId === variantId)?.displayName || variantId;
  return (
    <div className="exp-battle">
      <div className="exp-battle-head">
        <span className="status-badge status-badge--live">Battle results</span>
        <span className="exp-battle-sub">
          From /battle turns only, kept separate from the probabilistic A/B table above.
        </span>
      </div>
      <div className="exp-battle-table-wrap">
        <table className="exp-battle-table">
          <thead>
            <tr>
              <th>Variant</th>
              <th>Model</th>
              <th className="num">Turns</th>
              <th className="num">Quality</th>
              <th className="num">Est. cost / reply</th>
              <th className="num">Battle wins</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.variant_id}>
                <td>
                  <span className="exp-battle-variant-name">{nameFor(r.variant_id)}</span>
                  <span className="exp-battle-variant-id"> · {r.variant_id}</span>
                </td>
                <td>{modelDisplayName(r.model_name)}</td>
                <td className="num">
                  {r.turn_count.toLocaleString()}
                  {onDrill && r.turn_count > 0 && (
                    <button
                      className="admin-link-btn exp-drill-btn"
                      aria-expanded={openVariant === r.variant_id}
                      onClick={() => onDrill(r.variant_id)}
                      title="Show the battle turns these averages are computed from"
                    >
                      {openVariant === r.variant_id ? 'hide' : 'show'} turns
                    </button>
                  )}
                </td>
                <td className="num">{r.avg_score == null ? '—' : r.avg_score}</td>
                <td className="num">{r.avg_cost_usd == null ? '—' : `$${r.avg_cost_usd.toFixed(4)}`}</td>
                <td className="num">{r.battle_wins == null ? '—' : r.battle_wins}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VariantHeader({ variant, side }: { variant: VariantAgg; side: 'A' | 'B' }) {
  return (
    <div className="exp-variant-head">
      <span className="exp-variant-side">{side} · {variant.variant_id}</span>
      <span className="exp-variant-model">{modelDisplayName(variant.model_name)}</span>
    </div>
  );
}

// Significance-aware label for the primary metric (§4.2-C): replaces a bare a>b highlight.
function primaryLeadLabel(p: { metric: string; deltaPct: number; significant: boolean; pValue: number }): {
  text: string;
  tone: string;
} {
  const EPS = 0.5; // percent — below this the point estimate is "no difference"
  if (Math.abs(p.deltaPct) < EPS) return { text: 'No difference', tone: 'wait' };
  const higherBetter = /quality|accuracy/i.test(p.metric);
  const treatmentLeads = higherBetter ? p.deltaPct > 0 : p.deltaPct < 0;
  const leader = treatmentLeads ? 'Treatment' : 'Control';
  if (!p.significant) return { text: `${leader} leads (not significant)`, tone: 'wait' };
  const tone = treatmentLeads ? 'win' : 'hold';
  return p.pValue < 0.01
    ? { text: `${leader} leads (p<0.01)`, tone }
    : { text: `${leader} leads (p<0.05)`, tone };
}

// Local mirror of the stats/recommendation contract (DESIGN §4, A.6) consumed verbatim. The service
// result is cast to this at the boundary — the same pattern this file uses for ExperimentResultRow —
// so the significance-aware render is decoupled from the shared barrel's reco export reconciliation.
interface RecommendationView {
  verdict: string;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  primary?: {
    metric: string;
    deltaPct: number;
    ci: [number, number];
    pValue: number;
    significant: boolean;
    powered: boolean;
  };
  /** Three states, not two: held, breached, or neither, which is "not established". `breached` is sent
   *  because it cannot be derived from `held`, and older payloads omit it (treated as not breached). */
  guardrails?: Array<{ metric: string; deltaPct: number; bound: number; held: boolean; breached?: boolean }>;
  human?: { picks: number; winRate: number; ci: [number, number]; significant: boolean };
  recommendedVsChosen?: { recommended: string; chosen?: DecisionOutcome };
  variants?: Array<{ exchange_count: number }>;
  /** Exchanges per variant THIS deployment requires before a verdict is decision-grade. Configurable,
   *  so the console reads it rather than assuming one. */
  minSamplePerVariant?: number;
}

function RecommendationCard({
  reco,
  decision,
}: {
  reco: RecommendationView;
  decision?: { outcome: string; note?: string };
}) {
  const meta = verdictMeta(reco.verdict);
  const primary = reco.primary;
  // Recommended-vs-chosen (§4.4): show both when the operator has recorded a decision.
  const rvc =
    reco.recommendedVsChosen ??
    (decision ? { recommended: reco.verdict, chosen: decision.outcome as DecisionOutcome } : undefined);

  // Underpowered state (§4.2-D): give a concrete "need ~N more" only while a variant is below THIS
  // deployment's floor, which the recommendation reports; otherwise state the qualitative
  // underpowered condition honestly. Naming a floor the backend does not apply turns a correct
  // verdict into a contradicted one, and prescribes work that changes nothing.
  const floor = reco.minSamplePerVariant ?? MIN_SAMPLE_FALLBACK;
  let underpowered: string | null = null;
  if (primary && !primary.powered) {
    const counts = (reco.variants ?? []).map((v) => v.exchange_count).filter((n) => Number.isFinite(n));
    const minExch = counts.length ? Math.min(...counts) : 0;
    const needFloor = floor - minExch;
    underpowered =
      needFloor > 0
        ? `Underpowered — need ~${needFloor} more per variant (to the ${floor}-sample floor).`
        : 'Underpowered — collect more data to detect the target effect at the objective’s bar.';
  }

  return (
    <div className="exp-reco" data-tone={meta.tone}>
      <div className="exp-reco-head">
        <span className="exp-reco-badge">{meta.label}</span>
        <span className="exp-reco-confidence">{reco.confidence} confidence</span>
        <span className="exp-reco-tag">advisory · not auto-applied</span>
      </div>

      {primary && (
        <div className="exp-reco-primary">
          {underpowered ? (
            <span className="exp-reco-underpowered" data-status="underpowered">{underpowered}</span>
          ) : (
            (() => {
              const lead = primaryLeadLabel(primary);
              return (
                <span className="exp-reco-lead" data-tone={lead.tone}>
                  {primary.metric}: {lead.text}
                </span>
              );
            })()
          )}
          <span className="exp-reco-primary-detail">
            {primary.deltaPct >= 0 ? '+' : ''}{primary.deltaPct.toFixed(1)}% · 95% CI [{primary.ci[0].toFixed(4)}, {primary.ci[1].toFixed(4)}] · p={primary.pValue.toFixed(4)}
          </span>
        </div>
      )}

      {reco.guardrails && reco.guardrails.length > 0 && (
        <div className="exp-reco-guardrails">
          {/* A guardrail has three states, and rendering `!held` as "breached" reported the middle one
              as a proven regression: an interval too wide to place either side of the bound is "not
              established", which blocks a ship without claiming harm was demonstrated. */}
          {reco.guardrails.map((g, i) => {
            const status = g.held ? 'held' : g.breached ? 'breached' : 'not-established';
            const label = g.held ? 'held' : g.breached ? 'breached' : 'not established';
            return (
              <span className="exp-reco-guardrail" data-status={status} key={i}>
                {g.metric} {g.deltaPct >= 0 ? '+' : ''}{g.deltaPct.toFixed(1)}% (bound {g.bound}%): {label}
              </span>
            );
          })}
        </div>
      )}

      {/* Human battle-pick axis (§4.3): shown as a DISTINCT signal, never blended into the metric verdict. */}
      {reco.human && (
        <div className="exp-reco-human">
          Humans: {Math.round(reco.human.winRate * 100)}% picked treatment ({reco.human.picks} picks) · CI [
          {Math.round(reco.human.ci[0] * 100)}–{Math.round(reco.human.ci[1] * 100)}%] ·{' '}
          {reco.human.significant ? 'excludes 50% (decisive)' : 'includes 50% (not decisive)'}
        </div>
      )}

      {rvc && rvc.chosen && (
        <div className="exp-reco-rvc">
          Recommended: <strong>{verdictMeta(rvc.recommended).label}</strong> · Chosen:{' '}
          <strong>{rvc.chosen === 'no_decision' ? 'No decision' : rvc.chosen === 'promoted_treatment' ? 'Promoted treatment' : 'Kept control'}</strong>
        </div>
      )}

      <p className="exp-reco-rationale">{reco.rationale}</p>
    </div>
  );
}

export default ExperimentsTab;
