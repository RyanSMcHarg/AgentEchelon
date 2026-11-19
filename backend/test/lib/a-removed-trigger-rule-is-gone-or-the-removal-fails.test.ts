/**
 * A TRIGGER IS REPORTED REMOVED ONLY WHEN ITS RULE IS GONE (`event-triggers-api.ts`). The rule's own tags are the binding
 * the router reads for a watched conversation, so a rule EventBridge refused to delete would keep running the workflow:
 * the console is answered with the failure instead. A rule already gone counts as removed.
 */
const mockRequireAdmin = jest.fn();
const mockChimeSend = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeMessagingClient: () => ({ send: (...a: unknown[]) => mockChimeSend(...a) }) }));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';

const ID = 'abcdef012345';
const ebSend = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
let handler: (e: APIGatewayProxyEvent) => Promise<{ statusCode: number; body: string }>;

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  process.env.EVENT_TRIGGER_RULE_PREFIX = 'ae';
  ({ handler } = await import('../../lambda/src/event-triggers-api'));
});

const remove = (typeKey: string, assistant?: string) => handler({
  httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}/{ruleId}/remove', headers: {},
  pathParameters: { typeKey, classification: 'premium', ruleId: ID }, requestContext: { accountId: '111122223333' },
  ...(assistant ? { body: JSON.stringify({ assistant }) } : {}),
} as unknown as APIGatewayProxyEvent);

/** EventBridge answering the watch rule's reads as this type's, and the removal as `onRemove`/`onDelete` say. */
function eventBridge(onRemove: () => unknown, onDelete: () => unknown, attachedFor?: string): void {
  ebSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'DescribeRuleCommand': return { Arn: 'arn:aws:events:us-east-1:111122223333:rule/r', EventPattern: '{}' };
      case 'ListTagsForResourceCommand': return { Tags: [{ Key: 'conversation-type', Value: 'ops' }, { Key: 'classification', Value: 'premium' }, { Key: 'workflow', Value: 'w' }, { Key: 'watch-kind', Value: 'ops-incident' }, ...(attachedFor ? [{ Key: 'assistant', Value: attachedFor }] : [])] };
      case 'ListTargetsByRuleCommand': return { Targets: [] };
      case 'RemoveTargetsCommand': return onRemove();
      case 'DeleteRuleCommand': return onDelete();
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
}
const refused = (name: string) => () => { throw Object.assign(new Error(name), { name }); };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ claims: { actor: 'admin-1' } });
  mockChimeSend.mockResolvedValue({});
});

describe('removing a watch trigger', () => {
  it('answers removed when the target and the rule are deleted', async () => {
    eventBridge(() => ({ FailedEntryCount: 0 }), () => ({}));
    const res = await remove('ops');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: ID });
  });

  it('answers removed when the rule is already gone', async () => {
    eventBridge(refused('ResourceNotFoundException'), refused('ResourceNotFoundException'));
    expect((await remove('ops')).statusCode).toBe(200);
  });

  it('answers the failure when EventBridge refuses to remove the target, and never says removed', async () => {
    eventBridge(refused('ConcurrentModificationException'), () => ({}));
    const res = await remove('ops');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('removed');
  });

  it('answers the failure when the target is reported not removed', async () => {
    eventBridge(() => ({ FailedEntryCount: 1, FailedEntries: [{ ErrorCode: 'ConcurrentModificationException' }] }), () => ({}));
    expect((await remove('ops')).statusCode).toBe(500);
  });

  it('answers the failure when the rule is not deleted', async () => {
    eventBridge(() => ({ FailedEntryCount: 0 }), refused('ValidationException'));
    expect((await remove('ops')).statusCode).toBe(500);
  });
});

describe('removing a team room trigger', () => {
  it('answers the failure when the rule is not deleted', async () => {
    eventBridge(() => ({ FailedEntryCount: 0 }), refused('ValidationException'));
    expect((await remove('ops-team')).statusCode).toBe(500);
  });

  it('keeps the room\'s tag while the rule stays, so the trigger is still listed and its removal can be tried again', async () => {
    eventBridge(() => ({ FailedEntryCount: 0 }), refused('ValidationException'));
    expect((await remove('ops-team')).statusCode).toBe(500);
    expect(mockChimeSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name)).not.toContain('UntagResourceCommand');
  });

  it('takes the room\'s tag away once the rule is gone', async () => {
    eventBridge(() => ({ FailedEntryCount: 0 }), () => ({}));
    expect((await remove('ops-team')).statusCode).toBe(200);
    expect(mockChimeSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name)).toContain('UntagResourceCommand');
  });
});

describe('a trigger is removed only for the assistant it was attached for', () => {
  const deleted = () => ebSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name).filter((n) => n === 'DeleteRuleCommand');

  it.each(['ops', 'ops-team'])('REFUSED: a %s rule attached for another assistant, whose version runs it, is left running', async (typeKey) => {
    eventBridge(() => ({ FailedEntryCount: 0 }), () => ({}), 'ops-premium');
    const res = await remove(typeKey, 'concierge');
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('TRIGGER_OTHER_ASSISTANT');
    expect(deleted()).toEqual([]);
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it.each(['ops', 'ops-team'])('removes a %s rule for the assistant it was attached for', async (typeKey) => {
    eventBridge(() => ({ FailedEntryCount: 0 }), () => ({}), 'ops-premium');
    expect((await remove(typeKey, 'ops-premium')).statusCode).toBe(200);
    expect(deleted()).toHaveLength(1);
  });
});

describe('a trigger runs only in a type an event reaches', () => {
  it('refuses a type with no team room and no opener that watches a key, as the workflow validator does', async () => {
    eventBridge(() => ({}), () => ({}));
    const res = await remove('general');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('NOT_A_TRIGGER_TYPE');
  });
});
