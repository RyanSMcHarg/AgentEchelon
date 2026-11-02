/**
 * A CONSOLE-CREATED ASSISTANT'S TURNS PER HOUR ARE SET IN THE CONSOLE; A DECLARED ONE'S BY A DEPLOY.
 *
 * The router reads a runtime assistant's limit from its assignment record (`runtimeSeedFor`), so the route
 * writes the record and the directory entry the console lists. Two layers: the session policy names only the
 * caller's own teams, and the handler re-reads their groups and the entry's owner.
 *   - an admin sets and clears the limit of a console-created assistant;
 *   - a declared assistant (no directory entry) is refused with what changes it;
 *   - a bad value is refused before anything is written;
 *   - a team member sets it for an assistant their team owns (by its owner-team tag), and is refused for another team's assistant
 *     and on a team route naming a team they are not in.
 */
const ssmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: ssmSend })) };
});
jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-identity');
  return { ...actual, ChimeSDKIdentityClient: jest.fn(() => ({ send: jest.fn() })) };
});
jest.mock('@aws-sdk/client-lex-models-v2', () => {
  const actual = jest.requireActual('@aws-sdk/client-lex-models-v2');
  return { ...actual, LexModelsV2Client: jest.fn(() => ({ send: jest.fn() })) };
});
const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: jest.fn(() => ({ send: lambdaSend })) };
});

process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.SSM_ROOT = '/ae';
process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/ai';
process.env.OWNERSHIP_FUNCTION_NAME = 'ae-assistant-ownership';
process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/src/manage-assistants';
import { teamsOfGroups } from '../lambda/src/lib/assistant-ownership';

const SUB = '11111111-2222-3333-4444-555555555555';
const PERSON = `${process.env.APP_INSTANCE_ARN}/user/${SUB}`;
let groups: string[] = [];

function signed(kind: 'team' | 'admin', path: string, body: unknown): APIGatewayProxyEvent {
  const session = kind === 'team' ? `console-${SUB}@premium` : `console-${SUB}`;
  return {
    httpMethod: 'POST',
    path,
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/ae-${kind}-console/${session}` } },
  } as unknown as APIGatewayProxyEvent;
}

const RECORD = '/ae/assistant-assignments/premium/primary/assistants/ops-helper';
const ENTRY = '/ae/assistant-directory/ops-helper';
let params: Map<string, string>;
const puts = () => ssmSend.mock.calls.map(([c]) => c).filter((c) => c.constructor.name === 'PutParameterCommand');

beforeEach(() => {
  groups = ['premium', 'team-members', 'team-ops'];
  lambdaSend.mockReset().mockImplementation(async (cmd: any) => {
    const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString());
    // Ownership is the identity's owner-team tag, read by the ownership function.
    if (payload.op === 'owned-by') return { Payload: Buffer.from(JSON.stringify({ assistants: ({ ops: ['ops-helper'], support: ['support-bot'] } as Record<string, string[]>)[payload.team] ?? [] })) };
    if (payload.op !== 'in-team') return {};
    const inTeam = payload.personArn === PERSON && teamsOfGroups(groups).includes(payload.team);
    return { Payload: Buffer.from(JSON.stringify({ inTeam })) };
  });
  const descriptor = { modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 30 };
  params = new Map([
    [ENTRY, JSON.stringify({ classification: 'premium', role: 'primary', status: 'active', ownerTeam: 'ops', descriptor })],
    [RECORD, JSON.stringify({ classification: 'premium', role: 'primary', occupancy: 'live', assistant: 'ops-helper', source: 'runtime', status: 'active', descriptor })],
    ['/ae/assistant-directory/support-bot', JSON.stringify({ classification: 'premium', role: 'primary', status: 'active', ownerTeam: 'support', descriptor })],
  ]);
  ssmSend.mockReset().mockImplementation(async (cmd: any) => {
    const i = cmd.input;
    if (cmd.constructor.name === 'GetParameterCommand') {
      if (!params.has(i.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
      return { Parameter: { Name: i.Name, Value: params.get(i.Name) } };
    }
    if (cmd.constructor.name === 'PutParameterCommand') { params.set(i.Name, i.Value); return {}; }
    return { Parameters: [] };
  });
});

describe('an admin', () => {
  it('sets a console-created assistant\'s limit on the record the router reads and on the directory entry', async () => {
    const res = await handler(signed('admin', '/admin/roster/ops-helper/limits', { rateLimitPerHour: 90 })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(params.get(RECORD)!).descriptor).toEqual({ modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 90 });
    expect(JSON.parse(params.get(ENTRY)!).descriptor.rateLimitPerHour).toBe(90);
    expect(JSON.parse(params.get(RECORD)!).source).toBe('runtime');
  });

  it('clears the limit with null', async () => {
    const res = await handler(signed('admin', '/admin/roster/ops-helper/limits', { rateLimitPerHour: null })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(params.get(RECORD)!).descriptor.rateLimitPerHour).toBeUndefined();
  });

  it.each([[0], [-5], [1.5], ['60']])('refuses %p before writing anything', async (value) => {
    const res = await handler(signed('admin', '/admin/roster/ops-helper/limits', { rateLimitPerHour: value })) as any;
    expect(res.statusCode).toBe(400);
    expect(puts()).toHaveLength(0);
  });

  it('refuses a declared assistant, naming the deploy that changes it', async () => {
    const res = await handler(signed('admin', '/admin/roster/advisor/limits', { rateLimitPerHour: 90 })) as any;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('TURN_LIMIT_IS_DEPLOYED');
    expect(puts()).toHaveLength(0);
  });
});

describe('a team member', () => {
  it('sets the limit of an assistant their team owns', async () => {
    const res = await handler(signed('team', '/admin/teams/ops/roster/ops-helper/limits', { rateLimitPerHour: 45 })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(params.get(RECORD)!).descriptor.rateLimitPerHour).toBe(45);
  });

  it('is refused for another team\'s assistant on their own team route', async () => {
    const res = await handler(signed('team', '/admin/teams/ops/roster/support-bot/limits', { rateLimitPerHour: 45 })) as any;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_NOT_OWNED');
    expect(puts()).toHaveLength(0);
  });

  it('is refused on a team route naming a team they are not in', async () => {
    const res = await handler(signed('team', '/admin/teams/support/roster/support-bot/limits', { rateLimitPerHour: 45 })) as any;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('TEAM_NOT_YOURS');
    expect(puts()).toHaveLength(0);
  });

  it('is refused on the admin route', async () => {
    const res = await handler(signed('team', '/admin/roster/ops-helper/limits', { rateLimitPerHour: 45 })) as any;
    expect(res.statusCode).toBe(403);
    expect(puts()).toHaveLength(0);
  });
});
