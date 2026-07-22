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
  type Experiment,
  type ExperimentVariant,
  type ExperimentObjective,
  type ImageGenModelKey,
} from '@ae/shared';
import { queryAnalytics, getExperimentRecommendation } from '../../services/analyticsService';
import type {
  AnalyticsDateRange,
  AnalyticsResult,
  BattleEffectivenessRow,
  ExperimentRecommendation,
  ExperimentResultRow,
  ExperimentVerdict,
} from '@ae/shared';

interface ExperimentsTabProps {
  resultsData: AnalyticsResult | null;
  isLoading: boolean;
  /** Register a "close the results detail first" handler so global/browser Back steps out of a focused
   *  experiment's results before walking tab history. */
  registerBack?: (close: (() => void) | null) => void;
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

const MODEL_OPTIONS = [
  { value: 'haiku', label: 'Claude Haiku' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'titan', label: 'Amazon Titan' },
  { value: 'gpt_oss_20b', label: 'GPT-OSS 20B' },
  { value: 'gpt_oss_120b', label: 'GPT-OSS 120B' },
];

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

const ExperimentsTab: React.FC<ExperimentsTabProps> = ({ resultsData, isLoading: _isLoading, registerBack }) => {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // #8 drill-down: null = show every experiment's comparison; an id = focus that
  // one experiment's results (with a "← All experiments" control to clear it).
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  // Available assistant profiles + versions, for profile-vs-profile experiments (SPEC-PORTABLE §6).
  const [profileOptions, setProfileOptions] = useState<ProfileListing[]>([]);
  useEffect(() => { listProfiles().then(setProfileOptions).catch(() => setProfileOptions([])); }, []);

  // Create form state
  const [newExperiment, setNewExperiment] = useState({
    experimentId: '',
    // 'intent'/'base_model'/'classification' vary a MODEL; 'profile' pits two whole assistant PROFILE
    // versions against each other (SPEC-PORTABLE-VERSIONED-PROFILES §6 — profileRef variants).
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
    description: '',
    // Advisory objective (optional). Empty
    // metric ⇒ no objective. endDate optional; startDate is auto-stamped today.
    endDate: '',
    objectiveMetric: '' as '' | 'cost' | 'accuracy' | 'quality' | 'latency',
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

    // A variant runs either a MODEL (modelKey) or a whole PROFILE version (profileRef) — mutually
    // exclusive (backend-validated). SPEC-PORTABLE-VERSIONED-PROFILES §6.
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

    // Objective (optional, advisory). When a metric is chosen the target must
    // be a percentage in [0, 100]; fail fast locally with a clear message.
    let objective: { metric: 'cost' | 'accuracy' | 'quality' | 'latency'; target: number } | undefined;
    if (newExperiment.objectiveMetric) {
      const target = Number(newExperiment.objectiveTarget);
      if (!Number.isFinite(target) || target < 0 || target > 100) {
        setActionError('Objective target must be a percentage between 0 and 100.');
        return;
      }
      objective = { metric: newExperiment.objectiveMetric, target };
    }

    try {
      setActionError(null);
      await createExperiment({
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
        description: newExperiment.description,
        ...(objective && { objective }),
        ...(newExperiment.battleEnabled && {
          battleEnabled: true,
          altBotSlotId: newExperiment.altBotSlotId,
        }),
      });
      setShowCreate(false);
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
        description: '',
        endDate: '',
        objectiveMetric: '',
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
      await loadExperiments();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create experiment');
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
                content="Intent tests which model best serves a specific detected intent (objective: quality). Classification tests the accuracy of the intent classifier itself — how well requests are labelled (objective: accuracy). Base Model compares default base models across all intents."
              />
              <select
                value={newExperiment.experimentType}
                onChange={(e) => setNewExperiment((p) => {
                  const experimentType = e.target.value as 'intent' | 'base_model' | 'classification' | 'profile';
                  // Keep the objective metric valid for the new type: accuracy is
                  // classification-only; quality is base_model/intent-only.
                  let objectiveMetric = p.objectiveMetric;
                  if (experimentType === 'classification' && objectiveMetric === 'quality') objectiveMetric = '';
                  if (experimentType !== 'classification' && objectiveMetric === 'accuracy') objectiveMetric = '';
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
              Description
              <input
                type="text"
                value={newExperiment.description}
                onChange={(e) => setNewExperiment((p) => ({ ...p, description: e.target.value }))}
                placeholder="Optional description"
              />
            </label>
            <label>
              End Date
              <input
                type="date"
                value={newExperiment.endDate}
                onChange={(e) => setNewExperiment((p) => ({ ...p, endDate: e.target.value }))}
              />
              <span className="admin-field-hint">Optional. Starts today; defaults to open-ended.</span>
            </label>
            <label>
              Objective (advisory)
              <select
                value={newExperiment.objectiveMetric}
                onChange={(e) => setNewExperiment((p) => ({ ...p, objectiveMetric: e.target.value as typeof p.objectiveMetric }))}
              >
                <option value="">None</option>
                <option value="cost">Cost (% decrease)</option>
                {newExperiment.experimentType === 'classification'
                  ? <option value="accuracy">Accuracy (% target)</option>
                  : <option value="quality">Quality (% target)</option>}
                <option value="latency">Latency (% decrease)</option>
              </select>
            </label>
            {newExperiment.objectiveMetric && (
              <label>
                Target (%)
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={newExperiment.objectiveTarget}
                  onChange={(e) => setNewExperiment((p) => ({ ...p, objectiveTarget: e.target.value }))}
                  placeholder="e.g. 20"
                />
              </label>
            )}
          </div>

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
        <h4>Active Experiments</h4>
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
                    {exp.status !== 'completed' && (
                      <button className="admin-inline-btn danger" onClick={() => handleStatusChange(exp.experimentId, 'completed')}>
                        Complete
                      </button>
                    )}
                  </div>
                );
              },
            },
          ]}
          data={experiments}
          emptyMessage="No experiments configured. Create one to start comparing models."
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
        />
      )}
    </div>
  );
};

