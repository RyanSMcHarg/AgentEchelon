/**
 * A duel ends because somebody ended it, not because a clock ran out (DESIGN-BATTLE 2a-i).
 *
 * The shape being guarded here is the one that made a TTL load-bearing in the first place. There was no
 * state for "left unfinished", so expiry was the only way such a duel ever ended - and every reader that
 * consulted the pointer went on reporting a running battle until it fired. These tests hold the four
 * writes that replace it together, because doing three of them is worse than doing none:
 *
 *   - the end is RECORDED (`ABANDONED`), and cannot be mistaken for a completion;
 *   - round 2 is SUPPRESSED, structurally rather than by a check a call site could forget;
 *   - the waiting affordance COMES DOWN, so an ended duel stops inviting an answer;
 *   - the channel pointer is RELEASED, so the next `/battle` is not refused.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
    UpdateCommand: class { __type = 'Update'; constructor(public input: unknown) {} },
    PutCommand: class { __type = 'Put'; constructor(public input: unknown) {} },
    GetCommand: class { __type = 'Get'; constructor(public input: unknown) {} },
    QueryCommand: class { __type = 'Query'; constructor(public input: unknown) {} },
    DeleteCommand: class { __type = 'Delete'; constructor(public input: unknown) {} },
  };
});

const mockClearMarker = jest.fn();
jest.mock('../../lambda/src/lib/battle-waiting-marker', () => ({
  clearBattleWaitingMarker: (...args: unknown[]) => mockClearMarker(...args),
}));

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BATTLE_ID = 'a1b2c3d4e5f60718';
const BOT_A = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Default';
const BOT_B = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';

beforeEach(() => {
  jest.resetModules();
  mockSend.mockReset();
  mockClearMarker.mockReset().mockResolvedValue(true);
  process.env.BATTLE_STATE_TABLE = 'BattleState';
  process.env.CHANNEL_BATTLE_CONFIG_TABLE = 'ChannelBattleConfig';
});

/** The commands the module issued, in order, by type. */
const cmds = (type: string) => mockSend.mock.calls.map((c) => c[0]).filter((c) => c?.__type === type);

describe('ABANDONED is an end, and never a completion', () => {
  it('does NOT satisfy allBotsTerminal, so round 2 can never fire for an abandoned duel', async () => {
    const { allBotsTerminal } = await import('../../lambda/src/lib/battle-state');

    // The structural half of the suppression. `allBotsTerminal` is what fires the rebuttal, and it
    // counts only COMPLETED and FAILED. If ABANDONED were ever added to that list - which reads like a
    // tidy-up, since it IS a state a duel stops in - the orchestrator would produce a rebuttal of a
    // comparison nobody finished, and the exclusion would depend on remembering a check at every call
    // site instead of being impossible.
    expect(allBotsTerminal([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'ABANDONED' },
    ])).toBe(false);

    expect(allBotsTerminal([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'ABANDONED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'ABANDONED' },
    ])).toBe(false);
  });

  it('is not IN FLIGHT either: an abandoned duel is neither running nor comparable', async () => {
    const { duelInFlight } = await import('../../lambda/src/lib/battle-state');

    expect(duelInFlight([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'ABANDONED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED' },
    ])).toBe(false);

    // Still running while any side is generating or blocked on a person.
    expect(duelInFlight([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'ABANDONED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'WAITING_FOR_USER' },
    ])).toBe(true);
  });

  it('is FALSE while a duel is mid-ROUND-2, so "not in flight" never means "nobody cares about it"', async () => {
    const { duelInFlight } = await import('../../lambda/src/lib/battle-state');
    // THE FACT THAT MADE AN ORDERING BUG DANGEROUS, pinned so the next reader meets it.
    //
    // Round 1 ends by moving both sides to COMPLETED, and nothing moves them back while the rebuttal
    // generates - so for the whole of round 2 this predicate reads false even though the duel is very
    // much alive and about to post. An `/battle end` path once treated that as an "already finished"
    // case and skipped its authorisation check for it, which handed any channel member the ability to
    // release someone else's duel and to win the orchestrator's exactly-once claim.
    //
    // `duelInFlight` is correct as written: its job is "is a side still working", not "is this duel
    // finished". Anything asking the SECOND question must not substitute this one, and nothing may
    // treat a false here as permission to act on a duel it does not own.
    expect(duelInFlight([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED' },
    ])).toBe(false);
  });

  it('and `duelIsLive` is the predicate that DOES cover round 2, up to the resolution marker', async () => {
    const { duelIsLive } = await import('../../lambda/src/lib/battle-state');

    // Mid round 2: both sides idle at COMPLETED, no marker yet. The duel is generating a rebuttal that
    // is about to land in the channel, so anything asking "is a battle running here" must say yes.
    // Two separate defects came from asking `duelInFlight` instead: drift would have moved a person
    // into a new conversation moments before the rebuttal arrived in the one they left, and
    // `/battle end` reported the duel already finished while killing the round 2 it had not noticed.
    expect(duelIsLive([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED' },
    ])).toBe(true);

    // The orchestrator's marker is what ends it. That is the only durable statement that no further
    // orchestrated phase is coming, which is exactly the question being asked.
    expect(duelIsLive([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: '__complete__', state: 'COMPLETED' },
    ])).toBe(false);

    // A duel everybody walked out of is not live either, marker or no marker.
    expect(duelIsLive([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'ABANDONED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'ABANDONED' },
    ])).toBe(false);
  });

  it('records the end as a marker no race can take away', async () => {
    const { duelWasAbandoned } = await import('../../lambda/src/lib/battle-state');

    // THE RACE THIS EXISTS FOR. `endBattle` claims the orchestrator sentinel before it transitions the
    // sides, so a side reaching COMPLETED in that instant fails its abandon transition - and the duel
    // ends up genuinely ended by a person while carrying no ABANDONED row at all. Keying only on the
    // rows would then accept a pick on a comparison whose rebuttal was suppressed.
    expect(duelWasAbandoned([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: '__abandoned__', state: 'ABANDONED' },
    ])).toBe(true);

    // The per-side rows still answer it when they can.
    expect(duelWasAbandoned([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'ABANDONED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED' },
    ])).toBe(true);

    // A duel that simply finished is not abandoned, and takes its pick normally.
    expect(duelWasAbandoned([
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: BOT_B, state: 'COMPLETED' },
      { battleId: BATTLE_ID, botArn: '__complete__', state: 'COMPLETED' },
    ])).toBe(false);
  });
});

