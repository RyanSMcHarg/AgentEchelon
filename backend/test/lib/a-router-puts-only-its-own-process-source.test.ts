/**
 * A ROUTER PUTS ONLY ITS OWN PROCESS SOURCE (SPEC-PROCESSES P4, P5; DESIGN-PROCESSES sections 4.1, 4.2, 5 and 12).
 *
 * What it proves: a `handoff` step puts one fixed-shape event, once however often its event is delivered, and the run goes on
 * by `onSuccess` when it is sent and `onFailure` when it is refused, its outcome recorded on the run; every value is checked
 * against its declared type before the put, so no free text and no value outside its type crosses; the step names a declared
 * hand-off and reads exactly its fields; the router puts through one seam, on the process event bus its stack names, and puts
 * nothing where none is named; its role is named by its classification and holds one put, on that bus, pinned to its own
 * classification's source; the bus's policy denies each classification's process source to every principal but that
 * classification's router role, named by its ARN and never by a tag, for every classification, denies every other source, and
 * denies rule and target writes to every principal but the trigger service's role; and no other role holds a put on the bus.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  HANDOFF_REFUSED, HANDOFF_SENT, eventWorkflowErrors, handoffDetail, runEventWorkflow, typedHandoffValue, versionProcessesErrors,
  type EventRunContext, type EventRunDeps, type EventWorkflow, type HandoffOutcome, type HandoffStep, type ProcessHandoff, type RunProcess,
} from '../../lambda/src/lib/event-workflow';
import { PROCESS_BUS_RULE_WRITES, STACK_PREFIX, createProcessEventBus, eventTriggersRoleName, processBusSenderPolicy, processEventBusName, routerRoleName } from '../../lib/stacks/agent-classification-common';
import { putHandoff } from '../../lambda/src/router-agent-handler';
import { adminServicesOnLiteralsTemplate, basicClassificationTemplate, identityStacks } from '../helpers/synth';

const channelArn = 'arn:aws:chime:us-east-1:1:app-instance/ai/channel/incident-1';
const declared: ProcessHandoff = {
  fields: {
    incident: { type: 'ref', store: 'incident-tool' },
    customerImpact: { type: 'enum', values: ['none', 'degraded', 'outage'] },
  },
};
const step: HandoffStep = { process: 'incident-response', name: 'customer-communication', fields: { incident: 'event:incidentRef', customerImpact: 'task:value:customerImpact' } };
const proc: RunProcess = { id: 'a1b2c3d4e5f6', name: 'incident-response', edition: '0123456789ab', ownerTeam: 'ops' };
const values = { incidentRef: 'INC-4410', 'task:value:customerImpact': 'degraded' };

describe('the detail is fixed, and every value is of its declared type before the put (P5)', () => {
  it('five keys, and fields holding exactly the declared names', () => {
    expect(handoffDetail({ step, declared, values, process: proc, instance: 'dev' })).toEqual({ detail: {
      instance: 'dev', processId: 'a1b2c3d4e5f6', process: 'incident-response', handoff: 'customer-communication',
      fields: { incident: { store: 'incident-tool', id: 'INC-4410' }, customerImpact: 'degraded' },
    } });
  });

  it.each([
    ['an enum value outside its values', { ...values, 'task:value:customerImpact': 'the site is down for everyone' }],
    ['a reference with spaces (free text)', { ...values, incidentRef: 'customer said they are angry' }],
    ['a missing value', { incidentRef: 'INC-4410' }],
  ])('DENY: refuses %s, naming the field and never the value', (_l, v) => {
    const out = handoffDetail({ step, declared, values: v, process: proc, instance: 'dev' });
    expect('refused' in out && out.refused).toMatch(/^the field \w+ is outside its declared type$/);
  });

  it('DENY: refuses a run of another process, an undeclared hand-off, a step that reads other fields, and no instance', () => {
    expect(handoffDetail({ step, declared, values, process: { ...proc, name: 'other' }, instance: 'dev' })).toHaveProperty('refused');
    expect(handoffDetail({ step, declared, values, process: undefined, instance: 'dev' })).toHaveProperty('refused');
    expect(handoffDetail({ step, declared: undefined, values, process: proc, instance: 'dev' })).toHaveProperty('refused');
    expect(handoffDetail({ step: { ...step, fields: { ...step.fields, note: 'event:note' } }, declared, values: { ...values, note: 'x' }, process: proc, instance: 'dev' })).toHaveProperty('refused');
    expect(handoffDetail({ step, declared, values, process: proc, instance: '' })).toHaveProperty('refused');
  });

  it('each type', () => {
    expect(typedHandoffValue('2026-11-16T10:00:00Z', { type: 'time' })).toBe('2026-11-16T10:00:00Z');
    expect(typedHandoffValue('next tuesday', { type: 'time' })).toBeUndefined();
    expect(typedHandoffValue('3', { type: 'number' })).toBe(3);
    expect(typedHandoffValue('three', { type: 'number' })).toBeUndefined();
    expect(typedHandoffValue('true', { type: 'boolean' })).toBe(true);
    expect(typedHandoffValue('yes', { type: 'boolean' })).toBeUndefined();
    expect(typedHandoffValue({ store: 'crm', id: 'X-1' }, { type: 'ref', store: 'incident-tool' })).toBeUndefined();
  });
});

describe('the step runs once and goes on by its outcome (P4)', () => {
  const WF = {
    on: 'event-received', types: ['ops'], initial: 'hand',
    states: {
      hand: { handoff: step, onSuccess: 'ok', onFailure: 'told' },
      ok: { disposition: 'success' },
      told: { disposition: 'failure' },
    },
  } as unknown as EventWorkflow;
  const ctx: EventRunContext = { event: 'event-received', channelArn, values, process: proc };
  const harness = (outcome: HandoffOutcome) => {
    const taken = new Map<string, string>();
    const puts: string[] = [];
    const d: EventRunDeps = {
      claimRun: async () => true,
      claimStep: async (s, o) => { if (taken.has(s)) return false; taken.set(s, o); return true; },
      mentionName: async () => '', send: async () => true, dispatchAgent: async () => true,
      handoff: async (s) => { puts.push(s); return outcome; },
    };
    return { d, puts };
  };

  it('sent: onSuccess, its outcome recorded', async () => {
    const { d, puts } = harness(HANDOFF_SENT);
    const out = await runEventWorkflow('incident', WF, ctx, d);
    expect(out.steps[0]).toEqual({ step: 'hand', outcome: 'sent' });
    expect(out.ended).toBe('success');
    expect(puts).toEqual(['hand']);
  });

  it('refused: onFailure, its outcome recorded', async () => {
    const { d } = harness(HANDOFF_REFUSED);
    const out = await runEventWorkflow('incident', WF, ctx, d);
    expect(out.steps[0]).toEqual({ step: 'hand', outcome: 'refused' });
    expect(out.ended).toBe('failure');
  });

  it('once, however often the event is delivered', async () => {
    const { d, puts } = harness(HANDOFF_SENT);
    await runEventWorkflow('incident', WF, ctx, d);
    await runEventWorkflow('incident', WF, ctx, d);
    expect(puts).toEqual(['hand']);
  });

  it('DENY: with no put wired, the step takes its failure edge', async () => {
    const { d } = harness(HANDOFF_SENT);
    const out = await runEventWorkflow('incident', WF, ctx, { ...d, handoff: undefined });
    expect(out.steps[0]).toEqual({ step: 'hand', outcome: 'not-dispatched' });
    expect(out.ended).toBe('failure');
  });

  it('declared as { process, name, fields }, each read from the run\'s values', () => {
    expect(eventWorkflowErrors('incident', WF)).toEqual([]);
    const bad = { ...WF, states: { ...WF.states, hand: { handoff: { ...step, fields: { incident: 'free text' } }, onSuccess: 'ok', onFailure: 'told' } } };
    expect(eventWorkflowErrors('incident', bad).join('\n')).toMatch(/reads a value of the run/);
  });

  it('DENY: names a hand-off its workflow\'s process declares, and reads exactly its fields', () => {
    const processes = { 'incident-response': { label: 'Incident response', workflows: ['incident'], handoffs: { 'customer-communication': declared } } };
    const opts = { connectors: ['incident-tool'] };
    expect(versionProcessesErrors(processes, { incident: WF }, undefined, opts)).toEqual([]);
    const other = { incident: { ...WF, states: { ...WF.states, hand: { handoff: { ...step, name: 'nope' }, onSuccess: 'ok', onFailure: 'told' } } } };
    expect(versionProcessesErrors(processes, other, undefined, opts)).toEqual(['eventWorkflows.incident.states.hand.handoff: HANDOFF_UNDECLARED']);
    const extra = { incident: { ...WF, states: { ...WF.states, hand: { handoff: { ...step, fields: { ...step.fields, note: 'event:note' } }, onSuccess: 'ok', onFailure: 'told' } } } };
    expect(versionProcessesErrors(processes, extra, undefined, opts)).toEqual(['eventWorkflows.incident.states.hand.handoff: HANDOFF_UNDECLARED']);
    // A version that declares no process declares no hand-off.
    expect(versionProcessesErrors(undefined, { incident: WF })).toEqual(['eventWorkflows.incident.states.hand.handoff: HANDOFF_UNDECLARED']);
  });
});

const statementsOf = (t: Template, type: string) =>
  Object.values(t.findResources(type)).flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
const PROCESS_BUS_ARN = `arn:aws:events:us-east-1:123456789012:event-bus/${processEventBusName()}`;
const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));

describe('the router puts through one seam, on the process event bus (P4)', () => {
  const prior = process.env.PROCESS_EVENT_BUS;
  afterEach(() => { if (prior === undefined) delete process.env.PROCESS_EVENT_BUS; else process.env.PROCESS_EVENT_BUS = prior; });
  const ctx: EventRunContext = { event: 'event-received', channelArn, values, process: proc };
  const who = { version: { processes: { 'incident-response': { label: 'Incident response', workflows: ['incident'], handoffs: { 'customer-communication': declared } } } } } as never;
  process.env.ALERT_INSTANCE = process.env.ALERT_INSTANCE || 'dev';

  it('DENY: with no process event bus named, nothing is put and the step is refused', async () => {
    delete process.env.PROCESS_EVENT_BUS;
    const send = jest.fn();
    expect(await putHandoff(step, ctx, who, 'hand', { send } as never)).toBe(HANDOFF_REFUSED);
    expect(send).not.toHaveBeenCalled();
  });

  it('puts one entry on the named bus, on its own classification\'s source, the detail of declared fields only', async () => {
    process.env.PROCESS_EVENT_BUS = processEventBusName();
    const send = jest.fn(async () => ({ FailedEntryCount: 0 }));
    expect(await putHandoff(step, ctx, who, 'hand', { send } as never)).toBe(HANDOFF_SENT);
    const [entry] = (send.mock.calls[0] as unknown as [{ input: { Entries: Array<Record<string, string>> } }])[0].input.Entries;
    expect(entry.EventBusName).toBe(processEventBusName());
    expect(entry.Source).toBe(`ae.process.${process.env.CLASSIFICATION || ''}`);
    expect(entry.DetailType).toBe('incident-response.customer-communication');
    expect(Object.keys(JSON.parse(entry.Detail).fields).sort()).toEqual(['customerImpact', 'incident']);
  });

  it('DENY: a value outside its type is refused before any put', async () => {
    process.env.PROCESS_EVENT_BUS = processEventBusName();
    const send = jest.fn();
    expect(await putHandoff(step, { ...ctx, values: { ...values, 'task:value:customerImpact': 'free text' } }, who, 'hand', { send } as never)).toBe(HANDOFF_REFUSED);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the router\'s role holds one put, on its own source on the process bus (synth, layer two)', () => {
  const t = basicClassificationTemplate();
  const [roleId, role] = Object.entries(t.findResources('AWS::IAM::Role')).find(([id]) => id.startsWith('AgentHandlerRole')) as [string, any];

  it('is named by its classification, so the bus policy can name it', () => {
    expect(role.Properties.RoleName).toBe(routerRoleName('basic'));
    expect(routerRoleName('basic')).toBe(`${STACK_PREFIX}-router-basic`);
  });

  it('one statement: PutEvents on the process bus only, the source pinned exactly, on a policy the router role holds', () => {
    const managed = Object.values(t.findResources('AWS::IAM::ManagedPolicy'))
      .filter((p: any) => (p.Properties.Roles ?? []).some((r: any) => r.Ref === roleId))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    const puts = managed.filter((s) => s.Sid === 'PutOnlyItsOwnProcessSource');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ Effect: 'Allow', Action: 'events:PutEvents', Resource: PROCESS_BUS_ARN, Condition: { StringEquals: { 'events:source': ['ae.process.basic'] } } });
  });

  it('DENY: no statement of the stack puts another classification\'s process source, or any wildcard of one', () => {
    const all = [...statementsOf(t, 'AWS::IAM::Policy'), ...statementsOf(t, 'AWS::IAM::ManagedPolicy')];
    const sources = all.flatMap((s: any) => [s.Condition?.StringEquals?.['events:source']].flat()).filter((x): x is string => typeof x === 'string');
    expect(sources.filter((x) => x.startsWith('ae.process.'))).toEqual(['ae.process.basic']);
    expect(JSON.stringify(all)).not.toMatch(/ae\.process\.\*/);
  });

  it('the router names the bus by env, reads a hand-off\'s watch rule on it, and its relay admits the bus\'s rules of this classification only', () => {
    const fns = t.findResources('AWS::Lambda::Function');
    const router = Object.values(fns).find((f: any) => f.Properties.Environment?.Variables?.WATCH_RULE_ARN_PREFIX) as any;
    expect(router.Properties.Environment.Variables.PROCESS_EVENT_BUS).toBe(processEventBusName());
    const perms = Object.values(t.findResources('AWS::Lambda::Permission')).map((p: any) => JSON.stringify(p.Properties.SourceArn ?? ''));
    expect(perms.filter((a) => a.includes(`rule/${processEventBusName()}/`))).toEqual([
      JSON.stringify(`arn:aws:events:us-east-1:123456789012:rule/${processEventBusName()}/${STACK_PREFIX}-basic-trigger-*`),
      JSON.stringify(`arn:aws:events:us-east-1:123456789012:rule/${processEventBusName()}/${STACK_PREFIX}-basic-watch-*`),
    ]);
  });

  it('the router puts only that source, through the one bus seam', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/EventBusName: bus, Source: processSource\(STATIC_CLASSIFICATION\), DetailType: handoffDetailType\(def\.process, def\.name\)/);
    expect(router.match(/new PutEventsCommand\(/g)).toHaveLength(1);
  });
});

