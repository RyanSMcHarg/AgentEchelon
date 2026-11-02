/**
 * ONE PRINCIPAL BUILDS AND RETIRES EVERY ASSISTANT (ADR-048, amended 2026-10-24): the provisioner's direct invokes.
 *
 * `lambda/src/assistant-provisioner-function.ts`, against mocked AWS clients. What it proves:
 *   - it answers exactly three request shapes, and refuses anything else, an API Gateway event included, before it
 *     reads or builds anything;
 *   - `seed-declared` refuses a declaration for a classification other than the invoking seed's own, one the
 *     registry does not declare, a name the registry does not give that classification, and a fulfillment that is
 *     not this deployment's function;
 *   - `seed-declared` builds a declared assistant on a session of the provisioner role tagged with the
 *     classification, leaves an active one alone, leaves one retired in the console retired, refuses a name the
 *     console created, and removes what a failed build made;
 *   - `build` builds only a console entry that is `provisioning` at a conversational classification, and `remove`
 *     removes only ids the assistant's own entry or record carries, never an active assistant's.
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
process.env.RUNTIME_LEX_BOT_ROLE_ARN = 'arn:aws:iam::123456789012:role/RuntimeAssistantLexBotRole';
process.env.RUNTIME_PROVISIONER_ROLE_ARN = 'arn:aws:iam::123456789012:role/RuntimeAssistantProvisionerRole';
process.env.ROUTER_FUNCTION_PREFIX = 'AgentEchelon';
process.env.LEX_BOT_NAME_PREFIX = 'agent-echelon';
process.env.OWNERSHIP_FUNCTION_NAME = 'ae-assistant-ownership';

import { handler, requestOf } from '../lambda/src/assistant-provisioner-function';
import { claimDigest, PROVISIONER_CLAIMS, CLAIM_MAX_AGE_MS } from '../lambda/src/lib/provisioner-claim';
import { timing } from '../lambda/src/lib/assistant-lex-bot';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import type { Declaration } from '../lambda/src/lib/declared-assistants';

timing.readyPollMs = 0; timing.buildPollMs = 0; timing.afterCreateMs = 0;

const ROUTER = 'arn:aws:lambda:us-east-1:123456789012:function:AgentEchelonAssistants-premium-AgentHandler';
const notFound = () => Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
let params: Map<string, string>;
/** When each parameter was last written, as SSM answers LastModifiedDate. */
const modified = new Map<string, Date>();
let claimCount = 0;
/**
 * The request with a claim written for it, as its caller writes one (`lib/provisioner-claim.ts`): under `writer` (the
 * path below `provisioner-claims`; by default the request's own caller's), carrying the digest of `digestOf` (by
 * default the request itself), written at `at`.
 */
const claimed = (req: Record<string, any>, over: { writer?: string; digestOf?: Record<string, unknown>; at?: Date } = {}) => {
  claimCount += 1;
  const claim = `00000000-0000-4000-8000-${String(claimCount).padStart(12, '0')}`;
  const writer = over.writer ?? (req.op === 'seed-declared' ? `seed/${req.callerClassification}` : 'console');
  const name = `/ae/${PROVISIONER_CLAIMS}/${writer}/${claim}`;
  params.set(name, claimDigest(over.digestOf ?? req));
  modified.set(name, over.at ?? new Date());
  return { ...req, claim };
};
/** Ask the provisioner as the request's own caller would. */
const call = (req: Record<string, any>) => handler(claimed(req));
const sent = (mock: jest.Mock, name: string) => mock.mock.calls.map((c) => c[0]).filter((c: any) => c.constructor.name === name).map((c: any) => c.input);
const entry = (id: string) => (params.has(`/ae/assistant-directory/${id}`) ? JSON.parse(params.get(`/ae/assistant-directory/${id}`)!) : undefined);

const PRIMARY = profiles.roleAssistantName('premium', 'primary')!;
const DECLARATION: Declaration = {
  classification: 'premium',
  roles: ['ops', 'primary'],
  assistants: [
    { assistantId: PRIMARY, role: 'primary', occupancy: 'live', displayName: 'Advisor', welcome: true },
    { assistantId: 'ops-premium', role: 'ops', occupancy: 'live', displayName: 'Ops', welcome: true },
  ],
};
const seedRequest = (over: Record<string, unknown> = {}) => ({
  op: 'seed-declared',
  callerClassification: 'premium',
  requestType: 'Create',
  logicalResourceId: 'DeclaredAssistants',
  fulfillmentArn: ROUTER,
  declaration: DECLARATION,
  ...over,
});

