/**
 * A HAND-OFF IS REFUSED WHEN ITS FIELDS CHANGE (SPEC-PROCESSES P5 to P7; DESIGN-PROCESSES sections 4.2, 4.3 and 12), unit and deny.
 *
 * What it proves:
 *  - a received hand-off starts no run unless its source and `detail-type` are the ones attached, the `detail-type` agrees with
 *    its detail, its process id is a process id, and its fields are exactly the declaration recorded at attach, each of its
 *    recorded type, so a declaration changed since attach is refused until the receiving team attaches again;
 *  - an event on a process source whose rule records no hand-off starts nothing, wherever it arrives;
 *  - the rule matches the exact sending source and `detail-type` on this instance and hands on only the process, the hand-off
 *    and the fields, with the declaration as it stood at attach;
 *  - the trigger form's Hand-off source lists what the active versions declare, and an attach reads the declaration from them,
 *    never from the request; a process source is attached only as a hand-off; the `process` kind is attached only as one;
 *  - the three targets: the team conversation (a new conversation), a conversation per process (a type whose pattern is
 *    `process:{key}`, keyed by the process id the trigger service fixes, opened for the type's one-holder lead role), and the
 *    conversation watching the process, keyed by the process and its id, so a hand-off of another process reaches none;
 *  - every hand-off rule is written on the process event bus, through one seam, and none is written where no bus is named; the
 *    router reads a hand-off's watch rule on that bus.
 */
