import { edgeContext } from '../helpers/edge-context';
/**
 * The share HANDLER refuses a group-sourced conversation before it adds anyone, and names the source in the
 * refusal so the chat app can give the reason in the reader's language.
 *
 * The helper tests beside this one prove the row is read and the sentence matches; they cannot prove the
 * handler acts on it before `CreateChannelMembership`. This drives the handler end to end with the
 * Amazon Chime SDK, Cognito and DynamoDB clients mocked.
 */
import { seedRegistryRows } from '../helpers/registry-rows';
const mockChime = jest.fn();
const mockCognito = jest.fn();
const mockDdb = jest.fn();

const tagged = (t: string) => class { __t = t; constructor(public input: any) {} };
// The sharer is cleared for the premium conversation (`lib/conversation-access.ts`); an uncleared sharer's
// refusal is proven in `lib/a-person-route-reaches-only-a-conversation-its-caller-reaches.test.ts`.
jest.mock('../../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../../lambda/src/lib/auth'),
  callerHolderToken: () => 'premium',
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => mockChime(...a) })),
  CreateChannelMembershipCommand: tagged('CreateChannelMembership'),
  ListChannelMembershipsCommand: tagged('ListChannelMemberships'),
  ListChannelMessagesCommand: tagged('ListChannelMessages'),
  SendChannelMessageCommand: tagged('SendChannelMessage'),
  DescribeChannelCommand: tagged('DescribeChannel'),
  DescribeChannelMembershipCommand: tagged('DescribeChannelMembership'),
  ListTagsForResourceCommand: tagged('ListTagsForResource'),
}));
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: (...a: unknown[]) => mockCognito(...a) })),
  ListUsersCommand: tagged('ListUsers'),
  AdminListGroupsForUserCommand: tagged('AdminListGroupsForUser'),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: (...a: unknown[]) => mockDdb(...a) })),
  GetItemCommand: tagged('GetItem'),
}));
jest.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: jest.fn(() => ({ send: jest.fn() })), SendEmailCommand: tagged('SendEmail') }));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: async () => ({ Parameter: { Value: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/premium' } }) })),
  GetParameterCommand: tagged('GetParameter'),
}));

process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:1:app-instance/i';
process.env.USER_POOL_ID = 'pool';
process.env.CHANNEL_CONTEXT_TABLE = 'ctx';
// The deployment's registry rows, read at runtime by the handler: the shipped catalog.
seedRegistryRows();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/share-conversation/index.js');

const event = {
  httpMethod: 'POST',
  requestContext: { authorizer: edgeContext({ claims: { sub: 'caller', email: 'lead@example.com' } }) },
  // A conversation of this deployment's app instance: one outside it is refused before anything is read.
  body: JSON.stringify({ conversationArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1', recipientEmail: 'someone@example.com' }),
};

beforeEach(() => {
  mockChime.mockReset().mockImplementation((cmd: { __t: string }) =>
    Promise.resolve(cmd.__t === 'ListTagsForResource' ? { Tags: [{ Key: 'classification', Value: 'premium' }] } : {}));
  mockCognito.mockReset().mockResolvedValue({ Users: [{ Username: 'invitee', Attributes: [] }], Groups: [{ GroupName: 'premium' }] });
  mockDdb.mockReset().mockResolvedValue({ Item: { membershipSource: { S: 'group:ops' } } });
});

describe('the share handler on a group-sourced conversation', () => {
  it('answers 409 with the source, and never adds the invitee', async () => {
    const res = await handler(event);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'MEMBERSHIP_FROM_SOURCE', membershipSource: 'group:ops' });
    expect(mockChime.mock.calls.some(([c]) => c.__t === 'CreateChannelMembership')).toBe(false);
  });

  it('is not vacuous: the same request with no source reaches the add', async () => {
    mockDdb.mockResolvedValue({ Item: {} });
    await handler(event).catch(() => undefined);
    expect(mockChime.mock.calls.some(([c]) => c.__t === 'CreateChannelMembership')).toBe(true);
  });
});

describe('the share handler on a conversation whose type cannot be read (FR23)', () => {
  it('answers 503 and adds nobody, because the issuers the type admits are unknown', async () => {
    // The capability check reads the same row first and is answered, so the refusal under test is the
    // read that decides the issuer narrowing.
    let narrowingReads = 0;
    mockDdb.mockImplementation(async (cmd: { input: { ProjectionExpression?: string } }) => {
      if (/membershipSource/.test(cmd.input.ProjectionExpression ?? '')) {
        narrowingReads += 1;
        throw Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' });
      }
      return { Item: {} };
    });
    const res = await handler(event);
    expect(narrowingReads).toBe(1);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('CONVERSATION_TYPE_UNREADABLE');
    expect(mockChime.mock.calls.some(([c]) => c.__t === 'CreateChannelMembership')).toBe(false);
  });
});
