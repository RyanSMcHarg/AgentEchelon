/**
 * A DRAFT IS REPLACED OR PROMOTED ONLY BY NAME (SPEC-PORTABLE-PROFILES FR18, FR19).
 *
 * Every write that would replace or promote a draft names the configId it was based on, so nobody's work in progress is
 * overwritten or put into service unseen:
 *  - Activate promotes the draft the activator reviewed: no configId is `409 CONFIG_ID_REQUIRED`, another one is
 *    `409 DRAFT_CHANGED` with the configId there now, and nothing serving changes;
 *  - Import and New version replace an existing draft only when `replaceConfigId` names it (`409 DRAFT_EXISTS`);
 *  - an edit names the draft it was based on, so the second of two edits based on the same draft is refused rather
 *    than merged over the first;
 *  - the profile CLI sends the same configIds (`the-assistant-cli-signs-its-calls.test.ts`).
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

import { createDraft, editDraft, getDraft, listProfile } from '../../lambda/src/lib/profile-lifecycle';
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

const manifest = (modelKey: string) => ({
  schemaVersion: 1, kind: 'assistant-profile', profileName: 'advisor',
  body: { modelKey },
  provenance: { sourceProfileName: 'advisor', sourceVersion: 1, exportedConfigId: 'cfg-src' },
});

let draftId: string;
beforeEach(async () => {
  mockStore.current = fakeSsmStore();
  const { client } = mockStore.current;
  for (const cls of ['basic', 'standard', 'premium']) {
    await client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/${cls}/context-sources`, Value: JSON.stringify([{ key: 'user-profile' }]), Type: 'String' }));
  }
  await createDraft(client, ROOT, 'advisor', 'admin-sub');
  draftId = (await editDraft(client, ROOT, 'advisor', { modelKey: 'titan' }, 'admin-sub')).configId;
});

describe('Activate promotes the draft the activator reviewed', () => {
  it('refuses an activation that names no draft, and activates nothing', async () => {
    const res = await handler(evt('/admin/profiles/activate', { profileName: 'advisor' }));
    expect(res.statusCode).toBe(409);
    expect(parse(res).code).toBe('CONFIG_ID_REQUIRED');
    expect((await listProfile(mockStore.current!.client, ROOT, 'advisor')).activeVersion).toBeNull();
  });

  it('refuses a stale configId after an import replaced the reviewed draft, naming the draft there now', async () => {
    // Someone else imports over the draft the activator is looking at.
    const imported = await handler(evt('/admin/profiles/import', { manifest: manifest('sonnet'), targetProfileName: 'advisor', replaceConfigId: draftId }));
    expect(imported.statusCode).toBe(200);
    const now = parse(imported).configId;
    expect(now).not.toBe(draftId);

    const res = await handler(evt('/admin/profiles/activate', { profileName: 'advisor', configId: draftId }));
    expect(res.statusCode).toBe(409);
    expect(parse(res)).toMatchObject({ code: 'DRAFT_CHANGED', configId: now });
    // Nothing serving changed, and the newer draft is kept for its author.
    expect((await listProfile(mockStore.current!.client, ROOT, 'advisor')).activeVersion).toBeNull();
    expect((await storedDraft()).modelKey).toBe('sonnet');
  });

  it('activates the draft whose configId it names', async () => {
    const res = await handler(evt('/admin/profiles/activate', { profileName: 'advisor', configId: draftId }));
    expect(res.statusCode).toBe(200);
    expect(parse(res).configId).toBe(draftId);
    expect(await getDraft(mockStore.current!.client, ROOT, 'advisor')).toBeNull();
  });

  it('answers a missing draft as NO_DRAFT', async () => {
    await handler(evt('/admin/profiles/activate', { profileName: 'advisor', configId: draftId }));
    const again = await handler(evt('/admin/profiles/activate', { profileName: 'advisor', configId: draftId }));
    expect(again.statusCode).toBe(404);
    expect(parse(again).code).toBe('NO_DRAFT');
  });
});

describe('Import and New version replace a draft only when they name it', () => {
  it('refuses an import over an existing draft that does not name it, and keeps the draft', async () => {
    const before = await storedDraft();
    for (const replaceConfigId of [undefined, 'cfg-someone-else']) {
      const res = await handler(evt('/admin/profiles/import', { manifest: manifest('sonnet'), targetProfileName: 'advisor', ...(replaceConfigId ? { replaceConfigId } : {}) }));
      expect(res.statusCode).toBe(409);
      expect(parse(res)).toMatchObject({ code: 'DRAFT_EXISTS', configId: draftId });
    }
    expect(await storedDraft()).toEqual(before);
  });

  it('refuses a new version over an existing draft that does not name it, and replaces the one it names', async () => {
    const refused = await handler(evt('/admin/profiles/version', { profileName: 'advisor' }));
    expect(refused.statusCode).toBe(409);
    expect(parse(refused)).toMatchObject({ code: 'DRAFT_EXISTS', configId: draftId });
    expect((await storedDraft()).modelKey).toBe('titan');

    const replaced = await handler(evt('/admin/profiles/version', { profileName: 'advisor', replaceConfigId: draftId }));
    expect(replaced.statusCode).toBe(200);
    expect((await storedDraft()).configId).not.toBe(draftId);
  });

  it('lands an import or a new version freely where there is no draft', async () => {
    await handler(evt('/admin/profiles/discard', { profileName: 'advisor', configId: draftId }));
    const imported = await handler(evt('/admin/profiles/import', { manifest: manifest('sonnet'), targetProfileName: 'advisor' }));
    expect(imported.statusCode).toBe(200);
  });
});

describe('an edit names the draft it was based on', () => {
  it('a write SSM refuses as too soon after another is a 503 with a code, sent once and never over the other write', async () => {
    const send = mockStore.current!.client.send as jest.Mock;
    const real = send.getMockImplementation()!;
    const puts: unknown[] = [];
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof PutParameterCommand) {
        puts.push(cmd);
        throw Object.assign(new Error('too many updates'), { name: 'TooManyUpdates' });
      }
      return real(cmd);
    });
    const res = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'opus' }, configId: draftId }));
    expect(res.statusCode).toBe(503);
    expect(parse(res)).toMatchObject({ code: 'PROFILE_WRITE_BUSY' });
    expect(parse(res).error).toMatch(/try again/);
    expect(puts).toHaveLength(1);
  });

  it('refuses the second of two edits based on the same draft, keeping the first', async () => {
    const first = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'opus' }, configId: draftId }));
    expect(first.statusCode).toBe(200);
    const second = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'sonnet' }, configId: draftId }));
    expect(second.statusCode).toBe(409);
    expect(parse(second)).toMatchObject({ code: 'DRAFT_CHANGED', configId: parse(first).draftConfigId });
    expect((await storedDraft()).modelKey).toBe('opus');
  });

  it('refuses an edit that names no draft while one exists, and one naming a draft that was activated since', async () => {
    const unnamed = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'opus' } }));
    expect(unnamed.statusCode).toBe(409);
    expect(parse(unnamed)).toMatchObject({ code: 'CONFIG_ID_REQUIRED', configId: draftId });

    await handler(evt('/admin/profiles/activate', { profileName: 'advisor', configId: draftId }));
    const gone = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'opus' }, configId: draftId }));
    expect(gone.statusCode).toBe(409);
    expect(parse(gone)).toMatchObject({ code: 'DRAFT_CHANGED', configId: null });
    expect(await getDraft(mockStore.current!.client, ROOT, 'advisor')).toBeNull();
  });

  it('starts a draft from the active version when there is none and the edit names none', async () => {
    await handler(evt('/admin/profiles/discard', { profileName: 'advisor', configId: draftId }));
    const res = await handler(evt('/admin/profiles/draft', { profileName: 'advisor', patch: { modelKey: 'opus' } }));
    expect(res.statusCode).toBe(200);
  });
});
