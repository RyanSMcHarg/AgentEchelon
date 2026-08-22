/**
 * PER-TIER LATENCY BANDS: the two rules that make tiering honest (G10).
 *
 * Tiering a target is a way to make a band informative, and it is one edit away from being a way to
 * excuse a slow deployment. These pin the difference.
 *
 * RULE 1 - THE CEILING IS INVARIANT. No tier may be given a band beyond the Nielsen abandon
 * threshold. Past it the person has left, so a "warn" there describes a system nobody is waiting for.
 * A tier band may only ever TIGHTEN what is expected of cheaper work.
 *
 * RULE 2 - PERCEIVED LATENCY IS NOT TIERED. TTFF and E2E measure the person, not the machine, and a
 * person does not know which model answered them. Overriding those would relabel a worse experience
 * as an acceptable one, which is the failure mode this whole registry exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import {
  METRIC_TARGETS,
  TIER_TARGET_OVERRIDES,
  ABANDON_CEILING_MS,
  targetFor,
  evaluateTarget,
  type LatencyTier,
} from './metricTargets';

const TIERS: LatencyTier[] = ['basic', 'standard', 'premium'];

describe('the abandon ceiling holds for every tier', () => {
  it('no override sets a target or a warn beyond it', () => {
    for (const [key, byTier] of Object.entries(TIER_TARGET_OVERRIDES)) {
      for (const [tier, band] of Object.entries(byTier)) {
        expect(band!.target, `${key}.${tier}.target`).toBeLessThanOrEqual(ABANDON_CEILING_MS);
        expect(band!.warn, `${key}.${tier}.warn`).toBeLessThanOrEqual(ABANDON_CEILING_MS);
      }
    }
  });

  it('a band is ordered: good is at least as strict as warn', () => {
    // A target above its own warn would make evaluateTarget unreachable at 'warn' and silently
    // reclassify everything either good or bad.
    for (const [key, byTier] of Object.entries(TIER_TARGET_OVERRIDES)) {
      for (const [tier, band] of Object.entries(byTier)) {
        expect(band!.target, `${key}.${tier}`).toBeLessThanOrEqual(band!.warn);
      }
    }
  });

  it('a cheaper tier is held to a stricter band than a richer one', () => {
    // The direction IS the argument for tiering. Reversed, the bands would be excusing the cheap
    // turns and squeezing the expensive ones, which is neither what the tiers cost nor what they do.
    for (const [key, byTier] of Object.entries(TIER_TARGET_OVERRIDES)) {
      const present = TIERS.filter((t) => byTier[t]);
      for (let i = 1; i < present.length; i++) {
        expect(byTier[present[i]]!.target, `${key}: ${present[i]} vs ${present[i - 1]}`)
          .toBeGreaterThanOrEqual(byTier[present[i - 1]]!.target);
      }
    }
  });
});

describe('perceived latency is deliberately not tiered', () => {
  it.each(['ttff_ms', 'avg_e2e_ms'])('%s has no per-tier override', (key) => {
    expect(TIER_TARGET_OVERRIDES[key]).toBeUndefined();
  });

  it('so the same value is judged identically whichever tier asked', () => {
    // The assertion that would actually break if someone added an override later: not "the map has no
    // key", but "a person waiting 1.8s is told the same thing regardless of who answered them".
    const verdicts = TIERS.map((t) => evaluateTarget(1800, targetFor('ttff_ms', t)!));
    expect(new Set(verdicts).size).toBe(1);
  });
});

describe('targetFor falls back rather than disappearing', () => {
  it('returns the global target when no tier is given', () => {
    expect(targetFor('avg_total_ms')).toEqual(METRIC_TARGETS.avg_total_ms);
  });

  it('returns the global target for a tier nobody has tuned', () => {
    // 'unknown' is a real bucket: the latency query emits it for rows whose tier cannot be resolved.
    // Dropping the band there would read as "this metric has no expectation" rather than "this tier
    // has no tuning yet".
    expect(targetFor('avg_total_ms', 'unknown')).toEqual(METRIC_TARGETS.avg_total_ms);
    expect(targetFor('avg_total_ms', 'a-tier-added-next-year')).toEqual(METRIC_TARGETS.avg_total_ms);
  });

  it('returns undefined for a metric with no target at all', () => {
    expect(targetFor('not_a_metric', 'premium')).toBeUndefined();
  });

  it('narrows the band when the tier has one, and says which tier in the label', () => {
    const premium = targetFor('avg_total_ms', 'premium')!;
    const basic = targetFor('avg_total_ms', 'basic')!;
    expect(premium.target).toBeGreaterThan(basic.target);
    expect(premium.label).toContain('premium');
    // The same 12s turn is healthy premium work and a basic anomaly - the whole point of the split.
    expect(evaluateTarget(12000, premium)).not.toBe('bad');
    expect(evaluateTarget(12000, basic)).toBe('bad');
  });
});
