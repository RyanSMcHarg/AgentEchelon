/**
 * A DRAFT IS DISCARDED ONLY AS IT WAS SEEN (SPEC-PORTABLE-PROFILES FR18).
 *
 * What it proves: a discard deletes the draft parameter when the caller names the configId stored there, and
 * nothing else (no definition version, no label, no body or layout object); a draft saved again since is kept
 * and its configId named back; no draft is its own answer; activation still consumes the draft it promoted.
 * The route: `edit-profiles` in both forms on the existing function, a team member's route refuses another
 * assistant's draft, and the deny side: the team console role is never granted the unscoped route, and its
 * session reaches only the assistants it names.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { ADMIN_CAPABILITIES, roleExecuteApiResources } from '../../lib/config/admin-capabilities';
import { ADMIN_CONSOLE_ROLE_NAME } from '../../lib/constructs/admin-role-grants';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { adminApiTemplate, adminServicesTemplate } from '../helpers/synth';
import { edgeContext } from '../helpers/edge-context';

const mockS3Calls: Array<{ verb: string; key: string }> = [];
jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand { constructor(public input: { Key: string }) {} }
  class GetObjectCommand { constructor(public input: { Key: string }) {} }
  class DeleteObjectCommand { constructor(public input: { Key: string }) {} }
  class S3Client {
    async send(cmd: { constructor: { name: string }; input: { Key: string } }): Promise<unknown> {
      mockS3Calls.push({ verb: cmd.constructor.name, key: cmd.input.Key });
      if (cmd instanceof PutObjectCommand) return {};
      throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command: class {} };
});

// The handler's SSM client is the test's in-memory store.
const mockStore: { current: ReturnType<typeof fakeSsmStore> | null } = { current: null };
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: (cmd: unknown) => mockStore.current!.client.send(cmd as never) })) };
});
// A team route's scope. Null, as an admin route resolves, unless a test names one.
const mockScope = jest.fn();
jest.mock('../../lambda/src/lib/assistant-scope', () => {
  const actual = jest.requireActual('../../lambda/src/lib/assistant-scope');
  return { ...actual, requireOwnedAssistant: (...a: unknown[]) => mockScope(...a) };
});

import {
  createDraft, editDraft, activateDraft, discardDraft, getDraft, listProfile,
} from '../../lambda/src/lib/profile-lifecycle';
import { teamSessionPolicy } from '../../lambda/src/admin-credential-exchange';
import { handler } from '../../lambda/src/manage-profiles';

const ROOT = '/agent-echelon';
const ACTOR = 'admin-sub-123';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const verbs = (client: { send: unknown }) => (client.send as jest.Mock).mock.calls.map(([cmd]: [object]) => cmd.constructor.name);

beforeEach(() => { mockS3Calls.length = 0; mockScope.mockReset(); mockScope.mockResolvedValue(null); });

describe('discardDraft', () => {
  it('deletes the draft it was named by configId, and only the draft parameter', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    const { configId } = await editDraft(client, ROOT, 'analyst', { persona: 'THROWAWAY' }, ACTOR);
    (client.send as unknown as jest.Mock).mockClear();
    mockS3Calls.length = 0;

    expect(await discardDraft(client, ROOT, 'analyst', configId, ACTOR)).toEqual({ outcome: 'discarded', configId });
    expect(await getDraft(client, ROOT, 'analyst')).toBeNull();
    expect((await listProfile(client, ROOT, 'analyst')).hasDraft).toBe(false);
    // One read of the envelope, one delete of the draft parameter: no definition written, labeled or deleted,
    // and no body or layout object touched, because both are content-addressed and a version may share them.
    const calls = (client.send as unknown as jest.Mock).mock.calls.slice(0, 2).map(([cmd]: [{ constructor: { name: string }; input: { Name: string } }]) => `${cmd.constructor.name} ${cmd.input.Name}`);
    expect(calls).toEqual([`GetParameterCommand ${ROOT}/assistant/analyst/draft`, `DeleteParameterCommand ${ROOT}/assistant/analyst/draft`]);
    expect(mockS3Calls.filter((c) => c.verb !== 'GetObjectCommand')).toEqual([]);
  });

  it('keeps a draft saved again since the caller read it, and names its configId', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    const seen = await editDraft(client, ROOT, 'analyst', { persona: 'FIRST' }, ACTOR);
    const newer = await editDraft(client, ROOT, 'analyst', { persona: 'SECOND' }, ACTOR);
    expect(newer.configId).not.toBe(seen.configId);

    expect(await discardDraft(client, ROOT, 'analyst', seen.configId, ACTOR)).toEqual({ outcome: 'changed', configId: newer.configId });
    const kept = await getDraft(client, ROOT, 'analyst');
    expect(kept?.configId).toBe(newer.configId);
    expect(kept?.persona).toBe('SECOND');
  });

  it('answers no-draft when there is none, and deletes nothing', async () => {
    const { client } = fakeSsmStore();
    expect(await discardDraft(client, ROOT, 'analyst', 'cfg-anything', ACTOR)).toEqual({ outcome: 'no-draft' });
    expect(verbs(client)).toEqual(['GetParameterCommand']);
  });

  it('leaves activation as it was: the promoted draft is consumed and the version serves', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', ACTOR);
    const { configId } = await editDraft(client, ROOT, 'analyst', { modelKey: 'titan' }, ACTOR);
    const r = await activateDraft(client, ROOT, 'analyst', CATALOG, ACTOR);
    expect(r.configId).toBe(configId);
    expect(await getDraft(client, ROOT, 'analyst')).toBeNull();
    // A discard after activation finds nothing, and the served version is untouched.
    expect(await discardDraft(client, ROOT, 'analyst', configId, ACTOR)).toEqual({ outcome: 'no-draft' });
    expect((await listProfile(client, ROOT, 'analyst')).activeVersion).toBe(1);
  });
});

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

describe('POST /admin/profiles/discard', () => {
  it('discards the named draft (200), and refuses a changed one (409 DRAFT_CHANGED) or none (404 NO_DRAFT)', async () => {
    mockStore.current = fakeSsmStore();
    const { client } = mockStore.current;
    await createDraft(client, ROOT, 'advisor', ACTOR);
    const seen = await editDraft(client, ROOT, 'advisor', { persona: 'SEEN' }, ACTOR);
    const newer = await editDraft(client, ROOT, 'advisor', { persona: 'NEWER' }, ACTOR);

    const changed = await handler(evt('/admin/profiles/discard', { profileName: 'advisor', configId: seen.configId }));
    expect(changed.statusCode).toBe(409);
    expect(parse(changed)).toMatchObject({ code: 'DRAFT_CHANGED', configId: newer.configId });
    expect((await getDraft(client, ROOT, 'advisor'))?.persona).toBe('NEWER');

    const ok = await handler(evt('/admin/profiles/discard', { profileName: 'advisor', configId: newer.configId }));
    expect(ok.statusCode).toBe(200);
    expect(parse(ok)).toEqual({ profileName: 'advisor', discarded: true, configId: newer.configId });
    expect(await getDraft(client, ROOT, 'advisor')).toBeNull();

    const none = await handler(evt('/admin/profiles/discard', { profileName: 'advisor', configId: newer.configId }));
    expect(none.statusCode).toBe(404);
    expect(parse(none).code).toBe('NO_DRAFT');
  });

  it('refuses a discard that names no configId, before anything is read', async () => {
    mockStore.current = fakeSsmStore();
    const res = await handler(evt('/admin/profiles/discard', { profileName: 'advisor' }));
    expect(res.statusCode).toBe(400);
    expect(parse(res).code).toBe('CONFIG_ID_REQUIRED');
    expect(verbs(mockStore.current.client).filter((v) => v === 'DeleteParameterCommand')).toEqual([]);
  });

  it('DENIED: a team route scoped to one assistant cannot discard another assistant\'s draft', async () => {
    mockStore.current = fakeSsmStore();
    const { client } = mockStore.current;
    await createDraft(client, ROOT, 'advisor', ACTOR);
    const theirs = await editDraft(client, ROOT, 'advisor', { persona: 'THEIRS' }, ACTOR);
    mockScope.mockResolvedValue({ assistant: 'ops-premium', bots: [] });

    const res = await handler(evt('/admin/assistants/ops-premium/profiles/discard', { profileName: 'advisor', configId: theirs.configId }));
    expect(res.statusCode).toBe(403);
    expect(parse(res).code).toBe('ASSISTANT_MISMATCH');
    expect((await getDraft(client, ROOT, 'advisor'))?.configId).toBe(theirs.configId);
  });
});

describe('the route and its grants', () => {
  it('is an edit-profiles route in both forms, and no other capability carries it', () => {
    const paths = (key: string) => [...(ADMIN_CAPABILITIES[key].resources ?? []), ...(ADMIN_CAPABILITIES[key].teamResources ?? [])].map((r) => `${r.method} ${r.path}`);
    expect(paths('edit-profiles')).toEqual(expect.arrayContaining(['POST admin/profiles/discard', 'POST admin/assistants/{assistant}/profiles/discard']));
    for (const key of Object.keys(ADMIN_CAPABILITIES).filter((k) => k !== 'edit-profiles')) {
      expect(paths(key).filter((p) => p.includes('/discard'))).toEqual([]);
    }
  });

  it('is served by the existing function, with no new statement on its role', () => {
    const construct = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'constructs', 'admin-assistant-administration.ts'), 'utf8');
    expect(construct).toMatch(/const profileActions = \[[^\]]*'discard'[^\]]*\]/);
    // The draft delete the role already holds for activation, scoped to drafts only.
    expect(construct).toMatch(/actions: \['ssm:DeleteParameter'\],\s*resources: \[`arn:aws:ssm:\$\{region\}:\$\{account\}:parameter\$\{SSM_ROOT\}\/assistant\/\*\/draft`\]/);
  });

  it('DENIED: the team grant is the per-assistant route only, and a session naming one assistant does not reach another', () => {
    const team = roleExecuteApiResources('team-members', 'assistant-admin').filter((r) => r.path.endsWith('/discard'));
    expect(team).toEqual([{ method: 'POST', path: '/admin/assistants/*/profiles/discard' }]);
    const resources: string[] = JSON.parse(teamSessionPolicy(['ops-premium'], [])).Statement[0].Resource;
    const matches = (arn: string) => resources.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(arn));
    const arn = (a: string) => `arn:aws:execute-api:us-east-1:1:api1/prod/POST/admin/assistants/${a}/profiles/discard`;
    expect(matches(arn('ops-premium'))).toBe(true);
    expect(matches(arn('advisor'))).toBe(false);
  });

  it('SYNTHESIZED: the admin console role may invoke it, and the team console role only on an assistant\'s own route', () => {
    const grants = (roleName: string): string[] => {
      const [roleId] = Object.entries(adminServicesTemplate().findResources('AWS::IAM::Role') as Record<string, { Properties?: Record<string, any> }>)
        .find(([, r]) => r.Properties?.RoleName === roleName) ?? [];
      const out: string[] = [];
      for (const p of Object.values(adminApiTemplate().findResources('AWS::IAM::ManagedPolicy') as Record<string, { Properties?: Record<string, any> }>)) {
        if (!JSON.stringify(p.Properties?.Roles ?? []).includes(roleId!)) continue;
        for (const s of p.Properties?.PolicyDocument?.Statement ?? []) {
          if ([].concat(s.Action).includes('execute-api:Invoke' as never)) out.push(...[].concat(s.Resource).map((x) => JSON.stringify(x)));
        }
      }
      return out.filter((g) => g.includes('/discard'));
    };
    expect(grants(ADMIN_CONSOLE_ROLE_NAME.admins).some((g) => g.includes('/POST/admin/profiles/discard'))).toBe(true);
    const team = grants(ADMIN_CONSOLE_ROLE_NAME['team-members']);
    expect(team.length).toBeGreaterThan(0);
    // DENIED: the unscoped route would discard any assistant's draft.
    expect(team.filter((g) => g.includes('/POST/admin/profiles/discard'))).toEqual([]);
    expect(team.every((g) => g.includes('/admin/assistants/'))).toBe(true);
  });
});
