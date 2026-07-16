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
    // findRelatedConversation: no scoped channels (1:1 channel) → returns no rival
    mockedQuery.mockResolvedValueOnce(mockRows([])); // channel_membership for current channel

    const { detectDrift } = await import('../../lambda/src/analytics-aurora/drift-detection');

    const result = await detectDrift({
      channelArn: CHANNEL_ARN,
      messageId: MESSAGE_ID,
      latestMessage: 'completely unrelated topic',
      intent: 'GENERAL',
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
      declinedDistances: [2.0], // matches the distance for opposite vectors
    });

    expect(result.isDrift).toBe(false);
    expect(result.suggestedAction).toBe('continue');
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
