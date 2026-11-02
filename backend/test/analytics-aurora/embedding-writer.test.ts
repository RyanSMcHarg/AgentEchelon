/**
 * embedding-writer — pins the contract that the summary-updater Lambda
 * depends on for fresh drift signals:
 *
 *   1. Empty/whitespace summaries are refused (`empty_summary`) — never
 *      embed a no-op text.
 *   2. Bedrock failure returns `embedding_failed`, never throws into the
 *      caller. The summary-updater treats this as best-effort.
 *   3. Concurrent writers are race-safe via `embedded_from_version <
 *      EXCLUDED.embedded_from_version` — a stale write reports
 *      `stale_version` and does NOT clobber a fresher embedding.
 *   4. The persisted vector is the exact Titan embedding (1024 floats,
 *      pgvector string literal format).
 */

import type { QueryResult, QueryResultRow } from 'pg';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

// ADR-028: the subject now runs its bounded-table statements as a database role, via
// `withReaderRole`/`withWriterRole` (which wrap `transaction()`). Route those back to the mocked
// `query` so the SQL assertions below are unchanged, and record which role was assumed so the tests
// can assert the boundary was entered at all — a query that reaches the right table as the WRONG role
// is precisely the failure this design exists to prevent, and it is invisible in the SQL text.
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

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args: unknown) => ({ __args: args })),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { DEFAULT_PROFILES_CONFIG } from '../../lib/config/profiles';
import { defaultProfileRegistry } from '../../lib/profile-registry';

/**
 * The fail-closed CONTENT classification, DERIVED. Named as `premium`, these assertions failed the
 * moment a higher classification was configured - reporting a correct tightening as a regression.
 *
 * ── AND IT IS NOT THE TOP OF THE LADDER ──────────────────────────────────────────────────────────
 *
 * The derivation was then the maximum rank, on the reasoning that a fail-closed stamp should be
 * "readable only by the classification that could already see everything". That premise assumes the
 * top of the ladder is a READER. An ADMIN PLANE classification is not: it ranks above the ordinary
 * ones and serves no user conversation, so a summary stamped there is read by nobody - which is
 * precisely the outcome the second test below calls the worse one.
 *
 * So: the highest-ranked classification that is not admin-plane. Withheld from everything below it,
 * and still reachable by the conversations served at it.
 */
// FROM THE REGISTRY, not recomputed here. This reduced over `rank` to find "the highest ordinary
// classification", which is the definition the registry no longer has - and a test that recomputes a
// rule is a test that can agree with itself while disagreeing with the code.
const FAIL_CLOSED_CONTENT = defaultProfileRegistry.failClosedContentValue;

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

function mockBedrockEmbedding(values: number[]): void {
  mockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ embedding: values })),
  });
}

const CHANNEL_ARN = 'arn:aws:chime:us-east-1:111111111111:app-instance/test/channel/c1';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DB_HOST = 'localhost';
  process.env.DB_NAME = 'analytics';
  process.env.DB_USER = 'testuser';
  process.env.DB_REGION = 'us-east-1';
});

