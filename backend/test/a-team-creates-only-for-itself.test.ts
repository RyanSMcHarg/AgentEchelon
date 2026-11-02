/**
 * A TEAM CREATES AN ASSISTANT ONLY FOR ITSELF (SPEC-ADMIN-CONSOLE, `manage-assistants` on a team route).
 *
 * The session policy names only the caller's own teams (`teamSessionPolicy`); this is the handler half:
 *   - a team member creates on `/admin/teams/{team}/roster` for a team their groups name, and the new
 *     assistant is owned by that team whatever the body says. Their groups are read by the ownership
 *     function (`op: 'in-team'`), asked about the person the signed session names, because this
 *     function's own role reads no directory;
 *   - a body naming another team, a route naming a team they are not in, and a classification their
 *     clearance does not reach are refused before anything is written;
 *   - the admin routes refuse a team console session, and the team route refuses an admin's;
 *   - an administrator still creates for any team, or for none;
 *   - the team's listing is its own runtime assistants and the classifications it may create in;
 *   - a team copies only an assistant it owns into a new one.
 */
const ssmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: ssmSend })) };
});
const chimeSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-identity');
  return { ...actual, ChimeSDKIdentityClient: jest.fn(() => ({ send: chimeSend })) };
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
process.env.AWS_LAMBDA_FUNCTION_NAME = 'AgentEchelonExperiments-ManageAssistants';
process.env.OWNERSHIP_FUNCTION_NAME = 'ae-assistant-ownership';
// Every admin route is AWS_IAM: the gateway vetted the signed console session before the handler runs.
process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/src/manage-assistants';
import { teamsOfGroups } from '../lambda/src/lib/assistant-ownership';

const SUB = '11111111-2222-3333-4444-555555555555';
const PERSON = `${process.env.APP_INSTANCE_ARN}/user/${SUB}`;
let groups: string[] = [];
/** The `owner-team` tags, by team: what the ownership function reads for a roster. */
let tagged: Record<string, string[]> = {};
const inTeamAsked: Array<{ personArn: string; team: string }> = [];

