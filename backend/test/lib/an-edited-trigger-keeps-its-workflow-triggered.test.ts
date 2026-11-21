/**
 * AN EDITED TRIGGER KEEPS ITS WORKFLOW TRIGGERED (DESIGN-EVENT-TARGETS 11.1, phase 5).
 *
 * The console edits a trigger by attaching its replacement with `replaces`. A rule's id is a digest of its room, workflow,
 * pattern and assistant, so:
 *  - an edit that keeps every part is the same rule, rewritten in place, and nothing is removed;
 *  - an edit that changes one attaches the new rule first, keyed by the one it replaces (`supersedes`), then removes the old
 *    rule and its room tag, so the workflow is never without a trigger and one event both match starts one run;
 *  - the replacement is counted once against the policy's caps, so an edit at the cap is not refused;
 *  - DENY: a replacement of a trigger the room does not hold for this workflow, or attached for another assistant, is refused.
 */
const mockRequireAdmin = jest.fn();
const mockChimeSend = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeMessagingClient: () => ({ send: (...a: unknown[]) => mockChimeSend(...a) }) }));

import { readFileSync } from 'fs';
import { join } from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import { editRunRoot, triggerTargetInput, watchRuleTags, watchTargetInput } from '../../lambda/src/lib/event-triggers';

const ebSend = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
const lambdaSend = jest.spyOn(LambdaClient.prototype, 'send') as unknown as jest.Mock;
const ssmSend = jest.spyOn(SSMClient.prototype, 'send') as unknown as jest.Mock;
let handler: (e: APIGatewayProxyEvent) => Promise<{ statusCode: number; body: string }>;
let roomTags: Record<string, string> = {};
let oldAssistant: string | undefined;
const PATTERNS: Record<string, string> = {
  'alarm-a': JSON.stringify({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], resources: ['arn:aws:cloudwatch:us-east-1:111122223333:alarm:A'] }),
  'alarm-b': JSON.stringify({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], resources: ['arn:aws:cloudwatch:us-east-1:111122223333:alarm:B'] }),
};
const names = () => ebSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name);
const inputs = (name: string) => ebSend.mock.calls.filter(([c]) => (c as { constructor: { name: string } }).constructor.name === name).map(([c]) => (c as { input: Record<string, unknown> }).input);

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  process.env.EVENT_TRIGGER_RULE_PREFIX = 'ae-';
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
  oldAssistant = undefined;
  mockChimeSend.mockResolvedValue({});
  mockRequireAdmin.mockResolvedValue({ claims: { actor: 'admin-1' } });
  ssmSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
  lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: true })) });
  ebSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    switch (cmd.constructor.name) {
      case 'DescribeRuleCommand': {
        const name = String(cmd.input.Name);
        return { Arn: `arn:aws:events:us-east-1:111122223333:rule/${name}`, EventPattern: PATTERNS[name] ?? PATTERNS['alarm-a'] };
      }
      case 'ListTagsForResourceCommand': return { Tags: oldAssistant ? [{ Key: 'assistant', Value: oldAssistant }] : [] };
      case 'ListRulesCommand': return { Rules: [] };
      case 'PutRuleCommand': return { RuleArn: `arn:aws:events:us-east-1:111122223333:rule/${String(cmd.input.Name)}` };
      case 'PutTargetsCommand': return { FailedEntryCount: 0 };
      case 'RemoveTargetsCommand': return { FailedEntryCount: 0 };
      case 'DeleteRuleCommand': return {};
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
});

const attach = (rule: string, replaces?: string) => handler({
  httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
  pathParameters: { typeKey: 'ops-team', classification: 'premium' }, requestContext: { accountId: '111122223333' },
  body: JSON.stringify({ workflow: 'incident-triage', rule, ...(replaces ? { replaces } : {}) }),
} as unknown as APIGatewayProxyEvent);

/** Attach the first trigger and record it on the room, as a standing trigger is. */
async function standing(rule: string): Promise<string> {
  const res = await attach(rule);
  expect(res.statusCode).toBe(200);
  const id = JSON.parse(res.body).id as string;
  roomTags = { [`event-rule:${id}`]: 'incident-triage' };
  jest.clearAllMocks();
  mockChimeSend.mockResolvedValue({});
  return id;
}

