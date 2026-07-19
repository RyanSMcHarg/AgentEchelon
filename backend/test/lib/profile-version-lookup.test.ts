/**
 * SPEC-PORTABLE-VERSIONED-PROFILES P2 — resolving a profileRef to its version's model.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { lookupProfileVersionModelKey } from '../../lambda/src/lib/profile-version-lookup';
import { createDraft, editDraft, activateDraft } from '../../lambda/src/lib/profile-lifecycle';
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
});