const mockRequireAdmin = jest.fn();
const mockChimeSend = jest.fn();
const HANDOFF_TYPE = { source: 'ae.process.standard', detailType: 'customer-request.security-review' };
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a) }));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeMessagingClient: () => ({ send: (...a: unknown[]) => mockChimeSend(...a) }) }));
// THE DEPLOYMENT'S POLICY, as a deployment that allowed the hand-off's event type reads it.
jest.mock('../../lambda/src/lib/event-policy', () => {
  const actual = jest.requireActual('../../lambda/src/lib/event-policy');
  return { ...actual, readEventPolicy: async () => ({ ...actual.DEV_EVENT_POLICY, allowedEventTypes: [...actual.DEV_EVENT_POLICY.allowedEventTypes, { source: 'ae.process.standard', detailType: 'customer-request.security-review' }] }) };
});
// THE DEPLOYMENT'S ASSISTANTS: two at standard, which both may declare processes.
jest.mock('../../lib/profile-registry', () => {
  const actual = jest.requireActual('../../lib/profile-registry');
  const classes: Record<string, string> = { accounts: 'standard', security: 'premium', 'accounts-two': 'standard' };
  const registry = new Proxy(actual.defaultProfileRegistry, {
    get(target, p) {
      if (p === 'profileNames') return () => Object.keys(classes);
      if (p === 'classificationOfAssistant') return (n: string) => classes[n];
      const v = Reflect.get(target, p);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...actual, loadProfileRegistry: jest.fn(async () => registry), defaultProfileRegistry: registry };
});

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import { receivedHandoffRefusal, receivedHandoffValues, type AttachedHandoff } from '../../lambda/src/lib/event-workflow';
import { attachedHandoffOf, handoffPattern, triggerTargetInput, watchTargetInput } from '../../lambda/src/lib/event-triggers';
import { handleWatchEvent, receivedHandoff, watchBindingOf } from '../../lambda/src/router-agent-handler';
import { CONVERSATION_TYPES, PROCESS_CONVERSATION_PATTERN, conversationPatternErrors } from '../../lib/config/conversation-types';

const DECLARED = { accountId: { type: 'id' }, dueBy: { type: 'time' }, ticket: { type: 'ref', store: 'crm' } } as const;
const attached: AttachedHandoff = attachedHandoffOf('standard', 'customer-request', 'security-review', DECLARED as never);
const PROCESS_ID = 'a1b2c3d4e5f6';
const good = {
  source: HANDOFF_TYPE.source, detailType: HANDOFF_TYPE.detailType,
  processId: PROCESS_ID, process: 'customer-request', handoff: 'security-review',
  fields: { accountId: 'acct-1042', dueBy: '2026-11-21T12:00:00Z', ticket: { store: 'crm', id: 'T-88213' } },
};

describe('the receiving check, before any run (P6, P7)', () => {
  it('admits the attached hand-off, its fields as values and a reference by its id', () => {
    expect(receivedHandoffRefusal(attached, good)).toBeUndefined();
    expect(receivedHandoffValues(good.fields, attached)).toEqual({ accountId: 'acct-1042', dueBy: '2026-11-21T12:00:00Z', ticket: 'T-88213' });
  });

  it.each([
    ['another classification\'s source', { source: 'ae.process.basic' }],
    ['a detail-type that disagrees with its detail', { process: 'other-process' }],
    ['a hand-off name that disagrees with the detail-type', { handoff: 'another-review' }],
    ['a process id that is not a hash', { processId: 'not-a-hash' }],
    ['a field the declaration added since attach', { fields: { ...good.fields, note: 'free text' } }],
    ['a field the declaration dropped since attach', { fields: { accountId: 'acct-1042', dueBy: good.fields.dueBy } }],
    ['a field whose type changed', { fields: { ...good.fields, dueBy: 'tomorrow' } }],
    ['a reference to another store', { fields: { ...good.fields, ticket: { store: 'erp', id: 'T-88213' } } }],
    ['an id carrying prose', { fields: { ...good.fields, accountId: 'the customer is angry' } }],
  ])('DENY: %s starts no run', (_l, over) => {
    expect(receivedHandoffRefusal(attached, { ...good, ...over })).toBeDefined();
  });

  it('the router takes the process id from the event, names the hand-off it received, and never an edition', () => {
    expect(receivedHandoff({ attached, ...good }, good.source, good.detailType)).toEqual({
      process: { id: PROCESS_ID, name: 'customer-request', received: 'customer-request.security-review' },
      values: { accountId: 'acct-1042', dueBy: '2026-11-21T12:00:00Z', ticket: 'T-88213' },
    });
  });

  it('DENY: a rule that records no hand-off is refused on a process source, and is no hand-off on any other', () => {
    expect(receivedHandoff(undefined, good.source, good.detailType)).toEqual({ refused: 'the rule records no hand-off' });
    expect(receivedHandoff({}, good.source, good.detailType)).toEqual({ refused: 'the rule records no hand-off' });
    expect(receivedHandoff(undefined, 'aws.cloudwatch', 'CloudWatch Alarm State Change')).toBeUndefined();
  });

  it('a team conversation\'s rule checks it after the policy and before the room\'s open work or any run', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('export async function handleRuleEvent('), router.indexOf('type WatchBinding'));
    const check = fn.indexOf('receivedHandoff(r.handoff, source, detailType)');
    expect(check).toBeGreaterThan(fn.indexOf('eventAgeRefusal('));
    expect(check).toBeLessThan(fn.indexOf('openIncidents('));
    expect(check).toBeLessThan(fn.indexOf('runWorkflowFor('));
  });
});

describe('the rule the trigger service writes (P6; O4)', () => {
  it('matches the exact sending source and detail-type on this instance, never a prefix', () => {
    expect(handoffPattern('standard', 'customer-request', 'security-review', 'dev')).toEqual({
      source: ['ae.process.standard'], 'detail-type': ['customer-request.security-review'], detail: { instance: ['dev'] },
    });
  });

  it('hands on the process, the hand-off and the fields, and records the declaration as it stood at attach', () => {
    for (const input of [triggerTargetInput({ rule: 'abcdef012345', channelArn: 'arn:room', workflow: 'w', handoff: attached }), watchTargetInput({ rule: 'abcdef012345', keyPath: '$.detail.processId', handoff: attached })]) {
      expect(Object.values(input.InputPathsMap).filter((p) => p.startsWith('$.detail'))).toEqual(expect.arrayContaining(['$.detail.processId', '$.detail.process', '$.detail.handoff', '$.detail.fields']));
      expect(Object.values(input.InputPathsMap)).not.toContain('$.detail');
      expect(input.InputTemplate).toContain(JSON.stringify(attached));
    }
    expect(triggerTargetInput({ rule: 'abcdef012345', channelArn: 'arn:room', workflow: 'w' }).InputTemplate).not.toContain('handoff');
  });
});