describe('an edit that keeps every part', () => {
  it('is the same rule, rewritten in place: nothing is removed', async () => {
    const id = await standing('alarm-a');
    const res = await attach('alarm-a', id);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id, replaced: id });
    expect(names()).not.toContain('DeleteRuleCommand');
    expect(JSON.stringify(inputs('PutTargetsCommand'))).not.toContain('supersedes');
  });
});

describe('an edit that changes the rule', () => {
  it('attaches the new rule keyed by the old, then removes the old rule and its room tag', async () => {
    const old = await standing('alarm-a');
    const res = await attach('alarm-b', old);
    expect(res.statusCode).toBe(200);
    const { id } = JSON.parse(res.body);
    expect(id).not.toBe(old);
    expect(JSON.stringify(inputs('PutTargetsCommand')[0])).toContain(`\\"supersedes\\":\\"${old}\\"`);
    const order = names();
    expect(order.indexOf('PutRuleCommand')).toBeLessThan(order.indexOf('DeleteRuleCommand'));
    expect(inputs('DeleteRuleCommand')[0]).toEqual({ Name: `ae-premium-trigger-${old}` });
    const untag = mockChimeSend.mock.calls.map(([c]) => c as { constructor: { name: string }; input: { TagKeys?: string[] } }).find((c) => c.constructor.name === 'UntagResourceCommand');
    expect(untag?.input.TagKeys).toEqual([`event-rule:${old}`]);
  });

  it('is counted once against the policy\'s caps: an edit at the cap is not refused, a new trigger is', async () => {
    const old = await standing('alarm-a');
    roomTags = { ...roomTags, 'event-rule:aaaaaaaaaaa1': 'w', 'event-rule:aaaaaaaaaaa2': 'w', 'event-rule:aaaaaaaaaaa3': 'w', 'event-rule:aaaaaaaaaaa4': 'w' };
    expect((await attach('alarm-b')).statusCode).toBe(409);
    expect((await attach('alarm-b', old)).statusCode).toBe(200);
  });
});

