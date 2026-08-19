/**
 * The gap this closes, asserted end to end: a persona LARGER THAN THE PARAMETER IT USED TO LIVE IN.
 *
 * `MAX_PERSONA_LENGTH` is 20000 and an SSM Standard-tier parameter holds 4096 characters for the whole
 * serialized definition, so a persona in that gap passed schema validation and then died at
 * PutParameter. Every test here is impossible against the pre-indirection code; the first one is the
 * proof the gap is shut.
 *
 * The rest pin the properties that make the indirection safe rather than merely present:
 *  - a definition written BEFORE the pointer existed still resolves, with no migration;
 *  - a body that cannot be read falls back to the compiled SEED, never to a personaless profile;
 *  - rollback re-points at an existing body and writes nothing;
 *  - an export INLINES the body and stays instance-agnostic, and import lands it in the TARGET's store;
 *  - storage never changes a version's identity: the same persona hashes to the same configId inline or
 *    offloaded, so migrating storage does not re-key analytics.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { createDraft, editDraft, activateDraft, activateExistingVersion } from '../../lambda/src/lib/profile-lifecycle';
import {
  resolveActiveProfile,
  __clearActiveProfileCache,
  serializeSeedDefinition,
  definitionParamName,
  buildDefinition,
  bodyFrom,
  type ProfileDefinition,
} from '../../lambda/src/lib/active-profile';
import { exportManifest, importManifest } from '../../lambda/src/lib/profile-manifest';
import { offloadBodies, hydrateBodies } from '../../lambda/src/lib/profile-bodies';
import { seedActiveProfileDefinition, SSM_STANDARD_TIER_MAX } from '../../lambda/src/lib/seed-profile-definitions';
import { PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

/** In-memory S3. Named `mock*` so jest's hoisted factory may close over it. */
const mockS3Objects = new Map<string, string>();
const mockS3Calls: Array<{ verb: 'put' | 'get'; bucket: string; key: string }> = [];
let mockS3GetError: Error | null = null;

jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    constructor(public input: { Bucket: string; Key: string; Body: string }) {}
  }
  class GetObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  class S3Client {
    async send(cmd: PutObjectCommand | GetObjectCommand): Promise<unknown> {
      const addr = `${cmd.input.Bucket}/${cmd.input.Key}`;
      if (cmd instanceof PutObjectCommand) {
        mockS3Calls.push({ verb: 'put', bucket: cmd.input.Bucket, key: cmd.input.Key });
        mockS3Objects.set(addr, cmd.input.Body);
        return {};
      }
      mockS3Calls.push({ verb: 'get', bucket: cmd.input.Bucket, key: cmd.input.Key });
      if (mockS3GetError) throw mockS3GetError;
      const body = mockS3Objects.get(addr);
      if (body === undefined) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => body } };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const ACTOR = 'admin-sub-123';
const BUCKET = 'ae-attachments';

/** Comfortably past the 4096-character parameter limit, comfortably inside MAX_PERSONA_LENGTH.
 *  Trimmed at the source because the seed path normalises whitespace before hashing. */
const BIG_PERSONA = `You are the Stratum Technologies assistant. ${'Ground every answer in company policy. '.repeat(250)}`.trim();

beforeEach(() => {
  __clearActiveProfileCache();
  mockS3Objects.clear();
  mockS3Calls.length = 0;
  mockS3GetError = null;
  process.env.PROFILE_BODY_BUCKET = BUCKET;
});
afterAll(() => {
  delete process.env.PROFILE_BODY_BUCKET;
});

/** The raw value sitting on a parameter, as SSM would hold it. */
function storedValue(store: Map<string, Array<{ value: string }>>, name: string): string {
  const vers = store.get(name);
  if (!vers?.length) throw new Error(`nothing stored at ${name}`);
  return vers[vers.length - 1].value;
}