beforeEach(() => {
  for (const m of [ssmSend, chimeSend, lexSend, lambdaSend]) m.mockReset();
  stsCalls.length = 0;
  modified.clear();
  params = new Map([['/ae/assistant/premium/router-arn', ROUTER]]);
  ssmSend.mockImplementation(async (cmd: any) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetParameterCommand':
        if (!params.has(i.Name)) throw notFound();
        return { Parameter: { Name: i.Name, Value: params.get(i.Name), LastModifiedDate: modified.get(i.Name) ?? new Date() } };
      case 'GetParametersByPathCommand':
        return { Parameters: [...params].filter(([k]) => k.startsWith(`${i.Path}/`) && !k.slice(i.Path.length + 1).includes('/')).map(([Name, Value]) => ({ Name, Value })) };
      case 'PutParameterCommand':
        if (!i.Overwrite && params.has(i.Name)) throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
        params.set(i.Name, i.Value);
        return {};
      case 'DeleteParameterCommand':
        if (!params.delete(i.Name)) throw notFound();
        return {};
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
  let n = 0;
  lexSend.mockImplementation(async (cmd: any) => {
    switch (cmd.constructor.name) {
      case 'CreateBotCommand': n += 1; return { botId: `LEXBOT${n}` };
      case 'DescribeBotLocaleCommand': return { botLocaleStatus: 'Built' };
      case 'ListIntentsCommand': return { intentSummaries: [{ intentName: 'FallbackIntent', intentId: 'FB' }] };
      case 'ListBotAliasesCommand': return { botAliasSummaries: [{ botAliasName: 'TestBotAlias', botAliasId: 'TSTALIASID' }] };
      default: return {};
    }
  });
  chimeSend.mockImplementation(async (cmd: any) => (cmd.constructor.name === 'CreateAppInstanceBotCommand'
    ? { AppInstanceBotArn: `${process.env.APP_INSTANCE_ARN}/bot/${cmd.input.Tags.find((t: any) => t.Key === 'assistant').Value}` }
    : {}));
  lambdaSend.mockResolvedValue({});
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const touchedNothing = () => {
  expect(sent(ssmSend, 'PutParameterCommand')).toEqual([]);
  expect(lexSend).not.toHaveBeenCalled();
  expect(chimeSend).not.toHaveBeenCalled();
  expect(stsCalls).toEqual([]);
};

describe('it answers three request shapes and refuses anything else', () => {
  it.each([
    ['an API Gateway event', { httpMethod: 'POST', path: '/admin/roster', body: '{}', requestContext: {} }],
    ['an API Gateway event carrying an op', { op: 'build', assistantId: 'x', httpMethod: 'POST', requestContext: {} }],
    ['an unknown op', { op: 'retire', assistantId: 'x' }],
    ['an inherited name as an op', { op: 'toString' }],
    ['a build naming more than its assistant', { op: 'build', assistantId: 'x', classification: 'premium' }],
    ['a build with no assistant', { op: 'build' }],
    ['an assistant id that is not one', { op: 'remove', assistantId: 'Not An Id' }],
    ['a seed with an unknown request type', seedRequest({ requestType: 'Replace' })],
    ['a seed with no caller classification', (() => { const r: Record<string, unknown> = seedRequest(); delete r.callerClassification; return r; })()],
    ['nothing', undefined],
    ['a list', [{ op: 'build', assistantId: 'x' }]],
  ])('refuses %s, before it reads or builds anything', async (_what, event) => {
    expect(() => requestOf(event)).toThrow(/provisioner:/);
    await expect(handler(event)).rejects.toThrow(/provisioner:/);
    expect(ssmSend).not.toHaveBeenCalled();
    touchedNothing();
  });
});

describe('seed-declared holds a declaration to the caller and the registry', () => {
  it("refuses a declaration for a classification other than the invoking seed's own", async () => {
    await expect(call(seedRequest({ callerClassification: 'standard' }))).rejects.toThrow(/names classification 'premium', and its seed serves 'standard'/);
    touchedNothing();
  });

  it('refuses a classification the registry does not declare', async () => {
    const d = { ...DECLARATION, classification: 'nosuch' };
    await expect(call(seedRequest({ callerClassification: 'nosuch', declaration: d }))).rejects.toThrow(/'nosuch' is not a classification this deployment's registry declares/);
    touchedNothing();
  });

  it("refuses a name that is not the registry's for its classification, role and occupancy", async () => {
    const forged = { ...DECLARATION, assistants: [{ ...DECLARATION.assistants[1], assistantId: 'ops-standard' }] };
    await expect(call(seedRequest({ declaration: forged }))).rejects.toThrow(/'ops-standard' is not the registry's assistant for premium\/ops \(it names 'ops-premium'\)/);
    const altAsLive = { ...DECLARATION, assistants: [{ ...DECLARATION.assistants[0], assistantId: 'alt-primary-premium' }] };
    await expect(call(seedRequest({ declaration: altAsLive }))).rejects.toThrow(/not the registry's assistant for premium\/primary/);
    touchedNothing();
  });

  it("refuses a fulfillment that is not this deployment's function", async () => {
    await expect(call(seedRequest({ fulfillmentArn: 'arn:aws:lambda:us-east-1:123456789012:function:SomeoneElse' }))).rejects.toThrow(/fulfillment ARN is not one of this deployment's functions/);
    touchedNothing();
  });
});

describe('seed-declared builds, leaves alone, keeps retired, refuses a conflict, and cleans up', () => {
  it('builds each declared assistant on a session tagged with its classification, and answers the primary', async () => {
    const out = await call(seedRequest()) as { PhysicalResourceId: string; Data: { PrimaryBotArn: string; Summary: string } };
    expect(out.Data.PrimaryBotArn).toBe(`${process.env.APP_INSTANCE_ARN}/bot/${PRIMARY}`);
    expect(JSON.parse(out.Data.Summary)).toEqual({ [PRIMARY]: 'built', 'ops-premium': 'built' });
    expect(stsCalls).toEqual([expect.objectContaining({ RoleArn: process.env.RUNTIME_PROVISIONER_ROLE_ARN, Tags: [{ Key: 'classification', Value: 'premium' }] })]);
    const lexCreate = sent(lexSend, 'CreateBotCommand')[0];
    expect(lexCreate).toMatchObject({ roleArn: process.env.RUNTIME_LEX_BOT_ROLE_ARN, botTags: expect.objectContaining({ provisioner: 'runtime', classification: 'premium' }) });
    expect(sent(lexSend, 'UpdateBotAliasCommand')[0].botAliasLocaleSettings.en_US.codeHookSpecification.lambdaCodeHook.lambdaARN).toBe(ROUTER);
    expect(entry('ops-premium')).toMatchObject({ origin: 'declared', status: 'active', classification: 'premium', role: 'ops' });
  });

  it('leaves an active one alone', async () => {
    await call(seedRequest());
    lexSend.mockClear(); chimeSend.mockClear();
    const out = await call(seedRequest({ requestType: 'Update', physicalResourceId: 'p', oldDeclaration: DECLARATION })) as { Data: { Summary: string } };
    expect(JSON.parse(out.Data.Summary)).toEqual({ [PRIMARY]: 'present', 'ops-premium': 'present' });
    expect(sent(lexSend, 'CreateBotCommand')).toEqual([]);
  });

  it('leaves one retired in the console retired', async () => {
    await call(seedRequest());
    params.set('/ae/assistant-directory/ops-premium', JSON.stringify({ ...entry('ops-premium'), status: 'retired' }));
    lexSend.mockClear();
    const out = await call(seedRequest({ requestType: 'Update', physicalResourceId: 'p', oldDeclaration: DECLARATION })) as { Data: { Summary: string } };
    expect(JSON.parse(out.Data.Summary)['ops-premium']).toBe('retired-in-console');
    expect(sent(lexSend, 'CreateBotCommand')).toEqual([]);
  });

  it('refuses a declared name the console created', async () => {
    params.set('/ae/assistant-directory/ops-premium', JSON.stringify({ classification: 'premium', role: 'ops', status: 'active', origin: 'console' }));
    await expect(call(seedRequest())).rejects.toThrow(/'ops-premium' is an assistant created in the console/);
  });

  it('removes what a failed build made, and leaves no entry for a rerun to trip on', async () => {
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'CreateAppInstanceBotCommand') throw Object.assign(new Error('denied'), { name: 'ForbiddenException' });
      return {};
    });
    await expect(call(seedRequest())).rejects.toThrow(/could not be built: denied/);
    expect(sent(lexSend, 'DeleteBotCommand')).toEqual([expect.objectContaining({ botId: 'LEXBOT1' })]);
    expect(entry(PRIMARY)).toBeUndefined();
  });

  it('refuses to withdraw a role an assistant fills, through the same op', async () => {
    await call(seedRequest());
    const withoutOps = { ...DECLARATION, roles: ['primary'], assistants: DECLARATION.assistants.slice(0, 1) };
    await expect(call(seedRequest({ requestType: 'Update', physicalResourceId: 'p', declaration: withoutOps, oldDeclaration: DECLARATION })))
      .rejects.toThrow(/the ops role cannot be withdrawn from premium while an assistant fills it: ops-premium/);
  });
});

describe('build and remove serve the console, and trust the directory rather than the request', () => {
  const consoleEntry = (over: Record<string, unknown> = {}) => JSON.stringify({
    classification: 'premium', role: 'primary', status: 'provisioning', createdAt: new Date().toISOString(), displayName: 'Finance', ...over,
  });

  it('builds a console entry that is provisioning, recording its ids on the entry', async () => {
    params.set('/ae/assistant-directory/finance-advisor', consoleEntry());
    const out = await call({ op: 'build', assistantId: 'finance-advisor' });
    expect(out).toEqual({ ok: true, lexBotId: 'LEXBOT1', botArn: `${process.env.APP_INSTANCE_ARN}/bot/finance-advisor` });
    expect(entry('finance-advisor')).toMatchObject({ status: 'provisioning', lexBotId: 'LEXBOT1', botArn: expect.stringMatching(/finance-advisor$/) });
  });

  it.each([
    ['a declared entry', { origin: 'declared' }, /declared; a deploy seeds it/],
    ['an active entry', { status: 'active' }, /active, not provisioning/],
    ['an entry at the admin plane', { classification: 'admin' }, /not a conversational classification/],
  ])('refuses to build %s', async (_what, over, why) => {
    params.set('/ae/assistant-directory/finance-advisor', consoleEntry(over));
    const out = await call({ op: 'build', assistantId: 'finance-advisor' }) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(why);
    expect(lexSend).not.toHaveBeenCalled();
    expect(stsCalls).toEqual([]);
  });

  it("removes a retiring assistant's own identity and Lex bot, identity first", async () => {
    const bot = `${process.env.APP_INSTANCE_ARN}/bot/finance-advisor`;
    params.set('/ae/assistant-directory/finance-advisor', consoleEntry({ status: 'retiring', botArn: bot, lexBotId: 'LEXBOT1' }));
    const out = await call({ op: 'remove', assistantId: 'finance-advisor', botArn: bot, lexBotId: 'LEXBOT1' });
    expect(out).toEqual({ identityGone: true, leftover: [] });
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([{ AppInstanceBotArn: bot }]);
    expect(sent(lexSend, 'DeleteBotCommand')).toEqual([expect.objectContaining({ botId: 'LEXBOT1' })]);
  });

  it('refuses to remove an active assistant, or ids that are not its own', async () => {
    const bot = `${process.env.APP_INSTANCE_ARN}/bot/finance-advisor`;
    params.set('/ae/assistant-directory/finance-advisor', consoleEntry({ status: 'active', botArn: bot, lexBotId: 'LEXBOT1' }));
    await expect(call({ op: 'remove', assistantId: 'finance-advisor', botArn: bot })).rejects.toThrow(/is active; mark it retiring first/);
    params.set('/ae/assistant-directory/finance-advisor', consoleEntry({ status: 'retiring', botArn: bot, lexBotId: 'LEXBOT1' }));
    await expect(call({ op: 'remove', assistantId: 'finance-advisor', botArn: `${process.env.APP_INSTANCE_ARN}/bot/advisor` }))
      .rejects.toThrow(/the identity named is not this assistant's/);
    await expect(call({ op: 'remove', assistantId: 'nobody', lexBotId: 'LEXBOT1' })).rejects.toThrow(/has no directory entry/);
    expect(chimeSend).not.toHaveBeenCalled();
    expect(lexSend).not.toHaveBeenCalled();
  });
});

describe("the seed is a thin adapter: it asks the provisioner and hands CloudFormation the answer", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requestFor, answerOf } = require('../lambda/src/seed-declared-assistants') as typeof import('../lambda/src/seed-declared-assistants');
  const own = { classification: 'premium', fulfillmentArn: ROUTER };

  it("names its own classification and fulfillment, and passes the declaration and the one before an update", () => {
    const req = requestFor({
      RequestType: 'Update', LogicalResourceId: 'DeclaredAssistants', PhysicalResourceId: 'p',
      ResourceProperties: { ServiceToken: 't', declaration: JSON.stringify(DECLARATION) },
      OldResourceProperties: { ServiceToken: 't', declaration: JSON.stringify({ ...DECLARATION, roles: ['primary'] }) },
    } as never, own);
    expect(req).toEqual({
      op: 'seed-declared', callerClassification: 'premium', requestType: 'Update', logicalResourceId: 'DeclaredAssistants',
      physicalResourceId: 'p', fulfillmentArn: ROUTER, declaration: DECLARATION, oldDeclaration: { ...DECLARATION, roles: ['primary'] },
    });
    // The request it builds, with the claim its seed writes, is one the provisioner accepts.
    expect(requestOf({ ...req, claim: '00000000-0000-4000-8000-000000000000' }).op).toBe('seed-declared');
  });

  it("returns the provisioner's answer, and fails with the provisioner's refusal", () => {
    expect(answerOf({ Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'p', Data: { PrimaryBotArn: 'b', Summary: '{}' } })) }))
      .toEqual({ PhysicalResourceId: 'p', Data: { PrimaryBotArn: 'b', Summary: '{}' } });
    expect(() => answerOf({ FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: 'seed: the ops role cannot be withdrawn' })) }))
      .toThrow('seed: the ops role cannot be withdrawn');
  });
});

