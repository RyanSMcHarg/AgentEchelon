/**
 * A WITHHELD NAME IS WITHHELD EVERYWHERE IT RIDES (SPEC-ADMIN-CONSOLE FR41, FR42).
 *
 * `who-a-person-is-is-a-separate-grant.test.ts` asserts on the SOURCE TEXT, which is how the three
 * defects this file exists for got shipped behind guards that were passing:
 *
 *   1. The gate never ran in Aurora mode. Both reads computed `showIdentity` and then returned from a
 *      branch above the row mapper the conditional spread lived in. A source guard matching the spread
 *      found it and proved nothing about the path the deployment runs.
 *   2. `raw` carried the same email one key deeper. Both reads return the faithful stored payload for
 *      the inspect drawer and it holds `Sender.Name`, and the drawer pretty-prints the whole object.
 *   3. `invitedBy` and `moderatedByName` were never dropped at all.
 *
 * All three were fixed as a field decision, and then the field decision ITSELF was replaced, because it
 * could not be made to bind: the check short-circuits for a trusted IAM-signed caller, which is sound
 * only for a capability owning an `execute-api` resource, and a field on a shared route owns none.
 * Measured rather than reasoned about: on the deployed API the group narrowing changed nothing at all.
 *
 * SO THE CONTRACT THESE CASES PIN IS STRONGER THAN "withheld from the wrong caller": a conversation read
 * carries no participant name for ANY caller, and `GET admin/conversations/identities` resolves an ARN
 * to a name under `see-user-identity`, which the gateway can refuse because that resource authorizes
 * nothing else. A payload with no name in it cannot leak one, whichever branch assembles it and whatever
 * a future field is called.
 *
 * These run the HANDLER and read the response body, because the source-text guards in
 * `test/lib/who-a-person-is-is-a-separate-grant.test.ts` are what the three defects shipped behind.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockHasDataPlane = jest.fn(() => true);
const mockAuroraListMessages = jest.fn();
const mockAuroraMembershipHistory = jest.fn();

jest.mock('../lambda/src/lib/data-plane-client.js', () => ({
  hasDataPlane: () => mockHasDataPlane(),
  adminListConversations: jest.fn(),
  adminListMessages: (...a: unknown[]) => mockAuroraListMessages(...a),
  adminMembershipHistory: (...a: unknown[]) => mockAuroraMembershipHistory(...a),
}));
jest.mock('@aws-sdk/client-athena', () => ({
  AthenaClient: jest.fn(() => ({ send: jest.fn() })),
  StartQueryExecutionCommand: jest.fn(),
  GetQueryExecutionCommand: jest.fn(),
  GetQueryResultsCommand: jest.fn(),
  QueryExecutionState: { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Parameter: { Value: '' } }) })),
  GetParameterCommand: jest.fn(),
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
process.env.APP_INSTANCE_ARN = APP;
process.env.AURORA_DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:1:function:data-plane';
process.env.ADMIN_GROUP_NAMES = 'admins';
// Narrowed BEFORE the import, because `auth.ts` parses this set once at module load - which is right
// for a Lambda, whose env is fixed for a container's life, and is why the deny-test updates the
// function configuration rather than expecting a live change. So the CALLER is the variable here
// rather than the env: `admins` may read the conversation, and `privacy-officers` may additionally be
// told whose words it holds.
process.env.USER_IDENTITY_VIEW_GROUP_NAMES = 'privacy-officers';
// Deliberately NOT set: ADMIN_IAM_ENFORCEMENT. With it set, `isTrustedIamAdminCall` short-circuits the
// gate for any IAM-signed caller and the withholding branch is unreachable - which is the open defect,
// not the behavior under test. These cases arrive with Cognito claims and no IAM identity.
delete process.env.ADMIN_IAM_ENFORCEMENT;

import { handler } from '../lambda/src/admin-conversations';
import { edgeContext } from './helpers/edge-context';

const CHANNEL_ID = 'conv-1';
const CHANNEL_ARN = `${APP}/channel/${CHANNEL_ID}`;
const SENDER_ARN = `${APP}/user/sub-of-a-real-person`;

/** A caller whose groups decide the identity field. No IAM identity, so nothing short-circuits. */
const evt = (groups: string, over: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent => ({
  httpMethod: 'GET',
  path: `/admin/conversations/${CHANNEL_ID}/messages`,
  headers: { origin: 'http://localhost:5173' },
  pathParameters: { channelId: CHANNEL_ID },
  queryStringParameters: null,
  requestContext: { authorizer: edgeContext({ claims: { sub: 'admin-sub', 'cognito:groups': groups } }) },
  ...over,
} as unknown as APIGatewayProxyEvent);

const messageRow = () => ({
  id: 'msg-1',
  content: 'what is our refund policy',
  senderArn: SENDER_ARN,
  senderName: 'a.person@example.com',
  timestamp: '2026-09-01T00:00:00Z',
  isBot: false,
  redacted: false,
  moderatedByName: 'an.operator@example.com',
  moderatedByArn: `${APP}/user/operator-sub`,
  metadata: {},
  // The inspect-drawer payload. `Sender.Name` here is the leak the top-level omission missed.
  raw: {
    MessageId: 'msg-1',
    Sender: { Arn: SENDER_ARN, Name: 'a.person@example.com' },
    ModeratedBy: { Arn: `${APP}/user/operator-sub`, Name: 'an.operator@example.com' },
    Content: 'what is our refund policy',
  },
});

const historyRow = () => ({
  action: 'joined',
  memberArn: SENDER_ARN,
  memberName: 'a.person@example.com',
  invitedBy: 'someone.else@example.com',
  timestamp: '2026-09-01T00:00:00Z',
  isBot: false,
});

const body = (res: { body: string }) => JSON.parse(res.body);

beforeEach(() => {
  jest.clearAllMocks();
  mockHasDataPlane.mockReturnValue(true);
  mockAuroraListMessages.mockResolvedValue([messageRow()]);
  mockAuroraMembershipHistory.mockResolvedValue([historyRow()]);
});
const GRANTED = 'admins,privacy-officers';

const withPath = (groups: string, path: string) => evt(groups, {
  path,
  pathParameters: null,
  queryStringParameters: { channelArn: CHANNEL_ARN },
});
const identitiesEvt = (groups: string) => withPath(groups, '/admin/conversations/identities');
const historyEvt = (groups: string) => withPath(groups, '/admin/conversations/membership-history');

/** Both callers below hold `view-conversations`; only GRANTED also holds the identity capability. */
const EITHER_CALLER: Array<[string, string]> = [
  ['the fullest grant there is', GRANTED],
  ['a caller without the identity grant', 'admins'],
];

describe('a conversation read names nobody, whoever is asking', () => {
  // The strongest case in this file. The first implementation returned names to an entitled caller on
  // these routes, which is what made the withholding a per-caller branch and gave the leak somewhere
  // to hide. Nobody gets a name here now, so there is no branch left to miss.
  it.each(EITHER_CALLER)('returns no name on the message list to %s', async (_label, groups) => {
    const res = await handler(evt(groups));
    expect(res.statusCode).toBe(200);
    const m = body(res).messages[0];
    expect('senderName' in m).toBe(false);
    expect(m.moderatedByName).toBeUndefined();
    // Blanked in place, because `raw` is presented as the faithful record: a missing key there would
    // read as "the archive has no sender" rather than "you were not told".
    expect(m.raw.Sender.Name).toBe('(identity withheld)');
    expect(m.raw.ModeratedBy.Name).toBe('(identity withheld)');
    // The catch-all: no fixture address anywhere in the serialized row, at any depth.
    expect(JSON.stringify(m)).not.toContain('@example.com');
  });

  it.each(EITHER_CALLER)('returns no name on the membership timeline to %s', async (_label, groups) => {
    const res = await handler(historyEvt(groups));
    expect(res.statusCode).toBe(200);
    const h = body(res).history[0];
    expect(h.memberName).toBeUndefined();
    // `invitedBy` has no ARN archived beside it, so it degrades to absent rather than to an id.
    expect(h.invitedBy).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain('@example.com');
  });

  it.each(EITHER_CALLER)('still identifies every participant by ARN for %s', async (_label, groups) => {
    // Withholding the name only works if something else identifies the person. The ARN's last segment
    // is the Cognito sub every analytics table joins on, so an operator can follow it everywhere else.
    const m = body(await handler(evt(groups))).messages[0];
    expect(m.senderArn).toBe(SENDER_ARN);
    expect(m.raw.Sender.Arn).toBe(SENDER_ARN);
    const h = body(await handler(historyEvt(groups))).history[0];
    expect(h.memberArn).toBe(SENDER_ARN);
  });

  it('still returns what was said, because refusing the read would stop the investigation', async () => {
    const res = await handler(evt('admins'));
    expect(res.statusCode).toBe(200);
    expect(body(res).messages[0].content).toBe('what is our refund policy');
  });
});

describe('resolving an ARN to a name is the separate, refusable call', () => {
  it('answers a caller holding the identity capability', async () => {
    const res = await handler(identitiesEvt(GRANTED));
    expect(res.statusCode).toBe(200);
    expect(body(res).identities[SENDER_ARN]).toBe('a.person@example.com');
  });

  it('refuses a caller who may read the conversation and may not be told who is in it', async () => {
    const res = await handler(identitiesEvt('admins'));
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(body(res))).not.toContain('@example.com');
  });

  it('refuses a channel ARN it cannot validate, before naming anyone', async () => {
    const res = await handler(evt(GRANTED, {
      path: '/admin/conversations/identities',
      pathParameters: null,
      queryStringParameters: { channelArn: 'not-a-channel-arn' },
    }));
    expect(res.statusCode).toBe(400);
  });
});

describe('and it holds on the archive path as well as the Aurora one', () => {
  it('carries no name when the data plane is absent', async () => {
    // The Aurora branch returns above the row mapper, so these were two separate code paths and only
    // one of them was ever gated. With no data plane the handler falls through to Athena, whose client
    // is mocked to fail - what matters is that no name rides the response either way.
    mockHasDataPlane.mockReturnValue(false);
    const res = await handler(evt(GRANTED));
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(body(res))).not.toContain('@example.com');
  });
});
