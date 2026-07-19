/**
 * SPEC-PORTABLE-VERSIONED-PROFILES P1 — the versioning lifecycle (§4).
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
  getDraft,
  ProfileValidationError,
} from '../../lambda/src/lib/profile-lifecycle';
import { resolveActiveProfile, __clearActiveProfileCache } from '../../lambda/src/lib/active-profile';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const ACTOR = 'admin-sub-123';

beforeEach(() => __clearActiveProfileCache());

describe('profile lifecycle P1', () => {
  it('create → edit → validate → activate produces a served version; the base was never mutated', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', ACTOR);
    await editDraft(client, ROOT, 'standard', { modelKey: 'opus', rateLimitPerHour: 500 }, ACTOR);
    const v = await validateDraft(client, ROOT, 'standard', CATALOG);
    expect(v.errors).toEqual([]);
    const { version, configId } = await activateDraft(client, ROOT, 'standard', CATALOG, ACTOR);
    expect(version).toBe(1);

    __clearActiveProfileCache();
    const { profile } = await resolveActiveProfile('standard', { ssm: client, ssmRoot: ROOT });
    expect(profile.modelKey).toBe('opus'); // the activated version now serves
    expect(profile.rateLimitPerHour).toBe(500);
    expect(profile.name).toBe('standard'); // identity unchanged
    // The listing shows exactly one version, active.
    const listing = await listProfile(client, ROOT, 'standard');
    expect(listing.activeVersion).toBe(1);
    expect(listing.versions).toHaveLength(1);
    expect(listing.versions[0].configId).toBe(configId);
  });

  it('activate v2 then ROLLBACK to v1 — no redeploy, lossless (the P1 acceptance)', async () => {
    const { client } = fakeSsmStore();
    // v1 = opus
    await createDraft(client, ROOT, 'premium', ACTOR);
    await editDraft(client, ROOT, 'premium', { modelKey: 'opus' }, ACTOR);
    const v1 = await activateDraft(client, ROOT, 'premium', CATALOG, ACTOR);
    // v2 = sonnet
    await createDraft(client, ROOT, 'premium', ACTOR);
    await editDraft(client, ROOT, 'premium', { modelKey: 'sonnet' }, ACTOR);
    const v2 = await activateDraft(client, ROOT, 'premium', CATALOG, ACTOR);
    expect(v2.version).toBe(2);

    __clearActiveProfileCache();
    expect((await resolveActiveProfile('premium', { ssm: client, ssmRoot: ROOT })).profile.modelKey).toBe('sonnet');

    // Rollback to v1 = re-label active onto the immutable prior version.
    const back = await activateExistingVersion(client, ROOT, 'premium', v1.version, ACTOR);
    expect(back.version).toBe(1);
    __clearActiveProfileCache();
    expect((await resolveActiveProfile('premium', { ssm: client, ssmRoot: ROOT })).profile.modelKey).toBe('opus');

    const listing = await listProfile(client, ROOT, 'premium');
    expect(listing.activeVersion).toBe(1);
    expect(listing.versions.map((x) => x.version).sort()).toEqual([1, 2]); // both retained (immutable history)
  });

  it('edit-draft rejects an invalid body and never writes it', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'basic', ACTOR);
    await expect(editDraft(client, ROOT, 'basic', { timeoutSeconds: -1 }, ACTOR)).rejects.toBeInstanceOf(ProfileValidationError);
    // draft still valid (the bad edit was not persisted)
    const draft = await getDraft(client, ROOT, 'basic');
    expect(draft!.timeoutSeconds).toBeGreaterThan(0);
  });

  it('activate is blocked by the §7 model-ARN boundary (modelKey outside the catalog)', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', ACTOR);
    // editDraft validates SHAPE only (a string modelKey passes); the catalog check is at validate/activate.
    await editDraft(client, ROOT, 'standard', { modelKey: 'not-a-real-model' }, ACTOR);
    const v = await validateDraft(client, ROOT, 'standard', CATALOG);
    expect(v.errors.some((e) => /not in the deployment's model catalog/.test(e))).toBe(true);
    await expect(activateDraft(client, ROOT, 'standard', CATALOG, ACTOR)).rejects.toBeInstanceOf(ProfileValidationError);
    // Nothing was activated; resolution still serves the seed.
    __clearActiveProfileCache();
    const { configId } = await resolveActiveProfile('standard', { ssm: client, ssmRoot: ROOT });
    expect(configId).toBe('seed');
  });

  it('edit-draft ignores boundary keys — a hostile contextScope in the patch is dropped', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'basic', ACTOR);
    await editDraft(client, ROOT, 'basic', { modelKey: 'sonnet', contextScope: 'own-rank-and-above' } as never, ACTOR);
    const draft = await getDraft(client, ROOT, 'basic');
    expect(draft!.modelKey).toBe('sonnet');
    expect((draft as unknown as Record<string, unknown>).contextScope).toBeUndefined(); // never stored in the body
  });

  it('lists profiles with no versions as seed-only (activeVersion null, no draft)', async () => {
    const { client } = fakeSsmStore();
    const listing = await listProfile(client, ROOT, 'premium');
    expect(listing.activeVersion).toBeNull();
    expect(listing.versions).toEqual([]);
    expect(listing.hasDraft).toBe(false);
  });
});
