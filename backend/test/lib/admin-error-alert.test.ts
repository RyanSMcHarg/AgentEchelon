/**
 * sendProcessorErrorAlert (async-processor-core): the processor's admin alert, end to end.
 *
 * AN ALERT IS AN EVENT. The processor raises an `ae.alert` on the default bus (`lib/admin-notice.ts`) and
 * names no channel; the `AdminServices` stack's one rule hands it to the alert poster, which posts it into
 * the admin notification channel as the admin assistant (`admin-alert-poster.ts`, `lib/admin-channel-post.ts`).
 *
 * Pins: log-only (no event) when the instance is not set; when it is, ONE event carrying the notice and the
 * instance; best-effort (a bus failure never throws out of the handler); the poster posts ONE message
 * bearing the admin assistant with a `notify` directive (so the channel flow fans it out to email) and
 * analytics.classification=admin (kept out of classification metrics); and the poster refuses another
 * instance's event and throws when it cannot post, so EventBridge retries.
 */
const mockMessagingSend = jest.fn();
const mockEventsSend = jest.fn();

jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({ send: mockEventsSend })),
  PutEventsCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'PutEvents', input })),
}), { virtual: true });
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
  // The notification bridge's own commands: the subject test below runs the alert's Metadata through
  // the REAL `channel-notify`, which constructs these.
  ListChannelMembershipsCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ListMemberships', input })),
  DescribeChannelCommand: jest.fn(),
  ListTagsForResourceCommand: jest.fn(),
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
const BEARER = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/admin-agent';
const INSTANCE = 'agent-echelon';
const baseEvent = { channelArn: CHANNEL, classification: 'premium', taskType: 'report_generation' } as any;

/** The `ae.alert` events raised, as EventBridge would deliver each to the poster. */
function raised(): Array<{ source: string; 'detail-type': string; detail: any }> {
  return mockEventsSend.mock.calls.flatMap((c) => c[0].input.Entries)
    .map((e: { Source: string; DetailType: string; Detail: string }) => ({ source: e.Source, 'detail-type': e.DetailType, detail: JSON.parse(e.Detail) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEventsSend.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] });
  mockMessagingSend.mockResolvedValue({});
  delete process.env.ALERT_INSTANCE;
  delete process.env.ADMIN_ALERT_CHANNEL_ARN;
  delete process.env.ADMIN_ALERT_BEARER_ARN;
});