describe('writeSummaryEmbedding', () => {
  it('refuses empty summary without calling Bedrock or DB', async () => {
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: '',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'empty_summary' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('refuses whitespace-only summary', async () => {
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: '   \n\t   ',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'empty_summary' });
  });

  it('returns embedding_failed when Bedrock errors out — never throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('Bedrock 5xx (simulated)'));
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'A meaningful summary of the conversation.',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'embedding_failed' });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('returns embedding_failed when Titan returns a wrong-shape embedding', async () => {
    // 512-dim instead of the required 1024.
    mockBedrockEmbedding(new Array(512).fill(0.5));
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'A meaningful summary.',
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });
    expect(result).toEqual({ written: false, reason: 'embedding_failed' });
  });

  it('writes the embedding via UPSERT and returns written:true on a fresh row', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.25));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 5 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'Discussing the API redesign.',
      fromVersion: 5,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });

    // The result now also reports WHICH classification was stamped and where it came from — a row
    // written without that is a row no reader role can see, so it is part of the contract, not
    // decoration.
    // `topicsWritten: 0` because this call passed no topics — the subject rows are FR5's own
    // contract, pinned in their describe block below, and reporting the count is part of the result
    // shape rather than an optional extra.
    expect(result).toEqual({ written: true, classification: 'standard', classificationSource: 'caller', topicsWritten: 0 });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    // ...and it went through the write role. Under FORCE RLS the same statement issued unroled
    // reports success and writes nothing, which no assertion on the SQL text can distinguish.
    expect(mockAssumedRoles).toEqual(['ae_writer']);

    const [sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO summary_embeddings/);
    expect(sql).toMatch(/ON CONFLICT \(channel_arn\) DO UPDATE/);
    // The version-guard predicate is the load-bearing race-safety bit.
    expect(sql).toMatch(/WHERE summary_embeddings\.embedded_from_version < EXCLUDED\.embedded_from_version/);
    expect(params).toEqual([
      CHANNEL_ARN,
      `[${new Array(1024).fill(0.25).join(',')}]`,
      5,
      'amazon.titan-embed-text-v2:0',
      // The isolation column (ADR-028). Written on every row, including on the ON CONFLICT UPDATE
      // path — a re-embed that kept the old classification would silently pin a summary to whatever
      // the first write happened to guess.
      'standard',
      // The anchor's own provenance (migration 065). Null when the caller did not state one, rather
      // than a guessed default: a wrong provenance at version 1 is what makes drift treat a spawned
      // conversation's real topic as the thin single-message case.
      null,
    ]);
    expect(sql).toMatch(/classification = EXCLUDED\.classification/);
    // Moves WITH the embedding on a re-embed, or a fresh anchor keeps the provenance of the one it
    // replaced.
    expect(sql).toMatch(/generated_by = EXCLUDED\.generated_by/);
  });

  it('returns stale_version when the WHERE clause excluded the UPDATE (a fresher writer raced ahead)', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    // 0 rows returned ⇒ the ON CONFLICT WHERE clause didn't match.
    mockedQuery.mockResolvedValueOnce(mockRows<{ embedded_from_version: number }>([]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'A meaningful summary.',
      fromVersion: 3,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });

    expect(result).toEqual({ written: false, reason: 'stale_version' });
  });

  it('truncates summary text to 8000 chars before sending to Bedrock', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const huge = 'x'.repeat(20000);
    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: huge,
      fromVersion: 1,
      // Supplied, so the UPSERT is what this test exercises rather than the resolution ladder
      // (covered separately below).
      classification: 'standard',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0] as { __args: { body: string } };
    const body = JSON.parse(command.__args.body);
    expect(body.inputText.length).toBe(8000);
    expect(body.dimensions).toBe(1024);
    expect(body.normalize).toBe(true);
  });
});

/**
 * ADR-028: which classification gets stamped, and what happens when nobody knows.
 *
 * This is the whole isolation value for a conversation summary. Stamp it too low and the summary is
 * readable by classifications that should never see it; leave it NULL and it is readable by nobody,
 * which is safe but silently removes drift's anchor. So the ladder - caller, then projection, then
 * most-restrictive - is pinned here rather than left to whatever the call site happens to pass.
 */
describe('writeSummaryEmbedding — classification resolution', () => {
  const upsertCall = () => mockedQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO summary_embeddings'))!;

  it('believes the caller when it supplied one, and never queries the projection', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1, classification: 'basic',
    });

    expect(result.classificationSource).toBe('caller');
    // The seed path resolved this from the live channel tag on the turn being served. Consulting the
    // projection anyway would prefer a stale copy to an authoritative read.
    expect(mockedQuery.mock.calls.some(([sql]) => String(sql).includes('channel_classification'))).toBe(false);
    expect(upsertCall()[1]).toContain('basic');
  });

  it('falls back to the projection when the caller could not know', async () => {
    // The scheduled scan runs inside the VPC, which has no route to the Chime SDK at all.
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ classification: 'standard' }]));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({ channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1 });

    expect(result.classificationSource).toBe('projection');
    expect(upsertCall()[1]).toContain('standard');
  });

  it('stamps the most restrictive READABLE classification when nobody knows', async () => {
    // Fail-closed for CONTENT goes UP the ladder - withheld from everything below it - while for a
    // READER role it goes DOWN, to the floor. Getting those two the same way round is the bug this
    // direction guards.
    //
    // But "up" stops at the last classification a conversation is actually served at. Past that there
    // is no reader, and a stamp nothing can read is not a stricter answer, it is a lost row.
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows<{ classification: string }>([]));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({ channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1 });

    expect(result.classificationSource).toBe('fail-closed');
    expect(result.classification).toBe(FAIL_CLOSED_CONTENT);
    expect(upsertCall()[1]).toContain(FAIL_CLOSED_CONTENT);
  });

  it('treats a classification this deployment does not declare as unknown, not as a label', async () => {
    // A renamed ladder leaves rows behind. An unrecognized value is not a classification just because
    // it is written down — believing it would stamp a row nothing can ever read, and (worse) would
    // make an attacker-chosen or typo'd label look like a successful write.
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ classification: 'top-secret-typo' }]));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 1 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({ channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 1 });

    expect(result.classificationSource).toBe('fail-closed');
    expect(result.classification).toBe(FAIL_CLOSED_CONTENT);
  });
});

