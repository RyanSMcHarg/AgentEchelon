/**
 * A PERSON ROUTE REACHES ONLY A CONVERSATION ITS CALLER REACHES (tenets D3 and D15).
 *
 * Each route below acts through its own role, so the caller's IAM scope does not bound what it does. Every one
 * puts the caller's own boundary in front of the action (`lib/conversation-access.ts`): a current member of the
 * conversation, proven with their own AppInstanceUser as bearer, and cleared for its `classification` tag.
 *
 * Driven through each route's own handler: an outsider, a removed member (their membership lookup fails), and a
 * member whose clearance does not reach the conversation are each refused, and nothing is written or returned. A
 * cleared member is served.
 */
// The conversation's type allows what these cases do; the refusal is `a-type-that-turns-a-capability-off-is-refused`.
jest.mock('../../lambda/src/lib/type-capability', () => ({ ...jest.requireActual('../../lambda/src/lib/type-capability'), typeAllows: jest.fn(async () => ({ ok: true })) }));
import type { APIGatewayProxyEvent } from 'aws-lambda';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CONVO = 'c0ffee00-1111-2222-3333-444455556666';
const CHANNEL = `${APP}/channel/${CONVO}`;
const OTHER_CHANNEL = `${APP}/channel/0dd00000-1111-2222-3333-444455556666`;
/** A conversation the caller is a member of whose `classification` tag names nothing this deployment declares. */
const UNTAGGED_CHANNEL = `${APP}/channel/0a7a6000-1111-2222-3333-444455556666`;
/** A conversation the caller is a member of whose tag read fails as a service failure. */
const TAG_OUTAGE_CHANNEL = `${APP}/channel/0f00d000-1111-2222-3333-444455556666`;
/** A conversation the caller is a member of, tagged with an alias of `premium`. */
const ALIAS_CHANNEL = `${APP}/channel/0a1a5000-1111-2222-3333-444455556666`;
/** The alias `ALIAS_CHANNEL` is tagged with, resolved to `premium` while a case declares it. */
const ALIAS = 'top-tier';
/** The conversations whose own membership lookup answers for the caller while they are a member. */
const MEMBER_OF = new Set([CHANNEL, UNTAGGED_CHANNEL, TAG_OUTAGE_CHANNEL, ALIAS_CHANNEL]);
/** Conversations named `pool-<n>`, each one the caller is a member of. */
const poolChannel = (n: number) => `${APP}/channel/pool-${n}`;
const MEMBER = 'person-1';
const OUTSIDER = 'person-outsider';
const ADMIN = `${APP}/user/service-admin`;
const BOT = `${APP}/bot/premium`;
const RECIPIENT = `${APP}/user/person-recipient`;
const TASK_SERVICE = 'arn:aws:lambda:us-east-1:111122223333:function:TaskService';

const state = {
  person: MEMBER,
  /** Whether the caller's own membership lookup answers. */
  member: true,
  token: 'premium' as string | undefined,
  /** The membership lookup fails as a service failure (a throttle), not as an answer. */
  outage: false,
  /** The follow-up `DescribeChannel` fails as a service failure. */
  describeFails: false,
  /** How many `pool-` conversations the caller is a member of, as their membership list reads. */
  pooled: 12,
};
/** How many `pool-` conversations a case names; the caller is a member of each. */
const POOL_SIZE = 12;
/** Every SSM parameter asked for. */
const ssmAsked: string[] = [];
const arnOf = (person: string) => `${APP}/user/${person}`;

/** Every call that changes something, by any route, in the order made. */
const writes: string[] = [];
/** Every item written to DynamoDB, as written. */
const items: Array<Record<string, any>> = [];
const sent: Array<{ name: string; input: Record<string, any> }> = [];

const CHIME_WRITES = new Set([
  'CreateChannelMembershipCommand', 'DeleteChannelMembershipCommand', 'TagResourceCommand', 'UpdateChannelCommand',
  'CreateChannelModeratorCommand', 'DeleteChannelModeratorCommand', 'SendChannelMessageCommand',
]);
const DOC_WRITES = new Set(['PutCommand', 'UpdateCommand', 'DeleteCommand', 'TransactWriteCommand']);

type Cmd = { constructor: { name: string }; input: Record<string, any> };

