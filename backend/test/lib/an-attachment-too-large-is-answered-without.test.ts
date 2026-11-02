/**
 * A FILE TOO BIG FOR THE MODEL IS A DEGRADED TURN, NOT A FAILED ONE.
 *
 * THE DEFECT THIS EXISTS FOR (2026-09-15). Nothing measured an attachment anywhere on the path into
 * Amazon Bedrock. The presigned upload capped at 10 MiB, `fetchAttachmentBytes` read whatever was
 * there, and the bytes went into a Converse image or document block. Bedrock answered a
 * `ValidationException`, `classifyError` marked it 'fail', and the person got an error line while an
 * operator got an alert - for a file the platform had accepted and stored moments earlier.
 *
 * And it did not stop at that turn. `resolveHistoryImageBlocks` re-offers recent conversation images,
 * so ONE oversize image failed every subsequent turn until it fell out of the history window.
 *
 * THE SECOND LIMIT (2026-09-15). A file can also be too WIDE. Amazon Bedrock refuses an image whose
 * longest edge is over 8000 px, and a stitched phone screenshot or a scan reaches that while staying
 * comfortably inside the byte budget - so the same ValidationException arrived by the other door. The
 * dimensions are now read from the file's own header, with no decoder and no dependency, and the
 * refusal runs through the SAME checker, the same counter and the same copy as the byte refusal.
 *
 * What is pinned here:
 *   - each limit is stated in exactly ONE place, and every path reads it from there;
 *   - an over-limit attachment on the CURRENT turn is dropped, counted, and the person is told in
 *     CONFIGURED copy, while the turn goes on to answer;
 *   - an over-limit image re-offered from HISTORY is skipped in silence, so nobody is apologized to
 *     on every later turn;
 *   - an at-limit image still goes through, on BOTH limits (the non-vacuity half: a guard that dropped
 *     everything would pass every assertion above);
 *   - each supported format's header parses, from a handcrafted buffer rather than a fixture binary;
 *   - a header this code cannot read is UNKNOWN, and unknown is SENT, never refused on a guess;
 *   - the code cannot approach the 20-block-per-request limit.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ownWords } from '../helpers/own-templates';
import {
  attachmentFitsModelBudget,
  attachmentFitsModelLimits,
  attachmentTooLargeLine,
  readImageDimensions,
  recordAttachmentOverBudget,
  ATTACHMENT_TOO_LARGE_DEFAULT,
  MAX_ATTACHMENT_BYTES_FOR_MODEL,
  MAX_ATTACHMENT_BASE64_BYTES_FOR_MODEL,
  MAX_ATTACHMENT_BLOCKS_PER_REQUEST,
  MAX_IMAGE_DIMENSION_PX,
} from '../../lambda/src/lib/attachment-budget';
import {
  resolveHistoryImageBlocks,
  type ConversationMessage,
} from '../../lambda/src/lib/async-processor-core';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('the budget is one number, stated once', () => {
  it('is the RAW byte budget behind the documented base64 limit, not the documented number itself', () => {
    // Base64 inflates by 4/3. Measuring the documented 5 MB against the unencoded buffer would admit a
    // file a third over the real limit and fail at Bedrock exactly as before.
    expect(MAX_ATTACHMENT_BYTES_FOR_MODEL).toBe(3_000_000);
    expect(MAX_ATTACHMENT_BASE64_BYTES_FOR_MODEL).toBe(4_000_000);
    expect(MAX_ATTACHMENT_BYTES_FOR_MODEL).toBe(
      Math.floor(MAX_ATTACHMENT_BASE64_BYTES_FOR_MODEL * 3 / 4),
    );
  });

  it('records where the numbers came from, so the next reader can re-check them', () => {
    // A limit with no source is a number somebody remembered. These were read from the vendor
    // documentation on 2026-09-15 and the links are what make them re-checkable rather than folklore.
    const src = read('lib/attachment-budget.ts');
    expect(src).toContain('build-with-claude/vision');
    expect(src).toContain('build-with-claude/pdf-support');
  });

  it('no other module on the path declares a byte threshold of its own', () => {
    // THE WHOLE POINT OF THE MODULE. A second copy of the number is a second thing to forget when the
    // vendor changes it, and the two paths would then disagree about the same file.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        if (rel === 'lib/attachment-budget.ts') continue;
        const body = fs.readFileSync(full, 'utf8');
        if (/3[_,]?000[_,]?000|3000000|3[_,]?750[_,]?000|3750000/.test(body)) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('no other module on the path declares a pixel threshold of its own', () => {
    // The same rule as the byte budget, for the second limit. Scoped to lines that use 8000 as a SIZE:
    // the number is also a character slice and a timeout elsewhere in the tree, and a blanket scan that
    // flagged those would be turned off rather than fixed.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        if (rel === 'lib/attachment-budget.ts') continue;
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (/\b8000\b/.test(line) && /\b(px|pixel|pixels|dimension|dimensions|width|height)\b/i.test(line)) {
            offenders.push(`${rel}: ${line.trim()}`);
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('every path that sends attachment bytes to a model asks the one checker', () => {
    // Discovered rather than listed: a new sender that compares a length itself would pass a test that
    // only named today's three files. And it is the COMBINED checker, so a sender cannot pick up the
    // byte limit while quietly skipping the pixel one.
    for (const rel of [
      'assistant-async-processor.ts',
      'lib/async-processor-core.ts',
      'analytics-aurora/evaluation-runner.ts',
    ]) {
      const body = read(rel);
      expect(`${rel}: ${/attachmentFitsModelLimits\(/.test(body)}`).toBe(`${rel}: true`);
      expect(`${rel}: ${/recordAttachmentOverBudget\(/.test(body)}`).toBe(`${rel}: true`);
      // The byte-only primitive is the module's own building block, not a sender's entry point.
      expect(`${rel}: ${/attachmentFitsModelBudget\(/.test(body)}`).toBe(`${rel}: false`);
    }
  });

  it('stays well under the 20-block limit a request must not cross', () => {
    // Above 20 image-plus-document blocks a stricter per-image dimension limit applies to EVERY block
    // in the request, and on Amazon Bedrock document blocks count toward it. This is a limit to
    // assert, not a limit to enforce dynamically: the code attaches one current-turn attachment plus
    // the history cap, which is nowhere near it.
    expect(MAX_ATTACHMENT_BLOCKS_PER_REQUEST).toBe(20);
    const core = read('lib/async-processor-core.ts');
    const historyCap = /const maxImages = args\.maxImages \?\? (\d+);/.exec(core);
    expect(historyCap).not.toBeNull();
    // +1 for the current turn's own attachment, which rides the same request.
    expect(Number(historyCap![1]) + 1).toBeLessThan(MAX_ATTACHMENT_BLOCKS_PER_REQUEST);
  });
});

describe('attachmentFitsModelBudget', () => {
  it('admits an attachment AT the budget (the non-vacuity half)', () => {
    // A guard that refused everything would satisfy every "it was dropped" assertion in this file.
    expect(attachmentFitsModelBudget(MAX_ATTACHMENT_BYTES_FOR_MODEL)).toBe(true);
    expect(attachmentFitsModelBudget(MAX_ATTACHMENT_BYTES_FOR_MODEL - 1)).toBe(true);
    expect(attachmentFitsModelBudget(0)).toBe(true);
  });

  it('refuses one byte over', () => {
    expect(attachmentFitsModelBudget(MAX_ATTACHMENT_BYTES_FOR_MODEL + 1)).toBe(false);
    // The upload cap the platform actually accepts. This is the gap the degrade exists to cover.
    expect(attachmentFitsModelBudget(10 * 1024 * 1024)).toBe(false);
  });

  it('fails closed on a length it cannot read', () => {
    expect(attachmentFitsModelBudget(undefined)).toBe(false);
    expect(attachmentFitsModelBudget(NaN)).toBe(false);
    expect(attachmentFitsModelBudget(-1)).toBe(false);
  });
});

// ── Handcrafted headers ─────────────────────────────────────────────────────────────────────────
//
// Every buffer below is built here, byte by byte, rather than checked in as a fixture. A fixture
// binary is a file nobody can read in a diff: when one of these parsers is changed, the reviewer can
// see exactly which byte the test is claiming carries the width, which is the whole thing under test.
// They are also header-only, which is legitimate - the parsers are specified to read the header and
// nothing else, so a buffer with no pixel data is a fair witness.

const ascii = (b: Uint8Array, at: number, s: string): void => {
  for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i);
};

/** PNG: 8-byte signature, then the IHDR chunk whose payload opens with width/height as BE uint32. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13); // IHDR payload length
  ascii(b, 12, 'IHDR');
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

/** GIF: 'GIF89a', then the logical screen descriptor - width/height as LE uint16. */
function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  ascii(b, 0, 'GIF89a');
  b[6] = width & 0xff; b[7] = (width >> 8) & 0xff;
  b[8] = height & 0xff; b[9] = (height >> 8) & 0xff;
  return b;
}

