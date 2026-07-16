/**
 * Phase-3 vision-in: Converse image-block shaping (pure helpers).
 * Pins the content-type→format mapping and that an image is attached
 * to the CURRENT turn (last user message) as a well-formed Converse
 * block — so we never send a malformed image to Bedrock.
 */
import {
  imageFormatFromContentType,
  buildConverseMessages,
} from '../../lambda/src/lib/async-processor-core';

describe('imageFormatFromContentType', () => {
  it('maps the supported image content types', () => {
    expect(imageFormatFromContentType('image/png')).toBe('png');
    expect(imageFormatFromContentType('image/jpeg')).toBe('jpeg');
    expect(imageFormatFromContentType('image/jpg')).toBe('jpeg');
    expect(imageFormatFromContentType('image/gif')).toBe('gif');
    expect(imageFormatFromContentType('image/webp')).toBe('webp');
    expect(imageFormatFromContentType('IMAGE/PNG')).toBe('png');
  });

  it('returns undefined for non-image / unknown / empty', () => {
    expect(imageFormatFromContentType('application/pdf')).toBeUndefined();
    expect(imageFormatFromContentType('text/plain')).toBeUndefined();
    expect(imageFormatFromContentType('')).toBeUndefined();
    expect(imageFormatFromContentType(undefined)).toBeUndefined();
  });
});

describe('buildConverseMessages', () => {
  const msgs = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'user' as const, content: 'current turn' },
  ];

  it('no image → plain text content blocks (unchanged behaviour)', () => {
    const out = buildConverseMessages(msgs);
    expect(out).toEqual([
      { role: 'user', content: [{ text: 'first' }] },
      { role: 'assistant', content: [{ text: 'reply' }] },
      { role: 'user', content: [{ text: 'current turn' }] },
    ]);
  });

  it('attaches the image to the LAST user message only', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = buildConverseMessages(msgs, { format: 'png', bytes });

    expect(out[0].content).toEqual([{ text: 'first' }]); // earlier user untouched
    expect(out[1].content).toEqual([{ text: 'reply' }]); // assistant untouched
    expect(out[2].content).toEqual([
      { text: 'current turn' },
      { image: { format: 'png', source: { bytes } } },
    ]);
  });

  it('drops the image (rather than malforming) when there is no user message', () => {
    const out = buildConverseMessages(
      [{ role: 'assistant', content: 'only assistant' }],
      { format: 'jpeg', bytes: new Uint8Array([9]) },
    );
    expect(out).toEqual([{ role: 'assistant', content: [{ text: 'only assistant' }] }]);
  });
});
