/**
 * Unit tests for the hardened drift detection module
 * (cosine similarity, no string-matching fallback — per SPEC-DRIFT-CONVERGENCE.md)
 *
 * These tests pin the contract that the live-suggestion path depends on:
 *
 *  - On embedding failure, drift returns `signalAvailable: false` and does
 *    NOT fall back to substring/keyword matching. This is the explicit
 *    "feels flaky" guardrail from the spec.
 *  - Intent-based short-circuits (GREETING, ACKNOWLEDGMENT, OFF_TOPIC)
 *    skip drift entirely without consulting embeddings.
 *  - Known topics: a message near a topic this conversation already holds (one a person kept by
 *    declining to split it out) is not drift, however far it sits from the summary.
 *  - Explicit-routing fast-path matches deterministic phrases and routes
 *    immediately without an embedding round-trip.
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

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

function mockEmbedding(dim = 1024, fill = 0.1): number[] {
  return new Array(dim).fill(fill);
}

function mockBedrockEmbedding(values: number[]): void {
  const body = JSON.stringify({ embedding: values });
  mockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(body),
  });
}

function mockBedrockFailure(): void {
  mockSend.mockRejectedValueOnce(new Error('Bedrock 5xx (simulated)'));
}

const CHANNEL_ARN = 'arn:aws:chime:us-east-1:111111111111:app-instance/test/channel/c1';

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` clears CALL RECORDS but NOT the `mockResolvedValueOnce` queue, so anything a test
  // primes and does not consume is inherited by the next one. That coupling made this file's result
  // depend on execution order: when a change to the code under test altered how many queries a run
  // makes, a leftover response became the NEXT test's summary read, and a test that passes alone
  // failed in file order with a NaN score. Reset the queues so each test starts from empty.
  mockedQuery.mockReset();
  mockSend.mockReset();
  mockAssumedRoles.length = 0;
  process.env.DB_HOST = 'localhost';
  process.env.DB_NAME = 'analytics';
  process.env.DB_USER = 'testuser';
  process.env.DB_REGION = 'us-east-1';
});

describe('detectDrift (hardened cosine path)', () => {
  it('skips when intent is GREETING — no DB lookup, no embedding call', async () => {
    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'hi',
      intent: 'GREETING',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(result.suggestedAction).toBe('continue');
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips when intent is ACKNOWLEDGMENT', async () => {
    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'thanks',
      intent: 'ACKNOWLEDGMENT',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips when intent is OFF_TOPIC', async () => {
    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'what is the weather today',
      intent: 'OFF_TOPIC',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips and emits signalAvailable=false when summary embedding is missing', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows<{ embedding_text: string | null }>([]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'a substantive question with several words to bypass length checks',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(result.signalAvailable).toBe(true); // The signal is technically available, we just have no anchor
  });

  it('returns signalAvailable=false on Bedrock embedding failure — NO string fallback', async () => {
    // 1st query: load summary embedding
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${mockEmbedding(1024, 0.5).join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]),
    );
    mockedQuery.mockResolvedValueOnce(mockRows([])); // the conversation's subjects
    // Embedding call fails
    mockBedrockFailure();

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'a substantive question that previously would have fallen back to keyword matching',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(result.signalAvailable).toBe(false);
    expect(result.suggestedAction).toBe('continue');
    // The two anchor reads (summary, subjects) and NO further query for a keyword-based fallback.
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });

  it('fires drift when message embedding is far from summary embedding', async () => {
    // Summary embedding pointing one direction
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]),
    );
    // Message embedding pointing opposite direction (negative correlation)
    const message = summary.map((v) => -v);
    mockBedrockEmbedding(message);
    // The conversation holds no adopted topics yet.
    mockedQuery.mockResolvedValueOnce(mockRows([]));
    // NO membership query is primed, because none is made any more. `findRelatedConversation` takes
    // its scope from `input.scopedChannelArns` (resolved by the caller from Amazon Chime SDK
    // membership) and returns no rival when it is absent — the archive is never consulted. Priming a
    // response the code does not consume left it queued for the NEXT test, which read `[]` as its
    // summary embedding and produced a NaN drift score: green alone, red in file order.

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'completely unrelated topic',
      intent: 'GENERAL',
      classification: 'standard',
    });

    // Cosine distance of (0.7-vector, -0.7-vector) → ~2.0 (opposite vectors)
    expect(result.driftScore).toBeGreaterThan(1.0);
    expect(result.isDrift).toBe(true);
    expect(result.suggestedAction).toBe('confirm');
    expect(result.suggestionTemplate).toBe('drift-offer');
  });

  it('does not fire when message embedding is close to summary embedding', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]),
    );
    // Nearly identical embedding
    const message = summary.map((v) => v + 0.001);
    mockBedrockEmbedding(message);

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'a follow-up question on the same topic',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(result.driftScore).toBeLessThan(0.1);
  });

  it('does NOT fire when the message is near a topic the conversation already holds', async () => {
    // A declined subject belongs to the conversation. The summary is an AVERAGE, so a
    // kept subject can sit far from it; what makes this message not a pivot is that it is near that topic.
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]));
    const message = summary.map((v) => -v); // far from the summary: would fire on distance alone
    mockBedrockEmbedding(message);
    // The adopted topic IS that subject.
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedding_text: `[${message.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'more on the subject the person chose to keep here',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(result.suggestedAction).toBe('continue');
    // The topics were read from their own table, as the channel's reader role.
    //
    // THE RULE, NOT THE VALUE. This pinned `status = 'adopted'`, which was the whole of the truth while
    // the only rows were declined offers. The summarizer now writes its `topics[]` as `established`
    // rows (FR5, migration 067), and an equality on `adopted` would have ignored every one of them -
    // so the read asks for anything that is not a pending offer, and this asserts that rule.
    const topicSql = String(mockedQuery.mock.calls[1][0]);
    expect(topicSql).toContain('FROM conversation_topic_embeddings');
    expect(topicSql).toMatch(/status\s*<>\s*'offered'/);
    // A pending offer is NOT a subject: it is a proposal still waiting on an answer, and treating one
    // as established would suppress drift on a subject the person has not agreed to keep here.
    expect(topicSql).not.toMatch(/status\s*=\s*'adopted'/);
    expect(mockAssumedRoles).toContain('ae_reader_standard');
  });

  it('still fires when the conversation holds topics but none is near this message', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]));
    const message = summary.map((v) => -v);
    mockBedrockEmbedding(message);
    // An adopted topic that points the SAME way as the summary, so it is far from this message.
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'a third, genuinely new subject',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(true);
  });

  it('a failed topic read offers anyway, rather than silently switching drift off', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]));
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockRejectedValueOnce(new Error('relation does not exist'));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'a new subject',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(true);
  });

  it('keeps the offered embedding, as the writer role, only when the live flow asks it to', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]));
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([])); // no adopted topics
    mockedQuery.mockResolvedValueOnce(mockRows([])); // the insert

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'a new subject',
      intent: 'GENERAL',
      classification: 'standard',
      correlationId: 'corr-keep',
      retainOfferEmbedding: true,
    });

    expect(result.isDrift).toBe(true);
    const insertCall = mockedQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO conversation_topic_embeddings'));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe(CHANNEL_ARN);
    expect(params[1]).toBe('drift:corr-keep');
    expect(params[3]).toBe('standard');
    // Offered, not adopted: only a decline makes it a topic.
    expect(String(insertCall![0])).toContain("'offered'");
    // A redelivered turn must not reset a topic that was already adopted.
    expect(String(insertCall![0])).toContain('ON CONFLICT (channel_arn, topic_key) DO NOTHING');
    expect(mockAssumedRoles).toContain('ae_writer');
  });

  it('keeps nothing when not asked, which is what archival scoring and a battle turn get', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]));
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'a new subject',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(mockedQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO conversation_topic_embeddings'))).toBe(false);
  });
});

describe('adoptOfferedTopic — a declined offer becomes a topic of the conversation', () => {
  it('promotes the offered row to adopted, as the writer role, for exactly that offer', async () => {
    mockedQuery.mockResolvedValueOnce({ ...mockRows([]), rowCount: 1 } as never);
    const { adoptOfferedTopic } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await adoptOfferedTopic({ channelArn: CHANNEL_ARN, correlationId: 'corr-d' });

    expect(result).toEqual({ adopted: true });
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(String(sql)).toContain('UPDATE conversation_topic_embeddings');
    expect(String(sql)).toContain("SET status = 'adopted'");
    expect(String(sql)).toContain("status = 'offered'");
    expect(params).toEqual([CHANNEL_ARN, 'drift:corr-d']);
    expect(mockAssumedRoles).toContain('ae_writer');
  });

  it('reports nothing adopted when the offer kept no embedding', async () => {
    mockedQuery.mockResolvedValueOnce({ ...mockRows([]), rowCount: 0 } as never);
    const { adoptOfferedTopic } = await import('../../lambda/src/analytics-aurora/drift-detection');

    expect(await adoptOfferedTopic({ channelArn: CHANNEL_ARN, correlationId: 'corr-none' })).toEqual({ adopted: false });
  });
});

/**
 * A live task means the assistant asked someone in this conversation for something and the
 * turn under evaluation is the ANSWER. Cosine cannot see that: an answer is typically a short
 * fragment carrying none of the summary's topic words, so it lands FAR from the summary
 * and fires drift on the one turn the assistant solicited. Observed live on 2026-07-30 -
 * `drift_fired` on "Audience is engineering leadership. Focus on delivery velocity, code
 * ownership, and CI cost." mid-report_generation, which derailed the flow.
 *
 * The flag is a statement about the CHANNEL, not about who holds the task: ownership moves only at
 * an `awaits` boundary, so keying it on the user made the guard depend on every state declaring
 * that flag correctly, and one that did not lost drift protection with no error. Who resolves it, and
 * from which reads, is the router's side of the contract (`live-work-suppresses-drift.test.ts`);
 * this module only ever sees the boolean.
 */
