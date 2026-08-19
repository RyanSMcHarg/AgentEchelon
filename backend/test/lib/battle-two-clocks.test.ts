/**
 * A thinking user is not a stalled assistant (ADR-026, the two clocks).
 *
 * WHAT WAS WRONG, AND WHY IT WAS INVISIBLE. `markBotWaitingForUser` stamped `enteredStateAt = now` and
 * nothing ever wrote `deadlineAt`. The orchestrator's `rowDeadlineMs` PREFERS `deadlineAt` and falls
 * back to `enteredStateAt + BATTLE_ROUND1_DEADLINE_MS` (180s) - so the preferred branch was dead code
 * and every deadline came from the fallback. A user who took more than three minutes to answer a
 * clarifying question was reported as an assistant that failed to finish, and the row was deleted by TTL
 * ten minutes in. Nothing errored: the duel just closed itself and blamed the assistant.
 *
 * That made ADR-026 decision 1 unbuildable on its own. A task-shaped duel needs several exchanges with a
 * person, so a per-leg machine deadline applied to a human wait guarantees the duel never finishes,
 * however correct the completion rule is.
 *
 * These assert the WRITES, because the write is what carries the distinction: only the state layer knows
 * which clock a transition starts, and the orchestrator must read the answer rather than recompute it.
 */
import type { PutCommandOutput, UpdateCommandOutput, GetCommandOutput } from '@aws-sdk/lib-dynamodb';

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const BATTLE_ID = 'a1b2c3d4e5f60718';
const BOT_A = 'arn:aws:chime:..:app-instance/i/bot/AltSlot0';

/** The defaults the state layer uses when the env vars are unset. */
const MACHINE_MS = 180_000;
const USER_WAIT_MS = 3_600_000;

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.BATTLE_STATE_TABLE = 'battle-state-test';
  delete process.env.BATTLE_ROUND1_DEADLINE_MS;
  delete process.env.BATTLE_USER_WAIT_MS;
  mockSend.mockResolvedValue({});
});

/** The `deadlineAt` a write set, whether it went in as an Item or an expression value. */
function deadlineFrom(call: { input: Record<string, unknown> }): number {
  const item = call.input.Item as Record<string, unknown> | undefined;
  if (item && typeof item.deadlineAt === 'number') return item.deadlineAt;
  const vals = call.input.ExpressionAttributeValues as Record<string, unknown>;
  return vals[':deadline'] as number;
}

function ttlFrom(call: { input: Record<string, unknown> }): number {
  const item = call.input.Item as Record<string, unknown> | undefined;
  if (item && typeof item.ttl === 'number') return item.ttl;
  const vals = call.input.ExpressionAttributeValues as Record<string, unknown>;
  return vals[':ttl'] as number;
}

describe('a generating side is on the MACHINE clock', () => {
  it('initBotState writes a machine deadline', async () => {
    mockSend.mockResolvedValueOnce({} as PutCommandOutput);
    const before = Date.now();
    const { initBotState } = await import('../../lambda/src/lib/battle-state');
    await initBotState({ battleId: BATTLE_ID, botArn: BOT_A, correlationId: 'c' });

    const deadline = deadlineFrom(mockSend.mock.calls[0][0]);
    // Within the machine window, nowhere near the human one.
    expect(deadline).toBeGreaterThanOrEqual(before + MACHINE_MS);
    expect(deadline).toBeLessThan(before + MACHINE_MS + 60_000);
    expect(deadline).toBeLessThan(before + USER_WAIT_MS);
  });
});

describe('a side blocked on a human is NOT', () => {
  it('markBotWaitingForUser writes the far longer user-wait deadline', async () => {
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const before = Date.now();
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A, question: 'which period?' });

    const deadline = deadlineFrom(mockSend.mock.calls[0][0]);
    // THE ASSERTION THAT MATTERS: past the machine deadline, so a user thinking for four minutes is not
    // reported as a stalled assistant.
    expect(deadline).toBeGreaterThan(before + MACHINE_MS);
    expect(deadline).toBeGreaterThanOrEqual(before + USER_WAIT_MS);
  });

  it('the row OUTLIVES its own wait, so the evidence is still there to report on', async () => {
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A });

    const call = mockSend.mock.calls[0][0];
    // ttl is epoch SECONDS, deadlineAt epoch MS. A row deleted before its deadline ends the duel by
    // disappearing instead of by saying anything, which is the failure the old 600s TTL produced.
    expect(ttlFrom(call)).toBeGreaterThan(Math.floor(deadlineFrom(call) / 1000));
  });

  it('a wait is still BOUNDED — suspended is not infinite', async () => {
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const before = Date.now();
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A });
    const deadline = deadlineFrom(mockSend.mock.calls[0][0]);
    expect(Number.isFinite(deadline)).toBe(true);
    expect(deadline).toBeLessThan(before + 24 * 3_600_000);
  });

  it('the bound is configuration, not a constant', async () => {
    process.env.BATTLE_USER_WAIT_MS = '7200000'; // 2h
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const before = Date.now();
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A });
    expect(deadlineFrom(mockSend.mock.calls[0][0])).toBeGreaterThanOrEqual(before + 7_200_000);
  });
});

