/**
 * Battle State Helpers Unit Tests
 *
 * Per SPEC-BATTLE.md, the state-machine and orchestrator-fire
 * contracts must be exactly-once safe under concurrent writes:
 *
 *  - deriveBattleId is deterministic: same inputs → same id, across
 *    retries of the channel-flow processor.
 *  - initBotState uses attribute_not_exists so retries don't clobber
 *    an in-flight INVOKED row.
 *  - transitionBotState's conditional expression succeeds for exactly
 *    one writer per row; the second writer (race or retry) gets
 *    ConditionalCheckFailedException → returns false.
 *  - tryClaimOrchestratorFire is the round-2-fire sentinel:
 *    exactly one caller wins; the rest no-op.
 *
 * These tests verify the contract by mocking the DDB client and asserting
 * the conditional expressions are present + correct.
 */

import type { QueryCommandOutput, GetCommandOutput, PutCommandOutput } from '@aws-sdk/lib-dynamodb';

// Mock @aws-sdk/lib-dynamodb before importing battle-state
const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  PutCommand: jest.fn().mockImplementation((args) => ({ __type: 'Put', input: args })),
  QueryCommand: jest.fn().mockImplementation((args) => ({ __type: 'Query', input: args })),
  UpdateCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

const BATTLE_ID = 'a1b2c3d4e5f60718';
const CHANNEL_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT_A = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const BOT_B = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';

function conditionalCheckFailed(): Error {
  const err = new Error('The conditional request failed') as Error & { name?: string };
  err.name = 'ConditionalCheckFailedException';
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BATTLE_STATE_TABLE = 'battle-state-test';
  process.env.CHANNEL_BATTLE_CONFIG_TABLE = 'channel-battle-config-test';
  // Reset modules so the module-level cache in battle-state.ts is fresh per-test
  jest.resetModules();
});

describe('deriveBattleId', () => {
  // Pure function — no DDB. Deterministic and stable across imports.
  it('produces a 16-hex-char id', async () => {
    const { deriveBattleId } = await import('../../lambda/src/lib/battle-state');
    const id = deriveBattleId(CHANNEL_ARN, 'msg-123');
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic — same inputs always produce the same id', async () => {
    const { deriveBattleId } = await import('../../lambda/src/lib/battle-state');
    const id1 = deriveBattleId(CHANNEL_ARN, 'msg-123');
    const id2 = deriveBattleId(CHANNEL_ARN, 'msg-123');
    expect(id1).toBe(id2);
  });

  it('different message ids produce different battle ids', async () => {
    const { deriveBattleId } = await import('../../lambda/src/lib/battle-state');
    const id1 = deriveBattleId(CHANNEL_ARN, 'msg-123');
    const id2 = deriveBattleId(CHANNEL_ARN, 'msg-124');
    expect(id1).not.toBe(id2);
  });

  it('different channel arns produce different battle ids for the same message id', async () => {
    const { deriveBattleId } = await import('../../lambda/src/lib/battle-state');
    const id1 = deriveBattleId(CHANNEL_ARN, 'msg-X');
    const id2 = deriveBattleId(CHANNEL_ARN + '-other', 'msg-X');
    expect(id1).not.toBe(id2);
  });
});

