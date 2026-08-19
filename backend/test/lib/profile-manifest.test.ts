/**
 * SPEC-PORTABLE-PROFILES P3 — export / import (§5).
 * Export is instance-agnostic (no ARNs/region); import is fail-closed, lands as a DRAFT never active,
 * and rejects anything the target does not provision (model/identity) — never escalates.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { exportManifest, importManifest, ProfileManifestError, MANIFEST_SCHEMA_VERSION, signManifest, type TargetContextSource } from '../../lambda/src/lib/profile-manifest';
import { createDraft, editDraft, activateDraft, getDraft, listProfile, isKnownProfile } from '../../lambda/src/lib/profile-lifecycle';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { awaitedPartyOf } from '../../lambda/src/lib/task-state-machines';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const ACTOR = 'admin-sub';
const known = isKnownProfile;
// The TARGET's selectable guardrails, as the assistant-profile stack publishes them: a stable
// selection KEY plus the id resolved on THIS instance. Ids are deliberately unlike any a source
// deployment would carry, which is the whole point of validating the selection on import.
const GUARDRAILS = async () => [
  { key: 'default', guardrailId: 'gr-target-default' },
  { key: 'strict', guardrailId: 'gr-target-strict' },
];

/**
 * The TARGET's published context sources. Field TYPES matter as much as keys here: a guardrail is an
 * opaque id, but a context source returns data with a shape, so two deployments can publish the same
 * key and disagree about what it yields.
 */
const CONTEXT_SOURCES = async (): Promise<TargetContextSource[]> => [
  {
    key: 'user-profile',
    contractVersion: '1.0',
    fields: { displayName: { type: 'string' }, company: { type: 'string', optional: true } },
  },
  { key: 'x-resume', fields: { headline: { type: 'string' } } },
];