describe('being past a DEADLINE is not the same as a row expiring', () => {
  it('reads the deadline the row carries, not its TTL', async () => {
    const { isPastDeadline } = await import('../../lambda/src/lib/battle-state');
    const now = 1_800_000_000_000;

    // A row whose garbage-collection TTL is far in the future can still be past due...
    expect(isPastDeadline(
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'INVOKED', deadlineAt: now - 1, ttl: 9_999_999_999 },
      now,
    )).toBe(true);

    // ...and a row can be well within its deadline regardless of when the janitor will collect it.
    expect(isPastDeadline(
      { battleId: BATTLE_ID, botArn: BOT_A, state: 'WAITING_FOR_USER', deadlineAt: now + 60_000, ttl: 1 },
      now,
    )).toBe(false);
  });

  it('treats an unreadable deadline as NOT yet due, rather than failing loud', async () => {
    const { isPastDeadline } = await import('../../lambda/src/lib/battle-state');
    expect(isPastDeadline({ battleId: BATTLE_ID, botArn: BOT_A, state: 'INVOKED' }, Date.now())).toBe(false);
  });
});

describe('clearActiveBattle', () => {
  it('releases the pointer only for the duel it names', async () => {
    mockSend.mockResolvedValueOnce({});
    const { clearActiveBattle } = await import('../../lambda/src/lib/battle-state');
    await clearActiveBattle({ channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'round2:full' });

    const cmd = cmds('Update')[0];
    // The condition is what stops a straggler from an ended duel clearing the pointer of a NEW battle
    // that has since started - which would strand the new one exactly as an overwrite would.
    expect(cmd.input.ConditionExpression).toBe('activeBattleId = :b');
    expect(cmd.input.ExpressionAttributeValues[':b']).toBe(BATTLE_ID);
    expect(cmd.input.UpdateExpression).toContain('REMOVE activeBattleId');
    expect(cmd.input.UpdateExpression).toContain('activeBattleEndReason = :r');
  });

  it('records WHO ended it when a person did', async () => {
    mockSend.mockResolvedValueOnce({});
    const { clearActiveBattle } = await import('../../lambda/src/lib/battle-state');
    await clearActiveBattle({
      channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'abandoned:requested', endedBy: 'user-1',
    });

    const cmd = cmds('Update')[0];
    expect(cmd.input.UpdateExpression).toContain('activeBattleEndedBy = :by');
    expect(cmd.input.ExpressionAttributeValues[':by']).toBe('user-1');
  });

  it('is non-fatal: a failed release must not take down the path that is ending the duel', async () => {
    mockSend.mockRejectedValueOnce(new Error('ddb down'));
    const { clearActiveBattle } = await import('../../lambda/src/lib/battle-state');
    await expect(
      clearActiveBattle({ channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'round2:full' }),
    ).resolves.toBeUndefined();
  });
});

