/**
 * ADR-048, `manage-assistants`: creating and retiring an assistant at runtime.
 *
 * What it proves, against mocked AWS clients:
 *   - the capability gate, and that a refused caller reaches no AWS call;
 *   - every reserved name is refused, a taken or tombstoned name is never reused, a role that is not
 *     enabled is refused, a model the classification cannot reach is refused, and a display name another
 *     assistant in the classification already shows is refused;
 *   - a create takes the name with `Overwrite: false` and hands the build off, answering 202;
 *   - the build creates a tagged Lex bot and a tagged identity, writes the record with its Lex bot id,
 *     asks the ownership function to seed, and marks the directory active;
 *   - a build claims itself first, so a duplicated invoke builds nothing, and records each id as it goes;
 *   - a build that fails undoes what it built and stays visible as failed; removing it releases the name;
 *   - a build that died without recording its end reads as failed after the build deadline, and retire
 *     removes it from the ids it recorded;
 *   - a display name is locked per classification, so two creates in flight cannot both show it;
 *   - retire stops admission first, deletes the identity, the Lex bot and the record, and leaves a
 *     tombstone; an identity or Lex bot already gone is success, and a denial counts as gone only when a
 *     listing confirms it; a retire stopped partway is finished by retiring again;
 *   - every outcome writes one audit line.
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
const lexSend = jest.fn();
jest.mock('@aws-sdk/client-lex-models-v2', () => {
  const actual = jest.requireActual('@aws-sdk/client-lex-models-v2');
  return { ...actual, LexModelsV2Client: jest.fn(() => ({ send: lexSend })) };
});
const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: jest.fn(() => ({ send: lambdaSend })) };
});
// The build's session: the provisioner role, assumed with the classification as a session tag.
const stsCalls: any[] = [];
jest.mock('@aws-sdk/client-sts', () => {
  const actual = jest.requireActual('@aws-sdk/client-sts');
  return {
    ...actual,
    STSClient: jest.fn(() => ({
      send: async (cmd: { input: unknown }) => {
        stsCalls.push(cmd.input);
        return { Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'token' } };
      },
    })),
  };
});

process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.SSM_ROOT = '/ae';
process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/ai';
process.env.RUNTIME_LEX_BOT_ROLE_ARN = 'arn:aws:iam::123456789012:role/RuntimeLex';
process.env.RUNTIME_PROVISIONER_ROLE_ARN = 'arn:aws:iam::123456789012:role/RuntimeProvisioner';
process.env.OWNERSHIP_FUNCTION_NAME = 'ae-assistant-ownership';
process.env.MANAGE_PROFILES_FUNCTION_NAME = 'ae-manage-profiles';
process.env.ROUTER_FUNCTION_PREFIX = 'AgentEchelon';
process.env.AWS_LAMBDA_FUNCTION_NAME = 'AgentEchelonExperiments-ManageAssistants';
process.env.LEX_CONVERSATION_LOG_GROUP_ARN = 'arn:aws:logs:us-east-1:123456789012:log-group:RuntimeLexLogs:*';
// The provisioner, the one principal that builds and removes every identity: invoked by this function, and run
// here in-process (below) on the same mocked AWS clients, so the build is asserted end to end.
process.env.PROVISIONER_FUNCTION_NAME = 'ae-assistant-provisioner';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, provision, lexBotNameFor, identityRequestToken } from '../lambda/src/manage-assistants';
import { handler as provisionerHandler } from '../lambda/src/assistant-provisioner-function';
import { BUILD_DEADLINE_MS } from '../lambda/src/lib/runtime-directory';
import { timing } from '../lambda/src/lib/assistant-lex-bot';
import { edgeContext } from './helpers/edge-context';

timing.readyPollMs = 0; timing.buildPollMs = 0; timing.afterCreateMs = 0;

const ROUTER = 'arn:aws:lambda:us-east-1:123456789012:function:AgentEchelonAssistants-premium-AgentHandler';
const BOT = `${process.env.APP_INSTANCE_ARN}/bot/finance-bot`;

function evt(over: { groups?: string; path?: string; body?: unknown; method?: string } = {}): APIGatewayProxyEvent {
  const { groups = 'admins', path = '/admin/roster', body = {}, method = 'POST' } = over;
  return {
    httpMethod: method,
    path,
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin-1', 'cognito:groups': groups } }) },
  } as unknown as APIGatewayProxyEvent;
}

const good = {
  assistantId: 'finance-advisor',
  classification: 'premium',
  role: 'primary',
  displayName: 'Finance',
  descriptor: { modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 120 },
  ownerTeam: 'finance',
};

const notFound = () => Object.assign(new Error('nf'), { name: 'ParameterNotFound' });

/** An in-memory SSM: parameters by name, honoring `Overwrite: false`. */
let params: Map<string, string>;
function fakeSsm() {
  ssmSend.mockImplementation(async (cmd: any) => {
    const name = cmd.constructor.name;
    const i = cmd.input;
    if (name === 'GetParameterCommand') {
      if (!params.has(i.Name)) throw notFound();
      return { Parameter: { Name: i.Name, Value: params.get(i.Name), LastModifiedDate: new Date() } };
    }
    if (name === 'PutParameterCommand') {
      if (!i.Overwrite && params.has(i.Name)) throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
      params.set(i.Name, i.Value);
      return {};
    }
    if (name === 'DeleteParameterCommand') {
      if (!params.delete(i.Name)) throw notFound();
      return {};
    }
    if (name === 'GetParametersByPathCommand') {
      return { Parameters: [...params].filter(([k]) => k.startsWith(`${i.Path}/`)).map(([Name, Value]) => ({ Name, Value })) };
    }
    throw new Error(`unexpected ${name}`);
  });
}

