/**
 * summary-updater — scheduled Lambda that generates fresh
 * conversation_summaries via Bedrock Haiku and triggers the embedding
 * writer inline.
 *
 * Tests pin:
 *
 *   1. Empty active-channel set → no-op return shape.
 *   2. Channel with messages but Bedrock fails → failed counter increments,
 *      doesn't throw, doesn't write summary/embedding.
 *   3. Channel with messages + valid Bedrock JSON → INSERT into
 *      conversation_summaries and call writeSummaryEmbedding inline.
 *   4. Version-race: if the INSERT returns 0 rows (another writer won),
 *      the embedding write is skipped.
 *   5. parseSummaryJson tolerates fenced/prefixed JSON output from the LLM.
 *
 * Embedding-writer is mocked at module boundary so this test pins the
 * orchestration only; the embedding-writer module has its own tests.
 */

import type { QueryResult, QueryResultRow } from 'pg';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  ensureSchema: jest.fn(),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args: unknown) => ({ __args: args })),
}));

const mockWriteEmbedding = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/embedding-writer', () => ({
  writeSummaryEmbedding: mockWriteEmbedding,
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { UTILITY_MODEL_ID } from '../../lib/config/model-strategy';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

function mockHaikuResponse(jsonText: string): void {
  mockBedrockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ content: [{ text: jsonText }] })),
  });
}

const CHANNEL_ARN = 'arn:aws:chime:us-east-1:1:app-instance/test/channel/c1';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DB_HOST = 'localhost';
  process.env.DB_NAME = 'analytics';
  process.env.DB_USER = 'testuser';
  process.env.DB_REGION = 'us-east-1';
  mockWriteEmbedding.mockResolvedValue({ written: true });
});