describe('initBotState', () => {
  it('writes the INVOKED row with attribute_not_exists guard', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { initBotState } = await import('../../lambda/src/lib/battle-state');
    await initBotState({ battleId: BATTLE_ID, botArn: BOT_A, correlationId: 'corr-1' });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Put');
    expect(cmd.input.Item.state).toBe('INVOKED');
    expect(cmd.input.Item.battleId).toBe(BATTLE_ID);
    expect(cmd.input.Item.botArn).toBe(BOT_A);
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(botArn)');
    // No taskId → PLACEHOLDER/DIRECT battle: the attribute is absent
    // (not undefined) so the continuation router's presence check is clean.
    expect('taskId' in cmd.input.Item).toBe(false);
  });

  it('stamps taskId for a TASK_* battle (continuation router uses its presence)', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { initBotState } = await import('../../lambda/src/lib/battle-state');
    await initBotState({ battleId: BATTLE_ID, botArn: BOT_A, correlationId: 'c', taskId: 'task-42' });
    expect(mockSend.mock.calls[0][0].input.Item.taskId).toBe('task-42');
  });

  it('swallows ConditionalCheckFailedException (retries are no-ops)', async () => {
    mockSend.mockRejectedValueOnce(conditionalCheckFailed());
    const { initBotState } = await import('../../lambda/src/lib/battle-state');
    await expect(
      initBotState({ battleId: BATTLE_ID, botArn: BOT_A, correlationId: 'corr-1' }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when BATTLE_STATE_TABLE is unset (fail-open)', async () => {
    delete process.env.BATTLE_STATE_TABLE;
    const { initBotState } = await import('../../lambda/src/lib/battle-state');
    await initBotState({ battleId: BATTLE_ID, botArn: BOT_A, correlationId: 'corr-1' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('transitionBotState', () => {
  it('writes COMPLETED with the conditional-update contract', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { transitionBotState } = await import('../../lambda/src/lib/battle-state');
    const result = await transitionBotState({
      battleId: BATTLE_ID,
      botArn: BOT_A,
      state: 'COMPLETED',
      round1Reply: 'the reply text',
      round1MessageId: 'msg-reply-A',
      correlationId: 'corr-A',
    });

    expect(result).toBe(true);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Item.state).toBe('COMPLETED');
    expect(cmd.input.Item.round1Reply).toBe('the reply text');
    expect(cmd.input.Item.round1MessageId).toBe('msg-reply-A');
    // Conditional: only transition if the row doesn't yet exist OR is
    // still in a non-terminal (INVOKED|WAITING_FOR_USER) state.
    expect(cmd.input.ConditionExpression).toContain('attribute_not_exists(botArn)');
    expect(cmd.input.ConditionExpression).toContain('IN');
    expect(cmd.input.ExpressionAttributeValues[':invoked']).toBe('INVOKED');
    expect(cmd.input.ExpressionAttributeValues[':waiting']).toBe('WAITING_FOR_USER');
  });

  it('returns false (race-loser) when the conditional fails', async () => {
    mockSend.mockRejectedValueOnce(conditionalCheckFailed());
    const { transitionBotState } = await import('../../lambda/src/lib/battle-state');
    const result = await transitionBotState({
      battleId: BATTLE_ID,
      botArn: BOT_A,
      state: 'COMPLETED',
      correlationId: 'corr-A',
    });
    expect(result).toBe(false);
  });

  it('returns false on unexpected DDB errors (and warns)', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const { transitionBotState } = await import('../../lambda/src/lib/battle-state');
    const result = await transitionBotState({
      battleId: BATTLE_ID,
      botArn: BOT_A,
      state: 'COMPLETED',
      correlationId: 'corr-A',
    });
    expect(result).toBe(false);
  });

  it('supports FAILED as a terminal state', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { transitionBotState } = await import('../../lambda/src/lib/battle-state');
    const ok = await transitionBotState({
      battleId: BATTLE_ID,
      botArn: BOT_A,
      state: 'FAILED',
      correlationId: 'corr-A',
    });
    expect(ok).toBe(true);
    expect(mockSend.mock.calls[0][0].input.Item.state).toBe('FAILED');
  });
});

describe('markBotWaitingForUser (INVOKED → WAITING_FOR_USER)', () => {
  it('updates with the INVOKED-only conditional and an ADD clarificationCount', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    const ok = await markBotWaitingForUser({
      battleId: BATTLE_ID,
      botArn: BOT_A,
      question: 'Which fiscal quarter — Q3 or Q4?',
      correlationId: 'corr-A',
      waitingMessageId: 'msg-placeholder-A',
    });

    expect(ok).toBe(true);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Update');
    expect(cmd.input.Key).toEqual({ battleId: BATTLE_ID, botArn: BOT_A });
    // Strictly INVOKED → WAITING_FOR_USER, and the row must already exist.
    expect(cmd.input.ConditionExpression).toBe('attribute_exists(botArn) AND #state = :invoked');
    expect(cmd.input.ExpressionAttributeValues[':invoked']).toBe('INVOKED');
    expect(cmd.input.ExpressionAttributeValues[':waiting']).toBe('WAITING_FOR_USER');
    expect(cmd.input.ExpressionAttributeValues[':q']).toBe('Which fiscal quarter — Q3 or Q4?');
    // The waiting placeholder id is persisted so resume reuses it.
    expect(cmd.input.UpdateExpression).toContain('waitingMessageId = :wmid');
    expect(cmd.input.ExpressionAttributeValues[':wmid']).toBe('msg-placeholder-A');
    // clarificationCount is an atomic counter, not a SET — so a retry
    // that loses the conditional can't double-count.
    expect(cmd.input.UpdateExpression).toContain('ADD clarificationCount :one');
    expect(cmd.input.ExpressionAttributeValues[':one']).toBe(1);
  });

  it('returns false (no double-count) when the row already left INVOKED', async () => {
    mockSend.mockRejectedValueOnce(conditionalCheckFailed());
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    const ok = await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A });
    expect(ok).toBe(false);
  });

  it('returns false on unexpected DDB errors (and warns)', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    const ok = await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A });
    expect(ok).toBe(false);
  });

  it('tolerates an absent question (lone-sentinel clarification)', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    const ok = await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A });
    expect(ok).toBe(true);
    expect(mockSend.mock.calls[0][0].input.ExpressionAttributeValues[':q']).toBeNull();
  });

  it('is a no-op (fails open, false) when BATTLE_STATE_TABLE is unset', async () => {
    delete process.env.BATTLE_STATE_TABLE;
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    const ok = await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A });
    expect(ok).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('resumeBotFromWaiting (WAITING_FOR_USER → INVOKED, banks waited interval)', () => {
  it('banks now − waitingSince and transitions with the WAITING-only conditional', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        battleId: BATTLE_ID,
        botArn: BOT_A,
        state: 'WAITING_FOR_USER',
        waitingSince: new Date(Date.now() - 5_000).toISOString(),
      },
    } as unknown as GetCommandOutput);
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    const ok = await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A, correlationId: 'corr-r' });

    expect(ok).toBe(true);
    const get = mockSend.mock.calls[0][0];
    expect(get.__type).toBe('Get');
    const upd = mockSend.mock.calls[1][0];
    expect(upd.__type).toBe('Update');
    expect(upd.input.ConditionExpression).toBe('attribute_exists(botArn) AND #state = :waiting');
    expect(upd.input.ExpressionAttributeValues[':waiting']).toBe('WAITING_FOR_USER');
    expect(upd.input.ExpressionAttributeValues[':invoked']).toBe('INVOKED');
    expect(upd.input.UpdateExpression).toContain('ADD waitedMs :delta');
    expect(upd.input.UpdateExpression).toContain('REMOVE waitingSince, clarificationQuestion');
    // ~5s elapsed; loose bounds so a slow CI box can't flake it.
    expect(upd.input.ExpressionAttributeValues[':delta']).toBeGreaterThanOrEqual(4_000);
    expect(upd.input.ExpressionAttributeValues[':delta']).toBeLessThan(120_000);
  });

  it('idempotent: conditional fails (already resumed) → false, no double-bank', async () => {
    mockSend.mockResolvedValueOnce({ Item: { waitingSince: new Date().toISOString() } } as unknown as GetCommandOutput);
    mockSend.mockRejectedValueOnce(conditionalCheckFailed());
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    expect(await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A })).toBe(false);
  });

  it('missing waitingSince → banks 0 but still transitions', async () => {
    mockSend.mockResolvedValueOnce({ Item: { battleId: BATTLE_ID, botArn: BOT_A, state: 'WAITING_FOR_USER' } } as unknown as GetCommandOutput);
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    expect(await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A })).toBe(true);
    expect(mockSend.mock.calls[1][0].input.ExpressionAttributeValues[':delta']).toBe(0);
  });

  it('unparseable waitingSince → banks 0 (NaN guard)', async () => {
    mockSend.mockResolvedValueOnce({ Item: { waitingSince: 'not-a-date' } } as unknown as GetCommandOutput);
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    expect(await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A })).toBe(true);
    expect(mockSend.mock.calls[1][0].input.ExpressionAttributeValues[':delta']).toBe(0);
  });

  it('telemetry is best-effort: a waitingSince READ failure does NOT block the resume', async () => {
    mockSend.mockRejectedValueOnce(new Error('ddb get throttled'));
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    const ok = await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A });
    expect(ok).toBe(true); // still transitioned
    expect(mockSend.mock.calls[1][0].input.ExpressionAttributeValues[':delta']).toBe(0);
  });

  it('returns false on an unexpected error on the transition write (and warns)', async () => {
    mockSend.mockResolvedValueOnce({ Item: {} } as unknown as GetCommandOutput);
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    expect(await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A })).toBe(false);
  });

  it('is a no-op (false) when BATTLE_STATE_TABLE is unset', async () => {
    delete process.env.BATTLE_STATE_TABLE;
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    expect(await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A })).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('tryClaimOrchestratorFire (exactly-once sentinel)', () => {
  it('first claimer wins (returns true)', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const { tryClaimOrchestratorFire } = await import('../../lambda/src/lib/battle-state');
    const result = await tryClaimOrchestratorFire(BATTLE_ID);

    expect(result).toBe(true);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Item.botArn).toBe('__orchestrator__');
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(botArn)');
  });

  it('second concurrent claim loses (returns false)', async () => {
    mockSend.mockRejectedValueOnce(conditionalCheckFailed());
    const { tryClaimOrchestratorFire } = await import('../../lambda/src/lib/battle-state');
    const result = await tryClaimOrchestratorFire(BATTLE_ID);
    expect(result).toBe(false);
  });
});

