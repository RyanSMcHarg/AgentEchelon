/**
 * AN ACTIVATION REMOVES THE TRIGGERS ITS VERSION NO LONGER RUNS (DESIGN-EVENT-TARGETS section 7).
 *
 * What it proves: once a version is activated, manage-profiles names the assistant to the trigger service, which reads that
 * assistant's active version itself and removes each rule attached for it whose workflow now starts on a lifecycle event or is
 * gone, as a removal does (the team conversation's tag, then the target, then the rule); a rule whose workflow still runs on an
 * attached event stays; DENY: another assistant's rule, or one attached for none, is never touched; a rule that cannot be removed
 * is left and logged, and the activation stands.
 */
const mockRequireAdmin = jest.fn();
const mockChimeSend = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeMessagingClient: () => ({ send: (...a: unknown[]) => mockChimeSend(...a) }) }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { InvokeCommand } from '@aws-sdk/client-lambda';

const ebSend = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
const ssmSend = jest.spyOn(SSMClient.prototype, 'send') as unknown as jest.Mock;
let api: typeof import('../../lambda/src/event-triggers-api');

const RULE = (kind: 'trigger' | 'watch', id: string) => `ae-premium-${kind}-${id}`;
const ARN = (name: string) => `arn:aws:events:us-east-1:111122223333:rule/${name}`;
/** The rules the deployment holds, each with its tags. */
const RULES: Record<string, Array<{ Key: string; Value: string }>> = {
  // The ops assistant's team-conversation trigger on a workflow its new version starts on a lifecycle event.
  [RULE('trigger', 'aaaaaaaaaaaa')]: [{ Key: 'classification', Value: 'premium' }, { Key: 'team-room', Value: 'ops-team' }, { Key: 'workflow', Value: 'incident-triage' }, { Key: 'assistant', Value: 'ops-premium' }],
  // Its watch trigger on a workflow the new version still runs on an attached event.
  [RULE('watch', 'bbbbbbbbbbbb')]: [{ Key: 'classification', Value: 'premium' }, { Key: 'conversation-type', Value: 'ops' }, { Key: 'workflow', Value: 'incident-updated' }, { Key: 'assistant', Value: 'ops-premium' }],
  // Its watch trigger on a workflow the new version no longer declares.
  [RULE('watch', 'cccccccccccc')]: [{ Key: 'classification', Value: 'premium' }, { Key: 'conversation-type', Value: 'ops' }, { Key: 'workflow', Value: 'retired-workflow' }, { Key: 'assistant', Value: 'ops-premium' }],
  // Another assistant's rule on a workflow of the same name, and one attached for no assistant.
  [RULE('trigger', 'dddddddddddd')]: [{ Key: 'classification', Value: 'premium' }, { Key: 'team-room', Value: 'ops-team' }, { Key: 'workflow', Value: 'incident-triage' }, { Key: 'assistant', Value: 'advisor-premium' }],
  [RULE('trigger', 'eeeeeeeeeeee')]: [{ Key: 'classification', Value: 'premium' }, { Key: 'team-room', Value: 'ops-team' }, { Key: 'workflow', Value: 'incident-triage' }],
};
const ACTIVE = { eventWorkflows: { 'incident-triage': { on: 'conversation-opened' }, 'incident-updated': { on: 'event-received' } } };
const calls = (name: string) => ebSend.mock.calls.map(([c]) => c as { constructor: { name: string }; input: Record<string, unknown> }).filter((c) => c.constructor.name === name).map((c) => c.input);
let failDelete: string | undefined;

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  process.env.EVENT_TRIGGER_RULE_PREFIX = 'ae-';
  process.env.SSM_ROOT = '/ae';
  api = await import('../../lambda/src/event-triggers-api');
});