describe('detectDrift — a live task suppresses the cosine signal', () => {
  it('does NOT fire on an answer to the assistant, even when it lands far from the summary', async () => {
    // Identical setup to the "fires drift" case above: opposite vectors, distance ~2.0.
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]),
    );
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'Audience is engineering leadership. Focus on delivery velocity and CI cost.',
      intent: 'REPORT_GENERATION',
      classification: 'standard',
      activeTaskInProgress: true,
    });

    expect(result.isDrift).toBe(false);
    expect(result.suggestedAction).toBe('continue');
    // Suppressed BEFORE the summary fetch and the embed, so a skipped turn costs neither.
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still fires for the SAME message when no task is live (proves the flag is what suppresses)', async () => {
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]),
    );
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'Audience is engineering leadership. Focus on delivery velocity and CI cost.',
      intent: 'REPORT_GENERATION',
      classification: 'standard',
      activeTaskInProgress: false,
    });

    expect(result.isDrift).toBe(true);
  });

  it('an EXPLICIT routing request still routes mid-task (suppression is cosine-only)', async () => {
    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: "let's start a new conversation about quarterly forecasting",
      intent: 'REPORT_GENERATION',
      classification: 'standard',
      activeTaskInProgress: true,
    });

    // The fast-path is checked BEFORE the task check, so a deliberate pivot is never
    // trapped inside a long-running task.
    expect(result.isDrift).toBe(true);
    expect(result.viaExplicitIntent).toBe(true);
  });
});