/** A Lex that builds instantly. */
function fakeLex() {
  lexSend.mockImplementation(async (cmd: any) => {
    switch (cmd.constructor.name) {
      case 'CreateBotCommand': return { botId: 'LEXBOT1' };
      case 'DescribeBotLocaleCommand': return { botLocaleStatus: 'Built' };
      case 'ListIntentsCommand': return { intentSummaries: [{ intentName: 'FallbackIntent', intentId: 'FB' }] };
      case 'ListBotAliasesCommand': return { botAliasSummaries: [{ botAliasName: 'TestBotAlias', botAliasId: 'TSTALIASID' }] };
      default: return {};
    }
  });
}

/** The build hand-offs: this function invoking itself asynchronously. */
const builds = () => sent(lambdaSend, 'InvokeCommand').filter((i: any) => i.FunctionName === process.env.AWS_LAMBDA_FUNCTION_NAME);
const sent = (mock: jest.Mock, name: string) => mock.mock.calls.map((c) => c[0]).filter((c: any) => c.constructor.name === name).map((c: any) => c.input);
let logs: string[];

beforeEach(() => {
  for (const m of [ssmSend, chimeSend, lexSend, lambdaSend]) m.mockReset();
  params = new Map([
    ['/ae/assistant-assignments/premium/primary/live', JSON.stringify({ classification: 'premium', role: 'primary', occupancy: 'live', assistant: 'advisor', botArn: 'arn:bot/advisor' })],
    ['/ae/assistant/premium/router-arn', ROUTER],
  ]);
  fakeSsm();
  fakeLex();
  chimeSend.mockImplementation(async (cmd: any) => (cmd.constructor.name === 'CreateAppInstanceBotCommand' ? { AppInstanceBotArn: BOT } : {}));
  lambdaSend.mockImplementation(async (cmd: any) => {
    const p = cmd.input?.Payload ? JSON.parse(Buffer.from(cmd.input.Payload).toString()) : {};
    const answer = (v: unknown) => ({ Payload: Buffer.from(JSON.stringify(v)) });
    if (cmd.input?.FunctionName === process.env.PROVISIONER_FUNCTION_NAME) {
      try {
        return answer(await provisionerHandler(p));
      } catch (err) {
        return { FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: (err as Error).message })) };
      }
    }
    if (p.op === 'team-exists') return answer({ exists: ['finance', 'ops'].includes(p.team) });
    if (p.op === 'seed') return answer({ seeded: [{ botArn: p.botArn, assistant: 'finance-advisor', team: 'finance' }] });
    if (p.aeSeedFirstDraft) return answer({ seeded: true, configId: 'cfg-1' });
    if (p.aeCheckStartingPoint) return answer({ errors: [] });
    return {};
  });
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const audits = () => logs.filter((l) => l.includes('"_audit":"manage-assistants"')).map((l) => JSON.parse(l));

describe('the capability gate', () => {
  it('a team member is refused and reaches no AWS call', async () => {
    const res = await handler(evt({ groups: 'team-finance', body: good })) as any;
    expect(res.statusCode).toBe(403);
    expect(ssmSend).not.toHaveBeenCalled();
    expect(lambdaSend).not.toHaveBeenCalled();
  });
});

describe('create refuses what it must', () => {
  const refused = async (body: unknown) => {
    const res = await handler(evt({ body })) as any;
    expect(res.statusCode).toBe(400);
    expect(sent(ssmSend, 'PutParameterCommand')).toEqual([]);
    return JSON.parse(res.body).errors.join(' | ');
  };

  it.each([
    ['a classification value', 'premium'],
    ['a declared assistant', 'advisor'],
    ['an alt', 'alt-primary-premium'],
    ['a composed role name', 'ops-premium'],
  ])('refuses %s as a name', async (_what, assistantId) => {
    expect(await refused({ ...good, assistantId })).toMatch(/reserved/);
  });

  it('refuses a name that is not safe for an IAM path', async () => {
    expect(await refused({ ...good, assistantId: 'Finance Advisor' })).toMatch(/lowercase/);
  });

  it('refuses consecutive hyphens, so distinct ids never map to one Lex bot name', async () => {
    expect(await refused({ ...good, assistantId: 'finance--advisor' })).toMatch(/consecutive hyphens/);
    expect(lexBotNameFor('team-x')).toBe('rt-team-x');
    expect(lexBotNameFor('team-x')).not.toBe(lexBotNameFor('teamx'));
  });

  it('refuses the admin plane and an undeclared role', async () => {
    expect(await refused({ ...good, classification: 'admin' })).toMatch(/not a conversational classification/);
    expect(await refused({ ...good, role: 'sales' })).toMatch(/not a role/);
  });

  it('takes a role the registry row deploys, with no record to say so (ADR-048, amended 2026-10-23)', async () => {
    // A role is enabled when its classification's stack deploys it, read from the registry row; no assignment
    // record is consulted, so a role whose declared assistant was retired still takes a console-created one.
    const res = await handler(evt({ body: { ...good, role: 'ops', displayName: 'Ops Two' } })) as any;
    expect(res.statusCode).toBe(202);
  });

  it('refuses a model the classification cannot reach', async () => {
    expect(await refused({ ...good, classification: 'basic', descriptor: { ...good.descriptor, modelKey: 'opus' } })).toMatch(/not selected by the basic/);
  });

  it('refuses a display name another assistant in the classification already shows', async () => {
    expect(await refused({ ...good, displayName: 'advisor' })).toMatch(/already shows the name/);
  });

  it('a taken name, a tombstone included, is never reused', async () => {
    params.set('/ae/assistant-directory/finance-advisor', JSON.stringify({ classification: 'premium', role: 'primary', status: 'retired' }));
    const res = await handler(evt({ body: good })) as any;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_NAME_TAKEN');
    expect(builds()).toEqual([]);
  });
});