describe('a persona too large for the parameter', () => {
  it('round-trips: edit, activate, and resolve with it intact', async () => {
    expect(BIG_PERSONA.length).toBeGreaterThan(SSM_STANDARD_TIER_MAX);
    const { client, store } = fakeSsmStore();

    await createDraft(client, ROOT, 'standard', ACTOR);
    await editDraft(client, ROOT, 'standard', { persona: BIG_PERSONA }, ACTOR);
    await activateDraft(client, ROOT, 'standard', CATALOG, ACTOR);

    // The resolved profile answers with the whole persona.
    __clearActiveProfileCache();
    const resolved = await resolveActiveProfile('standard', { ssm: client, ssmRoot: ROOT });
    expect(resolved.persona).toBe(BIG_PERSONA);
    expect(resolved.configId).not.toBe('seed');

    // And the parameter itself is small: the persona is not in it, a pointer is.
    const raw = storedValue(store, definitionParamName(ROOT, 'standard'));
    expect(raw.length).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
    const stored = JSON.parse(raw) as ProfileDefinition;
    expect(stored.persona).toBeUndefined();
    expect(stored.personaRef?.key).toBe(`profiles/standard/${stored.configId}/persona`);
  });

  it('is not what the parameter cap measures any more (the pre-change write is what failed)', async () => {
    // Same content, no body store: the definition must be REJECTED with the actionable message rather
    // than sent to AWS to fail as an opaque ValidationException. This is the behaviour that remains for
    // a deployment with no bucket wired, and it is what the offload replaces.
    delete process.env.PROFILE_BODY_BUCKET;
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', ACTOR);
    await expect(editDraft(client, ROOT, 'standard', { persona: BIG_PERSONA }, ACTOR))
      .rejects.toThrow(/over the 4096-character SSM Standard-tier limit/);
  });

  it('keeps the version identity: offloading does not change the configId', async () => {
    // configId is the attribution key analytics slices by, and it is the hash of the body INCLUDING the
    // persona. If moving the persona out changed it, migrating a deployment onto the body store would
    // split one version's history into two ids and invalidate every exported manifest.
    const body = { ...bodyFrom(JSON.parse(serializeSeedDefinition('standard') as string)), persona: BIG_PERSONA };
    const inline = buildDefinition('standard', body);
    const offloaded = await offloadBodies(inline);
    expect(offloaded.configId).toBe(inline.configId);
    expect(offloaded.persona).toBeUndefined();
    // And the key it was filed under is that same id, which is what makes the pointer verifiable.
    expect(offloaded.personaRef?.configId).toBe(inline.configId);
    expect(await hydrateBodies(offloaded)).toEqual(inline);
  });
});

describe('back-compat and failure', () => {
  it('a definition written BEFORE the indirection (inline persona) still resolves', async () => {
    const { client } = fakeSsmStore();
    // Exactly the shape live deployments hold today: persona inline, no pointer, nothing in S3.
    const legacy = JSON.parse(serializeSeedDefinition('standard', 'I am the legacy persona.') as string) as ProfileDefinition;
    expect(legacy.persona).toBe('I am the legacy persona.');
    await seedRaw(client, 'standard', legacy);

    __clearActiveProfileCache();
    const resolved = await resolveActiveProfile('standard', { ssm: client, ssmRoot: ROOT });
    expect(resolved.persona).toBe('I am the legacy persona.');
    // No pointer ⇒ no S3 call at all, so an existing deployment needs no bucket to keep working.
    expect(mockS3Calls).toEqual([]);
  });

  it('an unreadable body falls back to the SEED, never to a personaless profile', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', ACTOR);
    await editDraft(client, ROOT, 'standard', { persona: BIG_PERSONA, rateLimitPerHour: 777 }, ACTOR);
    await activateDraft(client, ROOT, 'standard', CATALOG, ACTOR);

    mockS3GetError = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    __clearActiveProfileCache();
    const resolved = await resolveActiveProfile('standard', { ssm: client, ssmRoot: ROOT });

    // The whole version is refused, not just its persona: serving the rest would run an assistant that
    // reports this configId while answering as the generic default.
    expect(resolved.configId).toBe('seed');
    expect(resolved.persona).toBeUndefined();
    expect(resolved.profile.rateLimitPerHour).not.toBe(777);
  });

  it('rollback re-points at an existing body and writes nothing', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', ACTOR);
    await editDraft(client, ROOT, 'standard', { persona: `${BIG_PERSONA} v1` }, ACTOR);
    const v1 = await activateDraft(client, ROOT, 'standard', CATALOG, ACTOR);
    await createDraft(client, ROOT, 'standard', ACTOR);
    await editDraft(client, ROOT, 'standard', { persona: `${BIG_PERSONA} v2` }, ACTOR);
    await activateDraft(client, ROOT, 'standard', CATALOG, ACTOR);

    const putsBefore = mockS3Calls.filter((c) => c.verb === 'put').length;
    await activateExistingVersion(client, ROOT, 'standard', v1.version, ACTOR);
    expect(mockS3Calls.filter((c) => c.verb === 'put').length).toBe(putsBefore);

    // And v1's body survived v2 being written — content-addressing is what makes that true.
    __clearActiveProfileCache();
    expect((await resolveActiveProfile('standard', { ssm: client, ssmRoot: ROOT })).persona).toBe(`${BIG_PERSONA} v1`);
  });
});

