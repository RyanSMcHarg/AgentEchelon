/**
 * RATCHET: a profile VERSION carries nothing a deploy owns.
 *
 * Six fields sat in the versioned profile definition, in its validation, in its hash, in the export
 * manifest and in the admin console's draft editor, and NONE of them changed a running turn:
 *
 *   classifierMode, rateLimitPerHour  - read from the COMPILED deployment
 *     config (`backend/lib/config/profiles.ts`, via `defaultProfileRegistry`) at every site that reads
 *     them at all;
 *   battleEligible  - split into a classification capability and a runtime setting, and deleted from
 *     the assistant descriptor (ADR-049); still guarded because stored versions carry the key;
 *   taskSupport  - read by NOTHING, and now deleted outright (ADR-049) rather than relocated; still
 *     guarded here because a version stored before the deletion carries the key;
 *   timeoutSeconds  - a Lambda property from `ProfileTopology`, which a running function cannot change;
 *   models.complex  - validated on the write path and displayed in the console, read by nothing.
 *
 * WHY A RATCHET AND NOT A ONE-OFF REMOVAL. The failure is not that somebody wrote a field; it is that
 * a field can sit in a versioned artifact for as long as it likes without anything noticing that no
 * turn reads it. An operator who publishes a version setting `battleEligible: true` gets a new version,
 * a new configId, a green activation and `/battle` still refused - and every layer reports success. The
 * next person to unify the two shapes will reach for exactly these names again, because they ARE real
 * profile settings; they just belong to the deploy.
 *
 * WHAT THIS GUARD DOES NOT SAY. It is not a claim that these settings are gone. They are unchanged in
 * `lib/config/profiles.ts` and in the stack topology, which is where a deploy changes them. This file
 * only refuses to let them back into the artifact that publishes without one.
 *
 * HOW TO USE IT:
 *  - Adding a field to a version? It must have a runtime reader that takes it from the VERSION.
 *  - Genuinely making one of these live? Wire the reader first, then delete its line from DEPLOY_TIME
 *    and say in the commit which reader now consumes the resolved value.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  bodyFrom,
  buildDefinition,
  ensureModelsBundle,
  profileDefinitionConfigId,
  resolveFromDefinition,
  serializeSeedDefinition,
  validateDefinitionBody,
  PROFILE_DEFINITION_SCHEMA_VERSION,
  type ProfileDefinition,
  type ProfileDefinitionBody,
} from '../lambda/src/lib/active-profile';
import { defaultProfileRegistry } from '../lib/profile-registry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The body keys a version must not carry, each with the reader that owns it instead. The reason is
 * the entry: a name with no live reader named here is a name nobody can justify keeping out.
 */
const DEPLOY_TIME: Array<{ field: string; ownedBy: string }> = [
  { field: 'classifierMode', ownedBy: "router-agent-handler.ts, from profiles.profileFor(...).classifierMode" },
  // WHICH MESSAGE FLOW A CONVERSATION IS ROUTED BY IS NOT AN ASSISTANT'S BUSINESS: the channel flow is
  // deployment configuration, never a profile field.
  //
  // Unlike the rest of this list, these names are guarded BEFORE anybody writes them rather than after.
  // The reason they would be written is easy to sympathise with: an assistant's routing feels like part
  // of the assistant. It is not. The flow decides whether anybody in the conversation can be addressed
  // at all, it is associated at creation by the principal that created the conversation, and it belongs
  // to the conversation type - `messageFlow` in `lib/config/conversation-types.ts`, resolved through
  // `resolveMessageFlowKey`. An assistant that could edit it would be an assistant editing the room it
  // sits in, and a profile carries selections rather than references exactly so that scope cannot travel
  // through one.
  // `channelFlowArn` IS DELIBERATELY NOT ON THIS LIST, and leaving it off is the distinction that makes
  // the rule right rather than merely strict. The Profiles tab renders `selected.resolved.channelFlowArn`
  // as a read-only deep link to the deployed flow, which is a resolved DEPLOYMENT value and exactly the
  // sort of thing an operator should be able to see. The rule is that a version may not SET the flow, not
  // that the console may not show which one is deployed. Both names below are word-boundary matched, so
  // neither collides with that display.
  { field: 'messageFlow', ownedBy: 'conversation-types.ts, resolved per conversation by resolveMessageFlowKey' },
  { field: 'channelFlow', ownedBy: 'conversation-types.ts - the same field under the name a writer is likelier to reach for' },
  { field: 'timeoutSeconds', ownedBy: 'assistant-profile-stack.ts, as the async processor Lambda timeout from ProfileTopology' },
  // THE ONE ENTRY WITH NO OWNER, AND IT NO LONGER HAS A HOME EITHER. Its reason used to read "nothing
  // at runtime", which by this file's own rule ("a name with no live reader named here is a name
  // nobody can justify keeping out") was an argument for deleting the field rather than for guarding
  // it. It is now deleted from `AssistantProfile` (ADR-049). The entry stays because a version STORED
  // before that deletion still carries the key, and this is what keeps it out of a hash or a manifest.
  { field: 'taskSupport', ownedBy: 'nothing, anywhere: the field is deleted (ADR-049). Kept so a stored legacy version carrying it still normalizes away' },
  { field: 'rateLimitPerHour', ownedBy: 'router-agent-handler.ts and channel-flow-processor.ts, as rateLimit from profiles.profileFor(...)' },
  // SPLIT IN TWO AND GONE FROM THE ASSISTANT (ADR-049). It answered "can a duel run here" and "is
  // battle turned on" with one value, and the two disagreed: it was `true` for basic, whose stack
  // wires no battle plumbing. Capability is now `DeploymentClassification.battleCapable` (a deploy
  // fact, and the same field the stack builds from) and policy is a runtime classification-level
  // setting. Guarded here for the same reason as `taskSupport`: stored versions still carry the key.
  { field: 'battleEligible', ownedBy: 'nothing on an assistant: capability is classification battleCapable, policy is the runtime battle setting (ADR-049)' },
];

