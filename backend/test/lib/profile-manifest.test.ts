/**
 * SPEC-PORTABLE-VERSIONED-PROFILES P3 — export / import (§5).
 * Export is instance-agnostic (no ARNs/region); import is fail-closed, lands as a DRAFT never active,
 * and rejects anything the target does not provision (model/identity) — never escalates.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { exportManifest, importManifest, ProfileManifestError, MANIFEST_SCHEMA_VERSION, signManifest } from '../../lambda/src/lib/profile-manifest';
import { createDraft, editDraft, activateDraft, getDraft, listProfile, isKnownProfile } from '../../lambda/src/lib/profile-lifecycle';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const ACTOR = 'admin-sub';
const known = isKnownProfile;

async function seedActiveVersion(client: import('@aws-sdk/client-ssm').SSMClient, name: string, modelKey: string) {
  await createDraft(client, ROOT, name, ACTOR);
  await editDraft(client, ROOT, name, { modelKey }, ACTOR);
  return activateDraft(client, ROOT, name, CATALOG, ACTOR);
}

describe('profile manifest P3', () => {
  it('exports an instance-agnostic manifest — no ARNs, account ids, or region', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'standard', 'opus');
    const manifest = await exportManifest(client, ROOT, 'standard');
    const json = JSON.stringify(manifest);
    expect(manifest.kind).toBe('assistant-profile');
    expect(manifest.body.modelKey).toBe('opus'); // logical catalog key, not an ARN
    expect(json).not.toMatch(/arn:aws/);
    expect(json).not.toMatch(/\b\d{12}\b/); // no 12-digit account id
    expect(json).not.toMatch(/us-east-1|us-west-2/); // no region
    expect(manifest.provenance.sourceProfileName).toBe('standard');
    expect(manifest.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips: export from A, import into B lands as a DRAFT (never active), then activate serves it', async () => {
    const a = fakeSsmStore();
    await seedActiveVersion(a.client, 'premium', 'opus');
    const manifest = await exportManifest(a.client, ROOT, 'premium');

    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, actor: ACTOR });
    expect(draft.modelKey).toBe('opus');
    // Landed as a DRAFT — nothing is active on B yet.
    const listing = await listProfile(b.client, ROOT, 'premium');
    expect(listing.activeVersion).toBeNull();
    expect(listing.hasDraft).toBe(true);
    // Provenance audit chain preserved.
    expect((draft as unknown as Record<string, unknown>).provenance).toBeTruthy();
    // A human activation is still required (P1 lifecycle).
    const r = await activateDraft(b.client, ROOT, 'premium', CATALOG, ACTOR);
    expect(r.version).toBe(1);
  });

  it('rejects a manifest whose model is not in the target catalog (never widens the allowlist, §7)', async () => {
    const { client } = fakeSsmStore();
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'assistant-profile',
      profileName: 'standard',
      body: { modelKey: 'some-unlisted-model', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' },
      provenance: { sourceProfileName: 'standard', sourceVersion: 'active', exportedConfigId: 'x' },
      contentHash: 'deadbeef',
    };
    await expect(importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/not in the target's model catalog/)]) });
  });

  it('rejects a manifest whose target profile is not provisioned on this instance', async () => {
    const { client } = fakeSsmStore();
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'assistant-profile',
      profileName: 'ghost-assistant',
      body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' },
      provenance: { sourceProfileName: 'ghost-assistant', sourceVersion: 'active', exportedConfigId: 'x' },
      contentHash: 'x',
    };
    await expect(importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/not provisioned on this instance/)]) });
  });

  it('rejects a non-manifest / wrong-schema blob (untrusted input)', async () => {
    const { client } = fakeSsmStore();
    await expect(importManifest(client, ROOT, { kind: 'something-else' }, { catalog: CATALOG, knownProfile: known, actor: ACTOR }))
      .rejects.toBeInstanceOf(ProfileManifestError);
    await expect(importManifest(client, ROOT, 'not json', { catalog: CATALOG, knownProfile: known, actor: ACTOR }))
      .rejects.toBeInstanceOf(ProfileManifestError);
  });

  it('an operator can REMAP a manifest onto a different provisioned profile', async () => {
    const src = fakeSsmStore();
    await seedActiveVersion(src.client, 'premium', 'opus');
    const manifest = await exportManifest(src.client, ROOT, 'premium');
    const { client } = fakeSsmStore();
    const draft = await importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, actor: ACTOR, targetProfileName: 'standard' });
    expect(draft.profileName).toBe('standard');
    expect((await getDraft(client, ROOT, 'standard'))!.modelKey).toBe('opus');
  });
});

describe('P4 — optional manifest signing', () => {
  const SECRET = 'test-signing-secret';
  afterEach(() => {
    delete process.env.MANIFEST_SIGNING_SECRET;
    delete process.env.MANIFEST_REQUIRE_SIGNATURE;
  });

  it('exports a SIGNED manifest when a secret is configured; the secret never travels', async () => {
    process.env.MANIFEST_SIGNING_SECRET = SECRET;
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'standard', 'opus');
    const manifest = await exportManifest(client, ROOT, 'standard');
    expect(manifest.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it('imports a validly-signed manifest and REJECTS a tampered one', async () => {
    process.env.MANIFEST_SIGNING_SECRET = SECRET;
    const src = fakeSsmStore();
    await seedActiveVersion(src.client, 'premium', 'opus');
    const manifest = await exportManifest(src.client, ROOT, 'premium');

    const b = fakeSsmStore();
    await expect(importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, actor: ACTOR })).resolves.toBeTruthy();

    const tampered = { ...manifest, body: { ...manifest.body, modelKey: 'sonnet' } }; // signature no longer matches
    await expect(importManifest(b.client, ROOT, tampered, { catalog: CATALOG, knownProfile: known, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/signature does not match/)]) });
  });

  it('rejects an unsigned manifest when the target REQUIRES a signature', async () => {
    process.env.MANIFEST_SIGNING_SECRET = SECRET;
    process.env.MANIFEST_REQUIRE_SIGNATURE = 'true';
    const { client } = fakeSsmStore();
    const unsigned = {
      schemaVersion: MANIFEST_SCHEMA_VERSION, kind: 'assistant-profile', profileName: 'standard',
      body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' },
      provenance: { sourceProfileName: 'standard', sourceVersion: 'active', exportedConfigId: 'x' }, contentHash: 'x',
    };
    await expect(importManifest(client, ROOT, unsigned, { catalog: CATALOG, knownProfile: known, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/unsigned/)]) });
  });

  it('rejects a signed manifest when this instance has no secret to verify with', async () => {
    // exporter signed with a secret; importer has none configured → cannot verify → reject (never trust).
    const signed = {
      schemaVersion: MANIFEST_SCHEMA_VERSION, kind: 'assistant-profile', profileName: 'standard',
      body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' },
      provenance: { sourceProfileName: 'standard', sourceVersion: 'active', exportedConfigId: 'x' }, contentHash: 'x',
      signature: signManifest({ profileName: 'standard' }, SECRET),
    };
    const { client } = fakeSsmStore();
    await expect(importManifest(client, ROOT, signed, { catalog: CATALOG, knownProfile: known, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/no MANIFEST_SIGNING_SECRET/)]) });
  });
});
