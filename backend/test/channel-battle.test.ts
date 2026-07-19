/**
 * Channel Battle Admin API Handler — Unit Tests
 *
 * Per SPEC-BATTLE.md "Per-Channel Battle Enablement", this
 * Lambda backs:
 *   POST /channels/battle/enable   { channelArn, experimentId }
 *   POST /channels/battle/disable  { channelArn }
 *   GET  /channels/battle?channelArn=...
 *
 * Authorization (defense in depth):
 *   - Cognito-authenticated (handled by API Gateway authorizer — tests
 *     assume claims are present on the event)
 *   - Channel moderator (creator) only
 *   - Premium-classification channel only for enable
 *
 * The handler validates the experiment is battle-enabled, has an
 * altBotSlotArn bound, isn't conflicting with another active battle,
 * then calls Chime CreateChannelMembership + writes ChannelBattleConfig.
 *
 * These tests pin the auth + validation contracts that prevent abuse.
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockMessagingSend = jest.fn();
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  CreateChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'CreateMembership', input: args })),
  DeleteChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'DeleteMembership', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
  DescribeChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannelMembership', input: args })),
  ListChannelModeratorsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListModerators', input: args })),
  // The classification gate keys on the IMMUTABLE `classification` tag (ListTagsForResource),
  // NOT mutable `metadata.modelTier` — see channel-battle.ts resolveChannelClassification().
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  PutCommand: jest.fn().mockImplementation((args) => ({ __type: 'Put', input: args })),
  DeleteCommand: jest.fn().mockImplementation((args) => ({ __type: 'Delete', input: args })),
  ScanCommand: jest.fn().mockImplementation((args) => ({ __type: 'Scan', input: args })),
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
}), { virtual: true });

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const CHANNEL = `${APP_INSTANCE}/channel/conv-abc-123`;
const CALLER_SUB = 'user-creator';
const CALLER_ARN = `${APP_INSTANCE}/user/${CALLER_SUB}`;
const OTHER_SUB = 'user-other';
const OTHER_ARN = `${APP_INSTANCE}/user/${OTHER_SUB}`;
const DEFAULT_BOT = `${APP_INSTANCE}/bot/default`;
const ALT_SLOT = `${APP_INSTANCE}/bot/AltSlot0`;
const EXP_ID = 'exp-battle-1';

function makeEvent(args: {
  method: 'GET' | 'POST' | 'OPTIONS';
  path: string;
  body?: object;
  query?: Record<string, string>;
  sub?: string;
}): APIGatewayProxyEvent {
  return {
    httpMethod: args.method,
    path: args.path,
    body: args.body ? JSON.stringify(args.body) : null,
    queryStringParameters: args.query || null,
    headers: { origin: 'http://localhost:5173' },
    requestContext: {
      authorizer: { claims: { sub: args.sub ?? CALLER_SUB } },
    },
  } as unknown as APIGatewayProxyEvent;
}

// Queue the classification-tag read (ListTagsForResource). The handler resolves
// the channel's classification from this immutable tag, called AFTER DescribeChannel
// (createdBy) and BEFORE ListChannelModerators — so queue it in that order.
function queueClassificationTag(classification: string) {
  mockMessagingSend.mockResolvedValueOnce({ Tags: [{ Key: 'classification', Value: classification }] });
}

async function loadHandler() {
  jest.resetModules();
  jest.doMock('@aws-sdk/client-chime-sdk-messaging', () => ({
    ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
    CreateChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'CreateMembership', input: args })),
    DeleteChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'DeleteMembership', input: args })),
    DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
    // channel-battle GET membership-checks the caller. mockMessagingSend
    // default resolves to {} so the check passes unless a test overrides.
    DescribeChannelMembershipCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannelMembership', input: args })),
    // callerIsModerator uses ListChannelModerators. Per-test mocks below
    // stub the response so
    // the caller is/is-not a moderator as the case under test requires.
    ListChannelModeratorsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListModerators', input: args })),
    // Classification gate reads the immutable `classification` tag, not metadata.modelTier.
    ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
    SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
    ChannelMessageType: { STANDARD: 'STANDARD' },
    ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
  }), { virtual: true });
  jest.doMock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn(),
  }), { virtual: true });
  jest.doMock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
    GetCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
    PutCommand: jest.fn().mockImplementation((args) => ({ __type: 'Put', input: args })),
    DeleteCommand: jest.fn().mockImplementation((args) => ({ __type: 'Delete', input: args })),
    ScanCommand: jest.fn().mockImplementation((args) => ({ __type: 'Scan', input: args })),
  }), { virtual: true });
  jest.doMock('@aws-sdk/client-ssm', () => ({
    SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
    GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
  }), { virtual: true });
  const mod = await import('../lambda/src/channel-battle');
  return mod.handler;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APP_INSTANCE_ARN = APP_INSTANCE;
  process.env.CHANNEL_BATTLE_CONFIG_TABLE = 'channel-battle-config-test';
  process.env.EXPERIMENTS_TABLE = 'experiments-test';
  process.env.BOT_ARN_PARAM = '/agent-echelon/bot-arn';
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
  // Default SSM bot-arn lookup
  mockSsmSend.mockResolvedValue({ Parameter: { Value: DEFAULT_BOT } });
});

describe('OPTIONS preflight', () => {
  it('returns 200 with CORS headers', async () => {
    const handler = await loadHandler();
    const res = await handler(makeEvent({ method: 'OPTIONS', path: '/channels/battle/enable' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers!['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });
});

describe('GET /channels/battle', () => {
  it('returns the config row when enabled', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL, enabled: true, experimentId: EXP_ID, altBotSlotArn: ALT_SLOT },
    });
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/channels/battle',
      query: { channelArn: CHANNEL },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).enabled).toBe(true);
    expect(JSON.parse(res.body).experimentId).toBe(EXP_ID);
  });

  it('returns enabled:false when no row exists', async () => {
    mockDdbSend.mockResolvedValueOnce({});
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/channels/battle',
      query: { channelArn: CHANNEL },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ enabled: false, channelArn: CHANNEL });
  });

  it('returns 400 for invalid channelArn shape', async () => {
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/channels/battle',
      query: { channelArn: 'not-a-valid-arn' },
    }));
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /channels/battle/enable', () => {
  // Helper that queues the M3 moderator-list response confirming the
  // caller IS a moderator (one page, NextToken absent).
  function mockModeratorOk() {
    mockMessagingSend.mockResolvedValueOnce({
      ChannelModerators: [{ Moderator: { Arn: CALLER_ARN } }],
    });
  }

  // Helper that wires up the typical successful enable mock sequence.
  // DDB call order:
  //   1. GetCommand → loadExperiment (the battle experiment to bind)
  //   2. ScanCommand → findSlotConflicts (no conflicts)
  //   3. PutCommand → write ChannelBattleConfig row
  function mockSuccessfulEnable() {
    // 1. DescribeChannel → created by caller (createdBy read from metadata)
    mockMessagingSend.mockResolvedValueOnce({
      Channel: {
        Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }),
      },
    });
    // 1b. classification tag → premium (battle-eligible); the real classification gate
    queueClassificationTag('premium');
    // moderator-list check post-classification-gate
    mockModeratorOk();
    // 2. loadExperiment GetCommand
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        experimentId: EXP_ID,
        status: 'active',
        battleEnabled: true,
        altBotSlotId: 'slot-0',
        altBotSlotArn: ALT_SLOT,
        variants: [
          { variantId: 'control', displayName: 'Atlas' },
          { variantId: 'treatment', displayName: 'Echo' },
        ],
      },
    });
    // 3. findSlotConflicts ScanCommand — no conflicts
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    // 4. CreateChannelMembership
    mockMessagingSend.mockResolvedValueOnce({});
    // 5. PutCommand → ChannelBattleConfig
    mockDdbSend.mockResolvedValueOnce({});
    // 6. SendChannelMessage (announcement)
    mockMessagingSend.mockResolvedValueOnce({});
  }

  it('happy path: moderator enables on premium channel', async () => {
    mockSuccessfulEnable();
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/channels/battle/enable',
      body: { channelArn: CHANNEL, experimentId: EXP_ID },
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.enabled).toBe(true);
    expect(body.experimentId).toBe(EXP_ID);
    expect(body.altBotSlotArn).toBe(ALT_SLOT);
    expect(body.altBotDisplayName).toBe('Echo');

    // Verify the membership add happened against the slot ARN
    const createMembership = mockMessagingSend.mock.calls.find(
      (c) => c[0].__type === 'CreateMembership',
    );
    expect(createMembership![0].input.MemberArn).toBe(ALT_SLOT);
  });

  describe('input validation', () => {
    it('rejects missing channelArn (400)', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(400);
    });

    it('rejects malformed channelArn (400)', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: 'arn:bogus', experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing experimentId (400)', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL },
      }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('auth gates', () => {
    it('returns 403 TIER_FORBIDDEN for a basic-classification channel', async () => {
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'basic', createdBy: CALLER_ARN }) },
      });
      queueClassificationTag('basic'); // the tag, not metadata, gates the classification
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('TIER_FORBIDDEN');
    });

    it('returns 403 TIER_FORBIDDEN for a standard-classification channel', async () => {
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'standard', createdBy: CALLER_ARN }) },
      });
      queueClassificationTag('standard'); // the tag, not metadata, gates the classification
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('TIER_FORBIDDEN');
    });

    it('returns 403 NOT_MODERATOR when caller is not a channel moderator (live ListChannelModerators)', async () => {
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: OTHER_ARN }) },
      });
      queueClassificationTag('premium'); // passes the classification gate, so the moderator check runs
      // moderator list does NOT include CALLER_ARN
      mockMessagingSend.mockResolvedValueOnce({
        ChannelModerators: [{ Moderator: { Arn: OTHER_ARN } }],
      });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
        sub: CALLER_SUB,
      }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('NOT_MODERATOR');
    });

    it('returns 401 when no Cognito sub on the request', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      });
      // strip the claims
      (event.requestContext.authorizer as { claims: object }).claims = {};
      const handler = await loadHandler();
      const res = await handler(event);
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when channel metadata cannot be loaded', async () => {
      mockMessagingSend.mockRejectedValueOnce(new Error('channel not found'));
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(404);
    });
  });

  describe('experiment validation', () => {
    function expectChannelOk() {
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }) },
      });
      queueClassificationTag('premium'); // battle-eligible classification from the tag
      // moderator-list pass-through.
      mockMessagingSend.mockResolvedValueOnce({
        ChannelModerators: [{ Moderator: { Arn: CALLER_ARN } }],
      });
    }

    it('returns 404 when experiment does not exist', async () => {
      expectChannelOk();
      mockDdbSend.mockResolvedValueOnce({}); // no Item
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 EXPERIMENT_NOT_BATTLE when battleEnabled is false', async () => {
      expectChannelOk();
      mockDdbSend.mockResolvedValueOnce({
        Item: { experimentId: EXP_ID, status: 'active', battleEnabled: false, altBotSlotArn: ALT_SLOT },
      });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('EXPERIMENT_NOT_BATTLE');
    });

    it('returns 400 EXPERIMENT_NO_SLOT when altBotSlotArn is missing', async () => {
      expectChannelOk();
      mockDdbSend.mockResolvedValueOnce({
        Item: { experimentId: EXP_ID, status: 'active', battleEnabled: true },
      });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('EXPERIMENT_NO_SLOT');
    });

    it('returns 400 EXPERIMENT_NOT_ACTIVE for paused/completed experiments', async () => {
      expectChannelOk();
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          experimentId: EXP_ID,
          status: 'paused',
          battleEnabled: true,
          altBotSlotId: 'slot-0',
          altBotSlotArn: ALT_SLOT,
        },
      });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('EXPERIMENT_NOT_ACTIVE');
    });

    it('returns 409 SLOT_BOUND when another active experiment claims the same slot', async () => {
      expectChannelOk();
      mockDdbSend
        .mockResolvedValueOnce({
          Item: {
            experimentId: EXP_ID,
            status: 'active',
            battleEnabled: true,
            altBotSlotId: 'slot-0',
            altBotSlotArn: ALT_SLOT,
            variants: [{ displayName: 'A' }, { displayName: 'B' }],
          },
        })
        .mockResolvedValueOnce({
          Items: [
            { experimentId: 'exp-other', battleEnabled: true, altBotSlotId: 'slot-0', status: 'active' },
          ],
        });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('SLOT_BOUND');
      expect(JSON.parse(res.body).conflictingExperimentIds).toContain('exp-other');
    });
  });

  describe('idempotency', () => {
    it('CreateChannelMembership ConflictException is treated as success (already a member)', async () => {
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }) },
      });
      queueClassificationTag('premium');
      // moderator-list pass-through.
      mockMessagingSend.mockResolvedValueOnce({
        ChannelModerators: [{ Moderator: { Arn: CALLER_ARN } }],
      });
      mockDdbSend
        .mockResolvedValueOnce({
          Item: {
            experimentId: EXP_ID,
            status: 'active',
            battleEnabled: true,
            altBotSlotId: 'slot-0',
            altBotSlotArn: ALT_SLOT,
            variants: [{ displayName: 'A' }, { displayName: 'B' }],
          },
        })
        .mockResolvedValueOnce({ Items: [] }); // no conflicts

      const conflictErr = new Error('member already exists') as Error & { name: string };
      conflictErr.name = 'ConflictException';
      mockMessagingSend.mockRejectedValueOnce(conflictErr); // CreateChannelMembership

      mockDdbSend.mockResolvedValueOnce({}); // Put config
      mockMessagingSend.mockResolvedValueOnce({}); // announce message

      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).enabled).toBe(true);
    });
  });
});

describe('POST /channels/battle/disable', () => {
  it('removes the membership + deletes the config row + posts a leave message', async () => {
    // DescribeChannel — caller is creator
    mockMessagingSend.mockResolvedValueOnce({
      Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }) },
    });
    queueClassificationTag('premium'); // disable resolves the tag too (resolveBotArn)
    // moderator-list pass-through.
    mockMessagingSend.mockResolvedValueOnce({
      ChannelModerators: [{ Moderator: { Arn: CALLER_ARN } }],
    });
    // GetCommand → load existing config to find altBotSlotArn
    mockDdbSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL, enabled: true, altBotSlotArn: ALT_SLOT },
    });
    mockMessagingSend.mockResolvedValueOnce({}); // DeleteChannelMembership
    mockDdbSend.mockResolvedValueOnce({}); // DeleteCommand
    mockMessagingSend.mockResolvedValueOnce({}); // SendChannelMessage

    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/channels/battle/disable',
      body: { channelArn: CHANNEL },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ enabled: false, channelArn: CHANNEL });

    const deleteMembership = mockMessagingSend.mock.calls.find(
      (c) => c[0].__type === 'DeleteMembership',
    );
    expect(deleteMembership![0].input.MemberArn).toBe(ALT_SLOT);
  });

  it('returns 403 NOT_MODERATOR when caller is not a moderator (live ListChannelModerators)', async () => {
    mockMessagingSend.mockResolvedValueOnce({
      Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: OTHER_ARN }) },
    });
    queueClassificationTag('premium');
    // moderator list does NOT include CALLER_ARN
    mockMessagingSend.mockResolvedValueOnce({
      ChannelModerators: [{ Moderator: { Arn: OTHER_ARN } }],
    });
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/channels/battle/disable',
      body: { channelArn: CHANNEL },
    }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('NOT_MODERATOR');
  });

  it('still removes the config row even if Chime DeleteChannelMembership fails (non-fatal)', async () => {
    mockMessagingSend.mockResolvedValueOnce({
      Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }) },
    });
    queueClassificationTag('premium');
    // moderator-list pass-through.
    mockMessagingSend.mockResolvedValueOnce({
      ChannelModerators: [{ Moderator: { Arn: CALLER_ARN } }],
    });
    mockDdbSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL, enabled: true, altBotSlotArn: ALT_SLOT },
    });
    mockMessagingSend.mockRejectedValueOnce(new Error('chime is down'));
    mockDdbSend.mockResolvedValueOnce({}); // DeleteCommand still runs
    mockMessagingSend.mockResolvedValueOnce({}); // announce

    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/channels/battle/disable',
      body: { channelArn: CHANNEL },
    }));
    expect(res.statusCode).toBe(200);
    // Verify DeleteCommand was called
    const deleteCfg = mockDdbSend.mock.calls.find((c) => c[0].__type === 'Delete');
    expect(deleteCfg).toBeDefined();
  });
});

describe('Unknown route', () => {
  it('returns 404 for an unrecognized path', async () => {
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/channels/battle/bogus',
      body: {},
    }));
    expect(res.statusCode).toBe(404);
  });
});
