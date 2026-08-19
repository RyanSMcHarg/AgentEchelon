/**
 * Battle Outcome storage unit tests (SPEC-BATTLE.md §"Battle Scoring &
 * Per-Step Telemetry"; DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.4 B3 + §A.4).
 *
 * NEW contract (per-user picks, schema v2 — the B3 redesign):
 *  - recordBattleOutcome no longer writes an unconditional Put (last-write-wins).
 *    It writes ONE row per battleId holding a per-user `votes` map, mutated with
 *    UpdateCommands on the NESTED path `votes.<sub>` — atomic per user, so a
 *    sibling user's vote is never clobbered and two members both persist.
 *  - A re-pick by the same user overwrites only that user's own entry (same
 *    nested path), never another user's.
 *  - chosenAt is server-stamped, not client-supplied.
 *  - The read is VERSIONED: it tolerates a legacy v1 single-row outcome
 *    (top-level winner/chosenByUserSub, no votes map) during cutover, and
 *    tallies a v2 votes map across users.
 *  - Invalid input (bad winner / empty ids) → null, no DDB call.
 *  - Fail-open: table unset or DDB throws → null.
 *
 * Mirrors battle-state.test.ts: mock the DDB doc client, reset modules
 * per test, set env then dynamic-import so module-load env capture sees
 * the right table name.
 */

import type { PerUserPick } from '../../lambda/src/lib/battle-outcome';

const mockSend = jest.fn();
// The write path is now UpdateCommand (per-user nested SET), NOT PutCommand.
// Registering UpdateCommand (and NOT PutCommand) here means an accidental
// regression to a full-row Put would fail with an unregistered constructor.
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  UpdateCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

const BATTLE_ID = 'a1b2c3d4e5f60718';
const USER_SUB = 'user-sub-123';

/**
 * The per-user SET call(s) among the DDB sends — those that write the nested
 * `votes.<sub>` path (as opposed to the idempotent map-init call). This is the
 * write that carries a single user's pick.
 */
function perUserSetCalls() {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (cmd) =>
        cmd.__type === 'Update' &&
        typeof cmd.input.UpdateExpression === 'string' &&
        cmd.input.UpdateExpression.includes('votes.#u'),
    );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.BATTLE_OUTCOME_TABLE = 'battle-outcome-test';
});