/**
 * SPEC-DRIFT-CONVERGENCE FR5: a conversation's OWN subjects, not the average of them.
 *
 * The summary embedding is one point averaged over everything a conversation covers, so in a
 * multi-subject conversation every individual subject sits some distance from it - and step 6b then
 * reads a move between the conversation's own subjects as drift away from it. A Q3 revenue report and
 * a Q2 revenue report are two points a long way apart; the conversation that covered both is one
 * point between them, close to neither. These cases pin the half that makes the per-subject
 * comparison possible: the summarizer storing a row per subject.
 */
describe('writeSummaryEmbedding — the conversation\'s own subjects (FR5)', () => {
  const topicInserts = () => mockedQuery.mock.calls.filter(
    ([sql]) => String(sql).includes('INSERT INTO conversation_topic_embeddings'),
  );
  const topicDeletes = () => mockedQuery.mock.calls.filter(
    ([sql]) => String(sql).includes('DELETE FROM conversation_topic_embeddings'),
  );

  /** The anchor write plus one embed per subject, in the order the writer consumes them. */
  function mockAnchorAndSubjects(count: number): void {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 7 }]));
    for (let i = 0; i < count; i++) mockBedrockEmbedding(new Array(1024).fill(0.2 + i / 100));
  }

  it('stores one row per subject, stamped as this conversation\'s own and tied to the version it came from', async () => {
    mockAnchorAndSubjects(2);

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN,
      summaryText: 'Q3 revenue and the API redesign.',
      fromVersion: 7,
      classification: 'standard',
      topics: ['Q3 revenue report', 'API redesign'],
    });

    expect(result.written).toBe(true);
    expect(result.topicsWritten).toBe(2);
    expect(topicInserts()).toHaveLength(2);

    const [sql, params] = topicInserts()[0];
    // `summary_topic` and `established` are the two values migration 067 added, and they are the
    // contract: `drift_offer`/`adopted` would make "how many subjects did people decline here"
    // unanswerable from the column that appears to answer it.
    expect(String(sql)).toMatch(/'summary_topic'/);
    expect(String(sql)).toMatch(/'established'/);
    // The version travels with the row, so a re-delivered summary run replaces its own subjects
    // rather than accumulating a set per version.
    expect(params as unknown[]).toContain(7);
    // Same classification as the anchor above it — a subject row stamped differently is one no reader
    // role can pair with the summary it describes.
    expect(params as unknown[]).toContain('standard');
    // Keyed by the subject, namespaced so it can never collide with a `drift:<correlationId>` row.
    expect((params as unknown[])[1]).toBe('summary:q3-revenue-report');
    expect((topicInserts()[1][1] as unknown[])[1]).toBe('summary:api-redesign');
  });

  it('replaces only its own rows, leaving the subjects a person declined to split out', async () => {
    mockAnchorAndSubjects(1);

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 7, classification: 'standard',
      topics: ['API redesign'],
    });

    expect(topicDeletes()).toHaveLength(1);
    // A `drift_offer` row is a subject the person DECLINED to move out of this conversation. It
    // belongs to the conversation independently of any summary, and a summary run is not evidence
    // about it — an unscoped DELETE here would quietly undo that answer.
    expect(String(topicDeletes()[0][0])).toMatch(/origin\s*=\s*'summary_topic'/);
  });

  it('leaves the previous version\'s subjects standing when a run says nothing about subjects', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 7 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 7, classification: 'standard',
    });

    expect(result.topicsWritten).toBe(0);
    // ABSENT IS NOT EMPTY. Deleting here would read "the model did not return the field" as "this
    // conversation has no subjects", which is the destructive reading of a silence.
    expect(topicDeletes()).toHaveLength(0);
    expect(topicInserts()).toHaveLength(0);
  });

  it('treats an explicit empty list the same way, and never spends an embed call on it', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 7 }]));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 7, classification: 'standard',
      topics: [],
    });

    expect(result.topicsWritten).toBe(0);
    expect(topicDeletes()).toHaveLength(0);
    // One Bedrock call: the summary. The subjects never reached the model.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('writes no subjects when the anchor was stale, because they describe the same stale version', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    // 0 rows ⇒ a fresher writer raced ahead.
    mockedQuery.mockResolvedValueOnce(mockRows<{ embedded_from_version: number }>([]));
    // The subject's embedding is queued and waiting. Without it this case would pass whether or not
    // the skip exists, because an unmocked Bedrock call fails and no subject survives to be written.
    mockBedrockEmbedding(new Array(1024).fill(0.2));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 3, classification: 'standard',
      topics: ['Q3 revenue report'],
    });

    expect(result).toEqual({ written: false, reason: 'stale_version' });
    // The replace rule is "at this version", so running it from a stale version would swap a fresher
    // subject set for an older one — the exact clobber the anchor's own version guard prevents.
    expect(topicDeletes()).toHaveLength(0);
    expect(topicInserts()).toHaveLength(0);
  });

  it('keeps the subjects that embedded when one of them failed', async () => {
    mockBedrockEmbedding(new Array(1024).fill(0.1));
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedded_from_version: 7 }]));
    mockBedrockEmbedding(new Array(1024).fill(0.2));
    mockSend.mockRejectedValueOnce(new Error('Bedrock 5xx (simulated)'));
    mockBedrockEmbedding(new Array(1024).fill(0.3));

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 7, classification: 'standard',
      topics: ['Q3 revenue report', 'API redesign', 'onboarding'],
    });

    // A partial subject set is strictly better than the average-only comparison it replaces, so one
    // failed embed costs recall on one subject rather than discarding the other two.
    expect(result.written).toBe(true);
    expect(result.topicsWritten).toBe(2);
    expect(topicInserts()).toHaveLength(2);
  });

  it('drops duplicates and caps how many subjects one version can store', async () => {
    // 14 distinct subjects plus a case-differing repeat of the first.
    const many = Array.from({ length: 14 }, (_, i) => `Subject ${i}`);
    mockAnchorAndSubjects(many.length + 1);

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    const result = await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 7, classification: 'standard',
      topics: ['Subject 0', ...many, '   ', 'subject 0'],
    });

    // MAX_SUBJECTS_PER_VERSION. Two identical vectors change no comparison while costing an embed
    // call each, and an unbounded list makes one summary run's model spend unbounded too.
    expect(result.topicsWritten).toBe(12);
    expect(topicInserts()).toHaveLength(12);
    const keys = topicInserts().map(([, params]) => (params as unknown[])[1]);
    expect(new Set(keys).size).toBe(12);
    expect(keys).not.toContain('summary:');
  });

  it('runs the subject write as the write role, never as the owner', async () => {
    mockAnchorAndSubjects(1);
    // The recorder is module-level and accumulates across cases, so measure this call's own roles.
    // Counting the whole array would pass on the anchor writes every earlier case already made.
    const before = mockAssumedRoles.length;

    const { writeSummaryEmbedding } = await import('../../lambda/src/analytics-aurora/embedding-writer');
    await writeSummaryEmbedding({
      channelArn: CHANNEL_ARN, summaryText: 'hello', fromVersion: 7, classification: 'standard',
      topics: ['API redesign'],
    });

    // ADR-028: `conversation_topic_embeddings` is a bounded table under FORCE ROW LEVEL SECURITY.
    // Issued as the owner these statements report success and write nothing, which presents as "no
    // drift detected" rather than as a fault. Two entries: the anchor, then the subjects.
    expect(mockAssumedRoles.slice(before)).toEqual(['ae_writer', 'ae_writer']);
  });
});