describe('DENY: what an edit may replace', () => {
  it('a trigger the room does not hold for this workflow is not replaced, and nothing is written', async () => {
    roomTags = { 'event-rule:aaaaaaaaaaa1': 'another-workflow' };
    const res = await attach('alarm-b', 'aaaaaaaaaaa1');
    expect(res.statusCode).toBe(404);
    expect(names()).not.toContain('PutRuleCommand');
    expect((await attach('alarm-b', 'not-an-id')).statusCode).toBe(400);
  });

  it('a trigger attached for another assistant is not replaced', async () => {
    const old = await standing('alarm-a');
    oldAssistant = 'advisor-premium';
    const res = await handler({
      httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
      pathParameters: { typeKey: 'ops-team', classification: 'premium' }, requestContext: { accountId: '111122223333' },
      body: JSON.stringify({ workflow: 'incident-triage', rule: 'alarm-b', replaces: old, assistant: 'ops-premium' }),
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(409);
    expect(names()).not.toContain('DeleteRuleCommand');
  });
});

describe('one event both rules match during the swap starts one run', () => {
  it('the replacement\'s input names the rule it replaced, for team rooms and watched conversations alike', () => {
    expect(triggerTargetInput({ rule: 'bbbbbbbbbbbb', channelArn: 'c', workflow: 'w', supersedes: 'aaaaaaaaaaaa' }).InputTemplate).toContain('"supersedes":"aaaaaaaaaaaa"');
    expect(watchTargetInput({ rule: 'bbbbbbbbbbbb', keyPath: '$.detail.id', supersedes: 'aaaaaaaaaaaa' }).InputTemplate).toContain('"supersedes":"aaaaaaaaaaaa"');
    expect(triggerTargetInput({ rule: 'bbbbbbbbbbbb', channelArn: 'c', workflow: 'w' }).InputTemplate).not.toContain('supersedes');
  });

  it('the router keys the run by the replaced rule, and checks the rule that delivered it', () => {
    const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/const runRule = \/\^\[a-f0-9\]\{12\}\$\/\.test\(str\(r\.supersedes\)\) \? str\(r\.supersedes\) : rule;/);
    expect(router).toMatch(/ruleEvent: \{ rule: runRule, window,/);
    expect(router).toMatch(/ruleEvent: \{\s+rule: TRIGGER_RULE_ID\.test\(str\(r\.supersedes\)\) \? str\(r\.supersedes\) : rule, window,[\s\S]{0,400}: byPattern \|\| named \? \{\} : \{ watch:/);
  });
});

describe('an AgentEchelon event, chosen by its source and detail type', () => {
  const platform = (source: string, detailType: string) => handler({
    httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
    pathParameters: { typeKey: 'ops-team', classification: 'premium' }, requestContext: { accountId: '111122223333' },
    body: JSON.stringify({ workflow: 'incident-triage', platformEvent: { source, detailType } }),
  } as unknown as APIGatewayProxyEvent);

  it('DENY: an admin notice is never a trigger, and a source outside the platform\'s is not taken as one', async () => {
    const notice = await platform('ae.alert', 'Admin alert');
    expect(notice.statusCode).toBe(400);
    expect(JSON.parse(notice.body).error).toMatch(/admin notice is not a trigger/);
    expect((await platform('aeXalert', 'x')).statusCode).toBe(400);
    expect((await platform('aws.ec2', 'x')).statusCode).toBe(400);
    expect(names()).not.toContain('PutRuleCommand');
  });
});

describe('an edit of an edit keeps one run key', () => {
  it('keys the new rule by the replaced rule\'s own root, and records that root on the new rule', async () => {
    const old = await standing('alarm-a');
    // THE STANDING RULE IS ITSELF AN EDIT, keyed by the first rule of the chain.
    ebSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      switch (cmd.constructor.name) {
        case 'DescribeRuleCommand': return { Arn: `arn:aws:events:us-east-1:111122223333:rule/${String(cmd.input.Name)}`, EventPattern: PATTERNS['alarm-a'] };
        case 'ListTagsForResourceCommand': return { Tags: [{ Key: 'supersedes', Value: 'aaaaaaaaaaaa' }] };
        case 'PutRuleCommand': return { RuleArn: `arn:aws:events:us-east-1:111122223333:rule/${String(cmd.input.Name)}` };
        default: return {};
      }
    });
    const res = await attach('alarm-b', old);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(inputs('PutTargetsCommand')[0])).toContain('\\"supersedes\\":\\"aaaaaaaaaaaa\\"');
    expect(JSON.stringify(inputs('PutTargetsCommand')[0])).not.toContain(`\\"supersedes\\":\\"${old}\\"`);
    expect(inputs('PutRuleCommand')[0].Tags).toEqual(expect.arrayContaining([{ Key: 'supersedes', Value: 'aaaaaaaaaaaa' }]));
  });

  it('a first edit roots the chain at the rule it replaced; a root that is no rule id is not taken', () => {
    expect(editRunRoot('bbbbbbbbbbbb', undefined, /^[a-f0-9]{12}$/)).toBe('bbbbbbbbbbbb');
    expect(editRunRoot('bbbbbbbbbbbb', 'aaaaaaaaaaaa', /^[a-f0-9]{12}$/)).toBe('aaaaaaaaaaaa');
    expect(editRunRoot('bbbbbbbbbbbb', 'not-a-rule', /^[a-f0-9]{12}$/)).toBe('bbbbbbbbbbbb');
    // A WATCH RULE CARRIES THE SAME ROOT TAG.
    expect(watchRuleTags({ classification: 'premium', workflow: 'w', typeKey: 't', kind: 'k', source: 's', detailType: 'd', supersedes: 'aaaaaaaaaaaa' })).toContainEqual({ Key: 'supersedes', Value: 'aaaaaaaaaaaa' });
  });
});

describe('DENY: a trigger whose event names its conversation, on a type whose watch triggers are not listed', () => {
  it('is refused for a team conversation type, so no rule is left that the console cannot list or remove', async () => {
    const res = await handler({
      httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
      pathParameters: { typeKey: 'ops-team', classification: 'premium' }, requestContext: { accountId: '111122223333' },
      body: JSON.stringify({ workflow: 'incident-triage', target: 'named' }),
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('NAMED_TARGET_TYPE');
    expect(names()).not.toContain('PutRuleCommand');
  });
});