describe('readBattleRows + allBotsTerminal + botRowsOnly', () => {
  it('queries the partition by battleId', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] } as unknown as QueryCommandOutput);
    const { readBattleRows } = await import('../../lambda/src/lib/battle-state');
    await readBattleRows(BATTLE_ID);

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Query');
    expect(cmd.input.KeyConditionExpression).toBe('battleId = :id');
    expect(cmd.input.ExpressionAttributeValues[':id']).toBe(BATTLE_ID);
  });

  it('allBotsTerminal returns false when any bot is still INVOKED', async () => {
    const { allBotsTerminal } = await import('../../lambda/src/lib/battle-state');
    const result = allBotsTerminal([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'INVOKED' },
    ]);
    expect(result).toBe(false);
  });

  it('allBotsTerminal returns true when every bot is COMPLETED or FAILED', async () => {
    const { allBotsTerminal } = await import('../../lambda/src/lib/battle-state');
    expect(allBotsTerminal([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'FAILED' },
    ])).toBe(true);
  });

  it('allBotsTerminal returns false when rows are empty', async () => {
    const { allBotsTerminal } = await import('../../lambda/src/lib/battle-state');
    expect(allBotsTerminal([])).toBe(false);
  });

  it('botRowsOnly excludes the __orchestrator__ sentinel from terminal checks', async () => {
    const { botRowsOnly, allBotsTerminal } = await import('../../lambda/src/lib/battle-state');
    const rows = [
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' as const },
      { battleId: BATTLE_ID, botArn: '__orchestrator__', state: 'COMPLETED' as const },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'INVOKED' as const },
    ];
    expect(botRowsOnly(rows)).toHaveLength(2);
    expect(allBotsTerminal(rows)).toBe(false); // BOT_B is still INVOKED
  });
});