/** A request signed by a console session: a team member's (with their clearance) or an admin's. */
function signed(kind: 'team' | 'admin', path: string, method = 'POST', body: unknown = {}, clearance = 'premium'): APIGatewayProxyEvent {
  const session = kind === 'team' ? `console-${SUB}@${clearance}` : `console-${SUB}`;
  return {
    httpMethod: method,
    path,
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/ae-${kind}-console/${session}` } },
  } as unknown as APIGatewayProxyEvent;
}

const good = {
  assistantId: 'ops-helper',
  classification: 'premium',
  role: 'primary',
  displayName: 'Ops Helper',
  descriptor: { modelKey: 'sonnet', classifierMode: 'llm' },
};

let params: Map<string, string>;
beforeEach(() => {
  ssmSend.mockReset();
  // The ownership function answers `in-team` from the person's groups; every other invoke is the build.
  inTeamAsked.length = 0;
  lambdaSend.mockReset().mockImplementation(async (cmd: any) => {
    const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString());
    // The tags are the record of ownership: `owned-by` answers from them, `team-exists` from the groups.
    if (cmd.input.FunctionName === 'ae-assistant-ownership' && payload.op === 'owned-by') {
      return { Payload: Buffer.from(JSON.stringify({ assistants: tagged[payload.team] ?? [] })) };
    }
    if (cmd.input.FunctionName === 'ae-assistant-ownership' && payload.op === 'team-exists') {
      return { Payload: Buffer.from(JSON.stringify({ exists: ['ops', 'support'].includes(payload.team) })) };
    }
    if (cmd.input.FunctionName !== 'ae-assistant-ownership' || payload.op !== 'in-team') return {};
    inTeamAsked.push(payload);
    const inTeam = payload.personArn === PERSON && teamsOfGroups(groups).includes(payload.team);
    return { Payload: Buffer.from(JSON.stringify({ inTeam })) };
  });
  params = new Map([
    ['/ae/assistant-assignments/premium/primary/live', JSON.stringify({ classification: 'premium', role: 'primary', occupancy: 'live', assistant: 'advisor', botArn: 'arn:bot/advisor' })],
    ['/ae/assistant-directory/ops-old', JSON.stringify({ classification: 'premium', role: 'primary', status: 'active', ownerTeam: 'ops', displayName: 'Ops Old' })],
    ['/ae/assistant-directory/support-bot', JSON.stringify({ classification: 'standard', role: 'primary', status: 'active', ownerTeam: 'support' })],
  ]);
  ssmSend.mockImplementation(async (cmd: any) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetParameterCommand':
        if (!params.has(i.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Name: i.Name, Value: params.get(i.Name) } };
      case 'PutParameterCommand':
        if (!i.Overwrite && params.has(i.Name)) throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
        params.set(i.Name, i.Value);
        return {};
      case 'GetParametersByPathCommand':
        return { Parameters: [...params].filter(([k]) => k.startsWith(`${i.Path}/`)).map(([Name, Value]) => ({ Name, Value })) };
      default:
        return {};
    }
  });
  groups = ['premium', 'team-members', 'team-ops'];
  tagged = { ops: ['ops-old'], support: ['support-bot'] };
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

const written = () => ssmSend.mock.calls.map((c) => c[0]).filter((c: any) => c.constructor.name === 'PutParameterCommand');
/** The build hand-offs: this function invoking itself with `op: 'provision'`. */
const builds = () => lambdaSend.mock.calls.map((c) => c[0].input).filter((i: any) => i.FunctionName === process.env.AWS_LAMBDA_FUNCTION_NAME);
const entry = (id: string) => JSON.parse(params.get(`/ae/assistant-directory/${id}`) || 'null');

describe('a team member creating an assistant', () => {
  it('creates for their own team, owned by it', async () => {
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'POST', good)) as any;
    expect(res.statusCode).toBe(202);
    expect(entry('ops-helper').ownerTeam).toBe('ops');
    // Asked about the person the signed session names, for the route's team.
    expect(inTeamAsked).toEqual([{ op: 'in-team', personArn: PERSON, team: 'ops' }]);
  });

  it('makes the route\'s team the owner when the body names none', async () => {
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'POST', { ...good, ownerTeam: undefined })) as any;
    expect(res.statusCode).toBe(202);
    expect(entry('ops-helper').ownerTeam).toBe('ops');
  });

  it.each([
    ['a body naming another team', '/admin/teams/ops/roster', { ...good, ownerTeam: 'support' }, 'TEAM_NOT_YOURS'],
    ['a route naming a team they are not in', '/admin/teams/support/roster', good, 'TEAM_NOT_YOURS'],
    ['a classification their clearance does not reach', '/admin/teams/ops/roster', { ...good, classification: 'admin' }, 'CLASSIFICATION_NOT_CLEARED'],
  ])('refuses %s, and writes nothing', async (_what, path, body, code) => {
    const res = await handler(signed('team', path, 'POST', body)) as any;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe(code);
    expect(written()).toEqual([]);
    expect(builds()).toEqual([]);
  });

  it('refuses a copy of an assistant the team does not own, before anything is checked or written', async () => {
    // support-bot is the support team's: a copy would show the ops team its configuration.
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'POST', { ...good, startingPoint: { kind: 'copy', from: 'support-bot' } })) as any;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('COPY_SOURCE_NOT_OWNED');
    expect(written()).toEqual([]);
    expect(builds()).toEqual([]);
  });

  it('refuses a person whose groups no longer name the team, though the session still does', async () => {
    groups = ['premium', 'team-members'];
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'POST', good)) as any;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('TEAM_NOT_YOURS');
    expect(written()).toEqual([]);
    expect(builds()).toEqual([]);
  });

  it('fails rather than refuses when the team check is not answered, and writes nothing', async () => {
    lambdaSend.mockImplementation(async () => ({ FunctionError: 'Unhandled' }));
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'POST', good)) as any;
    expect(res.statusCode).toBe(500);
    expect(written()).toEqual([]);
  });

  it('is refused on the admin routes, which create for any team and retire', async () => {
    for (const path of ['/admin/roster', '/admin/roster/ops-old/retire']) {
      const res = await handler(signed('team', path, 'POST', { ...good, ownerTeam: 'ops', reason: 'r' })) as any;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('ADMIN_ROUTE');
    }
    expect(written()).toEqual([]);
  });

  it('lists its own team\'s runtime assistants and where it may create one', async () => {
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'GET')) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.team).toBe('ops');
    expect(body.runtimeAssistants.map((a: { assistant: string }) => a.assistant)).toEqual(['ops-old']);
    const targets = body.rosterTargets.map((t: { classification: string }) => t.classification);
    expect(targets).toContain('premium');
    expect(targets).not.toContain('admin');
  });
});

describe('an administrator creating an assistant', () => {
  it('creates for any team on the admin route', async () => {
    const res = await handler(signed('admin', '/admin/roster', 'POST', { ...good, ownerTeam: 'support' })) as any;
    expect(res.statusCode).toBe(202);
    expect(entry('ops-helper').ownerTeam).toBe('support');
  });

  it('creates for no team', async () => {
    const res = await handler(signed('admin', '/admin/roster', 'POST', good)) as any;
    expect(res.statusCode).toBe(202);
    expect(entry('ops-helper').ownerTeam).toBeUndefined();
  });

  it('is refused on a team route', async () => {
    const res = await handler(signed('admin', '/admin/teams/ops/roster', 'POST', good)) as any;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('TEAM_ROUTE');
  });
});

describe('a clearance that does not reach a real conversational classification', () => {
  it('refuses a basic-cleared team member creating at premium, and writes nothing', async () => {
    groups = ['basic', 'team-members', 'team-ops'];
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'POST', good, 'basic')) as any;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('CLASSIFICATION_NOT_CLEARED');
    expect(written()).toEqual([]);
    expect(builds()).toEqual([]);
  });

  it('offers a basic-cleared team member no premium target', async () => {
    params.set('/ae/assistant-assignments/basic/primary/live', JSON.stringify({ classification: 'basic', role: 'primary', occupancy: 'live', assistant: 'guide' }));
    const res = await handler(signed('team', '/admin/teams/ops/roster', 'GET', {}, 'basic')) as any;
    const targets = JSON.parse(res.body).rosterTargets.map((t: { classification: string }) => t.classification);
    expect(targets).toEqual(['basic']);
  });
});

describe('an administrator naming an owner', () => {
  it('refuses a team that does not exist, and writes nothing', async () => {
    const res = await handler(signed('admin', '/admin/roster', 'POST', { ...good, ownerTeam: 'nosuchteam' })) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('TEAM_NOT_FOUND');
    expect(written()).toEqual([]);
    expect(builds()).toEqual([]);
  });
});

describe('the roster follows the owner tag', () => {
  it('an assistant moved to another team leaves the old roster and joins the new one', async () => {
    // Created for ops (its entry says so); the tag now names support.
    tagged = { ops: [], support: ['ops-old', 'support-bot'] };
    groups = ['premium', 'team-members', 'team-ops', 'team-support'];
    const ops = JSON.parse((await handler(signed('team', '/admin/teams/ops/roster', 'GET')) as any).body);
    const support = JSON.parse((await handler(signed('team', '/admin/teams/support/roster', 'GET')) as any).body);
    expect(ops.runtimeAssistants.map((a: { assistant: string }) => a.assistant)).toEqual([]);
    expect(support.runtimeAssistants.map((a: { assistant: string }) => a.assistant).sort()).toEqual(['ops-old', 'support-bot']);
    expect(support.runtimeAssistants.find((a: { assistant: string }) => a.assistant === 'ops-old').ownerTeam).toBe('support');
  });

  it('a build with no identity yet is listed under the team it was created for', async () => {
    params.set('/ae/assistant-directory/ops-new', JSON.stringify({ classification: 'premium', role: 'primary', status: 'provisioning', ownerTeam: 'ops', createdAt: new Date().toISOString() }));
    const ops = JSON.parse((await handler(signed('team', '/admin/teams/ops/roster', 'GET')) as any).body);
    expect(ops.runtimeAssistants.map((a: { assistant: string }) => a.assistant).sort()).toEqual(['ops-new', 'ops-old']);
  });
});
