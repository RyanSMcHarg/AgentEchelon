/**
 * Unit tests for cross-conversation context module
 *
 * Tests related conversation lookup and context update logic.
 * Mocks the database client.
 */

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
}));

// ADR-028: `cross_conversation_context` is a bounded table as of migration 068, so its reads run as a
// classification's reader role and its writes as the write role. Route both back to the mocked
// `query` so the SQL assertions are unchanged, and record which role was assumed - a statement that
// reaches the right table as the WRONG role is precisely what this design prevents, and it is
// invisible in the SQL text.
const mockAssumedRoles: string[] = [];
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withReaderRole: jest.fn(async (classification: string, fn: (c: unknown) => unknown) => {
    mockAssumedRoles.push(`ae_reader_${classification}`);
    return fn({ query: require('../../lambda/src/analytics-aurora/db-client').query });
  }),
  withWriterRole: jest.fn(async (fn: (c: unknown) => unknown) => {
    mockAssumedRoles.push('ae_writer');
    return fn({ query: require('../../lambda/src/analytics-aurora/db-client').query });
  }),
}));

// ADR-004 surface 3: the lookup tries a cosine-NN over `summary_embeddings` before falling back to
// keyword matching, so it needs an embedding of the topic. MOCKED, for two reasons: an unmocked
// `embedText` reaches for Bedrock on every case here - slow, and dependent on credentials a unit test
// must not need - and the choice between the two paths is exactly what these tests want to control.
//
// DEFAULT IS `null`, which means "no embedding available" and sends every existing case down the
// keyword path it was written for. A case that wants the vector path sets `mockEmbedding`.
let mockEmbedding: number[] | null = null;
jest.mock('../../lambda/src/analytics-aurora/embed-text', () => ({
  embedText: jest.fn(async () => mockEmbedding),
  toPgVector: (v: readonly number[]) => `[${v.join(',')}]`,
  EMBEDDING_TIMEOUT_LIVE_MS: 500,
  EMBEDDING_TIMEOUT_ASYNC_MS: 5000,
  EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
  EMBEDDING_DIM: 1024,
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockQueryResult(rows: any[], rowCount?: number) {
  return { rows, rowCount: rowCount ?? rows.length, command: '', oid: 0, fields: [] as any[] };
}

/**
 * THE CALL THAT DID A GIVEN THING, FOUND BY WHAT IT SAYS - NOT BY ITS POSITION.
 *
 * These assertions used to index `mock.calls[1]`, and the 1 was load-bearing: call 0 was a probe
 * counting `embeddings WHERE source_type = 'conversation_context'`, which was dead three ways over
 * and has been deleted (ADR-004 surface 3). Every one of those assertions broke on a change that
 * removed a statement doing nothing, because the index encoded the dead call's existence.
 *
 * Ordering is not derivation. Selecting by SQL content means adding or removing a statement cannot
 * silently repoint an assertion at a different query.
 */
function callMatching(pattern: RegExp): [string, unknown[]] {
  const found = mockedQuery.mock.calls.find((c) => pattern.test(String(c[0])));
  if (!found) {
    throw new Error(
      `no query matched ${pattern}. Calls were:\n`
      + mockedQuery.mock.calls.map((c, i) => `  [${i}] ${String(c[0]).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n'),
    );
  }
  return found as [string, unknown[]];
}

/** The keyword read: over `cross_conversation_context`, with no vector term. */
const keywordCall = () => callMatching(/FROM cross_conversation_context/);

/** The semantic read: the cosine-NN over `summary_embeddings`. */
const vectorCall = () => callMatching(/FROM summary_embeddings/);


/** A resolved scope, as resolveScopedChannelArns returns it. Every read needs one. */
const SCOPE = ['channel-1', 'channel-2'];

/** The serving assistant's classification. Its reader role runs every read below. */
const CLASSIFICATION = 'standard';

describe('Cross-Conversation Context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Back to "no embedding", so a case that opts into the vector path cannot leak into the next.
    mockEmbedding = null;
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'analytics';
    process.env.DB_USER = 'testuser';
    process.env.DB_REGION = 'us-east-1';
  });

  /**
   * THE SCOPE IS THE ACCESS CONTROL FOR THIS READ, SO IT IS TESTED LIKE ONE.
   *
   * These rows live in Aurora, where no Amazon Chime SDK membership check applies. Scoping by
   * `person_id` alone answers "every conversation this person ever had", including ones the serving
   * assistant was never added to - and because an assistant is bound to one classification (ADR-042),
   * that is also how content crosses a classification boundary: two people sharing a basic and a
   * premium channel would let the premium assistant reach the basic one.
   *
   * `lib/scoped-channels.ts` resolves the scope as the intersection of every current human member AND
   * the serving assistant's own ARN, and answers `[]` for every case it cannot settle. These assert
   * that "suggest nothing" survives the trip, and that the filter reaches the SQL rather than only the
   * signature - a scope accepted and then not applied is the worse of the two failures, because it
   * looks handled.
   */
  describe('the scope this read cannot run without', () => {
    const load = () => import('../../lambda/src/analytics-aurora/cross-conversation-context');

    it('returns nothing when the scope is empty, rather than everything', async () => {
      const { findRelatedConversations } = await load();
      expect(await findRelatedConversations('user-sub-123', 'product management', [], CLASSIFICATION)).toEqual([]);
      // AND IT ASKED THE DATABASE NOTHING. Returning [] after running an unscoped query would leak
      // into logs and cost, and would mean the guard sat after the disclosure rather than before it.
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it('returns nothing when the scope is absent or malformed', async () => {
      const { findRelatedConversations } = await load();
      for (const bad of [undefined, null, 'channel-1', {}] as unknown as string[][]) {
        expect(await findRelatedConversations('u', 't', bad, CLASSIFICATION)).toEqual([]);
      }
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it('filters on the channel set in the SQL, not just in the signature', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));
      const { findRelatedConversations } = await load();
      await findRelatedConversations('user-sub-123', 'product management', SCOPE, CLASSIFICATION);

      const [sql, params] = keywordCall();
      expect(sql).toMatch(/channel_arn\s*=\s*ANY\(\$\d+\)/);
      expect(params).toContainEqual(SCOPE);
    });

    it('keeps the keyword placeholders numbered correctly with the scope appended last', async () => {
      // The scope goes after the LIKE params on purpose: inserting it at $3 would shift every keyword
      // onto the wrong parameter, which would still run and would still return rows.
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));
      const { findRelatedConversations } = await load();
      await findRelatedConversations('u', 'alpha beta gamma', SCOPE, CLASSIFICATION);

      const [sql, params] = keywordCall();
      // three keywords -> $3,$4,$5 for LIKE, so the scope is $6 and is the last parameter.
      expect(sql).toContain('ANY($6)');
      expect(params[params.length - 1]).toEqual(SCOPE);
      expect(params.slice(2, 5)).toEqual(['%alpha%', '%beta%', '%gamma%']);
    });

    it('scopes the no-keyword path too, which is the one that returns most-recent-anything', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));
      const { findRelatedConversations } = await load();
      // Punctuation-only topic: no keywords survive, so this takes the ORDER BY updated_at branch.
      await findRelatedConversations('u', '!!! ???', SCOPE, CLASSIFICATION);

      const [sql, params] = keywordCall();
      expect(sql).toContain('ORDER BY ccc.updated_at DESC');
      expect(sql).toMatch(/channel_arn\s*=\s*ANY\(\$3\)/);
      expect(params).toContainEqual(SCOPE);
    });

    it('returns nothing when no classification was supplied, rather than picking one', async () => {
      // Since migration 068 the table is bounded, so the read needs a reader role to run as. No
      // classification means no role, and running as anything else is how a cross-boundary read
      // happens - so it refuses instead of choosing.
      const { findRelatedConversations } = await load();
      for (const bad of ['', undefined, null] as unknown as string[]) {
        expect(await findRelatedConversations('u', 't', SCOPE, bad)).toEqual([]);
      }
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it('runs the read as the classification\'s reader role, never unroled', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));
      const { findRelatedConversations } = await load();
      // Measure this call's own roles: the recorder is module-level and accumulates across cases.
      const before = mockAssumedRoles.length;
      await findRelatedConversations('u', 'product management', SCOPE, 'premium');

      // Under FORCE ROW LEVEL SECURITY the same statement issued unroled matches no policy and
      // returns zero rows, which presents as "this person has no other conversations".
      expect(mockAssumedRoles.slice(before)).toEqual(['ae_reader_premium']);
    });
  });

  /**
   * ADR-004 SURFACE 3: THE SEMANTIC PATH, which for months could not execute at all.
   *
   * The stub returned the keyword result, and the gate that chose it counted a source_type nothing
   * writes, in the wrong table, through an unroled connection. Every one of those failed CLOSED, so
   * the symptom was a correct-looking keyword answer and nothing anywhere said the vector path had
   * never run. These cases exist because that is not observable from the outside.
   */
  describe('the semantic path', () => {
    const load = () => import('../../lambda/src/analytics-aurora/cross-conversation-context');
    const VECTOR = Array.from({ length: 1024 }, (_, i) => (i % 7) / 7);

    it('ranks by cosine distance over summary_embeddings when an embedding is available', async () => {
      mockEmbedding = VECTOR;
      mockedQuery.mockResolvedValueOnce(mockQueryResult([
        { channel_arn: 'channel-1', topic: 'Pricing', summary: 'Talked pricing', last_message_id: 'm1', relevance_score: '0.9', updated_at: '2026-04-01T10:00:00Z', similarity: '0.82' },
      ]));

      const { findRelatedConversations } = await load();
      const result = await findRelatedConversations('u', 'pricing model', SCOPE, CLASSIFICATION);

      const [sql, params] = vectorCall();
      // The distance operator, not a LIKE. A keyword query that happened to mention the table would
      // satisfy a weaker assertion.
      expect(sql).toContain('embedding <=> $1::vector');
      expect(params[0]).toBe(`[${VECTOR.join(',')}]`);
      expect(result).toHaveLength(1);
      expect(result[0].channelArn).toBe('channel-1');
    });

    it('does not also run the keyword query once the semantic one answered', async () => {
      mockEmbedding = VECTOR;
      mockedQuery.mockResolvedValueOnce(mockQueryResult([
        { channel_arn: 'c1', topic: 'T', summary: 'S', last_message_id: null, relevance_score: '0.5', updated_at: '2026-04-01', similarity: '0.7' },
      ]));

      const { findRelatedConversations } = await load();
      await findRelatedConversations('u', 'pricing model', SCOPE, CLASSIFICATION);

      // Two reads for one question would double the cost and could disagree with each other.
      expect(mockedQuery.mock.calls.filter((c) => /FROM cross_conversation_context/.test(String(c[0])) && !/summary_embeddings/.test(String(c[0])))).toHaveLength(0);
    });

    it('carries BOTH bounds: the resolved scope and the classification reader role', async () => {
      mockEmbedding = VECTOR;
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));

      const { findRelatedConversations } = await load();
      const before = mockAssumedRoles.length;
      await findRelatedConversations('u', 'pricing model', SCOPE, 'premium');

      const [sql, params] = vectorCall();
      // Membership, resolved live by the caller - and applied to the embedding table too, not only
      // through the join, because that is the side the index is on.
      expect(sql).toMatch(/se\.channel_arn\s*=\s*ANY\(\$4\)/);
      expect(params).toContainEqual(SCOPE);
      // Classification. Membership protects the people; it does not protect the conversation.
      expect(mockAssumedRoles.slice(before)).toContain('ae_reader_premium');
    });

    it('applies a similarity floor, so an unrelated conversation is not surfaced', async () => {
      mockEmbedding = VECTOR;
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));

      const { findRelatedConversations } = await load();
      await findRelatedConversations('u', 'pricing model', SCOPE, CLASSIFICATION);

      const [sql, params] = vectorCall();
      expect(sql).toMatch(/>=\s*\$5/);
      expect(typeof params[4]).toBe('number');
    });

    it('falls back to keyword when no embedding could be produced', async () => {
      // Titan refused or timed out. An embedding is a better ranking, never a gate.
      mockEmbedding = null;
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));

      const { findRelatedConversations } = await load();
      await findRelatedConversations('u', 'pricing model', SCOPE, CLASSIFICATION);

      expect(mockedQuery.mock.calls.filter((c) => /FROM summary_embeddings/.test(String(c[0])))).toHaveLength(0);
      expect(keywordCall()).toBeDefined();
    });

    it('falls back to keyword when nothing in scope is embedded yet', async () => {
      // The state of a deployment whose summaries exist but have not been embedded - which must
      // answer exactly as it did before the vector path landed.
      mockEmbedding = VECTOR;
      mockedQuery.mockResolvedValueOnce(mockQueryResult([])); // vector: no rows
      mockedQuery.mockResolvedValueOnce(mockQueryResult([
        { channel_arn: 'c1', topic: 'T', summary: 'S', last_message_id: null, relevance_score: '0.5', updated_at: '2026-04-01' },
      ]));

      const { findRelatedConversations } = await load();
      const result = await findRelatedConversations('u', 'pricing model', SCOPE, CLASSIFICATION);

      expect(vectorCall()).toBeDefined();
      expect(keywordCall()).toBeDefined();
      expect(result).toHaveLength(1);
    });

    it('asks nothing at all when the topic is empty, rather than embedding whitespace', async () => {
      mockEmbedding = VECTOR;
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));

      const { findRelatedConversations } = await load();
      await findRelatedConversations('u', '   ', SCOPE, CLASSIFICATION);

      expect(mockedQuery.mock.calls.filter((c) => /FROM summary_embeddings/.test(String(c[0])))).toHaveLength(0);
    });
  });

  describe('findRelatedConversations', () => {
    it('should return empty array when user has no prior conversations', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([]));

      const { findRelatedConversations } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      const result = await findRelatedConversations('user-sub-123', 'product management', SCOPE, CLASSIFICATION);

      expect(result).toEqual([]);
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('cross_conversation_context'),
        expect.arrayContaining(['user-sub-123'])
      );
    });

    it('should return related conversations ranked by relevance', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([
          {
            channel_arn: 'channel-1',
            topic: 'Senior PM role at Acme',
            summary: 'Discussed qualifications and interview process',
            relevance_score: '0.85',
            updated_at: '2026-04-01T10:00:00Z',
          },
          {
            channel_arn: 'channel-2',
            topic: 'Engineering leadership',
            summary: 'Talked about team scaling challenges',
            relevance_score: '0.45',
            updated_at: '2026-03-28T14:00:00Z',
          },
      ]));

      const { findRelatedConversations } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      const result = await findRelatedConversations('user-sub-123', 'product management', SCOPE, CLASSIFICATION, 5);

      expect(result).toHaveLength(2);
      expect(result[0].relevanceScore).toBeGreaterThan(result[1].relevanceScore);
      expect(result[0].channelArn).toBe('channel-1');
    });

    it('should respect the limit parameter', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([
          { channel_arn: 'c1', topic: 'A', summary: 'S1', relevance_score: '0.9', updated_at: '2026-04-01' },
      ]));

      const { findRelatedConversations } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      await findRelatedConversations('user-sub-123', 'test', SCOPE, CLASSIFICATION, 1);

      // Verify LIMIT was passed to query
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        expect.any(Array)
      );
    });
  });

  describe('updateConversationContext', () => {
    it('should upsert context record for user + channel', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([], 1));

      const { updateConversationContext } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      await updateConversationContext(
        'user-sub-123',
        'arn:aws:chime:us-east-1:123456789012:app-instance/test/channel/abc',
        CLASSIFICATION,
        'msg-abc-123'
      );

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO cross_conversation_context'),
        expect.arrayContaining(['user-sub-123', expect.stringContaining('channel')])
      );
    });

    it('should update existing context on conflict', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([], 1));

      const { updateConversationContext } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      await updateConversationContext('user-sub-123', 'channel-1', CLASSIFICATION, 'msg-1');

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        expect.any(Array)
      );
    });

    /**
     * MIGRATION 068: A REFERENCE, NEVER A COPY OF WHAT SOMEBODY SAID.
     *
     * The write used to store the latest user message verbatim - 100 characters as `topic`, 500 as
     * `summary`. A copy is exactly what the redaction mechanism cannot reach, because `-RED`/`-DEL`
     * sibling rows resolve at READ time and a duplicate is not a derived view, so a redacted
     * message's text simply stayed. These pin that there is nowhere for message text to go.
     */
    it('writes a message id and a classification, and no message text at all', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([], 1));

      const { updateConversationContext } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );

      await updateConversationContext('user-sub-123', 'channel-1', 'premium', 'msg-xyz');

      const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('last_message_id');
      expect(sql).toContain('classification');
      // The dropped columns must not reappear. A call site that means well cannot put a caption back
      // if the statement has nowhere to put one.
      expect(sql).not.toMatch(/\btopic\b/);
      expect(sql).not.toMatch(/\bsummary\b/);
      expect(params).toEqual(['user-sub-123', 'channel-1', 'premium', 'msg-xyz']);
    });

    it('runs the write as the write role, never as the owner', async () => {
      mockedQuery.mockResolvedValueOnce(mockQueryResult([], 1));

      const { updateConversationContext } = await import(
        '../../lambda/src/analytics-aurora/cross-conversation-context'
      );
      const before = mockAssumedRoles.length;
      await updateConversationContext('user-sub-123', 'channel-1', CLASSIFICATION, 'msg-1');

      // Under FORCE ROW LEVEL SECURITY the same INSERT issued unroled reports success and writes
      // nothing, which presents later as "this person has no other conversations".
      expect(mockAssumedRoles.slice(before)).toEqual(['ae_writer']);
    });
  });
});
