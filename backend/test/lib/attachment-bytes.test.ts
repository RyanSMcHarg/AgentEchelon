/**
 * fetchAttachmentBytes (Phase-3 vision-in S3 read). Pins: GetObject is
 * issued for the right bucket/key, the SDK stream is transformed to
 * bytes, and a missing/streamless body throws (so the caller can fall
 * back to the reject path rather than send a malformed image).
 */
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: jest.fn().mockImplementation((args) => ({ __t: 'Get', input: args })),
}), { virtual: true });

import { fetchAttachmentBytes, senderOwnsAttachmentKey } from '../../lambda/src/lib/attachment-bytes';

const s3 = { send: mockS3Send };

beforeEach(() => mockS3Send.mockReset());

describe('fetchAttachmentBytes', () => {
  it('GETs the bucket/key and returns the transformed bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockS3Send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => bytes } });

    const out = await fetchAttachmentBytes(s3, 'attachments-bkt', 'attachments/c/u/pic.png');

    expect(out).toBe(bytes);
    const cmd = mockS3Send.mock.calls[0][0];
    expect(cmd.__t).toBe('Get');
    expect(cmd.input).toEqual({ Bucket: 'attachments-bkt', Key: 'attachments/c/u/pic.png' });
  });

  it('throws when the object has no readable body', async () => {
    mockS3Send.mockResolvedValueOnce({});
    await expect(fetchAttachmentBytes(s3, 'b', 'k')).rejects.toThrow(/no readable body/);
  });

  it('throws when Body lacks transformToByteArray', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: {} });
    await expect(fetchAttachmentBytes(s3, 'b', 'k')).rejects.toThrow(/no readable body/);
  });

  it('rejects missing bucket/key without an S3 call', async () => {
    await expect(fetchAttachmentBytes(s3, '', 'k')).rejects.toThrow(/required/);
    await expect(fetchAttachmentBytes(s3, 'b', '')).rejects.toThrow(/required/);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe('senderOwnsAttachmentKey (attachment-in object-level authz)', () => {
  // Chime AppInstanceUser ARN; the sub is the segment after `/user/`.
  const SENDER = 'arn:aws:chime:us-east-1:1:app-instance/app/user/sub-alice';
  const OWN_KEY = 'attachments/conv-1/sub-alice/1700000000-report.pdf';

  it('accepts a key under the sender own prefix', () => {
    expect(senderOwnsAttachmentKey(OWN_KEY, SENDER)).toBe(true);
  });

  it("rejects another user's file (the cross-user IDOR this guards)", () => {
    const victimKey = 'attachments/conv-9/sub-victim/1700000000-secret.pdf';
    expect(senderOwnsAttachmentKey(victimKey, SENDER)).toBe(false);
  });

  it('rejects keys outside the attachments/ prefix', () => {
    expect(senderOwnsAttachmentKey('context/standard/sub-alice/x.json', SENDER)).toBe(false);
    expect(senderOwnsAttachmentKey('generated-docs/conv/sub-alice/x.md', SENDER)).toBe(false);
  });

  it('fails closed on a missing/malformed sender ARN or a too-short key', () => {
    expect(senderOwnsAttachmentKey(OWN_KEY, undefined)).toBe(false);
    expect(senderOwnsAttachmentKey(OWN_KEY, 'arn-with-no-user-segment')).toBe(false);
    expect(senderOwnsAttachmentKey(undefined, SENDER)).toBe(false);
    expect(senderOwnsAttachmentKey('attachments/only/two', SENDER)).toBe(false);
  });
});
