/**
 * Slim Chime Metadata contract (SPEC-MESSAGE-METADATA-CODEBOOK.md Phase 1; ADR-016).
 *
 * When the out-of-band analytics store is available, the bot message's Chime
 * Metadata is slimmed to ONLY the fields the frontend renders; the heavy
 * analytics-only fields move out of band. This test pins that contract:
 *   - the frontend-needed fields (incl. the experiment thumbs-join keys) survive,
 *   - the heavy analytics-only fields are dropped from the inline metadata,
 * so a regression that drops a join key (breaking live thumbs) or that re-adds a
 * bulky field (re-inflating toward the 1024 cap) fails here.
 */

import {
  pickFrontendMetadata,
  FRONTEND_METADATA_KEYS,
  buildAnalyticsMetadata,
} from '../../lambda/src/lib/analytics-metadata';

describe('pickFrontendMetadata', () => {
  const full = buildAnalyticsMetadata({
    messageNumber: 7,
    userType: 'premium',
    role: 'assistant',
    agentType: 'premium',
    intent: 'report_generation',
    intentConfidence: '0.95',
    deliveryOption: 'TASK_MULTI_STEP',
    bedrockResponse: { model: 'anthropic.claude-3-5-sonnet-20241022-v2:0', inputTokens: 1234, outputTokens: 567, latencyMs: 8900 },
    totalMs: 12000,
    pollMs: 900,
    activeTask: { type: 'report_generation', status: 'in_progress', label: 'Q4 report' },
    wasFallback: true,
    fallbackReason: 'model_unavailable',
    retryCount: 2,
    experimentId: 'exp_abc',
    variantId: 'treatment',
    // The processor passes 'probabilistic' for non-battle turns (the builder only
    // stamps assignmentMode when given it or a battleContext).
    assignmentMode: 'probabilistic',
    configIdentity: { configId: 'cfg_1', personaVersion: 'v1', intentPackVersion: 'v1', systemPromptHash: 'deadbeef' },
  } as Parameters<typeof buildAnalyticsMetadata>[0]) as unknown as Record<string, unknown>;

  it('keeps the experiment thumbs-join keys (live thumbs depend on these)', () => {
    const slim = pickFrontendMetadata(full);
    expect(slim.experimentId).toBe('exp_abc');
    expect(slim.variantId).toBe('treatment');
    expect(slim.assignmentMode).toBe('probabilistic'); // set by buildAnalyticsMetadata for non-battle
  });

  it('keeps the frontend-rendered fields (model, intent, activeTask)', () => {
    const slim = pickFrontendMetadata(full);
    expect(slim.bedrockModel).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(slim.intent).toBe('report_generation');
    expect(slim.activeTask).toEqual({ type: 'report_generation', status: 'in_progress', label: 'Q4 report' });
  });

  it('drops the heavy analytics-only fields from inline metadata', () => {
    const slim = pickFrontendMetadata(full);
    for (const dropped of [
      'inputTokens', 'outputTokens', 'latencyMs', 'totalMs', 'pollMs',
      'intentConfidence', 'deliveryOption', 'wasFallback', 'fallbackReason', 'retryCount',
      'configId', 'personaVersion', 'intentPackVersion', 'systemPromptHash',
      'messageNumber', 'timestamp', 'role', 'userType', 'agentType',
    ]) {
      expect(slim[dropped]).toBeUndefined();
    }
  });

  it('emits no keys outside the declared allow-list', () => {
    const slim = pickFrontendMetadata(full);
    for (const key of Object.keys(slim)) {
      expect(FRONTEND_METADATA_KEYS as readonly string[]).toContain(key);
    }
  });

  it('omits absent optional keys rather than emitting undefined', () => {
    const slim = pickFrontendMetadata({ intent: 'general' });
    expect('bedrockModel' in slim).toBe(false);
    expect(slim).toEqual({ intent: 'general' });
  });

  it('never lets per-step telemetry leak into the slim inline metadata', () => {
    // steps[] is persisted out-of-band only (it would blow the 1024 cap and only
    // archival/admin consume it); the inline slim must drop it.
    const slim = pickFrontendMetadata({
      intent: 'report_generation',
      steps: [{ stepLabel: 'generate', modelId: 'm', startedAt: 'a', endedAt: 'b' }],
    });
    expect('steps' in slim).toBe(false);
  });
});
