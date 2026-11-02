/**
 * THE RAW LAMBDAS' ADMISSION CHECK MIRRORS THE REGISTRY, AND THIS IS WHAT HOLDS THEM TOGETHER.
 *
 * `share-conversation` is a JavaScript handler that applies the registry's decision data with its own
 * `reachableClassifications`: it loads the runtime registry and builds the data with `classificationAdmission`
 * (`lib/classification-admission.ts`), and applies it locally.
 *
 * `create-conversation` WAS THE OTHER ONE AND NO LONGER IS (ADR-053). It is a bundled
 * `NodejsFunction` that imports the registry, so there is no second implementation of the rule left on
 * that path and nothing for this suite to hold together - it is removed from the list rather than left
 * reading a file that does not exist. The way to keep the remaining mirror honest is to retire it the
 * same way; the way to make this suite lie is to let the list empty out while the `it` below still
 * reports green, which is what the vacuity check guards.
 *
 * That is two implementations of one rule, which is a real cost and only acceptable with a test
 * holding them together. What they replaced was worse: three copies of
 * `TIER_RANK = { basic: 1, standard: 2, premium: 3 }` plus an `includes('premium')` ladder, with no
 * guard at all - which is why an administrator could not be invited to a conversation, could not
 * create one, and why an `admin`-classified conversation ranked BELOW `basic`.
 *
 * The cases below are chosen to DISTINGUISH the two implementations, not to agree trivially. A ladder
 * and a grant set give the same answer for the shipped config, so a test built only on that config
 * would pass against the code this replaced.
 */
import { ProfileRegistry, defaultProfileRegistry } from '../../lib/profile-registry';
import { classificationAdmission } from '../../lib/classification-admission';
import { DEFAULT_PROFILES_CONFIG } from '../../lib/config/profiles';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The Lambda's own `reachableClassifications`, executed - not re-typed here.
 *
 * Extracted from the shipped source and evaluated, so this tests the CODE THAT DEPLOYS rather than a
 * copy of it that could drift from both sides at once.
 */