describe('detectDrift — explicit-routing fast-path (the only legitimate string match)', () => {
  it('matches "let\'s start a new conversation about X" and routes immediately', async () => {
    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: "let's start a new conversation about quarterly forecasting",
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.viaExplicitIntent).toBe(true);
    expect(result.explicitTopicHint).toContain('quarterly forecasting');
    // Critical: the embedding call was NOT made (latency optimization)
    expect(mockSend).not.toHaveBeenCalled();
    // And no DB query was made either
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('does NOT match conversational "let\'s talk about X" (would be a false positive)', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]),
    );
    // Nearly identical → no drift
    mockBedrockEmbedding(summary.map((v) => v + 0.001));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: "let's talk about the recent earnings call",
      intent: 'GENERAL',
      classification: 'standard',
    });

    // Fell through to the cosine path (not fast-path), found no drift
    expect(result.viaExplicitIntent).toBeFalsy();
    expect(mockSend).toHaveBeenCalled(); // cosine path was taken
  });
});

describe('detectExplicitRoutingRequest (allowlist)', () => {
  let detect: (s: string) => { matched: boolean; topicHint?: string };

  beforeAll(async () => {
    const mod = await import('../../lambda/src/lib/explicit-routing');
    detect = mod.detectExplicitRoutingRequest;
  });

  it('matches the canonical phrase', () => {
    expect(detect("let's start a new conversation about API design")).toMatchObject({
      matched: true,
      topicHint: expect.stringContaining('API design'),
    });
  });

  it('matches "switch to a separate channel about X"', () => {
    expect(detect("let's switch to a separate channel about retrospective planning")).toMatchObject({
      matched: true,
    });
  });

  it('does NOT match conversational continuations', () => {
    expect(detect('tell me more about that').matched).toBe(false);
    expect(detect("let's talk about pricing strategy").matched).toBe(false);
    expect(detect('I want to discuss salary expectations').matched).toBe(false);
    expect(detect('thanks, can you elaborate?').matched).toBe(false);
  });

  it('does NOT match short or empty input', () => {
    expect(detect('').matched).toBe(false);
    expect(detect('hi').matched).toBe(false);
    expect(detect('   ').matched).toBe(false);
  });

  it('caps haystack at 500 chars (does not scan long substantive messages)', () => {
    const longMessage = 'lorem ipsum '.repeat(100) + " let's start a new conversation about X";
    // The matching phrase is past the 500-char cap, so it should not match
    expect(detect(longMessage).matched).toBe(false);
  });
});

