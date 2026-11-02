/**
 * A TEAM MEMBER VERSIONS AN ASSISTANT THEIR TEAM OWNS, AND NO OTHER (SPEC-ADMIN-CONSOLE FR48, the
 * manage-profiles team routes).
 *
 * Through the handler, with the real scope check (`requireOwnedAssistant`) reading the caller's groups and
 * the `owner-team` tags, and the real lifecycle over a versioned in-memory SSM:
 *   - on an assistant the caller's team owns, a draft, an activation, a rollback and an import succeed;
 *   - on another team's assistant each is refused with ASSISTANT_NOT_OWNED and writes nothing;
 *   - a patch carrying what only a deploy or another capability changes (classification, role, reach) is a
 *     422 through the handler, not a silently dropped key.
 */
import { fakeSsmStore } from './helpers/fake-ssm-store';
import type { AssistantIdentity } from '../lambda/src/lib/assistant-ownership';

const mockStore = fakeSsmStore();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return {
    ...actual,
    SSMClient: jest.fn(() => ({
      send: (cmd: unknown) => (cmd instanceof actual.GetParametersByPathCommand ? Promise.resolve({ Parameters: [] }) : mockStore.client.send(cmd as never)),
    })),
  };
});
let mockGroups: string[] = [];
jest.mock('../lambda/src/lib/membership-source', () => ({
  ...jest.requireActual('../lambda/src/lib/membership-source'),
  defaultDirectory: () => ({
    groupsFor: async () => mockGroups,
    listGroups: async () => [],
    // The clearance the handler binds the scope to, read from the same groups by the registry's own rule.
    clearedByGroups: async () => jest.requireActual('../lib/profile-registry').defaultProfileRegistry.clearancesForGroups(mockGroups),
  }),
}));
const APP = 'arn:aws:chime:us-east-1:123456789012:app-instance/ai';
const identity = (assistant: string, classification: string, ownerTeam: string): AssistantIdentity => ({
  assistant, classification, ownerTeam, ownerRecorded: true, role: assistant === 'advisor' ? 'primary' : 'ops', name: assistant,
  botArn: `${APP}/bot/${assistant}`,
});
jest.mock('../lambda/src/lib/assistant-ownership', () => {
  const actual = jest.requireActual('../lambda/src/lib/assistant-ownership');
  return {
    ...actual,
    listAssistantIdentities: async () => [identity('ops-premium', 'premium', 'ops'), identity('advisor', 'premium', 'support')],
  };
});

process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.SSM_ROOT = '/ae';
process.env.APP_INSTANCE_ARN = APP;
process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/src/manage-profiles';
import { classificationServedBy } from '../lambda/src/lib/profile-lifecycle';

const SUB = '11111111-2222-3333-4444-555555555555';

/** A request on a team route, signed by a team member's console session cleared for premium. */
function onRoute(assistant: string, action: string, body: unknown = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: `/admin/assistants/${assistant}/profiles/${action}`,
    pathParameters: { assistant },
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/ae-team-console/console-${SUB}@premium` } },
  } as unknown as APIGatewayProxyEvent;
}

const call = async (assistant: string, action: string, body: unknown = {}) => {
  const res = await handler(onRoute(assistant, action, body));
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const writes = () => (mockStore.client.send as jest.Mock).mock.calls
  .map(([c]) => c as { constructor: { name: string }; input: { Name?: string } })
  .filter((c) => ['PutParameterCommand', 'LabelParameterVersionCommand', 'DeleteParameterCommand'].includes(c.constructor.name));

beforeEach(async () => {
  mockGroups = ['premium', 'team-members', 'team-ops'];
  // The catalog the assistant's classification publishes, at the key activation resolves for it, so a version
  // selecting the seeded `user-profile` activates.
  const { PutParameterCommand } = jest.requireActual('@aws-sdk/client-ssm');
  await mockStore.client.send(new PutParameterCommand({
    Name: `${process.env.SSM_ROOT}/assistant/${classificationServedBy('ops-premium')}/context-sources`,
    Value: JSON.stringify([{ key: 'user-profile' }]), Type: 'String', Overwrite: true,
  }) as never);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('on an assistant the team owns', () => {
  it('drafts, activates, rolls back and imports', async () => {
    expect((await call('ops-premium', 'version')).status).toBe(200);
    const edited = await call('ops-premium', 'draft', { patch: { persona: 'You keep the deployment healthy.' } });
    expect(edited.status).toBe(200);
    const first = await call('ops-premium', 'activate');
    expect(first.status).toBe(200);
    expect(first.body.version).toBeGreaterThanOrEqual(1);

    await call('ops-premium', 'version');
    await call('ops-premium', 'draft', { patch: { persona: 'A second persona.' } });
    const second = await call('ops-premium', 'activate');
    expect(second.status).toBe(200);
    expect(second.body.version).toBeGreaterThan(first.body.version);

    const back = await call('ops-premium', 'rollback', { version: first.body.version });
    expect(back.status).toBe(200);
    expect(back.body.version).toBe(first.body.version);

    const exported = await call('ops-premium', 'export');
    expect(exported.status).toBe(200);
    const imported = await call('ops-premium', 'import', { manifest: exported.body.manifest });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ imported: 'ops-premium', landedAs: 'draft' });
  });

  it.each([
    ['classification', { classification: 'basic' }],
    ['role', { role: 'primary' }],
    ['reach', { reach: ['context/finance/'] }],
  ])('refuses a patch carrying %s with a 422 that names it', async (key, patch) => {
    await call('ops-premium', 'version');
    const res = await call('ops-premium', 'draft', { patch });
    expect(res.status).toBe(422);
    expect(res.body.errors.join(' ')).toContain(`${key} is not part of a version`);
  });
});

describe("on another team's assistant", () => {
  it.each([
    ['draft', { patch: { persona: 'x' } }],
    ['activate', {}],
    ['rollback', { version: 1 }],
    ['import', { manifest: {} }],
  ])('refuses %s with ASSISTANT_NOT_OWNED and writes nothing', async (action, body) => {
    const before = writes().length;
    const res = await call('advisor', action, body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ASSISTANT_NOT_OWNED');
    expect(writes().length).toBe(before);
  });

  it('refuses a team member whose groups no longer name the owning team, though the path is theirs', async () => {
    mockGroups = ['premium', 'team-members'];
    const res = await call('ops-premium', 'draft', { patch: { persona: 'x' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ASSISTANT_NOT_OWNED');
  });
});
