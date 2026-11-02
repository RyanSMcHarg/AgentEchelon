/**
 * Battle Orchestrator Lambda Unit Tests
 *
 * Per SPEC-BATTLE.md, the orchestrator's job:
 *   1. Read all bot rows for a battleId.
 *   2. If not all terminal, defer — the late writer will fire when their
 *      transition lands.
 *   3. tryClaimOrchestratorFire — exactly-one wins; rest no-op.
 *   4. For each bot in parallel: hand the round to the duel classification's
 *      router, with battleContext.round=2 and the OTHER bot's round-1 reply as
 *      rivalReply. The router posts the side's placeholder and dispatches.
 *
 * THE ORCHESTRATOR SPEAKS AS NO ASSISTANT. Every line a duel puts in the
 * conversation outside a turn is the router's: the round placeholder (`aeRebuttal`), the didn't-finish
 * and closing lines (`aeNotice`, through `sayThroughRouter`). These tests pin that no Amazon Chime SDK
 * send ever leaves this handler, and what it names to the router instead. The placeholder's own content
 * is pinned where the router builds it (`a-shared-service-only-speaks.test.ts`).
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockReadBattleRows = jest.fn();
const mockTryClaimOrchestratorFire = jest.fn();
const mockClearActiveBattle = jest.fn();

const mockChimeModule = () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Send', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
});
const mockLambdaModule = () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
});
// Mock battle-state module entirely — we don't need the real impl for these
// tests, and inlining the two pure helpers (allBotsTerminal, botRowsOnly)
// avoids pulling in the real module's AWS SDK imports.
/** The conversation's battle config: binds the experiment the round's sides are read from. */
const mockLoadChannelBattleConfig = jest.fn(async (..._a: unknown[]): Promise<unknown> => null);
const mockBattleStateModule = () => ({
  readBattleRows: (...args: unknown[]) => mockReadBattleRows(...args),
  tryClaimOrchestratorFire: (...args: unknown[]) => mockTryClaimOrchestratorFire(...args),
  allBotsTerminal: (rows: Array<{ botArn: string; state: string }>) => {
    const bots = rows.filter((r) => r.botArn !== '__orchestrator__');
    if (bots.length === 0) return false;
    return bots.every((r) => r.state === 'COMPLETED' || r.state === 'FAILED');
  },
  botRowsOnly: (rows: Array<{ botArn: string }>) => rows.filter((r) => r.botArn !== '__orchestrator__'),
  clearActiveBattle: (...args: unknown[]) => mockClearActiveBattle(...args),
  loadChannelBattleConfig: (...args: unknown[]) => mockLoadChannelBattleConfig(...args),
  COMPLETE_SENTINEL: '__complete__',
  isPastDeadline: (row: { deadlineAt?: number; enteredStateAt?: string }) => {
    const d = row.deadlineAt;
    if (typeof d === 'number' && Number.isFinite(d)) return Date.now() > (d < 1e12 ? d * 1000 : d);
    const e = row.enteredStateAt ? Date.parse(row.enteredStateAt) : NaN;
    return Number.isFinite(e) ? Date.now() > e + 180000 : false;
  },
});
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => mockChimeModule(), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => mockLambdaModule(), { virtual: true });
jest.mock('../lambda/src/lib/battle-state', () => mockBattleStateModule());

import type { BattleOrchestratorEvent } from '../lambda/src/battle-orchestrator';

// A fresh module graph per test, so each one starts with no cached client.
async function loadHandler() {
  jest.resetModules();
  jest.doMock('@aws-sdk/client-chime-sdk-messaging', mockChimeModule, { virtual: true });
  jest.doMock('@aws-sdk/client-lambda', mockLambdaModule, { virtual: true });
  jest.doMock('../lambda/src/lib/battle-state', mockBattleStateModule);
  const mod = await import('../lambda/src/battle-orchestrator');
  return mod.handler;
}

