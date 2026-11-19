/**
 * A PROCESS IS EXPORTED, IMPORTED AND RE-CHECKED THROUGH THE PROFILE API (SPEC-PROCESSES P13).
 *
 *  - `/process-export` answers one process of the active (or draft) version as its own manifest, with its requirements.
 *  - `/process-import` lands the process in the owner's draft, never the active version, and only where this deployment has
 *    what it requires; otherwise it answers every refusal as a code with the missing names and writes nothing.
 *  - `/activate` checks a draft's processes again, so a draft whose process needs what the deployment no longer has (an
 *    assistant's intent withdrawn since the import) is refused with the same codes and nothing serving changes.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { edgeContext } from '../helpers/edge-context';

/** In-memory S3, the profile body store the persona and pack are offloaded to, as on a deployment. */
const mockS3Objects = new Map<string, string>();
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  class S3Client {
    async send(cmd: { constructor: { name: string }; input: { Bucket: string; Key: string; Body?: string } }): Promise<unknown> {
      const addr = `${cmd.input.Bucket}/${cmd.input.Key}`;
      if (cmd.constructor.name === 'PutObjectCommand') { mockS3Objects.set(addr, String(cmd.input.Body)); return {}; }
      if (cmd.constructor.name === 'GetObjectCommand') {
        const body = mockS3Objects.get(addr);
        if (body === undefined) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => body } };
      }
      throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
    }
  }
  return { ...actual, S3Client };
});
process.env.PROFILE_BODY_BUCKET = 'profile-bodies';
afterAll(() => { delete process.env.PROFILE_BODY_BUCKET; });
const mockStore: { current: ReturnType<typeof fakeSsmStore> | null } = { current: null };
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: (cmd: unknown) => mockStore.current!.client.send(cmd as never) })) };
});
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  class LambdaClient {
    async send(): Promise<unknown> { return { Payload: Buffer.from(JSON.stringify({ applied: true, entries: 0, regressionEntries: 0, run: null })) }; }
  }
  return { ...actual, LambdaClient };
});
// The names in use are read by path, which the in-memory store does not model; no other assistant holds the ops name here.
jest.mock('../../lambda/src/lib/display-names-in-use', () => ({ displayNameHolder: async () => undefined }));

import { importManifest } from '../../lambda/src/lib/profile-manifest';
import { activateDraft, getDraft, isKnownProfile, listProfile } from '../../lambda/src/lib/profile-lifecycle';
import { projectAdvertisement, advertisementParamName, __resetAdvertisementCacheForTests } from '../../lambda/src/lib/assistant-advertisement';
import { buildProcessManifest, type ProcessManifest } from '../../lambda/src/lib/process-manifest';
import { opsAssistantManifest, opsIncidentProcess, OPS_ASSISTANT } from '../../../demo/portable-assistants/ops-assistant-manifest';
import { stratumIntentPack } from '../../../demo/stratum-company/intent-packs';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { handler } from '../../lambda/src/manage-profiles';

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const GUARDRAILS = async () => [{ key: 'default', guardrailId: 'gr-default' }];
const CONTEXT_SOURCES = async () => [{ key: 'user-profile', contractVersion: '1.0', fields: { displayName: { type: 'string' } } }];

function evt(route: string, body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: route,
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'u-1', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}
const parse = (r: { body: string }) => JSON.parse(r.body);
const client = () => mockStore.current!.client;

/** The primary's published advertisement: what its active version offers another assistant. */
async function publishAdvisor(intents?: string[]): Promise<void> {
  const ad = projectAdvertisement({ assistant: 'advisor', pack: stratumIntentPack('premium') });
  const shown = intents ? { ...ad, intents: ad.intents.filter((i) => intents.includes(i.key)) } : ad;
  await client().send(new PutParameterCommand({ Name: advertisementParamName(ROOT, 'advisor'), Value: JSON.stringify(shown), Type: 'String', Overwrite: true }));
  __resetAdvertisementCacheForTests();
}

/** The incident response process as the ops team exports it. */
function processManifest(): ProcessManifest {
  return buildProcessManifest({
    ownerProfileName: OPS_ASSISTANT, processName: 'incident-response',
    body: { eventWorkflows: opsAssistantManifest().body.eventWorkflows, processes: opsIncidentProcess() },
    provenance: { sourceProfileName: OPS_ASSISTANT, sourceVersion: 'active', exportedConfigId: 'abcabcabcabc' },
  })!;
}

