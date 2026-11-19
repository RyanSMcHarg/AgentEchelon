/**
 * Keeping a backgrounded tab's timers alive for the duration of a meeting.
 *
 * ── THE PROBLEM THIS SOLVES, WHICH IS NOT A CHIME PROBLEM ────────────────────────────────────────
 *
 * Browsers aggressively throttle a backgrounded tab: timers are clamped to roughly once a minute, and
 * in Chrome a fully hidden tab can be frozen outright. Amazon Chime SDK's own reconnection logic runs
 * on those timers, so the thing meant to recover a dropped connection is itself throttled exactly when
 * it is needed. Somebody switches tabs during a meeting, comes back, and the session is dead with no
 * reconnect ever attempted.
 *
 * A tab that is PLAYING AUDIO is exempt from that throttling. So this plays a looping, near-silent
 * tone for as long as the meeting is up, which keeps the tab audible to the browser and leaves Chime's
 * own recovery working. It is a browser workaround rather than anything to do with meetings, which is
 * why it lives in its own file.
 *
 * WHY NOT RELY ON THE REMOTE AUDIO ALREADY PLAYING. A meeting where nobody happens to be speaking is
 * not audible, and neither is one the person joined to listen to a screen share. The exemption has to
 * hold for the whole meeting, not only while somebody talks.
 *
 * NEITHER THE VOLUME NOR THE SIGNAL IS ZERO, deliberately. A browser counts a tab as audible by the level it actually
 * plays (Chromium's audio stream monitor reads the output's power against a threshold of about -72 dBFS), so a muted
 * element, a zero volume or a file of zeros is silence to it, and the exemption would not apply while this looked like it
 * worked. The tone is a 30 Hz sine at -26 dBFS, played at 1% volume: about -66 dBFS out, over the threshold and below
 * what a person hears.
 *
 * IT CAN FAIL, AND THAT IS NOT FATAL. Autoplay policy can refuse playback when there has been no user
 * gesture. Starting a meeting is a gesture, so in practice it is allowed, but a refusal degrades to
 * the behavior without this file rather than failing the meeting - and the health check on
 * visibilitychange is the backstop for exactly that case.
 */

/** The tone's frequency and amplitude (of full scale), and the element's volume: see the file's comment. */
const TONE_HZ = 30;
const TONE_AMPLITUDE = 0.05;
export const KEEPALIVE_VOLUME = 0.01;

/**
 * A one-second mono 16-bit WAV of the keepalive tone: a whole number of cycles, so it loops without a click. Generated
 * rather than shipped as an asset.
 */
export function keepaliveWav(): ArrayBuffer {
  const sampleRate = 44100;
  const samples = sampleRate; // one second
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / sampleRate) * TONE_AMPLITUDE * 32767), true);
  }
  return buffer;
}

export interface Keepalive {
  stop: () => void;
  /**
   * Play the tone again if the browser paused it (a mobile browser pauses audio when another app takes the audio focus),
   * so the tab is audible again for the rest of the meeting. A refused play changes nothing.
   */
  resume: () => void;
}

/**
 * Start the keepalive. Returns a handle whose `stop` releases the element and its blob URL.
 *
 * Resolves once playback has been attempted, successfully or not: the caller does not branch on it,
 * because there is nothing useful to do about a refusal beyond what the health check already does.
 */
export async function startKeepalive(): Promise<Keepalive> {
  let url: string | null = null;
  let audio: HTMLAudioElement | null = null;
  const stop = () => {
    if (audio) { audio.pause(); audio = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
  };
  const resume = () => {
    if (!audio || !audio.paused) return;
    try { void audio.play()?.catch(() => undefined); } catch { /* refused; the visibility check is the backstop */ }
  };
  try {
    url = URL.createObjectURL(new Blob([keepaliveWav()], { type: 'audio/wav' }));
    audio = new Audio(url);
    audio.loop = true;
    // Audible to the browser, inaudible to the person.
    audio.volume = KEEPALIVE_VOLUME;
    await audio.play();
  } catch {
    // Autoplay refused, or no audio element in this environment. Release and degrade.
    stop();
  }
  return { stop, resume };
}
