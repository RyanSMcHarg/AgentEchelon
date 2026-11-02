/**
 * A VENDOR EVENT IS RECEIVED ONLY FROM ITS CONNECTOR'S PARTNER EVENT SOURCE, A REPLAY IS DROPPED, AND A
 * FAILED PUBLISH IS RETRIED RATHER THAN LOST (K5, PH-1).
 *
 * The receiver (`lambda/src/connector-ingest.ts`) as each connector's EventBridge rule invokes it, with its
 * stores faked. No live vendor is called: a real Salesforce Event Relay or PagerDuty EventBridge delivery is
 * NOT VERIFIED here; the deployed rule and receiver policy are checked by
 * `scripts/deny-test-connector-events.mjs`.
 *
 *  - an event from a source no subscribing connector declares is refused, as a second layer behind the
 *    rule, and writes nothing;
 *  - an event is accepted once, and the same vendor event again (a vendor resend under a new envelope id
 *    included) is dropped as a duplicate;
 *  - a publish that fails releases the claim and throws, so the retry is processed, not dropped;
 *  - a claim another invocation holds is retried, not dropped; one whose holder died is taken over;
 *  - a store that cannot answer throws, never accepts without a replay record.
 */
import { handleEvent, CLAIM_LEASE_SECONDS, REPLAY_WINDOW_SECONDS, IngestRetry, type IngestDeps } from '../../lambda/src/connector-ingest';
import type { PartnerEvent } from '../../lambda/src/lib/connectors/vendors';
import type { RuntimeConnector } from '../../lib/config/connectors';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const PD_SOURCE = 'aws.partner/pagerduty.com/example-oncall';
const SF_SOURCE = 'aws.partner/salesforce.com/00D000000000001AAA/0YL000000000001AAA';

const PD: RuntimeConnector = { id: 'pagerduty', vendor: 'pagerduty', capabilities: ['ingest', 'resolveParticipant'], subscribes: ['incident.trigger'], eventSource: PD_SOURCE, classification: 'standard', namespace: 'pagerduty' };
const SF: RuntimeConnector = { id: 'crm', vendor: 'salesforce', capabilities: ['ingest', 'resolveParticipant'], subscribes: ['LeadChangeEvent'], eventSource: SF_SOURCE, classification: 'standard', namespace: 'crm' };
const QUIET: RuntimeConnector = { id: 'quiet', vendor: 'pagerduty', capabilities: ['resolveParticipant'], subscribes: [], namespace: 'quiet' };
const PERSON = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/0192a000-0000-7000-8000-000000000001';

function pdEvent(over: { messageId?: string; envelopeId?: string; type?: string; createdOn?: string; source?: string } = {}): PartnerEvent {
  return {
    id: over.envelopeId ?? 'env-1',
    source: over.source ?? PD_SOURCE,
    'detail-type': 'PagerDuty Webhook',
    time: new Date(NOW).toISOString(),
    detail: {
      id: over.messageId ?? 'msg-1',
      event: over.type ?? 'incident.trigger',
      created_on: over.createdOn ?? new Date(NOW).toISOString(),
      incident: { id: 'Q1ABCDEF', html_url: 'https://example.invalid/i/1', assignments: [{ assignee: { id: 'PABC123', summary: 'Jane' } }] },
    },
  };
}

function sfEvent(uuid = 'uuid-1', envelopeId = 'env-sf-1'): PartnerEvent {
  return {
    id: envelopeId,
    source: SF_SOURCE,
    'detail-type': 'LeadChangeEvent',
    time: new Date(NOW).toISOString(),
    detail: {
      id: uuid,
      schemaId: 'schema-1',
      payload: { ChangeEventHeader: { entityName: 'Lead', changeType: 'UPDATE', recordIds: ['00Q000000000001AAA'], commitTimestamp: NOW }, OwnerId: '005000000000001AAA' },
    },
  };
}

type Item = { pk: string; state: string; claimedAt: number; ttl: number; publishedAt?: number };