/** The ops assistant's version, active, with no process: as its assistant manifest imports it. */
async function activeOpsAssistant(): Promise<void> {
  const draft = await importManifest(client(), ROOT, opsAssistantManifest(), {
    catalog: CATALOG, knownProfile: isKnownProfile, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES as never,
    actor: 'operator', targetProfileName: OPS_ASSISTANT,
  });
  await activateDraft(client(), ROOT, OPS_ASSISTANT, CATALOG, 'operator', CONTEXT_SOURCES, GUARDRAILS, draft.configId);
}

beforeEach(async () => {
  mockStore.current = fakeSsmStore();
  mockS3Objects.clear();
  await client().send(new PutParameterCommand({ Name: `${ROOT}/assistant/premium/context-sources`, Value: JSON.stringify([{ key: 'user-profile' }]), Type: 'String' }));
  await activeOpsAssistant();
  await publishAdvisor();
});

describe('the deployment\'s roles are read as validation reads them', () => {
  it('premium\'s primary is Advisor and its ops role is the ops assistant', () => {
    expect(defaultProfileRegistry.roleAssistantName('premium', 'primary')).toBe('advisor');
    expect(defaultProfileRegistry.roleAssistantName('premium', 'ops')).toBe(OPS_ASSISTANT);
  });
});

describe('/process-import lands a process in the owner\'s draft, never the active version', () => {
  it('where every requirement is met: a draft cloned from the active version holds it, and the active version does not', async () => {
    const res = await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT }));
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toMatchObject({ imported: 'incident-response', profileName: OPS_ASSISTANT, landedAs: 'draft' });
    const draft = await getDraft(client(), ROOT, OPS_ASSISTANT);
    expect(draft?.configId).toBe(parse(res).configId);
    expect(draft?.processes).toEqual(opsIncidentProcess());
    const active = JSON.parse((await client().send(new GetParameterCommand({ Name: `${ROOT}/assistant/${OPS_ASSISTANT}/definition:active` }))).Parameter!.Value!);
    expect(active.processes).toBeUndefined();
  });

  it('into a draft that exists only when replaceConfigId names it, keeping the rest of that draft', async () => {
    const first = await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT }));
    const draftId = parse(first).configId;
    const refused = await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT }));
    expect(refused.statusCode).toBe(409);
    expect(parse(refused)).toMatchObject({ code: 'DRAFT_EXISTS', configId: draftId });
    const again = await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT, replaceConfigId: draftId }));
    expect(again.statusCode).toBe(200);
    expect((await getDraft(client(), ROOT, OPS_ASSISTANT))?.processes).toEqual(opsIncidentProcess());
  });

  it('DENY: where the primary\'s active version does not advertise an intent asked, every refusal is a code and nothing is written', async () => {
    await publishAdvisor(['impacted_accounts']);
    const res = await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT }));
    expect(res.statusCode).toBe(422);
    expect(parse(res).code).toBe('PROCESS_REQUIREMENTS_UNMET');
    expect(parse(res).refusals).toEqual([
      { code: 'PROCESS_REQ_INTENT', type: 'customer-messaging', role: 'primary', intent: 'customer_notice_draft', assistant: 'advisor' },
    ]);
    expect(await getDraft(client(), ROOT, OPS_ASSISTANT)).toBeNull();
  });

  it('DENY: an owner whose version lacks a linked workflow is refused by name, however the manifest was written', async () => {
    const m = processManifest();
    const edited = buildProcessManifest({
      ownerProfileName: OPS_ASSISTANT, processName: 'incident-response',
      body: { eventWorkflows: { ...opsAssistantManifest().body.eventWorkflows, 'not-here': { on: 'conversation-opened', types: ['ops'], initial: 'done', states: { done: { disposition: 'success' } } } }, processes: { 'incident-response': { ...m.process, workflows: [...m.process.workflows, 'not-here'] } } },
      provenance: m.provenance,
    })!;
    const res = await handler(evt('/admin/profiles/process-import', { manifest: edited, profileName: OPS_ASSISTANT }));
    expect(res.statusCode).toBe(422);
    expect(parse(res).refusals).toEqual([{ code: 'PROCESS_REQ_WORKFLOW', workflow: 'not-here' }]);
    expect(await getDraft(client(), ROOT, OPS_ASSISTANT)).toBeNull();
  });

  it('DENY: a manifest edited since export, or one naming no assistant here, writes nothing', async () => {
    const m = processManifest();
    const tampered = await handler(evt('/admin/profiles/process-import', { manifest: { ...m, requires: { ...m.requires, assistantRoles: [] } }, profileName: OPS_ASSISTANT }));
    expect(tampered.statusCode).toBe(422);
    expect(parse(tampered)).toMatchObject({ code: 'PROCESS_MANIFEST_REFUSED', refusals: [{ code: 'PROCESS_MANIFEST_HASH' }] });
    // The owner is the assistant the request names, else the manifest's; neither names one here.
    const res = await handler(evt('/admin/profiles/process-import', { manifest: { ...m, ownerProfileName: 'nobody-here' } }));
    expect(res.statusCode).toBe(422);
    expect(parse(res).refusals).toEqual([{ code: 'PROCESS_OWNER_UNKNOWN', assistant: 'nobody-here' }]);
    expect(await getDraft(client(), ROOT, OPS_ASSISTANT)).toBeNull();
  });
});

