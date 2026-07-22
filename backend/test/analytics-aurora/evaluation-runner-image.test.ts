/**
 * Image-turn evaluation routing — an `image_generation` turn is judged on the GENERATED IMAGE with a
 * vision judge (Converse image block), NOT on its caption text; a text turn still goes to the text
 * judge (InvokeModel); and an un-judgeable image is SKIPPED (left unscored), never mis-scored.
 */

// Vision judge needs the attachments bucket + a vision-capable model; set both BEFORE the module loads.
process.env.ATTACHMENTS_BUCKET = 'attach-bucket';
process.env.EVALUATOR_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';
delete process.env.VISION_EVALUATOR_MODEL;

const mockSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  // Tag each command by kind so the test can assert WHICH judge (text vs vision) was invoked.
  InvokeModelCommand: jest.fn((input) => ({ kind: 'invoke', input })),
  ConverseCommand: jest.fn((input) => ({ kind: 'converse', input })),
  ApplyGuardrailCommand: jest.fn((input) => ({ kind: 'guardrail', input })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn((input) => ({ input })),
  PutObjectCommand: jest.fn((input) => ({ input })),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import {
  InvokeModelCommand,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { handler, isVisionCapableJudgeId } from '../../lambda/src/analytics-aurora/evaluation-runner';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const ConverseMock = ConverseCommand as unknown as jest.Mock;
const InvokeMock = InvokeModelCommand as unknown as jest.Mock;

/** A Converse (vision judge) response carrying the judge's JSON verdict. */
function converseJson(obj: unknown) {
  return { output: { message: { content: [{ text: JSON.stringify(obj) }] } } };
}
/** An InvokeModel (text judge) response carrying the judge's JSON verdict. */
function invokeJson(obj: unknown) {
  const payload = JSON.stringify({ content: [{ text: JSON.stringify(obj) }] });
  return { body: new TextEncoder().encode(payload) };
}

const IMAGE_EXCHANGE = {
  id: 'ex-img',
  channel_arn: 'c1',
  agent_type: 'premium',
  user_type: 'human',
  intent: 'image_generation',
  task_id: null,
  created_at: '2026-07-15T00:00:00Z',
  user_message: 'a red bicycle on a beach at sunset',
  agent_response: 'Generated an image with Titan.',
  agent_metadata: { attachment: { fileKey: 'battle-images/c1/ts-0.png', name: 'g.png', size: 100, type: 'image/png' } },
};

const TEXT_EXCHANGE = {
  id: 'ex-txt',
  channel_arn: 'c1',
  agent_type: 'premium',
  user_type: 'human',
  intent: 'general',
  task_id: null,
  created_at: '2026-07-15T00:00:00Z',
  user_message: 'what is the capital of France?',
  agent_response: 'Paris.',
  agent_metadata: {},
};

function findInsert() {
  return mockedQuery.mock.calls.find(([sql]) => /INSERT INTO evaluation_results/.test(sql as string)) as
    | [string, unknown[]]
    | undefined;
}

describe('image-turn evaluation routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockS3Send.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
  });

  it('isVisionCapableJudgeId: Claude judges read images except 3.5 Haiku', () => {
    expect(isVisionCapableJudgeId('anthropic.claude-3-haiku-20240307-v1:0')).toBe(true);
    expect(isVisionCapableJudgeId('anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe(true);
    expect(isVisionCapableJudgeId('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(true);
    expect(isVisionCapableJudgeId('anthropic.claude-3-5-haiku-20241022-v1:0')).toBe(false); // text-only
    expect(isVisionCapableJudgeId('amazon.titan-text-express-v1')).toBe(false);
    expect(isVisionCapableJudgeId(undefined)).toBe(false);
  });

  it('routes an image_generation turn to the VISION judge (image block), not the text judge', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [IMAGE_EXCHANGE], rowCount: 1 } as never) // getUnscoredExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // INSERT evaluation_results
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // getFlowsToScore (Pass B: nothing)
    mockSend.mockResolvedValueOnce(converseJson({ relevanceScore: 82, classification: 'good', reasoning: 'depicts the request' }));

    const res = await handler({});
    const body = JSON.parse(res.body);
    expect(body.evaluated).toBe(1);
    expect(body.imageSkipped).toBe(0);

    // Vision judge used; text judge NOT used; the image was fetched from the attachments bucket.
    expect(ConverseMock).toHaveBeenCalledTimes(1);
    expect(InvokeMock).not.toHaveBeenCalled();
    expect(mockS3Send).toHaveBeenCalledTimes(1);

    // The Converse call carries the prompt + a well-formed image block (bytes from S3).
    const converseInput = ConverseMock.mock.calls[0][0] as { modelId: string; messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(converseInput.modelId).toBe('anthropic.claude-3-haiku-20240307-v1:0');
    const blocks = converseInput.messages[0].content;
    expect(blocks.some((b) => 'text' in b)).toBe(true);
    expect(blocks).toContainEqual({ image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } });

    // The image score is written into the SAME columns as a text score (evaluator_model = the vision judge).
    const insert = findInsert();
    expect(insert).toBeDefined();
    const [, params] = insert!;
    expect(params[2]).toBe('anthropic.claude-3-haiku-20240307-v1:0'); // evaluator_model
    expect(params[3]).toBe(82); // relevance_score
    expect(params[4]).toBe('good'); // classification
  });

  it('routes a text turn to the TEXT judge (InvokeModel), not the vision judge', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [TEXT_EXCHANGE], rowCount: 1 } as never) // getUnscoredExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // getPriorTurns (context)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // INSERT evaluation_results
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // getFlowsToScore
    mockSend.mockResolvedValueOnce(invokeJson({ relevanceScore: 90, classification: 'excellent', reasoning: 'correct' }));

    const res = await handler({});
    const body = JSON.parse(res.body);
    expect(body.evaluated).toBe(1);

    // Text judge used; vision judge NOT used; no image fetch.
    expect(InvokeMock).toHaveBeenCalledTimes(1);
    expect(ConverseMock).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();

    const insert = findInsert();
    expect(insert).toBeDefined();
    expect(insert![1][3]).toBe(90); // relevance_score from the text judge
  });

  it('SKIPS an image turn with no attachment — no misleading score is written', async () => {
    const noAttachment = { ...IMAGE_EXCHANGE, id: 'ex-img-noatt', agent_metadata: {} };
    mockedQuery
      .mockResolvedValueOnce({ rows: [noAttachment], rowCount: 1 } as never) // getUnscoredExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // getFlowsToScore (Pass B) — NO insert in between

    const res = await handler({});
    const body = JSON.parse(res.body);
    expect(body.evaluated).toBe(0);
    expect(body.imageSkipped).toBe(1);

    // Neither judge ran; nothing fetched; nothing written → the turn stays unscored (retried next run).
    expect(ConverseMock).not.toHaveBeenCalled();
    expect(InvokeMock).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(findInsert()).toBeUndefined();
  });

  it('SKIPS an image turn when the image fetch fails (degrades safely)', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [IMAGE_EXCHANGE], rowCount: 1 } as never) // getUnscoredExchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // getFlowsToScore — NO insert
    mockS3Send.mockReset();
    mockS3Send.mockRejectedValueOnce(new Error('s3 down'));

    const res = await handler({});
    const body = JSON.parse(res.body);
    expect(body.evaluated).toBe(0);
    expect(body.imageSkipped).toBe(1);
    expect(ConverseMock).not.toHaveBeenCalled(); // never reached the judge
    expect(findInsert()).toBeUndefined();
  });
});