describe('summary-updater handler', () => {
  it('no active channels → returns { processed: 0, failed: 0 }', async () => {
    // Scan returns empty channel set.
    mockedQuery.mockResolvedValueOnce(mockRows([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('skips channels with no messages — bedrock + write are not called', async () => {
    mockedQuery
      // findActiveChannels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // pull recent messages → empty
      .mockResolvedValueOnce(mockRows([]));

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  /**
   * A TARGETED MESSAGE IS NOT PART OF THE CONVERSATION'S SHARED SUBJECT.
   *
   * `target_arn` holds the one member a message was addressed to. The content select carried no
   * predicate on it, so a privately-addressed question and the assistant's targeted reply to it were
   * both summarized into the channel-wide summary - the one every member can read and the one drift
   * builds its anchor from. The blast radius is wider than the text: `summary_embeddings` is embedded
   * FROM this summary and the per-subject rows come from the `topics[]` it returned, so one missing
   * predicate put private content into three places.
   */
  it('never summarizes a message addressed to one member', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(mockRows([]));

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await handler();

    const fetch = mockedQuery.mock.calls.find(([sql]) => /FROM messages\b/.test(String(sql))
      && /content IS NOT NULL/.test(String(sql)))!;
    // Asserted on the SQL because there is no other way to prove a row was never read: a test that
    // fed it untargeted rows and checked the output would pass whether or not the predicate exists.
    expect(String(fetch[0])).toMatch(/AND\s+target_arn\s+IS\s+NULL/);
  });

  /**
   * THE TURN-ONE SEED IS NOT CARRIED FORWARD, WHICH IS WHAT KEEPS THE TARGETING FILTER HONEST.
   *
   * The transcript filter cannot reach `seedSummaryFromExchange`: it is handed the opening exchange in
   * memory to avoid the archival lag, so a targeted first turn still seeds version 1 from private
   * content. Feeding that version forward as `previousSummary` would carry it into every later version
   * and past the filter permanently - a clean transcript beside a contaminated anchor.
   */
  function prompts(): string[] {
    return mockBedrockSend.mock.calls.map(([cmd]) => {
      // The mock wraps the constructor args as `__args`, so the prompt is at `__args.body`.
      const body = (cmd as { __args?: { body?: string } })?.__args?.body ?? '';
      return String(body);
    });
  }

  function runWithPrevious(previous: Record<string, unknown> | null) {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([{
          channel_arn: CHANNEL_ARN, current_version: 1,
          last_summary_at: '2026-05-21T00:00:00Z', newest_message_at: '2026-05-22T00:00:00Z',
        }]),
      )
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'the shared subject', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      .mockResolvedValueOnce(mockRows(previous ? [previous] : []));
  }

  it('rebuilds rather than extending a turn-one seed, so a seeded secret cannot persist', async () => {
    runWithPrevious({
      version: 1, summary: 'SEEDED-SECRET-TEXT', purpose: 'seeded purpose',
      topics: ['seeded topic'], generated_by: 'summary-seed',
    });
    mockBedrockSend.mockRejectedValueOnce(new Error('stop after the prompt (simulated)'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await handler();
    warnSpy.mockRestore();
    logSpy.mockRestore();

    const all = prompts().join('\n');
    expect(all).toContain('the shared subject');
    // The seed's text, purpose and topics are all dropped - not just the summary field.
    expect(all).not.toContain('SEEDED-SECRET-TEXT');
    expect(all).not.toContain('seeded purpose');
    expect(all).not.toContain('seeded topic');
  });

  it('DOES carry a drift-spawn seed forward, because that one is shared by construction', async () => {
    // A split-out conversation's version 1 is the topic the person accepted when they agreed to split,
    // in their own words, and the new conversation may have no messages of its own yet - so dropping
    // it would leave the anchor empty. The distinction is deliberate, not incidental.
    runWithPrevious({
      version: 1, summary: 'the Q3 revenue forecast', purpose: 'forecasting',
      topics: ['Q3 revenue'], generated_by: 'drift-spawn',
    });
    mockBedrockSend.mockRejectedValueOnce(new Error('stop after the prompt (simulated)'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await handler();
    warnSpy.mockRestore();

    expect(prompts().join('\n')).toContain('the Q3 revenue forecast');
  });

  it('Bedrock failure: processed++ (best-effort), no summary write, no embedding', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi there', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      // pull existing summary
      .mockResolvedValueOnce(mockRows([]));

    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock 5xx (simulated)'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    warnSpy.mockRestore();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('happy path: writes a new summary row + invokes writeSummaryEmbedding inline', async () => {
    mockedQuery
      // findActiveChannels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: 2,
            last_summary_at: '2026-05-21T00:00:00Z',
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // pull recent messages
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'we need to ship the migration tonight', created_at: '2026-05-22T00:00:00Z' },
          { sender_name: null, is_bot: true, content: 'ok — what step is failing?', created_at: '2026-05-22T00:00:01Z' },
        ]),
      )
      // pull existing summary
      .mockResolvedValueOnce(
        mockRows([
          { version: 2, summary: 'Earlier discussion of the staging migration.', purpose: 'ops', topics: ['migration'] },
        ]),
      )
      // NOTE: no getMessageCount hop any more - `message_count` is not written (ADR-020 / migration
      // 015), so the INSERT is the very next query. Leaving the old mock queued here made the INSERT
      // consume the COUNT row and left the real INSERT mock unconsumed, so this assertion passed
      // without the write it claims to check ever being exercised.
      // INSERT new version
      .mockResolvedValueOnce(mockRows([{ version: 3 }]));

    mockHaikuResponse(JSON.stringify({
      summary: 'Coordinating tonight\'s production database migration.',
      purpose: 'migration coordination',
      topics: ['migration', 'staging', 'release'],
      key_points: ['target window 10pm UTC', 'rollback plan ready'],
    }));

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).toHaveBeenCalledTimes(1);
    expect(mockWriteEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL_ARN,
      summaryText: expect.stringContaining('database migration'),
      fromVersion: 3,
    }));

    // Find the INSERT call and verify the version increment + writer attribution.
    const insertCall = mockedQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO conversation_summaries'),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall!;
    expect(params).toEqual([
      CHANNEL_ARN,
      'migration coordination',
      'Coordinating tonight\'s production database migration.',
      ['migration', 'staging', 'release'],
      ['target window 10pm UTC', 'rollback plan ready'],
      // `message_count` is NO LONGER written (ADR-020, migration 015): it stored the channel TOTAL,
      // which is channel STATE frozen into a versioned row, not provenance for this summary version.
      // Readers count it live from `messages`. The parameter list is the assertion that the column
      // really is gone from the write path, not just from the schema.
      3, // previousVersion(2) + 1
      // The utility model, read from the one place it is declared rather than copied. The literal
      // that used to be here was an end-of-life model, and a copy in a test is one more place that
      // has to be found when it moves (it was in fourteen files on 2026-09-17).
      UTILITY_MODEL_ID,
    ]);
  });

  it('version race: INSERT returns 0 rows → skip embedding write (another writer won)', async () => {
    mockedQuery
      // findActiveChannels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: 1,
            last_summary_at: '2026-05-21T00:00:00Z',
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // pull messages
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      // pull existing summary
      .mockResolvedValueOnce(mockRows([]))
      // INSERT → 0 rows (race lost)
      .mockResolvedValueOnce(mockRows<{ version: number }>([]));

    mockHaikuResponse(JSON.stringify({
      summary: 'A summary.',
      purpose: 'p',
      topics: ['t'],
      key_points: [],
    }));

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('tolerates fenced/prefixed JSON in Haiku output (strips outer prose)', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hello', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));  // INSERT (no message-count hop)

    // Realistic Haiku output: fenced block + leading prose.
    mockHaikuResponse(
      'Sure, here is the JSON:\n\n```json\n' +
      JSON.stringify({
        summary: 'A short hello.',
        purpose: 'greet',
        topics: ['greeting'],
        key_points: [],
      }) +
      '\n```',
    );

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      summaryText: 'A short hello.',
    }));
  });

  it('rejects malformed Bedrock JSON (no {} block) — channel processed, no writes', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: CHANNEL_ARN,
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      .mockResolvedValueOnce(mockRows([]));

    mockHaikuResponse('Sorry, I cannot summarize this conversation.');

    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('per-channel failure does not poison the batch', async () => {
    mockedQuery
      // findActiveChannels — two channels
      .mockResolvedValueOnce(
        mockRows([
          {
            channel_arn: 'arn:.../c-fail',
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
          {
            channel_arn: 'arn:.../c-ok',
            current_version: null,
            last_summary_at: null,
            newest_message_at: '2026-05-22T00:00:00Z',
          },
        ]),
      )
      // c-fail: messages lookup throws
      .mockRejectedValueOnce(new Error('connection blip'))
      // c-ok: full happy path
      .mockResolvedValueOnce(
        mockRows([
          { sender_name: 'alice', is_bot: false, content: 'hi', created_at: '2026-05-22T00:00:00Z' },
        ]),
      )
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));  // INSERT (no message-count hop)

    mockHaikuResponse(JSON.stringify({
      summary: 'ok',
      purpose: 'p',
      topics: ['t'],
      key_points: [],
    }));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const result = await handler();
    warnSpy.mockRestore();

    expect(result).toEqual({ processed: 1, failed: 1 });
    expect(mockWriteEmbedding).toHaveBeenCalledTimes(1);
  });
});