describe('isBattleEnabled (ChannelBattleConfig lookup)', () => {
  it('returns true when the row has enabled:true', async () => {
    mockSend.mockResolvedValueOnce({ Item: { channelArn: CHANNEL_ARN, enabled: true } } as unknown as GetCommandOutput);
    const { isBattleEnabled } = await import('../../lambda/src/lib/battle-state');
    expect(await isBattleEnabled(CHANNEL_ARN)).toBe(true);
  });

  it('returns false when the row exists with enabled:false', async () => {
    mockSend.mockResolvedValueOnce({ Item: { channelArn: CHANNEL_ARN, enabled: false } } as unknown as GetCommandOutput);
    const { isBattleEnabled } = await import('../../lambda/src/lib/battle-state');
    expect(await isBattleEnabled(CHANNEL_ARN)).toBe(false);
  });

  it('returns false (fails open) when DDB throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('table not found'));
    const { isBattleEnabled } = await import('../../lambda/src/lib/battle-state');
    expect(await isBattleEnabled(CHANNEL_ARN)).toBe(false);
  });

  it('returns false (fails open) when CHANNEL_BATTLE_CONFIG_TABLE is unset', async () => {
    delete process.env.CHANNEL_BATTLE_CONFIG_TABLE;
    const { isBattleEnabled } = await import('../../lambda/src/lib/battle-state');
    expect(await isBattleEnabled(CHANNEL_ARN)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('caches reads for the 60s TTL (no second DDB call within TTL)', async () => {
    mockSend.mockResolvedValueOnce({ Item: { channelArn: CHANNEL_ARN, enabled: true } } as unknown as GetCommandOutput);
    const { isBattleEnabled } = await import('../../lambda/src/lib/battle-state');
    expect(await isBattleEnabled(CHANNEL_ARN)).toBe(true);
    expect(await isBattleEnabled(CHANNEL_ARN)).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('setActiveBattle (channel→battle pointer at fan-out)', () => {
  it('conditionally SETs the pointer and busts the config cache', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const mod = await import('../../lambda/src/lib/battle-state');
    await mod.setActiveBattle({ channelArn: CHANNEL_ARN, battleId: BATTLE_ID });

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Update');
    expect(cmd.input.Key).toEqual({ channelArn: CHANNEL_ARN });
    expect(cmd.input.ConditionExpression).toBe('attribute_exists(channelArn)');
    expect(cmd.input.UpdateExpression).toContain('activeBattleId = :b');
    expect(cmd.input.UpdateExpression).toContain('activeBattleStartedAt = :now');
    expect(cmd.input.ExpressionAttributeValues[':b']).toBe(BATTLE_ID);
    // Cache busted → a follow-up resolve re-reads from DDB.
    mockSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL_ARN, enabled: true, activeBattleId: BATTLE_ID, activeBattleStartedAt: new Date().toISOString() },
    } as unknown as GetCommandOutput);
    expect(await mod.resolveActiveBattleId(CHANNEL_ARN)).toBe(BATTLE_ID);
    expect(mockSend).toHaveBeenCalledTimes(2); // not served from a stale cache
  });

  it('is non-fatal: a failed write must not throw (battle still fans out)', async () => {
    mockSend.mockRejectedValueOnce(new Error('ddb down'));
    const { setActiveBattle } = await import('../../lambda/src/lib/battle-state');
    await expect(
      setActiveBattle({ channelArn: CHANNEL_ARN, battleId: BATTLE_ID }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when CHANNEL_BATTLE_CONFIG_TABLE is unset', async () => {
    delete process.env.CHANNEL_BATTLE_CONFIG_TABLE;
    const { setActiveBattle } = await import('../../lambda/src/lib/battle-state');
    await setActiveBattle({ channelArn: CHANNEL_ARN, battleId: BATTLE_ID });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('resolveActiveBattleId (continuation pre-filter)', () => {
  it('returns the pointer when fresh', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL_ARN, enabled: true, activeBattleId: BATTLE_ID, activeBattleStartedAt: new Date().toISOString() },
    } as unknown as GetCommandOutput);
    const { resolveActiveBattleId } = await import('../../lambda/src/lib/battle-state');
    expect(await resolveActiveBattleId(CHANNEL_ARN)).toBe(BATTLE_ID);
  });

  it('returns null when no pointer is set', async () => {
    mockSend.mockResolvedValueOnce({ Item: { channelArn: CHANNEL_ARN, enabled: true } } as unknown as GetCommandOutput);
    const { resolveActiveBattleId } = await import('../../lambda/src/lib/battle-state');
    expect(await resolveActiveBattleId(CHANNEL_ARN)).toBeNull();
  });

  it('returns null when the pointer is older than the BattleState TTL (stale → aged out)', async () => {
    const stale = new Date(Date.now() - 601_000).toISOString(); // > 600s
    mockSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL_ARN, enabled: true, activeBattleId: BATTLE_ID, activeBattleStartedAt: stale },
    } as unknown as GetCommandOutput);
    const { resolveActiveBattleId } = await import('../../lambda/src/lib/battle-state');
    expect(await resolveActiveBattleId(CHANNEL_ARN)).toBeNull();
  });

  it('returns the pointer (lets rows arbitrate) when the timestamp is missing/invalid', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { channelArn: CHANNEL_ARN, enabled: true, activeBattleId: BATTLE_ID, activeBattleStartedAt: 'garbage' },
    } as unknown as GetCommandOutput);
    const { resolveActiveBattleId } = await import('../../lambda/src/lib/battle-state');
    expect(await resolveActiveBattleId(CHANNEL_ARN)).toBe(BATTLE_ID);
  });
});

