/**
 * G.711 mu-law, the format Twilio Media Streams carries: 8000 Hz, 8-bit, mono, 20 ms (160-byte) frames.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** One mu-law byte to a 16-bit linear sample. */
export function mulawDecodeSample(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

/** One 16-bit linear sample to a mu-law byte. */
export function mulawEncodeSample(sample) {
  let s = sample | 0;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** A buffer of mu-law bytes to an Int16Array of linear samples. */
export function mulawToPcm(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = mulawDecodeSample(bytes[i]);
  return out;
}

/** An Int16Array of linear samples to a Buffer of mu-law bytes. */
export function pcmToMulaw(samples) {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = mulawEncodeSample(samples[i]);
  return out;
}