const messaging = {
  send: async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    sent.push({ name, input: cmd.input });
    if (CHIME_WRITES.has(name)) writes.push(name);
    switch (name) {
      case 'DescribeChannelMembershipCommand':
        if (state.outage) throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
        // Only the caller's own membership in a conversation they are in answers.
        if (!state.member || !(MEMBER_OF.has(cmd.input.ChannelArn) || cmd.input.ChannelArn.startsWith(poolChannel(0).slice(0, -1)))
          || cmd.input.MemberArn !== cmd.input.ChimeBearer) {
          throw Object.assign(new Error('not a member'), { name: state.person === OUTSIDER ? 'ForbiddenException' : 'NotFoundException' });
        }
        return {};
      case 'ListChannelMembershipsForAppInstanceUserCommand': {
        // THE SERVICE'S RULE: a person reads only their own memberships, so the bearer is the user asked about.
        if (state.outage) throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
        if (cmd.input.AppInstanceUserArn !== cmd.input.ChimeBearer) throw Object.assign(new Error('not your memberships'), { name: 'ForbiddenException' });
        const all = state.member && state.person !== OUTSIDER
          ? [...MEMBER_OF, ...Array.from({ length: state.pooled }, (_, i) => poolChannel(i))]
          : [];
        const start = Number(cmd.input.NextToken ?? 0);
        const page = all.slice(start, start + cmd.input.MaxResults);
        return { ChannelMemberships: page.map((ChannelArn) => ({ ChannelSummary: { ChannelArn } })), ...(start + page.length < all.length ? { NextToken: String(start + page.length) } : {}) };
      }
      case 'ListTagsForResourceCommand':
        if (cmd.input.ResourceARN === TAG_OUTAGE_CHANNEL) throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
        if (cmd.input.ResourceARN === UNTAGGED_CHANNEL) return { Tags: [{ Key: 'classification', Value: 'not-declared' }] };
        if (cmd.input.ResourceARN === ALIAS_CHANNEL) return { Tags: [{ Key: 'classification', Value: ALIAS }] };
        return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      case 'DescribeChannelCommand':
        if (state.describeFails) throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
        return { Channel: { Name: 'Room', Mode: 'RESTRICTED', Metadata: '{}' } };
      case 'ListChannelModeratorsCommand':
        return { ChannelModerators: [{ Moderator: { Arn: arnOf(state.person) } }] };
      case 'ListChannelMembershipsCommand':
        return { ChannelMemberships: [] };
      default:
        return {};
    }
  },
};
/** The caller's owned-task partition, as pages of the query `getActiveTasksForUser` walks. */
let taskPages: Array<Array<Record<string, unknown>>> = [];
const doc = {
  send: async (cmd: Cmd) => {
    if (DOC_WRITES.has(cmd.constructor.name)) writes.push(`dynamodb:${cmd.constructor.name}`);
    if (cmd.constructor.name === 'PutCommand') items.push(cmd.input.Item);
    if (cmd.constructor.name === 'QueryCommand' && cmd.input.TableName === 'user-tasks') {
      const page = Number(cmd.input.ExclusiveStartKey?.page ?? 0);
      return { Items: taskPages[page] ?? [], ...(page + 1 < taskPages.length ? { LastEvaluatedKey: { page: page + 1 } } : {}) };
    }
    return {};
  },
};
const lambdaSend = jest.fn(async (_cmd: Cmd) => {
  writes.push('lambda:Invoke');
  return { Payload: Buffer.from(JSON.stringify({ ok: true, channelArn: `${APP}/channel/opened` })) };
});

jest.mock('../../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../../lambda/src/lib/auth'),
  callerPersonId: async () => state.person,
  callerPersonArn: async () => arnOf(state.person),
  callerPerson: async () => ({
    personId: state.person, personArn: arnOf(state.person), source: 'edge', issuer: null,
    contact: { email: 'lead@example.com', name: 'Lead' },
  }),
  requireAuth: async () => ({ claims: { personId: state.person, actor: state.person, email: null } }),
  callerHolderToken: () => state.token,
}));
jest.mock('../../lambda/src/lib/chime/clients', () => ({
  ...jest.requireActual('../../lambda/src/lib/chime/clients'),
  chimeMessagingClient: () => messaging,
  chimeIdentityClient: () => ({ send: async () => ({ AppInstanceUser: { Name: 'Lead' } }) }),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ...jest.requireActual('@aws-sdk/lib-dynamodb'),
  DynamoDBDocumentClient: { from: () => doc },
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  ...jest.requireActual('@aws-sdk/client-ssm'),
  SSMClient: jest.fn(() => ({
    send: async (cmd: Cmd) => {
      const name = String(cmd.input.Name || '');
      ssmAsked.push(name);
      if (name === '/test/admin-arn') return { Parameter: { Value: ADMIN } };
      if (name.endsWith('/task-service-arn')) return { Parameter: { Value: TASK_SERVICE } };
      throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    },
  })),
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  ...jest.requireActual('@aws-sdk/client-lambda'),
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
}));

