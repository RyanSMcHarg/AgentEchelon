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
    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', { modelKey: 'titan' }, 'a');
    await activateDraft(client, ROOT, 'analyst', CATALOG, 'a');
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'analyst' })).toBe('titan');
  });

  it('resolves a PINNED version model (immutable history)', async () => {
    const { client } = fakeSsmStore();
    // v1 = opus, v2 = sonnet
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus' }, 'a');
    await activateDraft(client, ROOT, 'advisor', CATALOG, 'a');
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'sonnet' }, 'a');
    await activateDraft(client, ROOT, 'advisor', CATALOG, 'a');
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'advisor', version: 1 })).toBe('opus');
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'advisor', version: 2 })).toBe('sonnet');
  });

  it('returns null (fail-safe) for an unresolvable ref — no version, missing param, bad name', async () => {
    const { client } = fakeSsmStore();
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'analyst' })).toBeNull(); // never activated
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: 'analyst', version: 99 })).toBeNull();
    expect(await lookupProfileVersionModelKey(client, ROOT, { profileName: '' })).toBeNull();
  });

  it('resolves the WHOLE definition, not just the model', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', {
      modelKey: 'titan',
      tools: ['load_company_context'],
      persona: 'terse',
      contextSources: [],
    }, 'a');
    await activateDraft(client, ROOT, 'analyst', CATALOG, 'a');

    const def = await lookupProfileVersion(client, ROOT, { profileName: 'analyst' });
    expect(def?.modelKey).toBe('titan');
    expect(def?.tools).toEqual(['load_company_context']);
    expect(def?.persona).toBe('terse');
    expect(def?.contextSources).toEqual([]);
    expect(def?.configId).toBeTruthy(); // the version's attribution key
  });

  it('distinguishes two versions that differ ONLY in tools — the experiment §6 names', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus', tools: [] }, 'a');
    await activateDraft(client, ROOT, 'advisor', CATALOG, 'a');
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus', tools: ['load_company_context'] }, 'a');
    await activateDraft(client, ROOT, 'advisor', CATALOG, 'a');

    const v1 = await lookupProfileVersion(client, ROOT, { profileName: 'advisor', version: 1 });
    const v2 = await lookupProfileVersion(client, ROOT, { profileName: 'advisor', version: 2 });

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

    const noModel = await put('analyst', { profileName: 'analyst', configId: 'c1' });
    expect(await lookupProfileVersion(noModel, ROOT, { profileName: 'analyst' })).toBeNull();

    const noConfigId = await put('advisor', { profileName: 'advisor', modelKey: 'opus' });
    expect(await lookupProfileVersion(noConfigId, ROOT, { profileName: 'advisor' })).toBeNull();
  });
});

describe('serving a profileRef variant at the turn (SPEC-PORTABLE §6)', () => {
  beforeEach(() => __clearActiveProfileCache());

  it('a variant differing ONLY in tools reaches the turn with a different tool surface', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus', tools: [] }, 'a');
    await activateDraft(client, ROOT, 'advisor', CATALOG, 'a');
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus', tools: ['load_company_context'] }, 'a');
    await activateDraft(client, ROOT, 'advisor', CATALOG, 'a');

    const control = await lookupProfileVersion(client, ROOT, { profileName: 'advisor', version: 1 });
    const treatment = await lookupProfileVersion(client, ROOT, { profileName: 'advisor', version: 2 });

    // What the worker actually serves for each side of the duel.
    const servedControl = resolveFromDefinition(control!, 'advisor');
    const servedTreatment = resolveFromDefinition(treatment!, 'advisor');

    // Same model on both sides ON PURPOSE — a model-only resolution makes these indistinguishable.
    expect(servedControl.profile.modelKey).toBe(servedTreatment.profile.modelKey);
    expect(servedControl.tools).toEqual([]);
    expect(servedTreatment.tools).toEqual(['load_company_context']);
    expect(servedControl.configId).not.toBe(servedTreatment.configId);
  });

  it('carries persona, tool allowlist and guardrail selection, not just the model', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', {
      modelKey: 'titan', persona: 'terse and blunt', tools: ['open_work_summary'], guardrailId: 'gr-abc',
    }, 'a');
    await activateDraft(client, ROOT, 'analyst', CATALOG, 'a');

    const served = resolveFromDefinition((await lookupProfileVersion(client, ROOT, { profileName: 'analyst' }))!, 'analyst');
    expect(served.persona).toBe('terse and blunt');
    expect(served.tools).toEqual(['open_work_summary']);
    expect(served.guardrailId).toBe('gr-abc');
  });

  it('serving a variant does NOT poison the warm-container profile cache', async () => {
    // The cache is keyed by profile NAME. If serving a variant wrote into it, the next ORDINARY turn on
    // the same container would inherit the variant's persona and tools — a cross-turn leak that no
    // single-turn assertion would catch.
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus', persona: 'ACTIVE persona', tools: [] }, 'a');
    await activateDraft(client, ROOT, 'advisor', CATALOG, 'a');

    const variantDef = { ...(await lookupProfileVersion(client, ROOT, { profileName: 'advisor' }))!, persona: 'VARIANT persona', tools: ['load_company_context'] };
    resolveFromDefinition(variantDef, 'advisor');

    const ordinary = await resolveActiveProfile('advisor', { ssm: client, ssmRoot: ROOT });
    expect(ordinary.persona).toBe('ACTIVE persona');
    expect(ordinary.tools).toEqual([]);
  });
});

describe('a retired copy is not served', () => {
  /**
   * WHAT AN ASSISTANT SAYS IS ITS MESSAGE TEMPLATES (ADR-062). A version stored before them may still carry `copy`; it is
   * parsed so the version still reads and hashes to its own configId, and left off the resolved profile, so no turn
   * can read a line from it. `npm run migrate-legacy-copy` makes those lines the assistant's own templates.
   */
  it('leaves copy off the resolved profile even when the definition carries it', () => {
    const served = resolveFromDefinition(
      {
        configId: 'v1',
        modelKey: 'opus',
        copy: { queuedOne: 'Ich kümmere mich gleich darum.' },
      } as never,
      'advisor',
    );

    expect((served as unknown as Record<string, unknown>).copy).toBeUndefined();
  });
});