describe('the process event bus admits each process source from its router\'s role alone (synth, layer one)', () => {
  const CLASSIFICATIONS = ['basic', 'standard', 'premium', 'customer'];
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const stack = new cdk.Stack(app, 'Bus', { env });
  createProcessEventBus(stack);
  const t = Template.fromStack(stack);
  const statements = Object.values(t.findResources('AWS::Events::EventBusPolicy')).map((p: any) => p.Properties.Statement);
  // EACH CLASSIFICATION'S PIN IS ITS OWN STACK'S, so adding or removing one changes nothing in the bus's stack.
  const pins = Object.fromEntries(CLASSIFICATIONS.map((c) => {
    const own = new cdk.Stack(new cdk.App(), `Assistants-${c}`, { env });
    processBusSenderPolicy(own, c);
    return [c, Object.values(Template.fromStack(own).findResources('AWS::Events::EventBusPolicy')).map((p: any) => p.Properties)];
  }));
  const all = [...statements, ...Object.values(pins).flat().map((p: any) => p.Statement)];

  it('is the instance\'s own bus, and its own policy names no classification and only denies', () => {
    expect(Object.values(t.findResources('AWS::Events::EventBus')).map((b: any) => b.Properties.Name)).toEqual([processEventBusName()]);
    expect(statements).toHaveLength(2);
    for (const c of CLASSIFICATIONS) expect(JSON.stringify(statements)).not.toContain(routerRoleName(c));
    for (const s of all) {
      expect(s.Effect).toBe('Deny');
      expect([{ AWS: '*' }, '*']).toContainEqual(s.Principal);
    }
  });

  it.each(CLASSIFICATIONS)('DENY: ae.process.%s is denied to every principal but that classification\'s router role ARN, by its own stack', (c) => {
    expect(pins[c]).toHaveLength(1);
    const [p] = pins[c] as any[];
    expect(p.EventBusName).toBe(processEventBusName());
    expect(p.Statement.Action).toBe('events:PutEvents');
    expect(p.Statement.Condition).toEqual({
      StringEquals: { 'events:source': `ae.process.${c}` },
      ArnNotEquals: { 'aws:PrincipalArn': `arn:aws:iam::123456789012:role/${routerRoleName(c)}` },
    });
    for (const other of CLASSIFICATIONS.filter((x) => x !== c)) expect(JSON.stringify(p)).not.toContain(routerRoleName(other));
  });

  it('DENY: every source that is not a process source is denied to all', () => {
    const s = statements.find((x) => x.Sid === 'cdk-NoOtherSource');
    expect(s).toMatchObject({ Action: 'events:PutEvents', Condition: { StringNotLike: { 'events:source': 'ae.process.*' } } });
  });

  it('DENY: rule and target writes on the bus\'s rules are denied to every principal but the trigger service\'s role ARN', () => {
    const s = statements.find((x) => x.Sid === 'cdk-OnlyTheTriggerServiceSubscribes');
    expect(list(s.Action).sort()).toEqual([...PROCESS_BUS_RULE_WRITES].sort());
    expect(s.Resource).toBe(`arn:aws:events:us-east-1:123456789012:rule/${processEventBusName()}/*`);
    expect(s.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': `arn:aws:iam::123456789012:role/${eventTriggersRoleName()}` } });
  });

  it('DENY: the pins are by role ARN, never by a tag a person\'s exchanged credentials could carry', () => {
    const conditions = JSON.stringify(all.map((s) => s.Condition));
    expect(conditions).not.toMatch(/aws:PrincipalTag|aws:ResourceTag|aws:RequestTag|ArnLike/);
  });

  it('is held by the Messaging stack, and each classification\'s stack adds its own pin', () => {
    const messaging = readFileSync(resolve(__dirname, '../../lib/stacks/messaging-stack.ts'), 'utf8');
    expect(messaging).toMatch(/createProcessEventBus\(this\);/);
    const assistants = readFileSync(resolve(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    expect(assistants).toMatch(/processBusSenderPolicy\(this, classification\);/);
  });

  it('DENY: a role name past IAM\'s 64 characters is refused at synth', () => {
    expect(() => routerRoleName('x'.repeat(64))).toThrow(/64 characters/);
  });
});

describe('no other role holds a put on the process bus, and only the trigger service writes its rules (synth)', () => {
  const putsOnBus = (t: Template) => [...statementsOf(t, 'AWS::IAM::Policy'), ...statementsOf(t, 'AWS::IAM::ManagedPolicy')]
    .filter((s: any) => s.Effect === 'Allow' && list(s.Action).some((a) => a === 'events:PutEvents' || a === 'events:*' || a === '*')
      && list(s.Resource).some((r) => r === '*' || r.includes(`event-bus/${processEventBusName()}`) || r.endsWith('event-bus/*')));

  it('DENY: in the classification stack, only the router\'s own put', () => {
    expect(putsOnBus(basicClassificationTemplate()).map((s: any) => s.Sid)).toEqual(['PutOnlyItsOwnProcessSource']);
  });

  it('DENY: in AdminServices and Messaging, none', () => {
    expect(putsOnBus(adminServicesOnLiteralsTemplate())).toEqual([]);
    expect(putsOnBus(Template.fromStack(identityStacks().messaging))).toEqual([]);
  });

  it('the trigger service\'s role is named, and its rule writes reach the bus\'s rules of this instance only, targeting only a relay', () => {
    const t = adminServicesOnLiteralsTemplate();
    const roles = Object.values(t.findResources('AWS::IAM::Role')).map((r: any) => r.Properties.RoleName).filter(Boolean);
    expect(roles).toContain(eventTriggersRoleName());
    const all = statementsOf(t, 'AWS::IAM::Policy');
    const write = all.find((s: any) => s.Sid === 'WriteOnlyTriggerRules');
    expect(list(write.Resource)).toEqual(expect.arrayContaining([
      `arn:aws:events:us-east-1:123456789012:rule/${processEventBusName()}/${STACK_PREFIX}-*-trigger-*`,
      `arn:aws:events:us-east-1:123456789012:rule/${processEventBusName()}/${STACK_PREFIX}-*-watch-*`,
    ]));
    const target = all.find((s: any) => s.Sid === 'TargetOnlyARelay');
    expect(list(target.Resource)).toEqual(list(write.Resource));
    expect(JSON.stringify(target.Condition)).toMatch(/EventTriggerRelay/);
  });
});
