/**
 * persistImageGenOutput (Phase 4C-ii). Pins the honest no-image path
 * (images:[] ⇒ zero S3 calls, no placeholder), the upload shape
 * (PutObject bucket/key/PNG/SSE + decoded body + provenance metadata),
 * deterministic keying, presign (bucket,key,ttl), and required-arg
 * validation. Mirrors attachment-bytes.test.ts: structural fake +
 * virtual SDK command mocks (no aws-sdk-client-mock, no real signing).
 */
const mockS3Send = jest.fn();
jest.mock(
  '@aws-sdk/client-s3',
  () => ({
    PutObjectCommand: jest.fn().mockImplementation((args) => ({ __t: 'Put', input: args })),
    GetObjectCommand: jest.fn().mockImplementation((args) => ({ __t: 'Get', input: args })),
    S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  }),
  { virtual: true },
);
jest.mock(
  '@aws-sdk/s3-request-presigner',
  () => ({ getSignedUrl: jest.fn() }),
  { virtual: true },
);

import {
  persistImageGenOutput,
  buildBattleImageContent,
  BATTLE_IMAGE_MARKER_PREFIX,
} from '../../lambda/src/lib/image-gen-output';

const s3 = { send: mockS3Send };
const ARN = 'arn:aws:chime:us-east-1:1:app-instance/x/channel/chan-1';
const FIXED = () => new Date('2026-05-16T00:00:00.000Z');
const TS = '2026-05-16T00-00-00-000Z';
const presign = jest.fn(async (b: string, k: string, t: number) => `signed:${k}:${t}`);

beforeEach(() => {
  mockS3Send.mockReset();
  presign.mockClear();
});

describe('persistImageGenOutput', () => {
  it('honest no-image path: images:[] ⇒ nothing persisted, zero S3/presign calls', async () => {
    const out = await persistImageGenOutput({
      images: [],
      bucket: 'b',
      channelArn: ARN,
      modelId: 'amazon.titan-image-generator-v2:0',
      s3,
      presign,
    });
    expect(out).toEqual({ persisted: [] });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(presign).not.toHaveBeenCalled();
  });

  it('uploads a PNG with SSE + provenance metadata and presigns it', async () => {
    mockS3Send.mockResolvedValueOnce({});
    const b64 = Buffer.from('PNGBYTES').toString('base64');

    const out = await persistImageGenOutput({
      images: [b64],
      bucket: 'battle-bkt',
      channelArn: ARN,
      modelId: 'amazon.nova-canvas-v1:0',
      urlTtlSeconds: 900,
      s3,
      presign,
      now: FIXED,
    });

    const key = `battle-images/chan-1/${TS}-0.png`;
    expect(out).toEqual({ persisted: [{ key, url: `signed:${key}:900` }] });

    const cmd = mockS3Send.mock.calls[0][0];
    expect(cmd.__t).toBe('Put');
    expect(cmd.input.Bucket).toBe('battle-bkt');
    expect(cmd.input.Key).toBe(key);
    expect(cmd.input.ContentType).toBe('image/png');
    expect(cmd.input.ServerSideEncryption).toBe('AES256');
    expect(Buffer.isBuffer(cmd.input.Body)).toBe(true);
    expect((cmd.input.Body as Buffer).toString()).toBe('PNGBYTES'); // base64-decoded
    expect(cmd.input.Metadata).toMatchObject({
      channelArn: ARN,
      modelId: 'amazon.nova-canvas-v1:0',
    });
    expect(presign).toHaveBeenCalledWith('battle-bkt', key, 900);
  });

  it('persists multiple images with stable per-index keys', async () => {
    mockS3Send.mockResolvedValue({});
    const out = await persistImageGenOutput({
      images: ['QQ==', 'Qg=='],
      bucket: 'b',
      channelArn: ARN,
      modelId: 'm',
      s3,
      presign,
      now: FIXED,
    });
    expect(out.persisted.map((p) => p.key)).toEqual([
      `battle-images/chan-1/${TS}-0.png`,
      `battle-images/chan-1/${TS}-1.png`,
    ]);
    expect(mockS3Send).toHaveBeenCalledTimes(2);
    expect(presign).toHaveBeenCalledTimes(2);
  });

  it('skips empty/non-string entries; all-empty ⇒ honest [] (no S3 call)', async () => {
    const out = await persistImageGenOutput({
      images: ['', null as unknown as string, undefined as unknown as string],
      bucket: 'b',
      channelArn: ARN,
      modelId: 'm',
      s3,
      presign,
    });
    expect(out).toEqual({ persisted: [] });
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('rejects missing bucket/channelArn without an S3 call', async () => {
    await expect(
      persistImageGenOutput({ images: ['x'], bucket: '', channelArn: ARN, modelId: 'm', s3, presign }),
    ).rejects.toThrow(/required/);
    await expect(
      persistImageGenOutput({ images: ['x'], bucket: 'b', channelArn: '', modelId: 'm', s3, presign }),
    ).rejects.toThrow(/required/);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe('buildBattleImageContent', () => {
  it('persisted image → human line + JSON marker (urls/modelId/count)', () => {
    const content = buildBattleImageContent({
      persisted: [{ key: 'k', url: 'https://s3/signed?X-Amz-Signature=ab=cd&y,z' }],
      modelId: 'amazon.nova-canvas-v1:0',
      displayName: 'Amazon Nova Canvas',
      guardrailIntervened: false,
    });
    expect(content).toContain('Generated an image with Amazon Nova Canvas.');
    expect(content).toContain(BATTLE_IMAGE_MARKER_PREFIX);

    // URL has =,&, — only a JSON-in-marker (not key=val) survives this.
    const json = content.slice(
      content.indexOf(BATTLE_IMAGE_MARKER_PREFIX) + BATTLE_IMAGE_MARKER_PREFIX.length,
      content.lastIndexOf('-->'),
    );
    expect(JSON.parse(json)).toEqual({
      urls: ['https://s3/signed?X-Amz-Signature=ab=cd&y,z'],
      modelId: 'amazon.nova-canvas-v1:0',
      count: 1,
    });
  });

  it('pluralises and counts multiple images', () => {
    const content = buildBattleImageContent({
      persisted: [
        { key: 'a', url: 'u1' },
        { key: 'b', url: 'u2' },
      ],
      modelId: 'm',
      displayName: 'Titan',
      guardrailIntervened: false,
    });
    expect(content).toContain('Generated 2 images with Titan.');
    const json = content.slice(
      content.indexOf(BATTLE_IMAGE_MARKER_PREFIX) + BATTLE_IMAGE_MARKER_PREFIX.length,
      content.lastIndexOf('-->'),
    );
    expect(JSON.parse(json).count).toBe(2);
  });

  it('no images + guardrail intervened → honest withheld line, NO marker', () => {
    const content = buildBattleImageContent({
      persisted: [],
      modelId: 'm',
      guardrailIntervened: true,
    });
    expect(content).toMatch(/withheld by the content filter/i);
    expect(content).not.toContain(BATTLE_IMAGE_MARKER_PREFIX);
  });

  it('no images + no guardrail → honest failure line, NO marker (never fabricated)', () => {
    const content = buildBattleImageContent({
      persisted: [],
      modelId: 'm',
      guardrailIntervened: false,
    });
    expect(content).toMatch(/generation failed/i);
    expect(content).not.toContain(BATTLE_IMAGE_MARKER_PREFIX);
  });
});