describe('/process-export answers one process as its own manifest', () => {
  it('of the draft, with the same requirements and hash as the manifest it was imported from', async () => {
    await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT }));
    const res = await handler(evt('/admin/profiles/process-export', { profileName: OPS_ASSISTANT, processName: 'incident-response', draft: true }));
    expect(res.statusCode).toBe(200);
    const { manifest } = parse(res);
    expect(manifest).toMatchObject({ kind: 'process', ownerProfileName: OPS_ASSISTANT, processName: 'incident-response', process: opsIncidentProcess()['incident-response'] });
    expect(manifest.requires).toEqual(processManifest().requires);
    expect(manifest.contentHash).toBe(processManifest().contentHash);
  });

  it('of the active version, where it declares none, is PROCESS_NOT_FOUND', async () => {
    const res = await handler(evt('/admin/profiles/process-export', { profileName: OPS_ASSISTANT, processName: 'incident-response' }));
    expect(res.statusCode).toBe(404);
    expect(parse(res)).toMatchObject({ code: 'PROCESS_NOT_FOUND', refusals: [{ code: 'PROCESS_NOT_FOUND', process: 'incident-response' }] });
  });
});

describe('/activate checks a draft\'s processes again', () => {
  it('activates a draft whose process is still met', async () => {
    const imported = await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT }));
    const res = await handler(evt('/admin/profiles/activate', { profileName: OPS_ASSISTANT, configId: parse(imported).configId }));
    expect(res.statusCode).toBe(200);
  });

  it('DENY: refuses with the same codes once an assistant withdrew an intent the process asks, and nothing serving changes', async () => {
    const imported = await handler(evt('/admin/profiles/process-import', { manifest: processManifest(), profileName: OPS_ASSISTANT }));
    const before = (await listProfile(client(), ROOT, OPS_ASSISTANT)).activeVersion;
    // The primary's advertisement is gone since: its role's assistant offers nothing to another assistant now.
    await client().send(new DeleteParameterCommand({ Name: advertisementParamName(ROOT, 'advisor') }));
    __resetAdvertisementCacheForTests();
    const res = await handler(evt('/admin/profiles/activate', { profileName: OPS_ASSISTANT, configId: parse(imported).configId }));
    expect(res.statusCode).toBe(409);
    expect(parse(res).code).toBe('PROCESS_REQUIREMENTS_UNMET');
    expect(parse(res).refusals).toEqual(expect.arrayContaining([
      { code: 'PROCESS_REQ_INTENT', type: 'customer-messaging', role: 'primary', intent: 'customer_notice_draft', assistant: 'advisor', process: 'incident-response' },
      { code: 'PROCESS_REQ_INTENT', type: 'ops', role: 'primary', intent: 'impacted_accounts', assistant: 'advisor', process: 'incident-response' },
    ]));
    expect((await listProfile(client(), ROOT, OPS_ASSISTANT)).activeVersion).toBe(before);
    expect((await getDraft(client(), ROOT, OPS_ASSISTANT))?.configId).toBe(parse(imported).configId);
  });
});