const bodyOf = (cmd: { input: { Payload: Uint8Array } }) => JSON.parse(Buffer.from(cmd.input.Payload).toString());
/** The rounds the orchestrator handed the router (Phase 1c): the processor payload, wrapped. */
const rounds = () => mockLambdaSend.mock.calls.filter((c) => bodyOf(c[0]).aeRebuttal);
const payloadOf = (cmd: { input: { Payload: Uint8Array } }) => bodyOf(cmd).aeRebuttal;
/** The notices the orchestrator named to the router. */
const notices = () => mockLambdaSend.mock.calls.filter((c) => bodyOf(c[0]).aeNotice).map((c) => ({
  router: c[0].input.FunctionName as string,
  ...bodyOf(c[0]).aeNotice,
}));
const routerFor = (c: string) => `arn:aws:lambda:us-east-1:111:function:router-${c}`;
const ROUTER_ENV = ['BASIC_ROUTER_ARN', 'STANDARD_ROUTER_ARN', 'PREMIUM_ROUTER_ARN'];
/** The router answers a round with a dispatch, and a notice with a post. */
const routerAnswers = async (cmd: { input: { Payload: Uint8Array } }) => ({
  Payload: Buffer.from(JSON.stringify(bodyOf(cmd).aeRebuttal ? { dispatched: true, placeholderMessageId: 'ph-1' } : { posted: true })),
});

const BATTLE_ID = 'a1b2c3d4e5f60718';
const CHANNEL_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT_A = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const BOT_B = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Alt-premium';

const baseEvent: BattleOrchestratorEvent = {
  battleId: BATTLE_ID,
  channelArn: CHANNEL_ARN,
  userMessage: 'Compare REST vs GraphQL',
  senderArn: 'arn:aws:chime:us-east-1:111:app-instance/i/user/sender',
  originatingMessageId: 'msg-orig-1',
  // THE DUEL'S CLASSIFICATION, which a real invoke always carries: the finishing worker passes it
  // from `event.classification` through `recordBattleTerminalAndFireOrchestrator`.
  classification: 'premium',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLambdaSend.mockReset().mockImplementation(routerAnswers);
  mockMessagingSend.mockReset().mockResolvedValue({ Tags: [] });
  for (const name of ROUTER_ENV) process.env[name] = routerFor(name.split('_')[0].toLowerCase());
});
afterAll(() => {
  for (const name of ROUTER_ENV) delete process.env[name];
});

/** No Amazon Chime SDK send leaves the orchestrator: the only Chime call it may make is a tag read. */
const sentNothing = () => expect(mockMessagingSend.mock.calls.filter((c) => c[0].__type !== 'ListTags')).toEqual([]);

