import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endIfNoStream, joinLegResources } from '../src/legs.mjs';
import { maskNumbersIn } from '../src/config.mjs';

function deps(leg, endAfter) {
  const made = { attendees: [], deleted: [], pages: [], closed: [] };
  return {
    made,
    createAttendee: async () => { const a = { AttendeeId: `a${made.attendees.length}` }; made.attendees.push(a); if (endAfter === 'attendee') leg.status = 'ended'; return a; },
    deleteAttendee: async (a) => { made.deleted.push(a.AttendeeId); },
    openPage: async () => { const p = { id: made.pages.length }; made.pages.push(p); if (endAfter === 'page') leg.status = 'ended'; return p; },
    closePage: async (p) => { made.closed.push(p.id); },
  };
}

test('a leg that stays wanted keeps its attendee and page', async () => {
  const leg = { status: 'connecting', attendee: null, page: null };
  const d = deps(leg);
  assert.equal(await joinLegResources(leg, d), true);
  assert.deepEqual(leg.attendee, { AttendeeId: 'a0' });
  assert.deepEqual(leg.page, { id: 0 });
  assert.deepEqual(d.made.deleted, []);
});

test('a leg ended while its attendee was being created gives the attendee back', async () => {
  const leg = { status: 'connecting', attendee: null, page: null };
  const d = deps(leg, 'attendee');
  assert.equal(await joinLegResources(leg, d), false);
  assert.deepEqual(d.made.deleted, ['a0']);
  assert.equal(leg.attendee, null);
  assert.deepEqual(d.made.pages, []);
});

test('a leg ended while its page was opening closes the page and gives the attendee back', async () => {
  const leg = { status: 'connecting', attendee: null, page: null };
  const d = deps(leg, 'page');
  assert.equal(await joinLegResources(leg, d), false);
  assert.deepEqual(d.made.closed, [0]);
  assert.deepEqual(d.made.deleted, ['a0']);
  assert.equal(leg.attendee, null);
  assert.equal(leg.page, null);
});

test('an inbound call that opens no stream is ended, and one that does is left alone', async () => {
  const silent = { status: 'joined, waiting for the call', twilioWs: null };
  const streaming = { status: 'live', twilioWs: {} };
  const ended = [];
  endIfNoStream(silent, 5, (why) => ended.push(['silent', why]));
  endIfNoStream(streaming, 5, (why) => ended.push(['streaming', why]));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ended, [['silent', 'the call opened no audio stream']]);
});

test('a Twilio refusal is masked before it is logged or shown', () => {
  const msg = 'The number +15555550123 is unverified. Trial accounts cannot call 15555550124 until verified.';
  const masked = maskNumbersIn(msg);
  assert.ok(!masked.includes('5555550123') && !masked.includes('15555550124'), masked);
  assert.ok(masked.includes('0123') && masked.includes('0124'));
  assert.equal(maskNumbersIn('meeting 1b2c3d4e-0000-1111-2222-333344445555 leg 12345678'), 'meeting 1b2c3d4e-0000-1111-2222-333344445555 leg 12345678');
});

test('a leg records the late caller audio its player dropped, as a growing total', async () => {
  const { recordDroppedAudio } = await import('../src/legs.mjs');
  const leg = { timings: {} };
  assert.equal(recordDroppedAudio(leg, 140.4), true);
  assert.equal(leg.timings.droppedMs, 140);
  assert.equal(recordDroppedAudio(leg, 140), false);
  assert.equal(recordDroppedAudio(leg, 90), false);
  assert.equal(recordDroppedAudio(leg, Number.NaN), false);
  assert.equal(recordDroppedAudio(leg, '300'), false);
  assert.equal(recordDroppedAudio(leg, 300), true);
  assert.equal(leg.timings.droppedMs, 300);
});

test('the server takes the page\'s dropped-audio reports onto the leg the control page reads', async () => {
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const page = await readFile(new URL('../web/bridge-page.mjs', import.meta.url), 'utf8');
  const control = await readFile(new URL('../web/control-page.mjs', import.meta.url), 'utf8');
  assert.match(server, /page\.exposeFunction\('reportDroppedMs', \(ms\) => \{ if \(recordDroppedAudio\(leg, ms\)\) broadcast\(\); \}\)/);
  assert.ok(server.indexOf("exposeFunction('reportDroppedMs'") < server.indexOf('page.goto('), 'exposed before the page loads');
  assert.match(page, /window\.reportDroppedMs\?\.\(e\.data\.droppedMs\)/);
  assert.match(control, /t\.droppedMs/);
});
