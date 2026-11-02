/**
 * SPEC-PORTABLE-PROFILES P1 — the versioning lifecycle (§4).
 * create-version → edit-draft → validate → activate → rollback, all on SSM native versions + the
 * `active` label. Version immutability + fail-closed validation + no-redeploy rollback are the bar.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import {
  listProfile,
  createDraft,
  editDraft,
  validateDraft,
  activateDraft,
  activateExistingVersion,
  publishVariantVersion,
  getDraft,
  ProfileValidationError,
} from '../../lambda/src/lib/profile-lifecycle';
import {
  resolveActiveProfile, __clearActiveProfileCache, bodyFrom, profileDefinitionConfigId,
} from '../../lambda/src/lib/active-profile';
import { lookupProfileVersion } from '../../lambda/src/lib/profile-version-lookup';
import { SSM_STANDARD_TIER_MAX } from '../../lambda/src/lib/seed-profile-definitions';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { GetParameterCommand, PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const ACTOR = 'admin-sub-123';

beforeEach(() => __clearActiveProfileCache());

describe('profile lifecycle P1', () => {
  it('create → edit → validate → activate produces a served version; the base was never mutated', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'titan', tools: ['add_item'] }, ACTOR);
    const v = await validateDraft(client, ROOT, 'analyst', CATALOG);
    expect(v.errors).toEqual([]);
    const { version, configId } = await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    expect(version).toBe(1);

    __clearActiveProfileCache();
    const { profile, tools } = await resolveActiveProfile('analyst', { ssm: client, ssmRoot: ROOT });
    expect(profile.modelKey).toBe('titan'); // the activated version now serves
    expect(tools).toEqual(['add_item']);
    expect(profile.name).toBe('analyst'); // identity unchanged
    // The listing shows exactly one version, active.
    const listing = await listProfile(client, ROOT, 'analyst');
    expect(listing.activeVersion).toBe(1);
    expect(listing.versions).toHaveLength(1);
    expect(listing.versions[0].configId).toBe(configId);
  });

  it('ACTIVATION CONSUMES THE DRAFT, so the next edit starts from what is serving', async () => {
    // A draft left behind after activation was edited by whoever opened the profile next, because the
    // console offers a fresh clone only when no draft exists. A test persona travelled between two e2e
    // specs on dev this way, surviving the rollback that restored the served version.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { persona: 'FIXTURE-PERSONA' }, ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    expect(await getDraft(client, ROOT, 'analyst')).toBeNull();
    expect((await listProfile(client, ROOT, 'analyst')).hasDraft).toBe(false);
    // The promoted body is in the served history, not lost with the draft.
    __clearActiveProfileCache();
    expect((await resolveActiveProfile('analyst', { ssm: client, ssmRoot: ROOT })).persona).toBe('FIXTURE-PERSONA');
  });

  it('activation keeps a draft that changed after it was read, rather than discarding someone else\'s edit', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    // An edit lands between activation's read of the draft and its consume step.
    const send = client.send as jest.Mock;
    const real = send.getMockImplementation()!;
    let raced = false;
    send.mockImplementation(async (cmd: unknown) => {
      if (!raced && cmd?.constructor?.name === 'LabelParameterVersionCommand') {
        raced = true;
        const out = await real(cmd);
        await editDraft(client, ROOT, 'analyst', { persona: 'LATER-EDIT' }, ACTOR);
        return out;
      }
      return real(cmd);
    });
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    expect((await getDraft(client, ROOT, 'analyst'))?.persona).toBe('LATER-EDIT');
  });

  it('activate v2 then ROLLBACK to v1 — no redeploy, lossless (the P1 acceptance)', async () => {
    const { client } = fakeSsmStore();
    // v1 = opus
    await createDraft(client, ROOT, 'advisor', ACTOR);
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus' }, ACTOR);
    const v1 = await activateDraft(client, ROOT, 'advisor', CATALOG, ACTOR);
    // v2 = sonnet
    await createDraft(client, ROOT, 'advisor', ACTOR);
    await editDraft(client, ROOT, 'advisor', { modelKey: 'sonnet' }, ACTOR);
    const v2 = await activateDraft(client, ROOT, 'advisor', CATALOG, ACTOR);
    expect(v2.version).toBe(2);

    __clearActiveProfileCache();
    expect((await resolveActiveProfile('advisor', { ssm: client, ssmRoot: ROOT })).profile.modelKey).toBe('sonnet');

    // Rollback to v1 = re-label active onto the immutable prior version.
    const back = await activateExistingVersion(client, ROOT, 'advisor', v1.version, ACTOR);
    expect(back.version).toBe(1);
    __clearActiveProfileCache();
    expect((await resolveActiveProfile('advisor', { ssm: client, ssmRoot: ROOT })).profile.modelKey).toBe('opus');

    const listing = await listProfile(client, ROOT, 'advisor');
    expect(listing.activeVersion).toBe(1);
    expect(listing.versions.map((x) => x.version).sort()).toEqual([1, 2]); // both retained (immutable history)
  });

  it.each([
    ['classification', { classification: 'basic' }, /needs a deploy, because it changes IAM/],
    ['role', { role: 'ops' }, /needs a deploy, because it changes IAM/],
    ['reach', { grants: ['premium'] }, /needs a deploy, because it changes IAM/],
    ['an owner', { ownerTeam: 'ops' }, /changed through manage-ownership/],
  ])('edit-draft refuses %s by name, because a version cannot carry it, and writes nothing', async (_what, patch, message) => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'concierge', ACTOR);
    const before = await getDraft(client, ROOT, 'concierge');
    const edit = editDraft(client, ROOT, 'concierge', { modelKey: 'sonnet', ...patch } as never, ACTOR);
    await expect(edit).rejects.toBeInstanceOf(ProfileValidationError);
    await expect(editDraft(client, ROOT, 'concierge', patch as never, ACTOR)).rejects.toThrow(message);
    expect((await getDraft(client, ROOT, 'concierge'))!.configId).toBe(before!.configId);
  });

  it('edit-draft rejects an invalid body and never writes it', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'concierge', ACTOR);
    await expect(editDraft(client, ROOT, 'concierge', { tools: ['not_a_registered_tool'] }, ACTOR)).rejects.toBeInstanceOf(ProfileValidationError);
    // draft still valid (the bad edit was not persisted)
    const draft = await getDraft(client, ROOT, 'concierge');
    expect(draft!.tools).not.toContain('not_a_registered_tool');
  });

  it('activate is blocked by the §7 model-ARN boundary (modelKey outside the catalog)', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    // editDraft validates SHAPE only (a string modelKey passes); the catalog check is at validate/activate.
    await editDraft(client, ROOT, 'analyst', { modelKey: 'not-a-real-model' }, ACTOR);
    const v = await validateDraft(client, ROOT, 'analyst', CATALOG);
    expect(v.errors.some((e) => /not in the deployment's model catalog/.test(e))).toBe(true);
    await expect(activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR)).rejects.toBeInstanceOf(ProfileValidationError);
    // Nothing was activated; resolution still serves the seed.
    __clearActiveProfileCache();
    const { configId } = await resolveActiveProfile('analyst', { ssm: client, ssmRoot: ROOT });
    expect(configId).toBe('seed');
  });

  it('edit-draft ignores boundary keys — a hostile contextScope in the patch is dropped', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'concierge', ACTOR);
    await editDraft(client, ROOT, 'concierge', { modelKey: 'sonnet', contextScope: 'own-rank-and-above' } as never, ACTOR);
    const draft = await getDraft(client, ROOT, 'concierge');
    expect(draft!.modelKey).toBe('sonnet');
    expect((draft as unknown as Record<string, unknown>).contextScope).toBeUndefined(); // never stored in the body
  });

  it('edit-draft REFUSES an oversize persona with an actionable message, not an opaque AWS error', async () => {
    // THE DEFECT THIS EXISTS FOR. The draft parameter carries the same 4096-character Standard-tier
    // limit as the active one, so a persona between MAX_PERSONA_LENGTH (20000) and that limit cannot
    // be saved at all. The size check lived only in validate, which this path never reaches: the
    // PutParameter threw an AWS ValidationException, the route reported a bare 500 'Internal error',
    // and the operator was told nothing about the persona, the profile, or the size.
    //
    // Worse for anyone diagnosing it, the draft kept its PREVIOUS content, so a follow-up /validate
    // reported `valid: true` — the API affirming a definition the operator had never managed to save.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);

    const oversize = 'x'.repeat(6000);
    await expect(
      editDraft(client, ROOT, 'analyst', { persona: oversize }, ACTOR),
    ).rejects.toThrow(ProfileValidationError);

    // The message has to be actionable: name the limit AND the room actually left for a persona.
    let message = '';
    try {
      await editDraft(client, ROOT, 'analyst', { persona: oversize }, ACTOR);
    } catch (err) {
      message = (err as ProfileValidationError).errors.join(' ');
    }
    expect(message).toMatch(/SSM Standard-tier limit/i);
    expect(message).toMatch(/leaving room for a persona of about \d+ characters/);

    // And the rejected edit was NOT persisted — the draft still holds the pre-edit body.
    const draft = await getDraft(client, ROOT, 'analyst');
    expect(draft?.persona ?? '').not.toContain(oversize);
  });

  it('counts the stored ENVELOPE, so a persona sized into the gap cannot slip past', async () => {
    // THE DEFECT THIS EXISTS FOR. The guard measured `bodyFrom(def)` while the write stores
    // `JSON.stringify(def)`. bodyFrom strips schemaVersion, profileName and configId - about 70
    // characters that count against the same 4096 limit. A persona sized into that gap passed the
    // guard and still died at PutParameter with the opaque AWS error the guard exists to replace,
    // which is the exact failure it was added to prevent.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);

    // Find a persona that fits the BODY but not the stored definition, by construction: start from a
    // body that just fits and grow until the enveloped form crosses the limit.
    const draft = await getDraft(client, ROOT, 'analyst');
    const envelope = JSON.stringify(draft).length - JSON.stringify(bodyFrom(draft!)).length;
    // A zero envelope would make this test vacuous — the gap it targets would not exist.
    expect(envelope).toBeGreaterThan(0);

    const bodyOnlyOverhead = JSON.stringify({ ...bodyFrom(draft!), persona: '' }).length;
    // Sits under the limit as a bare body, over it once the envelope is included.
    const inTheGap = 'z'.repeat(SSM_STANDARD_TIER_MAX - bodyOnlyOverhead - Math.floor(envelope / 2));

    await expect(
      editDraft(client, ROOT, 'analyst', { persona: inTheGap }, ACTOR),
    ).rejects.toThrow(ProfileValidationError);

    // And the draft is unchanged, so the refusal did not half-apply.
    const after = await getDraft(client, ROOT, 'analyst');
    expect(after?.persona ?? '').not.toContain(inTheGap);
  });

  it('edit-draft ACCEPTS a persona that fits, so the guard is not simply refusing everything', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    const fits = 'y'.repeat(200);
    await editDraft(client, ROOT, 'analyst', { persona: fits }, ACTOR);
    const draft = await getDraft(client, ROOT, 'analyst');
    expect(draft!.persona).toBe(fits);
  });


  it('CLEARS a field when the patch sends null, so a renamed assistant can inherit again', async () => {
    // A patch is a MERGE, so an omitted key keeps what the draft had. That left no way to remove a
    // value: an assistant renamed once could never be returned to its configured name, because the
    // console's cleared field sent no key and the draft kept the old one. Absent and empty already
    // mean different things here (inherit vs a name nobody can address), so clearing gets the third
    // spelling - the one JSON Merge Patch uses.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { displayName: 'Research Desk' }, ACTOR);
    expect((await getDraft(client, ROOT, 'analyst'))!.displayName).toBe('Research Desk');

    // Omitting it KEEPS it - the behavior that made clearing impossible, pinned so the two are
    // distinguishable rather than accidentally the same.
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    expect((await getDraft(client, ROOT, 'analyst'))!.displayName).toBe('Research Desk');

    await editDraft(client, ROOT, 'analyst', { displayName: null } as never, ACTOR);
    expect((await getDraft(client, ROOT, 'analyst'))!.displayName).toBeUndefined();
  });

  it('ACTIVATION HANDS THE NAME TO ITS CALLER, which is how it reaches the identity', async () => {
    // The integration point nothing covered. Every piece of the rename was tested in isolation and
    // green - the field validated, the resolver resolved, the applier applied - while the stored body
    // silently dropped the name in `bodyFrom`, so activation returned undefined and the identity was
    // never asked to change. A round trip through the real store is the only thing that shows it.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { displayName: 'Research Desk' }, ACTOR);
    const activated = await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    expect(activated.displayName).toBe('Research Desk');

    // And a version that names nothing reports nothing, which the caller reads as 'inherit'.
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { displayName: null } as never, ACTOR);
    const cleared = await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    expect(cleared.displayName).toBeUndefined();
  });

  it('does NOT refuse an edit for an unreachable route the version ALREADY HAD', async () => {
    // MEASURED ON A LIVE DEPLOYMENT. The rule refuses a byIntent route the deployment's pack cannot
    // classify - correct for a route someone is ADDING, and applied to the whole merged body it made
    // a profile permanently uneditable: a deployment whose pack narrowed after seeding carries those
    // routes on every version, so every later edit was refused for something nobody wrote, including
    // an edit that would have removed them. Renaming an assistant was blocked by it.
    const { client, store } = fakeSsmStore();
    // A deployment pack that declares a NARROWER taxonomy than the seeded routes.
    store.set(`${ROOT}/assistant/standard/assistant-intent-pack`, [
      { version: 1, value: JSON.stringify({ intents: [{ key: 'general' }] }), labels: new Set<string>() },
    ]);

    await createDraft(client, ROOT, 'analyst', ACTOR);
    // An ordinary edit that touches something else entirely must still be accepted.
    await editDraft(client, ROOT, 'analyst', { displayName: 'Research Desk' }, ACTOR);
    const v = await validateDraft(client, ROOT, 'analyst', CATALOG);
    expect(v.errors.filter((e) => e.includes('would never fire'))).toEqual([]);
  });

  it('refuses a workflow selection naming a graph that does not exist', async () => {
    // A selection is narrowing, so the failure mode is not a security one - it is a workflow the
    // assistant can never open, configured and doing nothing. Same shape as a byIntent route to an
    // intent nothing classifies to, and refused for the same reason: it reads as set up and is not.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { workflows: ['report_generation', 'not_a_workflow'] } as never, ACTOR);
    const v = await validateDraft(client, ROOT, 'analyst', CATALOG);
    expect(v.errors.join(' ')).toMatch(/not_a_workflow.*names no workflow/);
    // And it names what IS available, so the operator can fix it without reading the source.
    expect(v.errors.join(' ')).toMatch(/available: .*report_generation/);
  });

  it('accepts a selection of workflows that exist, and accepts none at all', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { workflows: ['report_generation'] } as never, ACTOR);
    const picked = await validateDraft(client, ROOT, 'analyst', CATALOG);
    expect(picked.errors.filter((e) => e.includes('workflow'))).toEqual([]);

    // Absent ⇒ every available workflow. That is the pre-existing behaviour and must stay the default,
    // or adding the field would silently narrow every assistant that never sets it.
    await editDraft(client, ROOT, 'analyst', { workflows: null } as never, ACTOR);
    const all = await validateDraft(client, ROOT, 'analyst', CATALOG);
    expect(all.errors.filter((e) => e.includes('workflow'))).toEqual([]);
  });

  it('refuses a version that tries to DEFINE a workflow, and says where they live', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await expect(editDraft(client, ROOT, 'analyst', {
      machines: { report_generation: { initial: 'a', states: { a: { transitions: [] } } } },
    } as never, ACTOR)).rejects.toBeInstanceOf(ProfileValidationError);
  });
  it('lists profiles with no versions as seed-only (activeVersion null, no draft)', async () => {
    const { client } = fakeSsmStore();
    const listing = await listProfile(client, ROOT, 'advisor');
    expect(listing.activeVersion).toBeNull();
    expect(listing.versions).toEqual([]);
    expect(listing.hasDraft).toBe(false);
  });
});

/**
 * A VARIANT'S VERSION: the live occupant's profile plus the experiment's delta.
 *
 * An experiment compares two implementations of ONE assistant. A variant carrying no `profileRef`
 * can only say `modelKey` and `imageGenModelKey`, so the softer half of an assistant - its persona,
 * its tools, its guardrail - was untestable in practice even though the runtime has always been
 * able to serve a whole definition through `profileRef`. What was missing was the way to AUTHOR one.
 */
