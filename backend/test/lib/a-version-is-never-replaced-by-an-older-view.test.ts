/**
 * A VERSION IS NEVER REPLACED BY AN OLDER VIEW.
 *
 * Whatever an update starts from, it builds on the latest version: a console page, a CLI or an import each change the
 * active version, and a write based on an older one is refused rather than written over it.
 *  - A first edit (no draft open) names the active version the console was showing; one activated since is refused
 *    `409 VERSION_CHANGED`, and the draft it starts records the version it was built on.
 *  - Activating a draft is held to the version it was started from: a newer version activated since is never replaced
 *    by it. A draft with no recorded start (an import or a copy, which replace on purpose) is not held.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { edgeContext } from '../helpers/edge-context';

jest.mock('@aws-sdk/client-s3', () => {
  class S3Client { async send(): Promise<unknown> { throw Object.assign(new Error('not found'), { name: 'NoSuchKey' }); } }
  return { S3Client, PutObjectCommand: class {}, GetObjectCommand: class {}, DeleteObjectCommand: class {}, ListObjectsV2Command: class {} };
});
const mockStore: { current: ReturnType<typeof fakeSsmStore> | null } = { current: null };
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: (cmd: unknown) => mockStore.current!.client.send(cmd as never) })) };
});
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  class LambdaClient {
    async send(): Promise<unknown> { return { Payload: Buffer.from(JSON.stringify({ entries: 0, regressionEntries: 0, run: null })) }; }
  }
  return { ...actual, LambdaClient };
});

import { createDraft, editDraft, listProfile, versionBasisError } from '../../lambda/src/lib/profile-lifecycle';
import { handler } from '../../lambda/src/manage-profiles';

const ROOT = '/agent-echelon';
const DRAFT = `${ROOT}/assistant/advisor/draft`;

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
const storedDraft = async () => JSON.parse((await mockStore.current!.client.send(new GetParameterCommand({ Name: DRAFT }))).Parameter!.Value!);

/** Activate a draft with this model, through the handler, and answer the version it became. */
async function activateWith(modelKey: string): Promise<number> {
  const { client } = mockStore.current!;
  const draft = await editDraft(client, ROOT, 'advisor', { modelKey }, 'admin-sub');
  const res = await handler(evt('/admin/profiles/activate', { profileName: 'advisor', configId: draft.configId }));
  expect(res.statusCode).toBe(200);
  return (await listProfile(client, ROOT, 'advisor')).activeVersion!;
}

beforeEach(async () => {
  mockStore.current = fakeSsmStore();
  const { client } = mockStore.current;
  for (const cls of ['basic', 'standard', 'premium']) {
    await client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/${cls}/context-sources`, Value: JSON.stringify([{ key: 'user-profile' }]), Type: 'String' }));
  }
  await createDraft(client, ROOT, 'advisor', 'admin-sub');
});

describe('the version a write was based on', () => {
  it('agrees, or nothing is active, and only a different active version is refused', () => {
    expect(versionBasisError('advisor', 3, 3)).toBeNull();
    expect(versionBasisError('advisor', null, 2)).toBeNull();
    expect(versionBasisError('advisor', 3, undefined)).toBeNull();
    expect(versionBasisError('advisor', 4, 3)?.code).toBe('VERSION_CHANGED');
  });
});

describe('a first edit is held to the active version the console showed', () => {
  it('refuses an edit based on a version older than the active one, and starts no draft', async () => {
    const v1 = await activateWith('titan');
    const v2 = await activateWith('sonnet');
    expect(v2).toBeGreaterThan(v1);
    const res = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'haiku' }, basedOnVersion: v1 }));
    expect(res.statusCode).toBe(409);
    expect(parse(res).code).toBe('VERSION_CHANGED');
    expect((await listProfile(mockStore.current!.client, ROOT, 'advisor')).hasDraft).toBe(false);
  });

  it('accepts an edit based on the active version, and the draft records it', async () => {
    const v1 = await activateWith('titan');
    const res = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'haiku' }, basedOnVersion: v1 }));
    expect(res.statusCode).toBe(200);
    expect((await storedDraft()).provenance).toEqual({ basedOnVersion: v1 });
  });
});

describe('activating a draft is held to the version it was started from', () => {
  it('refuses a draft started before a newer version was activated, and nothing serving changes', async () => {
    const v1 = await activateWith('titan');
    // A console starts a draft on v1 ...
    const stale = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'haiku' }, basedOnVersion: v1 }));
    const staleId = parse(stale).draftConfigId as string;
    // ... while another path activates a newer version (a rollback, an import, another console), which leaves the draft as it is.
    const { client } = mockStore.current!;
    const draftRaw = (await client.send(new GetParameterCommand({ Name: DRAFT }))).Parameter!.Value!;
    const name = `${ROOT}/assistant/advisor/definition`;
    const active = (await client.send(new GetParameterCommand({ Name: `${name}:active` }))).Parameter!.Value!;
    await client.send(new PutParameterCommand({ Name: name, Value: active, Type: 'String', Overwrite: true }));
    const { LabelParameterVersionCommand } = jest.requireActual('@aws-sdk/client-ssm');
    const newest = (await client.send(new GetParameterCommand({ Name: name }))).Parameter!.Version!;
    await client.send(new LabelParameterVersionCommand({ Name: name, ParameterVersion: newest, Labels: ['active'] }));
    await client.send(new PutParameterCommand({ Name: DRAFT, Value: draftRaw, Type: 'String', Overwrite: true }));
    const res = await handler(evt('/admin/profiles/activate', { profileName: 'advisor', configId: staleId }));
    expect(res.statusCode).toBe(409);
    expect(parse(res).code).toBe('VERSION_CHANGED');
    expect((await listProfile(client, ROOT, 'advisor')).activeVersion).toBe(newest);
  });
});
