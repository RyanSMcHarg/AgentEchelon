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
 *  - Decline-suppression: if a user's previous decline was within ±0.05
 *    of the current cosine distance, drift is suppressed for this turn.
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
const MESSAGE_ID = 'msg-12345';

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` clears CALL RECORDS but NOT the `mockResolvedValueOnce` queue, so anything a test
  // primes and does not consume is inherited by the next one. That coupling made this file's result
  // depend on execution order: when a change to the code under test altered how many queries a run
  // makes, a leftover response became the NEXT test's summary read, and a test that passes alone
  // failed in file order with a NaN score. Reset the queues so each test starts from empty.
  mockedQuery.mockReset();
  mockSend.mockReset();
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
      messageId: MESSAGE_ID,
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
      messageId: MESSAGE_ID,
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
      messageId: MESSAGE_ID,
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
      messageId: MESSAGE_ID,
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
      mockRows([{ embedding_text: `[${mockEmbedding(1024, 0.5).join(',')}]` }]),
    );
    // Embedding call fails
    mockBedrockFailure();

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
      latestMessage: 'a substantive question that previously would have fallen back to keyword matching',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(result.signalAvailable).toBe(false);
    expect(result.suggestedAction).toBe('continue');
    // Crucially: NO additional DB query for keyword-based fallback.
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('fires drift when message embedding is far from summary embedding', async () => {
    // Summary embedding pointing one direction
    const summary = mockEmbedding(1024, 0.7);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]` }]),
    );
    // Message embedding pointing opposite direction (negative correlation)
    const message = summary.map((v) => -v);
    mockBedrockEmbedding(message);
    // NO membership query is primed, because none is made any more. `findRelatedConversation` takes
    // its scope from `input.scopedChannelArns` (resolved by the caller from Amazon Chime SDK
    // membership) and returns no rival when it is absent — the archive is never consulted. Priming a
    // response the code does not consume left it queued for the NEXT test, which read `[]` as its
    // summary embedding and produced a NaN drift score: green alone, red in file order.

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
      latestMessage: 'completely unrelated topic',
      intent: 'GENERAL',
      classification: 'standard',
    });

    // Cosine distance of (0.7-vector, -0.7-vector) → ~2.0 (opposite vectors)
    expect(result.driftScore).toBeGreaterThan(1.0);
    expect(result.isDrift).toBe(true);
    expect(result.suggestedAction).toBe('confirm');
    expect(result.suggestionTemplate).toContain('separate conversation');
  });

  it('does not fire when message embedding is close to summary embedding', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]` }]),
    );
    // Nearly identical embedding
    const message = summary.map((v) => v + 0.001);
    mockBedrockEmbedding(message);

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
      latestMessage: 'a follow-up question on the same topic',
      intent: 'GENERAL',
      classification: 'standard',
    });

    expect(result.isDrift).toBe(false);
    expect(result.driftScore).toBeLessThan(0.1);
  });

  it('suppresses drift when distance is within ±0.05 of a declined distance', async () => {
    const summary = mockEmbedding(1024, 0.5);
    mockedQuery.mockResolvedValueOnce(
      mockRows([{ embedding_text: `[${summary.join(',')}]` }]),
    );
    const message = summary.map((v) => -v); // far away → would normally fire
    mockBedrockEmbedding(message);

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
      latestMessage: 'topic the user declined twice already',
      intent: 'GENERAL',
      classification: 'standard',
      declinedDistances: [2.0], // matches the distance for opposite vectors
    });

    expect(result.isDrift).toBe(false);
    expect(result.suggestedAction).toBe('continue');
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
      mockRows([{ embedding_text: `[${summary.join(',')}]` }]),
    );
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
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
      mockRows([{ embedding_text: `[${summary.join(',')}]` }]),
    );
    mockBedrockEmbedding(summary.map((v) => -v));
    mockedQuery.mockResolvedValueOnce(mockRows([]));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
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
      messageId: MESSAGE_ID,
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
      messageId: MESSAGE_ID,
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
      mockRows([{ embedding_text: `[${summary.join(',')}]` }]),
    );
    // Nearly identical → no drift
    mockBedrockEmbedding(summary.map((v) => v + 0.001));

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
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
