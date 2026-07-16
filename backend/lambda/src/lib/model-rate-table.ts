/**
 * MODEL_RATE_TABLE — single source of approximate model pricing for the
 * /battle scorecard's "Est. cost" axis and the Phase 4 image cost guard.
 *
 * Per docs/SPEC-BATTLE.md §"Battle Scoring & Per-Step Telemetry":
 *   - Text: $/1k input + $/1k output tokens.
 *   - Image (generation-out): $/image.
 *   - ONE place. APPROXIMATE BY DESIGN. Must NOT be presented as an
 *     authoritative bill — the UI shows it as an estimate with a
 *     "based on published rates; not a bill" tooltip.
 *
 * Open-source posture: these are reasonable defaults a deployer is
 * expected to review/adjust against current AWS Bedrock pricing for
 * their region and negotiated rates. Keep all numbers here so there is
 * exactly one file to edit.
 *
 * Keyed by the canonical BackendModelKey so it stays in lockstep with
 * the model catalog; a parity unit test fails if a catalog model has no
 * rate entry. `steps[].modelId` (a Bedrock model id) resolves to a key
 * via bedrockModelIdToKey().
 *
 * Honesty contract: estimateStepCostUsd returns `null` (not 0, not a
 * guess) whenever it cannot compute a real estimate — unknown model,
 * missing token counts, or an unconfigured image rate. The scorecard
 * renders "—" for null rather than a fabricated number.
 */
import {
  getModelCatalog,
  type BackendModelKey,
} from '../../../lib/config/model-strategy.js';
import {
  IMAGE_GEN_RATE_USD_PER_IMAGE as IMAGE_GEN_RATES,
  imageGenModelIdToKey,
} from './image-gen-models.js';

export interface TextModelRate {
  /** USD per 1,000 input tokens. APPROXIMATE — verify against AWS pricing. */
  inputPer1kUsd: number;
  /** USD per 1,000 output tokens. APPROXIMATE — verify against AWS pricing. */
  outputPer1kUsd: number;
}

/**
 * APPROXIMATE Bedrock on-demand text rates (USD / 1k tokens). These are
 * order-of-magnitude defaults for the scorecard estimate, NOT a billing
 * source. A deployer should reconcile against current AWS Bedrock
 * pricing for their region. Edit here only.
 */
export const MODEL_RATE_TABLE: Record<BackendModelKey, TextModelRate> = {
  haiku: { inputPer1kUsd: 0.00025, outputPer1kUsd: 0.00125 },
  sonnet: { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
  opus: { inputPer1kUsd: 0.015, outputPer1kUsd: 0.075 },
  titan: { inputPer1kUsd: 0.0005, outputPer1kUsd: 0.0015 },
  // gpt_oss_* on Bedrock — approximate placeholders; verify before relying on them.
  gpt_oss_20b: { inputPer1kUsd: 0.0002, outputPer1kUsd: 0.0006 },
  gpt_oss_120b: { inputPer1kUsd: 0.0008, outputPer1kUsd: 0.0024 },
  // DeepSeek V3.1 on Bedrock — approximate; reconcile against AWS pricing.
  deepseek_v3: { inputPer1kUsd: 0.00058, outputPer1kUsd: 0.00168 },
};

// Phase 4 model decision made: per-image rates live in
// image-gen-models.ts (IMAGE_GEN_RATES), keyed by image-gen model so
// Titan Image vs Nova Canvas price differently. The estimator resolves
// them via imageGenModelIdToKey below; an unknown/absent image model id
// still yields null (honesty contract — never a fabricated price).

// Reverse map: Bedrock model id -> canonical key. Built once from the
// catalog (region/account don't affect the id->key relationship).
let reverseMap: Map<string, BackendModelKey> | null = null;
function getReverseMap(): Map<string, BackendModelKey> {
  if (reverseMap) return reverseMap;
  const catalog = getModelCatalog('us-east-1', '000000000000');
  const m = new Map<string, BackendModelKey>();
  for (const def of Object.values(catalog)) {
    m.set(def.bedrockModelId, def.key);
    // Battle / inference-profile-only models record modelId as the
    // inference-profile ARN, not the bare model id. The ARN carries the
    // real account+region (the catalog here uses placeholders), so map by
    // the account/region-independent profile id suffix after
    // "inference-profile/" (e.g. "us.anthropic.claude-opus-4-6-v1").
    for (const arn of def.inferenceProfileArns ?? []) {
      const id = profileIdFromArn(arn);
      if (id) m.set(id, def.key);
    }
  }
  reverseMap = m;
  return m;
}

/**
 * Extract the inference-profile id from an ARN
 * ("arn:aws:bedrock:r:acct:inference-profile/<id>" -> "<id>"). Returns
 * the input unchanged when it carries no "inference-profile/" segment so
 * a bare model id or bare profile id passes through.
 */
function profileIdFromArn(s: string): string {
  const i = s.indexOf('inference-profile/');
  return i === -1 ? s : s.slice(i + 'inference-profile/'.length);
}

/**
 * Resolve a Bedrock model id (as recorded in steps[].modelId) to its
 * key. Accepts a bare model id, a bare inference-profile id, or a full
 * inference-profile ARN (the battle path records the ARN).
 */
export function bedrockModelIdToKey(modelId: string | undefined | null): BackendModelKey | null {
  if (!modelId) return null;
  const map = getReverseMap();
  return map.get(modelId) ?? map.get(profileIdFromArn(modelId)) ?? null;
}

export interface StepCostInput {
  /** Bedrock model id from steps[].modelId (preferred). */
  modelId?: string | null;
  /** Canonical key, if already known (skips the id lookup). */
  modelKey?: BackendModelKey | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** generation-out only */
  imageCount?: number | null;
}

/**
 * Estimate the USD cost of one battle step. Returns `null` — never 0 or a
 * guess — when a real estimate is impossible (unknown model, no usage
 * data, or an unconfigured image rate). Callers/UI must treat null as
 * "no estimate available" and render "—", not "$0.00".
 */
export function estimateStepCostUsd(input: StepCostInput): number | null {
  // Image step: per-image rate keyed by the image-gen model id.
  // Unknown/absent image model → null (honesty contract), not a guess.
  if (input.imageCount != null && input.imageCount > 0) {
    const ik = imageGenModelIdToKey(input.modelId);
    if (!ik) return null;
    return round6(input.imageCount * IMAGE_GEN_RATES[ik]);
  }

  const key = input.modelKey ?? bedrockModelIdToKey(input.modelId);
  if (!key) return null;
  const rate = MODEL_RATE_TABLE[key];
  if (!rate) return null;

  const tin = input.tokensIn ?? 0;
  const tout = input.tokensOut ?? 0;
  if (tin <= 0 && tout <= 0) return null; // no usable usage -> no estimate

  const cost = (tin / 1000) * rate.inputPer1kUsd + (tout / 1000) * rate.outputPer1kUsd;
  return round6(cost);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