describe('extractTargetedBotArns (Target → bot ARNs — pure)', () => {
  const HUMAN = 'arn:aws:chime:us-east-1:111:app-instance/i/user/u-1';

  it('keeps only /bot/ ARNs, drops humans', async () => {
    const { extractTargetedBotArns } = await import('../../lambda/src/lib/battle-state');
    expect(
      extractTargetedBotArns([{ MemberArn: BOT_A }, { MemberArn: HUMAN }, { MemberArn: BOT_B }]),
    ).toEqual([BOT_A, BOT_B]);
  });

  it('dedupes and preserves order', async () => {
    const { extractTargetedBotArns } = await import('../../lambda/src/lib/battle-state');
    expect(extractTargetedBotArns([{ MemberArn: BOT_B }, { MemberArn: BOT_B }, { MemberArn: BOT_A }]))
      .toEqual([BOT_B, BOT_A]);
  });

  it('undefined / empty / entries without MemberArn → []', async () => {
    const { extractTargetedBotArns } = await import('../../lambda/src/lib/battle-state');
    expect(extractTargetedBotArns(undefined)).toEqual([]);
    expect(extractTargetedBotArns([])).toEqual([]);
    expect(extractTargetedBotArns([{}, { MemberArn: '' }])).toEqual([]);
  });
});