/**
 * A CONVERSATION WITH ONE EXCHANGE HAS NO TOPIC TO DRIFT FROM.
 *
 * Version 1 of a summary is the turn-one seed, written by `seedSummaryFromFirstExchange` from a
 * single exchange so that drift is not blind while the scheduled summariser catches up. Comparing
 * message two against it asks whether message two is about the same thing as message one, which for
 * most conversations has no useful answer - and the answer it gives is "no", so the person is offered
 * a new conversation for continuing the one they just started. That was observed live.
 *
 * Version 2 is the first anchor the scheduled summariser built over the accumulated transcript.
 */
/**
 * EVERY TURN IS COMPARED WITH THE CONVERSATION'S OWN SUBJECTS.
 *
 * The nearest of the summary and each subject decides. The turn-one seed is compared against rather than
 * skipped: its subjects stand beside its summary, so the plainest pivot on turn two is caught.
 */
describe('every turn is compared with the conversation subjects', () => {
  const opposite = (v: number[]) => v.map((x) => -x);
  const seed = (summary: number[]) => mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 1, generated_by: 'summary-seed' }]);
  const subjectRows = (...vs: number[][]) => mockRows(vs.map((v) => ({ embedding_text: `[${v.join(',')}]` })));

  it('compares turn two against the seed, and fires when the message is far from it and from every subject', async () => {
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(seed(summary));
    mockedQuery.mockResolvedValueOnce(subjectRows(summary));
    mockBedrockEmbedding(opposite(summary));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({ channelArn: CHANNEL_ARN, latestMessage: 'what is our net revenue retention?', intent: 'GENERAL', classification: 'standard' });

    expect(result.isDrift).toBe(true);
    expect(result.suggestedAction).toBe('confirm');
  });

  it('is the same subject when the message is near ANY one subject, however far from the summary', async () => {
    const summary = mockEmbedding(1024, 0.7);
    const subject = opposite(summary);
    mockedQuery.mockResolvedValueOnce(seed(summary));
    mockedQuery.mockResolvedValueOnce(subjectRows(summary, subject));
    mockBedrockEmbedding(subject);

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({ channelArn: CHANNEL_ARN, latestMessage: 'more on that second subject', intent: 'GENERAL', classification: 'standard' });

    expect(result.isDrift).toBe(false);
  });

  it('is the same subject when the message is near the summary, however far from every subject label', async () => {
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(seed(summary));
    mockedQuery.mockResolvedValueOnce(subjectRows(opposite(summary)));
    mockBedrockEmbedding(summary);

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({ channelArn: CHANNEL_ARN, latestMessage: 'a follow-up', intent: 'GENERAL', classification: 'standard' });

    expect(result.isDrift).toBe(false);
  });

  it('reads the version in the same query as the embedding, not a second round trip', async () => {
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 1, generated_by: 'summary-seed' }]),
    );

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'completely unrelated topic',
      intent: 'GENERAL',
      classification: 'standard',
    });

    const sql = String(mockedQuery.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('summary_embeddings');
    expect(sql).toContain('embedded_from_version');
  });
});

