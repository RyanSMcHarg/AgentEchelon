/**
 * A CONVERSATION TYPE'S GROUP AND ITS CLASSIFICATION CANNOT CONTRADICT EACH OTHER (DESIGN-CONVERSATION-TYPES §6).
 *
 * A type that takes its people from a group adds whoever is in it, so the group is a MEMBERSHIP group
 * whose members must already be cleared for the type's classification. It grants nothing: clearance comes
 * from the clearance groups alone. Synthesis refuses a deployment where a type's group does not require
 * what the type is created at.
 */
import { ProfileRegistry, defaultProfileRegistry } from '../lib/profile-registry';
import { DEFAULT_PROFILES_CONFIG, validateProfilesConfig, type ProfilesConfig } from '../lib/config/profiles';
import { typeGroupContradictions, assertTypeGroupsRequireTheirClassifications } from '../lib/conversation-type-grants';

const withConfig = (patch: Partial<ProfilesConfig>) => new ProfileRegistry({ ...DEFAULT_PROFILES_CONFIG, ...patch });

describe('the shipped configuration', () => {
  it('has no contradiction: ops is a membership group that requires premium', () => {
    expect(typeGroupContradictions(defaultProfileRegistry)).toEqual([]);
    expect(() => assertTypeGroupsRequireTheirClassifications(defaultProfileRegistry)).not.toThrow();
    expect(defaultProfileRegistry.membershipGroups()).toEqual({ ops: 'premium' });
  });

  it('gives ops no clearance: it is not a clearance group, and holding it reaches nothing', () => {
    expect(defaultProfileRegistry.groupClearance).not.toHaveProperty('ops');
    expect(defaultProfileRegistry.clearanceGroups()).not.toContain('ops');
    // A basic person in ops is still only basic.
    expect(defaultProfileRegistry.resolveHolderToken(['basic', 'ops'])).toBe('basic');
    expect(defaultProfileRegistry.resolveHolderToken(['ops'])).toBeUndefined();
  });

  it('lets only someone already cleared for premium meet the ops requirement', () => {
    expect(defaultProfileRegistry.meetsMembershipRequirement(['premium'], 'ops')).toBe(true);
    // The admin plane grants itself alone: `admins` meets the requirement only beside a premium clearance.
    expect(defaultProfileRegistry.meetsMembershipRequirement(['admins'], 'ops')).toBe(false);
    expect(defaultProfileRegistry.meetsMembershipRequirement(['admins', 'premium'], 'ops')).toBe(true);
    expect(defaultProfileRegistry.meetsMembershipRequirement(['standard'], 'ops')).toBe(false);
    expect(defaultProfileRegistry.meetsMembershipRequirement(['basic', 'ops'], 'ops')).toBe(false);
    expect(defaultProfileRegistry.meetsMembershipRequirement([], 'ops')).toBe(false);
  });
});

describe('what synthesis refuses', () => {
  it('a source group nothing declares as a membership group', () => {
    const problems = typeGroupContradictions(withConfig({ membershipGroups: {} }));
    expect(problems.join('\n')).toMatch(/group 'ops', which membershipGroups does not declare/);
  });

  it('a source group whose requirement does not reach the type\'s classification', () => {
    const problems = typeGroupContradictions(withConfig({ membershipGroups: { ops: 'standard' } }));
    expect(problems.join('\n')).toMatch(/created at 'premium', but its group 'ops' requires only 'standard'/);
  });

  it('a group that is both a clearance group and a membership group', () => {
    expect(() => validateProfilesConfig({
      ...DEFAULT_PROFILES_CONFIG,
      groupClearance: { ...DEFAULT_PROFILES_CONFIG.groupClearance, ops: 'premium' },
    })).toThrow(/'ops' is both a clearance group and a membership group/);
  });

  it('a membership group requiring a classification the deployment does not declare', () => {
    expect(() => validateProfilesConfig({ ...DEFAULT_PROFILES_CONFIG, membershipGroups: { ops: 'nope' } }))
      .toThrow(/membershipGroups\['ops'\] requires unknown classification 'nope'/);
  });
});