/**
 * A SPLIT-OUT CONVERSATION IS SEEDED FROM THE TOPIC THAT CREATED IT.
 *
 * Every other summary compresses a transcript, so it needs a model. This one has nothing to compress:
 * the person was asked whether to move a subject to a separate conversation and said yes, so the
 * subject is settled and in their own words before the new conversation has any messages at all.
 *
 * The seed is what lets `detectDrift` tell this version-1 anchor from the turn-one seed, which it
 * refuses to compare against. Without it, a conversation created BECAUSE of a topic would be the one
 * place drift stayed blind longest.
 */
describe('seedSummaryFromDriftTopic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockReset();
    mockBedrockSend.mockReset();
    mockWriteEmbedding.mockReset();
    mockWriteEmbedding.mockResolvedValue({ written: true });
  });

  async function seed(input: { channelArn: string; topicLabel: string; originatingMessageText?: string }) {
    const { seedSummaryFromDriftTopic } = await import('../../lambda/src/analytics-aurora/summary-updater');
    return seedSummaryFromDriftTopic(input);
  }

  it('writes version 1 stamped drift-spawn, which is what drift reads', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([])) // no existing summary
      .mockResolvedValueOnce(mockRows([{ version: 1 }])); // the INSERT

    const res = await seed({
      channelArn: CHANNEL_ARN,
      topicLabel: 'quarterly revenue forecasting',
      originatingMessageText: "let's talk about quarterly revenue forecasting for the EMEA region",
    });

    expect(res.seeded).toBe(true);
    const insert = mockedQuery.mock.calls.find(([sql]) =>
      /INSERT INTO conversation_summaries/.test(String(sql)),
    );
    expect(insert).toBeDefined();
    // The provenance is the whole point: `summary-seed` would be treated as thin and silence drift.
    expect(String(insert![0])).toContain("'drift-spawn'");
    expect(String(insert![0])).toMatch(/\$5::text\[\], 1,/); // version 1, positionally
  });

  it('costs no model call, because there is nothing to compress', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));

    await seed({ channelArn: CHANNEL_ARN, topicLabel: 'a topic' });

    // A Bedrock call here would add a failure mode and a latency to the conversation-creation path
    // in exchange for restating words somebody already chose.
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('embeds the topic AND the person own words, so the anchor carries the full subject', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));

    await seed({
      channelArn: CHANNEL_ARN,
      topicLabel: 'quarterly revenue forecasting',
      originatingMessageText: 'how does EMEA affect the quarterly revenue forecast?',
    });

    expect(mockWriteEmbedding).toHaveBeenCalledWith({
      channelArn: CHANNEL_ARN,
      summaryText: 'quarterly revenue forecasting. how does EMEA affect the quarterly revenue forecast?',
      fromVersion: 1,
      // A SPAWNED CONVERSATION, and the anchor has to say so. It has its topic before its first
      // message, so a reader at version 1 cannot otherwise tell it from an ordinary new conversation
      // with nothing to drift from - and treating it as the latter suppresses drift on a room that
      // exists precisely because the subject changed.
      generatedBy: 'drift-spawn',
    });
  });

  it('falls back to the label alone when the originating message could not be read', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));

    await seed({ channelArn: CHANNEL_ARN, topicLabel: 'quarterly revenue forecasting' });

    expect(mockWriteEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ summaryText: 'quarterly revenue forecasting' }),
    );
  });

  it('leaves an existing summary alone, so it is safe to call more than once', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows([{ version: 3 }])); // already summarised

    const res = await seed({ channelArn: CHANNEL_ARN, topicLabel: 'a topic' });

    expect(res).toEqual({ seeded: false, reason: 'already-summarised' });
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no topic, rather than seeding an empty anchor', async () => {
    // An empty anchor is worse than none: drift would compare every message against nothing and the
    // distance would be meaningless rather than absent.
    const res = await seed({ channelArn: CHANNEL_ARN, topicLabel: '   ' });

    expect(res).toEqual({ seeded: false, reason: 'no-topic' });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('still reports seeded when the embedding write fails, because the row is the marker', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([{ version: 1 }]));
    mockWriteEmbedding.mockRejectedValueOnce(new Error('Bedrock 5xx (simulated)'));

    const res = await seed({ channelArn: CHANNEL_ARN, topicLabel: 'a topic' });

    // The conversation already exists and the person is already in it. The scheduled writer catches up.
    expect(res.seeded).toBe(true);
  });
});