describe('create takes the name and hands off the build', () => {
  it('locks the name with Overwrite false, invokes itself asynchronously, and answers 202', async () => {
    const res = await handler(evt({ body: good })) as any;
    expect(res.statusCode).toBe(202);
    const lock = sent(ssmSend, 'PutParameterCommand')[0];
    expect(lock).toMatchObject({ Name: '/ae/assistant-directory/finance-advisor', Overwrite: false });
    expect(JSON.parse(lock.Value)).toMatchObject({ status: 'provisioning', classification: 'premium', role: 'primary', createdBy: 'admin-1' });
    const invoke = builds()[0];
    expect(builds()).toHaveLength(1);
    expect(invoke).toMatchObject({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event' });
    expect(audits()).toEqual([expect.objectContaining({ action: 'create-requested', actor: 'admin-1', assistant: 'finance-advisor' })]);
  });

  it('a second create showing the same name while the first is still building is refused, and its id released', async () => {
    expect((await handler(evt({ body: good })) as any).statusCode).toBe(202);
    const res = await handler(evt({ body: { ...good, assistantId: 'finance-helper', displayName: '  FINANCE ' } })) as any;
    // The first create's entry already counts as a name in use (400); the lock (409) is what stops two
    // creates that both read before either wrote. Either way the second takes no id and builds nothing.
    expect([400, 409]).toContain(res.statusCode);
    expect(JSON.stringify(JSON.parse(res.body))).toMatch(/already shows the name/);
    expect(params.has('/ae/assistant-directory/finance-helper')).toBe(false);
    expect(builds()).toHaveLength(1);
  });
});

describe('the build', () => {
  beforeEach(async () => { await handler(evt({ body: good })); logs = []; });

  it('creates a tagged Lex bot and a tagged identity, records both, seeds ownership and goes active', async () => {
    await provision('finance-advisor');
    const lexCreate = sent(lexSend, 'CreateBotCommand')[0];
    const tags = { classification: 'premium', assistant: 'finance-advisor', role: 'primary', provisioner: 'runtime' };
    expect(lexCreate).toMatchObject({ botTags: tags, testBotAliasTags: tags, roleArn: process.env.RUNTIME_LEX_BOT_ROLE_ARN });
    // No version: the alias serves DRAFT and the grant names no bot-version resource.
    expect(sent(lexSend, 'CreateBotVersionCommand')).toEqual([]);
    expect(sent(lexSend, 'UpdateBotAliasCommand')[0].botAliasLocaleSettings.en_US.codeHookSpecification.lambdaCodeHook.lambdaARN).toBe(ROUTER);
    const bot = sent(chimeSend, 'CreateAppInstanceBotCommand')[0];
    expect(bot.Tags).toEqual(expect.arrayContaining([{ Key: 'provisioner', Value: 'runtime' }, { Key: 'assistant', Value: 'finance-advisor' }]));
    expect(bot.Configuration.Lex).toMatchObject({ InvokedBy: { StandardMessages: 'NONE', TargetedMessages: 'ALL' }, WelcomeIntent: 'WelcomeIntent' });
    expect(bot.Configuration.Lex.LexBotAliasArn).toBe('arn:aws:lex:us-east-1:123456789012:bot-alias/LEXBOT1/TSTALIASID');
    // One token per create, inside the 64-character limit, so a re-create of a released name never replays it.
    expect(bot.ClientRequestToken).toBe(identityRequestToken('finance-advisor', JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!).createdAt));
    expect(bot.ClientRequestToken.length).toBeLessThanOrEqual(64);
    expect(identityRequestToken('a'.repeat(63), '2026-10-13T00:00:00.000Z')).not.toBe(identityRequestToken('a'.repeat(63), '2026-10-13T00:00:01.000Z'));
    // Text conversation logs, as a deploy-time bot has, without the trailing :* Lex refuses.
    expect(sent(lexSend, 'UpdateBotAliasCommand')[0].conversationLogSettings.textLogSettings[0].destination.cloudWatch.cloudWatchLogGroupArn)
      .toBe('arn:aws:logs:us-east-1:123456789012:log-group:RuntimeLexLogs');
    const record = JSON.parse(params.get('/ae/assistant-assignments/premium/primary/assistants/finance-advisor')!);
    expect(record).toMatchObject({ source: 'runtime', status: 'active', occupancy: 'live', botArn: BOT, lexBotId: 'LEXBOT1', ownerTeam: 'finance' });
    expect(sent(lambdaSend, 'InvokeCommand').find((i: any) => i.FunctionName === 'ae-assistant-ownership')).toBeTruthy();
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({ status: 'active', botArn: BOT, lexBotId: 'LEXBOT1' });
    expect(audits()).toEqual([expect.objectContaining({ action: 'created', botArn: BOT, lexBotId: 'LEXBOT1' })]);
  });

  it('builds on a session of the provisioner role tagged with the classification it builds at', async () => {
    await provision('finance-advisor');
    // Kept per classification for most of its hour, so an earlier build in this file may have taken it.
    expect(stsCalls).toContainEqual(expect.objectContaining({
      RoleArn: process.env.RUNTIME_PROVISIONER_ROLE_ARN,
      Tags: [{ Key: 'classification', Value: 'premium' }],
    }));
  });

  it('refuses a router ARN that is not one of this deployment\'s functions, builds nothing, and says why', async () => {
    params.set('/ae/assistant/premium/router-arn', 'arn:aws:lambda:us-east-1:123456789012:function:SomeoneElse');
    await provision('finance-advisor');
    expect(sent(lexSend, 'CreateBotCommand')).toEqual([]);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({
      status: 'failed', leftover: [], error: expect.stringMatching(/router ARN/),
    });
  });

  it('a failed identity create deletes the Lex bot and stays visible as failed', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'CreateAppInstanceBotCommand') throw Object.assign(new Error('denied'), { name: 'ForbiddenException' });
      return {};
    });
    await provision('finance-advisor');
    expect(sent(lexSend, 'DeleteBotCommand')).toEqual([{ botId: 'LEXBOT1', skipResourceInUseCheck: true }]);
    const entry = JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!);
    expect(entry).toMatchObject({ status: 'failed', leftover: [], error: 'denied' });
    expect(entry.lexBotId).toBeUndefined();
    expect(params.has('/ae/assistant-assignments/premium/primary/assistants/finance-advisor')).toBe(false);
    expect(audits()).toEqual([expect.objectContaining({ action: 'create-failed', leftover: [] })]);
  });

  it('undoes a build the provisioner answered as done but with no identity, rather than leaving its Lex bot', async () => {
    // The provisioner undoes only a build it answers as failed. One answered ok with no identity left its Lex bot.
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => {
      const p = cmd.input?.Payload ? JSON.parse(Buffer.from(cmd.input.Payload).toString()) : {};
      if (cmd.input?.FunctionName === process.env.PROVISIONER_FUNCTION_NAME && p.op === 'build') {
        return { Payload: Buffer.from(JSON.stringify({ ok: true, lexBotId: 'LEXBOT1' })) };
      }
      return base(cmd);
    });
    await provision('finance-advisor');
    const removes = sent(lambdaSend, 'InvokeCommand')
      .filter((i: any) => i.FunctionName === process.env.PROVISIONER_FUNCTION_NAME)
      .map((i: any) => JSON.parse(Buffer.from(i.Payload).toString()))
      .filter((p: any) => p.op === 'remove');
    expect(removes).toEqual([expect.objectContaining({ op: 'remove', assistantId: 'finance-advisor', lexBotId: 'LEXBOT1' })]);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({ status: 'failed' });
  });

  it('asks the provisioner once per claim: its client does not retry, since a retry would arrive unclaimed', () => {
    const src = (f: string) => require('fs').readFileSync(require('path').join(__dirname, '..', 'lambda', 'src', f), 'utf8') as string;
    expect(src('manage-assistants.ts')).toContain('const provisionerClient = new LambdaClient({ region: REGION, maxAttempts: 1 });');
    expect(src('manage-assistants.ts')).toContain('return await ask<T>(PROVISIONER_FUNCTION_NAME, request, provisionerClient);');
    expect(src('seed-declared-assistants.ts')).toContain('const lambdaClient = new LambdaClient({ region: REGION, maxAttempts: 1 });');
  });

  it('what cannot be undone is recorded, and the name stays taken', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'CreateAppInstanceBotCommand') throw new Error('denied');
      return {};
    });
    lexSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteBotCommand') throw new Error('throttled');
      return fakeLexAnswer(cmd);
    });
    await provision('finance-advisor');
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({ status: 'failed', leftover: ['Lex bot LEXBOT1'] });
  });

  it('runs once: a second build of an active assistant does nothing', async () => {
    await provision('finance-advisor');
    lexSend.mockClear();
    await provision('finance-advisor');
    expect(sent(lexSend, 'CreateBotCommand')).toEqual([]);
  });

  it('a duplicated invoke finds the build claimed and builds nothing', async () => {
    params.set('/ae/assistant-directory/_build/finance-advisor', JSON.stringify({ at: new Date().toISOString() }));
    await provision('finance-advisor');
    expect(sent(lexSend, 'CreateBotCommand')).toEqual([]);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!).status).toBe('provisioning');
  });

  it('records the Lex bot id on the entry as soon as the bot exists, before the build finishes', async () => {
    let seenDuringBuild: any;
    lexSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'BuildBotLocaleCommand') seenDuringBuild = JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!);
      return fakeLexAnswer(cmd);
    });
    await provision('finance-advisor');
    expect(seenDuringBuild).toMatchObject({ status: 'provisioning', lexBotId: 'LEXBOT1' });
  });
});

