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
    await seedActiveVersion(client, 'analyst', 'titan');
    const manifest = await exportManifest(client, ROOT, 'analyst');
    const json = JSON.stringify(manifest);
    // The account-id sweep runs over the manifest MINUS its two hex digests. `configId` is 12 hex
    // characters, so roughly one in 140 of them is all decimal digits and reads exactly like an
    // account id to a `\d{12}` scan - a fixture-dependent failure that says nothing about
    // portability. The digests are checked for their own shape below instead.
    const { contentHash: _h, provenance: { exportedConfigId: _c, ...prov }, ...rest } = manifest;
    const scanned = JSON.stringify({ ...rest, provenance: prov });
    expect(manifest.kind).toBe('assistant-profile');
    expect(manifest.body.modelKey).toBe('titan'); // logical catalog key, not an ARN
    expect(json).not.toMatch(/arn:aws/);
    expect(scanned).not.toMatch(/\b\d{12}\b/); // no 12-digit account id
    expect(manifest.provenance.exportedConfigId).toMatch(/^[0-9a-f]{12}$/);
    expect(json).not.toMatch(/us-east-1|us-west-2/); // no region
    expect(manifest.provenance.sourceProfileName).toBe('analyst');
    expect(manifest.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips: export from A, import into B lands as a DRAFT (never active), then activate serves it', async () => {
    const a = fakeSsmStore();
    await seedActiveVersion(a.client, 'advisor', 'opus');
    const manifest = await exportManifest(a.client, ROOT, 'advisor');

    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.modelKey).toBe('opus');
    // Landed as a DRAFT — nothing is active on B yet.
    const listing = await listProfile(b.client, ROOT, 'advisor');
    expect(listing.activeVersion).toBeNull();
    expect(listing.hasDraft).toBe(true);
    // Provenance audit chain preserved.
    expect((draft as unknown as Record<string, unknown>).provenance).toBeTruthy();
    // A human activation is still required (P1 lifecycle).
    const r = await activateDraft(b.client, ROOT, 'advisor', CATALOG, ACTOR);
    expect(r.version).toBe(1);
  });

  it('a manifest cannot carry task graphs onto a version, and the OLD wait spelling still resolves', async () => {
    // THIS TEST CHANGED SHAPE WITH THE DECISION IT GUARDS. It used to prove that a version's own
    // `machines` survived export, import and activation - the round trip that kept a deployment's
    // legacy machine working. Task graphs are global workflows now: a version
    // neither defines nor carries them, so the round trip it protected no longer exists, and IMPORT is
    // the other door into per-assistant graphs that had to be closed alongside the edit path.
    //
    // What survives is the half that still matters: a machine whose wait is spelled the OLD way must
    // still resolve to the same reference the declared form does (SPEC-TASK-STATE-TRANSITIONS 12.6),
    // because a deployment whose CLASSIFICATION pack predates the declared form keeps running.
    const legacyMachines = {
      report_generation: {
        initial: 'collecting_requirements',
        states: {
          collecting_requirements: {
            transitions: ['generating'],
            awaitsUser: true,
            requires: ['the audience'],
          },
          generating: { transitions: ['completed'], produces: 'document' as const },
          completed: { transitions: [], terminal: 'success' },
        },
      },
    };

    // A manifest that arrives carrying graphs lands a draft without them - not a rejection, because
    // the manifest is otherwise valid and a target that refused it could never accept a body exported
    // from a deployment that predates this rule.
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'assistant-profile',
      profileName: 'analyst',
      body: {
        // `sonnet`, not `opus`: the target is `analyst`, which serves `standard`, and a premium-only
        // model is now refused on a standard target. This case is about machines being dropped, so it
        // must not also be exercising the model boundary.
        modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full',
        machines: legacyMachines,
      },
      provenance: { sourceProfileName: 'analyst', sourceVersion: 'active', exportedConfigId: 'x' },
      contentHash: 'deadbeef',
    };
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.machines).toBeUndefined();
    const activated = await activateDraft(b.client, ROOT, 'analyst', CATALOG, ACTOR);
    expect(activated.version).toBe(1);

    // The reader still understands the old spelling, wherever the graph now lives.
    expect(awaitedPartyOf(legacyMachines.report_generation.states.collecting_requirements as never))
      .toEqual({ party: 'requester' });
  });

  it('rejects a manifest whose model is not in the target catalog (never widens the allowlist, §7)', async () => {
    const { client } = fakeSsmStore();
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'assistant-profile',
      profileName: 'analyst',
      body: { modelKey: 'some-unlisted-model', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' },
      provenance: { sourceProfileName: 'analyst', sourceVersion: 'active', exportedConfigId: 'x' },
      contentHash: 'deadbeef',
    };
    await expect(importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/not in the target's model catalog/)]) });
  });

  it('rejects an image model the target classification is not allowed (one rule for every model)', async () => {
    const { client } = fakeSsmStore();
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'assistant-profile',
      profileName: 'analyst',
      body: { modelKey: 'sonnet', models: { default: 'sonnet', image: 'stability_image_core' } },
      provenance: { sourceProfileName: 'advisor', sourceVersion: 'active', exportedConfigId: 'x' },
      contentHash: 'x',
    };
    await expect(importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/models\.image .*not selected by the standard classification/)]) });
  });

  it('lands a draft without the routes the target cannot invoke, so it can be activated', async () => {
    const { client } = fakeSsmStore();
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'assistant-profile',
      profileName: 'analyst',
      body: { modelKey: 'sonnet', models: { default: 'sonnet', byIntent: { general: { primary: 'haiku' }, strategic_analysis: { primary: 'opus', fallback: 'sonnet' } } } },
      provenance: { sourceProfileName: 'advisor', sourceVersion: 'active', exportedConfigId: 'x' },
      contentHash: 'x',
    };
    const draft = await importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.models?.byIntent).toEqual({ general: { primary: 'haiku' } });
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
    // THE SOURCE IS THE BASIC ASSISTANT, NOT THE PREMIUM ONE, and the swap is the finding rather than
    // a convenience. This read `advisor` (premium) remapped onto `analyst` (standard) and asserted the
    // draft kept `opus` - a premium-only model landing on a standard target, which is the defect the
    // case below now locks out. Re-pointing it at `sonnet` was not enough either: export backfills the
    // COMPLETE models bundle (`ensureModelsBundle`), so a premium profile's per-intent routes name
    // premium models whatever its base key is, and the whole bundle is judged. A premium definition
    // therefore cannot land on a standard target without hand-editing the manifest, which §5 names as
    // the intended operator workflow. What remains a pure remap is a source whose every selection the
    // target also declares.
    await seedActiveVersion(src.client, 'concierge', 'haiku');
    const manifest = await exportManifest(src.client, ROOT, 'concierge');
    const { client } = fakeSsmStore();
    const draft = await importManifest(client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR, targetProfileName: 'analyst' });
    expect(draft.profileName).toBe('analyst');
    expect((await getDraft(client, ROOT, 'analyst'))!.modelKey).toBe('haiku');
  });

  /**
   * THE REMAP CANNOT CARRY A MODEL THE TARGET CLASSIFICATION IS DENIED.
   *
   * The deployment catalog is shared by every classification, so `mk in catalog` - all this checked
   * once - is true for a premium-only model on a standard target. The deployed importer accepted
   * `advisor`'s opus definition onto `analyst` and answered `{"imported":"analyst","landedAs":"draft"}`;
   * activating that draft degrades every turn on an AccessDenied, because standard's processor role is
   * denied opus by IAM (`a-classification-is-denied-a-model-it-does-not-declare.spec.ts` proves the
   * denial against AWS). §7 says reject or remap, never widen, so the refusal belongs at import.
   *
   * The ACCEPTING case above is half of this pair: without it, an importer that refused every remap
   * would satisfy this test and break the feature.
   */
  it('rejects a remap carrying a model the TARGET classification does not declare', async () => {
    const src = fakeSsmStore();
    await seedActiveVersion(src.client, 'advisor', 'opus');
    const manifest = await exportManifest(src.client, ROOT, 'advisor');
    const { client } = fakeSsmStore();
    await expect(importManifest(client, ROOT, manifest, {
      catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS,
      contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR, targetProfileName: 'analyst',
    })).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.stringMatching(/'opus' is not available to the target classification 'standard'/),
      ]),
    });
    // AND IT LANDED NOTHING. A refusal that still wrote the draft would leave the unreachable model
    // one activation away, which is the state the refusal exists to prevent.
    expect(await getDraft(client, ROOT, 'analyst')).toBeNull();
  });

  it('export carries a COMPLETE editable models bundle (not just a hash) so the manifest can be hand-edited', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'analyst', 'sonnet');
    const manifest = await exportManifest(client, ROOT, 'analyst');
    expect(manifest.body.models?.default).toBe('sonnet');
    expect(manifest.body.models?.classifier).toBeDefined(); // explicit (the 'default' sentinel), not absent
    expect(Object.keys(manifest.body.models?.byIntent ?? {}).length).toBeGreaterThan(0);
  });

  it('ACCEPTS a hand-edited (contentHash-mismatched) UNSIGNED manifest — export→edit→import is the workflow', async () => {
    const src = fakeSsmStore();
    await seedActiveVersion(src.client, 'advisor', 'opus');
    const manifest = await exportManifest(src.client, ROOT, 'advisor');
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
    await seedActiveVersion(client, 'advisor', 'opus', { guardrailId: 'gr-target-strict' });
    const manifest = await exportManifest(client, ROOT, 'advisor', undefined, GUARDRAILS);
    expect(manifest.body.guardrailId).toBe('strict');
    // The instance-agnostic promise this field used to break: an opaque resolved id is not an ARN, not
    // an account id, and not a region, so the existing check could never have caught it.
    expect(JSON.stringify(manifest)).not.toContain('gr-target-strict');
  });

  it('export→import across instances round-trips the SELECTION onto the target\'s own guardrail', async () => {
    const a = fakeSsmStore();
    await seedActiveVersion(a.client, 'advisor', 'opus', { guardrailId: 'gr-source-abc123' });
    // Instance A resolves 'strict' to its own id; instance B resolves it to a DIFFERENT one.
    const sourceCatalog = async () => [{ key: 'strict', guardrailId: 'gr-source-abc123' }];
    const manifest = await exportManifest(a.client, ROOT, 'advisor', undefined, sourceCatalog);
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.guardrailId).toBe('gr-target-strict'); // B's id, not A's — no manual edit needed
  });

  it('export without a catalog emits the selection verbatim (no throw, import stays the gate)', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'advisor', 'opus', { guardrailId: 'gr-target-strict' });
    const manifest = await exportManifest(client, ROOT, 'advisor');
    expect(manifest.body.guardrailId).toBe('gr-target-strict');
  });

  it('export does not fail when the guardrail catalog is unreadable', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'advisor', 'opus', { guardrailId: 'gr-target-strict' });
    const unreadable = async () => { throw new Error('ParameterNotFound'); };
    await expect(exportManifest(client, ROOT, 'advisor', undefined, unreadable)).resolves.toBeTruthy();
  });

  // GUARDRAIL SELECTION (§7 reject-or-remap). `guardrailId` is a deployment-RESOLVED id, so it is the
  // one cross-deployment reference that cannot survive a move unchanged. Left unchecked it landed a
  // draft whose guardrail can never be applied — and because the apply path falls back to the
  // deployment default, the damage is silent: the assistant runs, just not under the guardrail the
  // profile says it selected.
  it('REMAPS a guardrail selection key to this instance\'s resolved id (what makes it portable)', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'advisor', 'opus');
    const manifest = await exportManifest(client, ROOT, 'advisor');
    manifest.body.guardrailId = 'strict'; // the stable key, not an id
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.guardrailId).toBe('gr-target-strict');
  });

  it('ACCEPTS a guardrail id already provisioned on this target, unchanged', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'advisor', 'opus');
    const manifest = await exportManifest(client, ROOT, 'advisor');
    manifest.body.guardrailId = 'gr-target-default';
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR });
    expect(draft.guardrailId).toBe('gr-target-default');
  });

  it('REJECTS a guardrail id from ANOTHER deployment rather than landing an unappliable selection', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'advisor', 'opus');
    const manifest = await exportManifest(client, ROOT, 'advisor');
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
    await seedActiveVersion(client, 'advisor', 'opus');
    const manifest = await exportManifest(client, ROOT, 'advisor');
    manifest.body.guardrailId = 'strict';
    const b = fakeSsmStore();
    const unreadable = async () => { throw new Error('ParameterNotFound'); };
    await expect(importManifest(b.client, ROOT, manifest, { catalog: CATALOG, knownProfile: known, guardrailCatalog: unreadable, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toThrow(/cannot validate the guardrail selection/);
  });

  it('a manifest with NO guardrail selection imports untouched (inherits the deployment default)', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'advisor', 'opus');
    const manifest = await exportManifest(client, ROOT, 'advisor');
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
    await seedActiveVersion(client, 'analyst', 'titan');
    const manifest = await exportManifest(client, ROOT, 'analyst');
    expect(manifest.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it('imports a validly-signed manifest and REJECTS a tampered one', async () => {
    process.env.MANIFEST_SIGNING_SECRET = SECRET;
    const src = fakeSsmStore();
    await seedActiveVersion(src.client, 'advisor', 'opus');
    const manifest = await exportManifest(src.client, ROOT, 'advisor');

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
      schemaVersion: MANIFEST_SCHEMA_VERSION, kind: 'assistant-profile', profileName: 'analyst',
      body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' },
      provenance: { sourceProfileName: 'analyst', sourceVersion: 'active', exportedConfigId: 'x' }, contentHash: 'x',
    };
    await expect(importManifest(client, ROOT, unsigned, { catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR }))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/unsigned/)]) });
  });

  it('rejects a signed manifest when this instance has no secret to verify with', async () => {
    // exporter signed with a secret; importer has none configured → cannot verify → reject (never trust).
    const signed = {
      schemaVersion: MANIFEST_SCHEMA_VERSION, kind: 'assistant-profile', profileName: 'analyst',
      body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full' },
      provenance: { sourceProfileName: 'analyst', sourceVersion: 'active', exportedConfigId: 'x' }, contentHash: 'x',
      signature: signManifest({ profileName: 'analyst' }, SECRET),
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
      profileName: 'analyst',
      body: { modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full', contextSources: ['user-profile'] },
      provenance: { sourceProfileName: 'analyst', sourceVersion: 'active', exportedConfigId: 'x' },
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

describe('an import never moves an assistant (classification, role, reach and owner are not part of a profile)', () => {
  const opts = (targetProfileName?: string) => ({
    catalog: CATALOG, knownProfile: known, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR,
    ...(targetProfileName ? { targetProfileName } : {}),
  });

  it.each([
    ['classification', { classification: 'basic' }],
    ['role', { role: 'ops' }],
    ['grants', { grants: ['premium'] }],
    ['reach', { reach: ['context/finance/'] }],
    ['ownerTeam', { ownerTeam: 'finance' }],
  ])('refuses a manifest whose body carries %s, by name, and lands nothing', async (key, extra) => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'analyst', 'titan');
    const manifest = await exportManifest(client, ROOT, 'analyst');
    const tampered = { ...manifest, body: { ...manifest.body, ...extra } };
    const before = await getDraft(client, ROOT, 'analyst');
    await expect(importManifest(client, ROOT, tampered, opts()))
      .rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringContaining(`${key} is not part of a profile`)]) });
    expect(await getDraft(client, ROOT, 'analyst')).toEqual(before);
  });

  it('refuses the same keys beside the body, where a hand-edited manifest might put them', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'analyst', 'titan');
    const manifest = await exportManifest(client, ROOT, 'analyst');
    await expect(importManifest(client, ROOT, { ...manifest, classification: 'premium', ownerTeam: 'finance' }, opts()))
      .rejects.toMatchObject({ errors: expect.arrayContaining([
        expect.stringContaining('classification is not part of a profile'),
        expect.stringContaining('ownerTeam is not part of a profile'),
      ]) });
  });

  it('lands a clean manifest on its target, whose classification it does not change', async () => {
    const { client } = fakeSsmStore();
    await seedActiveVersion(client, 'analyst', 'titan');
    const { classificationServedBy } = await import('../../lambda/src/lib/profile-lifecycle');
    const before = classificationServedBy('analyst');
    const manifest = await exportManifest(client, ROOT, 'analyst');
    const draft = await importManifest(client, ROOT, manifest, opts('analyst'));
    expect(draft.profileName).toBe('analyst');
    for (const k of ['classification', 'role', 'grants', 'reach', 'ownerTeam']) expect(draft).not.toHaveProperty(k);
    expect(classificationServedBy('analyst')).toBe(before);
  });
});