describe('planBattleContinuation (per-bot resume routing — pure)', () => {
  // Pure — no DDB. The strict-isolation cases are the load-bearing ones:
  // a waiting bot the user did NOT address must never resume.
  const waiting = (botArn: string) =>
    ({ battleId: BATTLE_ID, botArn, state: 'WAITING_FOR_USER' as const });
  const completed = (botArn: string) =>
    ({ battleId: BATTLE_ID, botArn, state: 'COMPLETED' as const });

  it('resumes a single addressed waiting bot', async () => {
    const { planBattleContinuation } = await import('../../lambda/src/lib/battle-state');
    expect(planBattleContinuation([waiting(BOT_A), completed(BOT_B)], [BOT_A]))
      .toEqual({ resumeBotArns: [BOT_A] });
  });

  it('ISOLATION: a waiting bot the user did NOT address stays waiting', async () => {
    const { planBattleContinuation } = await import('../../lambda/src/lib/battle-state');
    // Both waiting; user replied only to A. B must NOT resume — it must
    // not free-ride on A's clarification (measured-dimension integrity).
    expect(planBattleContinuation([waiting(BOT_A), waiting(BOT_B)], [BOT_A]))
      .toEqual({ resumeBotArns: [BOT_A] });
  });

  it('an addressed bot that already finished round 1 is ignored (not a continuation)', async () => {
    const { planBattleContinuation } = await import('../../lambda/src/lib/battle-state');
    expect(planBattleContinuation([completed(BOT_A), waiting(BOT_B)], [BOT_A]))
      .toEqual({ resumeBotArns: [] });
  });

  it('explicit "all" — user deliberately addresses both waiting bots → both resume, mention order preserved', async () => {
    const { planBattleContinuation } = await import('../../lambda/src/lib/battle-state');
    expect(planBattleContinuation([waiting(BOT_A), waiting(BOT_B)], [BOT_B, BOT_A]))
      .toEqual({ resumeBotArns: [BOT_B, BOT_A] });
  });

  it('no mentions / undefined mentions → empty (ordinary chatter, not a continuation)', async () => {
    const { planBattleContinuation } = await import('../../lambda/src/lib/battle-state');
    expect(planBattleContinuation([waiting(BOT_A)], []).resumeBotArns).toEqual([]);
    expect(planBattleContinuation([waiting(BOT_A)], undefined).resumeBotArns).toEqual([]);
  });

  it('dedupes repeated mentions and excludes the __orchestrator__ sentinel', async () => {
    const { planBattleContinuation } = await import('../../lambda/src/lib/battle-state');
    const rows = [
      waiting(BOT_A),
      { battleId: BATTLE_ID, botArn: '__orchestrator__', state: 'WAITING_FOR_USER' as const },
    ];
    expect(planBattleContinuation(rows, [BOT_A, BOT_A, '__orchestrator__']))
      .toEqual({ resumeBotArns: [BOT_A] });
  });

  it('mentions with no battle waiting at all → empty', async () => {
    const { planBattleContinuation } = await import('../../lambda/src/lib/battle-state');
    expect(planBattleContinuation([completed(BOT_A), completed(BOT_B)], [BOT_A, BOT_B]))
      .toEqual({ resumeBotArns: [] });
  });
});