/**
 * THE SUMMARY FOLLOWS THE CONVERSATION. Archival calls `summarizeChannelsNow` for the
 * conversations it has just written an answer into; the scheduled scan is the backstop.
 */
describe('summarizeChannelsNow - the event-driven refresh archival calls', () => {
  const OTHER = 'arn:aws:chime:us-east-1:1:app-instance/test/channel/c2';

  it('skips a conversation whose latest summary is already newer than its newest message', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows([{
      channel_arn: CHANNEL_ARN, current_version: 3,
      last_summary_at: '2026-10-14T10:00:05Z', newest_message_at: '2026-10-14T10:00:00Z',
    }]));
    const { summarizeChannelsNow } = await import('../../lambda/src/analytics-aurora/summary-updater');
    expect(await summarizeChannelsNow([CHANNEL_ARN])).toEqual({ summarized: 0, deferred: 0 });
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('is bounded per batch, deduplicated, and leaves the rest to the scheduled scan', async () => {
    mockedQuery.mockResolvedValue(mockRows([]));
    const { summarizeChannelsNow } = await import('../../lambda/src/analytics-aurora/summary-updater');
    const many = [CHANNEL_ARN, CHANNEL_ARN, OTHER, 'c3', 'c4', 'c5'];
    const result = await summarizeChannelsNow(many);
    expect(result.deferred).toBe(2); // five distinct, three now
    expect(mockedQuery.mock.calls.length).toBe(3);
  });

  it('never throws, so archival cannot fail over a summary', async () => {
    mockedQuery.mockRejectedValueOnce(new Error('connection reset'));
    const { summarizeChannelsNow } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await expect(summarizeChannelsNow([CHANNEL_ARN])).resolves.toEqual({ summarized: 0, deferred: 0 });
  });

  it('archival calls it after the commit, only for conversations an assistant just answered', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/kinesis-archival.ts'), 'utf8');
    const at = src.indexOf('await summarizeChannelsNow(answered)');
    expect(at).toBeGreaterThan(src.indexOf('emitArchivalHealth({ archived: records.length'));
    expect(src).toMatch(/filter\(\(r\) => r\.is_bot && \(r\.event_type === 'CREATE_CHANNEL_MESSAGE'/);
  });
});

describe('a conversation is summarized only once a person has spoken in it', () => {
  it('leaves a conversation holding only the welcome unsummarized, so the first question is not drift', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([{ channel_arn: CHANNEL_ARN, current_version: null, last_summary_at: null, newest_message_at: '2026-10-15T02:16:56Z' }]))
      .mockResolvedValueOnce(mockRows([{ sender_name: 'Advisor', is_bot: true, content: 'Hi - I am your assistant at Stratum', created_at: '2026-10-15T02:16:56Z' }]));
    const { summarizeChannelsNow } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await summarizeChannelsNow([CHANNEL_ARN]);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('reads message events only, never channel or membership events the service admin sent', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([{ channel_arn: CHANNEL_ARN, current_version: null, last_summary_at: null, newest_message_at: '2026-10-15T02:16:56Z' }]))
      .mockResolvedValueOnce(mockRows([]));
    const { summarizeChannelsNow } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await summarizeChannelsNow([CHANNEL_ARN]);
    expect(String(mockedQuery.mock.calls[1][0])).toMatch(/event_type IN \('CREATE_CHANNEL_MESSAGE', 'UPDATE_CHANNEL_MESSAGE'\)/);
  });
});