function fakeLexAnswer(cmd: any) {
  switch (cmd.constructor.name) {
    case 'CreateBotCommand': return { botId: 'LEXBOT1' };
    case 'DescribeBotLocaleCommand': return { botLocaleStatus: 'Built' };
    case 'ListBotAliasesCommand': return { botAliasSummaries: [{ botAliasName: 'TestBotAlias', botAliasId: 'TSTALIASID' }] };
    default: return {};
  }
}

describe('retire', () => {
  const retirePath = '/admin/roster/finance-advisor/retire';
  beforeEach(async () => { await handler(evt({ body: good })); await provision('finance-advisor'); logs = []; chimeSend.mockClear(); lexSend.mockClear(); });

  it('stops admission first, then deletes the identity, the Lex bot and the record, and leaves a tombstone', async () => {
    const order: string[] = [];
    const base = ssmSend.getMockImplementation()!;
    ssmSend.mockImplementation(async (cmd: any) => {
      // The claim the request to the provisioner carries is a digest, not a record.
      if (cmd.constructor.name === 'PutParameterCommand' && !cmd.input.Name.includes('/provisioner-claims/')) order.push(`put:${JSON.parse(cmd.input.Value).status}`);
      return base(cmd);
    });
    chimeSend.mockImplementation(async (cmd: any) => { order.push(cmd.constructor.name); return {}; });
    const res = await handler(evt({ path: retirePath, body: { reason: 'replaced' } })) as any;
    expect(res.statusCode).toBe(200);
    expect(order.slice(0, 2)).toEqual(['put:retiring', 'put:retiring']);
    expect(order).toContain('DeleteAppInstanceBotCommand');
    expect(order.indexOf('DeleteAppInstanceBotCommand')).toBeGreaterThan(1);
    expect(sent(lexSend, 'DeleteBotCommand')[0]).toMatchObject({ botId: 'LEXBOT1' });
    expect(params.has('/ae/assistant-assignments/premium/primary/assistants/finance-advisor')).toBe(false);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({ status: 'retired', retiredBy: 'admin-1', reason: 'replaced' });
    expect(audits()).toEqual([expect.objectContaining({ action: 'retired', botArn: BOT, lexBotId: 'LEXBOT1' })]);
  });

  it('an identity already gone is success', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') throw Object.assign(new Error('gone'), { name: 'NotFoundException' });
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(200);
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([]);
  });

  it('a deleted identity answers Describe with Forbidden, and the list settles that it is gone', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') throw Object.assign(new Error('not allowed'), { name: 'ForbiddenException' });
      if (cmd.constructor.name === 'ListAppInstanceBotsCommand') return { AppInstanceBots: [{ AppInstanceBotArn: 'arn:other' }] };
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(200);
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([]);
  });

  it('a Forbidden on an identity the app instance still lists is a failure, not a retire', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') throw Object.assign(new Error('not allowed'), { name: 'ForbiddenException' });
      if (cmd.constructor.name === 'ListAppInstanceBotsCommand') return { AppInstanceBots: [{ AppInstanceBotArn: BOT }] };
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!).status).toBe('retiring');
  });

  it('an identity that cannot be deleted leaves the assistant retiring, which admits nothing', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteAppInstanceBotCommand') throw new Error('denied');
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!).status).toBe('retiring');
    expect(JSON.parse(params.get('/ae/assistant-assignments/premium/primary/assistants/finance-advisor')!).status).toBe('retiring');
  });

  it("a deleted identity answers the provisioner's session with the IAM layer's AccessDeniedException, and the list settles that it is gone", async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') {
        throw Object.assign(new Error('User: provisioner-premium is not authorized to perform: chime:DescribeAppInstanceBot'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
      }
      if (cmd.constructor.name === 'ListAppInstanceBotsCommand') return { AppInstanceBots: [{ AppInstanceBotArn: 'arn:other' }] };
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(200);
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([]);
  });

  it('a denial on an identity whose listing also fails is a failure, not a retire', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      if (cmd.constructor.name === 'ListAppInstanceBotsCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!).status).toBe('retiring');
  });

  it('a deleted Lex bot answers DeleteBot with AccessDenied, and the list settles that it is gone', async () => {
    lexSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteBotCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
      if (cmd.constructor.name === 'ListBotsCommand') {
        return cmd.input.nextToken ? { botSummaries: [{ botId: 'OTHER2' }] } : { botSummaries: [{ botId: 'OTHER1' }], nextToken: 'page-2' };
      }
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).leftover).toBeUndefined();
    expect(sent(lexSend, 'ListBotsCommand')).toHaveLength(2);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({ status: 'retired', leftover: [] });
  });

  it('a Lex bot listing that fails leaves the bot on the tombstone', async () => {
    lexSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteBotCommand' || cmd.constructor.name === 'ListBotsCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).leftover).toEqual(['Lex bot LEXBOT1']);
  });

  it('a retire stopped partway is finished by retiring again, once the resources it named are gone', async () => {
    // The first attempt cannot settle the identity, so the entry stays retiring.
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      if (cmd.constructor.name === 'ListAppInstanceBotsCommand') throw new Error('throttled');
      return {};
    });
    expect(((await handler(evt({ path: retirePath }))) as any).statusCode).toBe(500);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!).status).toBe('retiring');
    // Both resources are already deleted: each answers with a denial, and neither is listed.
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DescribeAppInstanceBotCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      if (cmd.constructor.name === 'ListAppInstanceBotsCommand') return { AppInstanceBots: [] };
      return {};
    });
    lexSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteBotCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      if (cmd.constructor.name === 'ListBotsCommand') return { botSummaries: [] };
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'retired' });
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({ status: 'retired', leftover: [] });
  });

  it('a Lex bot that cannot be deleted is recorded on the tombstone, not passed off as a clean retire', async () => {
    lexSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteBotCommand') throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      // Still listed: the denial is not a deleted bot.
      if (cmd.constructor.name === 'ListBotsCommand') return { botSummaries: [{ botId: 'LEXBOT1' }] };
      return {};
    });
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).leftover).toEqual(['Lex bot LEXBOT1']);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).toMatchObject({ status: 'retired', leftover: ['Lex bot LEXBOT1'] });
  });

  it('retiring twice answers the tombstone', async () => {
    await handler(evt({ path: retirePath }));
    const res = await handler(evt({ path: retirePath })) as any;
    expect(JSON.parse(res.body)).toMatchObject({ status: 'retired', already: true });
  });

  it('retiring releases the display name, so another assistant may show it', async () => {
    await handler(evt({ path: retirePath }));
    const res = await handler(evt({ body: { ...good, assistantId: 'finance-advisor-2' } })) as any;
    expect(res.statusCode).toBe(202);
  });

  it("refuses a classification's primary, whoever asked for it: every room needs one", async () => {
    const res = await handler(evt({ path: '/admin/roster/advisor/retire' })) as any;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_IS_PRIMARY');
    expect(chimeSend).not.toHaveBeenCalled();
  });

  it("refuses a duel's alt: it is removed with its duel", async () => {
    const res = await handler(evt({ path: '/admin/roster/alt-primary-premium/retire' })) as any;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_IS_ALT');
  });

  it('retires a DECLARED assistant the same way, leaving a tombstone its next deploy respects', async () => {
    params.set('/ae/assistant-directory/ops-premium', JSON.stringify({
      classification: 'premium', role: 'ops', origin: 'declared', status: 'active', botArn: BOT, lexBotId: 'LEXOPS', displayName: 'Ops',
    }));
    params.set('/ae/assistant-assignments/premium/ops/assistants/ops-premium', JSON.stringify({
      classification: 'premium', role: 'ops', occupancy: 'live', assistant: 'ops-premium', botArn: BOT, lexBotId: 'LEXOPS', source: 'declared', status: 'active',
    }));
    const res = await handler(evt({ path: '/admin/roster/ops-premium/retire', body: { reason: 'no longer needed' } })) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('retired');
    expect(JSON.parse(params.get('/ae/assistant-directory/ops-premium')!)).toMatchObject({ status: 'retired', origin: 'declared', reason: 'no longer needed' });
    expect(params.has('/ae/assistant-assignments/premium/ops/assistants/ops-premium')).toBe(false);
  });

  it("refuses a declared assistant's turn limit: it is its profile's, which a deploy sets", async () => {
    params.set('/ae/assistant-directory/ops-premium', JSON.stringify({ classification: 'premium', role: 'ops', origin: 'declared', status: 'active', botArn: BOT }));
    const res = await handler(evt({ path: '/admin/roster/ops-premium/limits', body: { rateLimitPerHour: 5 } })) as any;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('TURN_LIMIT_IS_DEPLOYED');
  });
});