describe('battle-orchestrator handler', () => {
  describe('preconditions', () => {
    it('no-ops when no bot rows exist for the battleId', async () => {
      mockReadBattleRows.mockResolvedValueOnce([]);
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(mockTryClaimOrchestratorFire).not.toHaveBeenCalled();
      expect(mockLambdaSend).not.toHaveBeenCalled();
      sentNothing();
    });

    it('defers when not all bots are terminal (late writer will retry)', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says' },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'INVOKED' },
      ]);
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(mockTryClaimOrchestratorFire).not.toHaveBeenCalled();
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('no-ops if the duel classification has no router wired', async () => {
      delete process.env.PREMIUM_ROUTER_ARN;
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(mockReadBattleRows).not.toHaveBeenCalled();
    });
  });

  describe('exactly-once sentinel claim', () => {
    const terminalRows = [
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says X', round1MessageId: 'msg-A' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'B says Y', round1MessageId: 'msg-B' },
    ];

    it('skips fan-out when the sentinel claim loses (another invocation won)', async () => {
      mockReadBattleRows.mockResolvedValueOnce(terminalRows);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(false);
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('proceeds to fan-out when the sentinel claim wins: one round per side, and no send of its own', async () => {
      mockReadBattleRows.mockResolvedValueOnce(terminalRows);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(rounds()).toHaveLength(2);
      sentNothing();
    });
  });

  describe('round-2 fan-out shape', () => {
    const terminalRows = [
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'Choose REST', round1MessageId: 'msg-A' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'Choose GraphQL', round1MessageId: 'msg-B' },
    ];

    beforeEach(() => {
      mockReadBattleRows.mockResolvedValueOnce(terminalRows);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
    });

    it('each round names its side and carries what the router builds the placeholder from', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const byBot = new Map(rounds().map((c) => [payloadOf(c[0]).botArn, payloadOf(c[0])]));
      expect([...byBot.keys()].sort()).toEqual([BOT_A, BOT_B].sort());
      const a = byBot.get(BOT_A);
      // BOT_A's rival is BOT_B: the placeholder's rival markers come from these.
      expect(a.battleContext).toMatchObject({ battleId: BATTLE_ID, round: 2, totalRounds: 2, rivalBotArn: BOT_B, rivalReplyMsgId: 'msg-B' });
      expect(a.correlationId).toMatch(/^battle-r2-/);
    });

    it('each round passes the rival reply text in battleContext', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const aPayload = payloadOf(rounds().find((c) => payloadOf(c[0]).botArn === BOT_A)![0]);
      expect(aPayload.battleContext.rivalReply).toBe('Choose GraphQL');
      expect(aPayload.classification).toBe('premium');
      expect(aPayload.userType).toBeUndefined();
    });

    it('each round is handed to the duel classification router, never a processor', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(rounds().map((c) => c[0].input.FunctionName)).toEqual([routerFor('premium'), routerFor('premium')]);
    });

    it('the hand-off is synchronous, so a refused round is seen and logged', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(rounds().every((c) => c[0].input.InvocationType === 'RequestResponse')).toBe(true);
    });

    it('the round carries what the router validates: the turn, the side, the room and the rebuttal shape', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      for (const c of rounds()) {
        expect(payloadOf(c[0])).toMatchObject({ channelArn: CHANNEL_ARN, trigger: 'rebuttal', deliveryOption: 'PLACEHOLDER_UPDATE', battleContext: { round: 2 } });
        expect(payloadOf(c[0]).correlationId).toEqual(expect.any(String));
      }
    });

    it('propagates senderArn + originatingMessageId into round-2 payloads', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const payload = payloadOf(rounds()[0][0]);
      expect(payload.senderArn).toBe(baseEvent.senderArn);
      expect(payload.battleContext.originatingMessageId).toBe('msg-orig-1');
    });

    it('posts no placeholder and names no notice of its own on a full round', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      sentNothing();
      expect(notices()).toEqual([]);
    });
  });

  describe('partial-failure handling (fail-loud / degraded round 2, B2)', () => {
    it('runs a DEGRADED round 2 for the survivor only when one bot FAILED round 1', async () => {
      // A round-1 participant that FAILED (or stalled past deadline) does NOT get a round-2 invocation.
      // Instead its "didn't finish in time" line is named to the router, said by that side, and a
      // degraded round 2 runs for the completed survivor only, flagged so the rebuttal can acknowledge it.
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says', round1MessageId: 'msg-A' },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'FAILED' },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);

      const handler = await loadHandler();
      await handler(baseEvent);

      expect(rounds()).toHaveLength(1);
      const payload = payloadOf(rounds()[0][0]);
      expect(payload.botArn).toBe(BOT_A);
      expect(payload.battleContext.rivalDidNotFinish).toBe(true);
      expect(payload.battleContext.rivalReply).toBe('');

      // Fail loud: a notice, said by the failed side, to the room, through the duel's router.
      expect(notices()).toEqual([{
        router: routerFor('premium'), kind: 'battleSideDidNotFinishUnnamed', channelArn: CHANNEL_ARN, botArn: BOT_B, to: [],
      }]);
      sentNothing();
    });

    it('closes a duel nobody finished with the room primary\'s notice', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'FAILED' },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'FAILED' },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(rounds()).toHaveLength(0);
      const kinds = notices().map((n) => [n.kind, n.botArn]);
      expect(kinds).toContainEqual(['battleSideDidNotFinishUnnamed', BOT_A]);
      expect(kinds).toContainEqual(['battleSideDidNotFinishUnnamed', BOT_B]);
      // The room's primary cannot be resolved here, so the first side closes it, as before.
      expect(kinds[kinds.length - 1]).toEqual(['battleNoneFinished', BOT_A]);
      expect(mockClearActiveBattle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'closed:no-completion' }));
      sentNothing();
    });

    it('a round the router refuses for one side does not block the other', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says', round1MessageId: 'msg-A' },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'B says', round1MessageId: 'msg-B' },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
      mockLambdaSend.mockImplementation(async (cmd: { input: { Payload: Uint8Array } }) => ({
        Payload: Buffer.from(JSON.stringify(bodyOf(cmd).aeRebuttal?.botArn === BOT_A
          ? { dispatched: false, reason: 'placeholder-failed' }
          : { dispatched: true })),
      }));
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(rounds()).toHaveLength(2);
      expect(mockClearActiveBattle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'round2:full' }));
    });
  });

  /**
   * ROUND TWO IS MEASURED FROM THE INSTANT IT WAS TRIGGERED.
   *
   * The side whose terminal write makes every row terminal fires this orchestrator, so the trigger is
   * that last transition: the latest `enteredStateAt` across the duel's rows. Every rebuttal of the duel
   * declares it as `triggerAtMs`, and its acknowledgment and end to end are both measured from it
   * (migration 071). The rival's completion is the wrong instant for the side that finished second,
   * since it predates that side's own round-1 answer.
   */
  describe('the round-two trigger instant', () => {
    const FIRST = '2026-10-01T10:00:05.000Z';
    const LAST = '2026-10-01T10:00:09.500Z';

    it('declares the LAST round-1 terminal transition on every side, the same instant for both', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A', round1MessageId: 'msg-A', enteredStateAt: FIRST },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'B', round1MessageId: 'msg-B', enteredStateAt: LAST },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);

      const handler = await loadHandler();
      await handler(baseEvent);

      const byBot = new Map(rounds().map((c) => [payloadOf(c[0]).botArn, payloadOf(c[0])]));
      expect(byBot.size).toBe(2);
      expect(byBot.get(BOT_A).triggerAtMs).toBe(Date.parse(LAST));
      expect(byBot.get(BOT_B).triggerAtMs).toBe(Date.parse(LAST));
      expect(byBot.get(BOT_A).trigger).toBe('rebuttal');
    });

    it('declares the failed side\'s transition when that is the one that fired the round', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A', round1MessageId: 'msg-A', enteredStateAt: FIRST },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'FAILED', enteredStateAt: LAST },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);

      const handler = await loadHandler();
      await handler(baseEvent);

      expect(rounds()).toHaveLength(1);
      expect(payloadOf(rounds()[0][0]).triggerAtMs).toBe(Date.parse(LAST));
    });

    it('declares NO instant when any row has no readable stamp, rather than a partial maximum', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A', round1MessageId: 'msg-A', enteredStateAt: FIRST },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'B', round1MessageId: 'msg-B' },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);

      const handler = await loadHandler();
      await handler(baseEvent);

      expect(rounds()).toHaveLength(2);
      for (const c of rounds()) {
        expect('triggerAtMs' in payloadOf(c[0])).toBe(false);
      }
    });

    it('roundTwoTriggeredAtMs: the latest stamp, or undefined for an empty or unreadable set', async () => {
      const { roundTwoTriggeredAtMs } = await import('../lambda/src/battle-orchestrator');
      expect(roundTwoTriggeredAtMs([{ enteredStateAt: LAST }, { enteredStateAt: FIRST }])).toBe(Date.parse(LAST));
      expect(roundTwoTriggeredAtMs([])).toBeUndefined();
      expect(roundTwoTriggeredAtMs([{ enteredStateAt: FIRST }, { enteredStateAt: 'not a date' }])).toBeUndefined();
    });
  });
});

