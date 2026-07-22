/**
 * Experiment Manager — Resolution by type (Phase 1)
 *
 * An intent-specific experiment wins over a
 * base-model experiment; a base-model experiment swaps the tier default for ANY
 * intent; classification experiments resolve on their own path and never match
 * the response-model resolver. Mirrors the battle suite's cache handling
 * (resetModules + a per-test mocked Scan).
 */

import type { QueryCommandOutput } from '@aws-sdk/lib-dynamodb';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  GetCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

import { getModelCatalog } from '../../lib/config/model-strategy';

const catalog = getModelCatalog('us-east-1', '123456789012');

function variants(controlKey: string, treatmentKey: string) {
  return [
    { variantId: 'control', modelKey: controlKey, weight: 100 },   // 100% control → deterministic
    { variantId: 'treatment', modelKey: treatmentKey, weight: 0 },
  ];
}

describe('resolveExperimentModel — type ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
    jest.resetModules();
  });

  it('returns null when no experiment matches', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    expect(await resolveExperimentModel('standard', 'general_qa', 'arn:chan', catalog)).toBeNull();
  });

  it('resolves an intent experiment for the matching intent (legacy/default type)', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-intent', status: 'active', intent: 'general_qa', tiers: ['standard'], variants: variants('sonnet', 'haiku') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const res = await resolveExperimentModel('standard', 'general_qa', 'arn:chan', catalog);
    expect(res?.experimentId).toBe('exp-intent');
    expect(res?.variantId).toBe('control');
    expect(res?.modelKey).toBe('sonnet');
  });

  it('resolves an image_generation experiment on the RAW intent and carries the variant image model', async () => {
    // image_generation is NOT a text RouteKey (it normalizes to general_qa), so the resolver must match
    // it on the raw intent string. The assigned variant's imageGenModelKey rides the resolution so the
    // NORMAL flow serves the variant's image model (non-battle image A/B).
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          experimentId: 'exp-img', status: 'active', experimentType: 'intent', intent: 'image_generation',
          tiers: ['premium'],
          variants: [
            { variantId: 'control', modelKey: 'sonnet', imageGenModelKey: 'stability_image_core', weight: 100 },
            { variantId: 'treatment', modelKey: 'sonnet', imageGenModelKey: 'stability_image_ultra', weight: 0 },
          ],
        },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const res = await resolveExperimentModel('premium', 'image_generation', 'arn:chan', catalog);
    expect(res?.experimentId).toBe('exp-img');
    expect(res?.variantId).toBe('control');
    expect(res?.imageGenModelKey).toBe('stability_image_core');
  });

  it('matches an intent experiment when the router passes the RAW classifier intent', async () => {
    // Regression (#9): the router calls resolveExperimentModel with the coarse
    // classifier intent ('general'), but the admin stores experiments with the
    // fine-grained RouteKey ('general_qa'). Resolution must normalize the former
    // to the latter — comparing them raw silently never matched, so no intent
    // experiment ever fired and experiment_results stayed empty.
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-intent', status: 'active', intent: 'general_qa', tiers: ['standard'], variants: variants('sonnet', 'haiku') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const res = await resolveExperimentModel('standard', 'general', 'arn:chan', catalog);
    expect(res?.experimentId).toBe('exp-intent');
    expect(res?.modelKey).toBe('sonnet');
  });

  it('normalizes a mapped classifier intent (data_extraction → document_extraction) before matching', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-doc', status: 'active', intent: 'document_extraction', tiers: ['standard'], variants: variants('sonnet', 'haiku') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const res = await resolveExperimentModel('standard', 'data_extraction', 'arn:chan', catalog);
    expect(res?.experimentId).toBe('exp-doc');
  });

  it('does NOT resolve an intent experiment for a different intent', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-intent', status: 'active', intent: 'code_generation', tiers: ['standard'], variants: variants('sonnet', 'haiku') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    expect(await resolveExperimentModel('standard', 'general_qa', 'arn:chan', catalog)).toBeNull();
  });

  it('resolves a base_model experiment for ANY intent on the tier', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-base', status: 'active', experimentType: 'base_model', intent: '', tiers: ['standard'], variants: variants('sonnet', 'haiku') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const res = await resolveExperimentModel('standard', 'general_qa', 'arn:chan', catalog);
    expect(res?.experimentId).toBe('exp-base');
  });

  it('prefers an intent experiment over a base_model experiment when both apply', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-base', status: 'active', experimentType: 'base_model', intent: '', tiers: ['standard'], variants: variants('haiku', 'titan') },
        { experimentId: 'exp-intent', status: 'active', experimentType: 'intent', intent: 'general_qa', tiers: ['standard'], variants: variants('sonnet', 'titan') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const res = await resolveExperimentModel('standard', 'general_qa', 'arn:chan', catalog);
    expect(res?.experimentId).toBe('exp-intent');
  });

  it('does NOT resolve a classification experiment as a response-model experiment', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-cls', status: 'active', experimentType: 'classification', intent: '', tiers: ['standard'], variants: variants('haiku', 'titan') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    expect(await resolveExperimentModel('standard', 'general_qa', 'arn:chan', catalog)).toBeNull();
  });

  it('skips a model the tier may not use (tier safety)', async () => {
    // Config-driven: pick a model the 'standard' tier is NOT allowed to use per the actual
    // catalog (allowedClassifications), rather than hardcoding a model presumed premium-only. A standard
    // experiment pinning that model must be skipped.
    const restrictedKey = Object.keys(catalog).find(
      (k) => !catalog[k as keyof typeof catalog].allowedClassifications.includes('standard'),
    );
    if (!restrictedKey) throw new Error('tier-safety test needs a model not allowed for the standard tier');
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-bad', status: 'active', intent: 'general_qa', tiers: ['standard'], variants: variants(restrictedKey, restrictedKey) },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    expect(await resolveExperimentModel('standard', 'general_qa', 'arn:chan', catalog)).toBeNull();
  });
});

describe('resolveClassificationExperiment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
    jest.resetModules();
  });

  it('resolves a classification experiment intent-agnostically', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-cls', status: 'active', experimentType: 'classification', intent: '', tiers: ['standard'], variants: variants('haiku', 'titan') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveClassificationExperiment } = await import('../../lambda/src/lib/experiment-manager');
    const res = await resolveClassificationExperiment('standard', 'arn:chan', catalog);
    expect(res?.experimentId).toBe('exp-cls');
    expect(res?.modelKey).toBe('haiku');
    expect(res?.bedrockModelId).toBeTruthy();
  });

  it('returns null when only non-classification experiments are active', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { experimentId: 'exp-base', status: 'active', experimentType: 'base_model', intent: '', tiers: ['standard'], variants: variants('haiku', 'titan') },
      ],
    } as unknown as QueryCommandOutput);
    const { resolveClassificationExperiment } = await import('../../lambda/src/lib/experiment-manager');
    expect(await resolveClassificationExperiment('standard', 'arn:chan', catalog)).toBeNull();
  });
});
