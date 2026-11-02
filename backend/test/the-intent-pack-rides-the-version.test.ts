/**
 * THE INTENT PACK IS PART OF A PROFILE, and this file is the direction of guard that was missing.
 *
 * The spec has defined a profile as including the intent pack since it was written
 * (SPEC-PORTABLE-PROFILES: "a profile is what an assistant is: model, persona/system prompt, INTENT
 * PACK, tools, guardrail selection, classifier mode, timeouts, limits"). It was never built. `intentPack`
 * appeared in none of `active-profile.ts`, `profile-lifecycle.ts` or `profile-manifest.ts` on any ref.
 *
 * WHY MONTHS OF CONFORMANCE WORK DID NOT CATCH IT. `versioned-profile-omits-deploy-time-fields.test.ts`
 * is entirely one-directional: every assertion in it is about what must stay OUT ("carries no
 * deployment-time field", "drops every one of them", "offers no editor for one"). There was no
 * counterpart asserting the spec's field list is IN - so a MISSING field passed every test in the suite.
 * A ratchet that only tightens in one direction is not a ratchet; it is a filter.
 *
 * So the first test here reads the spec's own sentence and requires every field it names to be
 * ACCOUNTED FOR: either it rides the version, or it is on the deploy-owned list with the reader that
 * owns it. A field in neither bucket fails, which is exactly the state `intentPack` was in.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  bodyFrom,
  buildDefinition,
  profileDefinitionConfigId,
  resolveFromDefinition,
  serializeSeedDefinition,
  validateDefinitionBody,
  PROFILE_DEFINITION_SCHEMA_VERSION,
  resolveActiveProfile,
  __clearActiveProfileCache,
  type ProfileDefinition,
  type ProfileDefinitionBody,
} from '../lambda/src/lib/active-profile';
import {
  DEFAULT_INTENT_PACK,
  resolveStoredPack,
  instructionsForIntent,
  toolsForIntent,
  MAX_INTENT_INSTRUCTIONS,
  type StoredIntentPack,
  type IntentDef,
} from '../lambda/src/lib/intent-pack';
import { ALL_TOOL_NAMES } from '../lambda/src/lib/tool-registry';
import { answersThroughGeneral, resolveModelForIntent } from '../lambda/src/lib/model-resolver';
import { getModelCatalog } from '../lib/config/model-strategy';
import { selectDeliveryOption, DeliveryOption } from '../lambda/src/lib/delivery-options';
import { BASIC_ONBOARDING, STANDARD_ONBOARDING, PREMIUM_ONBOARDING } from '../demo/onboarding';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SPEC = path.join(REPO_ROOT, 'docs/specs/interaction/assistants/SPEC-PORTABLE-PROFILES.md');

/**
 * Every field the spec sentence names, and where it lives. `ridesTheVersion` names the key on
 * `ProfileDefinitionBody`; `deployOwned` means the other ratchet file owns it and says why.
 *
 * The point of the table is that a spec-named field cannot be silently ABSENT from both. That is the
 * only state this test refuses, and it is the state the pack was in.
 */
const SPEC_FIELDS: Array<{ spec: string; ridesTheVersion?: keyof ProfileDefinitionBody; deployOwned?: string }> = [
  { spec: 'model', ridesTheVersion: 'models' },
  { spec: 'persona/system prompt', ridesTheVersion: 'persona' },
  { spec: 'intent pack', ridesTheVersion: 'intentPack' },
  { spec: 'onboarding', ridesTheVersion: 'onboarding' },
  { spec: 'tools', ridesTheVersion: 'tools' },
  { spec: 'guardrail selection', ridesTheVersion: 'guardrailId' },
  { spec: 'classifier mode', deployOwned: 'versioned-profile-omits-deploy-time-fields.test.ts (classifierMode)' },
  { spec: 'timeouts', deployOwned: 'versioned-profile-omits-deploy-time-fields.test.ts (timeoutSeconds)' },
  { spec: 'limits', deployOwned: 'versioned-profile-omits-deploy-time-fields.test.ts (rateLimitPerHour)' },
];

/** A body with every key set, used to prove a key is real rather than merely declared on a type. */
function fullBody(pack?: StoredIntentPack): ProfileDefinitionBody {
  return {
    modelKey: 'claude-haiku',
    models: { default: 'claude-haiku' },
    tools: [ALL_TOOL_NAMES[0]],
    guardrailId: 'strict',
    persona: 'I am the test persona.',
    onboarding: { greeting: 'Hello.', fields: [{ key: 'k', prompt: 'p?', required: false }] },

    ...(pack ? { intentPack: pack } : {}),
  };
}