describe('a request proves its caller with a claim only that caller can write', () => {
  const seeded = async () => {
    await call(seedRequest());
    lexSend.mockClear(); chimeSend.mockClear();
    expect(entry(PRIMARY)).toMatchObject({ status: 'active', classification: 'premium' });
  };
  const removedNothing = () => {
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([]);
    expect(sent(lexSend, 'DeleteBotCommand')).toEqual([]);
    expect(entry(PRIMARY)).toMatchObject({ status: 'active' });
    expect(entry('ops-premium')).toMatchObject({ status: 'active' });
  };

  it("refuses another classification's seed asking, in premium's name, to remove premium's primary and its ops assistant", async () => {
    await seeded();
    // The standard seed may invoke the provisioner, and may write a claim only under its own path.
    const forged = claimed(seedRequest({ requestType: 'Delete', physicalResourceId: 'p' }), { writer: 'seed/standard' });
    await expect(handler(forged)).rejects.toThrow(/does not prove its caller: no claim was written where its caller writes \(\/ae\/provisioner-claims\/seed\/premium\)/);
    removedNothing();
  });

  it("refuses the console asking for a seed's declaration, and a seed asking for the console's removal", async () => {
    await seeded();
    await expect(handler(claimed(seedRequest({ requestType: 'Delete', physicalResourceId: 'p' }), { writer: 'console' }))).rejects.toThrow(/does not prove its caller/);
    params.set(`/ae/assistant-directory/${PRIMARY}`, JSON.stringify({ ...entry(PRIMARY), status: 'retiring' }));
    const bot = entry(PRIMARY).botArn;
    await expect(handler(claimed({ op: 'remove', assistantId: PRIMARY, botArn: bot }, { writer: 'seed/premium' }))).rejects.toThrow(/does not prove its caller/);
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([]);
  });

  it('refuses a request with no claim, a claim written for another request, a stale claim, and a claim spent already', async () => {
    await seeded();
    const del = seedRequest({ requestType: 'Delete', physicalResourceId: 'p' });
    await expect(handler({ ...del, claim: '00000000-0000-4000-8000-999999999999' })).rejects.toThrow(/no claim was written/);
    await expect(handler(claimed(del, { digestOf: seedRequest({ requestType: 'Delete', physicalResourceId: 'p', declaration: { ...DECLARATION, assistants: [] } }) })))
      .rejects.toThrow(/the claim was written for another request/);
    await expect(handler(claimed(del, { at: new Date(Date.now() - CLAIM_MAX_AGE_MS - 1000) }))).rejects.toThrow(/the claim is stale/);
    removedNothing();
    const once = claimed(seedRequest({ requestType: 'Update', physicalResourceId: 'p', oldDeclaration: DECLARATION }));
    await handler(once);
    await expect(handler(once)).rejects.toThrow(/no claim was written/);
  });

  it('refuses a caller classification that is not one path segment, so no claim path can nest inside another', async () => {
    await expect(handler(claimed(seedRequest({ callerClassification: 'premium/x' }), { writer: 'seed/premium/x' }))).rejects.toThrow(/'premium\/x' is not a classification/);
    touchedNothing();
  });
});