/**
 * JPEG: SOI, then real segments BEFORE the frame header, so the test exercises the segment walk rather
 * than a fixed offset. `sofMarker` picks baseline (0xC0), progressive (0xC2) or anything else.
 */
function jpeg(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  // APP0/JFIF: 14 payload bytes, the shape every camera and export writes first.
  out.push(0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0));
  // A comment segment, so the SOF is not at a predictable distance from the start either.
  out.push(0xff, 0xfe, 0x00, 0x05, 1, 2, 3);
  // SOFn: length 17 = 2 + precision(1) + height(2) + width(2) + componentCount(1) + 3 components x 3.
  out.push(0xff, sofMarker, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, ...new Array(9).fill(0));
  return new Uint8Array(out);
}

/** A RIFF/WEBP container around one chunk. */
function webp(fourcc: string, payload: number[]): Uint8Array {
  const b = new Uint8Array(20 + payload.length);
  ascii(b, 0, 'RIFF');
  ascii(b, 8, 'WEBP');
  ascii(b, 12, fourcc);
  b[16] = payload.length & 0xff;
  b[17] = (payload.length >> 8) & 0xff;
  b.set(payload, 20);
  return b;
}

/** WebP lossy: 3-byte frame tag, the 9D 01 2A start code, then 14-bit LE width and height. */
function webpVp8(width: number, height: number): Uint8Array {
  return webp('VP8 ', [
    0, 0, 0, 0x9d, 0x01, 0x2a,
    width & 0xff, (width >> 8) & 0x3f,
    height & 0xff, (height >> 8) & 0x3f,
  ]);
}