describe('a task step suspends round 2 without inflating the clarification measurement', () => {
  it('reason: task-step does NOT increment clarificationCount', async () => {
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A, reason: 'task-step' });

    const call = mockSend.mock.calls[0][0];
    // `clarificationCount` is a MEASURED dimension: how often a model asks rather than forging ahead.
    // A `report_generation` duel passes through here once per machine leg, so counting those would make
    // a model that never asked anything look like one that cannot stop.
    expect(call.input.UpdateExpression).not.toContain('ADD clarificationCount');
    expect(call.input.ExpressionAttributeValues[':one']).toBeUndefined();
  });

  it('it still reaches WAITING_FOR_USER, which is what suspends round 2', async () => {
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A, reason: 'task-step' });

    const vals = mockSend.mock.calls[0][0].input.ExpressionAttributeValues;
    // Non-terminal, so `allBotsTerminal` ignores it and the orchestrator stays quiet. No new predicate
    // was needed for ADR-026 decision 1 - the state machine already had the word for "busy".
    expect(vals[':waiting']).toBe('WAITING_FOR_USER');
  });

  it('a real clarification still counts', async () => {
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A, question: 'which period?' });

    const call = mockSend.mock.calls[0][0];
    expect(call.input.UpdateExpression).toContain('ADD clarificationCount');
    expect(call.input.ExpressionAttributeValues[':one']).toBe(1);
  });

  it('a task step is on the HUMAN clock like any other wait', async () => {
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);
    const before = Date.now();
    const { markBotWaitingForUser } = await import('../../lambda/src/lib/battle-state');
    await markBotWaitingForUser({ battleId: BATTLE_ID, botArn: BOT_A, reason: 'task-step' });
    // The two decisions compose: without this a task-shaped duel would be suspended correctly and then
    // reported as a stalled assistant three minutes later.
    expect(deadlineFrom(mockSend.mock.calls[0][0])).toBeGreaterThan(before + MACHINE_MS);
  });
});

describe('resuming puts the side BACK on the machine clock', () => {
  it('a resumed side is due on the machine deadline again, not the human one', async () => {
    // First call is the waitingSince read, second is the transition.
    mockSend.mockResolvedValueOnce({
      Item: { battleId: BATTLE_ID, botArn: BOT_A, state: 'WAITING_FOR_USER', waitingSince: new Date().toISOString() },
    } as unknown as GetCommandOutput);
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);

    const before = Date.now();
    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A });

    const update = mockSend.mock.calls.find((c) => c[0].__t === 'Update')![0];
    const deadline = deadlineFrom(update);
    // The user has answered, so a stall from here IS the assistant's and the short clock is correct.
    expect(deadline).toBeLessThan(before + USER_WAIT_MS);
    expect(deadline).toBeGreaterThanOrEqual(before + MACHINE_MS);
  });

  it('waited time is banked rather than charged to the assistant', async () => {
    const waitedFor = 240_000; // 4 min: past the machine deadline on purpose
    mockSend.mockResolvedValueOnce({
      Item: {
        battleId: BATTLE_ID,
        botArn: BOT_A,
        state: 'WAITING_FOR_USER',
        waitingSince: new Date(Date.now() - waitedFor).toISOString(),
      },
    } as unknown as GetCommandOutput);
    mockSend.mockResolvedValueOnce({} as UpdateCommandOutput);

    const { resumeBotFromWaiting } = await import('../../lambda/src/lib/battle-state');
    await resumeBotFromWaiting({ battleId: BATTLE_ID, botArn: BOT_A });

    const update = mockSend.mock.calls.find((c) => c[0].__t === 'Update')![0];
    // `computeActiveResponseMs` subtracts this, so a slow human is never recorded as a slow assistant.
    const banked = update.input.ExpressionAttributeValues[':delta'] as number;
    expect(banked).toBeGreaterThanOrEqual(waitedFor - 5_000);
  });
});