describe('a rollback is not a withdrawal', () => {
  const BEFORE: Declaration = { ...DECLARATION, roles: ['primary'], assistants: DECLARATION.assistants.slice(0, 1) };

  it('removes the assistant the rolled-back update built in the role it added, and completes', async () => {
    await call(seedRequest({ declaration: BEFORE }));
    // The update adds the ops role and builds its assistant; something after it fails, and CloudFormation undoes it.
    await call(seedRequest({ requestType: 'Update', physicalResourceId: 'p', declaration: DECLARATION, oldDeclaration: BEFORE }));
    const opsBot = entry('ops-premium').botArn;
    expect(entry('ops-premium')).toMatchObject({ status: 'active', role: 'ops' });
    chimeSend.mockClear();
    const out = await call(seedRequest({ requestType: 'Update', physicalResourceId: 'p', declaration: BEFORE, oldDeclaration: DECLARATION, rollback: true })) as { Data: { PrimaryBotArn: string } };
    expect(out.Data.PrimaryBotArn).toMatch(new RegExp(`${PRIMARY}$`));
    expect(sent(chimeSend, 'DeleteAppInstanceBotCommand')).toEqual([{ AppInstanceBotArn: opsBot }]);
    expect(entry('ops-premium')).toBeUndefined();
    expect(entry(PRIMARY)).toMatchObject({ status: 'active' });
  });

  it('the same update, not a rollback, is still refused while the assistant fills the role', async () => {
    await call(seedRequest({ declaration: BEFORE }));
    await call(seedRequest({ requestType: 'Update', physicalResourceId: 'p', declaration: DECLARATION, oldDeclaration: BEFORE }));
    await expect(call(seedRequest({ requestType: 'Update', physicalResourceId: 'p', declaration: BEFORE, oldDeclaration: DECLARATION })))
      .rejects.toThrow(/the ops role cannot be withdrawn from premium/);
    expect(entry('ops-premium')).toMatchObject({ status: 'active' });
  });
});