describe('recordBattleOutcome', () => {
  it('writes the pick as an UpdateCommand on the per-user votes path (no full-row Put)', async () => {
    mockSend.mockResolvedValue({});
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    const before = new Date().toISOString();
    const result = await recordBattleOutcome({
      battleId: BATTLE_ID,
      winner: 'B',
      chosenByUserSub: USER_SUB,
    });
    const after = new Date().toISOString();

    // The returned pick is this user's own entry, in the legacy BattleOutcome shape.
    expect(result).not.toBeNull();
    expect(result!.battleId).toBe(BATTLE_ID);
    expect(result!.winner).toBe('B');
    expect(result!.chosenByUserSub).toBe(USER_SUB);
    // chosenAt is server-stamped within the call window.
    expect(result!.chosenAt >= before && result!.chosenAt <= after).toBe(true);

    // Every DDB call is an UpdateCommand keyed by battleId — never a Put. The
    // redesign is explicitly UpdateCommand-based (atomic nested writes), so a
    // regression to a Put would show up here.
    expect(mockSend).toHaveBeenCalled();
    for (const call of mockSend.mock.calls) {
      const cmd = call[0];
      expect(cmd.__type).toBe('Update');
      expect(cmd.input.TableName).toBe('battle-outcome-test');
      expect(cmd.input.Key.battleId).toBe(BATTLE_ID);
    }

    // The user's pick is written to the nested `votes.<sub>` path, atomically —
    // #u binds to the chooser's sub, :vote carries the winner + server chosenAt.
    const setCalls = perUserSetCalls();
    expect(setCalls).toHaveLength(1);
    const setCmd = setCalls[0];
    expect(setCmd.input.ExpressionAttributeNames['#u']).toBe(USER_SUB);
    expect(setCmd.input.ExpressionAttributeValues[':vote'].winner).toBe('B');
    expect(typeof setCmd.input.ExpressionAttributeValues[':vote'].chosenAt).toBe('string');
    // Per-user overwrite is intentional (re-pick allowed) — no ConditionExpression.
    expect(setCmd.input.ConditionExpression).toBeUndefined();
  });

  it('two different users both persist — each writes only its own votes.<sub> entry (no clobber)', async () => {
    mockSend.mockResolvedValue({});
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    await recordBattleOutcome({ battleId: BATTLE_ID, winner: 'A', chosenByUserSub: USER_SUB });
    await recordBattleOutcome({ battleId: BATTLE_ID, winner: 'tie', chosenByUserSub: 'user-2' });

    const setCalls = perUserSetCalls();
    expect(setCalls).toHaveLength(2);

    // Both target the SAME row (battleId) but DISTINCT nested paths (votes.<sub>),
    // so neither write can clobber the other member's retained vote.
    const subs = setCalls.map((c) => c.input.ExpressionAttributeNames['#u']);
    expect(new Set(subs)).toEqual(new Set([USER_SUB, 'user-2']));
    for (const c of setCalls) {
      expect(c.input.Key.battleId).toBe(BATTLE_ID);
      expect(c.input.UpdateExpression).toContain('votes.#u');
    }

    // user-2's pick is 'tie'; USER_SUB's is untouched by it.
    const userTwoSet = setCalls.find((c) => c.input.ExpressionAttributeNames['#u'] === 'user-2');
    expect(userTwoSet!.input.ExpressionAttributeValues[':vote'].winner).toBe('tie');
  });

  it('a re-pick by the same user overwrites only that user\'s own entry', async () => {
    mockSend.mockResolvedValue({});
    const { recordBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    await recordBattleOutcome({ battleId: BATTLE_ID, winner: 'A', chosenByUserSub: USER_SUB });
    await recordBattleOutcome({ battleId: BATTLE_ID, winner: 'B', chosenByUserSub: USER_SUB });

    const setCalls = perUserSetCalls();
    expect(setCalls).toHaveLength(2);
    // Both writes hit the SAME nested path (same #u), so the second overwrites
    // just this user's own entry — no other user's vote is involved.
    for (const c of setCalls) {
      expect(c.input.ExpressionAttributeNames['#u']).toBe(USER_SUB);
      expect(c.input.Key.battleId).toBe(BATTLE_ID);
      expect(c.input.ConditionExpression).toBeUndefined();
    }
    // The later pick wins for this user.
    expect(setCalls[1].input.ExpressionAttributeValues[':vote'].winner).toBe('B');
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

describe('readUserBattleOutcome (the live scorecard read)', () => {
  it('maps a LEGACY v1 single-row outcome to that user own pick during cutover', async () => {
    // A v1 row has a top-level winner/chosenByUserSub and NO votes map. This is the coverage the
    // removed back-compat read used to carry, moved onto the function the API actually calls.
    const legacyV1 = {
      battleId: BATTLE_ID,
      winner: 'B',
      chosenByUserSub: USER_SUB,
      chosenAt: '2026-05-15T00:00:00.000Z',
    };
    mockSend.mockResolvedValueOnce({ Item: legacyV1 });
    const { readUserBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    const pick = await readUserBattleOutcome(BATTLE_ID, USER_SUB);
    expect(pick).not.toBeNull();
    expect(pick!.winner).toBe('B');
    expect(pick!.userSub).toBe(USER_SUB);
    expect(mockSend.mock.calls[0][0].__type).toBe('Get');
  });

  it('returns null when there is no row', async () => {
    mockSend.mockResolvedValueOnce({});
    const { readUserBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    expect(await readUserBattleOutcome(BATTLE_ID, USER_SUB)).toBeNull();
  });

  it('returns null for a caller who did not vote — never another member pick', async () => {
    // The privacy half of scoping to the caller: a non-voter gets null rather than whoever voted
    // last, so no other member's choice (or sub) is ever disclosed through this read.
    mockSend.mockResolvedValueOnce({
      Item: {
        battleId: BATTLE_ID,
        schemaVersion: 2,
        votes: { someoneElse: { winner: 'A', chosenAt: '2026-05-15T00:00:00.000Z' } },
      },
    });
    const { readUserBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');
    expect(await readUserBattleOutcome(BATTLE_ID, USER_SUB)).toBeNull();
  });
});

describe('readBattleOutcomes (v2 per-user tally)', () => {
  it('tallies a v2 votes map across users into a majority winner', async () => {
    // Two users retained on ONE row's votes map — the redesign's whole point.
    const v2Row = {
      battleId: BATTLE_ID,
      schemaVersion: 2,
      votes: {
        [USER_SUB]: { winner: 'A', chosenAt: '2026-05-15T00:00:00.000Z' },
        'user-2': { winner: 'A', chosenAt: '2026-05-15T00:01:00.000Z' },
        'user-3': { winner: 'B', chosenAt: '2026-05-15T00:02:00.000Z' },
      },
    };
    mockSend.mockResolvedValueOnce({ Item: v2Row });
    const { readBattleOutcomes } = await import('../../lambda/src/lib/battle-outcome');

    const tally = await readBattleOutcomes(BATTLE_ID);
    expect(tally).not.toBeNull();
    // Both members' picks are retained (not last-write-wins) and tallied.
    expect(tally!.picks).toHaveLength(3);
    expect(tally!.aCount).toBe(2);
    expect(tally!.bCount).toBe(1);
    expect(tally!.winner).toBe('A'); // majority of decisive picks
    expect(mockSend.mock.calls[0][0].__type).toBe('Get');
  });
});

describe('tallyPicks (pure majority tally)', () => {
  // Minimal per-user pick builder — only the fields tallyPicks reads matter.
  const pick = (userSub: string, winner: 'A' | 'B' | 'tie', chosenAt = ''): PerUserPick => ({
    userSub,
    winner,
    chosenAt,
  });

  it('2×A + 2×B ⇒ tie (equal decisive counts), all decisive, no tie picks', async () => {
    const { tallyPicks } = await import('../../lambda/src/lib/battle-outcome');
    const tally = tallyPicks(BATTLE_ID, [
      pick('u1', 'A'),
      pick('u2', 'A'),
      pick('u3', 'B'),
      pick('u4', 'B'),
    ]);
    expect(tally.winner).toBe('tie');
    expect(tally.aCount).toBe(2);
    expect(tally.bCount).toBe(2);
    expect(tally.totalDecisive).toBe(4);
    expect(tally.tieCount).toBe(0);
  });

  it('three tie picks ⇒ tie, zero decisive, tieCount 3', async () => {
    const { tallyPicks } = await import('../../lambda/src/lib/battle-outcome');
    const tally = tallyPicks(BATTLE_ID, [
      pick('u1', 'tie'),
      pick('u2', 'tie'),
      pick('u3', 'tie'),
    ]);
    expect(tally.winner).toBe('tie');
    expect(tally.totalDecisive).toBe(0);
    expect(tally.tieCount).toBe(3);
    expect(tally.aCount).toBe(0);
    expect(tally.bCount).toBe(0);
  });

  it('1×A + 1×B + 1×tie ⇒ tie; the tie is excluded from totalDecisive', async () => {
    const { tallyPicks } = await import('../../lambda/src/lib/battle-outcome');
    const tally = tallyPicks(BATTLE_ID, [
      pick('u1', 'A'),
      pick('u2', 'B'),
      pick('u3', 'tie'),
    ]);
    expect(tally.winner).toBe('tie');
    expect(tally.aCount).toBe(1);
    expect(tally.bCount).toBe(1);
    expect(tally.totalDecisive).toBe(2); // tie NOT counted
    expect(tally.tieCount).toBe(1);
  });
});

describe('extractPicks v1↔v2 coexistence + invalid-skip (via the exported reads)', () => {
  it('votes map wins over a legacy top-level pick for the SAME user', async () => {
    // One row carrying BOTH a v2 votes entry for subA AND a legacy v1 top-level
    // pick that also names subA (a legacy row later voted into). The votes map
    // must win for subA. subC's votes entry has an invalid winner ('C') and is
    // dropped by the VALID_WINNERS guard.
    const coexistRow = {
      battleId: BATTLE_ID,
      votes: {
        subA: { winner: 'A', chosenAt: '2026-05-15T00:00:00.000Z' },
        subC: { winner: 'C', chosenAt: '2026-05-15T00:01:00.000Z' },
      },
      // Legacy v1 top-level fields on the same row.
      winner: 'B',
      chosenByUserSub: 'subA',
      chosenAt: '2026-05-15T00:02:00.000Z',
    };
    mockSend.mockResolvedValue({ Item: coexistRow });
    const { readUserBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    // (a) votes map wins for subA — the legacy 'B' is discarded because subA is
    // already seen from the votes map.
    const a = await readUserBattleOutcome(BATTLE_ID, 'subA');
    expect(a).not.toBeNull();
    expect(a!.winner).toBe('A');

    // (c) subC's votes entry has an invalid winner ('C') ⇒ skipped, not returned.
    expect(await readUserBattleOutcome(BATTLE_ID, 'subC')).toBeNull();
  });

  it('a DIFFERENT legacy sub (not in the votes map) IS retained', async () => {
    // votes map holds subA; the legacy top-level pick names subB. subB has no
    // votes entry, so the legacy pick is retained under its chosenByUserSub.
    const row = {
      battleId: BATTLE_ID,
      votes: {
        subA: { winner: 'A', chosenAt: '2026-05-15T00:00:00.000Z' },
      },
      winner: 'B',
      chosenByUserSub: 'subB',
      chosenAt: '2026-05-15T00:02:00.000Z',
    };
    mockSend.mockResolvedValue({ Item: row });
    const { readUserBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    // (b) subB IS retained, carrying the legacy winner.
    const b = await readUserBattleOutcome(BATTLE_ID, 'subB');
    expect(b).not.toBeNull();
    expect(b!.winner).toBe('B');
    // And subA is still read from the votes map.
    expect((await readUserBattleOutcome(BATTLE_ID, 'subA'))!.winner).toBe('A');
  });
});

describe('a group battle returns each member THEIR OWN pick', () => {
  it('gives two members different answers from the same row', async () => {
    // What the removed most-recent-across-users read got wrong, asserted directly: with several
    // votes on one row, each caller must see the pick they cast, not whoever happened to vote last.
    const row = {
      battleId: BATTLE_ID,
      schemaVersion: 2,
      votes: {
        u1: { winner: 'A', chosenAt: '2026-05-15T00:00:00.000Z' },
        u2: { winner: 'B', chosenAt: '2026-05-15T00:05:00.000Z' }, // newest
      },
    };
    const { readUserBattleOutcome } = await import('../../lambda/src/lib/battle-outcome');

    mockSend.mockResolvedValueOnce({ Item: row });
    const forU1 = await readUserBattleOutcome(BATTLE_ID, 'u1');
    mockSend.mockResolvedValueOnce({ Item: row });
    const forU2 = await readUserBattleOutcome(BATTLE_ID, 'u2');

    // u1 keeps 'A' even though u2 voted later — the whole point of per-user picks.
    expect(forU1!.winner).toBe('A');
    expect(forU2!.winner).toBe('B');
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
