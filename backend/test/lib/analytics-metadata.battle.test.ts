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

  // THE ATTRIBUTION A BATTLE TURN MUST CARRY.
  //
  // `experiment_id` / `variant_id` reach Aurora from these fields and NOWHERE else - a `battleContext`
  // alone does not attribute a turn to its experiment. The battle fan-out sent `battleContext` without
  // them for the life of the feature, so every duel archived with `experiment_id` NULL, and
  // `fetchBattleEffectivenessRows` (`WHERE m.experiment_id IS NOT NULL`) matched none of them: no
  // `battle_wins`, and a recommendation that reported "only one variant has recorded traffic" while
  // reading ordinary probabilistic turns. Battles collected human picks that could never reach the
  // decision loop they exist to feed.
  //
  // Pinned here because the two fields are easy to read as redundant next to `battleContext`, and
  // dropping them again would be silent: nothing errors, the rows just stop matching.
  it('attributes a BATTLE turn to its experiment and variant, alongside the battleContext', () => {
    const battleContext: AnalyticsBattleContext = {
      battleId: 'b1',
      round: 1,
      selfBotArn: 'arn:self',
      rivalBotArn: 'arn:rival',
    };
    const md = buildAnalyticsMetadata(baseCtx({
      battleContext,
      experimentId: 'exp-1',
      variantId: 'treatment',
    }));
    expect(md.assignmentMode).toBe('battle');
    // Compared as one object so a failure shows WHICH id went missing: a turn without experimentId can
    // never join its own results, and one without variantId cannot be attributed to a side.
    expect({ experimentId: md.experimentId, variantId: md.variantId })
      .toEqual({ experimentId: 'exp-1', variantId: 'treatment' });
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
