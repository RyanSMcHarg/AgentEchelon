/**
 * Battle Outcome storage unit tests (SPEC-BATTLE.md §"Battle Scoring &
 * Per-Step Telemetry", Phase 1A).
 *
 * Contract:
 *  - recordBattleOutcome writes an UNCONDITIONAL Put keyed by battleId
 *    (last-write-wins; a re-pick overwrites, no ConditionExpression).
 *  - chosenAt is server-stamped, not client-supplied.
 *  - Invalid input (bad winner / empty ids) → null, no DDB call.
 *  - Fail-open: table unset or DDB throws → null.
 *
 * Mirrors battle-state.test.ts: mock the DDB doc client, reset modules
 * per test, set env then dynamic-import so module-load env capture sees
 * the right table name.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  PutCommand: jest.fn().mockImplementation((args) => ({ __type: 'Put', input: args })),
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

const BATTLE_ID = 'a1b2c3d4e5f60718';
const USER_SUB = 'user-sub-123';

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.BATTLE_OUTCOME_TABLE = 'battle-outcome-test';
});

describe('recordBattleOutcome', () => {
  it('writes an unconditional Put keyed by battleId and returns the record', async () => {
    mockSend.mockResolvedValueOnce({});
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    const before = new Date().toISOString();
    const result = await recordBattleOutcome({
      battleId: BATTLE_ID,
      winner: 'B',
      chosenByUserSub: USER_SUB,
    });
    const after = new Date().toISOString();

    expect(result).not.toBeNull();
    expect(result!.battleId).toBe(BATTLE_ID);
    expect(result!.winner).toBe('B');
    expect(result!.chosenByUserSub).toBe(USER_SUB);
    // chosenAt is server-stamped within the call window
    expect(result!.chosenAt >= before && result!.chosenAt <= after).toBe(true);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Put');
    expect(cmd.input.TableName).toBe('battle-outcome-test');
    expect(cmd.input.Item.battleId).toBe(BATTLE_ID);
    // Last-write-wins: NO ConditionExpression.
    expect(cmd.input.ConditionExpression).toBeUndefined();
  });

  it('re-pick overwrites (last-write-wins) — both writes unconditional', async () => {
    mockSend.mockResolvedValue({});
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    await recordBattleOutcome({ battleId: BATTLE_ID, winner: 'A', chosenByUserSub: USER_SUB });
    await recordBattleOutcome({ battleId: BATTLE_ID, winner: 'tie', chosenByUserSub: 'user-2' });

    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const call of mockSend.mock.calls) {
      expect(call[0].input.ConditionExpression).toBeUndefined();
      expect(call[0].input.Item.battleId).toBe(BATTLE_ID);
    }
    expect(mockSend.mock.calls[1][0].input.Item.winner).toBe('tie');
  });

  it('rejects an invalid winner with null and no DDB call', async () => {
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    const result = await recordBattleOutcome({
      battleId: BATTLE_ID,
      // Cast (not @ts-expect-error): the project's TS config doesn't flag
      // this literal, so @ts-expect-error would be an "unused directive".
      // We deliberately feed an invalid winner to exercise the runtime guard.
      winner: 'C' as 'A' | 'B' | 'tie',
      chosenByUserSub: USER_SUB,
    });
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects empty battleId / userSub with null and no DDB call', async () => {
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    expect(await recordBattleOutcome({ battleId: '', winner: 'A', chosenByUserSub: USER_SUB })).toBeNull();
    expect(await recordBattleOutcome({ battleId: BATTLE_ID, winner: 'A', chosenByUserSub: '  ' })).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fails open (null) when BATTLE_OUTCOME_TABLE is unset', async () => {
    delete process.env.BATTLE_OUTCOME_TABLE;
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    const result = await recordBattleOutcome({
      battleId: BATTLE_ID,
      winner: 'A',
      chosenByUserSub: USER_SUB,
    });
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fails open (null) when DDB throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('DDB unavailable'));
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    const result = await recordBattleOutcome({
      battleId: BATTLE_ID,
      winner: 'A',
      chosenByUserSub: USER_SUB,
    });
    expect(result).toBeNull();
  });
});

describe('readBattleOutcome', () => {
  it('returns the stored record', async () => {
    const stored = {
      battleId: BATTLE_ID,
      winner: 'B',
      chosenByUserSub: USER_SUB,
      chosenAt: '2026-05-15T00:00:00.000Z',
    };
    mockSend.mockResolvedValueOnce({ Item: stored });
    const { readBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    expect(await readBattleOutcome(BATTLE_ID)).toEqual(stored);
    expect(mockSend.mock.calls[0][0].__type).toBe('Get');
  });

  it('returns null when there is no row', async () => {
    mockSend.mockResolvedValueOnce({});
    const { readBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    expect(await readBattleOutcome(BATTLE_ID)).toBeNull();
  });

  it('returns null (fail-open) on empty id without a DDB call', async () => {
    const { readBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    expect(await readBattleOutcome('')).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