describe('sendProcessorErrorAlert raises an ae.alert and posts nothing itself', () => {
  it('is log-only (no event, no Amazon Chime SDK call) when the instance is not set', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');
    await sendProcessorErrorAlert(baseEvent, new Error('boom'));
    expect(mockEventsSend).not.toHaveBeenCalled();
    expect(mockMessagingSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('raises ONE event carrying the notice and the instance, and sends no message', async () => {
    process.env.ALERT_INSTANCE = INSTANCE;
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');
    await sendProcessorErrorAlert(baseEvent, Object.assign(new Error('kaboom'), { name: 'ModelError' }));

    expect(mockEventsSend).toHaveBeenCalledTimes(1);
    expect(mockMessagingSend).not.toHaveBeenCalled();
    const [event] = raised();
    expect(event.source).toBe('ae.alert');
    expect(event['detail-type']).toBe('assistant_error');
    expect(event.detail.instance).toBe(INSTANCE);
    expect(event.detail.notice.subject).toContain('ModelError');
    expect(event.detail.notice.extra).toMatchObject({ errorType: 'ModelError', classification: 'premium' });
  });

  it('is best-effort: a bus failure does not throw', async () => {
    process.env.ALERT_INSTANCE = INSTANCE;
    mockEventsSend.mockRejectedValueOnce(new Error('bus down'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');
    await expect(sendProcessorErrorAlert(baseEvent, new Error('boom'))).resolves.toBeUndefined();
    err.mockRestore();
  });
});

// This file declares its jest mocks at top level and imports the modules under test lazily, so it has
// no top-level import/export of its own; this marks it as a module so its constants do not collide with
// another script-mode test file's. Do not remove.
export {};

describe('the AdminServices alert poster', () => {
  async function anAlert() {
    process.env.ALERT_INSTANCE = INSTANCE;
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');
    await sendProcessorErrorAlert(baseEvent, Object.assign(new Error('kaboom'), { name: 'ModelError' }));
    return raised()[0];
  }

  it('posts ONE message to the admin channel bearing the admin assistant, with a notify directive and admin analytics', async () => {
    const event = await anAlert();
    process.env.ADMIN_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BEARER;
    const { handler } = await import('../../lambda/src/admin-alert-poster');
    await expect(handler(event as never)).resolves.toEqual({ posted: true });

    expect(mockMessagingSend).toHaveBeenCalledTimes(1);
    const input = mockMessagingSend.mock.calls[0][0].input;
    expect(input.ChannelArn).toBe(CHANNEL);
    expect(input.ChimeBearer).toBe(BEARER);
    const meta = JSON.parse(input.Metadata);
    expect(meta.messageType).toBe('assistant_error');
    expect(meta.errorType).toBe('ModelError');
    expect(meta.notify).toEqual({ email: true }); // drives the channel-flow email fan-out
    expect(meta.analytics.classification).toBe('admin'); // kept out of classification metrics
    expect(meta.classification).toBe('premium'); // the failing turn's conversation
  });

  it('drops an alert another instance raised', async () => {
    const event = await anAlert();
    process.env.ADMIN_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BEARER;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/admin-alert-poster');
    await expect(handler({ ...event, detail: { ...event.detail, instance: 'another-instance' } } as never)).resolves.toEqual({ posted: false });
    expect(mockMessagingSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws when it cannot post, so EventBridge retries the delivery', async () => {
    const event = await anAlert();
    process.env.ADMIN_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BEARER;
    mockMessagingSend.mockRejectedValueOnce(new Error('ForbiddenException'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/admin-alert-poster');
    await expect(handler(event as never)).rejects.toThrow(/was not posted/);
    err.mockRestore();
  });
});

describe('the subject the alert chose is the subject the email carries', () => {
  /**
   * WHY THIS DRIVES BOTH ENDS RATHER THAN ASSERTING A KEY NAME.
   *
   * The alert's Metadata and `parseNotifyDirective` are two halves of one contract, and each half read
   * as correct on its own: the alert wrote `subject`, the parser read `notifySubject`, and nothing
   * anywhere complained. So the subject is taken from the REAL poster, the REAL parser and the REAL
   * fan-out, and checked against what the failure itself says: the error's name and the conversation's
   * classification.
   */
  const MEMBER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/admin-sub';

  it('reaches the notification bridge, and the email is sent under it', async () => {
    process.env.ALERT_INSTANCE = INSTANCE;
    const { sendProcessorErrorAlert } = await import('../../lambda/src/lib/async-processor-core');
    await sendProcessorErrorAlert(baseEvent, Object.assign(new Error('kaboom'), { name: 'ModelError' }));
    process.env.ADMIN_ALERT_CHANNEL_ARN = CHANNEL;
    process.env.ADMIN_ALERT_BEARER_ARN = BEARER;
    const { handler } = await import('../../lambda/src/admin-alert-poster');
    await handler(raised()[0] as never);

    const { Metadata } = mockMessagingSend.mock.calls[0][0].input;
    const { parseNotifyDirective, fanOutChannelNotification } = await import('../../lambda/src/lib/channel-notify');

    const directive = parseNotifyDirective(Metadata);
    expect(directive).not.toBeNull();
    expect(directive!.subject).toContain('ModelError');
    expect(directive!.subject).toContain(baseEvent.classification);

    // And the whole way out: the parsed directive through the fan-out to the email it hands SES.
    // The recipient plumbing is stubbed; the subject is not.
    const emails: { subject?: string }[] = [];
    type FanArgs = Parameters<typeof fanOutChannelNotification>[0];
    await fanOutChannelNotification({
      channelArn: CHANNEL,
      bearerArn: BEARER,
      messageText: 'the alert body',
      directive: directive!,
      deps: {
        chime: { send: async () => ({ ChannelMemberships: [{ Member: { Arn: MEMBER } }] }) },
        directory: { contactFor: async () => ({ route: 'email', address: 'admin@example.com', name: null }) },
        isEmailConversation: async () => true,
        send: async (_recipients: unknown, opts: { subject?: string }) => {
          emails.push(opts);
          return { sent: ['admin@example.com'], failed: [] };
        },
      } as unknown as FanArgs['deps'],
    });

    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe(directive!.subject);
  });
});
