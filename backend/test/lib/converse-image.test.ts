/**
 * Phase-3 vision-in: Converse image-block shaping (pure helpers).
 * Pins the content-type→format mapping and that an image is attached
 * to the CURRENT turn (last user message) as a well-formed Converse
 * block — so we never send a malformed image to Bedrock.
 */
import {
  imageFormatFromContentType,
  buildConverseMessages,
  consolidateConsecutiveMessages,
  resolveHistoryImageBlocks,
  type ConversationMessage,
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

  // Vision-through-conversation with perspective-based roles: another participant (human OR another
  // assistant, e.g. a battle rival) is a USER turn, so its image renders inline (Bedrock permits image
  // blocks only on user turns). The model's OWN prior turn is an ASSISTANT turn - its image is skipped
  // (it need not re-perceive its own output, and an assistant-turn image block is invalid).
  it('renders an image inline on a user turn (other participant) and skips an assistant-turn image', () => {
    const selfBytes = new Uint8Array([7, 8, 9]);
    const rivalBytes = new Uint8Array([4, 5, 6]);
    const out = buildConverseMessages([
      { role: 'user', content: 'prompt' },
      {
        role: 'assistant',
        content: 'my answer',
        images: [{ fileKey: 'battle-images/c/self-0.png', contentType: 'image/png', bytes: selfBytes }],
      },
      {
        role: 'user',
        content: 'rival answer',
        images: [{ fileKey: 'battle-images/c/rival-0.png', contentType: 'image/png', bytes: rivalBytes }],
      },
    ]);
    // Self (assistant) turn keeps only its text.
    expect(out[1].content).toEqual([{ text: 'my answer' }]);
    // The other participant's (user turn) image renders inline.
    expect(out[2].content).toEqual([
      { text: 'rival answer' },
      { image: { format: 'png', source: { bytes: rivalBytes } } },
    ]);
    expect(out[0].content).toEqual([{ text: 'prompt' }]);
  });

  it('skips an unresolved (no-bytes) or unusable-format history image (never a malformed block)', () => {
    const out = buildConverseMessages([
      {
        role: 'assistant',
        content: 'no bytes yet',
        images: [{ fileKey: 'k1', contentType: 'image/png' }], // not fetched
      },
      {
        role: 'assistant',
        content: 'bad format',
        images: [{ fileKey: 'k2', contentType: 'application/pdf', bytes: new Uint8Array([1]) }],
      },
    ]);
    expect(out[0].content).toEqual([{ text: 'no bytes yet' }]);
    expect(out[1].content).toEqual([{ text: 'bad format' }]);
  });

  it('renders MULTIPLE images inline on a user turn (other participant); assistant-turn images skipped', () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    const selfImg = new Uint8Array([9]);
    const out = buildConverseMessages([
      {
        role: 'assistant',
        content: 'my image',
        images: [{ fileKey: 'k0', contentType: 'image/png', bytes: selfImg }],
      },
      {
        role: 'user',
        content: 'two images',
        images: [
          { fileKey: 'k1', contentType: 'image/png', bytes: a },
          { fileKey: 'k2', contentType: 'image/jpeg', bytes: b },
        ],
      },
    ]);
    expect(out[0].content).toEqual([{ text: 'my image' }]);
    expect(out[1].content).toEqual([
      { text: 'two images' },
      { image: { format: 'png', source: { bytes: a } } },
      { image: { format: 'jpeg', source: { bytes: b } } },
    ]);
  });
});

