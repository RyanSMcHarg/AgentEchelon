/**
 * A `Needs work` can say WHY, and the reason is validated rather than trusted.
 *
 * The three reasons are the three axes effectiveness is judged on (routing, answer quality, having
 * to re-ask), so the whole value of the field is that it GROUPS. An unrecognized value stored as-is
 * would split a rollup silently, which is the failure that never shows up as an error - the number
 * is simply wrong and nobody can tell. So the closed set is enforced at the write path.
 *
 * The reason is also optional by construction: the vote is recorded the moment it is clicked and the
 * picker only ever refines it. These tests pin that a vote without a reason is still a whole vote.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: jest.fn((input) => ({ __scan: input })),
  PutCommand: jest.fn((input) => ({ __put: input })),
  DeleteCommand: jest.fn((input) => ({ __del: input })),
}));
// No APP_INSTANCE_ARN: the channel-membership check is skipped, so these tests exercise the record
// that gets written rather than the Chime call in front of it.
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })),
  DescribeChannelMembershipCommand: jest.fn(),
}));

process.env.FEEDBACK_TABLE = 'test-feedback';
import { handler } from '../lambda/src/user-feedback';
import { edgeContext } from './helpers/edge-context';

const post = (body: Record<string, unknown>): any => ({
  httpMethod: 'POST',
  headers: {},
  body: JSON.stringify(body),
  requestContext: { authorizer: edgeContext({ claims: { sub: 'u1' } }) },
});

/** The item the handler actually put, so assertions read the STORED record, not the request. */
function storedItem(): any {
  const call = mockSend.mock.calls.find((c) => c[0]?.__put);
  return call?.[0].__put.Item;
}

describe('a reason rides only a down vote', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('stores the vote as the PERSON the token resolves to, never the token sub or one the body names', async () => {
    const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
    // The edge resolved the token's subject to this person; the handler reads it from the context.
    const e = post({ messageId: 'm1', channelArn: 'arn:chan', feedback: 'up', userSub: 'victim', personId: 'victim' });
    e.requestContext.authorizer = edgeContext({ claims: { sub: 'u1' }, personId: PERSON });
    const res = await handler(e);
    expect(res.statusCode).toBe(200);
    expect(storedItem().userSub).toBe(PERSON);
  });

  it('stores a recognized reason alongside the down vote', async () => {
    const res = await handler(post({
      messageId: 'm1', channelArn: 'arn:chan', feedback: 'down', reason: 'wrong_assistant',
    }));
    expect(res.statusCode).toBe(200);
    expect(storedItem()).toMatchObject({ feedback: 'down', reason: 'wrong_assistant' });
  });

  it.each(['poor_answer', 'asked_again'] as const)('accepts the other reasons: %s', async (reason) => {
    await handler(post({ messageId: 'm1', channelArn: 'arn:chan', feedback: 'down', reason }));
    expect(storedItem().reason).toBe(reason);
  });

  it('drops an unrecognized reason to null rather than storing it', async () => {
    // The vote still counts. Rejecting the whole request would lose a real signal because a client
    // sent a value this deployment does not know, and storing it would fragment the rollup.
    await handler(post({
      messageId: 'm1', channelArn: 'arn:chan', feedback: 'down', reason: 'because_i_said_so',
    }));
    const item = storedItem();
    expect(item.feedback).toBe('down');
    expect(item.reason).toBeNull();
  });

  it('records a down vote with no reason at all, because the reason is optional', async () => {
    await handler(post({ messageId: 'm1', channelArn: 'arn:chan', feedback: 'down' }));
    const item = storedItem();
    expect(item.feedback).toBe('down');
    expect(item.reason).toBeNull();
  });

  it('never attaches a reason to an up vote', async () => {
    // Nothing to attribute about approval, and a reason here could only be a leftover from the
    // picker a previous down vote opened.
    await handler(post({
      messageId: 'm1', channelArn: 'arn:chan', feedback: 'up', reason: 'poor_answer',
    }));
    expect(storedItem()).toMatchObject({ feedback: 'up', reason: null });
  });

  it('never attaches a reason to a clear', async () => {
    await handler(post({
      messageId: 'm1', channelArn: 'arn:chan', feedback: 'clear', reason: 'poor_answer',
    }));
    expect(storedItem()).toMatchObject({ feedback: 'clear', reason: null });
  });

  it('appends rather than replacing, so a reason given later keeps the original vote in the trail', async () => {
    await handler(post({ messageId: 'm1', channelArn: 'arn:chan', feedback: 'down' }));
    await handler(post({
      messageId: 'm1', channelArn: 'arn:chan', feedback: 'down', reason: 'asked_again',
    }));
    const puts = mockSend.mock.calls.filter((c) => c[0]?.__put);
    expect(puts).toHaveLength(2);
    // Two distinct records: the rollup counts the latest, and the earlier one still evidences that
    // the person voted before they said why.
    expect(puts[0][0].__put.Item.feedbackId).not.toBe(puts[1][0].__put.Item.feedbackId);
    expect(puts[0][0].__put.Item.reason).toBeNull();
    expect(puts[1][0].__put.Item.reason).toBe('asked_again');
  });
});