/**
 * A SPLIT-OUT CONVERSATION HAS ITS TOPIC BEFORE ITS FIRST MESSAGE.
 *
 * The thin-anchor gate above must not silence the one conversation whose subject is most explicitly
 * established. A conversation created by accepting a drift offer exists BECAUSE of a topic: the person
 * was asked whether to move it somewhere else and said yes. `seedSummaryFromDriftTopic` writes that
 * topic as version 1, stamped `drift-spawn`, so the gate reads provenance rather than the number.
 *
 * Gating on "version < 2" alone would have made drift blind longest in exactly these conversations.
 */
describe('a conversation split out of another one is not thin', () => {
  it('fires against a version-1 anchor that came from the drift topic', async () => {
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{
        embedding_text: `[${summary.join(',')}]`,
        embedded_from_version: 1,
        generated_by: 'drift-spawn',
      }]),
    );
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([])); // no adopted topics

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'completely unrelated topic',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(true);
    expect(result.suggestedAction).toBe('confirm');
  });

  it('reads the provenance in the same query, joined on the version the embedding was built from', async () => {
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{
        embedding_text: `[${summary.join(',')}]`,
        embedded_from_version: 1,
        generated_by: 'summary-seed',
      }]),
    );

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'completely unrelated topic',
      intent: 'GENERAL',
      classification: 'standard',
    });

    const sql = String(mockedQuery.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('generated_by');

    // THE ANCHOR'S PROVENANCE COMES OFF THE ANCHOR, AND THIS IS THE GUARD FOR WHY.
    //
    // This read runs as the channel's READER role, which holds SELECT on the bounded tables only.
    // An earlier version joined `conversation_summaries` here for `generated_by`, and that table is
    // not bounded - it carries no classification for RLS to scope it by - so every drift turn on the
    // deployment was refused with `permission denied for table conversation_summaries`. The caller
    // catches, so it presented as a null anchor and "no drift detected" rather than as a fault.
    //
    // Asserted as the ABSENCE of any join, not as the presence of the new column, because the defect
    // was a reachable table rather than a missing one. A future reader wanting another field from an
    // unbounded table would reintroduce it and this would still pass if it only checked the column.
    expect(sql).not.toContain('JOIN');
    expect(sql).not.toContain('conversation_summaries');
    // Still read from the anchor row itself, so the value describes the summary this embedding was
    // built from rather than whatever the latest summary happens to say.
    expect(sql).toContain('se.generated_by');
  });
});

/**
 * FR7: A PIVOT TO A SUBJECT ALREADY LIVE SOMEWHERE THE WHOLE ROOM CAN REACH OFFERS TO CONTINUE
 * THERE, RATHER THAN CREATING A DUPLICATE THREAD.
 *
 * This is decision-flow question 3, and the spec listed it as Delivered with "Validated by: none" -
 * the one differentiator in the table with no coverage at all. It is also the most expensive thing
 * here to get wrong in either direction: a false redirect sends somebody into a conversation they did
 * not ask for, and a missed one leaves two threads on one subject with nothing joining them.
 *
 * THE SCOPE IS THE PRIVACY CONTROL, so it is asserted as one. `scopedChannelArns` is the intersection
 * of every current human member's memberships and the serving assistant's, resolved live from Amazon
 * Chime SDK by the CALLER - this code runs VPC-attached with no Chime endpoint, so it cannot resolve
 * it and must not try. An absent scope suggests nothing; the archive is never consulted.
 */
