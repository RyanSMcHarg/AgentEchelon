/**
 * Battle image-attachment extraction (Phase-3 vision-in). Pins the
 * Metadata→image contract channel-flow relies on: only a well-formed
 * IMAGE attachment yields a payload; everything else → undefined
 * (so a normal /battle text turn is unaffected).
 */
import { extractImageAttachment } from '../../lambda/src/lib/battle-attachment';

const imageMeta = JSON.stringify({
  attachment: { fileKey: 'attachments/c/u/pic.png', name: 'pic.png', size: 1234, type: 'image/png' },
});

describe('extractImageAttachment', () => {
  it('returns {fileKey,contentType} for an image attachment', () => {
    expect(extractImageAttachment(imageMeta)).toEqual({
      fileKey: 'attachments/c/u/pic.png',
      contentType: 'image/png',
    });
  });

  it('returns undefined for no metadata / empty string', () => {
    expect(extractImageAttachment(undefined)).toBeUndefined();
    expect(extractImageAttachment('')).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(extractImageAttachment('{not json')).toBeUndefined();
  });

  it('returns undefined when there is no attachment', () => {
    expect(extractImageAttachment(JSON.stringify({ assignmentMode: 'battle' }))).toBeUndefined();
  });

  it('returns undefined for a non-image attachment (PDF etc.)', () => {
    const pdf = JSON.stringify({
      attachment: { fileKey: 'attachments/c/u/doc.pdf', name: 'doc.pdf', size: 9, type: 'application/pdf' },
    });
    expect(extractImageAttachment(pdf)).toBeUndefined();
  });

  it('returns undefined when fileKey or type is missing/blank', () => {
    expect(
      extractImageAttachment(JSON.stringify({ attachment: { type: 'image/jpeg' } })),
    ).toBeUndefined();
    expect(
      extractImageAttachment(JSON.stringify({ attachment: { fileKey: '', type: 'image/jpeg' } })),
    ).toBeUndefined();
    expect(
      extractImageAttachment(JSON.stringify({ attachment: { fileKey: 'k' } })),
    ).toBeUndefined();
  });

  it('handles common image content types', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      const meta = JSON.stringify({ attachment: { fileKey: 'k', name: 'n', size: 1, type: t } });
      expect(extractImageAttachment(meta)).toEqual({ fileKey: 'k', contentType: t });
    }
  });
});
