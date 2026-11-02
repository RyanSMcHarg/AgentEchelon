/**
 * AN OPENING EVENT OPENS ONE ROOM (ADR-061 decision 1, `conversation-opened`).
 *
 * What it proves: the canonical creator claims an event a declared rule delivered, by the declaration and the event's
 * own id, after every refusal and before it creates anything, so a redelivered event opens no second room and starts no
 * second `conversation-opened` run; the claim names the room once it exists, and a claim that never named one is taken
 * again once it is stale, so a re-driven event still opens its room. A direct invoke, which no rule redelivers, claims
 * nothing.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../lambda/src/lib/channel-creation.js', () => ({ createConversationFromEvent: jest.fn() }));
// eslint-disable-next-line import/first
import { openingKey } from '../../lambda/src/typed-conversation-from-event';
// eslint-disable-next-line import/first
import { OPENING_CLAIM_STALE_MS } from '../../lambda/src/lib/channel-context-client';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

describe('one room per opening event', () => {
  it('keys the claim by the declaration that delivered the event and the event\'s own id', () => {
    expect(openingKey({ aeOpener: 'ops#0', event: { id: '7bf73129-1428-4cd3-a780-95db273d1602' } })).toBe('opened#ops#0#7bf73129-1428-4cd3-a780-95db273d1602');
    expect(openingKey({ detail: { conversationType: 'ops' } })).toBeUndefined();
    expect(openingKey({ aeOpener: 'ops#0', event: {} })).toBeUndefined();
    expect(openingKey({ aeOpener: 'ops#0', event: { id: 'bad id with spaces' } })).toBeUndefined();
  });

  it('claims after every refusal and before anything is created, returns the room a redelivery finds, and names the room it opened', () => {
    const creator = read('typed-conversation-from-event.ts');
    const at = (t: string) => creator.indexOf(t);
    expect(at('const opening = openingKey(event);')).toBeGreaterThan(at("throw new Error('detail.watchesAlarm is not an alarm name')"));
    expect(at('const opening = openingKey(event);')).toBeGreaterThan(at('if (!allowed.admitted.has(forUserArn))'));
    expect(at('const claim = await claimOpening(opening);')).toBeLessThan(at('const created = await createConversationFromEvent({'));
    expect(creator).toMatch(/return \{ ok: true, reused: true, channelArn: claim\.existing,/);
    expect(at('if (opening) await settleOpening(opening, created.channelArn);')).toBeLessThan(at("nameEventThroughRouter(DEPLOYED_CLASSIFICATION, {"));
  });

  it('a claim that never named a room is taken again once stale, and only then', () => {
    const store = read('lib/channel-context-client.ts');
    expect(store).toMatch(/ConditionExpression: 'attribute_not_exists\(#claimedAt\) OR \(attribute_not_exists\(#room\) AND #claimedAt < :stale\)'/);
    expect(OPENING_CLAIM_STALE_MS).toBe(300_000);
  });
});
