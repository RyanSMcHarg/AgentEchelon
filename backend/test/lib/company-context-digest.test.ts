/**
 * Company-context DIGEST (ADR-017):
 *   - buildDigestHint renders the always-present manifest (or empty).
 *   - loadCompanyContext SKIPS `_`-prefixed keys, so `_digest.json` is never
 *     loaded as a company document (that would pollute the corpus).
 *   - loadContextDigest reads + parses the per-classification digest and caches it warm.
 */

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ __type: 'List', input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'Get', input })),
}));

import {
  buildDigestHint,
  loadCompanyContext,
  loadContextDigest,
  __clearDigestCache,
  type DigestEntry,
} from '../../lambda/src/lib/company-context';

const BUCKET = 'test-bucket';

beforeEach(() => {
  jest.clearAllMocks();
  __clearDigestCache();
});

describe('buildDigestHint', () => {
  it('returns empty string for no entries', () => {
    expect(buildDigestHint([])).toBe('');
  });

  it('renders titles + descriptions under an AVAILABLE COMPANY CONTEXT header', () => {
    const entries: DigestEntry[] = [
      { title: 'Financial data', description: 'Quarterly ARR and churn', classification: 'premium' },
      { title: 'Company overview', description: 'Profile and products', classification: 'basic' },
    ];
    const hint = buildDigestHint(entries);
    expect(hint).toContain('## AVAILABLE COMPANY CONTEXT');
    expect(hint).toContain('- Financial data: Quarterly ARR and churn');
    expect(hint).toContain('- Company overview: Profile and products');
  });
});

describe('loadCompanyContext skips `_`-prefixed files', () => {
  it('does not load `_digest.json` as a company document', async () => {
    mockS3Send.mockImplementation((cmd: { __type: string; input: { Prefix?: string; Key?: string } }) => {
      if (cmd.__type === 'List') {
        // Only the basic prefix has content; it includes the digest file.
        if (cmd.input.Prefix === 'context/basic/') {
          return Promise.resolve({
            Contents: [
              { Key: 'context/basic/company-public.json' },
              { Key: 'context/basic/_digest.json' },
            ],
          });
        }
        return Promise.resolve({ Contents: [] });
      }
      // GetObject: only the real document should ever be fetched.
      return Promise.resolve({
        Body: { transformToString: async () => '{"company":"Stratum"}' },
      });
    });

    const result = await loadCompanyContext(BUCKET);
    const sources = result.documents.map((d) => d.source);
    expect(sources).toEqual(['context/basic/company-public.json']);
    expect(sources).not.toContain('context/basic/_digest.json');
    // GetObject must never have been called for the digest file.
    const getKeys = mockS3Send.mock.calls
      .map((c) => c[0])
      .filter((cmd: { __type: string }) => cmd.__type === 'Get')
      .map((cmd: { input: { Key: string } }) => cmd.input.Key);
    expect(getKeys).not.toContain('context/basic/_digest.json');
  });
});

describe('loadContextDigest', () => {
  it('reads + parses the per-classification digest and caches it warm', async () => {
    const digest: DigestEntry[] = [
      { title: 'Financial data', description: 'ARR', classification: 'premium' },
    ];
    mockS3Send.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify(digest) },
    });

    const first = await loadContextDigest(BUCKET, 'premium');
    expect(first).toEqual(digest);
    // Second call is served from the warm cache — no extra S3 fetch.
    const second = await loadContextDigest(BUCKET, 'premium');
    expect(second).toEqual(digest);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the digest is missing', async () => {
    mockS3Send.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    expect(await loadContextDigest(BUCKET, 'basic')).toEqual([]);
  });
});
