/**
 * Profile bodies in S3, keyed by configId (SPEC-PORTABLE-PROFILES, "Where it lives").
 *
 * The properties that make the indirection safe, rather than that the SDK was called:
 *  - the key is content-addressed, so a version's body is immutable and a rollback re-points rather
 *    than rewrites;
 *  - a pointer whose configId disagrees with the version being resolved is an ERROR, never a fallback -
 *    serving it would answer with another version's persona while reporting this version's id;
 *  - an absent object returns undefined so a definition written before the indirection (inline persona)
 *    still resolves;
 *  - a write with no bucket configured THROWS rather than silently keeping the body inline, which would
 *    re-impose the 4096-character definition cap this exists to remove.
 */
import { bodyKey, putBody, getBody, type ProfileBodyRef } from '../../lambda/src/lib/profile-bodies';

const sent: any[] = [];
const fakeS3 = (impl?: (cmd: any) => any) => ({
  send: jest.fn(async (cmd: any) => {
    sent.push(cmd);
    return impl ? impl(cmd) : {};
  }),
}) as any;

beforeEach(() => {
  sent.length = 0;
  delete process.env.PROFILE_BODY_BUCKET;
  delete process.env.CONTEXT_BUCKET;
});

describe('key shape', () => {
  it('is content-addressed by configId, so two versions never collide', () => {
    const a = bodyKey('premium', 'abc123', 'persona');
    const b = bodyKey('premium', 'def456', 'persona');
    expect(a).not.toBe(b);
    expect(a).toContain('abc123');
    expect(a.startsWith('profiles/premium/')).toBe(true);
  });

  it('separates fields within a version', () => {
    expect(bodyKey('premium', 'abc123', 'persona'))
      .not.toBe(bodyKey('premium', 'abc123', 'intentPack'));
  });
});

describe('putBody', () => {
  it('writes to the content-addressed key and returns a pointer carrying the configId', async () => {
    const ref = await putBody('premium', 'abc123', 'persona', 'You are…', { s3: fakeS3(), bucket: 'b' });
    expect(ref).toEqual({ key: 'profiles/premium/abc123/persona', configId: 'abc123' });
    expect(sent[0].input.Bucket).toBe('b');
    expect(sent[0].input.Key).toBe('profiles/premium/abc123/persona');
    expect(sent[0].input.Body).toBe('You are…');
  });

  it('THROWS when no bucket is configured rather than silently keeping the body inline', async () => {
    // The silent-skip version of this would re-impose the 4096 definition cap, and the failure would
    // surface much later as an unstorable definition rather than here.
    await expect(putBody('premium', 'abc123', 'persona', 'x', { s3: fakeS3() }))
      .rejects.toThrow(/no body bucket configured/i);
  });

  it('is idempotent for the same version: same key, same bytes', async () => {
    const s3 = fakeS3();
    const a = await putBody('premium', 'abc123', 'persona', 'same', { s3, bucket: 'b' });
    const b = await putBody('premium', 'abc123', 'persona', 'same', { s3, bucket: 'b' });
    expect(a).toEqual(b);
    expect(sent[0].input.Key).toBe(sent[1].input.Key);
  });
});

describe('getBody', () => {
  const ref: ProfileBodyRef = { key: 'profiles/premium/abc123/persona', configId: 'abc123' };

  it('returns the stored body', async () => {
    const s3 = fakeS3(() => ({ Body: { transformToString: async () => 'You are…' } }));
    await expect(getBody(ref, 'abc123', { s3, bucket: 'b' })).resolves.toBe('You are…');
  });

  it('REFUSES a pointer from a different version instead of serving it', async () => {
    // The dangerous case: the assistant would answer with another version's persona while the turn is
    // attributed to this version, so the experiment or rollback reads as something it is not.
    await expect(getBody(ref, 'different', { s3: fakeS3(), bucket: 'b' }))
      .rejects.toThrow(/mismatch/i);
  });

  it('returns undefined for an absent object, so an inline-persona definition still resolves', async () => {
    const s3 = fakeS3(() => { throw Object.assign(new Error('nope'), { name: 'NoSuchKey' }); });
    await expect(getBody(ref, 'abc123', { s3, bucket: 'b' })).resolves.toBeUndefined();
  });

  it('propagates a non-404 failure rather than masking it as "no body"', async () => {
    // AccessDenied must not look like "this version has no persona" - that would silently serve the
    // deployment default and read as a profile that lost its character.
    const s3 = fakeS3(() => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); });
    await expect(getBody(ref, 'abc123', { s3, bucket: 'b' })).rejects.toThrow(/denied/i);
  });
});
