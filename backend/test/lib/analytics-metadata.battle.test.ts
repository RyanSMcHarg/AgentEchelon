/**
 * analytics-metadata battle additions (SPEC-BATTLE.md §Analytics +
 * §"Battle Scoring & Per-Step Telemetry", Phase 1A).
 *
 * Covers: the assignmentMode rollup-safety invariant (battleContext
 * always forces assignmentMode='battle'), passthrough of the typed
 * battle shapes, and makeConverseStep wiring estCostUsd from
 * MODEL_RATE_TABLE (incl. the null honesty contract).
 */
import {
  buildAnalyticsMetadata,
  makeConverseStep,
  type AnalyticsContext,
  type AnalyticsBattleContext,
} from '../../lambda/src/lib/analytics-metadata';
import { getModelCatalog } from '../../lib/config/model-strategy';

const catalog = getModelCatalog('us-east-1', '123456789012');

function baseCtx(over: Partial<AnalyticsContext> = {}): AnalyticsContext {
  return { messageNumber: 1, userType: 'premium', role: 'assistant', ...over };
}

describe('buildAnalyticsMetadata — assignmentMode rollup-safety invariant', () => {
  it("forces assignmentMode='battle' whenever a battleContext is present", () => {
    const battleContext: AnalyticsBattleContext = {
      battleId: 'b1',
      round: 1,
      selfBotArn: 'arn:self',
      rivalBotArn: 'arn:rival',
    };
    // Caller wrongly passes 'probabilistic' — the builder must override it.
    const md = buildAnalyticsMetadata(baseCtx({ assignmentMode: 'probabilistic', battleContext }));
    expect(md.assignmentMode).toBe('battle');
    expect(md.battleContext).toEqual(battleContext);
  });

  it('passes assignmentMode through unchanged when there is no battleContext', () => {
    const md = buildAnalyticsMetadata(baseCtx({ assignmentMode: 'probabilistic' }));
    expect(md.assignmentMode).toBe('probabilistic');
    expect(md.battleContext).toBeUndefined();
  });

  it('stamps portable-profile attribution (assistant + profile version) when provided', () => {
    const md = buildAnalyticsMetadata(baseCtx({ profileAttribution: { profileName: 'premium', profileConfigId: 'abc123def456', profileVersion: 4 } }));
    expect(md.profileName).toBe('premium');
    expect(md.profileConfigId).toBe('abc123def456'); // the VERSION fingerprint, distinct from configId
    expect(md.profileVersion).toBe(4);
  });

  it('omits profile attribution when not provided (no silent default)', () => {
    const md = buildAnalyticsMetadata(baseCtx());
    expect(md.profileName).toBeUndefined();
    expect(md.profileConfigId).toBeUndefined();
  });

  it('leaves assignmentMode unset when neither is provided (no silent default)', () => {
    const md = buildAnalyticsMetadata(baseCtx());
    expect(md.assignmentMode).toBeUndefined();
    expect(md.battleContext).toBeUndefined();
  });

  it('carries steps[] through on the battleContext', () => {
    const battleContext: AnalyticsBattleContext = {
      battleId: 'b2',
      round: 2,
      selfBotArn: 'arn:self',
      rivalBotArn: 'arn:rival',
      optedOutOfRound2: false,
      steps: [
        makeConverseStep({
          stepLabel: 'round1-generate',
          modelId: catalog.sonnet.bedrockModelId,
          startedAt: '2026-05-14T00:00:00.000Z',
          endedAt: '2026-05-14T00:00:02.000Z',
          tokensIn: 1200,
          tokensOut: 800,
        }),
      ],
    };
    const md = buildAnalyticsMetadata(baseCtx({ battleContext }));
    expect(md.battleContext?.steps).toHaveLength(1);
    expect(md.battleContext?.steps?.[0].stepLabel).toBe('round1-generate');
  });
});

describe('makeConverseStep — estCostUsd wired from MODEL_RATE_TABLE', () => {
  it('computes a positive estimate for a known model with token usage', () => {
    const step = makeConverseStep({
      stepLabel: 'round1-generate',
      modelId: catalog.opus.bedrockModelId,
      startedAt: '2026-05-14T00:00:00.000Z',
      endedAt: '2026-05-14T00:00:05.000Z',
      tokensIn: 3000,
      tokensOut: 1500,
    });
    expect(step.estCostUsd).not.toBeNull();
    expect(step.estCostUsd as number).toBeGreaterThan(0);
    expect(step.modelId).toBe(catalog.opus.bedrockModelId);
  });

  it('propagates the null honesty contract for an unknown model', () => {
    const step = makeConverseStep({
      stepLabel: 'round1-generate',
      modelId: 'mystery.model',
      startedAt: 'a',
      endedAt: 'b',
      tokensIn: 100,
      tokensOut: 100,
    });
    expect(step.estCostUsd).toBeNull();
  });

  it('image step has null cost until the Phase 4 gen-out rate is configured', () => {
    const step = makeConverseStep({
      stepLabel: 'image-gen',
      modelId: 'some.image.model',
      startedAt: 'a',
      endedAt: 'b',
      imageCount: 2,
    });
    expect(step.estCostUsd).toBeNull();
    expect(step.imageCount).toBe(2);
  });
});
