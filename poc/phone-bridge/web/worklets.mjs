/**
 * The two AudioWorklet processors the bridge page runs, as source text so the page can load them from a
 * Blob URL with no second file to serve.
 *
 * pstn-player: 8000 Hz frames from the caller in, the AudioContext's rate out (linear interpolation).
 *   It waits for 40 ms before it starts, re-buffers after an underrun, and DROPS audio rather than
 *   queueing it once more than 200 ms is waiting, back to 60 ms. A queue that only grows is how a phone
 *   leg ends up seconds behind the meeting.
 * pstn-capture: the meeting's mixed audio in, 8000 Hz 20 ms (160-sample) Int16 frames out, by averaging
 *   each block of input samples (a crude low-pass before decimation; telephone audio tolerates it).
 */
export const WORKLETS = `
const RING = 8000;
const START_AT = 320;   // 40 ms at 8000 Hz
const DROP_ABOVE = 1600; // 200 ms
const DROP_TO = 480;     // 60 ms

class PstnPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(RING);
    this.r = 0; this.w = 0; this.n = 0; this.pos = 0; this.started = false; this.dropped = 0;
    this.port.onmessage = (e) => {
      const s = new Int16Array(e.data);
      for (let i = 0; i < s.length; i++) {
        if (this.n === RING) { this.r = (this.r + 1) % RING; this.n--; }
        this.buf[this.w] = s[i] / 32768;
        this.w = (this.w + 1) % RING;
        this.n++;
      }
      if (this.n > DROP_ABOVE) {
        const drop = this.n - DROP_TO;
        this.r = (this.r + drop) % RING; this.n -= drop; this.dropped += drop;
        this.port.postMessage({ droppedMs: Math.round(this.dropped / 8) });
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.started) {
      if (this.n < START_AT) { out.fill(0); return true; }
      this.started = true;
    }
    const step = 8000 / sampleRate;
    for (let i = 0; i < out.length; i++) {
      if (this.n < 2) { out[i] = 0; this.started = false; continue; }
      const a = this.buf[this.r];
      const b = this.buf[(this.r + 1) % RING];
      out[i] = a + (b - a) * this.pos;
      this.pos += step;
      while (this.pos >= 1) { this.pos -= 1; this.r = (this.r + 1) % RING; this.n--; }
    }
    return true;
  }
}

class PstnCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 8000;
    this.acc = 0; this.cnt = 0; this.i = 0;
    this.frame = new Int16Array(160);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.cnt++;
      if (this.cnt >= this.ratio) {
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.acc = 0; this.cnt = 0;
        this.frame[this.i++] = Math.round(v * 32767);
        if (this.i === 160) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(160); this.i = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pstn-player', PstnPlayer);
registerProcessor('pstn-capture', PstnCapture);
`;
