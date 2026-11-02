/**
 * WHERE THE CONSOLE DRAWS EACH WORKFLOW STEP RIDES THE VERSION, AND NOTHING THE VERSION DOES READS IT (ADR-061 decision 7).
 *
 * What it proves: a layout saved with a draft edit is an offloaded body under the version's own key
 * (`profiles/{name}/{configId}/layout/{contentId}`), never inline in the parameter; it changes no `configId`; a step's
 * point is dropped with the step; activation keeps it, a rollback restores the rolled-to version's, and a new version
 * starts from the active one's; export carries it inline outside the body and its hash, and import lands it in the
 * target's store; validation and the runtime never read it; a deployment with no body store keeps none; an unreadable
 * layout reads as none; and its storage takes no grant the manage-profiles role did not already hold.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { PLATFORM_EVENT_WORKFLOWS, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import {
  activateDraft, activateExistingVersion, createDraft, editDraft, getDraft, isKnownProfile, ProfileValidationError, validateDraft,
} from '../../lambda/src/lib/profile-lifecycle';
import { __clearActiveProfileCache, bodyFrom, definitionParamName, resolveActiveProfile, type ProfileDefinition } from '../../lambda/src/lib/active-profile';
import { exportManifest, importManifest } from '../../lambda/src/lib/profile-manifest';
import { canonicalLayout, contentIdOf, layoutKey, offloadBodies } from '../../lambda/src/lib/profile-bodies';
import { layoutFor, workflowLayoutErrors, MAX_LAYOUT_COORDINATE } from '../../lambda/src/lib/workflow-layout';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const mockS3Objects = new Map<string, string>();
const mockS3Calls: Array<{ verb: 'put' | 'get'; key: string }> = [];
jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand { constructor(public input: { Bucket: string; Key: string; Body: string }) {} }
  class GetObjectCommand { constructor(public input: { Bucket: string; Key: string }) {} }
  class S3Client {
    async send(cmd: PutObjectCommand | GetObjectCommand): Promise<unknown> {
      const addr = `${cmd.input.Bucket}/${cmd.input.Key}`;
      if (cmd instanceof PutObjectCommand) {
        mockS3Calls.push({ verb: 'put', key: cmd.input.Key });
        mockS3Objects.set(addr, cmd.input.Body);
        return {};
      }
      mockS3Calls.push({ verb: 'get', key: cmd.input.Key });
      const body = mockS3Objects.get(addr);
      if (body === undefined) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => body } };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command: class {} };
});

const ROOT = '/agent-echelon';
const NAME = 'ops-premium';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const BUCKET = 'ae-attachments';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const OWN: EventWorkflow = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);
const WORKFLOWS = { 'ops-mine': OWN };
const AT = { 'ops-mine': { opening: { x: 40, y: 120 }, 'greet-lead': { x: 40, y: 260 }, 'first-look': { x: 360, y: 260 }, done: { x: 40, y: 400 } } };
const MOVED = { 'ops-mine': { ...AT['ops-mine'], 'first-look': { x: 600, y: 300 } } };
const importOpts = {
  catalog: CATALOG, knownProfile: isKnownProfile, guardrailCatalog: async () => [{ key: 'default', guardrailId: 'g' }],
  contextSourceCatalog: async () => [{ key: 'user-profile', contractVersion: '1.0', fields: { displayName: { type: 'string' }, company: { type: 'string', optional: true } } }],
  actor: 'admin',
};

beforeEach(() => {
  __clearActiveProfileCache();
  mockS3Objects.clear();
  mockS3Calls.length = 0;
  process.env.PROFILE_BODY_BUCKET = BUCKET;
});
afterAll(() => { delete process.env.PROFILE_BODY_BUCKET; });

const latest = (store: Map<string, Array<{ value: string }>>, name: string): ProfileDefinition => {
  const vers = store.get(name)!;
  return JSON.parse(vers[vers.length - 1].value) as ProfileDefinition;
};
const draftName = `${ROOT}/assistant/${NAME}/draft`;

async function draftWithLayout(layout: unknown = AT) {
  const s = fakeSsmStore();
  await createDraft(s.client, ROOT, NAME, 'admin');
  await editDraft(s.client, ROOT, NAME, { modelKey: 'titan', eventWorkflows: WORKFLOWS, layout } as never, 'admin');
  return s;
}

describe('the layout is a body of the version, never inline', () => {
  it('a draft edit stores it under the version\'s own layout key and keeps a pointer in the parameter', async () => {
    const { store } = await draftWithLayout();
    const stored = latest(store, draftName);
    expect(stored.layout).toBeUndefined();
    const body = canonicalLayout(AT);
    expect(stored.layoutRef).toEqual({ key: layoutKey(NAME, stored.configId, contentIdOf(body)), configId: stored.configId });
    expect(stored.layoutRef!.key).toMatch(new RegExp(`^profiles/${NAME}/${stored.configId}/layout/[0-9a-f]{64}$`));
    expect(mockS3Objects.get(`${BUCKET}/${stored.layoutRef!.key}`)).toBe(body);
    expect(JSON.stringify(stored)).not.toMatch(/"x":/);
  });

  it('moving a step changes no configId, and each layout is its own object (a key is written once)', async () => {
    const { client, store } = await draftWithLayout();
    const first = latest(store, draftName);
    await editDraft(client, ROOT, NAME, { layout: MOVED } as never, 'admin');
    const second = latest(store, draftName);
    expect(second.configId).toBe(first.configId);
    expect(second.layoutRef!.key).not.toBe(first.layoutRef!.key);
    expect(mockS3Objects.get(`${BUCKET}/${first.layoutRef!.key}`)).toBe(canonicalLayout(AT));
    expect((await getDraft(client, ROOT, NAME))!.layout).toEqual(MOVED);
  });

  it('an edit that does not name the layout keeps it, and null clears it', async () => {
    const { client, store } = await draftWithLayout();
    await editDraft(client, ROOT, NAME, { displayName: 'Ops' } as never, 'admin');
    expect((await getDraft(client, ROOT, NAME))!.layout).toEqual(AT);
    await editDraft(client, ROOT, NAME, { layout: null } as never, 'admin');
    expect(latest(store, draftName).layoutRef).toBeUndefined();
    expect((await getDraft(client, ROOT, NAME))!.layout).toBeUndefined();
  });

  it('a removed step\'s point is dropped, and so is a workflow the version does not declare', async () => {
    const { client } = await draftWithLayout({ ...AT, ghost: { a: { x: 1, y: 1 } } });
    const shorter = clone(OWN);
    delete shorter.states['greet-lead'];
    shorter.states.opening.onSuccess = 'first-look';
    shorter.states.opening.onFailure = 'first-look';
    await editDraft(client, ROOT, NAME, { eventWorkflows: { 'ops-mine': shorter } } as never, 'admin');
    const { 'greet-lead': _gone, ...rest } = AT['ops-mine'];
    expect((await getDraft(client, ROOT, NAME))!.layout).toEqual({ 'ops-mine': rest });
  });

  it('a malformed layout is refused at the edit, naming the field', async () => {
    const s = fakeSsmStore();
    await createDraft(s.client, ROOT, NAME, 'admin');
    const err = await editDraft(s.client, ROOT, NAME, { layout: { 'ops-mine': { opening: { x: 'left', y: 0 } } } } as never, 'admin').catch((e) => e);
    expect(err).toBeInstanceOf(ProfileValidationError);
    expect((err as ProfileValidationError).errors[0]).toMatch(/layout\.ops-mine\.opening is \{ x, y \}/);
    expect(workflowLayoutErrors({ a: { s: { x: MAX_LAYOUT_COORDINATE + 1, y: 0 } } })).toHaveLength(1);
    expect(workflowLayoutErrors({ a: { s: { x: 1, y: 2, z: 3 } } })).toHaveLength(1);
    expect(workflowLayoutErrors(undefined)).toEqual([]);
  });

  it('with no body store a layout is not kept, and never goes inline', async () => {
    delete process.env.PROFILE_BODY_BUCKET;
    const { store } = await draftWithLayout();
    const stored = latest(store, draftName);
    expect(stored.layout).toBeUndefined();
    expect(stored.layoutRef).toBeUndefined();
    expect(mockS3Calls).toEqual([]);
  });

  it('a pointer whose body cannot be read, or is not the bytes its key names, reads as no layout', async () => {
    const { client, store } = await draftWithLayout();
    const stored = latest(store, draftName);
    mockS3Objects.set(`${BUCKET}/${stored.layoutRef!.key}`, canonicalLayout(MOVED));
    expect((await getDraft(client, ROOT, NAME))!.layout).toBeUndefined();
    mockS3Objects.clear();
    expect((await getDraft(client, ROOT, NAME))!.layout).toBeUndefined();
  });
});

describe('versioned with the draft', () => {
  it('activation keeps it, a rollback restores the rolled-to version\'s, and a new version starts from the active one', async () => {
    const { client, store } = await draftWithLayout();
    const v1 = await activateDraft(client, ROOT, NAME, CATALOG, 'admin');
    const active1 = latest(store, definitionParamName(ROOT, NAME));
    expect(active1.layoutRef?.configId).toBe(v1.configId);

    await createDraft(client, ROOT, NAME, 'admin');
    expect((await getDraft(client, ROOT, NAME))!.layout).toEqual(AT);
    await editDraft(client, ROOT, NAME, { layout: MOVED } as never, 'admin');
    await activateDraft(client, ROOT, NAME, CATALOG, 'admin');

    await activateExistingVersion(client, ROOT, NAME, v1.version, 'admin');
    await createDraft(client, ROOT, NAME, 'admin');
    expect((await getDraft(client, ROOT, NAME))!.layout).toEqual(AT);
  });
});

describe('carried by export and import', () => {
  it('export carries it inline beside the body, outside the body and its hash', async () => {
    const { client } = await draftWithLayout();
    expect((await exportManifest(client, ROOT, NAME, 'draft')).layout).toEqual(AT);
    await activateDraft(client, ROOT, NAME, CATALOG, 'admin');
    const withIt = await exportManifest(client, ROOT, NAME);
    expect(withIt.layout).toEqual(AT);
    expect((withIt.body as unknown as Record<string, unknown>).layout).toBeUndefined();
    expect(JSON.stringify(withIt)).not.toContain('layoutRef');
    const { client: other } = await draftWithLayout(MOVED);
    await activateDraft(other, ROOT, NAME, CATALOG, 'admin');
    expect((await exportManifest(other, ROOT, NAME)).contentHash).toBe(withIt.contentHash);
  });

  it('import lands it in the target\'s store under the target\'s own key, and refuses a malformed one', async () => {
    const { client } = await draftWithLayout();
    await activateDraft(client, ROOT, NAME, CATALOG, 'admin');
    const manifest = await exportManifest(client, ROOT, NAME);
    process.env.PROFILE_BODY_BUCKET = 'target-attachments';
    const target = fakeSsmStore();
    await importManifest(target.client, ROOT, manifest, importOpts as never);
    const stored = latest(target.store, draftName);
    expect(mockS3Objects.get(`target-attachments/${stored.layoutRef!.key}`)).toBe(canonicalLayout(AT));
    const bad = { ...clone(manifest), layout: { 'ops-mine': { opening: [1, 2] } } };
    delete (bad as { signature?: unknown }).signature;
    const err = await importManifest(fakeSsmStore().client, ROOT, bad, importOpts as never).catch((e) => e);
    expect(JSON.stringify(err.errors)).toMatch(/layout\.ops-mine\.opening/);
  });
});

describe('ignored by validation and by the runtime', () => {
  it('validation reads the body alone, so a layout changes no answer', async () => {
    const { client } = await draftWithLayout();
    const a = await validateDraft(client, ROOT, NAME, CATALOG);
    await editDraft(client, ROOT, NAME, { layout: MOVED } as never, 'admin');
    const b = await validateDraft(client, ROOT, NAME, CATALOG);
    expect(b).toEqual(a);
    expect(bodyFrom({ ...(await getDraft(client, ROOT, NAME))! })).not.toHaveProperty('layout');
  });

  it('the runtime resolver never reads a layout', async () => {
    const { client } = await draftWithLayout();
    await activateDraft(client, ROOT, NAME, CATALOG, 'admin');
    mockS3Calls.length = 0;
    __clearActiveProfileCache();
    await resolveActiveProfile(NAME, { ssm: client, ssmRoot: ROOT });
    expect(mockS3Calls.filter((c) => c.key.includes('/layout/'))).toEqual([]);
    const runtime = ['router-agent-handler.ts', 'assistant-async-processor.ts', 'lib/active-profile.ts', 'lib/event-workflow.ts'];
    for (const f of runtime) expect(fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', f), 'utf8')).not.toMatch(/withLayout\(|readLayout\(/);
  });

  it('offload with no layout writes none', async () => {
    const def = { schemaVersion: 1, profileName: NAME, configId: 'abc', modelKey: 'titan' } as unknown as ProfileDefinition;
    await offloadBodies(def);
    expect(mockS3Calls).toEqual([]);
    expect(layoutFor(undefined, WORKFLOWS)).toBeUndefined();
    expect(layoutFor({ 'ops-mine': { opening: { x: 1.4, y: 2.6 } } }, WORKFLOWS)).toEqual({ 'ops-mine': { opening: { x: 1, y: 3 } } });
  });
});

describe('no grant of its own', () => {
  it('the layout key is in the profiles/ family manage-profiles already writes, and the admin plane names no layout grant', () => {
    expect(layoutKey('a', 'b', 'c')).toMatch(/^profiles\//);
    const construct = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'constructs', 'admin-assistant-administration.ts'), 'utf8');
    expect(construct).not.toMatch(/layout/i);
  });
});
