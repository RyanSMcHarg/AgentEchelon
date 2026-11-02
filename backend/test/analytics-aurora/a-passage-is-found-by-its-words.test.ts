/**
 * A passage is found by its words as well as by its meaning.
 *
 * Retrieval fuses a pgvector leg and a lexical leg (`content_tsv`, schema 081) by reciprocal rank
 * fusion. Measured on 2026-10-23: a question about where an exported profile's persona text is stored
 * ranked six passages by embedding similarity and none of the chunks that name `personaRef`, and the
 * model answered wrongly. These pin the three things that fix depends on:
 *
 *   1. the fusion rule: a lexical-only exact identifier hit reaches the top-K, an empty lexical leg
 *      leaves the vector order exactly as it was, and ties resolve the same way every time;
 *   2. the SQL: every read of `embeddings` in the hybrid statement carries the classification filter,
 *      so the lexical leg cannot see, or count, a chunk the vector leg could not;
 *   3. the migration: idempotent and transaction-safe, because it auto-applies at cold start inside
 *      one shared transaction on fresh and existing clusters.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { QueryResult, QueryResultRow } from 'pg';

const mockBedrockSend = jest.fn();
const mockDbQuery = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args) => ({ __type: 'InvokeModel', input: args })),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: mockDbQuery, getClient: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withReaderRole: jest.fn(async (_c: string, fn: (c: unknown) => unknown) =>
    fn({ query: require('../../lambda/src/analytics-aurora/db-client').query })),
}));

import {
  fuseRetrievalLegs,
  retrieveContext,
  type RetrievalCandidate,
} from '../../lambda/src/analytics-aurora/document-retrieval';

const MIGRATION = path.join(
  __dirname, '../../lambda/src/analytics-aurora/schema/081-a-passage-is-found-by-its-words.sql',
);

const OPTS = { topK: 6, minSimilarity: 0.35, minLexicalCoverage: 0.5 };

function candidate(
  sourceId: string,
  chunkIndex: number,
  similarity: number,
  vectorRank: number | null,
  lexicalRank: number | null = null,
  lexicalCoverage: number | null = null,
): RetrievalCandidate {
  return {
    chunk: { sourceId, sourceType: 'agentechelon', title: sourceId, chunkIndex, content: `${sourceId}#${chunkIndex}`, similarity },
    vectorRank,
    lexicalRank,
    lexicalCoverage,
  };
}

const keyOf = (c: { sourceId: string; chunkIndex: number | null }) => `${c.sourceId}#${c.chunkIndex}`;

describe('fuseRetrievalLegs', () => {
  it('puts a lexical-only exact identifier hit into the top-K even when the vector leg fills it', () => {
    // Six vector candidates, all above the floor: vector-only retrieval returns exactly these.
    const vector = [0.62, 0.6, 0.58, 0.55, 0.52, 0.5].map((s, i) => candidate('HOW-TO-ADD-OR-MANAGE-A-PROFILE.md', i, s, i + 1));
    // The chunk naming `personaRef`: the embedding ranks it nowhere and scores it under the floor, the
    // lexical leg ranks it first with most of the query's term weight.
    const personaRef = candidate('SPEC-PORTABLE-PROFILES.md', 14, 0.31, null, 1, 0.82);

    const fused = fuseRetrievalLegs([...vector, personaRef], OPTS);

    expect(fused).toHaveLength(6);
    const hit = fused.find((c) => c.sourceId === 'SPEC-PORTABLE-PROFILES.md');
    expect(hit).toBeDefined();
    expect(hit!.foundBy).toEqual(['lexical']);
    // Its real cosine similarity is reported, not a stand-in.
    expect(hit!.similarity).toBe(0.31);
  });

  it('returns the vector order unchanged when the lexical leg found nothing', () => {
    const vector = [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4].map((s, i) => candidate('doc', i, s, i + 1));
    const fused = fuseRetrievalLegs([...vector].reverse(), OPTS);
    expect(fused.map(keyOf)).toEqual(['doc#0', 'doc#1', 'doc#2', 'doc#3', 'doc#4', 'doc#5']);
    expect(fused.every((c) => c.foundBy?.join() === 'vector')).toBe(true);
  });

  it('keeps the similarity floor for the vector leg, and re-counts ranks without the dropped chunk', () => {
    const fused = fuseRetrievalLegs([
      candidate('a', 0, 0.8, 1),
      candidate('b', 0, 0.2, 2),
      candidate('c', 0, 0.5, 3),
    ], OPTS);
    expect(fused.map(keyOf)).toEqual(['a#0', 'c#0']);
  });

  it('drops a lexical-only hit that shares only low-weight words and sits under the floor', () => {
    const fused = fuseRetrievalLegs([
      candidate('a', 0, 0.7, 1),
      candidate('common-words', 0, 0.12, null, 1, 0.2),
    ], OPTS);
    expect(fused.map(keyOf)).toEqual(['a#0']);
  });

  it('admits a lexical hit that clears the similarity floor whatever its coverage', () => {
    const fused = fuseRetrievalLegs([candidate('lex', 0, 0.4, null, 1, 0.05)], OPTS);
    expect(fused.map((c) => [keyOf(c), c.foundBy])).toEqual([['lex#0', ['lexical']]]);
  });

  it('ranks a chunk both legs found above chunks only one leg found', () => {
    const fused = fuseRetrievalLegs([
      candidate('vector-only', 0, 0.9, 1),
      candidate('lexical-only', 0, 0.3, null, 1, 0.9),
      candidate('both', 0, 0.6, 3, 2, 0.7),
    ], OPTS);
    expect(fused.map(keyOf)).toEqual(['both#0', 'vector-only#0', 'lexical-only#0']);
    expect(fused[0].foundBy).toEqual(['vector', 'lexical']);
  });

  it('breaks ties the same way regardless of input order: vector rank, then lexical rank, then key', () => {
    // vector rank 1 and lexical rank 1 score the same; the vector leg wins the tie.
    const pair = [candidate('lex', 0, 0.3, null, 1, 0.9), candidate('vec', 0, 0.9, 1)];
    expect(fuseRetrievalLegs(pair, OPTS).map(keyOf)).toEqual(['vec#0', 'lex#0']);
    expect(fuseRetrievalLegs([...pair].reverse(), OPTS).map(keyOf)).toEqual(['vec#0', 'lex#0']);

    // Identical ranks in every leg (as two separate retrievals could produce) fall back to the key.
    const twins = [candidate('b', 0, 0.3, null, 1, 0.9), candidate('a', 0, 0.3, null, 1, 0.9)];
    expect(fuseRetrievalLegs(twins, OPTS).map(keyOf)).toEqual(['a#0', 'b#0']);
    expect(fuseRetrievalLegs([...twins].reverse(), OPTS).map(keyOf)).toEqual(['a#0', 'b#0']);
  });

  it('honors topK', () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate('d', i, 0.9 - i * 0.01, i + 1));
    expect(fuseRetrievalLegs(many, { ...OPTS, topK: 3 })).toHaveLength(3);
  });
});

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

describe('the hybrid statement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify({ embedding: new Array(1024).fill(0.1) })),
    });
  });

  async function runAndCapture(query: string): Promise<{ sql: string; params: unknown[] }> {
    mockDbQuery.mockResolvedValueOnce(mockRows([
      {
        source_id: 'SPEC-PORTABLE-PROFILES.md', source_type: 'agentechelon', title: 'Spec', chunk_index: 14,
        content: 'personaRef points at the body store', similarity: 0.31,
        vector_rank: null, lexical_rank: 1, lexical_coverage: 0.9,
      },
    ]));
    const result = await retrieveContext({
      query, sourceTypes: ['agentechelon'], classificationScope: ['basic'], classification: 'basic', topK: 6,
    });
    // One round trip carries both legs.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(result.chunks.map((c) => c.foundBy)).toEqual([['lexical']]);
    const [sql, params] = mockDbQuery.mock.calls[0];
    return { sql, params };
  }

  it('carries the classification filter on every read of embeddings, in both legs', async () => {
    const { sql, params } = await runAndCapture('where is personaRef stored');

    const reads = sql.match(/\b(FROM|JOIN)\s+embeddings\b/g) ?? [];
    // The vector leg, the corpus count, the per-term document count, the lexical leg, the final fetch.
    expect(reads.length).toBe(5);
    const filters = sql.match(/metadata->>'classification' = ANY\(\$3::text\[\]\)/g) ?? [];
    const sourceFilters = sql.match(/source_type = ANY\(\$2::text\[\]\)/g) ?? [];
    expect(filters.length).toBe(reads.length);
    expect(sourceFilters.length).toBe(reads.length);
    expect(params[1]).toEqual(['agentechelon']);
    expect(params[2]).toEqual(['basic']);
  });

  it('tokenizes the query with the same language-neutral configuration as the index', async () => {
    const { sql, params } = await runAndCapture('where is personaRef stored');
    expect(sql).toContain("to_tsvector('simple'::regconfig, $4::text)");
    expect(sql).toContain('content_tsv @@');
    // No language-specific configuration anywhere in the statement.
    expect(sql).not.toMatch(/'(english|german|french|spanish)'/i);
    expect(params[3]).toBe('where is personaRef stored');
  });
});

describe('migration 081', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);

  it('is idempotent: every statement is guarded or replaces in place', () => {
    for (const s of statements) {
      const guarded = /\bIF NOT EXISTS\b/i.test(s) || /^COMMENT ON\b/i.test(s);
      expect({ statement: s.slice(0, 60), guarded }).toEqual({ statement: s.slice(0, 60), guarded: true });
    }
    expect(statements.some((s) => /ADD COLUMN IF NOT EXISTS content_tsv/i.test(s))).toBe(true);
    expect(statements.some((s) => /CREATE INDEX IF NOT EXISTS idx_embeddings_content_tsv[\s\S]*USING gin/i.test(s))).toBe(true);
  });

  it('is transaction-safe: no CONCURRENTLY and no transaction control of its own', () => {
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(/\bCONCURRENTLY\b|\bBEGIN\b|\bCOMMIT\b|\bVACUUM\b/i);
  });

  it('is a generated column, so existing and newly ingested chunks both carry it', () => {
    expect(sql).toMatch(/GENERATED ALWAYS AS \(to_tsvector\('simple'::regconfig, coalesce\(content, ''\)\)\) STORED/);
  });
});
