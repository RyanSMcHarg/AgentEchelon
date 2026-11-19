/**
 * AN OPENER RECORDS THE KEY ITS CONVERSATION WATCHES (DESIGN-EVENT-TARGETS sections 3 and 5, WT124, WT125).
 *
 * What it proves:
 *  - a key's kind is declared and checked at synth, belongs to one source, and its path reads only the event's detail or resources;
 *  - an id is normalized one way for every reader, and anything that is not an id is refused, never coerced;
 *  - an event that carries no key opens a conversation that watches nothing, and one that carries a bad key is refused;
 *  - the creator returns the live conversation that already watches a key, writes the row before the watch item, and claims the
 *    item conditionally, so a later event cannot move a key away from the conversation that holds it;
 *  - the watch item is kept per classification.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  isRefPath, openerWatchKey, refId, refKey, resolveEventOpeners, watchedKindSources, type EventOpener,
} from '../../lib/config/event-openers';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';
import { refWatchKey } from '../../lambda/src/lib/event-workflow';

jest.mock('../../lambda/src/lib/channel-creation.js', () => ({ createConversationFromEvent: jest.fn() }));
// eslint-disable-next-line import/first
import { KeyWatchUnwritten, holdRefWatch } from '../../lambda/src/typed-conversation-from-event';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

const opener = (over: Partial<EventOpener> = {}): EventOpener => ({
  source: 'ae.ops', detailType: 'Incident opened', values: { forPerson: 'a@example.com' }, ...over,
});
const types = (...openers: EventOpener[]) => ({ ops: { classifications: ['premium'], initiation: 'system', openedBy: openers } });

describe('a watched key is declared, never read from the event', () => {
  it('accepts a kind and a path into the event\'s detail or resources', () => {
    expect(() => resolveEventOpeners(types(opener({ watches: { kind: 'support-ticket', path: '$.detail.ticketId' } })))).not.toThrow();
    expect(isRefPath('$.resources[0]')).toBe(true);
  });

  it.each([
    ['a kind outside its shape', { kind: 'Support Ticket', path: '$.detail.id' }, /watches.kind/],
    ['a path into the envelope', { kind: 'ticket', path: '$.source' }, /watches.path/],
    ['a path that is not plain', { kind: 'ticket', path: '$.detail[*].id' }, /watches.path/],
  ])('refuses %s', (_n, watches, pattern) => {
    expect(() => resolveEventOpeners(types(opener({ watches })))).toThrow(pattern);
  });

  it('refuses one kind under two sources, so one source cannot reach another\'s conversations', () => {
    expect(() => resolveEventOpeners(types(
      opener({ watches: { kind: 'ticket', path: '$.detail.id' } }),
      opener({ source: 'ae.other', watches: { kind: 'ticket', path: '$.detail.id' } }),
    ))).toThrow(/already belongs to source default\|ae.ops/);
  });

  it('the shipped ops opener records its incident\'s id, and the kind is bound to the platform\'s ops source', () => {
    expect(CONVERSATION_TYPES.ops.openedBy?.[0].watches).toEqual({ kind: 'ops-incident', path: '$.detail.incidentId' });
    expect(watchedKindSources(CONVERSATION_TYPES).get('ops-incident')).toBe('default|ae.ops');
  });
});

describe('an id is normalized one way, and anything else is none', () => {
  it('trims a string and writes a number in decimal', () => {
    expect(refId(' INC-42 ')).toBe('INC-42');
    expect(refId(42)).toBe('42');
  });

  it('accepts an ARN read at $.resources[0], slashes and all', () => {
    const arn = 'arn:aws:ec2:us-east-1:111122223333:instance/i-0123456789abcdef0';
    expect(refId(arn)).toBe(arn);
    expect(refId(`arn:aws:cloudwatch:us-east-1:111122223333:alarm:${'a'.repeat(255)}`)).toBeDefined();
  });

  it.each([[{ id: 'x' }], [['x']], [''], ['a b'], ['x'.repeat(1025)], ['a#b'], [Number.NaN], [true], [undefined]])('refuses %p', (v) => {
    expect(refId(v)).toBeUndefined();
  });

  it('reads the key from the event: none when absent, refused when not an id', () => {
    const o = opener({ watches: { kind: 'ticket', path: '$.detail.ticketId' } });
    expect(openerWatchKey(o, { detail: { ticketId: 7 } })).toEqual({ kind: 'ticket', id: '7' });
    expect(openerWatchKey(o, { detail: {} })).toBeUndefined();
    expect(openerWatchKey(o, { detail: { ticketId: { nested: true } } })).toBeNull();
    expect(openerWatchKey(opener(), { detail: { ticketId: 'x' } })).toBeUndefined();
    expect(refKey('ticket', '7')).toBe('ticket#7');
  });
});

describe('the watch item', () => {
  it('is kept per classification, so one cannot read or evict another\'s', () => {
    expect(refWatchKey('premium', 'ticket', '7')).toBe('watch#ref#premium#ticket#7');
    expect(refWatchKey('premium', 'ticket', '7')).not.toBe(refWatchKey('standard', 'ticket', '7'));
  });

  it('is claimed only where it is absent, names this room, or names a room that no longer holds it', () => {
    const client = read('lib/channel-context-client.ts');
    const fn = client.slice(client.indexOf('export async function claimRefWatch('), client.indexOf('export async function refWatchOf('));
    expect(fn).toContain("'attribute_not_exists(#room) OR #room = :room'");
    expect(fn).toContain('if (!(await released(held.room))) return held.room;');
    expect(fn).toContain("'#room = :held'");
  });

  it('the creator returns the live conversation that holds the key, writes the row first, and claims the item after', () => {
    const creator = read('typed-conversation-from-event.ts');
    const order = [
      'const held = await refWatchOf(refWatch, { strict: true })',
      'await watchesRefLive(held.room, refKey(ref.kind, ref.id))',
      'const claim = await claimOpening(opening);',
      'watchedRefs: [refKey(ref.kind, ref.id)]',
      'await holdRefWatch(() => claimRefWatch(refWatch, { room: created.channelArn',
    ].map((t) => creator.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("the room holds its key's watch", () => {
  it('tries a claim the store could not write again, so one failed write does not leave the room watching nothing', async () => {
    const answers: Array<string | null | Error> = [null, new Error('ProvisionedThroughputExceededException'), 'room-a'];
    let calls = 0;
    const holder = await holdRefWatch(async () => { const a = answers[calls++]; if (a instanceof Error) throw a; return a; }, 3, 0);
    expect(holder).toBe('room-a');
    expect(calls).toBe(3);
  });

  it('answers the conversation that holds it at the first answer, and null only when every attempt failed', async () => {
    let calls = 0;
    expect(await holdRefWatch(async () => { calls++; return 'room-b'; }, 3, 0)).toBe('room-b');
    expect(calls).toBe(1);
    expect(await holdRefWatch(async () => null, 3, 0)).toBeNull();
  });

  it('a second delivery of the event claims the watch for the room the first one opened', () => {
    const creator = read('typed-conversation-from-event.ts');
    const existing = creator.indexOf("if ('existing' in claim) {");
    const repair = creator.indexOf('holdRefWatch(() => claimRefWatch(refWatch, { room: claim.existing');
    expect(existing).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(existing);
    expect(repair).toBeLessThan(creator.indexOf("if ('busy' in claim)"));
  });

  it('DENY: a room that stands without its key\'s watch fails the event, so it is delivered again rather than reported opened', () => {
    const creator = read('typed-conversation-from-event.ts');
    const write = creator.indexOf('holdRefWatch(() => claimRefWatch(refWatch, { room: created.channelArn');
    const fail = creator.indexOf("throw new KeyWatchUnwritten(", write);
    expect(fail).toBeGreaterThan(write);
    // Only an event with an opening claim fails: its redelivery finds the room it opened, where a direct invoke would open another.
    expect(creator.slice(write, fail)).toContain('else if (opening) {');
    expect(creator).toContain('if (err instanceof KeyWatchUnwritten) throw err;');
    expect(new KeyWatchUnwritten('x').name).toBe('KeyWatchUnwritten');
  });
});