describe('a build that never finished', () => {
  const retirePath = '/admin/roster/finance-advisor/retire';
  beforeEach(async () => { await handler(evt({ body: good })); logs = []; });

  it('a failed build that left nothing is removed, and its name and display name are released', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'CreateAppInstanceBotCommand') throw new Error('denied');
      return {};
    });
    await provision('finance-advisor');
    const res = await handler(evt({ path: retirePath })) as any;
    expect(JSON.parse(res.body)).toMatchObject({ status: 'released' });
    expect(params.has('/ae/assistant-directory/finance-advisor')).toBe(false);
    expect(params.has('/ae/assistant-directory/_build/finance-advisor')).toBe(false);
    expect(audits()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'released' })]));
    chimeSend.mockImplementation(async (cmd: any) => (cmd.constructor.name === 'CreateAppInstanceBotCommand' ? { AppInstanceBotArn: BOT } : {}));
    expect((await handler(evt({ body: good })) as any).statusCode).toBe(202);
  });

  it('a build still inside its deadline cannot be retired', async () => {
    const res = await handler(evt({ path: retirePath })) as any;
    expect(res.statusCode).toBe(409);
  });

  it('past the deadline, a build that died mid-way reads as failed and retire removes what it recorded', async () => {
    const name = '/ae/assistant-directory/finance-advisor';
    const entry = JSON.parse(params.get(name)!);
    params.set(name, JSON.stringify({ ...entry, lexBotId: 'LEXBOT9', createdAt: new Date(Date.now() - BUILD_DEADLINE_MS - 1000).toISOString() }));
    params.set('/ae/assistant-directory/_build/finance-advisor', JSON.stringify({ at: entry.createdAt }));
    const res = await handler(evt({ path: retirePath })) as any;
    expect(sent(lexSend, 'DeleteBotCommand')[0]).toMatchObject({ botId: 'LEXBOT9' });
    expect(JSON.parse(res.body)).toMatchObject({ status: 'released' });
    expect(params.has(name)).toBe(false);
  });
});