/** WebP lossless: a 0x2F signature, then width-1 and height-1 as 14-bit fields packed LE. */
function webpVp8l(width: number, height: number): Uint8Array {
  const bits = (((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0;
  return webp('VP8L', [
    0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff,
  ]);
}

/** WebP extended: flags + reserved, then the CANVAS width-1 and height-1 as 24-bit LE. */
function webpVp8x(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return webp('VP8X', [
    0, 0, 0, 0,
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ]);
}

describe('readImageDimensions reads the header, and nothing else', () => {
  it('reads PNG from IHDR', () => {
    expect(readImageDimensions(png(1024, 768))).toEqual({ width: 1024, height: 768 });
    // Non-square, so a parser that read the same four bytes twice would fail here.
    expect(readImageDimensions(png(8000, 120))).toEqual({ width: 8000, height: 120 });
  });

  it('reads GIF from the logical screen descriptor, little-endian', () => {
    expect(readImageDimensions(gif(1024, 768))).toEqual({ width: 1024, height: 768 });
    // A byte order mix-up turns 300 into 11264, so an asymmetric pair catches it.
    expect(readImageDimensions(gif(300, 7))).toEqual({ width: 300, height: 7 });
  });

  it('reads JPEG by WALKING the segment chain, not from a fixed offset', () => {
    // The APP0 and comment segments before the SOF are the point: their sizes vary per file, so an
    // assumed offset reads whatever happens to be there.
    expect(readImageDimensions(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    // JPEG stores HEIGHT before width; swapping them is the easy mistake.
    expect(readImageDimensions(jpeg(4000, 300))).toEqual({ width: 4000, height: 300 });
  });

  it('reads the other SOFn markers, not only baseline', () => {
    // A progressive JPEG (SOF2) is what a web export produces, and arithmetic-coded variants exist.
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb]) {
      expect(`${marker}: ${JSON.stringify(readImageDimensions(jpeg(640, 480, marker)))}`)
        .toBe(`${marker}: {"width":640,"height":480}`);
    }
  });

  it('does NOT treat DHT, JPG or DAC as a frame header', () => {
    // 0xC4, 0xC8 and 0xCC sit inside the SOFn range but are other segments entirely. Reading one as a
    // frame header yields a plausible-looking pair of numbers from a Huffman table.
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      expect(`${marker}: ${JSON.stringify(readImageDimensions(jpeg(640, 480, marker)))}`)
        .toBe(`${marker}: undefined`);
    }
  });

  it('gives up at the scan data rather than reading entropy bytes as a size', () => {
    // SOS means the segment chain is over. A parser that kept walking would read compressed pixel data
    // as marker lengths and eventually produce a number.
    const sosOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    expect(readImageDimensions(sosOnly)).toBeUndefined();
  });

  it('reads all three WebP chunk layouts, which do not agree with each other', () => {
    // VP8 masks 14 bits out of a 16-bit field, VP8L packs two 14-bit fields across four bytes, and
    // VP8X stores 24-bit values MINUS ONE. One parser for all three would be wrong for two of them.
    expect(readImageDimensions(webpVp8(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions(webpVp8l(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions(webpVp8x(1024, 768))).toEqual({ width: 1024, height: 768 });
    // The off-by-one the two minus-one encodings invite, at the limit that matters.
    expect(readImageDimensions(webpVp8l(8000, 8000))).toEqual({ width: 8000, height: 8000 });
    expect(readImageDimensions(webpVp8x(8000, 8001))).toEqual({ width: 8000, height: 8001 });
  });

  it('returns UNKNOWN for a header it cannot read', () => {
    // Each of these must be undefined rather than a number: undefined is what makes the file SEND.
    expect(readImageDimensions(undefined)).toBeUndefined();
    expect(readImageDimensions(new Uint8Array(0))).toBeUndefined();
    // Truncated: the signature is there and the dimensions are not.
    expect(readImageDimensions(png(8001, 8001).slice(0, 14))).toBeUndefined();
    expect(readImageDimensions(webpVp8x(8001, 8001).slice(0, 22))).toBeUndefined();
    // A format this platform does not send as an image block.
    expect(readImageDimensions(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]))).toBeUndefined();
    // Not an image at all.
    expect(readImageDimensions(new Uint8Array(64))).toBeUndefined();
    // A RIFF/WEBP container whose chunk is none of the three encodings.
    expect(readImageDimensions(webp('ANIM', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeUndefined();
  });

  it('treats a zero edge as unknown rather than as a tiny image', () => {
    // A header that parsed into nonsense is not evidence about the file. Answering "0 x 0 fits" would
    // be the same guess as answering "too big", made in the other direction.
    expect(readImageDimensions(png(0, 500))).toBeUndefined();
    expect(readImageDimensions(gif(500, 0))).toBeUndefined();
  });
});

describe('attachmentFitsModelLimits enforces the pixel edge', () => {
  it('states the limit once, with the block limit it sits under', () => {
    expect(MAX_IMAGE_DIMENSION_PX).toBe(8000);
    const src = read('lib/attachment-budget.ts');
    // The stricter rule above 20 blocks is a limit to respect, recorded beside the number it would
    // otherwise silently replace.
    expect(src).toMatch(/MAX_ATTACHMENT_BLOCKS_PER_REQUEST[\s\S]{0,400}stricter/i);
  });

  it('admits an image AT the limit on both edges (the non-vacuity half)', () => {
    // Without this, a check that refused every image would satisfy every refusal assertion below.
    for (const bytes of [
      png(MAX_IMAGE_DIMENSION_PX, MAX_IMAGE_DIMENSION_PX),
      gif(MAX_IMAGE_DIMENSION_PX, MAX_IMAGE_DIMENSION_PX),
      jpeg(MAX_IMAGE_DIMENSION_PX, MAX_IMAGE_DIMENSION_PX),
      webpVp8l(MAX_IMAGE_DIMENSION_PX, MAX_IMAGE_DIMENSION_PX),
      webpVp8x(MAX_IMAGE_DIMENSION_PX, MAX_IMAGE_DIMENSION_PX),
    ]) {
      const verdict = attachmentFitsModelLimits(bytes);
      expect(JSON.stringify(verdict.dimensions) + ':' + verdict.fits)
        .toBe(`{"width":${MAX_IMAGE_DIMENSION_PX},"height":${MAX_IMAGE_DIMENSION_PX}}:true`);
    }
  });

  it('refuses one pixel over, on either edge', () => {
    const over = MAX_IMAGE_DIMENSION_PX + 1;
    for (const [label, bytes] of [
      ['png wide', png(over, 10)],
      ['png tall', png(10, over)],
      ['gif wide', gif(over, 10)],
      ['jpeg tall', jpeg(10, over)],
      ['webp lossless wide', webpVp8l(over, 10)],
      ['webp extended tall', webpVp8x(10, over)],
    ] as Array<[string, Uint8Array]>) {
      const verdict = attachmentFitsModelLimits(bytes);
      expect(`${label}: ${verdict.fits} ${verdict.reason}`).toBe(`${label}: false dimensions`);
    }
  });

  it('SENDS a file whose header it could not read', () => {
    // The check predicts a Bedrock rejection; it does not guess at one. Refusing an unparsed file would
    // turn a working turn into a degraded one on no evidence, which is a worse outcome than the
    // rejection this exists to avoid.
    for (const bytes of [
      new Uint8Array(64),
      png(9000, 9000).slice(0, 14),
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]),
    ]) {
      const verdict = attachmentFitsModelLimits(bytes);
      expect(`${verdict.fits} ${verdict.reason} ${verdict.dimensions}`).toBe('true undefined undefined');
    }
  });

  it('measures bytes first, so a huge file is refused for the reason it is huge', () => {
    // A 4 MB image inside the pixel limit is still over the byte budget. The reason has to be the one
    // an operator can act on, and "too many bytes" is the one the person can do something about.
    const heavy = new Uint8Array(MAX_ATTACHMENT_BYTES_FOR_MODEL + 1);
    heavy.set(png(10, 10), 0);
    expect(attachmentFitsModelLimits(heavy)).toEqual({ fits: false, reason: 'bytes' });
    expect(attachmentFitsModelLimits(undefined)).toEqual({ fits: false, reason: 'bytes' });
  });

  it('leaves a document measured on bytes alone', () => {
    // A PDF has no image header, so it comes back with no dimensions and fits on weight. The page count
    // is still unenforced, and that is a stated gap, not something this pretends to cover.
    const pdf = new Uint8Array(1024);
    ascii(pdf, 0, '%PDF-1.7');
    expect(attachmentFitsModelLimits(pdf)).toEqual({ fits: true });
  });
});

describe('a dimension refusal reuses the one counter', () => {
  it('counts under the same metric with a Reason, not a second metric', () => {
    // Tenet D7: "how often does a person's file go unread" is ONE question. A separate metric would have
    // to be summed with this one to answer it, and the two would drift the first time only one was
    // wired to an alarm.
    const docs: Array<Record<string, unknown>> = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      try { docs.push(JSON.parse(line)); } catch { /* not EMF */ }
    });
    try {
      recordAttachmentOverBudget({
        path: 'current-turn',
        byteLength: 120_000,
        reason: 'dimensions',
        dimensions: { width: 12000, height: 400 },
        contentType: 'image/png',
        classification: 'premium',
      });
    } finally { warn.mockRestore(); log.mockRestore(); }
    expect(docs).toHaveLength(1);
    expect(docs[0].attachment_over_budget).toBe(1);
    expect(docs[0].Reason).toBe('dimensions');
    expect(docs[0].ImageWidth).toBe(12000);
    expect(docs[0].ImageHeight).toBe(400);
    const block = (docs[0]._aws as { CloudWatchMetrics: Array<{ Metrics: Array<{ Name: string }> }> })
      .CloudWatchMetrics[0];
    expect(block.Metrics.map((m) => m.Name)).toEqual(['attachment_over_budget']);
  });

  it('defaults the reason to bytes, and leaves the existing dimension sets alone', () => {
    // The alarm-facing streams must keep publishing exactly what they published before the second
    // limit existed, or adding it silently re-points an operator's alarm.
    const docs: Array<Record<string, unknown>> = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      try { docs.push(JSON.parse(line)); } catch { /* not EMF */ }
    });
    try {
      recordAttachmentOverBudget({ path: 'history', byteLength: 9_000_000, contentType: 'image/png' });
    } finally { warn.mockRestore(); log.mockRestore(); }
    expect(docs[0].Reason).toBe('bytes');
    // No edges on a byte refusal: zeroes would read as a zero-pixel image.
    expect(docs[0].ImageWidth).toBeUndefined();
    const block = (docs[0]._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> })
      .CloudWatchMetrics[0];
    expect(block.Dimensions).toEqual([[], ['Classification'], ['Classification', 'Path'], ['Classification', 'Reason']]);
  });
});