/** The standard classification's primary role: its live assistant and the alt that challenges it (ADR-050). */
const PRIMARY_ROLE = { baseProfile: 'analyst', targetProfile: 'alt-primary-standard' };

describe('publishVariantVersion (an experiment derives a candidate from what is live)', () => {
  /** Which duel side the derivation is for - stamped onto the candidate as `derivedFrom`. */
  const PROV = { experimentId: 'exp-battle-1', variantId: 'treatment' };

  it('copies the live version, applies the delta, and does NOT activate it', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet', tools: ['add_item'] }, ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    const derived = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { modelKey: 'titan' }, CATALOG, ACTOR, PROV,
    );

    // PUBLISHED UNDER THE ALT'S OWN NAME (ADR-050), never into the live occupant's history: the live
    // history holds only what served, and the alt's history is the record of what was tested.
    expect(derived.profileName).toBe('alt-primary-standard');
    expect(derived.version).toBeGreaterThan(0);

    // THE LIVE OCCUPANT IS UNTOUCHED. A candidate that activated itself would change the assistant
    // every ordinary turn resolves, which is the opposite of running an experiment against it.
    __clearActiveProfileCache();
    const live = await resolveActiveProfile('analyst', { ssm: client, ssmRoot: ROOT });
    expect(live.profile.modelKey).toBe('sonnet');

    // ...and the candidate inherited what the delta did not mention: the live tools, under the alt.
    const stored = await lookupProfileVersion(client, ROOT, { profileName: 'alt-primary-standard', version: derived.version });
    expect(stored?.tools).toEqual(['add_item']);
    expect(stored?.modelKey).toBe('titan');
  });

  it('REFUSES a patch that changes the intents, rather than inheriting them silently', async () => {
    // THE ONE THING A VARIANT MAY NOT CHANGE. `intentPack` decides how turns are
    // routed, so a side that served different use cases would classify differently and produce a
    // score the other side cannot be compared against - two products in one duel, reported as a
    // winner and a loser.
    //
    // REFUSED, NOT DROPPED. Silently inheriting would let an operator believe they had changed the
    // taxonomy and read the result as though they had, which is the quieter failure and the worse one.
    const { client } = fakeSsmStore();
    await expect(
      publishVariantVersion(
        client, ROOT, PRIMARY_ROLE,
        { intentPack: { version: 1, intents: {} } as never },
        CATALOG, ACTOR, PROV,
      ),
    ).rejects.toThrow(/may not change intentPack/);
  });

  it('applies the SAME validation an operator edit gets, so a variant is not a privileged writer', async () => {
    // A body the editor would refuse must not reach the runtime through the experiment door. A
    // second, laxer path for derived versions is how a deployment ends up serving a duel side its
    // own console would not have let anyone author.
    const { client } = fakeSsmStore();
    await expect(
      publishVariantVersion(
        client, ROOT, PRIMARY_ROLE, { modelKey: 'not-in-the-catalog' as never }, CATALOG, ACTOR, PROV,
      ),
    ).rejects.toBeInstanceOf(ProfileValidationError);
  });

  it('SAYS WHAT PRODUCED IT, and that provenance does not change the version identity', async () => {
    // A candidate sits in the same version history as versions that really served, so without this it
    // reads exactly like a prior live state - an invitation to roll back into something that was never
    // live. `derivedFrom` is what lets the Profiles tab tell the two apart.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    const baseVersion = (await listProfile(client, ROOT, 'analyst')).activeVersion;

    const derived = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { modelKey: 'titan' }, CATALOG, ACTOR, PROV,
    );

    const stored = await lookupProfileVersion(client, ROOT, { profileName: 'alt-primary-standard', version: derived.version });
    expect(stored?.derivedFrom).toEqual({ ...PROV, baseProfile: 'analyst', baseVersion });

    // ENVELOPE, NOT BODY. The `configId` is the body's own fingerprint and the arm path compares it to
    // decide whether it already holds the candidate it needs - so provenance must not reach the hash,
    // or every arm would look like a new body and the reuse rule below could never fire.
    expect(profileDefinitionConfigId(bodyFrom(stored!))).toBe(derived.configId);
  });

  it('REUSES the pinned version when the derivation still says the same thing (no version per arm)', async () => {
    // The (experiment, variant) reuse rule. Re-arming an unchanged experiment
    // against an unchanged occupant must not mint a version each time.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    const first = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { modelKey: 'titan' }, CATALOG, ACTOR, PROV,
    );
    const second = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { modelKey: 'titan' }, CATALOG, ACTOR, PROV, first.version,
    );
    expect(second.reused).toBe(true);
    expect(second.version).toBe(first.version);

    // ...AND IT IS NOT A BLIND REUSE. Reuse is decided on the body's fingerprint, so a derivation that
    // now says something ELSE publishes rather than silently measuring against a base the operator has
    // already replaced.
    const changed = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { modelKey: 'haiku' }, CATALOG, ACTOR, PROV, first.version,
    );
    expect(changed.reused).toBe(false);
    expect(changed.version).not.toBe(first.version);
  });

  it('REFUSES a selection this deployment cannot resolve, the same as an operator edit would', async () => {
    // The docstring claims parity with an operator's own edit, and it did not have it: the selection
    // checks were missing, so a variant could name a guardrail the deployment does not publish. The
    // candidate would publish, the duel side would run, the resolver would fall back to the default,
    // and the experiment would report a winner measured under a guardrail its version says it is not
    // getting. A laxer path for experiment-derived versions is exactly what must not exist.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    const noGuardrails = async () => [] as Array<{ key: string; guardrailId: string }>;
    await expect(
      publishVariantVersion(
        client, ROOT, PRIMARY_ROLE, { guardrailId: 'strict' } as never, CATALOG, ACTOR, PROV,
        undefined, undefined, noGuardrails,
      ),
    ).rejects.toBeInstanceOf(ProfileValidationError);
  });
});