const OWN_PACK: StoredIntentPack = {
  extends: 'default',
  intents: [{
    key: 'financial_metric',
    description: 'A single financial figure, answered inline.',
    keywords: ['arr', 'revenue'],
    delivery: 'PLACEHOLDER_UPDATE',
  }],
};

describe('the spec field list is accounted for, in both directions', () => {
  it('the spec still defines a profile as the list this table mirrors', () => {
    // If the sentence is reworded, this fails and the table has to be re-read against it rather than
    // drifting quietly - which is how a spec sentence and an implementation part company.
    const spec = fs.readFileSync(SPEC, 'utf8');
    const sentence = spec.split('\n').find((l) => l.includes('A **profile** is'));
    expect(sentence).toBeDefined();
    for (const { spec: field } of SPEC_FIELDS) {
      expect(sentence!.toLowerCase()).toContain(field.toLowerCase());
    }
  });

  it.each(SPEC_FIELDS)('the spec field "$spec" is either on the version or deploy-owned', (entry) => {
    if (entry.deployOwned) {
      expect(typeof entry.deployOwned).toBe('string');
      return;
    }
    expect(entry.ridesTheVersion).toBeDefined();
    // Declared on the type is not enough - `bodyFrom` is what actually carries a field through an
    // edit, an export and a clone, so a field it drops does not ride the version whatever the type says.
    const carried = bodyFrom(fullBody(OWN_PACK) as Partial<ProfileDefinitionBody>);
    expect(Object.keys(carried)).toContain(entry.ridesTheVersion as string);
  });
});

describe('a version carries its taxonomy', () => {
  it('bodyFrom round-trips the pack through export, import and clone', () => {
    const body = fullBody(OWN_PACK);
    // Two hops: the shape an export writes, then the shape an import reads back.
    const exported = JSON.parse(JSON.stringify(bodyFrom(body)));
    const reimported = bodyFrom(exported);
    expect(reimported.intentPack).toEqual(OWN_PACK);
    // `extends` in particular must survive. Resolving it on the way through would silently inflate the
    // stored definition past the 4096-character parameter limit (demo-seed-budget.test.ts measures it).
    expect(reimported.intentPack?.extends).toBe('default');
  });

  it('the configId changes when the taxonomy changes', () => {
    // The defect this closes: `intentPack` was on the body and in `bodyFrom` but NOT in
    // RUNTIME_EDITABLE_KEYS, so it was not hashed. A version that added an intent, reworded a
    // description the classifier is shown, or changed an intent's delivery produced the SAME configId
    // as the version it replaced - and every turn it served was attributed to that one.
    const withPack = profileDefinitionConfigId(fullBody(OWN_PACK));
    const without = profileDefinitionConfigId(fullBody());
    expect(withPack).not.toBe(without);

    const reworded: StoredIntentPack = {
      ...OWN_PACK,
      intents: [{ ...OWN_PACK.intents[0], description: 'A different description entirely.' }],
    };
    expect(profileDefinitionConfigId(fullBody(reworded))).not.toBe(withPack);
  });

  it('resolveFromDefinition serves the RESOLVED pack, inheriting the platform taxonomy', () => {
    const def: ProfileDefinition = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      ...fullBody(OWN_PACK),
      configId: profileDefinitionConfigId(fullBody(OWN_PACK)),
    };
    const resolved = resolveFromDefinition(def, 'analyst');
    const keys = resolved.intentPack!.intents.map((d) => d.key);
    // Its own intent first, then every default it did not override - the order the classifier prompt uses.
    expect(keys[0]).toBe('financial_metric');
    for (const d of DEFAULT_INTENT_PACK.intents) expect(keys).toContain(d.key);
  });

  it('a version carrying no pack resolves to undefined, so the deployment seam still answers', () => {
    const body = fullBody();
    const def: ProfileDefinition = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      ...body,
      configId: profileDefinitionConfigId(body),
    };
    // Undefined, NOT the default pack: the caller's fallback is the deployment's own taxonomy, and
    // answering with the platform default here would take that away from every legacy version.
    expect(resolveFromDefinition(def, 'analyst').intentPack).toBeUndefined();
  });

  it('the seed is unchanged when no pack is handed to it', () => {
    // The additive bar: a caller that does not migrate gets byte-for-byte what it got before.
    expect(serializeSeedDefinition('analyst')).toBe(serializeSeedDefinition('analyst', undefined, undefined));
    expect(JSON.parse(serializeSeedDefinition('analyst')!).intentPack).toBeUndefined();
  });

  it('the seed carries the pack when one is handed to it', () => {
    const seeded = JSON.parse(serializeSeedDefinition('analyst', undefined, OWN_PACK)!) as ProfileDefinition;
    expect(seeded.intentPack).toEqual(OWN_PACK);
    // And it is hashed, so the migrated version is not attributed to the unmigrated one.
    expect(seeded.configId).not.toBe(JSON.parse(serializeSeedDefinition('analyst')!).configId);
  });
});