// consolidateConsecutiveMessages must preserve image attachments from EVERY merged message, so an
// image battle (both bots' round-1 image messages are consecutive assistant turns) does not lose one
// side's image when the turns are combined into a single Bedrock-legal assistant block.
describe('consolidateConsecutiveMessages preserves images across merges', () => {
  it('concatenates image arrays from consecutive same-role messages', () => {
    const merged = consolidateConsecutiveMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'A', images: [{ fileKey: 'kA', contentType: 'image/png' }] },
      { role: 'assistant', content: 'B', images: [{ fileKey: 'kB', contentType: 'image/png' }] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1].content).toBe('A\n\nB');
    expect(merged[1].images).toEqual([
      { fileKey: 'kA', contentType: 'image/png' },
      { fileKey: 'kB', contentType: 'image/png' },
    ]);
  });

  it('does not mutate the original message image arrays', () => {
    const first = { role: 'assistant' as const, content: 'A', images: [{ fileKey: 'kA', contentType: 'image/png' }] };
    consolidateConsecutiveMessages([
      first,
      { role: 'assistant', content: 'B', images: [{ fileKey: 'kB', contentType: 'image/png' }] },
    ]);
    expect(first.images).toHaveLength(1); // untouched (copied, not aliased)
  });
});

// resolveHistoryImageBlocks: the bounded fetch that turns history image METADATA into resolved bytes
// (so buildConverseMessages can render them). Fetch is guarded and bounded for cost/latency.
describe('resolveHistoryImageBlocks', () => {
  function fakeS3(bytesByKey: Record<string, Uint8Array | Error>) {
    return {
      send: jest.fn(async (cmd: { input?: { Key?: string } } | unknown) => {
        // GetObjectCommand is mocked as identity elsewhere; read the key defensively.
        const key = (cmd as { Key?: string; input?: { Key?: string } }).Key
          ?? (cmd as { input?: { Key?: string } }).input?.Key
          ?? '';
        const v = bytesByKey[key];
        if (v instanceof Error) throw v;
        return { Body: { transformToByteArray: async () => v } };
      }),
    };
  }

  it('attaches bytes to a recent history image and returns the count', async () => {
    const bytes = new Uint8Array([5, 5, 5]);
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'img', images: [{ fileKey: 'battle-images/c/ts-0.png', contentType: 'image/png' }] },
      { role: 'user', content: 'rebut' },
    ];
    const s3 = fakeS3({ 'battle-images/c/ts-0.png': bytes });
    const n = await resolveHistoryImageBlocks({ messages, s3: s3 as never, bucket: 'attach-bucket' });
    expect(n).toBe(1);
    expect(messages[1].images![0].bytes).toBe(bytes);
  });

  it('caps the number of images attached (cost/latency guard)', async () => {
    const messages: ConversationMessage[] = [
      {
        role: 'assistant',
        content: 'three',
        images: [
          { fileKey: 'k1', contentType: 'image/png' },
          { fileKey: 'k2', contentType: 'image/png' },
          { fileKey: 'k3', contentType: 'image/png' },
        ],
      },
    ];
    const s3 = fakeS3({ k1: new Uint8Array([1]), k2: new Uint8Array([2]), k3: new Uint8Array([3]) });
    const n = await resolveHistoryImageBlocks({ messages, s3: s3 as never, bucket: 'b', maxImages: 2 });
    expect(n).toBe(2);
    expect(messages[0].images![2].bytes).toBeUndefined(); // 3rd never fetched
  });

  it('degrades (skips) on a fetch failure without throwing', async () => {
    const messages: ConversationMessage[] = [
      { role: 'assistant', content: 'img', images: [{ fileKey: 'boom', contentType: 'image/png' }] },
    ];
    const s3 = fakeS3({ boom: new Error('s3 down') });
    const n = await resolveHistoryImageBlocks({ messages, s3: s3 as never, bucket: 'b' });
    expect(n).toBe(0);
    expect(messages[0].images![0].bytes).toBeUndefined();
  });

  it('is a no-op with no bucket or no images', async () => {
    const s3 = fakeS3({});
    expect(await resolveHistoryImageBlocks({ messages: [], s3: s3 as never, bucket: '' })).toBe(0);
    const noImg = [{ role: 'user' as const, content: 'hi' }];
    expect(await resolveHistoryImageBlocks({ messages: noImg, s3: s3 as never, bucket: 'b' })).toBe(0);
    expect(s3.send).not.toHaveBeenCalled();
  });
});
