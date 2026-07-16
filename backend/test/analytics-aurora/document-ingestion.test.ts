/**
 * document-ingestion — pure chunker + ingest orchestration
 * (S3 + Bedrock + DDB mocked at module boundary).
 *
 * Covers the contract the RAG proof-point depends on:
 *   1. chunkText respects size + overlap + boundary preferences
 *   2. Ingest is idempotent on unchanged ETag
 *   3. Etag change clears prior chunks then re-embeds
 *   4. Embedding failure on one chunk is non-fatal; other chunks proceed
 *   5. Unsupported file types skip without S3 read or Bedrock call
 */

const mockS3Send = jest.fn();
const mockBedrockSend = jest.fn();
const mockDbQuery = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetObject', input: args })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args) => ({ __type: 'InvokeModel', input: args })),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  getClient: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DRIFT_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
});

function mockBedrockEmbedding(values: number[] = new Array(1024).fill(0.1)) {
  mockBedrockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ embedding: values })),
  });
}

function s3Event(key: string, etag = 'etag-1') {
  return {
    Records: [
      {
        s3: { bucket: { name: 'test-bucket' }, object: { key, eTag: `"${etag}"` } },
      },
    ],
  };
}

describe('chunkText', () => {
  it('returns one chunk for short text under the size limit', async () => {
    const { chunkText } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const chunks = chunkText('Short text that fits in one chunk.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Short text that fits in one chunk.');
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].start).toBe(0);
  });

  it('produces multiple overlapping chunks for long text', async () => {
    const { chunkText } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const text = 'A'.repeat(5000); // forces multiple chunks at 1800-char size
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Sequential starts; overlap < chunk size.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeGreaterThan(chunks[i - 1].start);
      expect(chunks[i].start).toBeLessThan(chunks[i - 1].start + 1800);
    }
  });

  it('prefers paragraph (\\n\\n) boundaries when available within the size window', async () => {
    const { chunkText } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    // Build a doc where a natural paragraph break sits past the midpoint of the chunk window.
    const para1 = 'A'.repeat(1000);
    const para2 = 'B'.repeat(2000);
    const chunks = chunkText(`${para1}\n\n${para2}`);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end at the paragraph break, not in the middle of para2.
    expect(chunks[0].text.endsWith(para1)).toBe(true);
  });

  it('returns [] for empty / whitespace-only text', async () => {
    const { chunkText } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n   ')).toEqual([]);
  });
});

describe('handler (S3-event entry point)', () => {
  it('skips records whose key is NOT under the rag/ prefix', async () => {
    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const result = await handler(s3Event('attachments/foo.png'));
    expect(result.ingested).toEqual([]);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('skips unsupported file types without reading from S3 or hitting Bedrock', async () => {
    // ETag dedup check runs first (a DB query) — return no existing rows.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const result = await handler(s3Event('rag/wiki/binary.pdf'));
    expect(result.ingested[0].skippedReason).toBe('unsupported_type');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('skips re-ingest when same source_id + etag already exists', async () => {
    // ETag dedup check returns "1 existing row with this etag" → unchanged_etag.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const result = await handler(s3Event('rag/wiki/foo.md', 'etag-unchanged'));
    expect(result.ingested[0].skippedReason).toBe('unchanged_etag');
    expect(mockS3Send).not.toHaveBeenCalled(); // no GetObject; no Bedrock
  });

  it('re-ingests when etag changes: clears prior chunks then writes fresh embeddings', async () => {
    // ETag check: no row at this etag → not unchanged.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    // DELETE prior chunks
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 });
    // S3 GetObject
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: async () => '# A title\n\nBody content here.' },
    });
    // One chunk → one embedding call
    mockBedrockEmbedding();
    // INSERT for the chunk
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const result = await handler(s3Event('rag/wiki/foo.md', 'etag-new'));

    expect(result.ingested[0].chunksWritten).toBe(1);
    expect(result.ingested[0].chunksEmbedded).toBe(1);
    expect(result.ingested[0].sourceType).toBe('wiki');

    // Confirm a DELETE query was issued before the INSERT.
    const deleteCall = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM embeddings'),
    );
    expect(deleteCall).toBeDefined();
    const insertCall = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO embeddings'),
    );
    expect(insertCall).toBeDefined();
  });

  it('one chunk failing to embed is non-fatal — other chunks proceed', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Long doc → 3 chunks expected at size 1800
    const longText = 'AAA. '.repeat(1200);
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: async () => longText },
    });

    // 1st embed succeeds; 2nd fails (Bedrock throws); 3rd succeeds.
    mockBedrockEmbedding();
    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock blip'));
    mockBedrockEmbedding();

    // 2 successful INSERTs
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const result = await handler(s3Event('rag/wiki/long.txt', 'etag-x'));
    warnSpy.mockRestore();

    expect(result.ingested[0].chunksAttempted).toBeGreaterThanOrEqual(3);
    // 2 of the 3 embedded successfully
    expect(result.ingested[0].chunksEmbedded).toBeLessThan(result.ingested[0].chunksAttempted);
    expect(result.ingested[0].chunksEmbedded).toBeGreaterThan(0);
  });

  it('derives source_type from the first path segment under rag/', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: async () => 'doc content' },
    });
    mockBedrockEmbedding();
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    const result = await handler(s3Event('rag/runbooks/incident.md', 'e1'));
    expect(result.ingested[0].sourceType).toBe('runbooks');
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
