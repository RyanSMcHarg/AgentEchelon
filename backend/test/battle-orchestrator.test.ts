/**
 * Battle Orchestrator Lambda Unit Tests
 *
 * Per SPEC-BATTLE.md, the orchestrator's job:
 *   1. Read all bot rows for a battleId.
 *   2. If not all terminal, defer — the late writer will fire when their
 *      transition lands.
 *   3. tryClaimOrchestratorFire — exactly-one wins; rest no-op.
 *   4. For each bot in parallel: send a round-2 placeholder + invoke
 *      the premium async processor with battleContext.round=2 and the
 *      OTHER bot's round-1 reply as rivalReply.
 *
 * These tests pin the contract by mocking the state-table reads + the
 * Chime/Lambda clients and asserting the invocations the orchestrator
 * makes.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();
const mockReadBattleRows = jest.fn();
const mockTryClaimOrchestratorFire = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Send', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParameter', input: args })),
}), { virtual: true });

// Mock battle-state module entirely — we don't need the real impl for these
// tests, and inlining the two pure helpers (allBotsTerminal, botRowsOnly)
// avoids pulling in the real module's AWS SDK imports.
jest.mock('../lambda/src/lib/battle-state', () => ({
  readBattleRows: (...args: unknown[]) => mockReadBattleRows(...args),
  tryClaimOrchestratorFire: (...args: unknown[]) => mockTryClaimOrchestratorFire(...args),
  allBotsTerminal: (rows: Array<{ botArn: string; state: string }>) => {
    const bots = rows.filter((r) => r.botArn !== '__orchestrator__');
    if (bots.length === 0) return false;
    return bots.every((r) => r.state === 'COMPLETED' || r.state === 'FAILED');
  },
  botRowsOnly: (rows: Array<{ botArn: string }>) => rows.filter((r) => r.botArn !== '__orchestrator__'),
}));

import type { BattleOrchestratorEvent } from '../lambda/src/battle-orchestrator';

// Dynamic import so PREMIUM_ASYNC_PROCESSOR_ARN env is in place at
// module-load time. Each test's beforeEach resets modules + re-sets the env.
async function loadHandler() {
  jest.resetModules();
  // Re-register the mocks against the fresh module graph.
  jest.doMock('@aws-sdk/client-chime-sdk-messaging', () => ({
    ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
    SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Send', input: args })),
    ChannelMessageType: { STANDARD: 'STANDARD' },
    ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
  }), { virtual: true });
  jest.doMock('@aws-sdk/client-lambda', () => ({
    LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
    InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
    InvocationType: { Event: 'Event' },
  }), { virtual: true });
  jest.doMock('@aws-sdk/client-ssm', () => ({
    SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
    GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParameter', input: args })),
  }), { virtual: true });
  jest.doMock('../lambda/src/lib/battle-state', () => ({
    readBattleRows: (...args: unknown[]) => mockReadBattleRows(...args),
    tryClaimOrchestratorFire: (...args: unknown[]) => mockTryClaimOrchestratorFire(...args),
    allBotsTerminal: (rows: Array<{ botArn: string; state: string }>) => {
      const bots = rows.filter((r) => r.botArn !== '__orchestrator__');
      if (bots.length === 0) return false;
      return bots.every((r) => r.state === 'COMPLETED' || r.state === 'FAILED');
    },
    botRowsOnly: (rows: Array<{ botArn: string }>) => rows.filter((r) => r.botArn !== '__orchestrator__'),
  }));
  const mod = await import('../lambda/src/battle-orchestrator');
  return mod.handler;
}

const BATTLE_ID = 'a1b2c3d4e5f60718';
const CHANNEL_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT_A = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const BOT_B = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';

const baseEvent: BattleOrchestratorEvent = {
  battleId: BATTLE_ID,
  channelArn: CHANNEL_ARN,
  userMessage: 'Compare REST vs GraphQL',
  senderArn: 'arn:aws:chime:us-east-1:111:app-instance/i/user/sender',
  originatingMessageId: 'msg-orig-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PREMIUM_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111:function:premium';
  delete process.env.PREMIUM_PROCESSOR_ARN_PARAM;
});

describe('battle-orchestrator handler', () => {
  describe('preconditions', () => {
    it('no-ops when no bot rows exist for the battleId', async () => {
      mockReadBattleRows.mockResolvedValueOnce([]);
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(mockTryClaimOrchestratorFire).not.toHaveBeenCalled();
      expect(mockMessagingSend).not.toHaveBeenCalled();
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('defers when not all bots are terminal (late writer will retry)', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says' },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'INVOKED' },
      ]);
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(mockTryClaimOrchestratorFire).not.toHaveBeenCalled();
      expect(mockMessagingSend).not.toHaveBeenCalled();
    });

    it('no-ops if PREMIUM_ASYNC_PROCESSOR_ARN is unset', async () => {
      delete process.env.PREMIUM_ASYNC_PROCESSOR_ARN;
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
      expect(mockMessagingSend).not.toHaveBeenCalled();
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('proceeds to fan-out when the sentinel claim wins', async () => {
      mockReadBattleRows.mockResolvedValueOnce(terminalRows);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
      mockMessagingSend.mockResolvedValue({});
      mockLambdaSend.mockResolvedValue({});
      const handler = await loadHandler();
      await handler(baseEvent);
      expect(mockMessagingSend).toHaveBeenCalledTimes(2); // one placeholder per bot
      expect(mockLambdaSend).toHaveBeenCalledTimes(2);    // one async invoke per bot
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
      mockMessagingSend.mockResolvedValue({});
      mockLambdaSend.mockResolvedValue({});
    });

    it('each placeholder is sent as the correct bot (ChimeBearer)', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const bearers = mockMessagingSend.mock.calls.map((c) => c[0].input.ChimeBearer);
      expect(bearers).toContain(BOT_A);
      expect(bearers).toContain(BOT_B);
    });

    it('each placeholder content includes the battle marker with round=2 + rival info', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const contents = mockMessagingSend.mock.calls.map((c) => c[0].input.Content);
      for (const content of contents) {
        expect(content).toContain('round=2');
        expect(content).toContain(`battleId=${BATTLE_ID}`);
        expect(content).toContain('rivalArn=');
      }
    });

    it('placeholder content includes rivalReplyMsgId when the rival has one', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const aPlaceholder = mockMessagingSend.mock.calls.find((c) => c[0].input.ChimeBearer === BOT_A)?.[0].input.Content;
      // BOT_A's rival is BOT_B; rivalReplyMsgId should be msg-B
      expect(aPlaceholder).toContain('rivalReplyMsgId=msg-B');
    });

    it('each async invoke passes the rival reply text in battleContext', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const aInvoke = mockLambdaSend.mock.calls.find((c) =>
        JSON.parse(Buffer.from(c[0].input.Payload).toString()).botArn === BOT_A,
      );
      const aPayload = JSON.parse(Buffer.from(aInvoke![0].input.Payload).toString());
      // BOT_A's rival is BOT_B; rivalReply should be BOT_B's round-1 reply
      expect(aPayload.battleContext.round).toBe(2);
      expect(aPayload.battleContext.totalRounds).toBe(2);
      expect(aPayload.battleContext.rivalBotArn).toBe(BOT_B);
      expect(aPayload.battleContext.rivalReply).toBe('Choose GraphQL');
      expect(aPayload.battleContext.battleId).toBe(BATTLE_ID);
      expect(aPayload.userType).toBe('premium');
      expect(aPayload.botArn).toBe(BOT_A);
    });

    it('each async invoke targets the premium async processor ARN', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const fnNames = mockLambdaSend.mock.calls.map((c) => c[0].input.FunctionName);
      expect(fnNames.every((n) => n === process.env.PREMIUM_ASYNC_PROCESSOR_ARN)).toBe(true);
    });

    it('async invoke uses Event invocation type (fire-and-forget)', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const types = mockLambdaSend.mock.calls.map((c) => c[0].input.InvocationType);
      expect(types.every((t) => t === 'Event')).toBe(true);
    });

    it('propagates senderArn + originatingMessageId into round-2 payloads', async () => {
      const handler = await loadHandler();
      await handler(baseEvent);
      const firstInvoke = mockLambdaSend.mock.calls[0][0];
      const payload = JSON.parse(Buffer.from(firstInvoke.input.Payload).toString());
      expect(payload.senderArn).toBe(baseEvent.senderArn);
      expect(payload.battleContext.originatingMessageId).toBe('msg-orig-1');
    });
  });

  describe('partial-failure handling', () => {
    it('still fans out round 2 when one bot failed round 1', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says', round1MessageId: 'msg-A' },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'FAILED' },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
      mockMessagingSend.mockResolvedValue({});
      mockLambdaSend.mockResolvedValue({});

      const handler = await loadHandler();
      await handler(baseEvent);

      // Both bots still get round-2 invocations; the FAILED bot's rival
      // (BOT_A) sees the empty/failed reply.
      expect(mockLambdaSend).toHaveBeenCalledTimes(2);
      const bInvoke = mockLambdaSend.mock.calls.find((c) =>
        JSON.parse(Buffer.from(c[0].input.Payload).toString()).botArn === BOT_B,
      );
      const bPayload = JSON.parse(Buffer.from(bInvoke![0].input.Payload).toString());
      // BOT_B's rival is BOT_A — should receive A's reply text
      expect(bPayload.battleContext.rivalReply).toBe('A says');
    });

    it('skips a bot whose placeholder send throws (without blocking the other bot)', async () => {
      mockReadBattleRows.mockResolvedValueOnce([
        { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says', round1MessageId: 'msg-A' },
        { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'B says', round1MessageId: 'msg-B' },
      ]);
      mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
      // BOT_A's placeholder fails; BOT_B's succeeds.
      mockMessagingSend
        .mockRejectedValueOnce(new Error('SendChannelMessage threw'))
        .mockResolvedValueOnce({});
      mockLambdaSend.mockResolvedValue({});

      const handler = await loadHandler();
      await handler(baseEvent);

      // Should still attempt both placeholders and invoke only the surviving one
      expect(mockMessagingSend).toHaveBeenCalledTimes(2);
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    });
  });
});

// The premium processor ARN is not held at deploy time (that would couple
// the orchestrator to AgentEchelonTier-Premium and reintroduce a fresh-deploy
// ordering cycle). The orchestrator resolves the ARN at runtime from SSM
// (PREMIUM_PROCESSOR_ARN_PARAM), with a literal env override honored first.
// These tests pin that resolution order + the unresolved guard.
describe('premium processor ARN resolution (runtime SSM)', () => {
  const SSM_PARAM = '/agent-echelon/tier/premium/processor-arn';
  const SSM_ARN = 'arn:aws:lambda:us-east-1:111:function:premium-from-ssm';
  const terminalRows = [
    { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', round1Reply: 'A says X', round1MessageId: 'msg-A' },
    { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED', round1Reply: 'B says Y', round1MessageId: 'msg-B' },
  ];

  it('resolves the premium processor ARN from SSM when only PREMIUM_PROCESSOR_ARN_PARAM is set', async () => {
    delete process.env.PREMIUM_ASYNC_PROCESSOR_ARN;
    process.env.PREMIUM_PROCESSOR_ARN_PARAM = SSM_PARAM;
    mockSsmSend.mockResolvedValue({ Parameter: { Value: SSM_ARN } });
    mockReadBattleRows.mockResolvedValueOnce(terminalRows);
    mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
    mockMessagingSend.mockResolvedValue({});
    mockLambdaSend.mockResolvedValue({});

    const handler = await loadHandler();
    await handler(baseEvent);

    // GetParameterCommand was issued for the configured param name.
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    const getParamInput = mockSsmSend.mock.calls[0][0].input;
    expect(getParamInput.Name).toBe(SSM_PARAM);
    // Every async invoke targets the SSM-resolved ARN.
    const fnNames = mockLambdaSend.mock.calls.map((c) => c[0].input.FunctionName);
    expect(fnNames).toHaveLength(2);
    expect(fnNames.every((n) => n === SSM_ARN)).toBe(true);
  });

  it('caches the SSM lookup across bots (one GetParameter per cold start)', async () => {
    delete process.env.PREMIUM_ASYNC_PROCESSOR_ARN;
    process.env.PREMIUM_PROCESSOR_ARN_PARAM = SSM_PARAM;
    mockSsmSend.mockResolvedValue({ Parameter: { Value: SSM_ARN } });
    mockReadBattleRows.mockResolvedValueOnce(terminalRows);
    mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
    mockMessagingSend.mockResolvedValue({});
    mockLambdaSend.mockResolvedValue({});

    const handler = await loadHandler();
    await handler(baseEvent);

    // Two bots fan out, but the ARN is resolved once and cached.
    expect(mockLambdaSend).toHaveBeenCalledTimes(2);
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  it('honors the literal PREMIUM_ASYNC_PROCESSOR_ARN env override without querying SSM', async () => {
    process.env.PREMIUM_ASYNC_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:111:function:premium-env';
    process.env.PREMIUM_PROCESSOR_ARN_PARAM = SSM_PARAM;
    mockReadBattleRows.mockResolvedValueOnce(terminalRows);
    mockTryClaimOrchestratorFire.mockResolvedValueOnce(true);
    mockMessagingSend.mockResolvedValue({});
    mockLambdaSend.mockResolvedValue({});

    const handler = await loadHandler();
    await handler(baseEvent);

    expect(mockSsmSend).not.toHaveBeenCalled();
    const fnNames = mockLambdaSend.mock.calls.map((c) => c[0].input.FunctionName);
    expect(fnNames.every((n) => n === 'arn:aws:lambda:us-east-1:111:function:premium-env')).toBe(true);
  });

  it('no-ops (no fan-out) when SSM resolution throws — never resolves to a bad ARN', async () => {
    delete process.env.PREMIUM_ASYNC_PROCESSOR_ARN;
    process.env.PREMIUM_PROCESSOR_ARN_PARAM = SSM_PARAM;
    mockSsmSend.mockRejectedValue(new Error('SSM unavailable'));

    const handler = await loadHandler();
    await handler(baseEvent);

    // Unresolved ARN → guard returns before reading rows / claiming / fan-out.
    expect(mockReadBattleRows).not.toHaveBeenCalled();
    expect(mockTryClaimOrchestratorFire).not.toHaveBeenCalled();
    expect(mockMessagingSend).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('no-ops when neither the env override nor the SSM param is configured', async () => {
    delete process.env.PREMIUM_ASYNC_PROCESSOR_ARN;
    delete process.env.PREMIUM_PROCESSOR_ARN_PARAM;

    const handler = await loadHandler();
    await handler(baseEvent);

    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(mockReadBattleRows).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});