describe('planBattleResume (PLACEHOLDER vs TASK_* resume shape — pure)', () => {
  it('no rowTaskId → plain re-invoke, no task fields', async () => {
    const { planBattleResume } = await import('../../lambda/src/lib/battle-state');
    expect(planBattleResume({ rowTaskId: undefined, task: null }))
      .toEqual({ deliveryOption: 'PLACEHOLDER_UPDATE' });
  });

  it('TASK_* battle, live task → resume that chain (carries deliveryOption/taskType/taskId)', async () => {
    const { planBattleResume } = await import('../../lambda/src/lib/battle-state');
    expect(
      planBattleResume({
        rowTaskId: 'task-1',
        task: { status: 'in_progress', deliveryOption: 'TASK_MULTI_STEP', taskType: 'report_generation', taskId: 'task-1' },
      }),
    ).toEqual({ deliveryOption: 'TASK_MULTI_STEP', taskType: 'report_generation', taskId: 'task-1' });
  });

  it('TASK_* battle but task gone → degrade to plain re-invoke (no stranding)', async () => {
    const { planBattleResume } = await import('../../lambda/src/lib/battle-state');
    expect(planBattleResume({ rowTaskId: 'task-1', task: null }))
      .toEqual({ deliveryOption: 'PLACEHOLDER_UPDATE' });
  });

  it('TASK_* battle but task already terminal → degrade to plain re-invoke', async () => {
    const { planBattleResume } = await import('../../lambda/src/lib/battle-state');
    for (const status of ['completed', 'failed']) {
      expect(
        planBattleResume({
          rowTaskId: 'task-1',
          task: { status, deliveryOption: 'TASK_MULTI_STEP', taskType: 'x', taskId: 'task-1' },
        }),
      ).toEqual({ deliveryOption: 'PLACEHOLDER_UPDATE' });
    }
  });

  it('live task with a non-TASK deliveryOption → plain re-invoke, NO task fields (coherent)', async () => {
    const { planBattleResume } = await import('../../lambda/src/lib/battle-state');
    expect(
      planBattleResume({
        rowTaskId: 'task-1',
        task: { status: 'in_progress', deliveryOption: 'PLACEHOLDER_UPDATE', taskType: 'x', taskId: 'task-1' },
      }),
    ).toEqual({ deliveryOption: 'PLACEHOLDER_UPDATE' });
  });

  it('falls back to rowTaskId when the task record omits its own taskId', async () => {
    const { planBattleResume } = await import('../../lambda/src/lib/battle-state');
    expect(
      planBattleResume({
        rowTaskId: 'row-task-9',
        task: { status: 'pending', deliveryOption: 'TASK_UPDATE_IN_PLACE', taskType: 'data_extraction' },
      }),
    ).toEqual({ deliveryOption: 'TASK_UPDATE_IN_PLACE', taskType: 'data_extraction', taskId: 'row-task-9' });
  });
});

