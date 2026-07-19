/**
 * profile-registry — Phase 0 of SPEC-CAPABILITY-PROFILES. Pins that the registry over
 * DEFAULT_PROFILES_CONFIG returns LEGACY-IDENTICAL answers for classification/rank/min-cap/
 * clearance/RAG-scope (so wiring it in Phase 1 changes nothing there), the one intended
 * deviation (basic classifierMode = 'llm'), and that synth-time validation fails loudly.
 */
import { ProfileRegistry, defaultProfileRegistry } from '../lib/profile-registry';
import {
  DEFAULT_PROFILES_CONFIG,
  validateProfilesConfig,
  ProfilesConfig,
} from '../lib/config/profiles';

describe('profile-registry (default config = legacy behavior)', () => {
  const reg = defaultProfileRegistry;

  it('resolveClassification: primary passes through; unknown/empty fail closed to basic', () => {
    expect(reg.resolveClassification('basic')).toBe('basic');
    expect(reg.resolveClassification('standard')).toBe('standard');
    expect(reg.resolveClassification('premium')).toBe('premium');
    expect(reg.resolveClassification('bogus')).toBe('basic'); // legacy VALID_CLASSIFICATIONS fail-closed
    expect(reg.resolveClassification('')).toBe('basic');
    expect(reg.resolveClassification(null)).toBe('basic');
    expect(reg.resolveClassification(undefined)).toBe('basic');
  });

  it('rank reproduces TIER_RANK {basic:1,standard:2,premium:3}', () => {
    expect(reg.rank('basic')).toBe(1);
    expect(reg.rank('standard')).toBe(2);
    expect(reg.rank('premium')).toBe(3);
    expect(reg.rank('bogus')).toBe(1); // fail-closed rank
  });

  it('min reproduces minTier (lower rank wins; tie returns first arg)', () => {
    expect(reg.min('premium', 'basic')).toBe('basic');
    expect(reg.min('standard', 'premium')).toBe('standard');
    expect(reg.min('premium', 'standard')).toBe('standard');
    expect(reg.min('basic', 'basic')).toBe('basic');
    expect(reg.min('standard', 'standard')).toBe('standard'); // tie -> first arg
  });

  it('clearanceForGroups reproduces resolveUserClearance (highest match; default basic)', () => {
    expect(reg.clearanceForGroups(['premium'])).toBe('premium');
    expect(reg.clearanceForGroups(['basic', 'premium'])).toBe('premium'); // highest wins
    expect(reg.clearanceForGroups(['standard'])).toBe('standard');
    expect(reg.clearanceForGroups([])).toBe('basic');
    expect(reg.clearanceForGroups(['nope'])).toBe('basic');
    expect(reg.clearanceForGroups(['admins'])).toBe('basic'); // 'admins' not a clearance group (legacy)
  });

  it('scopeAtOrBelow reproduces the hardcoded classificationScope ladders', () => {
    expect(reg.scopeAtOrBelow('premium')).toEqual(['basic', 'standard', 'premium']);
    expect(reg.scopeAtOrBelow('standard')).toEqual(['basic', 'standard']);
    expect(reg.scopeAtOrBelow('basic')).toEqual(['basic']);
  });

  it('profileFor returns the legacy capability bundle, with basic classified by LLM (intended deviation)', () => {
    const basic = reg.profileFor('basic');
    expect(basic.modelKey).toBe('haiku');
    expect(basic.classifierMode).toBe('llm'); // DEVIATION: legacy basic was 'keyword'
    expect(basic.timeoutSeconds).toBe(30);
    expect(basic.taskSupport).toBe('full'); // basic gets full task support (the unified processor wires the task loop for every profile)
    expect(basic.rateLimitPerHour).toBe(60);
    expect(basic.battleEligible).toBe(false);

    expect(reg.profileFor('standard').modelKey).toBe('sonnet');
    expect(reg.profileFor('standard').classifierMode).toBe('llm');
    expect(reg.profileFor('standard').timeoutSeconds).toBe(60);

    const premium = reg.profileFor('premium');
    expect(premium.modelKey).toBe('opus');
    expect(premium.classifierMode).toBe('llm');
    expect(premium.timeoutSeconds).toBe(90);
    expect(premium.rateLimitPerHour).toBe(240);
    expect(premium.battleEligible).toBe(true);
  });

  it('classificationValues lists values ascending by rank', () => {
    expect(reg.classificationValues()).toEqual(['basic', 'standard', 'premium']);
  });
});

describe('profile-registry (aliases + non-default config)', () => {
  it('resolves legacy alias values onto their successor classification', () => {
    const cfg: ProfilesConfig = {
      classifications: [
        { value: 'internal', rank: 1, profile: 'p1' },
        { value: 'confidential', rank: 2, profile: 'p2' },
        { value: 'restricted', rank: 3, profile: 'p2', aliases: ['premium'] },
      ],
      profiles: [
        { name: 'p1', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'lightweight', contextScope: 'own-rank-and-below' },
        { name: 'p2', modelKey: 'opus', classifierMode: 'llm', timeoutSeconds: 90, taskSupport: 'full', contextScope: 'own-rank-and-below' },
      ],
      failClosedTo: 'internal',
      groupClearance: { staff: 'confidential', legal: 'restricted' },
    };
    const reg = new ProfileRegistry(cfg);
    expect(reg.resolveClassification('premium')).toBe('restricted'); // legacy value -> successor
    expect(reg.resolveClassification('restricted')).toBe('restricted');
    expect(reg.resolveClassification('bogus')).toBe('internal'); // fail-closed
    expect(reg.clearanceForGroups(['legal'])).toBe('restricted');
    expect(reg.scopeAtOrBelow('confidential')).toEqual(['internal', 'confidential']);
    expect(reg.profileFor('restricted').modelKey).toBe('opus');
  });
});

describe('validateProfilesConfig (fails loudly)', () => {
  const base = (): ProfilesConfig => JSON.parse(JSON.stringify(DEFAULT_PROFILES_CONFIG));

  it('accepts the shipped default', () => {
    expect(() => validateProfilesConfig(DEFAULT_PROFILES_CONFIG)).not.toThrow();
  });

  it('rejects duplicate ranks', () => {
    const c = base();
    c.classifications[1].rank = 1;
    expect(() => validateProfilesConfig(c)).toThrow(/duplicate rank/);
  });

  it('rejects failClosedTo that is not the lowest rank', () => {
    const c = base();
    c.failClosedTo = 'premium';
    expect(() => validateProfilesConfig(c)).toThrow(/lowest-rank/);
  });

  it('rejects a classification referencing an unknown profile', () => {
    const c = base();
    c.classifications[0].profile = 'ghost';
    expect(() => validateProfilesConfig(c)).toThrow(/unknown profile 'ghost'/);
  });

  it('rejects a groupClearance target that is not a classification', () => {
    const c = base();
    c.groupClearance.staff = 'nope';
    expect(() => validateProfilesConfig(c)).toThrow(/unknown classification 'nope'/);
  });

  it('rejects an alias colliding with a primary value', () => {
    const c = base();
    c.classifications[2].aliases = ['basic'];
    expect(() => validateProfilesConfig(c)).toThrow(/collides with a primary/);
  });

  it('the ProfileRegistry constructor validates too (defense in depth)', () => {
    const c = base();
    c.classifications[1].rank = 1;
    expect(() => new ProfileRegistry(c)).toThrow(/duplicate rank/);
  });
});
