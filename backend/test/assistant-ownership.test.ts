/**
 * THE OWNERSHIP FUNCTION AND THE HANDLER RE-CHECK (SPEC-ADMIN-CONSOLE FR47, FR48).
 *
 * The function is the one writer of `owner-team`: a seed copies a profile's declared team onto a bot
 * with no owner and never over one, and a console change needs a reason and a team that exists. The
 * re-check refuses a team-scoped route for an assistant the caller's team does not own.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

type Tag = { Key: string; Value: string };
const bots: Record<string, { name: string; tags: Tag[] }> = {};
const sent: Array<{ type: string; input: any }> = [];
const groupsBySub: Record<string, string[]> = {};
const existingGroups = new Set<string>();

jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const cmd = (type: string) => jest.fn().mockImplementation((input) => ({ type, input }));
  return {
    ChimeSDKIdentityClient: jest.fn(() => ({
      send: async (c: { type: string; input: any }) => {
        sent.push(c);
        if (c.type === 'ListAppInstanceBots') {
          return { AppInstanceBots: Object.entries(bots).map(([arn, b]) => ({ AppInstanceBotArn: arn, Name: b.name })) };
        }
        if (c.type === 'ListTagsForResource') return { Tags: bots[c.input.ResourceARN]?.tags ?? [] };
        if (c.type === 'TagResource') {
          const b = bots[c.input.ResourceARN];
          for (const t of c.input.Tags) b.tags = [...b.tags.filter((x) => x.Key !== t.Key), t];
          return {};
        }
        if (c.type === 'UntagResource') {
          const b = bots[c.input.ResourceARN];
          b.tags = b.tags.filter((x) => !c.input.TagKeys.includes(x.Key));
          return {};
        }
        return {};
      },
    })),
    ListAppInstanceBotsCommand: cmd('ListAppInstanceBots'),
    ListTagsForResourceCommand: cmd('ListTagsForResource'),
    TagResourceCommand: cmd('TagResource'),
    UntagResourceCommand: cmd('UntagResource'),
  };
});
jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const cmd = (type: string) => jest.fn().mockImplementation((input) => ({ type, input }));
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({
      send: async (c: { type: string; input: any }) => {
        if (c.type === 'GetGroup') {
          if (!existingGroups.has(c.input.GroupName)) throw Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' });
          return {};
        }
        if (c.type === 'ListGroups') return { Groups: [...existingGroups].map((GroupName) => ({ GroupName })) };
        if (c.type === 'AdminListGroupsForUser') return { Groups: (groupsBySub[c.input.Username] ?? []).map((GroupName) => ({ GroupName })) };
        return {};
      },
    })),
    GetGroupCommand: cmd('GetGroup'),
    ListGroupsCommand: cmd('ListGroups'),
    AdminListGroupsForUserCommand: cmd('AdminListGroupsForUser'),
  };
});

// A runtime assistant's assignment record (ADR-048), read by the seed for a name no profile declares.
const ssmParams: Record<string, string> = {};
const ssmReads: string[] = [];
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({
    send: async (c: { input: { Name: string } }) => {
      ssmReads.push(c.input.Name);
      const v = ssmParams[c.input.Name];
      if (v === undefined) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
      return { Parameter: { Value: v } };
    },
  })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.SSM_ROOT = '/ae';
process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:1:app-instance/a';
process.env.USER_POOL_ID = 'us-east-1_pool';

import { handler } from '../lambda/src/assistant-ownership';
import { requireOwnedAssistant, isRefusal } from '../lambda/src/lib/assistant-scope';

const OPS = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/ops';
const ANALYST = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/analyst';
const SUB = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  sent.length = 0;
  for (const k of Object.keys(bots)) delete bots[k];
  bots[OPS] = { name: 'Ops', tags: [{ Key: 'assistant', Value: 'ops-premium' }, { Key: 'classification', Value: 'premium' }] };
  bots[ANALYST] = { name: 'Analyst', tags: [{ Key: 'assistant', Value: 'analyst' }, { Key: 'classification', Value: 'standard' }] };
  existingGroups.clear();
  existingGroups.add('team-ops');
  groupsBySub[SUB] = ['premium', 'team-members', 'team-ops'];
});

const owner = (arn: string) => bots[arn].tags.find((t) => t.Key === 'owner-team')?.Value ?? null;
const apiEvent = (method: string, body?: unknown): APIGatewayProxyEvent => ({
  httpMethod: method,
  path: '/admin/ownership',
  headers: {},
  body: body === undefined ? null : JSON.stringify(body),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/x-admin-console/console-${SUB}` } },
} as unknown as APIGatewayProxyEvent);

describe('seeding', () => {
  it('copies a declared owner onto a bot that has none', async () => {
    const out = await handler({ op: 'seed' }) as { seeded: unknown[] };
    expect(owner(OPS)).toBe('ops');
    // `analyst` declares no owner, so it stays admins-only.
    expect(owner(ANALYST)).toBeNull();
    expect(out.seeded).toHaveLength(1);
  });

  it('copies a runtime assistant\'s team from its own record, and asks nothing for a compiled one', async () => {
    const FIN = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/fin';
    bots[FIN] = { name: 'Finance', tags: [{ Key: 'assistant', Value: 'finance-advisor' }, { Key: 'classification', Value: 'premium' }, { Key: 'role', Value: 'primary' }] };
    const recordName = '/ae/assistant-assignments/premium/primary/assistants/finance-advisor';
    ssmParams[recordName] = JSON.stringify({ source: 'runtime', assistant: 'finance-advisor', botArn: FIN, ownerTeam: 'finance' });
    ssmReads.length = 0;
    await handler({ op: 'seed' });
    expect(owner(FIN)).toBe('finance');
    expect(ssmReads).toEqual([recordName]);
  });

  it('ignores a record that names another bot', async () => {
    const FIN = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/fin';
    bots[FIN] = { name: 'Finance', tags: [{ Key: 'assistant', Value: 'finance-advisor' }, { Key: 'classification', Value: 'premium' }, { Key: 'role', Value: 'primary' }] };
    ssmParams['/ae/assistant-assignments/premium/primary/assistants/finance-advisor'] = JSON.stringify({ source: 'runtime', assistant: 'finance-advisor', botArn: 'arn:other', ownerTeam: 'finance' });
    await handler({ op: 'seed', botArn: FIN });
    expect(owner(FIN)).toBeNull();
  });

  it('never overwrites an owner the console set', async () => {
    bots[OPS].tags.push({ Key: 'owner-team', Value: 'platform' });
    await handler({ op: 'seed', botArn: OPS });
    expect(owner(OPS)).toBe('platform');
  });
});

describe('changing ownership', () => {
  it('assigns a team to every bot of the assistant, with a reason', async () => {
    const res = await handler(apiEvent('POST', { assistant: 'analyst', team: 'ops', reason: 'ops runs analyst now' })) as { statusCode: number };
    expect(res.statusCode).toBe(200);
    expect(owner(ANALYST)).toBe('ops');
  });

  it('clears it with null, recorded as no team rather than removed', async () => {
    bots[ANALYST].tags.push({ Key: 'owner-team', Value: 'ops' });
    const res = await handler(apiEvent('POST', { assistant: 'analyst', team: null, reason: 'back to admins' })) as { statusCode: number };
    expect(res.statusCode).toBe(200);
    expect(owner(ANALYST)).toBe('_none');
    const listed = JSON.parse((await handler(apiEvent('GET')) as { body: string }).body);
    expect(listed.assistants.find((x: { assistant: string }) => x.assistant === 'analyst').ownerTeam).toBeNull();
  });

  it('does not hand a cleared assistant back to the team its profile declares', async () => {
    bots[OPS].tags.push({ Key: 'owner-team', Value: '_none' });
    await handler({ op: 'seed' });
    expect(owner(OPS)).toBe('_none');
  });

  it.each([
    ['no reason', { assistant: 'analyst', team: 'ops' }, 400, 'REASON_REQUIRED'],
    ['a team with no group', { assistant: 'analyst', team: 'nobody', reason: 'r' }, 400, 'TEAM_NOT_FOUND'],
    ['a malformed team', { assistant: 'analyst', team: 'Bad Team', reason: 'r' }, 400, 'TEAM_INVALID'],
    ['an unknown assistant', { assistant: 'ghost', team: 'ops', reason: 'r' }, 404, 'ASSISTANT_NOT_FOUND'],
  ])('refuses %s', async (_l, body, status, code) => {
    const res = await handler(apiEvent('POST', body)) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body).code).toBe(code);
    expect(owner(ANALYST)).toBeNull();
  });

  it('lists who owns what, and the teams that exist', async () => {
    bots[OPS].tags.push({ Key: 'owner-team', Value: 'ops' });
    const res = await handler(apiEvent('GET')) as { statusCode: number; body: string };
    const body = JSON.parse(res.body);
    expect(body.teams).toEqual(['ops']);
    expect(body.assistants.find((a: { assistant: string }) => a.assistant === 'ops-premium').ownerTeam).toBe('ops');
  });
});

describe('a team member assigning ownership', () => {
  const teamArn = `arn:aws:sts::1:assumed-role/x-team-console/console-${SUB}@premium`;
  const teamEvent = (assistant: string, body: unknown): APIGatewayProxyEvent => ({
    httpMethod: 'POST',
    path: `/admin/assistants/${assistant}/ownership`,
    pathParameters: { assistant },
    headers: {},
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: teamArn } },
  } as unknown as APIGatewayProxyEvent);
  const call = async (e: APIGatewayProxyEvent) => {
    const res = await handler(e) as { statusCode: number; body: string };
    return { status: res.statusCode, code: JSON.parse(res.body).code };
  };

  beforeEach(() => {
    bots[OPS].tags.push({ Key: 'owner-team', Value: 'ops' });
    existingGroups.add('team-platform');
    groupsBySub[SUB] = ['premium', 'team-members', 'team-ops', 'team-platform'];
  });

  it('moves an assistant their team owns to another of their own teams', async () => {
    expect(await call(teamEvent('ops-premium', { team: 'platform', reason: 'platform runs it now' }))).toEqual({ status: 200, code: undefined });
    expect(owner(OPS)).toBe('platform');
  });

  it.each([
    ['another team', { team: 'support', reason: 'r' }, 'TEAM_NOT_YOURS'],
    ['no team', { team: null, reason: 'r' }, 'TEAM_REQUIRED'],
  ])('refuses %s, and writes nothing', async (_what, body, code) => {
    expect(await call(teamEvent('ops-premium', body))).toEqual({ status: 403, code });
    expect(owner(OPS)).toBe('ops');
  });

  it('refuses an assistant their team does not own', async () => {
    expect((await call(teamEvent('analyst', { team: 'ops', reason: 'r' }))).status).toBe(403);
    expect(owner(ANALYST)).toBeNull();
  });

  it('refuses a body naming another assistant than the route', async () => {
    expect(await call(teamEvent('ops-premium', { assistant: 'analyst', team: 'ops', reason: 'r' }))).toEqual({ status: 403, code: 'ASSISTANT_MISMATCH' });
  });

  it('is refused on the admin route, which lists every owner and assigns any team', async () => {
    for (const method of ['GET', 'POST']) {
      const e = { ...apiEvent(method, { assistant: 'analyst', team: 'ops', reason: 'r' }), requestContext: { identity: { userArn: teamArn } } } as unknown as APIGatewayProxyEvent;
      expect(await call(e)).toEqual({ status: 403, code: 'ADMIN_ROUTE' });
    }
    expect(owner(ANALYST)).toBeNull();
  });

  it('leaves an administrator assigning any team on the admin route, and refuses them the team route', async () => {
    existingGroups.add('team-support');
    expect((await call(apiEvent('POST', { assistant: 'analyst', team: 'support', reason: 'support runs it' }))).status).toBe(200);
    expect(owner(ANALYST)).toBe('support');
    const adminOnTeamRoute = { ...teamEvent('ops-premium', { team: 'platform', reason: 'r' }), requestContext: apiEvent('POST').requestContext } as unknown as APIGatewayProxyEvent;
    expect(await call(adminOnTeamRoute)).toEqual({ status: 403, code: 'TEAM_ROUTE' });
  });
});

describe('the handler re-check on a team route', () => {
  const scoped = (assistant: string): APIGatewayProxyEvent => ({
    ...apiEvent('GET'),
    pathParameters: { assistant },
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/x-team-console/console-${SUB}` } },
  } as unknown as APIGatewayProxyEvent);

  it('admits the caller to an assistant their team owns', async () => {
    bots[OPS].tags.push({ Key: 'owner-team', Value: 'ops' });
    const r = await requireOwnedAssistant(scoped('ops-premium'));
    expect(isRefusal(r)).toBe(false);
    expect(r && !isRefusal(r) && r.bots.map((b) => b.botArn)).toEqual([OPS]);
  });

  it('refuses an assistant another team owns, or none does', async () => {
    bots[ANALYST].tags.push({ Key: 'owner-team', Value: 'support' });
    for (const a of ['analyst', 'ops-premium']) {
      const r = await requireOwnedAssistant(scoped(a));
      expect(isRefusal(r) && r.statusCode).toBe(403);
    }
  });

  it('is not involved on an unscoped route', async () => {
    expect(await requireOwnedAssistant(apiEvent('GET'))).toBeNull();
  });
});

describe('answering whether a person is in a team, for the provisioner', () => {
  const PERSON = `${process.env.APP_INSTANCE_ARN}/user/${SUB}`;
  const ask = (personArn: unknown, team: unknown) => handler({ op: 'in-team', personArn, team } as never);

  it('answers from the person\'s groups now', async () => {
    expect(await ask(PERSON, 'ops')).toEqual({ inTeam: true });
    groupsBySub[SUB] = ['premium', 'team-members'];
    expect(await ask(PERSON, 'ops')).toEqual({ inTeam: false });
  });

  it('never reads the `team-members` role group as a team', async () => {
    expect(await ask(PERSON, 'members')).toEqual({ inTeam: false });
  });

  it('answers no, and changes nothing, for anything but a person of this app instance and a team name', async () => {
    for (const [p, t] of [['arn:aws:chime:us-east-1:1:app-instance/other/user/' + SUB, 'ops'], [PERSON, 'ops/../x'], [null, 'ops'], [PERSON, 7]]) {
      expect(await ask(p, t)).toEqual({ inTeam: false });
    }
    expect(sent.filter((c) => c.type === 'TagResource' || c.type === 'UntagResource')).toEqual([]);
  });
});