/** The same rule for the model bundle. `models.complex` had no reader at all. */
const DEPLOY_TIME_MODEL_KEYS: string[] = ['complex'];

/** A body carrying every banned field, as a stored LEGACY version would. */
function legacyBody(): Record<string, unknown> {
  return {
    modelKey: 'opus',
    models: { default: 'opus', classifier: 'default', complex: 'opus', byIntent: {} },
    tools: ['add_item'],
    classifierMode: 'keyword',
    timeoutSeconds: 3600,
    taskSupport: 'lightweight',
    rateLimitPerHour: 99999,
    battleEligible: true,
  };
}

describe('a profile version carries no deployment-time field', () => {
  it('bodyFrom drops every one of them, so none reaches a hash, a manifest or a turn', () => {
    const narrowed = bodyFrom(legacyBody() as Partial<ProfileDefinitionBody>) as unknown as Record<string, unknown>;
    for (const { field, ownedBy } of DEPLOY_TIME) {
      expect([field, narrowed[field], `owned by: ${ownedBy}`]).toEqual([field, undefined, `owned by: ${ownedBy}`]);
    }
    const models = (narrowed.models ?? {}) as Record<string, unknown>;
    for (const key of DEPLOY_TIME_MODEL_KEYS) expect([key, models[key]]).toEqual([key, undefined]);
  });

  it('the configId ignores them: a version differing only in a deploy-time field is the SAME version', () => {
    // The whole point of dropping them. While they were hashed, two versions with identical behavior
    // got two ids, and per-turn analytics attributed a turn to a "change" that changed nothing.
    const { classifierMode, timeoutSeconds, taskSupport, rateLimitPerHour, battleEligible, models, ...rest } = legacyBody();
    const { complex, ...cleanModels } = models as Record<string, unknown>;
    const clean = bodyFrom({ ...rest, models: cleanModels } as Partial<ProfileDefinitionBody>);
    const legacy = bodyFrom(legacyBody() as Partial<ProfileDefinitionBody>);
    expect(profileDefinitionConfigId(legacy)).toBe(profileDefinitionConfigId(clean));
  });

  it('validation TOLERATES a legacy version rather than failing it closed to the seed', () => {
    // A deployment upgrading into this change has stored versions that still carry these fields. If
    // validation rejected an unknown one, every such version would fail to resolve and the assistant
    // would silently answer as the compiled seed - losing its persona, tools and guardrail selection.
    expect(validateDefinitionBody(legacyBody() as Partial<ProfileDefinitionBody>)).toEqual([]);
    // And a body that omits them is complete: none of them is required any more.
    expect(validateDefinitionBody({ modelKey: 'opus' })).toEqual([]);
    // The retired image field is not a deployment-time field: it is refused by name, pointing at the route's
    // image part where an image model is chosen (ADR-064 decision 2).
    const withRetiredImage = { ...legacyBody(), models: { ...(legacyBody().models as object), image: 'stability_image_core' } };
    expect(validateDefinitionBody(withRetiredImage as Partial<ProfileDefinitionBody>))
      .toEqual(["models.image is retired; name the image model as models.byIntent['image_generation'].image.primary"]);
  });

  it('resolution serves the SEED value for each of them, never the version', () => {
    // A version cannot claim any of these: each resolves from the seed whatever the stored body says.
    const seed = defaultProfileRegistry.profileByName('advisor')!;
    const def = {
      ...buildDefinition('advisor', bodyFrom({ modelKey: 'opus' })),
      ...legacyBody(),
      schemaVersion: PROFILE_DEFINITION_SCHEMA_VERSION,
      profileName: 'advisor',
      battleEligible: false,
    } as unknown as ProfileDefinition;

    const { profile } = resolveFromDefinition(def, 'advisor');
    expect(profile.classifierMode).toBe(seed.classifierMode);
    expect(profile.timeoutSeconds).toBe(seed.timeoutSeconds);
    expect(profile.rateLimitPerHour).toBe(seed.rateLimitPerHour);
  });

  it('the seed definition writes none of them into version 1', () => {
    for (const name of ['concierge', 'analyst', 'advisor']) {
      const seeded = JSON.parse(serializeSeedDefinition(name)!) as Record<string, unknown>;
      for (const { field } of DEPLOY_TIME) expect([name, field, seeded[field]]).toEqual([name, field, undefined]);
      const models = (seeded.models ?? {}) as Record<string, unknown>;
      for (const key of DEPLOY_TIME_MODEL_KEYS) expect([name, key, models[key]]).toEqual([name, key, undefined]);
    }
  });

  it('the legacy-body backfill (export, clone) does not reinstate them', () => {
    const filled = ensureModelsBundle(bodyFrom({ modelKey: 'opus' })) as unknown as Record<string, unknown>;
    for (const { field } of DEPLOY_TIME) expect([field, filled[field]]).toEqual([field, undefined]);
    const models = (filled.models ?? {}) as Record<string, unknown>;
    for (const key of DEPLOY_TIME_MODEL_KEYS) expect([key, models[key]]).toEqual([key, undefined]);
  });
});