describe("a candidate is published under its own role's alt and nowhere else", () => {
  const PROV = { experimentId: 'exp-battle-2', variantId: 'treatment' };
  it("refuses any target but the alt of the base's own role, the base itself included", async () => {
    const { client } = fakeSsmStore();
    for (const targetProfile of ['analyst', 'advisor', 'alt-primary-premium', 'alt-ops-premium', 'something-else']) {
      await expect(publishVariantVersion(
        client, ROOT, { baseProfile: 'analyst', targetProfile }, { modelKey: 'titan' }, CATALOG, ACTOR, PROV,
      )).rejects.toThrow("published under its role's alt (alt-primary-standard), not");
    }
  });
});

describe('nothing is published under the live name, and a candidate changes only what its recipe says (§3.5)', () => {
  const PROV = { experimentId: 'exp-9', variantId: 'treatment' };

  it("an intent recipe changes one route's primary and keeps that route's fallback and every other route", async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    __clearActiveProfileCache();
    const base = (await resolveActiveProfile('analyst', { ssm: client, ssmRoot: ROOT })).models;
    const route = Object.keys(base?.byIntent ?? {})[0];
    const r = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { models: { byIntent: { [route]: { primary: 'sonnet' } } } } as never, CATALOG, ACTOR, PROV,
    );
    const pinned = await lookupProfileVersion(client, ROOT, { profileName: 'alt-primary-standard', version: r.version });
    expect(pinned?.models?.byIntent).toEqual({ ...base?.byIntent, [route]: { ...base?.byIntent?.[route], primary: 'sonnet' } });
    expect(pinned?.models?.default).toBe(base?.default);
  });

  it("an image recipe naming the base's image fallback serves that model alone, and the candidate validates", async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'advisor', ACTOR);
    await activateDraft(client, ROOT, 'advisor', CATALOG, ACTOR);
    __clearActiveProfileCache();
    const base = (await resolveActiveProfile('advisor', { ssm: client, ssmRoot: ROOT })).models;
    const baseImage = (base?.byIntent?.image_generation as { image?: { primary?: string; fallback?: string } } | undefined)?.image;
    expect(baseImage).toEqual({ primary: 'stability_image_core', fallback: 'stability_image_ultra' });
    const ALT = { baseProfile: 'advisor', targetProfile: 'alt-primary-premium' };
    const r = await publishVariantVersion(
      client, ROOT, ALT, { models: { byIntent: { image_generation: { image: { primary: 'stability_image_ultra' } } } } } as never, CATALOG, ACTOR, PROV,
    );
    const pinned = await lookupProfileVersion(client, ROOT, { profileName: 'alt-primary-premium', version: r.version });
    expect((pinned?.models?.byIntent?.image_generation as { image?: unknown }).image).toEqual({ primary: 'stability_image_ultra' });
    // A recipe naming a third model keeps the base's fallback.
    const third = await publishVariantVersion(
      client, ROOT, ALT, { models: { byIntent: { image_generation: { image: { primary: 'nova_canvas' } } } } } as never, CATALOG, ACTOR, { ...PROV, variantId: 'third' },
    );
    const thirdPinned = await lookupProfileVersion(client, ROOT, { profileName: 'alt-primary-premium', version: third.version });
    expect((thirdPinned?.models?.byIntent?.image_generation as { image?: unknown }).image).toEqual({ primary: 'nova_canvas', fallback: 'stability_image_ultra' });
  });

  it('serves an image model hosted outside AWS exactly where the classification selects it, with no version switch', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'advisor', ACTOR);
    await activateDraft(client, ROOT, 'advisor', CATALOG, ACTOR);
    const ALT = { baseProfile: 'advisor', targetProfile: 'alt-primary-premium' };
    // The premium classification selects it, so a candidate may use it.
    await expect(publishVariantVersion(client, ROOT, ALT, { models: { byIntent: { image_generation: { image: { primary: 'openai_gpt_image_1' } } } } } as never, CATALOG, ACTOR, PROV))
      .resolves.toMatchObject({ profileName: 'alt-primary-premium' });
    // The standard classification does not, so neither a candidate nor the editor's own path may.
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    await expect(publishVariantVersion(client, ROOT, PRIMARY_ROLE, { models: { byIntent: { image_generation: { image: { primary: 'openai_gpt_image_1' } } } } } as never, CATALOG, ACTOR, PROV))
      .rejects.toThrow(/not selected by the standard classification/);
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await expect(editDraft(client, ROOT, 'analyst', { models: { byIntent: { image_generation: { image: { primary: 'fal_flux_pro_1_1' } } } } } as never, ACTOR)).resolves.toBeTruthy();
    await expect(activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR)).rejects.toThrow(/not selected by the standard classification/);
  });
});