describe('what the person is told', () => {
  it('uses the deployment CONFIGURED copy when there is some', () => {
    // Tenets P5 and D11: fixed English means a configured persona never reaches this line and a
    // conversation held in another language gets English at its most confusing moment.
    const line = attachmentTooLargeLine({
      name: 'quarterly.pdf',
      copy: ownWords({ attachmentTooLargeToRead: 'No he podido leer {name}; respondo sin el archivo.' }),
    });
    expect(line).toBe('No he podido leer quarterly.pdf; respondo sin el archivo.');
    expect(line).not.toContain('{name}');
  });

  it('leaves the shipped English when a deployment configured nothing', () => {
    expect(attachmentTooLargeLine({ name: 'x.png' })).toBe(ATTACHMENT_TOO_LARGE_DEFAULT);
  });

  it('says the file arrived, was not read, and that the answer follows without it', () => {
    // The three things the person cannot work out for themselves. A line that only apologizes leaves
    // them unable to tell whether the reply accounted for their file.
    expect(ATTACHMENT_TOO_LARGE_DEFAULT).toMatch(/attached/i);
    expect(ATTACHMENT_TOO_LARGE_DEFAULT).toMatch(/could not read/i);
    expect(ATTACHMENT_TOO_LARGE_DEFAULT).toMatch(/without it/i);
  });

  it('substitutes an absent name with nothing rather than the placeholder', () => {
    const line = attachmentTooLargeLine({ copy: ownWords({ attachmentTooLargeToRead: 'file:{name}:end' }) });
    expect(line).toBe('file::end');
  });
});

