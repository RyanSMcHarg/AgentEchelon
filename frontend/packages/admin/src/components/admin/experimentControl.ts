/**
 * WHETHER THE CONTROL IS THE LIVE ASSISTANT'S ACTIVE VERSION, so the form offers no model for it
 * (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5). An intent or base-model experiment's control is; a profile
 * experiment references its control, and a classification experiment's control names the live classifier
 * for the classifier gate to replay (the server refuses one that is not the live one).
 */
export function controlIsLiveVersion(type: string): boolean {
  return type === 'intent' || type === 'base_model';
}

/**
 * THE NAME THE DUEL GAVE A BATTLE VARIANT, from the experiment's read-only `sideNames` (the backend resolves
 * them from each side's pinned version, as the room names them). variants[0] is the control and variants[1]
 * the challenger. Undefined when the variant is neither or its name did not resolve; the caller then shows
 * the variant id alone.
 */
export function duelSideName(
  experiment: { variants?: Array<{ variantId: string }>; sideNames?: { control?: string; treatment?: string } } | undefined,
  variantId: string,
): string | undefined {
  if (!experiment?.sideNames || !experiment.variants) return undefined;
  const index = experiment.variants.findIndex((v) => v.variantId === variantId);
  if (index === 0) return experiment.sideNames.control;
  if (index === 1) return experiment.sideNames.treatment;
  return undefined;
}

/** An experiment's two versions in its own terms: the control is the version live now, the challenger the one being tested. */
export type VersionRole = 'control' | 'challenger';

type ExperimentShape = {
  variants?: Array<{
    variantId: string;
    modelKey?: string;
    profileRef?: { profileName: string; version?: number };
    controlPin?: { profileName: string; version: number };
    altPin?: { profileName: string; version: number };
  }>;
  sideNames?: { control?: string; treatment?: string };
};

/** Which of the experiment's versions a variant is: variants[0] is the control, variants[1] the challenger. */
export function versionRoleOf(experiment: ExperimentShape | undefined, variantId: string): VersionRole | null {
  const index = experiment?.variants?.findIndex((v) => v.variantId === variantId) ?? -1;
  if (index === 0) return 'control';
  if (index === 1) return 'challenger';
  return null;
}

/**
 * What a version IS, as short as a person reads it: the pinned version number (`v13`), else the profile it runs,
 * else the model, else the variant id. `modelName` turns a model key into its display name.
 */
export function versionLabelOf(
  experiment: ExperimentShape | undefined,
  variantId: string,
  modelName: (key: string) => string = (k) => k,
): string {
  const v = experiment?.variants?.find((x) => x.variantId === variantId);
  if (!v) return variantId;
  const pinned = v.controlPin?.version ?? v.altPin?.version;
  if (pinned != null) return `v${pinned}`;
  if (v.profileRef) {
    const { profileName, version } = v.profileRef;
    if (version == null) return profileName;
    // Two versions of the assistant the comparison already names read as their numbers alone.
    return profileName === comparedAssistantOf(experiment) ? `v${version}` : `${profileName} v${version}`;
  }
  if (v.modelKey) return modelName(v.modelKey);
  return variantId;
}

/** The assistant an experiment compares two versions of, when its control is a pinned or referenced profile. */
export function comparedAssistantOf(experiment: ExperimentShape | undefined): string | undefined {
  const control = experiment?.variants?.[0];
  return control?.controlPin?.profileName ?? control?.profileRef?.profileName;
}
