/**
 * A profile version past the SSM history page boundary is still reachable — read, export AND rollback.
 *
 * WHY THIS EXISTS. Three call sites confirmed a version's existence by scanning
 * `GetParameterHistory({ Name })` and taking the first page. Real SSM returns at most 10 entries,
 * OLDEST FIRST, with a `NextToken` none of the three followed. So the eleventh version onward was
 * invisible to all of them, and each failed in a different and misleading way:
 *
 *  - `lookupProfileVersion` returned null, which the caller reads as "no such variant" and skips. A
 *    `profileRef` experiment therefore ran CONTROL-ONLY and reported a clean "no difference" - a false
 *    negative shaped exactly like a real result, which is the worst possible failure for an experiment.
 *  - `exportManifest` threw "version N not found" for a version that existed.
 *  - `activateExistingVersion` - ROLLBACK - refused a version the console had just listed, because
 *    `listVersions` pages correctly and the confirm step did not.
 *
 * All three now address the version directly (`name:N`), so no page boundary is involved. Ten is not a
 * large number of versions for a profile anyone actually tunes, so this was reachable in normal use.
 *
 * The fake SSM store models the page boundary (`SSM_HISTORY_PAGE_SIZE`); before that it returned every
 * version in one page, which is why the whole class of bug passed CI.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { lookupProfileVersion } from '../../lambda/src/lib/profile-version-lookup';
import { createDraft, editDraft, activateDraft, activateExistingVersion, listProfile } from '../../lambda/src/lib/profile-lifecycle';
import { exportManifest } from '../../lambda/src/lib/profile-manifest';
import { fakeSsmStore, SSM_HISTORY_PAGE_SIZE } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
/** Comfortably past the boundary, so an off-by-one in the fake cannot make this pass by accident. */
const VERSIONS = SSM_HISTORY_PAGE_SIZE + 4;

/** Activate `VERSIONS` versions of `premium`, alternating the model so each is identifiable. */
async function seedManyVersions(client: Parameters<typeof createDraft>[0]) {
  for (let i = 1; i <= VERSIONS; i++) {
    await createDraft(client, ROOT, 'premium', 'a');
    await editDraft(client, ROOT, 'premium', { modelKey: i % 2 === 0 ? 'sonnet' : 'opus' }, 'a');
    await activateDraft(client, ROOT, 'premium', CATALOG, 'a');
  }
}

describe('a version past the SSM history page boundary', () => {
  it('is readable by lookupProfileVersion, so a pinned variant is not silently skipped', async () => {
    const { client } = fakeSsmStore();
    await seedManyVersions(client);

    const beyond = VERSIONS; // the newest, well past page 1
    const def = await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: beyond });

    // The assertion that matters: NOT null. Null is what made the experiment run control-only.
    expect(def).not.toBeNull();
    expect(def?.modelKey).toBe(beyond % 2 === 0 ? 'sonnet' : 'opus');
    expect(def?.configId).toBeTruthy(); // without this the caller rejects it as unattributable anyway
  });

  it('is still distinguishable from a version on the first page', async () => {
    const { client } = fakeSsmStore();
    await seedManyVersions(client);

    const onPageOne = await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: 1 });
    const beyond = await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: VERSIONS });
    // Assert non-null BEFORE comparing. Without this the comparison passes vacuously when `beyond` is
    // null - undefined !== a real configId - so a broken read would satisfy the very test meant to
    // catch it. Verified by reverting the read path: this line is what turns it red.
    expect(onPageOne).not.toBeNull();
    expect(beyond).not.toBeNull();
    expect(onPageOne?.modelKey).toBe('opus');
    expect(beyond?.configId).not.toBe(onPageOne?.configId);
  });

  it('is exportable as a manifest', async () => {
    const { client } = fakeSsmStore();
    await seedManyVersions(client);
    const manifest = await exportManifest(client, ROOT, 'premium', VERSIONS);
    expect(manifest.provenance.sourceVersion).toBe(VERSIONS);
  });

  it('is a valid ROLLBACK target, and every version listed is one', async () => {
    const { client } = fakeSsmStore();
    await seedManyVersions(client);

    // Roll back to a version past the boundary but NOT the newest, which is the real operator action.
    const target = SSM_HISTORY_PAGE_SIZE + 1;
    const rolled = await activateExistingVersion(client, ROOT, 'premium', target, 'operator');
    expect(rolled.version).toBe(target);
    expect(rolled.configId).toBeTruthy();

    // The console offers whatever `listProfile` returns, so anything it lists must be activatable.
    // A confirm step that pages differently from the list is how rollback refused its own options:
    // `listProfile` follows `NextToken`, the confirm step read page 1. This asserts they agree.
    const listing = await listProfile(client, ROOT, 'premium');
    expect(listing.versions.length).toBeGreaterThan(SSM_HISTORY_PAGE_SIZE);
    for (const v of listing.versions) {
      await expect(activateExistingVersion(client, ROOT, 'premium', v.version, 'operator')).resolves.toBeTruthy();
    }
  });

  it('a version that genuinely does not exist still fails closed', async () => {
    const { client } = fakeSsmStore();
    await seedManyVersions(client);
    expect(await lookupProfileVersion(client, ROOT, { profileName: 'premium', version: VERSIONS + 50 })).toBeNull();
    await expect(exportManifest(client, ROOT, 'premium', VERSIONS + 50)).rejects.toThrow(/not found/);
    await expect(activateExistingVersion(client, ROOT, 'premium', VERSIONS + 50, 'operator')).rejects.toThrow(/not found/);
  });
});