describe('endBattle does all four writes, or the end is only half done', () => {
  /** A duel with one side finished and one still holding a question open. */
  const liveRows = [
    { battleId: BATTLE_ID, botArn: BOT_A, state: 'COMPLETED', correlationId: 'c-a' },
    {
      battleId: BATTLE_ID, botArn: BOT_B, state: 'WAITING_FOR_USER',
      correlationId: 'c-b', waitingMessageId: 'question-msg-1',
    },
  ];

  async function loadWithRows(rows: unknown[], claimWon = true) {
    jest.doMock('../../lambda/src/lib/battle-state', () => ({
      readBattleRows: jest.fn().mockResolvedValue(rows),
      botRowsOnly: (r: Array<{ botArn: string }>) => r.filter((x) => !x.botArn.startsWith('__')),
      clearActiveBattle: mockClearActiveBattle,
      tryClaimOrchestratorFire: jest.fn().mockResolvedValue(claimWon),
      transitionBotState: mockTransition,
      markBattleAbandoned: mockMarkAbandoned,
    }));
    return import('../../lambda/src/lib/battle-end');
  }

  const mockClearActiveBattle = jest.fn();
  const mockTransition = jest.fn();
  const mockMarkAbandoned = jest.fn();

  beforeEach(() => {
    mockClearActiveBattle.mockReset().mockResolvedValue(undefined);
    mockMarkAbandoned.mockReset().mockResolvedValue(undefined);
    mockTransition.mockReset().mockResolvedValue(true);
  });

  it('abandons only the sides that had not already stopped', async () => {
    const { endBattle } = await loadWithRows(liveRows);
    const out = await endBattle({ channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'abandoned:requested' });

    // A side that genuinely produced its answer keeps it. Rewriting a real completion as abandoned
    // would erase work to make the row set tidy.
    expect(out.abandoned).toEqual([BOT_B]);
    expect(mockTransition).toHaveBeenCalledTimes(1);
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ botArn: BOT_B, state: 'ABANDONED' }));
  });

  it('TAKES DOWN THE WAITING AFFORDANCE, so an ended duel stops asking', async () => {
    const { endBattle } = await loadWithRows(liveRows);
    const out = await endBattle({ channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'abandoned:drift' });

    // The defect this exists to prevent: the marker is the frontend's live "Replying to:" control and
    // was cleared in exactly one place, the resume. End a duel while a side is waiting and the question
    // stayed answerable forever, attached to a duel that no longer existed.
    expect(mockClearMarker).toHaveBeenCalledWith(CHANNEL, 'question-msg-1', BOT_B);
    expect(out.markersCleared).toBe(1);
  });

  it('releases the pointer with the reason and the person who ended it', async () => {
    const { endBattle } = await loadWithRows(liveRows);
    await endBattle({
      channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'abandoned:battle-mode-off', endedBy: 'mod-1',
    });

    expect(mockClearActiveBattle).toHaveBeenCalledWith({
      channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'abandoned:battle-mode-off', endedBy: 'mod-1',
    });
  });

  it('reports honestly when the round-2 claim was already taken', async () => {
    const { endBattle } = await loadWithRows(liveRows, false);
    const out = await endBattle({ channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'abandoned:requested' });

    // A lost claim means the rebuttal is already dispatched and cannot be recalled. The duel still ends
    // and its pick is still refused - but a caller must be able to tell, because promising "no more
    // answers" is a promise the channel visibly breaks a few seconds later.
    expect(out.round2Suppressed).toBe(false);
    expect(mockClearActiveBattle).toHaveBeenCalled();
  });

  it('still releases the channel when the rows cannot be read', async () => {
    jest.doMock('../../lambda/src/lib/battle-state', () => ({
      readBattleRows: jest.fn().mockRejectedValue(new Error('ddb down')),
      botRowsOnly: (r: Array<{ botArn: string }>) => r,
      clearActiveBattle: mockClearActiveBattle,
      tryClaimOrchestratorFire: jest.fn().mockResolvedValue(true),
      transitionBotState: mockTransition,
      markBattleAbandoned: mockMarkAbandoned,
    }));
    const { endBattle } = await import('../../lambda/src/lib/battle-end');

    // Leaving the pointer standing would lock the channel out of new battles until the backstop clock
    // fired - the exact failure this whole change removes.
    await expect(
      endBattle({ channelArn: CHANNEL, battleId: BATTLE_ID, reason: 'abandoned:requested' }),
    ).resolves.toBeDefined();
    expect(mockClearActiveBattle).toHaveBeenCalled();
  });
});