// ============================================================
// Results comparison view (decision-oriented)
// ============================================================

const MIN_SAMPLE = 30;

interface VariantAgg {
  variant_id: string;
  model_name: string;
  exchange_count: number;
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
  let exch = 0, taskCount = 0;
  let scoreN = 0, latN = 0, costN = 0, compN = 0, fbN = 0, taskN = 0;
  // Thumbs + battle wins are raw counts at the (variant,intent) row grain — sum
  // straight to the variant total, then derive approval % from the totals.
  let thumbsUp = 0, fbCount = 0, battleWins = 0;
  for (const r of rows) {
    const n = Number(r.exchange_count) || 0;
    exch += n;
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

const VERDICT_META: Record<ExperimentVerdict, { label: string; tone: string }> = {
  promote_treatment: { label: 'Promote treatment', tone: 'win' },
  promote_control: { label: 'Keep control', tone: 'hold' },
  keep_running: { label: 'Keep running', tone: 'wait' },
  inconclusive: { label: 'Inconclusive', tone: 'wait' },
};

function ExperimentResults({
  resultsData,
  experiments,
  selectedExperimentId,
  onClearSelection,
}: {
  resultsData: AnalyticsResult | null;
  experiments: Experiment[];
  selectedExperimentId?: string | null;
  onClearSelection?: () => void;
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
      const data = await getExperimentRecommendation(experimentId, dateRange);
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
        <label className="exp-results-toggle" title="Battle traffic is excluded from variant stats by default.">
          <input type="checkbox" checked={includeBattle} onChange={(e) => toggleBattle(e.target.checked)} />
          <span>Include battle traffic</span>
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
  return (
    <div className="exp-objective" data-status={p.status}>
      <span className="exp-objective-label">Objective · {p.label}</span>
      <span className="exp-objective-current">{p.currentText}</span>
      <span className="exp-objective-badge">{badge}</span>
      <span className="exp-objective-tag">advisory · not auto-applied{p.note ? ` · ${p.note}` : ''}</span>
    </div>
  );
}

function ExperimentComparison({
  group,
  objective,
  reco,
  onRecommend,
  battleRows,
  experiment,
}: {
  group: ExperimentGroup;
  objective?: ExperimentObjective;
  reco?: { loading: boolean; data?: ExperimentRecommendation; error?: string };
  onRecommend: () => void;
  battleRows?: BattleEffectivenessRow[];
  experiment?: Experiment;
}) {
  const { control, treatment } = group;
  const totalN = (control?.exchange_count ?? 0) + (treatment?.exchange_count ?? 0);
  const thin = (control?.exchange_count ?? 0) < MIN_SAMPLE || (treatment?.exchange_count ?? 0) < MIN_SAMPLE;

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
          Below {MIN_SAMPLE} exchanges on a variant — treat these numbers as directional, not decisive.
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
                </span>
                <span className="exp-metric-label">{m.label}</span>
                <span className={`exp-metric-val${w === 1 ? ' is-winner' : ''}`}>
                  {m.fmt(b)}
                  {m.key === 'avg_cost_usd' && b == null && <em className="exp-hint">no estimate</em>}
                  {m.key === 'approval_rate' && treatment.feedback_count > 0 && (
                    <em className="exp-hint">{treatment.feedback_count} rating{treatment.feedback_count === 1 ? '' : 's'}</em>
                  )}
                </span>
              </div>
            );
          })}

          <div className="exp-metric-row exp-metric-row--sample">
            <span className="exp-metric-val">{control.exchange_count.toLocaleString()}</span>
            <span className="exp-metric-label">Sample (exchanges)</span>
            <span className="exp-metric-val">{treatment.exchange_count.toLocaleString()}</span>
          </div>
        </>
      ) : (
        <p className="admin-tab-description">
          Waiting for both variants to record traffic before a head-to-head is possible.
        </p>
      )}

      {reco?.error && <div className="admin-error"><span>{reco.error}</span></div>}
      {reco?.data && <RecommendationCard reco={reco.data} />}

      {/* Battle-scoped effectiveness: /battle turns only, kept separate from the A/B table above. */}
      <BattleResults rows={battleRows ?? []} experiment={experiment} />
    </div>
  );
}

/**
 * Battle-scoped effectiveness (SPEC-BATTLE): a variant-by-variant scorecard computed from the
 * experiment's BATTLE turns ONLY. Deliberately separate from, and additional to, the probabilistic
 * A/B comparison, so a hand-picked battle prompt never biases the A/B averages. Renders nothing when
 * the experiment has no battle turns.
 */
function BattleResults({ rows, experiment }: { rows: BattleEffectivenessRow[]; experiment?: Experiment }) {
  if (!rows.length) return null;
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
                <td className="num">{r.turn_count.toLocaleString()}</td>
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

function RecommendationCard({ reco }: { reco: ExperimentRecommendation }) {
  const meta = VERDICT_META[reco.verdict];
  return (
    <div className="exp-reco" data-tone={meta.tone}>
      <div className="exp-reco-head">
        <span className="exp-reco-badge">{meta.label}</span>
        <span className="exp-reco-confidence">{reco.confidence} confidence</span>
        <span className="exp-reco-tag">AI guidance · not auto-applied</span>
      </div>
      <p className="exp-reco-rationale">{reco.rationale}</p>
    </div>
  );
}

export default ExperimentsTab;