async function seedActiveVersion(
  client: import('@aws-sdk/client-ssm').SSMClient,
  name: string,
  modelKey: string,
  extra: Record<string, unknown> = {},
) {
  await createDraft(client, ROOT, name, ACTOR);
  // `extra` must go in BEFORE activation: export reads the ACTIVE version, so anything left on the
  // draft is invisible to it.
  await editDraft(client, ROOT, name, { modelKey, ...extra }, ACTOR);
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
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
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

  it('carries a machine whose wait is spelled the OLD way through export, import and activation', async () => {
    // THE REASON THE SHAPE CHANGED NOW RATHER THAN LATER. `machines` lives inside a versioned profile
    // definition and travels in the manifest, so a stored version predating the declared form has to
    // keep working: it validates on import, activates, and resolves to the same reference the declared
    // form does (SPEC-TASK-STATE-TRANSITIONS §12.6). If it did not, an existing deployment's own
    // profile would stop importing the day the platform changed the spelling.
    const legacyMachines = {
      report_generation: {
        initial: 'collecting_requirements',
        states: {
          collecting_requirements: {
            transitions: ['generating'],
            awaitsUser: true,
            requires: ['the audience'],
          },
          generating: { transitions: ['completed'], delivers: true },
          completed: { transitions: [], terminal: 'success' },
        },
      },
    };

    const a = fakeSsmStore();
    await seedActiveVersion(a.client, 'standard', 'opus', { machines: legacyMachines });
    const manifest = await exportManifest(a.client, ROOT, 'standard');
    expect(manifest.body.machines).toEqual(legacyMachines);

    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.machines).toEqual(legacyMachines);
    // Activation runs the same validation again, including the rule that refuses `requires` on a step
    // awaiting nobody - which is exactly the rule a reader left on the declared form would fire here.
    const activated = await activateDraft(b.client, ROOT, 'standard', CATALOG, ACTOR);
    expect(activated.version).toBe(1);

    expect(awaitedPartyOf(draft.machines!.report_generation.states.collecting_requirements))
      .toEqual({ party: 'requester' });
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
    await expect(importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
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
    await expect(importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/not provisioned on this instance/)]) });
  });

  it('rejects a non-manifest / wrong-schema blob (untrusted input)', async () => {
    const { client } = fakeSsmStore();
    await expect(importManifest(client, ROOT, { kind: 'something-else' }, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toBeInstanceOf(ProfileManifestError);
    await expect(importManifest(client, ROOT, 'not json', { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toBeInstanceOf(ProfileManifestError);
  });

  it('an operator can REMAP a manifest onto a different provisioned profile', async () => {
    const src = fakeSsmStore();
    await seedActiveVersion(src.client, 'premium', 'opus');
    const manifest = await exportManifest(src.client, ROOT, 'premium');
    const { client } = fakeSsmStore();
    const draft = await importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR, targetProfileName: 'standard' });
    expect(draft.profileName).toBe('standard');
    expect((await getDraft(client, ROOT, 'standard'))!.modelKey).toBe('opus');
  });

  it('export carries a COMPLETE editable models bundle (not just a hash) so the manifest can be hand-edited', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'standard', 'sonnet');
    const manifest = await exportManifest(client, ROOT, 'standard');
    expect(manifest.body.models?.default).toBe('sonnet');
    expect(manifest.body.models?.classifier).toBeDefined(); // explicit (the 'default' sentinel), not absent
    expect(Object.keys(manifest.body.models?.byIntent ?? {}).length).toBeGreaterThan(0);
  });

  it('ACCEPTS a hand-edited (contentHash-mismatched) UNSIGNED manifest — export→edit→import is the workflow', async () => {
    const src = fakeSsmStore();
    await seedActiveVersion(src.client, 'premium', 'opus');
    const manifest = await exportManifest(src.client, ROOT, 'premium');
    // Operator hand-edits a model in the exported body WITHOUT recomputing contentHash.
    manifest.body.models!.default = 'sonnet';
    manifest.body.modelKey = 'sonnet';
    const { client } = fakeSsmStore();
    const draft = await importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.modelKey).toBe('sonnet'); // the edit landed
    // The draft re-derives its own configId from the edited body (self-consistent), no rejection.
    expect(draft.configId).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('P4 — optional manifest signing', () => {
  const SECRET = 'test-signing-secret';
  afterEach(() => {
    delete process.env.MANIFEST_SIGNING_SECRET;
    delete process.env.MANIFEST_REQUIRE_SIGNATURE;
  });

  // EXPORT emits the portable KEY, not the id resolved on the authoring instance. This is what closes
  // the round trip: before it, a plain export→import across deployments could only ever REJECT, because
  // the manifest carried an opaque id the target had never heard of.
  it('export rewrites a stored guardrail id into its portable selection KEY', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus', { guardrailId: 'gr-target-strict' });
    const manifest = await exportManifest(client, ROOT, 'premium', undefined, GUARDRAILS);
    expect(manifest.body.guardrailId).toBe('strict');
    // The instance-agnostic promise this field used to break: an opaque resolved id is not an ARN, not
    // an account id, and not a region, so the existing check could never have caught it.
    expect(JSON.stringify(manifest)).not.toContain('gr-target-strict');
  });

  it('export→import across instances round-trips the SELECTION onto the target\'s own guardrail', async () => {
    const a = fakeSsmStore();
    await seedActiveVersion(a.client, 'premium', 'opus', { guardrailId: 'gr-source-abc123' });
    // Instance A resolves 'strict' to its own id; instance B resolves it to a DIFFERENT one.
    const sourceCatalog = async () => [{ key: 'strict', guardrailId: 'gr-source-abc123' }];
    const manifest = await exportManifest(a.client, ROOT, 'premium', undefined, sourceCatalog);
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.guardrailId).toBe('gr-target-strict'); // B's id, not A's — no manual edit needed
  });

  it('export without a catalog emits the selection verbatim (no throw, import stays the gate)', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus', { guardrailId: 'gr-target-strict' });
    const manifest = await exportManifest(client, ROOT, 'premium');
    expect(manifest.body.guardrailId).toBe('gr-target-strict');
  });

  it('export does not fail when the guardrail catalog is unreadable', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus', { guardrailId: 'gr-target-strict' });
    const unreadable = async () => { throw new Error('ParameterNotFound'); };
    await expect(exportManifest(client, ROOT, 'premium', undefined, unreadable)).resolves.toBeTruthy();
  });

  // GUARDRAIL SELECTION (§7 reject-or-remap). `guardrailId` is a deployment-RESOLVED id, so it is the
  // one cross-deployment reference that cannot survive a move unchanged. Left unchecked it landed a
  // draft whose guardrail can never be applied — and because the apply path falls back to the
  // deployment default, the damage is silent: the assistant runs, just not under the guardrail the
  // profile says it selected.
  it('REMAPS a guardrail selection key to this instance\'s resolved id (what makes it portable)', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus');
    const manifest = await exportManifest(client, ROOT, 'premium');
    manifest.body.guardrailId = 'strict'; // the stable key, not an id
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.guardrailId).toBe('gr-target-strict');
  });

  it('ACCEPTS a guardrail id already provisioned on this target, unchanged', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus');
    const manifest = await exportManifest(client, ROOT, 'premium');
    manifest.body.guardrailId = 'gr-target-default';
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.guardrailId).toBe('gr-target-default');
  });

  it('REJECTS a guardrail id from ANOTHER deployment rather than landing an unappliable selection', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus');
    const manifest = await exportManifest(client, ROOT, 'premium');
    manifest.body.guardrailId = 'gr-source-instance-abc123'; // resolved on the SOURCE, meaningless here
    const b = fakeSsmStore();
    await expect(importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toThrow(ProfileManifestError);
    // The error names the remap targets, so the operator can fix it without reading the stack.
    await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR })
      .catch((e: ProfileManifestError) => {
        expect(JSON.stringify(e.errors)).toContain("'strict'");
        expect(JSON.stringify(e.errors)).toContain("'default'");
      });
  });

  it('FAILS CLOSED when the target guardrail catalog cannot be read (never lands an unverifiable one)', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus');
    const manifest = await exportManifest(client, ROOT, 'premium');
    manifest.body.guardrailId = 'strict';
    const b = fakeSsmStore();
    const unreadable = async () => { throw new Error('ParameterNotFound'); };
    await expect(importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: unreadable, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toThrow(/cannot validate the guardrail selection/);
  });

  it('a manifest with NO guardrail selection imports untouched (inherits the deployment default)', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'premium', 'opus');
    const manifest = await exportManifest(client, ROOT, 'premium');
    delete (manifest.body as { guardrailId?: string }).guardrailId;
    const b = fakeSsmStore();
    // The catalog is never consulted, so even an unreadable one must not block this path.
    const unreadable = async () => { throw new Error('should not be called'); };
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: unreadable, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.guardrailId).toBeUndefined();
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
    await expect(importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR })).resolves.toBeTruthy();

    const tampered = { ...manifest, body: { ...manifest.body, modelKey: 'sonnet' } }; // signature no longer matches
    await expect(importManifest(b.client, ROOT, tampered, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
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
    await expect(importManifest(client, ROOT, unsigned, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
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
    await expect(importManifest(client, ROOT, signed, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/no MANIFEST_SIGNING_SECRET/)]) });
  });

  // SPEC-CONTEXT-SOURCES-AND-STORES section 6 - context SELECTION is portable by KEY, but a key alone is
  // not enough: a context source returns data with a SHAPE, so the field contract is what makes
  // portability real rather than nominal. Every case here asserts a REJECTION.
  describe('context source selection (SPEC-CONTEXT-SOURCES-AND-STORES)', () => {
    const ctxManifest = (over = {}) => ({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'assistant-profile',
      profileName: 'standard',
      body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full', contextSources: ['user-profile'] },
      provenance: { sourceProfileName: 'standard', sourceVersion: 'active', exportedConfigId: 'x' },
      contentHash: 'x',
      ...over,
    });
    const opts = (over = {}) => ({ catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR, ...over });

    it('accepts a selection every key of which the target publishes', async () => {
      const { client } = fakeSsmStore();
      const draft = await importManifest(client, ROOT, ctxManifest(), opts());
      expect(draft.contextSources).toEqual(['user-profile']);
    });

    it('rejects a key the target does not publish, and NAMES what it offers', async () => {
      const { client } = fakeSsmStore();
      const m = ctxManifest({ body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full', contextSources: ['x-crm-account'] } });
      await expect(importManifest(client, ROOT, m, opts()))
        .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/'x-crm-account' is not published.*user-profile/s)]) });
    });

    it('rejects a field the target does not provide (same key, different shape)', async () => {
      // The silent-misbehaviour case: without the contract this imports cleanly and breaks at runtime.
      const { client } = fakeSsmStore();
      const m = ctxManifest({ contextContracts: { 'user-profile': { contractVersion: '1.0', fields: { displayName: 'string', pronouns: 'string' } } } });
      await expect(importManifest(client, ROOT, m, opts()))
        .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/needs field 'pronouns'/)]) });
    });

    it('rejects a field the target RETYPED', async () => {
      const { client } = fakeSsmStore();
      const m = ctxManifest({ contextContracts: { 'user-profile': { contractVersion: '1.0', fields: { displayName: 'number' } } } });
      await expect(importManifest(client, ROOT, m, opts()))
        .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/'displayName' is 'number' in the manifest but 'string'/)]) });
    });

    it('rejects a reserved key whose contract MAJOR differs', async () => {
      const { client } = fakeSsmStore();
      const m = ctxManifest({ contextContracts: { 'user-profile': { contractVersion: '2.0', fields: { displayName: 'string' } } } });
      await expect(importManifest(client, ROOT, m, opts()))
        .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/written against contract v2.0 but this instance publishes v1.0/)]) });
    });

    it('accepts a MINOR contract difference (an added optional field is not a break)', async () => {
      const { client } = fakeSsmStore();
      const m = ctxManifest({ contextContracts: { 'user-profile': { contractVersion: '1.5', fields: { displayName: 'string' } } } });
      await expect(importManifest(client, ROOT, m, opts())).resolves.toBeDefined();
    });

    it('FAILS CLOSED when the target catalog cannot be read', async () => {
      // An unverifiable selection must not land. Compare: a permissive fallback would import a profile
      // whose context may not exist on this instance at all.
      const { client } = fakeSsmStore();
      const boom = async () => { throw new Error('ssm exploded'); };
      await expect(importManifest(client, ROOT, ctxManifest(), opts({ contextSourceCatalog: boom })))
        .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/could not be read.*refusing to land/s)]) });
    });

    it('does not consult the catalog when the manifest selects no sources', async () => {
      const { client } = fakeSsmStore();
      const spy = jest.fn(CONTEXT_SOURCES);
      const m = ctxManifest({ body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' } });
      await importManifest(client, ROOT, m, opts({ contextSourceCatalog: spy }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

});