// ── THE ROUTER, AT A WATCHED OR PATTERN TARGET ────────────────────────────────────────────────────────────────────

const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/channel/incident-1';
const watchEvent = (over: Record<string, unknown> = {}, handoff: Record<string, unknown> = {}) => ({
  rule: 'abcdef012345', at: new Date().toISOString(), source: good.source, detailType: good.detailType, resource: '', key: PROCESS_ID,
  handoff: { attached, processId: PROCESS_ID, process: good.process, handoff: good.handoff, fields: good.fields, ...handoff }, ...over,
});

describe('a hand-off answered to the conversation watching its process (P6)', () => {
  const binding = { workflow: 'review-answered', type: 'ops', kind: 'process', source: good.source, detailType: good.detailType };

  it('looks up the conversation by the process and its id, and lands only where that watch is held', async () => {
    const asked: string[] = [];
    const watchOf = async (k: string) => { asked.push(k); return k.endsWith(`#process#customer-request.${PROCESS_ID}`) ? { room: ROOM, classification: process.env.CLASSIFICATION || '' } : null; };
    await expect(handleWatchEvent(watchEvent(), { binding: async () => binding, watchOf, watches: async (room, kind, key) => { if (room === ROOM && kind === 'process' && key === `customer-request.${PROCESS_ID}`) throw new Error('reached'); return false; } }))
      .rejects.toThrow('reached');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(new RegExp(`#process#customer-request\\.${PROCESS_ID}$`));
  });

  it('DENY: another process\'s id reaches no conversation', async () => {
    const other = 'ffffffffffff';
    const out = await handleWatchEvent(watchEvent({ key: other }, { processId: other }), {
      binding: async () => binding, watchOf: async (k: string) => (k.endsWith(PROCESS_ID) ? { room: ROOM, classification: '' } : null),
    });
    expect(out).toEqual({ ran: false, reason: 'no conversation watches the key' });
  });

  it('DENY: a hand-off whose fields changed is refused before any lookup', async () => {
    let looked = false;
    const out = await handleWatchEvent(watchEvent({}, { fields: { ...good.fields, note: 'x' } }), { binding: async () => binding, watchOf: async () => { looked = true; return null; } });
    expect(out).toEqual({ ran: false, reason: 'the fields are not the attached declaration' });
    expect(looked).toBe(false);
  });

  it('DENY: a process-kind rule that records no hand-off reaches nothing', async () => {
    let looked = false;
    const { handoff: _h, ...bare } = watchEvent();
    const out = await handleWatchEvent(bare, { binding: async () => binding, watchOf: async () => { looked = true; return null; } });
    expect(out).toEqual({ ran: false, reason: 'the rule records no hand-off' });
    expect(looked).toBe(false);
  });

  it('DENY: an event on a process source at an ordinary watch rule that records no hand-off reaches nothing', async () => {
    const { handoff: _h, ...bare } = watchEvent();
    const out = await handleWatchEvent(bare, { binding: async () => ({ ...binding, kind: 'ops-incident' }), watchOf: async () => { throw new Error('looked'); } });
    expect(out).toEqual({ ran: false, reason: 'the rule records no hand-off' });
  });
});

