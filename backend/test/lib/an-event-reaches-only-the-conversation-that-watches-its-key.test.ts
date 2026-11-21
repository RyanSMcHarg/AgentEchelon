/**
 * AN EVENT REACHES ONLY THE CONVERSATION THAT WATCHES ITS KEY (DESIGN-EVENT-TARGETS section 4, WT123, WT124, WT126).
 *
 * What it proves:
 *  - the router starts nothing on a malformed event, a key that is not an id, a rule that is not this classification's watch
 *    rule, an event of another type than the rule's, a key no conversation here watches, or a conversation that does not;
 *  - every check comes before the run, in order, and the payload names only the rule and the key;
 *  - one run per rule, key and window, and a continuation re-reads the rule and the watch;
 *  - the rule's input keeps every placeholder unquoted, its tags carry the binding, and the IAM grants are its classification's own.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { eventAgeRefusal, handleWatchEvent, watchBindingOf } from '../../lambda/src/router-agent-handler';
import { eventNaturalKey } from '../../lambda/src/lib/event-natural-key';
import { EVENT_TRIGGER_WINDOW_MINUTES, eventTriggerWindow, watchRuleName, watchRuleTags, watchTargetInput } from '../../lambda/src/lib/event-triggers';
import { DEV_EVENT_POLICY, eventPolicyErrors, eventPolicyOf } from '../../lambda/src/lib/event-policy';

const ROOT = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const AT = new Date().toISOString();
const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/channel/conv-1';
const BINDING = { workflow: 'incident-updated', type: 'ops', kind: 'ops-incident', source: 'ae.ops', detailType: 'Incident updated' };
const event = (over: Record<string, unknown> = {}) => ({ rule: 'abcdef012345', at: AT, source: 'ae.ops', detailType: 'Incident updated', resource: '', key: 'INC-1', ...over });

describe('the router verifies the event before anything runs', () => {
  it('starts nothing on a malformed event or a key that is not an id', async () => {
    expect(await handleWatchEvent(event({ rule: 'nope' }))).toEqual({ ran: false, reason: 'malformed' });
    expect(await handleWatchEvent(event({ at: 'never' }))).toEqual({ ran: false, reason: 'malformed' });
    for (const key of [{ id: 'x' }, ['x'], null, '', 'a b']) {
      expect(await handleWatchEvent(event({ key }), { binding: async () => BINDING })).toEqual({ ran: false, reason: 'the event names no key' });
    }
  });

  it('starts nothing for a rule that is not this classification\'s watch rule, or an event of another type', async () => {
    expect(await handleWatchEvent(event(), { binding: async () => null })).toEqual({ ran: false, reason: 'not a watch rule of this classification' });
    expect(await handleWatchEvent(event({ source: 'ae.other' }), { binding: async () => BINDING })).toEqual({ ran: false, reason: 'the event is not the rule\'s event type' });
    expect(await handleWatchEvent(event({ detailType: 'Incident opened' }), { binding: async () => BINDING })).toEqual({ ran: false, reason: 'the event is not the rule\'s event type' });
  });

  it('starts nothing for a key no conversation here watches, or a conversation whose row does not list it', async () => {
    expect(await handleWatchEvent(event(), { binding: async () => BINDING, watchOf: async () => null })).toEqual({ ran: false, reason: 'no conversation watches the key' });
    expect(await handleWatchEvent(event(), { binding: async () => BINDING, watchOf: async () => ({ room: ROOM, classification: 'another' }) }))
      .toEqual({ ran: false, reason: 'no conversation watches the key' });
    expect(await handleWatchEvent(event(), { binding: async () => BINDING, watchOf: async () => ({ room: ROOM, classification: '' }), watches: async () => false }))
      .toEqual({ ran: false, reason: 'the conversation does not watch the key' });
  });

  it('checks the rule, the event type, both records, the room, the workflow, the policy and the age, in that order, before the run', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleWatchEvent('), router.indexOf('export async function handleDeadlineCancel('));
    const order = [
      'TRIGGER_RULE_ID.test(rule)', '(deps.binding ?? watchBindingOf)(rule, source)', 'source !== binding.source', 'refId(r.key)',
      '(deps.watchOf ?? refWatchOf)(refWatchKey(STATIC_CLASSIFICATION, binding.kind, key!), { strict: true })', '(deps.watches ?? conversationWatchesRef)(channelArn, binding.kind, key!, binding.type, watch)',
      "roomRefusal(roomTags, 'room')", 'eventWorkflowOwner(', 'workflowFor(served?.version.eventWorkflows, binding.workflow)',
      'wf.types?.includes(binding.type)', 'eventTypeAllowed(policy, source, detailType)', 'eventAgeRefusal(str(r.at), policy.maxEventAgeSeconds)', 'runWorkflowFor(',
    ].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // THE PAYLOAD NAMES THE RULE AND THE KEY: the workflow, the type and the room come from the rule's tags and the watch.
    expect(fn).not.toMatch(/r\.workflow|r\.channelArn|r\.type\b/);
  });

  it('reads a rule\'s binding only from its own classification\'s watch rules, and compares the classification tag', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function watchBindingOf('), router.indexOf('export async function conversationWatchesRef('));
    expect(fn).toContain('process.env.WATCH_RULE_ARN_PREFIX');
    expect(fn).toContain('tags[WATCH_TAG.classification] !== STATIC_CLASSIFICATION');
    const stack = read('lib/stacks/assistant-profile-stack.ts');
    expect(stack).toContain("sid: 'ReadOwnWatchRuleBindings', actions: ['events:ListTagsForResource']");
    expect(stack).toContain('twelveCharIds(eventWatchRulePrefix(classification))');
  });
});

describe('a record that cannot be read is never an answer', () => {
  const throttled = async () => { throw Object.assign(new Error('rate'), { name: 'ThrottlingException' }); };

  it('a binding, a watch or a row that cannot be read throws, so the event is delivered again', async () => {
    await expect(handleWatchEvent(event(), { binding: throttled })).rejects.toThrow('rate');
    await expect(handleWatchEvent(event(), { binding: async () => BINDING, watchOf: throttled })).rejects.toThrow('rate');
    await expect(handleWatchEvent(event(), { binding: async () => BINDING, watchOf: async () => ({ room: ROOM, classification: '' }), watches: throttled })).rejects.toThrow('rate');
  });

  it('a rule\'s binding is read once per rule, a failed read throws and is not remembered, and a rule that is gone is no rule', async () => {
    const prior = process.env.WATCH_RULE_ARN_PREFIX;
    process.env.WATCH_RULE_ARN_PREFIX = 'arn:aws:events:us-east-1:111122223333:rule/aepremium-watch-';
    const send = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
    try {
      send.mockRejectedValueOnce(Object.assign(new Error('rate'), { name: 'ThrottlingException' }));
      await expect(watchBindingOf('aaaaaaaaaaaa')).rejects.toThrow('rate');
      send.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'other' }] });
      expect(await watchBindingOf('aaaaaaaaaaaa')).toBeNull();
      expect(await watchBindingOf('aaaaaaaaaaaa')).toBeNull();
      expect(send).toHaveBeenCalledTimes(2);
      send.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }));
      expect(await watchBindingOf('bbbbbbbbbbbb')).toBeNull();
    } finally {
      send.mockRestore();
      process.env.WATCH_RULE_ARN_PREFIX = prior;
    }
  });
});

describe('an event\'s own time cannot open a window of its own', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const minute = 60_000;

  it('DENY: an event dated ahead of now starts nothing, and one inside the clock skew keys the window it arrived in', () => {
    expect(eventAgeRefusal(new Date(now + 15 * minute).toISOString(), 3600, now)).toBe('the event is dated in the future');
    expect(eventAgeRefusal(new Date(now + 30 * 1000).toISOString(), 3600, now)).toBeUndefined();
    expect(eventAgeRefusal(new Date(now - 2 * 3600 * 1000).toISOString(), 3600, now)).toBe('the event is older than the policy allows');
    const arrived = eventTriggerWindow(new Date(now).toISOString(), now);
    for (const ahead of [1, 15, 30, 60].map((m) => m * minute)) expect(eventTriggerWindow(new Date(now + ahead).toISOString(), now)).toBe(arrived);
    expect(eventTriggerWindow(new Date(now - EVENT_TRIGGER_WINDOW_MINUTES * minute).toISOString(), now)).toBe(arrived! - 1);
  });
});

describe('one run per rule, key and window, and a continuation checks again', () => {
  it('keys a watched run on the rule, the key and the window, apart from a team room\'s', () => {
    const watched = eventNaturalKey('event-received', ROOM, undefined, undefined, undefined, undefined, { rule: 'abcdef012345', window: 7, watch: { kind: 'ops-incident', key: 'INC-1' } });
    expect(watched).toMatch(/^watch-abcdef012345-[a-f0-9]{12}-7$/);
    expect(eventNaturalKey('event-received', ROOM, undefined, undefined, undefined, undefined, { rule: 'abcdef012345', window: 7, watch: { kind: 'ops-incident', key: 'INC-2' } })).not.toBe(watched);
    expect(eventNaturalKey('event-received', ROOM, undefined, undefined, undefined, undefined, { rule: 'abcdef012345', window: 7 })).toBe('rule-abcdef012345-7');
  });

  // A RUN ITS RULE STARTED FINISHES: the rule and the watch are read before a run starts; its
  // continuation does not read them again, so detaching a trigger stops new runs and an open one still reaches its end.
  it('lets a run its rule started finish, reading the rule and the watch only before it starts', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleEventContinuation('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/watchBindingOf\(|conversationWatchesRef\(|EVENT_RULE_TAG_PREFIX/);
    expect(body).toContain("if (wf.on === 'event-received' && !ruleEvent) return refuse('the run names no rule');");
  });
});

describe('the watch rule', () => {
  it('keeps every placeholder unquoted, so a value is written as the JSON value it is', () => {
    const input = watchTargetInput({ rule: 'abcdef012345', keyPath: '$.detail.incidentId' });
    expect(input.InputPathsMap.key).toBe('$.detail.incidentId');
    expect(input.InputTemplate).toContain('"key":<key>');
    expect(input.InputTemplate).not.toMatch(/"<[a-zA-Z]+>"/);
    expect(JSON.parse(input.InputTemplate.replace(/<[a-zA-Z]+>/g, 'null'))).toEqual({ aeWatchEvent: { rule: 'abcdef012345', at: null, source: null, detailType: null, resource: null, key: null } });
  });

  it('matches the deployment instance for a platform source, as the opener of the kind does, with the instance fixed at deploy', () => {
    const api = read('lambda/src/event-triggers-api.ts');
    expect(api).toContain('o.watches?.kind === kind && o.matchInstance');
    expect(api).toContain('p.detail = { ...(p.detail ?? {}), instance: [INSTANCE_NAME] };');
    expect(read('lib/stacks/admin-services-stack.ts')).toContain('AE_INSTANCE_NAME: INSTANCE_NAME,');
  });

  it('carries its binding in its tags and is named per classification', () => {
    expect(watchRuleName('AgentEchelon-', 'premium', 'abcdef012345')).toBe('AgentEchelon-premium-watch-abcdef012345');
    expect(Object.fromEntries(watchRuleTags({ classification: 'premium', workflow: 'w', typeKey: 'ops', kind: 'k', source: 's', detailType: 'd' }).map((t) => [t.Key, t.Value])))
      .toEqual({ classification: 'premium', workflow: 'w', 'conversation-type': 'ops', 'watch-kind': 'k', source: 's', 'detail-type': 'd' });
  });

  it('a policy saved before the per-type cap existed is still valid, and takes the dev cap', () => {
    const { maxWatchTriggersPerType: _cap, ...older } = DEV_EVENT_POLICY;
    expect(eventPolicyErrors(older)).toEqual([]);
    expect(eventPolicyOf(older).maxWatchTriggersPerType).toBe(DEV_EVENT_POLICY.maxWatchTriggersPerType);
    expect(eventPolicyErrors({ ...DEV_EVENT_POLICY, maxWatchTriggersPerType: -1 }).join()).toMatch(/maxWatchTriggersPerType/);
  });
});