// What each route does once it is admitted, recorded as writes so a refusal is seen to have done none of it.
jest.mock('../../lambda/src/lib/say-through-router', () => ({
  ...jest.requireActual('../../lambda/src/lib/say-through-router'),
  sayThroughRouter: async () => { writes.push('say'); return { posted: true }; },
  personJoinedThroughRouter: async () => new Set<string>(),
  cancelDeadlinesThroughRouter: async () => true,
}));
jest.mock('../../lambda/src/lib/join-recap', () => ({ dispatchJoinRecapTurn: async () => undefined }));
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  ...jest.requireActual('../../lambda/src/lib/conversation-primary'),
  primaryAssistantOf: async () => ({ classification: 'premium', botArn: BOT, assistant: 'premium' }),
}));
// Battle is wired and on for every classification here; no classification at all can never battle.
jest.mock('../../lambda/src/lib/battle-enablement', () => ({ canRunBattle: async (c?: string) => !!c }));
jest.mock('../../lambda/src/lib/battle-end', () => ({ endBattle: async () => { writes.push('endBattle'); } }));
jest.mock('../../lambda/src/lib/experiment-manager', () => ({
  ...jest.requireActual('../../lambda/src/lib/experiment-manager'),
  resolveActiveBattleExperimentForClassification: async () => null,
}));
jest.mock('../../lambda/src/lib/battle-state', () => ({
  ...jest.requireActual('../../lambda/src/lib/battle-state'),
  // The duel ran in the conversation the route names.
  readBattleRows: async () => [{ battleId: 'b1', botArn: '__round1__', state: 'COMPLETED', channelArn: CHANNEL }],
  loadChannelBattleConfig: async () => null,
}));
jest.mock('../../lambda/src/lib/battle-outcome', () => ({
  ...jest.requireActual('../../lambda/src/lib/battle-outcome'),
  recordBattleOutcome: async (o: Record<string, unknown>) => { writes.push('recordBattleOutcome'); return o; },
}));
jest.mock('../../lambda/src/lib/turn-lock', () => ({
  ...jest.requireActual('../../lambda/src/lib/turn-lock'),
  readTurnState: async () => { writes.push('read:turn-state'); return { busy: true, queued: [] }; },
  readDispatchFailure: async () => null,
}));
const task = (taskId: string, channelArn: string) => ({ principalId: MEMBER, taskId, channelArn, taskType: 'general', status: 'pending', visibility: 'private' });
jest.mock('../../lambda/src/lib/task-service-op', () => ({
  invokeTaskServiceOp: async (_c: unknown, _arn: string, op: string) => {
    writes.push(`task:${op}`);
    return op === 'createTask' ? { taskId: 't-new', status: 'open' } : { ok: true, to: 'done' };
  },
}));
const PROPOSAL = {
  pk: 'proposal#h1', kind: 'proposal', op: 'open_conversation', channelArn: CHANNEL, classification: 'premium',
  personArn: arnOf(MEMBER), addressedAs: 'person', conversationType: 'general', workflow: 'w', step: 's',
};
jest.mock('../../lambda/src/lib/proposals', () => ({
  ...jest.requireActual('../../lambda/src/lib/proposals'),
  readProposal: async () => PROPOSAL,
  proposalRefusal: () => undefined,
  settleProposal: async () => { writes.push('settleProposal'); },
  releaseProposal: async () => { writes.push('releaseProposal'); },
}));
jest.mock('../../lambda/src/lib/tokens', () => ({
  ...jest.requireActual('../../lambda/src/lib/tokens'),
  redeemToken: async () => { writes.push('redeemToken'); return { ok: true }; },
}));
const INVITATION = {
  pk: 'invitation#i1', invitationId: 'i1', channelArn: CHANNEL, personArn: RECIPIENT, inviteeName: 'Bob',
  inviterArn: arnOf(MEMBER), mode: 'sign-in', classification: 'premium', createdAt: 1, expiresAt: 4_000_000_000,
};
jest.mock('../../lambda/src/lib/invitations', () => ({
  ...jest.requireActual('../../lambda/src/lib/invitations'),
  listInvitations: async () => { writes.push('read:invitations'); return [INVITATION]; },
  findInvitation: async () => { writes.push('read:invitations'); return INVITATION; },
  markRevoked: async () => { writes.push('markRevoked'); return { ...INVITATION, revokedAt: 2 }; },
}));

