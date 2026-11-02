/**
 * PATH A CONTINUES IN A NEW CONVERSATION (B6, PLAN §16.5 P-11).
 *
 * A bind makes the visitor's AppInstanceUser the account, which is vended at the account's own
 * classification and never the visitor's, so the visitor's conversation is out of its reach. The visit
 * continues in a new conversation at the account's classification, opened through that classification's
 * creator, tagged `upgradedFrom` and `upgradedFromPerson`, seeded from the visit as a claim's is, at a
 * channel id deterministic from the visitor's conversation so a retried bind opens the same one.
 *
 * Here: where a visit continues (`bindTargetOf`); the exchange's half (`continueBoundVisit`, `boundVisitOf`)
 * against in-memory `Tokens`; and the creator's half (`kind: 'bind'`) with the shared creator unmocked, so
 * the Amazon Chime SDK calls asserted are its own. The exchange's wiring is
 * `the-exchange-continues-a-bound-visit.test.ts`; the live proof is `scripts/deny-test-upgrade.mjs`.
 */
const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  CreateChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateChannel', input: a })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateMembership', input: a })),
  CreateChannelModeratorCommand: jest.fn().mockImplementation((a) => ({ __type: 'CreateModerator', input: a })),
  DeleteChannelMembershipCommand: jest.fn().mockImplementation((a) => ({ __type: 'DeleteMembership', input: a })),
  DeleteChannelModeratorCommand: jest.fn().mockImplementation((a) => ({ __type: 'DeleteModerator', input: a })),
  AssociateChannelFlowCommand: jest.fn().mockImplementation((a) => ({ __type: 'AssociateFlow', input: a })),
  UpdateChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'UpdateChannel', input: a })),
  DescribeChannelCommand: jest.fn().mockImplementation((a) => ({ __type: 'DescribeChannel', input: a })),
  DescribeChannelMembershipCommand: jest.fn().mockImplementation((a) => ({ __type: 'DescribeMembership', input: a })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((a) => ({ __type: 'ListMemberships', input: a })),
  SendChannelMessageCommand: jest.fn().mockImplementation((a) => ({ __type: 'SendMessage', input: a })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((a) => ({ __type: 'ListTags', input: a })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((a) => ({ __type: 'GetParam', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn().mockImplementation((a) => ({ __type: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __type: 'Update', input: a })),
  PutCommand: jest.fn().mockImplementation((a) => ({ __type: 'Put', input: a })),
  TransactWriteCommand: jest.fn().mockImplementation((a) => ({ __type: 'Transact', input: a })),
}), { virtual: true });

import { bindTargetOf, GUEST_VISITOR_TYPE } from '../lib/config/conversation-types';
import { bindSecretHashOf, boundVisitOf, continueBoundVisit } from '../lambda/src/lib/guest-bind';
import { familyKey, type GuestConfig } from '../lambda/src/guest-session';
import { tokenKey, tokenRecordOf } from '../lambda/src/lib/tokens';
import { boundChannelIdOf, registrationKeyOf, UPGRADE_SOURCE_PERSON_TAG, UPGRADE_SOURCE_TAG } from '../lambda/src/lib/upgrade';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const VISITOR_ID = '0190c0de-0000-7000-8000-000000000001';
const VISITOR = `${APP}/user/${VISITOR_ID}`;
const GUEST_CHANNEL = `${APP}/channel/guest-1`;
const CONTINUATION = `${APP}/channel/${boundChannelIdOf(GUEST_CHANNEL)}`;
const NOW = 1_800_000_000;
const CONFIG = { issuerId: 'guest', classification: 'guest', tokensTableParameter: '/p' } as unknown as GuestConfig;

describe('where a bound visit continues', () => {
  it('in an ordinary conversation at a member classification, and in a customer conversation for a customer', () => {
    expect(bindTargetOf(GUEST_VISITOR_TYPE, 'basic')).toEqual({ typeKey: 'general', classification: 'basic' });
    expect(bindTargetOf(GUEST_VISITOR_TYPE, 'premium')).toEqual({ typeKey: 'general', classification: 'premium' });
    expect(bindTargetOf(GUEST_VISITOR_TYPE, 'customer')).toEqual({ typeKey: 'customer-engagement', classification: 'customer' });
  });

  it('never at the visitor\'s own classification, and nowhere from a type that declares no bind', () => {
    expect(bindTargetOf(GUEST_VISITOR_TYPE, 'guest')).toBeNull();
    expect(bindTargetOf('general', 'basic')).toBeNull();
    expect(bindTargetOf('customer-engagement', 'customer')).toBeNull();
  });

  it('the channel id is the visitor\'s conversation\'s, and a legal Amazon Chime SDK id', () => {
    expect(boundChannelIdOf(GUEST_CHANNEL)).toBe(boundChannelIdOf(GUEST_CHANNEL));
    expect(boundChannelIdOf(GUEST_CHANNEL)).not.toBe(boundChannelIdOf(`${APP}/channel/guest-2`));
    expect(boundChannelIdOf(GUEST_CHANNEL)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

// ── THE EXCHANGE'S HALF ──────────────────────────────────────────────────────────────────────────

function tokens(rows: Record<string, Record<string, unknown>> = {}) {
  const table = new Map(Object.entries(rows));
  return { table, async send(cmd: any) { if (cmd.__type === 'Get') return { Item: table.get(cmd.input.Key.pk) }; throw new Error(cmd.__type); } };
}
/** The creators. The guest one's `assess` and `retire` are recorded apart (`visits`): it has no assessment here. */
function creator() {
  return {
    calls: [] as any[],
    visits: [] as any[],
    async send(cmd: any) {
      const req = { to: cmd.input.FunctionName, ...JSON.parse(new TextDecoder().decode(cmd.input.Payload)) };
      if (req.kind === 'assess' || req.kind === 'retire') {
        this.visits.push(req);
        return { Payload: new TextEncoder().encode(JSON.stringify(req.kind === 'retire' ? { ok: true } : { ok: false, code: 'NO_ASSESSMENT', error: 'none' })) };
      }
      this.calls.push(req);
      return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, channelArn: CONTINUATION })) };
    },
  };
}
const CREATORS = { basic: 'creator-basic', customer: 'creator-customer' };
const continueAt = (classification: string, doc = tokens(), lambda = creator()) => continueBoundVisit(
  { personArn: VISITOR, guestChannelArn: GUEST_CHANNEL, classification },
  { config: CONFIG, doc, lambda, tokensTable: 'tokens', creators: CREATORS, guestCreator: 'creator-guest' },
);

describe('the exchange continues a bound visit', () => {
  it('asks the person\'s own classification\'s creator for one conversation, tagged with the visit, for the visitor\'s own AppInstanceUser', async () => {
    const lambda = creator();
    const r = await continueAt('basic', tokens(), lambda);
    expect(r).toEqual({ ok: true, conversationArn: CONTINUATION });
    expect(lambda.calls).toEqual([{
      to: 'creator-basic', kind: 'bind', classification: 'basic',
      userArn: VISITOR, sourceChannelArn: GUEST_CHANNEL, sourcePersonArn: VISITOR,
      seed: { upgradedFrom: 'guest-visitor' },
    }]);
  });

  it('is seeded from the visit\'s registration exactly as a claim is', async () => {
    const reg = { ...tokenRecordOf('registration', GUEST_CHANNEL, { channelArn: GUEST_CHANNEL, personArn: VISITOR, issuer: 'guest', expiresAt: NOW + 60 }), fields: { name: 'Ada', note: 'pricing' }, sourceType: 'guest-visitor' };
    const lambda = creator();
    await continueAt('basic', tokens({ [registrationKeyOf(GUEST_CHANNEL)]: reg }), lambda);
    expect(lambda.calls[0].seed).toEqual({ upgradedFrom: 'guest-visitor', registration: { name: 'Ada', note: 'pricing' } });
  });

  it('never at the visitor\'s classification, and not where no creator is configured: nothing is invoked', async () => {
    const lambda = creator();
    expect(await continueAt('guest', tokens(), lambda)).toMatchObject({ ok: false });
    expect(await continueAt('premium', tokens(), lambda)).toMatchObject({ ok: false });
    expect(lambda.calls).toEqual([]);
    expect(lambda.visits).toEqual([]);
  });

  it('a creator that fails is not a continuation', async () => {
    const failing = { async send() { return { FunctionError: 'Unhandled' }; } };
    expect(await continueBoundVisit(
      { personArn: VISITOR, guestChannelArn: GUEST_CHANNEL, classification: 'basic' },
      { config: CONFIG, doc: tokens(), lambda: failing, tokensTable: 'tokens', creators: CREATORS, guestCreator: 'creator-guest' },
    )).toMatchObject({ ok: false });
  });
});

describe('a retried bind is recognized, and nothing else is', () => {
  const refresh = (over: Record<string, unknown> = {}) => ({
    ...tokenRecordOf('guest-refresh', 'refresh-1', { channelArn: GUEST_CHANNEL, personArn: VISITOR, issuer: 'guest', expiresAt: NOW + 600 }),
    familyId: 'fam-1', subject: 'g-sub', consumedAt: NOW, ...over,
  });
  const family = (over: Record<string, unknown> = {}) => ({
    ...tokenRecordOf('guest-family', 'fam-1', { channelArn: GUEST_CHANNEL, personArn: VISITOR, issuer: 'guest', expiresAt: NOW + 3600 }),
    status: 'revoked', revokedBy: 'bind', ...over,
  });
  /** The widget's hand-off of that credential, spent by the bind. */
  const handOff = (over: Record<string, unknown> = {}) => ({
    ...tokenRecordOf('guest-bind', 'nonce-1', { channelArn: GUEST_CHANNEL, personArn: VISITOR, issuer: 'guest', expiresAt: NOW + 600 }),
    refreshPk: tokenKey('guest-refresh', 'refresh-1'), secretHash: bindSecretHashOf('secret-1'), consumedAt: NOW, ...over,
  });
  const visit = (r = refresh(), f = family(), h = handOff()) => tokens({ [tokenKey('guest-refresh', 'refresh-1')]: r, [familyKey('fam-1')]: f, [tokenKey('guest-bind', 'nonce-1')]: h });
  const replay = (doc: ReturnType<typeof tokens>, personId = VISITOR_ID, nonce = 'nonce-1', secret = 'secret-1') =>
    boundVisitOf({ personId, request: { nonce, secret } }, { config: CONFIG, doc, tokensTable: 'tokens' });

  it('the visit\'s hand-off, spent by a bind, presented again with its secret by the AppInstanceUser it was bound to', async () => {
    expect(await replay(visit())).toBe(GUEST_CHANNEL);
  });

  it.each([
    ['another person', () => replay(visit(), '0190c0de-0000-7000-8000-0000000000ff')],
    ['an unknown hand-off', () => replay(visit(), VISITOR_ID, 'nope')],
    ['the hand-off without its secret (a forwarded link)', () => replay(visit(), VISITOR_ID, 'nonce-1', 'a-guess')],
    ['a hand-off never spent', () => replay(visit(refresh(), family(), handOff({ consumedAt: undefined })))],
    ['a credential never spent', () => replay(visit(refresh({ consumedAt: undefined })))],
    ['a family that is still live', () => replay(visit(refresh(), family({ status: 'active', revokedBy: undefined })))],
    ['a family revoked by a refresh replay, not a bind', () => replay(visit(refresh(), family({ revokedBy: 'replay' })))],
  ])('not %s', async (_why, run) => {
    expect(await run()).toBeNull();
  });
});

// ── THE CREATOR'S HALF ───────────────────────────────────────────────────────────────────────────

const BOT = `${APP}/bot/standard`;
const ADMIN = `${APP}/user/ae-admin`;
const ADMIN_PARAM = '/agent-echelon/app-instance-admin-arn';
const FLOW_PARAM = '/agent-echelon/channel-flow-arn';
const FLOW = `${APP}/channel-flow/f`;

type Creator = (req: unknown) => Promise<{ ok: boolean; code?: string; channelArn?: string }>;
function creatorAt(classification: string): Creator {
  process.env.APP_INSTANCE_ARN = APP;
  process.env.SSM_ROOT = '/agent-echelon';
  process.env.CHANNEL_CONTEXT_TABLE = 'ChannelContextTest';
  process.env.CHANNEL_FLOW_ARN_PARAM = FLOW_PARAM;
  process.env.CREATOR_BEARER_ARN_PARAM = ADMIN_PARAM;
  process.env.CREATOR_CLASSIFICATION = classification;
  let handler: Creator | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    handler = require('../lambda/src/create-conversation-at-classification').handler;
  });
  return handler!;
}
const sent = (type: string) => mockMessagingSend.mock.calls.map(([c]) => c).filter((c) => c.__type === type);
const bindRequest = (classification: string, over: Record<string, unknown> = {}) => ({
  kind: 'bind', classification, userArn: VISITOR, sourceChannelArn: GUEST_CHANNEL, sourcePersonArn: VISITOR, seed: { upgradedFrom: 'guest-visitor' }, ...over,
});

describe('the creator opens the continuation', () => {
  beforeEach(() => {
    mockSsmSend.mockReset().mockImplementation(async (cmd: { input: { Name: string } }) => {
      if (cmd.input.Name === ADMIN_PARAM) return { Parameter: { Value: ADMIN } };
      if (cmd.input.Name === FLOW_PARAM) return { Parameter: { Value: FLOW } };
      return { Parameter: { Value: BOT } };
    });
    mockDdbSend.mockReset().mockResolvedValue({});
    mockMessagingSend.mockReset().mockImplementation(async (cmd: { __type: string }) => (cmd.__type === 'CreateChannel' ? { ChannelArn: CONTINUATION } : {}));
  });

  it('at its own classification, at the deterministic id, tagged with the visit, with the person a member', async () => {
    const r = await creatorAt('standard')(bindRequest('standard'));
    expect(r).toMatchObject({ ok: true, channelArn: CONTINUATION });
    const [create] = sent('CreateChannel');
    expect(create.input.ChannelId).toBe(boundChannelIdOf(GUEST_CHANNEL));
    expect(create.input.Tags).toEqual(expect.arrayContaining([
      { Key: 'classification', Value: 'standard' },
      { Key: UPGRADE_SOURCE_TAG, Value: GUEST_CHANNEL },
      { Key: UPGRADE_SOURCE_PERSON_TAG, Value: VISITOR },
    ]));
    expect(sent('CreateChannel')).toHaveLength(1);
    expect(sent('CreateMembership').map((c) => c.input.MemberArn)).toContain(VISITOR);
  });

  it('a retried bind re-opens the same conversation and creates no second one', async () => {
    mockMessagingSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'CreateChannel') throw Object.assign(new Error('exists'), { name: 'ConflictException' });
      if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'standard' }, { Key: UPGRADE_SOURCE_TAG, Value: GUEST_CHANNEL }, { Key: UPGRADE_SOURCE_PERSON_TAG, Value: VISITOR }] };
      return {};
    });
    const r = await creatorAt('standard')(bindRequest('standard'));
    expect(r).toMatchObject({ ok: true, channelArn: CONTINUATION });
    expect(sent('CreateMembership').filter((c) => c.input.ChannelArn === CONTINUATION).map((c) => c.input.MemberArn)).toEqual([BOT, VISITOR]);
  });

  it('an existing channel at that id that is not this visit\'s continuation is not re-opened', async () => {
    mockMessagingSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'CreateChannel') throw Object.assign(new Error('exists'), { name: 'ConflictException' });
      if (cmd.__type === 'ListTags') return { Tags: [{ Key: UPGRADE_SOURCE_TAG, Value: GUEST_CHANNEL }, { Key: UPGRADE_SOURCE_PERSON_TAG, Value: `${APP}/user/someone-else` }] };
      return {};
    });
    expect(await creatorAt('standard')(bindRequest('standard'))).toMatchObject({ ok: false, code: 'CONVERSATION_CREATION_FAILED' });
    expect(sent('CreateMembership')).toEqual([]);
  });

  it('THE GUEST ROOM STAYS UNREACHABLE: the visitor\'s classification\'s creator opens no continuation', async () => {
    expect(await creatorAt('guest')(bindRequest('guest'))).toMatchObject({ ok: false, code: 'CLASSIFICATION_MISMATCH' });
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });

  it('a bind names the visitor\'s own AppInstanceUser: another person is refused', async () => {
    expect(await creatorAt('standard')(bindRequest('standard', { userArn: `${APP}/user/someone-else` }))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(mockMessagingSend).not.toHaveBeenCalled();
  });
});
