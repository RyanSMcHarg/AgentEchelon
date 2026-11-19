/**
 * A MEMBERSHIP REVOKE ACTS ONLY ON AN OPEN FINDING, AND ONLY ON THE MEMBERSHIP IT NAMES.
 *
 * Through the membership-audit admin handler: a revoke with no `sk`, with an `sk` the audit table does
 * not hold, on a finding that is no longer open, or with a body that names a different channel or member
 * than the finding is refused before any membership is removed. A revoke of an open finding removes the
 * finding's own membership as the app-instance admin and marks the finding revoked.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const ADMIN = `${APP}/user/ae-admin`;
const CHANNEL = `${APP}/channel/finding-channel`;
const MEMBER = `${APP}/user/flagged-person`;
const OTHER_CHANNEL = `${APP}/channel/elsewhere`;
const OTHER_MEMBER = `${APP}/user/someone-else`;

const findings = new Map<string, Record<string, unknown>>();
const ddbSent: Array<{ __type: string; input: Record<string, unknown> }> = [];
const chimeSent: Array<{ name: string; input: Record<string, unknown> }> = [];

const mockDdbSend = jest.fn(async (cmd: { __type: string; input: Record<string, unknown> }) => {
  ddbSent.push(cmd);
  if (cmd.__type === 'Get') {
    const key = cmd.input.Key as { pk: string; sk: string };
    return { Item: key.pk === 'finding' ? findings.get(key.sk) : undefined };
  }
  return {};
});

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ __type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ __type: 'Update', input })),
  QueryCommand: jest.fn((input: unknown) => ({ __type: 'Query', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('../lib/profile-registry', () => ({ loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../lambda/src/lib/auth'),
  requireAdmin: jest.fn(async () => ({ claims: { actor: 'admin-sub' } })),
}));
jest.mock('../lambda/src/lib/chime/clients', () => ({
  chimeMessagingClient: () => ({
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      chimeSent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    },
  }),
  appInstanceAdminBearer: () => async () => ADMIN,
}));

process.env.AUDIT_TABLE = 'membership-audit';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lambda/src/membership-audit-admin');

const revoke = async (body: Record<string, unknown>) => {
  const res = await handler({
    httpMethod: 'POST',
    path: '/membership-audit/revoke',
    headers: {},
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent);
  return { status: res.statusCode as number, body: JSON.parse(res.body || '{}') };
};

const OPEN_SK = `2026-11-10T00:00:00.000Z#${CHANNEL}#${MEMBER}`;
const REVOKED_SK = `2026-11-09T00:00:00.000Z#${CHANNEL}#${MEMBER}`;

beforeEach(() => {
  findings.clear();
  ddbSent.length = 0;
  chimeSent.length = 0;
  findings.set(OPEN_SK, { pk: 'finding', sk: OPEN_SK, channelArn: CHANNEL, memberArn: MEMBER, status: 'open' });
  findings.set(REVOKED_SK, { pk: 'finding', sk: REVOKED_SK, channelArn: CHANNEL, memberArn: MEMBER, status: 'revoked' });
});

const removals = () => chimeSent.filter((c) => c.name === 'DeleteChannelMembershipCommand');

describe('a membership revoke', () => {
  it('is refused without a finding key', async () => {
    const r = await revoke({ channelArn: CHANNEL, memberArn: MEMBER });
    expect(r.status).toBe(400);
    expect(removals()).toHaveLength(0);
  });

  it('is refused for a finding the audit table does not hold', async () => {
    const r = await revoke({ sk: 'no-such-finding', channelArn: CHANNEL, memberArn: MEMBER });
    expect(r.status).toBe(404);
    expect(removals()).toHaveLength(0);
  });

  it('is refused for a finding that is no longer open', async () => {
    const r = await revoke({ sk: REVOKED_SK });
    expect(r.status).toBe(409);
    expect(removals()).toHaveLength(0);
  });

  it('is refused when the body names a different channel than the finding', async () => {
    const r = await revoke({ sk: OPEN_SK, channelArn: OTHER_CHANNEL, memberArn: MEMBER });
    expect(r.status).toBe(400);
    expect(removals()).toHaveLength(0);
  });

  it('is refused when the body names a different member than the finding', async () => {
    const r = await revoke({ sk: OPEN_SK, channelArn: CHANNEL, memberArn: OTHER_MEMBER });
    expect(r.status).toBe(400);
    expect(removals()).toHaveLength(0);
  });

  it('is refused when the finding read fails', async () => {
    mockDdbSend.mockImplementationOnce(async () => { throw new Error('read failed'); });
    const r = await revoke({ sk: OPEN_SK });
    expect(r.status).toBe(500);
    expect(removals()).toHaveLength(0);
  });

  it("removes the open finding's own membership as the app-instance admin and marks it revoked", async () => {
    const r = await revoke({ sk: OPEN_SK, channelArn: CHANNEL, memberArn: MEMBER });
    expect(r.status).toBe(200);
    expect(removals()).toEqual([{ name: 'DeleteChannelMembershipCommand', input: { ChannelArn: CHANNEL, MemberArn: MEMBER, ChimeBearer: ADMIN } }]);
    const mark = ddbSent.find((c) => c.__type === 'Update');
    expect(mark?.input.Key).toEqual({ pk: 'finding', sk: OPEN_SK });
    expect((mark?.input.ExpressionAttributeValues as Record<string, unknown>)[':s']).toBe('revoked');
    expect((mark?.input.ExpressionAttributeValues as Record<string, unknown>)[':b']).toBe('admin-sub');
  });

  it('acts on the finding alone when the body names only the finding', async () => {
    const r = await revoke({ sk: OPEN_SK });
    expect(r.status).toBe(200);
    expect(removals().map((c) => [c.input.ChannelArn, c.input.MemberArn])).toEqual([[CHANNEL, MEMBER]]);
  });
});