describe('routes and the taxonomy are reconciled', () => {
  const withRoute = (intent: string, pack?: StoredIntentPack): Partial<ProfileDefinitionBody> => ({
    ...fullBody(pack),
    models: { default: 'claude-haiku', byIntent: { [intent]: { primary: 'claude-opus' } } },
  });

  it('refuses a route no intent this version can classify resolves to', () => {
    // The defect: such a version published and activated cleanly, the route never fired, and every
    // such turn answered on the base model with nothing errored and nothing logged.
    const errs = validateDefinitionBody(withRoute('no_such_intent', OWN_PACK));
    expect(errs.join(' ')).toContain("models.byIntent['no_such_intent']");
  });

  it('accepts every route the SEED ships, which is the shape a real deployment activates', () => {
    // The check has to pass on the routes the product already ships, or it refuses every activation.
    // It nearly did: `byIntent` is keyed by RouteKey and the pack declares classifier intent keys, so
    // comparing the two key sets directly refused `general`, `data_extraction` and
    // `guided_troubleshooting` - the routes that carry general, data_extraction and guided_troubleshooting.
    const seeded = JSON.parse(serializeSeedDefinition('analyst', undefined, OWN_PACK)!) as ProfileDefinition;
    expect(Object.keys(seeded.models!.byIntent!).length).toBeGreaterThan(0);
    expect(validateDefinitionBody(seeded)).toEqual([]);
  });

  it.each([
    ['general', 'general, greeting and acknowledgment all resolve here'],
    ['guided_troubleshooting', 'guided_troubleshooting resolves here'],
    ['data_extraction', 'data_extraction resolves here'],
    ['report_generation', 'an identity mapping - the key is both'],
  ])('accepts the reachable route %s (%s)', (routeKey) => {
    expect(validateDefinitionBody(withRoute(routeKey, OWN_PACK))).toEqual([]);
  });

  it('accepts a route keyed by the intent itself, and refuses a retired route key naming the intent (ADR-064)', () => {
    expect(validateDefinitionBody(withRoute('guided_troubleshooting', OWN_PACK))).toEqual([]);
    const errs = validateDefinitionBody(withRoute('workflow_actions', OWN_PACK));
    expect(errs.join(' ')).toContain('is a retired route key; the route is keyed by the intent');
  });

  it('leaves a version with routes and NO pack to the write path', () => {
    // Pure code cannot read the deployment pack, so this case is checked by `deploymentRouteErrors`
    // in profile-lifecycle (publish + activate) and profile-manifest (import). Refusing here on a pack
    // it cannot see would reject every version written before the migration.
    expect(validateDefinitionBody(withRoute('no_such_intent'))).toEqual([]);
  });

  it('refuses a pack that redeclares a universal intent or repeats a key', () => {
    const dupe: StoredIntentPack = { intents: [OWN_PACK.intents[0], OWN_PACK.intents[0]] };
    expect(validateDefinitionBody({ ...fullBody(dupe) }).join(' ')).toContain('repeats the key');
    const universal: StoredIntentPack = {
      intents: [{ key: 'general', description: 'x', keywords: ['x'], delivery: 'PLACEHOLDER_UPDATE' }],
    };
    expect(validateDefinitionBody({ ...fullBody(universal) }).join(' ')).toContain('redeclares the universal intent');
  });

  it('refuses `intentPack.machines` on a version, naming the field that works', () => {
    // Bringing the pack onto the version created a SECOND place to declare task machines. The pack's
    // block is read on the per-deployment parameter (`taskStateMachines()` merges it over the
    // defaults) and by nothing at all on a version - every machines consumer takes the body's
    // top-level `machines`. Two identical-looking homes where one decides nothing is the exact shape
    // of defect that kept the pack off the version in the first place.
    const withMachines = { ...OWN_PACK, machines: { place_item: { initial: 'x', states: {} } } } as unknown as StoredIntentPack;
    const errs = validateDefinitionBody({ ...fullBody(withMachines) });
    expect(errs.join(' ')).toContain('intentPack.machines is not read from a profile version');
    expect(errs.join(' ')).toContain('top-level `machines`');
  });

  it('the seed drops the deployment pack\'s machines rather than refusing itself', () => {
    // The seed folds in the deployment pack, which MAY carry machines. Left in, the validator would
    // refuse the definition the seeder just wrote.
    const packWithMachines = {
      ...OWN_PACK,
      machines: { place_item: { initial: 'x', states: {} } },
    } as unknown as StoredIntentPack;
    const seeded = JSON.parse(serializeSeedDefinition('analyst', undefined, packWithMachines)!) as ProfileDefinition;
    expect(seeded.intentPack?.machines).toBeUndefined();
    expect(seeded.intentPack?.intents).toEqual(OWN_PACK.intents);
    expect(validateDefinitionBody(seeded)).toEqual([]);
  });

  it('refuses a mistyped `extends`, which would silently REPLACE the platform taxonomy', () => {
    const typo = { extends: 'defaults', intents: OWN_PACK.intents } as unknown as StoredIntentPack;
    expect(validateDefinitionBody({ ...fullBody(typo) }).join(' ')).toContain('intentPack.extends');
  });
});

