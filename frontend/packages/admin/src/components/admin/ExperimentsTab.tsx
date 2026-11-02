import i18n from '@ae/shared/i18n';
import type { TFunction } from 'i18next';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import UnsupportedAnalyticsBanner from './UnsupportedAnalyticsBanner';
import { InfoTooltip, GuideLinks, guide } from './AdminHelp';
import { useCan } from '../../capabilities';
import { listProfiles, type ProfileListing } from '../../services/profileService';
import { createOrArmExperiment } from '../../services/battleArm';
import {
  listExperiments,
  updateExperimentStatus,
  listBattleSettings,
  listChallengers,
  setBattleEnabled,
  endExperiment,
  deleteExperiment,
} from '../../services/experimentsService';
import {
  type BattleSetting,
  type BattleChallenger,
  modelDisplayName,
  MODEL_STRATEGY_MODELS,
  ApiError,
  DEFAULT_ACCURACY_MARGIN_PCT,
  type Experiment,
  type ExperimentVariant,
  type ExperimentObjective,
  type ImageGenModelKey,
  classificationName,
  classificationOf,
  classificationSelectsModel,
  memberConversationalClassifications,
} from '@ae/shared';
import { queryAnalytics, getExperimentRecommendation } from '../../services/analyticsService';
import { teamAssistant } from '../../services/teamScope';
import PromoteExperiment from './PromoteExperiment';
import { comparedAssistantOf, controlIsLiveVersion, versionLabelOf } from './experimentControl';
import ExperimentBattles, { battleSummaryOf } from './ExperimentBattles';
import type { MessageLink } from './messageLink';
import { BattleModeSwitch, ExperimentSettings } from './ExperimentBattle';
import ExperimentDrillDown, { axisKey, type DrillAxis, type DrillTarget, type DrillAggregate } from './ExperimentDrillDown';
import {
  SampleMeta,
  SampleConversationsCells,
  UnitOfAnalysisNote,
  smallestConversationCount,
  unitsForExperiment,
  type VariantUnitCounts,
} from './ExperimentUnits';
import type {
  AnalyticsDateRange,
  AnalyticsResult,
  ExperimentRecommendation,
  ExperimentResultRow,
  ExperimentUnitsRow,
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

/** Experiments that hold a classification the pending create needs (§3.2.1: one live experiment per
 *  classification). This MIRRORS the backend gate `findClassificationConflicts`; the two must agree, because
 *  this list decides whether the held create is auto-retried after a resolution. Over-reporting here
 *  is not cosmetic: any extra row keeps `remaining.length !== 0`, so the create is never retried and
 *  the panel keeps demanding End/Pause/Delete on experiments that do not actually block anything.
 *
 *  Two conditions, both from the backend rule:
 *   - LIVE, not merely `active`: the resolver's window is active + startDate<=now<endDate, so an
 *     expired or not-yet-started experiment resolves no traffic and does not occupy the classification.
 *   - shares a targeted classification.
 *
 *  Type does not matter: the resolver measures one experiment per classification, so a second one
 *  would receive no traffic. */
function computeConflicts(
  tiers: string[],
  selfId: string,
  all: Experiment[],
): Experiment[] {
  const now = Date.now();
  return all.filter((e) => {
    if (e.experimentId === selfId) return false;
    if (e.status !== 'active') return false;
    if (e.startDate && new Date(e.startDate).getTime() > now) return false;
    if (e.endDate && new Date(e.endDate).getTime() <= now) return false;
    return Array.isArray(e.tiers) && e.tiers.some((t) => tiers.includes(t));
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

/**
 * THE CHALLENGERS THE BATTLE FORM OFFERS, AND THE ONE IT NAMES. A battle runs in exactly one
 * classification, and one challenger per (classification, role) is structural, so the form offers that
 * classification's challengers (from `listChallengers`) and names the chosen one, or the only one, by
 * assistant id. Nothing is offered while the form targets other than one classification.
 */
export function challengerForForm(
  challengers: BattleChallenger[],
  tiers: string[],
  chosen: string,
): { offered: BattleChallenger[]; chosen: string | undefined } {
  const offered = tiers.length === 1 ? challengers.filter((c) => c.classification === tiers[0]) : [];
  return { offered, chosen: offered.find((c) => c.assistant === chosen)?.assistant ?? offered[0]?.assistant };
}

/** Consequence copy for a confirmed lifecycle action (§3.2.1, verbatim from the design's table). */
function confirmCopy(kind: 'end' | 'pause' | 'delete', id: string): string {
  switch (kind) {
    case 'end':
      return i18n.t('admin.experiments.endItStopsCollectingData', { id });
    case 'pause':
      return i18n.t('admin.experiments.pauseNewConversationsStopBeing', { id });
    case 'delete':
      return i18n.t('admin.experiments.deleteItSRemovedFrom', { id });
  }
}

interface ExperimentsTabProps {
  resultsData: AnalyticsResult | null;
  isLoading: boolean;
  /** The window the dashboard is showing, so this tab's on-demand calls match the table beside them. */
  dateRange?: AnalyticsDateRange;
  /** Register a "close the results detail first" handler so global/browser Back steps out of a focused
   *  experiment's results before walking tab history. */
  registerBack?: (close: (() => void) | null) => void;
  /** Open a conversation's transcript (AdminDashboard.openConversation). The drill-down's link from a
   *  scored exchange to the reply that produced it - the admin-plane read that already exists, not a
   *  second path to conversation content. */
  onOpenConversation?: (channelArn: string, message?: MessageLink) => void;
}

const INTENT_OPTIONS = [
  { value: 'general', label: 'General Q&A' },
  { value: 'code_generation', label: 'Code Generation' },
  { value: 'code_review', label: 'Code Review' },
  { value: 'data_extraction', label: 'Data Extraction' },
  { value: 'report_generation', label: 'Report Generation' },
  { value: 'image_generation', label: 'Image Generation' },
  { value: 'strategic_analysis', label: 'Strategic Analysis' },
  { value: 'guided_troubleshooting', label: 'Guided Troubleshooting' },
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

/**
 * The classifications an experiment can target: the deployment's declared member conversational classifications,
 * in declaration order. The form starts on the first of them.
 */
const tierOptions = (): string[] => memberConversationalClassifications().map((c) => c.value);
const firstTier = (): string[] => tierOptions().slice(0, 1);

/**
 * The text models a variant may run in this classification: the catalog's models the classification selects
 * (`models.selected`, carried in `GET /classifications`). The platform allows, the classification selects, and
 * the server refuses a variant on a model its classification does not select, so the form offers only those.
 * A classification the client set does not describe offers the whole catalog and leaves the refusal to the server.
 */
function modelOptionsFor(tier: string | undefined): { value: string; label: string }[] {
  const c = classificationOf(tier);
  if (!c?.models) return MODEL_OPTIONS;
  return MODEL_OPTIONS.filter((o) => classificationSelectsModel(c, o.value));
}

/** `current` when the classification offers it; otherwise the first offered model other than `avoid`, or the first. */
function fitModel(current: string, options: { value: string }[], avoid?: string): string {
  if (options.some((o) => o.value === current)) return current;
  return (options.find((o) => o.value !== avoid) ?? options[0])?.value ?? current;
}

/**
 * The finished replay runs that can gate a classification split of `control` against `treatment` over
 * `classifications` (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5.2, §5.4).
 *
 * Same pair, either way round: which side is called incumbent is the replay's framing, not the experiment's.
 *
 * MATCHED ON EITHER FORM, and that is a transition accommodation rather than looseness. The gate records
 * catalog KEYS ('sonnet'), the vocabulary this form holds; rows written before that still hold resolved
 * Bedrock ids, and refusing to recognize them would invalidate gate runs that were performed correctly.
 *
 * AND IN A CLASSIFICATION THE SPLIT WILL RUN IN. A replay runs in one classification over that
 * classification's traffic with that classification's models (tenet D12), so it is evidence about that
 * classification only. A run that names none read every classification's traffic and is evidence about
 * none of them, so it never gates.
 */
export function gateRunsFor(
  runs: ReadonlyArray<Record<string, string>>,
  control: string,
  treatment: string,
  classifications: readonly string[],
): Array<Record<string, string>> {
  const sameModel = (recorded: string, selectedKey: string): boolean => {
    if (recorded === selectedKey) return true; // both keys: the path all new runs take
    const def = MODEL_STRATEGY_MODELS.find((m) => m.key === selectedKey);
    return !!def && recorded === def.bedrockModelId; // a legacy row recorded the resolved id
  };
  return runs.filter(
    (r) =>
      r.status === 'complete' &&
      !!r.classification && classifications.includes(r.classification) &&
      ((sameModel(r.incumbentModel, control) && sameModel(r.challengerModel, treatment)) ||
        (sameModel(r.incumbentModel, treatment) && sameModel(r.challengerModel, control))),
  );
}

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

/** The experiment a `?exp=<id>` URL opens, if any. */
export function experimentFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('exp') || null;
}

/**
 * Reflect the open experiment in the URL. Opening one adds a history entry so Back closes it; closing
 * replaces the entry. A URL already naming the state (a popstate-driven change) writes nothing.
 */
function syncExperimentToUrl(id: string | null): void {
  const url = new URL(window.location.href);
  if ((url.searchParams.get('exp') || null) === id) return;
  if (id) {
    url.searchParams.set('exp', id);
    window.history.pushState({}, '', url);
  } else {
    url.searchParams.delete('exp');
    window.history.replaceState({}, '', url);
  }
}

const ExperimentsTab: React.FC<ExperimentsTabProps> = ({ resultsData, isLoading: _isLoading, registerBack, onOpenConversation, dateRange }) => {
  const { t: translate } = useTranslation();
  // Each control renders only for a role holding its capability (SPEC-ADMIN-CONSOLE FR0f, FR36).
  const can = useCan();
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // #8 drill-down: null = show every experiment's comparison; an id = focus that
  // one experiment's results (with a "← All experiments" control to clear it).
  // The open experiment's page is a URL (`?exp=<id>`), so it is deep-linkable and the Duels view links to it.
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(() => experimentFromUrl());
  useEffect(() => syncExperimentToUrl(selectedExperimentId), [selectedExperimentId]);
  useEffect(() => {
    // After the dashboard's own popstate handling, which closes an open detail, so a URL naming an
    // experiment (browser Forward) reopens it.
    const onPop = () => { setTimeout(() => setSelectedExperimentId(experimentFromUrl()), 0); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
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
    intent: 'general',
    tiers: firstTier(),
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
    // power Battle Mode. Requires a challenger (the classification's alt, from listChallengers). A variant
    // carries no name: each duel side is named from its profile by the server.
    battleEnabled: false,
    challengerAssistant: '',
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
      setActionError(error instanceof Error ? error.message : translate('admin.experiments.failedToLoadExperiments'));
    } finally {
      setIsRefreshing(false);
    }
  }

  // BATTLE ON/OFF, PER CLASSIFICATION. Loaded beside the experiments because this is where an
  // operator arms the comparison a duel runs on, so turning battle on and arming it are one visit.
  const [battleSettings, setBattleSettings] = useState<BattleSetting[]>([]);
  const [battleSaving, setBattleSaving] = useState<string | null>(null);

  async function loadBattleSettings() {
    // Battle is set for a whole classification, so a team's console has no route for it and does not ask.
    if (teamAssistant()) {
      setBattleSettings([]);
      return;
    }
    try {
      setBattleSettings(await listBattleSettings());
    } catch {
      // BEST EFFORT, AND SILENT. This panel is one control among many on a tab whose main job is
      // experiments; a deployment whose API predates the route would otherwise show an error banner
      // over working content. The panel simply does not render.
      setBattleSettings([]);
    }
  }

  async function toggleBattle(classification: string, enabled: boolean) {
    setBattleSaving(classification);
    try {
      setActionError(null);
      await setBattleEnabled(classification, enabled);
      // RE-READ rather than assume. The server refuses a classification that is not capable, and it
      // is the authority on what the setting now is - optimistically flipping the box would show an
      // operator a state the backend may not have accepted.
      await loadBattleSettings();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : translate('admin.experiments.failedToChangeBattleMode'));
      await loadBattleSettings();
    } finally {
      setBattleSaving(null);
    }
  }

  // THE CHALLENGERS A BATTLE CAN NAME, from the deployment's assignment records rather than a list of
  // this console's own, so the form can only offer an assistant that exists. Admin only, like the setting.
  const [challengers, setChallengers] = useState<BattleChallenger[]>([]);

  async function loadChallengers() {
    if (teamAssistant()) {
      setChallengers([]);
      return;
    }
    try {
      setChallengers(await listChallengers());
    } catch {
      // Best effort, like the battle setting: the form then offers no challenger and the server's
      // refusal names what is missing.
      setChallengers([]);
    }
  }

  useEffect(() => {
    loadExperiments();
    void loadBattleSettings();
    void loadChallengers();
  }, []);

  // The models the chosen classification selects. A model it does not select is not offered, and a selection
  // a classification change left behind (or the form's default) moves to one it does select.
  const variantModelOptions = modelOptionsFor(newExperiment.tiers[0]);
  const variantModelKeys = variantModelOptions.map((o) => o.value).join(',');
  useEffect(() => {
    setNewExperiment((prev) => {
      const controlModel = fitModel(prev.controlModel, variantModelOptions);
      const treatmentModel = fitModel(prev.treatmentModel, variantModelOptions, controlModel);
      return controlModel === prev.controlModel && treatmentModel === prev.treatmentModel
        ? prev
        : { ...prev, controlModel, treatmentModel };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantModelKeys, newExperiment.controlModel, newExperiment.treatmentModel]);

  const { offered: challengersForClassification, chosen: battleChallenger } =
    challengerForForm(challengers, newExperiment.tiers, newExperiment.challengerAssistant);

  // Let global/browser Back close the focused-experiment results detail before walking tab history.
  useEffect(() => {
    registerBack?.(selectedExperimentId ? () => setSelectedExperimentId(null) : null);
    return () => registerBack?.(null);
  }, [selectedExperimentId, registerBack]);

  /**
   * Why a classification experiment cannot be started right now, or null when it can (DESIGN §5.4).
   *
   * Resolved from the shadow gate: a COMPLETE replay comparing this experiment's two models whose
   * verdict authorizes a split. Anything less and the split would change routing for real users while
   * the only evidence about the change is the evaluator's opinion of the answers downstream.
   */
  const [classifierGateBlock, setClassifierGateBlock] = useState<string | null>(
    translate('admin.experiments.gate.runFirst'),
  );
  const gateModels = `${newExperiment.controlModel}|${newExperiment.treatmentModel}|${newExperiment.tiers.join(',')}`;
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
    const [control, treatment, tierList] = gateModels.split('|');
    const gateTiers = (tierList || '').split(',').filter(Boolean);
    // BLOCK WHILE THE ANSWER IS UNKNOWN (CR-11). This left `classifierGateBlock` at its previous value
    // across the round-trip, and that value is `null` whenever the operator has just switched Type to
    // Classification (the early return above cleared it) or changed only one model on a pair that had
    // previously passed. Clicking Create & Activate inside that window created an UNGATED live
    // classification split - the one thing the gate exists to prevent. Fail closed until a run is found.
    setClassifierGateBlock(translate('admin.experiments.gate.checking'));
    (async () => {
      try {
        const res = await queryAnalytics('classifier_replays', gateRange, {});
        const runs = ((res.data as unknown) as Array<Record<string, string>>) ?? [];
        const matching = gateRunsFor(runs, control, treatment, gateTiers);
        if (!matching.length) {
          if (!cancelled) {
            setClassifierGateBlock(
              translate('admin.experiments.noCompletedClassifierGateCompares', { control: control, treatment: treatment }),
            );
          }
          return;
        }
        // EVERY classification the split covers needs its own passing run.
        const passed = new Set<string>();
        for (const r of matching) {
          if (passed.has(r.classification)) continue;
          const detail = (await queryAnalytics('classifier_replay', gateRange, { runId: r.runId })) as unknown as {
            gate?: { verdict?: string; rationale?: string };
          };
          const verdict = detail?.gate?.verdict;
          if (verdict === 'challenger_better' || verdict === 'non_inferior') passed.add(r.classification);
          if (gateTiers.every((c) => passed.has(c))) {
            if (!cancelled) setClassifierGateBlock(null);
            return;
          }
        }
        if (!cancelled) {
          setClassifierGateBlock(
            translate('admin.experiments.gate.notAuthorised'),
          );
        }
      } catch {
        // A gate that cannot be READ is not a gate that passed.
        if (!cancelled) {
          setClassifierGateBlock(translate('admin.experiments.gate.unreadable'));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [newExperiment.experimentType, gateModels, gateRange]);

  async function handleCreate() {
    if (!newExperiment.experimentId.trim()) {
      setActionError(translate('admin.experiments.experimentIdIsRequired'));
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
      setActionError(translate('admin.experiments.imageExperimentPickAnImage'));
      return;
    }

    // THE CLASSIFICATION GATE (DESIGN §5.4). A classification experiment changes which model LABELS
    // a message, for real users, and the online split measures the answer rather than the labeling.
    // The gate answers the actual question first, on archived traffic, exposing nobody — so it is a
    // precondition for the split rather than a report on it: "the gate does not replace the split; it
    // earns it". Blocked here rather than server-side because the experiments API is DynamoDB-only
    // and the gate's evidence lives in Aurora; a request made outside the console is not refused (**OPEN**).
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
      setActionError(translate('admin.experiments.profileExperimentPickAProfile'));
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
        // The control of an intent or base-model experiment is the live active version and names no model (§3.5).
        ...(controlIsLiveVersion(newExperiment.experimentType)
          ? {}
          : runFor(newExperiment.controlModel, newExperiment.controlProfile, newExperiment.controlProfileVersion)),
        weight: newExperiment.controlWeight,
        // Image model is a NORMAL variant property (served in the non-battle flow too), not battle-only.
        ...(controlImageGenModelKey && {
          imageGenModelKey: controlImageGenModelKey as ImageGenModelKey,
        }),
        ...(newExperiment.battleEnabled && {
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
          systemPromptAddendum: newExperiment.treatmentAddendum || undefined,
        }),
      },
    ];

    // Objective (§1.4). The written statement is REQUIRED; the metric+target is the primary
    // quantitative criterion (target ∈ [0, 100]); guardrails are optional veto conditions.
    const statement = newExperiment.objectiveStatement.trim();
    if (!statement) {
      setActionError(translate('admin.experiments.objectiveStateTheDecisionThis'));
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
      setActionError(translate('admin.experiments.objectiveTargetIsRequiredState'));
      return;
    }
    const target = Number(newExperiment.objectiveTarget);
    if (!Number.isFinite(target) || target < 0 || target > 100) {
      setActionError(translate('admin.experiments.objectiveTargetMustBeA'));
      return;
    }
    // Only fully-specified guardrails (metric chosen + valid bound) are sent; ≤3.
    const guardrails: ObjectiveGuardrail[] = [];
    for (const gr of newExperiment.guardrails) {
      if (!gr.metric) continue;
      const bound = Number(gr.bound);
      if (!Number.isFinite(bound) || bound < 0 || bound > 100) {
        setActionError(translate('admin.experiments.guardrailBoundMustBeA'));
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
        ...(battleChallenger && { challengerAssistant: battleChallenger }),
      }),
    };

    await submitCreate(payload);
  }

  function resetCreateForm() {
    setNewExperiment({
      experimentId: '',
      experimentType: 'intent',
      intent: 'general',
      tiers: firstTier(),
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
      challengerAssistant: '',
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
      // One call, a battle included: the server derives both duel sides when it arms one (§3.7).
      await createOrArmExperiment(payload);
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
          : computeConflicts(payload.tiers, payload.experimentId, experiments);
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
            translate('admin.experiments.blockingResolved'),
          );
          return;
        }
      }
      setActionError(error instanceof Error ? error.message : translate('admin.experiments.failedToCreateExperiment'));
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
      setActionError(error instanceof Error ? error.message : translate('admin.experiments.actionFailed'));
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
      setActionError(error instanceof Error ? error.message : translate('admin.experiments.failedToUpdateExperiment'));
    }
  }

  // ONE CLASSIFICATION: an experiment compares two versions of one assistant, and an assistant acts in one
  // classification (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5), so picking a classification replaces
  // the choice rather than adding to it. The server refuses any other number at arm.
  function toggleTier(tier: string) {
    setNewExperiment((prev) => ({ ...prev, tiers: [tier] }));
  }

  // THE EXPERIMENT'S PAGE, one URL (`?exp=<id>`) with a Back control; global/browser Back steps out of it too.
  // Its sections run in the order a reader asks: what is it testing (Goal), what has it found (Results),
  // what did people pick in battles (Battles, when Battle Mode is on), and how is it set up (Settings).
  if (selectedExperimentId) {
    const selectedExperiment = experiments.find((e) => e.experimentId === selectedExperimentId);
    const name = selectedExperiment ? experimentName(selectedExperiment) : selectedExperimentId;
    const unsupported = Boolean(resultsData?.unsupported);
    return (
      <div className="admin-tab" data-testid="experiment-page">
        <div className="admin-tab-header">
          <nav className="admin-breadcrumb" aria-label={translate('admin.experiments.experimentPath')}>
            <button className="btn-link" onClick={() => setSelectedExperimentId(null)}>{translate('admin.experiments.allExperiments')}</button>
            <span> / </span>
            <span>{name}</span>
          </nav>
        </div>
        <h3 className="experiment-page-title">
          {name}
          {selectedExperiment && <> <span className="status-badge">{selectedExperiment.status}</span></>}
        </h3>
        {selectedExperiment && <ExperimentGoal experiment={selectedExperiment} />}
        {unsupported ? (
          <UnsupportedAnalyticsBanner result={resultsData!} />
        ) : (
          <>
            <ExperimentResults
              dashboardRange={dateRange}
              resultsData={resultsData}
              experiments={experiments}
              experimentId={selectedExperimentId}
              title={name}
              actions={selectedExperiment && (
                <PromoteExperiment exp={selectedExperiment} can={can} onPromoted={() => { void loadExperiments(); }} />
              )}
              onOpenConversation={onOpenConversation}
            />
            {/* Battles are read from the Aurora columns, so they show where the results do. */}
            {selectedExperiment?.battleEnabled && dateRange && (
              <ExperimentBattles
                dateRange={dateRange}
                experiment={selectedExperiment}
                rollup={resultsData?.battleEffectiveness?.data ?? []}
                onOpenConversation={onOpenConversation}
              />
            )}
          </>
        )}
        {selectedExperiment && (
          <ExperimentSettings
            experiment={selectedExperiment}
            setting={battleSettings.find((s) => s.classification === selectedExperiment.tiers?.[0])}
            saving={battleSaving === selectedExperiment.tiers?.[0]}
            canChange={can('manage-battle-settings')}
            onToggle={(c, on) => void toggleBattle(c, on)}
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
        {/* The tab opened straight onto controls with nothing saying what a reader is deciding.
            One line does that; the decision loop itself - guardrails, power, how a recommendation is
            reached - is a document, not a page header. */}
        <h3>
          {translate('admin.experiments.aBExperiments')}
          <InfoTooltip
            label={translate('admin.experiments.whatAnExperimentOnThis')}
            content={
              translate('admin.experiments.aboutText')
            }
          />
        </h3>
        <div className="admin-filter-group">
          <button className="btn-secondary" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? translate('admin.experiments.cancel') : translate('admin.experiments.newExperiment')}
          </button>
          <button className="admin-filter-btn" onClick={() => loadExperiments()}>
            {isRefreshing ? translate('admin.experiments.refreshing') : translate('admin.experiments.refresh')}
          </button>
        </div>
      </div>

      <p className="admin-tab-description">{translate('admin.experiments.description')}</p>
      <GuideLinks guides={[
        guide(translate('admin.guides.experiments.loop'), 'experimentDecisionLoop'),
        guide(translate('admin.guides.experiments.guide'), 'abTesting'),
      ]} />

      {actionError && (
        <div className="admin-error">
          <span>{actionError}</span>
          <button className="btn-secondary" onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      {/* Conflict-resolution panel (§3.2.1): a blocked create lists the experiment(s) holding the
          classification and offers three confirmed ways to free it, then auto-retries. */}
      {conflicts && conflicts.length > 0 && (
        <div className="admin-section experiment-conflict-panel" data-testid="experiment-conflict">
          <h4>{translate('admin.experiments.classificationAlreadyInUse')}</h4>
          <p className="admin-tab-description">
            {pendingCreate ? `"${pendingCreate.experimentId}" can't start` : "This test can't start"} —{' '}
            {conflicts.length === 1 ? translate('admin.experiments.anotherExperimentIs') : translate('admin.experiments.experimentsAre', { conflicts: conflicts.length })} active on{' '}
            {(pendingCreate?.tiers ?? []).join(', ') || translate('admin.experiments.theTargetedTierS')}. Free the classification and the
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
              {can('manage-experiments') && (
              <div className="admin-inline-actions">
                <button
                  className="btn-secondary"
                  onClick={() => setConfirm({ kind: 'end', exp: c, ran: c.status !== 'draft', decision: 'no_decision', note: '' })}
                >
                  End
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setConfirm({ kind: 'pause', exp: c, ran: c.status !== 'draft', decision: 'no_decision', note: '' })}
                >
                  Pause
                </button>
                <button
                  className="btn-danger"
                  onClick={() => setConfirm({ kind: 'delete', exp: c, ran: c.status !== 'draft', decision: 'no_decision', note: '' })}
                >
                  Delete
                </button>
              </div>
              )}
            </div>
          ))}
          <button
            className="btn-secondary"
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
          aria-label={translate('admin.experiments.confirm', { kind: confirm.kind })}
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
              {confirm.kind === 'end' ? translate('admin.experiments.endExperiment') : confirm.kind === 'pause' ? translate('admin.experiments.pauseExperiment') : translate('admin.experiments.deleteExperiment')}
            </h4>
            <p>{confirmCopy(confirm.kind, confirm.exp.experimentId)}</p>
            {confirm.kind === 'end' && confirm.ran && (
              <div className="experiment-decision-picker">
                <label>
                  {translate('admin.experiments.recordTheOutcome')}
                  <select className="select"
                    value={confirm.decision}
                    onChange={(e) => setConfirm((c) => (c ? { ...c, decision: e.target.value as DecisionOutcome } : c))}
                  >
                    <option value="no_decision">{translate('admin.experiments.noDecisionDefault')}</option>
                    <option value="promoted_treatment">{translate('admin.experiments.promotedTreatment')}</option>
                    <option value="kept_control">{translate('admin.experiments.keptControl')}</option>
                  </select>
                </label>
                <label>
                  Note (optional)
                  <textarea
                    className="textarea input"
                    value={confirm.note}
                    maxLength={500}
                    rows={2}
                    placeholder={translate('admin.experiments.optionalEGWhyThis')}
                    onChange={(e) => setConfirm((c) => (c ? { ...c, note: e.target.value } : c))}
                  />
                </label>
                <p className="admin-field-hint">
                  {translate('admin.experiments.youReNeverForcedTo')}
                </p>
              </div>
            )}
            <div className="admin-inline-actions">
              <button className="btn-secondary" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </button>
              <button
                className={confirm.kind === 'pause' ? 'btn-secondary' : 'btn-danger'}
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
          <h4>{translate('admin.experiments.createExperiment')}</h4>
          <div className="admin-form-grid">
            <label>
              {translate('admin.experiments.experimentId')}
              <input className="input"
                type="text"
                value={newExperiment.experimentId}
                onChange={(e) => setNewExperiment((p) => ({ ...p, experimentId: e.target.value }))}
                placeholder={translate('admin.experiments.eGExpCodeGen')}
              />
            </label>
            <label>
              Type
              <InfoTooltip
                label={translate('admin.experiments.aboutExperimentType')}
                // The Classification wording no longer claims to measure labeling. It does not: the
                // `accuracy` objective maps to the same evaluator score that backs `quality`, so a
                // classification experiment is scored on the ANSWER, a downstream proxy for the
                // routing change. Saying otherwise told an operator they were measuring something the
                // platform does not measure. See DESIGN §5 for the shadow gate that would.
                content={translate('admin.experiments.intentTestsWhichModelBest')}
              />
              <select className="select"
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
                <option value="intent">{translate('admin.experiments.intentShipped')}</option>
                <option value="base_model">{translate('admin.experiments.baseModelShipped')}</option>
                <option value="classification">{translate('admin.experiments.classificationShipped')}</option>
                <option value="profile">{translate('admin.experiments.profileVsProfileShipped')}</option>
              </select>
            </label>
            {newExperiment.experimentType === 'intent' && (
              <label>
                Intent
                <select className="select"
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
                        {translate('admin.experiments.controlProfile')}
                        <select className="select" value={newExperiment.controlProfile} onChange={(e) => setNewExperiment((p) => ({ ...p, controlProfile: e.target.value, controlProfileVersion: '' }))}>
                          <option value="">{translate('admin.experiments.selectAProfile')}</option>
                          {profileOptions.map((p) => <option key={p.profileName} value={p.profileName}>{p.profileName}</option>)}
                        </select>
                        <select className="select" value={newExperiment.controlProfileVersion} onChange={(e) => setNewExperiment((p) => ({ ...p, controlProfileVersion: e.target.value }))} style={{ marginTop: 'var(--space-1)' }}>
                          <option value="">Active version{ctrl?.activeVersion != null ? ` (v${ctrl.activeVersion})` : ''}</option>
                          {(ctrl?.versions ?? []).map((v) => <option key={v.version} value={String(v.version)}>v{v.version}{v.active ? ' (active)' : ''}</option>)}
                        </select>
                      </label>
                      <label>
                        {translate('admin.experiments.treatmentProfile')}
                        <select className="select" value={newExperiment.treatmentProfile} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentProfile: e.target.value, treatmentProfileVersion: '' }))}>
                          <option value="">{translate('admin.experiments.selectAProfile')}</option>
                          {profileOptions.map((p) => <option key={p.profileName} value={p.profileName}>{p.profileName}</option>)}
                        </select>
                        <select className="select" value={newExperiment.treatmentProfileVersion} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentProfileVersion: e.target.value }))} style={{ marginTop: 'var(--space-1)' }}>
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
                    <select className="select" value={newExperiment.controlImageGenModelKey} onChange={(e) => setNewExperiment((p) => ({ ...p, controlImageGenModelKey: e.target.value }))}>
                      <option value="">{translate('admin.experiments.selectAnImageModel')}</option>
                      {IMAGE_GEN_MODEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  ) : controlIsLiveVersion(newExperiment.experimentType) ? (
                    // The control of an intent or base-model experiment IS the live assistant's active
                    // version (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5), so there is no model to pick.
                    <span className="admin-field-hint">{translate('admin.experiments.controlIsLive')}</span>
                  ) : (
                    <select className="select" value={newExperiment.controlModel} onChange={(e) => setNewExperiment((p) => ({ ...p, controlModel: e.target.value }))}>
                      {variantModelOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  )}
                </label>
                <label>
                  Treatment {showImageGenModels ? 'Image Model' : 'Model'}
                  {showImageGenModels ? (
                    <select className="select" value={newExperiment.treatmentImageGenModelKey} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentImageGenModelKey: e.target.value }))}>
                      <option value="">{translate('admin.experiments.selectAnImageModel')}</option>
                      {IMAGE_GEN_MODEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  ) : (
                    <select className="select" value={newExperiment.treatmentModel} onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentModel: e.target.value }))}>
                      {variantModelOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  )}
                </label>
                {showImageGenModels && (
                  <p className="admin-field-hint" style={{ gridColumn: '1 / -1' }}>
                    {translate('admin.experiments.imageVariantsHelp')}
                  </p>
                )}
              </>
            )}
            <label>
              {translate('admin.experiments.trafficSplitControl')}
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
              <span>{translate('admin.experiments.tiers')}</span>
              <div className="admin-filter-group">
                {tierOptions().map((tier) => (
                  <button
                    key={tier}
                    className={`admin-filter-btn ${newExperiment.tiers.includes(tier) ? 'active' : ''}`}
                    onClick={() => toggleTier(tier)}
                  >
                    {classificationName(tier)}
                  </button>
                ))}
              </div>
            </div>
            <label>
              End Date
              <input className="input"
                type="date"
                value={newExperiment.endDate}
                onChange={(e) => setNewExperiment((p) => ({ ...p, endDate: e.target.value }))}
              />
              <span className="admin-field-hint">{translate('admin.experiments.endDateHint')}</span>
            </label>
          </div>

          {/* Objective block (§1.4): the written decision this test informs is REQUIRED; the
              metric+target is the primary quantitative criterion; guardrails pre-register the
              ship rule. The objective is advisory — it frames the decision, never auto-acts. */}
          <fieldset className="admin-section experiment-objective-block" style={{ marginTop: '12px' }}>
            <legend>
              Objective
              <InfoTooltip
                label={translate('admin.experiments.aboutTheObjective')}
                content={translate('admin.experiments.stateTheDecisionThisTest')}
              />
            </legend>
            <label style={{ display: 'block' }}>
              What decision will this test inform? <span aria-hidden="true">*</span>
              <textarea
                className="textarea input"
                value={newExperiment.objectiveStatement}
                onChange={(e) => setNewExperiment((p) => ({ ...p, objectiveStatement: e.target.value }))}
                placeholder={translate('admin.experiments.eGDecideWhetherPremium')}
                maxLength={500}
                rows={3}
                required
              />
              <span className="admin-field-hint">{translate('admin.experiments.requiredTheHypothesisShipCriteria')}</span>
            </label>
            <div className="admin-form-grid">
              <label>
                {translate('admin.experiments.primaryMetric')}
                <select className="select"
                  value={newExperiment.objectiveMetric}
                  onChange={(e) => setNewExperiment((p) => ({ ...p, objectiveMetric: e.target.value as ObjectiveMetric }))}
                >
                  <option value="cost">{translate('admin.experiments.costDecrease')}</option>
                  {newExperiment.experimentType === 'classification'
                    ? <option value="accuracy">{translate('admin.experiments.accuracyTarget')}</option>
                    : <option value="quality">{translate('admin.experiments.qualityTarget')}</option>}
                  <option value="latency">{translate('admin.experiments.latencyDecrease')}</option>
                </select>
              </label>
              <label>
                Target (%)
                <input className="input"
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
                <span>{translate('admin.experiments.guardrails')} <span className="admin-field-hint">{translate('admin.experiments.optionalMetricsThatMustNot')}</span></span>
                {newExperiment.guardrails.length < 3 && (
                  <button
                    type="button"
                    className="btn-secondary"
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
                    <select className="select"
                      value={gr.metric}
                      onChange={(e) => setNewExperiment((p) => {
                        const guardrails = [...p.guardrails];
                        guardrails[i] = { ...guardrails[i], metric: e.target.value as '' | ObjectiveMetric };
                        return { ...p, guardrails };
                      })}
                    >
                      <option value="">{translate('admin.experiments.select')}</option>
                      <option value="cost">{translate('admin.experiments.cost')}</option>
                      <option value="latency">{translate('admin.experiments.latency')}</option>
                      <option value="quality">{translate('admin.experiments.quality')}</option>
                      <option value="accuracy">{translate('admin.experiments.accuracy')}</option>
                    </select>
                  </label>
                  <label>
                    Rule
                    <select className="select"
                      value={gr.direction}
                      onChange={(e) => setNewExperiment((p) => {
                        const guardrails = [...p.guardrails];
                        guardrails[i] = { ...guardrails[i], direction: e.target.value as 'no_worse_than' | 'at_least' };
                        return { ...p, guardrails };
                      })}
                    >
                      <option value="no_worse_than">{translate('admin.experiments.noWorseThanRegressionCap')}</option>
                      <option value="at_least">{translate('admin.experiments.atLeastImprovementFloor')}</option>
                    </select>
                  </label>
                  <label>
                    Bound (%)
                    <input className="input"
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
                    className="btn-danger"
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
              {translate('admin.experiments.battleOptionHelp')}
            </p>
          </div>

          {newExperiment.battleEnabled && (
            <div className="experiment-battle-card">
              <div className="experiment-battle-header">
                <span className="status-badge status-badge--live">{translate('admin.experiments.battleMode')}</span>
                <span className="experiment-battle-header-title">{translate('admin.experiments.sideBySideBattle')}</span>
              </div>
              <p className="experiment-battle-toggle-help">{translate('admin.battles.help')}</p>
              {/* Battle Mode is the chosen classification's setting; arming this experiment needs it on. */}
              <BattleModeSwitch
                setting={battleSettings.find((s) => s.classification === newExperiment.tiers[0])}
                saving={battleSaving === newExperiment.tiers[0]}
                canChange={can('manage-battle-settings')}
                onToggle={(c, on) => void toggleBattle(c, on)}
              />

              <div className="experiment-battle-variants">
                <div className="experiment-battle-variant">
                  <span className="experiment-battle-variant-label">{translate('admin.experiments.aControl')}</span>
                  <span className="experiment-battle-variant-model">
                    {showImageGenModels ? (newExperiment.controlImageGenModelKey || 'no image model') : newExperiment.controlModel}
                  </span>
                  <textarea
                    className="textarea input experiment-battle-variant-addendum"
                    value={newExperiment.controlAddendum}
                    aria-label={translate('admin.experiments.addendumLabel', { side: translate('admin.experiments.aControl') })}
                    data-testid="addendum-a"
                    onChange={(e) => setNewExperiment((p) => ({ ...p, controlAddendum: e.target.value }))}
                    placeholder={translate('admin.experiments.addendumPlaceholder')}
                    maxLength={500}
                    rows={3}
                  />
                </div>

                <div className="experiment-battle-vs" aria-hidden="true">VS</div>

                <div className="experiment-battle-variant">
                  <span className="experiment-battle-variant-label">{translate('admin.experiments.bTreatment')}</span>
                  <span className="experiment-battle-variant-model">
                    {showImageGenModels ? (newExperiment.treatmentImageGenModelKey || 'no image model') : newExperiment.treatmentModel}
                  </span>
                  <textarea
                    className="textarea input experiment-battle-variant-addendum"
                    value={newExperiment.treatmentAddendum}
                    aria-label={translate('admin.experiments.addendumLabel', { side: translate('admin.experiments.bTreatment') })}
                    data-testid="addendum-b"
                    onChange={(e) => setNewExperiment((p) => ({ ...p, treatmentAddendum: e.target.value }))}
                    placeholder={translate('admin.experiments.addendumPlaceholder')}
                    maxLength={500}
                    rows={3}
                  />
                </div>
              </div>

              {!showImageGenModels && <p className="experiment-battle-toggle-help" data-testid="addendum-help">{translate('admin.experiments.addendumHelp')}</p>}

              {showImageGenModels && (
                <p className="experiment-battle-toggle-help">
                  {translate('admin.experiments.imageBattleThisExperimentS')}
                </p>
              )}

              <div className="experiment-battle-challenger">
                <label className="label" htmlFor="battle-challenger-select">{translate('admin.experiments.battleChallenger')}</label>
                <select
                  id="battle-challenger-select"
                  className="select input"
                  value={battleChallenger ?? ''}
                  disabled={challengersForClassification.length === 0}
                  onChange={(e) => setNewExperiment((p) => ({ ...p, challengerAssistant: e.target.value }))}
                >
                  {challengersForClassification.length === 0 && <option value="" />}
                  {challengersForClassification.map((c) => (
                    <option key={c.assistant} value={c.assistant}>
                      {c.assistant}{c.inUseBy ? ` (${c.inUseBy})` : ''}
                    </option>
                  ))}
                </select>
                <p className="experiment-battle-challenger-help">
                  {translate(challengersForClassification.length === 0
                    ? 'admin.experiments.noChallengerForClassification'
                    : 'admin.experiments.challengerHelp')}
                </p>
              </div>
            </div>
          )}

          <button className="btn-secondary" onClick={handleCreate} style={{ marginTop: '12px' }}>
            Create & Activate
          </button>
        </div>
      )}

      <div className="admin-section">
        {/* "Experiments", not "Active Experiments": this table lists every non-deleted experiment
            regardless of state, and the old heading asserted otherwise on a list that is mostly
            completed rows. The ACTIVE count now says the live number, and it is a filter. */}
        <h4>{translate('admin.experiments.experiments')}</h4>
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
        {/* ONE ROW PER EXPERIMENT, read left to right as a sentence: what it is and is for, what it compares,
            where it stands, how much evidence it has, and what that evidence says so far. The row opens the
            experiment's page; the full results live there, under the experiment's name. */}
        <DataTable
          onRowClick={(row) => setSelectedExperimentId((row as Experiment).experimentId)}
          columns={[
            {
              key: 'experimentId',
              label: translate('admin.experiments.list.experiment'),
              render: (_v, row) => {
                const exp = row as Experiment;
                return (
                  <div>
                    <button
                      type="button"
                      className="btn-link experiment-name-link"
                      title={translate('admin.experiments.openThisExperimentSResults')}
                      onClick={() => setSelectedExperimentId(exp.experimentId)}
                    >
                      {experimentName(exp)}
                    </button>
                    <div className="admin-field-hint">{goalLine(exp, translate)}</div>
                  </div>
                );
              },
            },
            {
              key: 'variants',
              label: translate('admin.experiments.list.compares'),
              sortable: false,
              render: (_v, row) => comparisonLine(row as Experiment, translate),
            },
            { key: 'status', label: translate('admin.experiments.list.status') },
            {
              key: 'evidence',
              label: translate('admin.experiments.list.evidence'),
              sortable: false,
              render: (_v, row) => evidenceLine(row as Experiment, resultsData, translate),
            },
            {
              key: 'result',
              label: translate('admin.experiments.list.result'),
              sortable: false,
              render: (_v, row) => (
                <span data-testid="experiment-result-line">
                  {resultLine(summarizeResult(row as Experiment, resultsData), translate)}
                </span>
              ),
            },
            {
              key: 'actions',
              label: translate('admin.experiments.list.actions'),
              sortable: false,
              render: (_v, row) => {
                const exp = row as Experiment;
                return (
                  <div className="admin-inline-actions">
                    {exp.status === 'active' && (
                      <button className="btn-secondary" onClick={() => handleStatusChange(exp.experimentId, 'paused')}>
                        Pause
                      </button>
                    )}
                    {exp.status === 'paused' && (
                      <button className="btn-secondary" onClick={() => handleStatusChange(exp.experimentId, 'active')}>
                        Resume
                      </button>
                    )}
                    {(exp.status === 'active' || exp.status === 'paused') && can('manage-experiments') && (
                      // End (not a bare Complete): a test that ran prompts a decision on close (§3.2.1).
                      <button
                        className="btn-danger"
                        onClick={() => setConfirm({ kind: 'end', exp, ran: exp.status !== 'draft', decision: 'no_decision', note: '' })}
                      >
                        End
                      </button>
                    )}
                    {exp.status !== 'deleted' && (
                      <button
                        className="btn-danger"
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
              ? translate('admin.experiments.noneConfigured')
              : translate('admin.experiments.noExperimentsClearTheFilter', { statusFilter: statusFilter, visibleExperiments: visibleExperiments.length })
          }
        />
      </div>

      {/*
        Honest-empty banner: in Athena mode `experiment_results` returns unsupported, so every row's
        evidence and result would be permanently blank without explanation. Render the banner so the
        reader sees WHY.
      */}
      {resultsData?.unsupported && <UnsupportedAnalyticsBanner result={resultsData} />}
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
      tier: expRows[0]?.assistant ?? '',
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

/**
 * The metrics compared, in display order.
 *
 * No `label` field: the copy is `admin.experiments.metric.<key>`, resolved at the render site. A label
 * here would be module-scope English with no hook in reach, and a second field to keep in step with the
 * key it already duplicates.
 */
const METRICS: { key: MetricKey; higherIsBetter: boolean; headline?: boolean; fmt: (v: number | null) => string }[] = [
  { key: 'task_completion_rate', higherIsBetter: true, headline: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
  { key: 'avg_score', higherIsBetter: true, headline: true, fmt: (v) => (v == null ? '—' : `${v}`) },
  // Human signal, separate from the evaluator's Quality. '—' when no ratings yet.
  { key: 'approval_rate', higherIsBetter: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
  // /battle head-to-head wins — the fast human-preference signal. '—' when no battles ran.
  { key: 'battle_wins', higherIsBetter: true, fmt: (v) => (v == null ? '—' : `${v}`) },
  { key: 'avg_total_ms', higherIsBetter: false, fmt: (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()} ms`) },
  { key: 'avg_cost_usd', higherIsBetter: false, fmt: (v) => (v == null ? '—' : `$${v.toFixed(4)}`) },
  { key: 'compliance_rate', higherIsBetter: true, fmt: (v) => (v == null ? '—' : `${v}%`) },
  { key: 'fallback_rate', higherIsBetter: false, fmt: (v) => (v == null ? '—' : `${v}%`) },
];

/** Copy for a compared metric. */
export const metricLabelKey = (key: MetricKey | string): string => `admin.experiments.metric.${key}`;

/** -1 control better, 1 treatment better, 0 tie/unknown. */
function winner(a: number | null, b: number | null, higherIsBetter: boolean): -1 | 0 | 1 {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a === b) return 0;
  const aBetter = higherIsBetter ? a > b : a < b;
  return aBetter ? -1 : 1;
}

/**
 * Verdict tone and copy (§4.4). String-keyed + a tolerant getter so the widened union
 * ('keep_control', 'equivalent', …) renders without pinning to an exact enum shape.
 *
 * `labelKey` rather than a label, for the module-scope reason. `promote_control` is a legacy alias and
 * deliberately points at the same key as `keep_control` - two keys with identical English would drift the
 * moment someone edited one of them.
 */
const VERDICT_META: Record<string, { labelKey: string; tone: string }> = {
  promote_treatment: { labelKey: 'admin.experiments.verdict.promoteTreatment', tone: 'win' },
  keep_control: { labelKey: 'admin.experiments.verdict.keepControl', tone: 'hold' },
  promote_control: { labelKey: 'admin.experiments.verdict.keepControl', tone: 'hold' }, // legacy alias
  keep_running: { labelKey: 'admin.experiments.verdict.keepRunning', tone: 'wait' },
  equivalent: { labelKey: 'admin.experiments.verdict.equivalent', tone: 'wait' },
  inconclusive: { labelKey: 'admin.experiments.verdict.inconclusive', tone: 'wait' },
};

/**
 * An unrecognised verdict keeps its raw value as the label, which is why the fallback is a `defaultValue`
 * at the render site rather than a key: a key that does not exist would render as the key itself, and a
 * reader seeing `admin.experiments.verdict.something_new` learns less than seeing `something_new`.
 */
function verdictMeta(verdict: string): { labelKey: string | null; raw: string; tone: string } {
  const known = VERDICT_META[verdict];
  return { labelKey: known?.labelKey ?? null, raw: verdict, tone: known?.tone ?? 'wait' };
}

// ============================================================
// An experiment in one line: its name, goal, comparison, evidence and current result
// ============================================================

/** What a person calls an experiment: its description, else its id. */
export function experimentName(exp: Pick<Experiment, 'experimentId' | 'description'>): string {
  return exp.description?.trim() || exp.experimentId;
}

/** The objective's metric and bar as a label key (`Quality ≥4% target`), shared by the goal and the progress banner. */
export function objectiveLabelOf(objective: Pick<ExperimentObjective, 'metric' | 'target'>): { key: string; values: { target: number } } {
  const key = objective.metric === 'cost'
    ? 'admin.experiments.objective.costTarget'
    : objective.metric === 'latency'
      ? 'admin.experiments.objective.latencyTarget'
      : objective.metric === 'quality'
        ? 'admin.experiments.objective.qualityTarget'
        : 'admin.experiments.objective.accuracyTarget';
  return { key, values: { target: objective.target } };
}

/** The goal in words: the written statement when there is one, else the metric it decides on. */
function goalLine(exp: Experiment, t: TFunction): string {
  if (exp.objective?.statement?.trim()) return exp.objective.statement.trim();
  if (exp.objective) {
    const label = objectiveLabelOf(exp.objective);
    return t('admin.experiments.goal.decidesOnLine', { metric: t(label.key, label.values) });
  }
  return t('admin.experiments.goal.none');
}

/** "v12 vs v13": the control (live now) against the challenger (being tested). */
function versusLine(exp: Experiment, t: TFunction): string {
  const [control, challenger] = exp.variants ?? [];
  if (!control || !challenger) return exp.experimentId;
  return t('admin.experiments.compare.versus', {
    control: versionLabelOf(exp, control.variantId, modelDisplayName),
    challenger: versionLabelOf(exp, challenger.variantId, modelDisplayName),
  });
}

/** "Advisor: v12 vs v13", naming the assistant when the experiment compares two versions of one. */
function comparisonLine(exp: Experiment, t: TFunction): string {
  const assistant = comparedAssistantOf(exp);
  const versus = versusLine(exp, t);
  return assistant ? t('admin.experiments.compare.withAssistant', { assistant, versus }) : versus;
}

/** "240 conversations · 9 battles": the evidence so far, battles only where Battle Mode is on. */
function evidenceLine(exp: Experiment, resultsData: AnalyticsResult | null, t: TFunction): string {
  const units = [...unitsForExperiment(resultsData?.units?.data, exp.experimentId).values()];
  const conversations = units.reduce((n, u) => n + u.conversation_count, 0);
  const parts = [t('admin.experiments.evidence.conversations', { count: conversations })];
  if (exp.battleEnabled) {
    const battles = battleSummaryOf(resultsData?.battleEffectiveness?.data ?? [], exp.experimentId)?.battles ?? 0;
    parts.push(t('admin.experiments.evidence.battles', { count: battles }));
  }
  return parts.join(' · ');
}

/**
 * WHETHER A COMPARISON IS STILL BELOW THE SAMPLE FLOOR, the one rule the comparison's banner and the list's
 * result line both read.
 *
 * When the recommendation is in hand it wins outright: it reports the floor this deployment applies
 * (`minSamplePerVariant`) and has judged the summed data against it, counted in CONVERSATIONS (§4.2). Without
 * it, the backend's own per-variant flag decides, and no local count against a hardcoded number overrides a
 * backend "sufficient".
 */
export function belowSampleFloor(
  control: VariantAgg | undefined,
  treatment: VariantAgg | undefined,
  units: Map<string, VariantUnitCounts> | undefined,
  reco?: { minSamplePerVariant?: number; variants?: Array<{ conversation_count?: number; exchange_count: number }> },
): boolean {
  const floor = reco?.minSamplePerVariant;
  const controlUnits = control ? units?.get(control.variant_id) : undefined;
  const treatmentUnits = treatment ? units?.get(treatment.variant_id) : undefined;
  const smallest = smallestConversationCount(reco?.variants?.length ? reco.variants : [controlUnits, treatmentUnits]);
  return floor != null && smallest != null
    ? smallest < floor
    : Boolean(control?.needs_more_data && treatment?.needs_more_data);
}

/** The metric an objective decides on, as the comparison's row; accuracy has none yet. */
const OBJECTIVE_METRIC: Record<string, MetricKey | null> = {
  quality: 'avg_score',
  cost: 'avg_cost_usd',
  latency: 'avg_total_ms',
  accuracy: null,
};

/** Below this difference, in percent, the point estimate reads as no difference (as the recommendation's lead does). */
const NO_DIFFERENCE_PCT = 0.5;

export type ResultSummary =
  | { state: 'decided'; outcome: 'promoted_treatment' | 'kept_control' }
  | { state: 'noData' }
  | { state: 'waiting' }
  | { state: 'notMeasured'; metric: string }
  | { state: 'even'; metric: string; thin: boolean }
  | { state: 'leads'; metric: string; leader: 'control' | 'challenger'; liftPct: number; thin: boolean };

/**
 * AN EXPERIMENT'S CURRENT RESULT IN ONE LINE, from the same pieces its Results section uses: the recorded
 * decision when one was made, else the comparison on the objective's metric (quality when none was set, as
 * the recommendation defaults), with the sample floor deciding whether it is decisive yet.
 */
export function summarizeResult(exp: Experiment, resultsData: AnalyticsResult | null): ResultSummary {
  const outcome = exp.decision?.outcome;
  if (outcome === 'promoted_treatment' || outcome === 'kept_control') return { state: 'decided', outcome };
  const rows = ((resultsData?.data as unknown as ExperimentResultRow[]) ?? []).filter((r) => r.experiment_id === exp.experimentId);
  if (rows.length === 0) return { state: 'noData' };
  const { control, treatment } = groupExperiments(rows)[0];
  if (!control || !treatment) return { state: 'waiting' };
  const metric = exp.objective?.metric ?? 'quality';
  const key = OBJECTIVE_METRIC[metric] ?? null;
  const spec = METRICS.find((m) => m.key === key);
  const c = key ? control[key] : null;
  const tr = key ? treatment[key] : null;
  if (!spec || c == null || tr == null || c === 0) return { state: 'notMeasured', metric };
  const thin = belowSampleFloor(control, treatment, unitsForExperiment(resultsData?.units?.data, exp.experimentId));
  // Positive when the challenger is better on this metric (higher quality, lower cost or latency).
  const improvement = spec.higherIsBetter ? ((tr - c) / c) * 100 : ((c - tr) / c) * 100;
  if (Math.abs(improvement) < NO_DIFFERENCE_PCT) return { state: 'even', metric, thin };
  return { state: 'leads', metric, leader: improvement > 0 ? 'challenger' : 'control', liftPct: Math.round(Math.abs(improvement)), thin };
}

/** The result line a list row shows. */
function resultLine(r: ResultSummary, t: TFunction): string {
  const metric = (m: string) => t(`admin.experiments.result.metric.${m}`);
  const decisive = (thin: boolean) => t(thin ? 'admin.experiments.result.notDecisive' : 'admin.experiments.result.sampleReached');
  switch (r.state) {
    case 'decided':
      return t('admin.experiments.result.decided', {
        outcome: t(r.outcome === 'promoted_treatment' ? 'admin.experiments.chosen.promotedTreatment' : 'admin.experiments.chosen.keptControl'),
      });
    case 'noData':
      return t('admin.experiments.result.noData');
    case 'waiting':
      return t('admin.experiments.result.waiting');
    case 'notMeasured':
      return t('admin.experiments.result.notMeasured', { metric: metric(r.metric) });
    case 'even':
      return `${t('admin.experiments.result.even', { metric: metric(r.metric) })} · ${decisive(r.thin)}`;
    case 'leads':
      return `${t('admin.experiments.result.leads', {
        leader: t(`admin.battles.role.${r.leader}`),
        metric: metric(r.metric),
        pct: r.liftPct,
      })} · ${decisive(r.thin)}`;
  }
}

/** The Goal section of an experiment's page: what it is testing, the metric it decides on, and its guardrails. */
function ExperimentGoal({ experiment }: { experiment: Experiment }) {
  const { t } = useTranslation();
  const objective = experiment.objective;
  const label = objective ? objectiveLabelOf(objective) : null;
  return (
    <section className="admin-section" data-testid="experiment-goal" aria-labelledby="experiment-goal-title">
      <h4 id="experiment-goal-title">{t('admin.experiments.goal.title')}</h4>
      <p>{objective?.statement?.trim() || t('admin.experiments.goal.none')}</p>
      <dl className="admin-config-list">
        <dt>{t('admin.experiments.goal.decidesOn')}</dt>
        <dd>{label ? t(label.key, label.values) : t('admin.experiments.goal.defaultMetric')}</dd>
        {(objective?.guardrails?.length ?? 0) > 0 && (
          <>
            <dt>{t('admin.experiments.guardrails')}</dt>
            <dd>
              {objective!.guardrails!.map((g) => t(
                g.direction === 'no_worse_than' ? 'admin.experiments.noWorseThan' : 'admin.experiments.atLeast',
                { metricName: t(`admin.experiments.${g.metric}`), bound: g.bound },
              )).join(' · ')}
            </dd>
          </>
        )}
        <dt>{t('admin.experiments.goal.compares')}</dt>
        <dd>{comparisonLine(experiment, t)}</dd>
        <dt>{t('admin.experiments.goal.scope')}</dt>
        <dd>{[experiment.intent, ...(experiment.tiers ?? []).map(classificationName)].filter(Boolean).join(' · ')}</dd>
      </dl>
    </section>
  );
}

/**
 * ONE EXPERIMENT'S RESULTS, on its own page and titled with its name: per-version metrics from real traffic,
 * the recommendation and why, and Promote. Never rendered for several experiments at once, so a number on
 * screen always belongs to the experiment the heading names.
 */
function ExperimentResults({
  resultsData,
  experiments,
  experimentId,
  title,
  actions,
  onOpenConversation,
  dashboardRange,
}: {
  resultsData: AnalyticsResult | null;
  experiments: Experiment[];
  experimentId: string;
  /** The experiment's name, which the section is titled with. */
  title: string;
  /** The experiment's own actions beside the title (Promote). */
  actions?: React.ReactNode;
  onOpenConversation?: (channelArn: string, message?: MessageLink) => void;
  /** The window the DASHBOARD is showing. Its on-demand calls must use the same one. */
  dashboardRange?: AnalyticsDateRange;
}) {
  const { t: translate } = useTranslation();
  const [includeBattle, setIncludeBattle] = useState(false);
  const [overrideRows, setOverrideRows] = useState<ExperimentResultRow[] | null>(null);
  // The per-variant units of the population on screen: re-read with the rows when battle turns are merged.
  const [overrideUnits, setOverrideUnits] = useState<ExperimentUnitsRow[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [recos, setRecos] = useState<Record<string, { loading: boolean; data?: ExperimentRecommendation; error?: string }>>({});

  // THE DASHBOARD'S OWN WINDOW, not a second one that claims to mirror it: the recommendation card and
  // the head-to-head table are computed over the same window, so they reconcile.
  const fallbackRange: AnalyticsDateRange = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, []);
  const dateRange = dashboardRange ?? fallbackRange;

  const baseRows = (resultsData?.data as unknown as ExperimentResultRow[]) ?? [];
  const rows = overrideRows ?? baseRows;
  const groups = useMemo(
    () => groupExperiments(rows.filter((r) => r.experiment_id === experimentId)),
    [rows, experimentId],
  );
  const unitRows = overrideUnits ?? resultsData?.units?.data;
  const experiment = experiments.find((e) => e.experimentId === experimentId);

  async function toggleBattle(next: boolean) {
    setIncludeBattle(next);
    if (!next) {
      setOverrideRows(null);
      setOverrideUnits(null);
      return;
    }
    setFetching(true);
    try {
      const res = await queryAnalytics('experiment_results', dateRange, { includeBattle: 'true' });
      setOverrideRows((res.data as unknown as ExperimentResultRow[]) ?? []);
      setOverrideUnits(res.units?.data ?? []);
    } catch {
      setOverrideRows([]);
      setOverrideUnits([]);
    } finally {
      setFetching(false);
    }
  }

  async function loadReco(id: string) {
    setRecos((p) => ({ ...p, [id]: { loading: true } }));
    try {
      // Send the experiment's OWN objective + recorded decision. The backend reads both from the
      // request (it never re-reads the record), so omitting them would evaluate every experiment
      // against a quality-primary default with no guardrails and no power check.
      const data = await getExperimentRecommendation(id, dateRange, {
        objective: experiment?.objective,
        decision: experiment?.decision,
      });
      setRecos((p) => ({ ...p, [id]: { loading: false, data } }));
    } catch (e) {
      setRecos((p) => ({ ...p, [id]: { loading: false, error: e instanceof Error ? e.message : translate('admin.experiments.failedToLoadRecommendation') } }));
    }
  }

  return (
    <section className="admin-section exp-results" data-testid="experiment-results" aria-labelledby="experiment-results-title">
      <div className="exp-results-head">
        <div>
          <h4 id="experiment-results-title">{translate('admin.experiments.resultsTitle', { name: title })}</h4>
          <p className="admin-tab-description">{translate('admin.experiments.resultsHelp')}</p>
        </div>
        {actions}
        {/* This toggle MERGES battle turns into the probabilistic metric averages. That is a statistical
            trade, not a display preference: a battle version is CHOSEN by a person rather than randomly
            assigned, so folding those turns into the A/B comparison biases it. Off by default, and the
            label says the consequence. People's picks are reported in Battles regardless. */}
        <label className="exp-results-toggle" title={translate('admin.experiments.battleTurnsToggleHelp')}>
          <input type="checkbox" checked={includeBattle} onChange={(e) => toggleBattle(e.target.checked)} />
          <span>{translate('admin.experiments.mergeBattleTurnsIntoMetrics')}</span>
        </label>
      </div>

      {fetching && <p className="admin-tab-description">{translate('admin.experiments.loading')}</p>}

      {!fetching && groups.length === 0 && (
        <p className="admin-tab-description">{translate('admin.experiments.noResultsForExperiment')}</p>
      )}

      {groups.map((g) => (
        <ExperimentComparison
          key={g.experimentId}
          group={g}
          objective={experiment?.objective ?? undefined}
          reco={recos[g.experimentId]}
          onRecommend={() => loadReco(g.experimentId)}
          units={unitsForExperiment(unitRows, g.experimentId)}
          experiment={experiment}
          dateRange={dateRange}
          includeBattle={includeBattle}
          onOpenConversation={onOpenConversation}
        />
      ))}
    </section>
  );
}

// ── Advisory objective progress ──────────────
// Treatment-vs-control against the target. Advisory only: it frames the
// decision, never auto-acts. 'pending' when the signal isn't available yet
// (cost/latency need both estimates; quality needs evaluator scores; accuracy
// needs the classifier-accuracy eval, which isn't built — always pending here).

type ObjectiveStatus = 'met' | 'not_met' | 'pending';

/**
 * Advisory objective progress.
 *
 * `labelKey`/`noteKey` rather than text: `evaluateObjective` is module scope and exported for its own
 * test, so it names copy and the view resolves it. `labelValues` carries the target percentage the label
 * interpolates, which also lets a translator put the number where the sentence needs it.
 */
interface ObjectiveProgress {
  labelKey: string;
  labelValues: Record<string, string | number>;
  currentText: string;
  status: ObjectiveStatus;
  noteKey?: string;
}

export function evaluateObjective(
  objective: ExperimentObjective,
  control: VariantAgg,
  treatment: VariantAgg,
): ObjectiveProgress {
  const { metric, target } = objective;

  const { key: labelKey, values: labelValues } = objectiveLabelOf(objective);
  if (metric === 'cost' || metric === 'latency') {
    const key = metric === 'cost' ? 'avg_cost_usd' : 'avg_total_ms';
    const c = control[key];
    const t = treatment[key];
    if (c == null || t == null || c === 0) {
      return { labelKey, labelValues, currentText: '—', status: 'pending', noteKey: 'admin.experiments.objective.awaitingData' };
    }
    const pctDecrease = ((c - t) / c) * 100; // positive ⇒ treatment cheaper/faster
    const sign = pctDecrease >= 0 ? '−' : '+';
    return {
      labelKey,
      labelValues,
      currentText: `${sign}${Math.abs(pctDecrease).toFixed(0)}% vs control`,
      status: pctDecrease >= target ? 'met' : 'not_met',
    };
  }

  if (metric === 'quality') {
    const t = treatment.avg_score;
    if (t == null) {
      return { labelKey, labelValues, currentText: '—', status: 'pending', noteKey: 'admin.experiments.objective.awaitingScores' };
    }
    return { labelKey, labelValues, currentText: `${t} (treatment score)`, status: t >= target ? 'met' : 'not_met' };
  }

  // accuracy — the classifier-accuracy eval (judge agreement + thumbs) isn't built yet.
  return {
    labelKey,
    labelValues,
    currentText: '—',
    status: 'pending',
    noteKey: 'admin.experiments.objective.accuracyPending',
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
  const { t: translate } = useTranslation();
  const p = evaluateObjective(objective, control, treatment);
  const badge = translate(`admin.experiments.objective.badge.${p.status}`);
  const guardrails = objective.guardrails ?? [];
  return (
    <div className="exp-objective" data-status={p.status}>
      {objective.statement && <p className="exp-objective-statement">{objective.statement}</p>}
      <div className="exp-objective-primary">
        <span className="exp-objective-label">{translate('admin.experiments.objective.prefix', { label: translate(p.labelKey, p.labelValues) })}</span>
        <span className="exp-objective-current">{p.currentText}</span>
        <span className="exp-objective-badge">{badge}</span>
        {guardrails.map((gr, i) => {
          const g = evaluateGuardrail(gr, control, treatment);
          return (
            <span className="exp-objective-guardrail" data-status={g.status} key={i} title={g.currentText}>
              {g.label}: {translate(`admin.experiments.guardrail.${g.status}`)}
            </span>
          );
        })}
        <span className="exp-objective-tag">
          {translate('admin.experiments.objective.advisory')}
          {p.noteKey ? ` · ${translate(p.noteKey)}` : ''}
        </span>
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
  const { t: translate } = useTranslation();
  if (!n) return null; // nothing recorded on this axis for this variant — a link would lead nowhere
  const open = drill?.axis === axis && drill?.variantId === variantId;
  return (
    <button
      className="btn-link exp-drill-btn"
      aria-expanded={open}
      onClick={() => onOpen(axis, variantId)}
      title={translate('admin.experiments.showTheThisNumberIs', { countLabel: translate(axisKey(axis, 'countLabel')).toLowerCase() })}
    >
      {translate(open ? 'admin.experiments.drill.hide' : 'admin.experiments.drill.show', {
        countLabel: translate(axisKey(axis, 'countLabel')).toLowerCase(),
      })}
    </button>
  );
}

function ExperimentComparison({
  group,
  objective,
  reco,
  onRecommend,
  units,
  experiment,
  dateRange,
  includeBattle,
  onOpenConversation,
}: {
  group: ExperimentGroup;
  objective?: ExperimentObjective;
  reco?: { loading: boolean; data?: ExperimentRecommendation; error?: string };
  onRecommend: () => void;
  /** Each variant's conversations and exchanges (§4.2). Empty when the backend could not read them. */
  units?: Map<string, VariantUnitCounts>;
  experiment?: Experiment;
  dateRange: AnalyticsDateRange;
  /** Whether battle turns are folded into the figures below, so a drill-down reconciles against the
   *  SAME population the aggregate was computed from (CR-12). */
  includeBattle: boolean;
  onOpenConversation?: (channelArn: string, message?: MessageLink) => void;
}) {
  const { t: translate } = useTranslation();
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
  //
  // THE FLOOR COUNTS CONVERSATIONS (§4.2), the unit every test counts, so the comparison is against each
  // side's conversations, from the recommendation's variants when in hand and the units read otherwise.
  const recoFloor = reco?.data?.minSamplePerVariant;
  const controlUnits = control ? units?.get(control.variant_id) : undefined;
  const treatmentUnits = treatment ? units?.get(treatment.variant_id) : undefined;
  const thin = belowSampleFloor(control, treatment, units, reco?.data);
  const hasUnits = Boolean(controlUnits || treatmentUnits);

  return (
    <div className="exp-compare">
      <div className="exp-compare-head">
        <div className="exp-compare-title">
          <span className="exp-compare-id">{experiment ? versusLine(experiment, translate) : group.experimentId}</span>
          <span className="exp-compare-meta">
            {group.intent}{group.tier ? ` · ${group.tier}` : ''} ·{' '}
            {hasUnits ? <SampleMeta variants={[controlUnits, treatmentUnits]} /> : `${totalN.toLocaleString()} exchanges`}
          </span>
        </div>
        <button className="btn-secondary" onClick={onRecommend} disabled={reco?.loading}>
          {reco?.loading
            ? translate('admin.experiments.reco.analyzing')
            : reco?.data
              ? translate('admin.experiments.reco.refresh')
              : translate('admin.experiments.reco.get')}
        </button>
      </div>

      {thin && (
        <div className="exp-thin-banner">
          {translate('admin.experiments.belowConversationFloor', { value: recoFloor ?? reco?.data?.minSamplePerVariant ?? '' })}
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
                  {m.key === 'avg_cost_usd' && a == null && <em className="exp-hint">{translate('admin.experiments.noEstimate')}</em>}
                  {m.key === 'approval_rate' && control.feedback_count > 0 && (
                    <em className="exp-hint">{control.feedback_count} rating{control.feedback_count === 1 ? '' : 's'}</em>
                  )}
                  {m.key === 'approval_rate' && <DrillButton drill={drill} onOpen={openDrill} axis="approval" variantId="control" n={control.feedback_count} />}
                  {m.key === 'battle_wins' && <DrillButton drill={drill} onOpen={openDrill} axis="picks" variantId="control" n={control.battle_wins} />}
                </span>
                <span className="exp-metric-label">{translate(metricLabelKey(m.key))}</span>
                <span className={`exp-metric-val${w === 1 ? ' is-winner' : ''}`}>
                  {m.fmt(b)}
                  {m.key === 'avg_cost_usd' && b == null && <em className="exp-hint">{translate('admin.experiments.noEstimate')}</em>}
                  {m.key === 'approval_rate' && treatment.feedback_count > 0 && (
                    <em className="exp-hint">{treatment.feedback_count} rating{treatment.feedback_count === 1 ? '' : 's'}</em>
                  )}
                  {m.key === 'approval_rate' && <DrillButton drill={drill} onOpen={openDrill} axis="approval" variantId="treatment" n={treatment.feedback_count} />}
                  {m.key === 'battle_wins' && <DrillButton drill={drill} onOpen={openDrill} axis="picks" variantId="treatment" n={treatment.battle_wins} />}
                </span>
              </div>
            );
          })}

          {/* The unit the tests count, above the unit the means are taken over (§4.2). */}
          {hasUnits && (
            <div className="exp-metric-row exp-metric-row--sample">
              <SampleConversationsCells control={controlUnits} treatment={treatmentUnits} />
            </div>
          )}

          <div className="exp-metric-row exp-metric-row--sample">
            <span className="exp-metric-val">
              {control.exchange_count.toLocaleString()}
              <DrillButton drill={drill} onOpen={openDrill} axis="metrics" variantId="control" n={control.exchange_count} />
            </span>
            <span className="exp-metric-label">{translate('admin.experiments.sampleExchanges')}</span>
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
            <span className="exp-metric-label">{translate('admin.experiments.scoredByTheEvaluator')}</span>
            <span className="exp-metric-val">{treatment.scored_count.toLocaleString()}</span>
          </div>
        </>
      ) : (
        <p className="admin-tab-description">
          {translate('admin.experiments.waitingForBothVariantsTo')}
        </p>
      )}

      {reco?.error && <div className="admin-error"><span>{reco.error}</span></div>}
      {reco?.data && (
        <RecommendationCard reco={reco.data as unknown as RecommendationView} decision={experiment?.decision} />
      )}

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

function VariantHeader({ variant, side }: { variant: VariantAgg; side: 'A' | 'B' }) {
  return (
    <div className="exp-variant-head">
      <span className="exp-variant-side">{side} · {variant.variant_id}</span>
      <span className="exp-variant-model">{modelDisplayName(variant.model_name)}</span>
    </div>
  );
}

// Significance-aware label for the primary metric (§4.2-C): replaces a bare a>b highlight.
/**
 * Significance-aware label for the primary metric (§4.2-C): replaces a bare a>b highlight.
 *
 * Returns a KEY and the leader it interpolates, because this is module scope. The leader is itself a key,
 * so "Treatment" and "Control" are translated rather than embedded as English inside a sentence.
 */
function primaryLeadLabel(p: { metric: string; deltaPct: number; significant: boolean; pValue: number }): {
  textKey: string;
  values: Record<string, string>;
  tone: string;
} {
  const EPS = 0.5; // percent — below this the point estimate is "no difference"
  if (Math.abs(p.deltaPct) < EPS) return { textKey: 'admin.experiments.lead.noDifference', values: {}, tone: 'wait' };
  const higherBetter = /quality|accuracy/i.test(p.metric);
  const treatmentLeads = higherBetter ? p.deltaPct > 0 : p.deltaPct < 0;
  const values = { leader: treatmentLeads ? 'admin.experiments.lead.treatment' : 'admin.experiments.lead.control' };
  if (!p.significant) return { textKey: 'admin.experiments.lead.notSignificant', values, tone: 'wait' };
  const tone = treatmentLeads ? 'win' : 'hold';
  return p.pValue < 0.01
    ? { textKey: 'admin.experiments.lead.p01', values, tone }
    : { textKey: 'admin.experiments.lead.p05', values, tone };
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
  /** `duels` is the unit the pick interval is computed in; `picks` the decisive picks. */
  human?: { picks: number; duels?: number; winRate: number; ci: [number, number]; significant: boolean };
  recommendedVsChosen?: { recommended: string; chosen?: DecisionOutcome };
  /** Both units per variant (§4.2): the tests count conversations, the means are over exchanges. */
  variants?: Array<{ variant_id: string; conversation_count?: number; exchange_count: number }>;
  /** Conversations per variant THIS deployment requires before a verdict is decision-grade. Configurable,
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
  const { t: translate } = useTranslation();
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
    // In CONVERSATIONS, the unit the floor and the power calculation count (§4.2).
    const minConversations = smallestConversationCount(reco.variants ?? []) ?? 0;
    const needFloor = floor - minConversations;
    underpowered =
      needFloor > 0
        ? translate('admin.experiments.underpoweredNeedMorePerVariant', { needFloor: needFloor, value: floor })
        : translate('admin.experiments.underpowered');
  }

  return (
    <div className="exp-reco" data-tone={meta.tone}>
      <div className="exp-reco-head">
        <span className="exp-reco-badge">{meta.labelKey ? translate(meta.labelKey) : meta.raw}</span>
        <span className="exp-reco-confidence">{reco.confidence} confidence</span>
        <span className="exp-reco-tag">{translate('admin.experiments.advisoryNotAutoApplied')}</span>
      </div>

      <UnitOfAnalysisNote variants={reco.variants} />

      {primary && (
        <div className="exp-reco-primary">
          {underpowered ? (
            <span className="exp-reco-underpowered" data-status="underpowered">{underpowered}</span>
          ) : (
            (() => {
              const lead = primaryLeadLabel(primary);
              return (
                <span className="exp-reco-lead" data-tone={lead.tone}>
                  {primary.metric}: {translate(lead.textKey, {
                    leader: lead.values.leader ? translate(lead.values.leader) : '',
                  })}
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
            const label = g.held ? 'held' : g.breached ? 'breached' : translate('admin.experiments.notEstablished');
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
          Humans: {Math.round(reco.human.winRate * 100)}% picked treatment (
          {reco.human.duels != null
            ? translate('admin.experiments.picksInBattles', { picks: reco.human.picks, battles: reco.human.duels })
            : `${reco.human.picks} picks`}
          ) · CI [
          {Math.round(reco.human.ci[0] * 100)}–{Math.round(reco.human.ci[1] * 100)}%] ·{' '}
          {translate(reco.human.significant ? 'admin.experiments.ci.decisive' : 'admin.experiments.ci.notDecisive')}
        </div>
      )}

      {rvc && rvc.chosen && (() => {
        const rec = verdictMeta(rvc.recommended);
        const chosenKey = rvc.chosen === 'no_decision'
          ? 'admin.experiments.chosen.noDecision'
          : rvc.chosen === 'promoted_treatment'
            ? 'admin.experiments.chosen.promotedTreatment'
            : 'admin.experiments.chosen.keptControl';
        return (
          <div className="exp-reco-rvc">
            {translate('admin.experiments.recommendedLabel')}{' '}
            <strong>{rec.labelKey ? translate(rec.labelKey) : rec.raw}</strong>
            {' · '}
            {translate('admin.experiments.chosenLabel')}{' '}
            <strong>{translate(chosenKey)}</strong>
          </div>
        );
      })()}

      <p className="exp-reco-rationale">{reco.rationale}</p>
    </div>
  );
}

export default ExperimentsTab;
