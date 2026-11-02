/**
 * A TEAM OPENS ONLY ITS ASSISTANT'S DELIVERABLES (SPEC-ADMIN-CONSOLE FR48, `attachment-read`).
 *
 * `POST exchange-credentials/admin/assistants/{assistant}/attachment-read` vends a team member an
 * `s3:GetObject` on one conversation's deliverables, and only when their team owns the assistant, one of
 * its identities is a member of that conversation now, and they state a reason. The credential is
 * assumed on a role whose boundary is deliverables alone, never the admin plane, so a user upload is out
 * of reach whatever the session policy says.
 */
const mockStsSend = jest.fn();
const mockMessagingSend = jest.fn();
const mockScope = jest.fn();

// The Access Log write every vend makes before it returns (ADR-052).
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })) },
  PutCommand: jest.fn((input: unknown) => ({ input })),
  QueryCommand: jest.fn((input: unknown) => ({ input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn(() => ({ send: mockStsSend })),
  AssumeRoleCommand: jest.fn((input: unknown) => ({ __type: 'AssumeRole', input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  DescribeChannelMembershipForAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'DescribeMembership', input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn(() => ({ send: jest.fn() })),
  CreateAppInstanceUserCommand: jest.fn(),
  UpdateAppInstanceUserCommand: jest.fn(),
  DescribeAppInstanceUserCommand: jest.fn(),
  CreateAppInstanceAdminCommand: jest.fn(),
  TagResourceCommand: jest.fn(),
  ListAppInstanceBotsCommand: jest.fn(),
  ListTagsForResourceCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Parameter: { Value: 'arn:aws:s3:::attach' } }) })),
  GetParameterCommand: jest.fn(),
}));
jest.mock('../lambda/src/lib/assistant-scope.js', () => ({
  ...jest.requireActual('../lambda/src/lib/assistant-scope.js'),
  requireOwnedAssistant: (...a: unknown[]) => mockScope(...a),
}));

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP;
process.env.ACCESS_LOG_TABLE = 'access-log';
process.env.ADMIN_CONSOLE_ROLE_ARN = 'arn:aws:iam::111:role/agent-echelon-admin-console';
process.env.TEAM_CONSOLE_ROLE_ARN = 'arn:aws:iam::111:role/agent-echelon-team-console';
process.env.TEAM_ATTACHMENT_ROLE_ARN = 'arn:aws:iam::111:role/team-attachments';
process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN = 'arn:aws:s3:::attach';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/src/admin-credential-exchange');

const SUB = '0a1b2c3d-0000-4000-8000-00000000abcd';
const CHANNEL = `${APP}/channel/conv-1`;
const BOT = `${APP}/bot/hr-standard`;
const vend = (body: Record<string, unknown>, role = 'agent-echelon-team-console') => ({
  httpMethod: 'POST',
  path: '/exchange-credentials/admin/assistants/hr/attachment-read',
  pathParameters: { assistant: 'hr' },
  requestContext: { identity: { userArn: `arn:aws:sts::111:assumed-role/${role}/console-${SUB}@standard` } },
  body: JSON.stringify(body),
});
const parsed = (res: { body: string }) => JSON.parse(res.body);

beforeEach(() => {
  jest.clearAllMocks();
  mockScope.mockResolvedValue({ assistant: 'hr', bots: [{ assistant: 'hr', botArn: BOT, classification: 'standard' }] });
  mockMessagingSend.mockResolvedValue({ ChannelMembership: {} });
  mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'A', SecretAccessKey: 'S', SessionToken: 'T' } });
});

describe('a team member opening a deliverable', () => {
  it('gets one conversation\'s deliverables, on the team role, when the assistant is a member', async () => {
    const res = await handler(vend({ channelArn: CHANNEL, reason: 'customer asked about the report' }));
    expect(res.statusCode).toBe(200);
    const assume = mockStsSend.mock.calls[0][0].input;
    expect(assume.RoleArn).toBe('arn:aws:iam::111:role/team-attachments');
    expect(JSON.parse(assume.Policy).Statement[0].Resource).toEqual(['arn:aws:s3:::attach/generated-docs/conv-1/*']);
    expect(assume.Tags).toEqual(expect.arrayContaining([{ Key: 'assistant', Value: 'hr' }, { Key: 'classification', Value: 'standard' }]));
    // Asked of the Amazon Chime SDK as the assistant's own identity.
    expect(mockMessagingSend.mock.calls[0][0].input).toEqual({ ChannelArn: CHANNEL, AppInstanceUserArn: BOT, ChimeBearer: BOT });
    expect(parsed(res).bucket).toBe('attach');
  });

  it('is refused for a conversation the assistant is not in, without saying whether it exists', async () => {
    mockMessagingSend.mockRejectedValue(Object.assign(new Error('not a member'), { name: 'ForbiddenException' }));
    const res = await handler(vend({ channelArn: CHANNEL, reason: 'r' }));
    expect(res.statusCode).toBe(404);
    expect(parsed(res).code).toBe('CONVERSATION_NOT_FOUND');
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('is refused for an assistant the team does not own', async () => {
    mockScope.mockResolvedValue({ statusCode: 403, headers: {}, body: '{}' });
    const res = await handler(vend({ channelArn: CHANNEL, reason: 'r' }));
    expect(res.statusCode).toBe(403);
    expect(mockMessagingSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it.each([
    ['no reason', { channelArn: CHANNEL }, 'REASON_REQUIRED'],
    ['a wildcard conversation', { channelArn: `${APP}/channel/*`, reason: 'r' }, 'CHANNEL_NOT_LITERAL'],
    ['another app instance\'s conversation', { channelArn: 'arn:aws:chime:us-east-1:111:app-instance/zzz/channel/conv-1', reason: 'r' }, 'CHANNEL_NOT_LITERAL'],
  ])('is refused with %s', async (_label, body, code) => {
    const res = await handler(vend(body));
    expect(res.statusCode).toBe(400);
    expect(parsed(res).code).toBe(code);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('is not a route an admin session uses', async () => {
    const res = await handler(vend({ channelArn: CHANNEL, reason: 'r' }, 'agent-echelon-admin-console'));
    expect(res.statusCode).toBe(403);
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});
