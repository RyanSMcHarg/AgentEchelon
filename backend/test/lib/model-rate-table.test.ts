/**
 * MODEL_RATE_TABLE unit tests (SPEC-BATTLE.md §"Battle Scoring & Per-Step
 * Telemetry", Phase 1A).
 *
 * The load-bearing invariants:
 *   - Catalog/rate parity: every model in the canonical catalog has a
 *     rate entry (adding a model without a rate must fail CI here).
 *   - steps[].modelId resolves to a key via the reverse map.
 *   - The estimator does the right arithmetic AND returns null (never a
 *     fabricated number) when it cannot estimate.
 */
import {
  MODEL_RATE_TABLE,
  bedrockModelIdToKey,
  estimateStepCostUsd,
} from '../../lambda/src/lib/model-rate-table';
import { IMAGE_GEN_RATE_USD_PER_IMAGE } from '../../lambda/src/lib/image-gen-models';
import { getModelCatalog } from '../../lib/config/model-strategy';

const catalog = getModelCatalog('us-east-1', '123456789012');

describe('catalog ⇄ rate-table parity', () => {
  it('every catalog model has a rate entry', () => {
    for (const key of Object.keys(catalog)) {
      expect(MODEL_RATE_TABLE).toHaveProperty(key);
      const rate = (MODEL_RATE_TABLE as Record<string, unknown>)[key] as {
        inputPer1kUsd: number;
        outputPer1kUsd: number;
      };
      expect(typeof rate.inputPer1kUsd).toBe('number');
      expect(typeof rate.outputPer1kUsd).toBe('number');
      expect(rate.inputPer1kUsd).toBeGreaterThan(0);
      expect(rate.outputPer1kUsd).toBeGreaterThan(0);
    }
  });

  it('has no rate entries for non-catalog keys', () => {
    const catalogKeys = new Set(Object.keys(catalog));
    for (const rateKey of Object.keys(MODEL_RATE_TABLE)) {
      expect(catalogKeys.has(rateKey)).toBe(true);
    }
  });
});

describe('bedrockModelIdToKey', () => {
  it('resolves every catalog model id to its key', () => {
    for (const def of Object.values(catalog)) {
      expect(bedrockModelIdToKey(def.bedrockModelId)).toBe(def.key);
    }
  });

  it('returns null for unknown / empty model ids', () => {
    expect(bedrockModelIdToKey('not.a.real.model')).toBeNull();
    expect(bedrockModelIdToKey('')).toBeNull();
    expect(bedrockModelIdToKey(undefined)).toBeNull();
    expect(bedrockModelIdToKey(null)).toBeNull();
  });

  // The battle path records modelId as the inference-profile ARN (real
  // account+region), not the bare model id. Cost estimation must still
  // resolve it, or the scorecard EST. COST axis is permanently a dash.
  it('resolves inference-profile ARNs and bare profile ids to the key', () => {
    for (const def of Object.values(catalog)) {
      for (const arn of def.inferenceProfileArns ?? []) {
        expect(bedrockModelIdToKey(arn)).toBe(def.key);
        const seg = 'inference-profile/';
        const id = arn.slice(arn.indexOf(seg) + seg.length);
        expect(bedrockModelIdToKey(id)).toBe(def.key);
      }
    }
    // A real-account ARN (catalog reverse map is built with placeholders)
    // still resolves, since lookup falls back to the profile-id suffix.
    const realArn =
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1';
    expect(bedrockModelIdToKey(realArn)).toBe('opus');
    const sonnetArn =
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6';
    expect(
      estimateStepCostUsd({ modelId: sonnetArn, tokensIn: 1000, tokensOut: 500 }),
    ).not.toBeNull();
  });
});

describe('estimateStepCostUsd — arithmetic', () => {
  it('computes tokensIn/out × rate for a known model id', () => {
    const sonnetId = catalog.sonnet.bedrockModelId;
    const r = MODEL_RATE_TABLE.sonnet;
    const cost = estimateStepCostUsd({ modelId: sonnetId, tokensIn: 1000, tokensOut: 500 });
    const expected = (1000 / 1000) * r.inputPer1kUsd + (500 / 1000) * r.outputPer1kUsd;
    expect(cost).toBeCloseTo(expected, 9);
  });

  it('accepts a modelKey directly (skips id lookup)', () => {
    const r = MODEL_RATE_TABLE.opus;
    const cost = estimateStepCostUsd({ modelKey: 'opus', tokensIn: 2000, tokensOut: 0 });
    expect(cost).toBeCloseTo((2000 / 1000) * r.inputPer1kUsd, 9);
  });

  it('counts output-only usage', () => {
    const r = MODEL_RATE_TABLE.haiku;
    const cost = estimateStepCostUsd({ modelKey: 'haiku', tokensOut: 300 });
    expect(cost).toBeCloseTo((300 / 1000) * r.outputPer1kUsd, 9);
  });
});

describe('estimateStepCostUsd — honesty contract (null, never a guess)', () => {
  it('returns null for an unknown model', () => {
    expect(estimateStepCostUsd({ modelId: 'mystery.model', tokensIn: 100, tokensOut: 100 })).toBeNull();
  });

  it('returns null when there is no usable token usage', () => {
    expect(estimateStepCostUsd({ modelKey: 'sonnet' })).toBeNull();
    expect(estimateStepCostUsd({ modelKey: 'sonnet', tokensIn: 0, tokensOut: 0 })).toBeNull();
  });

  it('prices an image step per image-gen model; unknown/absent model → null', () => {
    // Phase 4: per-model rates (Titan Image vs Nova Canvas price differently).
    expect(
      estimateStepCostUsd({ modelId: 'amazon.nova-canvas-v1:0', imageCount: 2 }),
    ).toBeCloseTo(2 * IMAGE_GEN_RATE_USD_PER_IMAGE.nova_canvas, 6);
    expect(
      estimateStepCostUsd({ modelId: 'amazon.titan-image-generator-v2:0', imageCount: 1 }),
    ).toBeCloseTo(IMAGE_GEN_RATE_USD_PER_IMAGE.titan_image, 6);
    // No image model id → cannot price → null (never a guess).
    expect(estimateStepCostUsd({ imageCount: 2 })).toBeNull();
    expect(estimateStepCostUsd({ modelId: 'mystery.image', imageCount: 2 })).toBeNull();
  });

  it('does not return 0 as a stand-in for "unknown"', () => {
    const r = estimateStepCostUsd({ modelId: 'mystery.model', tokensIn: 100 });
    expect(r).not.toBe(0);
    expect(r).toBeNull();
  });
});
