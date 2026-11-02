/**
 * THE AWS EVENT STREAM WIRE FORMAT, DECODED.
 *
 * CloudWatch Logs `StartLiveTail` answers with `application/vnd.amazon.eventstream`: a sequence of binary
 * messages, each a prelude (total length, headers length, prelude CRC), typed headers, a payload and a
 * message CRC. The tests package carries no SDK for CloudWatch Logs, so the watchdog reads the stream
 * itself, and this decoder is the whole of that. It is pure: bytes in, messages out, so it is proven by a
 * unit test with no account and no network.
 *
 * Chunks arrive split anywhere, including inside a prelude, so the decoder keeps what it has not yet
 * consumed and yields a message only once all of its bytes are present.
 */

/** One decoded event stream message: its string-valued headers and its raw payload. */
export interface EventStreamMessage {
  headers: Record<string, string | number | boolean>;
  payload: Buffer;
}

const PRELUDE = 12;
const TRAILER = 4;

function readHeaders(buf: Buffer): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let at = 0;
  while (at < buf.length) {
    const nameLen = buf.readUInt8(at);
    at += 1;
    const name = buf.subarray(at, at + nameLen).toString('utf8');
    at += nameLen;
    const type = buf.readUInt8(at);
    at += 1;
    switch (type) {
      case 0: out[name] = true; break;
      case 1: out[name] = false; break;
      case 2: out[name] = buf.readInt8(at); at += 1; break;
      case 3: out[name] = buf.readInt16BE(at); at += 2; break;
      case 4: out[name] = buf.readInt32BE(at); at += 4; break;
      case 5: out[name] = Number(buf.readBigInt64BE(at)); at += 8; break;
      case 6: {
        const len = buf.readUInt16BE(at);
        at += 2;
        out[name] = buf.subarray(at, at + len).toString('base64');
        at += len;
        break;
      }
      case 7: {
        const len = buf.readUInt16BE(at);
        at += 2;
        out[name] = buf.subarray(at, at + len).toString('utf8');
        at += len;
        break;
      }
      case 8: out[name] = Number(buf.readBigInt64BE(at)); at += 8; break;
      case 9: out[name] = buf.subarray(at, at + 16).toString('hex'); at += 16; break;
      default:
        // An unknown header type leaves the rest of the block unreadable; what was read is kept.
        return out;
    }
  }
  return out;
}

/** Accumulates chunks and yields every message that is complete. */
export class EventStreamDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | Uint8Array): EventStreamMessage[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, Buffer.from(chunk)]) : Buffer.from(chunk);
    const out: EventStreamMessage[] = [];
    while (this.pending.length >= PRELUDE) {
      const total = this.pending.readUInt32BE(0);
      const headersLen = this.pending.readUInt32BE(4);
      if (total < PRELUDE + TRAILER || headersLen > total - PRELUDE - TRAILER) {
        throw new Error(`event stream prelude is malformed (total ${total}, headers ${headersLen})`);
      }
      if (this.pending.length < total) break;
      const headers = readHeaders(this.pending.subarray(PRELUDE, PRELUDE + headersLen));
      const payload = Buffer.from(this.pending.subarray(PRELUDE + headersLen, total - TRAILER));
      out.push({ headers, payload });
      this.pending = this.pending.subarray(total);
    }
    return out;
  }
}

/**
 * Encode one message with string headers. The decoder's test counterpart, and the shape the service sends;
 * CRC fields are written as zero because the decoder does not read them (TLS already carries integrity).
 */
export function encodeEventStreamMessage(headers: Record<string, string>, payload: Buffer | string): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let at = h.writeUInt8(n.length, 0);
    n.copy(h, at);
    at += n.length;
    at = h.writeUInt8(7, at);
    at = h.writeUInt16BE(v.length, at);
    v.copy(h, at);
    parts.push(h);
  }
  const headerBlock = Buffer.concat(parts);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const total = PRELUDE + headerBlock.length + body.length + TRAILER;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBlock.length, 4);
  headerBlock.copy(out, PRELUDE);
  body.copy(out, PRELUDE + headerBlock.length);
  return out;
}