describe('what a create leaves ready, and what it says when it cannot', () => {
  beforeEach(async () => { await handler(evt({ body: good })); logs = []; });
  const invokes = (fn: string) => sent(lambdaSend, 'InvokeCommand')
    .filter((i: any) => i.FunctionName === fn).map((i: any) => JSON.parse(Buffer.from(i.Payload).toString()));
  const entry = () => JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!);

  it('asks manage-profiles for a first draft once the entry is active, naming the assistant and its creator', async () => {
    const order: string[] = [];
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => {
      if (cmd.input.FunctionName === 'ae-manage-profiles') order.push(`seed-draft-while-${entry().status}`);
      return base(cmd);
    });
    await provision('finance-advisor');
    expect(invokes('ae-manage-profiles')).toEqual([{ aeSeedFirstDraft: { assistant: 'finance-advisor', actor: 'admin-1' } }]);
    expect(order).toEqual(['seed-draft-while-active']);
    expect(entry().firstDraftError).toBeUndefined();
    expect(entry().ownerSeedError).toBeUndefined();
  });

  it('records a first draft that was not seeded on the entry, and stays active', async () => {
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => (cmd.input.FunctionName === 'ae-manage-profiles'
      ? { Payload: Buffer.from(JSON.stringify({ seeded: false, error: 'pack unreadable' })) }
      : base(cmd)));
    await provision('finance-advisor');
    expect(entry()).toMatchObject({ status: 'active', firstDraftError: 'pack unreadable' });
  });

  it('records an owner tag that could not be written on the entry, so the roster can say why', async () => {
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => (cmd.input.FunctionName === 'ae-assistant-ownership'
      ? { FunctionError: 'Unhandled' }
      : base(cmd)));
    await provision('finance-advisor');
    expect(entry()).toMatchObject({ status: 'active', ownerSeedError: 'Unhandled' });
    expect(audits()).toEqual([expect.objectContaining({ action: 'created', ownerSeedError: 'Unhandled' })]);
  });

  it('never marks failed an assistant that is running: a note that cannot be written after it is active stays a note', async () => {
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => (cmd.input.FunctionName === 'ae-manage-profiles'
      ? { Payload: Buffer.from(JSON.stringify({ seeded: false, error: 'pack unreadable' })) }
      : base(cmd)));
    const ssmBase = ssmSend.getMockImplementation()!;
    ssmSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'PutParameterCommand' && String(cmd.input.Value).includes('firstDraftError')) throw new Error('throttled');
      return ssmBase(cmd);
    });
    await provision('finance-advisor');
    expect(entry()).toMatchObject({ status: 'active', botArn: BOT, lexBotId: 'LEXBOT1' });
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([]);
    expect(invokes(process.env.PROVISIONER_FUNCTION_NAME!).map((p: any) => p.op)).toEqual(['build']);
    expect(audits()).toEqual([expect.objectContaining({ action: 'created', firstDraftError: 'pack unreadable' })]);
  });
});