/**
 * ROUND 2 GOES TO THE DUEL'S OWN ROUTER (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1c), the one
 * `routerArnForClassification` names from the deploy-time variables. The router dispatches only its own
 * processor, so there is no worker choice here and no fallback to another classification's router,
 * upward or downward.
 */
describe('round 2 is handed to the router of the duel classification', () => {
  const terminalRows = [
    { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says X', round1MessageId: 'msg-A' },
    { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'B says Y', round1MessageId: 'msg-B' },
  ];
  const readyToFanOut = () => {
    mockReadBattleRows.mockResolvedValueOnce(terminalRows);
    mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
  };

  it.each(['premium', 'standard', 'basic'])('a %s duel goes to that classification router, and its payload names it', async (c) => {
    readyToFanOut();
    const handler = await loadHandler();
    await handler({ ...baseEvent, classification: c });
    expect(rounds().map((call) => call[0].input.FunctionName)).toEqual([routerFor(c), routerFor(c)]);
    for (const call of rounds()) expect(payloadOf(call[0]).classification).toBe(c);
  });

  it.each([undefined, 'enterprise', ''])('a duel naming no declared classification (%p) fires nothing', async (c) => {
    // A classification is set or not (ADR-046): an absent or undeclared one is never answered as some
    // other classification, standard included.
    const handler = await loadHandler();
    await handler({ ...baseEvent, classification: c });
    expect(mockReadBattleRows).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
    sentNothing();
  });

  it.each([undefined, 'enterprise', ''])('a duel naming no declared classification (%p) is ENDED, releasing the room, not left running', async (c) => {
    // Failing closed must not strand the duel: the channel's active-battle pointer is released through
    // the same terminal marker every other degraded close writes.
    const handler = await loadHandler();
    await handler({ ...baseEvent, classification: c });
    expect(mockClearActiveBattle).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: baseEvent.channelArn, battleId: BATTLE_ID, reason: 'closed:no-classification',
    }));
  });

  it('a duel whose router is not wired is ENDED too', async () => {
    delete process.env.PREMIUM_ROUTER_ARN;
    const handler = await loadHandler();
    await handler(baseEvent);
    expect(mockClearActiveBattle).toHaveBeenCalledWith(expect.objectContaining({ battleId: BATTLE_ID, reason: 'closed:no-router' }));
  });

  it('NEVER borrows another router: an unwired basic router declines before anything is read or posted', async () => {
    delete process.env.BASIC_ROUTER_ARN;
    const handler = await loadHandler();
    await handler({ ...baseEvent, classification: 'basic' });
    expect(mockReadBattleRows).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
    sentNothing();
  });
});