describe('the current turn drops the attachment and still answers', () => {
  const processor = read('assistant-async-processor.ts');
  // The attach block, from the ownership gate to the end of its catch.
  const attachBlock = processor.slice(
    processor.indexOf('if (!battleOn && event.attachment?.fileKey && attachmentsBucket'),
    processor.indexOf("console.warn('[AssistantAsyncProcessor] attachment fetch failed (non-fatal):'"),
  );

  it('finds the block it is asserting about', () => {
    // A slice that came back empty would make every assertion below pass against nothing.
    expect(attachBlock.length).toBeGreaterThan(200);
  });

  it('checks the limits BEFORE the bytes become a Converse block', () => {
    const checkedAt = attachBlock.indexOf('attachmentFitsModelLimits(bytes)');
    expect(checkedAt).toBeGreaterThan(-1);
    expect(checkedAt).toBeLessThan(attachBlock.indexOf('imageInput = { format: imgFmt, bytes }'));
    expect(checkedAt).toBeLessThan(attachBlock.indexOf('documentInput = { format: docFmt'));
  });

  it('passes the refusal REASON to the counter rather than assuming bytes', () => {
    // Both limits share one counter, so the reason is the only thing telling an operator whether a
    // deployment is losing files to weight or to pixel edges. Defaulted at the emitter, so a call site
    // that dropped it would silently report every dimension refusal as a byte one.
    expect(attachBlock).toContain('reason: fit.reason');
    expect(attachBlock).toContain('dimensions: fit.dimensions');
  });

  it('degrades rather than throwing: no error handler on this branch', () => {
    // The whole defect was that an over-budget file became a thrown ValidationException, an error line
    // in the conversation and an admin alert. The turn must go on to answer instead.
    const guard = attachBlock.slice(attachBlock.indexOf('attachmentFitsModelLimits(bytes)'));
    expect(guard).not.toContain('handleProcessingError');
    expect(guard).not.toMatch(/throw new Error/);
    expect(guard).toContain('attachmentTooLarge = true');
  });

  it('counts it where an operator can see how often it fires', () => {
    expect(attachBlock).toContain("path: 'current-turn'");
    expect(attachBlock).toContain('recordAttachmentOverBudget(');
  });

  it('tells the person in configured copy, resolved the way every other line is', () => {
    const at = processor.indexOf('if (attachmentTooLarge) {');
    expect(at).toBeGreaterThan(-1);
    const told = processor.slice(at, at + 400);
    expect(told).toContain('attachmentTooLargeLine(');
    // The SAME resolved copy every other platform line uses, not a profile read of its own.
    expect(told).toContain('copy: versionCopy');
    // Said ABOVE the answer: the person needs to know what the reply is missing before they read it.
    expect(told).toMatch(/\}\\n\\n\$\{response\}/);
  });

  it('holds the battle vision path to the same budget', () => {
    // A duel side that sent an oversize image lost the round to a ValidationException rather than to
    // its rival. Same checker, same counter, and it falls through to the text-only invoke.
    const battle = processor.slice(
      processor.indexOf('} else if (imgAtt) {'),
      processor.indexOf('} else if (useExternal && cnCfg) {'),
    );
    expect(battle.length).toBeGreaterThan(200);
    expect(battle).toContain('attachmentFitsModelLimits(bytes)');
    expect(battle).toContain('recordAttachmentOverBudget(');
    expect(battle).toContain('reason: battleFit.reason');
    // And it still answers: the text-only invoke runs in place of the vision one.
    expect(battle).not.toContain('handleProcessingError');
  });
});

