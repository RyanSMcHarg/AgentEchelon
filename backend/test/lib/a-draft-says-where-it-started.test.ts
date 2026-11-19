/**
 * A DRAFT SAYS WHERE IT WAS STARTED, AND A LISTING SAYS WHICH VERSIONS A ROLLBACK LANDS ON (SPEC-PORTABLE-PROFILES FR19, Appendix C).
 *
 * What it proves:
 *   - New version records the active version it cloned on the draft's envelope, every edit keeps it, and a rollback
 *     afterwards does not change it, so the console names the draft by where it started rather than by what is active;
 *   - an imported or copied draft's provenance is listed as where it came from;
 *   - a stored version carrying the retired welcome is listed as such, the same test the rollback refuses by;
 *   - Validate runs the name check it is handed, the one Activate runs.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import {
  activateDraft, activateExistingVersion, createDraft, draftStartedFrom, editDraft, getDraft, listProfile, validateDraft,
} from '../../lambda/src/lib/profile-lifecycle';
import { __clearActiveProfileCache, definitionParamName } from '../../lambda/src/lib/active-profile';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { PutParameterCommand } from '@aws-sdk/client-ssm';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const ACTOR = 'admin-sub-123';
const NAME = 'analyst';

beforeEach(() => __clearActiveProfileCache());

describe('where a draft was started', () => {
  it('records nothing while no version is active', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    const listing = await listProfile(client, ROOT, NAME);
    expect(listing.hasDraft).toBe(true);
    expect(listing.draftBasedOnVersion).toBeUndefined();
  });

  it('records the version New version cloned, keeps it through an edit, and a rollback does not move it', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    await editDraft(client, ROOT, NAME, { persona: 'First.' }, ACTOR);
    await activateDraft(client, ROOT, NAME, CATALOG, ACTOR);
    await createDraft(client, ROOT, NAME, ACTOR);
    await editDraft(client, ROOT, NAME, { persona: 'Second.' }, ACTOR);
    await activateDraft(client, ROOT, NAME, CATALOG, ACTOR);

    await createDraft(client, ROOT, NAME, ACTOR);
    expect((await listProfile(client, ROOT, NAME)).draftBasedOnVersion).toBe(2);
    await editDraft(client, ROOT, NAME, { persona: 'Third.' }, ACTOR);
    expect((await listProfile(client, ROOT, NAME)).draftBasedOnVersion).toBe(2);

    await activateExistingVersion(client, ROOT, NAME, 1, ACTOR);
    const after = await listProfile(client, ROOT, NAME);
    expect(after.activeVersion).toBe(1);
    expect(after.draftBasedOnVersion).toBe(2);
    // Provenance is envelope: the edit's configId is the body's alone.
    expect((await getDraft(client, ROOT, NAME))?.persona).toBe('Third.');
  });

  it('lists where an imported draft came from', () => {
    const raw = JSON.stringify({ configId: 'c', provenance: { createdFrom: { instanceId: 'prod', profileName: 'concierge', version: 7 }, contentHash: 'h' } });
    expect(draftStartedFrom(raw)).toEqual({ draftCreatedFrom: { profileName: 'concierge', version: 7 } });
    expect(draftStartedFrom(JSON.stringify({ configId: 'c' }))).toEqual({});
    expect(draftStartedFrom('not json')).toEqual({});
  });
});

describe('a version a rollback is refused for', () => {
  it('is listed as carrying the retired welcome', async () => {
    const { client } = fakeSsmStore();
    await client.send(new PutParameterCommand({
      Name: definitionParamName(ROOT, NAME), Type: 'String', Overwrite: true,
      Value: JSON.stringify({ schemaVersion: 1, profileName: NAME, modelKey: 'sonnet', welcome: { title: 'Hello' }, configId: 'old' }),
    }));
    await client.send(new PutParameterCommand({
      Name: definitionParamName(ROOT, NAME), Type: 'String', Overwrite: true,
      Value: JSON.stringify({ schemaVersion: 1, profileName: NAME, modelKey: 'sonnet', configId: 'new' }),
    }));
    const listing = await listProfile(client, ROOT, NAME);
    expect(listing.versions.find((v) => v.version === 1)?.retiredWelcome).toBe(true);
    expect(listing.versions.find((v) => v.version === 2)?.retiredWelcome).toBeUndefined();
    await expect(activateExistingVersion(client, ROOT, NAME, 1, ACTOR)).rejects.toThrow(/retired welcome/);
  });
});

describe('Validate runs the name check Activate runs', () => {
  it('refuses a name another assistant shows, through the check it is handed', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    await editDraft(client, ROOT, NAME, { displayName: 'Penny' }, ACTOR);
    const nameTaken = jest.fn(async (dn: string) => (dn === 'Penny' ? "an assistant in premium already shows the name 'Penny'" : null));
    const v = await validateDraft(client, ROOT, NAME, CATALOG, undefined, undefined, nameTaken);
    expect(nameTaken).toHaveBeenCalledWith('Penny');
    expect(v.errors).toContain("an assistant in premium already shows the name 'Penny'");
  });

  it('asks nothing of a draft that names no one', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    // Null clears the field, so the draft names no one whatever the seed carried.
    await editDraft(client, ROOT, NAME, { displayName: null } as never, ACTOR);
    expect((await getDraft(client, ROOT, NAME))?.displayName).toBeUndefined();
    const nameTaken = jest.fn(async () => 'taken');
    const v = await validateDraft(client, ROOT, NAME, CATALOG, undefined, undefined, nameTaken);
    expect(nameTaken).not.toHaveBeenCalled();
    expect(v.errors).not.toContain('taken');
  });
});
