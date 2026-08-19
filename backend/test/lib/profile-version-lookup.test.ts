/**
 * SPEC-PORTABLE-PROFILES P2 — resolving a profileRef to its version's DEFINITION.
 *
 * §6's variant is the whole definition, not a model. The `tools`-only case below is the one that
 * matters most: it is the experiment the spec names ("does this tool earn its place"), and under a
 * model-only resolution the two variants come out identical, so it reports no difference for a reason
 * unrelated to tools. A test that only asserted the model would pass in exactly that broken state.
 */
import { PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { lookupProfileVersion, lookupProfileVersionModelKey } from '../../lambda/src/lib/profile-version-lookup';
import { createDraft, editDraft, activateDraft } from '../../lambda/src/lib/profile-lifecycle';
import { resolveActiveProfile, resolveFromDefinition, __clearActiveProfileCache } from '../../lambda/src/lib/active-profile';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');

describe('profile-version lookup P2', () => {
  it('resolves the ACTIVE version model when no version is pinned', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', 'a');
    await editDraft(client, ROOT, 'standard', { modelKey: 'opus' }, 'a');
    await activateDraft(client, ROOT, 'standard', CATALOG, 'a');
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'standard' })).toBe('opus');
  });

  it('resolves a PINNED version model (immutable history)', async () => {
    const { client } = fakeSsmStore();
    // v1 = opus, v2 = sonnet
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: 'opus' }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: 'sonnet' }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'premium', version: 1 })).toBe('opus');
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'premium', version: 2 })).toBe('sonnet');
  });

  it('returns null (fail-safe) for an unresolvable ref — no version, missing param, bad name', async () => {
    const { client } = fakeSsmStore();
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'standard' })).toBeNull(); // never activated
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'standard', version: 99 })).toBeNull();
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: '' })).toBeNull();
  });

  it('resolves the WHOLE definition, not just the model', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', 'a');
    await editDraft(client, ROOT, 'standard', {
      modelKey: 'opus',
      tools: ['load_company_context'],
      persona: 'terse',
      classifierMode: 'llm',
    }, 'a');
    await activateDraft(client, ROOT, 'standard', CATALOG, 'a');

    const def = await lookupProfileVersion(client, ROOT, { profileName: 'standard' });
    expect(def?.modelKey).toBe('opus');
    expect(def?.tools).toEqual(['load_company_context']);
    expect(def?.persona).toBe('terse');
    expect(def?.classifierMode).toBe('llm');
    expect(def?.configId).toBeTruthy(); // the version's attribution key
  });

  it('distinguishes two versions that differ ONLY in tools — the experiment §6 names', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: 'opus', tools: [] }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: 'opus', tools: ['load_company_context'] }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');

    const v1 = await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: 1 });
    const v2 = await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: 2 });

    // Same model on purpose: resolving to a model key cannot tell these apart.
    expect(v1?.modelKey).toBe(v2?.modelKey);
    expect(v1?.tools).toEqual([]);
    expect(v2?.tools).toEqual(['load_company_context']);
    expect(v1?.configId).not.toBe(v2?.configId); // so the two are attributable apart
  });

  it('treats a definition with no model or no attribution key as unusable', async () => {
    // Written straight to the store: the lifecycle write path would reject these, so the guard exists
    // for a hand-edited or partially-migrated parameter, which is exactly when it must not be served.
    const put = async (profile: string, body: Record<string, unknown>) => {
      const { client } = fakeSsmStore();
      const name = `${ROOT}/assistant/${profile}/definition`;
      const res = await client.send(new PutParameterCommand({ Name: name, Value: JSON.stringify(body), Overwrite: true }));
      await client.send(new LabelParameterVersionCommand({
        Name: name,
        ParameterVersion: (res as { Version: number }).Version,
        Labels: ['active'],
      }));
      return client;
    };

    const noModel = await put('standard', { profileName: 'standard', configId: 'c1' });
    expect(await lookupProfileVersion(noModel, ROOT, { profileName: 'standard' })).toBeNull();

    const noConfigId = await put('premium', { profileName: 'premium', modelKey: 'opus' });
    expect(await lookupProfileVersion(noConfigId, ROOT, { profileName: 'premium' })).toBeNull();
  });
});

describe('serving a profileRef variant at the turn (SPEC-PORTABLE §6)', () => {
  beforeEach(() => __clearActiveProfileCache());

  it('a variant differing ONLY in tools reaches the turn with a different tool surface', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: 'opus', tools: [] }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: 'opus', tools: ['load_company_context'] }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');

    const control = await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: 1 });
    const treatment = await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: 2 });

    // What the worker actually serves for each side of the duel.
    const servedControl = resolveFromDefinition(control!, 'premium');
    const servedTreatment = resolveFromDefinition(treatment!, 'premium');

    // Same model on both sides ON PURPOSE — a model-only resolution makes these indistinguishable.
    expect(servedControl.profile.modelKey).toBe(servedTreatment.profile.modelKey);
    expect(servedControl.tools).toEqual([]);
    expect(servedTreatment.tools).toEqual(['load_company_context']);
    expect(servedControl.configId).not.toBe(servedTreatment.configId);
  });

  it('carries persona, classifier mode and guardrail selection, not just the model', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', 'a');
    await editDraft(client, ROOT, 'standard', {
      modelKey: 'opus', persona: 'terse and blunt', classifierMode: 'llm', guardrailId: 'gr-abc',
    }, 'a');
    await activateDraft(client, ROOT, 'standard', CATALOG, 'a');

    const served = resolveFromDefinition((await lookupProfileVersion(client, ROOT, { profileName: 'standard' }))!, 'standard');
    expect(served.persona).toBe('terse and blunt');
    expect(served.profile.classifierMode).toBe('llm');
    expect(served.guardrailId).toBe('gr-abc');
  });

  it('serving a variant does NOT poison the warm-container profile cache', async () => {
    // The cache is keyed by profile NAME. If serving a variant wrote into it, the next ORDINARY turn on
    // the same container would inherit the variant's persona and tools — a cross-turn leak that no
    // single-turn assertion would catch.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: 'opus', persona: 'ACTIVE persona', tools: [] }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');

    const variantDef = { ...(await lookupProfileVersion(client, ROOT, { profileName: 'premium' }))!, persona: 'VARIANT persona', tools: ['load_company_context'] };
    resolveFromDefinition(variantDef, 'premium');

    const ordinary = await resolveActiveProfile('premium', { ssm: client, ssmRoot: ROOT });
    expect(ordinary.persona).toBe('ACTIVE persona');
    expect(ordinary.tools).toEqual([]);
  });
});
