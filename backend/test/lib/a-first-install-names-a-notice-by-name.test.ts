/**
 * A STACK THAT DEPLOYS BEFORE THE CLASSIFICATION STACKS READS THE ROUTER BY NAME (lib/router-arn.ts).
 *
 * Foundations names notices to the routers, and the classification stacks that publish the routers'
 * `router-arn` parameters deploy after it. Resolving those parameters at synth failed a first install
 * outright ("Unable to fetch parameters ... router-arn"). So Foundations carries the parameter root and
 * reads the named classification's own parameter at call time. These tests pin that the by-name path
 * keeps the rule of the variable path: a declared classification reaches its OWN router or nothing.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const send = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const saved = { ...process.env };
let warn: jest.SpyInstance;

beforeEach(() => {
  jest.resetModules();
  send.mockReset();
  for (const k of Object.keys(process.env)) if (k.endsWith('_ROUTER_ARN')) delete process.env[k];
  process.env.ROUTER_ARN_PARAM_ROOT = '/agent-echelon/assistant';
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  process.env = { ...saved };
});

const load = () => require('../../lambda/src/lib/router-arn') as typeof import('../../lambda/src/lib/router-arn');

describe('the router is read by name at call time', () => {
  it("reads only the named classification's own parameter", async () => {
    send.mockResolvedValue({ Parameter: { Value: 'arn:aws:lambda:us-east-1:111122223333:function:router-standard' } });
    expect(await load().resolveRouterArn('standard')).toBe('arn:aws:lambda:us-east-1:111122223333:function:router-standard');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({ Name: '/agent-echelon/assistant/standard/router-arn' });
  });

  it('reads nothing for a value the deployment does not declare, or for the admin plane', async () => {
    const { resolveRouterArn } = load();
    expect(await resolveRouterArn('not-a-classification')).toBeUndefined();
    expect(await resolveRouterArn('admin')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('a parameter not yet published declines, and is read again once it is, without a cold start', async () => {
    const { resolveRouterArn } = load();
    send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    expect(await resolveRouterArn('basic')).toBeUndefined();
    send.mockResolvedValueOnce({ Parameter: { Value: 'arn:router-basic' } });
    expect(await resolveRouterArn('basic')).toBe('arn:router-basic');
    expect(await resolveRouterArn('basic')).toBe('arn:router-basic');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a wired variable wins, so a stack that deploys after the classifications reads no parameter', async () => {
    const { resolveRouterArn, routerArnEnvName } = load();
    process.env[routerArnEnvName('premium')] = 'arn:from-env';
    expect(await resolveRouterArn('premium')).toBe('arn:from-env');
    expect(send).not.toHaveBeenCalled();
  });

  it('with neither the variable nor the root, nothing resolves', async () => {
    delete process.env.ROUTER_ARN_PARAM_ROOT;
    expect(await load().resolveRouterArn('basic')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the by-name wiring resolves no router parameter at deploy', () => {
  it('carries the root, grants the read of each conversational parameter, and no SSM template parameter', () => {
    const { sayThroughRouterWiring } = require('../../lib/stacks/agent-classification-common') as typeof import('../../lib/stacks/agent-classification-common');
    const stack = new cdk.Stack(new cdk.App(), 'ByName', { env: { account: '111122223333', region: 'us-east-1' } });
    const wiring = sayThroughRouterWiring(stack, ['basic', 'standard', 'premium'], { resolvesPrimary: false });
    expect(Object.keys(wiring.env)).toEqual(['ROUTER_ARN_PARAM_ROOT']);
    new cdk.aws_iam.Role(stack, 'R', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: { P: new cdk.aws_iam.PolicyDocument({ statements: wiring.statements }) },
    });
    const t = Template.fromStack(stack).toJSON();
    expect(JSON.stringify(t.Parameters || {})).not.toContain('router-arn');
    const policy = JSON.stringify(t.Resources);
    for (const c of ['basic', 'standard', 'premium']) expect(policy).toContain(`parameter/agent-echelon/assistant/${c}/router-arn`);
  });

  it('a shared caller reads every classification\'s router under one path wildcard, and names none', () => {
    const { sayThroughRouterWiring, EVERY_CLASSIFICATION } = require('../../lib/stacks/agent-classification-common') as typeof import('../../lib/stacks/agent-classification-common');
    const stack = new cdk.Stack(new cdk.App(), 'ByNameShared', { env: { account: '111122223333', region: 'us-east-1' } });
    const wiring = sayThroughRouterWiring(stack, EVERY_CLASSIFICATION, { resolvesPrimary: false });
    expect(Object.keys(wiring.env)).toEqual(['ROUTER_ARN_PARAM_ROOT']);
    const statements = wiring.statements.map((s) => stack.resolve(s.toStatementJson()));
    const read = statements.find((s) => s.Sid === 'ReadTheRouterByName');
    expect(JSON.stringify(read.Resource)).toContain(':ssm:us-east-1:111122223333:parameter/agent-echelon/assistant/*/router-arn');
    const invoke = statements.find((s) => s.Sid === 'NameANoticeToTheRouter');
    expect(invoke.Condition).toEqual({
      StringEquals: { 'aws:ResourceTag/Instance': 'agent-echelon' },
      Null: { 'aws:ResourceTag/classification': 'false' },
    });
  });
});

