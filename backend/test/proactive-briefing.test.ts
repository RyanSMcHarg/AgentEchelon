/**
 * Proactive Briefing Lambda — unit tests.
 *
 * This is the proactive-workflow test that was explicitly missing. It
 * pins: an EventBridge fire (no user) creates a bot-owned conversation,
 * adds members, renders the on-the-fly page to S3 + signs a URL, seeds
 * the conversation, and emails members via the notification workflow —
 * resiliently (a member-add failure doesn't abort) and degrading
 * cleanly when REPORT_BUCKET / recipients are absent.
 *
 * Mocks the AWS SDK clients + the notification module so the test is
 * pure (no SES/Chime/S3). Mirrors channel-battle.test.ts mocking +
 * battle-state.test.ts reset-modules-per-test (the Lambda captures
 * several env vars at module load).
 */

const mockChimeSend = jest.fn();
const mockSsmSend = jest.fn();
const mockS3Send = jest.fn();
const mockGetSignedUrl = jest.fn();
const mockSendEmail = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockChimeSend })),
  CreateChannelCommand: jest.fn().mockImplementation((i) => ({ __t: 'CreateChannel', i })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((i) => ({ __t: 'AddMember', i })),
  AssociateChannelFlowCommand: jest.fn().mockImplementation((i) => ({ __t: 'AssocFlow', i })),
  SendChannelMessageCommand: jest.fn().mockImplementation((i) => ({ __t: 'SendMsg', i })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((i) => ({ __t: 'GetParam', i })),
}), { virtual: true });

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((i) => ({ __t: 'Put', i })),
  GetObjectCommand: jest.fn().mockImplementation((i) => ({ __t: 'Get', i })),
}), { virtual: true });

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...a: unknown[]) => mockGetSignedUrl(...a),
}), { virtual: true });

jest.mock('../lambda/src/lib/notification', () => ({
  sendEmailNotifications: (...a: unknown[]) => mockSendEmail(...a),
}));

const MEMBERS = [
  { userArn: 'arn:user/a', email: 'a@stratum.example.com', name: 'Demo Basic' },
  { userArn: 'arn:user/b', email: 'b@stratum.example.com', name: 'Demo Standard' },
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i';
  process.env.BOT_ARN_PARAM = '/agent/bot-arn';
  process.env.CHANNEL_FLOW_ARN_PARAM = '/agent/flow-arn';
  process.env.REPORT_BUCKET = 'briefings-bucket';
  process.env.APP_URL = 'https://app.example';
  process.env.BRIEFING_RECIPIENTS = JSON.stringify(MEMBERS);
  mockSsmSend.mockResolvedValue({ Parameter: { Value: 'arn:bot/default' } });
  mockChimeSend.mockImplementation((cmd) =>
    cmd.__t === 'CreateChannel'
      ? Promise.resolve({ ChannelArn: 'arn:channel/proactive-1' })
      : Promise.resolve({}),
  );
  mockS3Send.mockResolvedValue({});
  mockGetSignedUrl.mockResolvedValue('https://s3.example/briefings/x.html?sig');
  mockSendEmail.mockResolvedValue({ sent: ['a@stratum.example.com', 'b@stratum.example.com'], failed: [] });
});

describe('proactive-briefing handler', () => {
  it('no recipients configured → ok, and nothing is created', async () => {
    process.env.BRIEFING_RECIPIENTS = '[]';
    const { handler } = await import('../lambda/src/proactive-briefing');
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(true);
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('creates a bot-owned RESTRICTED/PRIVATE conversation and adds every member', async () => {
    const { handler } = await import('../lambda/src/proactive-briefing');
    const res = await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' });

    expect(res.ok).toBe(true);
    expect(res.conversationArn).toBe('arn:channel/proactive-1');

    const create = mockChimeSend.mock.calls.find((c) => c[0].__t === 'CreateChannel')![0];
    expect(create.i.Mode).toBe('RESTRICTED');
    expect(create.i.Privacy).toBe('PRIVATE');
    expect(create.i.ChimeBearer).toBe('arn:bot/default');
    expect(JSON.parse(create.i.Metadata).createdViaProactive).toBe(true);

    const adds = mockChimeSend.mock.calls.filter((c) => c[0].__t === 'AddMember');
    expect(adds.map((a) => a[0].i.MemberArn).sort()).toEqual(['arn:user/a', 'arn:user/b']);
  });

  it('renders the page to S3 and signs a GET URL (created on the fly)', async () => {
    const { handler } = await import('../lambda/src/proactive-briefing');
    const res = await handler({ source: 'aws.events' });

    const put = mockS3Send.mock.calls.find((c) => c[0].__t === 'Put')![0];
    expect(put.i.Bucket).toBe('briefings-bucket');
    expect(put.i.Key).toMatch(/^briefings\/conv-proactive-\d+\.html$/);
    expect(put.i.ContentType).toContain('text/html');
    expect(String(put.i.Body)).toContain('PROACTIVE');
    expect(res.reportUrl).toBe('https://s3.example/briefings/x.html?sig');
  });

  it('emails every member via the notification workflow with both links', async () => {
    const { handler } = await import('../lambda/src/proactive-briefing');
    await handler({ source: 'aws.events' });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [recipients, content] = mockSendEmail.mock.calls[0];
    expect(recipients).toEqual([
      { email: 'a@stratum.example.com', name: 'Demo Basic' },
      { email: 'b@stratum.example.com', name: 'Demo Standard' },
    ]);
    expect(content.subject).toContain('Proactive Operational Briefing');
    expect(content.bodyText).toContain('https://s3.example/briefings/x.html?sig');
    expect(content.bodyText).toContain('https://app.example?conversation=conv-proactive-');
    expect(content.bodyHtml).toContain('<a href="https://s3.example/briefings/x.html?sig">');
  });

  it('seeds the conversation with a message linking the page', async () => {
    const { handler } = await import('../lambda/src/proactive-briefing');
    await handler({ source: 'aws.events' });
    const seed = mockChimeSend.mock.calls.find((c) => c[0].__t === 'SendMsg')![0];
    expect(seed.i.ChimeBearer).toBe('arn:bot/default');
    expect(seed.i.Content).toContain('https://s3.example/briefings/x.html?sig');
    expect(seed.i.Content).toContain('proactive');
  });

  it('is resilient: a member-add failure does not abort the run', async () => {
    mockChimeSend.mockImplementation((cmd) => {
      if (cmd.__t === 'CreateChannel') return Promise.resolve({ ChannelArn: 'arn:channel/p' });
      if (cmd.__t === 'AddMember' && cmd.i.MemberArn === 'arn:user/a') {
        return Promise.reject(new Error('not a member of app instance'));
      }
      return Promise.resolve({});
    });
    const { handler } = await import('../lambda/src/proactive-briefing');
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(1); // still emailed
  });

  it('degrades cleanly when REPORT_BUCKET is unset (no page, still conv + email)', async () => {
    delete process.env.REPORT_BUCKET;
    const { handler } = await import('../lambda/src/proactive-briefing');
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(true);
    expect(res.reportUrl).toBeUndefined();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [, content] = mockSendEmail.mock.calls[0];
    expect(content.bodyText).not.toContain('Briefing page:');
  });

  it('top-level failure returns ok:false (no throw → no EventBridge retry storm)', async () => {
    mockChimeSend.mockImplementation((cmd) =>
      cmd.__t === 'CreateChannel' ? Promise.reject(new Error('Chime down')) : Promise.resolve({}),
    );
    const { handler } = await import('../lambda/src/proactive-briefing');
    const res = await handler({ source: 'aws.events' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Chime down');
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