function lambdaReach(source: string, admission: unknown, groups: string[]): string[] {
  const fn = source.match(/function reachableClassifications\(groups\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error('reachableClassifications not found in the Lambda source');
  // eslint-disable-next-line no-new-func
  const make = new Function('ADMISSION', `${fn[0]}; return reachableClassifications;`);
  return make(admission)(groups);
}

// ONE ENTRY IS STILL A REAL SUBJECT, and an empty list must fail rather than pass: the first `it`
// below iterates this, so a list emptied by the next consolidation would assert nothing at all.
const RAW_LAMBDAS = ['share-conversation'];
const sourceOf = (dir: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', dir, 'index.js'), 'utf8');

/** Source with `//` and ` *` comment lines dropped, so prose ABOUT a removed symbol does not read as a
 *  use of it. Every one of these files explains what it replaced, which is the point of the comments
 *  and would otherwise make an absence check unpassable. */
const codeOnly = (src: string) => src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');

/** The env payload the stacks emit - THE BUILDER ITSELF, so a field added to it is exercised here
 *  rather than re-typed into a copy that agrees with nothing. */
const admissionFor = (reg: ProfileRegistry) => classificationAdmission(reg);

describe('the raw Lambdas admit exactly who the registry says', () => {
  it('every raw Lambda carries the mirror (a scan that finds none passes vacuously)', () => {
    // THE LIST IS NOT EMPTY, asserted first. Everything below is a `for` over it, so the day the last
    // raw Lambda is bundled this suite would go green while testing nothing - retire it then instead.
    expect(RAW_LAMBDAS.length).toBeGreaterThan(0);
    for (const dir of RAW_LAMBDAS) {
      expect(`${dir}: ${sourceOf(dir).includes('function reachableClassifications')}`)
        .toBe(`${dir}: true`);
    }
  });

  it('agrees with the registry on the shipped config, including the admin case', () => {
    const reg = defaultProfileRegistry;
    const admission = admissionFor(reg);
    const cases: string[][] = [
      ['basic'], ['standard'], ['premium'],
      // THE CASE THAT WAS BROKEN. An admin-only user resolved to no tier, ranked 0, and was refused
      // everywhere - including their own admin-classified conversation.
      ['admins'],
      ['admins', 'premium'],
      ['platform-devs'], // maps to nothing: reach is empty, and that is the honest answer
      [],
    ];
    for (const dir of RAW_LAMBDAS) {
      const src = sourceOf(dir);
      for (const groups of cases) {
        const expected = reg.clearancesForGroups(groups).length === 0
          ? []
          : reg.holderForGroups(groups).token ? reg.reachOf(reg.holderForGroups(groups)) : [];
        expect(`${dir} ${JSON.stringify(groups)}: ${lambdaReach(src, admission, groups).sort().join(',')}`)
          .toBe(`${dir} ${JSON.stringify(groups)}: ${[...expected].sort().join(',')}`);
      }
    }
  });

  it('agrees on a NON-CONTIGUOUS grant set, which a rank ladder cannot express', () => {
    // The case that distinguishes the implementations. `finance` grants basic+finance and NOT
    // standard, so a rank comparison gives a different answer from a set membership test - a mirror
    // that had quietly reverted to ranking fails here and nowhere else.
    const reg = new ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      classifications: [
        ...DEFAULT_PROFILES_CONFIG.classifications,
        { value: 'finance', profile: 'advisor', grants: ['basic', 'finance'] },
      ],
      groupClearance: { ...DEFAULT_PROFILES_CONFIG.groupClearance, finance: 'finance' },
    });
    const admission = admissionFor(reg);
    for (const dir of RAW_LAMBDAS) {
      const reach = lambdaReach(sourceOf(dir), admission, ['finance']);
      expect(`${dir}: ${reach.sort().join(',')}`).toBe(`${dir}: basic,finance`);
      expect(`${dir} excludes standard: ${reach.includes('standard')}`).toBe(`${dir} excludes standard: false`);
    }
  });

  it('names no floor, in code or in the payload it applies', () => {
    // `share-conversation` read `grants[ADMISSION.failClosedTo]` for an unnamed combination and
    // `ADMISSION.failClosedTo` for an unreadable channel tag. The builder has never emitted that
    // field, so both resolved to nothing and the Lambda was correct by accident - while its comments
    // described a floor policy, which is what the next reader would have restored. The field is
    // absent from the payload (pinned below) and now absent from the consumers too.
    for (const dir of RAW_LAMBDAS) {
      expect(`${dir} reads failClosedTo: ${codeOnly(sourceOf(dir)).includes('failClosedTo')}`)
        .toBe(`${dir} reads failClosedTo: false`);
    }
  });

  it('share-conversation refuses an unestablished classification before it resolves a bot', () => {
    // A SOURCE-TEXT GUARD, which is the honest level available: this Lambda ships as a raw directory
    // and its handler is one function over five AWS clients. What it pins is the ORDER, which is where
    // the defect was: the refusal has to precede the bot lookup, now the room's primary
    // (`resolveRoomPrimaryBotArn`, DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION 3.8), which compares the
    // primary's classification with the channel's and throws on a mismatch - so an unestablished
    // classification reaching it turns a 403 the caller could act on into a 500 that names nothing.
    const src = sourceOf('share-conversation');
    const refusal = src.indexOf('CLASSIFICATION_UNKNOWN');
    const botLookup = src.indexOf('await resolveRoomPrimaryBotArn(conversationArn, channelTier)');
    expect(`refuses: ${refusal !== -1}`).toBe('refuses: true');
    expect(`resolves a bot: ${botLookup !== -1}`).toBe('resolves a bot: true');
    expect(`refusal precedes the bot lookup: ${refusal < botLookup}`)
      .toBe('refusal precedes the bot lookup: true');
    // And the tag reader hands back nothing rather than a substitute value.
    expect(`returns undefined for an unreadable tag: ${/if \(tag && VALID_CLASSIFICATIONS\.has\(tag\)\) return tag;[\s\S]*?return undefined;/.test(src)}`)
      .toBe('returns undefined for an unreadable tag: true');
  });

  it('agrees on FAILING CLOSED when no declared classification names the combination', () => {
    // standard grants [basic,standard]; finance grants [basic,finance]. The union is named by
    // nothing, so both sides must reach nothing rather than a near fit.
    const reg = new ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      classifications: [
        ...DEFAULT_PROFILES_CONFIG.classifications,
        { value: 'finance', profile: 'advisor', grants: ['basic', 'finance'] },
      ],
      groupClearance: { ...DEFAULT_PROFILES_CONFIG.groupClearance, finance: 'finance' },
    });
    const admission = admissionFor(reg);
    // AN UNNAMED COMBINATION NOW REACHES NOTHING. This expected the floor's grants, because an
    // undeclared combination used to resolve to the floor; it resolves to no token at all, so the
    // Lambda's admission data grants nothing and the caller is refused.
    const expected: string[] = [];
    for (const dir of RAW_LAMBDAS) {
      expect(`${dir}: ${lambdaReach(sourceOf(dir), admission, ['standard', 'finance']).sort().join(',')}`)
        .toBe(`${dir}: ${[...expected].sort().join(',')}`);
    }
  });

  it('admits nobody when the config is absent, rather than everybody', () => {
    // A missing or malformed env is a deployment fault. The direction it fails in is the point.
    for (const dir of RAW_LAMBDAS) {
      expect(`${dir}: ${lambdaReach(sourceOf(dir), {}, ['premium']).join(',')}`).toBe(`${dir}: `);
    }
  });
});