describe('an intent carries BEHAVIOR, not just a label', () => {
  const packWith = (extra: Partial<IntentDef>): StoredIntentPack => ({
    extends: 'default',
    intents: [{ ...OWN_PACK.intents[0], ...extra } as IntentDef],
  });

  it('a deployment-declared intent can be ROUTED, which the closed key space forbade', () => {
    // A route is keyed by the intent it serves (ADR-064 decision 1), so a deployment's own intent routes by its key.
    const strategy = [{
      intent: 'financial_metric', label: 'x', primaryModel: 'opus' as never,
      fallbackModel: 'haiku' as never, rationale: 'test',
    }];
    const resolved = resolveModelForIntent(
      'financial_metric', 'premium', getModelCatalog('us-east-1', '111122223333'),
      strategy as never, { selected: ['haiku', 'opus'], default: 'haiku' },
    );
    expect(resolved.resolvedFromStrategy).toBe(true);
    expect(resolved.primaryModelKey).toBe('opus');
  });

  it('an intent with NO route still falls to the profile default, unchanged', () => {
    // Opening the key space must not start force-routing unrecognized intents somewhere.
    const resolved = resolveModelForIntent(
      'financial_metric', 'premium', getModelCatalog('us-east-1', '111122223333'),
      [] as never, { selected: ['haiku', 'opus'], default: 'haiku' },
    );
    expect(resolved.resolvedFromStrategy).toBe(false);
  });

  it('the universal intents answer through the general route; a deployment intent does not', () => {
    for (const universal of ['general', 'greeting', 'acknowledgment']) expect(answersThroughGeneral(universal)).toBe(true);
    expect(answersThroughGeneral('financial_metric')).toBe(false);
  });

  it('per-intent instructions reach the answering model, and are bounded', () => {
    expect(instructionsForIntent('financial_metric', resolveStoredPack(packWith({ instructions: 'Cite the source.' }))))
      .toBe('Cite the source.');
    // Absent ⇒ undefined, so a pack that sets none reads exactly as before.
    expect(instructionsForIntent('financial_metric', resolveStoredPack(OWN_PACK))).toBeUndefined();
    const tooLong = packWith({ instructions: 'x'.repeat(MAX_INTENT_INSTRUCTIONS + 1) });
    expect(validateDefinitionBody({ ...fullBody(tooLong) }).join(' ')).toContain('over the');
  });

  it('per-intent tools NARROW the profile allowlist and never widen it', () => {
    const two = ALL_TOOL_NAMES.slice(0, 2);
    const pack = resolveStoredPack(packWith({ tools: [two[0]] }));
    expect(toolsForIntent('financial_metric', two, pack)).toEqual([two[0]]);
    // A tool the profile forbids is intersected away rather than granted.
    expect(toolsForIntent('financial_metric', [two[1]], pack)).toEqual([]);
    // An intent declaring none inherits the profile's list untouched.
    expect(toolsForIntent('financial_metric', two, resolveStoredPack(OWN_PACK))).toEqual(two);
  });

  it('refuses a version whose intent names a tool the profile does not allow', () => {
    const body = { ...fullBody(packWith({ tools: [ALL_TOOL_NAMES[1]] })), tools: [ALL_TOOL_NAMES[0]] };
    const errs = validateDefinitionBody(body).join(' ');
    expect(errs).toContain('does not allow');
    expect(errs).toContain('never widen');
  });

  it('a version-declared TASK_MULTI_STEP intent actually delivers as a task', () => {
    // The taxonomy rode the version while the one field deciding how a turn is DELIVERED was still
    // read from the deployment pack, which has never heard of a version-only key. So the intent
    // resolved to PLACEHOLDER_UPDATE, never reached the task branch, and no `machines` entry could
    // rescue it - the workflow half of "an intent carries behavior" was unreachable from a version.
    const pack = resolveStoredPack({
      extends: 'default',
      intents: [{
        key: 'incident_review',
        description: 'A multi-step incident review.',
        keywords: ['incident review'],
        delivery: 'TASK_MULTI_STEP',
      }],
    });
    expect(selectDeliveryOption('incident_review', false, pack)).toBe(DeliveryOption.TASK_MULTI_STEP);
    // Without the pack it is invisible, which is the previous behavior and the bug.
    expect(selectDeliveryOption('incident_review', false)).toBe(DeliveryOption.PLACEHOLDER_UPDATE);
  });

  it('bounds the WHOLE pack, not just one intent', () => {
    // `MAX_INTENT_INSTRUCTIONS` bounds ONE intent and nothing bounded how many a pack declares. Ten
    // well-instructed intents reach 40KB, which stores fine and then fails only when someone EXPORTS
    // it - the worst moment to find out, and the reason `MAX_MANIFEST_BYTES` can now be derived.
    const many: StoredIntentPack = {
      extends: 'default',
      intents: Array.from({ length: 12 }, (_, i) => ({
        key: `bulky_${i}`,
        description: 'x',
        keywords: ['x'],
        delivery: 'PLACEHOLDER_UPDATE' as const,
        instructions: 'y'.repeat(MAX_INTENT_INSTRUCTIONS),
      })),
    };
    // Every individual intent is legal...
    for (const d of many.intents) expect(d.instructions!.length).toBeLessThanOrEqual(MAX_INTENT_INSTRUCTIONS);
    // ...and the pack is not.
    const errs = validateDefinitionBody({ ...fullBody(many) }).join(' ');
    expect(errs).toContain('over the');
    expect(errs).toContain('byte limit');
  });

  it('refuses an unknown tool name on an intent', () => {
    const errs = validateDefinitionBody({ ...fullBody(packWith({ tools: ['not_a_real_tool'] })) }).join(' ');
    expect(errs).toContain('unknown tool');
  });
});