describe('the challenger is named by assistant id, and its side by the bot its record names', () => {
  const mockChallengerOf = jest.fn();
  const mockTreatment = jest.fn();
  const mockControl = jest.fn();
  const mockSidesRead = jest.fn();

  async function loadWithSides() {
    jest.resetModules();
    jest.doMock('@aws-sdk/client-chime-sdk-messaging', mockChimeModule, { virtual: true });
    jest.doMock('@aws-sdk/client-lambda', mockLambdaModule, { virtual: true });
    jest.doMock('../lambda/src/lib/battle-state', mockBattleStateModule);
    jest.doMock('../lambda/src/lib/alt-assignment', () => ({
      ...jest.requireActual('../lambda/src/lib/alt-assignment'),
      duelChallengerOf: (...a: unknown[]) => mockChallengerOf(...a),
    }));
    jest.doMock('../lambda/src/lib/experiment-manager', () => ({
      ...jest.requireActual('../lambda/src/lib/experiment-manager'),
      // ONE READ of the experiment for both sides.
      resolveBattleSides: async (...a: unknown[]) => {
        mockSidesRead(...a);
        return { active: true, control: await mockControl(...a), treatment: await mockTreatment(...a) };
      },
    }));
    return (await import('../lambda/src/battle-orchestrator')).handler;
  }

  beforeEach(() => {
    mockReadBattleRows.mockResolvedValueOnce([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'Choose REST', round1MessageId: 'msg-A' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'Choose GraphQL', round1MessageId: 'msg-B' },
    ]);
    mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
    mockChallengerOf.mockResolvedValue({ assistant: 'alt-primary-premium', botArn: BOT_B });
    mockLoadChannelBattleConfig.mockResolvedValue({ channelArn: 'x', enabled: true, experimentId: 'exp-1' });
    mockTreatment.mockResolvedValue({ experimentId: 'exp-1', variantId: 'treatment', modelKey: 'opus', displayName: 'Echo', variantProfile: { profileName: 'alt-primary-premium' } });
    mockControl.mockResolvedValue({ experimentId: 'exp-1', variantId: 'control', modelKey: 'sonnet', displayName: 'Atlas', variantProfile: { profileName: 'advisor' } });
  });

  it('gives the challenger\'s row the treatment and the other row the control, each naming its rival', async () => {
    const handler = await loadWithSides();
    await handler(baseEvent);
    expect(mockChallengerOf).toHaveBeenCalledWith('premium');
    // One read of the experiment for both sides, by the id the conversation's battle config bound.
    expect(mockSidesRead).toHaveBeenCalledTimes(1);
    expect(mockSidesRead).toHaveBeenCalledWith('alt-primary-premium', { experimentId: 'exp-1' });
    const byBot = new Map(rounds().map((c) => [payloadOf(c[0]).botArn, payloadOf(c[0])]));
    expect(byBot.get(BOT_B)).toMatchObject({ experimentId: 'exp-1', variantId: 'treatment', battleContext: { rivalName: 'Atlas' } });
    expect(byBot.get(BOT_A)).toMatchObject({ experimentId: 'exp-1', variantId: 'control', battleContext: { rivalName: 'Echo' } });
  });

  it('resolves no side when the challenger\'s bot is not in the duel, rather than guessing one', async () => {
    mockChallengerOf.mockResolvedValue({ assistant: 'alt-primary-premium', botArn: 'arn:aws:chime:us-east-1:111:app-instance/i/bot/someone-else' });
    const handler = await loadWithSides();
    await handler(baseEvent);
    expect(mockSidesRead).not.toHaveBeenCalled();
    for (const c of rounds()) expect(payloadOf(c[0]).experimentId).toBeUndefined();
  });
});
