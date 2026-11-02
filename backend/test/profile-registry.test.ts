/**
 * profile-registry — the ONE interpreter of a classification value.
 *
 * THIS FILE USED TO PIN A LADDER, and that is the point of the rewrite. It asserted
 * `rank`, `min` (the min-cap), `scopeAtOrBelow` and a fail-closed floor, all of which presume the
 * classifications are totally ordered. They are not: a deployment may declare `legal` and `finance`,
 * where neither is above the other and neither is a floor.
 *
 * So every case here now asserts SET behavior. The default config is still a ladder, and the ladder's
 * answers still come out right - that is the compatibility claim worth keeping - but they come out of
 * `grants`, which a peer deployment can express and a rank cannot.
 */
import { ProfileRegistry, defaultProfileRegistry } from '../lib/profile-registry';
import {
  DEFAULT_PROFILES_CONFIG,
  validateProfilesConfig,
  ProfilesConfig,
} from '../lib/config/profiles';

describe('profile-registry (default config = legacy behavior)', () => {
  const reg = defaultProfileRegistry;

  it('resolveClassification: a declared value passes through; anything else is undefined', () => {
    expect(reg.resolveClassification('basic')).toBe('basic');
    expect(reg.resolveClassification('standard')).toBe('standard');
    expect(reg.resolveClassification('premium')).toBe('premium');
    // UNDEFINED, NOT THE FLOOR. This returned 'basic' for every one of these, so a typo'd tag and a
    // genuinely basic channel were the same value and no consumer could tell them apart.
    expect(reg.resolveClassification('bogus')).toBeUndefined();
    expect(reg.resolveClassification('')).toBeUndefined();
    expect(reg.resolveClassification(null)).toBeUndefined();
    expect(reg.resolveClassification(undefined)).toBeUndefined();
  });

  it('reaches replaces the min-cap: it is set membership, not a comparison', () => {
    // The default config is a ladder, so reach still reads like one.
    expect(reg.reaches('premium', 'basic')).toBe(true);
    expect(reg.reaches('premium', 'premium')).toBe(true);
    expect(reg.reaches('standard', 'basic')).toBe(true);
    // And the direction that used to be a rank comparison.
    expect(reg.reaches('basic', 'premium')).toBe(false);
    expect(reg.reaches('standard', 'premium')).toBe(false);
    // An undeclared classification reaches nothing and is reached by nothing.
    expect(reg.reaches('bogus', 'basic')).toBe(false);
    expect(reg.reaches('premium', 'bogus')).toBe(false);
  });

  it('clearanceForGroups reproduces resolveUserClearance (highest match; default basic)', () => {
    expect(reg.clearanceForGroups(['premium'])).toBe('premium');
    // NOT "HIGHEST WINS" ANY MORE - the token whose grants ARE the union of what they hold. On this
    // ladder that is still 'premium', because premium's grants already contain basic's.
    expect(reg.clearanceForGroups(['basic', 'premium'])).toBe('premium');
    expect(reg.clearanceForGroups(['standard'])).toBe('standard');
    // UNDEFINED, NOT THE FLOOR. "No clearance groups" and "cleared for the least-privileged
    // classification" were one value, so an unclassified person silently got a working clearance.
    expect(reg.clearanceForGroups([])).toBeUndefined();
    expect(reg.clearanceForGroups(['nope'])).toBeUndefined();
    // `admins` CLEARS FOR `admin`, the top classification. Administration happens in conversations,
    // and those conversations are judged by the same closed axis as every other room - so the group
    // that administers has a clearance of its own rather than borrowing whichever tier group an
    // operator also happens to hold.
    expect(reg.clearanceForGroups(['admins'])).toBe('admin');
    // THE ADMIN PLANE GRANTS ITSELF ALONE (SPEC-ADMIN-IDENTITY FR1): a chat identity holding it reaches admin
    // conversations and no member conversation. Holding it beside a tier group, the token is the tier's and the
    // admin plane rides beside it (`holderOf`).
    expect(reg.grantsFor('admin')).toEqual(['admin']);
    expect(reg.clearanceForGroups(['admins', 'basic'])).toBe('basic');
    expect(reg.holderForGroups(['admins', 'basic'])).toEqual({ token: 'basic', adminPlane: true });
    // AND NOT THE GUEST'S: an outside classification is reached by its own people alone, so no member's
    // clearance, the administrator's included, reaches a visitor's conversation as a standing grant.
    for (const c of reg.classificationValues()) if (c !== 'guest') expect(reg.grantsFor(c)).not.toContain('guest');
    expect(reg.grantsFor('guest')).toEqual(['guest']);
    // The reverse does NOT hold: no ordinary classification reaches `admin`.
    expect(reg.grantsFor('premium')).not.toContain('admin');
  });

  it('grantsFor replaces scopeAtOrBelow, and reads the declared set rather than an order', () => {
    expect(reg.grantsFor('premium')).toEqual(['basic', 'standard', 'premium']);
    expect(reg.grantsFor('standard')).toEqual(['basic', 'standard']);
    expect(reg.grantsFor('basic')).toEqual(['basic']);
    // An undeclared classification grants nothing. It used to fall through to the ladder.
    expect(reg.grantsFor('bogus')).toEqual([]);
  });

  it('contextPrefixesGranted derives the S3 prefixes (IAM + retrieval consume this one resolver)', () => {
    // The prefixes ARE the grant set with a wrapper, so they are derived from it and the ORDER is what
    // this case is really about: declaration order for IAM, reversed for retrieval, which on this
    // prefix-shaped config puts the serving classification's own documents first.
    const granted = reg.grantsFor('premium');
    expect(reg.contextPrefixesGranted('premium')).toEqual(granted.map((v) => `context/${v}/`));
    expect(reg.contextPrefixesGranted('premium', { reversed: true }))
      .toEqual([...granted].reverse().map((v) => `context/${v}/`));
    expect(reg.contextPrefixesGranted('standard')).toEqual(['context/basic/', 'context/standard/']);
    expect(reg.contextPrefixesGranted('basic')).toEqual(['context/basic/']);
  });

  it('profileFor returns the legacy capability bundle, with basic classified by LLM (intended deviation)', () => {
    const basic = reg.requireProfileFor('basic');
    expect(basic.modelKey).toBe('haiku');
    expect(basic.classifierMode).toBe('llm'); // DEVIATION: legacy basic was 'keyword'
    expect(basic.timeoutSeconds).toBe(30);
    expect(basic.rateLimitPerHour).toBe(60);

    expect(reg.requireProfileFor('standard').modelKey).toBe('sonnet');
    expect(reg.requireProfileFor('standard').classifierMode).toBe('llm');
    expect(reg.requireProfileFor('standard').timeoutSeconds).toBe(60);

    const premium = reg.requireProfileFor('premium');
    expect(premium.modelKey).toBe('opus');
    expect(premium.classifierMode).toBe('llm');
    expect(premium.timeoutSeconds).toBe(90);
    expect(premium.rateLimitPerHour).toBe(240);
  });

  it('classificationValues lists values in declaration order', () => {
    // DERIVED, so the property under test is the ORDER rather than today's roster. Declaration order
    // is the only stable one left: with no rank there is nothing else to sort by, and the config is
    // where a deployment expresses what it wants first.
    const expected = DEFAULT_PROFILES_CONFIG.classifications.map((c) => c.value);
    expect(reg.classificationValues()).toEqual(expected);
    // Non-vacuous: an empty or single-entry roster would satisfy any ordering claim.
    expect(expected.length).toBeGreaterThan(1);
  });
});