/**
 * THE EXCLUSIVE CLEARANCE GROUPS, which are a different question from reach.
 *
 * `post-confirmation.js` and `user-management.ts` both SET somebody's clearance, and setting one means
 * removing the others - so they need to know which groups are exclusive of each other, not which
 * groups convey a classification. Both carried `['basic', 'standard', 'premium']` as a literal, so a
 * deployment declaring a fourth classification could leave a person in two groups at once with
 * precedence decided by whichever writer ran last.
 */
describe('the exclusive clearance groups come from the registry', () => {
  it('excludes the admin plane, so a clearance edit cannot strip administration', () => {
    const groups = defaultProfileRegistry.clearanceGroups();
    // `admins` maps to a classification, so a plain `Object.keys(groupClearance)` would include it -
    // and the exclusivity sweep would then remove an administrator from `admins` on any tier change,
    // demoting them as a side effect of an unrelated edit.
    expect(`admins is exclusive: ${groups.includes('admins')}`).toBe('admins is exclusive: false');
    // DERIVED, NOT LITERAL, and for the reason this describe block is about. A literal list here
    // fails the moment a deployment declares another classification, which is the same break
    // `profile-registry.test.ts` was already corrected for. The expectation is rebuilt from the config
    // so it still refuses the two regressions that matter: a group whose classification is admin-plane
    // leaking in, and an order that is not the config's declaration order.
    const expected = Object.entries(DEFAULT_PROFILES_CONFIG.groupClearance)
      .map(([group, value]) => ({
        group,
        c: DEFAULT_PROFILES_CONFIG.classifications.find((x) => x.value === value),
      }))
      .filter((e) => e.c && !e.c.adminPlane)
      .sort((a, b) => DEFAULT_PROFILES_CONFIG.classifications.indexOf(a.c!)
        - DEFAULT_PROFILES_CONFIG.classifications.indexOf(b.c!))
      .map((e) => e.group);
    expect(`clearance groups: ${groups.join(',')}`).toBe(`clearance groups: ${expected.join(',')}`);
    // Non-vacuity: the derivation must actually have dropped something, or the admin-plane filter
    // above is being asserted by a list that never contained an admin-plane group in the first place.
    expect(`dropped an admin-plane group: ${'admins' in DEFAULT_PROFILES_CONFIG.groupClearance && !expected.includes('admins')}`)
      .toBe('dropped an admin-plane group: true');
  });

  it('is ordered by the classifications declaration order, not by the order the config lists groups in', () => {
    const reg = new ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      groupClearance: { premium: 'premium', basic: 'basic', admins: 'admin', standard: 'standard' },
    });
    expect(reg.clearanceGroups().join(',')).toBe('basic,standard,premium');
  });

  it('travels to the raw Lambdas in the admission payload', () => {
    // post-confirmation reads `ADMISSION.clearanceGroups`, and a payload missing the field makes its
    // sweep a silent no-op rather than an error - so the field's presence is the thing to pin.
    expect(Object.keys(classificationAdmission(defaultProfileRegistry)).sort().join(','))
      // `failClosedTo` IS GONE from the payload: there is no floor for an unnamed
      // combination to fall to, so the consumer refuses instead of reaching for one.
      .toBe('adminPlane,clearanceGroups,grants,groupClearance');
  });

  const LITERAL_LADDER = /\[\s*'basic',\s*'standard',\s*'premium'\s*\]/;
  /** The same comment-stripper the absence checks above use, under the name this block already read by. */
  const withoutComments = codeOnly;

  it('post-confirmation reads the payload rather than a literal ladder', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'cognito-triggers', 'post-confirmation.js'), 'utf8');
    expect(`reads config: ${src.includes('(await loadAdmission()).clearanceGroups')}`).toBe('reads config: true');
    expect(`carries a literal ladder: ${LITERAL_LADDER.test(withoutComments(src))}`)
      .toBe('carries a literal ladder: false');
  });

  it('user-management derives the groups rather than listing them', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'user-management.ts'), 'utf8');
    expect(`derives from the registry: ${src.includes('profiles.clearanceGroups()')}`)
      .toBe('derives from the registry: true');
    expect(`carries a literal ladder: ${LITERAL_LADDER.test(withoutComments(src))}`)
      .toBe('carries a literal ladder: false');
  });
});