describe("the live assistant's history holds only what served or was promoted", () => {
  const PROV = { experimentId: 'exp-battle-9', variantId: 'control' };

  it('a derived candidate is refused as a rollback target, and the refusal names the Promote action', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    const activated = await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    const candidate = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { modelKey: 'titan', systemPromptAddendum: 'be rigorous' }, CATALOG, ACTOR, PROV,
    );
    // The live assistant still serves what it served, and its history gained nothing.
    expect((await listProfile(client, ROOT, 'analyst')).versions.map((v) => v.version)).toEqual([activated.version]);
    const listing = await listProfile(client, ROOT, 'alt-primary-standard');
    expect(listing.versions[0]).toMatchObject({ derivedFrom: { experimentId: 'exp-battle-9', variantId: 'control', baseProfile: 'analyst' } });
    await expect(activateExistingVersion(client, ROOT, 'alt-primary-standard', candidate.version, ACTOR)).rejects.toThrow(/Promote action/);
  });
  it('a delta naming one model keeps the base bundle\'s others (a classifier swap keeps the base model)', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    const r = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { models: { classifier: 'haiku' } as never }, CATALOG, ACTOR, PROV,
    );
    const pinned = await lookupProfileVersion(client, ROOT, { profileName: 'alt-primary-standard', version: r.version });
    expect(pinned?.models?.classifier).toBe('haiku');
    expect(pinned?.models?.default).toBe('sonnet');
    expect(pinned?.models?.byIntent).toBeDefined();
  });
});

