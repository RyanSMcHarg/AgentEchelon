/**
 * AN OWN-APP EVENT FROM ANOTHER PRINCIPAL IS REFUSED (WT84; DESIGN-EVENT-TARGETS 11.2 and 11.3, phase 7).
 *
 * The deployment's own application is a connector over a bus of its own. What this proves:
 *  - the bus allows `PutEvents` from the app's declared principal for its declared source, and denies every other principal and
 *    every other source, so a principal of this account whose IAM allows `events:PutEvents` on `*` is still refused there;
 *  - an app connector names its principal, and no other connector may;
 *  - the app adapter reads its declared schema: its people by the app's user id, and a conversation as a channel id only;
 *  - the receiver records whom it admitted and the conversation an app event named, and a consumer trusts a fact's person or
 *    conversation only where that record says the same;
 *  - DENY: the router takes a person or a named conversation from a connector fact only, only where the receiver's record
 *    agrees, and a named conversation only of the rule's type.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { appEventBus } from '../lib/stacks/connectors-stack';
import { ADAPTERS, UnreadableEvent } from '../lambda/src/lib/connectors/vendors';
import { connectorRecordConfirms } from '../lambda/src/lib/connector-fact-record';
import { CONVERSATION_TYPES } from '../lib/config/conversation-types';
import { handleWatchEvent } from '../lambda/src/router-agent-handler';

jest.mock('../lambda/src/lib/event-policy', () => {
  const actual = jest.requireActual('../lambda/src/lib/event-policy');
  return { ...actual, readEventPolicy: async () => ({ ...actual.DEV_EVENT_POLICY, allowedEventTypes: [...actual.DEV_EVENT_POLICY.allowedEventTypes, { source: 'ae.connector', detailType: 'app.order.shipped' }] }) };
});

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
const APP = 'arn:aws:iam::111122223333:role/shop-app';

describe('the app\'s own bus', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Connectors', { env: { account: '111122223333', region: 'us-east-1' } });
  appEventBus(stack, 'shop', 'ae.app.shop', APP);
  const policies = Template.fromStack(stack).findResources('AWS::Events::EventBusPolicy');
  const statements = Object.values(policies).map((p) => (p as { Properties: { Statement?: Record<string, unknown> } }).Properties.Statement ?? {});

  it('allows the app\'s principal to put its declared source', () => {
    expect(statements).toContainEqual(expect.objectContaining({ Sid: 'cdk-TheAppPutsItsOwnSource', Effect: 'Allow', Principal: { AWS: APP }, Action: 'events:PutEvents', Condition: { StringEquals: { 'events:source': ['ae.app.shop'] } } }));
  });

  it('DENY: every other principal, and every other source, whatever their own IAM allows', () => {
    expect(statements).toContainEqual(expect.objectContaining({ Sid: 'cdk-NoOtherPrincipalPuts', Effect: 'Deny', Principal: { AWS: '*' }, Action: 'events:PutEvents', Condition: { ArnNotEquals: { 'aws:PrincipalArn': APP } } }));
    expect(statements).toContainEqual(expect.objectContaining({ Sid: 'cdk-NoOtherSource', Effect: 'Deny', Principal: { AWS: '*' }, Action: 'events:PutEvents', Condition: { StringNotEquals: { 'events:source': ['ae.app.shop'] } } }));
  });
});

describe('an app connector\'s declaration', () => {
  it('DENY: an app connector that subscribes names its principal, and no other connector names one', () => {
    const src = read('lib/config/connectors.ts');
    expect(src).toMatch(/an app connector that subscribes names appPrincipal/);
    expect(src).toMatch(/appPrincipal is read only for an app connector that subscribes to events/);
  });
});

describe('the app adapter', () => {
  const event = (detail: Record<string, unknown>) => ({ id: 'env-1', source: 'ae.app.shop', 'detail-type': 'order.shipped', time: '2026-11-20T10:00:00Z', detail });

  it('reads its people by the app\'s user id, its record, and the conversation it names', () => {
    expect(ADAPTERS.app.read(event({ eventId: 'e-1', ref: { recordId: 'ORD-9' }, people: [{ role: 'customer', subject: 'u-42' }, { role: 'Bad Role', subject: 'x' }], conversation: 'conv-abc' })))
      .toEqual({ eventId: 'e-1', type: 'order.shipped', occurredAt: '2026-11-20T10:00:00Z', ref: { recordId: 'ORD-9' }, people: [{ role: 'customer', subject: 'u-42' }], conversation: 'conv-abc' });
  });

  it('DENY: a conversation that is not a channel id, or an event with no record, is unreadable', () => {
    expect(() => ADAPTERS.app.read(event({ eventId: 'e-1', ref: { recordId: 'ORD-9' }, conversation: 'arn:aws:chime:x/channel/y' }))).toThrow(UnreadableEvent);
    expect(() => ADAPTERS.app.read(event({ eventId: 'e-1' }))).toThrow(UnreadableEvent);
  });
});

describe('the receiver\'s record, and a consumer\'s check against it', () => {
  it('the receiver records whom it admitted, at which classification, and the conversation an app event named', () => {
    const ingest = read('lambda/src/connector-ingest.ts');
    expect(ingest).toMatch(/admittedPeople = :people, factClassification = :cls/);
    expect(ingest).toMatch(/namedConversation = :conv/);
  });

  const record = (over: Record<string, unknown> = {}) => ({ state: 'published', factClassification: 'premium', admittedPeople: ['p-1'], namedConversation: 'conv-abc', ...over });
  const deps = (rec: Record<string, unknown> | undefined) => ({ table: async () => 'replay', get: async () => rec });
  const fact = { connectorId: 'shop', eventId: 'e-1', classification: 'premium' };

  it('confirms the one person admitted, or the conversation named, by the published event at this classification', async () => {
    expect(await connectorRecordConfirms(fact, { person: 'p-1' }, deps(record()))).toBe(true);
    expect(await connectorRecordConfirms(fact, { conversation: 'conv-abc' }, deps(record()))).toBe(true);
  });

  it('DENY: anything else confirms nothing', async () => {
    expect(await connectorRecordConfirms(fact, { person: 'p-2' }, deps(record()))).toBe(false);
    expect(await connectorRecordConfirms(fact, { person: 'p-1' }, deps(record({ admittedPeople: ['p-1', 'p-3'] })))).toBe(false);
    expect(await connectorRecordConfirms(fact, { conversation: 'conv-other' }, deps(record()))).toBe(false);
    expect(await connectorRecordConfirms(fact, { person: 'p-1' }, deps(record({ state: 'claimed' })))).toBe(false);
    expect(await connectorRecordConfirms(fact, { person: 'p-1' }, deps(record({ factClassification: 'standard' })))).toBe(false);
    expect(await connectorRecordConfirms(fact, { person: 'p-1' }, deps(undefined))).toBe(false);
    expect(await connectorRecordConfirms(fact, { person: 'p-1' }, { table: async () => undefined })).toBe(false);
    expect(await connectorRecordConfirms(fact, {}, deps(record()))).toBe(false);
  });
});

describe('the router, for a person or a conversation a connector fact names', () => {
  const AT = new Date().toISOString();
  const ev = (fact: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ rule: 'abcdef012345', at: AT, source: 'ae.connector', detailType: 'app.order.shipped', resource: '', key: 'ORD-9', fact: { connectorId: 'shop', eventId: 'e-1', ...fact }, ...over });
  beforeAll(() => {
    (CONVERSATION_TYPES as Record<string, unknown>)['test-main'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'main:{person}' };
  });
  afterAll(() => { delete (CONVERSATION_TYPES as Record<string, unknown>)['test-main']; });
  const PERSON = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/p-1';

  it('opens the person\'s pattern conversation for them once the receiver\'s record agrees', async () => {
    const asked: unknown[][] = [];
    await handleWatchEvent(ev({ person: PERSON }), {
      binding: async () => ({ workflow: 'w', type: 'test-main', kind: 'pattern', source: 'ae.connector', detailType: 'app.order.shipped' }),
      confirms: async (_f, expect) => expect.person === 'p-1',
      roomTags: async () => null,
      patternRuns: async () => undefined, openPattern: async (...a) => { asked.push(a); return true; },
    });
    expect(asked).toEqual([['test-main', 'main:p-1', 25, PERSON, ev({ person: PERSON })]]);
  });

  it('DENY: a person the record does not show admitted alone, or from any other source, opens nothing', async () => {
    const open = jest.fn();
    const binding = { workflow: 'w', type: 'test-main', kind: 'pattern', source: 'ae.connector', detailType: 'app.order.shipped' };
    expect(await handleWatchEvent(ev({ person: PERSON }), { binding: async () => binding, confirms: async () => false, patternRuns: async () => undefined, openPattern: open }))
      .toEqual({ ran: false, reason: 'the receiver did not admit that person alone for the event' });
    expect(await handleWatchEvent(ev({ person: PERSON }, { source: 'ae.ops', detailType: 'Incident updated' }), { binding: async () => ({ ...binding, source: 'ae.ops', detailType: 'Incident updated' }), confirms: async () => true, patternRuns: async () => undefined, openPattern: open }))
      .toEqual({ ran: false, reason: 'a person is taken only from a connector fact' });
    expect(open).not.toHaveBeenCalled();
  });

  it('DENY: a named conversation the record does not show, or from any other source, is not run in', async () => {
    const binding = { workflow: 'w', type: 'ops', kind: 'named', source: 'ae.connector', detailType: 'app.order.shipped' };
    expect(await handleWatchEvent(ev({ conversation: 'conv-abc' }), { binding: async () => binding, confirms: async () => false }))
      .toEqual({ ran: false, reason: 'the receiver did not record that conversation for the event' });
    expect(await handleWatchEvent(ev({ conversation: '../x' }), { binding: async () => binding, confirms: async () => true }))
      .toEqual({ ran: false, reason: 'the event names no conversation' });
    expect(await handleWatchEvent(ev({ conversation: 'conv-abc' }, { source: 'ae.ops', detailType: 'Incident updated' }), { binding: async () => ({ ...binding, source: 'ae.ops', detailType: 'Incident updated' }), confirms: async () => true }))
      .toEqual({ ran: false, reason: 'a named conversation is taken only from a connector fact' });
  });

  it('DENY: the attach API takes a person or a named conversation only on a connector fact\'s trigger', () => {
    const api = read('lambda/src/event-triggers-api.ts');
    expect(api).toMatch(/if \(needsFact && p\.source\[0\] !== CONNECTOR_FACT_SOURCE\) \{/);
  });

  it('the router reads the receiver\'s record and nothing else of the receiver\'s', () => {
    const stack = read('lib/stacks/assistant-profile-stack.ts');
    expect(stack).toMatch(/sid: 'ReadTheConnectorReceiversRecord', actions: \['dynamodb:GetItem'\],/);
  });
});