describe('portability', () => {
  it('export INLINES the body and names no bucket, account or region', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'standard', ACTOR);
    await editDraft(client, ROOT, 'standard', { persona: BIG_PERSONA }, ACTOR);
    await activateDraft(client, ROOT, 'standard', CATALOG, ACTOR);

    const manifest = await exportManifest(client, ROOT, 'standard');
    expect(manifest.body.persona).toBe(BIG_PERSONA);
    const serialized = JSON.stringify(manifest);
    // A leaked bucket name would aim a target instance at THIS account's storage.
    expect(serialized).not.toContain(BUCKET);
    expect(serialized).not.toContain('personaRef');
    expect(serialized).not.toMatch(/arn:aws|123456789012|us-east-1/);
  });

  it('import lands the body in the TARGET store and keeps a target-local pointer', async () => {
    const source = fakeSsmStore();
    await createDraft(source.client, ROOT, 'standard', ACTOR);
    await editDraft(source.client, ROOT, 'standard', { persona: BIG_PERSONA }, ACTOR);
    await activateDraft(source.client, ROOT, 'standard', CATALOG, ACTOR);
    const manifest = await exportManifest(source.client, ROOT, 'standard');

    // A different instance, with its own bucket.
    process.env.PROFILE_BODY_BUCKET = 'target-instance-attachments';
    const target = fakeSsmStore();
    const draft = await importManifest(target.client, ROOT, manifest, {
      catalog: CATALOG,
      knownProfile: () => true,
      guardrailCatalog: async () => [],
      contextSourceCatalog: async () => [],
      actor: ACTOR,
    });

    const raw = storedValue(target.store, `${ROOT}/assistant/standard/draft`);
    expect(raw.length).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
    const stored = JSON.parse(raw) as ProfileDefinition;
    expect(stored.persona).toBeUndefined();
    expect(stored.personaRef?.configId).toBe(draft.configId);
    // The body is in the TARGET's bucket, under the target's own key.
    expect(mockS3Objects.get(`target-instance-attachments/${stored.personaRef?.key}`)).toBe(BIG_PERSONA);
  });
});

describe('the seeder', () => {
  it('seeds a persona that could never fit in the parameter', async () => {
    const { client, store } = fakeSsmStore();
    const r = await seedActiveProfileDefinition(client, ROOT, 'standard', BIG_PERSONA, { bucket: BUCKET });
    expect(r?.labeled).toBe(true);

    const raw = storedValue(store, definitionParamName(ROOT, 'standard'));
    expect(raw.length).toBeLessThanOrEqual(SSM_STANDARD_TIER_MAX);
    __clearActiveProfileCache();
    expect((await resolveActiveProfile('standard', { ssm: client, ssmRoot: ROOT })).persona).toBe(BIG_PERSONA);
  });

  it('still refuses an oversize definition when the deployment has NO body store', async () => {
    delete process.env.PROFILE_BODY_BUCKET;
    const { client } = fakeSsmStore();
    await expect(seedActiveProfileDefinition(client, ROOT, 'standard', BIG_PERSONA))
      .rejects.toThrow(/over the 4096-char SSM Standard-tier parameter limit/);
  });
});

/** Write a definition verbatim and label it active — the pre-change on-disk shape. */
async function seedRaw(client: ReturnType<typeof fakeSsmStore>['client'], profileName: string, def: ProfileDefinition) {
  const name = definitionParamName(ROOT, profileName);
  const put = await client.send(new PutParameterCommand({ Name: name, Type: 'String', Value: JSON.stringify(def), Overwrite: true }) as never) as unknown as { Version: number };
  await client.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: put.Version, Labels: ['active'] }) as never);
}
