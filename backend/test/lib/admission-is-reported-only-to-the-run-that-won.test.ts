/**
 * THE PIPELINE REPORTS ADMISSION ONLY TO THE RUN THAT WON THE DEDUP CLAIM.
 *
 * The processor's `finally` settles the turn lock only for an admitted run
 * (`a-duplicate-run-does-not-release-the-live-lock.test.ts`). That is only as good as the flag it
 * reads: a duplicate delivery must come back not admitted, and a run that won must be marked admitted
 * before anything that can throw, because a run that throws after winning still owns the lock.
 */

const mockClaim = jest.fn();

jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/abuse-controls.js'),
  claimCorrelation: (...a: unknown[]) => mockClaim(...a),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
  InvokeModelCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ListChannelMessagesCommand: jest.fn(),
  GetChannelMessageCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(),
  DescribeChannelCommand: jest.fn(),
  UpdateChannelCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(),
  GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

import { runSharedPipeline } from '../../lambda/src/lib/async-processor-core';

const EVENT = {
  channelArn: 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-1',
  correlationId: 'corr-dup',
  botArn: 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default',
  senderArn: 'arn:aws:chime:us-east-1:111:app-instance/i/user/sub-1',
  userMessage: 'hello',
  placeholderMessageId: 'placeholder-msg-id',
  conversationHistory: [{ role: 'user', content: 'earlier' }],
} as unknown as Parameters<typeof runSharedPipeline>[0];

beforeEach(() => jest.clearAllMocks());

describe('runSharedPipeline admission', () => {
  it('a duplicate that loses the claim is not admitted', async () => {
    mockClaim.mockResolvedValue(false);
    const admission = { admitted: false };

    expect(await runSharedPipeline(EVENT, admission)).toBeNull();
    expect(admission.admitted).toBe(false);
  });

  it('the run that wins the claim is admitted', async () => {
    mockClaim.mockResolvedValue(true);
    const admission = { admitted: false };

    await runSharedPipeline(EVENT, admission);
    expect(admission.admitted).toBe(true);
  });

  it('a run missing its identity is not admitted, and claims nothing', async () => {
    const admission = { admitted: false };

    expect(await runSharedPipeline({ ...EVENT, botArn: '' }, admission)).toBeNull();
    expect(admission.admitted).toBe(false);
    expect(mockClaim).not.toHaveBeenCalled();
  });
});