describe('profile-registry (aliases + non-default config)', () => {
  it('resolves legacy alias values onto their successor classification', () => {
    const cfg: ProfilesConfig = {
      classifications: [
        { value: 'internal', profile: 'p1', grants: ['internal'] },
        { value: 'confidential', profile: 'p2', grants: ['internal', 'confidential'] },
        { value: 'restricted', profile: 'p2', aliases: ['premium'], grants: ['internal', 'confidential', 'restricted'] },
      ],
      profiles: [
        { name: 'p1', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' },
        { name: 'p2', modelKey: 'opus', classifierMode: 'llm', timeoutSeconds: 90, contextScope: 'granted' },
      ],
      groupClearance: { staff: 'confidential', legal: 'restricted' },
    };
    const reg = new ProfileRegistry(cfg);
    expect(reg.resolveClassification('premium')).toBe('restricted'); // legacy value -> successor
    expect(reg.resolveClassification('restricted')).toBe('restricted');
    expect(reg.resolveClassification('bogus')).toBeUndefined();

    // AND IT REACHES AS WHAT IT NAMES. The old `rank()` read `byValue` alone while
    // `isKnownClassification` accepts an alias, so the two disagreed about the same string: an
    // alias-tagged channel was "known" and then ranked at the fail-closed floor. `grantsFor` resolves
    // the alias first, so the alias and its successor have identical reach.
    expect(reg.grantsFor('premium')).toEqual(reg.grantsFor('restricted'));
    expect(reg.reaches('premium', 'confidential')).toBe(true);
    expect(reg.reaches('bogus', 'internal')).toBe(false);
    expect(reg.clearanceForGroups(['legal'])).toBe('restricted');
    expect(reg.grantsFor('confidential')).toEqual(['internal', 'confidential']);
    expect(reg.requireProfileFor('restricted').modelKey).toBe('opus');
    // Drift-proof: the context prefixes derive from THIS config's classifications, not a hardcoded
    // basic/standard/premium list — so IAM and retrieval move together on a renamed/added classification.
    expect(reg.contextPrefixesGranted('confidential')).toEqual(['context/internal/', 'context/confidential/']);
    expect(reg.contextPrefixesGranted('restricted', { reversed: true })).toEqual(['context/restricted/', 'context/confidential/', 'context/internal/']);
  });
});

describe('validateProfilesConfig (fails loudly)', () => {
  const base = (): ProfilesConfig => JSON.parse(JSON.stringify(DEFAULT_PROFILES_CONFIG));

  it('accepts the shipped default', () => {
    expect(() => validateProfilesConfig(DEFAULT_PROFILES_CONFIG)).not.toThrow();
  });

  it('rejects a duplicate classification value', () => {
    // WHAT MUST BE UNIQUE IS THE VALUE, not a rank. This asserted unique ranks, which was the schema
    // stating the ladder; a tag value declared twice is what actually makes a tag ambiguous.
    const c = base();
    c.classifications[1].value = c.classifications[0].value;
    expect(() => validateProfilesConfig(c)).toThrow(/duplicate classification value/);
  });

  it('rejects a classification that declares no grants', () => {
    // `grants` was optional and fell back to own-rank-and-below. That fallback was the ladder's last
    // hiding place, so its absence is now an error rather than an inherited ordering.
    const c = base();
    (c.classifications[0] as { grants?: string[] }).grants = [];
    expect(() => validateProfilesConfig(c)).toThrow(/declares no grants/);
  });

  it('rejects a classification that does not grant itself', () => {
    // NOT classifications[0]: its only grant is itself, so removing it empties the set and trips the
    // earlier "declares no grants" rule instead - a test that would have passed for the wrong reason.
    const c = base();
    const target = c.classifications[1];
    target.grants = target.grants.filter((v) => v !== target.value);
    expect(target.grants.length).toBeGreaterThan(0); // non-vacuous: still a non-empty set
    expect(() => validateProfilesConfig(c)).toThrow(/does not grant itself/);
  });

  it('rejects two classifications granting the same set', () => {
    // `resolveHolderToken` picks the declared classification whose grants ARE the union a person
    // holds; two identical sets make that answer depend on declaration order, so it is refused here
    // rather than decided there.
    //
    // BOTH SETS STILL CONTAIN BOTH VALUES, so each classification grants itself and the self-grant
    // rule above does not fire first. Copying one set onto the other would have tripped that instead,
    // and the case under test would never have been reached.
    const c = base();
    const [a, b] = [c.classifications[0], c.classifications[1]];
    a.grants = [a.value, b.value];
    b.grants = [a.value, b.value];
    expect(() => validateProfilesConfig(c)).toThrow(/grant the same set/);
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
    c.classifications[1].value = c.classifications[0].value;
    expect(() => new ProfileRegistry(c)).toThrow(/duplicate classification value/);
  });
});

/**
 * THE TOP OF THE LADDER AND THE VALUE TO STAMP CONTENT AT ARE DIFFERENT QUESTIONS.
 *
 * They had one accessor and agreed for as long as every declared classification was a tier a
 * conversation could be served at. Declaring an ADMIN PLANE above the ordinary tiers separated them,
 * and three writers were reaching for the wrong one: untagged knowledge-base ingestion, a summary
 * whose channel tag could not be read, and the NULL-classification bootstrap that stamps every
 * bounded table. Retrieval runs as a per-classification database role and reads its own rank and
 * below, and no user conversation is served on the admin plane - so content stamped there is read by
 * nothing at all, silently and with no error.
 *
 * "Fail closed to the most restrictive value" is the sentence that hides this. The most restrictive
 * value a reader can still reach is the one that means it.
 */
describe('the fail-closed CONTENT stamp is not the widest-reaching classification', () => {
  it('stamps content below the admin plane, where a conversation can still read it', () => {
    expect(defaultProfileRegistry.failClosedContentValue).toBe('premium');
  });

  it('reports the member classification that reaches every other member classification', () => {
    // WAS `mostRestrictiveValue`, "the top of the ladder". There is no top once classifications are
    // peers, so the question became "which one reaches everything" - the same answer on a ladder, and
    // honestly `undefined` when no such classification exists.
    // The admin plane is not among them: it grants itself alone and nothing else grants it.
    expect(defaultProfileRegistry.widestReachingValue).toBe('premium');
  });

  it('the stamped value is readable by a conversation served at it', () => {
    // The property that actually matters, stated as the round trip rather than as a value.
    const stamped = defaultProfileRegistry.failClosedContentValue;
    expect(defaultProfileRegistry.grantsFor(stamped)).toContain(stamped);
  });

  it('there is no widest-reaching classification when the set is genuinely peers', () => {
    // THE CASE THE LADDER COULD NOT EXPRESS, and the reason this accessor is optional. `legal` and
    // `finance` reach only themselves, so nothing contains everything and the honest answer is
    // undefined rather than whichever happened to be declared last.
    const peers = new ProfileRegistry({
      classifications: [
        { value: 'legal', profile: 'p', grants: ['legal'] },
        { value: 'finance', profile: 'p', grants: ['finance'] },
      ],
      profiles: [{ name: 'p', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' }],
      groupClearance: { legal: 'legal', finance: 'finance' },
    });
    expect(peers.widestReachingValue).toBeUndefined();
    // And neither reaches the other, which is the whole point of the model.
    expect(peers.reaches('legal', 'finance')).toBe(false);
    expect(peers.reaches('finance', 'legal')).toBe(false);
    // A person holding BOTH groups holds a combination this deployment has not named, so there is no
    // token for them and the exchange vends nothing rather than guessing.
    expect(peers.clearanceForGroups(['legal', 'finance'])).toBeUndefined();
  });
});

/**
 * A PRINCIPAL'S REACH IS A SET, AND THE SET NEED NOT BE A RANK PREFIX.
 *
 * A person's holdings are not a point on a ladder. A type like `admin` grants access to several
 * classifications at once, and a real taxonomy is rarely a single ordered chain - a `finance` type
 * reaching `finance` and `basic` but not `standard` is ordinary, and rank cannot express it.
 *
 * The set does not live on the principal. A tag is one short Key->Value, so the principal carries a
 * single enum token and `grants` is the lookup that expands it. Enforcement already worked this way:
 * the IAM condition is `StringEquals` over a LIST, which is set membership rather than a comparison.
 * Only the derivation was rank-bound.
 */
describe('grantsFor: a type may grant a set that rank cannot describe', () => {
  const withGrants = (grants: Record<string, string[]>) => new ProfileRegistry({
    ...DEFAULT_PROFILES_CONFIG,
    classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (
      grants[c.value] ? { ...c, grants: grants[c.value] } : c
    )),
  });

  it('the shipped ladder is expressed as prefix-shaped grants, not inferred from an order', () => {
    // WHAT THIS REPLACES: "falls back to own-rank-and-below when a classification declares no grants".
    // There is no fallback any more - every classification declares its set - so the claim worth
    // making is that the default config still produces ladder-shaped reach, which is the
    // compatibility guarantee a ladder deployment cares about.
    const reg = new ProfileRegistry(DEFAULT_PROFILES_CONFIG);
    expect(reg.grantsFor('basic')).toEqual(['basic']);
    expect(reg.grantsFor('standard')).toEqual(['basic', 'standard']);
    expect(reg.grantsFor('premium')).toEqual(['basic', 'standard', 'premium']);
    // Each one reaches itself, which `validateProfilesConfig` now refuses a config for omitting.
    for (const v of reg.classificationValues()) {
      expect(reg.grantsFor(v)).toContain(v);
    }
  });

  it('honours a NON-CONTIGUOUS grant set, which is the whole point', () => {
    // basic and premium but NOT standard: unreachable through any rank comparison.
    const reg = withGrants({ premium: ['basic', 'premium'] });
    expect(reg.grantsFor('premium')).toEqual(['basic', 'premium']);
    expect(reg.grantsFor('premium')).not.toContain('standard');
  });

  it('orders the set by rank, so a generated policy is stable across runs', () => {
    const reg = withGrants({ premium: ['premium', 'basic'] });
    expect(reg.grantsFor('premium')).toEqual(['basic', 'premium']);
  });

  it('does not disturb the ORDER question, which resources still ask', () => {
    // `scopeAtOrBelow` answers "what sits at or below this rank" and is still right for a resource
    // ladder. Only the HOLDER question moved.
    const reg = withGrants({ premium: ['basic', 'premium'] });
    // THE DECLARED SET, VERBATIM. There is no order to derive an expectation from, which is exactly
    // what makes this case possible: 'basic' and 'premium' with 'standard' skipped is a reach no rank
    // comparison can produce.
    expect(reg.grantsFor('premium')).toEqual(['basic', 'premium']);
    expect(reg.reaches('premium', 'standard')).toBe(false);
  });

  it('refuses a grant naming a classification the deployment does not declare', () => {
    // Dropped silently when resolved, so a typo removes reach somebody was meant to have and the
    // symptom is a conversation that is simply missing. A hole, not a narrowing.
    expect(() => withGrants({ premium: ['basic', 'nope', 'premium'] }))
      .toThrow(/grants 'nope', which is not a declared classification/);
  });

  it('refuses a grant set that omits its own classification', () => {
    // A holder who may enter every room except their own is never what anybody means.
    expect(() => withGrants({ premium: ['standard'] })).toThrow(/does not grant itself/);
  });

  it('refuses an admin plane granting a member classification, and a member classification granting the admin plane', () => {
    expect(() => withGrants({ admin: ['basic', 'admin'] })).toThrow(/the admin plane grants itself alone/);
    expect(() => withGrants({ premium: ['basic', 'standard', 'premium', 'admin'] })).toThrow(/grants the admin plane 'admin'/);
  });

  it('drives the S3 context prefixes from the SAME set as the channels', () => {
    // Deriving reach two ways is how an assistant ends up able to message a conversation whose
    // context it cannot read, or the reverse.
    const reg = withGrants({ premium: ['basic', 'premium'] });
    expect(reg.contextPrefixesGranted('premium')).toEqual(['context/basic/', 'context/premium/']);
  });
});

/**
 * A PERSON MAY HOLD SEVERAL CLASSIFICATIONS, AND THE ONE TOKEN THEY CARRY MEANS ALL OF THEM.
 *
 * The principal carries one short enum token, because a tag is a bounded Key->Value and an IAM session
 * tag is single-valued. What was missing was the RESOLUTION: `clearanceForGroups` returned the highest
 * single group, so somebody in two clearance groups where neither contains the other lost one
 * silently - the set model existed for `grants` and stopped at the door.
 *
 * `resolveHolderToken` takes the union of what every held group clears for and returns the declared
 * classification whose grant set IS that union. Holding several is expressible; the carrier stays one
 * token; and a combination nobody declared fails closed rather than landing on a near fit.
 */
describe('a holder token stands for everything the caller holds', () => {
  const reg = defaultProfileRegistry;

  it('lists EVERY classification the groups clear for, not just the highest', () => {
    expect(reg.clearancesForGroups(['basic', 'premium'])).toEqual(['basic', 'premium']);
    expect(reg.clearancesForGroups(['admins', 'premium'])).toEqual(['premium', 'admin']);
  });

  it('ignores groups that map to no classification, rather than reading them as the floor', () => {
    // A persona or directory group is not a clearance. Treating an unmapped group as the floor would
    // invent a clearance from a group that says nothing about clearance.
    expect(reg.clearancesForGroups(['platform-devs', 'engineering'])).toEqual([]);
    expect(reg.clearancesForGroups(['platform-devs', 'standard'])).toEqual(['standard']);
  });

  it('resolves a ladder combination to the token that already covers it', () => {
    // premium grants [basic,standard,premium]; the admin plane grants itself alone, so holding both is the
    // premium token with the admin plane beside it, and holding the admin plane alone is the admin token.
    expect(reg.resolveHolderToken(['premium', 'admins'])).toBe('premium');
    expect(reg.holderForGroups(['premium', 'admins'])).toEqual({ token: 'premium', adminPlane: true });
    expect(reg.holderForGroups(['admins'])).toEqual({ token: 'admin', adminPlane: true });
    expect(reg.reachOf(reg.holderForGroups(['admins']))).toEqual(['admin']);
    expect(reg.reachOf(reg.holderForGroups(['premium', 'admins']))).toEqual(['basic', 'standard', 'premium', 'admin']);
    expect(reg.holderForGroups(['premium'])).toEqual({ token: 'premium', adminPlane: false });
    expect(reg.resolveHolderToken(['basic', 'standard'])).toBe('standard');
    expect(reg.resolveHolderToken(['premium'])).toBe('premium');
  });

  it('resolves a NON-CONTIGUOUS combination to the token declared for it', () => {
    // The case rank cannot express: `finance` grants basic+finance and nothing else. A person in
    // `basic` and `finance` holds exactly that union, and `finance` is its name.
    const withFinance = new ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      classifications: [
        ...DEFAULT_PROFILES_CONFIG.classifications,
        { value: 'finance', profile: 'advisor', grants: ['basic', 'finance'] },
      ],
      groupClearance: { ...DEFAULT_PROFILES_CONFIG.groupClearance, finance: 'finance' },
    });
    expect(withFinance.resolveHolderToken(['basic', 'finance'])).toBe('finance');
    expect(withFinance.grantsFor('finance')).toEqual(['basic', 'finance']);
    // And it is genuinely not a rank prefix - standard and premium rank between them and are excluded.
    expect(withFinance.grantsFor('finance')).not.toContain('standard');
  });

  it('FAILS CLOSED on a combination no declared classification names', () => {
    // standard grants [basic,standard]; finance grants [basic,finance]. The union is
    // [basic,standard,finance], which nothing declares - so the answer is the floor, never the
    // "closest" token. Closest is either more reach than they hold or less, and the first is a breach.
    const withFinance = new ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      classifications: [
        ...DEFAULT_PROFILES_CONFIG.classifications,
        { value: 'finance', profile: 'advisor', grants: ['basic', 'finance'] },
      ],
      groupClearance: { ...DEFAULT_PROFILES_CONFIG.groupClearance, finance: 'finance' },
    });
    // UNDEFINED, NOT THE FLOOR. An undeclared combination used to land on the floor, which is a
    // token that grants something - so the person got a working credential for a reach nobody wrote
    // down. Nothing is vended now.
    expect(withFinance.resolveHolderToken(['standard', 'finance'])).toBeUndefined();
    // And it says so, so the vend can log a config defect instead of silently under-serving.
    expect(withFinance.holderTokenCovers(['standard', 'finance'])).toBe(false);
    expect(withFinance.holderTokenCovers(['basic', 'finance'])).toBe(true);
  });

  it('a caller with no mapped group gets no token, and that is not a config defect', () => {
    // The two answers are deliberately different questions. There is no token, because they hold no
    // clearance; but nothing about the DEPLOYMENT is wrong, so `holderTokenCovers` stays true and the
    // vend logs no config defect. It is the caller who has no clearance, not the config that failed
    // to name one.
    expect(reg.resolveHolderToken([])).toBeUndefined();
    expect(reg.holderTokenCovers([])).toBe(true);
  });
});