describe('onboarding is per assistant, not per deployment', () => {
  const intake = {
    greeting: 'Welcome to the leadership assistant.',
    fields: [{ key: 'focus', prompt: 'What should reports cover?', required: false }],
  };

  it('the three shipped intakes differ, because what each assistant asks differs', () => {
    // The reason this rides the version at all. One deployment-wide intake made every assistant
    // introduce itself identically and then behave completely differently.
    const greetings = [BASIC_ONBOARDING, STANDARD_ONBOARDING, PREMIUM_ONBOARDING].map((o) => o.greeting);
    expect(new Set(greetings).size).toBe(3);
    // The FIELDS differ too, which is the part that changes what the assistant learns.
    const fieldKeys = [BASIC_ONBOARDING, STANDARD_ONBOARDING, PREMIUM_ONBOARDING]
      .map((o) => o.fields.map((f) => f.key).join(','));
    expect(new Set(fieldKeys).size).toBe(3);
    // WHAT EACH CAN REACH IS NO LONGER HERE. It moved to the advertised intents and the authored
    // boundary line (`an-assistant-says-what-it-does.test.ts`), so the greeting cannot drift from the
    // pack by restating it. Asserting it here again would rebuild the second copy this removed.
  });

  it('rides the version: hashed, carried by bodyFrom, and resolved', () => {
    const withIntake = { ...fullBody(), onboarding: intake };
    expect(bodyFrom(withIntake).onboarding).toEqual(intake);
    // Hashed, so an onboarding-only edit is a NEW configId rather than being attributed to the
    // version it replaced - the `copy` defect, on the assistant's first impression.
    expect(profileDefinitionConfigId(withIntake)).not.toBe(profileDefinitionConfigId(fullBody()));
    const def: ProfileDefinition = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      ...withIntake,
      configId: profileDefinitionConfigId(withIntake),
    };
    expect(resolveFromDefinition(def, 'analyst').onboarding).toEqual(intake);
  });

  it('a version carrying none resolves undefined, so the deployment seam still answers', () => {
    const { onboarding: _none, ...noIntake } = fullBody();
    const def: ProfileDefinition = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      ...noIntake,
      configId: profileDefinitionConfigId(noIntake),
    };
    expect(resolveFromDefinition(def, 'analyst').onboarding).toBeUndefined();
  });

  it('refuses an intake that would store as DISABLED rather than run', () => {
    // `parseIntakeConfig` returns null for anything it cannot make sense of, which on the read path
    // means "onboarding disabled". Storing that silently would show the operator their own text back
    // while the assistant greeted nobody.
    const errs = validateDefinitionBody({ ...fullBody(), onboarding: { greeting: '', fields: [] } as never });
    expect(errs.join(' ')).toContain('onboarding is not a valid intake config');
  });

  it('every shipped intake is storable on a version', () => {
    for (const o of [BASIC_ONBOARDING, STANDARD_ONBOARDING, PREMIUM_ONBOARDING]) {
      expect(validateDefinitionBody({ ...fullBody(), onboarding: o })).toEqual([]);
    }
  });
});