describe('a historical over-budget image is skipped in silence', () => {
  const OVER = new Uint8Array(MAX_ATTACHMENT_BYTES_FOR_MODEL + 1);
  const AT_BUDGET = new Uint8Array(8);

  function fakeS3(bytesByKey: Record<string, Uint8Array>) {
    return {
      send: jest.fn(async (cmd: unknown) => {
        const key = (cmd as { Key?: string; input?: { Key?: string } }).Key
          ?? (cmd as { input?: { Key?: string } }).input?.Key
          ?? '';
        return { Body: { transformToByteArray: async () => bytesByKey[key] } };
      }),
    };
  }

  const history = (): ConversationMessage[] => ([
    { role: 'user', content: 'here it is', images: [{ fileKey: 'attachments/c/u/huge.png', contentType: 'image/png' }] },
    { role: 'assistant', content: 'noted' },
    { role: 'user', content: 'and now?' },
  ] as ConversationMessage[]);

  it('does not attach it, so the later turn is not poisoned by it', async () => {
    const messages = history();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const n = await resolveHistoryImageBlocks({
        messages,
        s3: fakeS3({ 'attachments/c/u/huge.png': OVER }) as never,
        bucket: 'attach-bucket',
      });
      expect(n).toBe(0);
      expect(messages[0].images![0].bytes).toBeUndefined();
    } finally { warn.mockRestore(); log.mockRestore(); }
  });

  it('produces no copy: only the turn that carried the file says anything', async () => {
    // A person apologized to on every subsequent turn learns nothing new and cannot make it stop.
    const messages = history();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await resolveHistoryImageBlocks({
        messages,
        s3: fakeS3({ 'attachments/c/u/huge.png': OVER }) as never,
        bucket: 'attach-bucket',
      });
      const said = [...warn.mock.calls, ...log.mock.calls].map((c) => JSON.stringify(c)).join(' ');
      expect(said).not.toContain(ATTACHMENT_TOO_LARGE_DEFAULT);
    } finally { warn.mockRestore(); log.mockRestore(); }
  });

  it('still attaches a history image that FITS (the non-vacuity half)', async () => {
    // Without this, a skip-everything regression would pass both assertions above.
    const messages = history();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const n = await resolveHistoryImageBlocks({
        messages,
        s3: fakeS3({ 'attachments/c/u/huge.png': AT_BUDGET }) as never,
        bucket: 'attach-bucket',
      });
      expect(n).toBe(1);
      expect(messages[0].images![0].bytes).toBe(AT_BUDGET);
    } finally { log.mockRestore(); }
  });

  it('skips an over-DIMENSION historical image too, and still says nothing', async () => {
    // The same poisoning, by the other limit: a 12000 px screenshot re-offered on every later turn is
    // a ValidationException on every later turn. It is dropped here for the same reason and, like the
    // byte case, in silence - the turn that carried it already said so once.
    const messages = history();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const n = await resolveHistoryImageBlocks({
        messages,
        s3: fakeS3({ 'attachments/c/u/huge.png': png(12000, 400) }) as never,
        bucket: 'attach-bucket',
      });
      expect(n).toBe(0);
      expect(messages[0].images![0].bytes).toBeUndefined();
      const said = [...warn.mock.calls, ...log.mock.calls].map((c) => JSON.stringify(c)).join(' ');
      expect(said).not.toContain(ATTACHMENT_TOO_LARGE_DEFAULT);
    } finally { warn.mockRestore(); log.mockRestore(); }
  });

  it('still attaches a historical image INSIDE the pixel limit (the non-vacuity half)', async () => {
    // Without this, a parser that reported every image as oversized would pass the assertion above.
    const fits = png(MAX_IMAGE_DIMENSION_PX, 400);
    const messages = history();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const n = await resolveHistoryImageBlocks({
        messages,
        s3: fakeS3({ 'attachments/c/u/huge.png': fits }) as never,
        bucket: 'attach-bucket',
      });
      expect(n).toBe(1);
      expect(messages[0].images![0].bytes).toBe(fits);
    } finally { log.mockRestore(); }
  });

  it('counts the skip under its own path so the two are told apart', () => {
    const docs: Array<Record<string, unknown>> = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      try { docs.push(JSON.parse(line)); } catch { /* not EMF */ }
    });
    try {
      recordAttachmentOverBudget({ path: 'history', byteLength: 9_000_000, contentType: 'image/png' });
    } finally { warn.mockRestore(); log.mockRestore(); }
    expect(docs).toHaveLength(1);
    expect(docs[0].Path).toBe('history');
    expect(docs[0].attachment_over_budget).toBe(1);
  });
});
