import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulawDecodeSample, mulawEncodeSample, mulawToPcm, pcmToMulaw } from '../src/g711.mjs';

test('silence encodes to 0xff and decodes back to zero', () => {
  assert.equal(mulawEncodeSample(0), 0xff);
  assert.equal(mulawDecodeSample(0xff), 0);
});

test('every mu-law byte survives a decode and re-encode', () => {
  for (let b = 0; b < 256; b++) {
    const again = mulawEncodeSample(mulawDecodeSample(b));
    // 0x7f and 0xff are both zero (positive and negative zero); either is correct.
    if (b === 0x7f) assert.ok(again === 0x7f || again === 0xff);
    else assert.equal(again, b, `byte ${b}`);
  }
});

test('a linear sample comes back within the step size of its segment', () => {
  for (const s of [-32768, -20000, -1000, -50, -1, 1, 50, 1000, 20000, 32767]) {
    const back = mulawDecodeSample(mulawEncodeSample(s));
    const tolerance = Math.max(8, Math.abs(s) / 16);
    assert.ok(Math.abs(back - s) <= tolerance, `${s} came back as ${back}`);
  }
});

test('a 20 ms frame round-trips at its length', () => {
  const frame = new Int16Array(160).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)));
  const back = mulawToPcm(pcmToMulaw(frame));
  assert.equal(back.length, 160);
  for (let i = 0; i < 160; i++) assert.ok(Math.abs(back[i] - frame[i]) <= 512);
});