describe('a hand-off to a conversation per process (DESIGN-PROCESSES section 12)', () => {
  const binding = { workflow: 'review-received', type: 'test-review', kind: 'pattern', source: good.source, detailType: good.detailType };
  beforeAll(() => {
    (CONVERSATION_TYPES as Record<string, unknown>)['test-review'] = { classifications: ['premium'], initiation: 'system', conversationPattern: PROCESS_CONVERSATION_PATTERN };
  });
  afterAll(() => { delete (CONVERSATION_TYPES as Record<string, unknown>)['test-review']; });

  it('asks the creator for the process\'s own conversation, with the event to hand back', async () => {
    const asked: unknown[][] = [];
    const ev = watchEvent();
    const out = await handleWatchEvent(ev, { binding: async () => binding, roomTags: async () => null, patternRuns: async () => undefined, openPattern: async (...a) => { asked.push(a); return true; } });
    expect(asked).toEqual([['test-review', `process:${PROCESS_ID}`, 25, undefined, ev]]);
    expect(out.reason).toBe('the pattern conversation is being opened; the event is handed back once it stands');
  });

  it('DENY: a hand-off whose fields changed creates nothing', async () => {
    const open = jest.fn();
    const out = await handleWatchEvent(watchEvent({}, { fields: { ...good.fields, dueBy: 'tomorrow' } }), { binding: async () => binding, roomTags: async () => null, patternRuns: async () => undefined, openPattern: open });
    expect(out).toEqual({ ran: false, reason: 'a field is not of its attached type' });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('the process watch kind is reserved (DESIGN-PROCESSES section 12)', () => {
  it('DENY: no opener may record it', () => {
    expect(conversationPatternErrors({ reserved: { initiation: 'system', openedBy: [{ watches: { kind: 'process' } }] } }).join('\n')).toMatch(/reserved\.openedBy records a .*"process" key/);
  });

  it('is claimed by the runner of a conversation a process opened, or a hand-off\'s conversation per process, never a team conversation', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/if \(proc && \(ctx\.event === 'conversation-opened' \|\| \(proc\.received && isPatternType\(held\.conversationType\)\)\)\) await watchProcess\(ctx\.channelArn, proc\);/);
  });
});

// ── THE TRIGGER SERVICE ─────────────────────────────────────────────────────────────────────────────────────────

const ebSend = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
const lambdaSend = jest.spyOn(LambdaClient.prototype, 'send') as unknown as jest.Mock;
const ssmSend = jest.spyOn(SSMClient.prototype, 'send') as unknown as jest.Mock;
let handler: (e: APIGatewayProxyEvent) => Promise<{ statusCode: number; body: string }>;
let definitions: Record<string, unknown> = {};
let copied = '';
const inputs = (name: string) => ebSend.mock.calls.filter(([c]) => (c as { constructor: { name: string } }).constructor.name === name).map(([c]) => (c as { input: Record<string, unknown> }).input);
const securityReview = { fields: DECLARED };
const withHandoffs = (handoffs: Record<string, unknown>) => ({ processes: { 'customer-request': { label: 'Customer request', workflows: ['account-desk'], handoffs } } });

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  process.env.EVENT_TRIGGER_RULE_PREFIX = 'ae-';
  process.env.EVENT_POLICY_PARAM = '/ae/event-policy';
  process.env.SSM_ROOT = '/ae';
  process.env.AE_INSTANCE_NAME = 'dev';
  process.env.PROCESS_EVENT_BUS = 'ae-process';
  process.env.TYPED_CREATOR_NAME_PATTERN = 'ae-{classification}-TypedConversationFromEvent';
  process.env.EVENT_TRIGGER_RELAY_NAME_PATTERN = 'ae-{classification}-Relay';
  const tags = jest.requireActual('../../lambda/src/lib/channel-classification');
  jest.spyOn(tags, 'readChannelTags').mockImplementation(async () => ({}));
  ({ handler } = await import('../../lambda/src/event-triggers-api'));
  (CONVERSATION_TYPES as Record<string, unknown>)['test-ticket-review'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'ticket:{key}' };
  (CONVERSATION_TYPES as Record<string, unknown>)['test-leaderless'] = { classifications: ['premium'], initiation: 'system', conversationPattern: PROCESS_CONVERSATION_PATTERN };
  (CONVERSATION_TYPES as Record<string, unknown>)['test-process-review'] = {
    classifications: ['premium'], initiation: 'system', conversationPattern: PROCESS_CONVERSATION_PATTERN,
    participants: { participantRoles: { 'lead:security': { from: [{ group: 'security-leads' }], holders: 'one' } } },
  };
});
afterAll(() => { for (const k of ['test-ticket-review', 'test-leaderless', 'test-process-review']) delete (CONVERSATION_TYPES as Record<string, unknown>)[k]; });

