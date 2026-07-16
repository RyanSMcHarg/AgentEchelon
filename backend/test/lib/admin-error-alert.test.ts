/**
 * sendProcessorErrorAlert (async-processor-core) — the CH-parity admin alert.
 *
 * Pins: log-only (no Chime call) when unconfigured; when configured, ONE SendChannelMessage
 * to the alert channel bearing the admin ARN, carrying a `notify` directive (so the channel flow
 * fans it out to email) and analytics.userType=admin (kept out of tier metrics); and best-effort
 * (a Chime failure never throws out of the handler).
 */
const mockMessagingSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
  ApplyGuardrailCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListChannelMessagesCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Send', input })),
  DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
const BEARER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/admin-sub-admin';
const baseEvent = { channelArn: CHANNEL, userType: 'premium', taskType: 'report_generation' } as any;

describe('sendProcessorErrorAlert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_ERROR_ALERT_CHANNEL_ARN;
    delete process.env.ADMIN_ALERT_BEARER_ARN;
  });

  it('is log-only (no Chime send) when unconfigured', async () => {
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');
    await sendProcessorErrorAlert(baseEvent, new Error('boom'));
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('posts ONE alert to the channel bearing the admin ARN, with a notify directive + admin analytics', async () => {
    process.env.ADMIN_ERROR_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BEARER;
    mockMessagingSend.mockResolvedValueOnce({});
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');

    await sendProcessorErrorAlert(baseEvent, Object.assign(new Error('kaboom'), { name: 'ModelError' }));

    expect(mockMessagingSend).toHaveBeenCalledTimes(1);
    const input = mockMessagingSend.mock.calls[0][0].input;
    expect(input.ChannelArn).toBe(CHANNEL);
    expect(input.ChimeBearer).toBe(BEARER);
    const meta = JSON.parse(input.Metadata);
    expect(meta.messageType).toBe('assistant_error');
    expect(meta.errorType).toBe('ModelError');
    expect(meta.notify).toEqual({ email: true }); // drives the channel-flow email fan-out
    expect(meta.analytics.userType).toBe('admin'); // kept out of tier metrics
  });

  it('is best-effort — a Chime failure does not throw', async () => {
    process.env.ADMIN_ERROR_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BEARER;
    mockMessagingSend.mockRejectedValueOnce(new Error('chime down'));
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');
    await expect(sendProcessorErrorAlert(baseEvent, new Error('boom'))).resolves.toBeUndefined();
  });
});