describe("a classification's removal never fails its stack", () => {
  it('removes every declared assistant and reports, rather than refuses, a console-created assistant still active', async () => {
    await call(seedRequest());
    params.set('/ae/assistant-directory/finance-advisor', JSON.stringify({ classification: 'premium', role: 'primary', origin: 'console', status: 'active', createdAt: new Date().toISOString() }));
    const out = await call(seedRequest({ requestType: 'Delete', physicalResourceId: 'p' })) as { Data: { Summary: string } };
    expect(JSON.parse(out.Data.Summary)).toEqual({ unremoved: {}, consoleCreatedStillActive: ['finance-advisor'] });
    expect(entry(PRIMARY)).toBeUndefined();
    expect(entry('ops-premium')).toBeUndefined();
    expect(entry('finance-advisor')).toMatchObject({ status: 'active' });
  });

  it('reports an assistant whose identity could not be removed, keeps what is left on its entry, and still succeeds', async () => {
    await call(seedRequest());
    chimeSend.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteAppInstanceBotCommand') throw Object.assign(new Error('throttled'), { name: 'ThrottledClientException' });
      return {};
    });
    const out = await call(seedRequest({ requestType: 'Delete', physicalResourceId: 'p' })) as { Data: { Summary: string } };
    const summary = JSON.parse(out.Data.Summary);
    expect(Object.keys(summary.unremoved).sort()).toEqual(['ops-premium', PRIMARY].sort());
    expect(entry('ops-premium')).toMatchObject({ status: 'failed', leftover: [expect.stringMatching(/^identity /)] });
  });
});