/**
 * THE RAW COGNITO TRIGGER READS THE SAME ROWS AND ASSEMBLES THE SAME ADMISSION DATA.
 *
 * `post-confirmation.js` is deployed with `lambda.Code.fromAsset` and cannot import the registry, so it reads
 * the deployment's registry rows itself (`lambda/cognito-triggers/registry-admission.js`) and assembles the
 * admission data `classificationAdmission` builds from the registry those rows load into. Pinned here on the
 * shipped catalog, a selection of it and a custom set, so the two assemblies cannot drift.
 */
describe('the raw trigger assembles the admission data the registry builds from the same rows', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require('../../lambda/cognito-triggers/registry-admission.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registryRowsOf, registryRowValue, profilesConfigFromRows, resolveDeploymentProfiles } = require('../../lib/config/profiles');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CUSTOM_PROFILES_PLUS_ENTERPRISE } = require('../deploy-matrix/configurations');

  it.each([
    ['the shipped catalog', DEFAULT_PROFILES_CONFIG],
    ['a selection of the catalog', resolveDeploymentProfiles(['basic', 'premium'])],
    ['a custom set', resolveDeploymentProfiles(CUSTOM_PROFILES_PLUS_ENTERPRISE)],
  ])('%s', async (_name: string, config: unknown) => {
    const values: string[] = registryRowsOf(config).map(registryRowValue);
    const registry = new ProfileRegistry(profilesConfigFromRows(values.map((v) => raw.rowOf(v))));
    expect(raw.admissionOfRows(values.map((v) => raw.rowOf(v)))).toEqual(classificationAdmission(registry));
    process.env.AE_PROFILE_REGISTRY_PATH = '/test/registry/classification';
    try {
      raw.__setRowReaderForTest(async () => values);
      await expect(raw.loadAdmission()).resolves.toEqual(classificationAdmission(registry));
    } finally {
      delete process.env.AE_PROFILE_REGISTRY_PATH;
      raw.__setRowReaderForTest(undefined);
    }
  });

  it('refuses to answer with no path, and with no data read yet', async () => {
    await expect(raw.loadAdmission()).rejects.toThrow(/AE_PROFILE_REGISTRY_PATH is not set/);
    process.env.AE_PROFILE_REGISTRY_PATH = '/test/registry/classification';
    try {
      raw.__setRowReaderForTest(async () => { throw new Error('ssm down'); });
      await expect(raw.loadAdmission()).rejects.toThrow(/ssm down/);
    } finally {
      delete process.env.AE_PROFILE_REGISTRY_PATH;
      raw.__setRowReaderForTest(undefined);
    }
  });
});