describe('computeActiveResponseMs (elapsed − waited — pure)', () => {
  it('subtracts the banked wait', async () => {
    const { computeActiveResponseMs } = await import('../../lambda/src/lib/battle-state');
    expect(computeActiveResponseMs(10_000, 4_000)).toBe(6_000);
  });

  it('undefined waitedMs (no clarification) ⇒ active == elapsed', async () => {
    const { computeActiveResponseMs } = await import('../../lambda/src/lib/battle-state');
    expect(computeActiveResponseMs(7_500, undefined)).toBe(7_500);
  });

  it('clamps ≥ 0 when banked wait exceeds measured elapsed (skew / partial turn)', async () => {
    const { computeActiveResponseMs } = await import('../../lambda/src/lib/battle-state');
    expect(computeActiveResponseMs(3_000, 9_000)).toBe(0);
  });
});

describe('getBotRow (single-item self-row read)', () => {
  it('reads PK battleId + SK botArn and returns the row', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', clarificationCount: 2, waitedMs: 5000 },
    } as unknown as GetCommandOutput);
    const { getBotRow } = await import('../../lambda/src/lib/battle-state');
    const row = await getBotRow(BATTLE_ID, BOT_A);

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Get');
    expect(cmd.input.Key).toEqual({ battleId: BATTLE_ID, botArn: BOT_A });
    expect(row?.clarificationCount).toBe(2);
    expect(row?.waitedMs).toBe(5000);
  });

  it('returns null when the row is absent', async () => {
    mockSend.mockResolvedValueOnce({} as unknown as GetCommandOutput);
    const { getBotRow } = await import('../../lambda/src/lib/battle-state');
    expect(await getBotRow(BATTLE_ID, BOT_A)).toBeNull();
  });

  it('fails open (null) on a DDB error — telemetry must never block the reply', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const { getBotRow } = await import('../../lambda/src/lib/battle-state');
    expect(await getBotRow(BATTLE_ID, BOT_A)).toBeNull();
  });

  it('is a no-op (null) when BATTLE_STATE_TABLE is unset', async () => {
    delete process.env.BATTLE_STATE_TABLE;
    const { getBotRow } = await import('../../lambda/src/lib/battle-state');
    expect(await getBotRow(BATTLE_ID, BOT_A)).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