describe('a build whose invoke fails keeps the ids the provisioner recorded', () => {
  beforeEach(async () => { await handler(evt({ body: good })); logs = []; });
  const entry = () => JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!);
  /** The provisioner records the Lex bot on the entry, as its checkpoint does, then is killed before it answers. */
  const killedMidBuild = () => {
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => {
      const p = cmd.input?.Payload ? JSON.parse(Buffer.from(cmd.input.Payload).toString()) : {};
      if (cmd.input?.FunctionName === process.env.PROVISIONER_FUNCTION_NAME && p.op === 'build') {
        params.set('/ae/assistant-directory/finance-advisor', JSON.stringify({ ...entry(), lexBotId: 'LEXBOT7' }));
        return { FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: 'Task timed out after 780.00 seconds' })) };
      }
      return base(cmd);
    });
  };

  it('removes the Lex bot the killed build recorded, and records the failure', async () => {
    killedMidBuild();
    await provision('finance-advisor');
    expect(sent(lexSend, 'DeleteBotCommand')).toEqual([expect.objectContaining({ botId: 'LEXBOT7' })]);
    expect(entry()).toMatchObject({ status: 'failed', leftover: [] });
  });

  it('keeps the id on the entry when the bot it names could not be removed, so retire can finish it', async () => {
    killedMidBuild();
    const lexBase = lexSend.getMockImplementation()!;
    lexSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteBotCommand') throw Object.assign(new Error('busy'), { name: 'PreconditionFailedException' });
      return lexBase(cmd);
    });
    await provision('finance-advisor');
    expect(entry()).toMatchObject({ status: 'failed', lexBotId: 'LEXBOT7', leftover: ['Lex bot LEXBOT7'] });
  });
});

describe('the console proves each request to the provisioner, and bundles none of its clients', () => {
  beforeEach(async () => { await handler(evt({ body: good })); logs = []; });

  it("writes a claim under the console's path for each request, and spends it", async () => {
    await provision('finance-advisor');
    const claims = sent(ssmSend, 'PutParameterCommand').filter((i: any) => i.Name.startsWith('/ae/provisioner-claims/'));
    expect(claims.map((i: any) => i.Name)).toEqual([expect.stringMatching(/^\/ae\/provisioner-claims\/console\/[0-9a-f-]{36}$/)]);
    expect([...params.keys()].filter((k) => k.startsWith('/ae/provisioner-claims/'))).toEqual([]);
  });

  it("imports nothing but types from the provisioner's handler module", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').join(__dirname, '../lambda/src/manage-assistants.ts'), 'utf8');
    const imports = src.match(/^import [^;]*from '\.\/assistant-provisioner-function\.js';/gm) ?? [];
    expect(imports.filter((i) => !/^import type /.test(i))).toEqual([]);
  });
});

describe('an administrator naming an owner team', () => {
  it('refuses a team whose group does not exist, and takes no name', async () => {
    const res = await handler(evt({ body: { ...good, ownerTeam: 'nosuchteam' } })) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('TEAM_NOT_FOUND');
    expect(sent(ssmSend, 'PutParameterCommand')).toEqual([]);
  });
});