describe('the warm-container cache keeps every resolved field', () => {
  it('a cached resolution is field-for-field the same as the first one', async () => {
    // THE BUG THIS EXISTS FOR. The cache-hit return and the `cache.set` each listed every field by
    // hand, so `intentPack` and `onboarding` were dropped: the first turn after a TTL miss saw the
    // version's taxonomy and intake, and every cached turn after it fell back to the deployment seam.
    // Thirty seconds of correct behavior followed by wrong behavior that looked identical.
    //
    // Asserted by COMPARING THE TWO RESOLUTIONS rather than naming fields, so the next field added to
    // the resolved shape is covered without anyone remembering to extend this.
    const body = fullBody(OWN_PACK);
    const def: ProfileDefinition = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      ...body,
      configId: profileDefinitionConfigId(body),
    };
    const ssm = { send: jest.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(def) } }) };
    __clearActiveProfileCache();
    const first = await resolveActiveProfile('analyst', { ssm: ssm as never, ssmRoot: '/t' });
    const second = await resolveActiveProfile('analyst', { ssm: ssm as never, ssmRoot: '/t' });
    // The second call is a cache hit - the SSM read happened once.
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // And the fields this session added are actually present, so the comparison is not two empties.
    expect(second.intentPack).toBeDefined();
    expect(second.onboarding).toBeDefined();
  });
});

describe('a pointer is never served unhydrated', () => {
  it('refuses a definition whose pack pointer was not followed', () => {
    // This one hides better than the persona equivalent. `intentPack: undefined` is a LEGITIMATE state
    // meaning "inherit the deployment taxonomy", so an unhydrated pointer would classify every turn
    // against the wrong pack while reporting this version's configId, and look entirely healthy.
    const body = fullBody();
    const def = {
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'analyst',
      ...body,
      configId: profileDefinitionConfigId(body),
      intentPackRef: { key: 'profiles/standard/abc/intentPack', configId: 'abc' },
    } as ProfileDefinition;
    expect(() => resolveFromDefinition(def, 'analyst')).toThrow(/without hydrating its intent-pack pointer/);
  });
});

describe('the stored form and the served form are different shapes', () => {
  it('resolveStoredPack inherits only what was not overridden', () => {
    const override: StoredIntentPack = {
      extends: 'default',
      intents: [{
        key: DEFAULT_INTENT_PACK.intents[0].key,
        description: 'Overridden.',
        keywords: ['z'],
        delivery: 'PLACEHOLDER_UPDATE',
      }],
    };
    const resolved = resolveStoredPack(override);
    const matching = resolved.intents.filter((d) => d.key === DEFAULT_INTENT_PACK.intents[0].key);
    expect(matching).toHaveLength(1);
    expect(matching[0].description).toBe('Overridden.');
  });

  it('a pack without `extends` REPLACES, so a deployment can drop a default intent', () => {
    const resolved = resolveStoredPack({ intents: OWN_PACK.intents });
    expect(resolved.intents.map((d) => d.key)).toEqual(['financial_metric']);
  });
});