/** The replay table, with the conditions the receiver writes under evaluated as DynamoDB would. */
function replayStore() {
  const items = new Map<string, Item>();
  const ccf = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
  const send = jest.fn(async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'PutCommand': {
        const old = items.get(input.Item.pk);
        const stale = input.ExpressionAttributeValues[':stale'];
        if (old && !(old.state === 'claimed' && old.claimedAt < stale)) throw ccf();
        items.set(input.Item.pk, { ...input.Item });
        return {};
      }
      case 'GetCommand':
        return { Item: items.get(input.Key.pk) };
      case 'UpdateCommand': {
        const old = items.get(input.Key.pk);
        if (old) items.set(input.Key.pk, { ...old, state: input.ExpressionAttributeValues[':published'], publishedAt: input.ExpressionAttributeValues[':at'] });
        return {};
      }
      case 'DeleteCommand': {
        const old = items.get(input.Key.pk);
        if (!old || old.state !== 'claimed' || old.claimedAt !== input.ExpressionAttributeValues[':mine']) throw ccf();
        items.delete(input.Key.pk);
        return {};
      }
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
  return { items, send };
}

function world(over: Partial<IngestDeps> = {}) {
  const store = replayStore();
  const published: Array<{ connectorId: string; eventId: string; admitted: unknown[]; notAdmitted: Record<string, number> }> = [];
  let now = NOW;
  const deps: IngestDeps = {
    connectors: [PD, SF, QUIET],
    doc: store,
    replayTable: 'Replay',
    instance: 'test',
    publish: jest.fn(async (d) => { published.push(d as never); }),
    participants: {
      resolve: async (ns, subject) => (ns === 'pagerduty' && subject === 'PABC123' ? PERSON : null),
      directory: { accountState: async () => 'active', clearanceOf: async () => ({ state: 'held', token: 'standard', held: ['standard'], groups: [], admin: false }) },
    },
    now: () => now,
    ...over,
  };
  return { deps, store, published, advance: (seconds: number) => { now += seconds * 1000; } };
}

describe('the source, a second layer behind the rule', () => {
  it('refuses an event from a source no subscribing connector declares, writing nothing', async () => {
    const { deps, store, published } = world();
    for (const source of ['aws.partner/pagerduty.com/someone-else', 'aws.events', 'aws.partner/salesforce.com/00D000000000002AAA/0YL000000000001AAA', '']) {
      expect(await handleEvent(pdEvent({ source }), deps)).toEqual({ outcome: 'foreign-source' });
    }
    expect(await handleEvent({ ...pdEvent(), source: undefined }, deps)).toEqual({ outcome: 'foreign-source' });
    expect(store.send).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('names the connector by the source, never by the detail', async () => {
    const { deps, published } = world();
    const event = pdEvent();
    (event.detail as Record<string, unknown>).connectorId = 'crm';
    expect((await handleEvent(event, deps)).outcome).toBe('accepted');
    expect(published[0].connectorId).toBe('pagerduty');
  });

  it('refuses a source a connector declares when that connector does not subscribe', async () => {
    const { deps, store } = world({ connectors: [{ ...QUIET, eventSource: PD_SOURCE }] });
    expect((await handleEvent(pdEvent(), deps)).outcome).toBe('foreign-source');
    expect(store.send).not.toHaveBeenCalled();
  });
});

describe('the replay record', () => {
  it('accepts an event once, and drops the same event again', async () => {
    const { deps, store, published } = world();
    expect(await handleEvent(pdEvent(), deps)).toEqual({ outcome: 'accepted', connectorId: 'pagerduty', eventId: 'msg-1' });
    expect(await handleEvent(pdEvent(), deps)).toEqual({ outcome: 'duplicate', connectorId: 'pagerduty', eventId: 'msg-1' });
    expect(published).toHaveLength(1);
    const item = store.items.get('pagerduty#msg-1')!;
    expect(item.state).toBe('published');
    expect(item.ttl - item.claimedAt).toBe(REPLAY_WINDOW_SECONDS);
  });

  it('keys on the vendor\'s own event id, so a vendor resend under a new envelope id is still a replay', async () => {
    const { deps, published } = world();
    expect((await handleEvent(sfEvent('uuid-1', 'env-a'), deps)).outcome).toBe('accepted');
    expect((await handleEvent(sfEvent('uuid-1', 'env-b'), deps)).outcome).toBe('duplicate');
    expect((await handleEvent(pdEvent({ envelopeId: 'env-x' }), deps)).outcome).toBe('accepted');
    expect((await handleEvent(pdEvent({ envelopeId: 'env-y' }), deps)).outcome).toBe('duplicate');
    expect(published).toHaveLength(2);
  });

  it('keys the replay record by connector, so one vendor id under two connectors is two events', async () => {
    const other = { ...PD, id: 'pagerduty-eu', namespace: 'pagerduty-eu', eventSource: 'aws.partner/pagerduty.com/example-eu' };
    const { deps, store } = world({ connectors: [PD, other] });
    expect((await handleEvent(pdEvent(), deps)).outcome).toBe('accepted');
    expect((await handleEvent(pdEvent({ source: other.eventSource }), deps)).outcome).toBe('accepted');
    expect([...store.items.keys()].sort()).toEqual(['pagerduty#msg-1', 'pagerduty-eu#msg-1']);
  });

  it('refuses an event older than the replay window, whose record could have expired, and one dated in the future', async () => {
    const { deps, store } = world();
    const old = pdEvent({ messageId: 'old', createdOn: new Date(NOW - (REPLAY_WINDOW_SECONDS + 60) * 1000).toISOString() });
    expect((await handleEvent(old, deps)).outcome).toBe('out-of-window');
    expect((await handleEvent(pdEvent({ messageId: 'future', createdOn: new Date(NOW + 3600_000).toISOString() }), deps)).outcome).toBe('out-of-window');
    expect(store.items.size).toBe(0);
  });

  it('drops an event it cannot read, and ignores a type the connector does not subscribe to, recording neither', async () => {
    const { deps, store } = world();
    expect((await handleEvent({ id: 'e', source: PD_SOURCE, 'detail-type': 'PagerDuty Webhook', detail: { not: 'a message' } }, deps)).outcome).toBe('unreadable');
    expect((await handleEvent(pdEvent({ messageId: 'ack', type: 'incident.acknowledge' }), deps)).outcome).toBe('ignored');
    expect(store.items.size).toBe(0);
  });
});

describe('a failure a retry can cure', () => {
  it('throws when the publish fails, releases the claim, and processes the retry', async () => {
    let fail = true;
    const { deps, store, published } = world({
      publish: jest.fn(async (d) => { if (fail) throw new Error('bus down'); published.push(d as never); }),
    });
    await expect(handleEvent(pdEvent(), deps)).rejects.toBeInstanceOf(IngestRetry);
    expect(store.items.size).toBe(0);
    // Lambda retries the invocation: the same event, which is not dropped as a replay.
    fail = false;
    expect((await handleEvent(pdEvent(), deps)).outcome).toBe('accepted');
    expect(published).toHaveLength(1);
    expect(store.items.get('pagerduty#msg-1')!.state).toBe('published');
  });

  it('processes the retry even when the release failed, once the claim has lapsed', async () => {
    let fail = true;
    const { deps, store, published, advance } = world({
      publish: jest.fn(async (d) => { if (fail) throw new Error('bus down'); published.push(d as never); }),
    });
    const send = store.send.getMockImplementation()!;
    store.send.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'DeleteCommand') throw Object.assign(new Error('x'), { name: 'InternalServerError' });
      return send(cmd);
    });
    await expect(handleEvent(pdEvent(), deps)).rejects.toBeInstanceOf(IngestRetry);
    expect(store.items.get('pagerduty#msg-1')!.state).toBe('claimed');
    fail = false;
    // Inside the lease the claim is another invocation's: retried, not dropped.
    await expect(handleEvent(pdEvent(), deps)).rejects.toBeInstanceOf(IngestRetry);
    expect(published).toEqual([]);
    // Lambda's next retry comes after the lease: the dead holder's claim is taken over.
    advance(CLAIM_LEASE_SECONDS + 1);
    expect((await handleEvent(pdEvent(), deps)).outcome).toBe('accepted');
    expect(published).toHaveLength(1);
  });

  it('throws when the replay store cannot answer, publishing nothing', async () => {
    const down = { send: async () => { throw Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }); } };
    const { deps, published } = world({ doc: down });
    await expect(handleEvent(pdEvent(), deps)).rejects.toBeInstanceOf(IngestRetry);
    expect(published).toEqual([]);
  });

  it('throws when Identities cannot be read, and releases the claim, so nobody is reported unresolved by an outage', async () => {
    const { deps, store, published } = world();
    deps.participants = { ...deps.participants, resolve: async () => { throw new Error('Identities down'); } };
    await expect(handleEvent(pdEvent(), deps)).rejects.toBeInstanceOf(IngestRetry);
    expect(store.items.size).toBe(0);
    expect(published).toEqual([]);
  });
});

describe('the fact', () => {
  it('names the admitted people and counts the rest, never by address', async () => {
    const { deps, published } = world();
    await handleEvent(pdEvent(), deps);
    expect(published[0].admitted).toEqual([{ role: 'assignee', personArn: PERSON }]);
    const sf = world();
    await handleEvent(sfEvent(), sf.deps);
    expect(sf.published[0].admitted).toEqual([]);
    expect(sf.published[0].notAdmitted).toEqual({ refused: 0, undetermined: 0, unresolved: 1, pending: 0 });
  });
});