describe('the seed adapter: a claim, a rollback read from its stack, and a delete that never fails', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { seedEvent } = require('../lambda/src/seed-declared-assistants') as typeof import('../lambda/src/seed-declared-assistants');
  const event = (over: Record<string, unknown> = {}) => ({
    RequestType: 'Update', StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/AgentEchelonAssistants-premium/1', LogicalResourceId: 'DeclaredAssistants', PhysicalResourceId: 'p',
    ResourceProperties: { ServiceToken: 't', declaration: JSON.stringify(DECLARATION) },
    OldResourceProperties: { ServiceToken: 't', declaration: JSON.stringify({ ...DECLARATION, roles: ['primary'] }) },
    ...over,
  }) as never;
  const deps = (status: string, invoke: (req: any) => { FunctionError?: string; Payload?: Uint8Array }) => {
    const seen: { request?: any; claimAtInvoke?: string } = {};
    return {
      seen,
      deps: {
        classification: 'premium', fulfillmentArn: ROUTER, ssmRoot: '/ae', provisionerFunctionName: 'ae-assistant-provisioner',
        ssm: { send: ssmSend } as any,
        cloudformation: { send: async () => ({ Stacks: [{ StackStatus: status }] }) } as any,
        lambda: {
          send: async (cmd: any) => {
            seen.request = JSON.parse(Buffer.from(cmd.input.Payload).toString());
            seen.claimAtInvoke = params.get(`/ae/provisioner-claims/seed/premium/${seen.request.claim}`);
            return invoke(seen.request);
          },
        } as any,
      },
    };
  };
  const ok = () => ({ Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'p', Data: { PrimaryBotArn: 'b', Summary: '{}' } })) });

  it("writes a claim under its own classification's path carrying the request's digest, and spends it after", async () => {
    const { seen, deps: d } = deps('UPDATE_IN_PROGRESS', ok);
    await seedEvent(event(), d);
    expect(seen.claimAtInvoke).toBe(claimDigest(seen.request));
    expect(seen.request.rollback).toBeUndefined();
    expect([...params.keys()].filter((k) => k.includes('provisioner-claims'))).toEqual([]);
  });

  it('says rollback when its stack is rolling back the update before', async () => {
    const { seen, deps: d } = deps('UPDATE_ROLLBACK_IN_PROGRESS', ok);
    await seedEvent(event(), d);
    expect(seen.request.rollback).toBe(true);
  });

  it('a delete answers CloudFormation whatever stops the removal: a refusal, a failed invoke, a declaration that does not parse', async () => {
    const refused = deps('DELETE_IN_PROGRESS', () => ({ FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: 'provisioner: no' })) }));
    await expect(seedEvent(event({ RequestType: 'Delete' }), refused.deps)).resolves.toMatchObject({ PhysicalResourceId: 'p', Data: { Summary: expect.stringContaining('provisioner: no') } });
    const crashed = deps('DELETE_IN_PROGRESS', () => { throw new Error('throttled'); });
    await expect(seedEvent(event({ RequestType: 'Delete' }), crashed.deps)).resolves.toMatchObject({ Data: { Summary: expect.stringContaining('throttled') } });
    await expect(seedEvent(event({ RequestType: 'Delete', ResourceProperties: { ServiceToken: 't', declaration: 'not json' } }), crashed.deps))
      .resolves.toMatchObject({ Data: { Summary: expect.stringContaining('not JSON') } });
  });

  it('a create or update still fails with the refusal, so CloudFormation shows it', async () => {
    const refused = deps('UPDATE_IN_PROGRESS', () => ({ FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: 'seed: the ops role cannot be withdrawn' })) }));
    await expect(seedEvent(event(), refused.deps)).rejects.toThrow('seed: the ops role cannot be withdrawn');
  });
});