beforeEach(() => {
  jest.clearAllMocks();
  definitions = { accounts: withHandoffs({ 'security-review': securityReview }) };
  copied = '';
  mockChimeSend.mockResolvedValue({});
  mockRequireAdmin.mockResolvedValue({ claims: { actor: 'admin-1' } });
  ssmSend.mockImplementation(async (cmd: { input: { Name?: string } }) => {
    const m = /^\/ae\/assistant\/([^/]+)\/definition:active$/.exec(String(cmd.input.Name));
    if (m && definitions[m[1]]) return { Parameter: { Value: JSON.stringify(definitions[m[1]]) } };
    throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
  });
  lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: true })) });
  ebSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    switch (cmd.constructor.name) {
      case 'DescribeRuleCommand': return { Arn: `arn:aws:events:us-east-1:111122223333:rule/${String(cmd.input.Name)}`, EventPattern: copied || undefined };
      case 'ListTagsForResourceCommand': return { Tags: [] };
      case 'ListRulesCommand': return { Rules: [] };
      case 'ListTargetsByRuleCommand': return { Targets: [] };
      case 'PutRuleCommand': return { RuleArn: `arn:aws:events:us-east-1:111122223333:rule/${String(cmd.input.Name)}` };
      case 'PutTargetsCommand': return { FailedEntryCount: 0 };
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
});

const call = (typeKey: string, body: Record<string, unknown>) => handler({
  httpMethod: 'POST', resource: '/admin/event-triggers/{typeKey}/{classification}', headers: {},
  pathParameters: { typeKey, classification: 'premium' }, requestContext: { accountId: '111122223333' },
  body: JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);
const HANDOFF = { classification: 'standard', process: 'customer-request', name: 'security-review' };
const recordedInput = () => String((inputs('PutTargetsCommand')[0]?.Targets as Array<{ InputTransformer: { InputTemplate: string } }>)[0].InputTransformer.InputTemplate);

describe('the trigger form lists the declared hand-offs (P6)', () => {
  it('reads each assistant\'s active definition and keeps its processes\' hand-offs', async () => {
    const res = await handler({ httpMethod: 'GET', resource: '/admin/event-types', headers: {}, queryStringParameters: { handoffs: '1' } } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).handoffs).toEqual([{ assistant: 'accounts', classification: 'standard', process: 'customer-request', name: 'security-review', fields: DECLARED }]);
    const names = ssmSend.mock.calls.map(([c]) => (c as { input: { Name?: string } }).input.Name);
    expect(names.every((n) => /^\/ae\/assistant\/[^/]+\/definition:active$/.test(String(n)))).toBe(true);
  });

  it('DENY: a declaration with a field outside the closed types is not offered', async () => {
    definitions = { accounts: withHandoffs({ 'security-review': { fields: { note: { type: 'text' } } } }) };
    const res = await handler({ httpMethod: 'GET', resource: '/admin/event-types', headers: {}, queryStringParameters: { handoffs: '1' } } as unknown as APIGatewayProxyEvent);
    expect(JSON.parse(res.body).handoffs).toEqual([]);
  });
});