describe('a display name an active version shows', () => {
  it('is refused at create, though no record carries it', async () => {
    params.set('/ae/assistant/advisor/definition:active', JSON.stringify({ displayName: 'Penny' }));
    const res = await handler(evt({ body: { ...good, displayName: 'penny' } })) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors.join(' ')).toMatch(/already shows the name/);
  });
});

describe('what the first draft starts from, and the classifier model', () => {
  const manifest = { schemaVersion: 1, kind: 'assistant-profile', profileName: 'advisor', body: { modelKey: 'sonnet' } };
  const checks = () => sent(lambdaSend, 'InvokeCommand')
    .filter((i: any) => i.FunctionName === 'ae-manage-profiles').map((i: any) => JSON.parse(Buffer.from(i.Payload).toString()))
    .filter((p: any) => p.aeCheckStartingPoint);
  const refusedWith = async (body: unknown) => {
    const res = await handler(evt({ body })) as any;
    expect(res.statusCode).toBe(400);
    expect(sent(ssmSend, 'PutParameterCommand')).toEqual([]);
    expect(builds()).toEqual([]);
    return JSON.parse(res.body);
  };

  it('takes the platform classifier or a classifier model the classification selects, and refuses another', async () => {
    expect((await refusedWith({ ...good, classification: 'basic', descriptor: { ...good.descriptor, classifierModelKey: 'opus' } })).errors.join(' '))
      .toMatch(/classifier model 'opus' is not selected by the basic/);
    expect((await refusedWith({ ...good, descriptor: { ...good.descriptor, classifierModelKey: 'nope' } })).errors.join(' '))
      .toMatch(/classifierModelKey must name a model/);
    const res = await handler(evt({ body: { ...good, descriptor: { ...good.descriptor, classifierModelKey: 'default' } } })) as any;
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!).descriptor.classifierModelKey).toBe('default');
  });

  it('refuses a starting point that is not one, and asks nothing about it', async () => {
    expect((await refusedWith({ ...good, startingPoint: { kind: 'clone' } })).errors.join(' ')).toMatch(/startingPoint.kind/);
    expect(checks()).toEqual([]);
  });

  it('asks manage-profiles to check a file before taking the name, with the classification and the create\'s choices', async () => {
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => {
      const p = cmd.input?.Payload ? JSON.parse(Buffer.from(cmd.input.Payload).toString()) : {};
      if (p.aeCheckStartingPoint) return { Payload: Buffer.from(JSON.stringify({ errors: ["guardrailId 'strict-x' is not provisioned"] })) };
      return base(cmd);
    });
    const body = await refusedWith({ ...good, startingPoint: { kind: 'manifest', manifest } });
    expect(body).toMatchObject({ code: 'STARTING_POINT_REFUSED', errors: ["guardrailId 'strict-x' is not provisioned"] });
    expect(checks()).toEqual([{ aeCheckStartingPoint: {
      assistant: 'finance-advisor', classification: 'premium', startingPoint: { kind: 'manifest', manifest },
      choices: { displayName: 'Finance', modelKey: 'sonnet' },
    } }]);
  });

  it('refuses when the check cannot answer, rather than building an assistant whose first draft is unknown', async () => {
    const base = lambdaSend.getMockImplementation()!;
    lambdaSend.mockImplementation(async (cmd: any) => {
      const p = cmd.input?.Payload ? JSON.parse(Buffer.from(cmd.input.Payload).toString()) : {};
      return p.aeCheckStartingPoint ? { Payload: Buffer.from('{}') } : base(cmd);
    });
    expect((await refusedWith({ ...good, startingPoint: { kind: 'copy', from: 'advisor' } })).errors).toEqual(['the starting point could not be checked']);
  });

  it('hands an accepted starting point to the build, and the build hands it to the first draft', async () => {
    const startingPoint = { kind: 'copy', from: 'advisor' };
    const res = await handler(evt({ body: { ...good, startingPoint } })) as any;
    expect(res.statusCode).toBe(202);
    const handoff = JSON.parse(Buffer.from(builds()[0].Payload).toString());
    expect(handoff).toEqual({ op: 'provision', assistantId: 'finance-advisor', startingPoint });
    // The file or the copy is not kept on the entry: it is needed once, by the first draft.
    expect(JSON.parse(params.get('/ae/assistant-directory/finance-advisor')!)).not.toHaveProperty('startingPoint');
    await provision('finance-advisor', startingPoint as never);
    const seeds = sent(lambdaSend, 'InvokeCommand').filter((i: any) => i.FunctionName === 'ae-manage-profiles')
      .map((i: any) => JSON.parse(Buffer.from(i.Payload).toString())).filter((p: any) => p.aeSeedFirstDraft);
    expect(seeds).toEqual([{ aeSeedFirstDraft: { assistant: 'finance-advisor', actor: 'admin-1', startingPoint } }]);
    expect(audits()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'create-requested', startingPoint: 'copy', copiedFrom: 'advisor' })]));
  });

  it('starts from the classification defaults when it names no starting point, and asks for no check', async () => {
    const res = await handler(evt({ body: good })) as any;
    expect(res.statusCode).toBe(202);
    expect(checks()).toEqual([]);
    expect(JSON.parse(Buffer.from(builds()[0].Payload).toString())).toEqual({ op: 'provision', assistantId: 'finance-advisor' });
  });
});
