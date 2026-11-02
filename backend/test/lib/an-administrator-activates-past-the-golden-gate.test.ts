/**
 * AN ADMINISTRATOR ACTIVATES PAST THE GOLDEN GATE (ADR-065 decision 5, SPEC-EVALUATION FR28).
 *
 * What it proves:
 *  - the confirmation rule (`pastGateDecision`): a reason within its bounds, the draft and the refusal named, and both
 *    read again, so a draft saved since or a refusal that changed is refused with the one that stands, and a gate that no
 *    longer refuses has nothing to pass;
 *  - the route: an administrator whose directory groups hold an admin group activates the refused draft, the version
 *    records the refusal, the reason and who, and the admin channel is told; a caller whose groups hold none is refused
 *    whatever the signed call says (layer two), and a team route never reaches it;
 *  - the grant: its own capability, held by the admin role alone, with no team route, and no other capability names it.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { ADMIN_CAPABILITIES, roleExecuteApiResources } from '../../lib/config/admin-capabilities';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { edgeContext } from '../helpers/edge-context';
import { pastGateDecision, PAST_GATE_REASON_MIN, PAST_GATE_REASON_MAX, type GoldenGateRead } from '../../lambda/src/lib/golden-gate';

jest.mock('@aws-sdk/client-s3', () => {
  class S3Client { async send(): Promise<unknown> { throw Object.assign(new Error('not found'), { name: 'NoSuchKey' }); } }
  return { S3Client, PutObjectCommand: class {}, GetObjectCommand: class {}, DeleteObjectCommand: class {}, ListObjectsV2Command: class {} };
});
const mockStore: { current: ReturnType<typeof fakeSsmStore> | null } = { current: null };
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: (cmd: unknown) => mockStore.current!.client.send(cmd as never) })) };
});
// The gate as the classification's GoldenRun function reads it.
const mockGate: { current: GoldenGateRead | null } = { current: null };
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  class LambdaClient {
    async send(): Promise<unknown> { return { Payload: Buffer.from(JSON.stringify(mockGate.current)) }; }
  }
  return { ...actual, LambdaClient };
});
const mockScope = jest.fn();
jest.mock('../../lambda/src/lib/assistant-scope', () => {
  const actual = jest.requireActual('../../lambda/src/lib/assistant-scope');
  return { ...actual, requireOwnedAssistant: (...a: unknown[]) => mockScope(...a) };
});
// The caller's groups as the directory holds them: layer two reads these, not the signed call.
const mockGroups = jest.fn();
jest.mock('../../lambda/src/lib/membership-source', () => {
  const actual = jest.requireActual('../../lambda/src/lib/membership-source');
  return { ...actual, defaultDirectory: () => ({ groupsFor: (arn: string) => mockGroups(arn) }) };
});
jest.mock('../../lambda/src/lib/auth', () => {
  const actual = jest.requireActual('../../lambda/src/lib/auth');
  return { ...actual, callerPersonArn: async () => 'arn:aws:chime:us-east-1:1:app-instance/ai/user/person-1' };
});
const mockNotices: unknown[] = [];
jest.mock('../../lambda/src/lib/admin-notice', () => {
  const actual = jest.requireActual('../../lambda/src/lib/admin-notice');
  return { ...actual, postAdminNotice: async (n: unknown) => { mockNotices.push(n); return true; } };
});

import { createDraft, editDraft, getDraft, listProfile } from '../../lambda/src/lib/profile-lifecycle';
import { handler } from '../../lambda/src/manage-profiles';

const ROOT = '/agent-echelon';
const GOLDEN_ROOT = '/agent-echelon/golden-run-test';
const REASON = 'Ship the outage fix; entry 3f2a is stale';

const refusedGate = (configId: string): GoldenGateRead => ({
  entries: 2, regressionEntries: 2, uncoveredRegression: 0,
  run: {
    runId: 'run-1', draftConfigId: configId, status: 'complete', error: null, entriesTotal: 2, entriesDone: 2,
    result: {
      refused: true, failures: [{ entryId: 'e-1', attempt: 2, reason: 'empty' }], readyToPromote: [], pairedDifference: null,
      minimumDetectable: Infinity, notExercised: [], regressionExercised: 2, entries: 2, k: 3,
    },
  },
});

describe('pastGateDecision: what an administrator confirms', () => {
  const gate = refusedGate('cfg-1');
  const ok = { configId: 'cfg-1', code: 'GOLDEN_SET_REFUSED', params: { count: 1 }, runId: 'run-1', reason: REASON };

  it('allows the refusal that stands, with the reason trimmed', () => {
    expect(pastGateDecision(gate, 'cfg-1', { ...ok, reason: `  ${REASON}  ` })).toMatchObject({
      allow: true, reason: REASON, refusal: { code: 'GOLDEN_SET_REFUSED', params: { count: 1 } },
    });
  });

  it('needs a reason within its bounds', () => {
    for (const reason of [undefined, '', 'x'.repeat(PAST_GATE_REASON_MIN - 1), 'x'.repeat(PAST_GATE_REASON_MAX + 1)]) {
      expect(pastGateDecision(gate, 'cfg-1', { ...ok, reason })).toMatchObject({ allow: false, status: 400, code: 'REASON_REQUIRED' });
    }
    expect(pastGateDecision(gate, 'cfg-1', { ...ok, reason: 'x'.repeat(PAST_GATE_REASON_MAX) }).allow).toBe(true);
  });

  it('needs the draft and the refusal named', () => {
    expect(pastGateDecision(gate, 'cfg-1', { reason: REASON })).toMatchObject({ allow: false, status: 400, code: 'CONFIRMATION_REQUIRED' });
  });

  it('refuses a draft saved since, or a refusal that changed, naming the one that stands', () => {
    expect(pastGateDecision(gate, 'cfg-2', ok)).toMatchObject({ allow: false, status: 409, code: 'GATE_CHANGED', current: { code: 'GOLDEN_RUN_REQUIRED' } });
    expect(pastGateDecision(gate, 'cfg-1', { ...ok, code: 'GOLDEN_RUN_REQUIRED' })).toMatchObject({
      allow: false, status: 409, code: 'GATE_CHANGED', current: { code: 'GOLDEN_SET_REFUSED', params: { count: 1 } },
    });
  });

  it('refuses the same code read with other values or from another run', () => {
    expect(pastGateDecision(gate, 'cfg-1', { ...ok, params: { count: 3 } })).toMatchObject({ allow: false, code: 'GATE_CHANGED' });
    expect(pastGateDecision(gate, 'cfg-1', { ...ok, params: undefined })).toMatchObject({ allow: false, code: 'GATE_CHANGED' });
    expect(pastGateDecision(gate, 'cfg-1', { ...ok, runId: 'run-0' })).toMatchObject({ allow: false, code: 'GATE_CHANGED' });
  });

  it('keeps the reason on one line, so it cannot read as a line of the notice', () => {
    expect(pastGateDecision(gate, 'cfg-1', { ...ok, reason: 'Ship the fix\n**By:** someone else' })).toMatchObject({ allow: true, reason: 'Ship the fix **By:** someone else' });
  });

  it('has nothing to pass where the gate does not refuse', () => {
    expect(pastGateDecision(null, 'cfg-1', ok)).toMatchObject({ allow: false, status: 409, code: 'GATE_NOT_REFUSING' });
    expect(pastGateDecision({ entries: 0, regressionEntries: 0, run: null }, 'cfg-1', ok)).toMatchObject({ code: 'GATE_NOT_REFUSING' });
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

describe('POST /admin/profiles/activate-past-golden-gate', () => {
  const ROUTE = '/admin/profiles/activate-past-golden-gate';
  let configId = '';

  beforeEach(async () => {
    process.env.GOLDEN_RUN_PARAM_ROOT = GOLDEN_ROOT;
    mockNotices.length = 0;
    mockScope.mockReset();
    mockScope.mockResolvedValue(null);
    mockGroups.mockReset();
    mockGroups.mockResolvedValue(['admins']);
    mockStore.current = fakeSsmStore();
    const { client } = mockStore.current;
    for (const cls of ['basic', 'standard', 'premium']) {
      await client.send(new PutParameterCommand({ Name: `${GOLDEN_ROOT}/${cls}/golden-run-arn`, Value: `arn:aws:lambda:us-east-1:1:function:${cls}-GoldenRun`, Type: 'String' }));
      // The context-source catalog the activation verifies the version against, still checked when the gate is passed.
      await client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/${cls}/context-sources`, Value: JSON.stringify([{ key: 'user-profile' }]), Type: 'String' }));
    }
    await createDraft(client, ROOT, 'advisor', 'admin-sub');
    configId = (await editDraft(client, ROOT, 'advisor', { modelKey: 'titan' }, 'admin-sub')).configId;
    mockGate.current = refusedGate(configId);
  });

  it('Activate refuses the draft, and an administrator activates it past the gate, recorded on the version and announced', async () => {
    const refused = await handler(evt('/admin/profiles/activate', { profileName: 'advisor' }));
    expect(refused.statusCode).toBe(409);
    expect(parse(refused).code).toBe('GOLDEN_SET_REFUSED');

    const res = await handler(evt(ROUTE, { profileName: 'advisor', configId, code: 'GOLDEN_SET_REFUSED', params: { count: 1 }, runId: 'run-1', reason: REASON }));
    expect([res.statusCode, res.body]).toEqual([200, expect.any(String)]);
    expect(parse(res)).toMatchObject({
      configId, activatedPastGate: { code: 'GOLDEN_SET_REFUSED', params: { count: 1 }, reason: REASON, runId: 'run-1' },
    });
    expect(await getDraft(mockStore.current!.client, ROOT, 'advisor')).toBeNull();
    const listing = await listProfile(mockStore.current!.client, ROOT, 'advisor');
    const active = listing.versions.find((v) => v.active);
    expect(active).toMatchObject({ configId, activatedPastGate: { code: 'GOLDEN_SET_REFUSED', reason: REASON } });
    expect(active!.activatedPastGate!.actor).toBeTruthy();
    expect(mockNotices).toEqual([expect.objectContaining({
      messageType: 'activated-past-golden-gate',
      words: { name: 'activated-past-golden-gate', values: expect.objectContaining({ assistant: 'advisor', refusal: 'GOLDEN_SET_REFUSED', reason: REASON }) },
    })]);
  });

  it('DENIED: a caller whose directory groups hold no admin group is refused, whatever the signed call carries', async () => {
    for (const groups of [[], ['team-members', 'team-sales'], null]) {
      mockGroups.mockResolvedValue(groups);
      const res = await handler(evt(ROUTE, { profileName: 'advisor', configId, code: 'GOLDEN_SET_REFUSED', params: { count: 1 }, runId: 'run-1', reason: REASON }));
      expect(res.statusCode).toBe(403);
      expect(parse(res).code).toBe('ADMIN_REQUIRED');
    }
    expect((await getDraft(mockStore.current!.client, ROOT, 'advisor'))?.configId).toBe(configId);
    expect(mockNotices).toEqual([]);
  });

  it('DENIED: a team route is refused before anything is read', async () => {
    mockScope.mockResolvedValue({ assistant: 'advisor', bots: [] });
    const res = await handler(evt('/admin/assistants/advisor/profiles/activate-past-golden-gate', { profileName: 'advisor', configId, code: 'GOLDEN_SET_REFUSED', params: { count: 1 }, runId: 'run-1', reason: REASON }));
    expect(res.statusCode).toBe(403);
    expect(mockGroups).not.toHaveBeenCalled();
  });

  it('refuses a refusal that changed since it was shown, and activates nothing', async () => {
    const res = await handler(evt(ROUTE, { profileName: 'advisor', configId, code: 'GOLDEN_RUN_REQUIRED', reason: REASON }));
    expect(res.statusCode).toBe(409);
    expect(parse(res)).toMatchObject({ code: 'GATE_CHANGED', current: { code: 'GOLDEN_SET_REFUSED' } });
    expect((await getDraft(mockStore.current!.client, ROOT, 'advisor'))?.configId).toBe(configId);
  });
});

describe('the grant', () => {
  const paths = (key: string) => [...(ADMIN_CAPABILITIES[key].resources ?? []), ...(ADMIN_CAPABILITIES[key].teamResources ?? [])].map((r) => `${r.method} ${r.path}`);

  it('is its own capability, held by the admin role alone, with no team route', () => {
    const cap = ADMIN_CAPABILITIES['activate-past-golden-gate'];
    expect(cap.roles).toEqual(['admins']);
    expect(cap.teamResources).toBeUndefined();
    expect(paths('activate-past-golden-gate')).toEqual(['POST admin/profiles/activate-past-golden-gate']);
    for (const key of Object.keys(ADMIN_CAPABILITIES).filter((k) => k !== 'activate-past-golden-gate')) {
      expect(paths(key).filter((p) => p.includes('activate-past-golden-gate'))).toEqual([]);
    }
  });

  it('DENIED: the team console role is granted no route that reaches it', () => {
    expect(roleExecuteApiResources('team-members', 'assistant-admin').filter((r) => r.path.includes('activate-past-golden-gate'))).toEqual([]);
    expect(roleExecuteApiResources('admins', 'assistant-admin').filter((r) => r.path.includes('activate-past-golden-gate')))
      .toEqual([{ method: 'POST', path: '/admin/profiles/activate-past-golden-gate' }]);
  });
});
