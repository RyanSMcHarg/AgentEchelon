/**
 * A THROTTLED TRIGGER ATTACH SAYS SO AND LEAVES NOTHING (`event-triggers-api.ts`). Attaching writes the rule,
 * its target, then the team conversation's tag; the Amazon Chime SDK throttles TagResource on a busy conversation.
 *
 * What it proves:
 *  - a throttled tag answers 429 with the code `TRIGGER_THROTTLED`, which the console says in words, never a bare 500;
 *  - the rule this attach made is removed again (its target, then the rule), so no rule is left that its room does not name;
 *  - a trigger the room already names is left as it runs: a throttled re-attach removes nothing;
 *  - any other failure still answers 500, and still removes the rule it made.
 */
const mockRequireAdmin = jest.fn();
const mockChimeSend = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeMessagingClient: () => ({ send: (...a: unknown[]) => mockChimeSend(...a) }) }));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';

const ebSend = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
const lambdaSend = jest.spyOn(LambdaClient.prototype, 'send') as unknown as jest.Mock;
const ssmSend = jest.spyOn(SSMClient.prototype, 'send') as unknown as jest.Mock;
let handler: (e: APIGatewayProxyEvent) => Promise<{ statusCode: number; body: string }>;
let roomTags: Record<string, string> = {};
const calls = () => ebSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name);
const throttled = () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottledClientException', $metadata: { httpStatusCode: 429 } });

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  process.env.EVENT_TRIGGER_RULE_PREFIX = 'ae';
  process.env.EVENT_POLICY_PARAM = '/ae/event-policy';
  process.env.TYPED_CREATOR_NAME_PATTERN = 'ae-{classification}-TypedConversationFromEvent';
  process.env.EVENT_TRIGGER_RELAY_NAME_PATTERN = 'ae-{classification}-Relay';
  const tags = jest.requireActual('../../lambda/src/lib/channel-classification');
  jest.spyOn(tags, 'readChannelTags').mockImplementation(async () => roomTags);
  ({ handler } = await import('../../lambda/src/event-triggers-api'));
});

beforeEach(() => {
  jest.clearAllMocks();
  roomTags = {};
  mockRequireAdmin.mockResolvedValue({ claims: { actor: 'admin-1' } });
  ssmSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
  lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: true })) });
  ebSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    switch (cmd.constructor.name) {
      case 'DescribeRuleCommand': return { EventPattern: JSON.stringify({ source: ['ae.ops'], 'detail-type': ['Incident opened'] }) };
      case 'ListRulesCommand': return { Rules: [] };
      case 'PutRuleCommand': return { RuleArn: `arn:aws:events:us-east-1:111122223333:rule/${String(cmd.input.Name)}` };
      case 'PutTargetsCommand': return { FailedEntryCount: 0 };
      case 'RemoveTargetsCommand': return { FailedEntryCount: 0 };
      case 'DeleteRuleCommand': return {};
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
});

const attach = () => handler({
  httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
  pathParameters: { typeKey: 'ops-team', classification: 'premium' }, requestContext: { accountId: '111122223333' },
  body: JSON.stringify({ workflow: 'incident-triage', rule: 'some-rule' }),
} as unknown as APIGatewayProxyEvent);

describe('attaching a trigger whose team conversation the Amazon Chime SDK throttles', () => {
  it('answers 429 TRIGGER_THROTTLED, and removes the rule it made', async () => {
    mockChimeSend.mockRejectedValue(throttled());
    const res = await attach();
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ code: 'TRIGGER_THROTTLED', error: 'the call was throttled; nothing was attached, try again' });
    expect(calls()).toEqual(expect.arrayContaining(['PutRuleCommand', 'PutTargetsCommand', 'RemoveTargetsCommand', 'DeleteRuleCommand']));
    expect(calls().indexOf('RemoveTargetsCommand')).toBeLessThan(calls().indexOf('DeleteRuleCommand'));
  });

  it('a trigger the room already names is left running: a throttled re-attach removes nothing', async () => {
    mockChimeSend.mockResolvedValue({});
    expect((await attach()).statusCode).toBe(200);
    const tagged = (mockChimeSend.mock.calls[0][0] as { input: { Tags: Array<{ Key: string; Value: string }> } }).input.Tags[0];
    roomTags = { [tagged.Key]: tagged.Value };
    ebSend.mockClear();
    mockChimeSend.mockRejectedValue(throttled());
    const res = await attach();
    expect(res.statusCode).toBe(429);
    expect(calls()).not.toContain('DeleteRuleCommand');
    expect(calls()).not.toContain('RemoveTargetsCommand');
  });

  it('any other failure of the tag still answers 500, and still removes the rule it made', async () => {
    mockChimeSend.mockRejectedValue(Object.assign(new Error('no'), { name: 'ForbiddenException' }));
    const res = await attach();
    expect(res.statusCode).toBe(500);
    expect(calls()).toContain('DeleteRuleCommand');
  });
});