describe('drift detection — FR7, a rival conversation the whole room can reach', () => {
  /** Prime the two reads every cosine turn makes before the rival lookup. */
  function primeDriftTurn(summary: number[], message: number[]): void {
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]`, embedded_from_version: 2, generated_by: 'summary-updater' }]),
    );
    mockBedrockEmbedding(message);
    mockedQuery.mockResolvedValueOnce(mockRows([])); // no adopted topics
  }

  const RIVAL_ARN = 'arn:aws:chime:us-east-1:111111111111:app-instance/test/channel/c2';
  const SCOPE = [CHANNEL_ARN, RIVAL_ARN];

  it('offers to CONTINUE THERE when a scoped conversation is a close enough neighbour', async () => {
    const summary = mockEmbedding(1024, 0.7);
    primeDriftTurn(summary, summary.map((v) => -v));
    // The rival, comfortably past the 0.80 reroute threshold.
    mockedQuery.mockResolvedValueOnce(mockRows([{ channel_arn: RIVAL_ARN, similarity: 0.93 }]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'back to the billing migration cutover',
      intent: 'GENERAL',
      classification: 'standard',
      scopedChannelArns: SCOPE,
    });

    expect(result.isDrift).toBe(true);
    // The whole point of FR7: redirect, not a new thread.
    expect(result.suggestedAction).toBe('redirect');
    expect(result.rivalConversationArn).toBe(RIVAL_ARN);
    expect(result.suggestionTemplate).toBe('drift-redirect-offer');
    // And it must NOT be the create-a-new-conversation copy, which is the duplicate FR7 prevents.
    expect(result.suggestionTemplate).not.toBe('drift-offer');
  });

  it('DEFERRED: fires the offer without asking question 3, and hands back the embedding', async () => {
    // The caller resolves the scope only when this happens, so an ordinary turn pays no search.
    const summary = mockEmbedding(1024, 0.7);
    const message = summary.map((v) => -v);
    primeDriftTurn(summary, message);

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'back to the billing migration cutover',
      intent: 'GENERAL',
      classification: 'standard',
      deferRelatedLookup: true,
    });

    expect(result.isDrift).toBe(true);
    expect(result.suggestedAction).toBe('confirm');
    expect(result.relatedLookupPending?.messageEmbedding).toEqual(message);
    const rivalCall = mockedQuery.mock.calls.find((c) => /WHERE channel_arn = ANY/.test(String(c[0])));
    expect(rivalCall).toBeUndefined();
  });

  it('DEFERRED, second half: the rival lookup upgrades the offer inside the scope it is given', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows([{ channel_arn: RIVAL_ARN, similarity: 0.93 }]));
    const { resolveDriftRival } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const offer = {
      isDrift: true, driftScore: 0.5, suggestedAction: 'confirm' as const, confidence: 'medium' as const,
      signalAvailable: true, correlationId: 'corr-x', suggestionTemplate: 'drift-offer' as const,
      relatedLookupPending: { messageEmbedding: [0.1, 0.2] },
    };
    const result = await resolveDriftRival({
      result: offer, channelArn: CHANNEL_ARN, messageEmbedding: [0.1, 0.2], scopedChannelArns: SCOPE, classification: 'standard',
    });

    expect(result.suggestedAction).toBe('redirect');
    expect(result.rivalConversationArn).toBe(RIVAL_ARN);
    expect(result.suggestionTemplate).toBe('drift-redirect-offer');
    expect(result).not.toHaveProperty('relatedLookupPending');
    const rivalCall = mockedQuery.mock.calls.find((c) => /WHERE channel_arn = ANY/.test(String(c[0])));
    expect((rivalCall as unknown as [string, unknown[]])[1][1]).toEqual([RIVAL_ARN]);
  });

  it('DEFERRED, second half: an empty scope keeps the offer and asks nothing', async () => {
    const { resolveDriftRival } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const offer = {
      isDrift: true, driftScore: 0.5, suggestedAction: 'confirm' as const, confidence: 'medium' as const,
      signalAvailable: true, correlationId: 'corr-y', relatedLookupPending: { messageEmbedding: [0.1] },
    };
    const result = await resolveDriftRival({
      result: offer, channelArn: CHANNEL_ARN, messageEmbedding: [0.1], scopedChannelArns: [], classification: 'standard',
    });
    expect(result.suggestedAction).toBe('confirm');
    expect(result).not.toHaveProperty('relatedLookupPending');
    expect(mockedQuery.mock.calls.some((c) => /WHERE channel_arn = ANY/.test(String(c[0])))).toBe(false);
  });

  it('creates a new conversation instead when the nearest neighbour is too far', async () => {
    const summary = mockEmbedding(1024, 0.7);
    primeDriftTurn(summary, summary.map((v) => -v));
    // Just under the threshold. A weak match must not hijack the turn into somebody else's thread.
    mockedQuery.mockResolvedValueOnce(mockRows([{ channel_arn: RIVAL_ARN, similarity: 0.79 }]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'something only loosely similar',
      intent: 'GENERAL',
      classification: 'standard',
      scopedChannelArns: SCOPE,
    });

    expect(result.isDrift).toBe(true);
    expect(result.suggestedAction).toBe('confirm');
    expect(result.rivalConversationArn).toBeUndefined();
    expect(result.suggestionTemplate).toBe('drift-offer');
  });

  it('never offers the current conversation as its own rival', async () => {
    const summary = mockEmbedding(1024, 0.7);
    primeDriftTurn(summary, summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'unrelated',
      intent: 'GENERAL',
      classification: 'standard',
      scopedChannelArns: SCOPE,
    });

    // A conversation is always the nearest neighbour to its own summary, so leaving it in the
    // candidate list would offer to take the person to where they already are.
    const rivalCall = mockedQuery.mock.calls.find((c) => /FROM summary_embeddings\s*\n?\s*WHERE channel_arn = ANY/.test(String(c[0])));
    expect(rivalCall).toBeDefined();
    const candidates = (rivalCall as unknown as [string, unknown[]])[1][1] as string[];
    expect(candidates).toEqual([RIVAL_ARN]);
    expect(candidates).not.toContain(CHANNEL_ARN);
  });

  it('suggests nothing and asks nothing when the scope is empty, rather than widening it', async () => {
    const summary = mockEmbedding(1024, 0.7);
    primeDriftTurn(summary, summary.map((v) => -v));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const before = mockedQuery.mock.calls.length;
    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'unrelated',
      intent: 'GENERAL',
      classification: 'standard',
      scopedChannelArns: [],
    });

    // FR9: an unanswerable scope means suggest nothing. Falling back to the archived membership
    // table would widen the scope past the people actually in the room, which is the disclosure the
    // control exists to prevent - so there must be no third query at all.
    expect(result.rivalConversationArn).toBeUndefined();
    expect(result.suggestedAction).toBe('confirm');
    expect(mockedQuery.mock.calls.length - before).toBe(2);
  });

  it('runs the rival lookup under the classification reader role, scoped inside the query', async () => {
    const summary = mockEmbedding(1024, 0.7);
    primeDriftTurn(summary, summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([{ channel_arn: RIVAL_ARN, similarity: 0.95 }]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    const before = mockAssumedRoles.length;
    await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'unrelated',
      intent: 'GENERAL',
      classification: 'premium',
      scopedChannelArns: SCOPE,
    });

    // TWO independent bounds, because neither subsumes the other (ADR-028). Membership alone let a
    // basic conversation point at a premium one the members happened to share; classification alone
    // would ignore who is present.
    const rivalCall = mockedQuery.mock.calls.find((c) => /FROM summary_embeddings\s*\n?\s*WHERE channel_arn = ANY/.test(String(c[0])));
    expect(String((rivalCall as unknown as [string, unknown[]])[0])).toMatch(/WHERE channel_arn = ANY\(\$2::text\[\]\)/);
    expect(mockAssumedRoles.slice(before)).toContain('ae_reader_premium');
  });

  it('matches a rival on its summary or any of its subjects, the same anchors drift compares against', async () => {
    const summary = mockEmbedding(1024, 0.7);
    primeDriftTurn(summary, summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([{ channel_arn: RIVAL_ARN, similarity: 0.9 }]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await detectDrift({
      channelArn: CHANNEL_ARN,
      latestMessage: 'unrelated',
      intent: 'GENERAL',
      classification: 'standard',
      scopedChannelArns: SCOPE,
    });

    // A conversation whose summary is broader than the one subject the message names is still the place
    // that subject lives. A pending offer is not a subject yet, so it never draws a redirect.
    const sql = String(mockedQuery.mock.calls.find((c) => /FROM summary_embeddings\s*\n?\s*WHERE channel_arn = ANY/.test(String(c[0])))?.[0]);
    expect(sql).toMatch(/FROM conversation_topic_embeddings\s*\n?\s*WHERE channel_arn = ANY\(\$2::text\[\]\) AND status <> 'offered'/);
    expect(sql).toMatch(/1 - MIN\(distance\) AS similarity/);
    expect(sql).toMatch(/GROUP BY channel_arn/);
  });
});

describe('drift outcomes record when they were decided', () => {
  it('a decline is final at once; an acceptance stays open for the engagement check', async () => {
    mockedQuery.mockResolvedValue(mockRows([]));
    const { recordDriftOutcome } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await recordDriftOutcome({ eventId: 'e1', outcome: 'declined' });
    await recordDriftOutcome({ eventId: 'e2', outcome: 'accepted', newChannelArn: CHANNEL_ARN });
    const [sql, declined] = mockedQuery.mock.calls[0] as [string, unknown[]];
    const [, accepted] = mockedQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/outcome_at = NOW\(\)/);
    expect(sql).toMatch(/engagement_settled = \$4\b/);
    expect(declined).toEqual(['declined', null, 'e1', true]);
    expect(accepted).toEqual(['accepted', CHANNEL_ARN, 'e2', false]);
  });

  it('no parameter is both assigned to a column and compared with a literal', async () => {
    // Postgres deduces a parameter's type from each use, and refuses a statement whose uses disagree
    // ("inconsistent types deduced for parameter $1"). A mock accepts any SQL, so this is checked here.
    mockedQuery.mockResolvedValue(mockRows([]));
    const { recordDriftOutcome } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await recordDriftOutcome({ eventId: 'e1', outcome: 'declined' });
    const [sql] = mockedQuery.mock.calls[0] as [string];
    const assigned = [...sql.matchAll(/=\s*(\$\d+)\b/g)].map((m) => m[1]);
    expect(assigned.length).toBeGreaterThan(0);
    for (const p of new Set(assigned)) {
      expect(sql).not.toMatch(new RegExp(`\\${p}\\s*(<>|=|!=)\\s*'`));
    }
  });

  it('a live flag in a conversation someone just moved to settles that move as rejected there, in the same statement', async () => {
    mockedQuery.mockResolvedValue(mockRows([{ event_id: 'new-evt' }]));
    const { recordDriftFire } = await import('../../lambda/src/analytics-aurora/drift-detection');
    await recordDriftFire({
      result: { isDrift: true, driftScore: 0.7, suggestedAction: 'confirm', confidence: 'high', signalAvailable: true, correlationId: '11111111-1111-1111-1111-111111111111' },
      channelArn: CHANNEL_ARN, messageId: 'm1', intent: 'GENERAL', source: 'live',
    } as never);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockedQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/SET outcome = 'rejected_in_new_channel', outcome_at = NOW\(\), engagement_settled = TRUE/);
    expect(sql).toMatch(/WHERE new_channel_arn = \$2\s+AND outcome = 'accepted'\s+AND engagement_settled = FALSE\s+AND \$10::text = 'live'/);
  });
});