describe('the alt is named for its classification and role (ADR-050, P1)', () => {
  const reg = defaultProfileRegistry;

  it('names each declared role, and reads the classification and role back from the name', () => {
    expect(reg.altAssistantName('premium', 'primary')).toBe('alt-primary-premium');
    expect(reg.altAssistantName('premium', 'ops')).toBe('alt-ops-premium');
    expect(reg.roleOfAlt('alt-primary-premium')).toEqual({ classification: 'premium', role: 'primary' });
    expect(reg.roleOfAlt('alt-ops-premium')).toEqual({ classification: 'premium', role: 'ops' });
    expect(reg.classificationOfAssistant('alt-primary-basic')).toBe('basic');
  });

  it('names nothing for a role or classification the deployment does not declare', () => {
    expect(reg.altAssistantName('premium', 'nonexistent')).toBeUndefined();
    expect(reg.altAssistantName('legal', 'primary')).toBeUndefined();
    expect(reg.roleOfAlt('alt-primary-legal')).toBeUndefined();
    expect(reg.roleOfAlt('advisor')).toBeUndefined();
  });

  it("derives the alt's deploy-time descriptor from its role's live assistant, under the alt's own name", () => {
    const seed = reg.altSeedFor('alt-primary-premium')!;
    const live = reg.profileByName('advisor')!;
    expect(seed.name).toBe('alt-primary-premium');
    expect(seed.classifierMode).toBe(live.classifierMode);
    expect(seed.rateLimitPerHour).toBe(live.rateLimitPerHour);
    expect(reg.altSeedFor('alt-ops-premium')!.rateLimitPerHour).toBe(reg.profileByName('ops-premium')!.rateLimitPerHour);
    expect(reg.altSeedFor('alt-primary-legal')).toBeUndefined();
  });

  it('reserves every name a deploy-time assistant or an alt already owns', () => {
    for (const name of ['premium', 'advisor', 'ops-premium', 'alt-anything', '']) {
      expect({ name, reserved: reg.isReservedAssistantName(name) }).toEqual({ name, reserved: true });
    }
    expect(reg.isReservedAssistantName('finance-advisor')).toBe(false);
  });

  it('refuses a declared profile under the alt prefix', () => {
    const c: ProfilesConfig = JSON.parse(JSON.stringify(DEFAULT_PROFILES_CONFIG));
    c.profiles.push({ ...c.profiles[0], name: 'alt-primary-premium' });
    expect(() => validateProfilesConfig(c)).toThrow(/'alt-' prefix/);
  });
});
