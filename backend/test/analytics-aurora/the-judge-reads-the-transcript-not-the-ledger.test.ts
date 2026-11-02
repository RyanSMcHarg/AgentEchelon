/**
 * THE JUDGE READS THE TRANSCRIPT, NOT THE EXCHANGE LEDGER.
 *
 * The relevance judge used to be given the prior `exchanges` - user message paired with the reply it
 * produced. Not every message the assistant posts makes an exchange. A drift offer ("shall I move
 * that to a separate conversation?") posts directly rather than as a placeholder-then-update, carries
 * no correlation marker, and is deliberately excluded from the exchange population so that a message
 * which answers nothing does not drag the latency averages of messages that do.
 *
 * That exclusion is right for latency and wrong for a judge, and it produced a false verdict the
 * owner caught live: the assistant offered to split a topic out, the person declined and asked for
 * the answer in line, the assistant answered in line - and the judge, shown only the pairs, saw a
 * reply to a question it could not see and called it IRRELEVANT.
 *
 * So the judge now reads `messages`: the transcript the person actually read. That covers every
 * message posted outside an exchange, not just drift - task notices, the welcome, anything the
 * assistant volunteers.
 */

process.env.EVALUATOR_MODEL = 'anthropic.claude-3-5-haiku-20241022-v1:0'; // text-only judge

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn((input) => ({ kind: 'invoke', input })),
  ConverseCommand: jest.fn((input) => ({ kind: 'converse', input })),
  ApplyGuardrailCommand: jest.fn((input) => ({ kind: 'guardrail', input })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
  GetObjectCommand: jest.fn((input) => ({ input })),
  PutObjectCommand: jest.fn((input) => ({ input })),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn(), ensureSchema: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { handler } from '../../lambda/src/analytics-aurora/evaluation-runner';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const InvokeMock = InvokeModelCommand as unknown as jest.Mock;

function invokeJson(obj: unknown) {
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text: JSON.stringify(obj) }] })) };
}

/** The turn under judgement: the in-line answer the person asked for after declining the offer. */
const DECLINED_DRIFT_TURN = {
  id: 'ex-inline',
  channel_arn: 'c1',
  assistant: 'standard',
  conversation_classification: 'standard',
  intent: 'general',
  task_id: null,
  created_at: '2026-09-23T00:00:03Z',
  user_message: 'no, just answer it here',
  agent_response: 'Sure. The retention window is 90 days by default.',
  agent_metadata: {},
};

/** The transcript, as `messages` holds it - INCLUDING the offer, which is in no exchange. */
const TRANSCRIPT = [
  { content: 'How do I set up the archive?', is_bot: false },
  { content: 'You point it at a bucket and set a lifecycle rule.', is_bot: true },
  { content: 'What about the retention window?', is_bot: false },
  { content: 'That looks like a new topic. Shall I move it to a separate conversation?', is_bot: true },
];

/** What the old pair-shaped read returned for the same conversation: the offer is simply absent. */
const PAIRS_ONLY = [
  { user_message: 'How do I set up the archive?', agent_response: 'You point it at a bucket and set a lifecycle rule.' },
];

function promptText(): string {
  const call = InvokeMock.mock.calls[0]?.[0] as { body: string } | undefined;
  if (!call) return '';
  return JSON.parse(call.body).messages[0].content as string;
}

function contextQuery(): [string, unknown[]] | undefined {
  return mockedQuery.mock.calls.find(([sql]) => /FROM messages m\b/.test(sql as string)) as
    | [string, unknown[]]
    | undefined;
}

describe('the judge is shown every message, not only the paired ones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery
      .mockResolvedValueOnce({ rows: [DECLINED_DRIFT_TURN], rowCount: 1 } as never) // getUnscoredExchanges
      .mockResolvedValueOnce({ rows: TRANSCRIPT, rowCount: TRANSCRIPT.length } as never) // getPriorMessages
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // INSERT evaluation_results
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // getFlowsToScore
    mockSend.mockResolvedValueOnce(
      invokeJson({ relevanceScore: 88, classification: 'good', reasoning: 'answered what was asked' }),
    );
  });

  it('puts the drift offer in the prompt, so "no, just answer it here" has something to refer to', async () => {
    await handler({});
    // THE WHOLE POINT. Without this line the judge sees a decline of nothing.
    expect(promptText()).toContain('Shall I move it to a separate conversation?');
  });

  it('attributes each line, so the judge knows who offered and who declined', async () => {
    await handler({});
    const text = promptText();
    expect(text).toContain('User: What about the retention window?');
    expect(text).toContain('Assistant: That looks like a new topic.');
  });

  it('tells the judge that answering in line after a decline is correct', async () => {
    await handler({});
    // The transcript alone leaves the judge to infer what a decline licenses. The rubric says it,
    // because the observed failure was a judge that had the facts and drew the wrong conclusion.
    expect(promptText().toLowerCase()).toContain('declined');
  });

  it('reads the MESSAGE timeline, not the exchange pairs', async () => {
    await handler({});
    const ctx = contextQuery();
    expect(ctx).toBeDefined();
    const [sql, params] = ctx!;
    // Scoped to this conversation, and only what preceded the turn being judged.
    expect(params[0]).toBe('c1');
    expect(params[1]).toBe('2026-09-23T00:00:03Z');
    // No join to `exchanges` - that join is what dropped the offer.
    expect(sql).not.toMatch(/FROM exchanges/);
    expect(sql).toContain('is_bot');
  });

  it('prefers the edited text, so a redacted message is judged as it now reads', async () => {
    await handler({});
    expect(contextQuery()![0]).toContain('COALESCE(m.updated_content, m.content)');
  });
});

describe('the shape the fix replaced', () => {
  it('the pair-shaped view genuinely loses the offer, which is why this changed', () => {
    // Not a test of the code - a test of the PREMISE, so that if somebody reverts to pairs they see
    // stated here what pairs cannot carry. The offer is an assistant message with no user message
    // paired to it, so no arrangement of `user_message`/`agent_response` has a slot for it.
    const flattened = PAIRS_ONLY.flatMap((p) => [p.user_message, p.agent_response]);
    expect(flattened).not.toContain('That looks like a new topic. Shall I move it to a separate conversation?');
    expect(TRANSCRIPT.map((m) => m.content)).toContain(
      'That looks like a new topic. Shall I move it to a separate conversation?',
    );
  });
});

describe('an empty transcript still judges', () => {
  it('says so in words rather than sending an empty section', async () => {
    jest.clearAllMocks();
    mockedQuery
      .mockResolvedValueOnce({ rows: [DECLINED_DRIFT_TURN], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // no prior messages
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockSend.mockResolvedValueOnce(invokeJson({ relevanceScore: 70, classification: 'good', reasoning: 'ok' }));

    const res = await handler({});
    expect(JSON.parse(res.body).evaluated).toBe(1);
    expect(promptText()).toContain('this is the first turn of the conversation');
  });
});
