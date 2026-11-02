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
 * the classification's challenger, isn't conflicting with another active battle,
 * then calls Chime CreateChannelMembership + writes ChannelBattleConfig.
 *
 * These tests pin the auth + validation contracts that prevent abuse.
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { edgeContext } from './helpers/edge-context';

const mockMessagingSend = jest.fn();
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();
// Battle Mode's lines are named to the router (`say-through-router.ts`); this API speaks as no assistant.
const mockSay = jest.fn(async (..._args: unknown[]) => ({ posted: true }));

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
const ALT_BOT = `${APP_INSTANCE}/bot/Alt-premium`;
const EXP_ID = 'exp-battle-1';
const mockSidesOf = jest.fn();

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
      authorizer: edgeContext({ claims: { sub: args.sub ?? CALLER_SUB } }),
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
  jest.doMock('../lambda/src/lib/say-through-router', () => ({ sayThroughRouter: (...a: unknown[]) => mockSay(...a) }));
  // The challenger's name is resolved from the experiment the enable holds (`battleSidesOf`, its profile's name
  // settled by `battleSideNames`); that resolution has its own tests, so here it answers settled sides.
  jest.doMock('../lambda/src/lib/experiment-manager', () => ({
    ...jest.requireActual('../lambda/src/lib/experiment-manager'),
    battleSidesOf: (...a: unknown[]) => mockSidesOf(...a),
  }));
  const mod = await import('../lambda/src/channel-battle');
  return mod.handler;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSidesOf.mockResolvedValue({
    control: null,
    treatment: { experimentId: EXP_ID, variantId: 'treatment', modelKey: 'opus', displayName: 'Advisor (alt)', variantProfile: {} },
  });
  // A queued response a test did not consume must not leak into the next one.
  mockMessagingSend.mockReset();
  mockMessagingSend.mockResolvedValue({});
  process.env.APP_INSTANCE_ARN = APP_INSTANCE;
  process.env.CHANNEL_BATTLE_CONFIG_TABLE = 'channel-battle-config-test';
  process.env.EXPERIMENTS_TABLE = 'experiments-test';
  process.env.BOT_ARN_PARAM = '/agent-echelon/bot-arn';
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173';
  // Default SSM reads, BY PARAMETER NAME rather than one blanket value.
  //
  // Battle is now OFF for every classification until an operator turns it on (ADR-049), and the
  // setting is an SSM parameter this handler reads. A blanket mock answered that read with a bot ARN,
  // which is not 'true', so every enable in this file refused with TIER_FORBIDDEN - the gate working
  // exactly as designed against a fixture that had not been told the feature is opt-in now.
  mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) => {
    const name = cmd?.input?.Name ?? '';
    if (name.includes('/battle/') && name.endsWith('/enabled')) return { Parameter: { Value: 'true' } };
    // The room's alt, from the record its classification stack writes (§3.7).
    if (name.endsWith('/assistant-assignments/premium/primary/alt')) {
      return { Parameter: { Value: JSON.stringify({ classification: 'premium', role: 'primary', occupancy: 'alt', assistant: null, botArn: ALT_BOT, lexBotId: 'LEXALT' }) } };
    }
    return { Parameter: { Value: DEFAULT_BOT } };
  });
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
      Item: { channelArn: CHANNEL, enabled: true, experimentId: EXP_ID, challengerAssistant: 'alt-primary-premium', challengerBotArn: ALT_BOT },
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
    // `battleEligible` rides along even with no config row, because the UI gates the Battle surfaces
    // on capability. False here is the FAIL-CLOSED path: no classification tag is queued, so
    // resolution falls back to the lowest profile, which is not battle-eligible.
    // `attachmentsReadable` rides the same response for the same reason, and fails closed the same
    // way: the unresolved tag falls back to the lowest profile, which cannot read attachments. The
    // composer reads this to say so BEFORE a file is sent to a turn that would answer from the
    // caption alone - so a fail-closed false here is the safe direction, costing a notice somebody
    // ignores rather than a document silently unread.
    expect(JSON.parse(res.body)).toEqual({
      enabled: false,
      channelArn: CHANNEL,
      battleEligible: false,
      attachmentsReadable: false,
    });
  });

  it('reports battleEligible:true for a channel whose profile allows battles', async () => {
    // The half that matters to the UI: eligibility is read from the profile behind the IMMUTABLE
    // classification tag, not from `modelTier` in member-writable channel metadata. Without this the
    // frontend has no capability signal and falls back to that mutable field.
    // GET member-checks the caller BEFORE resolving the tag, so the membership response has to be
    // queued first or it consumes the tag read and eligibility silently resolves fail-closed.
    mockMessagingSend.mockResolvedValueOnce({});
    queueClassificationTag('premium');
    mockDdbSend.mockResolvedValueOnce({});
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/channels/battle',
      query: { channelArn: CHANNEL },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).battleEligible).toBe(true);
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
  //   2. ScanCommand → findChallengerConflicts (no conflicts)
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
        challengerAssistant: 'alt-primary-premium',
        variants: [
          { variantId: 'control' },
          { variantId: 'treatment' },
        ],
      },
    });
    // 3. findChallengerConflicts ScanCommand — no conflicts
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
    expect(body.challengerAssistant).toBe('alt-primary-premium');
    // The challenger is named by its profile, never an alias on the experiment row.
    expect(body.altBotDisplayName).toBe('Advisor (alt)');
    // From the experiment the enable read, not a second scan for the live battle.
    expect(mockSidesOf).toHaveBeenCalledTimes(1);
    expect(mockSidesOf.mock.calls[0][0]).toMatchObject({ experimentId: EXP_ID, challengerAssistant: 'alt-primary-premium' });

    // The membership add is the challenger's bot, read from its assignment record
    const createMembership = mockMessagingSend.mock.calls.find(
      (c) => c[0].__type === 'CreateMembership',
    );
    expect(createMembership![0].input.MemberArn).toBe(ALT_BOT);
    // The config row names the challenger by id and records the member this enable added.
    const config = mockDdbSend.mock.calls.find((c) => c[0].__type === 'Put')![0].input.Item;
    expect(config).toMatchObject({ challengerAssistant: 'alt-primary-premium', challengerBotArn: ALT_BOT });
    expect(config).not.toHaveProperty('altBotSlotArn');
    expect(config).not.toHaveProperty('altBotSlotId');
    // The announcement is named to the router, never posted by this API.
    expect(mockMessagingSend.mock.calls.some((c) => c[0].__type === 'SendMessage')).toBe(false);
    expect(mockSay).toHaveBeenCalledWith('premium', expect.objectContaining({ kind: expect.stringMatching(/^battleMode(On|Briefing)$/), channelArn: CHANNEL }));
  });

  it.each([
    ['resolves no name', async () => ({ control: null, treatment: { experimentId: EXP_ID, variantId: 'treatment', modelKey: 'opus', variantProfile: {} } })],
    ['throws', async () => { throw new Error('throttled'); }],
  ])("never announces the challenger's assistant id when its name %s", async (_label, sides) => {
    mockSidesOf.mockImplementation(sides);
    mockSuccessfulEnable();
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/channels/battle/enable',
      body: { channelArn: CHANNEL, experimentId: EXP_ID },
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.altBotDisplayName).toBe('The challenger');
    expect(JSON.stringify(mockSay.mock.calls)).not.toContain('alt-primary-premium');
    expect(mockSay).toHaveBeenCalledWith('premium', expect.objectContaining({ kind: 'battleModeOn', vars: { variant: 'The challenger' } }));
  });

  it("names an unnamed challenger with the battle-challenger-unnamed template; its version's retired copy is not read", async () => {
    mockSidesOf.mockResolvedValue({
      control: null,
      treatment: { experimentId: EXP_ID, variantId: 'treatment', modelKey: 'opus', variantProfile: { copy: { battleChallengerUnnamed: 'Le challenger' } } },
    });
    mockSuccessfulEnable();
    const handler = await loadHandler();
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/channels/battle/enable',
      body: { channelArn: CHANNEL, experimentId: EXP_ID },
    }));
    expect(JSON.parse(res.body).altBotDisplayName).toBe('The challenger');
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

  });

  // experimentId is optional: there is one active battle-enabled experiment per
  // classification, so an omitted id auto-resolves the channel classification's
  // single battle rather than forcing the caller to pick it.
  describe('auto-resolve (no experimentId)', () => {
    // Queue channel access + classification (premium) + moderator OK, matching
    // the successful-enable prelude but without an explicit experimentId.
    function queueEnablePrelude() {
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }) },
      });
      queueClassificationTag('premium');
      mockMessagingSend.mockResolvedValueOnce({
        ChannelModerators: [{ Moderator: { Arn: CALLER_ARN } }],
      });
    }

    it('auto-resolves the single battle-enabled experiment when experimentId is omitted', async () => {
      queueEnablePrelude();
      // resolveActiveBattleExperimentForClassification → loadExperiments Scan
      // (active-only in prod; the mock returns the one battle-enabled experiment).
      mockDdbSend.mockResolvedValueOnce({
        Items: [
          {
            experimentId: EXP_ID,
            status: 'active',
            battleEnabled: true,
            tiers: ['premium'],
            challengerAssistant: 'alt-primary-premium',
            variants: [
              { variantId: 'control' },
              { variantId: 'treatment' },
            ],
          },
        ],
      });
      // loadExperiment GetCommand (re-load by the resolved id for validation)
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          experimentId: EXP_ID,
          status: 'active',
          battleEnabled: true,
          challengerAssistant: 'alt-primary-premium',
          variants: [
            { variantId: 'control' },
            { variantId: 'treatment' },
          ],
        },
      });
      mockDdbSend.mockResolvedValueOnce({ Items: [] }); // findChallengerConflicts — none
      mockMessagingSend.mockResolvedValueOnce({}); // CreateChannelMembership
      mockDdbSend.mockResolvedValueOnce({}); // PutCommand config
      mockMessagingSend.mockResolvedValueOnce({}); // announce

      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL },
      }));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(true);
      expect(body.experimentId).toBe(EXP_ID);
    });

    it('returns 400 NO_BATTLE_EXPERIMENT when none is battle-enabled for the classification', async () => {
      queueEnablePrelude();
      // loadExperiments Scan returns no battle-enabled experiment.
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL },
      }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('NO_BATTLE_EXPERIMENT');
    });
  });

  describe('auth gates', () => {
    // ELIGIBILITY IS TWO QUESTIONS NOW (ADR-049), and these cases are the pair that proves the split.
    //
    // This block has been rewritten twice, which is worth knowing. It first asserted "premium only",
    // then "no classification is ever refused" once every conversational profile was marked eligible.
    // Both were reading ONE flag. The flag was wrong for basic: it said eligible while basic's stack
    // sets `battleCapable: false` and wires no battle plumbing, so an enable succeeded and the duel
    // had no grants to run with. What refuses basic now is capability, which is a fact about the
    // deployment rather than a setting anyone can flip.
    it('REFUSES a basic channel, because its deployment wires no battle plumbing', async () => {
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

    it('does NOT refuse a standard channel on eligibility once battle is turned on', async () => {
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'standard', createdBy: CALLER_ARN }) },
      });
      queueClassificationTag('standard');
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      // Asserted on the CODE rather than on a success, because the request goes on to moderator and
      // experiment checks this fixture does not satisfy. The claim is narrow and exact: for a capable
      // classification with battle turned on, eligibility is not what stops it.
      expect(JSON.parse(res.body).code).not.toBe('TIER_FORBIDDEN');
    });

    it('REFUSES a capable classification while battle is turned OFF, so the setting is what decides', async () => {
      // The other half of the split, and the one that makes the feature opt-in rather than ambient:
      // premium is capable, but an operator has not turned battle on.
      mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) => {
        const name = cmd?.input?.Name ?? '';
        if (name.includes('/battle/') && name.endsWith('/enabled')) return { Parameter: { Value: 'false' } };
        return { Parameter: { Value: DEFAULT_BOT } };
      });
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }) },
      });
      queueClassificationTag('premium');
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('TIER_FORBIDDEN');
    });

    it('refuses the enable when the classification tag cannot be read', async () => {
      // THE GUARANTEE THIS REPLACES. `channel-battle.ts` used to fail closed to the floor and lean on
      // the floor not being battle-eligible, so an unreadable tag denied the duel as a side effect.
      // The moment every classification became eligible, that side effect would have inverted into
      // OPENING a duel on a conversation nobody could classify. The refusal is now explicit and does
      // not depend on any classification's flags.
      mockMessagingSend.mockResolvedValueOnce({
        Channel: { Metadata: JSON.stringify({ modelTier: 'premium', createdBy: CALLER_ARN }) },
      });
      mockMessagingSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'ForbiddenException' }));
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('CLASSIFICATION_UNREADABLE');
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

    it('returns 401 when the sign-in names no person', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      });
      // strip the claims
      (event.requestContext.authorizer as { tokenClaims: object }).tokenClaims = {};
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
        Item: { experimentId: EXP_ID, status: 'active', battleEnabled: false, challengerAssistant: 'alt-primary-premium' },
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

    it('returns 400 EXPERIMENT_NO_CHALLENGER when the experiment names no challenger', async () => {
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
      expect(JSON.parse(res.body).code).toBe('EXPERIMENT_NO_CHALLENGER');
    });

    it('returns 400 EXPERIMENT_NO_CHALLENGER when the challenger is not the room\'s alt, and adds nobody', async () => {
      // A row naming another classification's alt names an assistant this room's records do not. Adding
      // it would put an identity nothing here sanctions into the room.
      expectChannelOk();
      mockDdbSend.mockResolvedValueOnce({
        Item: { experimentId: EXP_ID, status: 'active', battleEnabled: true, tiers: ['premium'], challengerAssistant: 'alt-primary-standard' },
      });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('EXPERIMENT_NO_CHALLENGER');
      expect(mockMessagingSend.mock.calls.some((c) => c[0]?.input?.MemberArn)).toBe(false);
      // The record read is this room's classification's alt, not a roster.
      const reads = mockSsmSend.mock.calls.map((c) => c[0]?.input?.Name as string);
      expect(reads).toContain('/agent-echelon/assistant-assignments/premium/primary/alt');
    });

    it('returns 400 CHALLENGER_CLASSIFICATION_MISMATCH for an experiment of another classification', async () => {
      expectChannelOk();
      mockDdbSend.mockResolvedValueOnce({
        Item: { experimentId: EXP_ID, status: 'active', battleEnabled: true, tiers: ['standard'], challengerAssistant: 'alt-primary-standard' },
      });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('CHALLENGER_CLASSIFICATION_MISMATCH');
    });

    it('returns 400 EXPERIMENT_NOT_ACTIVE for paused/completed experiments', async () => {
      expectChannelOk();
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          experimentId: EXP_ID,
          status: 'paused',
          battleEnabled: true,
          challengerAssistant: 'alt-primary-premium',
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

    it('returns 409 CHALLENGER_BOUND when another active experiment names the same challenger', async () => {
      expectChannelOk();
      mockDdbSend
        .mockResolvedValueOnce({
          Item: {
            experimentId: EXP_ID,
            status: 'active',
            battleEnabled: true,
            challengerAssistant: 'alt-primary-premium',
            variants: [{ variantId: 'control' }, { variantId: 'treatment' }],
          },
        })
        .mockResolvedValueOnce({
          Items: [
            { experimentId: 'exp-other', battleEnabled: true, challengerAssistant: 'alt-primary-premium', status: 'active' },
          ],
        });
      const handler = await loadHandler();
      const res = await handler(makeEvent({
        method: 'POST',
        path: '/channels/battle/enable',
        body: { channelArn: CHANNEL, experimentId: EXP_ID },
      }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('CHALLENGER_BOUND');
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
            challengerAssistant: 'alt-primary-premium',
            variants: [{ variantId: 'control' }, { variantId: 'treatment' }],
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
    queueClassificationTag('premium'); // disable resolves the tag too (resolvePrimaryBotArn)
    // moderator-list pass-through.
    mockMessagingSend.mockResolvedValueOnce({
      ChannelModerators: [{ Moderator: { Arn: CALLER_ARN } }],
    });
    // GetCommand → load existing config to find the member the enable added. A row written before the
    // re-key names it under its old attribute, which disable still reads.
    mockDdbSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL, enabled: true, altBotSlotArn: ALT_BOT },
    });
    mockMessagingSend.mockResolvedValueOnce({}); // DeleteChannelMembership
    mockDdbSend.mockResolvedValueOnce({}); // DeleteCommand

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
    expect(deleteMembership![0].input.MemberArn).toBe(ALT_BOT);
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
      Item: { channelArn: CHANNEL, enabled: true, challengerAssistant: 'alt-primary-premium', challengerBotArn: ALT_BOT },
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
