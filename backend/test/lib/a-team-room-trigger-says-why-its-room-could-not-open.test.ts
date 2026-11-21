/**
 * A TEAM ROOM TRIGGER SAYS WHY ITS ROOM COULD NOT OPEN (`event-triggers-api.ts`). Every attach asks the creator to open or
 * complete the type's team room, and the creator refuses with its own reason: an on-call group without exactly one person, or
 * an assistant the type names that this deployment does not declare (the `ops-team` room's ops assistant). The console is
 * answered with that reason, and no rule is made.
 */
const mockRequireAdmin = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeMessagingClient: () => ({ send: jest.fn(async () => ({})) }) }));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';

const ebSend = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
const lambdaSend = jest.spyOn(LambdaClient.prototype, 'send') as unknown as jest.Mock;
const ssmSend = jest.spyOn(SSMClient.prototype, 'send') as unknown as jest.Mock;
let handler: (e: APIGatewayProxyEvent) => Promise<{ statusCode: number; body: string }>;

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  process.env.EVENT_TRIGGER_RULE_PREFIX = 'ae';
  process.env.EVENT_POLICY_PARAM = '/ae/event-policy';
  process.env.TYPED_CREATOR_NAME_PATTERN = 'ae-{classification}-TypedConversationFromEvent';
  ({ handler } = await import('../../lambda/src/event-triggers-api'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ claims: { actor: 'admin-1' } });
  // No saved policy: the deployment's dev values, which allow the platform's ops events.
  ssmSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
  ebSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'DescribeRuleCommand') return { EventPattern: JSON.stringify({ source: ['ae.ops'], 'detail-type': ['Incident opened'] }) };
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
});

const attach = () => handler({
  httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
  pathParameters: { typeKey: 'ops-team', classification: 'premium' }, requestContext: { accountId: '111122223333' },
  body: JSON.stringify({ workflow: 'incident-triage', rule: 'some-rule' }),
} as unknown as APIGatewayProxyEvent);

const creatorAnswers = (answer: unknown) => lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify(answer)) });

describe('attaching a team room trigger whose room the creator refuses', () => {
  it('answers the creator\'s reason, and makes no rule', async () => {
    creatorAnswers({ ok: false, error: 'no live assistant holds the ops role this type names' });
    const res = await attach();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ code: 'NO_TEAM_ROOM', error: 'the team conversation could not be opened: no live assistant holds the ops role this type names' });
    expect(ebSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name)).not.toContain('PutRuleCommand');
  });

  it('answers without a reason when the creator gave none', async () => {
    lambdaSend.mockResolvedValue({ FunctionError: 'Unhandled', Payload: Buffer.from('{}') });
    const res = await attach();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('the team conversation could not be opened');
  });
});

describe('a listed trigger names the assistant it was attached for', () => {
  const list = (typeKey: string) => handler({
    httpMethod: 'GET', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
    pathParameters: { typeKey, classification: 'premium' }, requestContext: { accountId: '111122223333' },
  } as unknown as APIGatewayProxyEvent);
  const ID = 'abcdef012345';
  const OTHER = '0123456789ab';

  it('a team room trigger, from its rule\'s tag, and none where the rule records none', async () => {
    const tagsRead = jest.spyOn(jest.requireActual('../../lambda/src/lib/channel-classification'), 'readChannelTags');
    tagsRead.mockResolvedValue({ [`event-rule:${ID}`]: 'incident-triage', [`event-rule:${OTHER}`]: 'incident-triage' } as never);
    ebSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, string> }) => {
      if (cmd.constructor.name === 'DescribeRuleCommand') return { Arn: `arn:aws:events:us-east-1:111122223333:rule/${cmd.input.Name}`, EventPattern: '{}' };
      if (cmd.constructor.name === 'ListTagsForResourceCommand') return { Tags: cmd.input.ResourceARN.endsWith(ID) ? [{ Key: 'assistant', Value: 'ops-premium' }] : [] };
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const res = await list('ops-team');
    tagsRead.mockRestore();
    expect(res.statusCode).toBe(200);
    const triggers = JSON.parse(res.body).triggers as Array<{ id: string; assistant?: string }>;
    expect(triggers.find((t) => t.id === ID)?.assistant).toBe('ops-premium');
    expect(triggers.find((t) => t.id === OTHER)).not.toHaveProperty('assistant');
  });

  it('a watch trigger, from its rule\'s tag', async () => {
    ebSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'ListRulesCommand': return { Rules: [{ Name: `aepremium-watch-${ID}`, Arn: 'arn:aws:events:us-east-1:111122223333:rule/w', EventPattern: '{}' }] };
        case 'ListTagsForResourceCommand': return { Tags: [{ Key: 'conversation-type', Value: 'ops' }, { Key: 'classification', Value: 'premium' }, { Key: 'workflow', Value: 'incident-updated' }, { Key: 'watch-kind', Value: 'ops-incident' }, { Key: 'assistant', Value: 'ops-premium' }] };
        case 'ListTargetsByRuleCommand': return { Targets: [] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    const res = await list('ops');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).triggers).toEqual([expect.objectContaining({ id: ID, assistant: 'ops-premium' })]);
  });

  const denied = () => Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });

  it('DENY: a team room trigger whose tags cannot be read fails the list, never listing it as nobody\'s', async () => {
    const tagsRead = jest.spyOn(jest.requireActual('../../lambda/src/lib/channel-classification'), 'readChannelTags');
    tagsRead.mockResolvedValue({ [`event-rule:${ID}`]: 'incident-triage' } as never);
    ebSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, string> }) => {
      if (cmd.constructor.name === 'DescribeRuleCommand') return { Arn: `arn:aws:events:us-east-1:111122223333:rule/${cmd.input.Name}`, EventPattern: '{}' };
      if (cmd.constructor.name === 'ListTagsForResourceCommand') throw denied();
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const res = await list('ops-team');
    tagsRead.mockRestore();
    expect(res.statusCode).toBe(500);
  });

  it('DENY: a watch rule whose tags cannot be read fails the list, so the type\'s cap never counts short', async () => {
    ebSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'ListRulesCommand': return { Rules: [{ Name: `aepremium-watch-${ID}`, Arn: 'arn:aws:events:us-east-1:111122223333:rule/w', EventPattern: '{}' }] };
        case 'ListTagsForResourceCommand': throw denied();
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    expect((await list('ops')).statusCode).toBe(500);
  });

  it('the triggers function may read the tags of this instance\'s team room trigger rules', () => {
    const stack = require('fs').readFileSync(require('path').join(__dirname, '../../lib/stacks/admin-services-stack.ts'), 'utf8') as string;
    expect(stack).toContain("sid: 'ReadTriggerRuleTags', actions: ['events:ListTagsForResource'], resources: [triggerRules[0], triggerRules[2]]");
  });
});