describe('a derived candidate cannot become live by a label move', () => {
  const PROV = { experimentId: 'exp-battle-9', variantId: 'treatment' };

  it("the candidate never enters the live occupant's history, so no rollback there can reach it", async () => {
    // A candidate in the live history would read exactly like a prior live state, and rolling "back"
    // into it would serve a room a version nobody approved. Publishing it under the alt keeps the live
    // history to what served (ADR-050).
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    const activated = await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    const candidate = await publishVariantVersion(
      client, ROOT, PRIMARY_ROLE, { modelKey: 'titan' }, CATALOG, ACTOR, PROV,
    );
    expect(candidate.profileName).toBe('alt-primary-standard');
    const liveListing = await listProfile(client, ROOT, 'analyst');
    expect(liveListing.activeVersion).toBe(activated.version);
    expect(await lookupProfileVersion(client, ROOT, { profileName: 'analyst', version: activated.version + 1 })).toBeNull();

    // AND THE LIVE OCCUPANT IS UNTOUCHED, which is the property the refusal exists to protect.
    __clearActiveProfileCache();
    const live = await resolveActiveProfile('analyst', { ssm: client, ssmRoot: ROOT });
    expect(live.profile.modelKey).toBe('sonnet');
  });

  it('still allows an ORDINARY rollback, so the refusal is not simply blocking everything', async () => {
    // The negative control. Without it, "rollback refused" would pass equally if rollback were broken.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, ACTOR);
    const v1 = await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    await createDraft(client, ROOT, 'analyst', ACTOR);
    await editDraft(client, ROOT, 'analyst', { modelKey: 'titan' }, ACTOR);
    await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);

    await expect(
      activateExistingVersion(client, ROOT, 'analyst', v1.version, ACTOR),
    ).resolves.toMatchObject({ version: v1.version });
  });
});