Object.assign(process.env, {
  APP_INSTANCE_ARN: APP,
  CHANNEL_BATTLE_CONFIG_TABLE: 'battle-config',
  FEEDBACK_TABLE: 'feedback',
  AUDIT_TABLE: 'conversation-actions',
  ADMIN_ARN_PARAM: '/test/admin-arn',
  USER_TASKS_TABLE: 'user-tasks',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const channelBattle = require('../../lambda/src/channel-battle').handler;
const battleOutcome = require('../../lambda/src/battle-outcome-api').handler;
const feedback = require('../../lambda/src/user-feedback').handler;
const tasks = require('../../lambda/src/user-tasks-api').handler;
const turnState = require('../../lambda/src/turn-state-api').handler;
const { listForMember, revokeForMember } = require('../../lambda/src/invitations');
const conversationManagement = require('../../lambda/src/conversation-management').handler;
const { applyProposal } = require('../../lambda/src/proposals-api');
const share = require('../../lambda/share-conversation/index.js').handler;
const membershipSource = require('../../lambda/src/lib/membership-source');
const { taskStateMachines, DEFAULT_INTENT_PACK } = require('../../lambda/src/lib/intent-pack');
/* eslint-enable @typescript-eslint/no-require-imports */

const TASK_TYPE = Object.keys(taskStateMachines(DEFAULT_INTENT_PACK))[0];

membershipSource.__setDefaultDirectoryForTests({
  personsInGroup: async () => ({ persons: [], unminted: [] }),
  personOf: async () => null,
  admins: async () => ({ persons: [], unminted: [] }),
  clearanceOf: async () => ({ state: 'none' as const }),
  listGroups: async () => [],
  findByAddress: async () => { writes.push('read:directory'); return RECIPIENT; },
  accountState: async () => 'active' as const,
  groupsFor: async () => ['premium'],
  clearedByGroups: async () => null,
  displayNameFor: async () => 'Bob',
  contactFor: async () => ({ route: 'email', address: 'bob@example.com', name: 'Bob' }),
});

function event(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>): APIGatewayProxyEvent {
  return {
    httpMethod: method, path, resource: path, headers: { origin: 'http://localhost:5173' },
    body: body ? JSON.stringify(body) : null, queryStringParameters: query ?? null, requestContext: {},
  } as unknown as APIGatewayProxyEvent;
}
const answer = (res: { statusCode: number; body: string }) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const invitationDeps = () => ({
  doc, messaging, tokensTable: 'tokens', appInstanceArn: APP,
  adminBearer: async () => ADMIN,
  removeMember: async () => { writes.push('removeMember'); },
  cancelDeadline: async () => true,
});
const proposalDeps = () => ({
  doc, messaging, lambda: { send: lambdaSend }, tokensTable: 'tokens', appInstanceArn: APP, creatorOf: () => 'creator',
});

interface Route {
  name: string;
  call: () => Promise<{ status: number; body: any }>;
  /** What a cleared member is answered with. */
  served: (r: { status: number; body: any }) => void;
}

const ROUTES: Route[] = [
  {
    name: 'GET /channels/battle',
    call: async () => answer(await channelBattle(event('GET', '/channels/battle', undefined, { channelArn: CHANNEL }))),
    served: (r) => expect(r).toMatchObject({ status: 200, body: { channelArn: CHANNEL, battleEligible: true } }),
  },
  {
    name: 'POST /channels/battle/enable',
    call: async () => answer(await channelBattle(event('POST', '/channels/battle/enable', { channelArn: CHANNEL }))),
    // Admitted, it goes on to the battle's own checks: the moderator list, then the experiment (none is active here).
    served: (r) => {
      expect(r.status).toBe(400);
      expect(sent.some((s) => s.name === 'ListChannelModeratorsCommand')).toBe(true);
    },
  },
  {
    name: 'POST /channels/battle/disable',
    call: async () => answer(await channelBattle(event('POST', '/channels/battle/disable', { channelArn: CHANNEL }))),
    served: (r) => expect(r).toMatchObject({ status: 200, body: { enabled: false } }),
  },
  {
    name: 'POST /channels/battle/outcome',
    call: async () => answer(await battleOutcome(event('POST', '/channels/battle/outcome', { battleId: 'b1', winner: 'A', channelArn: CHANNEL }))),
    served: (r) => {
      expect(r.status).toBe(200);
      expect(writes).toContain('recordBattleOutcome');
    },
  },
  {
    name: 'POST /feedback',
    call: async () => answer(await feedback(event('POST', '/feedback', { messageId: 'm1', channelArn: CHANNEL, feedback: 'up' }))),
    served: (r) => {
      expect(r).toMatchObject({ status: 200, body: { success: true } });
      expect(writes).toContain('dynamodb:PutCommand');
    },
  },
  {
    name: 'POST /tasks',
    call: async () => answer(await tasks(event('POST', '/tasks', { channelArn: CHANNEL, taskType: TASK_TYPE }))),
    served: (r) => expect(r).toMatchObject({ status: 201, body: { task: { taskId: 't-new' } } }),
  },
  {
    name: 'POST /tasks/advance',
    call: async () => answer(await tasks(event('POST', '/tasks/advance', { channelArn: CHANNEL, taskId: 't1', state: 'open', choice: 'done' }))),
    served: (r) => expect(r).toMatchObject({ status: 200, body: { taskId: 't1' } }),
  },
  {
    name: 'GET /turn-state',
    call: async () => answer(await turnState(event('GET', '/turn-state', undefined, { channelArn: CHANNEL, responderId: 'premium' }))),
    served: (r) => expect(r).toMatchObject({ status: 200, body: { busy: true } }),
  },
  {
    name: 'GET /invitations (a member lists)',
    call: async () => answer(await listForMember(event('GET', '/invitations', undefined, { channelArn: CHANNEL }), invitationDeps())),
    served: (r) => expect(r.body.invitations).toHaveLength(1),
  },
  {
    name: 'POST /invitations/revoke',
    call: async () => answer(await revokeForMember(event('POST', '/invitations/revoke', { channelArn: CHANNEL, invitationId: 'i1' }), invitationDeps())),
    served: (r) => {
      expect(r.status).toBe(200);
      expect(writes).toEqual(expect.arrayContaining(['markRevoked', 'removeMember']));
    },
  },
  {
    name: 'POST /conversations/archive',
    call: async () => answer(await conversationManagement(event('POST', '/conversations/archive', { channelArn: CHANNEL }))),
    served: (r) => {
      expect(r).toMatchObject({ status: 200, body: { archived: true } });
      expect(writes).toContain('TagResourceCommand');
    },
  },
  {
    name: 'POST /conversations/remove-member',
    call: async () => answer(await conversationManagement(event('POST', '/conversations/remove-member', { channelArn: CHANNEL, memberArn: RECIPIENT }))),
    served: (r) => {
      expect(r).toMatchObject({ status: 200, body: { removed: RECIPIENT } });
      expect(writes).toContain('DeleteChannelMembershipCommand');
    },
  },
  {
    name: 'POST /proposals/apply (open_conversation)',
    call: async () => answer(await applyProposal(event('POST', '/proposals/apply', { proposal: 'h1', decision: 'apply' }), proposalDeps())),
    served: (r) => {
      expect(r).toMatchObject({ status: 200, body: { applied: true, op: 'open_conversation' } });
      expect(writes).toContain('lambda:Invoke');
    },
  },
  {
    name: 'POST /share-conversation',
    call: async () => answer(await share(event('POST', '/share-conversation', { conversationArn: CHANNEL, recipientEmail: 'bob@example.com' }))),
    served: (r) => {
      expect(r.status).toBe(200);
      expect(writes).toContain('CreateChannelMembershipCommand');
    },
  },
];

beforeEach(() => {
  Object.assign(state, { person: MEMBER, member: true, token: 'premium', outage: false, describeFails: false, pooled: POOL_SIZE });
  ssmAsked.length = 0;
  writes.length = 0;
  items.length = 0;
  sent.length = 0;
  taskPages = [[task('t-here', CHANNEL), task('t-elsewhere', OTHER_CHANNEL)]];
  for (const level of ['log', 'warn', 'error', 'info'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** Nothing was changed, and nothing about the conversation was read out to the caller. */
function expectNothingDone(): void {
  expect(writes).toEqual([]);
}

describe.each(ROUTES)('$name', ({ call, served }) => {
  it('DENIED: an outsider, who was never a member', async () => {
    Object.assign(state, { person: OUTSIDER, member: false });
    const r = await call();
    expect(r).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expectNothingDone();
  });

  it('DENIED: a removed member, whose own membership lookup fails', async () => {
    state.member = false;
    const r = await call();
    expect(r).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expectNothingDone();
    // Asked as them: their own AppInstanceUser is the bearer, so only their own membership could have answered.
    const lookup = sent.find((s) => s.name === 'DescribeChannelMembershipCommand');
    expect(lookup?.input).toMatchObject({ ChannelArn: CHANNEL, MemberArn: arnOf(MEMBER), ChimeBearer: arnOf(MEMBER) });
  });

  it('DENIED: a member whose clearance does not reach the conversation', async () => {
    state.token = 'basic';
    const r = await call();
    expect(r).toMatchObject({ status: 403, body: { code: 'NOT_CLEARED' } });
    expectNothingDone();
  });

  it('UNAVAILABLE: a membership lookup that fails as a service failure is a retryable 503, never an answer', async () => {
    state.outage = true;
    const r = await call();
    expect(r).toMatchObject({ status: 503, body: { code: 'UNAVAILABLE' } });
    expectNothingDone();
  });

  it('a member cleared for the conversation is served', async () => {
    served(await call());
  });
});

describe('GET /tasks/mine lists only items from conversations the caller still reaches', () => {
  const mine = async () => answer(await tasks(event('GET', '/tasks/mine')));

  it('drops an item from a conversation the caller is no longer a member of', async () => {
    const r = await mine();
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { taskId: string }) => i.taskId)).toEqual(['t-here']);
    // ONE READ OF THE CALLER'S OWN MEMBERSHIPS, bearing the caller, and no lookup per conversation.
    const reads = sent.filter((s) => s.name === 'ListChannelMembershipsForAppInstanceUserCommand');
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads[0].input).toMatchObject({ ChimeBearer: arnOf(MEMBER), AppInstanceUserArn: arnOf(MEMBER) });
    expect(sent.filter((s) => s.name === 'DescribeChannelMembershipCommand')).toEqual([]);
  });

  it('DENIED: an outsider, a removed member and an uncleared member are shown nothing', async () => {
    Object.assign(state, { person: OUTSIDER, member: false });
    expect((await mine()).body).toEqual({ items: [], count: 0, complete: true });
    Object.assign(state, { person: MEMBER, member: false });
    expect((await mine()).body).toEqual({ items: [], count: 0, complete: true });
    Object.assign(state, { member: true, token: 'basic' });
    expect((await mine()).body).toEqual({ items: [], count: 0, complete: true });
  });

  it('UNAVAILABLE: a check that cannot be answered fails the list with a 503, never a shorter list', async () => {
    state.outage = true;
    expect(await mine()).toMatchObject({ status: 503, body: { code: 'UNAVAILABLE' } });
  });

  it('fills the page past items in conversations the caller left, reading memberships once', async () => {
    // A first page of items wholly in a conversation the caller left, then a page in one they are in: the
    // list is filled from the second page rather than coming back empty.
    taskPages = [
      Array.from({ length: 30 }, (_, i) => task(`gone-${i}`, OTHER_CHANNEL)),
      Array.from({ length: 30 }, (_, i) => task(`here-${i}`, CHANNEL)),
    ];
    const r = await mine();
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(25);
    expect(r.body.items.every((i: { channelArn: string }) => i.channelArn === CHANNEL)).toBe(true);
    // The membership read is not repeated for the second page: it already answered both conversations.
    expect(sent.filter((s) => s.name === 'ListChannelMembershipsForAppInstanceUserCommand')).toHaveLength(1);
    expect(sent.filter((s) => s.name === 'DescribeChannelMembershipCommand')).toEqual([]);
  });
});

describe('GET /channels/battle for a member of a conversation with no recognized classification', () => {
  it('answers with every classification-dependent capability absent, rather than blanking the composer', async () => {
    const r = answer(await channelBattle(event('GET', '/channels/battle', undefined, { channelArn: UNTAGGED_CHANNEL })));
    expect(r).toMatchObject({ status: 200, body: { channelArn: UNTAGGED_CHANNEL, enabled: false, battleEligible: false, attachmentsReadable: false } });
  });

  it('DENIED: a non-member of it is still refused', async () => {
    state.member = false;
    const r = answer(await channelBattle(event('GET', '/channels/battle', undefined, { channelArn: UNTAGGED_CHANNEL })));
    expect(r).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
  });
});

describe('archive and remove-member on a conversation with no recognized classification', () => {
  const archive = async () => answer(await conversationManagement(event('POST', '/conversations/archive', { channelArn: UNTAGGED_CHANNEL })));
  const remove = async () => answer(await conversationManagement(event('POST', '/conversations/remove-member', { channelArn: UNTAGGED_CHANNEL, memberArn: RECIPIENT })));

  it('a member may take access away: archive and remove both act', async () => {
    expect(await archive()).toMatchObject({ status: 200, body: { archived: true } });
    expect(await remove()).toMatchObject({ status: 200, body: { removed: RECIPIENT } });
    expect(writes).toEqual(expect.arrayContaining(['TagResourceCommand', 'DeleteChannelMembershipCommand']));
  });

  it('DENIED: a non-member may not', async () => {
    state.member = false;
    expect(await archive()).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await remove()).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expectNothingDone();
  });
});

describe('POST /feedback records the conversation as the check named it', () => {
  it('a vote naming the conversation by id is stored under its full channel ARN', async () => {
    const r = answer(await feedback(event('POST', '/feedback', { messageId: 'm1', channelArn: CONVO, feedback: 'up' })));
    expect(r.status).toBe(200);
    expect(items).toHaveLength(1);
    expect(items[0].channelArn).toBe(CHANNEL);
  });
});

describe('POST /proposals/apply opens a conversation only at a classification the caller reaches', () => {
  it('DENIED: a proposal whose classification is not its conversation\'s, before anything is claimed or opened', async () => {
    const proposals = jest.requireMock('../../lambda/src/lib/proposals') as { readProposal: () => Promise<unknown> };
    const original = proposals.readProposal;
    proposals.readProposal = async () => ({ ...PROPOSAL, classification: 'basic' });
    try {
      const r = answer(await applyProposal(event('POST', '/proposals/apply', { proposal: 'h1', decision: 'apply' }), proposalDeps()));
      expect(r).toMatchObject({ status: 403, body: { code: 'UNCLASSIFIED' } });
      expectNothingDone();
    } finally {
      proposals.readProposal = original;
    }
  });

  it('a proposal naming its classification by an alias matches the conversation tagged with it', async () => {
    const registry = jest.requireActual('../../lib/profile-registry').defaultProfileRegistry;
    const resolve = registry.resolveClassification.bind(registry);
    jest.spyOn(registry, 'resolveClassification').mockImplementation((v: unknown) => (v === 'top-tier' ? 'premium' : resolve(v)));
    const proposals = jest.requireMock('../../lambda/src/lib/proposals') as { readProposal: () => Promise<unknown> };
    const original = proposals.readProposal;
    proposals.readProposal = async () => ({ ...PROPOSAL, classification: 'top-tier' });
    const creators: string[] = [];
    try {
      const r = answer(await applyProposal(event('POST', '/proposals/apply', { proposal: 'h1', decision: 'apply' }), {
        ...proposalDeps(), creatorOf: (c: string) => { creators.push(c); return 'creator'; },
      }));
      expect(r).toMatchObject({ status: 200, body: { applied: true } });
      expect(creators).toEqual(['premium']);
    } finally {
      proposals.readProposal = original;
    }
  });
});

describe('leave is not gated on clearance', () => {
  it('a member whose clearance no longer reaches the conversation may still leave it', async () => {
    state.token = 'basic';
    const r = answer(await conversationManagement(event('POST', '/conversations/leave', { channelArn: CHANNEL })));
    expect(r).toMatchObject({ status: 200, body: { left: true } });
  });
});

describe('GET /tasks/mine costs one membership read, however many conversations hold the caller\'s work', () => {
  const reads = () => sent.filter((s) => s.name === 'ListChannelMembershipsForAppInstanceUserCommand');
  const lookups = () => sent.filter((s) => s.name === 'DescribeChannelMembershipCommand');

  it('lists work across many conversations from one membership read, with no lookup per conversation', async () => {
    taskPages = [Array.from({ length: POOL_SIZE }, (_, i) => task(`pooled-${i}`, poolChannel(i)))];
    const r = answer(await tasks(event('GET', '/tasks/mine')));
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(POOL_SIZE);
    expect(reads()).toHaveLength(1);
    expect(lookups()).toEqual([]);
  });

  it('stops paging once every conversation it was asked about is found', async () => {
    state.pooled = 500;
    const r = answer(await tasks(event('GET', '/tasks/mine')));
    expect(r.body.items.map((i: { taskId: string }) => i.taskId)).toEqual(['t-here']);
    // CHANNEL is on the first page; OTHER_CHANNEL is in none, so the read goes to the end only for it.
    taskPages = [[task('t-here', CHANNEL)]];
    sent.length = 0;
    answer(await tasks(event('GET', '/tasks/mine')));
    expect(reads()).toHaveLength(1);
  });

  it('a membership larger than the read takes is asked one conversation at a time, never dropped', async () => {
    const { LIST_MEMBERSHIP_MAX_PAGES } = jest.requireActual('../../lambda/src/lib/conversation-access');
    state.pooled = LIST_MEMBERSHIP_MAX_PAGES * 50 + 10;
    const last = poolChannel(state.pooled - 1);
    taskPages = [[task('t-far', last)]];
    const r = answer(await tasks(event('GET', '/tasks/mine')));
    expect(r.body.items.map((i: { taskId: string }) => i.taskId)).toEqual(['t-far']);
    expect(reads()).toHaveLength(LIST_MEMBERSHIP_MAX_PAGES);
    expect(lookups().map((s) => s.input)).toEqual([expect.objectContaining({ ChannelArn: last, MemberArn: arnOf(MEMBER), ChimeBearer: arnOf(MEMBER) })]);
  });
});

describe('archive and remove-member by a bare conversation id', () => {
  it('archives the full channel ARN the check named', async () => {
    const r = answer(await conversationManagement(event('POST', '/conversations/archive', { channelArn: CONVO })));
    expect(r).toMatchObject({ status: 200, body: { channelArn: CHANNEL, archived: true } });
    expect(sent.find((s) => s.name === 'TagResourceCommand')?.input.ResourceARN).toBe(CHANNEL);
  });

  it('removes a member of the full channel ARN the check named', async () => {
    const r = answer(await conversationManagement(event('POST', '/conversations/remove-member', { channelArn: CONVO, memberArn: RECIPIENT })));
    expect(r).toMatchObject({ status: 200, body: { channelArn: CHANNEL } });
    expect(sent.find((s) => s.name === 'DeleteChannelMembershipCommand')?.input.ChannelArn).toBe(CHANNEL);
  });
});

describe('POST /share-conversation by a bare conversation id', () => {
  it('adds the recipient to the full channel ARN the check named', async () => {
    const r = answer(await share(event('POST', '/share-conversation', { conversationArn: CONVO, recipientEmail: 'bob@example.com' })));
    expect(r.status).toBe(200);
    expect(sent.find((s) => s.name === 'CreateChannelMembershipCommand')?.input.ChannelArn).toBe(CHANNEL);
  });
});

describe('the check records what it was for', () => {
  const useOf = () => {
    const lines = (console.log as unknown as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ConversationAccessCheckMs'));
    return lines.map((l) => JSON.parse(l).Use);
  };

  it('a route check is `check`, and filtering a list across conversations is `list`', async () => {
    await feedback(event('POST', '/feedback', { messageId: 'm1', channelArn: CHANNEL, feedback: 'up' }));
    expect(useOf()).toEqual(['check']);
    (console.log as unknown as jest.Mock).mockClear();
    await tasks(event('GET', '/tasks/mine'));
    expect(new Set(useOf())).toEqual(new Set(['list']));
  });
});

describe('a function with no app instance', () => {
  it('UNAVAILABLE: says the deployment cannot check, never that the caller is not a member', async () => {
    const { callerReachesConversation } = jest.requireActual('../../lambda/src/lib/conversation-access');
    const errors = jest.spyOn(console, 'error');
    const access = await callerReachesConversation(event('GET', '/x'), CHANNEL, { appInstanceArn: '', client: messaging });
    expect(access).toMatchObject({ ok: false, status: 503, code: 'UNAVAILABLE', memberProven: false });
    expect(errors.mock.calls.some((c) => String(c[0]).includes('APP_INSTANCE_ARN is not configured'))).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('the container tag memo', () => {
  const { memoizedTagReader, tagMemoHolds, TAG_MEMO_CAPACITY } = jest.requireActual('../../lambda/src/lib/conversation-primary');
  const { ListTagsForResourceCommand } = jest.requireActual('@aws-sdk/client-chime-sdk-messaging');
  const arn = (n: number) => `${APP}/channel/lru-${n}`;
  const reads: string[] = [];
  const client = {
    send: async (cmd: Cmd) => {
      reads.push(cmd.input.ResourceARN);
      return { Tags: [{ Key: 'classification', Value: cmd.input.ResourceARN === arn(-1) ? 'not-declared' : 'premium' }] };
    },
  };
  const read = (reader: { send: (c: unknown) => Promise<unknown> }, n: number) => reader.send(new ListTagsForResourceCommand({ ResourceARN: arn(n) }));

  it('is one memo for every reader, keeps only a recognized classification, and evicts the least recently used', async () => {
    const a = memoizedTagReader(client);
    const b = memoizedTagReader(client);
    await read(a, 0);
    await read(b, 0);
    expect(reads.filter((r) => r === arn(0))).toHaveLength(1);
    await read(a, -1);
    await read(b, -1);
    expect(reads.filter((r) => r === arn(-1))).toHaveLength(2);
    expect(tagMemoHolds(arn(-1))).toBe(false);
    // Fill to capacity, then touch the first so it is the most recent: one more evicts the least recently used.
    for (let n = 1; n < TAG_MEMO_CAPACITY; n++) await read(a, n);
    await read(a, 0);
    await read(a, TAG_MEMO_CAPACITY);
    expect(tagMemoHolds(arn(0))).toBe(true);
    expect(tagMemoHolds(arn(1))).toBe(false);
    expect(tagMemoHolds(arn(TAG_MEMO_CAPACITY))).toBe(true);
  });
});

describe('GET /channels/battle when the tag read fails', () => {
  it('a proven member is answered with every classification-dependent capability absent', async () => {
    const r = answer(await channelBattle(event('GET', '/channels/battle', undefined, { channelArn: TAG_OUTAGE_CHANNEL })));
    expect(r).toMatchObject({ status: 200, body: { battleEligible: false, attachmentsReadable: false } });
  });

  it('UNAVAILABLE: a caller whose membership could not be proven is refused with a 503', async () => {
    state.outage = true;
    const r = answer(await channelBattle(event('GET', '/channels/battle', undefined, { channelArn: TAG_OUTAGE_CHANNEL })));
    expect(r).toMatchObject({ status: 503, body: { code: 'UNAVAILABLE' } });
  });
});

describe('POST /tasks after the check', () => {
  it('UNAVAILABLE: a failed read of the conversation is a retryable 503, not a refusal of membership', async () => {
    state.describeFails = true;
    const r = answer(await tasks(event('POST', '/tasks', { channelArn: CHANNEL, taskType: TASK_TYPE })));
    expect(r).toMatchObject({ status: 503, body: { code: 'CHANNEL_STATE_UNREADABLE' } });
    expect(writes).toEqual([]);
  });

  it('a conversation tagged with an alias finds the task service of the classification it names', async () => {
    const registry = jest.requireActual('../../lib/profile-registry').defaultProfileRegistry;
    const resolve = registry.resolveClassification.bind(registry);
    const known = registry.isKnownClassification.bind(registry);
    jest.spyOn(registry, 'resolveClassification').mockImplementation((v: unknown) => (v === ALIAS ? 'premium' : resolve(v)));
    jest.spyOn(registry, 'isKnownClassification').mockImplementation((v: unknown) => v === ALIAS || known(v));
    const r = answer(await tasks(event('POST', '/tasks', { channelArn: ALIAS_CHANNEL, taskType: TASK_TYPE })));
    expect(r.status).toBe(201);
    expect(ssmAsked.some((n) => n.includes(ALIAS))).toBe(false);
  });
});

describe('a route that decides on `archived` reads the conversation tags once', () => {
  const tagReads = () => sent.filter((s) => s.name === 'ListTagsForResourceCommand').length;

  it.each([
    ['POST /tasks', () => tasks(event('POST', '/tasks', { channelArn: CHANNEL, taskType: TASK_TYPE }))],
    ['POST /tasks/advance', () => tasks(event('POST', '/tasks/advance', { channelArn: CHANNEL, taskId: 't1', state: 'open', choice: 'done' }))],
    ['POST /proposals/apply', () => applyProposal(event('POST', '/proposals/apply', { proposal: 'h1', decision: 'apply' }), proposalDeps())],
  ])('%s', async (_name, call) => {
    expect((await call()).statusCode).toBeLessThan(300);
    expect(tagReads()).toBe(1);
  });

  it('POST /share-conversation reads them at most once, through the check', async () => {
    const r = answer(await share(event('POST', '/share-conversation', { conversationArn: CHANNEL, recipientEmail: 'bob@example.com' })));
    expect(r.status).toBe(200);
    expect(tagReads()).toBeLessThanOrEqual(1);
  });
});