/**
 * The console half. The backend assertions above cannot see a select box: the editor wrote these
 * fields into a draft `patch`, the write path accepted the patch, and the operator was shown a control
 * for a setting publishing does not move. So the admin package's versioned-profile surfaces are
 * scanned for the names directly.
 */
const CONSOLE_FILES = [
  'frontend/packages/admin/src/services/profileService.ts',
  'frontend/packages/admin/src/components/admin/ProfilesTab.tsx',
];

/**
 * A COMMENT IS NOT A CONTROL, so comment lines are skipped. The whole failure this guards is an
 * operator being shown an editor for a setting publishing cannot move; inert prose explaining that it
 * is deploy-time is the opposite of that, and the removal comments have to be able to name the fields
 * they removed or nobody reading the file learns why they are missing.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/**
 * A LOCALE KEY IS NOT A FIELD READ, and since the console's copy moved into `en.json` the two look
 * identical to a word match. `<dt>Channel flow</dt>` was two words and matched nothing; localized it
 * became `translate('admin.profiles.channelFlow')`, and the key's camelCase spelling of its own label
 * contains `channelFlow`. The guard flagged a `<dt>` as an editor for a deploy-time field.
 *
 * This will recur for any forbidden name whose words appear in a label - `taskSupport`,
 * `battleEligible` and `classifierMode` all read as plausible headings - so the translator call is
 * stripped before matching rather than this one key being renamed around the guard. What still trips
 * it is the thing it cares about: a real read like `version.channelFlow` or a form bound to one.
 */
function withoutLocaleKeys(line: string): string {
  return line.replace(/\b(?:t|translate)\(\s*\[?\s*(['"`])[^'"`]*\1/g, 'LOCALE_KEY');
}

describe('the admin console offers no editor for a deployment-time field', () => {
  const names = [...DEPLOY_TIME.map((d) => d.field), ...DEPLOY_TIME_MODEL_KEYS];

  it('scans the console files it names (a scan of nothing passes vacuously)', () => {
    for (const rel of CONSOLE_FILES) expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
  });

  it('no versioned-profile surface in the console reads or edits one', () => {
    const offenders: string[] = [];
    for (const rel of CONSOLE_FILES) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        const code = withoutLocaleKeys(line);
        if (!names.some((n) => new RegExp(`\\b${n}\\b`).test(code))) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    if (offenders.length) {
      throw new Error(
        'The Profiles tab must not read or edit a deployment-time field on a profile VERSION.\n'
        + 'Publishing a version cannot change any of these, so a control for one tells the operator\n'
        + 'something the platform will not do. Each is owned elsewhere:\n'
        + DEPLOY_TIME.map((d) => `  ${d.field}: ${d.ownedBy}`).join('\n')
        + '\n  models.complex: no reader at all\n\n'
        + offenders.join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });
});
