import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTwilioFrame, placeCallForLeg } from '../src/legs.mjs';
import { tunnelUrlIn } from '../src/tunnel.mjs';

test('a media-stream frame is an object or nothing', () => {
  for (const raw of ['null', '42', '"start"', '[1]', 'not json', 'true']) assert.equal(parseTwilioFrame(raw), null, raw);
  assert.deepEqual(parseTwilioFrame('{"event":"start"}'), { event: 'start' });
  assert.deepEqual(parseTwilioFrame(Buffer.from('{"event":"stop"}')), { event: 'stop' });
});

test('a leg still wanted keeps its placed call', async () => {
  const leg = { status: 'connecting', callSid: null };
  const hungUp = [];
  const call = await placeCallForLeg(leg, async () => ({ sid: 'CA1' }), async (sid) => { hungUp.push(sid); });
  assert.deepEqual(call, { sid: 'CA1' });
  assert.equal(leg.callSid, 'CA1');
  assert.deepEqual(hungUp, []);
});

test('a leg that ended while its call was being placed hangs the call up', async () => {
  const leg = { status: 'connecting', callSid: null };
  const hungUp = [];
  const call = await placeCallForLeg(leg, async () => { leg.status = 'ended'; return { sid: 'CA2' }; }, async (sid) => { hungUp.push(sid); });
  assert.equal(call, null);
  assert.deepEqual(hungUp, ['CA2']);
});

test('only a quick tunnel host is read as the tunnel URL', () => {
  assert.equal(tunnelUrlIn('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null);
  assert.equal(tunnelUrlIn('INF |  https://brave-lion-sun-tree.trycloudflare.com  |'), 'https://brave-lion-sun-tree.trycloudflare.com');
  assert.equal(tunnelUrlIn('see https://api.trycloudflare.com then https://a-b-c.trycloudflare.com'), 'https://a-b-c.trycloudflare.com');
});
