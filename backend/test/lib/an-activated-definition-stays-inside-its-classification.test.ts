/**
 * AN ACTIVATED DEFINITION CANNOT CHOOSE A MODEL ITS CLASSIFICATION DOES NOT ALLOW.
 *
 * The vend narrows each assistant's session from its approved definition (`assistant-grant.ts`), so the
 * definition is part of the boundary. Activation checked only that a model was in the catalog: a
 * Standard assistant could be activated on Opus, and the resolver then degraded it silently at every
 * turn. Activation now refuses a chosen model the classification cannot reach. A per-intent route is
 * not held to this, because routes start from the platform's intent strategy and the resolver degrades
 * a disallowed one to the classification default by design.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { createDraft, editDraft, activateDraft, ProfileValidationError } from '../../lambda/src/lib/profile-lifecycle';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');

describe('activation keeps a definition inside its classification', () => {
  it('refuses a Standard assistant activated on a model Standard cannot reach', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', { modelKey: 'opus' }, 'a');
    await expect(activateDraft(client, ROOT, 'analyst', CATALOG, 'a')).rejects.toBeInstanceOf(ProfileValidationError);
    await expect(activateDraft(client, ROOT, 'analyst', CATALOG, 'a')).rejects.toThrow(/not selected by the standard classification/);
  });

  it('activates the same model on a Premium assistant, which can reach it', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'advisor', 'a');
    await editDraft(client, ROOT, 'advisor', { modelKey: 'opus' }, 'a');
    await expect(activateDraft(client, ROOT, 'advisor', CATALOG, 'a')).resolves.toMatchObject({ version: expect.any(Number) });
  });

  it('does not refuse a seed body whose intent routes name a model the classification degrades', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', { modelKey: 'titan' }, 'a');
    await expect(activateDraft(client, ROOT, 'analyst', CATALOG, 'a')).resolves.toMatchObject({ version: expect.any(Number) });
  });
});