beforeEach(() => {
  jest.clearAllMocks();
  failDelete = undefined;
  mockChimeSend.mockResolvedValue({});
  ssmSend.mockImplementation(async (cmd: { constructor: { name: string }; input: { Name: string } }) => {
    if (cmd.constructor.name === 'GetParameterCommand' && cmd.input.Name.endsWith('/ops-premium/definition:active')) return { Parameter: { Value: JSON.stringify(ACTIVE) } };
    throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
  });
  ebSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    switch (cmd.constructor.name) {
      case 'ListRulesCommand': return { Rules: [...Object.keys(RULES).map((Name) => ({ Name, Arn: ARN(Name) })), { Name: 'ae-admin-notice-alarm', Arn: ARN('ae-admin-notice-alarm') }] };
      case 'ListTagsForResourceCommand': return { Tags: RULES[String(cmd.input.ResourceARN).split('/').pop()!] ?? [] };
      case 'RemoveTargetsCommand': return { FailedEntryCount: 0 };
      case 'DeleteRuleCommand':
        if (cmd.input.Name === failDelete) throw Object.assign(new Error('x'), { name: 'InternalException' });
        return {};
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
});

const sweep = () => api.handler({ aeTriggerSweep: { assistant: 'ops-premium' } });

describe('an activation that moves a workflow to a lifecycle event', () => {
  it('removes its rule: the team conversation\'s tag, then the target, then the rule; and a workflow the version no longer declares too', async () => {
    expect((await sweep()).statusCode).toBe(200);
    expect(calls('DeleteRuleCommand').map((i) => i.Name).sort()).toEqual([RULE('trigger', 'aaaaaaaaaaaa'), RULE('watch', 'cccccccccccc')]);
    const untag = mockChimeSend.mock.calls.map(([c]) => c as { constructor: { name: string }; input: { ResourceARN: string; TagKeys: string[] } }).filter((c) => c.constructor.name === 'UntagResourceCommand');
    expect(untag.map((c) => c.input.TagKeys)).toEqual([['event-rule:aaaaaaaaaaaa']]);
    expect(untag[0].input.ResourceARN).toMatch(/\/channel\/team-ops-team-premium$/);
    // THE ORDER A REMOVAL TAKES: the tag before the target, the target before the rule.
    const removeA = ebSend.mock.calls.findIndex(([c]) => (c as { constructor: { name: string }; input: { Rule?: string } }).constructor.name === 'RemoveTargetsCommand' && (c as { input: { Rule?: string } }).input.Rule === RULE('trigger', 'aaaaaaaaaaaa'));
    const deleteA = ebSend.mock.calls.findIndex(([c]) => (c as { constructor: { name: string }; input: { Name?: string } }).constructor.name === 'DeleteRuleCommand' && (c as { input: { Name?: string } }).input.Name === RULE('trigger', 'aaaaaaaaaaaa'));
    expect(mockChimeSend.mock.invocationCallOrder[0]).toBeLessThan(ebSend.mock.invocationCallOrder[removeA]);
    expect(removeA).toBeLessThan(deleteA);
  });

  it('keeps a rule whose workflow the version still runs on an attached event', async () => {
    await sweep();
    expect(calls('DeleteRuleCommand').map((i) => i.Name)).not.toContain(RULE('watch', 'bbbbbbbbbbbb'));
  });

  it('DENY: another assistant\'s rule, one attached for none, and a rule the trigger service does not own are never touched', async () => {
    await sweep();
    const deleted = calls('DeleteRuleCommand').map((i) => i.Name);
    for (const kept of [RULE('trigger', 'dddddddddddd'), RULE('trigger', 'eeeeeeeeeeee'), 'ae-admin-notice-alarm']) expect(deleted).not.toContain(kept);
    expect(calls('ListTagsForResourceCommand').map((i) => i.ResourceARN)).not.toContain(ARN('ae-admin-notice-alarm'));
  });

  it('DENY: an assistant with no readable active version has nothing removed', async () => {
    ssmSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
    expect(await api.sweepAssistantTriggers('ops-premium')).toEqual({ removed: [], failed: [] });
    expect(calls('DeleteRuleCommand')).toEqual([]);
  });
});

describe('a cleanup that fails never fails the activation', () => {
  it('a rule that cannot be removed is left and logged, and the others are removed', async () => {
    failDelete = RULE('trigger', 'aaaaaaaaaaaa');
    const out = await api.sweepAssistantTriggers('ops-premium');
    expect(out.failed).toEqual([RULE('trigger', 'aaaaaaaaaaaa')]);
    expect(out.removed).toEqual(['cccccccccccc']);
    expect((await sweep()).statusCode).toBe(200);
  });

  it('manage-profiles asks for the cleanup after each activation, asynchronously, and an invoke that fails is only logged', async () => {
    const { sweepTriggersAfterActivation } = await import('../../lambda/src/manage-profiles');
    process.env.EVENT_TRIGGERS_FUNCTION = 'ae-EventTriggersFn';
    const sent: InvokeCommand[] = [];
    await sweepTriggersAfterActivation('ops-premium', async (c) => { sent.push(c); return {}; });
    expect(sent[0].input).toMatchObject({ FunctionName: 'ae-EventTriggersFn', InvocationType: 'Event' });
    expect(JSON.parse(Buffer.from(sent[0].input.Payload as Uint8Array).toString())).toEqual({ aeTriggerSweep: { assistant: 'ops-premium' } });
    await expect(sweepTriggersAfterActivation('ops-premium', async () => { throw new Error('down'); })).resolves.toBeUndefined();
    delete process.env.EVENT_TRIGGERS_FUNCTION;
    const src = readFileSync(join(__dirname, '../../lambda/src/manage-profiles.ts'), 'utf8');
    expect(src.match(/await sweepTriggersAfterActivation\(profileName\);/g)).toHaveLength(2);
  });

  it('the one new grant is manage-profiles\' invoke of the trigger service', () => {
    const stack = readFileSync(join(__dirname, '../../lib/stacks/admin-services-stack.ts'), 'utf8');
    expect(stack).toContain('this.triggersFn.grantInvoke(assistants.manageProfilesFn);');
  });
});