describe('attaching a hand-off to a new conversation (the team conversation)', () => {
  it('writes the exact pattern, and records the declaration read from the active version, never from the request', async () => {
    const res = await call('ops-team', { workflow: 'review-received', handoff: { ...HANDOFF, fields: { note: { type: 'text' } } } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(String(inputs('PutRuleCommand')[0].EventPattern))).toEqual({ source: ['ae.process.standard'], 'detail-type': ['customer-request.security-review'], detail: { instance: ['dev'] } });
    expect(recordedInput()).toContain(JSON.stringify(attachedHandoffOf('standard', 'customer-request', 'security-review', DECLARED as never)));
    expect(recordedInput()).not.toContain('"note"');
  });

  it('writes the rule and its target on the process event bus', async () => {
    expect((await call('ops-team', { workflow: 'review-received', handoff: HANDOFF })).statusCode).toBe(200);
    expect(inputs('PutRuleCommand')[0].EventBusName).toBe('ae-process');
    expect(inputs('PutTargetsCommand')[0].EventBusName).toBe('ae-process');
  });

  it('DENY: with no process event bus named, no hand-off is attached', async () => {
    delete process.env.PROCESS_EVENT_BUS;
    try {
      const res = await call('ops-team', { workflow: 'review-received', handoff: HANDOFF });
      expect([res.statusCode, JSON.parse(res.body).code]).toEqual([503, 'NO_PROCESS_BUS']);
      expect(inputs('PutRuleCommand')).toHaveLength(0);
    } finally { process.env.PROCESS_EVENT_BUS = 'ae-process'; }
  });

  it('an ordinary trigger stays on the default bus', async () => {
    copied = JSON.stringify({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'] });
    expect((await call('ops-team', { workflow: 'incident-triage', rule: 'an-alarm-rule' })).statusCode).toBe(200);
    expect(inputs('PutRuleCommand')[0].EventBusName).toBeUndefined();
  });

  it('DENY: a hand-off no active version declares is refused, and nothing is written', async () => {
    const res = await call('ops-team', { workflow: 'review-received', handoff: { ...HANDOFF, name: 'nobody-declares' } });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([404, 'NO_SUCH_HANDOFF']);
    expect(inputs('PutRuleCommand')).toHaveLength(0);
  });

  it('DENY: two assistants of the sending classification declaring the same hand-off is refused', async () => {
    definitions = { accounts: withHandoffs({ 'security-review': securityReview }), 'accounts-two': withHandoffs({ 'security-review': securityReview }) };
    const res = await call('ops-team', { workflow: 'review-received', handoff: HANDOFF });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([409, 'HANDOFF_AMBIGUOUS']);
  });

  it('DENY: a hand-off chosen with another event is refused', async () => {
    const res = await call('ops-team', { workflow: 'review-received', handoff: HANDOFF, rule: 'some-rule' });
    expect(res.statusCode).toBe(400);
    expect(inputs('PutRuleCommand')).toHaveLength(0);
  });

  it('DENY: a process source chosen as an AgentEchelon event, or copied from a rule, is refused: it is attached only as a hand-off', async () => {
    const asEvent = await call('ops-team', { workflow: 'review-received', platformEvent: HANDOFF_TYPE });
    expect(asEvent.statusCode).toBe(400);
    copied = JSON.stringify({ source: ['ae.process.standard'], 'detail-type': ['customer-request.security-review'] });
    const asRule = await call('ops-team', { workflow: 'review-received', rule: 'someone-elses-rule' });
    expect([asRule.statusCode, JSON.parse(asRule.body).code]).toEqual([400, 'HANDOFF_ONLY']);
    expect(inputs('PutRuleCommand')).toHaveLength(0);
  });

  it('DENY: a declaration larger than a rule\'s input can record is refused', async () => {
    const values = Array.from({ length: 32 }, (_v, i) => `value-${'x'.repeat(50)}-${i}`);
    const fields = Object.fromEntries(Array.from({ length: 16 }, (_v, i) => [`field${i}`, { type: 'enum', values }]));
    definitions = { accounts: withHandoffs({ 'security-review': { fields } }) };
    const res = await call('ops-team', { workflow: 'review-received', handoff: HANDOFF });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([409, 'HANDOFF_TOO_LARGE']);
    expect(inputs('PutRuleCommand')).toHaveLength(0);
  });
});

describe('attaching a hand-off to the conversation watching the process', () => {
  it('fixes the kind to process and the key path to the process id, whatever the request says', async () => {
    const res = await call('ops', { workflow: 'review-answered', target: 'watched', kind: 'ops-incident', keyPath: '$.detail.accountId', handoff: HANDOFF });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ kind: 'process', keyPath: '$.detail.processId' });
    expect(inputs('PutRuleCommand')[0].EventBusName).toBe('ae-process');
    expect(inputs('PutRuleCommand')[0].Tags).toEqual(expect.arrayContaining([{ Key: 'watch-kind', Value: 'process' }, { Key: 'source', Value: 'ae.process.standard' }]));
    expect(recordedInput()).toContain('"key":<key>');
    expect(recordedInput()).toContain('"attached":');
  });

  it('DENY: the process kind asked for without a hand-off is refused', async () => {
    const res = await call('ops', { workflow: 'review-answered', target: 'watched', kind: 'process', keyPath: '$.detail.processId', platformEvent: { source: 'ae.ops', detailType: 'Incident updated' } });
    expect(res.statusCode).toBe(400);
    expect(inputs('PutRuleCommand')).toHaveLength(0);
  });

  it('DENY: a hand-off to a conversation the event names is refused', async () => {
    const res = await call('ops', { workflow: 'review-answered', target: 'named', handoff: HANDOFF });
    expect(res.statusCode).toBe(400);
    expect(inputs('PutRuleCommand')).toHaveLength(0);
  });
});

describe('attaching a hand-off to a conversation per process', () => {
  it('a type whose pattern is process:{key}, keyed by the process id, with a one-holder lead role', async () => {
    const res = await call('test-process-review', { workflow: 'review-received', target: 'watched', keyPath: '$.detail.accountId', handoff: HANDOFF });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ kind: 'pattern', keyPath: '$.detail.processId' });
  });

  it('DENY: a type whose pattern is not one conversation per process is refused', async () => {
    const res = await call('test-ticket-review', { workflow: 'review-received', target: 'watched', handoff: HANDOFF });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([409, 'HANDOFF_PATTERN']);
  });

  it('DENY: a type with no one-holder role to open the conversation for is refused', async () => {
    const res = await call('test-leaderless', { workflow: 'review-received', target: 'watched', handoff: HANDOFF });
    expect([res.statusCode, JSON.parse(res.body).code]).toEqual([409, 'HANDOFF_NO_LEAD_ROLE']);
    expect(inputs('PutRuleCommand')).toHaveLength(0);
  });
});