describe('Battle, which deploys before the classification stacks, reaches the router by name', () => {
  it('a marker clear resolves the router from its parameter when only the root is wired', async () => {
    const invoke = jest.fn().mockResolvedValue({});
    jest.doMock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn().mockImplementation(() => ({ send: invoke })),
      InvokeCommand: jest.fn().mockImplementation((input) => ({ input })),
      InvocationType: { RequestResponse: 'RequestResponse', Event: 'Event' },
    }));
    send.mockResolvedValue({ Parameter: { Value: 'arn:aws:lambda:us-east-1:111122223333:function:router-premium' } });
    const { requestMarkerClear } = require('../../lambda/src/lib/battle-marker-clear') as typeof import('../../lambda/src/lib/battle-marker-clear');
    const asked = await requestMarkerClear({
      channelArn: 'arn:channel', battleId: 'b1', classification: 'premium', markers: [{ messageId: 'm1', botArn: 'arn:bot' }], wait: false,
    });
    expect(asked).toBe(1);
    expect(send.mock.calls[0][0].input).toEqual({ Name: '/agent-echelon/assistant/premium/router-arn' });
    expect(invoke.mock.calls[0][0].input.FunctionName).toBe('arn:aws:lambda:us-east-1:111122223333:function:router-premium');
  });
});

describe('the task service is read by name at call time, the same way (lib/classification-env.ts)', () => {
  const loadTasks = () => require('../../lambda/src/lib/classification-env') as typeof import('../../lambda/src/lib/classification-env');
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.endsWith('_TASK_SERVICE_ARN')) delete process.env[k];
    process.env.TASK_SERVICE_ARN_PARAM_ROOT = '/agent-echelon/assistant';
  });

  it("reads only the named classification's own parameter, and caches only a found ARN", async () => {
    const { resolveTaskServiceArn } = loadTasks();
    send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    expect(await resolveTaskServiceArn('premium')).toBeUndefined();
    send.mockResolvedValueOnce({ Parameter: { Value: 'arn:task-service-premium' } });
    expect(await resolveTaskServiceArn('premium')).toBe('arn:task-service-premium');
    expect(await resolveTaskServiceArn('premium')).toBe('arn:task-service-premium');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0].input)).toEqual([
      { Name: '/agent-echelon/assistant/premium/task-service-arn' },
      { Name: '/agent-echelon/assistant/premium/task-service-arn' },
    ]);
  });

  it('reads nothing for an undeclared value or the admin plane, and nothing without the root', async () => {
    const { resolveTaskServiceArn } = loadTasks();
    expect(await resolveTaskServiceArn('not-a-classification')).toBeUndefined();
    expect(await resolveTaskServiceArn('admin')).toBeUndefined();
    delete process.env.TASK_SERVICE_ARN_PARAM_ROOT;
    expect(await resolveTaskServiceArn('basic')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('a shared stack finds the routers and task services by name, and resolves no parameter at deploy', () => {
  it('carries the two roots, grants the path wildcards, and holds no SSM template parameter', () => {
    const common = require('../../lib/stacks/agent-classification-common') as typeof import('../../lib/stacks/agent-classification-common');
    const stack = new cdk.Stack(new cdk.App(), 'SharedByName', { env: { account: '111122223333', region: 'us-east-1' } });
    expect(common.routerByNameEnvironment()).toEqual({ ROUTER_ARN_PARAM_ROOT: '/agent-echelon/assistant' });
    expect(common.taskServiceByNameEnvironment()).toEqual({ TASK_SERVICE_ARN_PARAM_ROOT: '/agent-echelon/assistant' });
    const statements = [
      ...common.routerByNameStatements(stack, common.EVERY_CLASSIFICATION),
      ...common.taskServiceByNameStatements(stack, common.EVERY_CLASSIFICATION),
    ];
    new cdk.aws_iam.Role(stack, 'R', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: { P: new cdk.aws_iam.PolicyDocument({ statements }) },
    });
    const t = Template.fromStack(stack).toJSON();
    expect(Object.keys(t.Parameters ?? {}).filter((k) => /SsmParameterValue/.test(k))).toEqual([]);
    const policy = JSON.stringify(t.Resources);
    expect(policy).toContain('parameter/agent-echelon/assistant/*/router-arn');
    expect(policy).toContain('parameter/agent-echelon/assistant/*/task-service-arn');
    expect(policy).toContain('-TaskService*');
    expect(policy).toContain('-AgentHandler*');
  });

  it('a role of one classification names its own keys and nothing else', () => {
    const common = require('../../lib/stacks/agent-classification-common') as typeof import('../../lib/stacks/agent-classification-common');
    const stack = new cdk.Stack(new cdk.App(), 'OneByName', { env: { account: '111122223333', region: 'us-east-1' } });
    const resolved = [...common.routerByNameStatements(stack, ['basic']), ...common.taskServiceByNameStatements(stack, ['basic'])]
      .map((s) => JSON.stringify(stack.resolve(s.toStatementJson())));
    const joined = resolved.join('\n');
    expect(joined).toContain('/agent-echelon/assistant/basic/router-arn');
    expect(joined).toContain('/agent-echelon/assistant/basic/task-service-arn');
    expect(joined).not.toContain('assistant/*/');
    expect(joined).toContain('"aws:ResourceTag/classification":["basic"]');
  });
});
