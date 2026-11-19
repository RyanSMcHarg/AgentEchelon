/**
 * The keepalive tone is one a browser counts as audible: Chromium's audio stream monitor reads a tab's output power
 * against about -72 dBFS, so the tone, at the element's volume, peaks above that, and stays far below what a person hears.
 */
import { describe, expect, it } from 'vitest';
import { KEEPALIVE_VOLUME, keepaliveWav } from './meetingKeepalive';

/** The browser's audibility threshold, in dBFS (Chromium `AudioStreamMonitor`). */
const AUDIBLE_DBFS = -72.24;

describe('the keepalive tone', () => {
  const view = new DataView(keepaliveWav());
  const samples = (view.byteLength - 44) / 2;
  let peak = 0;
  for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)) / 32767);
  const playedDbfs = 20 * Math.log10(peak * KEEPALIVE_VOLUME);

  it('is a signal, not a file of zeros', () => {
    expect(peak).toBeGreaterThan(0);
  });

  it('plays above the level a browser counts as audible, and far below what a person hears', () => {
    expect(playedDbfs).toBeGreaterThan(AUDIBLE_DBFS);
    expect(playedDbfs).toBeLessThan(-60);
  });

  it('loops without a click: the last sample leads back into the first', () => {
    const first = view.getInt16(44, true);
    const last = view.getInt16(44 + (samples - 1) * 2, true);
    expect(Math.abs(last - first)).toBeLessThan(10);
  });
});
