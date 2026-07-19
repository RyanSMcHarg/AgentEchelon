/**
 * document-retrieval — query embed + pgvector cosine NN + citation shape.
 *
 * Covers:
 *   1. Empty / whitespace query short-circuits without DB or Bedrock
 *   2. Embedding failure returns signalAvailable:false, no DB call
 *   3. Tier-scope filter is applied at SQL level (not post-filter)
 *   4. minSimilarity filters out chunks below threshold
 *   5. Citations deduplicate by sourceId (multiple chunks → one citation)
 *   6. buildRetrievedContextHint shape: [N] markers + sources block
 */

import type { QueryResult, QueryResultRow } from 'pg';

const mockBedrockSend = jest.fn();
const mockDbQuery = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args) => ({ __type: 'InvokeModel', input: args })),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  getClient: jest.fn(),
}));

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

function mockEmbedSuccess(values: number[] = new Array(1024).fill(0.1)) {
  mockBedrockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ embedding: values })),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DRIFT_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
});

describe('retrieveContext', () => {
  it('returns empty for whitespace-only query — no DB, no Bedrock', async () => {
    const { retrieveContext } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const result = await retrieveContext({ query: '   ' });
    expect(result.chunks).toEqual([]);
    expect(result.signalAvailable).toBe(true);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('returns signalAvailable:false when query embedding fails — no DB call', async () => {
    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock blip'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { retrieveContext } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const result = await retrieveContext({ query: 'how do I deploy' });
    warnSpy.mockRestore();
    expect(result.signalAvailable).toBe(false);
    expect(result.chunks).toEqual([]);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('applies the tier-scope filter at SQL level when provided', async () => {
    mockEmbedSuccess();
    mockDbQuery.mockResolvedValueOnce(mockRows<{
      source_id: string; source_type: string; title: string | null; chunk_index: number | null; content: string; similarity: number;
    }>([
      { source_id: 's3://b/rag/wiki/a.md', source_type: 'wiki', title: 'A', chunk_index: 0, content: 'aaa', similarity: 0.9 },
    ]));

    const { retrieveContext } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    await retrieveContext({
      query: 'deploy',
      classificationScope: ['basic', 'standard'],
    });

    const [sql, params] = mockDbQuery.mock.calls[0];
    // Tier filter clause is part of the WHERE, not a post-filter.
    expect(sql).toContain(`metadata->>'tier' = ANY($3::text[])`);
    expect(params[2]).toEqual(['basic', 'standard']);
  });

  it('omits tier filter clause when classificationScope is not provided', async () => {
    mockEmbedSuccess();
    mockDbQuery.mockResolvedValueOnce(mockRows([]));
    const { retrieveContext } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    await retrieveContext({ query: 'deploy' });

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).not.toContain(`metadata->>'tier'`);
    expect(params).toHaveLength(2);
  });

  it('drops chunks below minSimilarity threshold', async () => {
    mockEmbedSuccess();
    mockDbQuery.mockResolvedValueOnce(mockRows([
      { source_id: 'doc-a', source_type: 'wiki', title: 'A', chunk_index: 0, content: 'good match', similarity: 0.8 },
      { source_id: 'doc-b', source_type: 'wiki', title: 'B', chunk_index: 0, content: 'weak match', similarity: 0.2 },
    ]));

    const { retrieveContext } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const result = await retrieveContext({ query: 'deploy', minSimilarity: 0.35 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].sourceId).toBe('doc-a');
  });

  it('deduplicates citations by sourceId across multiple chunks', async () => {
    mockEmbedSuccess();
    mockDbQuery.mockResolvedValueOnce(mockRows([
      { source_id: 'doc-a', source_type: 'wiki', title: 'A', chunk_index: 0, content: 'chunk 1 of A', similarity: 0.9 },
      { source_id: 'doc-a', source_type: 'wiki', title: 'A', chunk_index: 1, content: 'chunk 2 of A', similarity: 0.7 },
      { source_id: 'doc-b', source_type: 'wiki', title: 'B', chunk_index: 0, content: 'chunk 1 of B', similarity: 0.6 },
    ]));

    const { retrieveContext } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const result = await retrieveContext({ query: 'deploy' });
    expect(result.chunks).toHaveLength(3);
    expect(result.citations).toHaveLength(2); // doc-a + doc-b, not 3
    expect(result.citations[0].sourceId).toBe('doc-a');
    expect(result.citations[0].index).toBe(1);
    expect(result.citations[1].sourceId).toBe('doc-b');
    expect(result.citations[1].index).toBe(2);
  });
});

describe('buildRetrievedContextHint', () => {
  it('returns empty string when there are no chunks', async () => {
    const { buildRetrievedContextHint } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    expect(buildRetrievedContextHint({ chunks: [], citations: [], signalAvailable: true })).toBe('');
  });

  it('emits [N] markers on chunks + a Sources block listing titles + similarity', async () => {
    const { buildRetrievedContextHint } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const hint = buildRetrievedContextHint({
      chunks: [
        { sourceId: 'doc-a', sourceType: 'wiki', title: 'A title', chunkIndex: 0, content: 'first chunk text', similarity: 0.9 },
        { sourceId: 'doc-b', sourceType: 'wiki', title: 'B title', chunkIndex: 0, content: 'second chunk text', similarity: 0.7 },
      ],
      citations: [
        { index: 1, sourceId: 'doc-a', title: 'A title', similarity: 0.9 },
        { index: 2, sourceId: 'doc-b', title: 'B title', similarity: 0.7 },
      ],
      signalAvailable: true,
    });
    expect(hint).toContain('## RETRIEVED CONTEXT');
    expect(hint).toContain('[1] first chunk text');
    expect(hint).toContain('[2] second chunk text');
    expect(hint).toContain('### Sources');
    expect(hint).toContain('[1] A title (similarity 0.90)');
    expect(hint).toContain('[2] B title (similarity 0.70)');
  });

  it('renders multiple chunks from the same source under the SAME citation number', async () => {
    const { buildRetrievedContextHint } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const hint = buildRetrievedContextHint({
      chunks: [
        { sourceId: 'doc-a', sourceType: 'wiki', title: 'A', chunkIndex: 0, content: 'first chunk', similarity: 0.9 },
        { sourceId: 'doc-a', sourceType: 'wiki', title: 'A', chunkIndex: 1, content: 'second chunk', similarity: 0.7 },
      ],
      citations: [
        { index: 1, sourceId: 'doc-a', title: 'A', similarity: 0.9 },
      ],
      signalAvailable: true,
    });
    expect(hint).toContain('[1] first chunk');
    expect(hint).toContain('[1] second chunk');
    // Only one source line in the bottom block.
    const sourcesBlock = hint.split('### Sources')[1] ?? '';
    expect((sourcesBlock.match(/\[1\]/g) || []).length).toBe(1);
  });

  it('falls back to sourceId in Sources when title is null', async () => {
    const { buildRetrievedContextHint } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const hint = buildRetrievedContextHint({
      chunks: [
        { sourceId: 's3://bucket/path', sourceType: 'doc', title: null, chunkIndex: 0, content: 'chunk', similarity: 0.5 },
      ],
      citations: [
        { index: 1, sourceId: 's3://bucket/path', title: null, similarity: 0.5 },
      ],
      signalAvailable: true,
    });
    expect(hint).toContain('[1] s3://bucket/path (similarity 0.50)');
  });
});

describe('buildConversationSummaryHint', () => {
  it('returns empty string for missing/blank summary', async () => {
    const { buildConversationSummaryHint } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    expect(buildConversationSummaryHint(undefined)).toBe('');
    expect(buildConversationSummaryHint(null)).toBe('');
    expect(buildConversationSummaryHint('   ')).toBe('');
  });

  it('renders the summary under an EARLIER IN THIS CONVERSATION header', async () => {
    const { buildConversationSummaryHint } = await import('../../lambda/src/analytics-aurora/document-retrieval');
    const hint = buildConversationSummaryHint('User is migrating a workflow and hit an auth error.');
    expect(hint).toContain('## EARLIER IN THIS CONVERSATION');
    expect(hint).toContain('User is migrating a workflow and hit an auth error.');
  });
});
