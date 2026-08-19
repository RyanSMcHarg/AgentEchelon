/**
 * A guardrail selection the deployment cannot resolve is rejected at the WRITE, not discovered per turn.
 *
 * WHY THIS WAS ASYMMETRIC, AND WHY THAT SHAPE IS THE BUG. `importManifest` validated `guardrailId`
 * against the target's catalog; `validateDraft` / `activateDraft` did not. So the same selection was
 * REJECTED arriving as a manifest and ACCEPTED arriving through the console - and export/edit/activate is
 * exactly the round trip that produces the bad value, because the catalog publishes selection KEYS
 * ('default', 'strict') alongside deploy-resolved ids and an exported manifest deliberately carries the
 * key.
 *
 * The runtime is not silent about it: `runGuardrail` treats a selected guardrail that will not apply as a
 * persistent misconfiguration, falls back to the deployment default and logs at error level, so content
 * is still filtered. What the profile loses is the STRICTER guardrail it appears to have chosen, and the
 * only signal is an error line on every turn for as long as the version stays active. Rejecting it once
 * is the same rule `validateBody` already applies to `modelKey`.
 *
 * Both forms are accepted, matching import: a catalog key, or an already-resolved id the target
 * provisions. An unreadable catalog fails CLOSED - a selection that cannot be verified is not activated.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { createDraft, editDraft, validateDraft, activateDraft, ProfileValidationError } from '../../lambda/src/lib/profile-lifecycle';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');

/** What a deployment publishes: a stable selection key plus the id it resolved to. */
const PUBLISHED = [
  { key: 'default', guardrailId: 'gr-abc123' },
  { key: 'strict', guardrailId: 'gr-def456' },
];
const guardrailCatalog = async () => PUBLISHED;

async function draftWithGuardrail(client: Parameters<typeof createDraft>[0], guardrailId: string) {
  await createDraft(client, ROOT, 'premium', 'operator');
  await editDraft(client, ROOT, 'premium', { modelKey: 'sonnet', guardrailId }, 'operator');
}

describe('an unresolvable guardrail selection is refused', () => {
  it('validateDraft reports it, naming what IS published', async () => {
    const { client } = fakeSsmStore();
    await draftWithGuardrail(client, 'gr-does-not-exist');

    const { errors } = await validateDraft(client, ROOT, 'premium', CATALOG, undefined, guardrailCatalog);
    expect(errors.join(' ')).toMatch(/guardrailId 'gr-does-not-exist' matches no guardrail/);
    // Naming the alternatives is the difference between an error an operator can act on and one they
    // have to go read the catalog for.
    expect(errors.join(' ')).toContain("'strict'");
  });

  it('activateDraft REFUSES it — activation is the gate, since validate can be skipped', async () => {
    const { client } = fakeSsmStore();
    await draftWithGuardrail(client, 'gr-does-not-exist');

    await expect(
      activateDraft(client, ROOT, 'premium', CATALOG, 'operator', undefined, guardrailCatalog),
    ).rejects.toThrow(ProfileValidationError);
  });
});

describe('what must still be accepted', () => {
  it('a catalog KEY activates — it is what an exported manifest carries', async () => {
    const { client } = fakeSsmStore();
    await draftWithGuardrail(client, 'strict');
    const r = await activateDraft(client, ROOT, 'premium', CATALOG, 'operator', undefined, guardrailCatalog);
    expect(r.version).toBeGreaterThan(0);
  });

  it('an already-resolved id activates', async () => {
    const { client } = fakeSsmStore();
    await draftWithGuardrail(client, 'gr-def456');
    const r = await activateDraft(client, ROOT, 'premium', CATALOG, 'operator', undefined, guardrailCatalog);
    expect(r.version).toBeGreaterThan(0);
  });

  it('a profile selecting NO guardrail is unaffected', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'premium', 'operator');
    await editDraft(client, ROOT, 'premium', { modelKey: 'sonnet' }, 'operator');
    const r = await activateDraft(client, ROOT, 'premium', CATALOG, 'operator', undefined, guardrailCatalog);
    expect(r.version).toBeGreaterThan(0);
  });

  it('no catalog supplied ⇒ no new check, so an unrelated caller is not broken', async () => {
    // The parameter is optional. A caller that cannot supply a catalog keeps its previous behaviour
    // rather than being unable to activate anything.
    const { client } = fakeSsmStore();
    await draftWithGuardrail(client, 'gr-whatever');
    const r = await activateDraft(client, ROOT, 'premium', CATALOG, 'operator');
    expect(r.version).toBeGreaterThan(0);
  });
});

describe('an unverifiable selection fails CLOSED', () => {
  it('an unreadable catalog refuses activation rather than waving it through', async () => {
    const { client } = fakeSsmStore();
    await draftWithGuardrail(client, 'strict');
    const throwing = async () => { throw new Error('SSM unavailable'); };

    await expect(
      activateDraft(client, ROOT, 'premium', CATALOG, 'operator', undefined, throwing),
    ).rejects.toThrow(/could not be read/);
  });
});