describe('the router reads a hand-off\'s watch rule on the process event bus', () => {
  it('builds the rule ARN on the bus for a process source, and on the default bus for any other', async () => {
    process.env.WATCH_RULE_ARN_PREFIX = 'arn:aws:events:us-east-1:111122223333:rule/ae-premium-watch-';
    await watchBindingOf('aaaaaaaaaaa1', 'ae.process.standard');
    await watchBindingOf('aaaaaaaaaaa2', 'ae.ops');
    const arns = inputs('ListTagsForResourceCommand').map((i) => i.ResourceARN);
    expect(arns).toEqual([
      'arn:aws:events:us-east-1:111122223333:rule/ae-process/ae-premium-watch-aaaaaaaaaaa1',
      'arn:aws:events:us-east-1:111122223333:rule/ae-premium-watch-aaaaaaaaaaa2',
    ]);
  });

  it('DENY: with no process event bus named, a process source has no binding', async () => {
    delete process.env.PROCESS_EVENT_BUS;
    try {
      expect(await watchBindingOf('aaaaaaaaaaa3', 'ae.process.standard')).toBeNull();
      expect(inputs('ListTagsForResourceCommand')).toHaveLength(0);
    } finally { process.env.PROCESS_EVENT_BUS = 'ae-process'; }
  });
});
